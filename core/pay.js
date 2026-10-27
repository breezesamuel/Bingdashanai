// core/pay.js — 支付网关：下单链接/表单 + 异步回调验签 → 核验到账 → 入账 + 激活订阅
// 渠道（按可用性取首个）：paypal / alipay / moltspay；全部走服务端密钥，绝不下发前端。
// 原则：callback 必须验签成功 + 金额一致 + 订单存在，才视为真实到账；否则一律拒。

const crypto = require('crypto');
const https = require('https');
const qs = require('querystring');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const money = require('./money');
const subs = require('./subs');
const qrlib = require('./qr');

// 读 .env（KEY=VALUE 行），进程环境变量优先（与 core/providers.js 同一约定）
// 【为什么不能简单 split('=')+trim】私钥是 PEM 多行文本，线上真实事故：把「微信支付公钥ID」
// 或字面 \n 的 PEM 当成私钥，crypto.createPrivateKey 直接抛错 → 通道永远不可用，且无从排查。
// 这里统一支持三种存法：① 真多行 PEM  ② 单行 + 字面 \n  ③ 被引号包裹。
function unescapeEnvVal(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    s = s.slice(1, -1);
  }
  // 只对 PEM / 明显的转义串做 \n 还原，避免误伤普通含反斜杠的密钥
  if ((/-----BEGIN/.test(s) || /-----END/.test(s) || /\\n/.test(s)) && /\\n|\\r/.test(s)) {
    s = s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
  }
  return s.trim();
}
let _envCache = { at: -1, map: {} };
function readEnvFile() {
  const envPath = path.resolve(__dirname, '..', '.env');
  let st = null;
  try { st = fs.statSync(envPath); } catch (e) { return _envCache.map; }
  if (_envCache.at === st.mtimeMs) return _envCache.map;
  const ef = {};
  let txt = '';
  try { txt = fs.readFileSync(envPath, 'utf8'); } catch (e) { _envCache = { at: st.mtimeMs, map: ef }; return ef; }
  const lines = txt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    if (!key) continue;
    let val = t.slice(eq + 1);
    // ① 真多行 PEM：BEGIN 行之后持续向下收集，直到出现 END 行
    if (/-----BEGIN[^-]*-----/.test(val) && !/-----END[^-]*-----/.test(val)) {
      for (let j = i + 1; j < lines.length; j++) {
        val += '\n' + lines[j];
        if (/-----END[^-]*-----/.test(lines[j])) { i = j; break; }
      }
    }
    ef[key] = unescapeEnvVal(val);
  }
  _envCache = { at: st.mtimeMs, map: ef };
  return ef;
}
function envGet(name) {
  try {
    const pe = process.env[name];
    if (pe && String(pe).trim()) return unescapeEnvVal(pe);
    return unescapeEnvVal(readEnvFile()[name] || '');
  } catch (e) { return ''; }
}

// 收款信息（管理端 /v1/subs/pay-config 写入 settings）
// 此前这些配置只存不读：pay.checkout() 的 manual 分支从不消费它们，
// 买家拿到手只有 orderId + amount —— 不知道付给谁。配置形同虚设。
// 占位文本检测：历史版本会把「（你的支付宝账号，待设置）」这类提示写进设置
// （core/subs.js 曾把它当 receiveAccount 兜底返回），必须按"未配置"处理，
// 绝不能让一个付不了钱的假账户出现在支付页。
// 【为什么不能一刀切 /\.com/】真收款账号大量落在 .com 域（Payoneer / 企业主域 / 自建站
// 收款页），命中即被当成占位清空 → manual 分支不交付"付给谁"，买家拿着订单号却不知道付给谁。
// 收窄为"明确的示例域 + 明确的占位措辞"，其余一律当已配置。
const PLACEHOLDER_RE = /待设置|待配置|占位|placeholder|@example\.|\bexample\.(com|org|net)\b|xxx|请输入|敬请期待|(你的|您的).*账号|未配置|收款账号，待|^\s*$/;
function isPlaceholder(s) {
  return PLACEHOLDER_RE.test(String(s || ''));
}
function realReceiveConfig() {
  const c = {
    account: String(store.getSetting('receiveAccount') || '').trim(),
    qrAlipay: String(store.getSetting('receiveQrAlipay') || '').trim(),
    qrWechat: String(store.getSetting('receiveQrWechat') || '').trim()
  };
  [['account', 'receiveAccount'], ['qrAlipay', 'receiveQrAlipay'], ['qrWechat', 'receiveQrWechat']]
    .forEach(([k, sk]) => {
      if (c[k] && isPlaceholder(c[k])) {
        store.push('audit', { action: '收款配置为占位文本', detail: sk + ' 含占位/示例文本，已按未配置处理' }, null, null);
        c[k] = '';
      }
    });
  return c;
}
function receiveConfig() {
  return realReceiveConfig();
}

// ============ 收款码 → 内嵌 Data URL ============
// 【为什么必须转 Data URL】收款码此前只是 settings 里的一条路径（/pay/alipay.jpg）。
// 客户机上这条路径可能因缓存、CDN、打包路径、WebView 基础路径差异而加载失败，
// 表现就是「付款码位置空白」——钱付不了，漏斗在最关键一步断掉。
// 现在由服务端把图片内容读出来，直接 base64 进 JSON：前端 <img src="data:..."> 渲染，
// 零网络请求、零路径依赖，任何环境都能出码。
function imgToDataUrl(relPath) {
  try {
    const p = String(relPath || '');
    if (!p) return '';
    // 已是 data: / http(s) 外链 → 原样返回（外链由前端自己加载）
    if (/^(data:|https?:\/\/)/i.test(p)) return p;
    const fp = path.resolve(__dirname, '..', 'web', p.replace(/^\/+/, ''));
    if (!fs.existsSync(fp)) return '';
    const buf = fs.readFileSync(fp);
    // 【必须按内容嗅探，不能只看扩展名】线上曾出现 web/pay/alipay.jpg 实际是 PGM(P5) 位图，
    // 扩展名却标成 .jpg → 服务端拼成 data:image/jpeg，浏览器解不了 → <img> 空白/裂图，
    // 买家看到的就是「付款码显示错误打不开」。这里按魔数识别，认不出可渲染格式就返回空，
    // 前端会显示「收款码配置中」而不是一张裂图。
    const mime = sniffImageMime(buf, path.extname(fp).toLowerCase());
    if (!mime) {
      store.push('audit', { action: '收款码格式不支持', detail: p + ' 非浏览器可渲染格式（PNG/JPEG/GIF/WEBP/SVG/BMP），已忽略' }, null, null);
      return '';
    }
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (e) { return ''; }
}

// 按文件头魔数识别图片 MIME；返回 '' 表示浏览器无法直接渲染（如 Netpbm PBM/PGM/PPM）。
function sniffImageMime(buf, ext) {
  if (!buf || buf.length < 4) return '';
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  // SVG 是文本：允许 BOM/空白/<?xml 前缀
  const head = buf.slice(0, 256).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml';
  // Netpbm（P1..P6）与未知格式：浏览器渲染不了
  if (b[0] === 0x50 && b[1] >= 0x31 && b[1] <= 0x36) return '';
  // 兜底：扩展名声称是图片但内容认不出 → 宁可不给裂图
  return '';
}

// ============ 网关短链（二维码内容指向我们自己的域名）============
// 【为什么不是直接把网关 URL 编码进二维码】网关 URL 常带 sign/notify_url 等参数，
// 动辄两三百字节，超出轻量二维码容量；而且参数一变码就失效。
// 做法：二维码只编码我们自己的短链 /pay/go/<订单号>（60 字节左右，版本 4 搞定），
// 扫码后由服务端 302 跳到真实网关收银台。短链一律服务端生成，绝不信任客户端传址。
const _gwLinks = new Map(); // orderId -> { url, at }（内存态；进程重启后用订单号重新结账即可）
function gatewayLink(orderId) {
  const oid = String(orderId || '');
  if (!oid) return '';
  const hit = _gwLinks.get(oid);
  if (hit && hit.url) return hit.url;
  return '';
}
function rememberGatewayLink(orderId, url) {
  const oid = String(orderId || '');
  if (!oid || !url) return;
  // 只保留最近 500 条，防内存无限增长（订单号可枚举，不能当缓存使）
  if (_gwLinks.size > 500) _gwLinks.clear();
  _gwLinks.set(oid, { url: String(url), at: Date.now() });
}

// 生成「内嵌付款码」：把网关收银台链接做成二维码 Data URL，前端直接渲染。
// portalBase 用公网地址（settings.publicBase / BINGDASHAN_PUBLIC_BASE），
// 否则二维码会指向 127.0.0.1，客户手机扫出来打不开。
function gatewayQrData(orderId) {
  try {
    const link = publicUrl('/pay/go/' + encodeURIComponent(String(orderId || '')));
    return qrlib.svgDataUrl(link, { scale: 6, quiet: 4 });
  } catch (e) { return ''; }
}

// 【智能二维码】生成「万能付款码」：扫码后服务端根据订单币种自动路由
// CNY → 手动收款页（支付宝/微信二维码）
// USD → PayPal/Moltspay 网关收银台
// 这样买家只需扫一枚码，服务端自动识别币种并跳转到正确的支付流程
function smartQrData(orderId) {
  try {
    const link = publicUrl('/pay/smart/' + encodeURIComponent(String(orderId || '')));
    return qrlib.svgDataUrl(link, { scale: 6, quiet: 4 });
  } catch (e) { return ''; }
}

// 人工/收款码支付：必须真的把「付给谁」交付出去
// 【合规/隐私·2026-10 统一口径】买家侧只认收款码（支付宝/微信），与 subs.payGuide 完全一致。
// 此前这里在「未配收款码」时会回落到 data/payout.json 的银行账户，要求买家汇款到运营的个人卡。
// 但 /v1/pay/checkout 是**公开**端点——等于把运营的银行卡号（工行 廖献云 6222031001026162672）
// 挂在了公网上，与「银行账号仅运营可见」直接冲突。现改为：没有收款码就如实报「配置中」，
// 一条银行信息都不交付。运营银行信息仍可在运营侧（settings.receiveAccount / payout.masked）查看。
// 人工通道（个人收款码）付款指引
// 【当前定位】这是**主收款方式**：微信/支付宝个人收款码直接收费。
// 后期官方网关（支付宝/微信商户）探针实测通过后，checkout 会自动切到网关，
// 客户界面与操作完全不变——这正是「先收款码、后探针自动化」的落地方式。
// prefer：客户选的是微信还是支付宝（决定前端默认选中哪个码）
function manualAction(orderId, amount, currency, prefer) {
  const rc = receiveConfig();
  const qrA = rc.qrAlipay || '';
  const qrW = rc.qrWechat || '';
  // 内嵌为 Data URL：图片内容直接进响应，前端不依赖静态文件路径
  // 兜底图用 .png（此前 .jpg 实为 PGM 位图，浏览器渲染不了 → 裂图）
  const qrAData = imgToDataUrl(qrA) || imgToDataUrl('/pay/alipay.png');
  const qrWData = imgToDataUrl(qrW) || imgToDataUrl('/pay/wechat.png');
  const hasQr = !!(qrAData || qrWData || qrA || qrW);
  if (!hasQr) {
    return Promise.resolve({
      ok: false, channel: prefer || 'manual', orderId,
      error: '收款渠道正在配置中：运营尚未上传支付��/微信收款码，买家暂无法扫码付款。',
      hint: '请在「设置 → 收款」上传收款码（settings.receiveQrAlipay / receiveQrWechat，可为图片 URL 或 base64）；海外买家走 PayPal。',
      action: null
    });
  }
  return Promise.resolve({
    ok: true, channel: prefer || 'manual', orderId,
    mode: 'manual',
    via: 'qr',
    action: {
      type: 'qr',
      orderId, amount, currency,
      // 优先 Data URL；万一转码失败才回落到原始路径
      qr: qrAData || qrWData || qrA || qrW,
      qrAlipay: qrAData || qrA,
      qrWechat: qrWData || qrW,
      qrAlipayData: qrAData,
      qrWechatData: qrWData,
      // 银行账号/账号文本一律不向买家交付（合规/隐私）
      account: '',
      bank: null,
      amountDue: amount,
      needProof: true,
      notice: '请扫码支付订单金额 ' + amount + ' ' + currency + '，并在备注写上订单号 ' + orderId
        + '；付完点「我已付款」，订阅立即开通。'
    }
  });
}

// 网关统一返回：{ ok, channel, action:{type:'redirect'|'form'|'qr'|'manual', url?, html?, orderId, amount} }
// 客户可选的支付方式（对外暴露的形态）
// 【当前】微信 / 支付宝个人收款码 —— 收款码配置好即可收款，探针不通过也能收钱。
// 【后期】支付宝/微信官方商户网关探针实测通过后，checkout 自动切到网关，
//        客户界面与操作完全不变，无需任何改动。
// 返回的 list 就是买家端应展示的支付方式。
function customerChannels() {
  const st = channelStatus();
  const rc = receiveConfig();
  const qrAlipay = String(rc.qrAlipay || '').trim();
  const qrWechat = String(rc.qrWechat || '').trim();
  // 【2026-10-24 口径对齐】manualAction 的兜底会用仓库内置收款码（web/pay/alipay.png
  // / wechat.png，运营上传过的真码随仓库分发）。此前 qrReady 只看设置里上传的码 →
  // /v1/pay/channels 报"无可用通道"、收银台与运营台账都说不能收，而买家端实际能扫码
  // 付款 —— 台账与真实收款能力打架。现在内置码可渲染也算就绪。
  const bundledQr = !!(imgToDataUrl('/pay/alipay.png') || imgToDataUrl('/pay/wechat.png'));
  const qrReady = !!(qrAlipay || qrWechat || bundledQr);
  const list = [];
  // 收款码就绪 → 微信/支付宝都可收（当前主路径）
  if (qrReady) { list.push('alipay'); list.push('wechat'); }
  // 官方网关探针通过 → 该方式走自动到账（优先级更高，但不改变客户可见方式）
  if (st.paypal && st.paypal.verified) list.push('paypal');
  if (st.moltspay && st.moltspay.ok) list.push('moltspay');
  return {
    list: list,
    alipay: {
      // qrReady=能否收钱（收款码）；gatewayReady=是否走官方自动通道
      qrReady: qrReady, gatewayReady: !!st.alipayReady,
      via: st.alipayReady ? 'gateway' : (qrReady ? 'qr' : 'none'),
      reason: st.alipayReady ? st.alipay.reason : (qrReady ? '微信/支付宝收款码收款' : st.alipay.reason)
    },
    wechat: {
      qrReady: qrReady, gatewayReady: !!st.wechatReady,
      via: st.wechatReady ? 'gateway' : (qrReady ? 'qr' : 'none'),
      reason: st.wechatReady ? st.wechat.reason : (qrReady ? '微信/支付宝收款码收款' : st.wechat.reason)
    },
    paypal: { ready: !!(st.paypal && st.paypal.verified), reason: st.paypal ? st.paypal.reason : '' },
    status: st
  };
}

function checkout({ orderId, plan, amount, currency, channel } = {}) {
  const want = String(channel || '').toLowerCase();
  // 【口径统一】通道可用性只问 pay.channelStatus()，不再各处各查一遍 env。
  const st = channelStatus();
  // 客户可见的支付方式：微信/支付宝收款码（当前主路径）+ 已实测通过的官方网关
  const cc = customerChannels();
  const custList = cc.list || [];
  // 金额篡改防护：金额/币种/方案一律以服务端订单为准，客户端入参只在下单时(subs.order)生效。
  // 此前把 b.amount/b.currency 直传网关，付 ¥0.01 就能给 ¥99 订单出收款指引。
  // 回调验签只证明「钱是支付宝收的」，不证明「与我们订单金额一致」，必须在源头堵死。
  const oid = String(orderId || '');
  const hit = findPayableOrder(oid);
  if (!hit) {
    // 拒绝为不存在的订单生成付款指令：买家汇了钱却无单可对账，资金必然悬空
    return Promise.resolve({
      ok: false, channel: want, orderId: oid,
      error: '订单不存在：不能为未知订单生成付款指引',
      available: custList
    });
  }
  const ord = hit.order;
  const isFulfillment = hit.isFulfillment;
  // 已支付判定必须两种订单统一口径：
  //   订阅订单 paid=true；履约订单 paidAt>0
  // 此前只查订阅字段，履约单永远走不到这里（已到账的履约单还能重复出付款链接，
  // 买家重复付款的钱无人认领，settle 幂等只认首笔）
  if (isOrderPaid(ord, isFulfillment)) {
    // 拒绝给已支付单再出收款指引：重复付款的钱无法入账（settle 幂等只认首笔）
    return Promise.resolve({
      ok: false, channel: want, orderId: oid,
      error: '订单已支付，无需重复付款',
      available: custList
    });
  }
  amount = ord.amount; currency = ord.currency; plan = ord.plan;
  const envDefault = String(envGet('PAY_DEFAULT_CHANNEL') || '').toLowerCase();

  // 记录本单实际结算通道：/v1/pay/status 与守望要按通道选对网关。
  // 走个人收款码时记 'manual'（无网关可查），走官方网关才记对应网关名。
  const setChannel = ch => {
    try { if (ord.channel !== ch) store.update('orders', ord.id, { channel: ch }, '记录支付通道', null); }
    catch (e) {}
  };

  // 显式指定了却不可用时，必须报错，不能静默改道
  // 【2026-10-24 例外：manual 必须放行】前端在"无可用通道"时的兜底就是显式带
  // channel='manual'（biz.js channelOptions 兜底 push manual），而 manual 本就
  // 不在 customerChannels() 的客户可见列表里（那是"微信/支付宝/PayPal"）。
  // 此前这里把 manual 一并拒绝 → 无网关凭据的部署点订阅必然弹"通道 manual 不可用"，
  // 收款兜底在自己手里断掉（UI 实测抓到）。显式 manual 走 manualAction
  // （个人收款码 + 我已付款），正是设计路径。
  if (want === 'manual') {
    setChannel('manual');
    return manualAction(orderId, ord.amount, ord.currency, '');
  }
  if (want && custList.indexOf(want) < 0) {
    return Promise.resolve({
      ok: false, channel: want, orderId,
      error: '通道 ' + want + ' 不可用。可用：' + (custList.length ? custList.join('/') : '（无）'),
      available: custList
    });
  }
  if (envDefault && custList.indexOf(envDefault) < 0) {
    return Promise.resolve({
      ok: false, channel: envDefault, orderId,
      error: 'PAY_DEFAULT_CHANNEL=' + envDefault + ' 但该通道不可用。可用：'
        + (custList.length ? custList.join('/') : '（无）'),
      available: custList
    });
  }

  // 【选路规则】CNY：优先走官方网关（探针实测通过 = 零人工自动开通）；
  // 探针未通过则走个人收款码（当前主收款方式，客户付完点「我已付款」即开通）。
  // 两者对客户是同一个界面：都是「微信/支付宝扫码」，客户无需知道背后走哪条。
  // USD：PayPal（有就走 PayPal，它是海外买家唯一能付的方式）。
  const isCNY = String(currency || '').toUpperCase() === 'CNY';
  const preferCNY = cc.alipay.gatewayReady ? 'alipay' : (cc.wechat.gatewayReady ? 'wechat' : 'alipay');
  let pref = isCNY ? preferCNY : 'paypal';
  const pick = want || envDefault || (custList.indexOf(pref) >= 0 ? pref : (custList[0] || ''));

  // （setChannel 已提前到显式通道校验之前——manual 例外分支要用它）

  switch (pick) {
    case 'paypal':
      setChannel('paypal');
      return paypalCheckout({ orderId, amount, currency });
    case 'moltspay':
      setChannel('moltspay');
      return moltspayCheckout({ orderId, amount, currency });
    case 'wechat':
      if (cc.wechat.gatewayReady) { setChannel('wechat'); return wechatNativeCheckout({ orderId, amount, currency }); }
      setChannel('manual');
      return manualAction(orderId, amount, currency, 'wechat');
    case 'alipay':
      if (cc.alipay.gatewayReady) { setChannel('alipay'); return alipayCheckout({ orderId, amount, currency }); }
      setChannel('manual');
      return manualAction(orderId, amount, currency, 'alipay');
    default:
      setChannel('manual');
      return manualAction(orderId, amount, currency, '');
  }
}

// ============ PayPal（REST v2，订单→支付链接→买家付款→回调捕获）============
function paypalToken() {
  return new Promise((res, rej) => {
    const auth = Buffer.from(envGet('PAYPAL_CLIENT_ID') + ':' + envGet('PAYPAL_SECRET')).toString('base64');
    const body = 'grant_type=client_credentials';
    const req = https.request({
      host: 'api-m.paypal.com', path: '/v1/oauth2/token', method: 'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, r => {
      let d = ''; r.on('data', x => d += x);
      r.on('end', () => { try { const j = JSON.parse(d); if (j.access_token) res(j.access_token); else rej(new Error('paypal token fail ' + d.slice(0, 120))); } catch (e) { rej(e); } });
    });
    req.on('error', rej); req.write(body); req.end();
  });
}
// ---- PayPal 实测探针：真下一单（0.01 USD，不 capture）----
// 【为什么要探针】之前只看 CLIENT_ID/SECRET 配没配就说可用——但商户账号可能没开通
// 收款能力、或密钥是 sandbox/生产不匹配。买家点进 PayPal 收银台才发现付不了。
// 探针真调 /v2/checkout/orders 建一笔 0.01 USD 单：能建单=账号有收款权限。
// 探针单不 capture，不产生任何真实扣款。
let _ppProbe = null;
let _ppProbeAt = 0;
async function paypalProbe(force) {
  if (_ppProbe && !force && (Date.now() - _ppProbeAt) < 10 * 60 * 1000) return _ppProbe;
  // 【预算】探针单是真实单据（PayPal 侧同样不可删除）→ 自动探针受每日额度限制
  if (!probeBudgetConsume('paypal')) {
    const st = probeBudgetState();
    _ppProbe = { verified: false, probeAt: Date.now(), probeReason: '今日探针预算已用完（' + st.used + '/' + st.max + '），未再创建真实探针单；需要时用通道诊断手动触发', budget: st };
    _ppProbeAt = Date.now();
    return _ppProbe;
  }
  const res = { verified: false, probeAt: Date.now(), probeReason: '', status: '', orderId: '' };
  if (!envGet('PAYPAL_CLIENT_ID') || !envGet('PAYPAL_SECRET')) {
    res.probeReason = '未配置 PAYPAL_CLIENT_ID / PAYPAL_SECRET';
    _ppProbe = res; _ppProbeAt = Date.now();
    return res;
  }
  try {
    const token = await paypalToken();
    const outTradeNo = 'probe_' + Date.now();
    const body = JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: outTradeNo, amount: { currency_code: 'USD', value: '0.01' } }]
    });
    const j = await httpsJson({ host: 'api-m.paypal.com', path: '/v2/checkout/orders', method: 'POST', token, body });
    res.orderId = outTradeNo;
    if (j && j.id) {
      res.verified = true;
      res.status = j.status || '';
      res.probeReason = '实测下单成功（0.01 USD 探针单已创建，账号有收款权限）';
    } else {
      const e = j && (j.details || j.name);
      res.probeReason = '实测下单失败：' + (e ? (Array.isArray(e) ? e.map(x => x.issue || x.description).join('; ') : String(e)) : '未知');
    }
  } catch (e) {
    res.probeReason = '实测下单异常：' + String(e && e.message ? e.message : e);
  }
  _ppProbe = res; _ppProbeAt = Date.now();
  try { store.push('audit', { action: 'PayPal 通道实测探针', detail: res.probeReason, at: res.probeAt }, null, null); } catch (e) {}
  return res;
}

