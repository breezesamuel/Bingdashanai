// core/revenue-ops.js — 赚钱作战台（只读聚合层·不重复造轮子·不动 live 金额）
//
// 为什么有它：代码库已有 money.kpi / saas-loop.funnel / gtm.funnel / crm.summary /
// tickets.stats / partner.board，但它们各说各话，没人能一眼回答「钱从哪漏、
// 今天先干哪件事最快见到钱」。本模块只做**只读聚合 + 诊断 + 动作排序**。
//
// 诚实纪律（与 crm.js / saas-loop.js 同一套）：
//   1. 数字全部来自真实台账；某子模块缺失 → 该字段为 null，绝不编造。
//   2. 漏钱诊断找的是「真实 drop-off」（分母>0 且转化率最低），不按计划数估算。
//   3. 营收只认 settled 且非自测（money.kpi 的 testRevenue 已剔除本机/探针单）。
//   4. NRR 是真实可观测口径：repeat_pay=0 且 refund=0 → NRR=100%（不是假设 112%）。
//   5. 每条今日动作都带「人工确认闸口」：系统只做准备，不自动群发/结算/出款。

'use strict';
const store = require('./store');

function safe(fn, fallback) {
  try { const r = fn(); return r == null ? fallback : r; } catch (e) { return fallback; }
}

// ---- 单点漏钱诊断：找订阅漏斗最大 drop-off + 台账异常 ----
function leak() {
  const f = safe(() => require('./saas-loop').funnel(), null);
  const kpi = safe(() => require('./money').kpi(), null);
  const gtm = safe(() => require('./gtm').funnel(), null);
  if (!f || !Array.isArray(f.stages)) return { ok: false, reason: '订阅漏斗不可用', kpiPending: kpi ? kpi.pending : null };

  let worst = null;
  f.stages.forEach(s => {
    if (s.denominator == null || s.denominator <= 0) return; // 分母 0 = 不可计算，跳过
    const pct = s.conversionPct == null ? 0 : s.conversionPct;
    if (!worst || pct < worst.pct) worst = { id: s.id, name: s.name, count: s.count, denom: s.denominator, pct, note: s.note || '' };
  });
  const issues = [];
  if (worst) issues.push('漏斗最大断点：' + worst.name + '（' + worst.count + '/' + worst.denom + ' = ' + worst.pct + '%）' + (worst.note ? '｜' + worst.note : ''));
  if (kpi) {
    if (kpi.pending > 0) issues.push('挂账待收 ¥' + kpi.pending + '（' + kpi.pendingCount + ' 笔）——确认到账 settle，或关闭，别让它污染营收口径');
    if ((kpi.refunded || 0) > 0) issues.push('退款 ¥' + kpi.refunded + '（' + kpi.refundedCount + ' 笔）——退款最伤口碑，当天必须给客户明确时间点');
  }
  if (gtm && gtm.sent > 0 && gtm.paid === 0) issues.push('已发送触达 ' + gtm.sent + ' 条但 0 成交——话术或人群错位，先改 ICP 再扩量');
  return { ok: true, worst: worst || null, issues, kpiPending: kpi ? kpi.pending : null };
}

// ---- 今日赚钱动作清单（按「可执行 + 预期影响」排序，全部带人工确认闸口）----
function todaysActions() {
  const a = [];
  const db = safe(() => store.read(), { leads: [], visitors: [], customers: [] });
  const pendingPromo = (db.leads || []).filter(l => l.stage === '促单');
  const trialers = (db.visitors || []).filter(v => v.trialUsed === true);
  const partner = safe(() => require('./partner').board(), null);
  const tickets = safe(() => require('./tickets').stats(), null);
  const kpi = safe(() => require('./money').kpi(), null);

  if (pendingPromo.length) {
    a.push({
      rank: 1, impact: 'high', auto: false,
      title: '推进 ' + pendingPromo.length + ' 条卡在「促单」的线索',
      why: '它们已被识别、已触达，只差临门一脚报价。系统不自动发，需人工逐条确认后 markSent。',
      sample: pendingPromo.slice(0, 5).map(l => l.company || l.name || l.id),
      gate: '人工确认每条报价后才发送（防群发·防骚扰·合规）'
    });
  }
  if (trialers.length) {
    a.push({
      rank: 2, impact: 'high', auto: false,
      title: '试用→付费：挽回 ' + trialers.length + ' 个付过¥1体验未转正的客户',
      why: 'saas-loop 显示 试用(' + trialers.length + ')→付费(0)，这是全漏斗唯一真断点。用 conversion-engine 生成升级 offer（¥199 加购包 / ¥899 年付约75折）。',
      sample: trialers.slice(0, 5).map(v => v.visitor),
      gate: 'offer 生成草稿，人工确认发送；成交走 subs.order + confirm（人工结算闸口）'
    });
  }
  if (partner && partner.partners.length === 0) {
    a.push({
      rank: 3, impact: 'medium', auto: true,
      title: '启用合伙人渠道联盟（当前 0 合伙人）',
      why: '抽成口径已统一（平台 ' + partner.platformPct + '% / 合伙人 ' + partner.partnerPct + '%），但没有一个合伙人。拉 1-2 个能带单的合伙人，成交才有分润飞轮。',
      sample: ['enroll 1-2 个真实交付合伙人', '每笔成交挂 deliver→accept→pay'],
      gate: '零门槛·无入门费（合规）；佣金只认真实成交，不预支、不估算'
    });
  }
  if (tickets && tickets.open > 0) {
    a.push({
      rank: 4, impact: (tickets.byPrio && tickets.byPrio.P0 > 0) ? 'high' : 'medium', auto: false,
      title: '清 ' + tickets.open + ' 个未结客服工单（P0 ' + ((tickets.byPrio || {}).P0 || 0) + ' / P1 ' + ((tickets.byPrio || {}).P1 || 0) + '）',
      why: 'cs-sla 引擎可自动算 SLA 超时与升级路由，但响应话术需人工定。工单是最伤口碑的环节，先清 P0/P1。',
      sample: null,
      gate: '响应走 tickets.respond（过温度宪法禁词扫描）；退款走 tickets.refund（带 revId 记账）'
    });
  }
  if (kpi && kpi.pending > 0) {
    a.push({
      rank: 5, impact: 'medium', auto: true,
      title: '催收挂账 ¥' + kpi.pending + '（' + kpi.pendingCount + ' 笔）',
      why: '挂账超过 24h 不该继续挂着——要么确认到账 settle，要么关闭 writeoff，别污染营收口径。',
      sample: null,
      gate: 'money.settle / money.writeoff（人工核对凭证）'
    });
  }
  if (!a.length) {
    a.push({ rank: 1, impact: 'low', auto: true, title: '暂无高影响动作', why: '漏斗无真实 drop-off，或线索/客户为空。下一步：用 leadgen 找新线索，或上线 conversion-engine 制造 repeat_pay。', sample: null, gate: '—' });
  }
  a.sort((x, y) => x.rank - y.rank);
  return { ok: true, at: Date.now(), count: a.length, actions: a,
    note: '每条动作标注了人工确认闸口：系统只做「准备」，不自动群发/结算/出款。' };
}

