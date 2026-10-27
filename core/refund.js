'use strict';
/**
 * core/refund.js — 退款申请与出款确认（站点侧，钱的事实来源）
 *
 * 【为什么需要】商业闭环的「退款」段一直没有真实来源：站点没有退款入口，
 *   客户付了钱要退款只能找人工，运营再手工改库 —— 既慢又容易出错。
 *   本模块把退款变成一条**有状态、可追溯、不谎称**的流程：
 *
 *   requested（客户申请） → paid_out（运营确认已转账） → refunded（闭环镜像同步）
 *
 * 【钱的口径】这里（db.json）才是退款的事实来源；闭环侧只维护镜像 + 出款待办 + 通知，
 *   不重复记账（避免两处钱状态打架）。
 *
 * 【绝不谎称】客户申请 ≠ 已退款。没实际转账之前，任何地方都不得显示「已退款」。
 *
 * 【不做的事】不自动打款、不自动退 gateways（个人收款码也没有自动退款 API）——
 *   实际出款必须由运营人工转账，然后回来点确认。
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const subs = require('./subs');

const ROOT = path.join(__dirname, '..');
// 数据目录口径与 core/store.js 一致：BINGDASHAN_DATA_DIR 指到临时目录时（测试隔离），
// 申请流也必须跟着走 —— 否则测试会把申请写进真实 data/refund_requests.jsonl，
// 被闭环当成真退款申请处理（污染）。
const DATA_DIR = process.env.BINGDASHAN_DATA_DIR
  ? path.resolve(process.env.BINGDASHAN_DATA_DIR)
  : path.join(ROOT, 'data');
// 退款申请流（追加写）：闭环的喂送器读它，再转成闭环自己的退款收件箱
const REQ_FILE = path.join(DATA_DIR, 'refund_requests.jsonl');
const MAX_OPEN_REQUESTS = 3;      // 同一访客同时最多 3 笔在途退款申请

function nowIso() { return new Date().toISOString(); }

function appendRequest(row) {
  fs.mkdirSync(path.dirname(REQ_FILE), { recursive: true });
  fs.appendFileSync(REQ_FILE, JSON.stringify(row) + '\n', 'utf8');
}

function listRequests(limit = 100) {
  return store.list('refundRequests', limit);
}

function getRequest(orderId) {
  const oid = String(orderId || '');
  if (!oid) return null;
  const all = store.list('refundRequests', 999);
  // 取该订单**最新**的一条（状态可能推进过）
  return all.find(x => x.orderId === oid) || null;
}

/**
 * 客户申请退款。
 * @param {string} orderId
 * @param {string} visitorKey 申请人的访客身份（必须与订单一致）
 * @param {string} reason
 */
function request(orderId, visitorKey, reason) {
  const oid = String(orderId || '');
  if (!oid) return { ok: false, error: '缺少订单号' };

  const order = store.findBy('orders', 'id', oid);
  if (!order) return { ok: false, error: '订单不存在' };

  // 只能申请**自己**的订单（否则任何人都能给别人的订单发起退款）
  const v = subs.visitorBy(visitorKey);
  if (!v || v.visitor !== order.visitor) return { ok: false, error: '无权操作该订单' };

  if (order.paid !== true) return { ok: false, error: '订单未支付，无需退款' };

  const prior = getRequest(oid);
  if (prior && ['requested', 'paid_out'].includes(prior.status)) {
    return { ok: false, error: '该订单已有退款申请在处理中', request: prior };
  }

  // 同一访客的在途申请数量闸门（防刷）
  const open = listRequests(999).filter(r => r.status === 'requested' && r.visitor === order.visitor);
  if (open.length >= MAX_OPEN_REQUESTS) {
    return { ok: false, error: '退款申请过多，请先处理已有申请' };
  }

  const row = {
    id: 'rq_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    orderId: oid,
    visitor: order.visitor,
    amount: Number(order.amount) || 0,
    currency: String(order.currency || 'CNY').toUpperCase(),
    email: String(order.email || ''),
    reason: String(reason || '').slice(0, 300),
    status: 'requested',
    createdAt: Date.now(),
    at: nowIso(),
  };
  store.push('refundRequests', row, '退款申请', '#' + oid + ' ' + row.amount + ' ' + row.currency);
  // 追加写申请流：闭环喂送器据此创建出款待办并发通知
  appendRequest(row);
  return { ok: true, request: row };
}

/**
 * 运营确认「已实际转账」（唯一能把退款推进到已退的入口）。
 * @param {string} orderId
 * @param {string} by 操作人标识
 */
function confirm(orderId, by) {
  const oid = String(orderId || '');
  if (!oid) return { ok: false, error: '缺少订单号' };
  const prior = getRequest(oid);
  if (!prior) return { ok: false, error: '没有该订单的退款申请' };
  if (prior.status === 'refunded') return { ok: true, request: prior, already: true };
  if (prior.status !== 'requested' && prior.status !== 'paid_out') {
    return { ok: false, error: '退款申请状态异常：' + prior.status };
  }

  const row = {
    ...prior,
    status: 'refunded',
    paidOutBy: String(by || 'ops'),
    paidOutAt: Date.now(),
    at: nowIso(),
  };
  store.update('refundRequests', prior.id, row, '退款出款确认', '#' + oid);
  // 追加写：闭环据此把镜像状态从 refund_pending_manual 推进到 refunded
  appendRequest({ ...row, event: 'paid_out' });
  // 【2026-10-21 权益回收】钱退了，服务不能白用：把**这笔订单带来的**订阅权益收回
  // （按 grantedOrders 精确定位该单贡献的那一份；不动其他订单带来的时长）。
  // 原来只改退款状态、不动权益 → 客户退款后仍能用满一个月的服务 = 白送。
  let revoked = 0;
  try {
    revoked = revokeEntitlement(oid);
  } catch (e) { /* 回收失败要有痕迹，不能静默 */ }
  if (revoked) {
    try {
      store.push('audit', { action: '退款回收权益', detail: '#' + oid + ' 收回 ' + revoked + ' 份权益', at: Date.now() }, null, null);
    } catch (e) {}
  }
  return { ok: true, request: row, revokedEntitlements: revoked };
}

/**
 * 回收某订单带来的订阅权益。
 * 规则：sublist 里 grantedOrders 包含该订单号 → 该权益视为"由这笔订单提供" → 收回。
 * 只处理**单订单独占**的权益；若一份权益由多笔订单共同提供（顺延场景），
 * 只移除该订单号并保留其余部分（不能把别人的时长也收走）。
 */
function revokeEntitlement(orderId) {
  const oid = String(orderId || '');
  if (!oid) return 0;
  const subs = store.list('sublist', 999);
  let n = 0;
  for (const s of subs) {
    if (!s || !Array.isArray(s.grantedOrders) || s.grantedOrders.indexOf(oid) < 0) continue;
    const rest = s.grantedOrders.filter((x) => String(x) !== oid);
    if (!rest.length) {
      try { store.remove('sublist', s.id); n++; } catch (e) {}
    } else {
      try { store.update('sublist', s.id, { grantedOrders: rest }, '退款回收部分权益', oid); n++; } catch (e) {}
    }
  }
  return n;
}

module.exports = { request, confirm, getRequest, listRequests, REQ_FILE };
