// core/sop.js — 角色化 SOP 流水线（MetaGPT「Code = SOP(Team)」模型）
//
// 【需求来源】用户给出的 MetaGPT 流程层 SOP 九要点：
//   1 核心理念 Code = SOP(Team)：把标准作业程序交给 LLM 扮演的多角色团队执行
//   2 角色分工：产品经理 / 架构师 / 项目经理 / 工程师（对应真实岗位）
//   3 输入层：只需一行需求（Boss Requirement）
//   4 产品层：产品经理产出用户故事、竞品分析、需求文档、数据结构、API 设计
//   5 架构层：架构师出系统流程与设计草案，并经**多轮 Review 和 Revise**
//   6 项目层：项目经理拆解任务、分配，组织对各阶段交付物的评审
//   7 工程层：工程师写代码、自测、调试，QA 编写并运行测试用例
//   8 闭环机制：**每个阶段都带 Review / Revise 节点**，确保前一步达标才进入下一步
//   9 效果：一个人驱动一整支虚拟研发团队
//
// 【为什么 Review 判定不能交给 LLM】
// 这是本模块最重要的设计决定。如果让"审阅者"是另一个 LLM，让它输出「通过」或「打回」，
// 那么它几乎总会说通过——没有外部标尺时，模型倾向于认可既有产出。
// 于是 Review 闸门会退化成"形式上过一遍"，比没有闸门更危险：
// 因为它给了"已经审过了"的假证据。
//
// 所以本模块用**结构化判据**：每个阶段有明确的验收清单（checklist），
// 产出被机械地检查是否覆盖了清单项。检查不到 → 必须 Revise。
// LLM 负责"产出内容"，检查器负责"判定是否达标"。两者职责不可互换。
//
// 【Revise 有上限】
// 无限重做会烧光 token 且可能永不收敛（模型反复产出同样不合格的内容）。
// 默认每阶段最多 revise 2 次，超过则**标记为阻塞并如实上报**，不假装通过。

const store = require('./store');
const capability = require('./capability');
const K = require('./orkernel');

// —— 阶段定义 ——
// deliverable 是什么产物；checklist 是机械判据（不是"质量好不好"，是"该有的有没有"）
const STAGES = [
  {
    key: 'pm', role: '产品经理', arch: 'blackboard',
    deliverable: '产品需求包',
    brief: '产出：①一句话价值主张 ②3-5 条用户故事 ③目标用户画像 ④竞品差异 ⑤核心数据结构 ⑥API 端点清单 ⑦验收标准',
    // 机械判据：产出里必须能找到这些结构，否则说明模型跳过了环节
    checklist: [
      { key: 'value', name: '价值主张', re: /价值主张|核心价值|一句话价值/ },
      { key: 'story', name: '用户故事', re: /用户故事|作为.*我希望|user story/i },
      { key: 'persona', name: '用户画像', re: /用户画像|目标用户|画像/ },
      { key: 'schema', name: '数据结构', re: /数据结构|数据模型|schema|表结构|字段/i },
      { key: 'api', name: 'API 清单', re: /API|端点|endpoint|接口/i },
      { key: 'accept', name: '验收标准', re: /验收|accept|完成标准|DoD/i }
    ]
  },
  {
    key: 'arch', role: '架构师', arch: 'graph',
    deliverable: '系统设计',
    brief: '产出：①系统上下文与边界 ②模块划分与依赖 ③关键数据流 ④技术选型与理由 ⑤失败模式与降级策略 ⑥性能与容量估算',
    checklist: [
      { key: 'boundary', name: '系统边界', re: /系统边界|上下文|边界/ },
      { key: 'module', name: '模块划分', re: /模块|组件|拆分|分层/ },
      { key: 'flow', name: '数据流', re: /数据流|调用链|时序|流程/ },
      { key: 'choice', name: '技术选型', re: /技术选型|选型|方案对比|为什么用/i },
      { key: 'failure', name: '失败模式', re: /失败|降级|异常|容错|兜底/ },
      { key: 'perf', name: '性能估算', re: /性能|容量|QPS|延迟|吞吐/ }
    ]
  },
  {
    key: 'pmp', role: '项目经理', arch: 'plan',
    deliverable: '任务拆解与排期',
    brief: '基于产品需求与系统设计，产出：①可执行任务清单（每条有验收标准）②依赖关系与关键路径 ③里程碑与时间盒 ④风险登记与缓解 ⑤人员/角色分工',
    checklist: [
      { key: 'tasks', name: '任务清单', re: /任务清单|任务拆解|WBS|任务列表/ },
      { key: 'accept', name: '验收标准', re: /验收|完成标准|DoD/ },
      { key: 'dep', name: '依赖与关键路径', re: /依赖|关键路径|前置|串行/ },
      { key: 'mile', name: '里程碑', re: /里程碑|阶段|时间盒|排期/ },
      { key: 'risk', name: '风险登记', re: /风险|缓解|预案/ },
      { key: 'owner', name: '分工', re: /分工|负责人|角色分配|owner/i }
    ]
  },
  {
    key: 'eng', role: '工程师', arch: 'plan',
    deliverable: '可运行实现方案',
    // 诚实说明：本系统不凭空生成可编译的完整工程，产出的是「实现方案 + 关键代码骨架 + 自测清单」
    brief: '产出：①按任务拆解给出的实现步骤 ②核心数据结构与接口的代码骨架 ③关键算法/逻辑的伪码或片段 ④自测步骤与预期结果 ⑤已知限制',
    checklist: [
      { key: 'impl', name: '实现步骤', re: /实现步骤|实施|怎么做|落地/i },
      { key: 'code', name: '代码骨架', re: /代码|function|class|def |interface|struct|伪码/i },
      { key: 'selftest', name: '自测', re: /自测|测试|验证|预期结果/ },
      { key: 'limit', name: '已知限制', re: /限制|未做|暂不|遗留|TODO/i }
    ]
  },
  {
    key: 'qa', role: 'QA 工程师', arch: 'route',
    deliverable: '测试用例与验收结论',
    brief: '产出：①按需求与实现列出测试用例（正常路径 + 异常路径）②每条用例的预期结果 ③发现的缺陷与严重度 ④是否达到验收标准的明确结论',
    checklist: [
      { key: 'case', name: '测试用例', re: /测试用例|用例|case|测试点/i },
      { key: 'negative', name: '异常路径', re: /异常|边界|失败|错误|降级/ },
      { key: 'defect', name: '缺陷记录', re: /缺陷|问题|bug|严重/i },
      { key: 'verdict', name: '验收结论', re: /结论|是否通过|达标|verdict/i }
    ]
  }
];

