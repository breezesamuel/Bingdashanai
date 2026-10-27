// core/reuse-sop.js — 「先检索复用，再造」五步 SOP
//
// 【为什么单独一层】core/adoption.js 已经能对**单个仓库**做五维评分与协议判定，
// 但那是"给我一个仓库，我评估它"。真实决策是**一条流程**：
//   ① 先别写 → ② 五维筛 → ③ 选 3 个 → ④ 判直达/二开 → ⑤ 估成本与风险
// 少任何一步都会退化成"直接开写"或"只看 star 就抄"。
// 本模块把这条流程固化成 run(need) 一次跑完、每步留痕、结论可复算的 SOP。
//
// 【最容易被忽略、也最容易出事的是开源协议】
// Star 多、更新勤 ≠ 能用。GPL 传染性强、AGPL/SSPL 连「只提供 SaaS 不分发」
// 都触发；MIT/Apache 宽松但要看 NOTICE 与专利条款。这一步由 adoption.js
// 的 LICENSE_RULES 把守，本 SOP 只负责把它变成**流程中的硬闸**，
// 并保证协议 unknown 时流程直接停在 step 1，不会带着侥幸往下走。
//
// 【AI 幻觉】AI 检索 GitHub 会捏造不存在的仓库、或推荐已停更/有漏洞的版本。
// verifyReality 判 reachable/exists，不存在的仓库直接标幻觉候选，
// 且**不允许进入 shortlist**。
//
// 【诚实边界】维度数据不全时不猜：缺 license → unknown；仓库不可达 → 幻觉候选。
// SOP 输出的每一步都带 evidence，人能逐条复核。

const adoption = require('./adoption');

// ---------- Step 0：先别写（门禁）----------
// 落点：在 core/ 与技能库里搜同域能力。命中即停 —— 这是六步里唯一能省掉后面五步的一步。
function gateFirst(need, opts) {
  const o = opts || {};
  const q = String((need && (need.what || need.query || need)) || '').trim();
  if (!q) return { step: 0, pass: false, reason: '需求描述为空，无法检索' };

  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const hits = [];
  const kw = q.toLowerCase().split(/\s+/).filter(w => w.length >= 2);

  // a) 扫 core/ 模块名与导出函数名
  try {
    const dir = path.join(ROOT, 'core');
    fs.readdirSync(dir).filter(f => f.endsWith('.js')).forEach(f => {
      const base = f.replace(/\.js$/, '');
      let src = '';
      try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) {}
      // 文件头注释也纳入匹配（很多能力在注释里说明了用途）
      const head = src.slice(0, 1200);
      const blob = (base + ' ' + head).toLowerCase();
      const matched = kw.filter(w => blob.includes(w));
      if (matched.length >= Math.max(1, Math.ceil(kw.length / 2))) {
        // 提取导出的函数名，证明这个模块"真的干这件事"
        const fns = [...src.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)]
          .map(m => m[1].split(',').map(s => s.split(':')[0].trim()).filter(Boolean)).flat();
        hits.push({ where: 'core/' + f, module: base, matched, exports: fns.slice(0, 8) });
      }
    });
  } catch (e) { /* 目录不可读则跳过，不阻断 SOP */ }

  // b) 显式提供的能力清单（调用方可以传 ownModules 精确匹配）
  (o.ownModules || []).forEach(m => {
    const blob = String((m.name || '') + ' ' + (m.desc || '') + ' ' + (m.exports || []).join(' ')).toLowerCase();
    const matched = kw.filter(w => blob.includes(w));
    if (matched.length >= Math.max(1, Math.ceil(kw.length / 2))) {
      hits.push({ where: m.where || 'provided', module: m.name, matched, exports: m.exports || [] });
    }
  });

  if (hits.length) {
    return {
      step: 0, pass: false,
      reason: '自有能力已覆盖该需求 —— 停下别写，先复用',
      hits,
      nextAction: '核对上述模块的导出函数，确认覆盖后再决定是否需要扩展；不要新建同功能模块'
    };
  }
  return {
    step: 0, pass: true,
    reason: '自有能力未覆盖（扫了 core/ 全部模块与调用方提供的能力清单）',
    hits: [],
    nextAction: '进入 Step 1：检索外部候选，按五维筛选'
  };
}

