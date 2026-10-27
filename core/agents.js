// core/agents.js — 专家会诊：四位角色专家并行协作
// 每个专家独立系统提示 + 自动带记忆/知识；结论写入决策中心 + 审计日志 + 学习曲线。
// 多专家可对同一问题给出不同视角（互联互动：分析师 -> 战略 -> 策划 -> 风控）。

const providers = require('./providers');
const brain = require('./brain');
const knowledge = require('./knowledge');
const store = require('./store');

const AGENTS = [
  { id: 'analyst',   name: '分析专家',   color: '#2563eb', sys: '你是丙大山AI团队的分析专家，擅长把问题拆解成假设、数据与结论三个层次，回答结构化、给出可验证的指标。' },
  { id: 'strategist',name: '战略顾问',   color: '#7c3aed', sys: '你是丙大山AI团队的战略顾问，擅长从全局与长期收益思考，给出方向建议、风险权衡与优先级排序。' },
  { id: 'planner',   name: '项目策划',   color: '#0d9488', sys: '你是丙大山AI团队的项目策划，擅长把目标转成可执行的里程碑、任务拆解、排期与资源分配。' },
  { id: 'critic',    name: '风控审计',   color: '#dc2626', sys: '你是丙大山AI团队的风控审计专家，专门寻找计划中的漏洞、假设风险与可执行性缺陷，直接指出问题。' },
  { id: 'grower',    name: '增长专家',   color: '#f59e0b', sys: '你是丙大山AI团队的增长专家，擅长获客、转化、留存与复购的增长引擎设计，给出可量化指标与实验方案。' },
  { id: 'builder',   name: '落地工程师', color: '#0891b2', sys: '你是丙大山AI团队的落地工程师，擅长把方案转成具体实现路径：里程碑拆解、依赖清理、验收标准与第一周能动手的事情。' }
];

function list() {
  return AGENTS.map(a => Object.assign({}, a));
}