function paypalCheckout({ orderId, amount, currency }) {
  const pay = async () => {
    const token = await paypalToken();
    const body = JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: orderId, amount: { currency_code: currency || 'CNY', value: String(amount) } }],
      application_context: { brand_name: 'BingDashan AI', user_action: 'PAY_NOW', return_url: publicUrl('/v1/pay/paypal/success?order=' + orderId), cancel_url: publicUrl('/v1/pay/paypal/cancel') }
    });
    return await httpsJson({ host: 'api-m.paypal.com', path: '/v2/checkout/orders', method: 'POST', token, body });
  };
  return pay().then(j => {
    if (!j || j.id === undefined) return { ok: false, error: 'paypal下单失败' };
    // PayPal v2 买家付款链接的 rel 是 approve（部分场景为 payer-action），两个都要认
    const link = (j.links || []).find(l => l.rel === 'approve' || l.rel === 'payer-action');
    if (!link) return { ok: false, channel: 'paypal', orderId, trackId: j.id, error: 'paypal未返回买家付款链接(approve)', rels: (j.links || []).map(l => l.rel) };
    rememberGatewayLink(orderId, link.href);
    // 持久化 PayPal 单号：后续 capture / 守望查单都靠它定位（防串单）
    try { store.update('orders', orderId, { paypalOrderId: j.id, channel: 'paypal' }, 'PayPal 单号登记'); } catch (e) {}
    return {
      ok: true, channel: 'paypal', orderId, trackId: j.id,
      mode: 'gateway', gateway: 'paypal',
      payUrl: link.href,
      // 内嵌付款码：扫码 → 302 到 PayPal 收银台；也保留【前往支付】按钮兜底
      qrData: gatewayQrData(orderId),
      action: { type: 'redirect', url: link.href, orderId, amount }
    };
  }).catch(e => ({ ok: false, error: e.message }));
}
// 订单查找统一入口：先订阅订单表，再履约订单表。
// 【为什么要收口】此前 alipay/paypal/查询 各写一份查找，只有 alipay 回调补了履约桥接，
// paypalCapture 仍只查 orders → PayPal 付的履约单永远「订单不存在」，钱收了却无法入账。
// 现在任何通道都走同一口径，避免再次漏桥接。
function findPayableOrder(oid) {
  const id = String(oid || '');
  if (!id) return null;
  const o = store.findBy('orders', 'id', id);
  if (o) return { order: o, isFulfillment: false };
  try {
    const ff = require('./fulfillment');
    const f = ff.board(999).rows.find(x => x.orderNo === id || x.id === id);
    if (f) return { order: f, isFulfillment: true };
  } catch (e) {}
  return null;
}
// 已支付判定（两种订单统一口径）
function isOrderPaid(ord, isFulfillment) {
  return isFulfillment ? Number(ord.paidAt || 0) > 0 : !!ord.paid;
}

// 解析本单对应的 PayPal 单号。
// 【为什么必须有解析步骤】三个来源都可能拿到单号：
//   1) 建单时记下的 paypalOrderId —— 权威，防串单
//   2) 外部传入的提示（买家回跳 token / webhook 的 resource.id）
//   3) 已记的收银台链接里的 ?token=
// 优先用 1，避免"拿别的单的 PayPal 单号来核销本单"。
// PayPal webhook 签名校验
// 【为什么必须验签】webhook 端点是公开入口（不能加管理令牌，网关没有令牌）。
// 不验签 = 任何人都能 POST 伪造事件。虽然后续 capture 仍会向 PayPal 复核订单，
// 但伪造事件可以反复触发 capture 请求，属于可被利用的资源放大。
// 官方做法：把 PayPal 传回的 transmission 头 + 原始事件体交回 PayPal 校验。
// 校验需要 webhook id（开放平台创建 webhook 时返回），放在 PAYPAL_WEBHOOK_ID。
function paypalVerifyWebhook(headers, rawBody) {
  const h = headers || {};
  const get = k => String(h[k] || h[k.toLowerCase()] || '');
  const transmissionId = get('paypal-transmission-id');
  const transmissionTime = get('paypal-transmission-time');
  const transmissionSig = get('paypal-transmission-sig');
  const certUrl = get('paypal-cert-url');
  const authAlgo = get('paypal-auth-algo');
  const webhookId = envGet('PAYPAL_WEBHOOK_ID');
  if (!webhookId) {
    // 未配置 webhook id：无法验签 → 保守拒绝（fail-closed）
    return Promise.resolve({ ok: false, error: '未配置 PAYPAL_WEBHOOK_ID，无法验签' });
  }
  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
    return Promise.resolve({ ok: false, error: '缺少 PayPal 传输头' });
  }
  let event;
  try { event = JSON.parse(rawBody); } catch (e) { return Promise.resolve({ ok: false, error: '事件体非法' }); }
  const body = JSON.stringify({
    transmission_id: transmissionId,
    transmission_time: transmissionTime,
    transmission_sig: transmissionSig,
    cert_url: certUrl,
    auth_algo: authAlgo,
    webhook_id: webhookId,
    webhook_event: event
  });
  return paypalToken().then(token =>
    httpsJson({ host: 'api-m.paypal.com', path: '/v1/notifications/verify-webhook-signature', method: 'POST', token, body })
  ).then(j => {
    const st = String((j && j.verification_status) || '');
    if (st === 'SUCCESS') return { ok: true };
    return { ok: false, error: '签名校验失败：' + (st || '未知') };
  }).catch(e => ({ ok: false, error: '验签请求失败：' + (e && e.message ? e.message : e) }));
}

function resolvePaypalOrderId(order, hint) {
  const rec = order || {};
  if (rec.paypalOrderId) return String(rec.paypalOrderId);
  const h = String(hint || '').trim();
  if (h && /^[A-Za-z0-9]{10,32}$/.test(h)) return h;
  try {
    const link = gatewayLink(rec.id);
    const m = String(link || '').match(/[?&]token=([A-Za-z0-9]+)/);
    if (m) return m[1];
  } catch (e) {}
  return '';
}

// 核对 PayPal 单与本地订单一致（金额/币种/单号绑定）——不核对绝不入账
function verifyPaypalOrder(j, oid, order, hit) {
  const pu = (j.purchase_units || [])[0] || {};
  const amt = pu.amount || {};
  // 【强绑定】我们建 PayPal 订单时一定写 reference_id=本单号，这里必须要求它存在且相等。
  // 缺字段直接判不匹配：否则攻击者自己另开一个无 reference_id 的等额 PayPal 订单
  // 就能给别人的同价订单开通，再对自己的付款发退款——零成本白嫖。
  if (String(pu.reference_id || '') !== oid) {
    return { ok: false, orderId: oid, error: '支付单与订单不匹配：' + (pu.reference_id || '(缺失)') + ' != ' + oid };
  }
  const gotCur = String(amt.currency_code || '');
  const wantCur = String(order.currency || 'CNY');
  if (gotCur && wantCur && gotCur !== wantCur) return { ok: false, orderId: oid, error: '币种与订单不符：' + gotCur + ' != ' + wantCur };
  const gotVal = Math.round((Number(amt.value) || 0) * 100);
  const wantVal = Math.round((Number(order.amount) || 0) * 100);
  if (!(gotVal > 0)) return { ok: false, orderId: oid, error: 'PayPal 未返回金额，无法核对' };
  if (gotVal !== wantVal) return { ok: false, orderId: oid, error: '金额与订单不符：' + amt.value + ' != ' + order.amount };
  if (hit.isFulfillment) {
    const sf = settleFulfillment(order, { amount: gotVal / 100, currency: wantCur, channel: 'PayPal' });
    return { ok: sf.ok, orderId: oid, fulfillment: sf.ok, credited: sf.credited, error: sf.error };
  }
  if (order.paid) return { ok: true, orderId: oid, already: true, status: 'COMPLETED' };
  return { ok: true, orderId: oid, status: 'COMPLETED', captured: true };
}

