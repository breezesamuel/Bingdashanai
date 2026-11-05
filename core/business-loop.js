// core/business-loop.js — 全量商业闭环聚合器（只读·跨模块·缺模块置 null 不编数）
//
// 为什么有它：8 段管道（commercial-loop）+ 11 个运营模块（revenue-ops /
// conversion-engine / trial-conversion / partner-recruit / ledger-clean /
// stresslab / capacity / storage-engine / dataq / dataq-sql / cs-sla）各说各话，
// 没有一处能一眼回答「整条商业闭环现在转到哪了、哪一环断了、数据是否可信」。
//
// 本模块把上述全部串成一个闭环总览，只做**只读聚合 + 诊断 + 下一步**：
//   · pipeline   —— 8 段管道（直接复用 commercial-loop.status()，不重算）
//   · modules    —— 11 个运营模块的 board()（缺哪个置 null，绝不编造）
//   · ledger     —— 台账体检（自测假账 / 挂账超 24h / 真实到账），只读
//   · integrity  —— 哪些模块成功聚合、哪些缺失/异常（透明报告，不藏）
//   · diagnosis  —— 最大漏斗断点 + 最该做的一件事（来自真实数据，不自我安慰）
//
// 诚实纪律（与 revenue-ops / cs-sla 同一套）：
//   1. 数字全部来自真实台账与各模块 board；某模块缺失 → 该字段 null，绝不编造。
//   2. 本模块**零写**：只读 + 调用各模块只读函数（board/auditOnly），不动任何数据。
//   3. diagnosis 找的是「真实断点」（分母>0 且转化最低），不按计划数估算。
//   4. loopHealth 沿用 commercial-loop 口径：只认真实证据产出，零成交就是 0。

'use strict';

function safe(fn, fallback) {
  try { const r = fn(); return r == null ? fallback : r; } catch (e) { return fallback; }
}

// 各运营模块的只读入口（缺模块 → null + 记录到 missing）
// 表：[key(输出字段), label(人类名), requirePath(core 下), getter]
function loadModules() {
  const defs = [
    ['revenueOps', 'revenue-ops', './revenue-ops', m => m.board()],
    ['conversionEngine', 'conversion-engine', './conversion-engine', m => m.board()],
    ['trialConversion', 'trial-conversion', './trial-conversion', m => m.board()],
    ['partnerRecruit', 'partner-recruit', './partner-recruit', m => m.recruitBoard()],
    ['csSla', 'cs-sla', './cs-sla', m => m.board()],
    ['stresslab', 'stresslab', './stresslab', m => m.board()],
    ['capacity', 'capacity', './capacity', m => m.board()],
    ['storageEngine', 'storage-engine', './storage-engine', m => m.board()],
    ['dataq', 'dataq', './dataq', m => m.board()],
    ['dataqSql', 'dataq-sql', './dataq-sql', m => m.board()],
  ];
  const out = {};
  const missing = [];
  const failed = [];
  defs.forEach(([key, label, rel, getter]) => {
    const mod = safe(() => require(rel), null);
    if (!mod) { missing.push(label); out[key] = null; return; }
    let r;
    try { r = getter(mod); } catch (e) { failed.push(label + ': ' + e.message); out[key] = null; return; }
    out[key] = r;
  });
  return { out, missing, failed };
}

// 台账体检（只读）：自测假账 / 挂账超 24h / 真实到账
function ledgerCheck() {
  const lc = safe(() => require('./ledger-clean'), null);
  if (!lc) return { ok: false, reason: 'ledger-clean 不可用' };
  const a = safe(() => lc.auditOnly(), null);
  if (!a) return { ok: false, reason: 'auditOnly 失败' };
  return {
    ok: true,
    selfTest: { count: a.selfTestCount, sum: a.selfTestSum },
    realSettled: { count: a.realSettledCount, sum: a.realSettledSum },
    realPending: { count: a.realPendingCount, sum: a.realPendingSum },
    stalePendingOver24h: a.stalePendingOver24h,
    dirty: a.selfTestCount > 0,          // 还有自测假账未清
    verdict: a.verdict
  };
}