// ---------- Step 1：五维筛选 ----------
// 五个维度 = 更新时间 / Star数 / 开源协议 / 技术栈 / 部署难度。
// 每个维度一条独立结论，**不合成一个总分**（合成分会掩盖"协议不合格但 star 很高"这种致命项）。
const FIVE_DIMS = [
  { key: 'activity', dim: '更新时间', field: 'pushedAt', weightNote: '停更越久，漏洞与兼容性风险越高' },
  { key: 'activity', dim: 'Star数', field: 'stars/forks', weightNote: '高 star 不等于安全，只说明有人看过' },
  { key: 'license', dim: '开源协议', field: 'spdx', weightNote: '**硬闸**：unknown 或不可闭源直接终止' },
  { key: 'integration', dim: '技术栈', field: 'lang/runtime', weightNote: '与自身技术栈不一致会增加维护面' },
  { key: 'integration', dim: '部署难度', field: 'Dockerfile/deps/tests/CI', weightNote: '有 Docker+测试+CI 的仓库接入成本最低' }
];

function screen(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return { step: 1, pass: false, reason: '没有候选仓库，无法筛选' };

  const assessed = list.map(c => {
    const a = adoption.assess(c.repo || c.fullName || c.name, c.facts || c);
    return { raw: c, assessment: a };
  });

  // 硬闸一：仓库必须真实存在（AI 幻觉防御）
  // 【判据取自 assessment.checklist.reality，而不是调用方的原始字段】
  // 旧写法读 x.raw.reality，但调用方通常把 reality 直接摊在 facts 里
  // （reachable/exists/probeStatus），导致 x.raw.reality 取到 undefined，
  // 幻觉仓库漏过闸门进了 shortlist —— 这正是本闸要防的事。
  const hallucinated = assessed.filter(x => x.assessment.checklist.reality.verdict !== 'exists');
  // 硬闸二：协议必须是已知且可闭源（closedSrc !== false）
  const blockedByLicense = assessed.filter(x => {
    const L = x.assessment.checklist.license;
    return L.verdict === 'unknown' || L.closedSrc === false;
  });

  const survivors = assessed.filter(x =>
    !hallucinated.includes(x) && !blockedByLicense.includes(x));

  return {
    step: 1, pass: survivors.length > 0,
    fiveDims: FIVE_DIMS,
    counts: { input: assessed.length, hallucinated: hallucinated.length, blockedByLicense: blockedByLicense.length, survivors: survivors.length },
    hallucinated: hallucinated.map(x => ({
      repo: x.assessment.repo,
      why: x.assessment.checklist.reality.verdict === 'unreachable'
        ? '仓库不可达（网络失败/被删/限流）——不能凭 star 数放行'
        : '仓库不存在（' + (x.assessment.checklist.reality.probeStatus || '?') + '）——AI 幻觉候选'
    })),
    blockedByLicense: blockedByLicense.map(x => ({
      repo: x.assessment.repo,
      license: x.assessment.checklist.license,
      why: x.assessment.checklist.license.verdict === 'unknown'
        ? '协议 unknown —— 拿不准就不许往下走，先读 LICENSE 原文'
        : '协议不允许闭源分发（' + (x.assessment.checklist.license.spdx || '?') + '）'
    })),
    survivors: survivors.map(x => ({
      repo: x.assessment.repo,
      decision: x.assessment.decision,
      label: x.assessment.label,
      license: { spdx: x.assessment.checklist.license.spdx, copyleft: x.assessment.checklist.license.copyleft, closedSrc: x.assessment.checklist.license.closedSrc },
      activity: x.assessment.checklist.activity,
      integration: x.assessment.checklist.integration,
      reasons: x.assessment.reasons
    })),
    _assessed: assessed  // 供后续步骤复用，不直接暴露给调用方
  };
}

