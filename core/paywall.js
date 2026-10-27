// core/paywall.js — 收费墙覆盖治理（第 15 条需求）
//
// 【需求】"订阅收费墙针对的是所有项目，要求支付完善收款准确"
//
// 【诊断出的真问题：覆盖率不可见】
// 全系统有几百个 HTTP 端点、50+ 功能模块，但收费墙只挂在 server.js 里的
// gateSection(...) 调用上——我实测全文件只有 **13 处调用、6 个分区**。
// 也就是说：绝大多数"项目"（音乐制作、游戏制作、战情室、指挥塔、组织大脑、
// 记忆中心、Agent 会诊之外的几乎所有模块）**完全不收费**，
// 而且没人能一眼看出哪些漏了。
//
// "针对的是所有项目"这句话，在没有覆盖清单的前提下是无法验证的承诺。
//
// 【解法】把"哪些功能归入哪个收费分区"变成**声明式注册表**，
// 再由本模块反查覆盖率：
//   sections      分区定义（每个分区有免费额度与说明）
//   endpoints     端点 → 分区的映射表（新增端点时必须登记）
//   coverage()    反查：哪些端点没登记、哪些分区没用到 → 直接报出来
//
// 【红线】不为了"看起来覆盖了"而给只读/健康检查类端点也收费。
// 收费墙的作用是限制**有成本或有价值**的能力，
// 给 /v1/status 收费只会让人无法检查自己是否已订阅。
// 所以覆盖率报告区分【应收费】与【公共/只读】两类，并把后者显式列出。

const store = require('./store');

// —— 收费分区 ——
// 与 subs.js 的 POOLS 对齐，但这里是**唯一权威**：
// 之前 quota 写在 subs.js 里，这里再抄一份就成了两处口径，必然漂移。
//
// 【2026-10-23 能力成熟度标签 + Blueprint 说明（借鉴 ai-dots.org 证据分级）】
//   maturity  — 'tested'(✅ 实测稳定) / 'beta'(🔄 可用) / 'experimental'(⚠️ 实验性)
//   blueprint — 结构化使用说明：Goal / Inputs / Controls / Output / Failure
//   dataScope — 数据访问边界（哪些数据该模块能触及）
//   humanReview — 是否需要人工审批
// 目的：让订阅墙与功能入口能标注成熟度，消除"黑盒"式信任成本。
const SECTIONS = {
  chatdeep: {
    quota: 8, label: '深度思考', desc: '结构化推理（假设→依据→结论）', cost: 'LLM 调用',
    labelEn: 'Deep Reasoning', labelAr: 'تفكير عميق',
    descEn: 'Structured reasoning (hypothesis → evidence → conclusion)',
    descAr: 'استدلال منظم (فرضية ← دليل ← نتيجة)',
    maturity: 'tested',
    blueprint: {
      goal: '对复杂问题给出带推理链条的结构化判断',
      inputs: '问题描述、类别标签、上下文、偏好约束',
      controls: 'depth 开关、超时（12s）、安全模式',
      output: '结论 + 依据节点链 + 置信度评估',
      failure: '模型通道不可用时降级至本地模板并明示未走深度路径'
    },
    dataScope: '本项目文本上下文与已加载的记忆', humanReview: false
  },
  decision: {
    quota: 10, label: '决策框架', desc: '56 个决策方法论的应用与建议', cost: '本地计算',
    labelEn: 'Decision Frameworks', labelAr: 'أطر القرار',
    descEn: 'Apply 56 decision methodologies with recommendations',
    descAr: 'تطبيق ٥٦ منهجية قرار مع التوصيات',
    maturity: 'tested',
    blueprint: {
      goal: '从 56 个方法论中选出最适配的框架并给出行动建议',
      inputs: '当前目标、焦点焦点、约束条件、偏好（可选）',
      controls: '方法论白名单、行业路由、日限 10',
      output: '建议框架 + 步骤行动清单 + 风险项',
      failure: '无匹配方法论时降级通用决策模板并说明'
    },
    dataScope: '本项目目标与决策记录', humanReview: false
  },
  skill: {
    quota: 10, label: '技能调用', desc: '军械库技能执行与联网情报', cost: '可能联网/算力',
    labelEn: 'Skill Execution', labelAr: 'تنفيذ المهارات',
    descEn: 'Run arsenal skills and web intelligence',
    descAr: 'تشغيل مهارات الترسانة واستخبارات الويب',
    maturity: 'tested',
    blueprint: {
      goal: '按任务名称从军械库加载并执行对应技能，返回结果',
      inputs: '技能名 + 调用参数（可选上下文）',
      controls: '联网白名单、超时 30s、日限 10',
      output: '技能执行结果 + 耗时 + 是否触发联网',
      failure: '技能缺失或网络失败 → 明确报错，不虚构结果'
    },
    dataScope: '授权白名单站点与项目数据', humanReview: false
  },
  agent: {
    quota: 6, label: 'Agent 会诊', desc: '专家/团队多 Agent 并行会诊', cost: '多次 LLM 调用',
    labelEn: 'Agent Council', labelAr: 'مجلس الوكلاء',
    descEn: 'Parallel multi-agent expert consultation',
    descAr: 'استشارة خبراء متعددة الوكلاء بالتوازي',
    maturity: 'beta',
    blueprint: {
      goal: '多名专家 Agent 并行会诊复杂问题，输出多视角结论',
      inputs: '会诊主题、可选团队配置、分歧处理策略',
      controls: '并发上限、轮数上限、日限 6',
      output: '各专家结论 + 共识/分歧点 + 综合建议',
      failure: '个别专家掉线时仍输出其余结论并标注缺失'
    },
    dataScope: '专家/团队定义 + 本项目上下文', humanReview: false
  },
  leadgen: {
    quota: 6, label: '获客闭环', desc: '线索推进、看板与漏斗诊断', cost: '可能触达外部',
    labelEn: 'Lead Pipeline', labelAr: 'مسار العملاء المحتملين',
    descEn: 'Lead push, board and funnel diagnosis',
    descAr: 'دفع العملاء ولوحة المسار وتشخيص القمع',
    maturity: 'experimental',
    blueprint: {
      goal: '线索从触达→推进→转正的完整闭环',
      inputs: '线索来源、触达渠道、归因信息',
      controls: '日限 6、外发白名单、静默/确认配置',
      output: '看板状态 + 漏斗转化率 + 下一步动作',
      failure: '无新增线索时报零，不虚构数字'
    },
    dataScope: '线索库 + 外发渠道配置', humanReview: true
  },
  studio: {
    quota: 4, label: '音视频制作', desc: '写稿·配音·成片全流程', cost: 'TTS/ffmpeg 算力',
    labelEn: 'Audio & Video Studio', labelAr: 'استوديو الصوت والفيديو',
    descEn: 'Script · voiceover · final cut pipeline',
    descAr: 'نص · تعليق صوتي · مونتاج نهائي',
    maturity: 'beta',
    blueprint: {
      goal: '写稿 → 配音 → 成片的完整音视频制作流水线',
      inputs: '文案/主题、语音风格、素材引用、时长目标',
      controls: 'TTS 日限 4、素材队列、输出格式',
      output: '任务 ID + 成片 URL + 字幕文件',
      failure: '合成失败 → 任务标记 failed 并保留原稿与日志'
    },
    dataScope: '自上传素材队列与项目文件', humanReview: false
  },
  game: {
    quota: 4, label: '游戏制作', desc: '设计·代码·构建·调优', cost: '代码生成与构建',
    labelEn: 'Game Studio', labelAr: 'استوديو الألعاب',
    descEn: 'Design · code · build · tune',
    descAr: 'تصميم · كود · بناء · ضبط',
    maturity: 'experimental',
    blueprint: {
      goal: '设计 → 代码生成 → 构建 → 调优的游戏原型',
      inputs: '玩法描述、目标引擎、美术风格',
      controls: '构建日限 4、引擎白名单、超时 5min',
      output: '可玩构建产物 + 设计文档 + 构建日志',
      failure: '构建失败 → 返回错误日志，不产出伪可用产物'
    },
    dataScope: '项目内代码仓库与构建系统', humanReview: false
  },
  music: {
    quota: 4, label: '音乐制作', desc: '作曲·编曲·混音工程产出', cost: 'DSP 计算',
    labelEn: 'Music Studio', labelAr: 'استوديو الموسيقى',
    descEn: 'Compose · arrange · mix deliverables',
    descAr: 'تأليف · توزيع · مزج',
    maturity: 'experimental',
    blueprint: {
      goal: '作曲 → 编曲 → 混音的音频工程产出',
      inputs: '曲风、结构（前奏/主歌/副歌）、参考文件（可选）',
      controls: '渲染日限 4、采样率 44.1k、输出时长上限',
      output: '音频文件 URL + 工程说明',
      failure: '渲染失败 → 提示重试并保留工程文件，不产出静默片段'
    },
    dataScope: '项目内音频工程文件', humanReview: false
  },
  warboard: {
    quota: 20, label: '指挥与战情', desc: '指挥塔态势·战情室图表', cost: '聚合大量模块数据',
    labelEn: 'Command & War Room', labelAr: 'القيادة وغرفة العمليات',
    descEn: 'Command tower status and war-room charts',
    descAr: 'حالة برج القيادة ومخططات غرفة العمليات',
    maturity: 'tested',
    blueprint: {
      goal: '全局态势监控与战情图表聚合',
      inputs: '目标与子目标、各模块状态快照',
      controls: '日限 20、聚合频率（60s 轮询）、数据源白名单',
      output: '态势快照 + 告警列表 + 建议行动',
      failure: '数据缺失时只渲染有数据的格子，不补默认值'
    },
    dataScope: '只读聚合全局模块数据', humanReview: false
  },
  org: {
    quota: 15, label: '组织大脑', desc: '组队派工与员工成长', cost: '多表写盘',
    labelEn: 'Org Brain', labelAr: 'دماغ المنظمة',
    descEn: 'Team assembly, dispatch and growth',
    descAr: 'تجميع الفريق والتوزيع والنمو',
    maturity: 'tested',
    blueprint: {
      goal: '基于项目目标组队、派工与成长追踪',
      inputs: '任务描述、员工状态、能力标签',
      controls: '日限 15、派工需确认（可配置自动）',
      output: '分派记录 + 成长日志 + 负载热力',
      failure: '无候选员工时不派工，建议补充'
    },
    dataScope: '员工档案与任务表', humanReview: true
  },
  evolve: {
    quota: 10, label: '学习进化', desc: '经验沉淀与技能检索装载', cost: '可能联网',
    labelEn: 'Learning & Evolution', labelAr: 'التعلم والتطور',
    descEn: 'Capture experience and recall skills',
    descAr: 'تسجيل الخبرة واستدعاء المهارات',
    maturity: 'tested',
    blueprint: {
      goal: '将项目经验沉淀为可复用技能并检索装载',
      inputs: '经验条目、技能名、上下文检索词',
      controls: '日限 10、写入权限白名单、网络超时 10s',
      output: '经验条目 + 技能装载结果 + 检索命中数',
      failure: '写入失败 → 记录日志，不阻塞主流程'
    },
    dataScope: '经验库与技能库（可写）', humanReview: false
  }
};

