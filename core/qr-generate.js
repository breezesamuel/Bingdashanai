// QR code payload builder for Alipay/WeChat payments (PAYLOAD ONLY — no fake image)
//
// 【去假化 2026-11-06】旧版会画 5 个嵌套黑框当"二维码"（自注释 placeholder），
// 扫码器解不出来。真付款码走服务端短链 /pay/go/<订单号>，由客户端/桌面端真实编码；
// 本模块职责收窄为「产出待编码的真实 payload」，绝不产出无法验证的假二维码图像。
//
// 【可选增强】部署环境装了纯 JS 的 `qrcode` 包（npm i qrcode，无 native 依赖）时，
// buildQrImage() 自动升级为真实 QR 图（data URL）；没装就如实返回 not_enabled，不造假。

function buildAlipayScheme(opts) {
  const o = opts || {};
  const p = { app_id: o.appId || 'PENDING_CONFIG', amount: Number(o.amount) || 0, subject: String(o.subject || 'Payment').slice(0, 60), merchant: String(o.merchant || ''), order: String(o.orderId || '') };
  return { scheme: 'alipayqr://platformapi/startapp?saId=1000000004572&token=' + Buffer.from(JSON.stringify(p)).toString('base64').slice(0, 32), payload: JSON.stringify(p), dataUrl: null, dataUrlNote: '纯载荷（见 payload）；二维码图像由客户端/桌面端真实编码，本仓不自画假图' };
}

// 可选真实 QR 图像（纯 JS 库才启用；无库 = 如实 not_enabled，不造假）
function buildQrImage(text, opts) {
  const width = (opts && opts.width) || 300;
  let qrlib = null;
  try { qrlib = require('qrcode'); } catch (e) {
    return Promise.resolve({ ok: false, dataUrl: null, reason: 'qrcode 库未安装（npm i qrcode，纯 JS 无 native 依赖）', note: '不造假占位图；支付码走服务端 /pay/go/<订单号> 短链，由客户端真实编码' });
  }
  return qrlib.toDataURL(String(text), { width: width, margin: 1 })
    .then(function (url) { return { ok: true, dataUrl: url, engine: 'qrcode(纯JS)' }; })
    .catch(function (e) { return { ok: false, dataUrl: null, reason: 'qrcode 生成失败: ' + e.message }; });
}

// 兼容旧导出名：generateAlipayQR 现在返回真实 payload + 可选真图（不再是假黑框 SVG）
async function generateAlipayQR(opts) {
  const o = opts || {};
  const r = buildAlipayScheme({ amount: o.amount, subject: o.description, merchant: o.merchant, orderId: o.orderId });
  const img = await buildQrImage(r.payload, { width: 300 });
  return { ok: true, scheme: r.scheme, payload: r.payload, dataUrl: r.dataUrl, image: img };
}

// 兼容旧导出名：generateQR 升级为「载荷 + 可选真图」
async function generateQR(opts) {
  const o = opts || {};
  const img = await buildQrImage(String(o.data || ''), { width: o.width || 300 });
  return { ok: true, payload: String(o.data || ''), image: img };
}

module.exports = { buildAlipayScheme, buildQrImage, generateQR, generateAlipayQR };
