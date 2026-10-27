'use strict';
// core/validator.js — 创业验证所
//
// 借鉴 ferdinandobons/startup-skill (MIT) 的方法论，与本仓库 decision.js（61 种决策框架）互补：
//   decision.js 是**点状工具**（单个框架独立使用），本模块是**线性流程**（从 idea 到 validated plan）。
//
// 核心设计：
//   · 8 阶段验证流水线 + 两道闸（Research Gate / Interview Gate）
//   · Pre-Flight 三查：主导方案 / 先例失败 / 监管红线
//   · 诚实协议：数据标签 [Data]/[Estimate]/[Assumption]/[Opinion] + 来源 Tier T1/T2/T3 + Red/Yellow Flags
//   · 7 维 Scorecard + 明确判定（proceed/conditional/concerns/stop）
//   · Kill Criteria：可度量的止损条件
//   · PROGRESS 状态跟踪（断点续传）
//
// 诚实协议（Radical Honesty）是设计核心：
//   告诉创始人真相，而不是让他感觉良好。
//   如果市场太小、想法有致命缺陷，直说。
//   每条声明标注依据，绝不把估计当事实。

// ── 阶段定义 ──────────────────────────────────────────────────────────────
const PHASES = [
  { id: 'intake',          name: '需求受理', emoji: '📝', gate: false, desc: '收集 idea 全貌：问题、目标用户、商业模式、约束' },
  { id: 'brainstorm',       name: '创意发散', emoji: '🧠', gate: false, desc: '5-8 个方向变体，避免过早收敛' },
  { id: 'research',        name: '市场调研', emoji: '🔍', gate: false, desc: '市场规模、竞争格局、客户需求、分发渠道' },
  { id: 'research-gate',   name: '研究闸门', emoji: '🚦', gate: true,  desc: 'Go/No-Go：数据是否支持继续' },
  { id: 'interview',       name: '客户访谈', emoji: '🎤', gate: false, desc: '5+ 真实客户对话，验证痛点' },
  { id: 'interview-gate',  name: '访谈闸门', emoji: '🚦', gate: true,  desc: 'Proceed/Reassess：访谈是否确认问题' },
  { id: 'strategy',        name: '战略定位', emoji: '🧭', gate: false, desc: 'Lean Canvas、定位、商业模式、GTM' },
  { id: 'brand',           name: '品牌定义', emoji: '🎨', gate: false, desc: '使命/愿景/价值观/语气' },
  { id: 'product',         name: '产品定义', emoji: '📦', gate: false, desc: 'MVP、功能优先级、用户旅程' },
  { id: 'financial',       name: '财务模型', emoji: '💰', gate: false, desc: '收入模型、成本结构、三情景预测' },
  { id: 'validation',      name: '验证实验', emoji: '🧪', gate: false, desc: '实验手册、风险矩阵、Scorecard、Kill Criteria' },
];

// ── Scorecard 7 维 ─────────────────────────────────────────────────────────
const SCORECARD_DIMS = [
  { id: 'market',     name: '市场规模',   desc: 'TAM/SAM/SOM 是否够大' },
  { id: 'competition', name: '竞争格局',   desc: '竞争强度与差异化空间' },
  { id: 'demand',     name: '客户需求',   desc: '痛点强度与付费意愿' },
  { id: 'timing',     name: '时机',       desc: '市场窗口是否合适' },
  { id: 'unit',       name: '单位经济',   desc: 'CAC/LTV/毛利是否成立' },
  { id: 'team',       name: '团队契合',   desc: '创始人与市场的契合度' },
  { id: 'risk',       name: '风险画像',   desc: '关键风险可控性' },
];

// ── 判定逻辑 ──────────────────────────────────────────────────────────────
function computeVerdict(scores) {
  const vals = SCORECARD_DIMS.map(d => Math.max(1, Math.min(10, parseInt(scores[d.id], 10) || 5)));
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const min = Math.min(...vals);
  let verdict, color, summary;
  if (avg >= 8 && min >= 6)      { verdict = 'proceed';     color = 'green';  summary = '强信号：数据支持推进'; }
  else if (avg >= 6 && min >= 4) { verdict = 'conditional'; color = 'yellow'; summary = '有条件推进：需验证关键假设'; }
  else if (avg >= 4)             { verdict = 'concerns';    color = 'orange'; summary = '重大疑虑：建议先跑验证实验'; }
  else                           { verdict = 'stop';        color = 'red';    summary = '建议停止/转向：数据不支持当前方向'; }
  return { verdict, color, summary, avg: Math.round(avg * 10) / 10, min, dims: vals };
}