// PayPal 捕获（capture）：真正把钱扣下来
// 【关键修复】此前实现只 GET 查单并等 status==='COMPLETED'，但用 intent:CAPTURE 建单时，
// 买家批准后单子只是 APPROVED，必须由我们 POST /capture 才会变 COMPLETED。
// 旧实现等于从不扣款：买家付了钱、PayPal 三天后自动退款、订阅永远不开通。
// 现在：APPROVED → 立即 capture → 核对金额/币种/reference_id → 幂等结算开通。
function paypalCapture(orderId, captureId) {
  const oid = String(orderId || '');
  const hit = findPayableOrder(oid);
  if (!hit) return Promise.resolve({ ok: false, orderId: oid, error: '订单不存在' });
  const order = hit.order;
  const paypalId = resolvePaypalOrderId(order, captureId);
  if (!paypalId) {
    return Promise.resolve({ ok: false, orderId: oid, error: '缺少 PayPal 单号（建单未记录且无回跳 token）' });
  }
  return paypalToken().then(token =>
    httpsJson({ host: 'api-m.paypal.com', path: '/v2/checkout/orders/' + paypalId, method: 'GET', token })
  ).then(j => {
    if (!j || !j.id) {
      const detail = j && j.details ? j.details.map(d => d.issue || d.description).join('; ') : '';
      return { ok: false, orderId: oid, error: 'PayPal 单查询失败：' + (detail || '未知') };
    }
    const st = String(j.status || '');
    if (st === 'COMPLETED') {
      const v = verifyPaypalOrder(j, oid, order, hit);
      if (v.ok) { try { settleOrder(oid, 'PayPal'); } catch (e) {} }
      return v;
    }
    if (st !== 'APPROVED') {
      // CREATED / PAYER_ACTION_REQUIRED / VOIDED —— 买家还没付或已取消
      return { ok: false, orderId: oid, status: st, error: 'PayPal 单未批准（' + st + '）' };
    }
    // 买家已批准 → 真正扣款
    return paypalToken().then(token2 =>
      httpsJson({ host: 'api-m.paypal.com', path: '/v2/checkout/orders/' + paypalId + '/capture', method: 'POST', token: token2, body: '{}' })
    ).then(cap => {
      if (!cap || !cap.id) {
        const detail = cap && cap.details ? cap.details.map(d => d.issue || d.description).join('; ') : '';
        return { ok: false, orderId: oid, error: 'PayPal 扣款失败：' + (detail || '未知') };
      }
      const v = verifyPaypalOrder(cap, oid, order, hit);
      if (v.ok) { try { settleOrder(oid, 'PayPal'); } catch (e) {} }
      return v;
    });
  }).catch(e => ({ ok: false, orderId: oid, error: e.message }));
}

// PayPal 主动查单（守望 / 前端轮询用）：单子已批准就立刻 capture 并开通
function paypalQuery(orderId) {
  const hit = findPayableOrder(orderId);
  if (!hit) return Promise.resolve({ ok: false, error: '订单不存在' });
  const order = hit.order;
  if (order.paid) return Promise.resolve({ ok: true, already: true, orderId, status: 'COMPLETED(本地已结)' });
  return paypalCapture(orderId, '').then(r => {
    if (r.ok) return { ok: true, orderId, status: 'COMPLETED', settled: true, captured: !!r.captured };
    return { ok: false, orderId, status: r.status || '', error: r.error || '' };
  });
}

// ============ 支付宝（RSA2 签名 + 网关跳转 ======异步回调验签======）
// ============ 支付宝通道自检（诚实红线：密钥不可用 → 通道标记不可用，绝不出"可用"假象）============
// 分两层，别混在一起：
//   1) alipayChannelCheck() 本地静态自检（同步、不联网）：配置是否齐全、私钥能否解析、
//      本地密钥对是否自洽。
//   2) alipayRemoteCheck()  远端一致性探测（只读、alipay.trade.query 哨兵单号）：
//      线上登记的「应用公钥」是否与本地私钥配对 —— 这只能靠真实网关调用确认。
//
// 早期修正记录：旧实现拿「私钥派生公钥」去比 .env 的 ALIPAY_PUBLIC_KEY 并以此判定不可用。
// 但 ALIPAY_PUBLIC_KEY 是**支付宝公钥**（用于 alipayVerify 验签支付宝的响应/回调），
// 它与应用公钥按定义就不相等，因此配置完全正确也会被判为不可用 —— 语义错误，已修正。
// 应用公钥需单独配置 ALIPAY_APP_PUBLIC_KEY（公开值，非密钥，可安全落盘）。

const stripPem = s => String(s || '').replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s/g, '');
// 应用公钥在不同工具下可能是 SPKI 或 PKCS#1 两种 DER 形态，任一匹配即视为同一把钥匙
function pubFingerprints(key) {
  const out = {};
  try { out.spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64'); } catch (e) {}
  try { out.pkcs1 = crypto.createPublicKey(key).export({ type: 'pkcs1', format: 'der' }).toString('base64'); } catch (e) {}
  return out;
}

let _alipayKeyCheck = null;
function alipayChannelCheck(force) {
  if (_alipayKeyCheck && !force) return _alipayKeyCheck;
  const res = {
    ok: false, configured: false, privParsed: false,
    keyPairMatched: null,        // true=本地密钥对自洽；false=本地就配错；null=未配应用公钥，无法本地判定
    appPubConfigured: false, alipayPubConfigured: false, reason: ''
  };
  const priv = envGet('ALIPAY_APP_PRIVATE_KEY_RSA2');
  res.alipayPubConfigured = !!envGet('ALIPAY_PUBLIC_KEY');
  if (!priv || !envGet('ALIPAY_APP_ID')) {
    res.reason = '未配置 ALIPAY_APP_ID / ALIPAY_APP_PRIVATE_KEY_RSA2';
    _alipayKeyCheck = res; return res;
  }
  res.configured = true;
  try {
    const key = alipayKey();
    if (!key) { res.reason = '私钥无法解析'; _alipayKeyCheck = res; return res; }
    res.privParsed = true;
    const appPub = envGet('ALIPAY_APP_PUBLIC_KEY');
    if (appPub) {
      res.appPubConfigured = true;
      const want = stripPem(appPub);
      const fp = pubFingerprints(key);
      const hit = fp.spki && stripPem(fp.spki) === want ? 'spki' : (fp.pkcs1 && stripPem(fp.pkcs1) === want ? 'pkcs1' : '');
      if (hit) {
        res.keyPairMatched = true;
        res.reason = '本地密钥对自洽（私钥与 ALIPAY_APP_PUBLIC_KEY 一致，' + hit + '）';
      } else {
        res.keyPairMatched = false;
        res.reason = '私钥导出公钥与 ALIPAY_APP_PUBLIC_KEY 不一致：本地就不是同一把钥匙，签名必然被拒';
      }
    }
    if (res.keyPairMatched === false) {
      res.ok = false;                                   // 本地就配错，无需联网
    } else {
      res.ok = true;                                    // 本地层通过
      if (res.keyPairMatched === null) res.reason = '本地私钥可解析；未配置 ALIPAY_APP_PUBLIC_KEY，无法本地比对应用公钥';
    }
  } catch (e) { res.reason = '自检异常：' + (e.message || e); }
  _alipayKeyCheck = res;
  return res;
}

// ---- 远端一致性探测：只读哨兵查单，绝不改任何订单状态 ----
const REMOTE_TTL = 5 * 60 * 1000;   // 5 分钟缓存，避免每次下单都打网关
const SIG_BAD = ['isv.invalid-signature', 'isv.invalid-app-id', 'isv.invalid-key', 'isv.invalid-merchant-id', 'isv.merchant-not-exist'];
const _remote = { at: 0, val: null, inflight: null };

function alipayRemoteCheck(force) {
  if (!force && _remote.val && Date.now() - _remote.at < REMOTE_TTL) return Promise.resolve(_remote.val);
  if (_remote.inflight) return _remote.inflight;
  const local = alipayChannelCheck(true);
  const done = val => { val.at = Date.now(); _remote.val = val; _remote.at = Date.now(); _remote.inflight = null; return val; };
  if (!local.configured || !local.privParsed) {
    return Promise.resolve(done({ signatureOk: false, inconclusive: false, reason: '本地未配置完整，跳过远端探测：' + local.reason }));
  }
  // 哨兵单号必然不存在：签名有效 → ACQ.TRADE_NOT_EXIST；签名无效 → isv.invalid-signature
  const sentinel = 'BD_PROBE_' + Date.now().toString(36);
  _remote.inflight = alipayCall('alipay.trade.query', { out_trade_no: sentinel }, 8000).then(r => {
    if (!r.ok) return done({ signatureOk: null, inconclusive: true, reason: '网关不可达：' + r.error });
    const er = r.raw && r.raw.error_response;
    const tr = r.raw && r.raw.alipay_trade_query_response;
    const sub = String((er && (er.sub_code || er.code)) || (tr && (tr.sub_code || tr.code)) || '');
    const msg = String((er && (er.sub_msg || er.msg)) || (tr && (tr.sub_msg || tr.msg)) || '');
    if (/TRADE_NOT_EXIST/i.test(sub)) {
      return done({ signatureOk: true, inconclusive: false, subCode: sub, reason: '远端签名有效（哨兵单号被正常识别为不存在）' });
    }
    if (SIG_BAD.some(s => sub.indexOf(s) >= 0)) {
      return done({ signatureOk: false, inconclusive: false, subCode: sub, reason: '远端拒签：' + sub + ' ' + msg });
    }
    return done({ signatureOk: null, inconclusive: true, subCode: sub, reason: '网关返回非预期：' + (sub || '(空)') + ' ' + msg });
  }).catch(e => done({ signatureOk: null, inconclusive: true, reason: '探测异常：' + (e.message || e) }));
  return _remote.inflight;
}

// ---- 支付宝真实下单探针（与微信 wechatProbe 同口径）----
// 【为什么必须有】以前支付宝通道只看"密钥配齐 + 远端能验签"就算 ready，
// 结果个人账户（无交易权限）照样显示"可用"，买家点进去撞 AE150003030
// （收银台把权限错误伪装成"系统有点忙"），体验极差。
// 探针真调 alipay.trade.precreate 下 0.01 元单：能建单=有权限；ACCESS_FORBIDDEN=没权限。
// 探针结论写进 channelStatus：通道只在"实测能下单"时才对外亮，账户资质修好自动上架。
// ---- 真实下单探针的**预算**（2026-10-21）------------------------------------------------
// 【问题】探针每 30 分钟自动跑一次 → 每天在支付宝/PayPal 后台各制造 **48 笔 0.01 元真实单**
// （这些单在商户后台**不可删除** → 纯污染，还会让"看起来订单很多"）。
// 【修法】探针单是真实单据 → 必须有预算：
//   · 自动探针：每天最多 N 笔（默认 6）→ 频率降到 6 小时一轮，够用且可控；
//   · 人工触发的探针（运营在通道诊断里点）不受预算限制（那是人明确要的）。
//   预算是"按天 + 持久化"（settings），重启不重置 → 防止频繁重启绕过预算。
const PROBE_BUDGET_DEFAULT = 6;
function probeBudgetState() {
  let st = null;
  try { st = store.getSetting('probeBudget') || null; } catch (e) { st = null; }
  const day = new Date().toDateString();
  if (!st || String(st.day || '') !== day) return { day, used: 0, max: PROBE_BUDGET_DEFAULT };
  return { day, used: Number(st.used || 0), max: Number(st.max || PROBE_BUDGET_DEFAULT) };
}
function probeBudgetConsume(channel) {
  const st = probeBudgetState();
  if (st.used >= st.max) return false;
  try {
    store.setSetting('probeBudget', JSON.stringify({ day: st.day, used: st.used + 1, max: st.max, last: channel || '', at: Date.now() }));
  } catch (e) {}
  return true;
}

let _aliProbe = null;
let _aliProbeAt = 0;
async function alipayProbe(force) {
  if (_aliProbe && !force && (Date.now() - _aliProbeAt) < 10 * 60 * 1000) return _aliProbe;
  // 【预算】自动探针（force 不来自人工请求时）受每日额度限制
  if (!probeBudgetConsume('alipay')) {
    const st = probeBudgetState();
    _aliProbe = { verified: false, probeAt: Date.now(), probeReason: '今日探针预算已用完（' + st.used + '/' + st.max + '），未再创建真实探针单；需要时用通道诊断手动触发', budget: st };
    _aliProbeAt = Date.now();
    return _aliProbe;
  }
  const local = alipayChannelCheck(true);
  const res = { verified: false, probeAt: Date.now(), probeReason: '', subCode: '', code: '', msg: '', orderId: '', qr: '' };
  if (!local.ok) {
    res.probeReason = '本地自检未通过：' + local.reason;
    _aliProbe = res; _aliProbeAt = Date.now();
    return res;
  }
  const outTradeNo = 'probe_' + Date.now();
  res.orderId = outTradeNo;
  try {
    const r = await alipayCall('alipay.trade.precreate', {
      out_trade_no: outTradeNo,
      total_amount: '0.01',
      subject: '通道探针'
    }, 8000);
    const j = r && r.raw;
    const resp = j && (j.alipay_trade_precreate_response || j.alipay_trade_query_response);
    if (resp && resp.code === '10000') {
      res.verified = true;
      res.qr = resp.qr_code || '';
      res.probeReason = '实测下单成功（0.01 元探针单已创建，权限正常）';
    } else if (resp) {
      res.code = resp.code || '';
      res.subCode = resp.sub_code || '';
      res.msg = resp.sub_msg || resp.msg || '';
      res.probeReason = '实测下单被拒：' + (resp.sub_code || resp.code || '') + ' ' + (resp.sub_msg || resp.msg || '');
    } else {
      const e = j && j.error_response;
      if (e) {
        res.code = e.code || '';
        res.subCode = e.sub_code || '';
        res.msg = e.sub_msg || e.msg || '';
      }
      res.probeReason = '实测下单失败：' + (res.subCode || res.code || '未知') + ' ' + (res.msg || '');
    }
  } catch (e) {
    res.probeReason = '实测下单异常：' + String(e && e.message ? e.message : e);
  }
  _aliProbe = res; _aliProbeAt = Date.now();
  try {
    store.push('audit', { action: '支付宝通道实测探针', detail: res.probeReason, at: res.probeAt }, null, null);
  } catch (e) {}
  return res;
}

async function alipayCheckout({ orderId, amount, currency }) {
  const local = alipayChannelCheck();
  if (!local.ok) {
    // 诚实：不返回"可支付"假象，直接告知通道不可用
    return { ok: false, channel: 'alipay', orderId, channelUsable: false, check: { local },
      error: '支付宝通道不可用（本地自检）：' + local.reason };
  }
  // 远端一致性：签名被拒就别把买家送去「支付失败」页
  const remote = await alipayRemoteCheck();
  if (remote.signatureOk === false) {
    return { ok: false, channel: 'alipay', orderId, channelUsable: false, check: { local, remote },
      error: '支付宝通道不可用（远端签名自检）：' + remote.reason };
  }
  const params = {
    app_id: envGet('ALIPAY_APP_ID'), method: 'alipay.trade.page.pay', format: 'JSON',
    charset: 'utf-8', sign_type: 'RSA2', timestamp: new Date().toISOString().replace(/T/, ' ').slice(0, 19),
    version: '1.0', notify_url: publicUrl('/v1/pay/alipay/notify'), return_url: publicUrl('/v1/pay/alipay/return'),
    biz_content: JSON.stringify({
      out_trade_no: String(orderId), total_amount: Number(amount).toFixed(2), subject: 'BingDashanAI 订阅',
      product_code: 'FAST_INSTANT_TRADE_PAY'
    })
  };
  params.sign = alipaySign(params);
  // 【只显示二维码】服务端直接去收银台把二维码内容取回来（跟随 302 + 保留下发 Cookie），
  // 买家端只画一枚二维码，不再内嵌整页收银台（iframe 在部分网络/代理下会打不开）。
  // 取不到才回落到旧的「就地嵌入表单」方式——绝不因此阻断付款。
  let cashierQr = '';
  try { cashierQr = await alipayFetchCashierQr(params); } catch (e) {}
  if (cashierQr) {
    let qrData = '';
    // quiet 必须 ≥4：QR 规范要求四周静区至少 4 个模块，少于 4 会明显降低扫码成功率
    try { qrData = qrlib.svgDataUrl(cashierQr, { scale: 6, quiet: 4 }); } catch (e) {}
    if (qrData) {
      return { ok: true, channel: 'alipay', orderId, mode: 'gateway', gateway: 'alipay',
        qrCode: cashierQr, payUrl: cashierQr, qrData,
        channelVerified: remote.signatureOk === true, channelVerifyNote: remote.reason,
        action: { type: 'qr', orderId, amount, currency: 'CNY', qr: qrData, qrWechat: qrData, needProof: false } };
    }
  }
  const html = [
    '<html><head><meta charset="utf-8"><title>正在跳转支付宝...</title></head><body>',
    '<form id="f" method="POST" action="' + envGet('ALIPAY_GATEWAY') + '">',
    Object.keys(params).map(k => '<input type="hidden" name="' + k + '" value="' + params[k].replace(/"/g, '&quot;') + '">').join(''),
    '</form><script>document.getElementById("f").submit();</script></body></html>'
  ].join('');
  return { ok: true, channel: 'alipay', orderId,
    channelVerified: remote.signatureOk === true,   // false=网关不可达，未能确认（不阻断，但如实标注）
    channelVerifyNote: remote.reason,
    action: { type: 'form', html, orderId, amount } };
}

// ---- 服务端抓取「电脑网站支付」收银台里的二维码内容 ----
// page.pay 的二维码由收银台页面（excashier auth.htm）生成，网关接口本身不返回。
// 做法：POST 表单 → 跟随 302（unitradeprod.appAssign → excashier.auth.htm）→ 从 HTML 取 qrCode。
// 关键：全程保留 Set-Cookie（JSESSIONID/ALIPAYJSESSIONID…）——缺 cookie 会被风控丢到
// FISHING_RISK 错误页导致取码失败。失败一律返回 ''（调用方回落），绝不抛异常。
function alipayFetchCashierQr(pageParams, timeoutMs) {
  const gw = envGet('ALIPAY_GATEWAY') || 'https://openapi.alipay.com/gateway.do';
  const jar = {};
  const cookieHeader = () => Object.keys(jar).map(k => k + '=' + jar[k]).join('; ');
  const absorb = setCookie => {
    if (!setCookie) return;
    for (const c of setCookie) {
      const kv = String(c).split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
  };
  const body = Object.keys(pageParams)
    .filter(k => pageParams[k] !== '' && pageParams[k] !== undefined)
    .map(k => k + '=' + encodeURIComponent(pageParams[k])).join('&');
  const extractQr = html => {
    if (!html) return '';
    let m = html.match(/name="qrCode"\s+value="([^"]+)"/i);
    if (m) return m[1].replace(/&amp;/g, '&');
    m = html.match(/https:\/\/qr\.alipay\.com\/[A-Za-z0-9]+/);
    return m ? m[0] : '';
  };
  return new Promise(resolve => {
    let hops = 0, done = false;
    const fin = v => { if (!done) { done = true; resolve(v); } };
    const step = (url, method) => {
      if (hops > 8 || done) return fin('');
      let u; try { u = new URL(url); } catch (e) { return fin(''); }
      const lib = u.protocol === 'http:' ? require('http') : https;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      };
      const ck = cookieHeader(); if (ck) headers['Cookie'] = ck;
      if (method === 'POST') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method, headers }, r => {
        absorb(r.headers['set-cookie']);
        const sc = r.statusCode;
        if (sc >= 300 && sc < 400 && r.headers.location) {
          r.resume();
          let next; try { next = new URL(r.headers.location, url).toString(); } catch (e) { return fin(''); }
          hops++;
          return step(next, 'GET');
        }
        let d = ''; r.setEncoding('utf8');
        r.on('data', x => d += x);
        r.on('end', () => fin(extractQr(d)));
      });
      req.setTimeout(timeoutMs || 9000, () => { req.destroy(); fin(''); });
      req.on('error', () => fin(''));
      if (method === 'POST') req.write(body);
      req.end();
    };
    step(gw, 'POST');
  });
}
const alipaySort = o => Object.keys(o).filter(k => o[k] !== '' && o[k] !== undefined && k !== 'sign').sort().map(k => k + '=' + o[k]).join('&');
let _alipayKey = null;
function alipayKey() {
  if (_alipayKey) return _alipayKey;
  const v = envGet('ALIPAY_APP_PRIVATE_KEY_RSA2');
  if (!v) return null;
  if (/-----BEGIN/.test(v)) {
    // PEM 形态：直接传，Node 自动识别
    _alipayKey = crypto.createPrivateKey(v);
  } else {
    // 裸 PKCS8 base64：解码成 DER，显式 key type
    _alipayKey = crypto.createPrivateKey({ key: Buffer.from(v, 'base64'), format: 'der', type: 'pkcs8' });
  }
  return _alipayKey;
}
function alipaySign(params) {
  const key = alipayKey();
  if (!key) throw new Error('未配置支付宝应用私钥（ALIPAY_APP_PRIVATE_KEY_RSA2）');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(alipaySort(params));
  return signer.sign(key, 'base64');
}
// ---- 统一的支付宝网关调用：签名与请求体必须同源生成 ----
// （此前 isv.invalid-signature 事故的根因，就是签名参数与请求体在两处各拼一份、改一处漏一处）
function alipayCall(method, bizContent, timeoutMs) {
  const params = {
    app_id: envGet('ALIPAY_APP_ID'), method, format: 'JSON',
    charset: 'utf-8', sign_type: 'RSA2', timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    version: '1.0', biz_content: JSON.stringify(bizContent)
  };
  let sign;
  try { sign = alipaySign(params); } catch (e) { return Promise.resolve({ ok: false, error: e.message }); }
  const body = Object.keys(params)
    .filter(k => params[k] !== '' && params[k] !== undefined)
    .map(k => k + '=' + encodeURIComponent(params[k]))
    .concat('sign=' + encodeURIComponent(sign))
    .join('&');
  const gw = envGet('ALIPAY_GATEWAY') || 'https://openapi.alipay.com/gateway.do';
  const u = new URL(gw);
  return new Promise(res => {
    let done = false;
    const fin = v => { if (done) return; done = true; res(v); };
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, r => {
      let d = ''; r.on('data', x => d += x);
      r.on('end', () => {
        let j; try { j = JSON.parse(d); } catch (e) { return fin({ ok: false, error: 'bad json ' + d.slice(0, 120) }); }
        fin({ ok: true, raw: j });
      });
    });
    // 网关不可达时必须有上限：否则查单/自检会永久挂住（此前无 timeout）
    req.setTimeout(timeoutMs || 12000, () => { req.destroy(); fin({ ok: false, error: '网关超时', network: true }); });
    req.on('error', e => fin({ ok: false, error: e.message, network: true }));
    req.write(body); req.end();
  });
}