/**
 * 对外「额度说明」（2026-10-21 新增）
 * ------------------------------------------------------------------
 * 竞品（豆包 2026-07 / Kimi 2026-07）都被用户集中投诉「**额度口径不透明**」→
 * 我们必须把"未订阅能用多少、订阅后每天能用多少"**说清楚**。
 *
 * 【为什么要单独导出】这些数字的**唯一来源**就是上面的 SECTIONS 登记表与
 * core/subs.js 的档位倍率（TIERS）——任何地方手抄都会漂移，所以统一从代码导出，
 * 由落地页与订阅面板按接口渲染。
 * @returns {{free:Array, tiers:Array, note:string}}
 */
function quotaInfo() {
  const heavy = (Array.isArray(require('./subs').HEAVY_SECTIONS) ? require('./subs').HEAVY_SECTIONS : []);
  const TIERS = require('./subs').TIERS || {};
  const TIER_LABEL = { legacy: '历史档', basic: '基础档', pro: '进阶档', vip: 'VIP', sup: '至尊档' };
  const PLAN_TIER = { t: 'basic', m: 'basic', q: 'basic', y: 'basic', p: 'pro', v: 'vip', s: 'sup' };
  const PLANS = require('./subs').PLANS_CN || [];
  const PLANS_EN = require('./subs').PLANS_EN || [];
  const enById = {};
  PLANS_EN.forEach((p) => { enById[p.id] = p.label; });
  const plans = PLANS.map((p) => {
    const tier = p.tier || 'basic';
    const t = TIERS[tier] || TIERS.basic;
    return {
      id: p.id, label: p.label, amount: p.amount, tier,
      // 【2026-10-23】英文/阿文界面此前显示中文套餐名（基础款月度…）→ 补三语映射。
      // 阿拉伯语暂无官方译名，回落英文（比显示中文可读）。
      labelI18n: { zh: p.label, en: enById[p.id] || p.label, ar: enById[p.id] || p.label },
      tierLabel: TIER_LABEL[tier] || tier,
      // 重耗分区的每日上限：倍率 × 该分区基础额度（Infinity = 不限）
      heavyDaily: t.heavyDaily === Infinity ? '∞' : Math.max(1, Math.round(t.heavyDaily)) + '×',
      trial: !!p.trial,
    };
  });
  // 【2026-10-23 成熟度 + Blueprint 说明】把每个分区的能力成熟度与结构化
  // 说明（Goal/Inputs/Controls/Output/Failure）+ 数据边界/人工审批一并导出，
  // 让订阅墙能标注成熟度并展示"能做什么 / 需要什么 / 出了事怎么办"。
  // 缺失时 fallback 到 experimental，绝不静默（fail-closed）。
  const MAT_FALLBACK = 'experimental';
  const free = Object.keys(SECTIONS).map((k) => {
    const s = SECTIONS[k];
    const bp = s.blueprint || {};
    // fail-closed：缺失的 blueprint 字段填空串（前端判断后不渲染空块）
    return {
      key: k, label: s.label, perDay: s.quota, desc: s.desc, cost: s.cost,
      // 【2026-10-23 三语标签】此前英文/阿文用户看到的额度表全是中文标签 +「/日」，
      // 与界面语言混杂（旧的 935 处硬编码问题在收费链路里的残留）。
      // 服务端返回三语映射，前端按当前语言取，缺哪语回落到中文。
      labelI18n: { zh: s.label, en: s.labelEn || s.label, ar: s.labelAr || s.labelEn || s.label },
      descI18n:  { zh: s.desc,  en: s.descEn  || s.desc,  ar: s.descAr  || s.descEn  || s.desc },
      maturity: s.maturity || MAT_FALLBACK,
      blueprint: {
        goal:     bp.goal     || '',
        inputs:   bp.inputs   || '',
        controls: bp.controls || '',
        output:   bp.output   || '',
        failure:  bp.failure  || '',
      },
      dataScope:   s.dataScope   || '本项目数据（只读）',
      humanReview: !!s.humanReview,
    };
  });
  return {
    free,
    heavySections: heavy.slice(),
    tiers: plans,
    // 成熟度分级说明（ai-dots.org 借鉴：让用户理解 ✅/🔄/⚠️ 的含义）
    maturityNote: '成熟度分级：✅ 实测稳定 = 主力路径已在生产验证；🔄 Beta = 可用但仍在打磨；⚠️ 实验性 = 早期能力，产出请人工复核。',
    maturityNoteI18n: {
      zh: '成熟度分级：✅ 实测稳定 = 主力路径已在生产验证；🔄 Beta = 可用但仍在打磨；⚠️ 实验性 = 早期能力，产出请人工复核。',
      en: 'Maturity: ✅ Tested stable = production-verified core path; 🔄 Beta = usable, still being polished; ⚠️ Experimental = early capability, review outputs manually.',
      ar: 'المستوى: ✅ مُختبر ومستقر = مسار أساسي مُتحقق منه في الإنتاج؛ 🔄 تجريبي = قابل للاستخدام وقيد التحسين؛ ⚠️ تجريبي مبكر = قدرة مبكرة، راجع المخرجات يدويًا.'
    },
    note: '未订阅：每个功能区每天有免费额度（用完明日恢复）；订阅后常规功能不限次，重耗功能区按档位提高日限。',
    noteI18n: {
      zh: '未订阅：每个功能区每天有免费额度（用完明日恢复）；订阅后常规功能不限次，重耗功能区按档位提高日限。',
      en: 'Unsubscribed: each section has a free daily quota (resets tomorrow). Subscribed: regular sections are unlimited; heavy sections get a higher daily cap by tier.',
      ar: 'بدون اشتراك: لكل قسم حصة يومية مجانية (تُستعاد غدًا). مع الاشتراك: الأقسام العادية غير محدودة، والأقسام الثقيلة تحصل على سقف يومي أعلى حسب الخطة.'
    },
  };
}

