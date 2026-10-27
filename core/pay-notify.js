'use strict';
/**
 * core/pay-notify.js — 收款监听：外部可信信号 → 严格匹配 → 自动开通
 *
 * 【为什么需要它】
 *   个人收款码（支付宝/微信收款码）没有订单查询 API：站点既收不到回调、也查不到状态，
 *   客户付了钱只能等运营人工核账（慢、且人不在就漏单）。
 *   唯一能自动化的可信信号是「收款方自己收到的到账通知」：
 *     - 支付宝/微信的到账邮件（发到我们自己的收款邮箱）—— 来自支付方系统的原文
 *     - 官方网关回调（已有 alipay/wechat/paypal 通道，不走本模块）
 *
 * 【铁律（与全项目一致）】
 *   - Fail-Closed：匹配不唯一 / 金额对不上 / 超出时间窗 → 绝不开通，转人工留痕
 *   - 只认「唯一匹配」：0 个候选 = 未匹配；>1 个候选 = 歧义（不开通，人工裁决）
 *   - 幂等：同一笔外部凭据不会重复开通（复用 settleOrder 的双闸：settledMark + rev-<单号>）
 *   - 不新增资金逻辑：只负责「匹配 + 调用」，记账/时长/返利全部走 subs.settleEffects
 *   - 客户零操作：客户只管扫码付款，开通由系统完成
 *
 * 【权限边界】
 *   本模块只做「匹配 + 调用结算」。任何外部输入都必须先经过 server.js 的通知通道鉴权
 *   （本机回环 + 通知密钥/管理令牌），否则等于把「点一下就开通」暴露给公网。
 */

const store = require('./store');

const DEFAULTS = {
  windowMin: 90,     // 付款时间必须落在下单后 90 分钟内（超时 → 人工，避免误匹配历史订单）
  tolerance: 0.01,   // 金额容差（元）
  channels: ['alipay', 'wechat'],
  currencies: ['CNY'],
};

const CHANNEL_LABEL = { alipay: '支付宝收款码', wechat: '微信收款码', paypal: 'PayPal' };

function cfg() {
  const s = store.getSetting('payNotify') || {};
  return {
    windowMin: Number(s.windowMin) > 0 ? Number(s.windowMin) : DEFAULTS.windowMin,
    tolerance: Number(s.tolerance) >= 0 ? Number(s.tolerance) : DEFAULTS.tolerance,
    channels: Array.isArray(s.channels) && s.channels.length ? s.channels : DEFAULTS.channels,
    currencies: Array.isArray(s.currencies) && s.currencies.length ? s.currencies : DEFAULTS.currencies,
  };
}

function labelOf(channel) {
  return CHANNEL_LABEL[String(channel || '').toLowerCase()] || '收款监听';
}

/**
 * 严格匹配一个待支付订单。
 * @param {{amount:number,currency?:string,channel?:string,paidAt?:number}} input
 * @returns {{status:'matched'|'unmatched'|'ambiguous'|'rejected', reason?:string, order?:object, candidates?:string[], count?:number}}
 */
function matchOrder(input = {}) {
  const c = cfg();
  const amount = Number(input.amount);
  const currency = String(input.currency || 'CNY').toUpperCase();
  const channel = String(input.channel || '').toLowerCase();
  const paidAt = Number(input.paidAt) || Date.now();

  if (!(amount > 0)) return { status: 'rejected', reason: 'amount_invalid' };
  if (!c.currencies.includes(currency)) return { status: 'rejected', reason: 'currency_not_supported:' + currency };
  if (channel && !c.channels.includes(channel)) return { status: 'rejected', reason: 'channel_not_supported:' + channel };

  const winMs = c.windowMin * 60 * 1000;
  // 【2026-10-21 修正窗口方向 —— 这条是"付了却不开通"的真正根因】
  // 原来写成：lo = paidAt-60s，hi = paidAt+90min，于是要求**订单创建时刻**落在
  //   [付款时刻-60秒, 付款时刻+90分钟] 内 —— 等价于「付款必须发生在下单后 60 秒内」
  //   （或下单前 90 分钟的预付）。客户在 1~90 分钟后付款（扫码后切App、排队、犹豫）**一律 unmatched**，
  //   只能转人工核账 —— 正是"付了钱却不开通"的核心症状。
  // 正确语义（注释原文：付款必须在下单后 windowMin 内）：**付款**要落在
  //   [下单时刻, 下单时刻+90分钟] 内；再留 60 秒的时钟漂移余量给预付场景。
  const lo = paidAt - winMs;   // 付款最早可早于付款时刻 windowMin（即下单后 90 分钟内都算这单）
  const hi = paidAt + 60 * 1000;  // 允许付款时刻比参考时刻略晚（时钟漂移/预付 60 秒内）

  const cands = [];
  const paidCands = [];
  // 【2026-10-21 全量候选池】原来只扫**最近 999 单** —— 订单一多，客户付款时
  // 若他的单不在窗口里 → 无候选 → 判 unmatched → **钱到了却不开通**（最贵的 bug）。
  // 现在扫全部订单（金额/币种/时间窗三重过滤本来就很快，订单量级到十万级也只是毫秒）。
  for (const o of store.list('orders')) {
    if (!o || o.id === undefined) continue;
    const st = String(o.status || '');
    const isPending = (st === 'pending' || st === 'pending_payment');
    const isPaid = (o.paid === true || st === 'paid');
    if (!isPending && !isPaid) continue;                              // 只看待支付/已付款
    if (String(o.currency || 'CNY').toUpperCase() !== currency) continue;
    const amt = Number(o.amount) || 0;
    if (Math.abs(amt - amount) > c.tolerance) continue;              // 金额必须对上
    const created = Number(o.at || o.createdAt) || 0;
    if (!created) continue;
    if (created > hi || created < lo) continue;                       // 时间窗
    if (o.channel && channel && String(o.channel).toLowerCase() !== channel) continue; // 通道不符
    if (isPaid) paidCands.push(o); else cands.push(o);
  }

  if (cands.length === 0 && paidCands.length === 1) {
    // 同一笔到账信号重复到达（订单已被结算）→ 幂等，不重复入账
    return { status: 'already_paid', order: paidCands[0] };
  }
  if (cands.length === 0) return { status: 'unmatched', reason: 'no_candidate', count: 0 };
  if (cands.length > 1) {
    return {
      status: 'ambiguous', reason: 'multiple_candidates', count: cands.length,
      candidates: cands.map((o) => o.id),
    };
  }
  return { status: 'matched', order: cands[0] };
}

