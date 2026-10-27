// core/watchdog.js — 24h 全管辖监控：对列管项目做周期体检，异常第一时间邮件报警到默认告警邮箱。
// 管辖面：发布列车 / 客服工单(SLA) / 冷启动Playbook / 故事工厂 / MCP余额池 / 邮件系统 / 自主运营心跳 / KPI营收 / 排行榜一致性
// 品质：零 LLM；异常规则全部来自各引擎真实水位；告警限流（同 key 30 分钟冷静期）防轰炸；全部落审计。

const store = require('./store');
const mailer = require('./mailer');

const SCAN_MS = 60 * 1000;         // 体检周期基准：60s（真实监控密度，静默降级不炸邮件）
// 设备自适应：启动时按 devcap 推导，弱机拉长到 5min，避免高频扫描与小内存机器争抢事件循环
let scanMs = SCAN_MS;
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 同一异常 24 小时冷静期（一天最多一封告警，不频繁轰炸）
const DEFAULT_INBOX = '460123249@qq.com';

let timer = null;
let lastScan = null;
let alerts = [];         // 最近告警（含内容，供战情室）

// —— 告警冷静期持久化：sent 落库（watchdogCooldown）防服务器重启后重复轰炸 ——
function cooldownNow() {
  const db = store.read();
  const now = Date.now();
  // 惰性清理过期 key，避免集合无限涨
  const keep = (db.watchdogCooldown || []).filter(e => now - e.at < 24 * 60 * 60 * 1000);
  const map = {};
  keep.forEach(e => { map[e.key] = e.at; });
  return { map, keep, now };
}
function cooldownSave(map) {
  const db = store.read();
  db.watchdogCooldown = Object.entries(map).map(([key, at]) => ({ key, at }));
  store.write(db);
}
function cooldownGet(key) {
  const { map } = cooldownNow();
  return map[key] || 0;
}
function cooldownSet(key, at) {
  const { map, keep } = cooldownNow();
  map[key] = at;
  cooldownSave({ ...map, ...Object.fromEntries(keep.map(e => [e.key, e.at])) });
}

