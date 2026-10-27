/* ============================================================
   biz.js — 商业中枢前端（订阅/收费墙 / 排行榜 / 24h监控 / 半年千万KPI）
   三语：zh / en / ar；科幻主题联动 app.js THEMES['scifi']。
   访客身份：localStorage bd_visitor；内容端点 10 次免费后弹收费墙。
   ============================================================ */
'use strict';

const BIZ = (() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const _hdrs = () => {
    const hdrs = { 'Content-Type': 'application/json', 'X-Visitor': vid() };
    // 运营令牌透传：非回环部署（云服务器）资金/凭据类接口必须带 X-Admin-Token，
    // 否则 adminAuthed 会 403。回环时服务端放行，带上也不影响。
    let _t = null;
    try { _t = localStorage.getItem('bd_adminToken'); } catch (e) { _t = null; }
    if (_t) hdrs['X-Admin-Token'] = _t;
    return hdrs;
  };
  const api = async (path, opt) => {
    // 统一护栏：12s 超时 + 网络失败节流提示（不吞错）；失败返回空态代理，深层访问永不抛错
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 12000);
    const safeEmpty = () => new Proxy(function () {}, { get: () => safeEmpty() });
    try {
      const r = await fetch(path, Object.assign({ headers: _hdrs(), signal: ctrl.signal }, opt));
      clearTimeout(tm);
      return r.json().catch(() => safeEmpty());
    } catch (e) {
      clearTimeout(tm);
      bErr();
      return safeEmpty();
    }
  };
  // 【为什么必须另有一个 strict 版】资金链路绝不能被「空态代理」美化：失败代理让
  // pw.ok 恒为真、String(pw.qrData) === 'undefined'，页面于是把 <img src="undefined">
  // 当成付款码渲染 —— 买家看到的是一张坏掉的二维码 + 一句「服务连接异常」，却完全
  // 不知道发生了什么（线上真实事故）。strict 版失败返回 null，强制调用方显式处理，
  // 并在页面上如实说清「是网络问题，可重试」。付款链路超时放宽到 30s（网关出码较慢）。
  const apiStrict = async (path, opt, timeoutMs) => {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
    try {
      const r = await fetch(path, Object.assign({ headers: _hdrs(), signal: ctrl.signal }, opt));
      clearTimeout(tm);
      if (r.status >= 500) { bErr(); return null; }
      try { return await r.json(); } catch (e) { return null; }
    } catch (e) {
      clearTimeout(tm);
      bErr();
      return null;
    }
  };
  // 付款码必须是可直接进 <img src> 的 Data URL 或 http(s) 链接，其余一律视为无效
  const isQr = s => typeof s === 'string' && /^(data:image\/|https?:\/\/)/.test(s.trim());
  let _bErr = 0;
  function bErr() {
    const now = Date.now();
    if (now - _bErr < 2000) return;
    _bErr = now;
    toast('⚠️ ' + (I18N[curLang()] || I18N.zh).netShort, 'bad');
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = t => new Date(t).toLocaleString('zh-CN', { hour12: false });
  const loc = { CN: 'zh', US: 'en', AE: 'ar' };

  // —— 访客身份（持久，同一浏览器同一人）——
// 访客身份：服务端签发（带 HMAC 签名），稳定跨 IP/网络切换。
//
// 【为什么要改】原来前端生成的是**无签名**随机串（w + 时间戳 + 随机数），
// 而服务端 subs.verify() 只认签名的 vid（key.sig）。
// 结果：客户端带的头永远验不过 → 服务端每次都回落到「按 IP 兜底」的身份。
// 后果：换一个网络/代理/出口 IP，同一个人就变成新访客 —— 付了钱的订阅直接看不见，
// 收费墙照弹。实测发生过：客户付了 ¥1，订单与浏览会话落在不同身份上，
// 结果「付款成功但仍被收费墙拦住」。
//
// 【怎么改】启动时用服务端当前认定的身份 key 换一张**签发身份**，存进 localStorage，
// 之后所有请求都用它。identity 接口签的就是同一个 key，所以：
//   - 已有订阅不丢（key 没变）
//   - 换 IP / 换网络 / 换代理，身份不变
//   - 身份不可伪造（HMAC 签名，服务端只认自己签的）
let _vidSigned = null;
let _vidKey = '';

// 读一个稳定的本地 key（首次没有就生成一个）
function localKey() {
  let k = '';
  try { k = localStorage.getItem('bd_visitor') || ''; } catch (e) {}
  if (!k) {
    k = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try { localStorage.setItem('bd_visitor', k); } catch (e) {}
  }
  return k;
}

// 对外身份：优先用服务端签发的（服务端能验签通过）
function vid() {
  if (_vidSigned) return _vidSigned;
  let v = '';
  try { v = localStorage.getItem('bd_vid') || ''; } catch (e) {}
  if (v) { _vidSigned = v; return v; }
  _vidKey = localKey();
  return _vidKey;
}

// 启动时把身份升级成服务端签发的。
// 安全：签的是服务端当前认定的同一个 key → 身份不变、订阅不丢。
async function ensureSignedIdentity() {
  try {
    const st = await apiStrict('/v1/subs/status', null, 10000);
    const key = (st && st.visitor) ? String(st.visitor) : '';
    if (!key) return;
    const r = await fetch('/v1/subs/identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key })
    });
    const j = await r.json();
    if (j && j.ok && j.vid) {
      _vidSigned = j.vid;
      _vidKey = key;
      try { localStorage.setItem('bd_vid', j.vid); } catch (e) {}
      try { localStorage.setItem('bd_visitorKey', key); } catch (e) {}
    }
  } catch (e) {}
}

  // ===== 跨设备恢复订阅（2026-10-21）=====
  // 场景：客户在 A 设备付款（邮箱写在订单上），换到 B 设备 → 看到墙 → 这里用邮箱验证码
  // 找回已付订阅：服务端按**订单邮箱**定位原身份并把权益镜像过来（不叠加时长、不重复记账），
  // 前端换上原身份的签名 vid → 墙自动开、额度/订单/沉淀全部回来。
  function recoverMsg(t, kind) {
    const el = document.getElementById('recMsg');
    if (!el) return;
    el.textContent = t;
    el.style.color = kind === 'bad' ? 'var(--danger)' : (kind === 'ok' ? 'var(--ok,#3ddc97)' : 'var(--muted)');
  }
  async function recoverSend() {
    const mail = (document.getElementById('recEmail') || {}).value || '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail.trim())) return recoverMsg('请输入付款时填写的邮箱', 'bad');
    recoverMsg('正在发送验证码…');
    try {
      const r = await apiStrict('/v1/auth/send-code', { method: 'POST', body: JSON.stringify({ target: mail.trim(), type: 'email' }) }, 20000);
      if (!r || r.ok === false) return recoverMsg((r && r.error) || '发送失败，请稍后重试', 'bad');
      recoverMsg((r && r.message) || '验证码已发送，请查收邮箱（含垃圾箱）', 'ok');
    } catch (e) { recoverMsg('网络异常：' + String(e && e.message || e), 'bad'); }
  }
  async function recoverLogin() {
    const mail = (document.getElementById('recEmail') || {}).value || '';
    const code = (document.getElementById('recCode') || {}).value || '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail.trim())) return recoverMsg('请输入付款时填写的邮箱', 'bad');
    if (!/^\d{6}$/.test(code.trim())) return recoverMsg('请填写 6 位数字验证码', 'bad');
    recoverMsg('正在找回…');
    try {
      const r = await apiStrict('/v1/auth/login', { method: 'POST', body: JSON.stringify({ target: mail.trim(), type: 'email', code: code.trim() }) }, 20000);
      if (!r || r.ok === false) return recoverMsg((r && r.error) || '找回失败', 'bad');
      if (r.vid) {
        _vidSigned = r.vid;
        try { localStorage.setItem('bd_vid', r.vid); } catch (e) {}
        if (r.visitor) { _vidKey = r.visitor; try { localStorage.setItem('bd_visitorKey', r.visitor); } catch (e) {} }
      }
      recoverMsg('找回成功，订阅与额度已恢复' + (r.migrated ? ('（迁移 ' + r.migrated + ' 笔权益）') : ''), 'ok');
      try { await refreshSubs(); } catch (e) {}
      try { await refreshMyAssets(); } catch (e) {}
      hideWall();
    } catch (e) { recoverMsg('网络异常：' + String(e && e.message || e), 'bad'); }
  }
  document.addEventListener('DOMContentLoaded', () => {
    const s = document.getElementById('recSend'); if (s) s.onclick = recoverSend;
    const l = document.getElementById('recLogin'); if (l) l.onclick = recoverLogin;
  });

  // —— 三语词典 ——
  const I18N = {
    zh: { free: '免费次数', wallT: '🔒 免费次数已用完', wallM: '订阅后解锁全部功能。支持微信 / 支付宝，入账一律进支付宝。', later: '再逛逛', subNow: '订阅解锁', netShort: '网络异常，请重试（订单不受影响）', wallHint: '提示：扫码付款成功即自动开通订阅（开通由网关回调与查单自动确认，无需人工核账）。', quotaDailyDone: '今日此功能额度已用完', quotaDailyHint: ' 明日自动恢复；也可升级更高套餐。', quotaFreeHead: '未订阅也能用（每日免费额度）:', quotaHeavyTag: '重耗功能日限', quotaUnlimitedTag: '不限次', quotaTrialTag: '试用 7 天' },
    en: { free: 'Free uses left', wallT: '🔒 Free quota used up', wallM: 'Subscribe to unlock everything. WeChat / Alipay accepted; all revenue settles to Alipay.', later: 'Browse more', subNow: 'Subscribe to unlock', netShort: 'Network error, please retry (your order is unaffected)', wallHint: 'Tip: paying by QR code activates your subscription instantly (activation is confirmed automatically via gateway callback and order polling — no manual step).', quotaDailyDone: "Today's quota for this feature is used up", quotaDailyHint: ' Resets automatically tomorrow; upgrade plans are available.', quotaFreeHead: 'Free daily quota (no subscription needed):', quotaHeavyTag: 'Heavy-feature daily cap', quotaUnlimitedTag: 'Unlimited', quotaTrialTag: '7-day trial' },
    ar: { free: 'الاستخدامات المجانية المتبقية', wallT: '🔒 انتهت الاستخدامات المجانية', wallM: 'اشترك لفتح كل المزايا. يقبل WeChat / Alipay، وكل الإيرادات تُحصّل في Alipay.', later: 'تصفح أكثر', subNow: 'اشترك الآن', netShort: 'خطأ في الشبكة، يرجى إعادة المحاولة (طلبك غير متأثر)', wallHint: 'ملاحظة: الدفع بلمس الشيفرة يفعّل الاشتراك فورًا؛ يعتمد التفعيل على رد نداء البوابة والاستعلام المباشر دون أي خطوة يدوية.', quotaDailyDone: 'اكتملت حصة اليوم لهذه الوظيفة', quotaDailyHint: ' تُستعاد تلقائيًا غدًا؛ ويمكنك الترقية لخطة أعلى.', quotaFreeHead: 'متاح بلا اشتراك (حصة يومية مجانية):', quotaHeavyTag: 'سقف يومي للوظائف الثقيلة', quotaUnlimitedTag: 'غير محدود', quotaTrialTag: 'تجربة 7 أيام' }
  };
  // 语言以 i18n 引擎为唯一真源（window.I18N.get()），DOM 下拉框可能因初始化时序滞后，
  // 之前只读 #langSel.value 会导致"引擎已是英文、收银台仍按中文渲染 → 再被逐词机翻成混杂语"。
  const curLang = () => {
    try {
      if (window.I18N && window.I18N.get) { const g = window.I18N.get(); if (g) return g; }
    } catch (e) {}
    const v = ($('#langSel') && $('#langSel').value) || 'zh';
    return loc[v] || 'zh';
  };
  const T = k => (I18N[curLang()] || I18N.zh)[k] || I18N.zh[k] || k;

  // 收银台三语文案：直接按当前语言整句输出，避免中文被 i18n 引擎逐词机翻成
  // "语言混杂"（真实事故：中文按钮「扫码付款」在英文模式下被切成「扫码Pay」）。
  const PL = {
    zh: {
      choose: '选择支付方式：', alipayWechat: '支付宝 / 微信（扫码付款）', alipay: '支付宝', wechat: '微信',
      manual: '微信 / 支付宝',
      moltspay: 'Moltspay（聚合支付）', online: '在线支付',
      gen: '正在生成付款码…', fail: '获取支付信息失败，请稍后重试',
      scanTip: '用手机扫一扫付款；电脑上也可点下方按钮前往支付。',
      qrOnlyTip: '请用手机支付宝「扫一扫」上方二维码付款，付款成功即自动开通。',
      goPay: '前往支付', goPayGw: '前往支付（{g}）',
      redirectHint: '点击下方按钮跳转 PayPal 安全结账，完成后自动回到本页。',
      alipayCashier: '已拉起支付宝收银台，付款完成后回到本页。',
      noting: '收款码尚未配置，请联系客服完成下单。',
      noteOrder: '转账请备注订单号：', manualHint: '请扫码付款并备注订单号，付完点「我已付款」即可立即开通。',
      gwHint: '付款成功后自动回到本页，订阅即时开通（每 5 秒自动检测）。',
      orderTitle: '订阅 {a} {c}（{p} 计划）', orderFail: '下单失败：', unknown: '未知',
      netFail: '网络中断或超时，二维码未能加载。请检查网络后重试（订单已生成，不影响付款）。', retry: '重试',
      paidToast: '✅ 支付到账，订阅已激活', paidMark: '已记录：运营确认到账后自动激活（每 5 秒自动检测）',
      paidNow: '已收到，订阅已开通。系统会自动完成对账，你无需任何操作。',
      needProof: '这笔付款需要再确认一下，请补交支付截图（转账成功页面的截图）以继续使用。',
      resubmitBtn: '补交支付截图',
      resubmitOk: '已收到补交凭证，订阅已恢复。系统将在 24 小时内自动核账。',
      proofNotePh: '可附转账备注/流水号，便于核账（选填）',
      needImage: '请先选择支付截图文件',
      proofHint: '请上传转账成功页面的截图（支持 PNG/JPG，≤3MB）',
      imgTypeErr: '请选择图片文件',
      imgTooBig: '图片过大（请选小于 12MB 的图片）',
      imgReadErr: '图片读取失败，请换一张',
      // —— 重值功能每日额度（402 额度提示 / 订阅墙额度表共用）——
      // 【2026-10-22 修复】这些键原来只写在 I18N（zh/en）里，而提示文案走 PT（查 PL），
      // zh/en 下查不到就直接把键名显示给买家（「decision」quotaDailyDone (10/10) quotaDailyHint）。
      // 现在 PL 三语齐全，PT/T 两条路径都能正确取到文案。
      quotaDailyDone: '今日此功能额度已用完', quotaDailyHint: '明日自动恢复；也可升级更高套餐。', quotaFreeHead: '未订阅也能用（每日免费额度）:', quotaHeavyTag: '重耗功能日限', quotaUnlimitedTag: '不限次', quotaTrialTag: '试用 7 天',
      matHead: '成熟度', matTested: '✅ 实测稳定', matBeta: '🔄 Beta', matExperimental: '⚠️ 实验性',
      quotaPerDay: '/日', quotaEachUsedUp: '（每项额度已用完）', quotaSecQuote: '「{s}」', quotaSecJoin: '、',
      bpGoal: '目标', bpInputs: '输入', bpControls: '控制', bpOutput: '产出', bpFailure: '失败表现', bpScope: '数据边界', bpReview: '人工审批', bpOpened: '说明', bpReviewYes: '需人工确认', bpReviewNo: '无需人工确认', bpZhOnly: '',
      // —— 退款（客户自助入口）——
      refundTitle: '申请退款',
      refundReasonPh: '退款原因（选填，300 字以内）',
      refundSubmit: '提交退款申请',
      refundCancel: '取消',
      refundOrder: '订单 {a} · {b} {c}',
      refundOk: '退款申请已受理。款项实际到账后我们会通知你（申请 ≠ 已退款）。',
      refundPending: '已受理，等待出款',
      refundDone: '已退款',
      refundFailed: '退款申请失败：',
      refundBtn: '申请退款',
      refundUnknown: '找不到该订单（只能申请你自己的订单）',
      refundHint: '申请 ≠ 已退款：只有运营实际转账后，状态才会变成「已退款」。',
      // —— 免费试用 2 天（获客件）——
      trialBtn: '🎁 免费试用 {d} 天 · 无需付款，到期自动结束',
      trialGoing: '正在开通…',
      trialOk: '✅ 免费试用已开通 {d} 天，全部功能解锁，到期自动结束',
      trialErr: '免费试用领取失败，请稍后重试'
    },
    en: {
      choose: 'Choose a payment method:', alipayWechat: 'Alipay / WeChat (scan to pay)', alipay: 'Alipay', wechat: 'WeChat',
      manual: 'WeChat / Alipay',
      moltspay: 'Moltspay (aggregated)', online: 'Online payment',
      gen: 'Generating payment code…', fail: 'Failed to get payment info, please retry',
      scanTip: 'Scan with your phone to pay, or click the button below on desktop.',
      qrOnlyTip: 'Scan the QR code above with Alipay on your phone; the subscription activates instantly on payment.',
      goPay: 'Go to pay', goPayGw: 'Go to pay ({g})',
      redirectHint: 'Click below to open PayPal secure checkout; you will return here automatically.',
      alipayCashier: 'Alipay checkout opened; return here after paying.',
      noting: 'Payment QR is not configured yet, please contact support to complete the order.',
      noteOrder: 'Please include the order ID in your transfer note:', manualHint: 'Scan to pay and add your order ID, then tap I have paid to activate instantly.',
      gwHint: 'You will return here automatically; the subscription activates right away (checked every 5s).',
      orderTitle: 'Subscribe {a} {c} ({p} plan)', orderFail: 'Order failed: ', unknown: 'unknown',
      netFail: 'Network interrupted or timed out; the QR code did not load. Please check your connection and retry (your order is created and unaffected).', retry: 'Retry',
      paidToast: '✅ Payment received, subscription activated', paidMark: 'Recorded: activates automatically once operations confirms settlement (checked every 5s)',
      paidNow: 'Received - your subscription is active. We reconcile automatically; no action needed from you.',
      needProof: 'This payment needs one more confirmation. Please submit a payment screenshot to continue.',
      resubmitBtn: 'Submit payment screenshot',
      resubmitOk: 'Screenshot received, subscription restored. We verify automatically within 24 hours.',
      proofNotePh: 'Optional: add your transfer note or transaction ID to speed up verification',
      needImage: 'Please choose a payment screenshot file first',
      proofHint: 'Upload a screenshot of the transfer success page (PNG/JPG, up to 3MB)',
      imgTypeErr: 'Please choose an image file',
      imgTooBig: 'Image is too large (please pick one under 12MB)',
      imgReadErr: 'Could not read the image, please try another',
      // —— Heavy-feature daily quota (shared by 402 quota toasts / wall quota table) ——
      quotaDailyDone: "Today's quota for this feature is used up", quotaDailyHint: 'Resets automatically tomorrow; upgrade plans are available.', quotaFreeHead: 'Free daily quota (no subscription needed):', quotaHeavyTag: 'Heavy-feature daily cap', quotaUnlimitedTag: 'Unlimited', quotaTrialTag: '7-day trial',
      matHead: 'Maturity', matTested: '✅ Tested stable', matBeta: '🔄 Beta', matExperimental: '⚠️ Experimental',
      quotaPerDay: '/day', quotaEachUsedUp: ' (each section hit its daily cap)', quotaSecQuote: '"{s}"', quotaSecJoin: ', ',
      bpGoal: 'Goal', bpInputs: 'Inputs', bpControls: 'Controls', bpOutput: 'Output', bpFailure: 'On failure', bpScope: 'Data scope', bpReview: 'Human review', bpOpened: 'Details', bpReviewYes: 'Requires human confirmation', bpReviewNo: 'No human confirmation needed', bpZhOnly: 'Detailed operating spec is currently authored in Chinese — request an English version and we will send it.',
      // —— Refund (self-service entry) ——
      refundTitle: 'Request a refund',
      refundReasonPh: 'Reason (optional, up to 300 chars)',
      refundSubmit: 'Submit refund request',
      refundCancel: 'Cancel',
      refundOrder: 'Order {a} · {b} {c}',
      refundOk: 'Refund request accepted. We will notify you once the money is actually sent (a request is not a refund).',
      refundPending: 'Accepted, awaiting payout',
      refundDone: 'Refunded',
      refundFailed: 'Refund request failed: ',
      refundBtn: 'Refund',
      refundUnknown: 'Order not found (you can only request a refund for your own orders)',
      refundHint: 'A request is not a refund: the status becomes "Refunded" only after operations actually transfers the money.',
      // —— Free 2-day trial (acquisition) ——
      trialBtn: '🎁 Free {d}-day trial · no payment, ends automatically',
      trialGoing: 'Activating…',
      trialOk: '✅ Free trial activated for {d} days — everything unlocked, ends automatically',
      trialErr: 'Could not claim the free trial, please retry later'
    },
    ar: {
      choose: 'اختر طريقة الدفع:', alipayWechat: 'علي باي / ويتشات (امسح للدفع)', alipay: 'علي باي', wechat: 'ويتشات',
      manual: 'WeChat / Alipay',
      moltspay: 'Moltspay (مجمّع)', online: 'الدفع عبر الإنترنت',
      gen: 'جارٍ إنشاء رمز الدفع…', fail: 'فشل الحصول على معلومات الدفع، يرجى إعادة المحاولة',
      scanTip: 'امسح بهاتفك للدفع، أو اضغط الزر أدناه على الحاسوب.',
      qrOnlyTip: 'امسح رمز QR أعلاه بتطبيق علي باي من هاتفك؛ يُفعَّل الاشتراك فورًا عند الدفع.',
      goPay: 'اذهب للدفع', goPayGw: 'اذهب للدفع ({g})',
      redirectHint: 'اضغط أدناه لفتح الدفع الآمن عبر باي بال؛ ستعود إلى هنا تلقائيًا.',
      alipayCashier: 'تم فتح صفحة الدفع لعلي باي؛ عد إلى هنا بعد الدفع.',
      noting: 'لم يتم تهيئة رمز الدفع بعد، يرجى التواصل مع الدعم.',
      noteOrder: 'يرجى ذكر رقم الطلب في ملاحظة التحويل:', manualHint: 'امسح للدفع واذكر رقم الطلب، ثم اضغط «لقد دفعت» للتفعيل فورًا.',
      gwHint: 'ستعود إلى هنا تلقائيًا؛ يُفعَّل الاشتراك فورًا (يُفحص كل 5 ثوانٍ).',
      orderTitle: 'اشترك {a} {c} (خطة {p})', orderFail: 'فشل الطلب: ', unknown: 'غير معروف',
      netFail: 'انقطع الاتصال أو انتهت المهلة، ولم يتم تحميل رمز QR. يرجى التحقق من الشبكة وإعادة المحاولة (طلبك مُنشأ ولا يتأثر).', retry: 'إعادة المحاولة',
      paidToast: '✅ تم استلام الدفع وتنشيط الاشتراك', paidMark: 'تم التسجيل: يُفعَّل تلقائيًا بعد تأكيد العمليات للتسوية (يُفحص كل 5 ثوانٍ)',
      paidNow: 'تم الاستلام - اشتراكك مفعّل الآن. نقوم بالتسوية تلقائيًا، ولا يلزمك أي إجراء.',
      quotaDailyDone: 'اكتمل حصة اليوم لهذه الوظيفة', quotaDailyHint: ' تستعاد تلقائيًا غدًا؛ وخيار الترقية متاح.', quotaFreeHead: 'متاح بلا اشتراك (حصة يومية مجانية):', quotaHeavyTag: 'سقف يومي للوظائف الثقيلة', quotaUnlimitedTag: 'غير محدود', quotaTrialTag: 'تجربة 7 أيام',
      matHead: 'النضج', matTested: '✅ مُختبر ومستقر', matBeta: '🔄 نسخة تجريبية', matExperimental: '⚠️ تجريبي',
      quotaPerDay: '/يوم', quotaEachUsedUp: ' (كل قسم بلغ سقفه اليومي)', quotaSecQuote: '«{s}»', quotaSecJoin: '، ',
      bpGoal: 'الهدف', bpInputs: 'المدخلات', bpControls: 'الضوابط', bpOutput: 'المخرجات', bpFailure: 'عند الفشل', bpScope: 'نطاق البيانات', bpReview: 'مراجعة بشرية', bpOpened: 'التفاصيل', bpReviewYes: 'تتطلب تأكيدًا بشريًا', bpReviewNo: 'لا تتطلب تأكيدًا بشريًا', bpZhOnly: 'المواصفات التشغيلية التفصيلية متاحة حاليًا بالصينية — اطلب النسخة الإنجليزية وسنرسلها.',
      needProof: 'هذه الدفعة تحتاج تأكيدًا إضافيًا. يرجى إرسال لقطة شاشة للدفع للمتابعة.',
      resubmitBtn: 'إرسال لقطة شاشة للدفع',
      resubmitOk: 'تم استلام اللقطة، تم استعادة الاشتراك. نتحقق تلقائيًا خلال 24 ساعة.',
      proofNotePh: 'اختياري: أضف ملاحظة التحويل أو رقم العملية لتسريع التحقق',
      needImage: 'يرجى اختيار ملف لقطة شاشة للدفع أولاً',
      proofHint: 'ارفع لقطة شاشة لصفحة نجاح التحويل (PNG/JPG، حتى 3 ميجابايت)',
      imgTypeErr: 'يرجى اختيار ملف صورة',
      imgTooBig: 'الصورة كبيرة جدًا (يرجى اختيار أقل من 12 ميجابايت)',
      imgReadErr: 'تعذر قراءة الصورة، يرجى تجربة أخرى',
      // —— Refund (self-service entry) ——
      refundTitle: 'طلب استرداد',
      refundReasonPh: 'السبب (اختياري، حتى ٣٠٠ حرف)',
      refundSubmit: 'إرسال طلب الاسترداد',
      refundCancel: 'إلغاء',
      refundOrder: 'الطلب {a} · {b} {c}',
      refundOk: 'تم قبول طلب الاسترداد. سنُعلمك عند تحويل المبلغ فعليًا (الطلب ليس استردادًا).',
      refundPending: 'مقبول، بانتظار التحويل',
      refundDone: 'تم الاسترداد',
      refundFailed: 'فشل طلب الاسترداد: ',
      refundBtn: 'طلب استرداد',
      refundUnknown: 'الطلب غير موجود (يمكنك طلب الاسترداد لطلباتك فقط)',
      refundHint: 'الطلب ليس استردادًا: تصبح الحالة «تم الاسترداد» بعد تحويل العمليات للمبلغ فعليًا.',
      // —— تجربة مجانية يومان (جذب العملاء) ——
      trialBtn: '🎁 تجربة مجانية {d} يومين · بلا دفع وتنتهي تلقائيًا',
      trialGoing: 'جارٍ التفعيل…',
      trialOk: '✅ فُعِّلت التجربة المجانية لمدة {d} يومين — كل المزايا مفتوحة وتنتهي تلقائيًا',
      trialErr: 'تعذّر تفعيل التجربة المجانية، يرجى إعادة المحاولة لاحقًا'
    }
  };
  const PT = k => (PL[curLang()] || PL.zh)[k] || PL.zh[k] || k;
  const PTf = (k, vars) => PT(k).replace(/\{(\w+)\}/g, (m, x) => (vars && vars[x] !== undefined) ? vars[x] : m);

  // ===== 收费墙弹窗 =====
  let wallPlan = null;
  // 免费试用 2 天（获客件）：领取即激活，无需付款。资格位来自 402 body 的 trialAvail
  //（或 /v1/subs/status 的 freeTrialAvailable）——用完/已订阅者不亮按钮，绝不给"点了报错"的假入口。
  async function claimTrial() {
    const tb = document.getElementById('wallTrialBtn');
    if (tb) { tb.disabled = true; tb.textContent = PT('trialGoing'); }
    const r = await apiStrict('/v1/subs/free-trial', { method: 'POST' }, 15000);
    if (!r || r.ok !== true) {
      if (tb) { tb.disabled = false; tb.textContent = PTf('trialBtn', { d: 2 }); }
      toast((r && r.error) || PT('trialErr'), 'bad');
      return;
    }
    toast(PTf('trialOk', { d: r.days || 2 }), 'ok', 5000);
    try { await refreshSubs(); } catch (e) {}
    if (typeof refreshKPI === 'function') { try { refreshKPI(); } catch (e) {} }
    hideWall();
  }
  function showWall(plans, meta) {
    $('#wallPlans').innerHTML = (plans && plans.CN ? plans.CN : []).map(p =>
      '<div class="subs-card" data-plan="' + p.id + '"><div>' + esc(p.label + ' · ' + (plans.EN.find(x => x.id === p.id) || {}).label + '') + '</div>' +
      '<div class="sc-price">¥' + p.amount + ' / $' + ((plans.EN.find(x => x.id === p.id) || {}).amount || 0) + '</div>' +
      '<div class="sc-term">' + esc(p.en || '') + (p.tag ? ' · ' + esc(p.tag) : '') + '</div></div>').join('');
    $('#wallTitle').textContent = T('wallT');
    $('#wallMsg').textContent = T('wallM');
    $('#wallLater').textContent = T('later');
    // 【2026-10 修复】#wallHint 静态中文兜底曾被本地化流程完全绕过（英文/阿文界面里
    // 永远显示一句中文，且旧文案还写着「运营对账后激活」，与「付款即开通」产品决定矛盾）。
    // 现在由三语词典整句覆盖，语义与实际开通逻辑（回调/查单自动激活）一致。
    const wh = $('#wallHint'); if (wh) wh.textContent = T('wallHint');
    // 【获客件 2026-10-25】免费试用 2 天按钮：meta.trialAvail === false（已用/已订阅）时整行隐藏
    const trRow = document.getElementById('wallTrialRow');
    const trBtn = document.getElementById('wallTrialBtn');
    if (trRow && trBtn) {
      const avail = !(meta && meta.trialAvail === false);
      trRow.hidden = !avail;
      if (avail) {
        trBtn.disabled = false;
        trBtn.textContent = PTf('trialBtn', { d: 2 });
        trBtn.onclick = () => { claimTrial(); };
      }
    }
    // 【2026-10-21 额度口径透明】竞品（豆包/Kimi 2026-07）被投诉"额度口径不透明"。
    // 订阅墙是客户做决定的地方 → 把"各档每天能用多少 + 未订阅的免费额度"直接写出来，
    // 数据来自 /v1/subs/quota（收费墙登记表导出：权威、不漂移）。
    renderQuotaTable();
    [...$('#wallPlans').querySelectorAll('.subs-card')].forEach(c => {
      c.onclick = () => {
        wallPlan = c.dataset.plan;
        [...$('#wallPlans').querySelectorAll('.subs-card')].forEach(x => x.classList.remove('cur'));
        c.classList.add('cur');
        subscribe(wallPlan);
      };
    });
    $('#wallOverlay').hidden = false;
    // 【零操作】墙开着就开哨兵：任何渠道开通权益都会自动关墙（见 _startUnlockWatch）
    _startUnlockWatch();
    setTimeout(() => { if ($('#subsQuotaCard')) refreshSubs(); }, 300);
  }
  // ===== 额度表（免费额度 + 各档重耗日限）：口径透明 =====
  let _quotaInfo = null;
  async function loadQuotaInfo() {
    if (_quotaInfo) return _quotaInfo;
    try {
      const d = await api('/v1/subs/quota');
      if (d && d.ok) _quotaInfo = d;
    } catch (e) { /* 拿不到就不显示，绝不编造数字 */ }
    return _quotaInfo;
  }
  async function renderQuotaTable() {
    const box = $('#wallQuota');
    if (!box) return;
    const d = await loadQuotaInfo();
    if (!d || !d.free || !d.free.length) { box.innerHTML = ''; return; }
    // 【2026-10-23 本地化】服务端返回 {zh,en,ar} 映射，这里按当前界面语言取。
    // 缺语回落到 en，再回落到 zh（绝不把 undefined 渲染成 'undefined'）。
    const lang = curLang();
    const L = (obj, fb) => {
      if (!obj) return fb || '';
      return obj[lang] || obj.en || obj.zh || fb || '';
    };
    const heavy = d.heavySections || [];
    const rows = (d.tiers || []).map(t => {
      const h = t.trial ? PT('quotaTrialTag') : (heavy.length ? (PT('quotaHeavyTag') + ' ' + t.heavyDaily) : PT('quotaUnlimitedTag'));
      return '<tr><td>' + esc(L(t.labelI18n, t.label)) + '</td><td>¥' + t.amount + '</td><td>' + esc(h) + '</td></tr>';
    }).join('');
    const free = d.free.map(f => L(f.labelI18n, f.label) + ' ' + f.perDay + PT('quotaPerDay')).join(' · ');
    // =====【2026-10-23 成熟度标签 + Blueprint 卡片】=====
    const matTag = m => m === 'tested' ? PT('matTested') : (m === 'beta' ? PT('matBeta') : (m === 'experimental' ? PT('matExperimental') : ''));
    const bpLine = (k, v) => {
      if (!v) return '';
      const labelKey = { bpGoal: 'bpGoal', bpInputs: 'bpInputs', bpControls: 'bpControls', bpOutput: 'bpOutput', bpFailure: 'bpFailure', bpScope: 'bpScope', bpReview: 'bpReview' }[k];
      return '<div style="margin-top:4px"><b>' + esc(PT(labelKey || k)) + '</b>: ' + esc(v) + '</div>';
    };
    const cards = (d.free || []).map(f => {
      const bp = f.blueprint || {};
      const reviewText = f.humanReview ? PT('bpReviewYes') : PT('bpReviewNo');
      const detLines = [
        bpLine('bpGoal', bp.goal),
        bpLine('bpInputs', bp.inputs),
        bpLine('bpControls', bp.controls),
        bpLine('bpOutput', bp.output),
        bpLine('bpFailure', bp.failure),
        bpLine('bpScope', f.dataScope || ''),
        '<div style="margin-top:4px"><b>' + esc(PT('bpReview')) + '</b>: ' + esc(reviewText) + '</div>',
      ].join('');
      const label = L(f.labelI18n, f.label);
      // 【2026-10-23 语言一致性】Blueprint 正文（goal/inputs/…）目前只有中文原文；
      // 英文/阿文界面若直接展开会变成"英文标签 + 中文长段落"的语言混杂。
      // 与其假装已翻译，不如在非中文界面收起正文并明确说明（诚实优先）。
      // 待英文 spec 翻译完成后，服务端补 blueprintI18n 即可放开。
      const bpTextAvailable = lang === 'zh';
      const detBlock = (detLines && bpTextAvailable)
        ? '<details style="margin-top:6px"><summary class="sub" style="cursor:pointer;opacity:.8">' + esc(PT('bpOpened')) + ' · ' + esc(label) + '</summary>' +
          '<div class="sub" style="line-height:1.7;padding:4px 8px;background:rgba(0,0,0,.15);border-radius:6px;margin-top:4px">' + detLines + '</div></details>'
        : (detLines ? '<div class="sub" style="margin-top:6px;opacity:.75;font-size:.9em">' + esc(PT('bpZhOnly')) + '</div>' : '');
      const maturitySpan = matTag(f.maturity)
        ? '<span style="font-size:.85em;opacity:.9;margin-left:6px">' + matTag(f.maturity) + '</span>'
        : '';
      return '<div style="border:1px solid rgba(125,211,252,.25);border-radius:8px;padding:8px 10px;margin-top:6px;line-height:1.7">' +
        '<div><b>' + esc(label) + '</b>' + maturitySpan +
        '<span style="opacity:.7;font-size:.9em"> · ' + esc(f.perDay + PT('quotaPerDay')) + '</span></div>' +
        (f.desc ? '<div class="sub" style="opacity:.8">' + esc(L(f.descI18n, f.desc)) + '</div>' : '') +
        detBlock +
        '</div>';
    }).join('');
    const matNoteText = L(d.maturityNoteI18n, d.maturityNote);
    const maturityNote = matNoteText
      ? '<div class="sub" style="margin-top:8px;padding:6px 8px;background:rgba(125,211,252,.08);border-radius:6px;line-height:1.6">' + esc(matNoteText) + '</div>'
      : '';
    box.innerHTML =
      '<div class="sub" style="margin-top:10px;line-height:1.7">' + esc(PT('quotaFreeHead')) + ' ' + esc(free) + '</div>' +
      '<table class="sub" style="margin-top:6px"><tbody>' + rows + '</tbody></table>' +
      maturityNote +
      '<div style="margin-top:8px">' + cards + '</div>' +
      '<div class="sub" style="margin-top:8px">' + esc(L(d.noteI18n, d.note)) + '</div>';
  }

  function hideWall() { $('#wallOverlay').hidden = true; if (_unlockWatch) { clearInterval(_unlockWatch); _unlockWatch = null; } }
  $('#wallLater').onclick = hideWall;

  // ===== 订阅下单（真实收款：网关二维码/跳转 或 收款码+人工确认 → 运营核验到账后自动激活）=====
  let _payPoll = null;
  // 当前订单可用的支付方式（买家在弹窗里可切换）
  let _payModes = [];

  // ——【零操作 2026-10-21】支付结果轮询：5s×240 次（约 20 分钟）→ 降级 30s 慢轮询，**一直轮到 paid 为止** ——
  // 为什么改：旧版到 240 次就彻底停轮询，客户付完款回页面（尤其 >20 分钟）就永远停在二维码/墙上，
  // 只能手动刷新/重新下单——违反「全程不点按钮」。新版永不彻底停：迟到的确认信号（收款邮件、
  // 运营后台确认、回调排队）最多再等 30s 也会自动解锁。轮询只在「已支付」或页面关闭时结束。
  // 双信号探测：① 订单本身 paid（结算权威依据）② /v1/subs/status 已 unlimited/sub（任何通道已开通）。
  function _startPayPoll(orderId) {
    if (!orderId) return;
    if (_payPoll) { clearInterval(_payPoll); _payPoll = null; }
    let ticks = 0;
    let ms = 5000;
    const unlock = () => {
      clearInterval(_payPoll); _payPoll = null;
      const po2 = document.getElementById('payOverlay');
      if (po2) po2.hidden = true;
      hideWall();
      refreshSubs();
      if (typeof refreshKPI === 'function') { try { refreshKPI(); } catch (e) {} }
      toast(PT('paidToast'), 'ok');
    };
    const run = async () => {
      let done = false;
      try {
        const st = await apiStrict('/v1/pay/status?order=' + encodeURIComponent(orderId), null, 8000);
        done = !!(st && typeof st === 'object' && st.paid);
      } catch (e) { /* 网络抖动：不放弃，下一轮继续探 */ }
      if (!done) {
        try {
          const sd = await api('/v1/subs/status');
          done = !!(sd && (sd.unlimited || sd.sub));
        } catch (e) {}
      }
      if (done) { unlock(); return; }
      if (ms === 5000 && ++ticks >= 240) {
        ms = 30000;                      // 快轮询 20 分钟后降速，但绝不停止
        clearInterval(_payPoll);
        _payPoll = setInterval(run, ms);
      }
    };
    _payPoll = setInterval(run, ms);
  }

  // ——【零操作 2026-10-21】收费墙打开期间的被动解锁哨兵 ——
  // 每逢墙显示出来，后台每 10s 探一次订阅状态；一旦任何渠道（邮件自动核账、运营确认、
  // 网关回调、补单修复）开通了权益 → 墙自动消失 + 提示。客户全程零按钮。
  // 设为此轮询在客户支付回来 >20 分钟（旧轮询已死）的场景下的兜底信号源。
  let _unlockWatch = null;
  function _startUnlockWatch() {
    if (_unlockWatch) return;
    _unlockWatch = setInterval(async () => {
      try {
        const d = await api('/v1/subs/status');
        if (d && (d.unlimited || d.sub)) {
          clearInterval(_unlockWatch); _unlockWatch = null;
          if (!$('#wallOverlay').hidden) { hideWall(); toast(PT('paidToast'), 'ok'); }
          refreshSubs();
        }
      } catch (e) {}
    }, 10000);
  }

  // —— 付款码渲染小工具：Data URL 直接进 <img>，不依赖任何静态文件路径 ——
  const qrImg = (src, size) => '<img src="' + esc(src) + '" alt="pay-qr" style="width:' + (size || 260) + 'px;height:' + (size || 260) + 'px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:8px;display:block">';
  const chanTabs = (list, active) => '<div style="display:flex;justify-content:center;gap:6px;margin:6px 0;flex-wrap:wrap">'
    + list.map(x => '<button class="btn small ' + (x.key === active ? '' : 'ghost') + '" data-paymode="' + esc(x.key) + '">' + esc(x.label) + '</button>').join('')
    + '</div>';

  // —— 加载指定通道的付款信息并渲染（通道切换时复用；绝不抛错，失败给出可读提示）——
  async function loadChannel(orderId, currency, channel, containerId) {
    const qrBox = document.getElementById(containerId || 'payQr');
    if (!qrBox) return;
    qrBox.innerHTML = '<div class="sub" style="text-align:center;margin:14px 0">' + PT('gen') + '</div>';
    let pw = null;
    try {
      pw = await apiStrict('/v1/pay/checkout', { method: 'POST', body: JSON.stringify({ orderId, currency, channel }) });
    } catch (e) { pw = null; }
    // 严格校验：必须是真对象且 ok===true（代理/字符串/undefined 一律拒绝）；
    // 失败时如实报错并给「重试」，绝不渲染坏二维码、绝不谎称可扫码。
    if (!pw || typeof pw !== 'object' || pw.ok !== true) {
      const msg = (pw && typeof pw === 'object' && pw.error) ? esc(pw.error) : esc(PT('netFail'));
      qrBox.innerHTML = '<div class="sub" style="text-align:center;color:var(--danger);margin:14px 0;line-height:1.6">' + msg + '</div>'
        + '<div style="display:flex;justify-content:center"><button class="btn small" id="payRetry">' + esc(PT('retry')) + '</button></div>';
      const rb = document.getElementById('payRetry');
      if (rb) rb.onclick = () => loadChannel(orderId, currency, channel, containerId);
      return;
    }
    const act = pw.action || {};
    const setAcct = t => { const el = document.getElementById('payAccount'); if (el) el.textContent = t; };
    const setHint = t => { const el = document.getElementById('payHint'); if (el) el.textContent = t; };

    // ① 网关模式：服务端已把「付款内容」做成二维码 Data URL
    if (pw.mode === 'gateway' && isQr(pw.qrData || pw.payUrl)) {
      const gwName = pw.channel === 'paypal' ? 'PayPal'
        : (pw.gateway === 'moltspay' || pw.channel === 'moltspay') ? 'Moltspay'
          : (pw.channel === 'wechat' ? PT('wechat') : pw.channel === 'alipay' ? PT('alipay') : PT('online'));
      // 支付宝/微信的 payUrl 是 qr.alipay.com / weixin 协议——只能用 App 扫，浏览器打不开。
      // 给它配「前往支付」按钮就是给买家一个必然打不开的网页（用户已实测踩到）。
      // 只留二维码；PayPal/Moltspay 是真实网页收银台，才给跳转按钮。
      const qrOnly = (pw.channel === 'alipay' || pw.channel === 'wechat');
      _payModes = [{ key: channel || pw.channel, label: gwName }];
      setAcct(gwName);
      qrBox.innerHTML = chanTabs(_payModes, channel || pw.channel)
        + '<div style="display:flex;justify-content:center;margin-top:4px">' + qrImg(pw.qrData || pw.payUrl) + '</div>'
        + '<div class="sub" style="text-align:center;margin-top:6px">' + PT(qrOnly ? 'qrOnlyTip' : 'scanTip') + '</div>';
      if (pw.payUrl && !qrOnly) {
        const go = document.createElement('button');
        go.className = 'btn primary'; go.style.marginTop = '8px';
        go.textContent = PTf('goPayGw', { g: gwName });
        go.onclick = () => window.open(pw.payUrl, '_blank', 'noopener');
        qrBox.appendChild(go);
      }
      setHint(PT('gwHint'));
      return;
    }

    // ② 跳转模式（PayPal redirect）
    if (act.type === 'redirect' && act.url) {
      setAcct('PayPal');
      setHint(PT('redirectHint'));
      qrBox.innerHTML = '<div style="display:flex;justify-content:center;margin-top:8px">'
        + '<button class="btn primary" id="payGoBtn">' + esc(PTf('goPayGw', { g: 'PayPal' })) + '</button></div>';
      const b = document.getElementById('payGoBtn');
      if (b) b.onclick = () => { window.location.href = act.url; };
      return;
    }

    // ③ 表单模式（支付宝收银台表单，就地嵌入自动提交）
    if (act.type === 'form' && act.html) {
      const ifr = document.createElement('iframe');
      ifr.style.cssText = 'width:100%;height:460px;border:1px solid var(--line);border-radius:8px;background:#fff';
      qrBox.innerHTML = '';
      qrBox.appendChild(ifr);
      try { const doc = ifr.contentDocument; doc.open(); doc.write(act.html); doc.close(); } catch (e) {}
      setAcct(PT('alipay'));
      setHint(PT('alipayCashier'));
      return;
    }

    // ④ 手动收款：支付宝 / 微信收款码（服务端转 Data URL 内嵌下发）
    const aImg = isQr(act.qrAlipayData || act.qrAlipay) ? (act.qrAlipayData || act.qrAlipay) : '';
    const wImg = isQr(act.qrWechatData || act.qrWechat) ? (act.qrWechatData || act.qrWechat) : '';
    const list = [];
    if (aImg) list.push({ key: 'alipay', label: PT('alipay'), src: aImg });
    if (wImg) list.push({ key: 'wechat', label: PT('wechat'), src: wImg });
    _payModes = list;
    // 默认选中客户在外层选的方式（选微信就默认显示微信码）
    const activeKey = (list.find(x => x.key === channel) ? channel : list[0].key);
    // 【去重】收款码模式下，内层「微信/支付宝」页签就是客户要选的东西；
    // 外层通道选择器此时是同一个选择的重复展示，隐藏掉，只留一个选择入口。
    if (list.length > 1) {
      // 直接移除（不只是隐藏）：DOM 里留着会让读屏/自动化看到两遍同样的「支付宝/微信」，
      // 也可能被后续逻辑重复绑定。内层页签已经是完整的选择入口。
      const outerSel = document.getElementById('channelSelector');
      if (outerSel) outerSel.remove();
      const outerTip = document.getElementById('payChooseTip');
      if (outerTip) outerTip.remove();
    }
    if (!list.length) {
      setAcct(PT('alipay') + ' / ' + PT('wechat'));
      setHint(PT('noting'));
      qrBox.innerHTML = '<div class="sub" style="text-align:center;color:var(--danger);margin:14px 0">' + esc(PT('noting')) + '</div>';
      return;
    }
    qrBox.innerHTML = chanTabs(list, activeKey)
      + '<div style="display:flex;justify-content:center;margin-top:4px">' + qrImg(list[0].src) + '</div>'
      + '<div class="sub" style="text-align:center;margin-top:6px;color:var(--muted)">' + esc(PT('noteOrder')) + ' <b style="color:var(--fg)">' + esc(orderId) + '</b></div>';
    qrBox.querySelectorAll('[data-paymode]').forEach(btn => {
      btn.onclick = () => {
        const hit = list.find(x => x.key === btn.dataset.paymode);
        if (!hit) return;
        qrBox.querySelectorAll('[data-paymode]').forEach(b => b.classList.add('ghost'));
        btn.classList.remove('ghost');
        const img = qrBox.querySelector('img');
        if (img) img.src = hit.src;
      };
    });
    setAcct(PT('alipay') + ' / ' + PT('wechat'));
    // 服务端 notice 是中文全文，直接贴到非中文界面会被 i18n 逐词机翻成混杂语；
    // 展示文案由前端按当前语言整句给出，金额/订单号弹窗里已有。
    setHint(PT('manualHint'));
  }

  // —— 买家邮箱（可选）：用于接收付款凭证与续费提醒 ——
  // 【为什么】站点订单按访客令牌追踪，从不存邮箱 → 商业闭环的通知段只能记 skipped/no_email，
  //   客户拿不到付款凭证。采集邮箱是闭环能真正送达的前提。
  // 【零摩擦】记住上次填过的地址 → 之后每次下单自动带上，不用重复输入。
  // 【不阻塞】保存失败只提示，不影响扫码付款。
  function savedEmail() {
    try { return String(localStorage.getItem('bd_email') || '').trim(); } catch (e) { return ''; }
  }
  async function attachEmail(orderId, val) {
    const mail = String(val || '').trim();
    if (!mail || !orderId) return false;
    try {
      const r = await apiStrict('/v1/subs/order/email', { method: 'POST', body: JSON.stringify({ orderId, email: mail }) });
      const hint = document.getElementById('payEmailHint');
      if (r && r.ok) {
        try { localStorage.setItem('bd_email', mail); } catch (e) {}
        if (hint) hint.textContent = '已保存，付款后自动发送凭证';
        return true;
      }
      if (hint) hint.textContent = (r && r.error) || '邮箱保存失败';
    } catch (e) { /* 网络失败不打扰付款流程 */ }
    return false;
  }

  async function subscribe(plan) {
    const o = await apiStrict('/v1/subs/order', { method: 'POST', body: JSON.stringify({ plan, lang: curLang(), email: savedEmail() }) });
    if (!o || typeof o !== 'object' || !o.order) {
      return toast(PT('orderFail') + ((o && typeof o === 'object' && o.error) ? o.error : PT('netFail')), 'bad');
    }
    const p = o.order;
    const po = document.getElementById('payOverlay');
    const paidBox = document.getElementById('payPaid'); if (paidBox) paidBox.hidden = true;
    if (po) po.hidden = false;
    // 标题用方案名称（"月度会员"）而不是原始 id（"m"）：客户看到的应该是产品，不是内部编码
    let planName = p.plan;
    try {
      const st = await api('/v1/subs/status');
      const cn = (st && st.plans && st.plans.CN) || [];
      const en = (st && st.plans && st.plans.EN) || [];
      const hit = cn.find(x => x.id === p.plan) || en.find(x => x.id === p.plan);
      if (hit && hit.label) planName = hit.label;
    } catch (e) {}
    document.getElementById('payPlan').textContent = PTf('orderTitle', { a: p.amount, c: p.currency, p: planName });
    document.getElementById('payOrderId').textContent = p.id;
    // 邮箱输入：预填上次填过的地址；失焦/回车即保存（保存失败不阻塞付款）
    const emailInput = document.getElementById('payEmail');
    if (emailInput) {
      emailInput.value = savedEmail();
      const onEmailDone = () => { attachEmail(p.id, emailInput.value); };
      emailInput.onblur = onEmailDone;
      emailInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); onEmailDone(); } };
    }
    _payModes = [];

    // 先取可用通道，按币种过滤后给买家选择（CNY：支付宝/微信收款码，USD：PayPal）
    let chans = null;
    try { chans = await apiStrict('/v1/pay/channels', null, 10000); } catch (e) {}
    const currency = p.currency;
    const availableChannels = (chans && typeof chans === 'object' && Array.isArray(chans.channels)) ? chans.channels : ['manual'];
    const channelOptions = [];
    if (currency === 'CNY') {
      // 【对客户只暴露支付方式】微信 / 支付宝。
      // 背后走个人收款码还是官方商户网关，是内部实现，客户界面与操作完全一样。
      // 后期网关探针通过后自动切过去，这里无需改、客户也无需做任何事。
      if (availableChannels.includes('alipay')) channelOptions.push({ key: 'alipay', label: PT('alipay') });
      if (availableChannels.includes('wechat')) channelOptions.push({ key: 'wechat', label: PT('wechat') });
      // 两者都没有时（收款码未配置）给个兜底项，避免弹窗空着
      if (!channelOptions.length) channelOptions.push({ key: 'manual', label: PT('online') });
      if (availableChannels.includes('moltspay')) channelOptions.push({ key: 'moltspay', label: PT('moltspay') });

    } else if (currency === 'USD') {
      if (availableChannels.includes('paypal')) channelOptions.push({ key: 'paypal', label: 'PayPal' });
      if (availableChannels.includes('moltspay')) channelOptions.push({ key: 'moltspay', label: PT('moltspay') });
      if (!channelOptions.length) channelOptions.push({ key: 'paypal', label: 'PayPal' });
    } else {
      availableChannels.forEach(c => channelOptions.push({ key: c, label: c }));
      if (!channelOptions.length) channelOptions.push({ key: 'manual', label: PT('online') });
    }
    const defaultChannel = channelOptions[0].key;
    const qrBox = document.getElementById('payQr');

    if (channelOptions.length > 1) {
      qrBox.innerHTML = '<div class="sub" style="margin-bottom:4px" id="payChooseTip">' + esc(PT('choose')) + '</div>'
        + '<div style="display:flex;justify-content:center;gap:6px;margin:2px 0 6px;flex-wrap:wrap" id="channelSelector">'
        + channelOptions.map(opt => '<button class="btn small ' + (opt.key === defaultChannel ? '' : 'ghost') + '" data-channel="' + esc(opt.key) + '">' + esc(opt.label) + '</button>').join('')
        + '</div><div id="payQrBody"></div>';
      qrBox.querySelectorAll('#channelSelector button').forEach(btn => {
        btn.onclick = () => {
          qrBox.querySelectorAll('#channelSelector button').forEach(b => b.classList.add('ghost'));
          btn.classList.remove('ghost');
          loadChannel(p.id, p.currency, btn.dataset.channel, 'payQrBody');
        };
      });
      await loadChannel(p.id, p.currency, defaultChannel, 'payQrBody');
    } else {
      await loadChannel(p.id, p.currency, defaultChannel, 'payQr');
    }

    // 【零操作 2026-10-21】轮询改由 _startPayPoll 接管：5s×240 次 → 降级 30s 慢轮询、
    // 不再彻底停（旧版停了之后客户付款回来只能手动刷新/重下单——零操作红线）。
    // 并把订单号记到弹窗上，供「切回页面即探」使用。
    if (po) { try { po.dataset.order = p.id; } catch (e) {} }
    _startPayPoll(p.id);
    hideWall();
  }
  // 买家点「我已付款」：把回传记录进订单（提醒运营核账），然后等检测。
  // 绝不在此处开通权益——那等于谁点谁白嫖；开通只认网关回调或运营令牌确认。
  async function payDone() {
    const oid = document.getElementById('payOrderId').textContent.trim();
    const pb = document.getElementById('payPaid');
    const btn = document.getElementById('payDone');
    // 【可选】客户若顺手附了转账截图就一起上传：运营看一眼就能核销，无需等 24h。
    // 没传也照样提交——绝不因为"没截图"卡住付款流程。
    let img = '';
    const fileEl = document.getElementById('payProofFile');
    const f = fileEl && fileEl.files && fileEl.files[0];
    if (f) {
      try { img = await readImageAsDataUrl(f, 1400); }
      catch (e) { /* 压缩失败不该阻断付款：忽略图片照常提交 */ }
    }
    if (btn) btn.disabled = true;
    try {
      const r = await apiStrict('/v1/pay/manual-confirm', {
        method: 'POST',
        body: JSON.stringify({ orderId: oid, visitor: vid(), image: img })
      }, 30000);
      if (!r || typeof r !== 'object') { toast(PT('netFail'), 'bad'); return; }
      if (!r.ok) { toast((r && r.error) ? r.error : PT('orderFail'), 'bad'); return; }
      if (pb) { pb.hidden = false; pb.textContent = PT('paidNow'); }
      // 【立即放行】上传凭证即开通：不问客户"付没付"，不让客户等人工。
      if (r.unlimited || r.sub) {
        hideWall();
        refreshSubs().catch(() => {});
        refreshKPI();
        toast(PT('paidToast'), 'ok');
        const po = document.getElementById('payOverlay');
        if (po) setTimeout(() => { po.hidden = true; }, 1200);
      } else {
        toast(PT('paidMark'), 'ok');
      }
    } catch (e) {
      toast(PT('orderFail') + (e.message || '?'), 'bad');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // 24h 内无内部确认 → 客户补交支付截图（重新开启 24h 核账窗口）
  // 24h 内无内部确认 → 客户补交支付截图（重新开启 24h 核账窗口）
  // 截图是必填的：运营核账要真的能看到凭证，文字说明替代不了。
// resubmitProof(orderId, note, imageDataUrl)
// 【重要】订单号必须由调用方显式传入。
// 早前实现从付款弹窗的 #payOrderId 取号，但「补交截图」提示出现在**订阅面板**里，
// 两者不是同一个上下文：客户若在下单后又开了新单，弹窗里是另一单号，
// 就会把 A 单的截图补到 B 单上——A 单继续被拦，B 单被错误放行。
// 订阅面板有权威的 d.needProofOrderId，必须用它。
async function resubmitProof(orderId, note, imageDataUrl) {
  const oid = String(orderId || '').trim() || (document.getElementById('payOrderId') || {}).textContent.trim();
  if (!oid) { toast(PT('orderFail'), 'bad'); return; }
  const btn = document.getElementById('subsProofBtn');
  if (btn) btn.disabled = true;
  try {
    const r = await apiStrict('/v1/pay/manual-resubmit', {
      method: 'POST',
      body: JSON.stringify({ orderId: oid, visitor: vid(), note: String(note || '').slice(0, 2000), image: String(imageDataUrl || '') })
    }, 30000);
    if (!r || typeof r !== 'object' || !r.ok) {
      toast((r && r.error) ? r.error : PT('netFail'), 'bad');
      return;
    }
    toast(PT('resubmitOk'), 'ok');
    if (r.unlimited || r.sub) { hideWall(); refreshSubs().catch(() => {}); }
    const np = document.getElementById('subsNeedProof');
    if (np) np.hidden = true;
  } catch (e) {
    toast(PT('orderFail') + (e.message || '?'), 'bad');
  } finally {
    if (btn) btn.disabled = false;
  }
}

  // 读图片文件 → 压缩 → data URL（客户端压缩，避免大图撑爆 3MB 上限）
  function readImageAsDataUrl(file, maxSide) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error(PT('needImage')));
      if (!/^image\//.test(file.type || '')) return reject(new Error(PT('imgTypeErr')));
      if (file.size > 12 * 1024 * 1024) return reject(new Error(PT('imgTooBig')));
      const fr = new FileReader();
      fr.onerror = () => reject(new Error(PT('imgReadErr')));
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error(PT('imgReadErr')));
        img.onload = () => {
          const side = maxSide || 1400;
          const w0 = img.width || 1, h0 = img.height || 1;
          const scale = Math.min(1, side / Math.max(w0, h0));
          const w = Math.max(1, Math.round(w0 * scale));
          const h = Math.max(1, Math.round(h0 * scale));
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          try { resolve(cv.toDataURL('image/jpeg', 0.82)); } catch (e) { reject(e); }
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  // ===== 订阅面板 =====
  async function refreshSubs() {
    const d = await api('/v1/subs/status');
    // 【零操作 2026-10-21】已开通（订阅/无限/临时权益）而墙还挂着 → 立刻自动撤墙。
    // 覆盖场景：客户付款后 >20 分钟才回页面、离线面板 60s 巡检先把状态拉到——客户不点任何按钮。
    try {
      if (d && (d.unlimited || d.sub) && !$('#wallOverlay').hidden) { hideWall(); toast(PT('paidToast'), 'ok'); }
    } catch (e) {}
    // 【契约修正 2026-10】服务端无限额度用显式 unlimited 标志（freeLeft 序列化为 null，
    // 旧代码的 `d.freeLeft === Infinity` 永远不成立 → 订阅用户显示「免费次数 null·0」）
    const free = d.wall ? '0' : ((d.sub || d.unlimited || d.freeLeft == null) ? '∞' : d.freeLeft);
    $('#subsQuotaCard').textContent = '🧾 我的额度 · 访客 ' + vid() + ' · ' + T('free') + ' ' + free + '·' + d.used;
    $('#subsStatusBox').innerHTML =
      '<span class="watch-pill">' + (d.wall ? '🔒 已到墙' : '✅ 免费可用 ' + free + ' 次') + '</span>' +
      '<span class="watch-pill">' + (d.sub ? ('已订阅 ' + esc(d.sub.plan) + ' · 剩余 ' + d.sub.daysLeft + ' 天') : '未订阅') + '</span>' +
      '<span class="watch-pill">' + (d.inviteCode && d.inviteCode.length ? '邀请码 ' + esc(d.inviteCode[0]) : '我的邀请码待生成') + '</span>' +
      (function () {
        // 【诚实面板】今日重值模块配额的实况：满的如实点亮（给明日自动恢复一个明确预期）
        try {
          const ex = Object.keys((d.pools || {})).filter(s => d.pools[s] && d.pools[s].quota && d.pools[s].left === 0);
          return ex.length ? '<span class="watch-pill" title="每日自动恢复，可升级更高套餐">今日额度满：' + esc(ex.join(' / ')) + '</span>' : '';
        } catch (e) { return ''; }
      })() +
      (d.wall ? '<button class="btn primary" onclick="BIZ.showPlans()">去订阅</button>' : '');

    // 【需补交支付截图】24h 内系统未完成核账 → 引导客户补交截图（重新开启 24h 窗口）
    if (d.needProof && d.needProofOrderId) {
      const np = document.getElementById('subsNeedProof');
      if (np) {
        np.hidden = false;
        np.innerHTML = '<div class="sub" style="color:var(--danger);margin-top:8px">' + esc(PT('needProof')) + '</div>'
          + '<div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center">'
          + '<input type="file" id="subsProofFile" accept="image/*" class="ipt" style="flex:1;min-width:200px;padding:6px">'
          + '<input class="ipt" id="subsProofNote" placeholder="' + esc(PT('proofNotePh')) + '" style="flex:1;min-width:170px">'
          + '<button class="btn primary" id="subsProofBtn">' + esc(PT('resubmitBtn')) + '</button>'
          + '</div>'
          + '<div id="subsProofPrev" class="sub" style="margin-top:6px;color:var(--muted)">' + esc(PT('proofHint')) + '</div>';
        const fileEl = document.getElementById('subsProofFile');
        const prevEl = document.getElementById('subsProofPrev');
        if (fileEl && prevEl) {
          fileEl.onchange = () => {
            const f = fileEl.files && fileEl.files[0];
            if (!f) { prevEl.textContent = PT('proofHint'); return; }
            prevEl.textContent = f.name + ' (' + Math.round(f.size / 1024) + ' KB)';
          };
        }
        const btn = document.getElementById('subsProofBtn');
        if (btn) btn.onclick = async () => {
          const fileEl2 = document.getElementById('subsProofFile');
          const f = fileEl2 && fileEl2.files && fileEl2.files[0];
          if (!f) { toast(PT('needImage'), 'bad'); return; }
          const noteEl = document.getElementById('subsProofNote');
          const note = noteEl ? noteEl.value : '';
          btn.disabled = true;
          try {
            const dataUrl = await readImageAsDataUrl(f, 1400);
            await resubmitProof(d.needProofOrderId, note, dataUrl);
          } catch (e) {
            toast((e && e.message) ? e.message : PT('imgReadErr'), 'bad');
          } finally { btn.disabled = false; }
        };
      }
    } else {
      const np = document.getElementById('subsNeedProof');
      if (np) np.hidden = true;
    }
    // 方案卡
    const grid = $('#subsPlansGrid');
    if (grid) {
      const cn = d.plans.CN || [], en = d.plans.EN || [];
      grid.innerHTML = cn.map(p => {
        const e = en.find(x => x.id === p.id) || {};
        const price = d.sub && d.sub.plan === p.id ? '（当前）' : '';
        return '<div class="subs-card' + (d.sub && d.sub.plan === p.id ? ' cur' : '') + '" onclick="BIZ.subscribe(\'' + p.id + '\')">' +
          '<div>' + esc(p.label) + ' · ' + esc(e.label || '') + '</div>' +
          '<div class="sc-price">¥' + p.amount + '</div>' +
          '<div class="sc-term">周期 ' + p.months + ' 个月 · $' + (e.amount || 0) + (price ? ' · ' + price : '') + (p.tag ? ' · ' + esc(p.tag) : '') + '</div></div>';
      }).join('');
    }
    // 订单
    const od = await api('/v1/subs/orders?limit=10');
    const oe = $('#subsOrders'); oe.hidden = false;
    if ((od.orders || []).length) {
      oe.innerHTML = (od.orders || []).map(o =>
        '<div class="row" style="gap:8px;flex-wrap:wrap;margin:2px 0">' +
        '<span>' + (o.paid ? '✅' : '⏳') + ' ' + o.amount + o.currency + ' ' + esc(o.plan) +
        ' @' + fmt(o.at) + (o.paid ? ' 已入账' : '（订单 ' + esc(o.id) + ' 待确认）') + '</span>' +
        // 已付款的订单给一个「申请退款」入口：客户自助，不再只能找人工
        (o.paid ? ' <button class="btn ghost refund-open" data-oid="' + esc(o.id) + '">' + esc(PT('refundBtn')) + '</button>' : '') +
        '</div>').join('');
      oe.querySelectorAll('.refund-open').forEach(b => b.onclick = () => openRefund(b.dataset.oid));
    } else {
      oe.textContent = '暂无订单。';
    }
  }
  // ===== 我的沉淀（数据归属层 → 留存的真实理由） =====
  // 诚实口径：资产"挂在你的账号下，到期也不会被清掉"。绝不用"续费即保住"这类假威胁——
  // 到期只收起订阅时长（sublist.expireAt），数据从不删除（core/tenancy.js 红线）。
  // 用恐吓留人，用户换台设备登录发现数据还在，信任一次性归零。
  async function refreshMyAssets() {
    const box = $('#myAssetsBox'); if (!box) return;
    const d = await api('/v1/my/assets');
    const s = (d && d.summary) || {};
    const bc = s.byCollection || {};
    const rows = Object.keys(bc).filter(c => bc[c] > 0)
      .map(c => '<span class="watch-pill">' + esc(c) + ' ' + bc[c] + '</span>');
    box.innerHTML =
      '<div class="sub" style="flex-basis:100%">' + esc(s.message || '还没有专属沉淀——多问几个问题、多沉淀几条知识。') + '</div>' +
      (rows.length ? rows.join('') : '<span class="sub">（暂无已归属资产）</span>') +
      (s.renewAnchor ? '<div class="sub" style="flex-basis:100%;opacity:.75">' + esc(s.renewAnchor) + '</div>' : '');
  }
  window.BIZ = { subscribe, refreshSubs, resubmitProof, refreshMyAssets, ensureSignedIdentity, openRefund, requestRefund, claimTrial, vid: () => vid(), showPlans: () => api('/v1/subs/status').then(d => showWall(d.plans, { trialAvail: d.freeTrialAvailable })) };
  $('#subsRefresh').onclick = () => refreshSubs();
  // —— 退款面板的按钮接线 ——
  const _rfSubmit = $('#refundSubmit');
  if (_rfSubmit) _rfSubmit.onclick = () => requestRefund();
  const _rfCancel = $('#refundCancel');
  if (_rfCancel) _rfCancel.onclick = () => { const ov = $('#refundOverlay'); if (ov) ov.hidden = true; };
  $('#subsBind').onclick = async () => {
    const code = $('#subsInviteCode').value.trim();
    if (!code) return toast('请填写邀请码', 'bad');
    const r = await api('/v1/subs/bind', { method: 'POST', body: JSON.stringify({ code }) });
    toast(r.ok ? '已绑定推荐人 ' + r.host : (r.error || '绑定失败'), r.ok ? 'ok' : 'bad');
    refreshSubs();
  };
  $('#subsTestPay').onclick = async () => {
    // 运营对账：列出待付款订单，逐单核验收款（确认即入账+激活）
    const od = await api('/v1/subs/orders?limit=30');
    const pending = (od.orders || []).filter(o => !o.paid);
    const pb = $('#subsPendingBox'); if (pb) pb.hidden = false;
    const pe = $('#subsPending'); if (!pe) return;
    pe.hidden = false;
    pe.innerHTML = pending.length
      ? pending.map(o => '<div class="row" style="gap:8px;margin:4px 0;flex-wrap:wrap"><span>⏳ ¥' + o.amount + o.currency + ' ' + esc(o.plan) + ' · <b>订单 ' + esc(o.id) + '</b> · ' + fmt(o.at) + '</span><button class="btn primary pending-confirm" data-oid="' + esc(o.id) + '">✓ 已确认收到款</button></div>').join('')
      : '暂无待确认订单——有买家付款后会列在这里等你核验。';
    pe.querySelectorAll('.pending-confirm').forEach(b => b.onclick = () => confirmOrder(b.dataset.oid));
  };
  async function confirmOrder(orderId) {
    if (!confirm('已确认收到订单 ' + orderId + ' 的转账？确认后即入账支付宝并激活订阅。')) return;
    const r = await api('/v1/subs/confirm', { method: 'POST', body: JSON.stringify({ orderId }) });
    toast(r.ok ? ('✅ 已确认到账，¥' + r.order.amount + ' 入账支付宝' + (r.inviteBonus ? '，返利 ' + r.inviteBonus.addedMonths + ' 个月' : '')) : ('确认失败：' + (r.error || '')), r.ok ? 'ok' : 'bad');
    refreshSubs(); refreshKPI(); $('#subsTestPay').click();
  }

  // ===== 排行榜 =====
  async function refreshRank() {
    const [s, m] = await Promise.all([api('/v1/rank?field=score'), api('/v1/rank?field=money')]);
    const render = field => {
      const d = field === 'score' ? s : m;
      const box = field === 'score' ? $('#rankScoreBox') : $('#rankMoneyBox');
      const rows = d.rows || [];
      box.innerHTML = rows.length ? '<table class="rank-table"><tr><th>#</th><th>名字</th><th>' + (field === 'score' ? '分数' : '金额') + '</th><th>超前一档</th></tr>' +
        rows.map(r => '<tr><td><span class="rk">' + r.rank + '</span></td><td>' + esc(r.name) + '</td><td><b>' + (field === 'score' ? r.score : '¥' + r.money) + '</b></td><td>' + (r.aheadBy == null ? '—' : '+' + r.aheadBy) + '</td></tr>').join('') + '</table>'
        : '暂无上榜。补录一条点亮榜单。';
    };
    render('score'); render('money');
    const ig = s.integrity || { ok: true };
    $('#rankIntegrity').innerHTML = '榜单完整性：' + (ig.ok ? '✅ 前一名严格 > 后一名（差值全部 ≥1）' : '⚠ ' + (ig.bad || []).map(x => esc(x.name) + ' vs ' + esc(x.next)).join('、') + ' 需补录重排');
  }
  $('#rankRefresh').onclick = () => refreshRank();
  $('#rankEnter').onclick = async () => {
    const name = $('#rankName').value.trim(), score = $('#rankScore').value.trim(), field = $('#rankField').value;
    if (!name || !score) return toast('请填写名字和分数', 'bad');
    const r = await api('/v1/rank/enter', { method: 'POST', body: JSON.stringify({ name, score, field }) });
    if (r.ok) {
      $('#rankResult').hidden = false;
      $('#rankResult').textContent = '✅ 上榜成功：' + name + ' · ' + score + (r.violated && r.violated.length ? '\n⚠ 提示：与下一位差值 <1（' + JSON.stringify(r.violated.map(x => x.diff)) + '），已自动重排' : '\n前一名差值规则已校验干净');
      refreshRank();
    } else toast(r.error || '上榜失败', 'bad');
  };

  // ===== 24h 监控 =====
  async function refreshWatch() {
    const d = await api('/v1/watch');
    $('#watchStatusBox').innerHTML =
      '<span class="watch-pill">哨兵 ' + (d.running ? '🟢 运行中' : '🔴 停止') + '</span>' +
      '<span class="watch-pill">体检周期 <b>' + Math.round((d.scanMs || 0) / 1000) + 's</b></span>' +
      '<span class="watch-pill">冷静期 <b>' + (d.cooldownMin || 30) + 'min</b></span>' +
      '<span class="watch-pill">告警邮箱 <b>' + esc(d.inbox) + '</b></span>' +
      '<span class="watch-pill">上次巡检 <b>' + (d.lastScan ? fmt(d.lastScan) : '—') + '</b></span>';
    const al = $('#watchAlerts'); al.hidden = false;
    al.textContent = (d.alerts && d.alerts.length)
      ? d.alerts.map(x => '🚨 [' + x.level.toUpperCase() + '] ' + x.title + ' — ' + x.detail).join('\n')
      : '暂无告警（一切正常）。';
    const ml = await api('/v1/mail/log?limit=8');
    const me = $('#watchMailLog'); me.hidden = false;
    me.textContent = (ml.mails || []).length
      ? ml.mails.map(x => (x.ok ? '✅' : '❌') + ' → ' + esc(x.to) + ' · ' + esc(x.subject || '') + ' · ' + fmt(x.at) + (x.error ? ' · ' + esc(x.error) : '')).join('\n')
      : '暂无外发记录（有异常触发才会发信）。';
  }
  $('#watchRefresh').onclick = () => refreshWatch();
  $('#watchScan').onclick = async () => {
    const r = await api('/v1/watch/scan');
    toast('巡检完成：发现 ' + r.count + ' 项异常，' + (r.alert.sent ? '已告警 ' + r.alert.sent + ' 信' : '无需告警'), r.count ? 'bad' : 'ok');
    refreshWatch();
  };

  // ===== 半年千万 KPI =====
  async function refreshKPI() {
    const k = await api('/v1/money/kpi');
    const pct = Math.max(0, Math.min(100, Math.round(k.pct * 10)));
    // #kpiGauge 在 KPI 面板里并不存在（进度已由面板标题 + #kpiBox 呈现）。旧代码直接
    // $('#kpiGauge').innerHTML=… 会抛 "Cannot set properties of null (setting 'innerHTML')"，
    // 整个 refreshKPI 在此中断 → KPI 面板空白 + 一条红色报错。存在才写。
    const gauge = $('#kpiGauge');
    if (gauge) gauge.innerHTML = '🎯 进度 <span class="tag">半年 ' + (k.target / 10000).toFixed(0) + ' 万</span>';
    $('#kpiBox').innerHTML =
      '<div class="panel" style="flex:1;min-width:200px"><div>真实入账（支付宝）</div><div class="kpi-big">¥' + k.revenue.toFixed(0) + '</div><div class="kpi-bar"><i style="width:' + pct + '%"></i></div><div class="sub">' + pct + '% · 已过 ' + k.daysPast + ' 天</div></div>' +
      (k.testCount ? '<div class="panel" style="flex:1;min-width:180px"><div>自测单（不计营收）</div><div class="kpi-big" style="color:#94a3b8">¥' + k.testRevenue.toFixed(0) + '</div><div class="sub">' + k.testCount + ' 笔本机联调单 · 台账全额 ¥' + k.grossRevenue.toFixed(0) + '</div></div>' : '') +
      '<div class="panel" style="flex:1;min-width:180px"><div>目标</div><div class="kpi-big">¥' + (k.target / 10000).toFixed(0) + '万</div><div class="sub">截止 ' + esc(k.inboundDate) + '</div></div>' +
      '<div class="panel" style="flex:1;min-width:180px"><div>实际日均</div><div class="kpi-big">¥' + k.regDaily.toFixed(0) + '</div><div class="sub">需求日均 ¥' + k.needDaily.toFixed(0) + '</div></div>' +
      '<div class="panel" style="flex:1;min-width:170px"><div>状态</div><div class="kpi-big">' + (k.onTrack ? '✅ 达标' : '📉 落后') + '</div><div class="sub">' + k.daysLeft + ' 天后见分晓</div></div>';
    // 营收
    const rev = await api('/v1/money/budget');
    const re = $('#moneyRevenues'); re.hidden = false;
    re.textContent = (rev.revenues || []).length
      ? rev.revenues.map(x => (/test/i.test(String(x.source || '')) ? '🧪 ' : '✅ ') + '¥' + x.amt + ' · ' + esc(x.source) + ' · ' + esc(x.method) + ' → ' + esc(x.settle) + ' · ' + fmt(x.at) + (/test/i.test(String(x.source || '')) ? '  ← 自测单，不计真实营收' : '')).join('\n')
      : '暂无营收——记一笔入账即启动半年千万征程。';
    const pe = $('#moneyPromos'); pe.hidden = false;
    pe.textContent = (rev.promos || []).length
      ? '推广池：拨备 ¥' + rev.budget.allotted.toFixed(2) + ' · 已支 ¥' + rev.budget.spent.toFixed(2) + ' · 可用 ¥' + rev.budget.avail.toFixed(2) + '\n——\n' +
        rev.promos.map(x => (x.kind === '支出' ? '📤 支 ¥' : '📥 拨 ¥') + x.amt + ' · ' + esc(x.note) + ' · ' + fmt(x.at)).join('\n')
      : '推广池空——每笔入账自动计提 5%。';
    const ld = await api('/v1/money/leads?limit=15');
    const le = $('#moneyLeads'); le.hidden = false;
    le.textContent = (ld.leads || []).length
      ? ld.leads.map(x => '🎯 [' + esc(x.source) + '] ' + esc(x.hook) + ' · ' + x.status + ' · ' + fmt(x.at)).join('\n')
      : '暂无获客线索——自主运营每轮自动铺市场。';
    // 赚钱目标无人驾驶（暗线每日闭环）
    try {
      const g = await api('/v1/goalpilot/status');
      const d = g.lastDaily || null;
      const gp = $('#goalPilotBox'); if (gp) {
        gp.hidden = false;
        gp.textContent = d
          ? '📌 今日闭环 · ' + esc(d.day) + ' · 状态「' + esc(d.status) + '」（Q' + d.quarter + ' 剩 ' + d.quarterDaysLeft + ' 天）\n' +
            '  累计 ¥' + d.kpi.revenue + ' / 目标 ¥' + (d.kpi.target / 10000).toFixed(0) + '万（' + d.kpi.pct + '%）· 今日 +¥' + d.todayRevenue + ' · 剩 ' + d.kpi.daysLeft + ' 天需日均 ¥' + d.kpi.needDaily + '\n' +
            '  本周可及 ¥' + d.milestone.weekReach + '（计划 ¥' + d.milestone.weekPlan + '）\n—— 优化目标 ——\n' +
            (d.advises || []).map(x => '  · ' + esc(x)).join('\n') +
            '\n—— 逼近动作 ——\n' + ((d.acted || []).length ? (d.acted || []).map(x => '  ✓ ' + esc(x)).join('\n') : '  本轮无外部动作（维持自主运营节奏）') +
            (g.lastWeekly
              ? '\n\n📅 本周闭环 · ' + esc(g.lastWeekly.weekKey) + ' · 状态「' + esc(g.lastWeekly.status) + '」\n' +
                '  本周 ¥' + g.lastWeekly.week.inWeek + ' / 计划 ¥' + g.lastWeekly.week.weekPlan + '（差 ¥ ' + g.lastWeekly.week.needThisWeek + '·剩 ' + g.lastWeekly.week.leftInWeek + ' 天）\n' +
                (g.lastWeekly.acted || []).map(x => '  ✓ ' + esc(x)).join('\n')
              : '')
          : '今日闭环尚未运行——点击下方"记一笔入账"或刷新触发。';
      }
    } catch (e) {}
  }
  window.__goalReport = async () => {
    try {
      const rp = await api('/v1/goalpilot/report');
      const rb = $('#goalReportBox'); if (rb) { rb.hidden = false; rb.textContent = rp.text || JSON.stringify(rp, null, 2); }
    } catch (e) { toast(e.message, 'bad'); }
  };
  $('#kpiRefresh').onclick = () => refreshKPI();
  $('#moneyCredit').onclick = async () => {
    const amt = $('#moneyAmt').value.trim(), source = $('#moneySource').value.trim();
    if (!amt || !(Number(amt) > 0)) return toast('请填写金额', 'bad');
    const r = await api('/v1/money/credit', { method: 'POST', body: JSON.stringify({ amt, source: source || '手工入账', method: $('#moneyMethod').value }) });
    toast(r.ok ? ('入账 ¥' + amt + ' → 支付宝，自动计提 5% 推广费 ¥' + r.promo) : (r.error || '入账失败'), r.ok ? 'ok' : 'bad');
    refreshKPI();
  };
  $('#promoSpend').onclick = async () => {
    const amt = $('#promoAmt').value.trim(), note = $('#promoNote').value.trim();
    if (!amt || !(Number(amt) > 0)) return toast('请填写投放金额', 'bad');
    const r = await api('/v1/money/spend', { method: 'POST', body: JSON.stringify({ amt, note: note || '自主投放' }) });
    toast(r.ok ? ('已支出 ¥' + amt + ' 推广费') : (r.error || '支出失败'), r.ok ? 'ok' : 'bad');
    refreshKPI();
  };

  // ===== 三语联动：监听语言切换 =====
  function initLangWatch() {
    const sel = $('#langSel');
    if (!sel) return;
    sel.addEventListener('change', () => {
      const lang = sel.value;
      document.body.dir = lang === 'ar' ? 'rtl' : 'ltr';
      document.body.dataset.onlang = lang;
      if ($('#subsQuotaCard')) { refreshSubs(); refreshMyAssets().catch(() => {}); }
    });
  }

  // ===== 顶栏加一个订阅状态芯片 =====
  function initChip() {
    const st = $('#sbStats');
    if (!st) return;
    const chip = document.createElement('span');
    chip.className = 'sb-chip'; chip.id = 'subsChip'; chip.title = '点开订阅面板';
    chip.style.cursor = 'pointer'; chip.style.color = 'var(--accent)'; chip.style.border = '1px solid var(--line)'; chip.style.padding = '2px 8px'; chip.style.borderRadius = '12px';
    st.parentNode.insertBefore(chip, st);
    chip.onclick = () => { const it = [...document.querySelectorAll('.nav-item')].find(x => x.dataset.tab === 'subs'); if (it) it.click(); };
    setInterval(async () => {
      try { const d = await api('/v1/subs/status'); chip.textContent = d.wall ? '🔒 订阅' + (d.unlimited ? '✓' : '') : (d.sub ? '📡 会员 ' + d.sub.daysLeft + 'd' : '🎟 免费 ' + (d.freeLeft == null ? '∞' : d.freeLeft)); }
      catch (e) { chip.textContent = '🎟 …'; }
    }, 15000);
  }

  // ===== 付款弹窗接线（真实收款）=====
  const _po = document.getElementById('payOverlay');
  const _pl = document.getElementById('payLater');
  const _pd = document.getElementById('payDone');
  if (_po && _pl) _pl.onclick = () => { _po.hidden = true; if (_payPoll) { clearInterval(_payPoll); _payPoll = null; } };
  // 「我已付款」= 回传转账凭证（留痕 + 提醒运营核账），不是开通开关
  if (_pd) _pd.onclick = () => { payDone(); };

  // ===== 收款配置（运营）=====
  const _tokSave = document.getElementById('opTokenSave');
  if (_tokSave) _tokSave.onclick = () => {
    const v = document.getElementById('opToken').value.trim();
    if (!v) return toast('请粘贴运营令牌', 'bad');
    try { localStorage.setItem('bd_adminToken', v); } catch (e) {}
    toast('✅ 运营令牌已保存', 'ok');
    loadPayConfig();
  };
  async function loadPayConfig() {
    const r = await api('/v1/subs/pay-config');
    if (!r.ok) { const st = document.getElementById('payConfigStatus'); if (st) st.textContent = '未保存令牌或令牌无效——云服务器运营请先在上方填入运营令牌。'; return; }
    const c = r.config || {};
    const a = document.getElementById('payAccountCfg'); if (a) a.value = c.receiveAccount || '';
    const q1 = document.getElementById('payQrAlipay'); if (q1) q1.value = c.receiveQrAlipay || '';
    const q2 = document.getElementById('payQrWechat'); if (q2) q2.value = c.receiveQrWechat || '';
    const st = document.getElementById('payConfigStatus');
    if (st) st.textContent = c.receiveAccount ? '当前收款账号：' + c.receiveAccount + (c.receiveQrAlipay ? ' · 已配支付宝收款码' : '') + (c.receiveQrWechat ? ' · 已配微信收款码' : '') : '未配置——买家将看到"待设置"提示。';
  }
  function isOp() {
    // 运营身份：服务端对非回环请求用 X-Admin-Token 鉴权；前端以本地存过令牌为准（首访提示获取方式）
    try { return !!localStorage.getItem('bd_adminToken'); } catch (e) { return false; }
  }
  $('#payConfigSave').onclick = async () => {
    const body = {
      receiveAccount: $('#payAccountCfg').value.trim(),
      receiveQrAlipay: $('#payQrAlipay').value.trim(),
      receiveQrWechat: $('#payQrWechat').value.trim()
    };
    if (!isOp()) return toast('请先在下方保存运营令牌，再保存收款配置', 'bad');
    const r = await api('/v1/subs/pay-config', { method: 'POST', body: JSON.stringify(body) });
    toast(r.ok ? '✅ 收款配置已保存（买家下单即可看到）' : (r.error || '保存失败'), r.ok ? 'ok' : 'bad');
    if (r.ok) loadPayConfig();
  };

  // ===== 收费墙硬网关：对 /v1/report/seven 等服务端 402 拦截 - 自动弹墙 =====
  // 【2026-10-21 诚实化】402 有两种语义，前端必须区分，否则会对**已订阅客户重复推销**：
  //   ① 未订阅 + 免费额度用完 → 弹订阅墙（收钱）
  //   ② 已订阅 + 重值功能日配额用满 → 绝不弹墙，toast 说明明日恢复 / 可升级（防重复付费）
  //（402 body 现在带 unlimited/sub/section/used/quota —— server.js gateSection 诚实化）
  function hookWall() {
    const orig = window.fetch;
    // —— 402 额度提示节流（2026-10-22）——
    // 撞墙源头打不完：已订阅用户的重值分区日限用满后，后台轮询（榜单/战情室/自动运营）
    // 与用户反复点击都会持续收到 402 → 每条都 toast 就变成连环弹窗轰炸
    //（实测「decision」「evolve」每 5 秒刷一条）。两级收敛：
    //   ① 同分区 90 秒内只提示一次（首次撞墙立刻提示，之后静默，状态本身已如实返回给调用方）；
    //   ② 5 秒合并窗口：窗口内的不同分区合并成**一条** toast，一次性说清哪些功能已到当日上限。
    const _qtAt = {};      // section → 上次提示时间
    let _qtPend = {};      // section → { used, quota }（待合并窗口）
    let _qtTimer = null;
    function quotaToast(sec, used, quota) {
      if (!sec) return;
      const now = Date.now();
      if (_qtAt[sec] && now - _qtAt[sec] < 90000) return;   // ① 同分区静默期
      _qtAt[sec] = now;
      _qtPend[sec] = { used, quota };
      if (_qtTimer) return;                                  // 已有合并窗口在跑
      _qtTimer = setTimeout(() => {
        _qtTimer = null;
        const pend = _qtPend; _qtPend = {};
        const secs = Object.keys(pend);
        if (!secs.length) return;
        // 多分区时每个都展示自己独立的 used/quota（不再只取第一个）
        const body = secs.length === 1
          ? '(' + pend[secs[0]].used + '/' + pend[secs[0]].quota + ')'
          : PT('quotaEachUsedUp');
        // 【2026-10-23 本地化】原来这里的「」与「、」是硬编码中文标点，
        // 英文/阿文界面里会冒出中文括号与顿号；改为三语模板。
        const head = secs.map(s => PTf('quotaSecQuote', { s: s })).join(PT('quotaSecJoin'));
        toast(head + PT('quotaDailyDone') + body + PT('quotaDailyHint'), 'info', 5000);
      }, 5000);
    }
    window.fetch = async (input, init) => {
      const headers = new Headers((init && init.headers) || {});
      try { headers.set('X-Visitor', vid()); } catch (e) {}
      const resp = await orig(input, Object.assign({}, init, { headers }));
      if (resp.status === 402) {
        try {
          const d = await resp.clone().json();
          if (d && (d.unlimited || (d.sub && d.sub.plan))) {
            quotaToast(d.section || '', (d.used != null) ? d.used : '?', (d.quota != null) ? d.quota : '?');
          } else {
            showWall(d.plans, { trialAvail: d.trialAvail });
          }
        } catch (e) {}
      }
      return resp;
    };
  }

  // ===== 买卖交互 + 初始化 =====
  function bindTabs() {
    $$('.nav-item[data-tab="subs"]').forEach(a => a.addEventListener('click', () => { refreshSubs().catch(e => toast(e.message, 'bad')); refreshMyAssets().catch(() => {}); loadPayConfig().catch(() => {}); }));
    $$('.nav-item[data-tab="rank"]').forEach(a => a.addEventListener('click', () => refreshRank().catch(e => toast(e.message, 'bad'))));
    $$('.nav-item[data-tab="watch"]').forEach(a => a.addEventListener('click', () => refreshWatch().catch(e => toast(e.message, 'bad'))));
    $$('.nav-item[data-tab="kpi"]').forEach(a => a.addEventListener('click', () => refreshKPI().catch(e => toast(e.message, 'bad'))));
  }

  // ===== 退款申请（客户自助入口）=====
  // 【为什么】服务端已有完整的退款状态机（requested → 实际出款 → refunded），
  //   但界面**没有入口** → 客户只能找人工，运营手工改库。
  // 【诚实】申请 ≠ 已退款：界面只在系统确认出款后才显示「已退款」。
  let _refundOrderId = '';
  async function refundStatus(orderId) {
    const r = await apiStrict('/v1/pay/refund/status?orderId=' + encodeURIComponent(String(orderId || '')));
    return (r && r.ok && r.found) ? r : null;
  }
  function renderRefundStatus(st) {
    const hint = $('#refundHint'); if (!hint) return;
    const sub = $('#refundSubmit');
    if (st && st.status === 'refunded') {
      hint.textContent = PT('refundDone');
      hint.style.color = 'var(--danger)';
      if (sub) sub.disabled = true;
    } else if (st) {
      hint.textContent = PT('refundPending') + (st.amount ? (' · ' + st.currency + ' ' + st.amount) : '');
      hint.style.color = 'var(--muted)';
      if (sub) sub.disabled = true;   // 已有申请在处理中 → 不重复提交
    }
  }
  async function openRefund(orderId) {
    const oid = String(orderId || '').trim();
    if (!oid) return;
    _refundOrderId = oid;
    const ov = $('#refundOverlay'); if (!ov) return;
    const info = $('#refundInfo'); const hint = $('#refundHint'); const reason = $('#refundReason');
    const sub = $('#refundSubmit');
    if (reason) { reason.value = ''; reason.placeholder = PT('refundReasonPh'); }
    if (hint) { hint.textContent = PT('refundHint'); hint.style.color = 'var(--muted)'; }
    if (sub) { sub.disabled = false; sub.textContent = PT('refundSubmit'); }
    ov.hidden = false;
    // 订单信息（金额/方案）来自「我的订单」列表 —— 只显示自己的订单
    let amount = '', currency = '', plan = '', found = false;
    try {
      const od = await api('/v1/subs/orders?limit=30');
      const hit = (od && od.orders || []).find(o => o.id === oid);
      if (hit) { amount = hit.amount; currency = hit.currency; plan = hit.plan; found = true; }
    } catch (e) {}
    if (info) {
      info.textContent = found
        ? PTf('refundOrder', { a: oid, b: (currency === 'CNY' ? '¥' : (currency || '')) + (amount || ''), c: plan || '' })
        : (oid + ' · ' + PT('refundUnknown'));
    }
    const st = await refundStatus(oid);
    if (st) renderRefundStatus(st);
  }
  async function requestRefund() {
    const oid = _refundOrderId;
    if (!oid) return;
    const reason = (($('#refundReason') || {}).value) || '';
    const sub = $('#refundSubmit');
    if (sub) { sub.disabled = true; sub.textContent = '…'; }
    const r = await apiStrict('/v1/pay/refund', {
      method: 'POST', body: JSON.stringify({ orderId: oid, reason: String(reason).slice(0, 300) })
    });
    if (sub) { sub.disabled = false; sub.textContent = PT('refundSubmit'); }
    if (!r) { toast(PT('refundFailed') + PT('netFail'), 'bad'); return; }
    if (r.ok) {
      const hint = $('#refundHint'); if (hint) { hint.textContent = PT('refundOk'); hint.style.color = 'var(--muted)'; }
      if (sub) sub.disabled = true;
      toast(PT('refundOk'), 'ok');
      refreshSubs();
    } else {
      toast(PT('refundFailed') + (r.error || ''), 'bad');
      const hint = $('#refundHint'); if (hint) { hint.textContent = (r.error || PT('refundFailed')); hint.style.color = 'var(--danger)'; }
    }
  }
  // ===== 深链接（邮件里的「续费」「申请退款」入口直接落到对应界面）=====
  // 收据 / 到期提醒邮件里的链接形如：
  //   <站点>/?plan=m        → 直接打开该方案的付款界面（续费零绕路）
  //   <站点>/?refund=<订单> → 直接打开退款申请面板
  function applyDeepLink() {
    let q = null;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    if (!q) return;
    const plan = q.get('plan');
    const refund = q.get('refund');
    if (plan) { try { subscribe(plan); } catch (e) {} return; }
    if (refund) { try { openRefund(refund); } catch (e) {} }
  }
  function boot() {
    // 先把身份升级成服务端签发的：否则客户换网络/代理就会变成新访客，付了钱的订阅会消失
    // 签的是同一个 key → 身份不变、订阅不丢，fire-and-forget 即可
    ensureSignedIdentity().catch(() => {});
    hookWall();
    bindTabs();
    initLangWatch();
    setTimeout(initChip, 800);
    setTimeout(() => { refreshSubs().catch(() => {}); refreshMyAssets().catch(() => {}); }, 1000);
    setInterval(() => { refreshSubs().catch(() => {}); }, 60000);
    // 【零操作 2026-10-21】客户从支付/收款 App 切回页面的那一刻立即探测：
    // 后台标签页定时器被浏览器冻结过，回来这一刻最多错余 1 个轮询周期（或旧版已彻底停轮）
    // ——切回即探一次订单状态 + 订阅状态；若付款弹窗还开着而轮询已停，则恢复慢轮询。
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      (async () => {
        try {
          const payEl = document.getElementById('payOverlay');
          const payOpen = !!(payEl && !payEl.hidden);
          const oid = (payEl && payEl.dataset.order) || '';
          const d = await api('/v1/subs/status');
          if (d && (d.unlimited || d.sub)) {
            // 已开通：撤墙；付款弹窗若还开着一并收掉（等价于支付路径的自动收尾）
            hideWall();
            if (payOpen) { payEl.hidden = true; toast(PT('paidToast'), 'ok'); }
            refreshSubs();
            return;
          }
          if (!payOpen || !oid) return;
          const st = await apiStrict('/v1/pay/status?order=' + encodeURIComponent(oid), null, 8000).catch(() => null);
          if (st && typeof st === 'object' && st.paid) {
            if (_payPoll) { clearInterval(_payPoll); _payPoll = null; }
            payEl.hidden = true;
            hideWall(); refreshSubs();
            if (typeof refreshKPI === 'function') { try { refreshKPI(); } catch (e) {} }
            toast(PT('paidToast'), 'ok');
            return;
          }
          // 未付且弹窗开着：若轮询已不存在（旧版 240 次耗尽 / 异常清理），恢复一轮慢轮询
          if (!_payPoll) _startPayPoll(oid);
        } catch (e) {}
      })();
    });
    // 深链接必须在**身份签发之后**执行：订单要归属到正确的访客，否则订单/退款都对不上
    ensureSignedIdentity().then(() => { applyDeepLink(); }).catch(() => {});
  }
  document.addEventListener('DOMContentLoaded', boot);
  return { boot, subscribe, refreshSubs, refreshMyAssets, refreshRank, refreshWatch, refreshKPI, vid, ensureSignedIdentity, openRefund, requestRefund, applyDeepLink };
})();