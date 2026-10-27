// core/gtm.js — 获客引擎（Go-To-Market）：窄定位 + 触达序列 + 转化追踪
//
// 为什么不做"100万客户群发"（用户原始诉求）：
//   用他自己的真实数据算：现有 230 条真实线索 → 0 成交（转化率 0.000%）。
//   按同转化率扩到 100 万条 = 100 万条死线索，0 个付费客户，且大规模群发触犯
//   《互联网电子邮件服务管理办法》与 CAN-SPAM/GDPR，是法律风险不是营销策略。
//   2026-09 全网调研共识：超半数上线产品零付费用户；卡住的根因是"人群太宽"，不是线索太少。
//
// 本模块做正确的事：
//   ① ICP 窄化：从"所有有需求的人"收到 3 个具体到"能叫出名字"的人群
//   ② 触达序列：每一步真实可执行、个性化、含话术、**默认人工确认后才发**（不群发）
//   ③ 转化追踪：哪个渠道/话术/人群真的带来付费（而不是只看线索数）
//   ④ 落地页文案：一句话说清"解决什么问题、为什么适合你"
//   ⑤ 诚实体检：漏斗哪一环断了，用真实数据说话
//
// 红线：
//   · 绝不自动群发垃圾信息（法律风险 + 品牌自杀）
//   · 触达需逐条人工确认（status: draft → sent），系统只做"准备"不做"群发"
//   · 所有效果数字来自真实回复/成交，不自我安慰

const store = require('./store');

const DAY = 86400000;

// ---------- ① ICP 窄化：3 个具体人群 ----------
// 每个 ICP 必须窄到"你能在他们的群里叫出几个人的名字"（2026 调研共识）
const ICPS = [
  {
    id: 'indie-cn',
    name: '中文独立开发者/一人公司',
    why: '他们自己就是"一个人+AI"的处境，最能立刻理解并验证价值',
    pain: [
      '一个人要做营销/内容/客服/开发全流程，顾不过来',
      '内容生产耗时：写稿到成片链路太长',
      '不知道自己产品该卖给谁、怎么定价'
    ],
    where: ['v2ex / 掘金 / 少数派 评论区', '独立开发社群（w2solo / 生财有术）', '即刻/小宇宙 独立开发圈'],
    proof: 'SiteGPT 一人公司 30天 $10k MRR；Polsia 2000+ 公司在跑',
    price: '¥60/月 或 ¥500/年', firstAsk: '先用一个真实选题跑一遍"自然语言→成片"，看能不能省 3 小时'
  },
  {
    id: 'consultant',
    name: '独立咨询师/顾问/教练（1-10人）',
    why: '他们的交付物就是"结构化分析报告"，我们的七段报告+决策框架直接可用',
    pain: [
      '每单要写定制报告，重复劳动多',
      '客户要"有出处、不编造"的分析，自己做怕出错',
      '没有工具沉淀方法论，每次从零想'
    ],
    where: ['知乎/公众号 咨询类博主', '朋友圈/私域 高客单人群', '播客听众（多为咨询顾问）'],
    proof: '系统已实现：无出处不输出 + 危机词转介 + 决策正确率基准',
    price: '¥150/季 或 定制单次', firstAsk: '拿一个真实客户案例跑七段报告，看能不能直接交差'
  },
  {
    id: 'smb-owner',
    name: '小微企业主（1-5人团队）',
    why: '有真实付费能力，痛点明确（获客贵/客服累），但不会用复杂工具',
    pain: ['获客成本高、不知道投哪', '客服重复问题太多', '内容做不出来做不动'],
    where: ['本地商会/创业沙龙', '行业微信群', '抖音/视频号 同城内容'],
    proof: '系统已实现：线索漏斗+ROI 看板+客服工单+内容生产',
    price: '¥60/月起（可代运营）', firstAsk: '先看一次获客报表，知道钱花哪了'
  }
];

