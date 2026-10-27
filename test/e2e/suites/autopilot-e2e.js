  // ---- -115 self-heal: optimize / modules fallback ----
  // ---- -114 self-heal: optimize / modules fallback ----
const { finish } = require('./_exit');
const http = require('http');

let pass = 0, fail = 0;
const T = (name, ok, extra) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' . ' + extra : ';')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(base, method, p, body, headers) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
    const r = http.request(base + p, { method, headers: h }, resp => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => { try { res({ code: resp.statusCode, body: JSON.parse(d) }); } catch (e) { res({ code: resp.statusCode, body: d }); } });
    });
    r.setTimeout(20000, () => { r.destroy(); res({ code: 0, body: { raw: 'client timeout' } }); });
    r.on('error', e => res({ code: 0, body: { raw: String(e) } }));
    r.end(data || undefined);
  });
}
const G = (base, p) => req(base, 'GET', p);
const P = (base, p, b) => req(base, 'POST', p, b || {});
const bd = r => r && r.body || {};

  // ---- -90 self-heal: optimize / modules fallback ----
console.log('  [diag] waiting running=true / logLen=0');
async function waitIdle(base, ms) {
  const t0 = Date.now();
  const limit = ms || 90000;
  let sawRound = false;
  for (;;) {
    const st = bd(await G(base, '/v1/autopilot/status'));
    if (st.ok && st.roundNo > 0) sawRound = true;          // 已经真的跑过至少一轮
    // 只有在"已经跑过轮次 且 当前不忙"时才算空闲。
    // 旧实现只看 running===false：boot() 首轮是延后 FIRST_RUN_DELAY_MS(12s) 才启动，
    // 启动瞬间 running 还是 false，于是 waitIdle 立刻返回 roundNo=0 —— 竞态，
    // 断言"boot 跑完一轮"在首轮尚未开始时就误判失败。
    if (st.ok && sawRound && st.running === false) return st;
    if (Date.now() - t0 > limit) return st; // hard timeout guard for the polling helper
    await sleep(500);
  }
}

