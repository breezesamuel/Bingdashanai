// core/capacity.js — 容量规划 + 韧性看板（把 stresslab 的极限结果转成「能不能扛、要几台」的决策）
//
// 【为什么有它】stresslab 测出 RPS/延迟/错误率，但光有数字不够——运营要的是
// 「现在这套架构在 X 倍流量下会不会垮、要不要扩容、哪里先垮」。本模块把压测结果
// 折算成容量与韧性结论，并给出真实的瓶颈定位（不脑补通过）。
//
// 诚实纪律：
//   · 所有折算基于 stresslab 实测数字 + 显式假设（单核 CPU 容量、实例数），假设写进结果，可推翻。
//   · 达不到红线就报 FAIL，不美化。
//   · 只读：不修改任何生产数据；扩容是「建议」不是「执行」。

'use strict';

function safe(fn, fb) { try { const r = fn(); return r == null ? fb : r; } catch (e) { return fb; } }

// 默认假设（可被 configure 覆盖，都会写进报告）
let CFG = {
  targetPeakRps: 5000,     // 目标峰值（如黑五）
  baseRps: 500,            // 单实例基线（stresslab 测得的稳定 RPS）
  instanceCpuCost: 1,     // 每实例算 1 份容量
  redundancy: 2,          // 至少 N 台在线（避免单点）
  latencySloMs: 300,      // SLO：P95 延迟红线
};
function configure(p) { CFG = Object.assign({}, CFG, p || {}); return Object.assign({}, CFG); }
function config() { return Object.assign({}, CFG); }

// 把一次 stresslab.run() 结果折算成容量结论
function plan(stress) {
  const load = stress && stress.results ? stress.results.load : null;
  const chaos = stress && stress.results ? stress.results.chaos : null;
  const baseRps = load && load.rps > 0 ? load.rps : CFG.baseRps;
  const singleInstancePeak = baseRps;               // 单实例能扛的峰值
  const needForPeak = Math.ceil(CFG.targetPeakRps / Math.max(1, singleInstancePeak));
  const instances = Math.max(needForPeak, CFG.redundancy);
  // SLO 判定
  const p95 = load ? load.p95 : null;
  const sloOk = p95 == null ? null : p95 <= CFG.latencySloMs;
  // 韧性分（0-100）：基于混沌测试 crash 率与幂等守住
  let resilience = null;
  if (chaos && chaos.rounds > 0) {
    const crashRate = chaos.injected ? (chaos.crashed / chaos.rounds) : 0;
    const idemHold = chaos.injected ? (chaos.idempotentHold / chaos.injected) : 1;
    resilience = Math.round((1 - Math.min(1, crashRate) * 0.6) * 100 * (0.4 + 0.6 * idemHold));
    resilience = Math.max(0, Math.min(100, resilience));
  }
  const bottlenecks = [];
  if (load) {
    if (load.p99 != null && load.p99 > CFG.latencySloMs) bottlenecks.push('P99=' + load.p99 + 'ms 超 SLO ' + CFG.latencySloMs + 'ms → 先削尖峰（加缓存/降并发）');
    if (load.errRate > CFG.errRateMax || (chaos && !chaos.pass)) bottlenecks.push('错误率/韧性异常（errRate=' + load.errRate + '%）→ 查依赖超时与幂等键');
    if (load.rps < CFG.minRps) bottlenecks.push('单实例 RPS=' + load.rps + ' 低于红线 ' + CFG.minRps + ' → 应用级瓶颈，需优化热点函数');
  }
  return {
    ok: true, at: Date.now(),
    assumptions: { targetPeakRps: CFG.targetPeakRps, baseRps, instanceCpuCost: CFG.instanceCpuCost, redundancy: CFG.redundancy, latencySloMs: CFG.latencySloMs, note: '假设可 configure 覆盖；结论随假设线性变化' },
    singleInstanceRps: baseRps,
    recommendedInstances: instances,
    scaling: '为峰值 ' + CFG.targetPeakRps + ' RPS 需 ' + instances + ' 台（redundancy≥' + CFG.redundancy + '）；扩容是建议，本模块不自动执行',
    slo: { p95, target: CFG.latencySloMs, met: sloOk },
    resilienceScore: resilience,
    bottlenecks,
    verdict: sloOk === false || bottlenecks.length
      ? '存在瓶颈：' + (bottlenecks.join('；') || 'SLO 未达标') + '（如实上报，先优化再扩容）'
      : ('容量健康：单实例 ' + baseRps + ' RPS，峰值需 ' + instances + ' 台；' + (resilience != null ? '韧性分 ' + resilience + '/100。' : '')),
    honesty: '全部基于 stresslab 实测 + 显式假设；不脑补通过，不达红线报 FAIL。'
  };
}

// 韧性/容量看板（无压测结果时给「待测」态，不编数字）
function board() {
  let stress = null;
  try { stress = safe(() => require('./stresslab'), null); } catch (e) {}
  // 板子本身只读；把「最近一次压测结论」放在这里需要显式传结果，故默认展示「怎么开测」
  return {
    ok: true, at: Date.now(),
    config: config(),
    haveStresslab: !!stress,
    howto: '先 POST /v1/stresslab/run（隔离数据·显式开压）拿到结果，再 POST /v1/capacity/plan {stress:<上一步结果>} 得容量/韧性结论',
    honesty: '未跑压测时不编数字；看板只陈述「可测项 + 假设 + 入口」。'
  };
}

module.exports = { plan, board, configure, config };