// —— 规则引擎：扫描所有管辖模块，返回 anomalies[{key, level, title, detail}] ——
function scanNow() {
  const a = [];
  const db = store.read();
  const now = Date.now();

  // 1) 发布列车：当期班次装不满 / parking lot 空转 / 技术债堆积
  try {
    const train = require('./train');
    const b = train.board();
    const filled = [b.current.slots.growth, b.current.slots.retention, b.current.slots.debt].filter(Boolean).length;
    if (filled < 3) a.push({ key: 'train-underload', level: 'warn', title: '发布列车装载不足', detail: '第 ' + b.current.no + ' 班只装 ' + filled + '/3 格' + (b.lotCount ? '，但 parking lot 还有 ' + b.lotCount + ' 条可提取' : '') });
    if (b.techDebt && b.techDebt.length >= 3) a.push({ key: 'train-techdebt', level: 'warn', title: '技术债积压', detail: '欠账 ' + b.techDebt.length + ' 项：' + b.techDebt.slice(0, 2).join(' / ') });
  } catch (e) {}

  // 2) 客服工单：SLA 超时 / 危机单未回访 / 周批积压
  try {
    const tickets = require('./tickets');
    const w = tickets.slaWatch();
    if (w.overdue && w.overdue.length) a.push({ key: 'tickets-sla', level: 'error', title: '工单 SLA 超时', detail: '超时 ' + w.overdue.length + ' 单：' + w.overdue.slice(0, 4).join(',') + '（P0 当日响应/72h 结论，P1 48h）' });
    const open = (db.tickets || []).filter(t => t.status === 'open');
    if (open.some(t => t.crisis)) a.push({ key: 'tickets-crisis', level: 'error', title: '危机工单待回访', detail: open.filter(t => t.crisis).length + ' 个危机单未结——立即确认送达，不追问不留白' });
  } catch (e) {}

  // 3) 冷启动 Playbook：连续未推进（>48h）或 D30 门长期 NO-GO
  try {
    const playbook = require('./playbook');
    const b = playbook.board();
    if (b.current && b.current.day && b.current.day !== '—') {
      const lastAt = (db.playbook || []).length ? (db.playbook[db.playbook.length - 1].updatedAt || db.playbook[db.playbook.length - 1].createdAt || 0) : 0;
      if (lastAt && now - lastAt > 48 * 3600 * 1000) a.push({ key: 'pb-stall', level: 'warn', title: '冷启动推进行滞', detail: '当前 ' + b.current.day + '，已 ' + Math.round((now - lastAt) / 3600000) + ' 小时未推进' });
    }
  } catch (e) {}

  // 4) 故事工厂：在产作品卡在人工站超 72h / 井B 未授权
  try {
    const foundry = require('./foundry');
    const works = (db.foundry || []).filter(w => w.station && w.station !== 'published' && !/rejected|reid-block/.test(w.station || ''));
    const stuck = works.filter(w => w.station === 'S4' || w.station === 'S6' || w.station === 'S8');
    if (stuck.length) a.push({ key: 'foundry-human', level: 'warn', title: '故事工厂待人工裁决', detail: stuck.length + ' 部停在 ' + stuck.map(x => x.station).join('/') + '——人工站不代跑是底线，只催人不代答' });
  } catch (e) {}

  // 5) MCP 预付池：低于 ¥20 底限 / key 待充
  try {
    const mcp = require('./mcp');
    const ms = mcp.stats();
    if (ms.developers > 0 && ms.balancePool < 20) a.push({ key: 'mcp-pool', level: 'warn', title: 'MCP 预付池见底', detail: '池内 ¥' + ms.balancePool + ' < ¥20 底限，完整盘会拒接' });
  } catch (e) {}

  // 6) 自主运营心跳：>30 分钟无新轮词（opmods 正常运行则忽略单轮失败）
  try {
    const ap = (db.autopilot || [])[0];
    if (ap && now - ap.at > 30 * 60 * 1000) a.push({ key: 'autopilot-idle', level: 'warn', title: '自主运营心跳停滞', detail: '最后一轮 ' + Math.round((now - ap.at) / 60000) + ' 分钟前（#编号 ' + ap.no + '）' });
  } catch (e) {}

  // 7) KPI 营收进度（半年 1000 万）——只有真金白银落后才报；营收尚无任何入账（未开账）不算落后
  try {
    const money = require('./money');
    const k = money.kpi();
    const real = (db.revenue || []).some(r => r && r.amt && Number(r.amt) > 0 && money.isSettled(r));
    const behind = k.pacePlan > 0 ? 1 - k.regDaily / k.pacePlan : 0;
    if (real && behind >= 0.3) a.push({ key: 'kpi-slow', level: 'warn', title: '半年千万进度落后', detail: '实际日均 ¥' + k.regDaily.toFixed(0) + ' < 计划日均 ¥' + k.pacePlan.toFixed(0) + '（落后 ' + Math.round(behind * 100) + '%）' });
  } catch (e) {}

  // 8) 排行榜一致性：前一名必须严格比后一名 ≥1
  try {
    const rank = require('./rank');
    if (!rank.gapOk().ok) a.push({ key: 'rank-gap', level: 'error', title: '排行榜差值违规', detail: rank.gapOk().bad.map(x => x.name + ' vs ' + x.next).slice(0, 3).join(' / ') || '存在并列点' });
  } catch (e) {}

// 9) 邮件系统自检：最近一次发送失败则报
  try {
    const lastMail = store.list('mail', 1)[0];
    if (lastMail && lastMail.ok === false) a.push({ key: 'mail-down', level: 'error', title: '告警邮件发送失败', detail: '上次发送 ' + String(lastMail.subject || '').slice(0, 40) + ' 失败：' + String(lastMail.error || '').slice(0, 80) });
  } catch (e) {}

  // 10) 订阅续费预警：7 天内到期的订阅（续费比拉新便宜，到期即静默回墙是最伤的流失点）
  //     巡检只暴露、不轰炸运营；运营在 /v1/watch 与战情室可见，必要时逐人跟进。
  //     返利生成的等效订阅（fromRebate）单独注明，避免把它当付费客户误跟。
  try {
    const win = 7 * 86400000;
    const exp = (db.sublist || []).filter(s => s && s.expireAt && s.expireAt > now && s.expireAt - now <= win);
    if (exp.length) {
      a.push({
        key: 'subs-expiring', level: 'warn',
        title: exp.length + ' 个订阅本周到期',
        detail: exp.slice(0, 8).map(x => x.plan + (x.fromRebate ? '(返利)' : '') + ' ' + Math.ceil((x.expireAt - now) / 86400000) + 'd').join(' / ') +
          (exp.length > 8 ? ' 等 ' + exp.length + ' 个' : '') + '——到期即静默回墙，尽早续费提醒（showPlans 弹窗+7 天双触发）'
      });
    }
  } catch (e) {}

  lastScan = now;
  return a;
}

