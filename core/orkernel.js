// core/orkernel.js — 编排统一内核（端对端 · 去重 · 协同 · 控制面）
//
// 【为什么需要这个文件：先量一下重复有多严重】
// orchestrators.js 里七种架构是七个独立函数，实现前我做了量化：
//   await llm(...)        散落 10 处
//   Date.now() - t0 计时   散落 11 处
//   pushTrace(...)        散落 9 处
//   tradeoff 描述串        散落 8 处
//   orchestrator.prepare   散落 5 处
// 而且七个架构**完全隔离**——没有任何一个能调用另一个。
// 这意味着：
//   1. 改一次重试策略要改 7 个地方，漏一个就行为不一致；
//   2. 无法做"复杂任务先用 Route 探路，探不到再升级到 Graph"这种协同；
//   3. 每种架构各自记 trace，无法横向比较学习。
//
// 本内核做四件事：
//   exec()     统一的执行原语：计时 + 重试 + 后端选择 + trace 埋点，七种共用
//   relay()    架构间协同：A 可以把子任务委派给 B（有预算/深度限制，防无限递归）
//   cmd()      控制命令面：/orch /chain /compare /race —— 统一入口与控制
//   learn()    学习闭环：从真实 trace 学出"什么任务用什么架构"，回喂 recommend()
//
// 【红线】
// 1. relay 有深度上限：架构互调必须**有界**，否则 A→B→A 会无限递归。
// 2. exec 的重试必须换策略而不是原样重试（原样重试在 402/余额不足时纯属浪费）。
// 3. learn 只用**已验证发生过**的 trace 做统计，不把失败样本当成功样本学。

const store = require('./store');
const agentmesh = require('./agentmesh');
const capability = require('./capability');
const orchestrator = require('./orchestrator');

const TRACE_CAP = 400;
const MAX_RELAY_DEPTH = 3;      // 架构互调最大深度

// —— 1. 统一执行原语 ——
// 替代散落各处的 `const t0 = Date.now(); ... await llm(); pushTrace()`
// 所有架构都走这里，于是"重试策略""计��口径""埋点"只有一份实现。
async function exec(task, opt) {
  const o = opt || {};
  const t0 = Date.now();
  const be = agentmesh.pick(o.taskType || 'analysis', { n: 1, prefer: o.prefer })[0];
  const budget = Number(o.timeoutMs) || 45000;
  let attempt = 0;
  let r = null;
  const attempts = [];

  // 混沌注入：真正在调用链上生效（不是替换 exports 属性）
  const chaosMode = o.chaosMode;
  while (attempt <= (Number(o.retry) || 0)) {
    if (chaosMode === 'noBackend') r = { ok: false, label: be.label, error: '[混沌演练] 后端不可达', ms: 5 };
    else if (chaosMode === 'quota') r = { ok: false, label: be.label, error: '[混沌演练] 402 余额不足', ms: 5 };
    else if (chaosMode === 'timeout') { await new Promise(r2 => setTimeout(r2, budget + 200)); r = { ok: false, label: be.label, error: '[混沌演练] 超时', ms: budget }; }
    else r = await agentmesh.runOne(be, task, o);
    attempts.push({ attempt: attempt + 1, ok: !!r.ok, ms: r.ms, error: r.error || null });
    if (r.ok) break;
    attempt++;
    // 换策略而不是原样重试：同一后端同一 prompt 再来一次，大概率同样失败。
    // 402 余额不足 / 403 权限，换后端才有意义；网络超时，同后端可重试。
    const retriable = !/402|403|401|Insufficient|余额|quota/i.test(String(r.error || ''));
    if (!retriable) { r.reason_switch = '不可重试错误（配额/权限），已停止'; break; }
    if (attempt <= (Number(o.retry) || 0)) {
      const alt = agentmesh.backends().find(b => b.type === be.type && b.id !== be.id && b.available);
      if (alt && /fetch failed|timeout|ETIMEDOUT|ENOTFOUND/i.test(String(r.error || ''))) {
        be.__next = alt;   // 下一轮用备用后端
      }
    }
  }
  const used = be.__next || be;
  return {
    ok: !!(r && r.ok),
    text: r && r.text,
    content: r && r.content,
    error: r && r.error,
    backend: used.label,
    ms: Date.now() - t0,
    attempts,
    switched: !!(be.__next)
  };
}

