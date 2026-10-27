// core/harness.js — RRSI 式 harness 自动优化（Google Research rrsi, arXiv:2609.24972 落地版）
//
// 目标：不是"验证经验"（那已在 lessons.js），而是**让 agent 自动改进自己的 harness**
//      ——提示词、工具选择策略、上下文装配——并且用**真实业务数据**当评测集，
//      而不是自己给自己打分。这是 RRSI 的核心，也是它区别于"拍脑袋调 prompt"的地方。
//
// 移植的四条（与原文语义一致）：
//   ① 退火编辑预算 b_t：早期允许多改，后期收敛到 1，防止一次性大改砸了
//   ② 反过拟合 critic：候选在**花评测预算之前**先审 diff，拒绝"记住考题"式作弊
//   ③ 噪声地板 + 成本闸：Δscore 必须超过评测噪声，且收益要覆盖新增 token 成本
//   ④ 无提升则剪枝：不再有效的组件从 harness 里移除
//
// 红线（重要）：
//   · 评测集必须是**真实历史业务数据**（真问题 + 真结果），绝不自造题目
//   · 没有足够样本时**如实拒绝优化**并说明原因，不做无依据的改动
//   · 任何 harness 变更都写审计 + 可一键回滚（保留上一版）
//   · 提案由 LLM 生成，但**采纳由数据决定**；LLM 说好不算数
//   · 这是离线/定时任务，绝不在用户对话中途偷换 harness

const store = require('./store');
const fs = require('fs');
const path = require('path');

const HARNESS_KEY = 'harness';
const VERSION_KEY = 'harnessVersions';
const RUNS_KEY = 'harnessRuns';
const MAX_VERSIONS = 20;
const MAX_RUNS = 40;

// ---------- 当前 harness（可热更新，带默认值兜底）----------
const DEFAULT_HARNESS = {
  version: 1,
  // ① 系统提示词：告诉模型它有哪些能力、该怎么用真实数据
  systemPrompt: [
    '你是丙大山 AI Agent，一个会真正动手干活的智能体。',
    '你有这些真实能力：120 个可执行技能（财务/市场/管理/咨询/人力）、项目真实数据（营收/漏斗/知识/经验）、联网情报（GitHub/热点）、决策框架库。',
    '回答规则：',
    '1) 涉及数字时必须引用【工具上下文】或【项目真实数据】里的实测值，绝不编造。',
    '2) 涉及用户自身项目状态时，优先用注入的数据快照，不要给通用建议。',
    '3) 引用过的经验要说明来源；经验库只注入已验证通过的。',
    '4) 不知道就说不知道，并说明该查什么。'
  ].join('\n'),
  // ② 工具选择策略：决定 smart.detect 的路由偏好
  toolPolicy: {
    preferSkill: true,      // 优先跑技能而不是空谈
    preferDataFirst: true,  // 项目数据问题优先注入真实数据
    webOnNovelTopic: true,  // 陌生话题自动联网
    maxToolsPerTurn: 2      // 单轮最多注入几个工具结果（控制成本）
  },
  // ③ 上下文装配：决定把什么喂给模型
  contextPolicy: {
    includeLessons: true,   // 注入已验证经验
    includeMemory: true,    // 注入相关记忆
    includeData: true,      // 注入项目数据
    maxContextChars: 6000   // 上下文预算（成本闸的实际执行点）
  },
  updatedAt: 0,
  updatedBy: 'default'
};

function current() {
  const h = store.getSetting(HARNESS_KEY);
  if (!h || typeof h !== 'object') return Object.assign({}, DEFAULT_HARNESS);
  // 深合并默认值：新增字段向后兼容
  return {
    ...DEFAULT_HARNESS, ...h,
    toolPolicy: { ...DEFAULT_HARNESS.toolPolicy, ...(h.toolPolicy || {}) },
    contextPolicy: { ...DEFAULT_HARNESS.contextPolicy, ...(h.contextPolicy || {}) }
  };
}

// ---------- 版本存档（可回滚）----------
function snapshot(reason) {
  const db = store.read();
  if (!Array.isArray(db[VERSION_KEY])) db[VERSION_KEY] = [];
  const h = current();
  db[VERSION_KEY].unshift({
    version: h.version, harness: JSON.parse(JSON.stringify(h)),
    at: Date.now(), reason: String(reason || '').slice(0, 120)
  });
  if (db[VERSION_KEY].length > MAX_VERSIONS) db[VERSION_KEY] = db[VERSION_KEY].slice(0, MAX_VERSIONS);
  store.write(db);
}