// —— 端点 → 分区 ——
// key 用「方法 路径」。
//
// 【实测覆盖率】全系统 241 个端点，改造前收费墙只覆盖 16 个 = **7%**。
// "针对的是所有项目"在覆盖率只有 7% 时是空话。下面这张表把**有算力/联网/LLM
// 成本或高价值产出**的端点全部纳入；纯只读与个人数据读取列在 PUBLIC。
// 两者相加才是覆盖率，剩下的才是真正需要决策的"漏网"。
// 【2026-10-24 幽灵注册剪除】用运行时探针（tests/e2e_registry_probe.js）对全部注册端点
// 真实发请求对账：以下键在 server.js 里**没有对应路由**（404 no route），属"注册≠存在"
// 的死行。剪掉后行为不变——这些模块的**真实**端点仍由下方 PREFIX_RULES 前缀规则兜底
// 归入同一分区；但注册表从此只说真话，coverage() 的分子不再被幽灵端点虚增。
// 被剪键的完整清单与证据见 docs/registry-audit-2026-10-24.md。
const GATED = {
  // —— 对话与 Agent ——
  'POST /v1/chat': 'chatdeep',                 // 仅 depth=true 实际扣费（见 server.js 内部分支）
  'GET  /v1/brain/learn': 'chatdeep',
  'GET  /v1/brain/recall': 'chatdeep',
  'POST /v1/agents/consult': 'agent',
  'POST /v1/agents/team': 'agent',
  'GET  /v1/agents': 'agent',
  'GET  /v1/agentcenter': 'agent',
  'GET  /v1/agentcenter/agents': 'agent',
  'GET  /v1/agentcenter/coop': 'agent',
  'POST /v1/agentcenter/coop': 'agent',
  'GET  /v1/agentcenter/daemon/status': 'agent',
  'GET  /v1/agentcenter/log': 'agent',

  // —— 决策 ——（/v1/decision/* 单数旧名已无路由，真实路由是 /v1/decisions/* 复数族）
  'GET  /v1/decisions/suggest': 'decision',
  'GET  /v1/decisions/frameworks': 'decision',
  'GET  /v1/decisions/router-graph': 'decision',
  'GET  /v1/decisions/accuracy': 'decision',
  'GET  /v1/decisions/brio': 'decision',
  'POST /v1/decision/focus': 'decision',
  'DELETE /v1/decision/focus': 'decision',
  'GET  /v1/annual': 'decision',
  'GET  /v1/annual/month': 'decision',
  'GET  /v1/annual/stoploss': 'decision',

  // —— 技能与进化 ——
  'POST /v1/skills/invoke': 'skill',
  'POST /v1/skills/inject': 'evolve',
  'POST /v1/skills/remove': 'evolve',
  'GET  /v1/skills/discover': 'evolve',
  'POST /v1/skills/scout': 'evolve',
  'GET  /v1/memory-hub': 'evolve',
  'GET  /v1/memory-hub/entries': 'evolve',
  'GET  /v1/harness/current': 'evolve',
  'GET  /v1/lessons': 'evolve',
  'POST /v1/lessons': 'evolve',
  'POST /v1/autopilot/run': 'evolve',
  'GET  /v1/autopilot/optimize': 'evolve',
  'GET  /v1/autopilot/steps': 'evolve',
  'GET  /v1/autopilot/modules': 'evolve',
  'GET  /v1/autopub/overview': 'evolve',
  'GET  /v1/autopub/assets': 'evolve',

  // —— 获客闭环 ——（其余子端点由前缀 /v1/money/leads、/v1/leadgen、/v1/gtm 兜底）
  'POST /v1/money/leads/touch': 'leadgen',
  'POST /v1/gtm/touch': 'leadgen',

  // —— 音视频 / 游戏 / 音乐（第 14 条新模块）——（其余子端点由前缀规则兜底）
  'POST /v1/studio/produce': 'studio',
  'GET  /v1/studio/capability': 'studio',
  'GET  /v1/studio/jobs': 'studio',
  'GET  /v1/foundry/sources': 'studio',
  'POST /v1/game/build': 'game',
  'POST /v1/game/tune': 'game',
  'GET  /v1/game/engines': 'game',
  'GET  /v1/game/jobs': 'game',
  'POST /v1/music/produce': 'music',
  'GET  /v1/music/capability': 'music',

  // —— 指挥 / 战情 / 组织（第 12、13、4 条）——
  'GET  /v1/warboard': 'warboard',
  'GET  /v1/conductor/status': 'warboard',
  'GET  /v1/conductor/train': 'warboard',
  'POST /v1/conductor/run': 'warboard',
  'POST /v1/goals': 'warboard',
  'DELETE /v1/goals': 'warboard',
  'POST /v1/goals/primary': 'warboard',
  'GET  /v1/org/team': 'org',
  'POST /v1/org/assign': 'org',
  'POST /v1/org/sync': 'org',
  'POST /v1/org/evolve': 'org',
  'GET  /v1/coordinator': 'warboard',
  'GET  /v1/goalpilot/status': 'warboard',
  'GET  /v1/goalpilot/report': 'warboard',
  'GET  /v1/goalpilot/brief': 'warboard',
  'POST /v1/goalpilot/brief/generate': 'warboard',

  // —— 工单 / 协作 / 发布列车 ——
  'GET  /v1/tickets': 'evolve',
  'POST /v1/tickets': 'evolve',
  'GET  /v1/tickets/board': 'evolve',
  'POST /v1/tickets/respond': 'evolve',
  'POST /v1/tickets/conclude': 'evolve',
  'POST /v1/tickets/batch': 'evolve',
  'GET  /v1/train': 'evolve',
  'POST /v1/train/load': 'evolve',
  'POST /v1/train/depart': 'evolve',
  'GET  /v1/train/debt': 'evolve',
  'GET  /v1/playbook': 'evolve',
  'GET  /v1/repurpose': 'evolve',
  'POST /v1/repurpose/feed': 'evolve',
  'POST /v1/repurpose/run': 'evolve',
  'GET  /v1/peers/board': 'evolve',
  'GET  /v1/peers/gua': 'evolve',
  'GET  /v1/foundry': 'studio',
  'GET  /v1/foundry/sources': 'studio',
  'GET  /v1/foundry/works': 'studio',
  'POST /v1/foundry': 'studio',
  'GET  /v1/autopilot/log': 'evolve',
  'GET  /v1/autopilot/status': 'evolve'
};