// ---------- Step 2：选 3 个 ----------
const RANK = { use: 0, adapt: 1, hold: 2, reject: 3 };
function shortlist(step1, n) {
  const k = Math.max(1, Number(n) || 3);
  const pool = (step1 && step1.survivors) || [];
  if (!pool.length) return { step: 2, pass: false, reason: 'Step 1 没有存活候选' };
  const ranked = pool.slice().sort((a, b) => {
    const d = (RANK[a.decision] ?? 9) - (RANK[b.decision] ?? 9);
    if (d !== 0) return d;
    // 同为 use 时看活跃度与集成度
    const as = ((a.activity && a.activity.score) || 0) + ((a.integration && a.integration.score) || 0);
    const bs = ((b.activity && b.activity.score) || 0) + ((b.integration && b.integration.score) || 0);
    return bs - as;
  });
  const picked = ranked.slice(0, k);
  return {
    step: 2, pass: picked.length > 0,
    picked: picked.map((p, i) => ({
      rank: i + 1, repo: p.repo, decision: p.decision, label: p.label,
      license: p.license, why: '决策档位=' + p.decision + '；活跃度=' + ((p.activity && p.activity.score) || 0) + '；集成度=' + ((p.integration && p.integration.score) || 0)
    })),
    rankedOrder: ranked.map(p => ({ repo: p.repo, decision: p.decision })),
    note: '排序规则：use < adapt < hold < reject，同档比活跃度+集成度。**协议是硬闸，不参与排序加分**'
  };
}

// ---------- Step 3：判直达 vs 二开 ----------
function decide(step2) {
  const picked = (step2 && step2.picked) || [];
  if (!picked.length) return { step: 3, pass: false, reason: '没有候选可决策' };
  const DIRECT = {
    use: { bucket: 'direct', how: '按原样引入/CLI 调用/依赖注入，只做配置与适配层' },
    adapt: { bucket: 'fork', how: '拉分支改；须先估工时，并遵守原协议的传染条款' },
    hold: { bucket: 'watch', how: '先观望，不作为当前方案；记录原因待复评' },
    reject: { bucket: 'drop', how: '不复用；进入自研或换检索词重来' }
  };
  return {
    step: 3, pass: true,
    verdicts: picked.map(p => ({
      repo: p.repo,
      direct: DIRECT[p.decision].bucket === 'direct',
      bucket: DIRECT[p.decision].bucket,
      how: DIRECT[p.decision].how,
      because: p.why
    })),
    summary: {
      direct: picked.filter(p => DIRECT[p.decision].bucket === 'direct').map(p => p.repo),
      needFork: picked.filter(p => DIRECT[p.decision].bucket === 'fork').map(p => p.repo),
      watch: picked.filter(p => DIRECT[p.decision].bucket === 'watch').map(p => p.repo),
      drop: picked.filter(p => DIRECT[p.decision].bucket === 'drop').map(p => p.repo)
    },
    rule: 'use=直达（仅配置/适配）；adapt=二开（拉分支，先估工时）；hold=观望；reject=不复用'
  };
}

// ---------- Step 4：成本与风险 ----------
function estimate(step3, opts) {
  const o = opts || {};
  const verdicts = (step3 && step3.verdicts) || [];
  if (!verdicts.length) return { step: 4, pass: false, reason: '没有决策可评估' };
  const RATE = Number(o.hourlyRate) || 0; // 可选：单位小时成本，用于折算金额
  const BASE = { use: 4, adapt: 24, hold: 1, reject: 0 }; // 经验工时（小时，含阅读+接入+自测）
  return {
    step: 4, pass: true,
    items: verdicts.map(v => {
      const key = v.bucket === 'direct' ? 'use' : (v.bucket === 'fork' ? 'adapt' : (v.bucket === 'watch' ? 'hold' : 'reject'));
      const hours = BASE[key];
      const risks = [];
      if (v.bucket === 'direct') risks.push('升级/停更风险：上游大版本可能改 API');
      if (v.bucket === 'fork') risks.push('分叉维护成本：上游修复要手动合并；协议传染义务');
      if (v.bucket === 'watch') risks.push('机会成本：等它成熟期间需求仍在');
      if (v.bucket === 'drop') risks.push('已投入检索时间沉没');
      risks.push('供应链风险：依赖树中任意一环投毒即传导');
      return {
        repo: v.repo, bucket: v.bucket,
        hours,
        cost: RATE ? Math.round(hours * RATE) : null,
        risks,
        mitigation: v.bucket === 'fork'
          ? '锁版本 + 记录分叉 diff + 每季度评估是否回并上游'
          : '锁版本 + 订阅安全通告 + 保留降级开关（可换实现）'
      };
    }),
    totalHours: verdicts.reduce((s, v) => s + BASE[v.bucket === 'direct' ? 'use' : (v.bucket === 'fork' ? 'adapt' : (v.bucket === 'watch' ? 'hold' : 'reject'))], 0),
    honesty: '工时为经验估算，非精确测量；成本按 rate 折算，未提供 rate 时只给小时数'
  };
}