// ── Pre-Flight 三查 ───────────────────────────────────────────────────────
// 1. 主导方案检查：该领域是否已有 10k+ 用户的明确主导者
const DOMINANT_PLAYERS = {
  '项目管理': ['asana', 'monday', 'jira', 'trello', 'notion', 'clickup'],
  '客服': ['zendesk', 'intercom', 'freshdesk', 'helpscout'],
  '邮件营销': ['mailchimp', 'sendgrid', 'klaviyo', 'hubspot', 'brevo'],
  '电商': ['shopify', 'woocommerce', 'bigcommerce', 'magento'],
  '协作': ['slack', 'discord', 'teams', 'zoom', 'notion'],
  '设计': ['figma', 'sketch', 'canva', 'adobe'],
  '笔记': ['notion', 'obsidian', 'evernote', 'roam', 'logseq'],
  'crm': ['salesforce', 'hubspot', 'pipedrive', 'zoho'],
  '自动化': ['zapier', 'make', 'ifttt', 'n8n'],
  '建站': ['wordpress', 'wix', 'squarespace', 'webflow', 'framer'],
  '表单': ['typeform', 'google forms', 'jotform'],
  '问卷': ['survey monkey', 'qualtrics', 'typeform'],
  '会议': ['zoom', 'google meet', 'whereby'],
  '白板': ['miro', 'figma', 'lucidchart', 'whimsical'],
  '数据库': ['airtable', 'notion', 'google sheets', 'postgres'],
  '分析': ['google analytics', 'mixpanel', 'amplitude', 'hotjar'],
  '代码': ['github', 'gitlab', 'bitbucket', 'vercel'],
  '支付': ['stripe', 'paypal', 'square'],
  '聊天机器人': ['intercom', 'drift', 'zendesk', 'crisp'],
  '知识库': ['notion', 'confluence', 'gitbook', 'slite'],
};
// 2. 先例失败检查：常见失败模式
const FAILURE_PATTERNS = [
  { pattern: /^ai[- ]?powered/i, reason: 'AI-powered 标签已过度饱和，需证明实质差异' },
  { pattern: /chatbot.*(shop|store|commerce)/i, reason: '电商 chatbot 领域已多次失败，转化率低' },
  { pattern: /crypto|nft|blockchain/i, reason: '加密/SEO 领域监管不确定，先例失败率高' },
  { pattern: /social.*network/i, reason: '社交网络有强网络效应，新进入者极难' },
  { pattern: /search.*engine/i, reason: '搜索引擎有极强规模效应' },
  { pattern: /uber.*for/i, reason: '"X for Y" 模式需要双边市场，冷启动极难' },
];
// 3. 监管红线检查
const REGULATORY_RISKS = [
  { pattern: /fintech|payment|lending|trading|invest|crypto/i, level: 'high', reason: '金融/支付/借贷需牌照，监管壁垒极高' },
  { pattern: /health|medical|diagnos|therapy/i, level: 'high', reason: '医疗/健康需 FDA/NMPA 认证，周期长' },
  { pattern: /children|kids|student|minor/i, level: 'high', reason: '儿童/学生数据受 COPPA/个保法严格限制' },
  { pattern: /gambling|betting|casino/i, level: 'high', reason: '赌博/博彩在中国大陆非法' },
  { pattern: /insurance/i, level: 'high', reason: '保险需牌照，监管严格' },
  { pattern: /food|supplement|drug/i, level: 'medium', reason: '食品/保健品需资质与审批' },
  { pattern: /education|tutor|school/i, level: 'medium', reason: '教育/培训受双减等政策影响' },
  { pattern: /recruit|headhunt/i, level: 'medium', reason: '招聘/猎头需人力资源服务许可' },
];