// 公共/只读：不收费。**每一项都带理由**，可审计。
//
// 最重要的一条原则：**钱相关的端点一律免费**。
// 收费才能查"我付没付钱""我的分成是多少""我的账户余额"——
// 这不仅荒谬，而且会**直接切断付费转化链路**：
// 用户点了订阅 → 支付回调要查状态 → 被闸门拦 → 永远开通不了。
const PUBLIC = [
  // ===== 账户与协助（免费可用：客服链路不能被收费墙挡住）=====
  { ep: 'GET /v1/customer/file', why: '查看自己的订单/权益/工单/资料（客服基础）' },
  { ep: 'POST /v1/assist/request', why: '发起远程协助请求（需同意书）' },
  { ep: 'GET /v1/assist/status', why: '查看自己的协助进度' },
  { ep: 'POST /v1/assist/cancel', why: '撤回自己的协助请求' },
  // ===== 陪护（老人/子女/设备）：客服与安全通道，免费可用 =====
  { ep: 'POST /v1/care/family/create', why: '老人建档（需本人同意）' },
  { ep: 'POST /v1/care/family/join', why: '子女凭邀请码加入（需同意）' },
  { ep: 'GET /v1/care/family', why: '查看自己的家庭与告警' },
  { ep: 'GET /v1/care/profile', why: '查看健康档案' },
  { ep: 'POST /v1/care/profile', why: '更新健康档案' },
  { ep: 'POST /v1/care/device/register', why: '注册陪护设备' },
  { ep: 'POST /v1/care/device/heartbeat', why: '设备心跳（设备令牌）' },
  { ep: 'POST /v1/care/alert', why: '发起 SOS/异常告警' },
  { ep: 'POST /v1/care/alert/ack', why: '告警接单' },
  { ep: 'POST /v1/care/alert/resolve', why: '告警闭环' },
  { ep: 'GET /v1/care/alerts', why: '查看告警记录' },
  { ep: 'POST /v1/care/task', why: '安排服药/打卡/探访任务' },
  { ep: 'POST /v1/care/task/done', why: '完成任务' },
  { ep: 'GET /v1/care/tasks', why: '查看任务' },
  { ep: 'POST /v1/care/doc', why: '上传病历/处方/报告' },
  { ep: 'GET /v1/care/docs', why: '查看资料清单' },
  { ep: 'GET /v1/care/doc/file', why: '下载自己的资料（归属校验）' },
  // ===== 陪护：定价/订阅/治理（2026-10-24）=====
  { ep: 'GET /v1/care/plans', why: '查看陪护定价与种子名额（只读）' },
  { ep: 'POST /v1/care/order', why: '子女开订阅单（未付款=未开通）' },
  { ep: 'GET /v1/care/orders', why: '查看本家庭订阅单' },
  { ep: 'POST /v1/care/doc/delete', why: '删除自己的资料（PIPL 删除权）' },
  { ep: 'POST /v1/care/grant', why: '给运营开单份资料临时授权（可撤回）' },
  { ep: 'POST /v1/care/grant/revoke', why: '撤回临时授权' },
  // —— 钱与订阅：绝不收费（收费即断链）——
  { ep: 'GET /v1/subs', why: '查自己的订阅状态与套餐' },
  { ep: 'GET /v1/subs/due', why: '查待付金额——付费流程自身' },
  { ep: 'GET /v1/subs/orders', why: '查自己的订单' },
  { ep: 'GET /v1/subs/pay-config', why: '取收款配置——付费流程自身' },
  { ep: 'GET /v1/subs/renewal', why: '查续费状态' },
  { ep: 'GET /v1/subs/status', why: '查订阅状态' },
  { ep: 'GET /v1/pay/status', why: '支付状态回调查询' },
  { ep: 'GET /v1/pay/alipay/check', why: '支付宝异步校验——付费流程自身' },
  { ep: 'GET /v1/pay/alipay/return', why: '支付宝同步跳转——付费流程自身' },
  { ep: 'GET /v1/pay/paypal/success', why: 'PayPal 回调' },
  { ep: 'GET /v1/pay/wechat/check', why: '微信支付校验' },
  { ep: 'GET /v1/payout/config', why: '取自己的收款配置' },
  { ep: 'GET /v1/payout/pending', why: '查待打款（真实的打款状态端点是 pending 队列）' },
  { ep: 'GET /v1/money/kpi', why: '查自己的营收 KPI' },
  { ep: 'GET /v1/money/budget', why: '查自己的推广池' },
  { ep: 'GET /v1/money/leads', why: '列出自己的线索' },
  { ep: 'GET /v1/money/receivable', why: '查自己的应收' },
  { ep: 'GET /v1/partner', why: '查自己的合伙人身份与分润（看板数据在 /v1/partner/deliveries）' },
  { ep: 'GET /v1/plans', why: '定价页：收费墙要展示价格' },

  // —— 健康检查与自身数据 ——
  { ep: 'GET /v1/status', why: '健康检查：订阅者必须能确认自己已订阅' },
  { ep: 'GET /v1/diag/loop', why: '诊断端点，运维用' },
  { ep: 'GET /v1/settings', why: '读自己的设置' },
  { ep: 'PATCH /v1/settings', why: '改自己的设置' },
  { ep: 'POST /v1/settings', why: '保存自己的设置' },
  { ep: 'GET /v1/tasks', why: '读自己的任务' },
  { ep: 'POST /v1/tasks', why: '建自己的任务' },
  { ep: 'PATCH /v1/tasks', why: '改自己的任务' },
  { ep: 'DELETE /v1/tasks', why: '删自己的任务' },
  { ep: 'GET /v1/projects', why: '读自己的项目' },
  { ep: 'POST /v1/projects', why: '建自己的项目' },
  { ep: 'PATCH /v1/projects', why: '改自己的项目' },
  { ep: 'GET /v1/goals', why: '读自己的目标' },
  { ep: 'GET /v1/decision/focus', why: '读当前决策焦点' },
  { ep: 'POST /v1/projects/from-decision', why: '从决策一键立项（用户自己的项目数据）' },
  { ep: 'GET /v1/skillspace', why: '技能列表浏览' },
  { ep: 'GET /v1/paywall', why: '读自己的订阅用量台账' },
  { ep: 'POST /v1/paywall/toggle', why: '开关收费墙（管理动作）' },
  // 滥用观测台账：只读诊断，端点自身另需管理令牌（adminAuthedStrict），
  // 收费墙这层对它无意义（管理端自查，不该被墙挡）。登记为公开以免成"漏网"。
  { ep: 'GET /v1/wall/stats', why: '免费额度滥用观测台账（只读诊断，另需管理令牌）' },
  { ep: 'GET /v1/hw/scan', why: '硬件自感知枚举（宿主机能力，另需管理令牌）' },
  { ep: 'GET /v1/hw/events', why: '热插拔事件台账（宿主机能力，另需管理令牌）' },
  { ep: 'POST /v1/hw/command', why: '硬件语义命令（宿主机能力，另需管理令牌；控制类再需 allowControl）' },
  { ep: 'POST /v1/chat', why: '普通对话（仅 depth=true 才扣 chatdeep）' },
  { ep: 'GET /v1/messages', why: '读自己的会话' },
  { ep: 'GET /v1/audit', why: '读自己的审计' },
  // —— 付费链路自身（POST 也必须免费，理由同上）——
  { ep: 'POST /v1/subs/order', why: '下单——付费流程第一步，绝不能收费' },
  { ep: 'POST /v1/subs/free-trial', why: '领取免费试用 2 天——获客件，绝不能收费' },
  { ep: 'POST /v1/subs/confirm', why: '确认支付' },
  { ep: 'POST /v1/subs/bind', why: '绑定订阅身份' },
  { ep: 'POST /v1/subs/identity', why: '设置身份' },
  { ep: 'POST /v1/subs/redeem', why: '兑换码核销' },
  { ep: 'POST /v1/subs/pay-config', why: '配置收款方式' },
  { ep: 'POST /v1/subs/gate', why: '查询是否被墙' },
  { ep: 'POST /v1/pay/checkout', why: '发起支付——付费流程自身' },
  { ep: 'POST /v1/pay/alipay/notify', why: '支付宝异步通知——付费流程自身' },
  // 【为什么补这几条】微信/到账通知、通道就绪查询、买家"我已转账"回传，
  // 都是付费漏斗自身的端点。微信 notify 尤其关键：它此前**没有**登记，
  // 只因没有 /v1/pay 前缀规则才侥幸不被拦。一旦将来加了 /v1/pay 前缀收费规则，
  // 微信支付的异步回调会被 402 挡下 → 付款永远不激活（CNY 默认通道正是微信兜底）。
  // 支付宝 notify 早已登记，微信这条是遗漏，现补齐对齐。
  { ep: 'POST /v1/pay/wechat/notify', why: '微信支付异步通知——付费流程自身（与支付宝 notify 对齐）' },
  { ep: 'GET  /v1/pay/channels', why: '通道就绪查询——买家据此选支付方式（只读）' },
  { ep: 'POST /v1/pay/manual-confirm', why: '买家回传"我已转账"——只留痕待核账，不开通' },
  { ep: 'POST /v1/payout/config', why: '设置自己的收款配置' },
  { ep: 'GET  /v1/payout/pending', why: '查待打款' },
  { ep: 'POST /v1/payout/dunning', why: '催款' },
  { ep: 'POST /v1/payout/instruction', why: '打款指令' },
  { ep: 'POST /v1/partner/enroll', why: '成为合伙人' },
  { ep: 'POST /v1/partner/deliver', why: '合伙人交付' },
  { ep: 'POST /v1/partner/accept', why: '合伙人验收' },
  { ep: 'POST /v1/partner/paid', why: '标记已付' },
  { ep: 'POST /v1/partner/pay', why: '合伙人打款' },
  { ep: 'GET  /v1/money/writeoffs', why: '查核销' },
  { ep: 'POST /v1/money/credit', why: '记一笔入账（自己的账）' },
  { ep: 'POST /v1/money/settle', why: '结算自己的账' },
  { ep: 'POST /v1/money/spend', why: '记一笔支出（自己的账）' },
  { ep: 'POST /v1/money/writeoff', why: '核销（自己的账）' },

  // —— 个人数据与配置 ——
  { ep: 'GET /v1/my/assets', why: '读自己的资产' },
  { ep: 'GET /v1/leads/roi', why: '读自己线索的 ROI' },
  { ep: 'GET /v1/knowledge/memory', why: '读自己的记忆' },
  // 知识库读取对齐 memory 先例：list() 目前是全局共享列表（core/knowledge.js
  // 直接 store.list('knowledge')），但它是免费档知识面板的读路径（web/app.js 4 处调用），
  // 实测线上当前为空列表（total=0）。按"基础可用性"判为公开——
  // 真正的增值沉淀走 POST/DELETE（受变更限权 + 十七条数据归属），
  // 若把读也墙掉，免费档知识面板直接空白，与只读展示类入口同样的问题。
  { ep: 'GET /v1/knowledge', why: '读知识库——免费档知识面板读路径（与 memory 对齐）' },
  { ep: 'GET /v1/providers', why: '读可用模型通道' },
  { ep: 'GET /v1/free-tier', why: '读官方免费通道状态——本身就是"免费"，收费即自相矛盾' },
  { ep: 'POST /v1/free-tier/discover', why: '在线发现免费模型（管理动作，不改用户数据）' },
  { ep: 'POST /v1/settings/keys', why: '配自己的密钥' },
  { ep: 'POST /v1/sound', why: '警告音设置' },
  { ep: 'POST /v1/voice', why: '语音朗读——基础可用性' },
  { ep: 'POST /v1/verify', why: '基础校验' },
  { ep: 'GET /v1/update/check', why: '检查更新' },
  { ep: 'GET /v1/devcap', why: '设备能力扫描' },
  { ep: 'POST /v1/devcap/plan', why: '自适应参数' },

  // —— 流程端点与运营端点：见下方 FLOW_OPS（付费流程自身 + 严格管理端点）——

  // —— 排行榜 / 监控 / 地理 / 手册 / 邮件 ——

  { ep: 'GET /v1/rank', why: '读排行榜' },
  { ep: 'GET /v1/rank/gap', why: '读排行差距' },
  { ep: 'POST /v1/rank/enter', why: '进入榜单' },
  { ep: 'GET /v1/watch', why: '读监控状态' },
  { ep: 'POST /v1/watch/patrol', why: '手动巡检' },
  { ep: 'GET /v1/geo/clients', why: '读客户地域分布' },
  { ep: 'POST /v1/geo/report', why: '生成地域报告' },
  { ep: 'GET /v1/manuals', why: '读使用手册' },
  { ep: 'POST /v1/manuals/scan', why: '扫描手册缺口' },
  { ep: 'GET /v1/mail/log', why: '读自己的邮件日志' },
  { ep: 'POST /v1/mail', why: '发自己的邮件（授权范围内）' },

  // —— 合伙人/漏斗/外发/商业闭环/调度/工作流（运营配置与统计：基础免费） ——
  { ep: 'GET /v1/partner/deliveries', why: '查自己的交付记录' },
  { ep: 'GET /v1/funnel/snapshots', why: '读漏斗快照' },
  { ep: 'GET /v1/outreach', why: '读外发配置' },
  { ep: 'GET /v1/outreach/config', why: '读外发配置' },
  { ep: 'POST /v1/outreach/config', why: '存外发配置' },
  { ep: 'POST /v1/outreach/run', why: '执行外发' },
  { ep: 'POST /v1/outreach/test', why: '测试外发' },
  { ep: 'POST /v1/outreach/mute', why: '静音外发' },
  { ep: 'POST /v1/outreach/reply', why: '外发回复回调' },
  { ep: 'GET /v1/outreach/records', why: '读外发记录' },
  { ep: 'GET /v1/outreach/stats', why: '读外发统计' },
  { ep: 'GET /v1/evidence/status', why: '读证据状态' },
  { ep: 'GET /v1/commercial-loop/status', why: '读商业闭环状态' },
  { ep: 'GET /v1/commercial-loop/skills', why: '读商业闭环技能' },
  { ep: 'GET /v1/scheduler/status', why: '读调度器状态' },
  { ep: 'POST /v1/scheduler/tick', why: '调度器心跳' },
  { ep: 'POST /v1/scheduler/start', why: '启动调度器' },
  { ep: 'POST /v1/scheduler/stop', why: '停止调度器' },
  { ep: 'GET /v1/workflow16', why: '读工作流16状态' },
  { ep: 'POST /v1/workflow16/run', why: '运行工作流16' },
  { ep: 'POST /v1/workflow16/boot', why: '工作流16初始化' },
  { ep: 'POST /v1/workflow16/stop', why: '工作流16停止' },
  { ep: 'GET /v1/crawler', why: '读爬虫状态' },
  { ep: 'POST /v1/crawler/run', why: '运行爬虫' },
  { ep: 'POST /v1/crawler/ingest', why: '爬虫入库' },
  { ep: 'POST /v1/crawler/bank', why: '爬虫素材库' },
  { ep: 'GET /v1/fulfillment', why: '读履约状态' },
  { ep: 'POST /v1/fulfillment/advance', why: '推进履约' },
  { ep: 'POST /v1/fulfillment/logistics', why: '履约物流' },
  { ep: 'GET /v1/materials', why: '读素材库' },
  { ep: 'POST /v1/materials/register', why: '登记素材' },
  { ep: 'POST /v1/materials/move', why: '移动素材' },
  { ep: 'GET /v1/materials/plan', why: '读素材计划' },
  { ep: 'POST /v1/materials/intent', why: '素材意图' },
  { ep: 'POST /v1/materials/confirm', why: '确认素材' },
  { ep: 'POST /v1/materials/cancel', why: '取消素材' },
  { ep: 'GET /v1/logistics/status', why: '读物流状态' },
  { ep: 'POST /v1/logistics/query', why: '查询物流' },
  { ep: 'GET /v1/adoption/check', why: '读采纳检查' },
  { ep: 'GET /v1/adoption/license', why: '读许可证' },
  { ep: 'GET /v1/adoption/selfcheck', why: '自检采纳' },
  { ep: 'GET /v1/reuse-sop/gate', why: '复用SOP闸门' },
  { ep: 'POST /v1/reuse-sop/run', why: '运行复用SOP' },
  { ep: 'GET /v1/capability/map', why: '读能力全景图' },

  // —— 合规/隐私/支付回调（法律与付费链路：必须免费） ——
  { ep: 'GET /v1/compliance/clauses', why: '读合规条款' },
  { ep: 'GET /v1/compliance/audit', why: '读合规审计' },
  { ep: 'POST /v1/privacy/erasure', why: '隐私擦除请求' },
  { ep: 'GET /v1/privacy/portability', why: '隐私数据导出' },
  { ep: 'POST /v1/pay/moltspay/notify', why: 'Moltspay 回调' },
  { ep: 'POST /v1/pay/paypal/webhook', why: 'PayPal Webhook' },
  { ep: 'POST /v1/pay/create', why: '创建支付订单' },

  // —— 生肖伙伴（第 2 条·B 方案：养成互动是基础体验，不收费）——
  { ep: 'GET /v1/zodiac', why: '读生肖状态' },
  { ep: 'POST /v1/zodiac/interact', why: '与伙伴互动' },
  { ep: 'POST /v1/zodiac/select', why: '选择自己的伙伴' },
  { ep: 'POST /v1/zodiac/tick', why: '伙伴成长心跳' },

  // —— 管理员操作：显式免费但**危险**。这类端点必须由 token 鉴权保护，
  //    收费墙在这里的作用是"提醒",真正的防线是 subs.rotateAdminToken。
  { ep: 'POST /v1/subs/reset-visitors', why: '重置访客（管理员操作，需 token）' },
  { ep: 'POST /v1/subs/rotate-admin-token', why: '轮换管理 token（管理员操作）' }
];

