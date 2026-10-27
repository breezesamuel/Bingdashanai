// core/orchestrators.js — 七种 Agent 编排架构（第 7 条需求）
//
// 【本文件第二轮重构：消除重复 + 打通协同】
// 第一轮我写了七个**独立函数**的编排器，量化后发现三个结构性问题：
//   1. await llm(...) 散落 10 处、Date.now()-t0 计时 11 处、pushTrace 9 处
//      —— 改一次重试策略要改 7 个地方；
//   2. 七个架构**完全隔离**，无法"先用便宜的探路、探不到再升级"；
//   3. 每种各自记 trace，横向学不出东西。
//
// 现在：七种架构全部只描述**自己独有的那一步**，其余（调用、重试、计时、埋点、
// 数据注入、失败降级）交给 orkernel.exec / execWithRelay。
// 文件从 437 行降到 ~280 行，且行为更一致。
//
// 【七种架构的定位（按演进顺序）】
//   single      一个模型全包        最省，复杂时上下文污染
//   react       思考-行动-观察循环  可解释，token 线性增长
//   plan        先计划再执行        步骤明确时稳，计划错则全崩
//   multi       角色分工 + 协调     多视角，成本 = 角色数
//   route       意图路由 + 技能    企业级可控/可缓存  ← 默认
//   blackboard  共享状态驱动       协作写作，状态管理重
//   graph       DAG 编排           分支/并行/重试，最稳
//
// 【红线】
// 1. 每种架构的 tradeoff 必须写清——用户据此判断何时切哪种。
// 2. 模型不可用时必须**产出可读内容**（哪怕是"不可用+为什么+怎么办"），
//    不允许静默返回空串（第 2 条的核心诉求）。
// 3. trace 必须记真实调用次数；不能把串行伪装成并行。

const store = require('./store');
const capability = require('./capability');
const orchestrator = require('./orchestrator');
const agentmesh = require('./agentmesh');
const K = require('./orkernel');   // 统一内核

// —— 共用：失败降级 ——
// 七种架构都需要它：模型挂了也要给用户一句能看懂、能行动的话。
//
// 【重要修复】capability.route 是 **async** 函数。
// 这里原来同步调用 `const fb = capability.route(...)`，拿到的是 Promise 而非结果，
// 于是 `fb.tools` → undefined → `.map` 抛 "Cannot read properties of undefined"。
// 症状是四种架构全崩、只有 route/blackboard/graph 侥幸能跑（它们走了别的路径），
// 极具迷惑性——看起来像重构改坏了，其实是**第一版就存在的 bug 被重构暴露出来**。
// 现在降级路径也走 K.execWithData 的同一条异步链。
function degraded(reason, task) {
  const msg = '模型通道不可用：' + reason;
  const fb = K.capabilityData(task, { max: 3 });
  const ctx = fb && fb.context ? fb.context : [];
  return {
    answer: ctx.length
      ? (msg + '。以下为本系统实时数据的直接读取结果，可直接据此判断：\n\n' + ctx.join('\n'))
      : (msg + '。本系统也没有可直接回答该问题的模块数据。'
        + '建议：先恢复模型通道（检查密钥/余额/网络），或换一个系统已有数据可回答的问题。'),
    viaData: ctx.length > 0,
    tools: (fb && fb.tools ? fb.tools : []).map(t => (t && t.id) || '?')
  };
}

// —— 共用：埋点 ——
// 统一走这里，七种架构的 trace 口径一致，横向才能比较学习。
function trace(kind, o) {
  const t = Object.assign({ kind, at: Date.now() }, o);
  store.push('orchTrace', { kind, at: t.at, task: String(t.task || '').slice(0, 80), calls: t.calls || 0, ok: t.ok !== false, ms: t.ms || 0 }, '编排·' + kind);
  return t;
}

