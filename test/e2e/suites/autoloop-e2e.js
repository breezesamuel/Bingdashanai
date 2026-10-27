// test/e2e/suites/autoloop-e2e.js — 自主运营循环的步预算与启停
//
// 回归重点（真实踩过的坑）：
//   单轮预算 MAX_TICK 曾拿 done.length（各步输出的文本行数）来比，
//   而 collect 常返回 3-4 行（源不可达 + 热点），于是 modules 跑完就 >=5 而 break，
//   acquire（获客，唯一能带来客户的步骤）在 66 轮里只执行过 1 次。
//   正确口径是「已执行步数」。本套件实跑一轮，验证 acquire 不再被饿死。
//
// 与 autopilot-e2e.js 的分工：那个测业务产物，这个测循环本身的调度语义。
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const { finish } = require('./_exit');
const store = require(ROOT + '/core/store');
const ap = require(ROOT + '/core/autopilot');

let pass = 0, fail = 0; const failures = [];
function T(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? ' . ' + detail : '')); }
  else { fail++; failures.push(name); console.log('FAIL ' + name + (detail ? ' . ' + detail : '')); }
}

(async () => {
  let doneTimer;
  const done = new Promise(r => { doneTimer = setTimeout(r, 240000, 'TIMEOUT'); });
  const run = (async () => {
    const n0 = (store.read().autopilot || []).length;
    try {
      // ── 步注册表 ─────────────────────────────────────────
      const steps = ap.steps();
      T('step registry non-empty', steps.length >= 5, 'n=' + steps.length);
      T('acquire step is registered', steps.some(s => s.id === 'acquire'), JSON.stringify(steps.map(s => s.id)));
      T('every step has id and label', steps.every(s => !!s.id && !!s.label));

      // ── 节奏钳制：防止把外部源打爆 ───────────────────────
      const fast = ap.setIntervalSec(5);
      T('interval clamped up to MIN 60s', fast.intervalSec === 60, 'got ' + fast.intervalSec);
      const slow = ap.setIntervalSec(999999);
      T('interval clamped down to MAX 86400s', slow.intervalSec === 86400, 'got ' + slow.intervalSec);
      ap.setIntervalSec(900);

      // ── 启停语义 ─────────────────────────────────────────
      ap.pause('autoloop-e2e 探针');
      T('pause disables autopilot', ap.status().enabled === false);
      const skipped = await ap.runOnce();
      T('paused runOnce skips instead of running', skipped && skipped.skipped === true, 'reason=' + (skipped && skipped.reason));
      T('paused runOnce wrote no round', (store.read().autopilot || []).length === n0);
      T('resume re-enables', ap.resume('autoloop-e2e 探针').ok === true);

      // ── 核心回归：单轮所有步骤都轮到 ──────────────────────
      // 沙箱里 server 的 autopilot 也在跑轮次，runOnce 有并发闸门会返回 skipped。
      // 必须轮询等真实轮次落地，不能只判一次（否则必然假失败）。
      const before = (store.read().autopilot || []).length;
      let r = await ap.runOnce();
      let rows = store.read().autopilot || [];
      for (let w = 0; w < 20 && rows.length === before; w++) {
        await new Promise(x => setTimeout(x, 3000));
        r = await ap.runOnce();
        rows = store.read().autopilot || [];
      }
      T('runOnce executed a round', rows.length > before, 'skipped=' + !!r.skipped + ' delta=' + (rows.length - before));
      if (rows.length > before) {
        const ids = (rows[0].steps || []).map(s => s.id);
        T('REGRESSION: acquire not starved by verbose output', ids.indexOf('acquire') >= 0, '[' + ids.join(',') + ']');
        T('REGRESSION: all 6 registered steps ran', ids.length >= 6, 'ran ' + ids.length + ': [' + ids.join(',') + ']');
        T('optimize stays out of the registry loop', ids.indexOf('optimize') < 0);
        T('round recorded duration', typeof rows[0].ms === 'number' && rows[0].ms > 0, 'ms=' + rows[0].ms);
        T('each step records ok/err for isolation', (rows[0].steps || []).every(s => 'ok' in s && 'err' in s));
      }
      T('roundNo advanced', ap.status().roundNo > 0, 'roundNo=' + ap.status().roundNo);
      T('log readable', Array.isArray(ap.log(5)) && ap.log(5).length >= 1);

      // ── 断网兜底：外部源全不可达时仍要产出，且不能熔断停机 ──
      // collect() 原来三个源各自吞异常、从不抛，导致 collectStep.ok 恒为 true，
      // 降级/退避/熔断永远不触发 —— 断网时系统照样报「成功」。
      const intel = require(ROOT + '/core/intel');
      const skilllib = require(ROOT + '/core/skilllib');
      const oH = intel.headlines, oS = skilllib.invokeSkill;
      const db0 = store.read();
      const bakIntel = (db0.intel || []).slice();
      try {
        // 塞一条「此刻」的缓存，确保兜底有可用数据（用真实时间戳，不伪造）
        const d = store.read();
        d.intel = [{ q: 'e2e 探针缓存', a: '离线兜底探针', createdAt: Date.now() }].concat(bakIntel);
        store.write(d);
        intel.headlines = async () => { throw new Error('ENOTFOUND e2e 模拟断网'); };
        skilllib.invokeSkill = async () => { throw new Error('ETIMEDOUT e2e 模拟断网'); };

        const off = await ap.runOnce({ manual: true });
        const cs = (off.steps || []).find(s => s.id === 'collect');
        T('offline: round still completed all steps', (off.steps || []).length >= 6, 'ran ' + (off.steps || []).length);
        T('offline: collect flagged offline (not silently ok)', !!(cs && cs.offline === true), 'offline=' + (cs && cs.offline));
        T('offline: fallback reused cached intel', (cs.out || []).some(x => /离线兜底.*复用情报库缓存 [1-9]/.test(String(x))));
        T('offline: fallback reports real age, no fabrication', (cs.out || []).some(x => /小时前/.test(String(x))));
        T('offline: engine did NOT self-pause', ap.status().enabled === true, 'enabled=' + ap.status().enabled);
        T('offline: status surfaces offline=true', ap.status().offline === true);
        T('offline: backoff slows cadence but stays under 1h', ap.status().effectiveSec > 0 && ap.status().effectiveSec <= 3600, 'effectiveSec=' + ap.status().effectiveSec);
        T('offline: other steps still produced output', (off.done || []).length > 3, 'lines=' + (off.done || []).length);

        // 断网 + 无缓存 → 真正无事可做，才允许计入熔断
        const d2 = store.read(); d2.intel = []; store.write(d2);
        const bare = await ap.runOnce({ manual: true });
        const cs2 = (bare.steps || []).find(s => s.id === 'collect');
        T('offline+no cache: collect honestly fails', !!(cs2 && cs2.ok === false), 'err=' + (cs2 && cs2.err));
        T('offline+no cache: error names the real reason', /不可达/.test(String(cs2 && cs2.err || '')));
        ap.resume('e2e 探针结束');
      } finally {
        intel.headlines = oH; skilllib.invokeSkill = oS;
        const d3 = store.read(); d3.intel = bakIntel; store.write(d3);
      }
    } finally {
      const d = store.read();
      d.autopilot = (d.autopilot || []).slice(0, n0);
      store.write(d);
    }
  })();
  const r = await Promise.race([run, done]);
  clearTimeout(doneTimer);   // race 一结束就释放，否则进程要干等到超时点才退
  if (r === 'TIMEOUT') { fail++; failures.push('TIMEOUT'); console.log('TIMEOUT'); }
  console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  if (fail) { console.error('FAILED: ' + failures.join(', ')); process.exit(1); }
  finish(fail ? 1 : 0);
})();