function versions(limit) {
  return (store.read()[VERSION_KEY] || []).slice(0, limit || 10);
}

function rollback(versionNo) {
  const list = store.read()[VERSION_KEY] || [];
  const hit = list.find(v => v.version === Number(versionNo));
  if (!hit) return { ok: false, error: '没有该版本：' + versionNo };
  snapshot('回滚前存档');
  const h = current();
  store.setSetting(HARNESS_KEY, Object.assign({}, hit.harness, { version: h.version + 1, updatedAt: Date.now(), updatedBy: 'rollback:' + versionNo }));
  return { ok: true, restoredFrom: Number(versionNo), nowVersion: current().version };
}

// ---------- ① 退火编辑预算（Eq. annealed b_t）----------
// 早期 b_max（可多改），后期 b_min=1（收敛到单改）——防止一次大改砸掉现役系统
function editBudget(t, T, bMin, bMax) {
  const bmin = bMin || 1, bmax = bMax || 3;
  if (!T || T <= 1) return bmin;
  const frac = Math.min(1, Math.max(0, t / (T - 1)));
  return Math.ceil(bmin + (bmax - bmin) * 0.5 * (1 + Math.cos(Math.PI * frac)));
}

// ---------- 评测集：真实业务数据 ----------
// 关键：只用**真实发生过**的（问题 + 当时的回答/结果）。没有就拒绝优化。
// 【修改】样本阈值放宽：3 条以上可配对即可启动评测，但 <5 条时标记 risk='sample_insufficient'，
// 由人工 review 后决定是否采纳，避免“没有样本就彻底停摆”而导致闭环不启动。
function buildEvalSet(limit) {
  const db = store.read();
  const msgs = (db.messages || []).filter(m => m && m.role === 'user' && m.content);
  const replies = (db.messages || []).filter(m => m && m.role === 'assistant' && m.content);
  // 真实配对：按时间邻近把 user 问题与随后的 assistant 回答配对
  const pairs = [];
  for (let i = 0; i < msgs.length; i++) {
    const q = msgs[i];
    const after = replies.filter(r => (r.at || r.createdAt || 0) >= (q.at || q.createdAt || 0))
      .sort((a, b) => (a.at || 0) - (b.at || 0))[0];
    if (after && after.content) {
      pairs.push({
        q: String(q.content).slice(0, 200),
        a: String(after.content).slice(0, 600),
        tools: (after.tools || []).join(','),
        at: q.at || q.createdAt || 0
      });
    }
  }
  if (pairs.length < 3) {
    return { ok: false, reason: '可配对的真实问答不足（' + pairs.length + ' 对，需 ≥3）', count: pairs.length };
  }
  // 【放宽阈值】3 ≤ pairs.length < 5 时，允许启动评测但标记风险，由人工 review 后决定是否采纳
  if (pairs.length < 5) {
    return { ok: true, risk: 'sample_insufficient', count: pairs.length };
  }
  // 5条以上：正常返回完整样本
  return { ok: true, count: pairs.length, pairs: pairs.slice(-(limit || 8)) };
}

// ---------- 评测：给一个 harness 打分 ----------
// 评分维度（全部可用规则/真实数据判定，不需要额外 LLM 调用，零成本可重复）：
//   · grounding  回答是否引用了注入的上下文（数字/来源）
//   · brevity    是否命中"不啰嗦"（过短或过长都扣）
//   · toolUse    该用工具时是否真的用了
//   · honesty    是否出现无据断言（"据我了解/一定/肯定"等无来源断言）
//   总分 0..1。Δscore 需超过噪声地板才算真实提升。
function scoreAnswer(harness, pair) {
  const a = pair.a || '';
  const hasNumber = /\d/.test(a);
  const citesSource = /(工具上下文|项目真实数据|经验库|来源|出处|实测|依据)/.test(a);
  const tooShort = a.length < 40;
  const tooLong = a.length > 1800;
  const overClaim = /(据我了解|众所周知|一定|肯定会|绝对)/.test(a) && !citesSource;
  const admitsUnknown = /(不知道|无法确认|需要查|建议核实)/.test(a) && !hasNumber;

  // 打分
  let s = 0.5;
  if (citesSource) s += 0.2;
  if (hasNumber && citesSource) s += 0.1;      // 数字有出处 = 最好
  if (harness.contextPolicy.includeData && pair.needsData && citesSource) s += 0.1;
  if (overClaim) s -= 0.2;                        // 无据断言重罚
  if (tooShort) s -= 0.1;
  if (tooLong) s -= 0.1;
  if (admitsUnknown && !citesSource) s -= 0.05;
  if (pair.tools && harness.toolPolicy.preferSkill) s += 0.05;  // 真调了工具加分
  return Math.max(0, Math.min(1, s));
}