function preflight(idea) {
  const text = String(idea || '').toLowerCase();
  const findings = { dominant: [], precedent: [], regulatory: [] };

  // 1. 主导方案
  for (const [domain, players] of Object.entries(DOMINANT_PLAYERS)) {
    if (text.includes(domain.toLowerCase())) {
      for (const p of players) {
        if (text.includes(p.toLowerCase())) findings.dominant.push({ domain, player: p, note: `${p} 是「${domain}」领域的明确主导者` });
      }
    }
  }

  // 2. 先例失败
  for (const fp of FAILURE_PATTERNS) {
    if (fp.pattern.test(String(idea || ''))) findings.precedent.push({ pattern: fp.pattern.toString(), reason: fp.reason });
  }

  // 3. 监管红线
  for (const rr of REGULATORY_RISKS) {
    if (rr.pattern.test(String(idea || ''))) findings.regulatory.push({ level: rr.level, reason: rr.reason });
  }

  // 汇总
  const redFlags = [], yellowFlags = [];
  if (findings.dominant.length) redFlags.push(...findings.dominant.map(d => `主导者 ${d.player} 已占据「${d.domain}」`));
  if (findings.precedent.length) yellowFlags.push(...findings.precedent.map(p => p.reason));
  if (findings.regulatory.filter(r => r.level === 'high').length) redFlags.push(...findings.regulatory.filter(r => r.level === 'high').map(r => r.reason));
  if (findings.regulatory.filter(r => r.level === 'medium').length) yellowFlags.push(...findings.regulatory.filter(r => r.level === 'medium').map(r => r.reason));

  return { dominant: findings.dominant, precedent: findings.precedent, regulatory: findings.regulatory, redFlags, yellowFlags };
}

// ── 数据存储（内存 Map，与产品其他模块一致）──────────────────────────────
const projects = new Map();
const MAX_PROJECTS = 100;   // 内存上限：超过后淘汰最早创建的项目，防 Map 无界增长

function createProject(idea, meta) {
  // 上限淘汰：Map 保持插入序，size 超限先删最旧的
  if (projects.size >= MAX_PROJECTS) {
    const oldest = projects.keys().next().value;
    if (oldest) projects.delete(oldest);
  }
  const id = 'val_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();
  const name = (meta && meta.name) || deriveName(idea);
  const pf = preflight(idea);
  const proj = {
    id, idea, name, createdAt: now,
    phase: 0,                                    // PHASES 索引
    preflight: pf,
    gates: { research: null, interview: null },  // null | 'green' | 'yellow' | 'red'
    interviews: [],
    scorecard: null,                             // { market: 5, ... }
    verdict: null,
    killCriteria: [],
    flags: { red: Array.from(pf.redFlags), yellow: Array.from(pf.yellowFlags) },   // 防御性拷贝
    artifacts: {},                               // 各阶段产出物
    progress: [                                // PROGRESS 跟踪
      '# 创业验证进度', '',
      `- 项目：${name}`, `- 创建时间：${now}`, '',
      '## 阶段清单', '',
    ].concat(PHASES.map((p, i) => `- [${i <= 0 ? 'x' : ' '}] ${p.emoji} ${p.name}${p.gate ? '（闸门）' : ''}`)).concat(['', '## 备注', '']),
  };
  projects.set(id, proj);
  return proj;
}

function deriveName(idea) {
  const s = String(idea || '').trim().slice(0, 24).replace(/[^\w\u4e00-\u9fa5-]/g, '-');
  return s || '未命名验证项目';
}

function getProject(id) { return projects.get(id) || null; }
function listProjects() { return [...projects.values()].map(p => ({ id: p.id, name: p.name, idea: p.idea.slice(0, 60), phase: p.phase, phaseName: PHASES[p.phase].name, verdict: p.verdict, createdAt: p.createdAt })); }