// 最大漏斗断点 + 最该做的一件事（真实数据，不脑补）
function diagnosis() {
  const items = [];
  const rev = safe(() => require('./revenue-ops'), null);
  if (rev) {
    const leak = safe(() => rev.leak(), null);
    if (leak && leak.worst) items.push({ kind: '漏斗断点', sev: 'high', msg: '最大断点：' + leak.worst.name + '（' + leak.worst.count + '/' + leak.worst.denom + ' = ' + leak.worst.pct + '%）' });
    (leak && leak.issues ? leak.issues : []).forEach(s => items.push({ kind: '漏钱', sev: 'mid', msg: s }));
    const acts = safe(() => rev.todaysActions(), null);
    if (acts && acts.actions && acts.actions.length) {
      items.push({ kind: '今日动作', sev: 'high', msg: acts.actions[0].title, why: acts.actions[0].why, gate: acts.actions[0].gate });
    }
  }
  // 台账脏（自测假账未清）→ 提醒先清
  const led = ledgerCheck();
  if (led.ok && led.dirty) items.unshift({ kind: '台账体检', sev: 'high', msg: '台账尚有 ' + led.selfTest.count + ' 笔自测假账 ¥' + led.selfTest.sum + ' 未清（先 dry-run 清除，别让营收口径脏着）' });
  if (!items.length) items.push({ kind: '闭环', sev: 'low', msg: '当前无真实断点/动作（线索或客户为空）。下一步：用 leadgen 找新线索，把访客带到试用。' });
  return items;
}

// 总览主入口（只读）
function board() {
  const cl = safe(() => require('./commercial-loop'), null);
  const pipeline = cl ? safe(() => cl.status(), null) : null;

  const mods = loadModules();
  const ledger = ledgerCheck();
  const diag = diagnosis();

  // 摘要（全部来自真实数据；缺失项如实为 null/0）
  const revMoney = mods.out.revenueOps && mods.out.revenueOps.money ? mods.out.revenueOps.money : null;
  const summary = {
    // 管道层
    loopHealth: pipeline && pipeline.summary ? pipeline.summary.loopHealth : null,
    wiringPct: pipeline && pipeline.summary ? pipeline.summary.wiringPct : null,
    stagesStarted: pipeline && pipeline.summary ? pipeline.summary.stagesStarted : null,
    stagesTotal: pipeline && pipeline.summary ? pipeline.summary.stagesTotal : null,
    gatePass: pipeline && pipeline.summary ? pipeline.summary.gatePass : null,
    // 钱（settled 非自测）
    realRevenue: revMoney ? revMoney.settled : null,
    pending: revMoney ? revMoney.pending : null,
    refunded: revMoney ? revMoney.refunded : null,
    // 台账体检
    ledgerDirty: ledger.ok ? ledger.dirty : null,
    // 模块健康
    modulesAggregated: Object.values(mods.out).filter(x => x != null).length,
    modulesMissing: mods.missing,
    modulesFailed: mods.failed
  };

  // 一句话闭环结论（诚实：不吹"快成了"，零成交就说零）
  let verdict;
  if (pipeline && pipeline.summary) {
    verdict = (summary.realRevenue != null && summary.realRevenue > 0 && summary.gatePass === true)
      ? '商业闭环已成立（管道+真实到账+证据门全过）：守住复购与留存。'
      : (summary.realRevenue != null && summary.realRevenue > 0
        ? '有真实到账 ¥' + summary.realRevenue + '，但证据门 ' + (summary.gatePass ? '全过' : '未全过 ' + summary.wiringPct + '% 管道已布）：守复购、补证据。')
        : '管道已布 ' + summary.wiringPct + '%（' + summary.stagesStarted + '/' + summary.stagesTotal + ' 段有真实数据），但真实到账 = 0。闭环**未成立**——先拿到第 1 个真实买家，别用管道段数当健康度。');
  } else {
    verdict = 'commercial-loop 不可用，无法给出闭环健康度；只聚合了运营模块。';
  }

  return {
    ok: true,
    at: Date.now(),
    summary,
    verdict,
    pipeline,            // 8 段管道（commercial-loop.status() 全量）
    modules: mods.out,    // 11 个运营模块 board（缺的 null）
    integrity: {
      aggregated: Object.values(mods.out).filter(x => x != null).map((_, i) => i),
      missing: mods.missing,
      failed: mods.failed,
      note: 'missing=模块未装/require 失败；failed=装了但 board 抛错。均如实列出，不藏。'
    },
    ledger,
    diagnosis: diag,
    honesty: '本模块零写、只读聚合；数字全来自真实台账与各模块 board；某模块缺失该字段=null 不编造；loopHealth 沿用 commercial-loop 口径（只认真实证据产出）。'
  };
}

module.exports = { board, pipeline: () => safe(() => require('./commercial-loop').status(), null), ledgerCheck, diagnosis, loadModules };