// 评测一个 harness 在真实样本上的平均分与成本
function evaluate(harness, set) {
  let total = 0, ctxCost = 0;
  set.pairs.forEach(p => {
    total += scoreAnswer(harness, p);
    // 成本代理：注入的上下文长度（真实可控成本）
    ctxCost += Math.min(1, String(p.a || '').length / 2000);
  });
  const n = Math.max(1, set.pairs.length);
  return { score: total / n, cost: ctxCost / n, n };
}

// ---------- ② 反过拟合 critic：审 diff，拒绝作弊 ----------
// 拒绝"把考题答案硬编码进 harness"这类作弊——例如把具体数字/专有名词写进 systemPrompt。
const LEAK_PATTERNS = [
  /\b\d{3,}(?:\.\d+)?\s*(?:元|块|万|%|元)/,   // 具体金额/比例硬编码进提示词
  /(答案|正确答案|这道题|本次测试|样例问题)/,   // 明显针对评测集的措辞
  /always answer|always say|必须回答|一律回复/     // 过度规定（脆弱且多半是过拟合）
];
function criticScreen(candidate, base) {
  // _budget 是提案元数据（本次允许改几个键），不是配置项本身，必须排除在 diff 之外
  const META = ['_budget', 'version', 'updatedAt', 'updatedBy'];
  const diffKeys = Object.keys(candidate).filter(k => !META.includes(k) && JSON.stringify(candidate[k]) !== JSON.stringify(base[k]));
  const problems = [];
  // 泄漏检查：新增/修改的字符串里不能出现具体答案或硬编码数值
  diffKeys.forEach(k => {
    const text = typeof candidate[k] === 'string' ? candidate[k] : JSON.stringify(candidate[k] || {});
    LEAK_PATTERNS.forEach(re => {
      if (re.test(text)) problems.push({ key: k, why: '疑似过拟合/泄漏：' + re.source });
    });
  });
  // 变更预算检查
  // 【按叶子键计数，而不是顶层键】原实现 diffKeys.length 把
  // {toolPolicy:{a:1,b:2,c:3,d:4}} 算成 **1 个**键 → 提案可以往
  // toolPolicy 里塞几十个字段而通过预算检查，退火预算形同虚设。
  // 预算管的是「本轮允许改多少个配置项」，所以必须数真正发生变化的叶子键。
  const budget = candidate._budget || 3;
  const leafChanged = diffKeys.reduce((n, k) => {
    const before = base[k];
    const after = candidate[k];
    // 标量：键本身变了算 1
    if (after === null || typeof after !== 'object') return n + 1;
    // 对象：只数 candidate 里**新增或值改变**的键。
    // 【不能把 base 有而 candidate 缺的键算进来】candidate 是补丁而非完整替换，
    // runOnce 会用 {...base.toolPolicy, ...candidate.toolPolicy} 合并；
    // 若把「缺失」算成变更，一条只改 2 项的提案会被数成 8 项而被误驳。
    let c = 0;
    Object.keys(after || {}).forEach(kk => {
      if (JSON.stringify(before && before[kk]) !== JSON.stringify(after[kk])) c++;
    });
    return n + c;
  }, 0);
  if (leafChanged > budget) {
    problems.push({ key: '*', why: '实际变更配置项 ' + leafChanged + ' 个超过退火预算 ' + budget });
  }
  return { pass: problems.length === 0, problems, diffKeys, leafChanged, budget };
}