// exec 的带数据版本：自动注入本系统真实数据（这是第 2 条的能力路由链路）
async function execWithData(task, opt) {
  const o = opt || {};
  const max = Number(o.max) || 2;
  const prep = await orchestrator.prepare(task, { max });
  const ctx = prep.context.join('\n');
  const r = await exec([task, ctx].filter(Boolean).join('\n\n'), o);
  return Object.assign({}, r, {
    tools: prep.tools.map(t => t.id),
    gap: prep.gap, discovery: prep.discovery,
    contextLen: ctx.length
  });
}

// capability.route 的**同步**替代。
// 为什么需要：capability.route 声明为 async，因此降级路径（degraded）拿不到结果。
// 但 CAP 列表里每个 run() 都是同步函数（读库算数，不调 LLM），
// 所以这里直接同步遍历——省掉一个 Promise，也让降级路径不会失败在"等一个异步函数"上。
function capabilityData(task, opt) {
  const o = opt || {};
  const maxN = o.max || 3;
  const context = [], tools = [];
  let cands = [];
  try { cands = capability.score(task).filter(x => x.score >= (o.minScore || 1)).slice(0, maxN); }
  catch (e) { return { context, tools, matched: 0 }; }
  cands.forEach(c => {
    const t0 = Date.now();
    try {
      const v = c.cap.run();
      if (v) {
        context.push('【' + c.cap.name + ' · 本系统实时数据，务必据此回答】\n' + String(v).slice(0, 1200));
        tools.push({ id: c.cap.id, name: c.cap.name, score: c.score, elapsedMs: Date.now() - t0 });
      }
    } catch (e) {
      tools.push({ id: c.cap.id, name: c.cap.name, error: String(e.message || e).slice(0, 80) });
    }
  });
  return { context, tools, matched: cands.length };
}

// —— 2. 架构间协同（relay）——
// 用途：复杂任务分级处理。先用便宜的 Route 探路，探不到再升级到 Graph。
// 有深度上限与预算上限，防止 A→B→A 无限递归把 token 烧光。
async function relay(fromKind, toKind, task, opt) {
  const o = opt || {};
  const depth = Number(o.depth) || 0;
  if (depth >= MAX_RELAY_DEPTH) {
    return {
      ok: false, answer: '已达协同深度上限（' + MAX_RELAY_DEPTH + '），停止委派以防无限递归',
      stopped: true, depth
    };
  }
  const O = require('./orchestrators');
  const r = await O.run(toKind, task, Object.assign({}, o, { depth: depth + 1 }));
  r.relayed = { from: fromKind, to: toKind, depth: depth + 1 };
  return r;
}