// 指定专家回答（带记忆 + 知识 + 学习/降级）
// opts.fallback=true：无可用模型通道时改用"确定性本地专家模板"，引用真实记忆/知识，保证永不空跑。
async function consult(agentId, question, opts) {
  const ag = AGENTS.find(a => a.id === agentId);
  if (!ag) throw new Error('未知专家：' + agentId);

  const lang = (opts && opts.lang) || store.getSetting('lang') || 'zh';
  const langName = { zh: '中文', en: 'English', fr: 'Francais', ar: 'العربية' }[lang] || '中文';
  const mem = brain.recall(question).slice(0, 3);
  const kn = knowledge.recall(question, 3);
  // 跨项目经验注入（借鉴 Polsia 群体进化）：把其他项目沉淀的真实成败教训喂给专家，
  // 这是 lessons 从"只写不读"变成真正影响决策的关键接线。每次命中记 useCount（复用热度）。
  let les = [];
  try { les = require('./lessons').find(question, 3); } catch (e) {}

  const sys = [
    ag.sys,
    '本次请用 ' + langName + ' 回答。',
    mem.length ? '相关记忆：\n' + mem.map(m => '- [' + m.key + '] ' + m.value).join('\n') : '',
    kn.length ? '已沉淀知识：\n' + kn.map(x => '- Q:' + x.q + ' A:' + x.a).join('\n') : '',
    les.length ? '他项目真实教训（同类问题踩过的坑，务必规避，勿照搬未验证做法）：\n' + les.map(l => '- [' + (l.kind === 'win' ? '成功' : l.kind === 'fail' ? '失败' : '技巧') + '·' + l.topic + '] ' + l.action).join('\n') : ''
  ].filter(Boolean).join('\n');
  // 记复用（让 lessons 的召回排序能反映"哪些经验真的在用"）
  try { les.forEach(l => require('./lessons').used(l.id)); } catch (e) {}

  // provider：指定优先，否则自适应推荐
  const pl = providers.list();
  let providerId = (opts && opts.provider) || store.getSetting('provider') || null;
  if (!providerId || !pl.find(x => x.id === providerId && x.hasKey)) {
    providerId = brain.recommendedProvider(pl);
  }
  // 无任何可用模型通道：允许本地确定性模板兜底（team 协作默认开启，单专家 consult 可显式传 fallback）
  if (!providerId) {
    if (opts && opts.fallback) {
      const local = localAnswer(ag, question, { lang, mem, kn });
      store.push('audit', { action: '本地专家模板（无模型通道）', detail: ag.name + ' · ' + question.slice(0, 80), at: Date.now() });
      return { agent: ag, content: local, engine: 'local:' + ag.id };
    }
    throw new Error('无可用模型通道，请先配置密钥');
  }

  const t0 = Date.now();
  let out;
  try {
    out = await providers.chat({
      provider: providerId, model: (opts && opts.model),
      messages: [{ role: 'system', content: sys }, { role: 'user', content: question }],
      temperature: (opts && opts.depth) ? 0.3 : 0.7
    });
    brain.learnResult(providerId, true, Date.now() - t0);
  } catch (e) {
    brain.learnResult(providerId, false, Date.now() - t0);
    // 智能降级：换次优通道重试一次；重试或备份也失败时，fallback 模式走本地模板兜底
    const backup = brain.recommendedProvider(pl);
    try {
      if (backup && backup !== providerId) {
        brain.evolve('专家会诊自动降级 ' + providerId + ' -> ' + backup);
        out = await providers.chat({
          provider: backup, model: (opts && opts.model),
          messages: [{ role: 'system', content: sys }, { role: 'user', content: question }],
          temperature: 0.7
        });
        brain.learnResult(backup, true, Date.now() - t0);
      } else { throw e; }
    } catch (e2) {
      brain.learnResult(backup, false, Date.now() - t0);
      if (opts && opts.fallback) {
        const local = localAnswer(ag, question, { lang, mem, kn });
        store.push('audit', { action: '本地专家模板（通道失败降级）', detail: ag.name + ' · ' + question.slice(0, 80), at: Date.now() });
        out = { content: local, engine: 'local:' + ag.id };
      } else { throw e; }
    }
  }

  store.push('decisions', { question: '【' + ag.name + '】' + question, answer: out.content.slice(0, 420), engine: ag.name + '@' + out.engine, source: '会诊' }, '专家会诊', ag.name + ':' + question.slice(0, 60));
  store.push('audit', { action: '专家会诊', detail: ag.name + ' · ' + question.slice(0, 80), at: Date.now() });

  return { agent: ag, content: out.content, engine: out.engine };
}

