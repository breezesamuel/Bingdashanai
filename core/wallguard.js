'use strict';
// core/wallguard.js — 收费墙·免费额度滥用**观测**日志（只记不判）。
//
// 【为什么存在】免费档是「每分区每天 N 次 + 总量 10 次」，而访客身份是签名 Cookie。
// 清 Cookie / 换浏览器 就能拿到全新 visitor、免费额度归零 —— 单看单个 visitor 永远正常，
// 运营完全看不见"同一网络在反复刷免费额度"这件事。这里补的是**可见性**，不是闸门。
//
// 【铁律：绝不改动放行/拦截语义】
//   1. observe() 全程 try/catch 包裹，任何异常都吞掉 —— 观测代码绝不能把收费墙主流程打挂；
//   2. observe() 没有返回值给判定路径使用，gateSection / gateContent 的 {allowed} 完全不受影响；
//   3. 这里只在两类**低频**信号上落盘，避免把每次放行都写一遍（否则就是变相改性能/语义）：
//        a) 撞墙（allowed===false）—— 免费额度用尽，是滥用的直接结果；
//        b) 某 IP 上**首次出现**的新 visitor —— 清 Cookie 刷免费次数的核心特征。
//   两条合起来即可还原"哪些 IP 在制造大量 visitor / 反复撞墙"，且体量可控。
//
// 【数据归属】写进 store 的 'wallAbuse' 集合（JSONL 台账，跟 trialLedger 同一套存储）。
//   这是运营侧诊断数据，不进任何买家可见响应；/v1/wall/stats 另需管理令牌。
const store = require('./store');

const WINDOW_MS = 24 * 3600000;   // 内存聚合窗口（24h 滑动）
const MAX_IPS = 5000;             // 内存 IP 上限（防 OOM；超限先清最久未活跃）
const MAX_VISITORS_PER_IP = 50;   // 单 IP 记住的 visitor 上限（防单 IP 无限撑大 Set）
const MAX_LOG_PER_IP_PER_DAY = 200; // 单 IP 单日落盘上限（防单 IP 刷爆台账）

// ip -> { visitors:Set, first, last, dayKey, dayLogged }
const _ips = new Map();

function _normIp(ip) {
  return String(ip || '').trim().replace(/^::ffff:/, '').slice(0, 45);
}

function _evict(now) {
  if (_ips.size <= MAX_IPS) return;
  for (const [k, v] of _ips) {
    if (now - v.last > WINDOW_MS) _ips.delete(k);
    if (_ips.size <= MAX_IPS) break;
  }
}

// 被动观测入口。o = { ip, visitor, section, allowed }。
// 无返回值（判定路径不得依赖它）；任何异常一律吞掉。
function observe(o) {
  try {
    const now = Date.now();
    const ip = _normIp(o && o.ip);
    if (!ip) return;                                  // 拿不到真实 IP：跳过，不误判
    const vid = String((o && o.visitor) || '');
    const allowed = o && o.allowed;
    const section = String((o && o.section) || '');

    let e = _ips.get(ip);
    if (!e) {
      e = { visitors: new Set(), first: now, last: now, dayKey: '', dayLogged: 0 };
      _ips.set(ip, e);
    }
    e.last = now;

    // 新 visitor？（清 Cookie 刷免费次数的核心信号）
    let newVisitor = false;
    if (vid && !e.visitors.has(vid)) {
      newVisitor = true;
      if (e.visitors.size < MAX_VISITORS_PER_IP) e.visitors.add(vid);
    }

    const wallHit = (allowed === false);

    // 只在「撞墙」或「新 visitor」时落盘；其余放行不写（低频原则）
    if (!wallHit && !newVisitor) { _evict(now); return; }

    // 单 IP 单日落盘配额，防单点刷爆台账
    const day = new Date(now).toDateString();
    if (e.dayKey !== day) { e.dayKey = day; e.dayLogged = 0; }
    if (e.dayLogged >= MAX_LOG_PER_IP_PER_DAY) { _evict(now); return; }
    e.dayLogged++;

    try {
      store.push('wallAbuse', {
        ip, visitor: vid, section,
        allowed: allowed !== false,
        wall: wallHit,
        newVisitor,
        distinctVisitors: e.visitors.size,
        at: now
      }, '撞墙观测', ip + ' ' + (wallHit ? '撞墙' : '新访客') + ' ' + section);
    } catch (_) { /* 台账写失败不影响主流程 */ }

    _evict(now);
  } catch (_) { /* 观测绝不能影响收费墙主流程 */ }
}

function _parseRange(range) {
  const s = String(range || '7d');
  const m = /^(\d+)([hd])$/.exec(s);
  if (!m) return 7 * 86400000;
  const n = parseInt(m[1], 10) || 7;
  return m[2] === 'h' ? n * 3600000 : n * 86400000;
}

// 运营统计：range 形如 '1h' / '7d' / '30d'。按 IP 聚合，返回 Top offenders。
// 排序权重：撞墙数优先（滥用结果），其次不同 visitor 数（清 Cookie 特征）。
function stats(range) {
  const ms = _parseRange(range);
  const now = Date.now();
  const from = now - ms;
  const rows = store.list('wallAbuse', 20000).filter(r => r && Number(r.at || 0) >= from);
  const byIp = {};
  rows.forEach(r => {
    const e = byIp[r.ip] = byIp[r.ip] || { ip: r.ip, wallHits: 0, newVisitorEvents: 0, distinctVisitors: 0, sections: {}, first: r.at, last: r.at };
    if (r.wall) e.wallHits++;
    if (r.newVisitor) e.newVisitorEvents++;
    e.distinctVisitors = Math.max(e.distinctVisitors, Number(r.distinctVisitors) || 0);
    if (r.section) e.sections[r.section] = (e.sections[r.section] || 0) + 1;
    e.first = Math.min(e.first, r.at);
    e.last = Math.max(e.last, r.at);
  });
  const list = Object.values(byIp).map(e => ({
    ip: e.ip,
    wallHits: e.wallHits,
    newVisitorEvents: e.newVisitorEvents,
    distinctVisitors: e.distinctVisitors,
    topSection: Object.keys(e.sections).sort((a, b) => e.sections[b] - e.sections[a])[0] || '',
    firstAt: e.first,
    lastAt: e.last
  })).sort((a, b) => (b.wallHits - a.wallHits) || (b.distinctVisitors - a.distinctVisitors) || (b.newVisitorEvents - a.newVisitorEvents));

  const totalWall = list.reduce((s, x) => s + x.wallHits, 0);
  const multiVisitor = list.filter(x => x.distinctVisitors >= 3).length;
  return {
    range: String(range || '7d'),
    windowMs: ms,
    totalIps: list.length,
    totalWallHits: totalWall,
    suspiciousIps: multiVisitor,       // 同 IP ≥3 个不同 visitor —— 疑似清 Cookie 刷免费额度
    note: '纯观测台账，不改动任何放行/拦截语义。suspiciousIps = 同 IP 出现 ≥3 个不同访客身份（清 Cookie 特征），供人工判断，非自动封禁。',
    top: list.slice(0, 50)
  };
}

module.exports = { observe, stats, WINDOW_MS, MAX_IPS };
