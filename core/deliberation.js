// core/deliberation.js — 多 Agent 协同账本
//
// 现状问题：agents.team() 已能做真会诊（并行 consult + 确定性共识抽取），
// 但每次会诊只往 decisions 写一条文本，无法回答：
//   谁在什么时候提了什么？哪个专家被反驳过？哪条建议最终被采纳/否决？
//
// 本模块提供可审计的协同记录层，不替代 agents.js，只在其之上留痕。
//
// 设计纪律：
//   1. 账本只记录「已真实发生」的事。没有真实会诊结果就不许写入 —— 禁止事后编造专家意见。
//   2. 采纳与否必须给理由，且与原意见关联（replyTo），避免变成无根之萍。
//   3. 所有记录带 at 时间戳与来源，供复盘。
//   4. 证据分级沿用 core/evidence.js 的 A/B/C 纪律：LLM 产出的建议默认 C 级，
//      除非有实测数据支撑才允许升档。绝不让模型自己声称 A 级。

const store = require('./store');
const evidence = require('./evidence');

const ROLES = {
  analyst: { name: '分析', duty: '拆假设、找可验证指标' },
  strategist: { name: '战略', duty: '半年视角排优先级，守现金流' },
  planner: { name: '计划', duty: '拆里程碑，锁本周唯一交付' },
  critic: { name: '风控', duty: '挑假设漏洞，要求止损线' },
  grower: { name: '增长', duty: '找可转化场景，一料五吃' },
  builder: { name: '执行', duty: '压清单、清依赖、设验收点' }
};

const VERDICT = { adopted: 'adopted', rejected: 'rejected', pending: 'pending' };

// 开一次协同会：把 agents.team() 的真实结果登记进账本
// 不接受外部编造的 members 内容 —— 必须由调用方传入真实 consult 结果
function convene(body) {
  const q = String((body && body.question) || '').trim();
  if (!q) return { ok: false, error: 'question 必填' };
  const members = (body && body.members) || [];
  if (!Array.isArray(members) || !members.length) {
    return { ok: false, error: 'members 必填且非空：没有真实会诊结果就不许开会（禁止事后编造专家意见）' };
  }
  // 角色 id 必须已知。未知 id 会产出无法归集的账本行（roleName 回退成裸 id、duty 为空），
  // 复盘时按角色统计会漏掉它 —— 属于静默污染审计链，按纪律直接拒绝。
  // 确需临时角色时显式传 allowUnknown:true，会在 summary.unknownRoles 里留痕。
  const allowUnknown = !!(body && body.allowUnknown);
  const known = Object.keys(ROLES);
  const unknownRoles = members.map(m => m && m.id).filter(id => !id || known.indexOf(id) < 0);
  if (unknownRoles.length && !allowUnknown) {
    return {
      ok: false,
      error: '未知角色 id：' + unknownRoles.map(String).join('、')
        + '。合法值：' + known.join('/') + '。'
        + '（角色 id 写错会让该条意见在复盘里无法归集；确需临时角色请显式传 allowUnknown:true）',
      unknownRoles, allowed: known
    };
  }
  const at = Date.now();
  const roundId = store.uid();
  const rows = members.map((m, i) => ({
    id: store.uid(),
    roundId,
    seq: i + 1,
    role: m.id || ('role' + (i + 1)),
    roleName: (ROLES[m.id] || {}).name || (m.name || m.id) || '未标注',
    duty: (ROLES[m.id] || {}).duty || '',
    roleKnown: !!ROLES[m.id],
    claim: firstLine(m.content),
    full: String(m.content || '').slice(0, 4000),
    at
  }));
  store.pushMany('deliberation', rows, '协同会记录', roundId);

  const summary = {
    id: roundId,
    question: q.slice(0, 200),
    at,
    members: rows.map(r => ({ role: r.role, name: r.roleName, claim: r.claim })),
    consensus: (body.consensus || []).map(c => ({ text: c.text, n: c.n })),
    divergence: (body.divergence || []).slice(0, 10),
    risks: (body.risks || []).slice(0, 10),
    actions: (body.actions || []).slice(0, 10),
    failed: (body.failed || []).slice(0, 10),
    unknownRoles: unknownRoles.map(String)
  };
  store.push('deliberationRounds', summary, '协同会', q.slice(0, 60));
  store.push('audit', {
    action: '协同会',
    detail: q.slice(0, 60) + ' · 参与 ' + rows.map(r => r.roleName).join('+')
      + (summary.failed.length ? ' · 失败 ' + summary.failed.join(',') : ''),
    at
  }, null, null);
  return { ok: true, roundId, summary, rows };
}