// ---------- 一键跑完整条 SOP ----------
async function run(need, opts) {
  const o = opts || {};
  const trace = [];
  const t0 = Date.now();

  // Step 0
  const gate = gateFirst(need, o);
  trace.push({ step: 0, name: '先别写', pass: gate.pass, reason: gate.reason, hits: gate.hits || [], nextAction: gate.nextAction });
  if (!gate.pass) {
    return {
      ok: true, need, stoppedAt: 0,
      conclusion: 'REUSE_OWN',
      trace,
      verdict: '自有能力已覆盖，不启动外部检索 —— 这是最省成本的分支',
      cost: estimate({ verdicts: [] }, o),
      ms: Date.now() - t0
    };
  }

  // Step 1：候选来自调用方（SOP 不自己去搜，保证可离线复算 + 不产生幻觉）
  const cands = o.candidates || [];
  const s1 = screen(cands);
  trace.push({ step: 1, name: '五维筛选', pass: s1.pass, reason: s1.reason || ('存活 ' + s1.counts.survivors + '/' + s1.counts.input),
    blocked: s1.blockedByLicense || [], hallucinated: s1.hallucinated || [], fiveDims: s1.fiveDims });
  if (!s1.pass) {
    return {
      ok: true, need, stoppedAt: 1,
      conclusion: 'NO_VIABLE_CANDIDATE',
      trace,
      verdict: 'Step 1 无存活候选。协议与真实性是硬闸，此处不许放宽',
      next: '换检索词重试，或如实转自研（并记录为什么外部无解）',
      cost: estimate({ verdicts: [] }, o),
      ms: Date.now() - t0
    };
  }

  // Step 2
  const s2 = shortlist(s1, o.pick || 3);
  trace.push({ step: 2, name: '选 3 个', pass: s2.pass, reason: s2.reason || ('已选 ' + s2.picked.length + ' 个'), picked: s2.picked, note: s2.note });
  if (!s2.pass) {
    return { ok: true, need, stoppedAt: 2, conclusion: 'NO_SHORTLIST', trace, verdict: s2.reason, cost: estimate({ verdicts: [] }, o), ms: Date.now() - t0 };
  }

  // Step 3
  const s3 = decide(s2);
  trace.push({ step: 3, name: '判直达/二开', pass: s3.pass, reason: s3.rule, verdicts: s3.verdicts, summary: s3.summary });

  // Step 4
  const s4 = estimate(s3, o);
  trace.push({ step: 4, name: '成本与风险', pass: s4.pass, items: s4.items, totalHours: s4.totalHours, honesty: s4.honesty });

  return {
    ok: true, need,
    stoppedAt: null,
    conclusion: 'FOLLOW_SOP_COMPLETE',
    trace,
    verdict: 'SOP 五步走完。协议闸已在 Step 1 强制执行；' +
      (s3.summary.direct.length ? '可直达：' + s3.summary.direct.join('、') : '无可直达项') +
      (s3.summary.needFork.length ? '；需二开：' + s3.summary.needFork.join('、') : ''),
    cost: s4,
    ms: Date.now() - t0
  };
}

module.exports = {
  gateFirst, screen, shortlist, decide, estimate, run,
  FIVE_DIMS, RANK
};
console.log('[reuse-sop] 先检索复用再造五步 SOP loaded');