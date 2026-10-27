// core/payment-gateways.js — 真实支付网关统一出口
//
// 支持：PayPal（海外信用卡/余额）。
// moltspay 通道【未接入·2026-10-18】：MoltsPay 是 x402 服务商框架，官方无可直连收银台
// （详见 core/pay.js 里 moltspayCheckout 的收口说明），下单一律 fail-closed。
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

// ============ moltspay（未接入，保留壳以便将来接 x402）============
// pay.moltspayCheckout 现为 fail-closed：没有「运营显式配置且可信」的收银台地址，
// 一律拒绝下单，不再产出指向 moltspay.com/v1/pay 的死链。
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
  return { ok: false, error: '未知网关: ' + gateway + '（可用：paypal；moltspay 未接入）' };
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
      // 【必须分开两个 id】resource.id 是 PayPal 单号，reference_id 是我们的订单号。
      // 早前把二者混用（拿我们的单号当 PayPal 单号去查），查不到就永远结算不了。
      const res = body.resource || {};
      const ppId = res.id || '';
      const refId = (res.purchase_units && res.purchase_units[0] && res.purchase_units[0].reference_id) || '';
      const orderId = refId || ppId;
      if (orderId) {
        const cap = await paypalCapture(orderId, ppId);
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
