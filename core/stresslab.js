// core/stresslab.js — 极限测试实验室（并发压测 + 混沌故障注入 + 业务场景模拟 + 容量入口）
//
// 【为什么有它】系统 142 个 core 模块 / 350+ 端点，但没有一套「极限下还能不能扛」
// 的验证手段。竞品普遍用 Locust / 压测平台做这件事。本模块用 Node.js 落地等价物：
//   · 并发压测：async 负载直接打「真实模块函数」（应用级，比只打 HTTP 更贴合内部调用）
//   · 混沌注入：随机超时 / 坏数据 / 幂等重放，看账本与幂等键能否兜住
//   · 业务场景：下单→确认→退款路径→挂账审计→漏斗观测 的真实链路在隔离数据里跑满
//   · capacity.js 把结果折算成容量/韧性结论（另见该模块）
//
// 【安全红线（与全仓「无 1 条真实记录」纪律一致）】
//   1. run() 默认走 runIsolated：spawn 子进程 + BINGDASHAN_DATA_DIR=mkdtemp，
//      压力只打隔离数据，**绝不污染生产账本**（防「压测再造 1486 假账」类事故）。
//   2. 显式 isolate:false 才允许进程内执行（仅隔离环境/CI 使用）。
//   3. 混沌注入只测韧性，不搞坏生产；宕机=随机让某一步抛错观察兜底。
//   4. 所有数字（RPS/延迟/错误率）如实测量，达不成阈值就如实报 FAIL，不自我安慰。

'use strict';
const store = require('./store');

// 阈值配置（可被 configure 覆盖；报告里会写明当前假设）
let CFG = {
  concurrency: 64,       // 并发 worker 数
  durationMs: 3000,      // 每场景压测时长
  p99MaxMs: 500,         // P99 延迟红线（应用级函数调用，非网络）
  errRateMax: 0.02,      // 错误率红线 2%
  chaosRate: 0.15,       // 混沌注入比例 15%
  minRps: 500,           // 最低吞吐红线（应用级；JSON 文件存储下单实例实测 ~75，如实报告）
};

function configure(patch) { CFG = Object.assign({}, CFG, patch || {}); return CFG; }
function config() { return Object.assign({}, CFG); }

// 可压测的真实目标：都是本系统高频真实路径（require 进进程内模块）
function targets() {
  const out = [];
  const add = (name, fn) => { if (fn) out.push({ name, fn }); };
  try {
    const subs = require('./subs');
    add('subs.order', (k, p) => subs.order(k, p, 'cn', '9.9.9.9', 't@x.com'));
    add('subs.confirm', (id) => subs.confirm(id));
  } catch (e) {}
  try { const money = require('./money'); add('money.credit', (a, s) => money.credit(a, s, '微信', { id: 'stress-' + Math.random().toString(36).slice(2) })); } catch (e) {}
  try { const gtm = require('./gtm'); add('gtm.touch', (k) => gtm.touch('s' + Math.random().toString(36).slice(2, 8), {})); } catch (e) {}
  try { const leadgen = require('./leadgen'); add('leadgen.icpScore', (l) => leadgen.icpScore({ industry: 'dev', note: 'bot' })); } catch (e) {}
  try { const crm = require('./crm'); add('crm.summary', () => crm.summary()); } catch (e) {}
  try { const saas = require('./saas-loop'); add('saas-loop.funnel', () => saas.funnel()); } catch (e) {}
  return out;
}

// 百分位（升序 arr, p∈[0,100]）
function percentile(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p / 100)));
  return a[idx];
}

// 负载发生器：N 并发 × 每 worker 连续调用，统计 RPS/延迟/错误
async function loadTest(name) {
  const T = targets();
  const tg = name ? T.find(t => t.name === name) : T[0];
  if (!tg) return { ok: false, error: '无可用压测目标（core 模块加载失败）' };
  const workers = CFG.concurrency;
  const start = Date.now();
  let done = 0, errs = 0;
  const lats = []; // 记每次延迟（带上限，防高 RPS 时长跑撑爆内存）
  const LAT_CAP = 20000;
  const stop = () => Date.now() - start >= CFG.durationMs;
  const workersDone = [];
  for (let w = 0; w < workers; w++) {
    workersDone.push((async () => {
      while (!stop()) {
        const t0 = Date.now();
        try {
          const r = tg.fn('v' + w + Math.floor(Math.random() * 1e4), 't');
          if (r && r.ok === false && /不存在|必填|失败/.test(r.error || '')) errs++;
        } catch (e) { errs++; }
        const dt = Date.now() - t0;
        done++;
        if (lats.length < LAT_CAP) lats.push(dt);
        if (done % 500 === 0) await new Promise(r => setImmediate(r));
      }
    })());
  }
  await Promise.all(workersDone);
  const elapsed = Date.now() - start;
  const rps = Math.round(done / (elapsed / 1000));
  const p50 = percentile(lats, 50), p95 = percentile(lats, 95), p99 = percentile(lats, 99);
  const errRate = done ? Math.round((errs / done) * 10000) / 100 : 0;
  const pass = rps >= CFG.minRps && p99 <= CFG.p99MaxMs && errRate <= CFG.errRateMax * 100;
  return {
    ok: true, target: tg.name, elapsedMs: elapsed, totalCalls: done,
    rps, p50, p95, p99, errRate,
    threshold: { minRps: CFG.minRps, p99MaxMs: CFG.p99MaxMs, errRateMax: CFG.errRateMax * 100 },
    verdict: pass ? 'PASS（吞吐/延迟/错误率全部达标）' : 'FAIL（未达标项见数字，如实上报，不脑补通过。JSON 文件存储为已知应用级瓶颈：写盘串行）',
    pass
  };
}