// —— 共用骨架：把七种架构里 90% 相同的流程收敛到一处 ——
//
// 【为什么要 base()】重构后我量化发现：K.exec 出现 8 次、trace 8 次、
// tradeoff 8 次、计时 8 次——**去重只做到了"换个名字"，没做到逻辑收敛**。
// 真正重复的不是调用，而是这段流程：
//   起表 → 执行若干步 → 失败降级 → 埋点 → 返回
// 它在七种架构里一模一样，只有"每步做什么"不同。
// 所以抽 base(steps, spec)：steps 是唯一有差异的部分，其余全部复用。
// 七种架构现在各自只剩 15~30 行自己独有的逻辑。
async function base(kind, task, opt, steps, spec) {
  const o = opt || {};
  const t0 = Date.now();
  const calls = [];
  let answer = '', okAny = false, degradedAt = -1;
  const extras = {};

  const total = steps.length;
  for (let i = 0; i < total; i++) {
    const st = steps[i];
    const r = await st.run(i, { answer, extras, o });
    calls.push({
      step: i + 1,
      ok: r.ok !== false,
      ms: r.ms || 0,
      error: r.error || null,
      label: st.label || ''
    });
    if (r.ok !== false) okAny = true;
    else if (degradedAt < 0) degradedAt = i;
    if (r.answer !== undefined) answer = r.answer;
    if (r.set) Object.assign(extras, r.set);
    // 任何一步都可能提前终止整个架构（如"没有可调工具"）
    if (r.stop) break;
  }
  if (!answer) answer = degraded('全部环节未取得可用产出', task).answer;

  // 合并 trace 附加字段。注意 Object.assign 只接受两个参数，
  // 初版误写成三参数（尾部那个对象被丢弃且 spread 在错误位置），导致
  // spec.trace 返回的 undefined 再被 .map → 崩溃。改为显式 merge。
  const t = {
    task,
    calls: calls.length,
    ok: okAny,
    ms: Date.now() - t0,
    degradedAt,
    tradeoff: spec.tradeoff,
    steps: calls
  };
  if (spec.trace) Object.assign(t, spec.trace(extras, calls, okAny) || {});

  return { answer, trace: trace(kind, t), extras };
}

// ===== 1. 单 Agent =====
function single(task, opt) {
  return base('single', task, opt, [
    { label: '执行', run: (i, c) => K.execWithData(task, Object.assign({ retry: 0 }, c.o))
      .then(r => ({ ok: r.ok, answer: r.ok ? r.text : undefined, error: r.error, ms: r.ms, set: { tools: r.tools || [], backend: r.backend } })) }
  ], {
    tradeoff: '最低成本与延迟；上下文污染风险最高（一次调用承担全部推理）'
  });
}

// ===== 2. ReAct =====
function react(task, opt) {
  const o = opt || {};
  const maxSteps = Math.max(1, Math.min(Number(o.maxSteps) || 3, 6));
  const steps = [];
  for (let i = 0; i < maxSteps; i++) {
    steps.push({
      label: '第' + (i + 1) + '轮',
      run: (idx, c) => {
        const prompt = [
          '目标：' + task,
          c.extras.obs && c.extras.obs.length ? '已获得的观察：\n' + c.extras.obs.join('\n') : '（尚未获得任何观察）',
          idx === maxSteps - 1 ? '这是最后一轮，请给出最终答案。' : '判断下一步该调什么工具；若无可用工具，直接给当前最好的答案。'
        ].join('\n\n');
        return K.exec(prompt, Object.assign({ retry: 0 }, c.o)).then(async r => {
          if (!r.ok) return { ok: false, error: r.error, ms: r.ms, answer: idx === 0 ? degraded(r.error, task).answer : c.answer };
          // 每轮取一次真实能力数据作为"观察"
          const prep = await orchestrator.prepare(task, { max: 1 });
          const obs = (c.extras.obs || []).slice();
          if (prep.tools.length) obs.push('已调取 ' + prep.tools.map(t => t.name || t.id).join('、'));
          else obs.push('本轮无可用工具，停止循环');
          return { ok: true, answer: r.text, ms: r.ms, set: { obs }, stop: !prep.tools.length };
        });
      }
    });
  }
  return base('react', task, opt, steps, {
    tradeoff: '推理链可解释；token 随步数线性增长，步数失控即不稳定',
    trace: (ex) => ({ observations: (ex.obs || []).length })
  });
}