/**
 * 流程端点 / 运营端点（2026-10-21 新增分类）
 * ------------------------------------------------------------------
 * 这些端点**本来就不该上墙**（上墙会把付费流程自己锁死）或**本来就需要管理令牌**
 * （人工核账 / 自动开通）。之前它们既不在 GATED 也不在 PUBLIC 名单里，
 * 于是每次覆盖率自检都报"未登记" —— 审计噪音掩盖真问题。
 *
 * 现在单列一类：coverage() 里的 **uncovered = 真漏网**（需要处理），
 * 这才是能当部署门禁的数；本类单独报 flowOps 计数与原因。
 */
const FLOW_OPS = [
  { ep: 'POST /v1/subs/order/email', why: '下单后补邮箱（付费流程自身）' },
  { ep: 'POST /v1/pay/manual-resubmit', why: '补交支付凭证（付费流程自身）' },
  { ep: 'POST /v1/pay/refund', why: '客户自助申请退款（付费流程自身）' },
  { ep: 'GET /v1/pay/refund/status', why: '查自己的退款状态（付费流程自身）' },
  { ep: 'GET /v1/pay/refund/queue', why: '运营看退款队列（管理令牌）' },
  { ep: 'POST /v1/pay/refund/confirm', why: '运营确认已出款（管理令牌）' },
  { ep: 'POST /v1/pay/manual-verify', why: '人工核账确认到账（管理令牌）' },
  { ep: 'GET /v1/pay/manual-queue', why: '人工核账队列（管理令牌）' },
  { ep: 'POST /v1/pay/manual-sweep', why: '人工核账超时回收（管理令牌）' },
  { ep: 'POST /v1/pay/auto-settle', why: '收款监听自动开通（回环+通知密钥）' },
  { ep: 'GET /v1/pay/auto-settle/status', why: '收款监听就绪视图（管理令牌）' },
  { ep: 'GET /v1/pay/moltspay/notify', why: 'Moltspay 支付回调（付费流程自身）' },
  { ep: 'GET /v1/watch/scan', why: '手动巡检（运营读取）' },
  { ep: 'GET /v1/audit/summary', why: '运营看审计结论（管理令牌）' },
  { ep: 'GET /v1/subs/quota', why: '查免费额度与各档日限（付费前须知，基础可用）' },
  { ep: 'GET /v1/maturity/report', why: '成熟度校准报告（只读诊断，运营定期查看）' },
  { ep: 'GET /v1/usage/margin', why: '用量与毛利看板（经营数据，需管理令牌）' },
  { ep: 'GET /v1/loop/saas', why: '订阅闭环体检（转化率+断裂检查，需管理令牌）' },
  { ep: 'GET /v1/assist/queue', why: '协助请求队列（运营侧，需管理令牌）' },
  { ep: 'GET /v1/assist/stats', why: '协助时效统计（运营侧，需管理令牌）' },
  { ep: 'POST /v1/assist/accept', why: '协助接单（运营侧，需管理令牌）' },
  { ep: 'POST /v1/assist/complete', why: '协助归档（运营侧，需管理令牌）' },
  { ep: 'GET /v1/care/center', why: '陪护监控中心（运营侧，需管理令牌）' },
  { ep: 'GET /v1/care/loop', why: '陪护闭环体检（运营侧，需管理令牌）' },
  { ep: 'GET /v1/care/report', why: '陪护中心+闭环合并报告（运营侧，需管理令牌）' },
  { ep: 'POST /v1/care/order/fulfill', why: '运营核账后开通陪护订阅（需管理令牌）' },
  { ep: 'GET /v1/care/notifies', why: '告警通知队列/预算（运营侧，需管理令牌）' },
  { ep: 'POST /v1/care/notifies/flush', why: '重发未送达通知（运营侧，需管理令牌）' },
  { ep: 'POST /v1/care/profile/migrate', why: '存量健康数据加密迁移（PIPL，运营侧需管理令牌）' },
   { ep: 'GET /v1/paywall/coverage', why: '收费墙覆盖率自检（部署门禁，管理令牌）' },
];