// 团队会诊：多位专家并行独立作答 → 确定性合并为 分工/共识/分歧/行动
// 默认全员(6 位)或指定 ids；并行 Promise.allSettled，逐位降级，单点失败不影响其余。
async function team(question, opts) {
  const ids = (opts && opts.ids && opts.ids.length) ? opts.ids : AGENTS.map(a => a.id);
  const results = await Promise.allSettled(ids.map(id => consult(id, question, Object.assign({}, opts, { fallback: true }))));
  const ok = [], failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value && r.value.content) ok.push(r.value);
    else failed.push(ids[i]);
  });
  if (!ok.length) throw new Error('团队会诊全部失败（failed: ' + failed.join(',') + '），请检查模型通道密钥。');

  // 确定性共识引擎：抽取每个专家输出中的关键行（带指标/命令式的句子）作为"共识信号"，做去重投票。
  // 不做 LLM 拼接——降低不可控，同时保证"协作产出"真实可复现。
  const consensusLines = snip(ok);
  const actions = consensusLines.actions;
  const shared = consensusLines.shared;
  const verdict = consensusLines.verdict;

  const summary = [
    '【团队会诊 · ' + question.slice(0, 40) + '】',
    '团队: ' + ok.map(o => o.agent.name).join(' + '),
    '',
    '分工观点：',
    ...ok.map((o, i) => (i + 1) + '. [' + o.agent.name + '] ' + firstLine(o.content)),
    '',
    '共识条目（多人同样提到，按出现次数排序）：',
    shared.length ? shared.map(s => '· ' + s.text + '（' + s.n + ' 人共识）').join('\n') : '（专家各执一词，暂无明显共识，需人工仲裁）',
    '',
    '主要分歧：',
    verdict.divergence.length ? verdict.divergence.map(d => '· ' + d).join('\n') : '（无显著冲突观点）',
    '',
    '风险提示（来自风控审计视角）：',
    verdict.risks.length ? verdict.risks.map(r => '· ' + r).join('\n') : '· 未标出显著风险，仍建议落地前做小步验证。',
    '',
    '下步行动（按可执行性排序）：',
    actions.length ? actions.map((a, i) => (i + 1) + '. ' + a).join('\n') : '· 建议：先开一次 30 分钟的澄清会，把假设列全后再分工。'
  ].join('\n');

  // —— 双模型交叉验证（借鉴 Polsia：生成 → 独立第二模型找茬，双签才入库）——
  // 顺序很关键：复核必须在 store.push('decisions') **之前**跑完，否则"双签才上线"是空话
  // （历史实现先把结论入库、再复核，verify 的 ok 又恒为 true，等于纯装饰）。
  // 门禁语义：
  //   pass   → 正常入库
  //   reject → 不写入决策库，只落审计并把异议原文返回给人（人说了算，不自动丢弃）
  //   skip   → 无第二通道，未复核；照常入库但显式标注"未复核"，绝不谎称双签
  let verify = null;
  try {
    const providers = require('./providers');
    const v = await providers.verify({
      content: summary,
      brief: '团队会诊结论（' + question.slice(0, 30) + '）',
      facts: concatFacts(ok)
    });
    verify = { verdict: v.verdict, approved: v.approved, note: v.note, engine: v.engine, provider: v.provider, skipped: v.skipped || false };
  } catch (e) {
    verify = { verdict: 'skip', approved: false, note: '复核调用异常：' + String(e.message || e).slice(0, 80), skipped: true };
  }

  const rejected = verify && verify.verdict === 'reject';
  const src = '会诊' + (verify && verify.verdict === 'skip' ? '（未复核）' : rejected ? '（复核未通过）' : '（双签）');

  store.push('decisions', {
    question: '【团队会诊】' + question,
    answer: (rejected ? '⚠ 复核未通过，未作为定论入库：' + String(verify.note || '').slice(0, 120) + '\n' : '') + summary.slice(0, 600),
    engine: 'team@' + ok.map(o => o.agent.id).join('+') + (verify && verify.engine ? ' + 复核@' + verify.engine : ''),
    source: src
  }, rejected ? '团队会诊·复核未通过' : '团队会诊', question.slice(0, 60));
  store.push('audit', { action: '团队会诊', detail: question.slice(0, 60) + ' · 参与 ' + ok.map(o => o.agent.name).join('+') + ' · 复核 ' + (verify ? verify.verdict : 'skip'), at: Date.now() });
  if (verify && !verify.skipped) {
    store.push('audit', { action: '双模型交叉复核', detail: (verify.approved ? '通过' : '异议') + ' · ' + (verify.engine || '') + ' · ' + String(verify.note || '').slice(0, 120), at: Date.now() });
  }
  // 被否决的结论单独留痕（存 evidence 供人复核），不混入决策库冒充定论
  if (rejected) {
    store.push('rejectedDecisions', { question, summary: summary.slice(0, 800), critic: verify.note, engine: verify.engine, at: Date.now() }, '会诊结论被复核否决', question.slice(0, 60));
  }

  return {
    agents: ok.map(o => o.agent), members: ok.map(o => ({ id: o.agent.id, name: o.agent.name })),
    content: summary, consensus: shared, divergence: verdict.divergence, actions, risks: verdict.risks,
    engine: 'team@' + ok.map(o => o.agent.name).join('+'), failed, verify, committed: !rejected
  };
}

// 供复核员判断的事实基线：各专家结论的第一行（不暴露密钥/链接）
function concatFacts(ok) {
  try {
    return ok.map(o => (o.agent ? o.agent.name : '专家') + ': ' + firstLine(o.content)).join('\n').slice(0, 800);
  } catch (e) { return ''; }
}

function firstLine(x) { return String(x || '').split('\n')[0].slice(0, 90); }