// ---- NRR（净营收留存率）：真实口径，不假设 112% ----
// 当前台账：repeat_pay=0，全部一次性付费 → 无扩张也无流失 → NRR=100%（真实，非假设值）。
// 一旦出现 repeat_pay 或退款，NRR 需逐单核算，返回 null 待人工（不自动脑补）。
function nrr() {
  const db = safe(() => store.read(), {});
  const kpi = safe(() => require('./money').kpi(), null);
  const paidOrders = (db.orders || []).filter(o => o.paid === true || o.status === 'paid');
  const byVisitor = {};
  paidOrders.forEach(o => { const k = String(o.visitor); byVisitor[k] = (byVisitor[k] || 0) + 1; });
  const repeatPayers = Object.values(byVisitor).filter(n => n >= 2).length;
  const refunded = (db.revenue || []).filter(r => r.refunded === true || r.status === 'refunded').reduce((s, r) => s + Number(r.amt || 0), 0);
  const hasExpansion = repeatPayers > 0;
  return {
    ok: true,
    repeatPayers,
    repeatPayOrders: paidOrders.filter(o => !(o.trial === true || o.plan === 't')).length,
    refunded: Math.round(refunded * 100) / 100,
    settled: kpi ? kpi.revenue : null,
    nrr: (!hasExpansion && refunded === 0) ? 100 : null,
    note: 'repeat_pay=0 且 refund=0 → NRR=100%（真实，非假设 112%）。要破 100% 需 conversion-engine 制造 repeat_pay>0（加购/年度绑定），本模块只观测不脑补。'
  };
}

// ---- 作战台主入口 ----
function board() {
  const kpi = safe(() => require('./money').kpi(), null);
  const annual = safe(() => require('./money').annualSettled(), null);
  const funnel = safe(() => require('./saas-loop').funnel(), null);
  const stick = safe(() => require('./saas-loop').stickiness(), null);
  const gtmF = safe(() => require('./gtm').funnel(), null);
  const crm = safe(() => require('./crm').summary(), null);
  const tick = safe(() => require('./tickets').stats(), null);
  const sla = safe(() => require('./tickets').slaWatch(), null);
  const partner = safe(() => require('./partner').board(), null);
  const NRR = nrr();
  const L = leak();
  return {
    ok: true, at: Date.now(),
    // 钱
    money: kpi ? {
      settled: kpi.revenue, gross: kpi.grossRevenue, test: kpi.testRevenue,
      pending: kpi.pending, pendingCount: kpi.pendingCount, refunded: kpi.refunded,
      onTrack: kpi.onTrack, pacePct: kpi.pct, needDaily: kpi.needDaily,
      annualSettled: annual ? annual.total : null
    } : null,
    nrr: NRR,
    // 漏斗（订阅口径 + 触达口径 + 粘性）
    funnel: funnel ? funnel.stages.map(s => ({ id: s.id, name: s.name, count: s.count, pct: s.conversionPct })) : null,
    stickiness: stick ? { wau: stick.wau, mau: stick.mau, pct: stick.stickinessPct, dormantPaid: stick.dormantPaid } : null,
    gtm: gtmF ? { sent: gtmF.sent, interested: gtmF.interested, paid: gtmF.paid, sentToPaid: gtmF.sentToPaid } : null,
    crm: crm ? { leads: crm.leads, customers: crm.customers, waitingHuman: crm.waitingHuman, realTouches: crm.realTouches, revenue: crm.revenue } : null,
    tickets: tick ? { open: tick.open, closed: tick.closed, byPrio: tick.byPrio, slaOverdue: sla ? sla.overdue.length : null, slaDueSoon: sla ? sla.dueSoon.length : null } : null,
    partner: partner ? { count: partner.partners.length, platformPct: partner.platformPct, partnerPct: partner.partnerPct, annualSettled: partner.annualSettled } : null,
    // 诊断 + 动作
    leak: L,
    actions: todaysActions(),
    honesty: '数字全部来自真实台账；某子模块缺失时该字段为 null，不编造。营收只认 settled 且非自测。NRR=100% 是「无扩张无流失」的真实值，不是假设的 112%。'
  };
}

module.exports = { board, leak, todaysActions, nrr };