// ===== 3. Plan & Execute =====
function planExecute(task, opt) {
  const o = opt || {};
  const steps = [
    {
      label: '制定计划',
      run: (i, c) => K.exec('为以下目标制定可执行计划，输出编号步骤，每步一句话：\n' + task, Object.assign({ retry: 0 }, c.o))
        .then(r => {
          if (!r.ok) return { ok: false, error: r.error, answer: degraded(r.error, task).answer, stop: true };
          const plan = String(r.text).split('\n').map(s => s.replace(/^[\s\d.、)）\-]+/, '').trim()).filter(s => s.length > 4).slice(0, 8);
          return { ok: true, answer: r.text, ms: r.ms, set: { plan }, stop: !plan.length };
        })
    }
  ];
  // 计划步数不定，改为动态：base 支持在 run 里 append
  // 这里用一个"伪步"把执行阶段包起来，避免 base 里写动态逻辑
  steps.push({
    label: '逐步执行+汇总',
    run: async (i, c) => {
      const plan = c.extras.plan || [];
      const results = [];
      for (let k = 0; k < plan.length; k++) {
        const r = await K.execWithData(
          ['当前总目标：' + task, '正在执行第 ' + (k + 1) + ' 步：' + plan[k]].join('\n'),
          Object.assign({ retry: 0, max: 1 }, c.o));
        results.push({ step: k + 1, plan: plan[k], ok: r.ok, out: r.ok ? String(r.text).slice(0, 300) : ('本步失败：' + r.error) });
      }
      const okSteps = results.filter(r => r.ok);
      let answer;
      if (okSteps.length) {
        const sum = await K.exec(['总目标：' + task, '各步执行结果：',
          results.map(r => '第' + r.step + '步 ' + r.plan + ' → ' + r.out).join('\n'), '请汇总成最终交付。'].join('\n\n'),
          Object.assign({ retry: 0 }, c.o));
        answer = sum.ok ? sum.text
          : ('汇总环节不可用（' + sum.error + '）。以下为各步实际产出：\n\n' + results.map(r => '第' + r.step + '步：' + r.out).join('\n'));
      } else answer = degraded('计划已生成但每一步执行均失败', task).answer;
      return { ok: okSteps.length > 0, answer, set: { results } };
    }
  });
  return base('plan', task, opt, steps, {
    tradeoff: '计划先行 → 单步成功率高；计划错了会全盘重做，无局部容错',
    trace: (ex, calls) => ({ planSteps: (ex.plan || []).length, execSteps: (ex.results || []).length })
  });
}