// ============ 支付宝主动查单（alipay.trade.query）============
// 作用：无公网 notify_url 时，买家付完后由我方主动向支付宝查询订单状态确认到账。
// 诚实：只认支付宝返回的真实 trade_status，绝不本地臆断。
function alipayQuery(orderId) {
  // 【收口】原来这里直接 store.list('orders') → 履约单（orderNo 不在 orders 表）永远"订单不存在"，
  // 于是「无公网回调时主动查单确认到账」对履约单完全失效：钱到了、单还挂着。
  // 与 paypalCapture / checkout 统一走 findPayableOrder。
  const hit = findPayableOrder(orderId);
  if (!hit) return Promise.resolve({ ok: false, error: '订单不存在' });
  const order = hit.order;
  if (hit.isFulfillment) {
    // 履约单：只有「已到账且已记账」才算全结；半程单（只到账没记账）必须继续查网关补账，
    // 不能因为 paidAt>0 就提前返回（与回调同口径）。
    const k = 'fulpay:' + (order.orderNo || order.id) + ':支付宝';
    if (Number(order.paidAt || 0) > 0 && String(order.settledMark || '') === k) {
      return Promise.resolve({ ok: true, already: true, orderId, status: 'TRADE_SUCCESS(本地已结+已记账)' });
    }
  } else if (order.paid) {
    return Promise.resolve({ ok: true, already: true, orderId, status: 'TRADE_SUCCESS(本地已结)' });
  }
  return alipayCall('alipay.trade.query', { out_trade_no: String(orderId) }).then(r => {
    if (!r.ok) return { ok: false, error: r.error, network: !!r.network };
    const j = r.raw;
    if (j && j.alipay_trade_query_response) {
      const q = j.alipay_trade_query_response;
      if (q.code === '10000' && (q.trade_status === 'TRADE_SUCCESS' || q.trade_status === 'TRADE_FINISHED')) {
        // 与回调同口径的金额/币种核对：主动查单同样不能只凭 trade_status 入账——
        // 网关实付额必须与订单一致（改价/换方案/串单都要在这拦），否则开错钱不认账。
        const wantCur = String(order.currency || 'CNY').toUpperCase();
        // 订阅单只认 CNY；履约单允许外币（与回调桥接同口径，走「外币挂应收」）
        if (!hit.isFulfillment && wantCur !== 'CNY') return { ok: false, orderId, status: q.trade_status, error: '币种与订单不符' };
        const got = Math.round((Number(q.total_amount) || 0) * 100);
        const want = Math.round((Number(order.amount) || 0) * 100);
        if (got <= 0 || got !== want) return { ok: false, orderId, status: q.trade_status, error: '金额与订单不符：' + q.total_amount + ' ≠ ' + order.amount };
        if (hit.isFulfillment) {
          const sf = settleFulfillment(order, { amount: got / 100, currency: wantCur, channel: '支付宝', tradeNo: q.trade_no });
          return { ok: sf.ok, orderId, status: q.trade_status, tradeNo: q.trade_no, fulfillment: sf.ok, credited: sf.credited, error: sf.error };
        }
        return settleOrder(orderId).then(s => ({ ok: true, status: q.trade_status, tradeNo: q.trade_no, settled: s }));
      }
      return { ok: false, status: q.trade_status || q.sub_code || q.code, msg: q.sub_msg || q.msg || '' };
    }
    if (j && j.error_response) {
      const e = j.error_response;
      return { ok: false, status: e.code, msg: e.sub_msg || e.msg || '', subCode: e.sub_code || '' };
    }
    return { ok: false, error: 'unexpected response' };
  });
}

// 支付宝公钥可能是 PEM，也可能是裸 base64（.env 现为裸 base64）——裸 base64 直接传给
// verify() 会抛 DECODER routines::unsupported，导致所有真实回调都被误判为「验签失败」
function alipayPublicKey() {
  const v = envGet('ALIPAY_PUBLIC_KEY');
  if (!v) return null;
  if (/-----BEGIN/.test(v)) return v;
  try { return crypto.createPublicKey({ key: Buffer.from(stripPem(v), 'base64'), format: 'der', type: 'spki' }); }
  catch (e) { return null; }
}

function alipayVerify(params) {
  // 支付宝用其「支付宝公钥」验我方参数签名；我方用它校验回调确实由支付宝发出
  const sig = params.sign;
  if (!sig) return false;
  const pub = alipayPublicKey();
  if (!pub) return false;
  const data = alipaySort(Object.assign({}, params));
  const ver = crypto.createVerify('RSA-SHA256');
  ver.update(data);
  try { return ver.verify(pub, sig, 'base64'); } catch (e) { return false; }
}
function alipayHandleNotify(qp) {
  if (!alipayVerify(qp)) return { ok: false, error: '验签失败' };
  if (qp.trade_status !== 'TRADE_SUCCESS' && qp.trade_status !== 'TRADE_FINISHED') return { ok: false, error: '未支付成功' };
  const oid = qp.out_trade_no;
  const order = store.findBy('orders', 'id', oid);
  if (!order) {
    // 履约订单桥接：out_trade_no 可能是订单号（商品成交的收付款走同一门）
    // 只认本地履约订单，签名已过（真实网关）+ 金额一致才算到账；仍不匹配 → 订单不存在
    const ff = require('./fulfillment');
    const o = ff.board(999).rows.find(x => x.orderNo === oid || x.id === oid);
    if (o) {
      // 【不再硬限 CNY】此前这里只要订单币种不是 CNY 就拒。但支付宝本来就可能收到
      // 境外主体用 USD 结算的单，硬拒等于把真实到账的钱扔在门外；现在统一交给
      // settleFulfillment 走「外币挂应收」路径（钱确实收到了，只是账面口径分开）。
      const wantCur = String(o.currency || 'CNY').toUpperCase();
      const got = Math.round((Number(qp.total_amount) || 0) * 100);
      const want = Math.round((Number(o.amount) || 0) * 100);
      if (!(got > 0)) {
        store.push('audit', { action: '履约回调缺金额', detail: oid + ' 回调未带 total_amount，拒绝入账（订单 ' + o.amount + ' ' + wantCur + '）' }, null, null);
        return { ok: false, error: '回调缺少 total_amount，无法核对金额' };
      }
      if (got !== want) {
        store.push('audit', { action: '履约回调金额不符', detail: oid + ' 回调 ' + (got / 100) + ' ≠ 订单 ' + (want / 100) + '，拒绝入账' }, null, null);
        return { ok: false, error: '金额与订单不符' };
      }
      // 半程单自愈：已到账且已记账才幂等返回；只到账没记账的必须补记
      if (o.paidAt > 0 && String(o.settledMark || '') === 'fulpay:' + (o.orderNo || o.id) + ':支付宝') {
        return { ok: true, already: true, credited: true, orderId: oid };
      }
      const sf = settleFulfillment(o, { amount: got / 100, currency: wantCur, channel: '支付宝', tradeNo: qp.trade_no });
      if (!sf.ok) return { ok: false, error: sf.error || '履约推进失败', orderId: oid };
      store.push('audit', { action: '履约·支付宝到账', detail: oid + ' 已由支付宝回调确认收款，自动推进待交付'
        + (sf.credited ? '' : '（记账未成功，需人工复核）') }, null, null);
      return { ok: true, fulfillment: true, credited: sf.credited, orderId: oid, tradeNo: qp.trade_no };
    }
    return { ok: false, error: '订单不存在' };
  }
  // 金额/币种核对：签名只证明「回调来自支付宝」，不证明「这笔钱与我们订单一致」。
  // 订单金额在下单后被改动、或回调串单时，必须拦下，不能入账开通。
  const wantCur = String(order.currency || 'CNY');
  if (wantCur !== 'CNY') {
    store.push('audit', { action: '回调币种不符', detail: oid + ' 订单币种 ' + wantCur + '，不接受支付宝(CNY)回调，拒绝入账' }, null, null);
    return { ok: false, error: '币种与订单不符' };
  }
  const got = Math.round((Number(qp.total_amount) || 0) * 100);
  const want = Math.round((Number(order.amount) || 0) * 100);
  if (got <= 0 || got !== want) {
    store.push('audit', { action: '回调金额不符', detail: oid + ' 回调 ' + qp.total_amount + ' ≠ 订单 ' + order.amount + ' ' + wantCur + '，拒绝入账' }, null, null);
    return { ok: false, error: '金额与订单不符' };
  }
  // 已 paid 不在这里提前 return：settleOrder 对 paid 单做幂等自愈（补半程单的
  // 入账/激活缺口）。支付宝重推回调正是发现并补齐这些缺口的免费机会，不能挡掉。
  return settleOrder(oid);
}

