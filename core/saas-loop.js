// core/saas-loop.js — 订阅制商业闭环体检（真实数据，不做演示数字）
//
// 【为什么要有它】系统里已有一个 commercial-loop（获客→沟通→成交→物流→履约→售后→进化），
// 但它描述的是**B2B 线索/交付**模式；我们实际收钱靠的是**订阅**（subs.js + pay.js）。
// 两套口径各自存在，却没有一条链路把"访问→试用→付费→激活→留存→续费→转介绍"
// 串起来，于是没人能回答：付费客户有没有真的用起来？到期会不会续？断在哪一段？
//
// 本模块只做三件事：
//   1) funnel()    每个阶段用真实台账算人数与转化率；分母为 0 时返回 null（不写 0.0% 假装精确）
//   2) stickiness() 活跃/粘性/使用频率（依赖 2026-10-23 起新增的 usageDays 埋点）
//   3) integrity() 闭环断裂检查：付了钱没权益、有权益不用、待付超时、凭证悬挂、退款悬空…
//
// 【铁律】测试/自用访客一律剔除，并如实报告剔除数量；不把自测当客户。
'use strict';
const store = require('./store');

const DAY = 86400000;
const INTERNAL = /^(regress|diag|test|e2e|receipt-probe|local|probe)[:\-_]/i;
const LOOPBACK = /^ip:(127[._]0[._]0[._]1|0[._]0[._]0[._]0|::1)/i;