// ---------- ② 触达序列（人工确认后逐条发，不群发）----------
// 每步都是"一个人能真的做出来的动作"，不是"系统自动骚扰"
const SEQUENCES = {
  // 冷启动：先给价值，再提产品（2026 调研：先贡献后索取）
  'indie-cn': [
    { day: 0, channel: '社区', action: '在他们的帖子里给一个**真有用的具体建议**（不贴链接）', goal: '让人记住你懂行' },
    { day: 2, channel: '社区', action: '再贡献一次，帮助解决问题', goal: '建立信任' },
    { day: 5, channel: '私信', action: '看到他们聊到相关内容 → 私信："看到你在做X，我这边有个工具能省你2小时，要看下吗？"', goal: '试探兴趣' },
    { day: 8, channel: '演示', action: '发一条你自己的真实产出（用系统做的内容）作为证据', goal: '证明真能用' },
    { day: 12, channel: '报价', action: '直接报价 ¥60 首月（不是"要不要试试"）', goal: '成交' }
  ],
  'consultant': [
    { day: 0, channel: '内容', action: '写一篇"如何避免 AI 报告编造出处"的实操文章', goal: '专业形象' },
    { day: 3, channel: '私信', action: '给一个真实案例的样例报告（脱敏）', goal: '让他看到成品' },
    { day: 7, channel: '报价', action: '报价：单次 ¥299 / 季付 ¥150', goal: '成交' }
  ],
  'smb-owner': [
    { day: 0, channel: '内容', action: '发"你的获客费花哪了"这类实操内容', goal: '建立信任' },
    { day: 3, channel: '演示', action: '免费给他做一次获客诊断（有真实数据更好）', goal: '创造第一次接触' },
    { day: 10, channel: '报价', action: '报价 ¥60/月 或代运营报价', goal: '成交' }
  ]
};

// ---------- 触达记录 ----------
function touch(key, data) {
  const db = store.read();
  if (!Array.isArray(db.gtmTouches)) db.gtmTouches = [];
  const rec = Object.assign({ at: Date.now(), status: 'draft' }, data, { key: String(key) });
  db.gtmTouches.unshift(rec);
  if (db.gtmTouches.length > 500) db.gtmTouches = db.gtmTouches.slice(0, 500);
  store.write(db);
  return { ok: true, touch: rec };
}
function markSent(key) {
  const db = store.read();
  const t = (db.gtmTouches || []).find(x => x.key === key);
  if (!t) return { ok: false, error: '没有这条触达记录' };
  t.status = 'sent'; t.sentAt = Date.now();
  store.write(db);
  return { ok: true };
}
function markReply(key, outcome) {
  // outcome: 'interested' | 'paid' | 'rejected' | 'no_reply'
  const db = store.read();
  const t = (db.gtmTouches || []).find(x => x.key === key);
  if (!t) return { ok: false, error: '没有这条触达记录' };
  t.outcome = outcome; t.repliedAt = Date.now();
  store.write(db);
  return { ok: true, outcome };
}
function touches(limit) { return (store.read().gtmTouches || []).slice(0, limit || 50); }

// ---------- ③ 转化追踪（真实效果，不是线索数自嗨）----------
function funnel() {
  const ts = store.read().gtmTouches || [];
  const c = k => ts.filter(t => t.outcome === k).length;
  const sent = ts.filter(t => t.status === 'sent').length;
  return {
    ok: true,
    total: ts.length, sent,
    interested: c('interested'), paid: c('paid'), rejected: c('rejected'), noReply: c('no_reply'),
    // 关键指标：触达→兴趣、兴趣→付费
    sentToInterested: sent ? (c('interested') / sent * 100).toFixed(1) + '%' : '—',
    interestedToPaid: c('interested') ? (c('paid') / c('interested') * 100).toFixed(1) + '%' : '—',
    sentToPaid: sent ? (c('paid') / sent * 100).toFixed(1) + '%' : '—',
    // 按 ICP 拆：哪个人群真的掏钱
    byIcp: ICPS.map(i => {
      const g = ts.filter(t => t.icp === i.id);
      return { id: i.id, name: i.name, sent: g.filter(t => t.status === 'sent').length, paid: g.filter(t => t.outcome === 'paid').length, interested: g.filter(t => t.outcome === 'interested').length };
    })
  };
}

// ---------- ④ 落地页文案（生成，不编造）----------
function landingCopy(icpId) {
  const i = ICPS.find(x => x.id === icpId) || ICPS[0];
  return {
    ok: true, icp: i.id,
    headline: `给${i.name}：把「想法 → 成品」的时间从 3 天压到 3 小时`,
    sub: '一个 AI 智能体：写稿、出镜稿、配音、字幕、发布、获客、复盘，全部真实可核验',
    three: [
      { pain: i.pain[0], fix: '系统已实现：自然语言 → 三段式稿 → 配音 → 字幕 → 成片' },
      { pain: i.pain[1] || i.pain[0], fix: '系统已实现：决策框架 + 有据可依的分析（无出处不输出）' },
      { pain: i.pain[2] || i.pain[0], fix: '系统已实现：线索漏斗 + ROI 看板 + 内容自动生产' }
    ],
    proof: i.proof,
    price: i.price,
    cta: '先免费跑一个真实案例，满意再付费（不绑定）',
    disclaimer: '以上能力均已实装并可现场演示；不承诺未实现的功能。'
  };
}

