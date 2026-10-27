/* ============================================================
   landing-i18n.js — 落地页多语言（zh / en / ar）
   约定：
   1) 中文原文即词条 key。zh：原文即译文；en/ar：预定义翻译。
   2) 动态内容由 MutationObserver 处理，支持 alt/title/placeholder 本地化。
   3) RTL：阿拉伯语启用 dir=rtl。
   ============================================================ */
(function () {
  'use strict';

  var LDICT = {
    en: {
      'Agent 驾驶舱 · 全功能订阅': 'Agent Cockpit · Full-feature subscription',
      '把 AI 变成你的': 'Turn AI into your',
      '可复用生产力': 'reusable productivity',
      '决策框架·组织大脑·内容铸造·获客闭环——一个订阅，全模块无限用': 'Decision frameworks · Org brain · Content casting · Growth loop — one subscription, every module unlimited',
      '首7天体验 ¥1': 'First 7 days $1',
      '首7天体验': 'First 7 days',
      '/7天': '/7 days',
      '¥1': '$1', '¥99': '$12', '¥269': '$29', '¥899': '$119',
      '/月': '/mo', '/季': '/qtr', '/年': '/yr',
      '每人限一次 · 7 天全功能体验 · 到期后按 ¥99/月续订（可随时取消）': 'Once per person · 7 days full access · renews at $12/mo (cancel anytime)',
      '立即开通 ¥1（7 天）': 'Start now for $1 (7 days)',
      '深度思考 / 决策框架 / Agent 会诊': 'Deep thinking / Decision frameworks / Agent consult',
      '内容铸造 / 游戏制作 / 音乐制作': 'Content casting / Game making / Music making',
      '获客闭环 / 指挥塔 / 组织大脑': 'Growth loop / Command tower / Org brain',
      '学习进化 / 记忆中心 / 自主运营': 'Learning & evolution / Memory hub / Autopilot',
      '最灵活': 'Most flexible',
      '月度': 'Monthly', '季度': 'Quarterly', '年度': 'Yearly',
      '随时停 · 无长期绑定 · 适合先跑通一个项目再决定': 'Cancel anytime · No lock-in · Great for proving one project first',
      '订阅月度 ¥99': 'Subscribe Monthly $12',
      '包含首7天体验所有功能': 'Everything in the first-7-days plan',
      '无使用次数限制': 'No usage limits',
      '优先获得新功能': 'Early access to new features',
      '省 9%': 'Save 9%',
      '折合 ¥89.7/月 · 适合已有稳定产出节奏的团队': '≈$9.67/mo · for teams with a steady output rhythm',
      '订阅季度 ¥269': 'Subscribe Quarterly $29',
      '包含月度所有权益': 'Everything in Monthly',
      '季度账单一次搞定': 'One quarterly bill',
      '省 24%': 'Save 24%',
      '折合 ¥74.9/月 · 最大折扣 · 锁定一年价格': '≈$9.92/mo · biggest discount · lock the price for a year',
      '订阅年度 ¥899': 'Subscribe Yearly $119',
      '包含季度所有权益': 'Everything in Quarterly',
      '邀请返利：1 付费好友送 1 月 · 10 付费好友送 1 年': 'Referrals: 1 paying friend = 1 month free · 10 = 1 year free',
      '三步开通，即刻生效': 'Live in three steps',
      '选方案下单': 'Pick a plan',
      '点击上方任意方案，系统生成唯一订单号': 'Click any plan above and we generate a unique order number',
      '扫码付款': 'Pay by code',
      '国内用支付宝 / 微信扫码，海外用 PayPal，备注写上订单号': 'Scan with Alipay / WeChat in China, PayPal overseas — put the order number in the note',
      '自动/人工确认': 'Auto / manual confirmation',
      '汇款截图回传或等待运营核销，订阅即时生效，全功能解锁': 'Send the payment screenshot or wait for confirmation; your subscription activates instantly',
      '功能截图': 'Screenshots',
      '以下截图来自本产品的真实控制台，非示意图。': 'These are real screenshots of the actual product console, not mock-ups.',
      'Agent 驾驶舱控制台界面截图': 'Agent Cockpit console screenshot',
      'Agent 驾驶舱：决策框架 / 组织大脑 / 内容铸造 / 获客闭环，一个订阅全模块可用': 'Agent Cockpit: decision frameworks / org brain / content casting / growth loop — all modules on one subscription',
      '真实使用场景': 'Real use cases',
      '我们不编造客户故事。这里只列出产品确实能做的事，你可以自行验证。': "We don't invent customer stories. These are things the product actually does — verify them yourself.",
      '决策复盘': 'Decision retro',
      '把一次关键决策的背景、备选方案、依据与结论沉淀下来，事后可回溯「当时为什么这么定」，减少重复踩坑。': 'Capture a key decision\'s context, options, rationale and outcome so you can revisit why you chose it — and stop repeating the same mistakes.',
      '内容铸造': 'Content casting',
      '一条素材生成适配不同平台的多版本文案，并保留来源与依据，发布前由你确认，不做无依据的承诺。': 'Turn one asset into platform-specific copy, keeping its sources and rationale, for your approval before publishing — no unsupported claims',
      '获客闭环': 'Growth loop',
      '只触达已明确同意接收的线索，绝不向陌生地址群发；每次发送都有真实留痕，失败如实记录，随时可退订': 'We only contact leads who explicitly opted in, never blast strangers; every send is logged, failures recorded honestly, opt out anytime',
      '只触达已明确同意接收的线索，绝不向陌生地址群发；每次发送都有真实留痕，失败如实记录，随时可退订。': 'We only contact leads who explicitly opted in, never blast strangers; every send is logged, failures recorded honestly, opt out anytime.',
      '用户评价': 'Reviews',
      '这里只展示已审核、且作者同意公开的真实评价。我们绝不用模板或伪造的证言填充。': 'Only reviewed, author-approved, real reviews appear here. We never pad with templates or fake testimonials.',
      '还没有已审核的真实评价——因为我们不做假证言。': 'No approved reviews yet — because we do not fake testimonials.',
      '欢迎成为第一批用户，留下你的真实体验。': 'Be one of the first users and share your real experience.',
      '写下你的真实评价': 'Write your honest review',
      '写下你的真实体验': 'Write your real experience',
      '★★★★★ 非常满意': '★★★★★ Very satisfied',
      '★★★★☆ 满意': '★★★★☆ Satisfied',
      '★★★☆☆ 一般': '★★★☆☆ Average',
      '★★☆☆☆ 不太满意': '★★☆☆☆ Not satisfied',
      '★☆☆☆☆ 不满意': '★☆☆☆☆ Dissatisfied',
      '我同意在落地页展示这条评价（可匿名）。我保证这是真实体验。': 'I agree to show this review on the landing page (may be anonymous). I confirm it is genuine.',
      '提交评价': 'Submit review',
      '获取更新与案例': 'Get updates and case studies',
      '留下邮箱，第一时间收到新功能与真实案例。我们只在你同意后联系，随时可回复「退订」。': 'Leave your email for new features and real cases. We only contact you with your consent, and you can unsubscribe anytime.',
      '订阅更新': 'Subscribe to updates',
      '我同意接收产品更新邮件（可随时退订）。': 'I agree to receive product update emails (opt out anytime).',
      '跨设备同步 · 邮箱绑定': 'Cross-device sync · Email binding',
      '绑定邮箱后，换电脑 / 换浏览器用邮箱验证码登录，订阅与额度自动恢复。': 'Bind your email to sign in with a code on any computer or browser and restore your subscription and quota automatically.',
      '解绑': 'Unbind',
      '发送验证码': 'Send code',
      '绑定并同步': 'Bind & sync',
      '登录找回': 'Recover login',
      '重新发送': 'Resend',
      's 后可重发': 's until resend',
      '已绑定': 'Bound',
      '丙大山AI · Agent 驾驶舱 |': 'Bingdashan AI · Agent Cockpit |',
      '丙大山AI · Agent 驾驶舱 | ': 'Bingdashan AI · Agent Cockpit | ',
      '进入控制台': 'Open console',
      '服务条款': 'Terms of Service',
      '隐私政策': 'Privacy Policy',
      '订单已生成': 'Order created',
      '请按以下信息完成付款，并在备注中填写订单号': 'Complete payment with the details below and put the order number in the note',
      '暂无收款码': 'No payment code yet',
      '请联系客服获取收款信息': 'Contact support for payment details',
      '请联系客服获取收款信息（国内支付宝/微信 · 海外 PayPal）': 'Contact support for payment details (Alipay/WeChat in China · PayPal overseas)',
      '付款后，截图回传给客服，或等待运营核销（通常 5–30 分钟）': 'After paying, send the screenshot to support or wait for confirmation (usually 5–30 min)',
      '我知道了，去付款': 'Got it, go to payment',
      '订单号': 'Order number',
      '方案': 'Plan',
      '金额': 'Amount',
      '创建时间': 'Created at',
      '状态': 'Status',
      '待支付': 'Awaiting payment',
      '自动检测到账中（每 5 秒一次）…': 'Auto-checking payment (every 5s)…',
      '支付到账，订阅已开通': 'Payment received, subscription activated',
      '请用手机支付宝「扫一扫」上方二维码付款，付款成功即自动开通。': 'Scan the QR code above with Alipay on your phone. Your subscription activates the moment payment succeeds.',
      '请用 PayPal 完成付款，付款成功即自动开通。': 'Complete the payment with PayPal. Your subscription activates the moment payment succeeds.',
      '付款方式：扫码（支付宝）· 自动开通，无需备注订单号': 'Payment: scan the QR with Alipay. Activates automatically — no order number needed.',
      '如未自动刷新，可点击下方按钮手动检测': 'If it does not refresh automatically, use the button below to check manually',
      '手动检测到账': 'Check payment manually',
      '前往 PayPal 付款': 'Pay with PayPal',
      '支付方式: 支付宝 / 微信（国内扫码）· PayPal（海外，联系客服获取链接）': 'Payment method: Alipay / WeChat (China) · PayPal (overseas, ask support for the link)',
      '请用支付宝 / 微信扫码付款（海外买家用 PayPal），务必在备注中填写订单号：': 'Pay by scanning with Alipay / WeChat (PayPal overseas), and be sure to put the order number in the note: ',
      '收款渠道正在配置中，请先联系客服完成下单': 'Payment channels are being configured. Please contact support to complete your order.',
      '支付宝收款码（扫码付款）': 'Alipay QR code (scan to pay)',
      '微信收款码（扫码付款）': 'WeChat QR code (scan to pay)',
      '下单失败': 'Order failed',
      '首7天体验每人仅限一次，请选择月度方案': 'You have already used the 7-day trial. Please choose a monthly plan.',
      '请输入有效邮箱地址': 'Please enter a valid email address',
      '正在发送…': 'Sending…',
      '发送失败': 'Send failed',
      '验证码已发送，请查收邮箱（含垃圾箱）': 'Code sent — check your inbox (and spam)',
      '网络异常，请稍后重试': 'Network error, please try again later',
      '请输入 6 位数字验证码': 'Enter the 6-digit code',
      '正在绑定…': 'Binding…',
      '绑定失败': 'Binding failed',
      '绑定成功': 'Bound successfully',
      '请先点“发送验证码”，再填入 6 位验证码': 'Tap “Send code” first, then enter the 6-digit code',
      '正在登录找回…': 'Recovering login…',
      '登录失败': 'Login failed',
      '登录成功，订阅状态已恢复': 'Signed in, your subscription is restored',
      '确定解绑邮箱？解绑后将无法用邮箱跨设备找回订阅。': 'Unbind this email? You will no longer be able to recover your subscription across devices by email.',
      '已解绑': 'Unbound',
      '解绑失败': 'Unbind failed',
      '请多写两句真实感受': 'Please write a couple more words about your real experience',
      '请勾选同意展示——我们绝不伪造或擅自公开评价': 'Please tick consent — we never fake or publish reviews without permission',
      '正在提交…': 'Submitting…',
      '提交失败': 'Submit failed',
      '已提交，等待审核': 'Submitted, pending review',
      '请勾选同意接收，我们才会联系你': 'Please tick consent so we can contact you',
      '你的称呼（可留空，匿名展示）': 'Your name (optional, shown anonymously)',
      '身份，如：独立开发者 / 小团队负责人': 'Role, e.g. indie developer / small-team lead',
      '说说真实使用感受（会按上面的称呼或匿名展示）': 'Tell us your real experience (shown under the name above or anonymously)',
      '你的邮箱，如 you@example.com': 'Your email, e.g. you@example.com',
      '6 位验证码': '6-digit code',
      '丙大山AI · Agent 驾驶舱 · 订阅开通': 'Bingdashan AI · Agent Cockpit · Subscribe',
      '决策框架 · 组织大脑 · 内容铸造 · 获客闭环 —— 可验收的交付，不是"满意"这种感觉': 'Decision frameworks · Org brain · Content casting · Growth loop — verifiable delivery, not vague "satisfaction"',
      '下单之前，先答四个问题': 'Before ordering, answer four questions',
      '这一屏不是营销，是筛子。答不上来的，明确告诉你「交付不了」——别花这个钱。': 'This is a filter, not marketing. If you cannot answer, we tell you plainly: "cannot deliver" — do not spend money.',
      '这四条能把 90% 的事后纠纷消掉：范围说不清、达标靠「感觉」、没有截止日期、说不清第一笔钱从哪来。': 'These four points prevent most disputes: vague scope, success by feeling, no deadline, unclear first income.',
      '1. 你要的第一个能收到钱的东西，是什么？': '1. What is the first thing that earns you money?',
      '例：一个行业的获客落地页 / 10 封首发邮件。说不出具体物件 → 交付不了。': 'E.g. lead-gen page for one industry / 10 outreach emails. Cannot name concrete item → cannot deliver.',
      '2. 第一笔钱从哪来？': '2. Where does the first payment come from?',
      '例：第一个客户付的样品费。答不出 → 交付不了，因为无法验收。': 'E.g. sample fee from first client. No answer → cannot deliver.',
      '3. 做到什么程度算成？（要可数）': '3. What counts as done? (must be countable)',
      '例：1 个可提交的页面 + 10 封有依据的邮件。「让我满意」不算——没有验收标准。': 'E.g. 1 deliverable page + 10 evidence-based emails. "Make me happy" is not an acceptance criterion.',
      '4. 什么时候要？': '4. When do you need it?',
      '给一个具体日期。「现在就要」→ 交付不了，仓促交付必然返工。': 'Give a specific date. "Right now" → cannot deliver; rushing means rework.',
      '先看能不能接': 'Check if we can take it',
      '通过之后才会出现「订阅」入口。被挡住时，页面会说清缺哪一条、以及怎么改才能过。': 'The "Subscribe" entry appears only after passing. If blocked, page explains exactly what\'s missing.',
      '一个能收钱的最小单位': 'Smallest unit that earns money',
      '第一笔钱的来源': 'Source of first payment',
      '可数的验收标准': 'Countable acceptance criterion',
      '支付宝收款码': 'Alipay payment code',
      '微信收款码': 'WeChat payment code',
      '① 第一个能收钱的东西——必须是个具体物件': '① First money-earning thing — must be a concrete item',
      '② 说不清第一笔钱从哪来 → 无法验收': '② Unclear source of first payment → cannot verify',
      '③ 达标标准必须可数（几条/几份/几个）': '③ Success criterion must be countable (how many)',
      '④ 没有截止日期的需求会无限膨胀': '④ No deadline → scope creep',
      '④ 仓促交付必然返工，请给一个现实的日期': '④ Rushing means rework — give a realistic date',
      '① 大型公司是多年组织工程，不是可交付产品': '① Large company is multi-year org effort, not a simple deliverable',
      '支付方式：扫码（支付宝）· 自动开通，无需备注订单号': 'Payment: scan QR (Alipay) · auto-activate; no order number needed',
      '支付方式：PayPal · 自动开通，无需备注订单号': 'Payment: PayPal · auto-activate; no order number needed',
      '已登记': 'Registered',
      '交付不了，还差这些：': 'Cannot deliver. Missing:',
      '改完再试。改不动就先别付钱。': 'Fix these and try again. If you cannot fix, do not pay yet.',
      '✅ 可以进入方案阶段。向下选方案，下单后会生成一份': '✅ You can proceed to choose a plan. A',
      '交付说明书': 'delivery specification',
      '：逐项验收 + 改稿轮次 + 退出条款，你逐条确认后才生效。': ': item-by-item acceptance + revision rounds + exit terms — effective after confirming each item.',
      '我们不替你做任何确认。': 'We never confirm anything on your behalf.',
      '扫码即开通': 'Scan to activate',
      '付款成功即刻自动开通，无需截图回传、无需等待核销': 'Activates automatically on successful payment — no screenshot, no waiting',
      '请按以下信息完成付款': 'Complete payment with the details below',
      '付款成功后即刻自动开通，无需截图回传或等待核销': 'Activates automatically on successful payment — no screenshot, no waiting'
    },
    ar: {
      'Agent 驾驶舱 · 全功能订阅': 'قمرة قيادة الوكيل · اشتراك كامل الميزات',
      '把 AI 变成你的': 'حوّل الذكاء الاصطناعي إلى',
      '可复用生产力': 'إنتاجية قابلة لإعادة الاستخدام',
      '决策框架·组织大脑·内容铸造·获客闭环——一个订阅，全模块无限用': 'أطر القرار · عقل المؤسسة · صياغة المحتوى · حلقة جذب العملاء — اشتراك واحد، كل الوحدات بلا حدود',
      '首7天体验 ¥1': 'أول 7 أيام بـ $1',
      '首7天体验': 'أول 7 أيام',
      '/7天': '/7 أيام',
      '¥1': '$1', '¥99': '$12', '¥269': '$29', '¥899': '$119',
      '/月': '/شهر', '/季': '/ربع', '/年': '/سنة',
      '每人限一次 · 7 天全功能体验 · 到期后按 ¥99/月续订（可随时取消）': 'مرة واحدة لكل شخص · 7 أيام بكل الميزات · يتجدد بـ $12/شهر (إلغاء في أي وقت)',
      '立即开通 ¥1（7 天）': 'ابدأ الآن بـ $1 (7 أيام)',
      '深度思考 / 决策框架 / Agent 会诊': 'تفكير عميق / أطر القرار / استشارة الوكلاء',
      '内容铸造 / 游戏制作 / 音乐制作': 'صياغة المحتوى / صناعة الألعاب / إنتاج الموسيقى',
      '获客闭环 / 指挥塔 / 组织大脑': 'حلقة جذب العملاء / برج القيادة / عقل المؤسسة',
      '学习进化 / 记忆中心 / 自主运营': 'التعلّم والتطوّر / مركز الذاكرة / التشغيل الذاتي',
      '最灵活': 'الأكثر مرونة',
      '月度': 'شهري', '季度': 'ربع سنوي', '年度': 'سنوي',
      '随时停 · 无长期绑定 · 适合先跑通一个项目再决定': 'أوقف في أي وقت · بلا التزام طويل · مناسب لتجربة مشروع أولاً',
      '订阅月度 ¥99': 'اشترك شهريًا بـ $12',
      '包含首7天体验所有功能': 'يشمل كل ميزات خطة الأيام السبعة الأولى',
      '无使用次数限制': 'بلا حدود للاستخدام',
      '优先获得新功能': 'أولوية الوصول للميزات الجديدة',
      '省 9%': 'وفّر 9%',
      '折合 ¥89.7/月 · 适合已有稳定产出节奏的团队': '≈$9.67/شهر · لفرق ذات إنتاجية ثابتة',
      '订阅季度 ¥269': 'اشترك ربع سنويًا بـ $29',
      '包含月度所有权益': 'يشمل كل مزايا الخطة الشهرية',
      '季度账单一次搞定': 'فاتورة واحدة كل ربع',
      '省 24%': 'وفّر 24%',
      '折合 ¥74.9/月 · 最大折扣 · 锁定一年价格': '≈$9.92/شهر · أكبر خصم · تثبيت السعر لسنة',
      '订阅年度 ¥899': 'اشترك سنويًا بـ $119',
      '包含季度所有权益': 'يشمل كل مزايا الخطة الربع سنوية',
      '邀请返利：1 付费好友送 1 月 · 10 付费好友送 1 年': 'الإحالات: صديق دافع = شهر مجاني · 10 أصدقاء = سنة مجانية',
      '三步开通，即刻生效': 'التفعيل في ثلاث خطوات',
      '选方案下单': 'اختر الخطة',
      '点击上方任意方案，系统生成唯一订单号': 'اضغط أي خطة أعلاه ليُنشأ رقم طلب فريد',
      '扫码付款': 'ادفع بالمسح',
      '国内用支付宝 / 微信扫码，海外用 PayPal，备注写上订单号': 'امسح بـ Alipay / WeChat داخل الصين، وPayPal خارجها — واكتب رقم الطلب في الملاحظة',
      '自动/人工确认': 'تأكيد تلقائي/يدوي',
      '汇款截图回传或等待运营核销，订阅即时生效，全功能解锁': 'أرسل لقطة الدفع أو انتظر التأكيد؛ يُفعَّل الاشتراك فورًا',
      '功能截图': 'لقطات الشاشة',
      '以下截图来自本产品的真实控制台，非示意图。': 'هذه لقطات حقيقية من لوحة التحكم الفعلية، وليست صورًا توضيحية.',
      'Agent 驾驶舱控制台界面截图': 'لقطة شاشة لوحة تحكم قمرة قيادة الوكيل',
      'Agent 驾驶舱：决策框架 / 组织大脑 / 内容铸造 / 获客闭环，一个订阅全模块可用': 'قمرة القيادة: أطر القرار / عقل المؤسسة / صياغة المحتوى / حلقة جذب العملاء — كل الوحدات باشتراك واحد',
      '真实使用场景': 'حالات استخدام واقعية',
      '我们不编造客户故事。这里只列出产品确实能做的事，你可以自行验证。': 'لا نختلق قصص عملاء. نعرض فقط ما يفعله المنتج فعلاً — ويمكنك التحقق بنفسك.',
      '决策复盘': 'مراجعة القرار',
      '把一次关键决策的背景、备选方案、依据与结论沉淀下来，事后可回溯「当时为什么这么定」，减少重复踩坑。': 'وثّق خلفية القرار وبدائله وأسبابه ونتائجه، لتعود لاحقًا لتعرف لماذا اتخذته، وتتجنب تكرار الأخطاء.',
      '内容铸造': 'صياغة المحتوى',
      '一条素材生成适配不同平台的多版本文案，并保留来源与依据，发布前由你确认，不做无依据的承诺。': 'حوّل مادة واحدة إلى نصوص مناسبة لكل منصة، مع حفظ المصادر والأسانيد، ومراجعتك قبل النشر — بلا ادعاءات بلا دليل.',
      '获客闭环': 'حلقة جذب العملاء',
      '只触达已明确同意接收的线索，绝不向陌生地址群发；每次发送都有真实留痕，失败如实记录，随时可退订': 'نتواصل فقط مع من وافق صراحةً، ولا نرسل أبدًا إلى عناوين مجهولة؛ كل إرسال موثّق، والفشل مسجّل بأمانة، والإلغاء متاح دائمًا',
      '只触达已明确同意接收的线索，绝不向陌生地址群发；每次发送都有真实留痕，失败如实记录，随时可退订。': 'نتواصل فقط مع من وافق صراحةً، ولا نرسل أبدًا إلى عناوين مجهولة؛ كل إرسال موثّق، والفشل مسجّل بأمانة، والإلغاء متاح دائمًا.',
      '用户评价': 'آراء المستخدمين',
      '这里只展示已审核、且作者同意公开的真实评价。我们绝不用模板或伪造的证言填充。': 'نعرض فقط آراء حقيقية تمت مراجعتها ووافق أصحابها على نشرها. لا نستخدم قوالب أو شهادات مزيفة.',
      '还没有已审核的真实评价——因为我们不做假证言。': 'لا توجد آراء موثّقة بعد — لأننا لا نصنع شهادات مزيفة.',
      '欢迎成为第一批用户，留下你的真实体验。': 'كن من أوائل المستخدمين وشارك تجربتك الحقيقية.',
      '写下你的真实评价': 'اكتب رأيك الصادق',
      '写下你的真实体验': 'اكتب تجربتك الحقيقية',
      '★★★★★ 非常满意': '★★★★★ راضٍ جدًا',
      '★★★★☆ 满意': '★★★★☆ راضٍ',
      '★★★☆☆ 一般': '★★★☆☆ متوسط',
      '★★☆☆☆ 不太满意': '★★☆☆☆ غير راضٍ',
      '★☆☆☆☆ 不满意': '★☆☆☆☆ غير راضٍ إطلاقًا',
      '我同意在落地页展示这条评价（可匿名）。我保证这是真实体验。': 'أوافق على عرض هذا الرأي في الصفحة (يمكن إخفاء الاسم). وأؤكد أنه تجربة حقيقية.',
      '提交评价': 'إرسال الرأي',
      '获取更新与案例': 'احصل على التحديثات والحالات',
      '留下邮箱，第一时间收到新功能与真实案例。我们只在你同意后联系，随时可回复「退订」。': 'اترك بريدك لتصلك الميزات الجديدة والحالات الحقيقية أولًا. نتواصل فقط بموافقتك، ويمكنك إلغاء الاشتراك في أي وقت.',
      '订阅更新': 'اشترك في التحديثات',
      '我同意接收产品更新邮件（可随时退订）。': 'أوافق على تلقي رسائل تحديثات المنتج (إلغاء في أي وقت).',
      '跨设备同步 · 邮箱绑定': 'مزامنة بين الأجهزة · ربط البريد',
      '绑定邮箱后，换电脑 / 换浏览器用邮箱验证码登录，订阅与额度自动恢复。': 'بعد ربط بريدك، سجّل الدخول برمز عبر البريد على أي جهاز أو متصفح، ليُستعاد اشتراكك ورصيدك تلقائيًا.',
      '解绑': 'إلغاء الربط',
      '发送验证码': 'أرسل الرمز',
      '绑定并同步': 'اربط وزامن',
      '登录找回': 'استعادة الدخول',
      '重新发送': 'إعادة الإرسال',
      's 后可重发': ' ثانية حتى الإعادة',
      '已绑定': 'مربوط',
      '丙大山AI · Agent 驾驶舱 |': 'Bingdashan AI · Agent Cockpit |',
      '丙大山AI · Agent 驾驶舱 | ': 'Bingdashan AI · Agent Cockpit | ',
      '进入控制台': 'افتح لوحة التحكم',
      '服务条款': 'شروط الخدمة',
      '隐私政策': 'سياسة الخصوصية',
      '订单已生成': 'تم إنشاء الطلب',
      '请按以下信息完成付款，并在备注中填写订单号': 'أكمل الدفع وفق البيانات التالية، واكتب رقم الطلب في الملاحظة',
      '暂无收款码': 'لا يوجد رمز دفع بعد',
      '请联系客服获取收款信息': 'تواصل مع الدعم للحصول على بيانات الدفع',
      '请联系客服获取收款信息（国内支付宝/微信 · 海外 PayPal）': 'تواصل مع الدعم للحصول على بيانات الدفع (Alipay/WeChat داخل الصين · PayPal خارجها)',
      '付款后，截图回传给客服，或等待运营核销（通常 5–30 分钟）': 'بعد الدفع، أرسل لقطة الشاشة للدعم أو انتظر التأكيد (عادةً 5–30 دقيقة)',
      '我知道了，去付款': 'فهمت، إلى الدفع',
      '订单号': 'رقم الطلب',
      '方案': 'الخطة',
      '金额': 'المبلغ',
      '创建时间': 'تاريخ الإنشاء',
      '状态': 'الحالة',
      '待支付': 'بانتظار الدفع',
      '自动检测到账中（每 5 秒一次）…': 'جارٍ التحقق التلقائي من الدفع (كل 5 ثوانٍ)…',
      '支付到账，订阅已开通': 'تم استلام الدفع، والاشتراك مفعّل',
      '请用手机支付宝「扫一扫」上方二维码付款，付款成功即自动开通。': 'امسح رمز QR أعلاه بتطبيق Alipay على هاتفك. يُفعَّل اشتراكك فور نجاح الدفع.',
      '请用 PayPal 完成付款，付款成功即自动开通。': 'أكمل الدفع عبر PayPal. يُفعَّل اشتراكك فور نجاح الدفع.',
      '付款方式：扫码（支付宝）· 自动开通，无需备注订单号': 'طريقة الدفع: امسح الرمز بـ Alipay · تفعيل تلقائي، بلا حاجة لرقم الطلب',
      '如未自动刷新，可点击下方按钮手动检测': 'إذا لم يتحدّث تلقائيًا، استخدم الزر أدناه للتحقق يدويًا',
      '手动检测到账': 'تحقق من الدفع يدويًا',
      '前往 PayPal 付款': 'الدفع عبر PayPal',
      '支付方式: 支付宝 / 微信（国内扫码）· PayPal（海外，联系客服获取链接）': 'طريقة الدفع: Alipay / WeChat (مسح داخل الصين) · PayPal (خارج الصين، اطلب الرابط من الدعم)',
      '请用支付宝 / 微信扫码付款（海外买家用 PayPal），务必在备注中填写订单号：': 'ادفع بمسح Alipay / WeChat (وPayPal خارج الصين)، واكتب رقم الطلب في الملاحظة: ',
      '收款渠道正在配置中，请先联系客服完成下单': 'قنوات الدفع قيد الإعداد. تواصل مع الدعم لإتمام الطلب.',
      '支付宝收款码（扫码付款）': 'رمز دفع Alipay (امسح للدفع)',
      '微信收款码（扫码付款）': 'رمز دفع WeChat (امسح للدفع)',
      '下单失败': 'فشل إنشاء الطلب',
      '首7天体验每人仅限一次，请选择月度方案': 'استُخدمت تجربة الأيام السبعة مرة واحدة. اختر الخطة الشهرية.',
      '请输入有效邮箱地址': 'أدخل بريدًا صالحًا',
      '正在发送…': 'جارٍ الإرسال…',
      '发送失败': 'فشل الإرسال',
      '验证码已发送，请查收邮箱（含垃圾箱）': 'تم إرسال الرمز — تحقق من بريدك (والبريد المهمل)',
      '网络异常，请稍后重试': 'خطأ في الشبكة، حاول لاحقًا',
      '请输入 6 位数字验证码': 'أدخل رمزًا من 6 أرقام',
      '正在绑定…': 'جارٍ الربط…',
      '绑定失败': 'فشل الربط',
      '绑定成功': 'تم الربط بنجاح',
      '请先点“发送验证码”，再填入 6 位验证码': 'اضغط «أرسل الرمز» أولاً، ثم أدخل رمزًا من 6 أرقام',
      '正在登录找回…': 'جارٍ استعادة الدخول…',
      '登录失败': 'فشل الدخول',
      '登录成功，订阅状态已恢复': 'تم الدخول، واستُعيد اشتراكك',
      '确定解绑邮箱？解绑后将无法用邮箱跨设备找回订阅。': 'إلغاء ربط البريد؟ لن تستطيع استعادة اشتراكك بين الأجهزة بالبريد بعد ذلك.',
      '已解绑': 'أُلغي الربط',
      '解绑失败': 'فشل إلغاء الربط',
      '请多写两句真实感受': 'اكتب بضعة كلمات أكثر عن تجربتك الحقيقية',
      '请勾选同意展示——我们绝不伪造或擅自公开评价': 'يرجى الموافقة على العرض — لا نزوّر الآراء ولا ننشرها دون إذن',
      '正在提交…': 'جارٍ الإرسال…',
      '提交失败': 'فشل الإرسال',
      '已提交，等待审核': 'تم الإرسال، بانتظار المراجعة',
      '请勾选同意接收，我们才会联系你': 'يرجى الموافقة حتى نتمكن من التواصل معك',
      '你的称呼（可留空，匿名展示）': 'اسمك (اختياري، يُعرض مجهولًا)',
      '身份，如：独立开发者 / 小团队负责人': 'دورك، مثل: مطوّر مستقل / قائد فريق صغير',
      '说说真实使用感受（会按上面的称呼或匿名展示）': 'شاركنا تجربتك الحقيقية (تُعرض بالاسم أعلاه أو مجهولة)',
      '你的邮箱，如 you@example.com': 'بريدك، مثل you@example.com',
      '6 位验证码': 'رمز من 6 أرقام',
      '丙大山AI · Agent 驾驶舱 · 订阅开通': 'Bingdashan AI · Agent Cockpit · Subscription',
      '决策框架 · 组织大脑 · 内容铸造 · 获客闭环 —— 可验收的交付，不是"满意"这种感觉': 'أطر القرار · عقل المؤسسة · صياغة المحتوى · حلقة جذب العملاء — تسليم قابل للتحقق، لا مجرد «رضا» عام',
      '下单之前，先答四个问题': 'قبل الطلب، أجب عن أربعة أسئلة',
      '这一屏不是营销，是筛子。答不上来的，明确告诉你「交付不了」——别花这个钱。': 'هذا ليس تسويقًا بل غربال. من لا يجيب بوضوح يُقال له صراحةً «لا يمكن التسليم» — فلا تُنفق المال.',
      '这四条能把 90% 的事后纠纷消掉：范围说不清、达标靠「感觉」、没有截止日期、说不清第一笔钱从哪来。': 'هذه النقاط الأربع تلغي 90% من النزاعات اللاحقة: نطاق غامض، ومعيار رضا بالمزاج، وبلا موعد نهائي، وبلا مصدر واضح لأول دخل.',
      '1. 你要的第一个能收到钱的东西，是什么？': '١. ما أول شيء يجلب لك المال؟',
      '例：一个行业的获客落地页 / 10 封首发邮件。说不出具体物件 → 交付不了。': 'مثال: صفحة جذب لقطاع معيّن / 10 رسائل أولى. إن تعذّر تحديد شيء ملموس → لا يمكن التسليم.',
      '2. 第一笔钱从哪来？': '٢. من أين تأتي أول دفعة مال؟',
      '例：第一个客户付的样品费。答不出 → 交付不了，因为无法验收。': 'مثال: رسوم عيّنة يدفعها أول عميل. إن تعذّر الجواب → لا يمكن التسليم، لعدم إمكان التحقق.',
      '3. 做到什么程度算成？（要可数）': '٣. ما معيار النجاح؟ (يجب أن يكون قابلًا للعدّ)',
      '例：1 个可提交的页面 + 10 封有依据的邮件。「让我满意」不算——没有验收标准。': 'مثال: صفحة واحدة قابلة للتسليم + 10 رسائل مدعومة. «أرضِني» ليس معيارًا — فلا يوجد معيار تحقق.',
      '4. 什么时候要？': '٤. متى تحتاجه؟',
      '给一个具体日期。「现在就要」→ 交付不了，仓促交付必然返工。': 'حدّد تاريخًا معيّنًا. «الآن» → لا يمكن التسليم؛ فالتعجّل يعني إعادة العمل حتمًا.',
      '先看能不能接': 'تحقّق من إمكان التسليم',
      '通过之后才会出现「订阅」入口。被挡住时，页面会说清缺哪一条、以及怎么改才能过。': 'يظهر مدخل «الاشتراك» بعد الاجتياز فقط. وعند الحجب، توضّح الصفحة النقطة الناقصة وكيف تُعدّلها.',
      '一个能收钱的最小单位': 'أصغر وحدة تجلب المال',
      '第一笔钱的来源': 'مصدر أول دفعة مال',
      '可数的验收标准': 'معيار تحقق قابل للعدّ',
      '支付宝收款码': 'رمز دفع Alipay',
      '微信收款码': 'رمز دفع WeChat',
      '① 第一个能收钱的东西——必须是个具体物件': '① الشيء الأول الذي يجلب المال — يجب أن يكون ملموسًا',
      '② 说不清第一笔钱从哪来 → 无法验收': '② مصدر أول دفعة مال غير واضح → يتعذّر التحقق',
      '③ 达标标准必须可数（几条/几份/几个）': '③ معيار النجاح يجب أن يكون قابلًا للعدّ (كم عدد)',
      '④ 没有截止日期的需求会无限膨胀': '④ الطلب بلا موعد نهائي يتضخّم بلا حد',
      '④ 仓促交付必然返工，请给一个现实的日期': '④ التعجّل يعني إعادة العمل، فحدّد تاريخًا واقعيًا',
      '① 大型公司是多年组织工程，不是可交付产品': '① الشركات الكبرى مشروع تنظيمي يمتد سنوات، لا منتجًا قابلًا للتسليم',
      '支付方式：扫码（支付宝）· 自动开通，无需备注订单号': 'طريقة الدفع: امسح الرمز (Alipay) · تفعيل تلقائي، بلا حاجة لرقم الطلب',
      '支付方式：PayPal · 自动开通，无需备注订单号': 'طريقة الدفع: PayPal · تفعيل تلقائي، بلا حاجة لرقم الطلب',
      '已登记': 'تم التسجيل',
      '交付不了，还差这些：': 'لا يمكن التسليم، ينقص ما يلي:',
      '改完再试。改不动就先别付钱。': 'عدّل ثم أعد المحاولة. وإن تعذّر، فلا تدفع بعد.',
      '✅ 可以进入方案阶段。向下选方案，下单后会生成一份': '✅ يمكنك الانتقال لاختيار الخطة. اختر خطتك أدناه؛ سيتولّد بعد الطلب',
      '交付说明书': 'بيان التسليم',
      '：逐项验收 + 改稿轮次 + 退出条款，你逐条确认后才生效。': ': قبول بندًا بندًا + جولات التعديل + شروط الانسحاب، ولا يسري إلا بعد تأكيدك لكل بند.',
      '我们不替你做任何确认。': 'نحن لا نقوم بأي تأكيد نيابةً عنك.',
      '扫码即开通': 'امسح لتفعيل الاشتراك',
      '付款成功即刻自动开通，无需截图回传、无需等待核销': 'يُفعَّل الاشتراك فور نجاح الدفع — بلا لقطات شاشة وبلا انتظار',
      '请按以下信息完成付款': 'أكمل الدفع وفق البيانات التالية',
      '付款成功后即刻自动开通，无需截图回传或等待核销': 'يُفعَّل الاشتراك فور نجاح الدفع — بلا لقطات شاشة وبلا انتظار'
    }
  };

  var LANGS = [['zh', '中文'], ['en', 'English'], ['ar', 'العربية']];
  window.LANDING_LANG = 'zh';
  var _orig = new WeakMap();

  function has(obj, k) { return obj && Object.prototype.hasOwnProperty.call(obj, k); }

  function T(s) {
    if (s == null) return s;
    if (LANDING_LANG === 'zh') return s;
    var d = LDICT[LANDING_LANG];
    if (has(d, s)) return d[s];
    if (has(LDICT.en, s)) return LDICT.en[s];
    return s;
  }
  window.LANDING_T = T;

  function stripLead(k) { return k.replace(/^[\s·•\-\u2013\u2014]+/, ''); }
  function trText(base) {
    var key = base.trim();
    if (!key) return base;
    if (!/[A-Za-z\u4e00-\u9fff]/.test(key)) return base;
    var val = T(key);
    if (val !== key) return base.split(key).join(val);
    var k2 = stripLead(key);
    if (k2 && k2 !== key) {
      var v2 = T(k2);
      if (v2 !== k2) return base.split(k2).join(v2);
    }
    return base;
  }

  function translateOneTextNode(n) {
    var p = n.parentElement;
    if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) return;
    if (!_orig.has(n)) _orig.set(n, n.nodeValue);
    var base = _orig.get(n);
    var v = trText(base);
    if (v !== n.nodeValue) n.nodeValue = v;
  }

  function translateAttrs(root) {
    if (!root) return;
    var els = [root];
    if (root.querySelectorAll) {
      els = els.concat(Array.prototype.slice.call(root.querySelectorAll('[alt],[title],[placeholder]')));
    }
    els.forEach(function (el) {
      if (!el || el.nodeType !== 1) return;
      ['alt', 'title', 'placeholder'].forEach(function (a) {
        if (!el.hasAttribute || !el.hasAttribute(a)) return;
        var store = '__zh_' + a;
        if (!el[store]) el[store] = el.getAttribute(a);
        el.setAttribute(a, T(el[store]));
      });
    });
  }

  function translateSubtree(root) {
    if (!root) return;
    if (root.nodeType === 3) { translateOneTextNode(root); return; }
    if (root.nodeType !== 1) return;
    if (root.tagName === 'SCRIPT' || root.tagName === 'STYLE') return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n; while ((n = w.nextNode())) translateOneTextNode(n);
    translateAttrs(root);
  }

  function landingApplyLang(code) {
    if (code !== 'zh' && !LDICT[code]) code = 'zh';
    LANDING_LANG = code;
    try { localStorage.setItem('bd_landing_lang', code); } catch (e) {}
    document.documentElement.lang = code === 'zh' ? 'zh-CN' : (code === 'ar' ? 'ar' : code);
    document.documentElement.dir = (code === 'ar') ? 'rtl' : 'ltr';
    var tEl = document.querySelector('title');
    if (tEl) { if (!_orig.has(tEl)) _orig.set(tEl, tEl.textContent); tEl.textContent = T(_orig.get(tEl)); }
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      var p = n.parentElement;
      if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) continue;
      if (!_orig.has(n)) _orig.set(n, n.nodeValue);
      var base = _orig.get(n);
      n.nodeValue = trText(base);
    }
    translateAttrs(document.body);
    document.querySelectorAll('img[data-shot]').forEach(function (el) {
      if (!el.getAttribute('data-src-zh')) el.setAttribute('data-src-zh', el.getAttribute('src'));
      var zhSrc = el.getAttribute('data-src-zh'), enSrc = el.getAttribute('data-src-en'), arSrc = el.getAttribute('data-src-ar');
      var src = zhSrc;
      if (code === 'en' && enSrc) src = enSrc;
      if (code === 'ar' && arSrc) src = arSrc;
      // 本地化截图缺失时优雅回退到中文版，绝不显示裂图
      if (!el.__shotErrBound) {
        el.__shotErrBound = 1;
        el.onerror = function () { if (el.getAttribute('src') !== zhSrc) el.setAttribute('src', zhSrc); };
      }
      el.setAttribute('src', src);
    });
    document.querySelectorAll('#langBar button').forEach(function (b) {
      var on = b.dataset.lang === code;
      b.style.background = on ? 'rgba(16,185,129,.22)' : 'transparent';
      b.style.color = on ? '#10b981' : '#7a8a9a';
      b.style.borderColor = on ? '#10b981' : '#1e2a38';
    });
  }
  window.landingApplyLang = landingApplyLang;
  window.landingLang = function () { return LANDING_LANG; };

  function buildBar() {
    var host = document.querySelector('.container') || document.body;
    if (document.getElementById('langBar')) return;
    var bar = document.createElement('div');
    bar.id = 'langBar';
    bar.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;margin-bottom:10px';
    LANGS.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = p[1]; b.dataset.lang = p[0];
      b.style.cssText = 'padding:4px 10px;border:1px solid #1e2a38;border-radius:999px;background:transparent;color:#7a8a9a;font-size:13px;cursor:pointer';
      b.onclick = function () { landingApplyLang(p[0]); };
      bar.appendChild(b);
    });
    host.insertBefore(bar, host.firstChild);
  }

  function boot() {
    if (!document.getElementById('langBar')) buildBar();
    var q = null; try { q = new URLSearchParams(location.search).get('lang'); } catch (e) {}
    var saved = null;
    try { saved = localStorage.getItem('bd_landing_lang'); } catch (e) {}
    var code = (q && (q === 'zh' || q === 'en' || q === 'ar')) ? q : (saved || 'zh');
    landingApplyLang(code);
    var obs = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        if (m.type === 'characterData') translateSubtree(m.target);
        else if (m.addedNodes) m.addedNodes.forEach(translateSubtree);
      });
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