// —— 模块前缀 → 分区 ——
// 【为什么需要这一层】逐条登记 241 个端点不现实，而且**必然漏**：
// 每加一个端点就要记得改这张表，漏了就是静默免费。
// 所以补一层**模块前缀规则**：新端点只要路径落在已判定模块里，自动继承该模块的收费策略。
// 显式端点（GATED/PUBLIC）优先级最高，前缀只兜底——这样个别例外仍能精确控制。
const PREFIX_RULES = [
  // 前缀,           分区,          说明
  ['/v1/agentcenter', 'agent', 'Agent 管理中心：会诊/协作/守护进程'],
  ['/v1/agents', 'agent', 'Agent 会诊'],
  ['/v1/deliberation', 'decision', '多视角审议'],
  ['/v1/decisions', 'decision', '决策记录与统计'],
  ['/v1/annual', 'decision', '年度复盘'],
  ['/v1/harness', 'evolve', '提示词自优化'],
  ['/v1/memory-hub', 'evolve', '记忆学习进化中枢'],
  ['/v1/lessons', 'evolve', '经验库'],
  ['/v1/playbook', 'evolve', '打法手册'],
  ['/v1/train', 'evolve', '发布列车'],
  ['/v1/autopilot', 'evolve', '24h 自主运营'],
  ['/v1/autopub', 'evolve', '自主发布'],
  ['/v1/watchdog', 'evolve', '监控自愈'],
  ['/v1/report', 'evolve', '报告生成'],
  ['/v1/persona', 'evolve', '人格设定'],
  ['/v1/intel', 'skill', '情报抓取（有联网成本）'],
  ['/v1/mcp', 'skill', 'MCP 服务'],
  ['/v1/foundry', 'studio', '内容铸造'],
  ['/v1/studio', 'studio', '音视频制作'],
  ['/v1/game', 'game', '游戏制作'],
  ['/v1/music', 'music', '音乐制作'],
  ['/v1/goalpilot', 'warboard', '目标引擎'],
  ['/v1/conductor', 'warboard', '作战指挥'],
  ['/v1/coordinator', 'warboard', '协同调度'],
  ['/v1/warboard', 'warboard', '指挥塔与战情室'],
  ['/v1/org', 'org', '组织大脑与组队'],
  ['/v1/organs', 'org', '器官健康'],
  ['/v1/talents', 'org', '人才盘点'],
  ['/v1/leadgen', 'leadgen', '获客漏斗'],
  ['/v1/money/leads', 'leadgen', '线索推进（触达/推进/转正）'],
  ['/v1/gtm', 'leadgen', 'GTM 执行'],
  ['/v1/tickets', 'evolve', '工单协作'],
  ['/v1/peers', 'evolve', '同行互助'],
  ['/v1/skills', 'skill', '技能库'],
  ['/v1/repurpose', 'evolve', '内容再利用'],
  ['/v1/brain', 'chatdeep', '大脑记忆学习'],
  ['/v1/agentmesh', 'agent', '多 Agent 协作网（第 10 条）'],
  ['/v1/guard', 'agent', '同在守护：心理·策略·智慧库（第 13 条）'],
  ['/v1/publish', 'evolve', '全媒体运营（第 11 条）'],
  ['/v1/paperclip', 'agent', 'Paperclip 多 Agent 公司协同（外挂，状态与交接单）'],
  ['/v1/arch', 'decision', '七层架构与七种编排（第 1、7 条）'],
  ['/v1/registry', 'evolve', '自适应注册（第 2 条）'],
  ['/v1/sop', 'decision', 'MetaGPT SOP 流水线（第 9 条）'],
  ['/v1/orca', 'warboard', 'Orca 桌面指挥台（第 3 条）'],
  ['/v1/orca/chart', 'warboard', 'Orca 实时图表数据（利用率/吞吐/延迟/成功率）'],
  ['/v1/orca/pulse', 'warboard', 'Orca 人员脉络图（负载/协作/效能）'],
  ['/v1/orca/scene', 'warboard', 'Orca 场景动态图（任务流 DAG/时间线/热力）'],
  ['/v1/orca/ws', 'warboard', 'Orca WebSocket 实时推送'],
  ['/v1/graph', 'evolve', 'Graphify 语义知识图谱'],

  // —— PDE 产出大项 + 材料/PPT 生成 ——
  // 【为什么要登记】新加端点若不登记，paywall.auditEndpoints() 会判为"未登记"，
  // test-registry 就会红（99% 而非 100%）。收费墙覆盖必须跟着端点走，
  // 否则新增能力就成了免费绕过口。
  // 分区选择：PDE 体检是分析类（decision），生成材料要消耗算力（studio）。
  ['/v1/pde', 'decision', 'PDE 四级演进体检'],
  ['/v1/pde/stage', 'decision', 'PDE 单级体检'],
  ['/v1/deck', 'studio', '材料与演示文稿生成'],
  ['/v1/deck/list', 'studio', '已生成材料列表'],
  ['/v1/org/lead-assign', 'decision', '线索按获客能力派工'],
  ['/v1/tasks/claim', 'decision', '认领未分配任务（进入在跑）'],

  // —— 决策中心 ↔ 聊天互通（第 3 条）——
  // 归域查询是只读分析（decision 段）；sync 会写库派任务，代价更高，
  // 按「深度思考」段计费比按 decision 更合理——它真的在改变系统状态。
  ['/v1/decision-bridge/domain', 'decision', '业务域归类查询'],
  ['/v1/decision-bridge/sync', 'chatdeep', '聊天↔决策焦点同步（会派发任务）'],
  ['/v1/decision-bridge/moves', 'decision', '当前决策可推进动作'],

  // —— 24h 监控自修复（第 15 条）——
  // heal 会真的执行修复动作（触发运营轮次、推进 playbook、提工单优先级），
  // 按「自主运营」段计费：它在替系统干活，不是免费的只读查询。
  ['/v1/watch/heal', 'autopilot', '24h 监控自修复闭环（会执行修复）'],
  ['/v1/watch/heal/coverage', 'decision', '自修复策略覆盖率（只读）'],

  // —— 设置中枢（第 7 条）——
  // registry 返回分组声明与当前值，不含密钥明文；
  // health/coverage 是只读体诊。收入 decision 段。
  ['/v1/settings/registry', 'decision', '设置注册表（分组与当前值）'],
  ['/v1/settings/coverage', 'decision', '设置覆盖率（管理盲区检测）'],
  ['/v1/settings/health', 'decision', '设置体检']
];

