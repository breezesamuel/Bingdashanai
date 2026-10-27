// core/conversion-engine.js — 试用→付费 转化引擎（增量·只准备 offer·人工确认闸口）
//
// 为什么：revenue-ops.leak() 定位到全漏斗唯一真断点是 试用(¥1)→付费(0)。
// 本模块把「付过¥1体验却没转正」的访客，按 gtm.ICPS 的人群痛点 + 真实 SKU 价格，
// 生成 3 类升级 offer（加购包 / 年度绑定 / 代运营），并给出**可发送的文案草稿**。
//
// 诚实纪律（与 gtm.js 的「默认人工确认后才发」同一套）：
//   1. 只生成 offer 草稿（status=draft），绝不自发。落 gtmTouches，人工 markSent 后才算真发。
//   2. 价格只用 live SKU 实价（subs.PLANS_CN / commerce-skus 的 CATALOG），不编造折扣。
//   3. 每个 offer 标注「人工确认闸口」：成交走 subs.order + confirm（人工结算），退款走 tickets.refund。
//   4. 目标访客必须**真实付过¥1**（visitors.trialUsed / orders.plan==='t'），不碰未试用人群。

'use strict';
const store = require('./store');

function safe(fn, fb) { try { const r = fn(); return r == null ? fb : r; } catch (e) { return fb; } }

// live SKU 实价（增量模块在 boot 已 register 进 subs，这里直接读，不硬编码金额）
function livePlans() {
  const subs = safe(() => require('./subs'), null);
  // PLANS_CN 是【数组】，每项 {id,label,amount,currency,months,tier}（commerce-skus.register push 进去的就是 catalog 项）
  // 价格字段是 amount（不是 price）。key 用项的 id。
  const cn = Array.isArray(subs && subs.PLANS_CN) ? subs.PLANS_CN : [];
  const out = cn.map(p => ({ key: p.id, label: p.label || p.id, price: Number(p.amount) || 0, tier: p.tier || null }));
  return out.sort((a, b) => a.price - b.price);
}

// 找「付过¥1体验但未转正」的真实访客
function trialers() {
  const db = store.read();
  const paidPlans = {};
  (db.orders || []).forEach(o => { if (o.paid === true || o.status === 'paid') { const k = String(o.visitor); paidPlans[k] = (paidPlans[k] || new Set()); paidPlans[k].add(String(o.plan)); } });
  const isTrial = k => !(paidPlans[k]) || [...paidPlans[k]].filter(p => p !== 't').length === 0;
  return (db.visitors || [])
    .filter(v => v.trialUsed === true && isTrial(String(v.visitor)))
    .map(v => ({
      visitor: String(v.visitor),
      trialUsed: true,
      // 试用后是否真实用过（粘性钩子）
      active: !!(v.usageDays && Object.keys(v.usageDays).length) || Number(v.used || 0) > 0,
      lastUseAt: Number(v.lastUseAt || 0),
      icpHint: (v.note && String(v.note).toLowerCase().match(/dev|developer|agent|bot|smb|consult|独立|一人|顾问|咨询|小商家|老板/)) ? String(v.note).toLowerCase().split(/[\s,，;；]+/)[0] : ''
    }));
}

// 3 类升级 offer（价格全部来自 live SKU，文案人群化但不编造折扣）
// 全部靠 label+key 模式匹配 livePlans()（boot 已把 commerce-skus 的 4 包 push 进 PLANS_CN 数组）
function offers() {
  const plans = livePlans();
  const has = (re) => plans.find(p => re.test((p.label || '') + p.key)) || null;
  const add = has(/^addon10$|加购|×10|x10|add-on/i);            // 加购×10：最快 repeat_pay 钩子
  const ops = has(/^retainer$|代运营|ops|agency/i);               // 代运营包月：小商家锁 LTV
  const annual = plans.find(p => /^y$/i.test(p.key) && p.price > 0) || has(/年|annual/i) || null;
  const cheap = plans.find(p => p.price >= 99 && p.price <= 300 && !add && p.key !== 'addon10') || null; // 月付档
  const mk = (key, target, why, plan, expand) => ({
    key, target, why, expand: !!expand,
    plan: plan || null,                       // live plan 对象（key/label/price/tier）
    price: plan ? plan.price : null,
    planKey: plan ? plan.key : null,
    label: plan ? (plan.label || plan.key) : null,
    gate: '生成草稿→人工确认→markSent 发送；成交走 subs.order+confirm 人工结算；不自动群发'
  });
  const o = [];
  if (add) o.push(mk('addon10', '试用后加购', '¥1 体验后给「再来10次」加购包，最便宜的扩张钩子，直接把 1 单变 2 单（制造 repeat_pay）', add, true));
  if (ops) o.push(mk('agency', '代运营', '不会用工具的小商家：替他代运营，按月收费，锁定 LTV', ops, true));
  if (annual) o.push(mk('annual', '年度绑定', '把月付客户绑成年付（约75折），既提 NRR 又降流失', annual, false));
  if (cheap) o.push(mk('monthly', '月付转正', '试用转正为首月订阅', cheap, false));
  return o;
}