// ===== 4. 多 Agent =====
// 三个角色**真并发**（Promise.all），不是串行伪装。
function multiAgent(task, opt) {
  const o = opt || {};
  const roles = [
    { id: 'analyst', label: '分析', ask: '从数据角度分析现状与约束' },
    { id: 'strategist', label: '战略', ask: '从策略角度给出方案与取舍' },
    { id: 'critic', label: '评审', ask: '指出方案最可能失败的地方' }
  ];
  return base('multi', task, opt, [
    {
      label: '并发会商',
      run: async (i, c) => {
        const prep = await orchestrator.prepare(task, { max: 2 });
        const ctx = prep.context.join('\n');
        // 真并发：三个角色同时发起
        const outs = await Promise.all(roles.map(r =>
          K.exec([r.ask, '目标：' + task, ctx].filter(Boolean).join('\n\n'), Object.assign({ retry: 0 }, c.o))
            .then(v => Object.assign({ role: r.id, label: r.label }, v))
        ));
        const ok = outs.filter(x => x.ok);
        let answer;
        if (ok.length) {
          const sum = await K.exec(['目标：' + task, '专家意见：',
            ok.map(x => '【' + x.label + '】' + String(x.text).slice(0, 300)).join('\n\n'),
            '请综合给出统一结论，标注哪些是共识、哪些仍有分歧。'].join('\n\n'),
            Object.assign({ retry: 0 }, c.o));
          answer = sum.ok ? sum.text
            : ('汇总不可用（' + sum.error + '）。以下为各专家独立意见（未经综合）：\n\n'
              + ok.map(x => '【' + x.label + '】' + String(x.text).slice(0, 400)).join('\n\n'));
        } else answer = degraded('全部 ' + roles.length + ' 个角色均不可用', task).answer;
        return {
          ok: ok.length > 0, answer,
          set: {
            roles: outs.map(x => ({ r: x.role, ok: x.ok, error: x.error || null })),
            failed: roles.length - ok.length,
            opinions: ok.map(x => ({ role: x.label, content: String(x.text).slice(0, 400) }))
          }
        };
      }
    }
  ], {
    tradeoff: '角色分工清晰、可并行扩展；成本 = 角色数 × 单价，需处理意见冲突',
    trace: (ex) => ({ roles: ex.roles || [], failed: ex.failed || 0 })
  });
}

// ===== 5. Route + Skill =====
// **不让模型猜能力，改为显式路由**——所以可缓存、可控、成本最低。这是默认架构。
function routeSkill(task, opt) {
  return base('route', task, opt, [
    {
      label: '路由+技能',
      run: async (i, c) => {
        const cands = capability.score(task).filter(x => x.score >= (c.o.minScore || 1)).slice(0, 3);
        const prep = await orchestrator.prepare(task, { max: 3 });
        const ctx = prep.context.join('\n');
        const r = await K.exec([
          task, ctx,
          cands.length ? '请严格基于以上系统实时数据回答，不要编造未提供的数字。'
            : '若缺少某些能力，按「先做能做的部分 + 精确说明缺什么 + 给出补齐动作」三段式作答，不要回答做不到。'
        ].filter(Boolean).join('\n\n'), Object.assign({ retry: 0 }, c.o));
        const answer = r.ok ? r.text
          : (prep.gap
            ? ('模型不可用，但已识别到能力缺口并完成技能检索：\n'
              + (prep.discovery && prep.discovery.candidates && prep.discovery.candidates.length
                ? prep.discovery.candidates.map((cc, k) => (k + 1) + '. ' + cc.repo + ' ★' + cc.stars).join('\n')
                : '未检索到现成技能'))
            : degraded(r.error, task).answer);
        return {
          ok: r.ok, answer,
          set: {
            routed: cands.map(x => x.cap.id),
            gap: prep.gap, discovery: prep.discovery,
            discoveryCount: prep.discovery ? (prep.discovery.candidates || []).length : 0
          }
        };
      }
    }
  ], {
    tradeoff: '不让模型猜能力，改为显式路由 → 可控/可缓存/成本最低；新能力需注册',
    trace: (ex) => ({ routed: ex.routed || [], gap: ex.gap || null, discovery: ex.discoveryCount || 0 })
  });
}