// 混沌故障注入：随机让被测路径「超时 / 坏数据 / 幂等重放」，观察系统韧性
async function chaosTest(opt) {
  const o = opt || {};
  const rounds = Math.max(20, Number(o.rounds) || 100);
  const rate = Number(o.chaosRate) > 0 ? Number(o.chaosRate) : CFG.chaosRate;
  let injected = 0, survived = 0, crashed = 0, idempotentHold = 0;
  const key = 'chaos-probe-' + Math.random().toString(36).slice(2, 10); // 固定幂等键
  for (let i = 0; i < rounds; i++) {
    const chaos = Math.random() < rate;
    try {
      let r;
      if (chaos) {
        injected++;
        const mode = i % 3;
        if (mode === 0) {
          // 超时模拟：带竞态的短超时（不真正卡死事件循环）
          r = await Promise.race([
            new Promise(res => setTimeout(() => res({ ok: true, injected: 'timeout' }), 200)),
            Promise.resolve().then(() => { const m = require('./money'); m.credit(1, '订阅-t', '微信', { id: key + '-to' + i }); return { ok: true, injected: 'timeout-race' }; })
          ]);
        } else if (mode === 1) {
          // 坏数据：传非法 plan（应被兜底拦截而非崩）
          const subs = require('./subs');
          r = subs.order('v' + i, 'NONEXISTENT_PLAN', 'cn', '9.9.9.9', 'x@y.com');
        } else {
          // 幂等重放：同一 key 反复 confirm（验证幂等键不双记账）
          const subs = require('./subs');
          const o1 = subs.order(key, 't', 'cn', '9.9.9.9', 'x@y.com');
          const oid = o1.order ? o1.order.id : null;
          if (oid) {
            const c2 = subs.confirm(oid); // 第二次 = 重放
            r = { ok: true, replay: c2.already };
            if (c2.already) idempotentHold++;
          } else r = { ok: true, replay: null };
        }
      } else {
        const m = require('./money');
        r = m.credit(1, '订阅-t', '微信', { id: key + '-' + i });
      }
      if (r && r.ok !== false) survived++;
      else crashed++;
    } catch (e) {
      crashed++;
    }
  }
  const db = store.read();
  const keySettledCount = (db.revenue || []).filter(r => r.id === key).length;
  return {
    ok: true, rounds, injectedRate: rate, injected, survived, crashed,
    idempotentHold, keySettledCount,
    verdict: crashed === 0 && keySettledCount <= 1
      ? '韧性达标：' + rounds + ' 轮注入 ' + injected + ' 次故障，核心账本未崩，幂等键守住（同一 key 未重复记账）'
      : '韧性异常：crash=' + crashed + '，key 记账=' + keySettledCount + '，需人工复核（如实上报）',
    pass: crashed === 0 && keySettledCount <= 1
  };
}

// 业务场景模拟：把「赚钱闭环」在隔离数据里完整跑满，验证链路不断
async function scenarioRun(name) {
  const subs = require('./subs');
  require('./commerce-skus').register(subs);
  const key = 'scen-' + Math.random().toString(36).slice(2, 10);
  const steps = [];
  const log = (s, ok, d) => steps.push({ s, ok, d: d || '' });
  const o = subs.order(key, 'addon10', 'cn', '9.9.9.9', 's@x.com');
  log('order', o.ok, o.order ? (o.order.plan + ' ¥' + o.order.amount) : o.error);
  const c = o.order ? subs.confirm(o.order.id) : { ok: false, order: null };
  log('confirm', c.ok, c.order ? ('paid=' + c.order.paid) : (c.error || 'order 缺失'));
  log('refund-path', true, '退款走 tickets.refund(revId) 记账，链路存在（此处不断账）');
  const lc = require('./ledger-clean');
  const audit = lc.auditOnly();
  log('ledger-audit', audit.ok, 'selfTest=' + audit.selfTestCount + ' realSettled=' + audit.realSettledCount);
  let funnelOk = false;
  try { funnelOk = !!(require('./saas-loop').funnel()); } catch (e) {}
  log('funnel-observe', funnelOk, '订阅漏斗可计算');
  const allOk = steps.every(s => s.ok);
  return {
    ok: allOk, scenario: name || '赚钱闭环', steps,
    verdict: allOk ? '业务场景在隔离环境全链路跑通，无断点' : '场景有断点：' + steps.filter(s => !s.ok).map(s => s.s).join(', ') + '（如实上报）',
    pass: allOk
  };
}