// 静态资源与页面：天然免费。它们的"路径"是 /app.css、/i18n.js 这种，
// 与业务端点形态不同，单条登记没意义——用前缀规则兜底即可。
const STATIC_ASSETS = [
  '/', '/index.html', '/app.css',
  '/ui.js', '/app.js', '/biz.js', '/convert.js', '/capture.js', '/zodiac.js', '/geo.js', '/i18n.js',
  '/favicon.ico'
];
function isStatic(pathname) {
  if (STATIC_ASSETS.indexOf(pathname) >= 0) return true;
  return /\.(css|js|html|ico|png|jpg|jpeg|gif|svg|woff2?|ttf|map)$/i.test(pathname);
}

// 匹配端点（显式表优先，再退到前缀规则）
function sectionOf(method, pathname) {
  // 静态资源永远免费——界面的 CSS/JS 被墙挡住的话，整个产品直接不可用
  if (isStatic(pathname)) return '@public';
  const key = method + ' ' + pathname;
  if (GATED[key]) return GATED[key];
  // PUBLIC 也用「方法 空格 路径」查表（有的条目缩进对齐会带多个空格，故做归一化）
  for (const p of PUBLIC) {
    if (p.ep.replace(/\s+/g, ' ') === key) return '@public';
  }
  // 显式端的 :param 前缀匹配
  const keys = Object.keys(GATED);
  for (const k of keys) {
    const parts = k.split(' ');
    if (parts[0] !== method) continue;
    const p = parts[1];
    if (p.indexOf(':') >= 0 && pathname.indexOf(p.split(':')[0]) === 0) return GATED[k];
  }
  // 模块前缀规则兜底
  for (const [pfx, sec] of PREFIX_RULES) {
    if (pathname === pfx || pathname.indexOf(pfx + '/') === 0) return sec;
  }
  return null;
}