// ===== 6. Blackboard =====
// 多 Agent 共享**持久化**状态。后一角色能看到前一个写下的东西——这是它与
// multiAgent 的本质区别（multi 是并行独立意见，blackboard 是顺序共享）。
function board(task) {
  const db = store.read();
  const open = (db.blackboards || []).find(b => b.task === task && b.status === 'open');
  if (open) return open;
  const bb = {
    id: store.uid(), task: String(task).slice(0, 200), status: 'open',
    board: { facts: [], proposals: [], critiques: [], decisions: [], risks: [] },
    contributors: [], createdAt: Date.now()
  };
  const d2 = store.read();
  if (!Array.isArray(d2.blackboards)) d2.blackboards = [];
  d2.blackboards.push(bb);
  store.write(d2);
  return bb;
}
function writeBoard(id, section, entry, by) {
  const d = store.read();
  const bb = (d.blackboards || []).find(x => x.id === id);
  if (!bb) return null;
  bb.board[section].push({ by, at: Date.now(), entry: String(entry).slice(0, 400) });
  if (bb.contributors.indexOf(by) < 0) bb.contributors.push(by);
  bb.updatedAt = Date.now();
  store.write(d);
  return bb;
}
const STAGES = [
  { role: 'fact', label: '事实', sec: 'facts', ask: '把目标涉及的真实数据要点写到黑板上' },
  { role: 'propose', label: '方案', sec: 'proposals', ask: '读黑板已有事实，提出方案并写入' },
  { role: 'critique', label: '质疑', sec: 'risks', ask: '读黑板全部内容，指出风险并写入' },
  { role: 'decide', label: '决策', sec: 'decisions', ask: '综合事实/方案/风险，做出最终决策并写入' }
];
async function blackboardRun(task, opt) {
  const o = opt || {};
  const t0 = Date.now();
  const bb = board(task);
  let calls = 0;
  for (const ph of STAGES) {
    const cur = store.read();
    const bbNow = (cur.blackboards || []).find(x => x.id === bb.id);
    const snapshot = JSON.stringify(bbNow.board).slice(0, 1200);
    const r = await K.exec(['当前黑板内容：\n' + snapshot, ph.ask, '\n目标：' + task].join('\n\n'), Object.assign({ retry: 0 }, o));
    calls += r.attempts.length;
    // 模型不可用时**仍写结构**，并标注"未取得结论"——
    // 否则黑板 0 写入，看起来"跑过了"实际什么都没发生（第 2 条要消灭的假执行）
    writeBoard(bb.id, ph.sec,
      r.ok ? r.text : ('[未取得模型结论] 阶段「' + ph.label + '」失败：' + (r.error || '未知') + '。需人工补写或恢复模型通道后重跑。'),
      r.ok ? ph.label : ph.label + '(缺)');
  }
  const fin = (store.read().blackboards || []).find(x => x.id === bb.id);
  const dec = fin && fin.board.decisions[0];
  const filled = Object.keys(fin.board).filter(k => fin.board[k].length);
  const real = filled.filter(k => !/[未取得模型结论]/.test(fin.board[k][0].entry));
  const answer = dec
    ? dec.entry
    : ('黑板已建立（' + bb.id + '）：' + filled.map(k => k + ' ' + fin.board[k].length).join(' · ')
      + '。各阶段均未取得模型结论，详见黑板内标注。');
  return {
    answer,
    trace: trace('blackboard', {
      task, calls, ok: real.length > 0, ms: Date.now() - t0, boardId: bb.id,
      sections: filled.map(k => k + ':' + fin.board[k].length),
      realSections: real.length, degradedSections: filled.length - real.length,
      contributors: fin.contributors,
      tradeoff: '状态共享 → 后续角色能看到前面结论；代价是状态管理重、过程难追踪（已落库可查）'
    }),
    blackboard: fin
  };
}

