/* page-i18n.js — 三个独立页（download / activate / architecture）的语言运行时。
 *
 * 设计取舍：这三个页面是**独立 HTML**，不加载 app.js / i18n.js 那套（那套假定有 SPA 外壳）。
 * 所以这里给一份自足的小运行时：整页按「中文原文 → 译文」字典替换 DOM 文本节点与
 * placeholder/title 属性，并用 MutationObserver 覆盖 JS 动态插入的内容。
 * 它只认**字典里有的**中文；没收录的中文会在控制台报出来（下面 warnMissing），
 * 便于"不放过任何一处漏翻"——这正是"语言不能乱"的验收方式。
 *
 * 用法：页面在 </body> 前加一行 <script src="page-i18n.js?v=..."></script>。
 * JS 里要翻译的串用 PGT('中文原文')，带变量的用 PGT('模板 {x}', {x: v})。
 */
(function () {
  'use strict';
  var LANGS = { zh: 1, en: 1, ar: 1 };

  // ── 字典：键 = 页面上的中文原文（首尾空白会被忽略）──────────────────────
  var D = {
    // ===== 通用标点碎片（整段中文被标签拆开时，这些都是独立文本节点）=====
    '。': { en: '.', ar: '.' },
    '，': { en: ',', ar: '،' },
    '：': { en: ':', ar: ':' },
    '；': { en: ';', ar: '؛' },
    '（': { en: ' (', ar: ' (' },
    '）': { en: ')', ar: ')' },
    '、': { en: ', ', ar: '، ' },
    '天': { en: ' days', ar: ' يومًا' },
    '查看套餐与价格 →': { en: 'View plans and pricing →', ar: 'اعرض الخطط والأسعار →' },
    '打开网页版': { en: 'Open web version', ar: 'افتح نسخة الويب' },
    '套餐与价格': { en: 'Plans and pricing', ar: 'الخطط والأسعار' },
    '是': { en: 'Yes', ar: 'نعم' },
    '否': { en: 'No', ar: 'لا' },
    '激活失败': { en: 'Activation failed', ar: 'فشل التفعيل' },

    // ===== activate.html =====
    '丙大山AI · 激活授权': { en: 'BingDashan AI · Activate licence', ar: 'BingDashan AI · تفعيل الترخيص' },
    '激活授权': { en: 'Activate licence', ar: 'تفعيل الترخيص' },
    '把运营方签发的授权码粘进来，本机所有付费功能立即开通。': {
      en: 'Paste the licence key issued by the operator and every paid feature on this device unlocks immediately.',
      ar: 'الصق مفتاح الترخيص الصادر من المشغّل وسيُفعَّل كل شيء مدفوع على هذا الجهاز فورًا.'
    },
    '无法连接本机服务': { en: 'Cannot reach the local service', ar: 'تعذّر الوصول إلى الخدمة المحلية' },
    '这个页面需要由**你本机的丙大山AI 客户端**提供（地址形如': {
      en: 'This page must be served by your local BingDashan AI client (address like',
      ar: 'يجب أن تُقدَّم هذه الصفحة عبر عميل BingDashan AI المحلي لديك (العنوان مثل'
    },
    '）。': { en: ').', ar: ').' },
    '）。如果你是在公网网站上打开它，请改为：先安装并打开桌面/手机版 App，在 App 内打开「激活」页。': {
      en: '). If you opened it on the public website, install and open the desktop/mobile app instead, then open the “Activate” page inside the app.',
      ar: '). إذا فتحتها على الموقع العام، فبدلًا من ذلك ثبِّت تطبيق الحاسوب/الجوال وافتحه، ثم افتح صفحة «تفعيل» داخل التطبيق.'
    },
    '离线授权码是**签名校验**：破解者无法伪造授权码，但有能力改本机程序的人仍可能绕过离线校验。要做到“绝对绕不过”，请使用': {
      en: 'An offline key is a signed check: no one can forge a key, but anyone able to modify the local program can still bypass offline verification. For a guarantee that cannot be bypassed, use',
      ar: 'المفتاح دون اتصال تحقّق موقَّع: لا يمكن تزوير المفتاح، لكن من يستطيع تعديل البرنامج المحلي قد يتجاوز التحقّق دون اتصال. لضمان لا يمكن تجاوزه، استخدم'
    },
    '：让 App 只作为客户端连到运营方的服务器，权益与计费都在服务器上判定。两种模式的部署方式见仓库中的': {
      en: ': the app acts only as a client to the operator’s server; entitlements and billing are decided on the server. Deployment for both modes is described in the repository file',
      ar: ': يعمل التطبيق كعميل فقط لخادم المشغّل، وتُحدَّد الحقوق والفوترة على الخادم. نشر النمطين موضَّح في ملف المستودع'
    },
    '如果你是在公网网站上打开它，请改为：先安装并打开桌面/手机版 App，在 App 内打开「激活」页。': {
      en: 'If you opened it on the public website, install and open the desktop/mobile app instead, then open the “Activate” page inside the app.',
      ar: 'إذا فتحتها على الموقع العام، فبدلًا من ذلك ثبِّت تطبيق الحاسوب/الجوال وافتحه، ثم افتح صفحة «تفعيل» داخل التطبيق.'
    },
    '当前授权状态': { en: 'Current licence status', ar: 'حالة الترخيص الحالية' },
    '状态': { en: 'Status', ar: 'الحالة' },
    '套餐': { en: 'Plan', ar: 'الخطة' },
    '到期时间': { en: 'Expires', ar: 'تاريخ الانتهاء' },
    '剩余天数': { en: 'Days left', ar: 'الأيام المتبقية' },
    '买家备注': { en: 'Buyer note', ar: 'ملاحظة المشتري' },
    '设备绑定': { en: 'Device binding', ar: 'ربط الجهاز' },
    '本机机器码': { en: 'Device fingerprint', ar: 'بصمة الجهاز' },
    '复制机器码': { en: 'Copy fingerprint', ar: 'نسخ البصمة' },
    '解绑（换设备用）': { en: 'Unbind (to switch device)', ar: 'إلغاء الربط (لتغيير الجهاز)' },
    '需要锁定设备时：把上面的机器码发给客服，客服签发一枚绑定该设备的授权码；换机时先在这里解绑。': {
      en: 'To lock to a device: send the fingerprint above to support, and they will issue a key bound to that device; to switch devices, unbind here first.',
      ar: 'لقفل الجهاز: أرسل البصمة أعلاه إلى الدعم ليصدر مفتاحًا مرتبطًا بذلك الجهاز؛ وعند تغيير الجهاز ألغِ الربط هنا أولًا.'
    },
    '粘贴授权码激活': { en: 'Paste a key to activate', ar: 'الصق مفتاحًا للتفعيل' },
    'BDS1-……（客服发给你的整串授权码）': {
      en: 'BDS1-… (the whole key support sent you)',
      ar: 'BDS1-… (المفتاح الكامل الذي أرسله لك الدعم)'
    },
    '激活': { en: 'Activate', ar: 'تفعيل' },
    '还没拿到授权码？': { en: 'No key yet?', ar: 'ليس لديك مفتاح بعد؟' },
    '在 App 里打开付费功能': { en: 'Open a paid feature in the app', ar: 'افتح ميزة مدفوعة في التطبيق' },
    '，会看到订阅/购买提示与价格。': { en: ', and you will see the subscription/purchase prompt and price.', ar: '، وسترى عرض الاشتراك/الشراء والسعر.' },
    '按提示付款': { en: 'Pay as prompted', ar: 'ادفع حسب الإرشاد' },
    '（运营方确认到账后才会签发——不存在“付款后自动给码”的假承诺）。': {
      en: ' (the key is issued only after the operator confirms payment — there is no false claim of an automatic key right after paying).',
      ar: ' (يصدر المفتاح فقط بعد تأكيد المشغّل للدفع — لا وعد كاذب بمفتاح تلقائي فور الدفع).'
    },
    '把机器码发给客服': { en: 'Send your fingerprint to support', ar: 'أرسل بصمتك إلى الدعم' },
    '（若要绑定设备，点上面的「复制机器码」）。': { en: ' (to bind a device, click “Copy fingerprint” above).', ar: ' (لربط جهاز، انقر «نسخ البصمة» أعلاه).' },
    '把收到的授权码粘到上面': { en: 'Paste the key you received above', ar: 'الصق المفتاح الذي استلمته أعلاه' },
    '，点「激活」。': { en: ', then click “Activate”.', ar: '، ثم انقر «تفعيل».' },
    '关于授权方式（如实说明）': { en: 'About licensing (honest note)', ar: 'حول الترخيص (ملاحظة صادقة)' },
    '离线授权码是**签名校验**：破解者无法伪造授权码，但有能力改本机程序的人仍可能绕过离线校验。': {
      en: 'An offline key is a signed check: no one can forge a key, but anyone able to modify the local program can still bypass offline verification.',
      ar: 'المفتاح دون اتصال تحقّق موقَّع: لا يمكن تزوير المفتاح، لكن من يستطيع تعديل البرنامج المحلي قد يتجاوز التحقّق دون اتصال.'
    },
    '要做到“绝对绕不过”，请使用': { en: 'For a guarantee that cannot be bypassed, use', ar: 'لضمان لا يمكن تجاوزه، استخدم' },
    '托管模式': { en: 'hosted mode', ar: 'النمط المُستضاف' },
    '：让 App 只作为客户端连到运营方的服务器，权益与计费都在服务器上判定。': {
      en: ': the app acts only as a client to the operator’s server; entitlements and billing are decided on the server.',
      ar: ': يعمل التطبيق كعميل فقط لخادم المشغّل، وتُحدَّد الحقوق والفوترة على الخادم.'
    },
    '两种模式的部署方式见仓库中的': { en: 'Deployment for both modes is described in the repository file', ar: 'نشر النمطين موضَّح في ملف المستودع' },
    '运营端自检': { en: 'Operator self-check', ar: 'فحص ذاتي للمشغّل' },
    '客户端模式': { en: 'Client mode', ar: 'نمط العميل' },
    '已配置授权公钥': { en: 'Signing key configured', ar: 'المفتاح العام مُهيّأ' },
    '若“已配置授权公钥”为否，说明本机没有任何可信任的签发公钥：请让运营方执行': {
      en: 'If “signing key configured” is No, this device trusts no signing key: ask the operator to run',
      ar: 'إذا كان «المفتاح العام مُهيّأ» = لا، فهذا الجهاز لا يثق بأي مفتاح توقيع: اطلب من المشغّل تنفيذ'
    },
    '，并把生成的': { en: ', and ship the generated', ar: ', وشحن الملف المُنشأ' },
    '随安装包一起发布。': { en: 'with the installer.', ar: 'مع حزمة التثبيت.' },
    '丙大山AI · 授权码由运营方私钥签发，客户端只持有公钥（Ed25519 签名校验）': {
      en: 'BingDashan AI · keys are signed with the operator’s private key; the client holds only the public key (Ed25519 signature check)',
      ar: 'BingDashan AI · تُوقَّع المفاتيح بالمفتاح الخاص للمشغّل؛ ويملك العميل المفتاح العام فقط (تحقّق توقيع Ed25519)'
    },
    // ---- activate.html 动态串 ----
    '体验（7 天）': { en: 'Trial (7 days)', ar: 'تجربة (7 أيام)' },
    '月付（30 天）': { en: 'Monthly (30 days)', ar: 'شهري (30 يومًا)' },
    '季付（90 天）': { en: 'Quarterly (90 days)', ar: 'ربع سنوي (90 يومًا)' },
    '年付（365 天）': { en: 'Yearly (365 days)', ar: 'سنوي (365 يومًا)' },
    '买断（永久）': { en: 'Lifetime', ar: 'مدى الحياة' },
    '已激活': { en: 'Activated', ar: 'مُفعَّل' },
    '有其他有效订阅': { en: 'Another active subscription', ar: 'اشتراك نشط آخر' },
    '未激活': { en: 'Not activated', ar: 'غير مُفعَّل' },
    '已绑定本机': { en: 'Bound to this device', ar: 'مرتبط بهذا الجهاز' },
    '未绑定（可换机）': { en: 'Not bound (device can change)', ar: 'غير مرتبط (يمكن تغيير الجهاز)' },
    '是（这是下载/安装后的客户端）': { en: 'Yes (an installed client)', ar: 'نعم (عميل مُثبَّت)' },
    '否（这是运营端/托管实例）': { en: 'No (an operator/hosted instance)', ar: 'لا (نسخة مشغّل/مُستضافة)' },
    '本机未配置授权公钥，授权码将无法校验': { en: 'No signing key configured; keys cannot be verified', ar: 'لا يوجد مفتاح توقيع مهيّأ؛ لا يمكن التحقق من المفاتيح' },
    '机器码已复制，发给客服即可': { en: 'Fingerprint copied — send it to support', ar: 'تم نسخ البصمة — أرسلها إلى الدعم' },
    '已选中机器码，请按 Ctrl/Cmd+C 复制': { en: 'Fingerprint selected — press Ctrl/Cmd+C to copy', ar: 'تم تحديد البصمة — اضغط Ctrl/Cmd+C للنسخ' },
    '请先粘贴授权码。': { en: 'Paste a key first.', ar: 'الصق مفتاحًا أولًا.' },
    '校验中…': { en: 'Verifying…', ar: 'جارٍ التحقّق…' },
    '网络/服务异常：': { en: 'Network/service error: ', ar: 'خطأ في الشبكة/الخدمة: ' },
    '激活成功：{plan}，到期 {date}。': { en: 'Activated: {plan}, expires {date}.', ar: 'تم التفعيل: {plan}، ينتهي {date}.' },
    '解绑后本机的授权权益会立即收回（用于把这枚码换到别的设备）。确定解绑？': {
      en: 'After unbinding, this device’s licence is revoked immediately (to move the key to another device). Unbind?',
      ar: 'بعد إلغاء الربط يُسحب ترخيص هذا الجهاز فورًا (لنقل المفتاح إلى جهاز آخر). إلغاء الربط؟'
    },
    '已解绑，可在另一台设备激活': { en: 'Unbound — you can activate on another device', ar: 'تم إلغاء الربط — يمكنك التفعيل على جهاز آخر' },
    '解绑失败：': { en: 'Unbind failed: ', ar: 'فشل إلغاء الربط: ' },
    '这串码格式不对——请复制**完整**的授权码（以 BDS1- 开头），不要漏字符或带空格换行。': {
      en: 'Bad format — copy the complete key (starting with BDS1-), with no missing characters, spaces or line breaks.',
      ar: 'تنسيق غير صحيح — انسخ المفتاح كاملًا (يبدأ بـ BDS1-) دون نقص أحرف أو مسافات أو أسطر.'
    },
    '签名校验不通过：这串码被改过，或者它根本不是本产品的运营方签发的。请联系客服重发。': {
      en: 'Signature check failed: the key was modified, or it was not issued by this product’s operator. Contact support to reissue.',
      ar: 'فشل التحقق من التوقيع: تم تعديل المفتاح أو أنه ليس صادرًا من مشغّل هذا المنتج. تواصل مع الدعم لإعادة الإصدار.'
    },
    '授权码内容损坏，请让客服重新签发。': { en: 'The key content is corrupted; ask support to reissue.', ar: 'محتوى المفتاح تالف؛ اطلب من الدعم إعادة الإصدار.' },
    '这枚授权码已过期。请在提示的到期日之后联系客服续期／重新签发。': {
      en: 'This key has expired. Contact support after the expiry date to renew or reissue.',
      ar: 'انتهت صلاحية هذا المفتاح. تواصل مع الدعم بعد تاريخ الانتهاء للتجديد أو إعادة الإصدار.'
    },
    '这枚授权码绑定的是**另一台设备**。请在该设备上激活；或联系客服解绑后重发。': {
      en: 'This key is bound to a different device. Activate it on that device, or contact support to unbind and reissue.',
      ar: 'هذا المفتاح مرتبط بجهاز آخر. فعِّله على ذلك الجهاز، أو تواصل مع الدعم لإلغاء الربط وإعادة الإصدار.'
    },
    '这枚授权码已经在本机被另一个账号激活过了，不能重复使用。': {
      en: 'This key was already activated on this device by another account and cannot be reused.',
      ar: 'تم تفعيل هذا المفتاح مسبقًا على هذا الجهاز بحساب آخر ولا يمكن إعادة استخدامه.'
    },
    '本机没有内置任何可信任的签发公钥，无法校验授权码。请让运营方执行 npm run license:keygen 并随安装包发布 license.pub。': {
      en: 'No trusted signing key is built in, so keys cannot be verified. Ask the operator to run npm run license:keygen and ship license.pub with the installer.',
      ar: 'لا يوجد مفتاح توقيع موثوق مدمج، لذا لا يمكن التحقق من المفاتيح. اطلب من المشغّل تنفيذ npm run license:keygen وشحن license.pub مع حزمة التثبيت.'
    },
    '本机没有签发私钥（私钥只应存在于运营方，不该出现在客户端）。': {
      en: 'No signing private key here (it belongs to the operator only, never the client).',
      ar: 'لا يوجد مفتاح خاص للتوقيع هنا (يخصّ المشغّل فقط ولا يجب أن يكون في العميل).'
    }
  };

  // 由页面通过 PG_EXTRA 追加（见 download.html / architecture.html）
  if (window.PG_EXTRA) for (var k in window.PG_EXTRA) D[k] = window.PG_EXTRA[k];

  function detect() {
    var n;
    try { n = new URLSearchParams(location.search).get('lang'); if (n) return norm(n); } catch (e) {}
    try { n = localStorage.getItem('bd_page_lang'); if (n) return norm(n); } catch (e) {}
    try { n = norm(navigator.language); if (n) return n; } catch (e) {}
    return 'zh';
  }
  function norm(c) {
    c = String(c || '').toLowerCase();
    if (c.indexOf('ar') === 0) return 'ar';
    if (c.indexOf('zh') === 0 || c.indexOf('cn') === 0) return 'zh';
    if (c.indexOf('en') === 0) return 'en';
    return null;
  }
  var lang = detect();
  var missing = {};
  // 归一化索引：键与页面文本都做「宽松归一」后比较——去首尾空白、内部空白压成一个空格、
  // 全角/半角引号与各种破折号统一。这样 HTML 里跨行的中文、以及“ ”与 " 混用都能命中。
  function nk(s) {
    return String(s == null ? '' : s).trim()
      .replace(/[\u00a0\u3000]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
      .replace(/[\u201c\u201d\u201f\u2033]/g, '"')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-');
  }
  var DN = {};
  Object.keys(D).forEach(function (k) { DN[nk(k)] = D[k]; });

  function tr(src) {
    var e = DN[nk(src)];
    if (!e) { if (lang !== 'zh') missing[nk(src).slice(0, 40)] = (missing[nk(src).slice(0, 40)] || 0) + 1; return null; }
    var v = e[lang];
    return (v === undefined || v === null) ? null : v;
  }
  function PGT(src, vars) {
    var s = tr(src) || src;
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return (vars[k] === undefined ? m : String(vars[k])); });
    return s;
  }

  function walk(root) {
    if (lang === 'zh' || !root) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var jobs = [], n;
    while ((n = w.nextNode())) {
      var p = n.parentElement;
      if (!p) continue;
      var tag = p.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;        // 别去翻译源码文本
      if (p.id === 'pgLangBar' || (p.closest && p.closest('#pgLangBar'))) continue;  // 语言条自身不动
      var raw = n.nodeValue || '';
      var middle = raw.trim();
      if (!middle || !/[\u4e00-\u9fff]/.test(middle)) continue;                      // 无中文则跳过
      var v = tr(middle);
      if (v === null) continue;
      var at = raw.indexOf(middle);
      jobs.push([n, raw.slice(0, at) + v + raw.slice(at + middle.length)]);          // 保留首尾空白
    }
    for (var i = 0; i < jobs.length; i++) jobs[i][0].nodeValue = jobs[i][1];
    // 属性
    var els = root.querySelectorAll ? root.querySelectorAll('[placeholder],[title],[aria-label]') : [];
    for (var j = 0; j < els.length; j++) {
      ['placeholder', 'title', 'aria-label'].forEach(function (a) {
        var val = els[j].getAttribute(a);
        if (!val || !/[\u4e00-\u9fff]/.test(val)) return;
        var v = tr(val.trim());
        if (v !== null) els[j].setAttribute(a, v);
      });
    }
  }

  function apply() {
    if (lang === 'zh') return;
    walk(document.body);
    if (document.title) { var t = document.title.trim(); var v = tr(t); if (v !== null) document.title = v; }
  }

  function mount() {
    try {
      document.documentElement.lang = lang === 'ar' ? 'ar' : (lang === 'zh' ? 'zh-CN' : 'en');
      if (lang === 'ar') { document.documentElement.dir = 'rtl'; document.body.style.direction = 'rtl'; }
      apply();
      // 动态内容跟随
      var obs = new MutationObserver(function () { apply(); });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      // 切语言：写本地并重载（三个静态页无需热切换，重载最稳）
      var bar = document.createElement('div');
      bar.id = 'pgLangBar';
      bar.setAttribute('dir', 'ltr');
      Object.assign(bar.style, {
        position: 'fixed', top: '10px', right: '10px', zIndex: 9999, display: 'flex', gap: '6px',
        background: 'rgba(17,24,32,.9)', border: '1px solid #1e2a38', borderRadius: '999px', padding: '4px 6px'
      });
      [['zh', '中文'], ['en', 'EN'], ['ar', 'ع']].forEach(function (p) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = p[1];
        Object.assign(b.style, {
          background: p[0] === lang ? '#10b981' : 'transparent', color: p[0] === lang ? '#051d13' : '#e8edf2',
          border: 'none', borderRadius: '999px', padding: '4px 10px', cursor: 'pointer', fontSize: '12px', fontFamily: 'inherit'
        });
        b.onclick = function () { try { localStorage.setItem('bd_page_lang', p[0]); } catch (e) {} location.reload(); };
        bar.appendChild(b);
      });
      document.body.appendChild(bar);
      if (Object.keys(missing).length && window.console) {
        console.warn('[page-i18n] ' + lang + ' 未收录的中文（' + Object.keys(missing).length + ' 处）:', missing);
      }
    } catch (e) {
      if (window.console) console.warn('[page-i18n] mount failed', e);
    }
  }

  window.PGT = PGT;
  window.PG = { lang: lang, t: tr, apply: apply, missing: missing, dict: D };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