// ── 推进阶段 ──────────────────────────────────────────────────────────────
function advance(id, payload) {
  const p = getProject(id);
  if (!p) return { ok: false, error: '项目不存在' };
  const phase = PHASES[p.phase];
  if (!phase) return { ok: false, error: '已完成全部阶段' };

  // 记录产出物
  if (payload && payload.artifact) {
    p.artifacts[phase.id] = String(payload.artifact).slice(0, 4000);
  }
  if (payload && payload.note) {
    p.progress.push(`[${phase.name}] ${String(payload.note).slice(0, 200)}`);
  }

  // 闸门阶段判定
  if (phase.gate) {
    const gateKey = phase.id === 'research-gate' ? 'research' : 'interview';
    p.gates[gateKey] = payload && payload.gate ? String(payload.gate) : 'yellow';
  }

  // 访谈记录
  if (phase.id === 'interview' && payload && payload.interview) {
    p.interviews.push({
      n: p.interviews.length + 1,
      summary: String(payload.interview).slice(0, 500),
      confirmed: payload.confirmed === true || payload.confirmed === 'true',
      behaviorSignal: payload.behaviorSignal === true || payload.behaviorSignal === 'true',
      at: new Date().toISOString(),
    });
  }

  // 评分
  if (phase.id === 'validation' && payload && payload.scorecard) {
    p.scorecard = {};
    for (const d of SCORECARD_DIMS) p.scorecard[d.id] = Math.max(1, Math.min(10, parseInt(payload.scorecard[d.id], 10) || 5));
    p.verdict = computeVerdict(p.scorecard);
    if (payload.killCriteria && Array.isArray(payload.killCriteria)) {
      p.killCriteria = payload.killCriteria.map(k => String(k).slice(0, 200)).filter(Boolean);
    }
  }

  // 推进
  p.phase = Math.min(p.phase + 1, PHASES.length - 1);
  const next = PHASES[p.phase];
  p.progress.push(`- [${next.gate ? '闸门' : '→'}] 进入：${next.emoji} ${next.name}`);

  return { ok: true, phase: p.phase, next: next.id, gate: p.gates, verdict: p.verdict };
}

// ── 仅记录访谈（不推进阶段；用于访谈闸门前补足样本量）─────────────────────
function recordInterview(id, rec) {
  const p = getProject(id);
  if (!p) return { ok: false, error: '项目不存在' };
  const summary = String(rec && rec.summary || '').trim().slice(0, 500);
  if (!summary) return { ok: false, error: '缺少访谈摘要' };
  p.interviews.push({
    n: p.interviews.length + 1,
    summary,
    confirmed: !!(rec && rec.confirmed),
    behaviorSignal: !!(rec && rec.behaviorSignal),
    at: new Date().toISOString(),
  });
  return { ok: true, interviews: p.interviews.length };
}

// ── 研究深度评估（Phase 2.5 对应）─────────────────────────────────────────
function researchDepth(intake) {
  const text = String(intake || '').toLowerCase();
  let breadth = 1, competitors = 1, geo = 1;
  // 市场广度：提及多个细分/地域=3，单一=1
  if (/全球|international|多国|overseas/.test(text)) geo = 3;
  else if (/全国|china|中国|cn/.test(text)) geo = 2;
  // 已知竞品提及
  let compHits = 0;
  for (const players of Object.values(DOMINANT_PLAYERS)) {
    for (const pl of players) if (text.includes(pl)) compHits++;
  }
  if (compHits >= 3) competitors = 3; else if (compHits >= 1) competitors = 2;
  // 市场广度
  if (/b2b|b2c|b2b2c|企业|个人|消费者/.test(text)) breadth = 2;
  if (/平台|生态|marketplace|双边/.test(text)) breadth = 3;
  const score = breadth + competitors + geo;
  const tier = score <= 4 ? 'light' : score <= 7 ? 'standard' : 'deep';
  const tierName = tier === 'light' ? '轻量（2-3 轮搜索）' : tier === 'standard' ? '标准（默认）' : '深度（5-6 轮搜索）';
  return { score, breadth, competitors, geo, tier, tierName };
}

// ── 诚实协议：数据标签渲染 ────────────────────────────────────────────────
const LABELS = {
  data:      { tag: '[Data]',       desc: '有来源的事实', color: 'green' },
  estimate:  { tag: '[Estimate]',   desc: '含假设的推算', color: 'yellow' },
  assumption:{ tag: '[Assumption]', desc: '未验证假设',   color: 'orange' },
  opinion:   { tag: '[Opinion]',    desc: '分析判断',     color: 'blue' },
};
const TIERS = {
  1: { tier: 'T1', name: '行业报告/SEC/政府数据', use: '硬数字、市场规模、增速' },
  2: { tier: 'T2', name: '科技媒体/公司公告',   use: '融资、公司动态、专家观点' },
  3: { tier: 'T3', name: '博客/社媒/个案',      use: '情绪、用户声音、轶事证据' },
};

module.exports = {
  PHASES, SCORECARD_DIMS, LABELS, TIERS,
  preflight, researchDepth, computeVerdict,
  createProject, getProject, listProjects, advance, recordInterview,
  _projects: projects,
};
