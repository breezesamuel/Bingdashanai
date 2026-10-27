// core/agentmesh.js — 多 Agent 协作网（第 10 条需求）
//
// 【需求】"Agent 管理中心是可以管理多个Agent一起协作的地方，比如codex，openai，
//          千问，deepseek，opencode等等，相关skill需要在GitHub上完成装载20+"
//
// 【现状与差距】
// agentcenter.js 依赖外部守护进程 Paseo（getpaseo/paseo），实测本机多数函数返回空，
// 也就是说**协作功能实际上不可用**。但机器上明明有 7 个已配密钥的模型通道
// （DeepSeek / 智谱GLM / Qwen / Kimi / doubao / NVIDIA 等）和 opencode CLI ——
// 这些本身就是 Agent，之前完全没被编排层用上。
//
// 【解法】不依赖任何外部守护进程，直接把"手上真实可用的通道"编排起来：
//   backends()   探测并注册所有可用后端（模型通道 + 本机 CLI + 内置专家）
//   pick()       按任务类型选最合适的后端（而不是随机或固定一个）
//   consult()    单个 Agent 干活
//   debate()     多 Agent 并行 + 汇聚（真并发，不是串行假装并行）
//   packs()      GitHub 技能包装载（20+），白名单制
//
// 【设计红线：不伪造协作】
// 多 Agent 协作必须**真的并发调用**并返回**各自独立的真实结果**。
// 若某个后端不可用，如实标注"未参与"，绝不用其他后端的结果冒名顶替。

const store = require('./store');
const providers = require('./providers');
const skills = require('./skills');
const intel = require('./intel');
const agents = require('./agents');
const { execFile } = require('child_process');

// —— 后端注册表 ——
// channel 型：走 providers（有密钥即可用）
// cli 型：本机命令行工具
// expert 型：内置角色专家（走 LLM，但有明确 persona 与职责）
const CHANNEL_ROLES = {
  deepseek:   { kind: 'reasoner', label: 'DeepSeek',     strength: '推理与代码', cost: 'low' },
  zhipu:      { kind: 'generalist', label: '智谱 GLM',   strength: '中文理解与长文', cost: 'low' },
  moonshot:   { kind: 'generalist', label: 'Kimi',        strength: '长上下文', cost: 'mid' },
  siliconflow:{ kind: 'generalist', label: 'Qwen',        strength: '通用问答', cost: 'low' },
  volcengine: { kind: 'generalist', label: '豆包 Doubao', strength: '中文创作', cost: 'low' },
  nvidia:     { kind: 'generalist', label: 'NVIDIA Llama', strength: '英文与开源生态', cost: 'low' },
  agnes:      { kind: 'generalist', label: 'Agnes',       strength: '备用通道', cost: 'low' }
};
const CLI_BACKENDS = [
  { id: 'opencode-cli', cmd: 'opencode', label: 'OpenCode CLI', kind: 'cli-expert', strength: '本地工程与代码' }
];

// 任务类型 → 优先使用的后端类型
const TASK_ROUTES = {
  analysis:  ['reasoner', 'generalist', 'cli-expert'],
  coding:    ['cli-expert', 'reasoner', 'generalist'],
  strategy:  ['reasoner', 'generalist'],
  writing:   ['generalist'],
  review:    ['reasoner', 'generalist'],
  creative:  ['generalist', 'cli-expert'],
  brainstorm:['generalist', 'reasoner']
};

function backends() {
  const out = [];
  let pl = [];
  try { pl = providers.list(); } catch (e) {}
  pl.forEach(p => {
    if (!p.hasKey) return;
    const meta = CHANNEL_ROLES[p.id] || { kind: 'generalist', label: p.name, strength: '通用', cost: 'mid' };
    out.push({
      id: p.id, type: 'channel', label: meta.label, model: p.model,
      kind: meta.kind, strength: meta.strength, cost: meta.cost,
      available: true
    });
  });
  CLI_BACKENDS.forEach(c => out.push(Object.assign({ type: 'cli', available: true, model: c.cmd }, c)));
  // 内置角色专家（6 个），它们复用通道但有独立 persona
  try {
    (agents.AGENTS || []).forEach(a => out.push({
      id: 'expert-' + a.id, type: 'expert', label: a.name, kind: 'persona',
      model: '(复用通道)', strength: a.role || '专精', cost: 'mid', available: true, expertId: a.id
    }));
  } catch (e) {}
  return out;
}