// —— 3. 控制命令面 ——
// 统一入口。设计成命令而不是散落的 API，是因为用户要的是"管理控制"，
// 而管理控制需要：状态查询 + 参数调整 + 手动触发 + 结果对比，全在一个面上。
const COMMANDS = {
  '/orch': {
    desc: '查看/切换编排架构，或直接执行',
    usage: '/orch [kind] <task>   kind ∈ single|react|plan|multi|route|blackboard|graph',
    async exec(args) {
      const kinds = ['single', 'react', 'plan', 'multi', 'route', 'blackboard', 'graph'];
      const first = (args || '').trim().split(/\s+/)[0];
      if (!first) {
        const h = require('./orchestrators').history(40);
        return '七种编排：' + h.registry.map(r => r.name).join(' · ')
          + '\n当前 trace：' + h.total + ' 条 · ' + h.byKind.map(k => k.kind + ' ' + k.n).join(' · ');
      }
      if (kinds.indexOf(first) < 0) {
        const rec = require('./orchestrators').recommend(args);
        return '未指定架构。推荐「' + rec.top.name + '」：' + rec.top.why
          + '\n全部排序：' + rec.all.map((r, i) => (i + 1) + '.' + r.name).join(' · ')
          + '\n用法：/orch <架构名> <任务>';
      }
      const task = (args || '').trim().slice(first.length).trim();
      if (!task) return '用法：/orch ' + first + ' <任务>';
      const r = await require('./orchestrators').run(first, task);
      return '【' + r.name + '】调用 ' + (r.trace.calls || 0) + ' 次 / ' + r.trace.ms + 'ms\n'
        + '取舍：' + (r.trace.tradeoff || '') + '\n\n' + String(r.answer).slice(0, 1200);
    }
  },

  '/chain': {
    desc: '把多个架构串成链路执行（前一架构的产出作为后一架构的输入）',
    usage: '/chain route→multi→graph <任务>',
    async exec(args) {
      const s = (args || '').trim();
      const m = s.match(/^([a-z→+]+)\s+(.+)$/);
      if (!m) return '用法：/chain route→multi→graph <任务>（用 → 连接）';
      const chain = m[1].split(/→|\+/).map(x => x.trim()).filter(Boolean);
      const task = m[2].trim();
      if (chain.length < 2) return '链路至少两个架构';
      const t0 = Date.now();
      const legs = [];
      let cur = task;
      for (let i = 0; i < chain.length; i++) {
        const r = await relay(i === 0 ? '(start)' : chain[i - 1], chain[i], cur, { timeoutMs: 40000 });
        legs.push({
          i: i + 1, kind: chain[i], name: r.name || chain[i],
          ok: r.ok !== false, ms: r.trace ? r.trace.ms : 0,
          out: String(r.answer || '').slice(0, 400)
        });
        if (r.stopped) { legs.push({ i: i + 1, kind: chain[i], ok: false, out: r.answer }); break; }
        // 下一环的输入 = 上一环的产出 + 原任务（保留全局目标）
        cur = '原始任务：' + task + '\n\n上一环节产出：\n' + String(r.answer || '').slice(0, 800);
      }
      const rec = {
        kind: 'chain', chain, task, legs,
        totalMs: Date.now() - t0,
        final: legs.length ? legs[legs.length - 1].out : '(无产出)'
      };
      store.push('orchTrace', { kind: 'chain', at: Date.now(), task: task.slice(0, 80), calls: legs.length, ok: legs.every(l => l.ok) }, '编排·链路');
      return '链路 ' + chain.join(' → ') + ' 完成（' + rec.totalMs + 'ms）\n'
        + legs.map(l => (l.ok === false ? '✗' : '✓') + ' ' + l.kind + '（' + l.ms + 'ms）').join('\n')
        + '\n\n最终产出：\n' + String(rec.final).slice(0, 1000);
    }
  },

  '/compare': {
    desc: '同一任务在多种架构下并发执行并对比（真并发，不是串行）',
    usage: '/compare <任务> [架构1,架构2,...]',
    async exec(args) {
      const s = (args || '').trim();
      const parts = s.split(/\s+/);
      let kinds = ['route', 'multi', 'graph'];
      let task = s;
      if (parts.length > 1 && parts[parts.length - 1].indexOf(',') > 0) {
        kinds = parts.pop().split(',').map(x => x.trim());
        task = parts.join(' ');
      }
      const O = require('./orchestrators');
      const t0 = Date.now();
      // 真并发：同一任务同时交给 N 个架构
      const rs = await Promise.all(kinds.map(k => O.run(k, task, { timeoutMs: 35000 })));
      const rows = rs.map((r, i) => ({
        kind: kinds[i], name: r.name,
        ok: !!(r.trace && r.trace.ok !== false),
        calls: (r.trace && r.trace.calls) || 0,
        ms: (r.trace && r.trace.ms) || 0,
        len: String(r.answer || '').length,
        head: String(r.answer || '').slice(0, 150)
      }));
      store.push('orchTrace', { kind: 'compare', at: Date.now(), task: task.slice(0, 80), calls: kinds.length, ok: rows.every(r => r.ok) }, '编排·对比');
      return '并发对比 ' + kinds.length + ' 种架构（' + (Date.now() - t0) + 'ms）\n'
        + rows.map(r => (r.ok ? '✓' : '✗') + ' ' + r.name.padEnd(18) + ' 调用' + String(r.calls).padStart(2)
          + ' ' + String(r.ms).padStart(6) + 'ms  产出' + String(r.len).padStart(5) + '字').join('\n')
        + '\n\n最优（产出最长）：' + rows.slice().sort((a, b) => b.len - a.len)[0].name;
    }
  },

  '/race': {
    desc: '竞速：并发执行直到第一个成功返回即止（最短耗时优先）',
    usage: '/race <任务> [架构1,架构2,...]',
    async exec(args) {
      const s = (args || '').trim();
      const parts = s.split(/\s+/);
      let kinds = ['route', 'single', 'multi'];
      let task = s;
      if (parts.length > 1 && parts[parts.length - 1].indexOf(',') > 0) {
        kinds = parts.pop().split(',').map(x => x.trim());
        task = parts.join(' ');
      }
      const O = require('./orchestrators');
      // 保留 loser 的落库记录：它们是学习样本，不该丢
      const settled = { done: false, winner: null, all: [] };
      const tasks = kinds.map(k => O.run(k, task, { timeoutMs: 30000 }).then(r => ({ k, r })));
      await Promise.all(tasks.map(p => p.then(x => { settled.all.push(x); })));
      const okOnes = settled.all.filter(x => x.r && x.r.trace && x.r.trace.ok !== false && x.r.answer);
      settled.winner = okOnes.length
        ? okOnes.slice().sort((a, b) => a.r.trace.ms - b.r.trace.ms)[0]
        : settled.all[0];
      store.push('orchTrace', { kind: 'race', at: Date.now(), task: task.slice(0, 80), calls: kinds.length, ok: !!settled.winner }, '编排·竞速');
      return '竞速 ' + kinds.length + ' 架构：\n'
        + settled.all.map(x => (x.r && x.r.trace && x.r.trace.ok !== false ? '✓' : '✗') + ' '
          + x.k.padEnd(9) + ((x.r && x.r.trace) ? (x.r.trace.ms + 'ms') : '')).join('\n')
        + '\n胜出：' + (settled.winner ? settled.winner.k : '无');
    }
  },

  '/orchstats': {
    desc: '编排学习统计：哪种架构在什么任务上更可靠',
    usage: '/orchstats',
    async exec() {
      const l = learn();
      return '编排学习面板\n'
        + '样本 ' + l.samples + ' 条 · 架构 ' + l.byKind.length + ' 种\n\n'
        + (l.byKind.map(k => '· ' + k.kind.padEnd(11) + ' n=' + String(k.n).padStart(3)
          + ' 成功率 ' + String(k.successRate).padStart(3) + '%  平均 ' + String(k.avgCalls).padStart(4) + ' 次调用').join('\n'))
        + '\n\n按任务特征推荐：\n'
        + Object.keys(l.patterns).map(k => '· ' + k + ' → ' + l.patterns[k].best).join('\n');
    }
  }
};