// —— 自愈引擎（借鉴 Polsia 监控代理自愈，安全红线版）——
// 原则：只修"确定性、可离线、不涉现金/代发"的异常；修复动作必须幂等 + 可审计；
// 无法自愈的异常照旧走人工告警。绝不自动花钱、绝不代表公司对外发声。
// 每个修复动作都经 audit 留痕 + 写经验库（供其他项目复用）。
let healLog = [];        // 最近自愈动作（战情室可看）
const HEAL_GAP_MS = 30 * 60 * 1000; // 同一异常 30 分钟冷静期，防自愈抖动死循环

async function healOnce(list) {
  const now = Date.now();
  let healed = 0;
  for (const x of list) {
    const key = x.key;
    const last = cooldownGet('heal:' + key);
    if (now - last < HEAL_GAP_MS) continue;
    let action = null;
    try {
      if (key === 'train-underload') {
        // 发布列车装不满但 parking lot 有料 → 自动提取装货（不动人、不花钱）
        const train = require('./train');
        const b = train.board();
        const emptySlot = ['growth', 'retention', 'debt'].find(s => !(b.current.slots && b.current.slots[s]));
        const idea = (b.parkinglot || [])[0];
        if (emptySlot && idea) {
          const r = train.takeFromLot(idea.id, b.current.no, emptySlot);
          action = '自动从 parking lot 提取「' + r.title + '」装入 ' + b.current.no + ' 班 ' + emptySlot + ' 格';
        }
      } else if (key === 'rank-gap') {
        // 排行榜差值违规须人工重排错开（改分会篡改真实数据），不自动修，保持告警
      }
    } catch (e) { /* 自愈失败不阻断其他项 */ }
    if (action) {
      cooldownSet('heal:' + key, now);
      healLog = [{ key, title: x.title, action, at: now }].concat(healLog).slice(0, 20);
      try { store.push('audit', { action: '监控·自动自愈', detail: '[' + key + '] ' + action, at: now }); } catch (e) {}
      // 器官协作：免疫系统广播「自愈完成」信号 → 经验库/心脏/记忆皮层/情绪 自动接收
      // （体验由 organs.publish 的反射弧统一处理，这里只发信号，不各自为政）
      try { require('./organs').publish('heal@done', { key, title: x.title, action }); } catch (e) {}
      healed++;
    }
  }
  return healed;
}