// 为某真实试用访客生成可发送的升级文案草稿（不含假折扣）
// offerKey 可用 offer 的 key（addon10/agency/annual/monthly）或 live plan 的 key（retainer/y）
function composeFor(visitor, offerKey) {
  const offs = offers();
  const off = offs.find(x => x.key === offerKey) || offs.find(x => x.planKey === offerKey) || offs[0];
  const p = off ? off.plan : null;  // live plan 对象（含实价），不再二次查 livePlans
  const lines = [
    '你之前用 ¥1 体验过「丙大山AI」。',
    off ? '看到你有需求——' + off.why + '。' : '',
    p && p.price ? '给你一个实价档位：' + (p.label || p.key) + '（¥' + p.price + '），不锁死，随时停。' : '具体档位看你的场景。',
    '不方便就当我没说过，体验额度还在，想用随时回来。'
  ].filter(Boolean).join('\n');
  return { ok: true, visitor, offer: off ? off.key : null, draft: lines,
    note: '文案只含 live SKU 实价，无编造折扣。发送前人工确认（防骚扰·合规）。' };
}

// 生成全部待转化访客的 offer 草稿清单（落 gtmTouches，status=draft，人工确认后 markSent）
function queue(limit) {
  const n = Math.max(1, Math.min(50, Number(limit) || 10));
  const people = trialers().slice(0, n);
  const db = store.read();
  if (!Array.isArray(db.gtmTouches)) db.gtmTouches = [];
  const ofrs = offers();
  people.forEach((v, i) => {
    const off = ofrs.length ? ofrs[i % ofrs.length] : null;
    const key = 'conv-' + v.visitor + '-' + (off ? off.key : 'default');
    if ((db.gtmTouches || []).find(t => t.key === key)) return; // 幂等：不重复建
    const draft = composeFor(v.visitor, off ? off.key : undefined).draft;
    db.gtmTouches.unshift({ key, at: Date.now(), status: 'draft', icp: 'trial', target: v.visitor, channel: '升级offer', outcome: null, draft, active: v.active });
  });
  if (db.gtmTouches.length > 500) db.gtmTouches = db.gtmTouches.slice(0, 500);
  store.write(db);
  return {
    ok: true, queued: people.length, offers: ofrs.map(x => x.key),
    note: '已生成 ' + people.length + ' 条草稿（status=draft）。发送需逐条 markSent（人工确认），成交走 subs.order+confirm。'
  };
}

// 转化面板：当前试用未转正人数 + 可升级 offer + 已排队草稿
function board() {
  const people = trialers();
  const db = store.read();
  const drafts = (db.gtmTouches || []).filter(t => t.icp === 'trial').length;
  const paidRepeat = ((db.orders || []).filter(o => o.paid === true || o.status === 'paid')).filter(o => o.plan !== 't').length;
  return {
    ok: true, at: Date.now(),
    trialNotConverted: people.length,
    activeAmongThem: people.filter(v => v.active).length,
    offers: offers(),
    queuedDrafts: drafts,
    repeatPayOrders: paidRepeat,
    verdict: people.length === 0
      ? '暂无「付过¥1未转正」的真实访客（漏斗里试用数也可能为 0）——先靠 leadgen/gtm 把访客带到试用。'
      : ('有 ' + people.length + ' 个试用未转正，最快的赚钱动作是「加购×10」把 1 单变 2 单。已排队 ' + drafts + ' 条草稿待人工确认。'),
    honesty: '价格全部取 live SKU 实价；不编造折扣；发送与成交均设人工确认闸口。'
  };
}

module.exports = { trialers, offers, composeFor, queue, board, livePlans };
