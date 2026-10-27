// core/crm.js — CRM-lite：把已有的「获客漏斗 + 客户 + 履约订单」收敛成一张
// 「线索 → 商机 → 成交 → 复购」的经营视图（只读聚合，不改任何业务流）。
//
// 为什么单独做：leadgen.js 的 board() 是给 24h 轮巡用的**操作视图**（讲触达节奏），
// 运营/买家真正要看的是 CRM 口径的漏斗与「下一步该我做什么」。两者混在一起，
// 每次看板都有人把"机器排了 2 次计划"误读成"已经推进 2 次"。
//
// 诚实纪律（与 money.js / evidence-pipeline.js 同一套）：
//   1. 只统计库里**真实存在**的记录，绝不按计划数虚构阶段。
//   2. 金额只认**人工确认真实成交**（客户 amount + 待成交 deal）；planned 计划数
//      单独列出、永不计入进展，也永不进金额。
//   3. 转化率是「当前累计」口径（客户数 / 线索总数），不是同期 cohort；
//      且明示"预测成交率"是模型排序值，不是承诺。
//   1 条真实记录 = 1；没有任何编造的示例线索/假客户。

const store = require('./store');

const CLOSE_MIN_TOUCH = 2; // 与 leadgen 保持一致：只有人工确认真实触达才计数

function nameOf(l) {
  return String((l && (l.company || l.name || l.hook || l.title)) || (l && l.id) || '').slice(0, 80);
}

// 当前各段位存量（真实计数）。探测/触达同属漏斗口，合并为「线索」。
function pipeline() {
  const db = require('./store').read();
  const leads = db.leads || [];
  const customers = db.customers || [];
  const count = s => leads.filter(l => l.stage === s).length;
  const inStages = ss => leads.filter(l => ss.indexOf(l.stage) >= 0).length;

  const opps = leads.filter(l => l.stage === '商机候选');
  const pending = leads.filter(l => l.stage === '待成交');
  const nurture = leads.filter(l => l.stage === '长期跟进');

  const customerAmount = customers.reduce((a, c) => a + Number(c.amount || 0), 0);
  const pendingAmount = pending.reduce((a, l) => a + Number(l.deal || 0), 0);
  const total = leads.length;

  return {
    ok: true,
    funnel: [
      { stage: '线索', key: 'lead', count: inStages(['触达', '探测']) },
      { stage: '推荐', key: 'recommend', count: count('推荐') },
      { stage: '选择', key: 'select', count: count('选择') },
      { stage: '优化', key: 'optimize', count: count('优化') },
      { stage: '促单', key: 'promote', count: count('促单') },
      { stage: '商机候选', key: 'opportunity', count: opps.length },
      { stage: '待成交', key: 'pending', count: pending.length },
      { stage: '客户', key: 'customer', count: customers.length }
    ],
    total, customers: customers.length,
    opportunities: opps.length,
    pendingDeals: pending.length,
    nurture: nurture.length,
    // 诚实口径分开摆：机器排了多少计划 ≠ 人真做了多少接触
    realTouches: leads.reduce((s, l) => s + Number(l.touch || 0), 0),
    plannedOnly: leads.reduce((s, l) => s + Number(l.planned || 0), 0),
    waitingHuman: leads.filter(l => l.stage === '促单' && Number(l.touch || 0) < 2).length,
    // 金额只认人工确认真实成交
    revenue: customerAmount + pendingAmount,
    pendingAmount, customerAmount,
    leadToCustomerRate: total ? Number((customers.length / total).toFixed(3)) : 0,
    blocked: nurture.reduce((m, l) => { const k = l.blockedOn || 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {}),
    note: '转化率为「当前累计」口径（客户数/线索总数），非同期 cohort，不得当作承诺；金额仅来自人工确认的真实成交。'
  };
}

// 商机候选清单：每条的下一步动作。金额一律留空（等人工线下洽谈后经 convert() 填）。
function opportunities() {
  const leads = require('./store').read().leads || [];
  let convProb = () => null;
  try { convProb = require('./leadgen').convProb; } catch (e) {}
  return leads.filter(l => l.stage === '商机候选').map(l => ({
    id: l.id,
    name: l.company || l.name || l.hook || l.id,
    industry: l.industry || '',
    signal: Number(l.signal || 0),
    touch: Number(l.touch || 0),
    predictedPct: convProb(l), // 模型预测，仅排序用，不是承诺
    nextAction: '人工线下洽谈后，用 POST /v1/leads/' + l.id + '/convert {"amount":<真实金额>} 确认成交',
    // 商机候选 = 未经人工确认金额。历史上可能有机器/旧代码留下的 deal 值，
    // 一律降级为「估算」，绝不当成成交金额呈现（crm.pipeline 的 revenue 也只认已确认的）。
    dealConfirmed: false,
    estimatedDeal: l.deal == null ? null : Number(l.deal)
  }));
}

// 客户生命周期（新客/复购/沉睡/流失），复用 leadgen 口径。
function customers() {
  try { return require('./leadgen').lifecycle(); } catch (e) { return []; }
}

// 一句话摘要（给 MCP / 看板复用）。
function summary() {
  const p = pipeline();
  const byKey = {};
  p.funnel.forEach(f => { byKey[f.key] = f.count; });
  return {
    ok: true,
    leads: p.total,
    opportunities: p.opportunities,
    pendingDeals: p.pendingDeals,
    customers: p.customers,
    revenue: p.revenue,
    waitingHuman: p.waitingHuman,
    realTouches: p.realTouches,
    plannedOnly: p.plannedOnly,
    stageCounts: byKey,
    note: p.note
  };
}

module.exports = { pipeline, opportunities, customers, summary };