// —— 告警分发：只对"新出现 + 冷静期已过"的异常发邮件；每天最多一封（当日首封即锁门）——
async function dispatch(list) {
  const now = Date.now();
  const inbox = store.getSetting('alertEmail') || DEFAULT_INBOX;
  const fired = [];
  // 当日已发闸门：任一异常今日已告警 → 全天不再补发（不频繁轰炸），次日 0 点重置
  const dayKey = 'daily-sent-' + new Date(now).toISOString().slice(0, 10);
  if (cooldownGet(dayKey) && !(list.length === 0)) return { sent: 0, fired: [], mailbox: inbox, daily: true, keys: [] };
  const fresh = list.filter(x => {
    const last = cooldownGet(x.key);
    if (now - last < COOLDOWN_MS) return false;
    cooldownSet(x.key, now);
    return true;
  });
  if (!fresh.length) return { sent: 0, fired: [], mailbox: inbox };
  // 当日只发一封：无论几个新鲜异常，全部合并进这一封
  cooldownSet(dayKey, now);
  const subject = '【BingDashan 24h 监控】' + fresh[0].title + (fresh.length > 1 ? ' 等 ' + fresh.length + ' 项' : '');
  const rows = fresh.map(x =>
    '<tr style="border-bottom:1px solid #eee"><td style="padding:6px 0;font-weight:bold">' + esc(x.title) + '</td><td style="padding-left:12px;color:#555">' + esc(x.detail) + '</td></tr>'
  ).join('');
  const html = '<div style="font-family:-apple-system,sans-serif;max-width:640px;margin:20px auto"><h2 style="color:#c0392b">⚠ BingDashan 24h 监控告警</h2>' +
    '<p style="color:#666">监控时间：' + new Date(now).toLocaleString('zh-CN', { hour12: false }) + '</p>' +
    '<table style="width:100%;border-collapse:collapse">' + rows + '</table>' +
    '<p style="color:#888;font-size:12px;margin-top:16px">全部异常已落库可审计。设计目标：半年营收 ¥1000 万（日均 ¥' + (10000000 / 180).toFixed(0) + '）。</p></div>';
  // 真正 await 邮件结果，fired 反映真实送达/失败（mailer 自带超时不挂死）
  try {
    const r = await mailer.send(inbox, subject, html);
    fired.push({ ok: r && r.ok === true, error: !r || r.ok !== true ? (r && r.error || '发送失败') : undefined });
  } catch (e) { fired.push({ ok: false, error: String(e.message || e) }); }
  alerts = fresh.concat(alerts).slice(0, 50);
  return { sent: fresh.length, fired, mailbox: inbox, keys: fresh.map(x => x.key) };
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// —— 一轮完整体检：scan + dispatch（供定时器与手动触发复用之）——
let lastSig = ''; // 上轮异常签名：仅当异常集合发生翻转时落审计，常态持续不刷屏
async function patrol(force) {
  const __t0 = performance.now();   // 【2026-09】tasktime 登记
  try {
    return await __patrolInner(force);
  } finally {
    try { require('./tasktime').record('watchdog.patrol', performance.now() - __t0); } catch (e) {}
  }
}

async function __patrolInner(force) {
  // 先自愈再告警：能自动修复的资源性异常先处置，处置后重新扫描，残余异常才走人工告警
  let list = scanNow();
  if (!force) await healOnce(list);
  list = scanNow(); // 自愈后重扫，反映真实剩余异常
  const r = await dispatch(force ? list : list); // force 只影响冷区，这里保留 throttling 语义统一
  // 诚实审计：只在异常集合变化（出现/消失/换新）或手动触发时记账；每 60s 逐条写会淹没真实操作日志
  const sig = list.map(x => x.key).sort().join(',');
  if (sig !== lastSig || force) {
    store.push('audit', { action: '24h监控巡检', detail: '发现异常 ' + list.length + ' 项，' + (r.sent ? '已邮件告警 ' + r.sent + ' 封' : '无需告警') + (list.length ? '：【' + list.map(x => x.title).join(' / ') + '】' : '，状态恢复健康') }, null, null);
    lastSig = sig;
  }
  return { count: list.length, anomalies: list, alert: r };
}

// boot：启动定时巡检。扫描周期由 devcap 依设备能力推导（弱机自动降频到 5min），
// 地址可经 settings.alertEmail 改。
function boot() {
  if (timer) return;
  // 设备自适应：读 devcap 推导的监控周期（可被 settings.watchdogScanSec 覆盖）
  let sec = 0;
  try { sec = Number(store.getSetting('watchdogScanSec')) || require('./devcap').plan().watchdogScanSec || 60; } catch (e) { sec = 60; }
  scanMs = Math.max(30, Math.round(sec)) * 1000;
  timer = setInterval(() => { try { patrol().catch(() => {}); } catch (e) {} }, scanMs);
  // 启动后立即执行一轮（不等哨兵周期）
  setTimeout(() => { try { patrol().catch(() => {}); } catch (e) {} }, 1500);
  return { ok: true, scanMs, inbox: store.getSetting('alertEmail') || DEFAULT_INBOX };
}

function status() {
  return {
    ok: true, running: !!timer, scanMs, cooldownMin: COOLDOWN_MS / 60000,
    inbox: store.getSetting('alertEmail') || DEFAULT_INBOX,
    lastScan, alerts: alerts.slice(0, 10), heals: healLog.slice(0, 10), mailLog: mailer.log(5)
  };
}

// 最近告警（含内容）：供其他模块（CEO 晨报、指挥塔）消费。
// 此前 alerts 是模块私有、且未导出，导致 goalpilot.brief() 的异常行永远是死的。
function recentAlerts(n) { return (alerts || []).slice(0, n || 10); }
function recentHeals(n) { return (healLog || []).slice(0, n || 10); }

module.exports = { boot, scanNow, patrol, dispatch, status, recentAlerts, recentHeals, DEFAULT_INBOX };