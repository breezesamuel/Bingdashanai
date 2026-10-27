// core/payment-gateways.js — 真实支付网关统一出口
//
// 支持：moltspay（聚合扫码，海外/国内）、PayPal（海外信用卡/余额）。
// 铁律：
//   - 所有入账走 money.credit(settled=true) → 自动计 KPI + 5% 推广费
//   - 幂等：同一笔订单号只入账一次（账本侧另有 rev-<单号> 去重，双保险）
//   - 凭证留痕：网关原始回调全存 audit
//   - 绝不伪造到账：只有「验签通过 + 金额币种一致 + 订单存在」才算收到钱
//
// 【2026-10 收口】本文件曾是"自说自话"的第二套实现（模拟下单、自造签名口径），
// 与 core/pay.js 的真实实现各写一份，路由又同时挂着两套 → 订单能建、钱对不上。
// 现在这里只做「参数适配 + 转发」，真正的能力全部来自 core/pay.js，口径只有一份。

const pay = require('./pay');
const qrlib = require('./qr');

// ============ moltspay ============
// 预下单：由 pay.moltspayCheckout 生成真实网关链接（HMAC-SHA256 签名），
// 并配套一枚内嵌二维码（编码我们自己的短链，扫码后 302 到网关收银台）。
async function moltspayCreateOrder(outTradeNo, amount, subject, notifyUrl, returnUrl) {
  const r = await pay.moltspayCheckout({
    orderId: String(outTradeNo || ''),
    amount: Number(amount) || 0,
    currency: 'CNY'
  });
  if (!r || r.ok !== true) {
    return { ok: false, error: (r && r.error) || 'moltspay 预下单失败', orderId: outTradeNo, pendingConfig: !!(r && r.pendingConfig) };
  }
  return {
    ok: true,
    orderId: r.orderId,
    pay_url: r.payUrl,
    payUrl: r.payUrl,
    channel: 'moltspay',
    // 内嵌付款码：前端 <img src> 直接渲染，扫码即付
    qrData: r.qrData || pay.gatewayQrData(r.orderId),
    gatewayMode: r.gatewayMode,
    note: (subject || '') + '；回调 ' + (notifyUrl || pay.publicUrl('/v1/pay/moltspay/notify'))
  };
}

// moltspay 异步回调（pay.moltspayHandleNotify 内含验签 + 金额/币种核对 + 幂等入账）
async function moltspayHandleCallback(body, signature) {
  const r = pay.moltspayHandleNotify(body || {});
  return r;
}

// ============ PayPal ============
async function paypalCreateOrder(outTradeNo, amount, currency, returnUrl, cancelUrl) {
  const r = await pay.paypalCheckout({
    orderId: String(outTradeNo || ''),
    amount: Number(amount) || 0,
    currency: currency || 'USD'
  });
  if (!r || r.ok !== true) {
    return { ok: false, error: (r && r.error) || 'paypal 预下单失败', orderId: outTradeNo };
  }
  return {
    ok: true,
    orderId: r.orderId,
    order_id: r.trackId,
    approve_url: r.payUrl,
    payUrl: r.payUrl,
    channel: 'paypal',
    qrData: r.qrData || pay.gatewayQrData(r.orderId),
    note: '买家批准后由 /v1/pay/paypal/success 捕获入账'
  };
}

async function paypalCaptureOrder(orderId) {
  return pay.paypalCapture(orderId, orderId);
}

// ============ 统一入口 ============
async function createPaymentOrder(gateway, outTradeNo, amount, currency, subject, notifyUrl, returnUrl, cancelUrl) {
  const g = String(gateway || '').toLowerCase();
  if (g === 'moltspay') return moltspayCreateOrder(outTradeNo, amount, subject, notifyUrl, returnUrl);
  if (g === 'paypal') return paypalCreateOrder(outTradeNo, amount, currency, returnUrl, cancelUrl);
  return { ok: false, error: '未知网关: ' + gateway + '（可用：moltspay / paypal）' };
}

// 回调路由（server.js 的 /v1/pay/* 用）
async function handleCallback(gateway, body, headers) {
  const g = String(gateway || '').toLowerCase();
  const h = headers || {};
  if (g === 'moltspay') {
    const sig = h['x-moltspay-signature'] || h.signature || '';
    return moltspayHandleCallback(body, sig);
  }
  if (g === 'paypal') {
    // PayPal webhook：只处理"买家已批准"，真正入账仍以 capture 结果为准
    if (body && (body.event_type === 'CHECKOUT.ORDER.APPROVED' || body.event_type === 'PAYMENT.CAPTURE.COMPLETED')) {
      const orderId = body.resource && (body.resource.id || (body.resource.purchase_units && body.resource.purchase_units[0] && body.resource.purchase_units[0].reference_id));
      if (orderId) {
        const cap = await paypalCaptureOrder(orderId);
        return cap;
      }
    }
    return { ok: true, ignored: 'event=' + (body && body.event_type) };
  }
  return { ok: false, error: '未知网关回调：' + gateway };
}

// 生成内嵌二维码 Data URL（收银台/运营页都可能用）
function qrDataUrl(text, opts) {
  try { return qrlib.svgDataUrl(text, opts); } catch (e) { return ''; }
}

module.exports = {
  createPaymentOrder,
  handleCallback,
  moltspayCreateOrder,
  moltspayHandleCallback,
  paypalCreateOrder,
  paypalCaptureOrder,
  qrDataUrl
};