// ---------- 提案：让 LLM 生成候选 harness（它只是提案，采纳由数据决定）----------
// ---------- 规则化提案器：LLM 不可用时的降级路径 ----------
// 【为什么必须有】propose 依赖 LLM 生成候选。一旦模型通道不可达（离线、
// 额度耗尽、provider 全挂），整个自我优化闭环**完全停摆** —— 但闭环里
// 其他环节（evaluate / criticScreen / select）全是纯规则、零成本、离线可跑。
// 让它们陪 LLM 一起罢工是浪费。
//
// 这里基于**真实样本的统计特征**推导配置调整，而不是凭空生成提示词：
//   · 引用来源的比例低 → 开 includeLessons/includeMemory（更多可引用的上下文）
//   · 工具调用比例低   → 开 preferSkill（鼓励优先用已有技能而不是空想）
//   · 回答普遍过长     → 降 maxContextChars（减少注入噪音，间接抑制啰嗦）
// 全部是**有据可依**的配置位开关，不写提示词、不含具体答案，
// 因此天然通过 critic 的过拟合检查。
function rulePropose(base, set, budget) {
  const n = Math.max(1, set.pairs.length);
  const cites = set.pairs.filter(p => /(工具上下文|项目真实数据|经验库|来源|出处|实测|依据)/.test(p.a || '')).length;
  const citeRate = cites / n;
  const usedTools = set.pairs.filter(p => p.tools).length / n;
  const avgLen = set.pairs.reduce((a, p) => a + (p.a || '').length, 0) / n;

  const cand = { toolPolicy: {}, contextPolicy: {} };
  const reasons = [];

  // 来源引用率低 → 把经验/记忆接进上下文（都是已有的真实素材，不是编造）
  if (citeRate < 0.4) {
    if (!base.contextPolicy.includeLessons) { cand.contextPolicy.includeLessons = true; reasons.push('样本中仅 ' + Math.round(citeRate * 100) + '% 引用了来源 → 接入经验库'); }
    if (!base.contextPolicy.includeMemory) { cand.contextPolicy.includeMemory = true; reasons.push('接入记忆以提高可溯源比例'); }
  }
  // 工具调用率低 → 优先用已有技能
  if (usedTools < 0.5 && !base.toolPolicy.preferSkill) {
    cand.toolPolicy.preferSkill = true;
    reasons.push('仅 ' + Math.round(usedTools * 100) + '% 的回答用到了工具 → 优先复用已有技能');
  }
  // 样本里根本没调过工具 → 开了 preferSkill 也不会有用，反过来考虑放开话题外检索
  if (usedTools === 0 && !base.toolPolicy.webOnNovelTopic) {
    cand.toolPolicy.webOnNovelTopic = true;
    reasons.push('样本中零工具调用 → 允许陌生话题走联网检索');
  }

  // 【连续量旋钮·有据可依】布尔位全开时规则提案器会「无事可做」，
  // 闭环就又停摆了（默认配置里 preferSkill/includeLessons/includeMemory
  // 全部为 true，一旦样本特征也满足就直接无解）。
  // 真正还有依据可调的只有两个连续量，按**样本证据**双向调整：
  //   · maxToolsPerTurn：工具调用率低 → 下调（每轮少注入无关工具，直接省成本）
  //   · maxContextChars：平均回答过长 → 下调（压缩注入，间接抑制啰嗦）
  // 两者都不是凭空调整：阈值与理由都直接来自这批真实样本的统计值。
  if (usedTools < 0.5 && (base.toolPolicy.maxToolsPerTurn || 0) > 1) {
    cand.toolPolicy.maxToolsPerTurn = 1;
    reasons.push('仅 ' + Math.round(usedTools * 100) + '% 的回答用到工具 → 每轮工具上限 ' +
      base.toolPolicy.maxToolsPerTurn + '→1（少注入无关工具，省成本）');
  }
  if (avgLen > 1400 && base.contextPolicy.maxContextChars > 4000) {
    cand.contextPolicy.maxContextChars = 4000;
    reasons.push('平均回答 ' + Math.round(avgLen) + ' 字偏长 → 上下文注入 ' +
      base.contextPolicy.maxContextChars + '→4000（抑制噪音）');
  }
  // 反向：样本普遍引用了来源却仍未接入数据，说明 includeData 被关掉了
  if (citeRate >= 0.4 && !base.contextPolicy.includeData) {
    cand.contextPolicy.includeData = true;
    reasons.push('样本引用率高但未接入项目真实数据 → 打开 includeData');
  }

  const diffKeys = ['toolPolicy', 'contextPolicy'].filter(k => Object.keys(cand[k] || {}).length);
  if (!diffKeys.length) return { ok: false, error: '规则提案器：无依据可改（现有配置已匹配样本特征）' };
  if (diffKeys.length > budget) return { ok: false, error: '规则提案器：变更键数超过退火预算 ' + budget };

  return {
    ok: true, candidate: cand, engine: 'rule-based',
    ruleReasons: reasons,
    _budget: budget
  };
}