// 对某条专家意见作出裁决：采纳 / 否决 / 待定
// 必须给理由 —— 无理由的裁决没有价值
function adjudicate(roundId, rowId, verdict, reason) {
  const v = String(verdict || '').trim();
  if ([VERDICT.adopted, VERDICT.rejected, VERDICT.pending].indexOf(v) < 0) {
    return { ok: false, error: 'verdict 必须是 ' + Object.values(VERDICT).join(' / ') };
  }
  const rs = String(reason || '').trim();
  if (!rs) return { ok: false, error: '必须给出裁决理由（无理由的采纳/否决不可追溯）' };
  const row = store.list('deliberation', 9999).find(r => r.id === rowId && r.roundId === roundId);
  if (!row) return { ok: false, error: '意见不存在：' + rowId };
  const updated = store.update('deliberation', rowId, {
    verdict: v, verdictReason: rs, adjudicatedAt: Date.now()
  }, '协同裁决');
  store.push('audit', {
    action: '协同裁决',
    detail: row.roleName + ' 的意见 ' + v + '：' + rs.slice(0, 100),
    at: Date.now()
  }, null, null);
  return { ok: true, rec: updated };
}

// 给行动项分级：沿用 evidence 纪律，LLM 建议默认 C
// 升到 A/B 必须填实测来源，否则拒绝 —— 不允许模型自封 A 级
function gradeAction(actionId, grade, proof) {
  const g = String(grade || '').trim().toUpperCase();
  if (!['A', 'B', 'C'].includes(g)) return { ok: false, error: 'grade 必须是 A / B / C' };
  const p = String(proof || '').trim();
  if ((g === 'A' || g === 'B') && !p) {
    return {
      ok: false,
      error: '升到 ' + g + ' 级必须提供实测依据（数据/来源）。'
        + '默认 C 级：AI 产出的建议在你自己的场景未经检验，不得自封高等级'
    };
  }
  const act = store.list('actions', 9999).find(a => a.id === actionId);
  if (!act) return { ok: false, error: '行动项不存在：' + actionId };
  const updated = store.update('actions', actionId, {
    evidence: g, evidenceProof: p || null, gradedAt: Date.now()
  }, '行动项分级');
  const G = evidence.GRADE[g];
  return { ok: true, rec: updated, gradeDesc: G ? G.desc : '未知等级' };
}

// 记一个待执行行动项（默认 C 级）
function addAction(body) {
  const t = String((body && body.text) || '').trim();
  if (!t) return { ok: false, error: 'text 必填' };
  const rec = store.push('actions', {
    text: t.slice(0, 300),
    from: (body && body.from) || 'unknown',
    roundId: (body && body.roundId) || null,
    cost: body && body.cost !== undefined ? body.cost : null,
    impact: body && body.impact !== undefined ? body.impact : null,
    evidence: 'C',           // 默认 C：AI 建议未经本地验证
    evidenceProof: null,
    status: 'open',
    at: Date.now()
  }, '新增行动项', t.slice(0, 50));
  return { ok: true, rec, note: '默认 C 级：AI 产出的建议未经你自己的场景验证' };
}

