// core/receipt.js — 买家侧的两封关键邮件：**付款收据** 与 **到期续费提醒**
//
// 【为什么必须有】订阅是"预付"生意：客户先付钱、我们后履约。
//   ① **没有收据** → 客户没有付款凭证 → 反复来问"我付了吗"、甚至申请退款；
//      B2B 客户更致命（没有凭证就无法报销/入账）。
//   ② **没有续费提醒** → 订阅到期后**静默回墙**，客户根本没意识到要续费 →
//      这是白丢的复购收入（漏斗里的 retention 事件有记录，但没人被告知）。
//
// 【诚实原则】
//   · 邮件**发不出去就说发不出去**（skipped / failed 都写进订单与订阅记录）；
//   · 绝不影响结算与开通（发信失败不回滚权益）；
//   · 不编造"已发送"：只有 SMTP 返回成功才记 sent。
//
// 【安全】邮箱只用于送达凭证/提醒，**不是身份凭证**；内容里不放任何密钥或内部标识。
const store = require('./store');
const mailer = require('./mailer');

const DAY = 86400000;
const RENEW_WINDOW_DAYS = 7;      // 到期前 7 天提醒（与站内"7 天双触发"口径一致）
const EXPIRED_RECALL_DAYS = 14;    // 已过期后的召回窗（14 天内提醒一次，把"静默流失"变"可挽回"）
const BRAND = '丙大山AI · Agent 驾驶舱';

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(ts) {
  try {
    const d = new Date(Number(ts) || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  } catch (e) { return ''; }
}

/**
 * 到账即发收据（付款凭证）。
 * @param {object} order 订单记录（需含 id/plan/amount/currency/email/paidAt）
 * @returns {Promise<{ok:boolean,status:string,detail?:string}>}
 */
async function sendReceipt(order) {
  const o = order || {};
  const mail = String(o.email || '').trim().toLowerCase();
  if (!mail) {
    markOrder(o.id, { receiptStatus: 'skipped_no_email', receiptAt: Date.now() });
    return { ok: false, status: 'skipped_no_email' };
  }
  const plans = require('./subs').PLANS_CN || [];
  const plan = plans.find((p) => p.id === o.plan) || null;
  const amount = Number(o.amount) || 0;
  const cur = String(o.currency || 'CNY').toUpperCase();
  const sub = findSubForOrder(o.id);
  const until = sub ? fmtDate(sub.expireAt) : '';
  const subject = '【' + BRAND + '】付款收据 ' + o.id;
  const html = '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.8;max-width:560px">'
    + '<h2 style="margin:0 0 8px">付款成功，已开通</h2>'
    + '<p>你好，你的订阅已生效，凭证如下（请保存）：</p>'
    + '<table style="border-collapse:collapse;width:100%">'
    + row('订单号', o.id) + row('方案', plan ? plan.label : String(o.plan || ''))
    + row('金额', (cur === 'CNY' ? '¥' : cur === 'USD' ? '$' : '') + amount)
    + row('付款时间', fmtDate(o.paidAt || o.at))
    + (until ? row('有效期至', until) : '')
    + '</table>'
    + '<p style="color:#666;font-size:13px">换电脑或换浏览器？用这个邮箱在登录页「找回订阅」即可恢复权益（需邮箱验证码）。</p>'
    + '<p style="color:#666;font-size:13px">' + escHtml(BRAND) + '</p></div>';
  try {
    const r = await mailer.send(mail, subject, html);
    if (r && r.ok) {
      markOrder(o.id, { receiptStatus: 'sent', receiptAt: Date.now(), receiptTo: mail });
      return { ok: true, status: 'sent' };
    }
    const err = (r && r.error) || 'unknown';
    markOrder(o.id, {
      receiptStatus: 'failed', receiptAt: Date.now(), receiptError: String(err).slice(0, 160),
      receiptAttempts: Number((store.findBy('orders', 'id', o.id) || {}).receiptAttempts || 0) + 1,
    });
    return { ok: false, status: 'failed', detail: String(err) };
  } catch (e) {
    markOrder(o.id, {
      receiptStatus: 'failed', receiptAt: Date.now(), receiptError: String(e.message || e).slice(0, 160),
      receiptAttempts: Number((store.findBy('orders', 'id', o.id) || {}).receiptAttempts || 0) + 1,
    });
    return { ok: false, status: 'failed', detail: String(e.message || e) };
  }
}

function row(k, v) {
  return '<tr><td style="border:1px solid #eee;padding:6px 10px;color:#666;width:96px">' + escHtml(k)
    + '</td><td style="border:1px solid #eee;padding:6px 10px"><b>' + escHtml(v) + '</b></td></tr>';
}

function markOrder(orderId, patch) {
  if (!orderId) return;
  try { store.update('orders', String(orderId), patch, '付款收据', String(orderId)); } catch (e) {}
}

function findSubForOrder(orderId) {
  if (!orderId) return null;
  try {
    const subs = store.list('sublist', 999);
    return subs.find((s) => Array.isArray(s.grantedOrders) && s.grantedOrders.includes(String(orderId))) || null;
  } catch (e) { return null; }
}

/**
 * 到期前 N 天的续费提醒（每个订阅每轮只发一次 → 用 remindedAt 去重）。
 * @returns {Promise<{checked:number,sent:number,skipped:number,failed:number}>}
 */
async function sweepRenewalReminders(days) {
  const win = (Number(days) || RENEW_WINDOW_DAYS) * DAY;
  const now = Date.now();
  const stats = { checked: 0, sent: 0, skipped: 0, failed: 0 };
  let subs = [];
  try { subs = store.list('sublist', 999); } catch (e) { return stats; }
  for (const s of subs) {
    if (!s || !s.visitor) continue;
    const exp = Number(s.expireAt || 0);
    if (!exp) continue;
    // ① 已过期但在召回窗内（默认 14 天）→ 召回（到期提醒只覆盖"还没到期"的）
    if (exp <= now) {
      const since = now - exp;
      if (since > EXPIRED_RECALL_DAYS * DAY) continue;          // 过期太久就不打扰
      if (s.expireRemindedAt) continue;                          // 已召回过
      stats.checked++;
      const mail2 = findEmailForVisitor(s.visitor);
      if (!mail2) { markSub(s.id, { expireRemindStatus: 'skipped_no_email', expireRemindedAt: Date.now() }); stats.skipped++; continue; }
      const daysAgo = Math.max(1, Math.floor(since / DAY));
      const orders2 = ordersOfVisitor(s.visitor);
      const last2 = orders2[0];
      const html2 = '<div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.8;max-width:560px">'
        + '<h2 style="margin:0 0 8px">订阅已到期 ' + daysAgo + ' 天</h2>'
        + '<p>你的订阅已经到期，现在回到免费额度（每个功能区每天有限额）。'
        + '续费可立刻恢复全部功能，含重耗分区额度：</p>'
        + (last2 ? row('上次方案', planLabel(last2.plan)) + row('上次订单', last2.id) : '')
        + '<p style="margin-top:12px">回到控制台点「续费」即可（微信 / 支付宝扫码，到账即开通）。</p>'
        + '<p style="color:#666;font-size:13px">' + escHtml(BRAND) + '</p></div>';
      try {
        const r2 = await mailer.send(mail2, '【' + BRAND + '】订阅已到期，续费可恢复全部功能', html2);
        if (r2 && r2.ok) { markSub(s.id, { expireRemindStatus: 'sent', expireRemindedAt: Date.now(), expireRemindTo: mail2 }); stats.sent++; }
        else { markSub(s.id, { expireRemindStatus: 'failed', expireRemindedAt: Date.now(), expireRemindError: String((r2 && r2.error) || 'unknown').slice(0, 160) }); stats.failed++; }
      } catch (e) {
        markSub(s.id, { expireRemindStatus: 'failed', expireRemindedAt: Date.now(), expireRemindError: String(e.message || e).slice(0, 160) });
        stats.failed++;
      }
      continue;
    }
    if (exp - now > win) continue;                // 还早
    if (s.remindedAt && now - Number(s.remindedAt) < 20 * DAY) continue;  // 20 天内提醒过
    stats.checked++;
    const mail = findEmailForVisitor(s.visitor);
    if (!mail) {
      markSub(s.id, { remindStatus: 'skipped_no_email', remindedAt: Date.now() });
      stats.skipped++;
      continue;
    }
    const days = Math.max(1, Math.ceil((exp - now) / DAY));
    const orders = ordersOfVisitor(s.visitor);
    const last = orders[0];
    const subject = '【' + BRAND + '】订阅将在 ' + days + ' 天后到期';
    const html = '<div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.8;max-width:560px">'
      + '<h2 style="margin:0 0 8px">订阅将在 ' + days + ' 天后到期</h2>'
      + '<p>为了不中断你的使用，请提前续费：</p>'
      + (last ? row('当前方案', planLabel(last.plan)) + row('当前订单', last.id) + row('到期时间', fmtDate(exp)) : '')
      + '<p style="margin-top:12px">直接回到控制台点「续费」即可（微信 / 支付宝扫码，到账即开通）。</p>'
      + '<p style="color:#666;font-size:13px">' + escHtml(BRAND) + '</p></div>';
    try {
      const r = await mailer.send(mail, subject, html);
      if (r && r.ok) { markSub(s.id, { remindStatus: 'sent', remindedAt: Date.now(), remindTo: mail }); stats.sent++; }
      else { markSub(s.id, { remindStatus: 'failed', remindedAt: Date.now(), remindError: String((r && r.error) || 'unknown').slice(0, 160) }); stats.failed++; }
    } catch (e) {
      markSub(s.id, { remindStatus: 'failed', remindedAt: Date.now(), remindError: String(e.message || e).slice(0, 160) });
      stats.failed++;
    }
  }
  return stats;
}

function planLabel(planId) {
  try {
    const plans = require('./subs').PLANS_CN || [];
    const p = plans.find((x) => x.id === planId);
    return p ? p.label : String(planId || '');
  } catch (e) { return String(planId || ''); }
}

function ordersOfVisitor(visitorKey) {
  try {
    return store.list('orders').filter((o) => o && o.visitor === visitorKey && o.paid === true);
  } catch (e) { return []; }
}

// 访客名下**最近一笔已付订单**上的邮箱（收件地址来源）
function findEmailForVisitor(visitorKey) {
  try {
    const v = store.findBy('visitors', 'visitor', visitorKey);
    if (v && v.email) return String(v.email);
  } catch (e) {}
  const orders = ordersOfVisitor(visitorKey).slice().reverse();
  for (const o of orders) { if (o && o.email) return String(o.email); }
  return '';
}

function markSub(subId, patch) {
  if (!subId) return;
  try { store.update('sublist', String(subId), patch, '续费提醒', String(subId)); } catch (e) {}
}

/**
 * 失败收据补发（2026-10-21 新增）。
 * 收据是客户唯一凭证 —— 发失败一次就永久丢，等于没有凭证。
 * 这里把**已付但收据没送达**的订单捡起来重发（限次、限频，避免打扰与刷信）。
 * @returns {Promise<{checked:number,sent:number,failed:number}>}
 */
async function retryFailedReceipts() {
  const stats = { checked: 0, sent: 0, failed: 0 };
  let orders = [];
  try { orders = store.list('orders'); } catch (e) { return stats; }
  const now = Date.now();
  for (const o of orders) {
    if (!o || o.paid !== true) continue;
    if (!o.email) continue;
    if (o.receiptStatus !== 'failed') continue;             // 只补失败的
    const tries = Number(o.receiptAttempts || 0);
    if (tries >= 3) continue;                              // 最多 3 次，不无限骚扰
    if (now - Number(o.receiptAt || 0) < 10 * 60 * 1000) continue;  // 10 分钟内刚试过
    stats.checked++;
    const r = await sendReceipt(o).catch(() => ({ ok: false, status: 'failed' }));
    if (r && r.ok) stats.sent++; else stats.failed++;
  }
  return stats;
}

module.exports = { sendReceipt, sweepRenewalReminders, retryFailedReceipts, RENEW_WINDOW_DAYS };
