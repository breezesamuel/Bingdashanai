// web/i18n.js — 全站语言引擎（第 1 条 + 第 7 条）
//
// 【这一版解决的真问题】
// 上一版只有 64 个 data-i18n 键，而 app.js 里有 2115 条中文词组、935 处硬编码文案。
// 结果就是用户说的"语言混杂"：切到英文后，导航变了、面板标题变了，
// 但 935 处中文原样躺在那儿——新旧文字并排出现，这比完全不切换更糟。
//
// 【为什么不再逐个加 data-i18n】
// 给 3392 行的 app.js 逐处加键，可行但必然漏：漏一处就是一处永久混杂，
// 而且以后每加一个功能都要记得补三种语言，人一懒就又混杂了。
// 所以改成**词表驱动 + DOM 自动扫描**：
//   · TRANS 把"中文原文 → 各语言译文"作为唯一事实来源；
//   · applyI18n() 除了扫 data-i18n，还会遍历所有文本节点，
//     用词表做**最长优先**匹配替换，命中即翻；
//   · MutationObserver 盯住后续动态渲染的内容（面板刷新、聊天回复、图表标签），
//     一出现就翻，不需要谁记得再调用一次。
// 这样"补一个词"就等于"全站该词生效"，覆盖率不会随新功能退化。
//
// 【三条铁律，都是为了杜绝混杂】
//   A. 词表命中不了的中文**不许静默留着**。coverage() 会把漏网的原文列出来，
//      启动时打到控制台，测试脚本能直接断言"全站零残留中文"。问题被看见才算修。
//   B. 切换语言必须能**还原**。每个被翻过的节点把中文原文存进 data-i18n-src，
//      重新切换时先还原再翻，否则 en→ar 会拿英文当原文去找中文词表，越翻越乱。
//   C. 只暴露**有译文**的语言。宁可少一个语种，也不给"点了没反应"的假选项——
//      上一版下拉框里的法语就是元凶。
//
// 【扩展方式】看到界面里还有中文 → 把中文原文加进 TRANS，配好 en 和 ar 译文，
// 不用去改任何渲染代码。改完刷新，全站立刻生效。