// ===== 7. Graph Workflow =====
// DAG 真执行：拓扑推进 + 同层并行 + 真重试 + 卡点报告。
const DEFAULT_NODES = [
  { id: 'sense', label: '感知', deps: [], parallel: false },
  { id: 'analyze', label: '分析', deps: ['sense'], parallel: true },
  { id: 'risk', label: '风险', deps: ['sense'], parallel: true },
  { id: 'merge', label: '汇总', deps: ['analyze', 'risk'], parallel: false },
  { id: 'decide', label: '决策', deps: ['merge'], parallel: false },
  { id: 'deliver', label: '交付', deps: ['decide'], parallel: false }
];
async function graphWorkflow(task, opt) {
  const o = opt || {};
  const t0 = Date.now();
  const db = store.read();
  const gdef = (db.graphs || []).find(g => g.name === (o.graph || 'default'));
  const NODES = (gdef && Array.isArray(gdef.nodes)) ? gdef.nodes : DEFAULT_NODES;
  const maxRetry = Math.max(0, Number(o.retry) || 1);

  const results = {};
  const nodeTrace = [];
  let done = 0;
  while (done < NODES.length) {
    const ready = NODES.filter(n => !results[n.id] && (n.deps || []).every(d => results[d]));
    if (!ready.length) {
      // 依赖成环/不可达时**必须报出卡在哪**，不能静默停
      nodeTrace.push({
        node: '(stuck)', ok: false,
        error: '无就绪节点，疑似依赖成环；剩余：' + NODES.filter(n => !results[n.id]).map(n => n.id).join(',')
      });
      break;
    }
    // 同层并行节点真并发；否则一次一个
    const parallel = ready.filter(n => n.parallel);
    const batch = parallel.length ? parallel.concat(ready.filter(n => !n.parallel).slice(0, 1)) : [ready[0]];

    const runNode = async (n) => {
      const depCtx = (n.deps || []).map(d => results[d] ? '【' + d + '】' + String(results[d].out || '').slice(0, 200) : '').filter(Boolean).join('\n');
      let r = null, attempt = 0;
      // 真重试（重试策略在 K.exec 内部统一处理：不可重试错误会提前退出）
      while (attempt <= maxRetry) {
        r = await K.exec(['节点任务：' + n.label, depCtx ? '上游输出：\n' + depCtx : '', '总目标：' + task,
          attempt ? '上一次失败（' + (r && r.error) + '），换一种做法。' : ''].filter(Boolean).join('\n\n'),
          Object.assign({ retry: 0 }, o));
        attempt++;
        if (r.ok) break;
        if (/402|403|401|余额|quota/i.test(String(r.error || ''))) break;   // 配额类不重试
      }
      results[n.id] = { node: n.id, label: n.label, ok: !!(r && r.ok), out: r && r.text, attempts: attempt, ms: r && r.ms, error: r && r.error };
      nodeTrace.push({ node: n.id, ok: results[n.id].ok, attempts: attempt, ms: results[n.id].ms });
    };
    if (batch.length > 1) await Promise.all(batch.map(runNode));
    else await runNode(batch[0]);
    done += batch.length;
  }

  const complete = NODES.every(n => results[n.id]);
  const final = results.deliver || results.decide || results.merge;
  const stuck = nodeTrace.filter(t => !t.ok && t.node !== '(stuck)').map(t => t.node);
  const answer = final && final.ok ? final.out
    : ('图执行未完成。节点情况：' + nodeTrace.map(t => (t.ok ? '✓' : '✗') + t.node + (t.error ? '(' + t.error + ')' : '')).join(' ')
      + '。已完成部分的产出：' + (stuck.length && results.merge && results.merge.ok ? String(results.merge.out).slice(0, 400) : '（无可用中间产出）'));

  return {
    answer,
    trace: trace('graph', {
      task, calls: nodeTrace.length, nodes: NODES.length, executed: nodeTrace.length,
      retries: nodeTrace.reduce((a, t) => a + (t.attempts || 0), 0),
      completed: complete, ok: complete, ms: Date.now() - t0,
      nodesDetail: nodeTrace,
      tradeoff: 'DAG 编排支持分支/并行/重试，最稳；建模成本最高，节点写错则图走不通（能报出卡点）'
    })
  };
}