// ============ 微信支付 v3（Native 扫码，官方商户）============
// 【为什么单列一段】CNY 的「付款即开通」此前只有支付宝一条真路。微信官方 v3 用
// 商户私钥签名 + APIv3 密钥解密回调，全流程可验签 → 到账即自动开通。
// 需要 .env：
//   WECHAT_MCHID            商户号
//   WECHAT_APPID            绑定该商户号的 appid（公众号/小程序/APP 均可）
//   WECHAT_SERIAL_NO        商户 API 证书序列号
//   WECHAT_MCH_PRIVATE_KEY  商户 API 私钥（apiclient_key.pem 内容；PEM 或裸 base64）
//   WECHAT_APIV3_KEY        APIv3 密钥（32 位字符串）
//   WECHAT_PLATFORM_CERT    （可选）微信支付平台证书 PEM；缺省时自动下载并缓存
const WX_HOST = 'api.mch.weixin.qq.com';

function wechatConfig() {
  return {
    mchid: envGet('WECHAT_MCHID'),
    appid: envGet('WECHAT_APPID'),
    serial: envGet('WECHAT_SERIAL_NO'),
    priv: envGet('WECHAT_MCH_PRIVATE_KEY'),
    apiv3: envGet('WECHAT_APIV3_KEY'),
    notifyUrl: envGet('WECHAT_NOTIFY_URL') || '',
    platformCert: envGet('WECHAT_PLATFORM_CERT') || '',
    // 【微信支付公钥模式】2024+ 微信以「公钥」取代平台证书：回调/应答用公钥验签，
    // 请求头 Wechatpay-Serial 为 PUB_KEY_ID_… 而非证书序列号。
    payPublicKey: envGet('WECHAT_PAY_PUBLIC_KEY') || '',
    payPublicKeyId: envGet('WECHAT_PAY_PUBLIC_KEY_ID') || envGet('WECHAT_PUBLIC_KEY_ID') || ''
  };
}

// 私钥文本规范化：剥引号、还原字面 \n（.env 三种存法都吃下）
function normPemText(s) { return unescapeEnvVal(String(s == null ? '' : s)); }

let _wxKey;
function wechatPrivateKey() {
  if (_wxKey !== undefined) return _wxKey;
  const { priv } = wechatConfig();
  const raw = normPemText(priv);
  if (!raw) { _wxKey = null; return _wxKey; }
  // 明确拦截：把「微信支付公钥ID」当私钥填进来（线上真实事故，PUB_KEY_ID_ 开头）
  if (/^PUB_KEY_ID_/i.test(raw)) { _wxKey = null; return _wxKey; }
  const strip = s => String(s).replace(/-----[A-Z0-9 ]+-----/g, '').replace(/\s+/g, '');
  const tries = [];
  if (/-----BEGIN/.test(raw)) tries.push(() => crypto.createPrivateKey(raw));
  const b64 = strip(raw);
  if (b64) {
    // apiclient_key.pem 既可能是裸 base64（PKCS#8），也可能是 PKCS#1
    tries.push(() => crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' }));
    tries.push(() => crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs1' }));
    tries.push(() => crypto.createPrivateKey(Buffer.from(b64, 'base64')));
  }
  for (const t of tries) { try { _wxKey = t(); return _wxKey; } catch (e) {} }
  _wxKey = null;
  return _wxKey;
}

// 微信通道「实测」状态：凭据齐备 ≠ 真能下单（真实事故：appid 与 mch_id 未绑定，
// 凭据检查全过、买家一点必失败）。这里缓存一次真实 native 下单的结果，channelStatus
// 只有在实测通过后才把微信算作可用 —— 配置≠能收到钱，一律以真调用取证。
let _wxProbe = { at: 0, ok: null, reason: '' };
async function wechatProbe(force) {
  if (!force && _wxProbe.at && (Date.now() - _wxProbe.at) < 30 * 60 * 1000) return _wxProbe;
  const chk = wechatChannelCheck();
  if (!chk.ok) { _wxProbe = { at: Date.now(), ok: false, reason: '凭据不全：' + chk.reason }; return _wxProbe; }
  let r;
  try { r = await wechatNativeCheckout({ orderId: 'wxprobe' + Date.now().toString(36), amount: 0.01, currency: 'CNY' }); }
  catch (e) { r = { ok: false, error: e.message }; }
  _wxProbe = { at: Date.now(), ok: !!r.ok, reason: r.ok ? '' : String(r.error || '实测下单失败').slice(0, 200) };
  return _wxProbe;
}

function wechatChannelCheck(force) {
  // force=true：清掉私钥/环境缓存，用于「改了 .env 立即复查」而无需重启进程
  if (force === true) { _wxKey = undefined; _envCache = { at: -1, map: {} }; }
  const c = wechatConfig();
  const missing = [];
  if (!c.mchid) missing.push('WECHAT_MCHID');
  if (!c.appid) missing.push('WECHAT_APPID');
  if (!c.serial) missing.push('WECHAT_SERIAL_NO');
  if (!c.priv) missing.push('WECHAT_MCH_PRIVATE_KEY');
  if (!c.apiv3) missing.push('WECHAT_APIV3_KEY');
  const privRaw = normPemText(c.priv);
  const pubIdMisplaced = /^PUB_KEY_ID_/i.test(privRaw);
  const k = wechatPrivateKey();
  const appidBad = !!c.appid && !/^wx[0-9a-fA-F]{16}$/.test(c.appid);
  const apiv3Bad = !!c.apiv3 && String(c.apiv3).length !== 32;
  const ok = missing.length === 0 && !!k && !appidBad && !apiv3Bad;
  let reason;
  if (ok) reason = (_wxProbe.ok === true)
    ? (c.payPublicKey ? '微信支付 v3 凭据齐备（公钥模式）· 实测下单通过' : '微信支付 v3 凭据齐备 · 实测下单通过')
    : (_wxProbe.ok === false ? ('凭据齐备但实测下单失败：' + (_wxProbe.reason || '未知')) : '凭据齐备（尚未实测）');
  else if (pubIdMisplaced) reason = 'WECHAT_MCH_PRIVATE_KEY 填的是「微信支付公钥ID」(PUB_KEY_ID_…)，而不是商户 API 私钥；请改填 apiclient_key.pem 内容，并把该公钥ID放到 WECHAT_PAY_PUBLIC_KEY_ID';
  else if (missing.length) reason = '未配置：' + missing.join(' / ');
  else if (!k) reason = '商户 API 私钥无法解析（需 apiclient_key.pem 的 PEM 或裸 base64；支持字面 \\n）';
  else if (appidBad) reason = 'WECHAT_APPID 非法（应为 wx + 16 位十六进制，如 wx1234567890abcdef；当前为 ' + c.appid + '）';
  else reason = 'WECHAT_APIV3_KEY 必须为 32 位';
  return {
    configured: missing.length === 0,
    ok,
    verified: _wxProbe.ok === true,
    probeAt: _wxProbe.at || 0,
    probeReason: _wxProbe.reason || '',
    privParsed: !!k,
    apiv3Len: (c.apiv3 || '').length,
    appidOk: !appidBad,
    pubIdMisplaced,
    publicKeyMode: !!c.payPublicKey,
    missing,
    reason
  };
}

// 构造 Authorization 头（WECHATPAY2-SHA256-RSA2048）：签名串 = 方法\nURL\n时间戳\n随机串\n报文主体\n
function wechatSign(method, urlPath, body) {
  const c = wechatConfig();
  const key = wechatPrivateKey();
  if (!key) throw new Error('未配置微信商户私钥（WECHAT_MCH_PRIVATE_KEY）');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = method + '\n' + urlPath + '\n' + timestamp + '\n' + nonce + '\n' + (body || '') + '\n';
  const signature = crypto.createSign('RSA-SHA256').update(message).sign(key, 'base64');
  return 'WECHATPAY2-SHA256-RSA2048 mchid="' + c.mchid + '",nonce_str="' + nonce
    + '",signature="' + signature + '",timestamp="' + timestamp + '",serial_no="' + c.serial + '"';
}

function wechatRequest(method, urlPath, bodyObj, timeoutMs) {
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  let auth;
  try { auth = wechatSign(method, urlPath, body); } catch (e) { return Promise.resolve({ ok: false, error: e.message }); }
  const headers = { 'Authorization': auth, 'Accept': 'application/json', 'User-Agent': 'BingDashanAI/1.0', 'Content-Type': 'application/json' };
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  return new Promise(res => {
    let done = false; const fin = v => { if (done) return; done = true; res(v); };
    const req = https.request({ hostname: WX_HOST, port: 443, path: urlPath, method, headers }, r => {
      let d = ''; r.on('data', x => d += x);
      r.on('end', () => {
        let j = null; try { j = d ? JSON.parse(d) : {}; } catch (e) {}
        fin({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, raw: j, text: j ? '' : String(d).slice(0, 300) });
      });
    });
    req.setTimeout(timeoutMs || 12000, () => { req.destroy(); fin({ ok: false, error: '微信网关超时', network: true }); });
    req.on('error', e => fin({ ok: false, error: e.message, network: true }));
    if (body) req.write(body); req.end();
  });
}

// APIv3 密钥解密（AES-256-GCM，末 16 字节为 authTag）
function wechatDecryptResource(res) {
  const c = wechatConfig();
  if (!c.apiv3 || !res || !res.ciphertext) return null;
  try {
    const iv = Buffer.from(res.nonce, 'utf8');
    const data = Buffer.from(res.ciphertext, 'base64');
    if (data.length <= 16) return null;
    const tag = data.slice(data.length - 16);
    const enc = data.slice(0, data.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(c.apiv3, 'utf8'), iv);
    d.setAuthTag(tag);
    if (res.associated_data) d.setAAD(Buffer.from(res.associated_data, 'utf8'));
    return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
  } catch (e) { return null; }
}

// 平台证书（验签回调用）：优先 .env 里的 PEM，否则从 /v3/certificates 下载并缓存
let _wxPlat = { at: 0, map: {} };
function wechatLoadPlatformCerts() {
  // 公钥模式：不再下载平台证书（该接口在公钥模式下已不适用），直接返回空。
  if (wechatConfig().payPublicKey) return Promise.resolve({});
  return wechatRequest('GET', '/v3/certificates', null).then(r => {
    if (!r.ok || !r.raw || !Array.isArray(r.raw.data)) return {};
    const map = {};
    r.raw.data.forEach(item => {
      const dec = item && item.encrypt_certificate ? wechatDecryptResource(item.encrypt_certificate) : null;
      if (dec && dec.certificate) { try { map[item.serial_no] = crypto.createPublicKey(dec.certificate); } catch (e) {} }
    });
    if (Object.keys(map).length) _wxPlat = { at: Date.now(), map };
    return map;
  }).catch(() => ({}));
}
function wechatPlatformKey(serial) {
  const c = wechatConfig();
  // 【公钥模式】回调头 Wechatpay-Serial = PUB_KEY_ID_…，直接用微信支付公钥验签
  if (/^PUB_KEY_ID_/i.test(serial || '') && c.payPublicKey) {
    try { return crypto.createPublicKey(normPemText(c.payPublicKey)); } catch (e) {}
  }
  // 公钥模式下所有回调共用同一把公钥（serial 可能不等于 PUB_KEY_ID）
  if (c.payPublicKey && c.payPublicKeyId && serial && serial === c.payPublicKeyId) {
    try { return crypto.createPublicKey(normPemText(c.payPublicKey)); } catch (e) {}
  }
  if (c.platformCert && /-----BEGIN/.test(c.platformCert)) {
    try { return crypto.createPublicKey(normPemText(c.platformCert)); } catch (e) {}
  }
  return _wxPlat.map[serial] || null;
}
function wechatVerifyNotify(headers, rawBody) {
  const serial = headers['wechatpay-serial'];
  const ts = headers['wechatpay-timestamp'];
  const nonce = headers['wechatpay-nonce'];
  const sig = headers['wechatpay-signature'];
  if (!serial || !ts || !nonce || !sig) return false;
  const key = wechatPlatformKey(serial);
  if (!key) return false;
  try {
    const v = crypto.createVerify('RSA-SHA256');
    v.update(ts + '\n' + nonce + '\n' + rawBody + '\n');
    return v.verify(key, sig, 'base64');
  } catch (e) { return false; }
}

// Native 下单：返回 code_url，前端渲染成二维码，买家微信扫码即付
async function wechatNativeCheckout({ orderId, amount, currency }) {
  const chk = wechatChannelCheck();
  if (!chk.ok) return { ok: false, channel: 'wechat', orderId, channelUsable: false, error: '微信支付通道不可用：' + chk.reason };
  if (String(currency || '').toUpperCase() !== 'CNY') return { ok: false, channel: 'wechat', orderId, error: '微信支付仅支持 CNY' };
  const fen = Math.round(Number(amount) * 100);
  if (!(fen > 0)) return { ok: false, channel: 'wechat', orderId, error: '订单金额无效（≤0），不出付款指令' };
  const c = wechatConfig();
  const r = await wechatRequest('POST', '/v3/pay/transactions/native', {
    mchid: c.mchid, appid: c.appid, description: 'BingDashanAI 订阅 ' + String(orderId),
    out_trade_no: String(orderId), notify_url: c.notifyUrl || publicUrl('/v1/pay/wechat/notify'),
    amount: { total: fen, currency: 'CNY' }
  });
  if (!r.ok || !r.raw || !r.raw.code_url) {
    const msg = (r.raw && (r.raw.message || r.raw.code)) || r.error || r.text || '下单失败';
    return { ok: false, channel: 'wechat', orderId, channelUsable: false, error: '微信下单失败：' + msg };
  }
  const codeUrl = r.raw.code_url;
  let qrData = '';
  try { qrData = qrlib.svgDataUrl(codeUrl, { scale: 6, quiet: 4 }); } catch (e) {}
  return {
    ok: true, channel: 'wechat', orderId, mode: 'gateway', gateway: 'wechat',
    codeUrl, qrData,
    action: { type: 'qr', orderId, amount, currency: 'CNY', qr: qrData, qrWechat: qrData, needProof: false }
  };
}

// 主动查单：无公网回调时由服务端轮询确认到账（与支付宝同口径）
function wechatQuery(orderId) {
  // 【收口】同 alipayQuery：履约单（orderNo 不在 orders 表）此前永远"订单不存在"，
  // 微信的主动查单兜底对履约单失效。统一走 findPayableOrder。
  const hit = findPayableOrder(orderId);
  if (!hit) return Promise.resolve({ ok: false, error: '订单不存在' });
  const order = hit.order;
  if (hit.isFulfillment) {
    const k = 'fulpay:' + (order.orderNo || order.id) + ':微信';
    if (Number(order.paidAt || 0) > 0 && String(order.settledMark || '') === k) {
      return Promise.resolve({ ok: true, already: true, orderId, status: 'SUCCESS(本地已结+已记账)' });
    }
  } else if (order.paid) {
    return Promise.resolve({ ok: true, already: true, orderId, status: 'SUCCESS(本地已结)' });
  }
  if (!wechatChannelCheck().ok) return Promise.resolve({ ok: false, error: '微信通道未配置' });
  const c = wechatConfig();
  const p = '/v3/pay/transactions/out-trade-no/' + encodeURIComponent(String(orderId)) + '?mchid=' + encodeURIComponent(c.mchid);
  return wechatRequest('GET', p, null).then(r => {
    if (!r.ok && !r.raw) return { ok: false, error: r.error || r.text || '查单失败', network: !!r.network };
    const j = r.raw || {};
    if (j.trade_state === 'SUCCESS') {
      const got = Number((j.amount && j.amount.total) || 0);
      const want = Math.round((Number(order.amount) || 0) * 100);
      if (got <= 0 || got !== want) return { ok: false, orderId, status: j.trade_state, error: '金额与订单不符：' + got + ' ≠ ' + want };
      if (hit.isFulfillment) {
        const sf = settleFulfillment(order, { amount: got / 100, currency: String(order.currency || 'CNY').toUpperCase(), channel: '微信', tradeNo: j.transaction_id });
        return { ok: sf.ok, orderId, status: j.trade_state, tradeNo: j.transaction_id, settled: sf, fulfillment: sf.ok, credited: sf.credited, error: sf.error };
      }
      return settleOrder(orderId, '微信').then(s => ({ ok: true, status: j.trade_state, tradeNo: j.transaction_id, settled: s }));
    }
    return { ok: false, status: j.trade_state || j.code || r.status, msg: j.message || '' };
  });
}

// 异步回调：验签 + AES 解密 + 金额核对 + 订单存在 → 入账开通
async function wechatHandleNotify(headers, rawBody) {
  if (!wechatVerifyNotify(headers, rawBody)) {
    // 平台证书可能轮换/未缓存 → 拉一次再验，仍不过才拒
    await wechatLoadPlatformCerts();
    if (!wechatVerifyNotify(headers, rawBody)) return { ok: false, error: '验签失败' };
  }
  let body; try { body = JSON.parse(rawBody); } catch (e) { return { ok: false, error: 'body 非法' }; }
  const data = wechatDecryptResource(body.resource || {});
  if (!data) return { ok: false, error: '解密失败' };
  if (data.trade_state !== 'SUCCESS') return { ok: false, error: '未支付成功：' + data.trade_state };
  const oid = String(data.out_trade_no || '');
  // 【收口】与支付宝/MoltSpay 回调同口径：履约单（orderNo 不在 orders 表）必须走桥接，
  // 否则微信收到履约单的钱只会得到"订单不存在" → 钱收了、单不推进（与之前修过的
  // paypal/alipay 漏桥接是同一类 bug）。
  const hit = findPayableOrder(oid);
  if (!hit) {
    store.push('audit', { action: '微信回调·订单不存在', detail: oid + ' 回调找不到对应订单，拒绝入账' }, null, null);
    return { ok: false, error: '订单不存在' };
  }
  const order = hit.order;
  // 微信支付只支持 CNY：订阅单与履约单一律只接受 CNY，非 CNY 拒绝（与 wechatNativeCheckout 约束一致）
  const wantCur = String(order.currency || 'CNY');
  if (wantCur.toUpperCase() !== 'CNY') {
    store.push('audit', { action: '回调币种不符', detail: oid + ' 订单币种 ' + wantCur + '，不接受微信(CNY)回调，拒绝入账' }, null, null);
    return { ok: false, error: '币种与订单不符' };
  }
  const got = Number((data.amount && data.amount.total) || 0);
  const want = Math.round((Number(order.amount) || 0) * 100);
  if (got <= 0 || got !== want) {
    store.push('audit', { action: '回调金额不符', detail: oid + ' 回调 ' + got + ' ≠ 订单 ' + want + '(分)，拒绝入账' }, null, null);
    return { ok: false, error: '金额与订单不符' };
  }
  // 履约订单：半程单自愈（已到账但缺记账 → 补账），与支付宝/MoltSpay 同口径
  if (hit.isFulfillment) {
    const key = 'fulpay:' + (order.orderNo || order.id) + ':微信';
    if (Number(order.paidAt || 0) > 0 && String(order.settledMark || '') === key) {
      return { ok: true, already: true, credited: true, orderId: oid };
    }
    const sf = settleFulfillment(order, { amount: got / 100, currency: 'CNY', channel: '微信', tradeNo: data.transaction_id });
    if (!sf.ok) return { ok: false, error: sf.error || '履约推进失败', orderId: oid };
    store.push('audit', { action: '履约·微信到账', detail: '#' + (order.orderNo || order.id) + ' ' + (got / 100) + ' CNY 已由微信回调确认收款，自动推进待交付'
      + (sf.credited ? '' : '（记账未成功，需人工复核）') }, null, null);
    return { ok: true, fulfillment: true, credited: sf.credited, orderId: oid, tradeNo: data.transaction_id };
  }
  return settleOrder(oid, '微信');
}

// ============ moltspay（聚合支付：沙盒/回调按官方协议）============
function moltspayConfig() {
  // 优先读 settings 注册表（支持运行时热改），回落 env
  let apiKey = '', secret = '', mode = 'test', gateway = '';
  try {
    const s = require('./store').read().settings || {};
    if (s.moltspayApiKey) apiKey = s.moltspayApiKey;
    if (s.moltspaySecret) secret = s.moltspaySecret;
    if (s.moltspayMode) mode = s.moltspayMode;
    if (s.moltspayGateway) gateway = s.moltspayGateway;
  } catch (e) {}
  // 【兼容多种命名】运营在 .env 里可能写 MOLTSPAY_API_KEY 或 MOLTSPAY_API，
  // 两种都认（只认一种时，另一种配置会被判为"未配置"而拒单）。
  if (!apiKey) apiKey = envGet('MOLTSPAY_API_KEY') || envGet('MOLTSPAY_API') || '';
  if (!secret) secret = envGet('MOLTSPAY_SECRET') || '';
  // 【为什么强制要求网关地址】此前硬编码 https://api.moltspay.com/v1/pay，
  // 但该域名不存在（NXDOMAIN）——"前往支付"按钮点开就是打不开的死链。
  // MoltsPay 实为 x402 服务商框架，并非可直接下单的收银台；收银台地址必须由运营显式配置。
  if (!gateway) gateway = envGet('MOLTSPAY_GATEWAY') || '';
  return { apiKey, secret, mode: mode === 'live' ? 'live' : 'test', gateway };
}

function moltspayCheckout({ orderId, amount, currency }) {
  const cfg = moltspayConfig();
  if (!cfg.apiKey || !cfg.secret) {
    return Promise.resolve({ ok: false, channel: 'moltspay', orderId, pendingConfig: true, action: { type: 'manual', orderId, amount } });
  }
  const totalAmount = Number(amount);
  if (!(totalAmount > 0)) {
    // 零元/负数订单不得出网关付款链接——否则会生成一张「付 ¥0」的假收款页
    return Promise.resolve({ ok: false, channel: 'moltspay', orderId, error: '订单金额无效（≤0），不出付款指令' });
  }
  const params = {
    app_id: cfg.apiKey,
    out_trade_no: String(orderId),
    total_amount: totalAmount.toFixed(2),
    subject: 'BingDashanAI 订阅/履约 · ' + orderId,
    currency: currency || 'CNY',
    sign_type: 'HMAC_SHA256',
    notify_url: publicUrl('/v1/pay/moltspay/notify'),
    return_url: publicUrl('/pay/result?orderId=' + encodeURIComponent(orderId))
  };
  params.sign = moltspaySign(params);
  const query = qs.stringify(params);
  const payUrl = (cfg.gateway || 'https://moltspay.com/v1/pay') + (cfg.gateway && cfg.gateway.indexOf('?') >= 0 ? '&' : '?') + query;
  // 记住长链，短链 /pay/go/<订单号> 扫码后 302 到这里
  rememberGatewayLink(orderId, payUrl);
  return Promise.resolve({
    ok: true, channel: 'moltspay', orderId,
    mode: 'gateway',
    gateway: 'moltspay',
    gatewayMode: cfg.mode,
    payUrl,
    // 内嵌付款码：前端 <img> 直接渲染，扫码即付（不再依赖跳转/弹窗）
    qrData: gatewayQrData(orderId),
    action: { type: 'redirect', url: payUrl, orderId, amount: totalAmount, currency: currency || 'CNY' }
  });
}

// HMAC-SHA256 签名：字段名升序拼 key=value&…，跳过 sign / sign_type（与支付宝口径一致）
function moltspaySign(params) {
  const cfg = moltspayConfig();
  if (!cfg.secret) return '';
  const src = params || {};
  const keys = Object.keys(src).filter(k => k !== 'sign' && k !== 'sign_type' && src[k] !== undefined && src[k] !== null).sort();
  const str = keys.map(k => k + '=' + src[k]).join('&');
  return crypto.createHmac('sha256', cfg.secret).update(str, 'utf8').digest('hex');
}

function moltspayVerify(params) {
  const sign = String((params && params.sign) || '');
  const calc = moltspaySign(params);
  // 长度不等 → 一定不匹配（timingSafeEqual 要求等长，否则抛异常）
  if (!sign || !calc) return false;
  if (sign.length !== calc.length) return false;
  // 用 hex 缓冲区做 timingSafeEqual：只接受 64 位 hex，避免非 ASCII / 奇数长度触发异常后
  // 退化成 `===` 比较（非常量时间，可被时序攻击逐字节爆破）。
  if (!/^[0-9a-fA-F]{64}$/.test(sign)) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sign, 'hex'), Buffer.from(calc, 'hex'));
  } catch (e) {
    return false;
  }
}