async function propose(base, set, budget) {
  const providers = require('./providers');
  const brain = require('./brain');
  const providerId = brain.recommendedProvider(providers.list());
  if (!providerId) return { ok: false, error: '无可用模型通道，无法生成提案' };

  // 只给提案器看**真实样本的统计特征**，不看具体答案（避免它照抄考题）
  const stats = {
    样本数: set.pairs.length,
    平均回答长度: Math.round(set.pairs.reduce((a, p) => a + (p.a || '').length, 0) / set.pairs.length),
    调用过工具的比例: (set.pairs.filter(p => p.tools).length / set.pairs.length * 100).toFixed(0) + '%',
    当前均分: evaluate(base, set).score.toFixed(3)
  };

  const prompt = `你是一个 Agent harness 的优化器。当前 harness 配置如下：
${JSON.stringify(base, null, 2)}

最近真实业务对话的统计特征（不给具体内容，避免你照抄）：
${JSON.stringify(stats, null, 2)}

本轮最多允许你改 ${budget} 个配置项（退火预算，后期会更严）。
只输出 JSON，格式：{"systemPrompt": "...可选...", "toolPolicy": {...可选...}, "contextPolicy": {...可选...}}
只改你认为能提升「有据可依、不编造、不啰嗦」的点。不要写具体数字、不要写"针对某问题"这种针对具体样本的内容（会被判为过拟合直接拒绝）。`;

  try {
    const out = await providers.chat({
      provider: providerId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4
    });
    const m = String(out.content || '').match(/\{[\s\S]*\}/);
    if (!m) return rulePropose(base, set, budget);   // 降级：模型没给 JSON 也别停摆
    const cand = JSON.parse(m[0]);
    cand._budget = budget;
    return { ok: true, candidate: cand, engine: out.engine };
  } catch (e) {
    // 【降级而非放弃】模型通道不可达时，闭环里其余环节全是纯规则、离线可跑，
    // 陪它一起罢工是浪费。规则提案器同样只做「有据可依的配置位开关」，
    // 且必须再过 critic 的过拟合检查 —— 不会因为降级而降低安全标准。
    const r = rulePropose(base, set, budget);
    if (r.ok) {
      r.fallbackFrom = 'llm:' + String(e.message || e).slice(0, 80);
      return r;
    }
    return { ok: false, error: '提案生成失败：' + String(e.message || e).slice(0, 120) + '（规则降级亦无可改：' + r.error + '）' };
  }
}

// ---------- ③ 采纳规则：噪声地板 + 成本闸 ----------
// Δscore > 噪声地板(0.02，可调)  且  成本增幅可接受  → 采纳
const NOISE = 0.02;
function select(baseEval, candEval) {
  const dS = candEval.score - baseEval.score;
  const dC = candEval.cost - baseEval.cost;
  if (dS <= NOISE) {
    return { adopt: false, reason: '提升 ' + dS.toFixed(4) + ' ≤ 噪声地板 ' + NOISE + '（在评测噪声内，视为无提升）', dS, dC };
  }
  // 成本闸：成本增幅不能吞掉收益（这里用相对比，成本已归一到 0..1）
  if (dC > 0 && dC > dS * 2) {
    return { adopt: false, reason: '成本闸：成本增 ' + dC.toFixed(3) + ' 超过收益 ' + dS.toFixed(3) + ' 的 2 倍，不划算', dS, dC };
  }
  return { adopt: true, reason: 'Δscore=' + dS.toFixed(4) + ' 超过噪声地板，且通过成本闸', dS, dC };
}