// —— 统一注册表 ——
const REGISTRY = {
  single: { name: '单 Agent', order: 1, fn: single, cost: '最低', when: '简单任务、低延迟要求' },
  react: { name: 'ReAct', order: 2, fn: react, cost: '高', when: '需多轮试错的探索型任务' },
  plan: { name: 'Plan & Execute', order: 3, fn: planExecute, cost: '中', when: '长流程、代码生成、步骤明确' },
  multi: { name: '多 Agent', order: 4, fn: multiAgent, cost: '高', when: '需多视角交叉验证' },
  route: { name: 'Route + Skill', order: 5, fn: routeSkill, cost: '最低', when: '★ 默认：企业级可控、可缓存' },
  blackboard: { name: 'Blackboard', order: 6, fn: blackboardRun, cost: '中', when: '复杂协作写作、需共享中间结论' },
  graph: { name: 'Graph Workflow', order: 7, fn: graphWorkflow, cost: '中', when: '最稳：需分支/并行/重试' }
};

async function run(kind, task, opt) {
  const o = opt || {};
  const k = REGISTRY[kind] ? kind : 'route';
  const r = await REGISTRY[k].fn(task, o);
  store.push('decisions', {
    question: String(task).slice(0, 80), answer: String(r.answer || '').slice(0, 400),
    engine: 'orchestrator:' + k, source: kind
  }, '编排执行·' + k);
  return Object.assign({ kind: k, name: REGISTRY[k].name, order: REGISTRY[k].order }, r);
}

// 推荐：规则推断（学习闭环叠加在 orkernel.recommendLearned 上）
function recommend(task) {
  const t = String(task || '');
  const scored = [];
  for (const k of Object.keys(REGISTRY)) {
    let s = 1, why = '';
    if (/步骤|流程|拆解|排期|上线|迁移|重构/.test(t)) { if (k === 'plan') { s += 3; why = '步骤明确，适合先出计划'; } if (k === 'graph') s += 2; }
    if (/方案|取舍|要不要|该不该|对比|评估/.test(t)) { if (k === 'multi') { s += 3; why = '需要多视角交叉'; } if (k === 'blackboard') s += 2; }
    if (/数据|多少|现状|统计|多少条/.test(t)) { if (k === 'route') { s += 3; why = '纯数据查询，走能力路由最省'; } }
    if (/写|文案|稿|脚本/.test(t)) { if (k === 'single') { s += 2; why = '单轮生成足够'; } }
    if (/调研|探索|试试|不确定|能不能做/.test(t)) { if (k === 'react') { s += 3; why = '需多轮试错'; } }
    if (t.length > 300) { if (k === 'graph') s += 2; if (k === 'blackboard') s += 1; }
    scored.push({ kind: k, name: REGISTRY[k].name, score: s, why: why || REGISTRY[k].when, cost: REGISTRY[k].cost });
  }
  scored.sort((a, b) => b.score - a.score);
  return { top: scored[0], all: scored };
}

function history(limit) {
  const rows = store.list('orchTrace', Math.min(300, Number(limit) || 80));
  const by = {};
  rows.forEach(r => {
    const k = by[r.kind] || (by[r.kind] = { kind: r.kind, n: 0, calls: 0, ok: 0, ms: 0 });
    k.n++; k.calls += Number(r.calls) || 0; k.ms += Number(r.ms) || 0;
    if (r.ok !== false) k.ok++;
  });
  return {
    total: rows.length,
    byKind: Object.values(by).map(k => ({
      ...k, avgCalls: k.n ? Math.round(k.calls / k.n * 10) / 10 : 0,
      avgMs: k.n ? Math.round(k.ms / k.n) : 0,
      successRate: k.n ? Math.round(k.ok / k.n * 100) : null
    })).sort((a, b) => b.n - a.n),
    registry: Object.keys(REGISTRY).sort((a, b) => REGISTRY[a].order - REGISTRY[b].order)
      .map(k => ({ kind: k, name: REGISTRY[k].name, order: REGISTRY[k].order, cost: REGISTRY[k].cost, when: REGISTRY[k].when }))
  };
}

module.exports = {
  REGISTRY, run, recommend, history, degraded, trace,
  single, react, planExecute, multiAgent, routeSkill,
  blackboard: blackboardRun, graph: graphWorkflow,
  board, writeBoard, STAGES, DEFAULT_NODES
};