// 复盘视图：谁提了什么、被采纳/否决了几条、账本里 C 级占比
function review(limit) {
  const n = Number(limit) || 20;
  // 注意 store.list() 返回「最新在前」的倒序，下面需要正序的地方统一 .reverse()
  const rounds = store.list('deliberationRounds', 9999).slice(0, n);
  const rows = store.list('deliberation', 99999).reverse();
  const actions = store.list('actions', 9999).reverse();

  const byRole = {};
  rows.forEach(r => {
    const k = r.roleName || r.role;
    if (!byRole[k]) byRole[k] = { role: k, duty: r.duty || '', claims: 0, adopted: 0, rejected: 0, pending: 0, noVerdict: 0 };
    byRole[k].claims++;
    if (r.verdict === VERDICT.adopted) byRole[k].adopted++;
    else if (r.verdict === VERDICT.rejected) byRole[k].rejected++;
    else if (r.verdict === VERDICT.pending) byRole[k].pending++;
    else byRole[k].noVerdict++;
  });

  const byEv = { A: 0, B: 0, C: 0 };
  // 注意：不能用 if (byEv[x]) 判存在 —— 计数值 0 是 falsy，会把全部记录漏掉
  actions.forEach(a => {
    const g = String(a.evidence || '').toUpperCase();
    if (Object.prototype.hasOwnProperty.call(byEv, g)) byEv[g]++;
    else byEv.other = (byEv.other || 0) + 1;
  });

  // 按场次隔离的裁决覆盖率：只看全局会被「另一场全裁决」掩盖掉本场的空转
  const perRound = {};
  rows.forEach(r => {
    if (!perRound[r.roundId]) perRound[r.roundId] = { claims: 0, judged: 0 };
    perRound[r.roundId].claims++;
    if (r.verdict) perRound[r.roundId].judged++;
  });
  const idleRounds = Object.keys(perRound).filter(id => {
    const s = perRound[id];
    return s.claims && s.judged / s.claims < 0.5;
  });
  const totalClaims = rows.length;
  const judged = rows.filter(r => !!r.verdict).length;
  const unknown = rows.filter(r => r.roleKnown === false);
  const idleNote = idleRounds.length
    ? '有 ' + idleRounds.length + ' 场会超过一半意见未裁决：这些会的产出没落到行动上'
    : '各场会均有多数意见被裁决';

  return {
    rounds: rounds.map(r => {
      const s = perRound[r.id] || { claims: 0, judged: 0 };
      return {
        id: r.id, question: r.question, at: r.at,
        members: (r.members || []).length,
        consensus: (r.consensus || []).length,
        divergence: (r.divergence || []).length,
        failed: r.failed || [],
        claims: s.claims, judged: s.judged,
        idle: !!(s.claims && s.judged / s.claims < 0.5)
      };
    }),
    idleRounds,
    roleStats: Object.values(byRole).sort((a, b) => b.claims - a.claims),
    unknownRoles: unknown.map(r => ({ id: r.id, role: r.role, roundId: r.roundId, claim: r.claim })),
    coverage: {
      totalClaims,
      judged,
      unjudged: totalClaims - judged,
      note: totalClaims && judged / totalClaims < 0.5
        ? '超过一半意见未裁决：会诊产出没有落到行动上，多 agent 协同在空转'
        : '多数意见已被裁决（全局口径；按场次看见 idleRounds）',
      perRoundNote: idleNote
    },
    actionGrades: {
      A: byEv.A, B: byEv.B, C: byEv.C,
      note: 'C 级 ' + byEv.C + ' 条为默认等级（AI 建议未经本地验证）。'
        + '升 A/B 必须在 gradeAction 里给出实测依据'
    },
    openActions: actions.filter(a => a.status === 'open')
      .map(a => ({ id: a.id, text: a.text, from: a.from, evidence: a.evidence, cost: a.cost, impact: a.impact }))
  };
}

function firstLine(x) {
  return String(x || '').split('\n').map(s => s.trim()).find(Boolean) || '';
}

module.exports = { ROLES, VERDICT, convene, adjudicate, addAction, gradeAction, review };