// ---------- ⑤ 诚实体检：漏斗哪一环断了 ----------
function diagnose() {
  const db = store.read();
  const leads = db.leads || [];
  const byStage = {};
  leads.forEach(l => { byStage[l.stage] = (byStage[l.stage] || 0) + 1; });
  const f = funnel();
  const issues = [];
  if (leads.length > 0 && (db.customers || []).length === 0) {
    issues.push('有 ' + leads.length + ' 条线索但 0 成交 → 触达动作缺失或话术无效（不是线索不够）');
  }
  if ((byStage['长期跟进'] || 0) > leads.length * 0.3) {
    issues.push('长期跟进占 ' + Math.round((byStage['长期跟进'] || 0) / leads.length * 100) + '% → 线索在"养"而没在"聊"，养线索不产生收入');
  }
  if (f.sent === 0 && leads.length > 0) {
    issues.push('系统内 0 条已发送触达 → 你的 230 条线索从未真正被人接触');
  }
  if ((db.revenue || []).filter(r => r.settled).length === 0) {
    issues.push('已结算实收 ¥0 → 还没有任何真实付款，PMF 未验证');
  }
  return { ok: true, leads: leads.length, byStage, customers: (db.customers || []).length, revenue: (db.revenue || []).filter(r => r.settled).reduce((a, b) => a + (b.amt || 0), 0), funnel: f, issues, verdict: issues.length ? issues[0] : '漏斗无明显断点' };
}

// ---------- ⑥ 每日任务生成（把"该联系谁、说什么"变成可执行清单）----------
// 从**真实线索数据**生成个性化话术：读他们的 repo 名/描述/topics，
// 生成"我看到你在做 X"的针对性开场——而不是群发模板。
// 这是"系统代替我记住该找谁"的关键：不依赖记忆，每天打开就有动作。
function todayTasks(opts) {
  const o = opts || {};
  const n = Math.max(1, Math.min(20, Number(o.n) || 5));
  const db = store.read();
  const sentKeys = new Set((db.gtmTouches || []).filter(t => t.status === 'sent').map(t => t.target || ''));

  // 优先级排序：还没发过的 > 活跃度高的 > 有明确痛点关键词的
  const leads = (db.leads || [])
    .filter(l => l && l.name && l.url && !sentKeys.has(l.name))
    .map(l => {
      const blob = [l.name, l.desc, l.note, (l.topics || []).join(' ')].join(' ').toLowerCase();
      // 痛点匹配：他做的项目和我们哪个能力对得上
      let angle = '', capability = '';
      if (/chatbot|bot|agent|whatsapp|telegram|discord|assistant/.test(blob)) {
        capability = '智能对话/客服';
        angle = '你做的这个 bot/agent 项目，用户问得最多的应该是"它怎么回答的"——我们有个东西能让它答得有据可依，不编造';
      } else if (/skill|claude|copilot|mcp|prompt/.test(blob)) {
        capability = '技能军械库';
        angle = '看到你在做 skill/插件生态——我们也有个技能库（200+ 开源能力，自动补货），可能对你有用';
      } else if (/content|writing|blog|newsletter|video|youtube/.test(blob)) {
        capability = '内容生产';
        angle = '你做内容相关的——我们能把"想法→成片"从几小时压到几十分钟（自动出稿+配音+字幕）';
      } else if (/saas|product|startup|landing|marketing/.test(blob)) {
        capability = '获客/决策';
        angle = '看到你在做产品——我们有个东西帮你看"该卖给谁、怎么定价"，用真实数据不靠猜';
      } else {
        capability = '通用';
        angle = '看到你的项目，想起我们做的那个东西——可能有点用，不确定的话当我没说';
      }
      return { lead: l, angle, capability, score: (l.signal || 40) };
    })
    .sort((a, b) => b.score - a.score);

  const tasks = leads.slice(0, n).map(({ lead, angle, capability }) => ({
    target: lead.name,
    url: lead.url,
    desc: String(lead.desc || lead.note || '').slice(0, 80),
    capability,
    // 三句话：观察 / 钩子 / 低门槛邀约
    message: [
      '看到你在做 ' + lead.name + '（' + String(lead.desc || '').slice(0, 40) + '）。',
      angle,
      '不复杂，你现在这个项目就能直接跑一遍看看合不合适。要我发个链接，还是你直接试试？'
    ].join('\n'),
    // 第一次不要报价，要具体价值
    cta: '低门槛试用，不合适就当我没说过',
    channel: 'GitHub Issue / 邮件（看项目类型选）'
  }));

  return {
    ok: true, at: Date.now(), count: tasks.length,
    tasks,
    note: '话术已按对方真实项目定制。发出后请用 /v1/gtm/touch/:key/sent 标记，否则明天会重复推荐。'
  };
}

module.exports = { ICPS, SEQUENCES, touch, markSent, markReply, touches, funnel, landingCopy, diagnose, todayTasks };