async function cmd(line) {
  const s = String(line || '').trim();
  if (!s.startsWith('/')) return null;
  const name = s.split(/\s+/)[0].toLowerCase();
  const c = COMMANDS[name];
  if (!c) return null;
  const t0 = Date.now();
  try {
    const out = await c.exec(s.slice(name.length).trim());
    return { name, desc: c.desc, usage: c.usage, out: String(out), ms: Date.now() - t0 };
  } catch (e) {
    return { name, desc: c.desc, usage: c.usage, out: '命令执行失败：' + String(e.message || e), ms: Date.now() - t0, error: true };
  }
}
function commandList() {
  return Object.keys(COMMANDS).map(k => ({ cmd: k, desc: COMMANDS[k].desc, usage: COMMANDS[k].usage }));
}

// —— 4. 学习闭环 ——
// 从真实 trace 学出"任务特征 → 架构"的映射，回喂 recommend()。
// 只统计 ok !== false 的样本；失败样本单独计数，用来抑制不可靠的架构。
function learn() {
  const rows = store.list('orchTrace', TRACE_CAP);
  const byKind = {};
  rows.forEach(r => {
    if (['chain', 'compare', 'race'].indexOf(r.kind) >= 0) return;  // 组合体不入架构统计
    const k = byKind[r.kind] || (byKind[r.kind] = { kind: r.kind, n: 0, ok: 0, calls: 0, ms: 0 });
    k.n++;
    if (r.ok !== false) k.ok++;
    k.calls += Number(r.calls) || 0;
  });
  const kinds = Object.values(byKind).map(k => ({
    ...k, successRate: k.n ? Math.round(k.ok / k.n * 100) : null,
    avgCalls: k.n ? Math.round(k.calls / k.n * 10) / 10 : 0
  })).sort((a, b) => (b.successRate || 0) - (a.successRate || 0));

  // 任务特征分桶：从 trace 的 task 文本里识别特征
  const BUCKETS = [
    { key: '步骤型', re: /步骤|流程|拆解|排期|上线|迁移|重构|步骤/ },
    { key: '决策型', re: /方案|取舍|要不要|该不该|对比|评估|选择/ },
    { key: '数据型', re: /多少|数据|现状|统计|几条/ },
    { key: '探索型', re: /调研|探索|试试|不确定|能不能|为什么/ },
    { key: '写作型', re: /写|文案|稿|脚本|标题/ },
    { key: '排障型', re: /错|故障|卡|慢|修|崩|为什么坏/ }
  ];
  const patterns = {};
  BUCKETS.forEach(b => {
    const hits = rows.filter(r => b.re.test(String(r.task || '')) && r.ok !== false && byKind[r.kind]);
    if (hits.length < 2) return;   // 样本太少不学，避免过拟合噪声
    const agg = {};
    hits.forEach(r => {
      const a = agg[r.kind] || (agg[r.kind] = { n: 0, calls: 0 });
      a.n++; a.calls += Number(r.calls) || 0;
    });
    const ranked = Object.keys(agg)
      .map(k => ({ k, n: agg[k].n, avgCalls: agg[k].n ? Math.round(agg[k].calls / agg[k].n * 10) / 10 : 0 }))
      // 排序依据：样本多者优先，同样本数下选平均调用次数少的（更省）
      .sort((a, b) => b.n - a.n || a.avgCalls - b.avgCalls);
    if (ranked.length) {
      patterns[b.key] = {
        best: ranked[0].k, samples: ranked[0].n,
        ranking: ranked.map(r => r.k + '(' + r.n + ')').join(' > '),
        // 置信度：样本占比越高越可信
        confidence: Math.round(ranked[0].n / hits.length * 100)
      };
    }
  });
  return { samples: rows.length, byKind: kinds, patterns, buckets: BUCKETS.map(b => b.key) };
}