// 确定性本地专家模板：不依赖任何模型通道，只引用真实记忆/知识，保证团队协作永不空跑。
// 每个专家一句话判断 + 一条可执行动作；数字只来自真实记忆/知识字段，绝不虚构。
function localAnswer(ag, question, ctx) {
  const q = String(question || '').trim().slice(0, 60);
  const fact = (ctx.kn && ctx.kn[0]) ? '知识参考：「' + String(ctx.kn[0].q).slice(0, 28) + '」→ ' + String(ctx.kn[0].a).slice(0, 60) : '暂无相关知识沉淀，建议先做一轮情报采集。';
  const memLine = (ctx.mem && ctx.mem[0]) ? '现状参考：' + String(ctx.mem[0].value).slice(0, 60) : '';
  const byId = {
    analyst: '先拆假设：把问题中的目标、约束、未知数分开；列出 3 个可验证的假设，每个配上可观测指标；结论必须是"数据说了什么"，不是感觉。\n识别事实：' + fact + (memLine ? '\n' + memLine : ''),
    strategist: '从半年视角排序优先级：先保命/现金流，再谈增长；把 "必须做/应该做/可缓做" 三档列清，明确放弃哪个才敢聚焦哪个。\n识别事实：' + fact,
    planner: '把目标拆成 4 周里程碑，每周一个最小交付物；本周只排 1 件事（其余全部砍掉），负责人明确到人/自己，交付标准写死。\n识别事实：' + fact,
    critic: '挑三个假设漏洞：1) 现金流假设是否过度乐观；2) 外部依赖是否未验证；3) 时间投入是否低估。任何没写止损线的计划都不能直接执行。\n识别事实：' + fact,
    grower: '先找最近的可转化场景（同卦历史决策人数最多的一条），用"一料五吃"把该场景方案转成 5 种触达形式；目标 = 本周新增 1 个真实问询并沉淀为线索。\n识别事实：' + fact,
    builder: '第一周只做三件事：把方案描述压缩成一张 A4 清单、清点依赖（谁/哪/何时就绪）、设定一次可演示的最小版本验收点；其余交给周复盘。\n识别事实：' + fact
  };
  return '【' + ag.name + ' · ' + q + '】\n' + (byId[ag.id] || byId.analyst) + '\n\n执行方式：如已联网，我可进一步用真实工具补数据后合并成最终方案。';
}

// 从各专家文本抽取：共识信号（重复出现的关键短句/数字指标）、行动句、风险句
function snip(list) {
  const phraseCount = {};
  const actionHits = [];
  const riskHits = [];
  const verdict = { divergence: [], risks: [] };
  const stop = ['分析', '建议', '对于', '根据', '结论', '首先', '此外'];
  const collect = (o) => {
    // 数字/指标句（激励"可量化"）
    const lines = String(o.content || '').split('\n').map(s => s.trim()).filter(Boolean);
    lines.forEach(line => {
      const cl = line.replace(/^[\d.、\-* ]+/, '').replace(/[。！;；]$/, '');
      if (cl.length < 8 || cl.length > 60 || stop.some(s => cl.startsWith(s))) return;
      if (/(风险|隐患|警惕|不要再|千万别|廉价|漏洞)/.test(cl)) { riskHits.push(cl); return; }
      if (/(建议|应该|必须|先|第一周|立即|排期|投入)/.test(cl)) actionHits.push(cl);
      phraseCount[cl] = (phraseCount[cl] || 0) + 1;
    });
  };
  list.forEach(collect);
  // 共识：出现 >=2 次的关键句
  const shared = Object.keys(phraseCount).filter(k => phraseCount[k] >= 2)
    .map(text => ({ text, n: phraseCount[text] }))
    .sort((a, b) => b.n - a.n).slice(0, 6);
  // 分歧：同样主题但来自不同角色的对立动作（简化：风控对"优先投入"类动作的反对句）
  const action = actionHits.slice(0, 6);
  const riskTop = riskHits.slice(0, 4);
  if (riskTop.length) verdict.risks = riskTop;
  if (action.length >= 2 && new Set(action).size < action.length) verdict.divergence.push('多名专家对行动排序意见不一（' + action.slice(0, 3).join(' vs ') + '）');
  return { shared, actions: action, verdict, risks: riskTop };
}

module.exports = { AGENTS, list, consult, team };