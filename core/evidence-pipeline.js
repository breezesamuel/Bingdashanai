// core/evidence-pipeline.js — 商业化证据获取管线
//
// 铁律（不可妥协）：
//   只收录「真实发生、可追溯、带逐字原话」的证据。
//   绝不编造、绝不填充、绝不用模板充数。
//
// 证据来源有且只有两个：
//   1) 真实触达回复 —— outreach.ingestReply 收到的客户原文（最理想的一手证据）
//   2) 人工录入的真实对话 —— 必须填原话 quote + 渠道 channel + 来源类型 sourceType
//
// 与 core/evidence.js 的区别：
//   evidence.js 是「打法证据分级」（A/B/C 级 + 性价比排序），属于内部打法。
//   本文件是「商业化外部证据存证」，只认外部真实证据，两者不要混用。

const store = require('./store');

// 原始证据类型（只认外部可追溯来源，不接受"内部/自我"）
const SOURCE_TYPES = new Set([
  'chat', 'dm', 'private_message', 'group_chat', 'wechat', 'qq', 'discord', 'slack',
  'post', 'forum', 'reddit', 'hackernews', 'xiaohongshu', 'zhihu', 'weibo',
  'issue', 'github_issue', 'gitlab_issue',
  'email', 'ticket', 'support_ticket',
  'order', 'preorder', 'waitlist',
  'payment', 'receipt', 'invoice', 'charge',
  'review', 'appstore_review', 'playstore_review', 'g2', 'capterra', 'trustpilot',
  'comment', 'thread', 'conversation', 'survey', 'interview'
]);

// 商业化证据维度（每项都是真实准入条件，不是装饰）
// RETENTION 基于真实 ecomEvents 行为推算（非匿名用户 + 复用行为）。
const DIMENSIONS = ['ICP', 'JTBD', 'UVP', 'WTP', 'TRACTION', 'FIRST_CUSTOMER', 'RETENTION'];

// 关键词 → 维度（仅用于自动打标签，标记 auto:true，仍需人工确认后才计入正式证据）
const TAG_HINTS = {
  ICP:             ['我们团队', '我们是', '我们在做', '我们主要', '我们是一家', '我们属于'],
  JTBD:            ['我们需要', '我们正在找', '我们想解决', '我们想减少', '我们痛点', '我们遇到', '我们的问题是', '我们试过', '我们一直'],
  UVP:             ['比', '相比', '替代', 'instead', 'vs', '为什么是你们', '和现有', '市面上的', '不如'],
  WTP:             ['愿意付', '能付费', '预算', '报价', '多少钱', '价格', 'prepay', 'pay', 'order', '买', '订阅', 'subscribe', '定金'],
  TRACTION:        ['想试', '想用', '要对接', '约聊', '加微信', '发我看看', '试用', '我来试试', '什么时候能用', '怎么接入'],
  FIRST_CUSTOMER:  ['第一个', '首位', '首批', 'preorder', 'waitlist', '尝鲜'],
  RETENTION:       ['还在用', '一直在用', '用了几次', '持续用', '复用', '离不开', '每天都用', '习惯用']
};