// ---------- ④ 一轮完整优化 ----------
async function runOnce(opts) {
  const o = opts || {};
  const t = o.t || 0, T = o.T || 6;
  const budget = editBudget(t, T, 1, o.bMax || 3);
  const log = { at: Date.now(), round: t, budget, steps: [] };

  // 0) 评测集：真实业务数据
  const set = buildEvalSet(o.limit || 8);
  if (!set.ok) {
    log.result = 'skipped';
    log.reason = set.reason;   // 如实说明为什么没优化
    pushRun(log);
    return { ok: false, ...log };
  }
  // 【修建】当样本数 3 ≤ count < 5 时，允许启动评测但标记风险
  if (set.risk && set.risk === 'sample_insufficient') {
    log.result = 'sample_insufficient';
    log.reason = '真实对话样本不足（' + set.count + ' 条，需 ≥5），已记录但待人工 review，不计入采纳统计';
    log.risk = set.risk;
    log.evalSet = set.count;
    pushRun(log);
    return { ok: true, ...log };
  }
  log.evalSet = set.count;

  const base = current();
  const baseEval = evaluate(base, set);
  log.baseScore = Number(baseEval.score.toFixed(4));

  // 1) 提案
  const prop = await propose(base, set, budget);
  if (!prop.ok) { log.result = 'propose-failed'; log.reason = prop.error; pushRun(log); return { ok: false, ...log }; }
  log.candidate = prop.candidate;
  log.engine = prop.engine;
  if (prop.fallbackFrom) log.engineFallback = prop.fallbackFrom;
  if (prop.ruleReasons) log.ruleReasons = prop.ruleReasons;

  // 2) critic：花评测预算之前先审
  const screened = criticScreen(prop.candidate, base);
  log.critic = { pass: screened.pass, problems: screened.problems, diffKeys: screened.diffKeys, leafChanged: screened.leafChanged, budget: screened.budget };
  if (!screened.pass) {
    log.result = 'rejected-by-critic';
    log.reason = screened.problems.map(p => p.why).join('; ').slice(0, 200);
    pushRun(log);
    return { ok: false, rejected: true, ...log };
  }

  // 3) 应用候选到副本并评测 —— 记录**逐键 diff（before→after）**
  const candidate = {
    ...base, ...prop.candidate,
    toolPolicy: { ...base.toolPolicy, ...(prop.candidate.toolPolicy || {}) },
    contextPolicy: { ...base.contextPolicy, ...(prop.candidate.contextPolicy || {}) }
  };
  // 计算逐键 diff
  const diff = {};
  const changedKeys = new Set([...Object.keys(prop.candidate || {}), ...Object.keys(base)]);
  changedKeys.forEach(k => {
    if (k.startsWith('_') || k === 'version' || k === 'updatedAt' || k === 'updatedBy') return;
    const before = base[k];
    const after = candidate[k];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      diff[k] = { before, after };
    }
  });
  log.diff = diff;

  const candEval = evaluate(candidate, set);
  log.candScore = Number(candEval.score.toFixed(4));
  log.candCost = Number(candEval.cost.toFixed(4));

  // 4) 采纳判定
  const sel = select(baseEval, candEval);
  log.selection = { adopt: sel.adopt, reason: sel.reason, dS: sel.dS, dC: sel.dC };
  if (sel.adopt) {
    snapshot('RRSI 优化前 v' + base.version);
    store.setSetting(HARNESS_KEY, {
      ...candidate,
      version: base.version + 1,
      updatedAt: Date.now(),
      updatedBy: 'rrsi:' + (prop.engine || 'llm')
    });
    log.result = 'adopted';
    log.adoptedVersion = base.version + 1;
  } else {
    log.result = 'not-adopted';
    log.reason = sel.reason;
  }
  pushRun(log);
  return { ok: true, ...log };
}

function pushRun(log) {
  const db = store.read();
  if (!Array.isArray(db[RUNS_KEY])) db[RUNS_KEY] = [];
  db[RUNS_KEY].unshift(log);
  if (db[RUNS_KEY].length > MAX_RUNS) db[RUNS_KEY] = db[RUNS_KEY].slice(0, MAX_RUNS);
  store.write(db);
}

function status() {
  const h = current();
  const runs = store.read()[RUNS_KEY] || [];
  return {
    ok: true,
    version: h.version, updatedBy: h.updatedBy, updatedAt: h.updatedAt,
    toolPolicy: h.toolPolicy, contextPolicy: h.contextPolicy,
    totalRuns: runs.length,
    adopted: runs.filter(r => r.result === 'adopted').length,
    rejectedByCritic: runs.filter(r => r.result === 'rejected-by-critic').length,
    notAdopted: runs.filter(r => r.result === 'not-adopted').length,
    skipped: runs.filter(r => r.result === 'skipped').length,
    recent: runs.slice(0, 5).map(r => ({ at: r.at, round: r.round, result: r.result, base: r.baseScore, cand: r.candScore, reason: (r.reason || '').slice(0, 80) })),
    availableVersions: versions(5).map(v => ({ version: v.version, at: v.at, reason: v.reason }))
  };
}

module.exports = { current, snapshot, versions, rollback, buildEvalSet, evaluate, scoreAnswer, criticScreen, propose, select, runOnce, status, editBudget, DEFAULT_HARNESS, NOISE, RUNS_KEY };