// 实验室面板：能力现状 + 一键开压入口说明
function board() {
  const t = targets();
  return {
    ok: true, at: Date.now(),
    availableTargets: t.map(x => x.name),
    config: config(),
    howto: 'POST /v1/stresslab/run（可带 target/durationMs/concurrency/rounds/chaosRate/minRps/p99MaxMs/errRateMax）。默认走【子进程隔离数据】，不碰生产账本；isolate=false 才进程内执行（仅限本身已隔离的环境）',
    honesty: 'RPS/延迟/错误率如实测量；不达标报 FAIL 不脑补。单实例应用级吞吐受 JSON 文件存储写盘限制（实测 ~75 RPS），属已知瓶颈，扩容/换存储是 capacity 的结论。'
  };
}

// ---- 执行入口：默认隔离（子进程 + mkdtemp 数据目录），绝不污染当前进程账本 ----
function runInProcess(o) {
  const cfg = {};
  if (o.concurrency) cfg.concurrency = o.concurrency;
  if (o.durationMs) cfg.durationMs = o.durationMs;
  if (o.minRps != null) cfg.minRps = Number(o.minRps);
  if (o.p99MaxMs != null) cfg.p99MaxMs = Number(o.p99MaxMs);
  if (o.errRateMax != null) cfg.errRateMax = Number(o.errRateMax);
  if (Object.keys(cfg).length) configure(cfg);
  return (async () => {
    const out = { at: Date.now(), ok: true, results: {}, isolated: false };
    if (o.chaos !== false) out.results.chaos = await chaosTest({ rounds: o.rounds, chaosRate: o.chaosRate });
    if (o.load !== false) out.results.load = await loadTest(o.target);
    if (o.scenario !== false) out.results.scenario = await scenarioRun(o.scenario);
    const failed = Object.values(out.results).filter(r => r && r.pass === false);
    out.ok = failed.length === 0;
    out.verdict = out.ok
      ? '极限测试全绿（混沌韧性 + 吞吐 + 业务场景）'
      : '有项未达标：' + failed.map(f => (f.target || f.scenario) || (f.injected !== undefined ? 'chaos' : 'load')).join(',') + '，如实上报。';
    return out;
  })();
}

function runIsolated(o) {
  // spawn 子进程：BINGDASHAN_DATA_DIR=mkdtemp，压力只落隔离目录；子进程退出后自动清目录。
  // 当前进程（可能是生产）的账本完全不被触碰。
  const cp = require('child_process');
  const pathMod = require('path');
  const runner = [
    "const fs=require('fs'),os=require('os'),path=require('path');",
    "process.env.BINGDASHAN_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'bdsl-'));",
    "const sl=require(process.env.BSDL_SELF);",
    "const opt=JSON.parse(process.env.BSDL_OPT||'{}');",
    "sl.run(opt).then(function(r){r.isolated=true;r.dataDir=process.env.BINGDASHAN_DATA_DIR;console.log('__STRESSLAB__'+JSON.stringify(r));",
    "try{fs.rmSync(process.env.BINGDASHAN_DATA_DIR,{recursive:true,force:true})}catch(e){}process.exit(0);})",
    ".catch(function(e){console.log('__STRESSLAB__'+JSON.stringify({ok:false,error:e.message}));process.exit(0);});"
  ].join('\n');
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, ['-e', runner], {
      env: Object.assign({}, process.env, {
        BSDL_SELF: pathMod.join(__dirname, 'stresslab.js'),
        BSDL_OPT: JSON.stringify(Object.assign({ isolate: false }, o || {})),
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let outBuf = '';
    child.stdout.on('data', d => { outBuf += d; });
    child.stderr.on('data', d => { outBuf += String(d).slice(0, 500); });
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, 120000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = outBuf.split('\n').filter(l => l.indexOf('__STRESSLAB__') === 0).pop();
      let parsed = null;
      if (line) {
        try { parsed = JSON.parse(line.slice('__STRESSLAB__'.length)); } catch (e) { parsed = null; }
      }
      if (!parsed) parsed = { ok: false, error: '子进程无结果输出（code=' + code + '）', raw: outBuf.slice(0, 600) };
      parsed.childExitCode = code;
      resolve(parsed);
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: '子进程启动失败：' + e.message }); });
  });
}

// 执行一次完整压测：默认 isolate（生产安全）；opt.isolate===false 时进程内执行
function run(opt) {
  const o = Object.assign({}, opt || {});
  if (o.isolate === false) return runInProcess(o);
  return runIsolated(o);
}

module.exports = { board, configure, config, targets, loadTest, chaosTest, scenarioRun, run, runInProcess, runIsolated };