// —— 机械判据检查 ——
// 这是本模块的核心：产出是否达标，由这里判定，不由模型自述。
function checkChecklist(stage, text) {
  const t = String(text || '');
  const hits = [];
  const missing = [];
  stage.checklist.forEach(c => {
    if (c.re.test(t)) hits.push(c.key);
    else missing.push(c.name);
  });
  const coverage = stage.checklist.length ? Math.round(hits.length / stage.checklist.length * 100) : 0;
  return {
    total: stage.checklist.length, hits, missing, coverage,
    // 判定线 70%：允许模型换个说法，但不允许整块缺失
    pass: coverage >= 70
  };
}

// —— 单阶段执行（含 Review/Revise 闸门）——
async function runStage(stage, input, opt) {
  const o = opt || {};
  const maxRevise = Math.max(0, Number(o.maxRevise) !== undefined ? Number(o.maxRevise) : 2);
  const t0 = Date.now();
  const rounds = [];
  let brief = input;
  let output = '';

  for (let rev = 0; rev <= maxRevise; rev++) {
    const r = await K.exec([
      '角色：你是「' + stage.role + '」，正在为一个软件项目执行 SOP 的「' + stage.deliverable + '」阶段。',
      '原始需求（Boss Requirement）：' + o.requirement,
      rev === 0
        ? ('本阶段任务：' + stage.brief)
        : ('【这是第 ' + (rev + 1) + ' 次修订】上一次产出未覆盖以下要点：' + rounds[rounds.length - 1].check.missing.join('、')
          + '。请**补齐这些要点**，其余部分保持。'),
      '上游输入：', brief,
      '输出格式：直接给产出内容本身，不要写"作为'+stage.role+'我认为"这类开场白。'
    ].filter(Boolean).join('\n\n'), Object.assign({ retry: 0 }, o));

    if (!r.ok) {
      rounds.push({ rev, ok: false, error: r.error, check: { pass: false, coverage: 0, missing: ['（模型不可用，无法产出）'] } });
      // 模型不可用**不能算通过**——如实标阻塞
      return {
        stage: stage.key, role: stage.role, ok: false, blocked: true,
        reason: '模型不可用：' + r.error,
        rounds, ms: Date.now() - t0, output: ''
      };
    }

    output = r.text;
    const check = checkChecklist(stage, output);
    rounds.push({ rev, ok: true, ms: r.ms, check, len: String(output).length });
    if (check.pass) {
      return {
        stage: stage.key, role: stage.role, ok: true,
        revised: rev, rounds, output, check, ms: Date.now() - t0
      };
    }
    // 未达标 → 下一轮 Revise（附上缺失清单）
    brief = '上一轮你的产出（用于补齐，不要重写）：\n' + String(output).slice(0, 2000);
  }

  // 修订次数用尽仍不达标 → 阻塞，如实上报，绝不放行
  return {
    stage: stage.key, role: stage.role, ok: false, blocked: true,
    reason: '经 ' + (maxRevise + 1) + ' 轮产出仍未覆盖验收要点：' + rounds[rounds.length - 1].check.missing.join('、'),
    rounds, output, check: rounds[rounds.length - 1].check, ms: Date.now() - t0
  };
}

