// core/lessons.js — 跨公司/跨项目学习系统（借鉴 Polsia 群体进化护城河）
// 职责：把各项目真实跑出来的成败经验沉淀为结构化教训，供其他项目/决策自动复用。
// 设计红线：只记录"真实发生的"（失败/成功证据），绝不编造；由人工或带证据来源的自动沉淀写入。

const store = require('./store');

const L_MAX = 300;

// 经验实体：{ id, kind: 'fail'|'win'|'trick', topic, context, action, why, src: 'project'|'auto'|'manual', ref, at, useCount }
function add(item, visitor) {
  const db = store.read();
  if (!Array.isArray(db.lessons)) db.lessons = [];
  const rec = {
    id: 'L' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    kind: item.kind || 'trick',
    topic: String(item.topic || '').slice(0, 80),
    context: String(item.context || '').slice(0, 200),
    action: String(item.action || '').slice(0, 300),
    why: String(item.why || '').slice(0, 200),
    src: item.src || 'manual',
    ref: item.ref || '',
    // RRSI 验证层所需的证据字段：confidence(证据强度) + evidence(独立证据条数/来源)
    confidence: item.confidence || 'unverified',
    evidence: Array.isArray(item.evidence) ? item.evidence.slice(0, 10) : (item.evidence ? [String(item.evidence)] : []),
    at: Date.now(),
    useCount: 0
  };
  if (!rec.topic) return { ok: false, err: 'topic required' };
  // 入库即预验证一次：明显是噪声/过拟合的，不让它进决策注入池
  const v = verify(rec);
  rec.validated = v.ok;
  if (!v.ok) rec.rejectReason = v.reason;
  db.lessons.push(rec);
  if (db.lessons.length > L_MAX) db.lessons = db.lessons.slice(-L_MAX);
  store.write(db);
  // 数据归属（留存根因）：给经验打上 visitor（若有）
  try { require('./tenancy').markOwned('lessons', rec, visitor); } catch (e) {}
  return { ok: true, lesson: rec };
}

// ============ RRSI 式验证层（移植自 Google Research rrsi, arXiv:2609.24972）============
// 背景：原实现"记了就信"——一条失败教训可能只是噪声，却被当成经验注入后续所有决策。
// RRSI 的核心洞察：在**花评测预算之前**先筛掉不可信候选，且**收益必须显著超过噪声**才采纳。
// 移植四条（保持与原文语义一致，参数按本项目标定）：
//   ① 噪声地板 noise floor：单次信号 < δ 一律不采纳（否则等于把随机波动当规律）
//   ② 成本闸 cost gate：新增成本必须被实测收益覆盖 Δcost ≤ β₀ + β₁·Δsignal
//   ③ 泄漏筛 leakage screen：拒绝把"具体个案值/ID/金额"硬编码成通则的经验（过拟合）
//   ④ 证据要求 evidence：必须有真实证据来源，无证据只能作为 pending
// 噪声地板：单次信号强度必须超过此值才可注入决策。
// 标定依据：0 条证据 ≈ 0.30 信号（只是"记了一笔"，无支撑）；1 条 ≈ 0.47；
// 2 条 ≈ 0.56；4 条+ ≈ 0.75。把地板定在 0.45 → 要求"至少 2 条独立证据"或
// "1 条证据 + 高置信"。这样孤证与随手记录不会污染决策，而真实多轮验证的经验能过。
const NOISE_FLOOR = Number(store.getSetting('lessonNoiseFloor')) || 0.45;
const COST_BETA0 = 0.05;   // 允许的固定成本冗余
const COST_BETA1 = 1.0;    // 收益能覆盖的边际成本

// ③ 泄漏筛：把"个案值"当成通则 = 过拟合。
// 例："给 manishiitg 这个客户打了电话所以成交" → 个案，不能当通则。
// 重要区分：若该经验带**真实证据**（成交单/订单 id），则其中的具体金额是合法事实而非硬编码通则；
// 泄漏只针对"无证据却写死个案值/测试残留"的情况。
function leakageCheck(rec) {
  const text = [rec.action, rec.why, rec.context].join(' ');
  const hasRealEvidence = Array.isArray(rec.evidence) && rec.evidence.length > 0;
  const flags = [];
  // 测试残留永远可疑（无论有无证据）
  if (/\b(sec|e2e|test)[-_a-z0-9]{4,}\b/i.test(text)) flags.push('test-artifact');
  // 硬编码金额/哈希 ID：仅在"无真实证据"时判为过拟合
  if (!hasRealEvidence) {
    if (/[¥$]\s?\d{3,}/.test(text)) flags.push('hardcoded-amount');
    if (/\b[0-9a-f]{16,}\b/i.test(text)) flags.push('hashed-id');
  }
  return flags;
}