/**
 * 干跑：只匹配不结算（自检与运营预览用）。
 */
function dryRun(input = {}) {
  const m = matchOrder(input);
  if (m.status === 'matched') {
    return {
      ok: true, matched: true, orderId: m.order.id, amount: m.order.amount,
      currency: m.order.currency, plan: m.order.plan, createdAt: Number(m.order.at || m.order.createdAt) || 0,
    };
  }
  return { ok: true, matched: false, status: m.status, reason: m.reason, count: m.count || 0, candidates: m.candidates || [] };
}

/**
 * 收到一笔「到账信号」后尝试自动开通。
 * @param {{amount:number,currency?:string,channel?:string,tradeNo?:string,ref?:string,source?:string,paidAt?:number}} input
 */
function settleFromNotification(input = {}) {
  const ref = String(input.ref || '').slice(0, 200);
  const tradeNo = String(input.tradeNo || '').slice(0, 100);
  const source = String(input.source || 'notify').slice(0, 40);
  const m = matchOrder(input);

  if (m.status === 'already_paid') {
    // 重复的到账信号：订单已结算 → 幂等返回，不再记账
    return { ok: true, matched: true, already: true, orderId: m.order.id, status: 'already_paid' };
  }

  if (m.status !== 'matched') {
    // 歧义/未匹配/参数非法 → 绝不开通，只留痕等人工
    store.push('audit', {
      action: '收款监听·未自动开通',
      detail: (m.reason || m.status) + ' 金额=' + input.amount + ' ' + (input.currency || '')
        + ' 通道=' + (input.channel || '-') + (ref ? ' ref=' + ref : '') + (m.candidates && m.candidates.length ? ' 候选=' + m.candidates.join('/') : ''),
      at: Date.now(),
    }, null, null);
    return {
      ok: false, matched: false, status: m.status, reason: m.reason || m.status,
      count: m.count || 0, candidates: m.candidates || [],
    };
  }

  const o = m.order;
  if (o.paid === true) {
    // 同一笔到账信号重复到达（或订单已被别的通道结算）→ 幂等返回，不再记账
    return { ok: true, matched: true, already: true, orderId: o.id, status: 'already_paid' };
  }

  const pay = require('./pay');
  const label = labelOf(o.channel || input.channel);
  const r = pay.settleOrder(o.id, label);
  if (!r || !r.ok) {
    store.push('audit', {
      action: '收款监听·开通失败',
      detail: '#' + o.id + ' ' + (r && r.error) || '未知',
      at: Date.now(),
    }, null, null);
    return { ok: false, matched: true, status: 'settle_failed', error: (r && r.error) || 'settle_failed', orderId: o.id };
  }

  store.push('audit', {
    action: '收款监听·自动开通',
    detail: '#' + o.id + ' ' + o.amount + ' ' + o.currency + ' 通道=' + label
      + (tradeNo ? ' 交易号=' + tradeNo : '') + (ref ? ' ref=' + ref : ''),
    at: Date.now(),
  }, null, null);

  return {
    ok: true, matched: true, already: !!r.already, orderId: o.id, status: 'settled',
    inviteBonus: r.inviteBonus || null,
  };
}

/**
 * 通道就绪视图（运营/探针用）：如实报告有多少待支付订单能被自动匹配。
 */
function status() {
  const c = cfg();
  // 【2026-10-21 全量】待支付统计不能只看最近 999 单（否则运营看到的可匹配单数是假的）
  const pend = store.list('orders').filter((o) => o && o.paid !== true
    && (String(o.status || '') === 'pending' || String(o.status || '') === 'pending_payment'));
  return {
    ok: true,
    enabled: true,
    windowMin: c.windowMin,
    tolerance: c.tolerance,
    channels: c.channels,
    currencies: c.currencies,
    pendingOrders: pend.length,
    pendingAmount: pend.reduce((a, o) => a + (Number(o.amount) || 0), 0),
  };
}

module.exports = { matchOrder, dryRun, settleFromNotification, status, DEFAULTS };