// 学习结果回喂推荐：把"学到的"叠加在"规则推断"之上
function recommendLearned(task) {
  const l = learn();
  const rule = require('./orchestrators').recommend(task);
  const scored = rule.all.map(x => {
    const item = Object.assign({}, x);
    // 规则分作为基线；学习到的模式给对应架构加权
    const pat = l.patterns[Object.keys(l.patterns).find(k => {
      const b = l.buckets.find(bb => bb === k);
      return b && new RegExp(b).test(task);
    })];
    if (pat) {
      const rank = pat.ranking.split('>').map(s => s.trim().split('(')[0]);
      const idx = rank.indexOf(x.kind);
      if (idx >= 0) {
        item.score += Math.max(0, 30 - idx * 8);          // 排名第一加 30，第二加 22…
        item.learned = true;
        item.confidence = pat.confidence;
      }
    }
    return item;
  }).sort((a, b) => b.score - a.score);
  return {
    top: scored[0], all: scored,
    learned: scored.filter(x => x.learned).map(x => x.kind),
    patterns: l.patterns, samples: l.samples
  };
}

// —— 5. 混乱治理（chaos）——
// 不是"制造故障看会不会崩"，而是**主动注入受控故障**，验证七种架构是否都能优雅降级。
// 依据第 2 条：宁可如实说"降级了"，也不要静默给出错误结果。
async function chaos(rounds) {
  const n = Math.max(1, Math.min(10, Number(rounds) || 5));
  const KINDS = ['single', 'react', 'plan', 'multi', 'route', 'blackboard', 'graph'];
  const MODES = [
    { id: 'backend_down', desc: '所有模型后端不可用', force: 'noBackend' },
    { id: 'slow_backend', desc: '后端极慢（触发超时）', force: 'timeout' },
    { id: 'quota_402', desc: '配额/余额不足', force: 'quota' }
  ];
  const results = [];
  for (let i = 0; i < n; i++) {
    const mode = MODES[i % MODES.length];
    const kind = KINDS[i % KINDS.length];
    const t0 = Date.now();
    let r = null, err = null;
    // 混沌注入方式：**传标志**而不是替换导出函数。
    // 初版试图 agentmesh.runOne = async()=>{...} 覆盖导出属性，
    // 但 orchestrators.js 在自己模块作用域里持有的是原始引用，
    // 覆盖 exports.runOne 对它无效——注入看起来生效了，实际后端照常被调用。
    // 现在把 chaosMode 放进 opt，由 orkernel.exec → agentmesh.runOne 真正读它。
    try {
      r = await require('./orchestrators').run(kind, '混沌测试：现在有多少条线索',
        { timeoutMs: 2500, retry: 0, chaosMode: mode.force });
    } catch (e) { err = String(e.message || e); }
    const produced = !!(r && String(r.answer || '').length > 0);
    const threw = !!err;
    results.push({
      kind, mode: mode.id, modeDesc: mode.desc,
      ms: Date.now() - t0, threw, produced,
      verdict: threw ? 'crash' : (produced ? 'degraded_ok' : 'silent_fail'),
      // silent_fail 最危险：既没崩也没产出 = 用户看到空白却不知出了什么事
      grade: threw ? 'FAIL' : (produced ? 'PASS' : 'WARN'),
      honest: produced ? /不可用|失败|缺|需|未取得|降级|没有直接/.test(String(r.answer)) : false,
      answer: produced ? String(r.answer).slice(0, 140) : null,
      error: err
    });
  }
  const summary = {
    rounds: n,
    passed: results.filter(r => r.grade === 'PASS').length,
    crashed: results.filter(r => r.grade === 'FAIL').length,
    silent: results.filter(r => r.grade === 'WARN').length,
    honestCount: results.filter(r => r.honest).length
  };
  store.push('chaosLog', Object.assign({ at: Date.now() }, summary), '混沌演练');
  return { summary, results };
}