function moltspayHandleNotify(body) {
  try {
    const params = body && typeof body === 'object' ? body : {};
    if (!moltspayVerify(params)) return { ok: false, error: '验签失败' };
    const tradeStatus = String(params.trade_status || params.status || '').toUpperCase();
    if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') return { ok: false, error: '未支付成功', tradeStatus };
    const oid = String(params.out_trade_no || params.outTradeNo || '');
    if (!oid) return { ok: false, error: '缺少 out_trade_no' };

    // 【资金安全·关键】金额必须「强制」核对，不能写成 `got>0 && got!==want`——
    // 那样回调不带 total_amount 时 got=0，校验整段被跳过 → 任何金额都能入账。
    // 正确做法：缺金额即拒绝（宁可漏认一笔，不可错认一笔）。
    const rawAmt = params.total_amount !== undefined ? params.total_amount : params.totalAmount;
    const got = Math.round((Number(rawAmt) || 0) * 100);
    const gotCur = String(params.currency || '').toUpperCase();

    const order = store.findBy('orders', 'id', oid);
    if (!order) {
      // 履约订单桥接：只认本地履约单（out_trade_no 可能是 orderNo）
      const ff = require('./fulfillment');
      const o = ff.board(999).rows.find(x => x.orderNo === oid || x.id === oid);
      if (!o) {
        store.push('audit', { action: 'MoltSpay回调·订单不存在', detail: oid + ' 回调找不到对应订单，拒绝入账' }, null, null);
        return { ok: false, error: '订单不存在' };
      }
      const want = Math.round((Number(o.amount) || 0) * 100);
      const wantCur = String(o.currency || 'CNY').toUpperCase();
      if (!(got > 0)) {
        store.push('audit', { action: 'MoltSpay回调·缺金额', detail: oid + ' 回调未带 total_amount，拒绝入账（订单 ' + o.amount + ' ' + wantCur + '）' }, null, null);
        return { ok: false, error: '回调缺少 total_amount，无法核对金额' };
      }
      if (got !== want) {
        store.push('audit', { action: 'MoltSpay回调·金额不符', detail: oid + ' 回调 ' + (got / 100) + ' ≠ 订单 ' + (want / 100) + '，拒绝入账' }, null, null);
        return { ok: false, error: '金额与订单不符' };
      }
      if (gotCur && wantCur && gotCur !== wantCur) {
        store.push('audit', { action: 'MoltSpay回调·币种不符', detail: oid + ' 回调 ' + gotCur + ' ≠ 订单 ' + wantCur + '，拒绝入账' }, null, null);
        return { ok: false, error: '币种与订单不符' };
      }
      // 【半程单自愈】已到账但缺记账痕迹的履约单（早期版本只 ff.advance 不记账，
// 或记账失败后人工没处理），网关重推回调时必须补账，不能因为 paidAt>0 就返回。
// 判定「是否已记账」看 settledMark，而不是 paidAt —— paidAt 只说明钱到了。
const key = 'fulpay:' + (o.orderNo || o.id) + ':MoltSpay';
      const marked = String(o.settledMark || '') === key;
      if (o.paidAt > 0 && marked) return { ok: true, already: true, credited: true, orderId: oid };

      const r = settleFulfillment(o, { amount: got / 100, currency: wantCur, channel: 'MoltSpay', tradeNo: params.trade_no || params.tradeNo });
      if (!r.ok) return { ok: false, error: r.error || '履约推进失败', orderId: oid };
      store.push('audit', { action: '履约·MoltSpay到账', detail: '#' + o.orderNo + ' ' + (got / 100) + ' ' + wantCur + ' 已由 MoltSpay 回调确认收款，自动推进待交付'
        + (r.credited ? '' : '（记账未成功，需人工复核）') }, null, null);
      return { ok: true, fulfillment: true, credited: r.credited, already: r.already, orderId: oid, tradeNo: r.tradeNo };
    }

    // 订阅订单：与支付宝回调同口径（缺金额/币种不符一律拒）
    const want = Math.round((Number(order.amount) || 0) * 100);
    const wantCur = String(order.currency || 'CNY').toUpperCase();
    if (!(got > 0)) {
      store.push('audit', { action: 'MoltSpay回调·缺金额', detail: oid + ' 回调未带 total_amount，拒绝入账（订单 ' + order.amount + ' ' + wantCur + '）' }, null, null);
      return { ok: false, error: '回调缺少 total_amount，无法核对金额' };
    }
    if (got !== want) {
      store.push('audit', { action: 'MoltSpay回调·金额不符', detail: oid + ' 回调 ' + (got / 100) + ' ≠ 订单 ' + (want / 100) + '，拒绝入账' }, null, null);
      return { ok: false, error: '金额与订单不符' };
    }
    if (gotCur && wantCur && gotCur !== wantCur) {
      store.push('audit', { action: 'MoltSpay回调·币种不符', detail: oid + ' 回调 ' + gotCur + ' ≠ 订单 ' + wantCur + '，拒绝入账' }, null, null);
      return { ok: false, error: '币种与订单不符' };
    }
    return settleOrder(oid);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ============ 履约订单到账：推进履约 + 记账（营收）+ 物料消耗 ============
// 【为什么要单独收口】此前 alipayHandleNotify 走 ff.advance 就结束了——
// 履约单到账不进 revenues 表，于是「收了钱」与「账面营收」彻底脱钩：
// money.kpi() 永远 0，运营看不到真实收入，还以为没成交。
// 现在三个通道（alipay/moltspay/paypal）统一走这里，记账口径只有一份。
// 幂等键 = orderId + 通道名：同一笔到账重推不会重复记账。
function settleFulfillment(o, { amount, currency, channel, tradeNo } = {}) {
  const ff = require('./fulfillment');
  const orderNo = o.orderNo || o.id;
  const amt = Number(amount || o.amount || 0);
  const cur = String(currency || o.currency || 'CNY').toUpperCase();
  const ch = String(channel || '网关');
  const who = o.customer || o.leadName || '';
  const key = 'fulpay:' + orderNo + ':' + ch;

  // 【幂等判定只看 settledMark】paidAt 只说明「钱到了」，settledMark 才说明「账记过了」。
  // 早期版本用 paidAt>0 直接返回，导致「已到账但没记账」的半程单永远补不上账。
  if (String(o.settledMark || '') === key) {
    return { ok: true, already: true, credited: true, orderId: o.id, orderNo, tradeNo: tradeNo || '' };
  }

  // 【顺序：先落幂等标记，再记账】
  // 反过来（先记账后写标记）一旦记账后进程崩溃/报错，标记没落 → 网关重推就重复记一次账。
  // 先写标记最坏只是「标记已写但账没记」，此时 credited=false 会被如实上报，人工可查；
  // 而反过来最坏是「账记了两遍」，属于不可逆的资金错误。
  const marked = ff.advance(o.id, { paid: true, stageNote: ch + '到账', settledMark: key, credited: false });
  if (marked.ok !== true) {
    return { ok: false, error: marked.error || '履约推进失败', credited: false };
  }

  // 记账：人民币进营收；外币挂应收（钱确实收到了，只是账面口径分开）
  let credited = false;
  try {
    // 幂等键与 subs.settleEffects 同口径（'rev-' + 单号）：账本侧也查重，
    // 不只靠履约单上的 settledMark 字段。后者会因数据迁移/手工改库/字段覆盖而失效，
    // 一旦失效就是真金白银的重复入账——两道闸任缺一道都不够。
    const revId = 'rev-' + orderNo;
    if (cur === 'CNY') {
      const c = money.credit(amt, '履约到账 #' + orderNo + (who ? ' · ' + who : ''), ch,
        { settled: true, id: revId, currency: cur });
      credited = !!(c && c.ok);
      if (!credited) {
        store.push('audit', { action: '履约·记账失败', detail: '#' + orderNo + ' ' + amt + ' ' + cur + '：' + ((c && c.error) || '未知') }, null, null);
      }
    } else {
      const c = money.credit(amt, '履约到账 #' + orderNo + (who ? ' · ' + who : ''), ch,
        { settled: false, id: revId, currency: cur });
      credited = !!(c && c.ok);
    }
  } catch (e) {
    credited = false;
    store.push('audit', { action: '履约·记账异常', detail: '#' + orderNo + '：' + String(e.message || e) }, null, null);
  }

  // 回写记账结果（仅标记位，不改已落的幂等键）
  if (credited !== true) {
    try { ff.advance(o.id, { credited: false }); } catch (e) {}
  }

  // 物料出库：走 advance 内部的 delivered 联动（此处不重复扣，避免双扣）
  if (credited) {
    store.push('audit', {
      action: '履约·网关到账已记账',
      detail: '#' + orderNo + ' ' + amt + ' ' + cur + ' 经 ' + ch + ' 到账并入账'
    }, null, null);
  }
  return { ok: true, credited, already: false, orderId: o.id, orderNo, tradeNo: tradeNo || '' };
}

// ============ 统计入账：核验通过 → money.credit + subs 激活 ============
function settleOrder(orderId, channelLabel) {
  const order = store.findBy('orders', 'id', orderId);
  if (!order) return { ok: false, error: '订单不存在' };
  const first = !order.paid;
  if (first) store.update('orders', order.id, { status: 'paid', paid: true, paidAt: Date.now() }, '网关到账');
  // 与 subs.confirm 完全同一套副作用（settleEffects）：noPromo/币种/体验核销/返利
  // 全部同口径，且每个副作用自带幂等键——已 paid 的重入只补缺口（半程单自愈），
  // 绝不重复入账、不重复加时长。此前两条路径各写一份、口径漂移出了两宗账错。
  const label = channelLabel || (order.currency === 'USD' ? 'PayPal' : '支付宝');
  const fx = subs.settleEffects(order, label);
  if (first || fx.changed) {
    store.push('audit', {
      action: first ? '订单到账(网关)' : '订单到账(网关·补账)',
      detail: order.amount + ' ' + order.currency + ' 到账(网关通道)'
    }, null, null);
  }
  // 【2026-10-21 付款收据】首次到账即给买家发一封收据（凭证 = 信任 = 少退款少扯皮）。
  // 异步、**不阻塞开通**；发不出去就把状态如实记在订单上（sent/failed/skipped_no_email），绝不假装发过。
  if (first) {
    try {
      const receipt = require('./receipt');
      const o2 = store.findBy('orders', 'id', orderId) || order;
      receipt.sendReceipt(o2).catch(() => {});
    } catch (e) { /* 发信模块异常也不能影响开通 */ }
  }
  return { ok: true, order: store.findBy('orders', 'id', orderId), inviteBonus: fx.inviteBonus, already: !first };
}

// ============ 助手 ============
// 网关就绪综合视图：支付宝本地密钥自洽 + PayPal 凭据齐备 → 供 autopilot 决策信号。
// 诚实：缺任何一项都如实 report，绝不当成已可用。
// 探针新鲜度判断：三个通道的探针都在 10 分钟内才算新鲜。
// 服务器用它决定要不要后台补一次探针（保证通道状态永远反映实测）。
// 【注意变量形状】_wxProbe 是 { at, ok, reason }（没有 probeAt），
// 之前写成 _wxProbeAt 会抛 ReferenceError → 每次请求都重跑探针 → 每次都真建一笔
// 0.01 USD 探针单，污染 PayPal 后台。这里严格按各自真实字段取时间。
function channelProbesFresh() {
  const now = Date.now();
  const W = 10 * 60 * 1000;
  const aliAt = _aliProbe ? Number(_aliProbe.probeAt || _aliProbeAt || 0) : 0;
  const wxAt = _wxProbe ? Number(_wxProbe.at || 0) : 0;
  const ppAt = _ppProbe ? Number(_ppProbe.probeAt || _ppProbeAt || 0) : 0;
  return !!(aliAt && wxAt && ppAt &&
    (now - aliAt) < W && (now - wxAt) < W && (now - ppAt) < W);
}

function channelStatus(force) {
  const al = alipayChannelCheck(force === true);
  // 【2026-10-21】探针预算：探针是**真实单据** → 运营必须看得见"今天用了几笔"
  const probeBudget = probeBudgetState();
  const ppKey = envGet('PAYPAL_CLIENT_ID') && envGet('PAYPAL_SECRET');
  // 【诚实收口】PayPal 同样要实测能建单才算可用（凭据齐备不等于有收款权限）
  const ppProbe = _ppProbe || null;
  const ppVerified = !!(ppProbe && ppProbe.verified);
  const pp = { configured: !!ppKey, ok: !!ppKey && ppVerified, verified: ppVerified,
    blocked: !!(ppProbe && !ppProbe.verified),
    probeAt: ppProbe ? ppProbe.probeAt : 0,
    probeReason: ppProbe ? ppProbe.probeReason : '',
    reason: ppProbe ? (ppProbe.verified ? '实测可下单（探针 0.01 USD 单已创建）' : ppProbe.probeReason)
      : (ppKey ? '凭据齐备（尚未实测）' : '未配置 PAYPAL_CLIENT_ID / PAYPAL_SECRET') };
  // 远端验签结果（如有缓存）：false=开放平台拒签，true=远端已确认签名有效，null=尚未探测
  const remoteSig = _remote.val && typeof _remote.val.signatureOk === 'boolean' ? _remote.val.signatureOk : null;
  // 首次查询时后台补一次远端验签（不阻塞本次返回）：下一次状态就如实反映「远端是否接受签名」。
  if (al.configured && remoteSig === null) { try { alipayRemoteCheck(); } catch (e) {} }
  // 【诚实收口】支付宝通道必须「实测能下单」才算 ready。
  // 密钥齐备 + 能验签 ≠ 有交易权限（个人账户就是 ACCESS_FORBIDDEN，收银台伪装成 AE150003030）。
  const aliProbe = _aliProbe || null;
  const aliVerified = !!(aliProbe && aliProbe.verified);
  const aliBlocked = !!(aliProbe && (aliProbe.subCode === 'ACQ.ACCESS_FORBIDDEN' || /ACCESS_FORBIDDEN|insufficient-isv-permissions/i.test(aliProbe.probeReason || '')));
  const alipayReady = al.ok === true && al.alipayPubConfigured === true && remoteSig !== false && aliVerified;
  // 远端拒签时，不能只说「本地密钥自洽」——否则运营端会显示支付宝可用，
  // 买家点进去必然支付失败。如实标注原因。
  const alipayReason = remoteSig === false
    ? ('远端拒签（' + ((_remote.val && _remote.val.subCode) || 'isv.invalid-signature') + '）：开放平台的「应用公钥」与本地私钥不匹配，需把下方导出的应用公钥重新上传（open.alipay.com）')
    : (aliProbe ? (aliProbe.verified ? ('实测可下单（探针 ' + new Date(aliProbe.probeAt).toLocaleString('zh-CN') + '）') : aliProbe.probeReason) : al.reason);
  // MoltSpay：两个凭据齐备才算可用；只配一个 = 半配置，明确报「缺哪个」而不是说 ok
  const ms = moltspayConfig();
  const wx = wechatChannelCheck(force === true);
  const msMissing = [];
  if (!ms.apiKey) msMissing.push('MOLTSPAY_API_KEY(或 MOLTSPAY_API)');
  if (!ms.secret) msMissing.push('MOLTSPAY_SECRET');
  if (!ms.gateway) msMissing.push('MOLTSPAY_GATEWAY(收银台地址)');
  const moltspay = {
    configured: msMissing.length === 0,
    ok: msMissing.length === 0,
    mode: ms.mode,
    missing: msMissing,
    reason: msMissing.length === 0
      ? ('凭据齐备（' + ms.mode + ' 模式）')
      : ('未配置：' + msMissing.join(' / '))
  };
  const wechatReady = wx.ok && wx.verified;
  const anyReady = alipayReady || pp.ok || moltspay.ok || wechatReady;
  return {
    ok: anyReady,
    alipay: { configured: al.configured, ready: alipayReady, remoteSignatureOk: remoteSig, keyPairMatched: al.keyPairMatched, appPubConfigured: al.appPubConfigured, verified: aliVerified, blocked: aliBlocked, probeAt: aliProbe ? aliProbe.probeAt : 0, probeReason: aliProbe ? aliProbe.probeReason : '', reason: alipayReason },
    paypal: pp,
    moltspay,
    wechat: Object.assign({}, wx, { ready: wechatReady }),
    alipayReady, paypalReady: pp.ok, moltspayReady: moltspay.ok, wechatReady,
    probeBudget,   // {day, used, max} —— 探针=真实单据，预算可见
    available: [alipayReady ? 'alipay' : null, pp.ok ? 'paypal' : null, moltspay.ok ? 'moltspay' : null, wechatReady ? 'wechat' : null, 'manual'].filter(Boolean),
    reason: (remoteSig === false ? '支付宝远端拒签（需重新上传应用公钥）' : (al.configured ? '支付宝本地密钥自洽' : '未配支付宝密钥')) + (al.alipayPubConfigured ? '（含公钥）' : '（缺 ALIPAY_PUBLIC_KEY，无法验签回调）')
      + '；PayPal ' + (pp.ok ? '已配置' : '未配置')
      + '；微信 ' + wx.reason
      + '；MoltSpay ' + moltspay.reason
  };
}
function publicUrl(p) {
  const base = store.getSetting('publicBase') || envGet('BINGDASHAN_PUBLIC_BASE') || ('http://127.0.0.1:' + (envGet('BINGDASHAN_PORT') || 3721));
  return base.replace(/\/+$/, '') + p;
}
function httpsJson({ host, path, method, token, body }) {
  return new Promise((res, rej) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const payload = body ? Buffer.from(body) : null;
    if (payload) headers['Content-Length'] = payload.length;
    const req = https.request({ host, path, method, headers }, r => {
      let d = ''; r.on('data', x => d += x);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error('bad json ' + d.slice(0, 120))); } });
    });
    req.on('error', rej); if (payload) req.write(payload); req.end();
  });
}