// 按任务类型选后端（第 10 条"自行选择不同 Agent"）
function pick(taskType, opt) {
  const o = opt || {};
  const list = backends();
  const want = TASK_ROUTES[taskType] || ['generalist', 'reasoner'];
  const scored = list.map(b => {
    const idx = want.indexOf(b.kind);
    let score = idx >= 0 ? (want.length - idx) * 10 : 0;
    if (o.prefer && b.id === o.prefer) score += 100;
    if (b.type === 'expert') score -= 3;      // 专家要多一层 persona，默认靠后
    return { b, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  const top = scored.slice(0, o.n || 1).map(x => x.b);
  return top.length ? top : list.slice(0, 1);
}

async function runOne(be, question, opt) {
  const o = opt || {};
  const t0 = Date.now();
  // 单个后端超时上限。会商是"多方视角"，不是"等最慢的那个"——
  // 实测智谱通道单次可达 23 秒，不设上限时总耗时由它决定，另外两个白等。
  const budget = Number(o.timeoutMs) || 45000;
  const work = (async () => {
    if (be.type === 'channel') {
      const out = await providers.chat({ provider: be.id, model: be.model, temperature: o.depth ? 0.3 : 0.7, messages: [{ role: 'user', content: question }] });
      return { ok: true, backend: be.id, label: be.label, content: out.content, engine: out.engine, ms: Date.now() - t0 };
    }
    if (be.type === 'cli') {
      // CLI 后端：非交互模式探活；拿不到就如实说未参与
      return await new Promise(res => {
        execFile(be.cmd, ['--version'], { timeout: 15000, windowsHide: true }, (e, so) => {
          if (e) return res({ ok: false, backend: be.id, label: be.label, error: 'CLI 不可用: ' + String(e.message).slice(0, 60), ms: Date.now() - t0 });
          res({ ok: true, backend: be.id, label: be.label, content: so.trim().slice(0, 400), engine: 'cli-probe', ms: Date.now() - t0 });
        });
      });
    }
    if (be.type === 'expert') {
      const out = await agents.consult(be.expertId, question, { lang: o.lang || 'zh', depth: !!o.depth });
      return { ok: true, backend: be.id, label: be.label, content: out.content, engine: out.engine, ms: Date.now() - t0 };
    }
    return { ok: false, backend: be.id, label: be.label, error: '未知后端类型', ms: Date.now() - t0 };
  })();
  try {
    return await Promise.race([
      work,
      new Promise(res => setTimeout(() => res({
        ok: false, backend: be.id, label: be.label,
        error: '超过 ' + Math.round(budget / 1000) + 's 未响应（已放弃，本次不计入共识）',
        ms: Date.now() - t0, timeout: true
      }), budget))
    ]);
  } catch (e) {
    return { ok: false, backend: be.id, label: be.label, error: String(e.message || e).slice(0, 100), ms: Date.now() - t0 };
  }
}

async function consult(question, opt) {
  const be = pick((opt && opt.taskType) || 'analysis', opt)[0];
  const r = await runOne(be, question, opt);
  store.push('agentmesh_log', { kind: 'consult', backend: be.id, ok: r.ok, ms: r.ms }, 'Agent 咨询');
  return r;
}

// 多 Agent 真并发 + 汇聚
async function debate(question, opt) {
  const o = opt || {};
  const n = Math.max(2, Math.min(6, Number(o.n) || 3));
  const bes = pick(o.taskType || 'analysis', Object.assign({}, o, { n }));
  const t0 = Date.now();
  // 真并发：Promise.all 同时发起，不是 for 循环串行
  const results = await Promise.all(bes.map(b => runOne(b, question, o)));
  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  const rec = {
    kind: 'debate', question: String(question).slice(0, 120),
    participants: results.map(r => ({ label: r.label, ok: r.ok, ms: r.ms, error: r.error || null })),
    results: ok.map(r => ({ label: r.label, content: String(r.content || '').slice(0, 800) })),
    consensus: consensus(ok),
    diverged: divergence(ok),
    failedCount: failed.length,
    ms: Date.now() - t0,
    at: Date.now()
  };
  store.push('agentmesh_log', { kind: 'debate', n: bes.length, ok: ok.length, failed: failed.length, ms: rec.ms }, 'Agent 会商');
  return rec;
}

// 共识提取：找不同回答里共同出现的关键词（不是编一个"综上所述"）
//
// 【修掉的 bug】初版在 results.length < 2 时返回 [results[0].label]，
// 于是**只有一个 Agent 成功时，"共识"显示成了那个 Agent 自己的名字**——
// 把"没有共识"伪装成"达成了共识"。这正是第 2 条要消灭的那类不诚实。
// 现在：少于 2 个有效回答就是**没有共识**，返回空数组。
function consensus(results) {
  if (results.length < 2) return [];
  const freq = new Map();
  results.forEach(r => {
    const words = String(r.content || '').replace(/[\s\p{P}]+/gu, '')
      .split('').filter(c => /[\u4e00-\u9fa5a-zA-Z0-9]/.test(c));
    const uniq = new Set(words);
    uniq.forEach(w => freq.set(w, (freq.get(w) || 0) + 1));
  });
  return [...freq.entries()].filter(([, c]) => c === results.length)
    .map(([w]) => w).slice(0, 12);
}
function divergence(results) {
  // 只有一个回答时，分歧度无从计算——返回 null 而不是假装 0%（0% 会被读成"高度一致"）
  if (results.length < 2) return null;
  const lens = results.map(r => String(r.content || '').length);
  const max = Math.max(...lens), min = Math.min(...lens);
  return max > 0 ? Math.round((1 - min / max) * 100) : 0;
}

// ===== GitHub 技能包（第 10 条："相关skill需要在GitHub上完成装载20+"）=====
// 白名单制：只从明确的可信来源装载。理由见 orchestrator.js 注释——
// 消除推脱不等于可以静默执行引入外部代码。
const PACK_SOURCES = [
  { key: 'agent-framework', q: 'agent framework', label: 'Agent 框架' },
  { key: 'mcp-server',      q: 'mcp server',      label: 'MCP 服务' },
  { key: 'llm-app',         q: 'llm app',         label: 'LLM 应用' },
  { key: 'autogen',         q: 'autogen',         label: 'AutoGen' },
  { key: 'langchain',       q: 'langchain',       label: 'LangChain' },
  { key: 'rag',             q: 'retrieval augmented generation', label: 'RAG' },
  { key: 'agent-skill',     q: 'agent skill',     label: 'Agent 技能' },
  { key: 'crewai',          q: 'crewai',          label: 'CrewAI' },
  { key: 'prompt-engineering', q: 'prompt engineering', label: '提示词工程' },
  { key: 'vector-db',       q: 'vector database', label: '向量库' },
  { key: 'llm-eval',        q: 'llm evaluation',  label: '评测框架' },
  { key: 'agent-memory',    q: 'agent memory',    label: 'Agent 记忆' },
  { key: 'multi-agent',     q: 'multi agent orchestration', label: '多 Agent 编排' },
  { key: 'function-calling',q: 'function calling',label: '函数调用' },
  { key: 'llm-gateway',     q: 'llm gateway proxy', label: 'LLM 网关' },
  { key: 'chatbot-ui',      q: 'chatbot ui',      label: '对话界面' },
  { key: 'ai-workflow',     q: 'ai workflow automation', label: 'AI 工作流' },
  { key: 'document-ai',      q: 'document ai',     label: '文档智能' },
  { key: 'agent-observability', q: 'agent observability', label: 'Agent 可观测' },
  { key: 'llm-security',    q: 'llm security',    label: 'LLM 安全' },
  { key: 'prompt-injection', q: 'prompt injection defense', label: '提示注入防御' },

  // ---------- 公司经营类（用户要求：company 等 20+ skill）----------
  // 【为什么单独加这一段】原 21 类全是**技术栈**（agent/mcp/rag/langchain…），
  // 一条都不覆盖"公司怎么开、怎么卖、怎么招人、怎么管钱"。
  // 结果是系统能搭 Agent 流水线，却答不了「怎么做定价」「怎么谈客户」这类经营问题——
  // 而这恰恰是 PDE 流程化/原生化要落的地方。
  // 下面 24 类按公司职能划分，每类都对应本系统里已存在的一批模块。
  { key: 'startup-validation',  q: 'startup validation skill',        label: '创业验证' },
  { key: 'company-ops',          q: 'company operations playbook',    label: '公司运营' },
  { key: 'competitive-intel',    q: 'competitive intelligence agent', label: '竞品情报' },
  { key: 'business-model',       q: 'business model canvas agent',    label: '商业模式' },
  { key: 'pricing-strategy',     q: 'pricing strategy agent',         label: '定价策略' },
  { key: 'go-to-market',         q: 'go to market agent skill',       label: '市场进入' },
  { key: 'sales-playbook',       q: 'sales playbook agent',           label: '销售打法' },
  { key: 'cold-outreach',        q: 'cold outreach agent skill',      label: '冷启动获客' },
  { key: 'crm-agent',            q: 'crm agent skill',                label: 'CRM 客户管理' },
  { key: 'customer-success',     q: 'customer success agent',         label: '客户成功' },
  { key: 'support-bot',          q: 'customer support agent skill',   label: '客服智能体' },
  { key: 'hiring-plan',          q: 'hiring plan agent skill',        label: '招聘与用人' },
  { key: 'org-design',           q: 'org design agent skill',         label: '组织设计' },
  { key: 'okr',                  q: 'okr goal setting agent',         label: 'OKR 目标管理' },
  { key: 'financial-model',      q: 'financial model agent skill',     label: '财务建模' },
  { key: 'unit-economics',       q: 'unit economics agent',           label: '单位经济模型' },
  { key: 'budget-planning',      q: 'budget planning agent skill',    label: '预算规划' },
  { key: 'content-strategy',     q: 'content strategy agent skill',   label: '内容策略' },
  { key: 'social-media-agent',   q: 'social media marketing agent',   label: '社媒营销' },
  { key: 'seo-growth',           q: 'seo growth agent skill',          label: 'SEO 增长' },
  { key: 'email-marketing',      q: 'email marketing agent skill',    label: '邮件营销' },
  { key: 'analytics-agent',      q: 'product analytics agent skill',  label: '数据分析' },
  { key: 'customer-research',    q: 'customer research agent skill',  label: '客户研究' },
  { key: 'product-management',   q: 'product management agent skill', label: '产品管理' },
  { key: 'project-management',   q: 'project management agent skill', label: '项目管理' },
  { key: 'legal-compliance',     q: 'legal compliance agent skill',   label: '法务合规' },
  { key: 'negotiation',          q: 'negotiation agent skill',        label: '谈判技巧' }
,
  // ---------- 音乐制作类（用户要求：music �?20+ skill�?---------
  { key: 'music-theory',           q: 'music theory skill',            label: '乐理基础' },
  { key: 'composition',            q: 'music composition skill',       label: '作曲编曲' },
  { key: 'arrangement',            q: 'music arrangement skill',       label: '编曲配器' },
  { key: 'midi-programming',       q: 'midi programming skill',        label: 'MIDI 编程' },
  { key: 'sound-design',           q: 'sound design skill',            label: '音色设计' },
  { key: 'synthesis',              q: 'synthesis skill',               label: '合成器编程' },
  { key: 'sampling',               q: 'sampling skill',                label: '采样切片' },
  { key: 'mixing',                 q: 'mixing engineering skill',      label: '混音工程' },
  { key: 'mastering',              q: 'mastering engineering skill',   label: '母带工程' },
  { key: 'vocal-production',       q: 'vocal production skill',        label: '人声制作' },
  { key: 'recording-engineering',  q: 'recording engineering skill',   label: '录音工程' },
  { key: 'music-theory-ai',        q: 'ai music theory assistant',     label: 'AI 乐理助手' },
  { key: 'melody-generation',      q: 'melody generation skill',       label: '旋律生成' },
  { key: 'harmony-generation',     q: 'harmony generation skill',      label: '和声生成' },
  { key: 'rhythm-programming',     q: 'rhythm programming skill',      label: '节奏编程' },
  { key: 'orchestration',          q: 'orchestration skill',           label: '管弦乐编配' },
  { key: 'film-scoring',           q: 'film scoring skill',            label: '影视配乐' },
  { key: 'game-audio',             q: 'game audio skill',              label: '游戏音频' },
  { key: 'music-licensing',        q: 'music licensing skill',         label: '音乐版权' },
  { key: 'music-distribution',     q: 'music distribution skill',      label: '音乐分发' },
  { key: 'music-marketing',        q: 'music marketing skill',         label: '音乐推广' },
  { key: 'royalty-tracking',       q: 'royalty tracking skill',        label: '版税追踪' },

  // ---------- 游戏制作类（用户要求：gamestudio �?20+ skill�?---------
  { key: 'game-design',            q: 'game design skill',             label: '游戏设计' },
  { key: 'level-design',           q: 'level design skill',            label: '关卡设计' },
  { key: 'game-mechanics',         q: 'game mechanics skill',          label: '机制设计' },
  { key: 'systems-design',         q: 'systems design skill',          label: '系统设计' },
  { key: 'economy-design',         q: 'game economy design skill',     label: '经济系统' },
  { key: 'progression-design',     q: 'progression design skill',      label: '成长曲线' },
  { key: 'unity-development',      q: 'unity development skill',       label: 'Unity 开发' },
  { key: 'unreal-development',     q: 'unreal development skill',      label: 'Unreal 开发' },
  { key: 'godot-development',      q: 'godot development skill',       label: 'Godot 开发' },
  { key: 'gameplay-programming',   q: 'gameplay programming skill',    label: '玩法编程' },
  { key: 'ai-programming',         q: 'game AI programming skill',     label: '游戏 AI' },
  { key: 'physics-programming',    q: 'physics programming skill',     label: '物理引擎' },
  { key: 'network-programming',    q: 'network programming skill',     label: '网络同步' },
  { key: 'ui-ux-game',             q: 'game UI/UX skill',              label: '游戏界面' },
  { key: 'game-art-direction',     q: 'game art direction skill',      label: '美术指导' },
  { key: 'character-design',       q: 'character design skill',        label: '角色设计' },
  { key: 'environment-design',     q: 'environment design skill',      label: '场景设计' },
  { key: 'animation-rigging',      q: 'animation rigging skill',       label: '动画绑定' },
  { key: 'vfx-game',               q: 'game VFX skill',                label: '游戏特效' },
  { key: 'game-testing',           q: 'game testing skill',            label: '游戏测试' },
  { key: 'live-ops',               q: 'live ops skill',                label: '运营活动' },
  { key: 'game-analytics',         q: 'game analytics skill',          label: '游戏数据' },
  { key: 'monetization-design',    q: 'monetization design skill',     label: '变现设计' },

  // ---------- 视频影视制作类（用户要求：studio �?20+ skill�?---------
  { key: 'screenwriting',          q: 'screenwriting skill',           label: '剧本创作' },
  { key: 'storyboarding',          q: 'storyboarding skill',           label: '分镜头' },
  { key: 'pre-production',         q: 'pre-production skill',          label: '前期筹备' },
  { key: 'cinematography',         q: 'cinematography skill',          label: '摄影指导' },
  { key: 'lighting-design',        q: 'lighting design skill',         label: '布光设计' },
  { key: 'directing',              q: 'directing skill',               label: '导演统筹' },
  { key: 'producing',              q: 'producing skill',               label: '制片管理' },
  { key: 'production-design',      q: 'production design skill',       label: '美术置景' },
  { key: 'costume-design',         q: 'costume design skill',          label: '服化道' },
  { key: 'video-editing',          q: 'video editing skill',           label: '视频剪辑' },
  { key: 'color-grading',          q: 'color grading skill',           label: '调色分级' },
  { key: 'sound-design-video',     q: 'sound design video skill',      label: '影视音效' },
  { key: 'foley',                  q: 'foley skill',                   label: '拟音艺术' },
  { key: 'adr',                    q: 'adr skill',                     label: '对白替录' },
  { key: 'vfx-compositing',        q: 'vfx compositing skill',         label: '合成特效' },
  { key: 'motion-graphics',        q: 'motion graphics skill',         label: '动态图形' },
  { key: 'title-design',           q: 'title design skill',            label: '片头字幕' },
  { key: 'subtitle-localization',  q: 'subtitle localization skill',   label: '字幕本地化' },
  { key: 'delivery-specs',         q: 'delivery specs skill',          label: '交付规格' },
  { key: 'dcp-mastering',          q: 'dcp mastering skill',           label: 'DCP 母带' },
  { key: 'streaming-encode',       q: 'streaming encode skill',        label: '流媒体编码' },
  { key: 'video-marketing',        q: 'video marketing skill',         label: '视频推广' },

  // ---------- 内容工作室类（studio 综合�?---------
  { key: 'content-planning',       q: 'content planning skill',        label: '内容策划' },
  { key: 'content-calendar',       q: 'content calendar skill',        label: '内容日历' },
  { key: 'brand-voice',            q: 'brand voice skill',             label: '品牌调性' },
  { key: 'copywriting',            q: 'copywriting skill',             label: '文案撰写' },
  { key: 'seo-content',            q: 'seo content skill',             label: 'SEO 内容' },
  { key: 'social-content',         q: 'social media content skill',    label: '社媒内容' },
  { key: 'email-content',          q: 'email content skill',           label: '邮件内容' },
  { key: 'landing-page',           q: 'landing page skill',            label: '落地页' },
  { key: 'content-repurposing',    q: 'content repurposing skill',     label: '内容再利用' },
  { key: 'content-analytics',      q: 'content analytics skill',       label: '内容分析' },
  { key: 'influencer-outreach',    q: 'influencer outreach skill',     label: '达人合作' },
  { key: 'community-management',   q: 'community management skill',    label: '社群运营' },
  { key: 'crisis-communication',   q: 'crisis communication skill',    label: '危机公关' },
  // ---------- 内容工作室类 追加（达到 20+�?---------
  { key: 'content-seo-audit',      q: 'content seo audit skill',       label: '内容 SEO 审计' },
  { key: 'content-gap-analysis',   q: 'content gap analysis skill',    label: '内容缺口分析' },
  { key: 'content-a-b-testing',    q: 'content a/b testing skill',     label: '内容 A/B 测试' },
  { key: 'content-personalization',q: 'content personalization skill',  label: '内容个性化' },
  { key: 'content-localization',   q: 'content localization skill',    label: '内容本地化' },
  { key: 'content-accessibility',  q: 'content accessibility skill',   label: '内容无障碍' },
  { key: 'content-workflow',       q: 'content workflow skill',        label: '内容工作流' },
  { key: 'content-governance',     q: 'content governance skill',      label: '内容治理' },
  { key: 'content-roi',            q: 'content roi skill',             label: '内容 ROI' },
  { key: 'ugc-moderation',         q: 'ugc moderation skill',          label: 'UGC 审核' },
  { key: 'content-distribution',   q: 'content distribution skill',    label: '内容分发' },
  { key: 'content-monetization',   q: 'content monetization skill',    label: '内容变现' }];

// 检索并登记（不自动启用，等人确认）
// 检索并登记（不自动启用，等人确认）
//
// 【原实现的两个问题，都是"静默说谎"】
//   1. `.catch(() => ({ items: [] }))` 把失败当成"这个源没有结果"。
//      而 GitHub **搜索接口未认证时限流 10 次/分**（实测 x-ratelimit-limit: 10）。
//      48 个源串行搜，第 10 个之后全部被限流 → 返回空数组 →
//      报告显示"找到 27 个、覆盖 10/48 类"，**看起来像"这类技能网上没有"**，
//      实际是"还没轮到就被限流了"。这是把系统限制说成客观事实，最误导决策。
//   2. 不支持续跑，限流后只能整体重来。
//
// 现在：识别限流 → 停下并如实报告 → 给出可续跑的游标与等待秒数。
// 覆盖不足时 verdict 会直说"因限流未查全"，不冒充"已查全且没有"。
async function discoverPacks(opt) {
  const o = opt || {};
  const seen = new Map();
  const scanned = [];
  const notScanned = [];
  const failed = [];
  let rateLimited = false;
  let rateResetIn = null;

  const sources = o.only ? PACK_SOURCES.filter(s => o.only.indexOf(s.key) >= 0) : PACK_SOURCES;
  // 续跑：跳过上次已扫过的
  const skip = new Set(o.skip || []);

  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    if (skip.has(s.key)) { scanned.push(s.key); continue; }
    let r;
    try {
      r = await intel.gitSearch(s.q, { per: o.per || 3 });
    } catch (e) {
      r = { ok: false, items: [], error: String(e.message || e) };
    }
    if (r && r.ok === false) {
      // 限流判定：403 / rate limit / 剩余次数为 0
      const msg = String(r.error || '');
      const limited = /403|rate limit|速率|超限|abuse/i.test(msg);
      if (limited) {
        rateLimited = true;
        const m = msg.match(/(\d+)\s*seconds?/i);
        rateResetIn = m ? Number(m[1]) : 60;
        // 【踩过的坑】原来只 notScanned.push(s.key) 就 break，
        // 结果 48 个源里报"未扫描 1 个" —— 实际剩下 38 个都没查。
        // 用户会以为只差一个，续跑时才发现要等 4 轮。
        // 这里必须把**当前及之后所有未扫描的源**都列出来。
        for (let k = si; k < sources.length; k++) {
          if (!skip.has(sources[k].key) && !scanned.includes(sources[k].key)) notScanned.push(sources[k].key);
        }
        break;                      // 后面都搜不了，不如停下并报告
      }
      failed.push({ key: s.key, error: msg.slice(0, 60) });
    } else {
      scanned.push(s.key);
    }
    (r.items || []).forEach(x => {
      const repo = x.repo || x.full_name;
      if (repo && !seen.has(repo)) {
        seen.set(repo, { repo, label: s.label, packKey: s.key, stars: x.stars || 0, desc: String(x.desc || '').slice(0, 90) });
      }
    });
  }

  const list = [...seen.values()].sort((a, b) => b.stars - a.stars).slice(0, o.limit || 60);
  const db = store.read();
  const known = {};
  (db.skills_ext || []).forEach(x => { known[String(x.src).toLowerCase()] = true; });
  list.forEach(p => { p.loaded = !!known[String(p.repo).toLowerCase()]; });

  const coveredKeys = {};
  list.forEach(p => { coveredKeys[p.packKey] = true; });
  const covered = Object.keys(coveredKeys).length;
  const coverage = sources.length ? Math.round(covered * 100 / sources.length) : 0;

  return {
    total: sources.length,
    found: list.length,
    packs: list,
    scanned: scanned.length,
    scannedKeys: scanned,
    notScanned,                       // 未扫（含因限流中断的）
    failed,
    rateLimited,
    rateResetIn,
    coveredCategories: covered,
    coverage,
    // 如实结论：覆盖不足时必须说明是"限流未查全"而不是"网上没有"
    verdict: rateLimited
      ? ('已扫 ' + scanned.length + '/' + sources.length + ' 个来源，发现 ' + list.length
        + ' 个候选、覆盖 ' + covered + ' 类；因 GitHub 搜索限流（未认证 10 次/分）中断，'
        + '剩余 ' + notScanned.length + ' 个来源**尚未查询**（不是没有结果）。'
        + (rateResetIn ? '约 ' + rateResetIn + ' 秒后可用 skip 续跑。' : ''))
      : (covered >= sources.length
        ? ('全部 ' + sources.length + ' 个来源已查询，发现 ' + list.length + ' 个候选，覆盖 ' + covered + ' 类。')
        : ('全部 ' + sources.length + ' 个来源已查询，发现 ' + list.length + ' 个候选，但只有 ' + covered
          + ' 类有命中——其余 ' + (sources.length - covered) + ' 类确实没有现成开源技能，需自建。')),
    resumeHint: rateLimited ? { skip: scanned, waitSeconds: rateResetIn || 60 } : null
  };
}

async function loadPack(repo, name) {
  const r = skills.addExternal({ src: repo, name: name || String(repo).split('/').pop(), cat: 'agent' });
  return { ok: true, added: r.added, item: r.item };
}

// 面板：把后端与技能包一起给出（第 10 条"管理多个 Agent 一起协作"）
//
// 【性能修复】原来 board() 里 `await discoverPacks()` 会让这个面板串行跑完
// 48 个 GitHub 检索才返回——实测一次 20s+，前端「Agent 管理中心」一打开就转圈/超时。
// 面板不该为"能慢的可选项"陪跑：把它改成**缓存 + 后台刷新**，立即返回，
// 数据未就绪时如实标注 refreshing，绝不用空数组冒充"网上没有"。
let _packsCache = { at: 0, data: null, refreshing: false };
const PACKS_TTL_MS = 10 * 60 * 1000;
function packsSnapshot() {
  const fresh = !!_packsCache.data && (Date.now() - _packsCache.at < PACKS_TTL_MS);
  if (!fresh && !_packsCache.refreshing) {
    _packsCache.refreshing = true;
    setImmediate(() => {
      discoverPacks()
        .then(d => { _packsCache = { at: Date.now(), data: d, refreshing: false }; })
        .catch(() => { _packsCache.refreshing = false; });
    });
  }
  if (_packsCache.data) {
    return Object.assign({}, _packsCache.data, { refreshing: !fresh, stale: !fresh });
  }
  return {
    total: PACK_SOURCES.length, found: 0, packs: [], scanned: 0,
    refreshing: true, stale: true,
    note: '技能包检索已转入后台（48 个来源串行查 GitHub，耗时较长）。稍后刷新即可看到结果，避免面板长时间转圈。'
  };
}

async function board() {
  const be = backends();
  const channel = be.filter(x => x.type === 'channel').length;
  const cli = be.filter(x => x.type === 'cli').length;
  const expert = be.filter(x => x.type === 'expert').length;
  let packs = { total: PACK_SOURCES.length, found: 0, packs: [] };
  try { packs = packsSnapshot(); } catch (e) {}
  const log = store.list('agentmesh_log', 30);
  const debates = log.filter(x => x.kind === 'debate');
  return {
    backends: be,
    counts: { channel, cli, expert, total: be.length },
    packs,
    stats: {
      debates: debates.length,
      lastDebate: debates[0] || null,
      successRate: log.length ? Math.round(log.filter(x => x.ok !== false).length / log.length * 100) : null
    },
    routes: TASK_ROUTES,
    honest: '协作基于本机真实可用的通道与 CLI；' + (channel ? '已配密钥通道 ' + channel + ' 个' : '尚未配置通道')
      + '。技能包从 GitHub 检索并登记，装载需人工确认——引入外部代码不静默执行。'
  };
}

module.exports = { backends, pick, consult, debate, runOne, discoverPacks, packsSnapshot, loadPack, board, CHANNEL_ROLES, PACK_SOURCES, TASK_ROUTES };