(function (global) {
  'use strict';

  // ---- 1. 语种定义 ---------------------------------------------------------
  // dir 必须对：阿拉伯语是 RTL，只换文字不换排版方向会整页错位。
  var LANGUAGES = [
    { code: 'zh', label: '中文', dir: 'ltr', htmlLang: 'zh-CN' },
    { code: 'en', label: 'English', dir: 'ltr', htmlLang: 'en' },
    { code: 'ar', label: 'العربية', dir: 'rtl', htmlLang: 'ar' }
  ];
  var FALLBACK = 'zh';

  function meta(code) {
    for (var i = 0; i < LANGUAGES.length; i++) if (LANGUAGES[i].code === code) return LANGUAGES[i];
    return LANGUAGES[0];
  }
  function norm(code) {
    code = String(code || '').toLowerCase().slice(0, 2);
    for (var i = 0; i < LANGUAGES.length; i++) if (LANGUAGES[i].code === code) return code;
    return FALLBACK;
  }

  // ---- 2. 键值词典（给 data-i18n 用的稳定键）--------------------------------
  // 这些是结构性文案（导航、通用按钮、设置项），键名稳定、不会随内容变。
  var DICT = {
    zh: {
      'nav.chat': '智能对话', 'nav.decision': '决策中心', 'nav.org': '组织大脑',
      'nav.project': '项目管理', 'nav.tasks': '任务台', 'nav.audit': '审计日志',
      'nav.setting': '系统设置', 'nav.brain': '记忆 · 学习 · 进化',
      'nav.skills': '技能军械库', 'nav.agents': 'Agent 管理中心', 'nav.studiohub': '创作工坊',
      'nav.auto': '24h 自主运营', 'nav.cmd': '作战指挥塔', 'nav.guard': '同在守护',
      'nav.warroom': '战情室', 'nav.subs': '订阅 · 收费墙', 'nav.rank': '排行榜',
      'nav.watch': '24h 监控告警', 'nav.kpi': '目标任务', 'nav.funnel': '漏斗看板',
      'nav.capmap': '能力全景', 'nav.gtm': '获客市场', 'nav.partner': '合伙人分销', 'nav.cashier': '收银台', 'nav.compliance': '合规中心', 'nav.validator': '创业验证所',
      'nav.outreach': '外发触达', 'nav.convert': '线索转化', 'nav.commercial-loop': '商业闭环',
      // —— 商业闭环 5 大面板（gtm/partner/cashier/outreach/convert）——
      // 此前这些键在 zh 词典里完全缺失，t() 返回空串，applyI18n 会把标签清空。
      'gtm.title': '获客市场 · ICP 与触达序列', 'gtm.sub': '定义理想客户画像（ICP），配置多渠道触达序列，实时看板追踪漏斗转化。',
      'gtm.refresh': '刷新数据', 'gtm.diagnose': '诚实体检', 'gtm.icps': 'ICP 画像库', 'gtm.sequences': '触达序列',
      'gtm.landing': '落地页文案预览', 'gtm.genLanding': '生成文案', 'gtm.funnelDetail': '漏斗下钻详情', 'gtm.funnelTitle': '获客漏斗看板',
      'partner.title': '合伙人分销 · 招募与结算', 'partner.sub': '管理合伙人招募、交付验收、分成结算全流程。',
      'partner.refresh': '刷新数据', 'partner.enroll': '招募申请', 'partner.deliver': '交付验收', 'partner.deliverDetail': '交付明细（点击上表行查看）', 'partner.settle': '分成结算',
      'cashier.title': '收银台 · 统一收付款中心', 'cashier.sub': '聚合所有支付通道、订单查询、提现结算、资金看板、推广费预算、线索营收、核销记录。',
      'cashier.refresh': '刷新全量', 'cashier.diag': '通道自检', 'cashier.channels': '支付通道状态', 'cashier.kpi': '资金看板',
      'cashier.promo': '推广费预算池', 'cashier.leads': '线索营收记录', 'cashier.payout': '提现/结算管理', 'cashier.writeoff': '核销记录',
      'cashier.payoutConfig': '提现账户配置', 'cashier.saveConfig': '保存配置', 'cashier.instruction': '打款指令', 'cashier.createInstruction': '创建指令',
      'cashier.dunning': '催款管理', 'cashier.sendDunning': '发送催款', 'cashier.checkout': '创建收款单（测试）', 'cashier.createOrder': '创建订单',
      'outreach.title': '外发触达 · 线索触达记录与配额', 'outreach.sub': '查看每日触达记录、配额使用、渠道效果、失败原因分析。',
      'outreach.refresh': '刷新数据', 'outreach.quota': '今日配额', 'outreach.records': '触达记录', 'outreach.stats': '渠道效果统计',
      'convert.title': '线索转化 · 成交与漏斗下钻', 'convert.sub': '从线索到成交的完整漏斗，支持下钻到单条线索查看触达历史、跟进记录、成交详情。',
      'convert.refresh': '刷新漏斗', 'convert.funnel': '转化漏斗', 'convert.leads': '线索列表（可下钻）', 'convert.detail': '线索详情（点击行查看）',
      'common.save': '保存', 'common.cancel': '取消', 'common.close': '关闭',
      'common.confirm': '确定', 'common.delete': '删除', 'common.edit': '编辑',
      'common.add': '添加', 'common.export': '导出', 'common.import': '导入',
      'common.refresh': '刷新', 'common.test': '试听', 'common.loading': '加载中…',
      'common.saved': '已保存', 'common.none': '暂无', 'common.total': '合计',
      'common.status': '状态', 'common.action': '操作', 'common.name': '名称',
      'chat.model': '模型', 'chat.lang': '界面语言', 'chat.output': '输出',
      'chat.text': '文本', 'chat.voice': '语音朗读', 'chat.deep': '深度思考',
      'chat.export': '⬇ 导出', 'chat.mic': '语音输入', 'chat.cam': '打开摄像头',
      'chat.clear': '清空会话', 'chat.placeholder': '问我任何事，我会调用本系统所有模块来回答…',
      'chat.send': '发送', 'chat.thinking': '思考中', 'chat.growing': '学习中',
      'set.title': '系统设置',
      'set.language': '界面语言',
      'set.languageDesc': '选择后整个系统立即切换，所有页面、按钮、提示同步生效，不会出现语言混杂。',
      'set.theme': '主题配色', 'set.themeDesc': '全局配色即时切换，并自动写入大脑记忆。',
      'set.sound': '警告音', 'set.soundDesc': '不同事件使用不同提示音，避免所有提醒都一个样。',
      'set.soundOn': '启用警告音', 'set.soundTest': '🔔 试听', 'set.soundPick': '选择声音',
      'set.keys': '模型通道 · 密钥管理', 'set.keysSave': '💾 保存密钥',
      'set.update': '自我更新', 'set.ver': '当前版本', 'set.updateCheck': '检查更新',
      'set.updateDesc': '本地构建。检查最新版本并评估升级路径。',
      'set.goal': '目标任务', 'set.goalDesc': '所有功能模块程序的最核心指导目标，可添加多条。',
      'set.goalAdd': '添加目标', 'goal.ph': '例：半年营收 1000 万', 'goal.amt': '目标值',
      'goal.empty': '还没有设定目标任务。设定后，指挥塔、作战与 24h 运营都会以它为准绳。',
      'wall.free': '免费次数', 'wall.t': '🔒 免费次数已用完',
      'wall.m': '订阅后解锁全部功能。支持微信 / 支付宝，入账一律进支付宝。',
      'wall.later': '再逛逛', 'wall.subNow': '订阅解锁',
      'set.hub': '系统设置中枢',
      'set.covOk': '可配置',
      'set.goFix': '去修复',
      'set.showAdv': '显示高级项',
      'set.saveAll': '保存全部设置',
      'set.notSet': '未设置',
      'set.configured': '已配置',
      'set.noChange': '没有改动',
      'set.rejected': '已拒绝',
      'set.savedAll': '设置已保存',
      'set.moneyConfirm': '以下设置影响真实资金，确认？',
      'set.notInPage': '该项不在当前页面',
      'set.amtPh': '目标值',
      'set.modelCol': '默认模型',
      'set.keysCol': '密钥',
      'grp.lang': '界面',
      'grp.sound': '警告音',
      'grp.keys': '模型通道 · 密钥',
      'grp.alert': '监控与告警',
      'grp.money': '收款与分润',
      'grp.exec': '执行与并发',
      'grp.billing': '订阅与收费墙',
      'grp.goal': '目标任务',
      'grp.adv': '高级 · 数据',
      'setk.lang': '界面语言',
      'setk.sound': '警告音',
      'setk.soundKind': '默认事件类型',
      'setk.provider': '默认模型通道',
      'setk.alertEmail': '告警收件邮箱',
      'setk.watchdogScanSec': '监控扫描间隔（秒）',
      'setk.autoHeal': '自动修复闭环',
      'setk.receiveAccount': '收款账号',
      'setk.receiveQrAlipay': '支付宝收款码',
      'setk.receiveQrWechat': '微信收款码',
      'setk.platformFee': '平台费率（%）',
      'setk.partnerSharePct': '合伙人分成（%）',
      'setk.kpiStart': 'KPI 起算日',
      'setk.orcaSlots': '并发槽位',
      'setk.autopilot': '24h 自主运营',
      'setk.lessonNoiseFloor': '经验入库噪声阈值',
      'setk.paywallOn': '启用订阅收费墙',
      'setk.publicBase': '对外公开地址',
      'setk.devcapOverrides': '研发能力人工覆写',
      'setk.visitorSecret': '访客密钥',
      'setk.adminToken': '管理令牌',
      'setk.theme': '主题',
      'setd.lang': '切换后整个系统立即跟随，不会出现语言混杂。',
      'setd.sound': '不同事件使用不同提示音。',
      'setd.soundKind': '未指定事件类型时使用的音型。',
      'setd.provider': '对话默认使用哪个通道（不可用时自动降级）。',
      'setd.alertEmail': '监控异常报告发到这里。不填则只记在本机，不会丢但也没人知道。',
      'setd.watchdogScanSec': '多久扫一次异常。默认 60 秒；调小会增加磁盘与 CPU 开销。',
      'setd.autoHeal': '自动跑「诊断→处置→复检」。涉钱、对外发声、篡改数据的项仍会转人工。',
      'setd.receiveAccount': '客户付款时告知的收款账号。不填则订阅页无法指引付款。',
      'setd.receiveQrAlipay': '订阅页展示的支付宝收款码。',
      'setd.receiveQrWechat': '订阅页展示的微信收款码。',
      'setd.platformFee': '按近 365 天已结算实收判定的阶梯平台费。',
      'setd.partnerSharePct': '合伙人分润比例。平台费率与分成之和不得超过 100%。',
      'setd.kpiStart': '日均实收从哪天开始算。改了会影响营收进度口径。',
      'setd.orcaSlots': '同时能跑多少个后台作业。调高会同时压更多模型通道。',
      'setd.autopilot': '按间隔自动跑运营轮次。',
      'setd.lessonNoiseFloor': '低于该置信度的结论不入长期经验库。',
      'setd.paywallOn': '关闭时全部端点免费开放（当前暂停；修完全部问题后再开）。',
      'setd.publicBase': '生成对外链接与回调时使用的基地址。',
      'setd.devcapOverrides': '对自动评估出的研发能力做人工修正（JSON）。',
      'setd.visitorSecret': '外部访客调用凭据。只显示是否已配置，不回显明文。',
      'setd.adminToken': '管理员操作凭据。只显示是否已配置，不回显明文。',
      'setd.theme': '配色方案 ID。',
      'seto.zh': '中文',
      'seto.en': '英文',
      'seto.ar': '阿拉伯文',
      'seto.notice': '普通提醒',
      'seto.alert': '告警',
      'seto.success': '成功',
    },
    en: {
      'nav.chat': 'Chat', 'nav.decision': 'Decisions', 'nav.org': 'Organization',
      'nav.project': 'Projects', 'nav.tasks': 'Tasks', 'nav.audit': 'Audit Log',
      'nav.setting': 'Settings', 'nav.brain': 'Memory · Learn · Evolve',
      'nav.skills': 'Skill Arsenal', 'nav.agents': 'Agent Center', 'nav.studiohub': 'Creation Studio',
      'nav.auto': '24h Autopilot', 'nav.cmd': 'Command Tower', 'nav.guard': 'Guardian',
      'nav.warroom': 'War Room', 'nav.subs': 'Plans · Paywall', 'nav.rank': 'Leaderboard',
      'nav.watch': '24h Watchdog', 'nav.kpi': 'Mission Goals', 'nav.capmap': 'Capability Map', 'nav.gtm': 'GTM Market', 'nav.partner': 'Partner Program', 'nav.cashier': 'Cashier', 'nav.outreach': 'Outreach', 'nav.convert': 'Lead Convert', 'nav.commercial-loop': 'Commercial Loop', 'nav.funnel': 'Funnel', 'nav.compliance': 'Compliance Hub', 'nav.validator': 'Startup Validator',
      // —— 商业闭环 5 大面板（与 zh 词典一一对应）——
      'gtm.title': 'GTM Market · ICP & Sequences', 'gtm.sub': 'Define ideal customer profiles (ICP), configure multi-channel outreach sequences and track funnel conversion on a live board.',
      'gtm.refresh': 'Refresh', 'gtm.diagnose': 'Honest Check', 'gtm.icps': 'ICP Library', 'gtm.sequences': 'Outreach Sequences',
      'gtm.landing': 'Landing Copy Preview', 'gtm.genLanding': 'Generate Copy', 'gtm.funnelDetail': 'Funnel Drilldown', 'gtm.funnelTitle': 'GTM Funnel Board',
      'partner.title': 'Partner Program · Recruit & Settle', 'partner.sub': 'Manage partner recruitment, delivery acceptance and revenue-share settlement end to end.',
      'partner.refresh': 'Refresh', 'partner.enroll': 'Applications', 'partner.deliver': 'Delivery', 'partner.deliverDetail': 'Delivery detail (click a row above)', 'partner.settle': 'Settlement',
      'cashier.title': 'Cashier · Unified Payment Center', 'cashier.sub': 'All payment channels, order lookup, payouts, cash dashboard, promo budget, lead revenue and write-off records.',
      'cashier.refresh': 'Refresh All', 'cashier.diag': 'Channel Self-Check', 'cashier.channels': 'Payment Channel Status', 'cashier.kpi': 'Cash Dashboard',
      'cashier.promo': 'Promo Budget Pool', 'cashier.leads': 'Lead Revenue Records', 'cashier.payout': 'Payout / Settlement', 'cashier.writeoff': 'Write-off Records',
      'cashier.payoutConfig': 'Payout Account Config', 'cashier.saveConfig': 'Save Config', 'cashier.instruction': 'Payout Instruction', 'cashier.createInstruction': 'Create Instruction',
      'cashier.dunning': 'Dunning', 'cashier.sendDunning': 'Send Reminder', 'cashier.checkout': 'Create Payment Order (test)', 'cashier.createOrder': 'Create Order',
      'outreach.title': 'Outreach · Records & Quota', 'outreach.sub': 'Daily outreach records, quota usage, channel performance and failure analysis.',
      'outreach.refresh': 'Refresh', 'outreach.quota': "Today's Quota", 'outreach.records': 'Outreach Records', 'outreach.stats': 'Channel Performance',
      'convert.title': 'Lead Conversion · Deals & Funnel Drilldown', 'convert.sub': 'Full funnel from lead to deal; drill down to a single lead for touch history, follow-ups and deal detail.',
      'convert.refresh': 'Refresh Funnel', 'convert.funnel': 'Conversion Funnel', 'convert.leads': 'Leads (drillable)', 'convert.detail': 'Lead Detail (click a row)',
      'common.save': 'Save', 'common.cancel': 'Cancel', 'common.close': 'Close',
      'common.confirm': 'OK', 'common.delete': 'Delete', 'common.edit': 'Edit',
      'common.add': 'Add', 'common.export': 'Export', 'common.import': 'Import',
      'common.refresh': 'Refresh', 'common.test': 'Test', 'common.loading': 'Loading…',
      'common.saved': 'Saved', 'common.none': 'None', 'common.total': 'Total',
      'common.status': 'Status', 'common.action': 'Action', 'common.name': 'Name',
      'chat.model': 'Model', 'chat.lang': 'Language', 'chat.output': 'Output',
      'chat.text': 'Text', 'chat.voice': 'Voice', 'chat.deep': 'Deep think',
      'chat.export': '⬇ Export', 'chat.mic': 'Voice input', 'chat.cam': 'Camera',
      'chat.clear': 'Clear chat', 'chat.placeholder': 'Ask anything — I will call every module in this system to answer…',
      'chat.send': 'Send', 'chat.thinking': 'Thinking', 'chat.growing': 'Learning',
      'set.title': 'System Settings',
      'set.language': 'Interface language',
      'set.languageDesc': 'The entire system switches instantly — every page, button and message follows, with no mixed languages.',
      'set.theme': 'Theme', 'set.themeDesc': 'Global color scheme applies instantly and is saved to memory.',
      'set.sound': 'Alert sounds', 'set.soundDesc': 'Different events use different tones, so not every alert sounds identical.',
      'set.soundOn': 'Enable alert sounds', 'set.soundTest': '🔔 Test', 'set.soundPick': 'Choose sound',
      'set.keys': 'Model providers · API keys', 'set.keysSave': '💾 Save keys',
      'set.update': 'Self update', 'set.ver': 'Current version', 'set.updateCheck': 'Check for updates',
      'set.updateDesc': 'Local build. Check the latest version and assess the upgrade path.',
      'set.goal': 'Mission goals', 'set.goalDesc': 'The core guiding objective for every module. Add as many as you need.',
      'set.goalAdd': 'Add goal', 'goal.ph': 'e.g. ¥10M revenue in six months', 'goal.amt': 'Target',
      'goal.empty': 'No mission goal yet. Once set, the command tower, war room and 24h operations all steer by it.',
      'wall.free': 'Free uses left', 'wall.t': '🔒 Free quota used up',
      'wall.m': 'Subscribe to unlock everything. WeChat / Alipay accepted; all revenue settles to Alipay.',
      'wall.later': 'Browse more', 'wall.subNow': 'Subscribe',
      'set.hub': 'System settings hub',
      'set.covOk': 'Configurable',
      'set.goFix': 'Go fix',
      'set.showAdv': 'Show advanced',
      'set.saveAll': 'Save all settings',
      'set.notSet': 'Not set',
      'set.configured': 'Configured',
      'set.noChange': 'Nothing changed',
      'set.rejected': 'Rejected',
      'set.savedAll': 'Settings saved',
      'set.moneyConfirm': 'The following settings affect real money. Confirm?',
      'set.notInPage': 'This item is not on the current page',
      'set.amtPh': 'Target',
      'set.modelCol': 'Default model',
      'set.keysCol': 'Key',
      'grp.lang': 'Interface',
      'grp.sound': 'Alert sounds',
      'grp.keys': 'Providers & keys',
      'grp.alert': 'Monitoring & alerts',
      'grp.money': 'Payments & revenue share',
      'grp.exec': 'Execution & concurrency',
      'grp.billing': 'Plans & paywall',
      'grp.goal': 'Mission goals',
      'grp.adv': 'Advanced & data',
      'setk.lang': 'Interface language',
      'setk.sound': 'Alert sounds',
      'setk.soundKind': 'Default event',
      'setk.provider': 'Default provider',
      'setk.alertEmail': 'Alert inbox',
      'setk.watchdogScanSec': 'Scan interval (s)',
      'setk.autoHeal': 'Auto-repair loop',
      'setk.receiveAccount': 'Payment account',
      'setk.receiveQrAlipay': 'Alipay QR',
      'setk.receiveQrWechat': 'WeChat QR',
      'setk.platformFee': 'Platform fee (%)',
      'setk.partnerSharePct': 'Partner share (%)',
      'setk.kpiStart': 'KPI start date',
      'setk.orcaSlots': 'Concurrency slots',
      'setk.autopilot': '24h autopilot',
      'setk.lessonNoiseFloor': 'Lesson noise floor',
      'setk.paywallOn': 'Enable paywall',
      'setk.publicBase': 'Public base URL',
      'setk.devcapOverrides': 'Dev-capability overrides',
      'setk.visitorSecret': 'Visitor key',
      'setk.adminToken': 'Admin token',
      'setk.theme': 'Theme',
      'setd.lang': 'The whole system follows instantly, with no mixed languages.',
      'setd.sound': 'Different events use different tones.',
      'setd.soundKind': 'Tone used when no event type is given.',
      'setd.provider': 'Channel used by chat by default (auto-falls back).',
      'setd.alertEmail': 'Where monitoring reports land. Without it, incidents stay on this machine.',
      'setd.watchdogScanSec': 'How often anomalies are scanned. 60s by default; smaller costs more.',
      'setd.autoHeal': 'Runs diagnose → act → re-check. Money, outbound replies and data integrity stay manual.',
      'setd.receiveAccount': 'The account customers are told to pay into.',
      'setd.receiveQrAlipay': 'Alipay QR shown on the plans page.',
      'setd.receiveQrWechat': 'WeChat QR shown on the plans page.',
      'setd.platformFee': 'Tiered platform fee judged on last 365 days of settled revenue.',
      'setd.partnerSharePct': 'Partner revenue share. Fee + share must not exceed 100%.',
      'setd.kpiStart': 'The day daily revenue starts counting.',
      'setd.orcaSlots': 'How many background jobs run at once.',
      'setd.autopilot': 'Run operations rounds automatically on an interval.',
      'setd.lessonNoiseFloor': 'Conclusions below this confidence never enter long-term memory.',
      'setd.paywallOn': 'Off means every endpoint is free. Currently paused.',
      'setd.publicBase': 'Base address for public links and callbacks.',
      'setd.devcapOverrides': 'Manual corrections to auto-assessed capability (JSON).',
      'setd.visitorSecret': 'Visitor credential. Shown only as configured/masked.',
      'setd.adminToken': 'Admin credential. Shown only as configured/masked.',
      'setd.theme': 'Colour scheme id.',
      'seto.zh': 'Chinese',
      'seto.en': 'English',
      'seto.ar': 'Arabic',
      'seto.notice': 'Notice',
      'seto.alert': 'Alert',
      'seto.success': 'Success',
    },
    ar: {
      'nav.chat': 'المحادثة الذكية', 'nav.decision': 'مركز القرار', 'nav.org': 'عقل المؤسسة',
      'nav.project': 'إدارة المشاريع', 'nav.tasks': 'لوحة المهام', 'nav.audit': 'سجل التدقيق',
      'nav.setting': 'إعدادات النظام', 'nav.brain': 'الذاكرة · التعلم · التطور',
      'nav.skills': 'ترسانة المهارات', 'nav.agents': 'مركز الوكلاء', 'nav.studiohub': 'استوديو الإبداع',
      'nav.auto': 'التشغيل الذاتي 24س', 'nav.cmd': 'برج القيادة', 'nav.guard': 'الحارس',
      'nav.warroom': 'غرفة العمليات', 'nav.subs': 'الخطط · الحاجز', 'nav.rank': 'لوحة المتصدرين',
      'nav.watch': 'المراقبة 24س', 'nav.kpi': 'أهداف المهمة', 'nav.capmap': 'خريطة القدرات', 'nav.gtm': 'سوق اكتساب العملاء', 'nav.partner': 'برنامج الشركاء', 'nav.cashier': 'صندوق النقد', 'nav.outreach': 'التواصل الخارجي', 'nav.convert': 'تحويل العملاء المحتملين', 'nav.commercial-loop': 'الحلقة التجارية', 'nav.funnel': 'القمع', 'nav.compliance': 'مركز الامتثال', 'nav.validator': 'ملتقى التحقق من المشاريع',
      'common.save': 'حفظ', 'common.cancel': 'إلغاء', 'common.close': 'إغلاق',
      'common.confirm': 'تأكيد', 'common.delete': 'حذف', 'common.edit': 'تعديل',
      'common.add': 'إضافة', 'common.export': 'تصدير', 'common.import': 'استيراد',
      'common.refresh': 'تحديث', 'common.test': 'تجربة', 'common.loading': 'جارٍ التحميل…',
      'common.saved': 'تم الحفظ', 'common.none': 'لا شيء', 'common.total': 'الإجمالي',
      'common.status': 'الحالة', 'common.action': 'إجراء', 'common.name': 'الاسم',
      'chat.model': 'النموذج', 'chat.lang': 'لغة الواجهة', 'chat.output': 'المخرجات',
      'chat.text': 'نص', 'chat.voice': 'الصوت', 'chat.deep': 'تفكير عميق',
      'chat.export': '⬇ تصدير', 'chat.mic': 'إدخال صوتي', 'chat.cam': 'الكاميرا',
      'chat.clear': 'مسح المحادثة', 'chat.placeholder': 'اسأل أي شيء، سأستدعي كل وحدات النظام للإجابة…',
      'chat.send': 'إرسال', 'chat.thinking': 'يفكر', 'chat.growing': 'يتعلم',
      'set.title': 'إعدادات النظام',
      'set.language': 'لغة الواجهة',
      'set.languageDesc': 'يتبدل النظام بالكامل فورًا — كل صفحة وزر ورسالة تتبع ذلك، بلا اختلاط لغوي.',
      'set.theme': 'المظهر', 'set.themeDesc': 'نظام الألوان يُطبّق فورًا ويُحفظ في الذاكرة.',
      'set.sound': 'أصوات التنبيه', 'set.soundDesc': 'كل حدث يستخدم نغمة مختلفة، فلا يتشابه كل التنبيه.',
      'set.soundOn': 'تفعيل التنبيهات', 'set.soundTest': '🔔 تجربة', 'set.soundPick': 'اختر الصوت',
      'set.keys': 'مزودو النماذج · مفاتيح API', 'set.keysSave': '💾 حفظ المفاتيح',
      'set.update': 'التحديث الذاتي', 'set.ver': 'الإصدار الحالي', 'set.updateCheck': 'فحص التحديثات',
      'set.updateDesc': 'نسخة محلية. افحص أحدث إصدار وقِس مسار الترقية.',
      'set.goal': 'أهداف المهمة', 'set.goalDesc': 'الهدف المرشِد الأساسي لكل الوحدات. أضف ما تشاء.',
      'set.goalAdd': 'إضافة هدف', 'goal.ph': 'مثال: إيراد 10 ملايين خلال ستة أشهر', 'goal.amt': 'القيمة المستهدفة',
      'goal.empty': 'لا يوجد هدف بعد. عند ضبطه يتوجّه البرج وغرفة العمليات والتشغيل الذاتي 모두 إليه.',
      'wall.free': 'الاستخدامات المجانية', 'wall.t': '🔒 انتهت الحصة المجانية',
      'wall.m': 'اشترك لفتح كل الميزات. weChat / Alipay مدعومان؛ كل الإيرادات تُسوّى عبر Alipay.',
      'wall.later': 'تصفح أكثر', 'wall.subNow': 'اشترك',
      'set.hub': 'مركز إعدادات النظام',
      'set.covOk': 'قابل للتهيئة',
      'set.goFix': 'إصلاح',
      'set.showAdv': 'إظهار المتقدم',
      'set.saveAll': 'حفظ كل الإعدادات',
      'set.notSet': 'غير مُهيأ',
      'set.configured': 'مُهيأ',
      'set.noChange': 'لا تغيير',
      'set.rejected': 'مرفوض',
      'set.savedAll': 'حُفظت الإعدادات',
      'set.moneyConfirm': 'الإعدادات التالية تؤثر على أموال حقيقية. تأكيد؟',
      'set.notInPage': 'هذا العنصر ليس في هذه الصفحة',
      'set.amtPh': 'القيمة المستهدفة',
      'set.modelCol': 'النموذج الافتراضي',
      'set.keysCol': 'المفتاح',
      'grp.lang': 'الواجهة',
      'grp.sound': 'أصوات التنبيه',
      'grp.keys': 'المزودون والمفاتيح',
      'grp.alert': 'المراقبة والتنبيهات',
      'grp.money': 'المدفوعات وتوزيع الإيرادات',
      'grp.exec': 'التنفيذ والتوازي',
      'grp.billing': 'الخطط والحاجز',
      'grp.goal': 'أهداف المهمة',
      'grp.adv': 'متقدم وبيانات',
      'setk.lang': 'لغة الواجهة',
      'setk.sound': 'أصوات التنبيه',
      'setk.soundKind': 'الحدث الافتراضي',
      'setk.provider': 'المزود الافتراضي',
      'setk.alertEmail': 'صندوق التنبيهات',
      'setk.watchdogScanSec': 'فترة الفحص (ث)',
      'setk.autoHeal': 'حلقة الإصلاح التلقائي',
      'setk.receiveAccount': 'حساب التحصيل',
      'setk.receiveQrAlipay': 'رمز علي باي',
      'setk.receiveQrWechat': 'رمز ويتشات',
      'setk.platformFee': 'رسوم المنصة (%)',
      'setk.partnerSharePct': 'حصة الشريك (%)',
      'setk.kpiStart': 'بداية حساب المؤشر',
      'setk.orcaSlots': 'خانات التوازي',
      'setk.autopilot': 'التشغيل الذاتي 24س',
      'setk.lessonNoiseFloor': 'حد ضوضاء الدروس',
      'setk.paywallOn': 'تفعيل الحاجز',
      'setk.publicBase': 'الرابط العام',
      'setk.devcapOverrides': 'تجاوزات قدرات التطوير',
      'setk.visitorSecret': 'مفتاح الزائر',
      'setk.adminToken': 'رمز المدير',
      'setk.theme': 'السمة',
      'setd.lang': 'يتبع النظام بالكامل فورًا بلا اختلاط لغوي.',
      'setd.sound': 'كل حدث يستخدم نغمة مختلفة.',
      'setd.soundKind': 'النغمة المستخدمة عند عدم تحديد نوع الحدث.',
      'setd.provider': 'القناة الافتراضية للمحادثة (تتراجع تلقائيًا).',
      'setd.alertEmail': 'حيث تصل تقارير المراقبة. بدونه تبقى الحوادث على هذا الجهاز.',
      'setd.watchdogScanSec': 'كم مرة يتم فحص الاستثناءات. 60 ثانية افتراضيًا؛ تقليله يزيد الحمل.',
      'setd.autoHeal': 'يشغّل تشخيص ← تنفيذ ← إعادة فحص. المال والردود الخارجية وسلامة البيانات يدوية.',
      'setd.receiveAccount': 'الحساب الذي يُبلَّغ به العملاء الدفع.',
      'setd.receiveQrAlipay': 'رمز علي باي في صفحة الخطط.',
      'setd.receiveQrWechat': 'رمز ويتشات في صفحة الخطط.',
      'setd.platformFee': 'رسوم منصة متدرجة على آخر 365 يومًا من الإيراد المُسوّى.',
      'setd.partnerSharePct': 'حصة الشريك. مجموع الرسوم والحصة لا يتجاوز 100%.',
      'setd.kpiStart': 'اليوم الذي يبدأ عنده حساب الإيراد اليومي.',
      'setd.orcaSlots': 'كم مهمة خلفية تعمل معًا.',
      'setd.autopilot': 'تشغيل جولات التشغيل تلقائيًا.',
      'setd.lessonNoiseFloor': 'الاستنتاجات أقل من هذه الثقة لا تدخل الذاكرة.',
      'setd.paywallOn': 'إيقافه يعني أن كل النقاط مجانية. حالياً متوقف.',
      'setd.publicBase': 'العنوان الأساسي للروابط العامة.',
      'setd.devcapOverrides': 'تصحيحات يدوية للقدرة المقدّرة تلقائيًا (JSON).',
      'setd.visitorSecret': 'بيانات الزائر. تُعرض كـ مُهيأ/مقنّعة فقط.',
      'setd.adminToken': 'بيانات المدير. تُعرض كـ مُهيأ/مقنّعة فقط.',
      'setd.theme': 'معرّف نظام الألوان.',
      'seto.zh': 'الصينية',
      'seto.en': 'الإنجليزية',
      'seto.ar': 'العربية',
      'seto.notice': 'تنبيه عادي',
      'seto.alert': 'إنذار',
      'seto.success': 'نجاح'

    }
  };

  // ---- 3. 词表（中文原文 → 译文），自动扫描的底层数据 ------------------------
  // 键 = 界面里真实出现的中文原文（可以是一句话，也可以是一个词）。
  // 值 = [英文, 阿拉伯文]。顺序固定，别写反。
  // 【为什么按"中文原文"而不是按语义 key 建表】
  // 因为自动扫描拿到的是**已经拼好的成品文案**（含 emoji、标点、动态数字）。
  // 反查表能直接命中，用户看到的就是译文；不需要每个渲染点都改代码。
    var TRANS = {
    '🙋 申请协助': ['🙋 Request assistance', '🙋 طلب مساعدة'],
    '🧓 老人端': ['🧓 Elder app', '🧓 تطبيق كبار السن'],
    '👨‍👩‍👧 子女端': ['👨‍👩‍👧 Family app', '👨‍👩‍👧 تطبيق العائلة'],
    '↩️ 申请退款': ['↩️ Request refund', '↩️ طلب استرداد'],
    '退款原因（选填，300 字以内）': ['Refund reason (optional, within 300 chars)', 'سبب الاسترداد (اختياري، 300 حرفًا كحد أقصى)'],
    '提交退款申请': ['Submit refund request', 'إرسال طلب الاسترداد'],
    '可选：上传转账成功截图（上传后系统可立即核账，无需等待）': ['Optional: upload the transfer-success screenshot — the system can reconcile instantly after upload, no waiting', 'اختياري: ارفع لقطة نجاح التحويل — يمكن للنظام المصادقة فورًا بعد الرفع دون انتظار'],
    '可选：接收付款凭证与续费提醒的邮箱': ['Optional: email to receive payment proof & renewal reminders', 'اختياري: البريد الإلكتروني لاستلام إثبات الدفع وتذكيرات التجديد'],
    '失败': ['Failed', 'فشل'],
    '成功': ['Succeeded', 'نجح'],
    '完成': ['Done', 'مكتمل'],
    '已完成': ['Completed', 'مكتمل'],
    '执行中': ['Running', 'قيد التنفيذ'],
    '进行中': ['In progress', 'قيد التقدم'],
    '运行中': ['Running', 'قيد التشغيل'],
    '加载中': ['Loading…', 'جارٍ التحميل…'],
    '待确认': ['Pending confirmation', 'بانتظار التأكيد'],
    '待办': ['To do', 'قيد الانتظار'],
    '已停止': ['Stopped', 'متوقف'],
    '停止': ['Stop', 'إيقاف'],
    '暂停': ['Paused', 'متوقف مؤقتًا'],
    '通过': ['Passed', 'ناجح'],
    '未知': ['Unknown', 'غير معروف'],
    '暂无': ['None', 'لا يوجد'],
    '暂无数据': ['No data yet', 'لا توجد بيانات'],
    '未配置': ['Not configured', 'غير مُهيأ'],
    '已就绪': ['Ready', 'جاهز'],
    '离线': ['Offline', 'غير متصل'],
    '在岗': ['On duty', 'في الخدمة'],
    '无产出': ['No output', 'لا مخرجات'],
    '有降级产出': ['Degraded output', 'مخرجات منخفضة'],
    '网络异常': ['Network error', 'خطأ في الشبكة'],
    '空闲': ['Idle', 'خامل'],
    '忙碌': ['Busy', 'مشغول'],
    '降级': ['Degraded', 'متدهور'],
    '正常': ['Normal', 'طبيعي'],
    '异常': ['Abnormal', 'غير طبيعي'],
    '受阻': ['Blocked', 'متعثر'],
    '在跑': ['In flight', 'قيد التنفيذ'],
    '有期限': ['Has deadline', 'له موعد نهائي'],
    '保存': ['Save', 'حفظ'],
    '取消': ['Cancel', 'إلغاء'],
    '关闭': ['Close', 'إغلاق'],
    '确定': ['Confirm', 'تأكيد'],
    '删除': ['Delete', 'حذف'],
    '编辑': ['Edit', 'تعديل'],
    '添加': ['Add', 'إضافة'],
    '导出': ['Export', 'تصدير'],
    '导入': ['Import', 'استيراد'],
    '刷新': ['Refresh', 'تحديث'],
    '试听': ['Test', 'تجربة'],
    '搜索': ['Search', 'بحث'],
    '筛选': ['Filter', 'تصفية'],
    '全部': ['All', 'الكل'],
    '查看': ['View', 'عرض'],
    '复制': ['Copy', 'نسخ'],
    '删除全部': ['Delete all', 'حذف الكل'],
    '执行': ['Run', 'تنفيذ'],
    '立即跑一轮': ['Run one round now', 'شغّل جولة الآن'],
    '生成': ['Generate', 'توليد'],
    '重置': ['Reset', 'إعادة تعيين'],
    '提交': ['Submit', 'إرسال'],
    '发送': ['Send', 'إرسال'],
    '回复': ['Reply', 'رد'],
    '下载': ['Download', 'تنزيل'],
    '安装': ['Install', 'تثبيت'],
    '装载': ['Load', 'تحميل'],
    '卸载': ['Unload', 'إلغاء التحميل'],
    '启用': ['Enable', 'تفعيل'],
    '禁用': ['Disable', 'تعطيل'],
    '采纳': ['Adopt', 'اعتماد'],
    '验证': ['Verify', 'تحقق'],
    '调用': ['Call', 'استدعاء'],
    '检索': ['Search', 'بحث'],
    '部署': ['Deploy', 'نشر'],
    '同步中…': ['Syncing…', 'جارٍ المزامنة…'],
    '生成中…': ['Generating…', 'جارٍ التوليد…'],
    '执行中…': ['Running…', 'جارٍ التنفيذ…'],
    '检查中…': ['Checking…', 'جارٍ الفحص…'],
    '推演中…': ['Simulating…', 'جارٍ المحاكاة…'],
    '调用中…': ['Calling…', 'جارٍ الاستدعاء…'],
    '查询超时': ['Query timed out', 'انتهت مهلة الاستعلام'],
    '执行失败': ['Run failed', 'فشل التنفيذ'],
    '装载失败': ['Load failed', 'فشل التحميل'],
    '保存失败': ['Save failed', 'فشل الحفظ'],
    '状态': ['Status', 'الحالة'],
    '合计': ['Total', 'الإجمالي'],
    '总数': ['Total', 'الإجمالي'],
    '成功率': ['Success rate', 'نسبة النجاح'],
    '耗时': ['Time taken', 'المدة'],
    '平均': ['Average', 'متوسط'],
    '节点': ['Nodes', 'العُقد'],
    '边': ['Edges', 'الحواف'],
    '平均度': ['Avg degree', 'متوسط الدرجة'],
    '孤立节点': ['Isolated nodes', 'العُقد المعزولة'],
    '验证率': ['Verification rate', 'نسبة التحقق'],
    '槽位利用率': ['Slot utilisation', 'استخدام الخانات'],
    '平均耗时ms': ['Avg ms', 'متوسط المدة (مللي ثانية)'],
    '任务总数': ['Total tasks', 'إجمالي المهام'],
    '技能总数': ['Total skills', 'إجمالي المهارات'],
    '覆盖模块': ['Covered modules', 'الوحدات المغطاة'],
    '待归类': ['Unclassified', 'غير مصنّف'],
    '待验证结论': ['Unverified conclusions', 'استنتاجات غير محققة'],
    '学习产出累计': ['Cumulative learning output', 'إجمالي مخرجات التعلم'],
    '外部收录': ['External', 'خارجي'],
    '外部能力域': ['External domains', 'مجلدات خارجية'],
    '内置分类': ['Built-in categories', 'تصنيفات مدمجة'],
    '内置（可直接调）': ['Built-in (directly callable)', 'مدمج (قابل للاستدعاء)'],
    '未验证（仅参考）': ['Unverified (reference only)', 'غير محقق (مرجعي فقط)'],
    '决策焦点': ['Decision focus', 'محور القرار'],
    '内容': ['Content', 'المحتوى'],
    '近 7 天新增': ['Added in 7 days', 'أُضيف خلال 7 أيام'],
    '近7天反馈': ['7-day feedback', 'تغذية 7 أيام'],
    '近7天订单': ['7-day orders', 'طلبات 7 أيام'],
    '队列': ['Queue', 'الطابور'],
    '来源:': ['Source:', 'المصدر:'],
    '成本': ['Cost', 'التكلفة'],
    '手册': ['Manual', 'الدليل'],
    '装备': ['Gear', 'التجهيز'],
    '一键五吃': ['One-click all', 'بنقرة واحدة'],
    '全载体授权': ['All-channel auth', 'تفويض كل المنصات'],
    '去发布台': ['Go to publisher', 'إلى منصة النشر'],
    '被看见': ['Be seen', 'أن يُرى'],
    '给我那盏灯添一次被看见': ['Light my lamp once', 'أضئ مصباحي مرة'],
    '存': ['Save', 'حفظ'],
    '点击完成': ['Click to complete', 'اضغط للإكمال'],
    '查邻域': ['Query neighbourhood', 'استعلام الجوار'],
    '设为核心': ['Set as core', 'اجعله محوريًا'],
    '奖励': ['Reward', 'مكافأة'],
    '成长': ['Growth', 'نمو'],
    '学习': ['Learning', 'تعلم'],
    '进化': ['Evolution', 'تطور'],
    '记忆': ['Memory', 'ذاكرة'],
    '记忆 · 学习 · 进化': ['Memory · Learn · Evolve', 'الذاكرة · التعلم · التطور'],
    '大脑实验室': ['Brain lab', 'مختبر الدماغ'],
    '全部模块': ['All modules', 'كل الوحدات'],
    '技能进化': ['Skill evolution', 'تطور المهارات'],
    '员工技能进化': ['Employee skill evolution', 'تطور مهارات الموظفين'],
    '指挥建议': ['Command advice', 'توصيات القيادة'],
    '作战指挥塔': ['Command Tower', 'برج القيادة'],
    '战情室': ['War Room', 'غرفة العمليات'],
    '同在守护': ['Guardian', 'الحارس'],
    '作战数据底座': ['Operational data base', 'قاعدة البيانات التشغيلية'],
    '七段报告': ['Seven-part report', 'تقرير من سبعة أقسام'],
    '七段决策报告': ['Seven-part decision report', 'تقرير قرار من سبعة أقسام'],
    '客服工单': ['Support tickets', 'تذاكر الدعم'],
    '故事工厂': ['Story factory', 'مصنع القصص'],
    '冷启动': ['Cold start', 'البدء البارد'],
    '已发车': ['Dispatched', 'أُرسل'],
    '留存件': ['Retention items', 'عناصر الاحتفاظ'],
    '还债件': ['Repayment items', 'عناصر السداد'],
    '专家会诊': ['Expert consultation', 'استشارة الخبراء'],
    '决策框架库': ['Decision frameworks', 'مكتبة أطر القرار'],
    '审计日志': ['Audit log', 'سجل التدقيق'],
    '全网抓取': ['Web-wide crawl', 'زحف الويب'],
    '情报采集': ['Intelligence gathering', 'جمع المعلومات'],
    '商机': ['Opportunity', 'فرصة'],
    '线索': ['Lead', 'فرصة'],
    '成交': ['Deal', 'صفقة'],
    '订单金额': ['Order value', 'قيمة الطلب'],
    '内容生产': ['Content production', 'إنتاج المحتوى'],
    '发布队列': ['Publish queue', 'طابور النشر'],
    '平台适配': ['Platform adapters', 'مهايئات المنصات'],
    '凭证已配': ['Credentials set', 'بيانات الاعتماد مضبوطة'],
    '凭据': ['Credentials', 'بيانات الاعتماد'],
    '最后成功': ['Last success', 'آخر نجاح'],
    '未执行': ['Not executed', 'لم يُنفَّذ'],
    '成员': ['Member', 'عضو'],
    '天后台见分晓': ['days to reveal', 'يومًا حتى الحسم'],
    '分歧度': ['Divergence', 'درجة الاختلاف'],
    '参与': ['Participants', 'المشاركون'],
    '共识': ['Consensus', 'الإجماع'],
    '推理链': ['Reasoning chain', 'سلسلة الاستدلال'],
    '领先类型': ['Leading type', 'النوع الغالب'],
    '决策人格分布': ['Decision persona distribution', 'توزيع شخصيات القرار'],
    '分场景': ['By scenario', 'حسب السيناريو'],
    '手册开放': ['Manuals issued', 'الأدلة المُصدَرة'],
    '末尾时间': ['Latest time', 'آخر وقت'],
    '近 30 天决策': ['Decisions in 30 days', 'قرارات 30 يومًا'],
    '使用说明': ['Usage', 'الاستخدام'],
    '确认': ['Confirm', 'تأكيد'],
    '复习': ['Review', 'مراجعة'],
    '范围': ['Scope', 'النطاق'],
    '模块': ['Module', 'وحدة'],
    '层': ['Layer', 'طبقة'],
    '闭环': ['Closed loop', 'حلقة مغلقة'],
    '健康': ['Healthy', 'سليم'],
    '枢纽': ['Hub', 'محور'],
    '分层': ['Layered', 'متعدد الطبقات'],
    '子图': ['Subgraph', 'رسم فرعي'],
    '路径': ['Path', 'مسار'],
    '邻域': ['Neighbourhood', 'الجوار'],
    '知识图谱': ['Knowledge graph', 'رسم المعرفة'],
    '图谱': ['Graph', 'الرسم البياني'],
    '语义': ['Semantic', 'دلالي'],
    '短路': ['Shortest path', 'أقصر مسار'],
    '广度': ['Breadth', 'العرض'],
    '深度': ['Depth', 'العمق'],
    '建图': ['Build graph', 'بناء الرسم'],
    '单点执行': ['Single action', 'تنفيذ مفرد'],
    '收载': ['Collapsed', 'مطوي'],
    '未收载': ['Not collapsed', 'غير مطوي'],
    '标准': ['Standard', 'معيار'],
    '边界': ['Boundary', 'حدود'],
    '重叠': ['Overlap', 'تداخل'],
    '分类': ['Category', 'تصنيف'],
    '可执行': ['Executable', 'قابل للتنفيذ'],
    '无法执行': ['Not executable', 'غير قابل للتنفيذ'],
    '已收录': ['Included', 'مُدرج'],
    '安装包': ['Package', 'حزمة'],
    '技能': ['Skill', 'مهارة'],
    '技能库': ['Skill library', 'مكتبة المهارات'],
    '技能军械库': ['Skill Arsenal', 'م Arsenal المهارات'],
    '装载后即可调用': ['Callable once loaded', 'قابل للاستدعاء بعد التحميل'],
    '自我进化': ['Self-evolution', 'التطور الذاتي'],
    '发现': ['Discover', 'اكتشاف'],
    '收录': ['Index', 'فهرسة'],
    '协作': ['Collaboration', 'تعاون'],
    '联通': ['Connected', 'موصول'],
    '互联互通': ['Interconnected', 'مترابط'],
    '协同': ['Synergy', 'تآزر'],
    '会诊': ['Consult', 'استشارة'],
    '讨论': ['Debate', 'نقاش'],
    '收敛': ['Converge', 'تقارب'],
    '分工': ['Division of labour', 'تقسيم العمل'],
    '链路': ['Chain', 'سلسلة'],
    '命令': ['Command', 'أمر'],
    '学习进化': ['Learn & evolve', 'التعلم والتطور'],
    '先进后传': ['Learn then hand over', 'يتعلم ثم يسلّم'],
    '自主运营': ['Autonomous operations', 'تشغيل ذاتي'],
    '自托管': ['Self-hosted', 'مستضاف ذاتيًا'],
    '全媒体': ['All media', 'كل المنصات'],
    '全网': ['Whole web', 'الويب كله'],
    '文案': ['Copy', 'النص الإعلاني'],
    '图片': ['Image', 'صورة'],
    '视频': ['Video', 'فيديو'],
    '音乐': ['Music', 'موسيقى'],
    '游戏': ['Game', 'لعبة'],
    '影视': ['Film & TV', 'أفلام'],
    '创作工坊': ['Creation Studio', 'استوديو الإبداع'],
    '音乐制作': ['Music production', 'إنتاج موسيقي'],
    '游戏制作': ['Game development', 'إنتاج ألعاب'],
    '视频制作': ['Video production', 'إنتاج فيديو'],
    '制作要素': ['Production elements', 'عناصر الإنتاج'],
    '历史作业': ['Past jobs', 'أعمال سابقة'],
    '历史构建': ['Past builds', 'بناءات سابقة'],
    '构建': ['Build', 'بناء'],
    '运行': ['Run', 'تشغيل'],
    '负载': ['Load', 'الحِمل'],
    '架构': ['Architecture', 'معمارية'],
    '根节点': ['Root node', 'العقدة الجذر'],
    '找到': ['Found', 'تم العثور على'],
    '核验完成': ['Verification complete', 'اكتمل التحقق'],
    '共': ['Total', 'الإجمالي'],
    '条': ['items', 'عنصر'],
    '项': ['items', 'عنصر'],
    '次': ['times', 'مرة'],
    '天': ['days', 'يوم'],
    '人': ['people', 'شخص'],
    '分级': ['Tiered', 'مقسّم'],
    '主观': ['Subjective', 'ذاتي'],
    '平均耗时': ['Avg time', 'متوسط الم.Duration'],
    '熟练': ['Proficient', 'متمكن'],
    '智能对话': ['Chat', 'المحادثة الذكية'],
    '决策中心': ['Decisions', 'مركز القرار'],
    '组织大脑': ['Organization', 'عقل المؤسسة'],
    '项目管理': ['Projects', 'إدارة المشاريع'],
    '任务台': ['Tasks', 'لوحة المهام'],
    '系统设置': ['Settings', 'إعدادات النظام'],
    'Agent 管理中心': ['Agent Center', 'مركز الوكلاء'],
    '24h 自主运营': ['24h Autopilot', 'التشغيل الذاتي 24س'],
    '订阅 · 收费墙': ['Plans · Paywall', 'الخطط · الحاجز'],
    '排行榜': ['Leaderboard', 'لوحة المتصدرين'],
    '24h 监控告警': ['24h Watchdog', 'المراقبة 24س'],
    '目标任务': ['Mission Goals', 'أهداف المهمة'],
    '核心目标': ['Core goal', 'الهدف الأساسي'],
    '优化目标': ['Optimisation goal', 'هدف التحسين'],
    '指导目标': ['Guiding goal', 'هدف إرشادي'],
    '累计': ['Cumulative', 'تراكمي'],
    '今日': ['Today', 'اليوم'],
    '本月': ['This month', 'هذا الشهر'],
    '已达成': ['Achieved', 'مُنجز'],
    '达成率': ['Achievement rate', 'نسبة الإنجاز'],
    '缺口': ['Gap', 'الفجوة'],
    '万': ['0.01M', '0.01م'],
    '编排状态': ['Orchestration state', 'حالة التنسيق'],
    '已落地': ['Delivered', 'مُنجز فعليًا'],
    '未落地': ['Not delivered', 'لم يُنجز'],
    '已联动': ['Linked', 'مترابط'],
    '动作': ['Actions', 'إجراءات'],
    '全部动作': ['All actions', 'كل الإجراءات'],
    '本轮动作': ['This round’s actions', 'إجراءات هذه الجولة'],
    '最近': ['Latest', 'الأحدث'],
    '历史记录': ['History', 'السجل'],
    '已回复': ['Replied', 'تم الرد'],
    '已生成': ['Generated', 'تم التوليد'],
    '已保存': ['Saved', 'تم الحفظ'],
    '已装载': ['Loaded', 'محمّل'],
    '装载中': ['Loading…', 'جارٍ التحميل…'],
    '已存在': ['Already exists', 'موجود مسبقًا'],
    '已派发': ['Dispatched', 'مُرسَل'],
    '未就绪': ['Not ready', 'غير جاهز'],
    '已自动保存当前配置': ['Current settings saved automatically', 'حُفظت الإعدادات الحالية تلقائيًا'],
    '跳过': ['Skip', 'تخطٍّ'],
    '请填写': ['Please fill in', 'يرجى التعبئة'],
    '点击互动': ['Click to interact', 'اضغط للتفاعل'],
    '未解锁': ['Locked', 'مقفل'],
    '待到账': ['Awaiting settlement', 'بانتظار التسوية'],
    '阻塞于': ['Blocked at', 'متعثر عند'],
    '槽位': ['Slot', 'خانة'],
    '通道': ['Channel', 'قناة'],
    '降级通道': ['Degraded channel', 'قناة بديلة'],
    '记录': ['Record', 'سجل'],
    '暂无记录': ['No records', 'لا توجد سجلات'],
    '暂无任务': ['No tasks', 'لا توجد مهام'],
    '未知错误': ['Unknown error', 'خطأ غير معروف'],
    '服务连接异常，请重试': ['Service connection error, please retry', 'خطأ في اتصال الخدمة، يرجى المحاولة'],
    '引擎异常': ['Engine error', 'خطأ في المحرك'],
    '引擎不可达': ['Engine unreachable', 'المحرك غير متاح'],
    '引擎在线': ['Engine online', 'المحرك متصل'],
    '引擎离线 · 重连中': ['Engine offline · reconnecting', 'المحرك غير متصل · جارٍ إعادة الاتصال'],
    '网络连接不上': ['Cannot reach the network', 'تعذر الاتصال بالشبكة'],
    '崩溃': ['Crash', 'تعطل'],
    '静默失败': ['Silent failure', 'فشل صامت'],
    '诚实标注': ['Honest labelling', 'وسم صادق'],
    '混沌演练': ['Chaos drill', 'تمرين الفوضى'],
    '启动失败': ['Startup failed', 'فشل بدء التشغيل'],
    '入队失败': ['Enqueue failed', 'فشل الإدراج في الطابور'],
    '录入失败': ['Record failed', 'فشل التسجيل'],
    '生成中': ['Generating…', 'جارٍ التوليد…'],
    '立即执行一轮': ['Run one round now', 'شغّل جولة الآن'],
    '请检查更新': ['Check for updates', 'يرجى فحص التحديثات'],
    '发现新版本': ['New version found', 'تم العثور على إصدار جديد'],
    '自我更新': ['Self update', 'التحديث الذاتي'],
    '员工': ['Staff', 'الموظفون'],
    '项目': ['Project', 'مشروع'],
    '同路人': ['Fellow travellers', 'الرفاق'],
    '丙大山': ['BingDashan', 'بينغ داشان'],
    '随时待命': ['Always on standby', 'جاهز دائمًا'],
    '验收': ['Acceptance', 'قبول'],
    '开始会诊': ['Start consultation', 'ابدأ الاستشارة'],
    '开始会商': ['Start deliberation', 'ابدأ التداول'],
    '需求': ['Requirements', 'المتطلبات'],
    '配置为空': ['Config is empty', 'الإعدادات فارغة'],
    '全部行业': ['All industries', 'كل الصناعات'],
    '获取 AI 建议配置': ['Get AI-suggested config', 'احصل على إعدادات مقترحة من الذكاء الاصطناعي'],
    '技能检索': ['Skill search', 'بحث المهارات'],
    '技能已装载': ['Skill loaded', 'تم تحميل المهارة'],
    '该技能已在库中': ['Skill already in library', 'المهارة موجودة في المكتبة'],
    '技能检索未完成': ['Skill search incomplete', 'لم يكتمل بحث المهارات'],
    '识别到能力缺口：本系统暂无直接完成该请求的模块': ['Capability gap detected: no module can fulfil this request directly', 'ثغرة قدرات: لا توجد وحدة تنفّذ هذا الطلب مباشرة'],
    '未检索到现成开源技能，可通过「记忆 · 学习 · 进化」沉淀新技能补齐': ['No ready-made open-source skill found; build one via Memory · Learn · Evolve', 'لم يُعثر على مهارة مفتوحة جاهزة؛ يمكن بناؤها عبر الذاكرة · التعلم · التطور'],
    '已检索到可装载技能（点击即加入技能军械库': ['Loadable skills found (click to add to the arsenal', 'تم العثور على مهارات قابلة للتحميل (اضغط لإضافتها'],
    '本轮无外部动作': ['No external actions this round', 'لا إجراءات خارجية هذه الجولة'],
    '启动虚拟研发团队': ['Start virtual R&D team', 'شغّل فريق البحث والتطوير الافتراضي'],
    '先写任务': ['Write the task first', 'اكتب المهمة أولًا'],
    '本轮无外部动作（维持自主运营节奏': ['No external actions this round (autonomous rhythm maintained', 'لا إجراءات خارجية هذه الجولة (حافظنا على الإيقاع الذاتي'],
    '增长件': ['Growth items', 'عناصر النمو'],
    '知识沉淀': ['Knowledge consolidation', 'ترسيخ المعرفة'],
    '知识库': ['Knowledge base', 'قاعدة المعرفة'],
    '从在库内容资产取料': ['Draw from library assets', 'استخلاص من أصول المكتبة'],
    '真实发布': ['Truly published', 'نشر حقيقي'],
    '已真实发布': ['Really published', 'تم النشر فعليًا'],
    '发布列车': ['Publishing train', 'قطار النشر'],
    '发布列车状态': ['Publishing train status', 'حالة قطار النشر'],
    '全流程制作': ['End-to-end production', 'إنتاج شامل'],
    '危机': ['Crisis', 'أزمة'],
    '灯角': ['Lamp post', 'منارة'],
    '策略智慧库': ['Strategy wisdom library', 'مكتبة الحكمة الاستراتيجية'],
    '内容复用器': ['Content reuser', 'أداة إعادة استخدام المحتوى'],
    '这段内容值得评估': ['This content is worth evaluating', 'هذا المحتوى يستحق التقييم'],
    '核验全部外部源': ['Verify all external sources', 'تحقق من جميع المصادر الخارجية'],
    '从 GitHub 下载': ['Download from GitHub', 'تنزيل من GitHub'],
    '付费': ['Paid', 'مدفوع'],
    '收费墙弹窗': ['Paywall dialog', 'نافذة الحاجز'],
    '订阅': ['Subscribe', 'اشتراك'],
    '微信': ['WeChat', 'ويتشات'],
    '支付宝': ['Alipay', 'علي باي'],
    '入账': ['Settle in', 'تسجيل'],
    '记一笔入账': ['Record a settlement', 'تسجيل عملية'],
    '金额': ['Amount', 'المبلغ'],
    '报告': ['Report', 'تقرير'],
    '订单': ['Order', 'طلب'],
    '标题': ['Title', 'العنوان'],
    '提示': ['Notice', 'تنبيه'],
    '对话': ['Conversation', 'محادثة'],
    '积分榜': ['Score board', 'لوحة النقاط'],
    '自动下滑': ['Auto scroll', 'تمرير تلقائي'],
    '自动调用': ['Auto invoke', 'استدعاء تلقائي'],
    '停止录制': ['Stop recording', 'إيقاف التسجيل'],
    '朗读': ['Read aloud', 'قراءة صوتية'],
    '语音不可用': ['Voice unavailable', 'الصوت غير متاح'],
    '本机无语音引擎': ['No speech engine on this machine', 'لا يوجد محرك تحويل كلام'],
    '语音失败': ['Voice failed', 'فشل الصوت'],
    '当前浏览器不支持语音识别': ['This browser does not support speech recognition', 'هذا المتصفح لا يدعم التعرف على الصوت'],
    '听完啦，请继续说': ['Got it, keep going', 'تم، تابع'],
    '我在听，请讲': ['I’m listening, go ahead', 'أنا أستمع، تفضل'],
    '语音识别失败，请检查麦克风': ['Speech recognition failed, check your microphone', 'فشل التعرف على الصوت، تحقق من الميكروفون'],
    '当前环境不支持摄像头': ['Camera not supported here', 'الكاميرا غير مدعومة هنا'],
    '摄像头已开启，可用于视频沟通': ['Camera on, ready for video calls', 'الكاميرا مفعّلة وجاهزة للمكالمات'],
    '摄像头调用被拒绝': ['Camera permission denied', 'تم رفض إذن الكاميرا'],
    '摄像头': ['Camera', 'الكاميرا'],
    '不支持': ['Unsupported', 'غير مدعوم'],
    '本地语音识别失败，已切换到手动输入': ['Local speech recognition failed, switched to manual input', 'فشل التعرف المحلي على الصوت، تم التحويل للإدخال اليدوي'],
    '决策': ['Decision', 'قرار'],
    '意图': ['Intent', 'نية'],
    '请选择决策方向': ['Choose a decision direction', 'اختر اتجاه القرار'],
    '结束该焦点': ['End this focus', 'إنهاء هذا المحور'],
    '去任务台查看': ['View in Tasks', 'اعرض في لوحة المهام'],
    '已结束该决策焦点': ['Decision focus ended', 'انتهى محور القرار'],
    '决策已登记': ['Decision registered', 'تم تسجيل القرار'],
    '决策已有答案': ['Decision has an answer', 'للقرار إجابة'],
    '决策尚待回答': ['Decision awaiting answer', 'القرار بانتظار الإجابة'],
    '尚未设定决策焦点。选定方向后，系统会把它拆成指向性任务，并让智能对话朝这个方向回答': ['No decision focus set. Pick a direction and the system will break it into targeted tasks and steer chat that way', 'لم يُحدَّد محور قرار. اختر اتجاهًا وسيحوّله النظام إلى مهام موجهة ويوجّه المحادثة نحوه'],
    '项指向性任务 · 已完成': ['targeted tasks · completed', 'مهمة موجهة · مكتملة'],
    '项指向性任务，智能对话将朝': ['targeted tasks; chat will steer toward', 'مهمة موجهة، ستوجّه المحادثة نحو'],
    '方向回答': ['direction', 'الاتجاه'],
    '六个决策问题': ['decision questions', 'أسئلة القرار'],
    '个决策问题': ['decision questions', 'أسئلة القرار'],
    '会话导出': ['Conversation export', 'تصدير المحادثة'],
    '会话已导出': ['Conversation exported', 'تم تصدير المحادثة'],
    '会话已清空，历史记忆依然保留在大脑中。输入 /recall 可召回': ['Conversation cleared; history stays in memory. Type /recall to recover it', 'مُسحت المحادثة؛ تبقى السجلات في الذاكرة. اكتب /recall للاسترجاع'],
    '让我想想': ['Let me think…', 'دعني أفكر…'],
    '丙大山正在思考': ['BingDashan is thinking', 'بينغ داشان يفكر'],
    '刚才遇到了点状况，再试一次': ['Something went wrong just now, try again', 'حدث خلل للتو، أعد المحاولة'],
    '已回答': ['Answered', 'تمت الإجابة'],
    '配音': ['Voice-over', 'تعليق صوتي'],
    '字幕': ['Subtitles', 'ترجمة'],
    '片头': ['Intro', 'مقدمة'],
    '片尾': ['Outro', 'خاتمة'],
    '配音失败': ['Voice-over failed', 'فشل التعليق الصوتي'],
    '渲染失败': ['Render failed', 'فشل التصيير'],
    '合成失败': ['Synthesis failed', 'فشل التركيب'],
    '空': ['Empty', 'فارغ'],
    '剩': ['Left', 'متبقٍّ'],
    '轮': ['round', 'جولة'],
    '第': ['#', '#'],
    '无': ['None', 'لا شيء'],
    '中': ['In progress', 'قيد'],
    '分': ['min', 'د'],
    '秒': ['s', 'ث'],
    '个': ['items', 'عنصر'],
    '点': ['o’clock', 'ساعة'],
    '班': ['shift', 'وردية'],
    '字': ['chars', 'حرف'],
    '时': ['h', 'س'],
    '和': ['and', 'و'],
    '如': ['e.g.', 'مثال'],
    '合': ['match', 'مطابقة'],
    '仅': ['only', 'فقط'],
    '井': ['Well', 'بئر'],
    '员': ['member', 'عضو'],
    '井A 授权灯角': ['Well A authorised lamp', 'بئر A — منارة مصرّح بها'],
    '井B 公版手册': ['Well B public manual', 'بئر B — الدليل العام'],
    '盏 · 本月递出': ['lamps offered this month', 'مصابيح مُقدَّمة هذا الشهر'],
    '被裁': ['cut', 'مقطوع'],
    '会': ['meeting', 'جلسة'],
    '话': ['words', 'كلمة'],
    '同路': ['Fellowship', 'رفقة'],
    '建议': ['Suggestion', 'اقتراح'],
    '来源': ['Source', 'المصدر'],
    '时长': ['Duration', 'المدة'],
    '管家': ['Butler', 'الوصي'],
    '质量': ['Quality', 'الجودة'],
    '自检': ['Self-check', 'فحص ذاتي'],
    '回馈': ['Feedback', 'تغذية راجعة'],
    '异常处理': ['Exception handling', 'معالجة الاستثناءات'],
    '兜底': ['Fallback', 'احتياطي'],
    '看板': ['Kanban', 'لوحة كانبان'],
    '甘特': ['Gantt', 'مخطط جانت'],
    '里程碑': ['Milestone', 'معلم'],
    '工时': ['Effort', 'ساعات العمل'],
    '预算': ['Budget', 'الميزانية'],
    '收入': ['Revenue', 'الإيراد'],
    '利润': ['Profit', 'الربح'],
    '现金流': ['Cash flow', 'التدفق النقدي'],
    '转化': ['Conversion', 'تحويل'],
    '留存': ['Retention', 'الاحتفاظ'],
    '活跃': ['Active', 'نشط'],
    '回访': ['Follow-up', 'متابعة'],
    '裂变': ['Referral', 'انتشار'],
    '公域': ['Public domain', 'النطاق العام'],
    '私域': ['Private domain', 'النطاق الخاص'],
    '选品': ['Product selection', 'اختيار المنتجات'],
    '话术': ['Script', 'نص/سيناريو'],
    '素材': ['Material', 'مادة'],
    '钩子': ['Hook', 'خطاف'],
    '节奏': ['Rhythm', 'إيقاع'],
    '时机': ['Timing', 'توقيت'],
    '风控': ['Risk control', 'إدارة المخاطر'],
    '合规': ['Compliance', 'الامتثال'],
    '结算': ['Settlement', 'تسوية'],
    '分成': ['Revenue share', 'تقسيم'],
    '返利': ['Rebate', 'خصم مسترد'],
    '推广': ['Promotion', 'ترويج'],
    '投放': ['Ad placement', 'إعلان'],
    'ROI': ['ROI', 'العائد على الاستثمار'],
    '收银台': ['Cashier', 'صندوق النقد'],
    '外发触达': ['Outreach', 'التواصل الخارجي'],
    '线索转化': ['Lead conversion', 'تحويل العملاء المحتملين'],
    '触达记录': ['Outreach records', 'سجلات التواصل'],
    '日配额': ['Daily quota', 'الحصة اليومية'],
    '配额用量': ['Quota usage', 'استخدام الحصص'],
    '渠道效果': ['Channel performance', 'أداء القناة'],
    '转化漏斗': ['Conversion funnel', 'قمع التحويل'],
    '线索详情': ['Lead details', 'تفاصيل العميل المحتمل'],
    '跟进记录': ['Follow-up history', 'سجل المتابعة'],
    '成交详情': ['Deal details', 'تفاصيل الصفقة'],
    '支付通道': ['Payment channel', 'قناة الدفع'],
    '提现账户配置': ['Payout account setup', 'إعداد حساب السحب'],
    '打款指令': ['Payout instruction', 'أمر الدفع'],
    '催款管理': ['Collection management', 'إدارة التحصيل'],
    '保存配置': ['Save settings', 'حفظ الإعدادات'],
    '创建指令': ['Create instruction', 'إنشاء أمر'],
    '发送催款': ['Send reminder', 'إرسال تذكير'],
    '创建收款单': ['Create receipt', 'إنشاء إيصال'],
    '交付明细': ['Delivery details', 'تفاصيل التسليم'],
    '提现': ['Withdrawal', 'سحب'],
    '核销': ['Write-off', 'إلغاء'],
    '收款单': ['Payment order', 'أمر دفع'],
    '订单查询': ['Order query', 'استعلام الطلب'],
    '通道自检': ['Channel self-check', 'فحص ذاتي للقناة'],
    '推广费': ['Promotion fee', 'رسوم الترويج'],
    '预算池': ['Budget pool', 'ميزانية'],
    '线索营收': ['Lead revenue', 'إيرادات العملاء المحتملين'],
    '漏斗': ['Funnel', 'مسار التحويل'],
    '线索池': ['Lead pool', 'مجمع الفرص'],
    '获客': ['Acquisition', 'استحواذ'],
    'ICP': ['ICP', 'ICP'],
    '触达': ['Reachout', 'التواصل'],
    '落地页': ['Landing page', 'صفحة هبوط'],
    '合伙人': ['Partner', 'شريك'],
    '分销': ['Distribution', 'التوزيع'],
    '招募': ['Recruitment', 'التوظيف'],
    '验收': ['Acceptance', 'قبول'],
    '洗单': ['Order washing', 'غسل الطلبات'],
    '对账': ['Reconciliation', 'مطابقة الحسابات'],
    '发票': ['Invoice', 'فاتورة'],
    '税': ['Tax', 'ضريبة'],
    '合同': ['Contract', 'عقد'],
    '续约': ['Renewal', 'تجديد'],
    '流失': ['Churn', 'التسرب'],
    '客单价': ['Average order value', 'متوسط قيمة الطلب'],
    '复购': ['Repeat purchase', 'إعادة الشراء'],
    '口碑': ['Word of mouth', 'التسويق الشفهي'],
    '舆情': ['Public sentiment', 'الرصيد العام'],
    '危机公关': ['Crisis PR', 'إدارة أزمات اتصالية'],
    '内容合规': ['Content compliance', 'امتثال المحتوى'],
    '一键发布': ['One-click publish', 'نشر بنقرة'],
    '定时发布': ['Scheduled publish', 'نشر مجدول'],
    '草稿': ['Draft', 'مسودة'],
    '终稿': ['Final draft', 'المسودة النهائية'],
    '样片': ['Sample', 'عيّنة'],
    '分镜': ['Storyboard', 'لوحة قصة'],
    '镜头': ['Shot', 'لقطة'],
    '配乐': ['Score', 'موسيقى تصوير'],
    '特效': ['VFX', 'مؤثرات'],
    '调色': ['Colour grading', 'تصحيح الألوان'],
    '剪辑': ['Editing', 'مونتاج'],
    '转场': ['Transition', 'انتقال'],
    '字幕轨': ['Subtitle track', 'مسار الترجمة'],
    '详情': ['Details', 'التفاصيل'],
    '概览': ['Overview', 'نظرة عامة'],
    '更多': ['More', 'المزيد'],
    '较少': ['Less', 'أقل'],
    '展开': ['Expand', 'توسيع'],
    '收起': ['Collapse', 'طيّ'],
    '折叠': ['Fold', 'طيّ'],
    '选项': ['Options', 'الخيارات'],
    '选择': ['Select', 'اختيار'],
    '取消选择': ['Deselect', 'إلغاء الاختيار'],
    '请选择': ['Please select', 'يرجى الاختيار'],
    '自定义': ['Custom', 'مخصص'],
    '默认': ['Default', 'افتراضي'],
    '示例': ['Example', 'مثال'],
    '说明': ['Description', 'الوصف'],
    '下一步': ['Next', 'التالي'],
    '上一步': ['Previous', 'السابق'],
    '开始': ['Start', 'ابدأ'],
    '结束': ['End', 'نهاية'],
    '继续': ['Continue', 'متابعة'],
    '审核': ['Review', 'مراجعة'],
    '拒绝': ['Reject', 'رفض'],
    '过滤': ['Filter', 'تصفية'],
    '清空': ['Clear', 'مسح'],
    '复制成功': ['Copied', 'تم النسخ بنجاح'],
    '复制失败': ['Copy failed', 'فشل النسخ'],
    '点击复制': ['Click to copy', 'اضغط للنسخ'],
    '创建': ['Create', 'إنشاء'],
    '更新': ['Update', 'تحديث'],
    '切换': ['Switch', 'تبديل'],
    '已选': ['Selected', 'مختار'],
    '未选': ['Unselected', 'غير مختار'],
    '是': ['Yes', 'نعم'],
    '否': ['No', 'لا'],
    '首次可体验 3 次 AI 对话（无需配置 API Key）': ['First 3 AI chats free (no API key needed)', '3 محادثات AI تجريبية مجانية بدون مفتاح API'],

    '确认': ['Confirm', 'تأكيد'],
    '取消': ['Cancel', 'إلغاء'],
    '刷新': ['Refresh', 'تحديث'],
    '重试': ['Retry', 'إعادة المحاولة'],
    '操作': ['Action', 'إجراء'],
    '详情': ['Details', 'تفاصيل'],
    '展开': ['Expand', 'توسيع'],
    '收起': ['Collapse', 'طي'],
    '复制': ['Copy', 'نسخ'],
    '已复制': ['Copied', 'تم النسخ'],
    '下载': ['Download', 'تنزيل'],
    '上传': ['Upload', 'رفع'],
    '密码': ['Password', 'كلمة المرور'],
    '设置': ['Settings', 'إعدادات'],
    '首页': ['Home', 'الرئيسية'],
    '登录': ['Login', 'تسجيل الدخول'],
    '退出': ['Logout', 'تسجيل الخروج'],
    '退出登录': ['Logout', 'تسجيل الخروج'],
    '立即下载': ['Download now', 'تنزيل الآن'],
    '订阅': ['Subscribe', 'اشترك'],
    '立即订阅': ['Subscribe now', 'اشترك الآن'],
    '升级': ['Upgrade', 'ترقية'],
    '价格': ['Price', 'السعر'],
    '金额': ['Amount', 'المبلغ'],
    '订单号': ['Order ID', 'رقم الطلب'],
    '支付': ['Payment', 'الدفع'],
    '付款': ['Pay', 'ادفع'],
    '已支付': ['Paid', 'مدفوع'],
    '未支付': ['Unpaid', 'غير مدفوع'],
    '我已转账，手动确认': ['I have transferred, confirm manually', 'لقد قمت بالتحويل، أؤكد يدويًا'],
    '扫码付款 · 自动开通': ['Scan to pay · Activates instantly', 'امسح للدفع · تفعيل فوري'],
    '推荐下载': ['Recommended download', 'التنزيل الموصى به'],
    '其他平台与备用下载（点击展开）': ['Other platforms & alternatives (expand)', 'منصات أخرى (اضغط للتوسيع)'],

    '备注': ['Note', 'ملاحظة'],
    '标签': ['Tag', 'وسم'],
    '优先级': ['Priority', 'أولوية'],
    '负责人': ['Owner', 'المسؤول'],
    '协作者': ['Collaborators', 'المتعاونون'],
    '创建时间': ['Created at', 'وقت الإنشاء'],
    '更新时间': ['Updated at', 'وقت التحديث'],
    '截止': ['Due', 'الاستحقاق'],
    '截止时间': ['Due date', 'تاريخ الاستحقاق'],
    '开始时间': ['Start time', 'وقت البدء'],
    '结束时间': ['End time', 'وقت الانتهاء'],
    '进度': ['Progress', 'التقدم'],
    '百分比': ['Percentage', 'النسبة'],
    '数量': ['Count', 'العدد'],
    '价格': ['Price', 'السعر'],
    '单位': ['Unit', 'الوحدة'],
    '类型': ['Type', 'النوع'],
    '来源平台': ['Source platform', 'منصة المصدر'],
    '渠道': ['Channel', 'القناة'],
    '行业': ['Industry', 'القطاع'],
    '地区': ['Region', 'المنطقة'],
    '城市': ['City', 'المدينة'],
    '公司': ['Company', 'الشركة'],
    '职位': ['Role', 'المنصب'],
    '联系方式': ['Contact', 'وسيلة التواصل'],
    '备注信息': ['Remarks', 'ملاحظات'],
    '暂无更多': ['Nothing more', 'لا مزيد'],
    '加载更多': ['Load more', 'تحميل المزيد'],
    '返回顶部': ['Back to top', 'العودة للأعلى'],
    '复制链接': ['Copy link', 'نسخ الرابط'],
    '打开链接': ['Open link', 'فتح الرابط'],
    '刷新页面': ['Refresh page', 'تحديث الصفحة'],
    '重新加载': ['Reload', 'إعادة التحميل'],
    '重试': ['Retry', 'إعادة المحاولة'],
    '重试失败': ['Retry failed', 'فشلت إعادة المحاولة'],
    '取消操作': ['Cancel operation', 'إلغاء العملية'],
    '确认删除': ['Confirm delete', 'تأكيد الحذف'],
    '删除确认': ['Delete confirmation', 'تأكيد الحذف'],
    '不可撤销': ['Cannot be undone', 'لا يمكن التراجع'],
    '已确认': ['Confirmed', 'مؤكد'],
    '待审核': ['Pending review', 'بانتظار المراجعة'],
    '审核通过': ['Approved', 'تمت الموافقة'],
    '审核拒绝': ['Rejected', 'مرفوض'],
    '已下架': ['Delisted', 'مُسحب'],
    '上架': ['List', 'إدراج'],
    '草稿箱': ['Drafts', 'المسودات'],
    '指令': ['Directive', 'أمر'],
    '下达': ['Issue', 'إصدار'],
    '下达指令': ['Issue directive', 'إصدار أمر'],
    '接收': ['Receive', 'استلام'],
    '汇报': ['Report back', 'إفادة'],
    '简报': ['Briefing', 'إحاطة'],
    '态势': ['Situation', 'الوضع'],
    '敌我': ['Friendly/foe', 'صديق/عدو'],
    '风险': ['Risk', 'مخاطرة'],
    '风险等级': ['Risk level', 'درجة المخاطرة'],
    '高': ['High', 'عالية'],
    '低': ['Low', 'منخفضة'],
    '预警': ['Warning', 'تحذير'],
    '告警': ['Alert', 'تنبيه'],
    '巡检': ['Patrol', 'دورية'],
    '值班': ['On duty', 'مناوبة'],
    '布防': ['Defend', 'تحصين'],
    '调度': ['Dispatch', 'إرسال'],
    '预案': ['Contingency', 'خطة الطوارئ'],
    '演练': ['Drill', 'تمرين'],
    '战果': ['Outcome', 'النتيجة'],
    '损耗': ['Loss', 'خسارة'],
    '补给': ['Supply', 'إمداد'],
    '弹药': ['Ammo', 'ذخيرة'],
    '阵地': ['Position', 'مركز'],
    '前线': ['Front line', 'الجبهة'],
    '后方': ['Rear', 'المؤخرة'],
    '情报': ['Intelligence', 'معلومات'],
    '情报源': ['Intelligence source', 'مصدر المعلومات'],
    '可信度': ['Confidence', 'درجة الثقة'],
    '时效': ['Timeliness', 'الحداثة'],
    '采纳建议': ['Adopt suggestion', 'اعتماد الاقتراح'],
    '不采纳': ['Reject', 'رفض'],
    '等待指令': ['Awaiting directive', 'بانتظار الأمر'],
    '记忆条目': ['Memory entry', 'مذكرة'],
    '新增记忆': ['Add memory', 'إضافة ذاكرة'],
    '记忆容量': ['Memory capacity', 'سعة الذاكرة'],
    '召回': ['Recall', 'استرجاع'],
    '沉淀': ['Consolidate', 'ترسيخ'],
    '复盘': ['Retrospective', 'مراجعة'],
    '经验': ['Experience', 'خبرة'],
    '教训': ['Lesson', 'درس'],
    '最佳实践': ['Best practice', 'أفضل ممارسة'],
    '失败案例': ['Failure case', 'حالة فشل'],
    '验证结论': ['Verified conclusion', 'استنتاج متحقق'],
    '待验证': ['Awaiting verification', 'بانتظار التحقق'],
    '自检反馈': ['Self-check feedback', 'تغذية الفحص الذاتي'],
    '进化记录': ['Evolution log', 'سجل التطور'],
    '版本': ['Version', 'الإصدار'],
    '变更': ['Change', 'تغيير'],
    '回滚': ['Rollback', 'تراجع'],
    '已回滚': ['Rolled back', 'تم التراجع'],
    '灰度': ['Canary', 'تجريبي'],
    '实验': ['Experiment', 'تجربة'],
    '对照组': ['Control group', 'المجموعة الضابطة'],
    '假设': ['Hypothesis', 'فرضية'],
    '结论': ['Conclusion', 'استنتاج'],
    '证据': ['Evidence', 'دليل'],
    '可信': ['Credible', 'موثوق'],
    '存疑': ['Doubtful', 'مشكوك فيه'],
    '已废弃': ['Deprecated', 'مهمل'],
    '迁移': ['Migrate', 'ترحيل'],
    '归档': ['Archive', 'أرشفة'],
    '技能清单': ['Skill list', 'قائمة المهارات'],
    '技能详情': ['Skill details', 'تفاصيل المهارة'],
    '依赖': ['Dependency', 'تبعية'],
    '依赖项': ['Dependencies', 'التبعيات'],
    '版本号': ['Version', 'رقم الإصدار'],
    '作者': ['Author', 'المؤلف'],
    '许可证': ['License', 'الرخصة'],
    '星标': ['Stars', 'النجوم'],
    '最近更新': ['Last updated', 'آخر تحديث'],
    '调用次数': ['Invocations', 'عدد الاستدعاءات'],
    '失败原因': ['Failure reason', 'سبب الفشل'],
    '重试次数': ['Retries', 'عدد المحاولات'],
    '超时': ['Timeout', 'مهلة'],
    '并发': ['Concurrency', 'التوازي'],
    '排队': ['Queued', 'في الطابور'],
    '调度中': ['Scheduling', 'قيد الجدولة'],
    '已归档': ['Archived', 'مؤرشف'],
    '接入': ['Integrate', 'تكامل'],
    '断开': ['Disconnect', 'قطع'],
    '已连接': ['Connected', 'متصل'],
    '连接中': ['Connecting', 'جارٍ الاتصال'],
    '心跳': ['Heartbeat', 'نبض'],
    '在线': ['Online', 'متصل'],
    '模型': ['Model', 'النموذج'],
    '上下文': ['Context', 'السياق'],
    '温度': ['Temperature', 'حرارة'],
    '最大长度': ['Max length', 'أقصى طول'],
    '消耗': ['Consumed', 'المستهلك'],
    '预算充足': ['Budget sufficient', 'الميزانية كافية'],
    '预算不足': ['Budget insufficient', 'الميزانية غير كافية'],
    '配额': ['Quota', 'الحصة'],
    '用量': ['Usage', 'الاستهلاك'],
    '创作': ['Create', 'إنشاء'],
    '作品': ['Work', 'عمل'],
    '草稿已保存': ['Draft saved', 'حُفظت المسودة'],
    '灵感': ['Inspiration', 'إلهام'],
    '主题色': ['Theme colour', 'لون السمة'],
    '风格': ['Style', 'أسلوب'],
    '节奏型': ['Tempo', 'الإيقاع'],
    '调式': ['Mode', 'السُلّم'],
    '音色': ['Timbre', 'لون الصوت'],
    '和声': ['Harmony', 'وئام'],
    '曲式': ['Form', 'الصيغة'],
    '母带': ['Mastering', 'الماستر'],
    '混音': ['Mixing', 'المزج'],
    '分轨': ['Stem', 'مسار'],
    'BPM': ['BPM', 'BPM'],
    '时长不足': ['Too short', 'المدة قصيرة'],
    '关卡': ['Level', 'مرحلة'],
    '地图': ['Map', 'خريطة'],
    '角色': ['Character', 'شخصية'],
    '数值': ['Stat', 'قيمة'],
    '平衡性': ['Balance', 'التوازن'],
    '可玩性': ['Playability', 'القابلية للعب'],
    '画质': ['Graphics quality', 'جودة الرسوم'],
    '帧率': ['Frame rate', 'معدل الإطارات'],
    '剧情': ['Story', 'الحبكة'],
    '对白': ['Dialogue', 'الحوار'],
    '场景': ['Scene', 'المشهد'],
    '建模': ['Modelling', 'النمذجة'],
    '动作捕捉': ['Motion capture', 'التقاط الحركة'],
    '渲染': ['Render', 'تصيير'],
    '导出视频': ['Export video', 'تصدير الفيديو'],
    '导出音频': ['Export audio', 'تصدير الصوت'],
    '平台': ['Platform', 'منصة'],
    '账号': ['Account', 'حساب'],
    '授权': ['Authorisation', 'تفويض'],
    '已授权': ['Authorised', 'مُفوَّض'],
    '取消授权': ['Revoke access', 'سحب التفويض'],
    '粉丝': ['Followers', 'المتابعون'],
    '曝光': ['Impressions', 'الظهور'],
    '互动率': ['Engagement rate', 'معدل التفاعل'],
    '点赞': ['Likes', 'الإعجابات'],
    '评论': ['Comments', 'التعليقات'],
    '转发': ['Shares', 'المشاركات'],
    '私信': ['Direct message', 'رسالة خاصة'],
    '评论区': ['Comment section', 'قسم التعليقات'],
    '私信已回复': ['DM replied', 'تم الرد على الرسالة'],
    '待回复': ['Awaiting reply', 'بانتظار الرد'],
    '自动回复': ['Auto reply', 'رد آلي'],
    '话术模板': ['Reply template', 'قالب الرد'],
    '定时': ['Scheduled', 'مجدول'],
    '频率': ['Frequency', 'التكرار'],
    '每日上限': ['Daily cap', 'الحد اليومي'],
    '触发条件': ['Trigger', 'شرط التشغيل'],
    '自动化规则': ['Automation rule', 'قاعدة أتمتة'],
    '规则已启用': ['Rule enabled', 'القاعدة مفعّلة'],
    '规则已停用': ['Rule disabled', 'القاعدة متوقفة'],
    '素材库': ['Asset library', 'مكتبة المواد'],
    '内容日历': ['Content calendar', 'تقويم المحتوى'],
    '排期': ['Schedule', 'الجدولة'],
    '待发布': ['Pending publish', 'بانتظار النشر'],
    '已发布': ['Published', 'منشور'],
    '发布失败': ['Publish failed', 'فشل النشر'],
    '发布成功': ['Published successfully', 'تم النشر بنجاح'],
    '抓取': ['Crawl', 'زحف'],
    '来源链接': ['Source link', 'رابط المصدر'],
    '去重': ['Dedupe', 'إزالة التكرار'],
    '相似度': ['Similarity', 'التشابه'],
    '关键词': ['Keywords', 'الكلمات المفتاحية'],
    '筛选条件': ['Filter', 'شرط التصفية'],
    '时间范围': ['Time range', 'المدى الزمني'],
    '近七天': ['Last 7 days', 'آخر 7 أيام'],
    '近三十天': ['Last 30 days', 'آخر 30 يومًا'],
    '自定义区间': ['Custom range', 'فترة مخصصة'],
    '全部类型': ['All types', 'كل الأنواع'],
    '不限': ['Any', 'غير محدود'],
    '请稍候': ['Please wait', 'يرجى الانتظار'],
    '稍后': ['Later', 'لاحقًا'],
    '永不': ['Never', 'أبدًا'],
    '总是': ['Always', 'دائمًا'],
    '自动': ['Auto', 'تلقائي'],
    '手动': ['Manual', 'يدوي'],
    '开关': ['Toggle', 'مفتاح'],
    '启用状态': ['Enabled state', 'حالة التفعيل'],
    '保存并应用': ['Save and apply', 'حفظ وتطبيق'],
    '应用': ['Apply', 'تطبيق'],
    '还原': ['Revert', 'استرجاع'],
    '恢复默认设置': ['Restore defaults', 'استعادة الإعدادات الافتراضية'],
    '导入配置': ['Import config', 'استيراد الإعدادات'],
    '导出配置': ['Export config', 'تصدير الإعدادات'],
    '版本不兼容': ['Version mismatch', 'عدم توافق الإصدار'],
    '请刷新页面': ['Please refresh the page', 'يرجى تحديث الصفحة'],
    '操作已取消': ['Operation cancelled', 'أُلغيت العملية'],
    '操作成功': ['Operation succeeded', 'نجحت العملية'],
    '确定要删除吗': ['Delete this?', 'هل تريد الحذف؟'],
    '删除后不可恢复': ['Cannot be recovered after deletion', 'لا يمكن الاسترجاع بعد الحذف'],
    '共 条记录': ['records in total', 'سجل إجمالًا'],
    '没有更多了': ['No more', 'لا مزيد'],
    '已到底部': ['Reached the end', 'وصلت للنهاية'],
    '查看详情': ['View details', 'عرض التفاصيل'],
    '立即查看': ['View now', 'اعرض الآن'],
    '稍后再说': ['Maybe later', 'لاحقًا'],
    '暂不': ['Not now', 'ليس الآن'],
    '目标': ['Goal', 'هدف'],
    '计划': ['Plan', 'خطة'],
    '深度思考': ['Deep thinking', 'تفكير عميق'],
    '个月': ['months', 'شهر'],
    '一个开关': ['a single switch', 'مفتاح واحد'],
    '半年千万': ['¥10M in six months', '10 ملايين في ستة أشهر'],
    '加入队列': ['Add to queue', 'أضف للطابور'],
    '检查更新': ['Check for updates', 'فحص التحديثات'],
    '当前': ['Current', 'الحالي'],
    '支持': ['Support', 'دعم'],
    '管理中心': ['Center', 'مركز الإدارة'],
    '主题': ['Theme', 'السمة'],
    '森林': ['Forest', 'الغابة'],
    '海蓝': ['Sea blue', 'أزرق البحر'],
    '绯红': ['Crimson', 'قرمزي'],
    '曜橙': ['Solar orange', 'برتقالي شمسي'],
    '鎏金': ['Gilded gold', 'ذهبي مائل'],
    '紫曜': ['Violet', 'بنفسجي'],
    '石墨': ['Graphite', 'جرافيت'],
    '墨黑': ['Ink black', 'أسود حبر'],
    '雾乳': ['Milky mist', 'حليبي ضبابي'],
    '青蓝': ['Cyan blue', 'أزرق سماوي'],
    '量子舰': ['Quantum ship', 'سفينة كممية'],
    '普通提醒': ['Normal notice', 'تنبيه عادي'],
    '当前环境不支持音频': ['Audio not supported here', 'الصوت غير مدعوم هنا'],
    '中文': ['Chinese', 'الصينية'],
    '分隔线': ['Divider', 'فاصل'],
    '你': ['you', 'أنت'],
    '后可用': ['available after load', 'متاح بعد التحميل'],
    '装': ['Load', 'حمّل'],
    '支持（': ['Support (', 'دعم ('],
    '组织尚无人': ['No staff yet', 'لا يوجد موظفون بعد'],
    '下拉新建或对话中录入员工': ['Use the dropdown or add staff via chat', 'استخدم القائمة أو أضف موظفين عبر المحادثة'],
    '点击切换在岗/离线': ['Click to toggle on-duty/offline', 'اضغط للتبديل بين في الخدمة/غير متصل'],
    '员工已加入组织': ['Staff added to the organisation', 'أُضيف الموظف إلى المؤسسة'],
    '新建一个并行项目开始': ['Create a parallel project to start', 'أنشئ مشروعًا متوازيًا للبدء'],
    '已暂停': ['Paused', 'متوقف مؤقتًا'],
    '指派': ['Assign', 'إسناد'],
    '进行': ['In progress', 'جارٍ'],
    '项目已删除': ['Project deleted', 'حُذف المشروع'],
    '调整进度': ['Adjust progress', 'اضبط التقدم'],
    '员工数据不可用': ['Staff data unavailable', 'بيانات الموظفين غير متاحة'],
    '不指派 / 清除负责人与成员': ['Unassign / clear owner and members', 'إلغاء الإسناد / مسح المسؤول والأعضاء'],
    '指派负责人（输入 编号 或清除': ['Assign owner (enter number or clear', 'إسناد المسؤول (أدخل الرقم أو امسح'],
    '清': ['Clear', 'مسح'],
    '已清除项目人员': ['Project staff cleared', 'مُسح طاقم المشروع'],
    '指派成员（输入编号，逗号分隔多选': ['Assign members (numbers, comma separated', 'إسناد الأعضاء (الأرقام مفصولة بفواصل'],
    '留空表示仅负责人': ['Leave blank for owner only', 'اتركه فارغًا للمسؤول فقط'],
    '人员已指派': ['Staff assigned', 'تم إسناد الموظفين'],
    '项目已启动（并行': ['Project started (parallel', 'بدأ المشروع (متوازي'],
    '对话中说 /task 要做什么 即可创建': ['Say /task what to do in chat to create', 'اكتب /task ماذا تفعل في المحادثة للإنشاء'],
    '任务已创建': ['Task created', 'أُنشئت المهمة'],
    '先输入要会诊的问题': ['Enter the question to consult on', 'أدخل السؤال المراد استشارته'],
    '专家正在独立分析': ['Experts are analysing independently', 'المحلّلون يحللون بشكل مستقل'],
    '会诊完成，已写入决策中心': ['Consultation done, written to Decisions', 'اكتملت الاستشارة وكُتبت في مركز القرار'],
    '知识库为空': ['Knowledge base is empty', 'قاعدة المعرفة فارغة'],
    '用 /knowledge 问题': ['Use /knowledge question', 'استخدم /knowledge سؤال'],
    '问题与答案都要填': ['Both question and answer are required', 'يلزم ملء السؤال والجواب'],
    '知识已沉淀': ['Knowledge consolidated', 'تم ترسيخ المعرفة'],
    '帮我梳理今天做什么': ['Help me plan today', 'ساعدني في تخطيط اليوم'],
    '我的决策中心能做什么': ['What can my Decisions do?', 'ماذا يمكن لمركز القرار أن يفعل؟'],
    '给一个行业人才招聘建议': ['Give me hiring advice for an industry', 'أعطني نصائح توظيف لصناعة'],
    '生成一个技术方案框架': ['Generate a technical proposal framework', 'أنشئ إطار مقترح تقني'],
    '汇报当前系统水位': ['Report current system levels', 'اعرض مستويات النظام الحالية'],
    '已选中框架，填入主题即可应用': ['Framework selected; fill in the topic to apply', 'تم اختيار الإطار، أدخل الموضوع للتطبيق'],
    '个方法论': ['methodologies', 'منهجية'],
    '全部领域': ['All domains', 'كل المجالات'],
    '智能推荐（按话题语义': ['Smart suggestion (by topic semantics', 'اقتراح ذكي (حسب دلالات الموضوع'],
    '未匹配到常见话题，默认推荐通用框架': ['No common topic matched; suggesting a general framework', 'لم يطابق موضوع شائع؛ يُقترح إطار عام'],
    '已选智能推荐框架，点「应用框架」即得结构化决策': ['Suggested framework chosen; click Apply to get a structured decision', 'تم اختيار الإطار المقترح؛ اضغط «تطبيق» للحصول على قرار منظم'],
    '先选一个框架': ['Choose a framework first', 'اختر إطارًا أولًا'],
    '正在应用': ['Applying', 'جارٍ التطبيق'],
    '框架': ['Framework', 'إطار'],
    '框架已应用并沉淀到决策中心': ['Framework applied and recorded in Decisions', 'طُبّق الإطار وسُجل في مركز القرار'],
    '本机': ['This machine', 'هذا الجهاز'],
    '角色专家': ['Role experts', 'خبراء الأدوار'],
    '不足 2 个有效回答，不计算': ['Fewer than 2 valid answers; not computed', 'أقل من إجابتين صالحتين؛ لم يُحسب'],
    '技能包已收录': ['Skill package indexed', 'حُزم المهارات مفهرسة'],
    '已在库中': ['Already in library', 'موجود في المكتبة'],
    '先写下要会商的问题': ['Write the question to deliberate', 'اكتب السؤال المراد التداول فيه'],
    '会商中': ['Deliberating', 'قيد التداول'],
    '真并发': ['True concurrency', 'توازٍ حقيقي'],
    '会商失败': ['Deliberation failed', 'فشل التداول'],
    '自动发布': ['Auto publish', 'نشر تلقائي'],
    '凭证': ['Credentials', 'بيانات الاعتماد'],
    '已开启自动发布': ['Auto publish enabled', 'تم تفعيل النشر التلقائي'],
    '自动发布已关闭': ['Auto publish disabled', 'تم إيقاف النشر التلقائي'],
    '先填凭证值': ['Fill in credentials first', 'أدخل بيانات الاعتماد أولًا'],
    '已完整': ['Complete', 'مكتمل'],
    '仍缺其他项': ['Still missing items', 'ما زالت هناك عناصر ناقصة'],
    '队列为空': ['Queue is empty', 'الطابور فارغ'],
    '就绪': ['Ready', 'جاهز'],
    '缺凭证': ['Missing credentials', 'بيانات اعتماد ناقصة'],
    '待接适配器': ['Awaiting adapter', 'بانتظار المهايئ'],
    '状态分布': ['State distribution', 'توزيع الحالات'],
    '命中': ['Hits', 'تطابقات'],
    '需': ['Requires', 'يحتاج'],
    '先写标题': ['Write a title first', 'اكتب عنوانًا أولًا'],
    '还没有任何平台配好凭证（先在上方填凭证），无法入队': ['No platform has credentials yet (fill them above) so nothing can be queued', 'لا توجد منصة ببيانات اعتماد بعد (أدخلها أعلاه) فلا يمكن الإدراج'],
    '处理中': ['Processing', 'قيد المعالجة'],
    '内容创建失败': ['Content creation failed', 'فشل إنشاء المحتوى'],
    '已入队': ['Queued', 'أُدرج في الطابور'],
    '待命': ['Standby', 'في الاحتياط'],
    '启动中': ['Starting', 'جارٍ البدء'],
    '水位': ['Levels', 'المستويات'],
    '优化建议': ['Optimisation advice', 'اقتراحات التحسين'],
    '天需日均': ['daily average needed over', 'المتوسط اليومي المطلوب خلال'],
    '本周可及': ['reachable this week', 'يمكن بلوغه هذا الأسبوع'],
    '缺': ['Missing', 'ناقص'],
    '会商失败原因': ['Deliberation failure reason', 'سبب فشل التداول'],
    '参数（如': ['Parameters (e.g.', 'المعاملات (مثل'],
    '北京 或': ['Beijing or', 'بكين أو'],
    '这段内容值得评估': ['This content is worth evaluating', 'هذا المحتوى يستحق التقييم'],
    '六型决策人格 · 抉择测试（20 题 · 90 秒': ['Six decision personas · choice test (20 questions · 90s', 'ست شخصيات للقرار · اختبار الاختيار (20 سؤالًا · 90 ثانية'],
    '所有功能模块程序的最核心指导目标，可添加多条': ['The core guiding goal for every module; add as many as you like', 'الهدف المرشِد لكل الوحدات؛ أضف ما تشاء'],
    '已提交，运营确认到账后自动激活（每 5 秒自动检测': ['Submitted; activates automatically once operations confirms settlement (checked every 5s', 'تم الإرسال؛ يُفعَّل تلقائيًا بعد تأكيد العمليات للتسوية (يُفحص كل 5 ثوانٍ'],
    '关于': ['About', 'حول'],
    '首次可体验 3 次 AI 对话（无需配置 API Key）': ['First 3 AI chats free (no API key needed)', '3 محادثات AI تجريبية مجانية بدون مفتاح API'],
    '配置 DeepSeek API Key 后可使用自有额度，调用更灵活': ['Configure DeepSeek API Key for your own quota', 'يمكنك تكوين مفتاح DeepSeek لاستخدام رصيدك الخاص'],
  };

  // ---- 4. 运行状态 --------------------------------------------------------
  var current = FALLBACK;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var HAS_CN = /[\u4e00-\u9fa5]/;

  // 已翻译节点缓存。
  // 【踩过的坑】第一版想把中文原文存成 text 节点的 data-i18n-text 属性——
  // 但 **DOM 文本节点没有 setAttribute**，一调用就抛 TypeError，整页翻译直接崩。
  // 改为：值挂在节点自身的 JS 属性上（__i18nSrc），并用一个 Set 持有引用以便遍历还原。
  // 之所以必须能还原（铁律 B）：切换语言时得先拿回中文原文再翻，
  // 直接拿当前显示的英文去翻，切到阿拉伯语就找不到中文词表了，越翻越乱。
  var translated = new Set();

  // 铁律 B 的落地：单节点还原（中文模式下 trNode 会逐个调用它）
  function restore(node) {
    if (node.__i18nSrc !== undefined && node.nodeValue !== node.__i18nSrc) {
      node.nodeValue = node.__i18nSrc;
    }
  }
  // 全量还原的实现放在第 6 节 applyI18n 旁边（restoreAll），避免同一函数两处定义互相覆盖。

  // ---- 5. 查表 ------------------------------------------------------------
  // t() 两种输入：
  //   t('nav.chat')      → 稳定键，取 DICT
  //   t('全部')           → 中文原文，先查 DICT 再查 TRANS
  function t(key, vars) {
    if (key == null) return '';
    var s = '';
    var lang = DICT[current];
    if (lang && key in lang) s = lang[key];
    else if (DICT[FALLBACK] && key in DICT[FALLBACK]) s = DICT[FALLBACK][key];
    else {
      // 词表值是 [英文, 阿拉伯文]——中文就是键本身（原文），不需要另存。
      // 【踩过的坑】第一版按 [zh, en, ar] 三元组去取下标 0/1/2，
      // 结果切到英文时取到 index 1 = **阿拉伯文**，界面全变阿语，
      // 而且不报任何错——这种"看起来实现了、其实全错"的 bug 最费时间。
      // 【zh 守卫·动态回归抓出】current==='zh' 时必须返回键本身；
      // 否则 t(中文) 在中文模式下会返回英文译文（违反上两行的设计注释）。
      var tr = TRANS[key];
      if (tr) s = current === 'zh' ? key : (current === 'ar' ? (tr[1] || '') : (tr[0] || ''));
    }
    if (!s) return '';
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) {
      return vars[k] !== undefined ? vars[k] : m;
    });
    return s;
  }

  // 最长优先的词表匹配：一句"执行失败，共 3 项"里，"执行失败"必须先于"失败"被替换，
  // 否则会翻成 "执行Failed"。按长度降序贪心。
  var TERM_KEYS = Object.keys(TRANS).sort(function (a, b) { return b.length - a.length; });
  // 【驾驶舱专有词表·惰性合并】index.html 的 681 条中文（文本节点 + placeholder/title/alt/aria-label）
  // 不塞进本文件，而由 web/i18n-console.js 提供 window.__CONSOLE_I18N__。
  // 在 applyI18n 启动时合并一次并重算 TERM_KEYS —— 兼容脚本加载顺序（console 文件在 i18n.js 前后均可）。
  var __consoleMerged = false;
  function mergeConsole() {
    if (__consoleMerged) return;
    var extra = (typeof window !== 'undefined' && window.__CONSOLE_I18N__) || null;
    if (!extra) return;
    var changed = false;
    for (var k in extra) {
      if (!Object.prototype.hasOwnProperty.call(extra, k)) continue;
      var nv = extra[k];
      var ov = TRANS[k];
      // 【驾驶舱词表**优先**】同一串中文，index.html 里往往需要更贴语境的译法：
      //   「收银台」→ Checkout（不是泛词 Cashier）、「同在守护」→ Always With You（品牌名）。
      // 更关键的是修「语言夹生」：主词表个别旧译会把英文/拉丁词漏进阿语（如「技能军械库」
      // 译成「م Arsenal المهارات」），只靠"不覆盖"会让驾驶舱继续中英阿混排。
      // 因此：相同键且译文完全一致时跳过（保持幂等），否则以驾驶舱词表为准。
      if (ov && ov[0] === nv[0] && ov[1] === nv[1]) continue;
      TRANS[k] = nv;
      changed = true;
    }
    if (changed) TERM_KEYS = Object.keys(TRANS).sort(function (a, b) { return b.length - a.length; });
    __consoleMerged = true;
  }

  // 【属性自动翻译】placeholder/title/alt/aria-label 里含中文且**没有** data-i18n-* 显式钩子的，
  // 用同一套词表（trSegment）翻译。原文登记到 data-i18n-attr-src-<name> 以便切语言时先还原（铁律 B）。
  // 这样无需给 index.html 的 104 处属性逐个加钩子，也覆盖了此前完全没有处理路径的 alt / aria-label。
  var AUTO_ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  function trAttrs(scope) {
    if (current === 'zh') return;
    $$('[placeholder],[title],[alt],[aria-label]', scope).forEach(function (el) {
      for (var i = 0; i < AUTO_ATTRS.length; i++) {
        var name = AUTO_ATTRS[i];
        if (!el.hasAttribute(name)) continue;
        if (name === 'placeholder' && el.hasAttribute('data-i18n-ph')) continue;      // 交给 6.1
        if (name === 'title' && el.hasAttribute('data-i18n-title')) continue;         // 交给 6.1
        var src = 'data-i18n-attr-src-' + name;
        if (el.getAttribute(src) == null) {
          var cur = el.getAttribute(name);
          if (!cur || !HAS_CN.test(cur)) continue;    // 非中文不值得登记，避免无谓属性
          el.setAttribute(src, cur);
        }
        el.setAttribute(name, trSegment(el.getAttribute(src)));
      }
    });
  }
  function restoreAttrs() {
    $$('[data-i18n-attr-src-placeholder],[data-i18n-attr-src-title],[data-i18n-attr-src-alt],[data-i18n-attr-src-aria-label]').forEach(function (el) {
      for (var i = 0; i < AUTO_ATTRS.length; i++) {
        var v = el.getAttribute('data-i18n-attr-src-' + AUTO_ATTRS[i]);
        if (v != null) el.setAttribute(AUTO_ATTRS[i], v);
      }
    });
  }
  // 【语言夹生的根因·已修】TRANS 里有 41 个**单字键**（中→In progress、点→o'clock、是→Yes、
  // 会→meeting、人→people、条/项/个→items…）。它们本是给「+3 条 / 共 5 项」这类**独立**计数量词用的，
  // 但下面是"无脑连续串替换"——于是「商业中枢」被啃成「商业In progress枢」、「设为焦点」→「设为焦o'clock」、
  // 「我是…」→「我Yes…」。英文/阿拉伯语界面到处中英夹生，正是"语言混杂"。
  // 修法：**单字键只有在两侧都不是中文时才算命中**（它必须自成一个词/量词），
  // 绝不会插进另一个中文词内部；多字键维持原样（最长优先，可跨词匹配短语）。
  function trSegment(seg) {
    // seg 一定含中文
    var out = '', i = 0;
    while (i < seg.length) {
      var hit = null;
      for (var k = 0; k < TERM_KEYS.length; k++) {
        var term = TERM_KEYS[k];
        if (term.length > seg.length - i || seg.substr(i, term.length) !== term) continue;
        if (term.length === 1) {
          var prev = i > 0 ? seg.charAt(i - 1) : '';
          var next = i + 1 < seg.length ? seg.charAt(i + 1) : '';
          if ((prev && HAS_CN.test(prev)) || (next && HAS_CN.test(next))) continue; // 夹在中文词内 → 不当作量词
        }
        hit = term; break;
      }
      if (hit) {
        out += t(hit);
        i += hit.length;
      } else {
        out += seg.charAt(i);
        i++;
      }
    }
    return out;
  }

  // 翻译一个文本节点。返回 true 表示改动了。
  function trNode(node) {
    var txt = node.nodeValue;
    if (!txt || !HAS_CN.test(txt)) return false;
    if (current === 'zh') { restore(node); return false; }
    var out = trSegment(txt);
    if (out === txt) return false;
    // 【踩过的坑·已修】原来是：
    //     if (node.__i18nSrc === undefined) { node.__i18nSrc = txt; translated.add(node); }
    // 意思是"只在第一次翻译时登记进集合"。于是 en → ar 这一轮里，
    // 节点因为 __i18nSrc 已存在而**没有**被重新登记；上一轮 restoreAll 又已 clear()。
    // 结果切回中文时 restoreAll 拿到空集合，什么都还原不了 —— 界面卡在阿拉伯语。
    // 探针日志：restoreAll size=3 → … → restoreAll size=0（三语各切一轮后归零）。
    // Set.add 本身幂等，无条件登记即可，既保留原文又不丢成员。
    if (node.__i18nSrc === undefined) node.__i18nSrc = txt;
    translated.add(node);
    node.nodeValue = out;
    return true;
  }

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, CODE: 1, PRE: 1, KBD: 1, SAM: 1 };

  function walk(root, fn) {
    var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (SKIP_TAGS[el.tagName]) continue;
      if (el.getAttribute('data-i18n-skip')) continue;
      fn(el);
      // 【踩过的坑】第一版只处理 el 的**直接**子节点：
      //     c.nodeType === 3 ? fn(c) : fn(c)     // 元素也丢给 fn，但 fn 只认文本
      // 结果 <div><span>成功率</span></div> 这种**嵌套一层**的中文永远翻不到。
      // 现在对子元素递归下去，任何深度的文本节点都会被处理。
      for (var j = 0; j < el.childNodes.length; j++) {
        visit(el.childNodes[j], fn);
      }
    }
    for (var k = 0; k < root.childNodes.length; k++) visit(root.childNodes[k], fn);
  }
  function visit(n, fn) {
    if (!n) return;
    if (n.nodeType === 3) { fn(n); return; }
    if (n.nodeType !== 1) return;
    if (SKIP_TAGS[n.tagName] || n.getAttribute('data-i18n-skip')) return;
    fn(n);
    for (var i = 0; i < n.childNodes.length; i++) visit(n.childNodes[i], fn);
  }

  // ---- 6. 应用 ------------------------------------------------------------
  // 语言下拉框：独立于任何翻译逻辑，最先填充。
  // 【用户报的 bug】设置页"语言"下拉框是空的、切了没反应——此前它只在 applyI18n 的第 6.3 步填充，
  // 一旦前面任何一步抛错，下拉框就永远是空的（而且不报错，只是"切了没反应"）。
  // 现在把它提到最前面、并在启动时单独再调一次，保证一定可选。
  function buildLangSelect() {
    // 支持多处语言选择器：#langSel（设置页）与任意带 data-lang-select 的元素（如顶栏）。
    // 顶栏常驻切换器让"当前语言"一眼可见，不必进设置页找。
    $$('#langSel, [data-lang-select]').forEach(function (sel) {
      sel.innerHTML = LANGUAGES.map(function (l) {
        return '<option value="' + l.code + '"' + (l.code === current ? ' selected' : '') + '>' + l.label + '</option>';
      }).join('');
      sel.value = current;
    });
  }

  function applyI18n(root) {
    var scope = root || document;
    try { mergeConsole(); } catch (e) {}   // 词表合并必须先于任何翻译（文本与属性都依赖 TERM_KEYS）
    try { buildLangSelect(); } catch (e) {}

    // 【顺序修复：还原必须最先做】
    // 原顺序是「先 6.1 显式键 → 再 6.2 里 restoreAll()」，
    // 结果 6.1 把**已经翻译过的文字**当成 data-i18n-src 存下来，
    // 随后的 restoreAll() 又用这个错的值覆盖回去 —— 切回中文时恢复成英文，
    // 而 data-i18n 元素因为存了错误原文，第二语言切换后就不再变化。
    // 这种 bug 不报错，只是"切了没反应"，极难发现。
    if (scope === document) restoreAll();

    // 6.1 显式键
    // 缺词兜底：t(key) 对未收录键返回空串，直接写入会把标签清空
    //（用户报的“商业闭环四个字不见了”就是这个：nav.commercial-loop 只存在于英文词典）。
    // 一律回退到 data-i18n-src（原始中文），保证任何语言下都不出现空白标签。
    $$('[data-i18n]', scope).forEach(function (el) {
      if (el.getAttribute('data-i18n-src') == null) el.setAttribute('data-i18n-src', el.textContent);
      el.textContent = t(el.getAttribute('data-i18n')) || el.getAttribute('data-i18n-src') || '';
    });
    $$('[data-i18n-ph]', scope).forEach(function (el) {
      if (el.getAttribute('data-i18n-ph-src') == null) el.setAttribute('data-i18n-ph-src', el.getAttribute('placeholder') || '');
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')) || el.getAttribute('data-i18n-ph-src') || '');
    });
    $$('[data-i18n-title]', scope).forEach(function (el) {
      if (el.getAttribute('data-i18n-title-src') == null) el.setAttribute('data-i18n-title-src', el.getAttribute('title') || '');
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')) || el.getAttribute('data-i18n-title-src') || '');
    });
    $$('[data-i18n-html]', scope).forEach(function (el) {
      if (el.getAttribute('data-i18n-html-src') == null) el.setAttribute('data-i18n-html-src', el.innerHTML);
      el.innerHTML = t(el.getAttribute('data-i18n-html')) || el.getAttribute('data-i18n-html-src') || '';
    });

    // 6.2 自动扫描（核心）：把词表能命中的中文全部翻掉。
    // 必须在 restoreAll() 与 6.1 **之后**做：先还原成中文原文，再按当前语言翻一次。
    walk(scope, function (n) {
      if (n.nodeType === 3) trNode(n);
    });

    // 6.2.1 属性自动翻译（placeholder/title/alt/aria-label 无显式钩子者）
    try { trAttrs(scope); } catch (e) {}

    // 6.3 语言下拉框 + 文档语言与方向
    buildLangSelect();
    syncDocLang();
  }

  function restoreAll() {
    // 先还原 data-i18n 系列（属性里的原文是权威来源）
    $$('[data-i18n-src]').forEach(function (el) {
      el.textContent = el.getAttribute('data-i18n-src');
    });
    $$('[data-i18n-ph-src]').forEach(function (el) {
      el.setAttribute('placeholder', el.getAttribute('data-i18n-ph-src'));
    });
    $$('[data-i18n-title-src]').forEach(function (el) {
      el.setAttribute('title', el.getAttribute('data-i18n-title-src'));
    });
    $$('[data-i18n-html-src]').forEach(function (el) {
      el.innerHTML = el.getAttribute('data-i18n-html-src');
    });
    // 再还原被词表翻过的文本节点
    translated.forEach(function (n) {
      if (n.__i18nSrc !== undefined) n.nodeValue = n.__i18nSrc;
    });
    translated.clear();
    // 还原自动翻译过的属性（placeholder/title/alt/aria-label）
    restoreAttrs();
  }

  function syncDocLang() {
    var m = meta(current);
    document.documentElement.setAttribute('lang', m.htmlLang);
    document.documentElement.setAttribute('dir', m.dir);
  }

  // ---- 7. 动态内容监听 ----------------------------------------------------
  var mo = null;
  function ensureObserver() {
    if (mo || typeof MutationObserver === 'undefined') return;
    mo = new MutationObserver(function (muts) {
      if (current === 'zh') return;
      var touched = false;
      muts.forEach(function (m) {
        for (var i = 0; i < m.addedNodes.length; i++) {
          var n = m.addedNodes[i];
          if (n.nodeType === 3) { trNode(n); touched = true; }
          else if (n.nodeType === 1) {
            walk(n, function (x) { if (x.nodeType === 3) { trNode(x); touched = true; } });
          }
        }
      });
      if (touched) scheduleReport();
    });
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
  }

  // ---- 8. 覆盖率报告（铁律 A：漏网的必须被看见）---------------------------
  var reportTimer = null;
  function scheduleReport() {
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = setTimeout(function () { reportTimer = null; }, 1500);
  }
  // 私有哨兵：用于把已命中词表的片段从文本里挖掉
  var SENTINEL = '\u0001';
  function collectMissing() {
    var missed = {};
    if (typeof document.createTreeWalker !== 'function') return missed;
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !HAS_CN.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        var p = node.parentNode;
        while (p) {
          if (p.nodeType === 1 && (SKIP_TAGS[p.tagName] || p.getAttribute('data-i18n-skip'))) return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n;
    while ((n = w.nextNode())) {
      if (current === 'zh') { missed[n.nodeValue.trim()] = true; continue; }
      // 把词表命中的片段替换成一个私有哨兵，剩下的碎片就是漏网的词条。
      // 【踩过的坑】第一版写成 rest.split(k).join('') 再 rest.split(/\s+/)，
      // 结果把**所有**内容连同分隔符一起删掉了，报告恒为空 —— 等于没做检测。
      var rest = n.nodeValue;
      for (var ti = 0; ti < TERM_KEYS.length; ti++) {
        var tk = TERM_KEYS[ti];
        if (rest.indexOf(tk) >= 0) rest = rest.split(tk).join(SENTINEL);
      }
      rest.split(SENTINEL).forEach(function (piece) {
        var cn = piece.match(/[\u4e00-\u9fa5]+/g);
        if (cn) cn.forEach(function (c) { if (c.length) missed[c] = true; });
      });
    }
    return missed;
  }
  function coverage() {
    var m = collectMissing();
    var keys = Object.keys(m);
    var lang = DICT[current];
    var missKeys = [];
    if (lang) Object.keys(DICT.zh).forEach(function (k) { if (!(k in lang)) missKeys.push(k); });
    return { lang: current, untranslated: keys, untranslatedCount: keys.length, missingKeys: missKeys };
  }
  function audit() {
    return Object.keys(DICT).map(function (L) {
      var ks = Object.keys(DICT[L]);
      var base = Object.keys(DICT.zh);
      return {
        lang: L, keys: ks.length,
        missing: base.filter(function (k) { return !(k in DICT[L]); }),
        extra: ks.filter(function (k) { return !(k in DICT.zh); })
      };
    });
  }

  // ---- 9. 对外 ----------------------------------------------------------
  function setLang(code) {
    var next = norm(code);
    var changed = next !== current;
    current = next;
    applyI18n();
    ensureObserver();
    if (changed) {
      if (global.console && console.info) {
        console.info('[i18n] 切换到 ' + next + (next === 'zh' ? '' : '，未收录中文 ' + coverage().untranslatedCount + ' 处（见 I18N.coverage()）'));
      }
    }
    return current;
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  global.I18N = {
    // set 是 setLang 的别名：app.js 全篇调用 I18N.set()，此前只导出了 setLang，
    // 导致 restoreSettings/switchLang 一调用就 TypeError，语言下拉框永远填不上、切语言无反应。
    t: t, applyI18n: applyI18n, audit: audit, ready: ready, setLang: setLang, set: setLang,
    coverage: coverage, collectMissing: collectMissing, trSegment: trSegment,
    LANGUAGES: LANGUAGES, DICT: DICT, TRANS: TRANS,
    legacy: function (key) {
      var map = { free: 'wall.free', wallT: 'wall.t', wallM: 'wall.m', later: 'wall.later', subNow: 'wall.subNow' };
      return t(map[key] || key);
    },
    get: function () { return current; }
  };
  global.__i18nSet = function (code) { current = norm(code); syncDocLang(); return current; };

  // 事件委托兜底：万一 app.js 的 change 监听没挂上（脚本报错 / 元素被替换），
  // 这里也保证"选了下拉框就一定切换语言"，不会出现"切了没反应"。
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el && (el.id === 'langSel' || el.hasAttribute('data-lang-select')) && el.value) {
      try { setLang(el.value); } catch (err) {}
      // 同步其它语言选择器，避免两处显示不一致
      try { buildLangSelect(); } catch (err) {}
    }
  }, true);

  // 启动即应用一次：否则在页面加载时从未有人调用 set/setLang，
  // applyI18n() 不会运行 → #langSel 下拉框空白、导航/按钮也不翻译（用户报的正是这一条）。
  ready(function () {
    try { buildLangSelect(); } catch (e) {}   // 先保证下拉框可选（不依赖翻译是否成功）
    // 【语言不能乱·防闪屏】启动时先读本地已选语言（bd_lang）。
    // 否则首屏总是先用 fallback(zh) 渲染，等 /v1/settings 回来才切走 —— 那一闪就是"语言乱"。
    var bootLang = current;
    try { var saved = localStorage.getItem('bd_lang'); if (saved) bootLang = saved; } catch (e) {}
    try { setLang(bootLang); } catch (e) { /* 容错：任何单点失败都不该让整页语言失效 */ }
  });
})(window);