// —— 主流程：一行需求 → 全流程交付 ——
// stopOnBlock = true 时，任一阶段阻塞即停止（严格闸门，符合"确保前一步达标才进入下一步"）
async function run(requirement, opt) {
  const o = opt || {};
  const t0 = Date.now();
  const req = String(requirement || '').trim();
  if (!req) return { ok: false, error: '需求不能为空' };

  const job = {
    id: store.uid(), requirement: req, startedAt: Date.now(),
    status: 'running', stages: [], finalDeliverable: ''
  };
  const stages = Array.isArray(o.stages) ? STAGES.filter(s => o.stages.indexOf(s.key) >= 0) : STAGES;

  let upstream = '（无，这是第一阶段）';
  for (let i = 0; i < stages.length; i++) {
    const st = stages[i];
    const r = await runStage(st, upstream, o);
    job.stages.push({
      key: st.key, role: st.role, deliverable: st.deliverable,
      ok: r.ok, blocked: !!r.blocked, revised: r.revised || 0,
      coverage: r.check ? r.check.coverage : 0,
      missing: r.check ? r.check.missing : [],
      reason: r.reason || null, ms: r.ms,
      output: String(r.output || '').slice(0, 4000)
    });
    if (!r.ok) {
      job.status = 'blocked';
      job.blockedAt = st.role;
      job.reason = r.reason;
      store.push('sopJobs', job, 'SOP 流水线', req.slice(0, 60));
      // 严格闸门：前一步没达标就不进下一步——这是需求第 8 条的核心
      if (o.stopOnBlock !== false) {
        return Object.assign({}, job, {
          ok: false,
          note: '在「' + st.role + '」阶段阻塞，后续阶段未执行。这是 SOP 闸门按设计生效——'
            + '前一步未达标不会带着问题进入下一步。若要继续，请修正后重跑或设置 stopOnBlock=false。'
        });
      }
      upstream = '上一阶段（' + st.role + '）未能完成：' + (r.reason || '未知');
      continue;
    }
    upstream = '上一阶段（' + st.role + '）产出：\n' + String(r.output).slice(0, 2500);
  }

  job.status = 'done';
  job.finishedAt = Date.now();
  job.ms = Date.now() - t0;
  job.finalDeliverable = upstream;
  store.push('sopJobs', job, 'SOP 流水线', req.slice(0, 60));
  return Object.assign({}, job, { ok: true });
}

// —— 流水线看板 ——
function board(limit) {
  const jobs = store.list('sopJobs', Math.min(50, Number(limit) || 10));
  const byRole = {};
  jobs.forEach(j => (j.stages || []).forEach(s => {
    const r = byRole[s.role] || (byRole[s.role] = { role: s.role, n: 0, blocked: 0, revised: 0, coverage: 0 });
    r.n++; if (s.blocked) r.blocked++; r.revised += s.revised || 0; r.coverage += s.coverage || 0;
  }));
  return {
    total: jobs.length,
    done: jobs.filter(j => j.status === 'done').length,
    blocked: jobs.filter(j => j.status === 'blocked').length,
    byRole: Object.values(byRole).map(r => ({
      ...r, avgCoverage: r.n ? Math.round(r.coverage / r.n) : 0,
      blockRate: r.n ? Math.round(r.blocked / r.n * 100) : 0
    })),
    jobs: jobs.slice(0, 8).map(j => ({
      id: j.id, requirement: String(j.requirement || '').slice(0, 60),
      status: j.status, blockedAt: j.blockedAt || null,
      stages: (j.stages || []).map(s => ({ role: s.role, ok: s.ok, revised: s.revised, coverage: s.coverage })),
      ms: j.ms || ((j.finishedAt || 0) - j.startedAt)
    }))
  };
}

function stagesInfo() {
  return STAGES.map((s, i) => ({
    order: i + 1, key: s.key, role: s.role, deliverable: s.deliverable,
    brief: s.brief,
    checklist: s.checklist.map(c => ({ key: c.key, name: c.name }))
  }));
}

module.exports = { STAGES, run, runStage, checkChecklist, board, stagesInfo };