function genId() {
  return 'ev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function validSourceType(st) { return st && SOURCE_TYPES.has(String(st).toLowerCase()); }

function hasForbidden(s) {
  const t = String(s || '').toLowerCase();
  return /(need_real_|bootstrap|self-use|self_use|internal|myself|i think|i feel|template|模板|臆测)/.test(t);
}

// 自动打标签（不确认，仅提示维度归属）
function autoTag(quote) {
  const q = String(quote || '').toLowerCase();
  const tags = [];
  for (const dim of Object.keys(TAG_HINTS)) {
    if (TAG_HINTS[dim].some(k => q.includes(k.toLowerCase()))) tags.push(dim);
  }
  return tags;
}

// 核心：把一条真实回复结构化为证据
function captureReply({ leadId, name, channel, quote, outboundRef }) {
  if (!quote || String(quote).trim().length < 8) {
    return { ok: false, error: '原话逐字 >=8 字才算证据（避免「感兴趣」一句充数）' };
  }
  if (hasForbidden(quote)) return { ok: false, error: '含臆测/模板用语，拒绝收录' };
  const db = store.read();
  if (!db.marketEvidence) db.marketEvidence = [];
  const item = {
    id: genId(),
    ts: Date.now(),
    leadId: leadId || null,
    name: name || null,
    channel: channel || 'unknown',
    sourceType: 'chat',      // 触达回复默认 chat（可人工改为 dm/email 等）
    quote: String(quote).trim(),
    outboundRef: outboundRef || null,
    tags: autoTag(quote),
    auto: true,              // 自动打标签，未人工确认
    confirmed: false         // 需人工确认后才计入正式证据
  };
  db.marketEvidence.push(item);
  store.write(db);
  return { ok: true, evidence: item };
}

// 人工录入真实对话（必须带逐字原话）
function captureManual({ sourceType, channel, quote, name, leadId, note }) {
  if (!validSourceType(sourceType)) return { ok: false, error: 'sourceType 无效' };
  if (!quote || String(quote).trim().length < 8) return { ok: false, error: '原话逐字 >=8 字' };
  if (hasForbidden(quote)) return { ok: false, error: '含臆测/模板用语，拒绝收录' };
  const db = store.read();
  if (!db.marketEvidence) db.marketEvidence = [];
  const item = {
    id: genId(),
    ts: Date.now(),
    leadId: leadId || null,
    name: name || null,
    channel: channel || 'unknown',
    sourceType,
    quote: String(quote).trim(),
    note: note || null,
    tags: autoTag(quote),
    auto: false,
    confirmed: false
  };
  db.marketEvidence.push(item);
  store.write(db);
  return { ok: true, evidence: item };
}

function list() {
  const db = store.read();
  return (db.marketEvidence || []).slice().sort((a, b) => b.ts - a.ts);
}

function confirm(id) {
  const db = store.read();
  const it = (db.marketEvidence || []).find(x => x.id === id);
  if (!it) return { ok: false, error: '证据不存在' };
  it.confirmed = true;
  it.confirmedAt = Date.now();
  store.write(db);
  return { ok: true, evidence: it };
}

// 基于真实 ecomEvents 行为的留存指标（来自 retention-dashboard skill 框架）
// 铁律：只统计真实行为事件，排除匿名用户；空就是 0，绝不编造百分比。
function retentionMetrics() {
  const db = store.read();
  const evs = db.ecomEvents || [];
  if (!evs.length) return { users: 0, reused: 0, reuseRate: 0, note: '无真实行为事件' };

  const byUser = new Map();
  for (const e of evs) {
    const uid = e.userId || e.sessionId;
    if (!uid) continue; // 严格排除匿名
    const d = Math.floor(e.ts / 86400000);
    if (!byUser.has(uid)) byUser.set(uid, { first: d, last: d, cnt: 1 });
    else {
      const v = byUser.get(uid);
      v.first = Math.min(v.first, d); v.last = Math.max(v.last, d); v.cnt++;
    }
  }
  const users = Array.from(byUser.values());
  const reused = users.filter(u => u.cnt >= 2);
  return {
    users: users.length,
    reused: reused.length,
    reuseRate: users.length ? Math.round(reused.length / users.length * 100) / 100 : 0,
    avgActions: users.length ? Math.round(users.reduce((s, u) => s + u.cnt, 0) / users.length * 10) / 10 : 0,
    note: '基于真实 ecomEvents，排除匿名用户'
  };
}

// 诚实状态：每个维度有多少条「已确认」证据 + 总条数 + 真实留存指标
function status() {
  // 诚实红线：synthetic 标记是开发期特征数据，永不参与门禁/统计（清理脚本写入）。
  const evs = list().filter(e => e.synthetic !== true);
  const confirmed = evs.filter(e => e.confirmed);
  const byDim = {};
  DIMENSIONS.forEach(d => { byDim[d] = { total: 0, confirmed: 0, items: [] }; });
  for (const e of evs) {
    for (const d of e.tags) {
      if (!byDim[d]) continue;
      byDim[d].total++;
      if (e.confirmed) { byDim[d].confirmed++; byDim[d].items.push(e.id); }
    }
  }
  return {
    total: evs.length,
    confirmed: confirmed.length,
    dims: DIMENSIONS.map(d => ({ dim: d, confirmed: byDim[d].confirmed, total: byDim[d].total })),
    retention: retentionMetrics(),
    list: evs.slice(0, 50)
  };
}

module.exports = { captureReply, captureManual, list, confirm, status, DIMENSIONS, SOURCE_TYPES, autoTag };