(async () => {
  const { requireIsolated } = require('./_guard');
  const BASE = requireIsolated('autopilot-e2e');
  // 套件自身超时必须大于 core/autopilot.js 的 ROUND_TIMEOUT（6x45s+30s=300s），
// 再加上多轮轮次与轮询，否则套件会在轮次跑完前先判 TIMEOUT（原为 120s，必然偶发）。
let doneTimer;
  const done = new Promise(res => { doneTimer = setTimeout(res, 900000, 'TIMEOUT'); });
  const run = (async () => {

  // ---- -73 self-heal: optimize / modules fallback ----
  const boot = await waitIdle(BASE);
  T('boot round completed and persisted', boot.running === false && boot.roundNo > 0 && boot.logLen > 0,
    'roundNo=' + boot.roundNo + ' logLen=' + boot.logLen + ' running=' + boot.running);

  // ---- -68 self-heal: optimize / modules fallback ----
  let st = bd(await G(BASE, '/v1/autopilot/status'));
  T('status returns ok', st.ok === true);
  T('status has enabled flag', typeof st.enabled === 'boolean', 'enabled=' + st.enabled);
  T('status has intervalSec + effectiveSec', typeof st.intervalSec === 'number' && typeof st.effectiveSec === 'number', st.intervalSec + '/' + st.effectiveSec);
  T('status has degraded/consecFails/lastError', typeof st.degraded === 'boolean' && typeof st.consecFails === 'number' && typeof st.lastError === 'string');
  T('status keeps legacy fields (roundNo/running/nextInMs/logLen/wheel/last)', st.roundNo !== undefined && st.running !== undefined && st.nextInMs !== undefined && st.logLen !== undefined && !!st.wheel && st.last !== undefined);
  T('status exposes stepCatalog', Array.isArray(st.stepCatalog) && st.stepCatalog.length >= 6, 'steps=' + (st.stepCatalog || []).length);

  // ---- -59 self-heal: optimize / modules fallback ----
// ---- 6 pause/resume: engine must stop then restart cleanly ----
  const stepsRes = bd(await G(BASE, '/v1/autopilot/steps'));
  T('GET /v1/autopilot/steps lists catalog', stepsRes.ok === true && Array.isArray(stepsRes.steps) && stepsRes.steps.length >= 6);
  const ids = (stepsRes.steps || []).map(s => s.id);
  T('catalog covers collect/evolve/modules/acquire/memory/staff', ['collect', 'evolve', 'modules', 'acquire', 'memory', 'staff'].every(i => ids.indexOf(i) >= 0), ids.join(','));

  // ---- -52 self-heal: optimize / modules fallback ----
  const mem = bd(await P(BASE, '/v1/autopilot/step', { id: 'memory' }));
  T('runStep(memory) ok with ms', mem.ok === true && mem.step && mem.step.ok === true && typeof mem.step.ms === 'number', mem.step && (mem.step.id + ' ' + mem.step.ms + 'ms'));
  const badStep = bd(await P(BASE, '/v1/autopilot/step', { id: 'no_such_step' }));
  T('runStep(unknown) rejected with catalog', badStep.ok === false && !!badStep.error && Array.isArray(badStep.steps), badStep);

  // ---- -46 self-heal: optimize / modules fallback ----
  const paused = bd(await P(BASE, '/v1/autopilot/pause', { reason: 'e2e pause' }));
  T('pause returns enabled=false', paused.ok === true && paused.enabled === false);
  st = bd(await G(BASE, '/v1/autopilot/status'));
  T('status reflects paused', st.enabled === false && st.nextInMs === 0, 'nextInMs=' + st.nextInMs);
  T('reliability block present', st.reliability === null || (st.reliability && typeof st.reliability.okPct === 'number'), st.reliability ? ('okPct=' + st.reliability.okPct) : 'null');

  let manual = bd(await P(BASE, '/v1/autopilot/run', {}));
  // ---- -38 self-heal: optimize / modules fallback ----
  // runOnce has a concurrency guard: returns skipped while a round is still in flight. Poll until a real round lands.
  // 轮次耗时随外部源可达性在 15-60s 间波动（源不可达会走满单步超时），单轮最坏 6x45s。
  // 原来只等 4x8s=32s，网络一慢就取不到轮次 -> 后续断言集体 undefined 假失败（偶发）。
  // 这里放宽到 20 次 x 15s，覆盖最坏耗时。
  for (let w = 0; w < 20 && !(manual.round && manual.round.no !== undefined && !manual.round.skipped); w++) {
    await waitIdle(BASE, 15000);
    manual = bd(await P(BASE, '/v1/autopilot/run', {}));
  }
  T('run produced a real round', !!(manual.round && manual.round.no !== undefined), 'keys=' + Object.keys(manual.round || {}).join(','));
  T('manual run works while paused', manual.ok === true && !!manual.round && !manual.round.skipped, JSON.stringify(manual.round && (manual.round.skipped || ('no=' + manual.round.no))));

  // ---- -29 self-heal: optimize / modules fallback ----
  const badIv = bd(await P(BASE, '/v1/autopilot/interval', { sec: 0 }));
  T('interval rejects non-positive', badIv.ok === false && !!badIv.error, badIv.error);
  const okIv = bd(await P(BASE, '/v1/autopilot/interval', { sec: 1800 }));
  T('interval accepts 1800', okIv.ok === true && okIv.intervalSec === 1800, 'got=' + okIv.intervalSec);
  const clampLo = bd(await P(BASE, '/v1/autopilot/interval', { sec: 1 }));
  T('interval clamps below MIN to 60', clampLo.ok === true && clampLo.intervalSec === 60, 'got=' + clampLo.intervalSec);
  st = bd(await G(BASE, '/v1/autopilot/status'));
  T('status picks up new interval', st.intervalSec === 60, 'got=' + st.intervalSec);

  // ---- -19 self-heal: optimize / modules fallback ----
  const res = bd(await P(BASE, '/v1/autopilot/resume', {}));
  T('resume returns enabled=true', res.ok === true && res.enabled === true);
  st = bd(await G(BASE, '/v1/autopilot/status'));
  T('resumed engine is scheduled again', st.enabled === true && st.nextInMs > 0 && st.consecFails === 0, 'nextInMs=' + st.nextInMs + ' consecFails=' + st.consecFails);

  // ---- -13 self-heal: optimize / modules fallback ----
  const round = (manual.round || {});
  T('round keeps legacy fields', round.no !== undefined && typeof round.ms === 'number' && !!round.health && Array.isArray(round.done) && Array.isArray(round.advises) && !!round.report && !!round.wheel);
  T('round exposes per-step timings', Array.isArray(round.steps) && round.steps.length > 0 && round.steps.every(s => s.id && s.label && typeof s.ms === 'number' && typeof s.ok === 'boolean'),
    (round.steps || []).map(s => s.id + ':' + (s.ok ? 'ok' : 'fail') + ':' + s.ms + 'ms').join(' '));
  T('round exposes failed/ok counters', typeof round.failed === 'number' && typeof round.ok === 'boolean', 'failed=' + round.failed + ' ok=' + round.ok);
  T('report includes step timing section', typeof round.report === 'string' && round.report.length > 0, String(round.report).slice(0, 80));

  // ---- -5 self-heal: optimize / modules fallback ----
  const lg = bd(await G(BASE, '/v1/autopilot/log?n=5'));
  T('log returns rounds', lg.ok === true && Array.isArray(lg.log) && lg.log.length > 0, 'n=' + (lg.log || []).length);
  const top = (lg.log || [])[0] || {};
  T('persisted round keeps steps', Array.isArray(top.steps) && top.steps.length > 0);

  // ---- 1 self-heal: optimize / modules fallback ----
  const apPath = 'C:/Users/Think/project/BingDashan/core/autopilot.js';
  const ap = require(apPath);
  const stBefore = ap.status();
  // ---- 5 self-heal: optimize / modules fallback ----
  T('status exposes maxConsecFails threshold', stBefore.maxConsecFails >= 1, 'max=' + stBefore.maxConsecFails);
  T('status exposes backoff multiplier', typeof stBefore.backoff === 'number' && stBefore.backoff >= 1, 'backoff=' + stBefore.backoff);
  T('effectiveSec honors backoff', stBefore.effectiveSec === Math.min(86400, stBefore.intervalSec * stBefore.backoff), stBefore.intervalSec + '*' + stBefore.backoff + '=' + stBefore.effectiveSec);

  // ---- 10 self-heal: optimize / modules fallback ----
  const opt = bd(await G(BASE, '/v1/autopilot/optimize'));
  T('optimize still returns advises', opt.ok === true && Array.isArray(opt.advises));
  const mods = bd(await G(BASE, '/v1/autopilot/modules'));
  T('module library still lists modules', mods.ok === true && Array.isArray(mods.modules) && mods.modules.length > 0, 'total=' + mods.total);
  const one = (mods.modules || [])[0];
  const mr = bd(await P(BASE, '/v1/autopilot/modules/' + one.id + '/run', {}));
  T('single module run still works', !!mr && (mr.ok !== false), 'mod=' + one.id);

  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  finish(fail ? 1 : 0);
  })();
  const verdict = await Promise.race([run, done]);
  clearTimeout(doneTimer);   // race 一结束就释放，否则进程要干等到超时点才退
  if (verdict === 'TIMEOUT') { console.log('===== TIMEOUT (suite hung) ====='); process.exit(2); }
})();