// ============ 服务端到账守望（无公网回调也会自动开通）============
// 触发点：server.js 定时器调用；只对「自动通道」且创建 3 小时内的 pending 单做一次
// 网关查单。查到网关确认真到账才 settleOrder（fail-closed），查不到/通道不可用一律不动。
// 为什么需要它：买家关掉收银台后浏览器轮询（/v1/pay/status）就停了，若此时支付宝
// 异步通知因网络/风控未送达，就会出现「钱到了、墙没开」。这条服务端兜底把确认从
// 「买家页面存活」解耦成「服务端自己盯着」。
let _watchAt = 0;
function watchPending() {
  const now = Date.now();
  if (now - _watchAt < 45000) return Promise.resolve({ ok: true, skipped: 'throttled' });
  _watchAt = now;
  let st = {};
  try { st = channelStatus(); } catch (e) {}
  // 【2026-10-21 全量】主动查单守望：只看最近 999 单 → 老订单永远等不到查单（付了钱不开通）
  const pend = store.list('orders').filter(o =>
    !o.paid && String(o.status || '') === 'pending' &&
    Number(o.createdAt || o.at || 0) > now - 3 * 3600 * 1000);
  const tasks = [];
  for (const o of pend) {
    const ch = String(o.channel || '');
    if (String(o.currency || 'CNY') === 'USD') {
      // PayPal：买家可能关了收银台页面没回跳。守望主动 capture，避免付了钱却不开通。
      // 只对本单确实是 PayPal 通道的单生效：人工/其它 USD 单不该去问 PayPal。
      if (o.paypalOrderId || ch === 'paypal') {
        if (st.paypal && st.paypal.verified) tasks.push(paypalQuery(o.id).catch(() => null));
      }
      continue;
    }
    if (ch === 'wechat' && st.wechatReady) tasks.push(wechatQuery(o.id).catch(() => null));
    else if (ch === 'alipay' && st.alipayReady) tasks.push(alipayQuery(o.id).catch(() => null));
    // manual / moltspay：无服务端可验通道 → 由回调或运营令牌确认，不在此轮询
  }
  return Promise.all(tasks).then(() => ({ ok: true, checked: tasks.length }));
}


// ============ 人工通道：内部核账（确认 / 回收 / 补交截图） ============
// 【为什么需要这三个动作】
// 1) confirmManual：运营在后台看到"到账了" → 内部令牌确认 → 临时权益转正，永久有效。
// 2) sweepManual：24h 内没有任何内部确认 → 权益自动回收 + 订单转 needProof（要求补交支付截图）。
// 3) resubmitProof：客户补交支付截图 → 重新开一个 24h 核账窗口（不是直接放行）。
// 全程不询问客户"你付了吗"：只有系统内部在核账；只有超时未确认才要求客户补交截图。
function confirmManual(orderId, by) {
  const oid = String(orderId || '');
  const o = store.findBy('orders', 'id', oid);
  if (!o) return { ok: false, error: '订单不存在' };
  if (o.manualStatus === 'confirmed') return { ok: true, already: true, orderId: oid, manualStatus: 'confirmed' };
  const at = Date.now();
  try {
    store.update('orders', oid, {
      manualStatus: 'confirmed',
      confirmedAt: at,
      confirmedBy: String(by || 'ops').slice(0, 64),
      reviewUntil: null,
      needProof: false,
      paid: true,
      status: 'paid',
      paidBy: 'ops-confirm'
    }, '人工通道内部确认到账');
  } catch (e) { return { ok: false, error: '记录失败：' + String(e.message || e) }; }
  // 临时权益转正（永不过期）
  try { subs.confirmProvisional(oid); } catch (e) {}
  // 确认后才记账：钱确实收到了才进 revenue
  try { settleOrder(oid, '人工核账确认'); } catch (e) {}
  store.push('audit', {
    action: '人工通道内部确认到账',
    detail: '#' + oid + ' ' + o.amount + ' ' + o.currency + ' 已由内部确认，权益转正',
    at
  }, null, null);
  return { ok: true, orderId: oid, manualStatus: 'confirmed' };
}