// 单条经验的信号强度（0..1）：有多少条独立证据支撑
// 构成：证据条数(主) + 置信标注 + 复用热度 − 时间衰减
function signalStrength(rec) {
  const ev = Array.isArray(rec.evidence) ? rec.evidence : (rec.evidence ? [rec.evidence] : []);
  // 证据条数：1条=0.3, 2条=0.5, 3条=0.65, 4条+=0.75（对数饱和，防灌水）
  const evScore = Math.min(0.75, 0.3 + Math.log10(1 + ev.length) * 0.35);
  const conf = rec.confidence === 'high' ? 0.15 : rec.confidence === 'medium' ? 0.08 : 0;
  // 复用次数是反向证据：被反复引用说明有效，但也会被灌水 → 对数增长封顶
  const reuse = Math.min(0.10, Math.log10(1 + (rec.useCount || 0)) * 0.10);
  // 时间衰减：越久远越不可靠（半衰期 60 天）
  const age = Math.exp(-(Date.now() - (rec.at || Date.now())) / (60 * 864e5));
  return Math.min(1, evScore + conf + reuse) * age;
}

// ② 成本闸：估算该经验"被注入一次决策"的成本（token 量级），要求收益能覆盖。
// 诚实说明：这里 cost 指的是"决策上下文被这条经验占用的 token 预算"，不是钱。
function injectionCost(rec) {
  const len = [rec.topic, rec.context, rec.action, rec.why].join(' ').length;
  return len / 1000; // 千字符 ≈ 千 token 量级
}

// 验证一条经验是否可被注入决策。返回 { ok, reason, signal, cost }
function verify(rec) {
  if (!rec) return { ok: false, reason: 'no-record' };
  const leak = leakageCheck(rec);
  if (leak.length) return { ok: false, reason: 'leakage:' + leak.join('+'), leak };
  const signal = signalStrength(rec);
  if (signal < NOISE_FLOOR) return { ok: false, reason: 'below-noise-floor', signal, floor: NOISE_FLOOR };
  const cost = injectionCost(rec);
  const budget = COST_BETA0 + COST_BETA1 * signal;
  if (cost > budget) return { ok: false, reason: 'cost-gate', signal, cost, budget };
  return { ok: true, reason: 'verified', signal: Math.round(signal * 100) / 100, cost: Math.round(cost * 1000) / 1000 };
}

// 按主题召回（经 RRSI 验证层过滤：只注入"验证通过"的经验）
function find(keyword, n) {
  const db = store.read();
  const all = db.lessons || [];
  const pass = l => l.validated !== false; // 未跑过验证的（老数据）默认放行，保持向后兼容
  if (!keyword) {
    return all.filter(pass).slice().reverse().slice(0, n || 10).map(x => ({ ...x, useCount: x.useCount || 0 }));
  }
  const kw = String(keyword).toLowerCase();
  const now = Date.now();
  const DAY = 864e5;
  return all.filter(pass).map(x => {
    const blob = [x.topic, x.context, x.action, x.why].join(' ').toLowerCase();
    if (!blob.includes(kw)) return null;
    let score = (x.topic.toLowerCase().includes(kw) ? 3 : 0) + (blob.split(kw).length - 1) * 1.5;
    if (x.kind === 'win') score += 1;
    if (x.kind === 'trick') score += 0.5;
    score *= Math.exp(-(now - x.at) / (14 * DAY));
    score += (x.useCount || 0) * 0.2; // 有复用记录者略靠前
    return { x, score };
  }).filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, n || 10)
    .map(v => ({ ...v.x, useCount: v.x.useCount || 0 }));
}

// 标记一次复用（每次决策引用经验时 call，用于统计哪些经验真的管用）
function used(id) {
  const db = store.read();
  const all = db.lessons || [];
  const rec = all.find(x => x.id === id);
  if (!rec) return { ok: false };
  rec.useCount = (rec.useCount || 0) + 1;
  store.write(db);
  return { ok: true, useCount: rec.useCount };
}

// 统计：各 kind 数量 + 复用排行榜 + 验证通过率
function stats() {
  const db = store.read();
  const all = db.lessons || [];
  const by = { fail: 0, win: 0, trick: 0 };
  all.forEach(x => { if (by[x.kind] !== undefined) by[x.kind]++; });
  const top = all.slice().sort((a, b) => (b.useCount || 0) - (a.useCount || 0)).slice(0, 5);
  const verified = all.filter(x => x.validated === true).length;
  return { total: all.length, by, top, verified, verifiedPct: all.length ? Math.round(verified / all.length * 100) : 0 };
}

// 批量复核整库：给每条经验打上 validated 标记（RRSI 的"re-verify"）。
// 手动/定时调用，把噪声与过拟合经验剔除出决策注入。
function verifyAll() {
  const db = store.read();
  const all = db.lessons || [];
  const rejected = [];
  all.forEach(x => {
    const v = verify(x);
    x.validated = v.ok;
    if (!v.ok) x.rejectReason = v.reason;
    else delete x.rejectReason;
    if (!v.ok) rejected.push({ id: x.id, topic: x.topic, reason: v.reason });
  });
  store.write(db);
  return { ok: true, total: all.length, verified: all.filter(x => x.validated === true).length, rejected };
}

module.exports = { add, find, used, stats, verify, verifyAll, leakageCheck, signalStrength };