function isInternal(key) {
  const s = String(key || '');
  return INTERNAL.test(s) || LOOPBACK.test(s);
}
function ymd(ts) {
  const d = new Date(Number(ts) || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function rate(n, d) {
  if (!d) return null;                    // 0/0 不是 0%，是"不可计算"
  return Math.round((n / d) * 1000) / 10;
}
function hasUsage(v) {
  if (!v) return false;
  const days = v.usageDays && typeof v.usageDays === 'object' ? Object.keys(v.usageDays) : [];
  if (days.length) return true;
  if (Number(v.firstUseAt) > 0) return true;
  if (Number(v.used) > 0) return true;    // 旧版 gate() 计数（兼容历史）
  const pools = v.pools || {};
  return Object.keys(pools).some(k => Number(pools[k]) > 0);
}
function usageDayCount(v) {
  const days = v.usageDays && typeof v.usageDays === 'object' ? Object.keys(v.usageDays) : [];
  return days.length;
}

function load() {
  const db = store.read();
  const visitors = db.visitors || [];
  const orders = db.orders || [];
  const subs = db.sublist || [];
  const provisional = db.provisional || [];
  const now = Date.now();
  const vByKey = new Map(visitors.map(v => [String(v.visitor), v]));
  const internalVisitors = visitors.filter(v => isInternal(v.visitor));
  const realVisitors = visitors.filter(v => !isInternal(v.visitor));
  const realOrders = orders.filter(o => !isInternal(o.visitor));
  const realSubs = subs.filter(s => !isInternal(s.visitor));
  const activeSubs = realSubs.filter(s => Number(s.expireAt) > now);
  const isPaid = o => o && (o.paid === true || o.status === 'paid');
  const paidOrders = realOrders.filter(isPaid);
  const refundedVisitors = new Set((db.refundRequests || []).filter(r => r.status === 'refunded').map(r => String(r.visitor)));
  return { db, now, vByKey, internalVisitors, realVisitors, realOrders, realSubs, activeSubs, paidOrders, isPaid, refundedVisitors, provisional };
}

// 订阅闭环：访问 → 参与 → 试用 → 付费 → 激活 → 留存 → 续费 → 转介绍
function funnel() {
  const L = load();
  const firstPaidAt = new Map();
  const paidSet = new Set();
  const trialSet = new Set();
  L.paidOrders.forEach(o => {
    const key = String(o.visitor);
    const at = Number(o.at || o.createdAt || 0);
    if (!firstPaidAt.has(key) || at < firstPaidAt.get(key)) firstPaidAt.set(key, at);
    if (o.trial === true || o.plan === 't') trialSet.add(key); else paidSet.add(key);
  });

  const visit = L.realVisitors.length;
  const engaged = L.realVisitors.filter(hasUsage).length;
  const trial = trialSet.size;
  const paid = paidSet.size;
  const trialConverted = [...trialSet].filter(k => paidSet.has(k)).length;

  // 激活：付费后 7 天内有过任意一次真实使用
  let activated = 0;
  paidSet.forEach(key => {
    const v = L.vByKey.get(key);
    if (!v) return;
    const at = Number(firstPaidAt.get(key) || 0);
    const first = Number(v.firstUseAt || 0);
    if (first && at && first >= at - 60000 && first - at <= 7 * DAY) { activated++; return; }
    // 兼容历史：没有埋点但确有使用记录（旧版 used/pools）
    if (!first && hasUsage(v)) activated++;
  });

  // 留存：付费后出现过 ≥2 个不同使用日（复访）；无埋点则不可计算
  const stamped = L.realVisitors.filter(v => v.usageDays && Object.keys(v.usageDays).length);
  let retained7 = 0;
  paidSet.forEach(key => {
    const v = L.vByKey.get(key);
    if (v && usageDayCount(v) >= 2) retained7++;
  });

  // 续费：同一访客有 ≥2 笔非体验付费（体验→月付 是"转化"，不是续费）
  const paidCount = new Map();
  L.paidOrders.filter(o => !(o.trial === true || o.plan === 't')).forEach(o => {
    const k = String(o.visitor); paidCount.set(k, (paidCount.get(k) || 0) + 1);
  });
  const renewed = [...paidCount.values()].filter(n => n >= 2).length;

  // 转介绍：付费访客中带 invitedBy 的人
  const referred = [...paidSet].filter(k => {
    const v = L.vByKey.get(k);
    return !!(v && (v.invitedBy || (Array.isArray(v.invite) && v.invite.length)));
  }).length;

  const stage = (id, name, count, denom, denomName, note) => ({
    id, name, count,
    denominator: denom, denominatorName: denomName,
    conversionPct: rate(count, denom),
    note: note || '',
  });

  return {
    ok: true,
    generatedAt: L.now,
    excluded: { internalVisitors: L.internalVisitors.length, note: '本机/探针/回归访客已剔除，不参与任何转化率' },
    stages: [
      stage('visit', '访问', visit, null, '—', '访客记录数；未登录按 IP·小时桶计，且匿名访客每 5 分钟清理一次，所以是滚动窗口（登录后按账号去重）'),
      stage('engaged', '参与', engaged, visit, '访问', '至少用过一次功能（含免费额度）'),
      stage('trial', '试用(¥1)', trial, engaged, '参与', '付过 ¥1 体验的访客'),
      stage('paid', '付费', paid, engaged, '参与', '付过任意套餐（含后来转月付的体验客户）；试用→付费见 secondary.trialToPaidPct'),
      stage('activate', '激活', activated, paid, '付费', '付费后 7 天内真正用起来'),
      stage('retain', '留存', retained7, paid, '付费', '付费后出现 ≥2 个使用日'),
      stage('renew', '续费', renewed, paid, '付费', '同一访客 ≥2 笔非体验付费'),
      stage('refer', '转介绍', referred, paid, '付费', '付费客户带邀请关系'),
    ],
    secondary: {
      trialToPaidPct: rate(trialConverted, trial),   // 试用→付费（同一个人先试用再买）
      paidDirect: Math.max(0, paid - trialConverted), // 没试用直接付费的人数
      activationPct: rate(activated, paid),
      stampCoverage: stamped.length ? Math.round((stamped.length / Math.max(1, L.realVisitors.length)) * 100) : 0,
      stampSince: '2026-10-23',
      note: '激活/留存依赖 usageDays 埋点（2026-10-23 上线）；此前数据用旧版 used 兼容，覆盖不全时会低估。',
    },
  };
}

// 粘性 / 频率：WAU、MAU、付费客户活跃比例、沉默客户
function stickiness() {
  const L = load();
  const now = L.now;
  const within = (v, days) => {
    const d = v.usageDays || {};
    const from = now - days * DAY;
    return Object.keys(d).some(k => {
      const t = Date.parse(k + 'T00:00:00');
      return isFinite(t) && t >= from - DAY;
    });
  };
  const real = L.realVisitors;
  const wau = real.filter(v => within(v, 7)).length;
  const mau = real.filter(v => within(v, 30)).length;
  const activeSubs = L.activeSubs;
  const activeSubKeys = new Set(activeSubs.map(s => String(s.visitor)));
  const paidActive7 = real.filter(v => activeSubKeys.has(String(v.visitor)) && within(v, 7)).length;
  const dormant = activeSubs.filter(s => {
    const v = L.vByKey.get(String(s.visitor));
    if (!v) return true;
    const last = Number(v.lastUseAt || 0);
    if (last) return now - last > 14 * DAY;
    return !hasUsage(v) && now - Number(s.createdAt || 0) > 7 * DAY;
  }).length;
  let uses = 0, days = 0;
  real.forEach(v => {
    const d = v.usageDays || {};
    Object.keys(d).forEach(k => { uses += Number(d[k]) || 0; days++; });
  });
  return {
    ok: true,
    wau, mau,
    stickinessPct: mau ? Math.round((wau / mau) * 1000) / 10 : null,   // WAU/MAU
    paidCustomers: activeSubKeys.size,
    paidActive7,
    paidActivePct: activeSubKeys.size ? Math.round((paidActive7 / activeSubKeys.size) * 1000) / 10 : null,
    dormantPaid: dormant,
    dormantPct: activeSubKeys.size ? Math.round((dormant / activeSubKeys.size) * 1000) / 10 : null,
    avgUsesPerActiveDay: days ? Math.round((uses / days) * 10) / 10 : null,
    note: 'WAU/MAU 基于 usageDays；沉默=有效订阅但 14 天未使用（或无使用且开通超 7 天）。',
  };
}

// 闭环断裂检查：只报"能复现、有样本"的问题，每条给出处置动作
function integrity() {
  const L = load();
  const now = L.now;
  const out = [];
  const push = (id, severity, title, items, action) => {
    out.push({ id, severity, title, count: items.length, samples: items.slice(0, 5), action });
  };
  const vKey = o => String(o.visitor || '');

  // 1) 付了钱但没权益（含临时授权已过期）
  const provLive = new Set((L.provisional || []).filter(p => p.status === 'active' && Number(p.reviewUntil || 0) > now).map(p => String(p.visitor)));
  const subLive = new Set(L.activeSubs.map(s => String(s.visitor)));
  const paidNoSub = L.paidOrders.filter(o => {
    const k = vKey(o);
    if (L.refundedVisitors.has(k)) return false;
    return !subLive.has(k) && !provLive.has(k);
  });
  push('paid_no_entitlement', 'high', '已付款但没有有效权益', paidNoSub.map(o => ({ id: o.id, visitor: o.visitor, plan: o.plan, amount: o.amount, at: o.at })), '立刻补开权益并写审计；同时排查支付回调是否漏处理');

  // 2) 有权益但从没用过（开通超 24h）
  const subNoUse = L.activeSubs.filter(s => {
    if (now - Number(s.createdAt || 0) < DAY) return false;
    const v = L.vByKey.get(String(s.visitor));
    return v ? !hasUsage(v) : true;
  });
  push('sub_no_activation', 'medium', '已开通但从未使用（激活缺口）', subNoUse.map(s => ({ id: s.id, visitor: s.visitor, plan: s.plan, createdAt: s.createdAt })), '按开通时间排序逐个回访：不会用 → 给 15 分钟上手；不需要 → 退款止损');

  // 3) 待付订单超 24h（支付摩擦）
  // 已进入人工核账/补凭证流程的订单由 proof_waiting 负责，不在这里重复计一次
  const stalePending = L.realOrders.filter(o => o.status === 'pending' && !L.isPaid(o) && !o.manualStatus && now - Number(o.at || o.createdAt || 0) > DAY);
  push('pending_over_24h', 'medium', '待付款超过 24 小时', stalePending.map(o => ({ id: o.id, visitor: o.visitor, plan: o.plan, amount: o.amount, at: o.at })), '自动发一次提醒；仍不付则关闭订单，别让它污染漏斗');

  // 4) 凭证/核账悬挂
  const proofHang = L.realOrders.filter(o => ['needProof', 'reviewing', 'provisionally_active'].includes(o.manualStatus));
  push('proof_waiting', 'high', '人工核账/补凭证悬挂', proofHang.map(o => ({ id: o.id, visitor: o.visitor, manualStatus: o.manualStatus, proofAt: o.proofAt })), '运营当天清空队列；超过 24h 的按《待核账》流程转人工回访');

  // 5) 退款悬空
  const refundWait = (L.db.refundRequests || []).filter(r => r.status === 'requested' && now - Number(r.at || r.createdAt || 0) > DAY);
  push('refund_pending', 'high', '退款申请超过 24h 未处理', refundWait.map(r => ({ id: r.id, visitor: r.visitor, amount: r.amount })), '退款是最伤口碑的环节：当天必须给出明确时间点');

  // 6) 协助请求超时
  let assistOverdue = [];
  try { assistOverdue = require('./assist').queue().items.filter(a => a.overdue); } catch (e) {}
  push('assist_overdue', 'medium', '协助请求超 30 分钟未接单', assistOverdue, '运营接单或明确告知等待时间（客户最怕没人理）');

  // 7) 工单 SLA
  let sla = [];
  try {
    const w = require('./tickets').slaWatch(now);
    sla = (w.overdue || []).map(([id, left]) => ({ id, overdueMin: Math.round(Math.abs(left) / 60000) }));
  } catch (e) {}
  push('ticket_sla', 'high', '工单超过 SLA', sla, '按 P0→P1 顺序清理；超时工单必须给客户一个可执行的时间点');

  // 8) 库存不足（影响交付）
  const lowStock = (L.db.materials || []).filter(m => Number(m.reorderPoint) > 0 && Number(m.onHand) <= Number(m.reorderPoint));
  push('stock_low', 'medium', '物料低于补货点', lowStock.map(m => ({ sku: m.sku, onHand: m.onHand, reorderPoint: m.reorderPoint })), '按 materials.plan() 的 suggestQty 补货，避免接单后交不出');

  const order = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => (order[a.severity] - order[b.severity]) || (b.count - a.count));
  return out;
}

function report() {
  const f = funnel();
  const s = stickiness();
  const checks = integrity();
  const blocker = checks.find(c => c.count > 0) || null;
  const healthy = !blocker;
  return {
    ok: true,
    generatedAt: Date.now(),
    funnel: f,
    stickiness: s,
    integrity: { healthy, checks, openIssues: checks.filter(c => c.count > 0).length },
    nextAction: healthy
      ? '闭环无断点。下一步只做增长：把已验证的「付费→激活」路径复制到更多同类客户。'
      : '【' + blocker.severity + '】' + blocker.title + '（' + blocker.count + ' 条）→ ' + blocker.action,
    honesty: {
      money: '营收只认 settled 且非自测；本模块不重复计算金额，金额以 money.kpi 为准',
      rates: '分母为 0 时转化率为 null（不可计算），不写 0% 假装精确',
      stamps: '激活/留存依赖 2026-10-23 起的 usageDays 埋点；历史客户会低估',
    },
  };
}

module.exports = { funnel, stickiness, integrity, report, isInternal, hasUsage };