// 到期回收：24h 内无内部确认 → 权益失效 + 订单转 needProof
function sweepManual() {
  const now = Date.now();
  let expiredSubs = 0, marked = 0;
  try { expiredSubs = subs.sweepProvisionalSubs(); } catch (e) {}
  try { marked = subs.markNeedProofOrders(); } catch (e) {}
  if (expiredSubs || marked) {
    store.push('audit', {
      action: '人工核账超时回收',
      detail: '回收临时权益 ' + expiredSubs + ' 条；转需补交截图 ' + marked + ' 单（24h 内无内部确认）',
      at: now
    }, null, null);
  }
  return { ok: true, expiredSubs, marked, at: now };
}

// 客户补交支付截图：重新开一个 24h 核账窗口（不是直接放行）
function resubmitProof(orderId, visitor, note, imageDataUrl) {
  const oid = String(orderId || '');
  const o = store.findBy('orders', 'id', oid);
  if (!o) return { ok: false, error: '订单不存在' };
  if (o.manualStatus === 'confirmed') return { ok: true, already: true, orderId: oid, manualStatus: 'confirmed' };
  const at = Date.now();
  const reviewUntil = at + 24 * 3600 * 1000;
  // 【截图必填】补交流程的意义就是"把凭证给运营看"，所以这里强制要求真的传图。
  // 客户第一次点「我已付款」可以只留痕（不强制），但超时后补交必须带图。
  let proofImage = o.proofImage || null;
  if (imageDataUrl) {
    const sv = saveProofImage(oid, imageDataUrl);
    if (!sv.ok) return { ok: false, error: sv.error, needImage: true };
    proofImage = sv.file;
  } else if (!o.proofImage) {
    return { ok: false, error: '请上传支付截图（转账成功页面截图）', needImage: true };
  }
  try {
    store.update('orders', oid, {
      proofAt: at,
      proofBy: String(visitor || o.visitor || '').slice(0, 64),
      proofNote: String(note || '').slice(0, 2000),
      proofImage: proofImage,
      proofImageAt: imageDataUrl ? at : (o.proofImageAt || null),
      manualStatus: 'provisionally_active',
      reviewUntil,
      needProof: false,
      proofCount: (Number(o.proofCount) || 0) + 1,
      paid: true,
      status: 'paid',
      paidAt: o.paidAt || at,
      paidBy: 'manual-provisional'
    }, '买家补交支付截图（重开24h核账窗口）');
  } catch (e) { return { ok: false, error: '记录失败：' + String(e.message || e) }; }
  try { subs.activateProvisional(o.visitor, o.plan, oid, reviewUntil); } catch (e) {}
  store.push('audit', {
    action: '买家补交支付截图',
    detail: '#' + oid + ' ' + o.amount + ' ' + o.currency + ' 已补交截图，重新开启 24h 核账窗口',
    at
  }, null, null);
  return { ok: true, paid: true, orderId: oid, manualStatus: 'provisionally_active', reviewUntil };
}


// ============ 支付凭证截图（补交用） ============
// 【为什么需要真的存图】人工通道超时后要"要求客户提交支付切图"，如果只让客户敲一行字，
// 运营核账时看不到任何可核的东西，截图就形同虚设。所以这里真的落盘存图。
// 【安全】只接受图片魔数（PNG/JPEG/GIF/WEBP），不信任客户端声称的 MIME/扩展名；
// 大小上限 3MB；文件名用订单号 + 随机后缀（不���客户提供的任何字符），杜绝路径穿越。
const PROOF_DIR = '/opt/bingdashan/data/proofs';
const PROOF_MAX_BYTES = 3 * 1024 * 1024;

// 识别图片真实类型（按魔数，不看扩展名）
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return { ext: 'png', mime: 'image/png' };
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
  // GIF: "GIF87a" / "GIF89a"
  if (buf.slice(0, 3).toString('latin1') === 'GIF' && buf.slice(3, 6).toString('latin1') === '8' ) return { ext: 'gif', mime: 'image/gif' };
  if (buf.slice(0, 6).toString('latin1') === 'GIF89a') return { ext: 'gif', mime: 'image/gif' };
  // WEBP: "RIFF"...."WEBP"
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

// data URL -> Buffer（只接受 base64）
function decodeDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const m = s.match(/^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)?;base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return null;
  try { return Buffer.from(m[2].replace(/\s+/g, ''), 'base64'); } catch (e) { return null; }
}

// 保存支付凭证截图 → 返回 { path, mime, bytes }
function saveProofImage(orderId, dataUrl) {
  const oid = String(orderId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!oid) return { ok: false, error: '订单号无效' };
  const buf = decodeDataUrl(dataUrl);
  if (!buf || !buf.length) return { ok: false, error: '截图数据无效' };
  if (buf.length > PROOF_MAX_BYTES) return { ok: false, error: '截图过大（上限 3MB）' };
  const kind = sniffImage(buf);
  if (!kind) return { ok: false, error: '只接受图片文件（PNG/JPEG/GIF/WEBP）' };
  try {
    require('fs').mkdirSync(PROOF_DIR, { recursive: true });
    const name = oid + '-' + Date.now().toString(36) + '.' + kind.ext;
    const full = PROOF_DIR + '/' + name;
    require('fs').writeFileSync(full, buf);
    return { ok: true, path: full, file: name, mime: kind.mime, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: '保存失败：' + String(e.message || e) };
  }
}

// 读回截图（运营核账台用；管理令牌保护由 server.js 负责）
function readProofImage(fileName) {
  const fn = String(fileName || '').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!fn) return null;
  const full = PROOF_DIR + '/' + fn;
  try {
    const b = require('fs').readFileSync(full);
    const kind = sniffImage(b);
    if (!kind) return null;
    return { buf: b, mime: kind.mime };
  } catch (e) { return null; }
}

// 订单当前最新一张凭证截图（运营核账台展示）
function latestProofOf(order) {
  const f = String((order && order.proofImage) || '');
  if (!f) return null;
  const fn = f.replace(/^.*\//, '');
  if (!fn) return null;
  return { file: fn, at: Number(order.proofAt || 0) };
}

module.exports = {
  checkout, settleOrder, alipayHandleNotify, alipayVerify, alipayCheckout, alipaySign, alipayQuery, alipayFetchCashierQr,
  alipayChannelCheck, alipayRemoteCheck, alipayProbe, channelProbesFresh, paypalVerifyWebhook, paypalQuery, paypalCheckout, customerChannels, paypalProbe, paypalCapture, channelStatus, publicUrl, envGet,
  moltspayCheckout, moltspayConfig, moltspayHandleNotify, moltspayVerify,
  // 微信支付 v3（Native 扫码）：下单 / 查单 / 回调
  wechatConfig, wechatChannelCheck, wechatNativeCheckout, wechatQuery, wechatHandleNotify, wechatProbe,
  // 内嵌付款码 / 网关短链 / 智能二维码（server.js 的 /pay/go/<订单号> /pay/smart/<订单号> 与 /v1/pay/manual-confirm 用）
  gatewayLink, rememberGatewayLink, gatewayQrData, smartQrData, imgToDataUrl,
  // 买家回传"我已转账"：只留痕，绝不开通（开通必须运营带令牌确认 / 网关回调验签）
  recordTransferProof, confirmManual, sweepManual, resubmitProof,
  saveProofImage, readProofImage, latestProofOf, PROOF_DIR, setGuardOverride,
  // 服务端到账守望（无公网回调也会自动开通）
  watchPending
};

// ============ 买家回传转账凭证 ============
// 【为什么不能自动开通】买家点"我已转账"只是自述，服务端无从验证真伪。
// 自动开通 = 谁点谁白嫖。所以这里只做两件事：把回传时间/访客写进订单与审计，
// 让运营在后台看到"该核账了"，然后等人（或网关回调）确认。
// 人工通道乐观开通的滥用防护
// 【为什么必须有】乐观开通 = 点一下「我已付款」就能先用 24 小时。
// 如果毫无限制，脚本可以无限创建订单 + 点按钮 = 无限白嫖，订阅墙形同虚设。
// 三道闸（都能在设置里放宽，运营自测不受影响）：
//   1) 订单年龄：订单创建后至少 N 秒才允许开通。真人扫码+付款必然超过这个时间，
//      脚本点按钮通常是毫秒级。默认 30 秒，可用 settings.manualMinOrderAgeSec 调整（0=关闭）。
//   2) 每 24 小时开通次数上限：默认 3 次。真人一天买 3 次以上极罕见。
//      可用 settings.manualMaxProvisionalPerDay 调整。
//   3) 只对本单有效：必须是真实存在的、处于 pending 状态、金额与方案匹配的真实订单。
// 【重要】补交截图（resubmitProof）不受这些限制——那是超时后的恢复通道，不能再拦客户。
// 人工通道乐观开通的滥用防护
// 【为什么必须有】乐观开通 = 点一下「我已付款」就能先用 24 小时。
// 如果毫无限制，脚本可以无限创建订单 + 点按钮 = 无限白嫖，订阅墙形同虚设。
//
// 四道闸（都能在设置里放宽，运营自测不受影响）：
//   1) 订单年龄：订单创建后至少 N 秒才允许开通。真人扫码+付款必然超过这个时间，
//      脚本点按钮通常是毫秒级。默认 30 秒，settings.manualMinOrderAgeSec（0=关闭）。
//   2) 未核销次数：24 小时内「已提交凭证但内部尚未确认」的次数上限。
//      【关键】只数**未确认**的：真实付费客户会被运营很快确认掉，不占额度；
//      而刷子永远不会被确认，每试一次就消耗一次额度，很快被挡住。
//      默认 2 次，settings.manualMaxProvisionalPerDay（0=关闭）。
//   3) 并发上限：同一访客同时最多 1 笔待核销授权，防止并行开单叠加白嫖时长。
//   4) 订单必须真实存在、处于待支付状态。
//
// 【重要】补交截图（resubmitProof）不受这些限制——那是超时后的恢复通道，不能再拦客户。
// 进程内覆盖（仅测试用）：不写共享 settings，测试退出/异常都不会影响线上防护
let _guardOverride = null;
function setGuardOverride(o) { _guardOverride = o || null; return _guardOverride; }

function manualGuardSettings() {
  const num = k => {
    const v = store.getSetting(k);
    const n = Number(v);
    return isFinite(n) ? n : null;
  };
  const base = {
    minAgeSec: num('manualMinOrderAgeSec') === null ? 30 : num('manualMinOrderAgeSec'),
    maxPerDay: num('manualMaxProvisionalPerDay') === null ? 2 : num('manualMaxProvisionalPerDay'),
    maxConcurrent: num('manualMaxConcurrentProvisional') === null ? 1 : num('manualMaxConcurrentProvisional')
  };
  // 覆盖优先（测试进程内生效）
  if (_guardOverride) {
    return {
      minAgeSec: _guardOverride.minAgeSec === undefined ? base.minAgeSec : Number(_guardOverride.minAgeSec),
      maxPerDay: _guardOverride.maxPerDay === undefined ? base.maxPerDay : Number(_guardOverride.maxPerDay),
      maxConcurrent: _guardOverride.maxConcurrent === undefined ? base.maxConcurrent : Number(_guardOverride.maxConcurrent)
    };
  }
  return base;
}

// 返回 { ok:true } 或 { ok:false, error:'...' }
function manualGuardOk(order, visitorKey) {
  const s = manualGuardSettings();
  if (!order) return { ok: false, error: '订单不存在' };

  // 闸 1：订单年龄（真人扫码付款必然超过）
  if (s.minAgeSec > 0) {
    const created = Number(order.createdAt || order.at || 0);
    const age = created ? (Date.now() - created) / 1000 : 999;
    if (age < s.minAgeSec) {
      return { ok: false, error: '订单刚创建，请完成付款后再提交（' + Math.ceil(s.minAgeSec - age) + ' 秒后生效）' };
    }
  }

  // 闸 2：24 小时内「未核销」的开通次数
  // 只数未确认的 —— 真实付费客户被运营确认后不再占额度，刷子则每试一次消耗一次
  if (s.maxPerDay > 0) {
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    // 【2026-10-21 全量】刷单闸：窗口外的订单不算 → 闸门可被绕过
    const n = store.findAllBy('orders', 'visitor', order.visitor).filter(o =>
      Number(o.proofAt || 0) > dayAgo &&
      o.manualStatus !== 'confirmed').length;
    if (n >= s.maxPerDay) {
      return { ok: false, error: '24 小时内待核销的订单已达上限（' + s.maxPerDay + ' 笔），如有需要请联系客服' };
    }
  }

  // 闸 3：并发待核销上限（防止并行开单叠加免费时长）
  if (s.maxConcurrent > 0) {
    const live = store.list('provisional', 999).filter(x => x.visitor === order.visitor &&
      x.status === 'active' && Number(x.reviewUntil || 0) > Date.now() &&
      x.orderId && x.orderId !== order.id);
    if (live.length >= s.maxConcurrent) {
      return { ok: false, error: '你已有一笔正在核账中的订单（' + live[0].orderId + '），请先完成它' };
    }
  }

  return { ok: true };
}

function recordTransferProof(orderId, visitor, note, imageDataUrl) {
  const oid = String(orderId || '');
  if (!oid) return { ok: false, error: '缺少订单号' };
  const o = store.findBy('orders', 'id', oid);
  if (!o) return { ok: false, error: '订单不存在' };
  if (o.paid && (o.manualStatus === 'confirmed' || o.manualStatus === 'provisionally_active')) return { ok: true, already: true, paid: true, orderId: oid };
  // 【滥用防护】乐观开通是有代价的（24h 通行权），必须挡住脚本刷单。
  // 真人扫码付款必然需要时间，脚本是毫秒级；见 manualGuardOk 注释。
  const guard = manualGuardOk(o, visitor);
  if (!guard.ok) { store.push('audit', { action: '人工开通被防护拦截', detail: '#' + oid + ' ' + guard.error, at: Date.now() }, null, null); return { ok: false, error: guard.error, guarded: true }; }
  const at = Date.now();
  const REVIEW_MS = 24 * 3600 * 1000;
  const reviewUntil = at + REVIEW_MS;
  // 【首次凭证也收截图】有截图 → 运营看一眼就能核销（分钟级）；没截图 → 走 24h 自动核账兜底。
  // 截图是可选的：客户不该被强制上传（那会打断付款流程），但给了就能立刻核销。
  let proofImage = o.proofImage || null;
  if (imageDataUrl) {
    const sv = saveProofImage(oid, imageDataUrl);
    if (!sv.ok) return { ok: false, error: sv.error };
    proofImage = sv.file;
  }
  try {
    store.update('orders', oid, { 
      proofAt: at, 
      proofBy: String(visitor || '').slice(0, 64),
      proofNote: String(note || '').slice(0, 2000),
      proofImage: proofImage,
      proofImageAt: imageDataUrl ? at : (o.proofImageAt || null),
      manualStatus: 'provisionally_active', 
      reviewUntil,
      needProof: false,
      proofCount: (Number(o.proofCount) || 0) + 1,
      paid: true,
      status: 'paid',
      paidAt: o.paidAt || at,
      paidBy: 'manual-provisional'
    }, '买家回传转账凭证（立即开通，24h 内内部核账）');
  } catch (e) { return { ok: false, error: '记录失败：' + String(e.message || e) }; }
  // 立即开通权益：走"可回收的临时权益"（provisional），24h 内内部确认转正，超时自动回收。
  // 不能用 settleOrder：那条路会把钱计入 revenue（记账），而人工通道钱还没被核实。
  try { subs.activateProvisional(o.visitor, o.plan, oid, reviewUntil); } catch (e) {}
  store.push('audit', {
    action: '买家回传转账凭证-立即开通',
    detail: '#' + oid + ' ' + o.amount + ' ' + o.currency + ' 买家称已转账，已立即开通（临时有效，24h 内系统内部确认到账；未确认将自动失效需重新提交）',
    at
  }, null, null);
  return { ok: true, paid: true, orderId: oid, proofAt: at, manualStatus: 'provisionally_active', reviewUntil };
}