// 覆盖率自检：拿 server.js 的真实端点清单对账
// 这个函数是"针对所有项目"能否被验证的关键——没有它就只是口头承诺。
function coverage(allEndpoints, opts) {
  const list = Array.isArray(allEndpoints) ? allEndpoints : [];
  const options = opts || {};
  const pubSet = {};
  PUBLIC.forEach(p => { pubSet[p.ep] = p.why; });
  const flowSet = {};
  FLOW_OPS.forEach(p => { flowSet[p.ep] = p.why; });
  const gatedSet = {};
  Object.keys(GATED).forEach(k => { gatedSet[k] = GATED[k]; });
  // 严格管理端点（server.js 的 STRICT_ADMIN_PATHS）：必须带管理令牌，本来就不该上墙
  const opsPaths = new Set((Array.isArray(options.opsPaths) ? options.opsPaths : []).map(String));

  const uncovered = [];
  const covered = [];
  let flowOpsHit = 0;
  list.forEach(ep => {
    if (gatedSet[ep]) { covered.push(ep); return; }
    if (pubSet[ep]) { covered.push(ep); return; }
    if (flowSet[ep]) { covered.push(ep); flowOpsHit++; return; }
    const m = String(ep).split(' ')[0];
    const pn = String(ep).split(' ')[1] || '';
    if (opsPaths.has(pn)) { covered.push(ep); flowOpsHit++; return; }   // 严格管理端点
    if (sectionOf(m, pn)) { covered.push(ep); return; }
    uncovered.push(ep);   // ← 真漏网：既没上墙、也没被登记为免费/流程端点
  });

  // 端点数按实际匹配结果统计（含前缀兜底），而不是只数 GATED 里写了几条
  const secCount = {};
  list.forEach(ep => {
    if (pubSet[ep]) return;
    const m = String(ep).split(' ')[0];
    const pn = String(ep).split(' ')[1] || '';
    const sec = sectionOf(m, pn);
    if (sec) secCount[sec] = (secCount[sec] || 0) + 1;
  });
  const usedSections = secCount;
  const emptySections = Object.keys(SECTIONS).filter(s => !usedSections[s]);

  return {
    total: list.length,
    covered: covered.length,
    uncoveredCount: uncovered.length,     // ← 真漏网（门禁看这个数）
    rate: list.length ? Math.round(covered.length / list.length * 100) : null,
    uncovered,
    flowOpsCount: flowOpsHit,            // 流程/运营端点（已说明原因，不是漏网）
    flowOps: FLOW_OPS,
    sections: Object.keys(SECTIONS).map(k => ({ key: k, ...SECTIONS[k], endpoints: usedSections[k] || 0 })),
    emptySections,
    publicEndpoints: PUBLIC,
    staticAssets: STATIC_ASSETS
  };
}

// 真实台账：当前所有访客的订阅与用量情况（第 15 条"收款准确"）
function ledger() {
  const subs = store.list('sublist', 999);
  const visitors = store.list('visitors', 999);
  const now = Date.now();
  const active = subs.filter(s => s.expireAt > now);
  const expired = subs.filter(s => s.expireAt <= now);
  // 按分区汇总今日消耗
  const dayKey = d => new Date(d).toDateString();
  const today = dayKey(now);
  const usage = {};
  visitors.forEach(v => {
    const pools = v.pools || {};
    Object.keys(pools).forEach(k => {
      const day = String(k).split('.')[1];
      if (day !== today) return;
      const sec = String(k).split('.')[0];
      usage[sec] = (usage[sec] || 0) + Number(pools[k] || 0);
    });
  });
  return {
    subs: subs.length, active: active.length, expired: expired.length,
    visitors: visitors.length,
    usageToday: usage,
    // 诚实标注：这些数字是台账推算，不等于"已到账金额"
    // 真实到账要看 money.revenueAll 里 settled 的部分——两者刻意不混在一起
    note: '此处为订阅与用量台账；实际到账金额以「营收实收」中已结算记录为准，两者口径不同不可混用。'
  };
}

module.exports = { SECTIONS, GATED, PUBLIC, FLOW_OPS, PREFIX_RULES, STATIC_ASSETS, isStatic, sectionOf, coverage, ledger, quotaInfo };