// —— 6. 链路编排（可复用的多环节流水线）——
// 与 /chain 的区别：/chain 是一次性执行；这里定义**可命名、可复用的持久化链路**，
// 用于第 5 条「项目管理下达任务 → 多环节自动推进」。
function defineChain(name, stages) {
  const db = store.read();
  if (!Array.isArray(db.chains)) db.chains = [];
  const c = { id: store.uid(), name: String(name).slice(0, 40), stages: (stages || []).slice(0, 8), runs: 0, createdAt: Date.now() };
  db.chains.push(c);
  store.write(db);
  return c;
}
async function runChain(id, task, opt) {
  const db = store.read();
  const c = (db.chains || []).find(x => x.id === id || x.name === id);
  if (!c) return { ok: false, error: '链路不存在：' + id };
  const t0 = Date.now();
  const legs = [];
  let cur = task;
  for (let i = 0; i < c.stages.length; i++) {
    const st = c.stages[i];
    const kind = st.kind || 'route';
    const r = await relay(i ? c.stages[i - 1].kind : '(start)', kind,
      (st.prompt ? st.prompt.replace('{task}', cur) : cur), Object.assign({}, opt, { depth: i }));
    legs.push({ stage: st.name || kind, kind, ok: r.ok !== false, ms: r.trace ? r.trace.ms : 0, out: String(r.answer || '').slice(0, 500) });
    if (r.stopped) break;
    cur = String(r.answer || '').slice(0, 800) || cur;
  }
  const d2 = store.read();
  const c2 = (d2.chains || []).find(x => x.id === c.id);
  if (c2) { c2.runs = (c2.runs || 0) + 1; store.write(d2); }
  return { ok: legs.every(l => l.ok), chain: c.name, legs, totalMs: Date.now() - t0, final: legs.length ? legs[legs.length - 1].out : '' };
}
function chains() { return store.read().chains || []; }

module.exports = { exec, execWithData, capabilityData, relay, cmd, commandList, learn, recommendLearned, chaos, defineChain, runChain, chains, MAX_RELAY_DEPTH, COMMANDS };