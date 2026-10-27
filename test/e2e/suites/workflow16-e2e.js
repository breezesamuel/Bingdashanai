// workflow16-e2e.js — 16 工作流编排器（30s/轮全链路自动化）
// 验证：POST /v1/workflow16/run 返回 16/16 全 success，单轮 ≤ 30s，连续 3 轮无失败
// GET /v1/workflow16 返回状态包含 history、last、roundId

const { finish } = require('./_exit');
const { requireIsolated } = require('./_guard');
const http = require('http');
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const store = require(ROOT + '/core/store');
const BASE = requireIsolated('workflow16-e2e');
const ADMIN = process.env.BINGDASHAN_ADMIN_TOKEN || '';

let pass = 0, fail = 0;
function T(name, ok, extra) {
  ok ? pass++ : fail++;
  const line = (ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' . ' + extra : '');
  console.log(line);
}
function req(method, path, body) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (ADMIN) h['X-Admin-Token'] = ADMIN;
    const r = http.request(BASE + path, { method, headers: h }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
        try { res({ code: resp.statusCode, body: JSON.parse(d) }); }
        catch (e) { res({ code: resp.statusCode, body: { raw: d } }); }
      });
    });
    r.on('error', e => res({ code: 0, body: { error: e.message } }));
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const snap = JSON.stringify(store.read());
  try {
    // ── 1. 单轮 16/16 通过，≤30s ──
    const r1 = await req('POST', '/v1/workflow16/run');
    T('workflow16 single round 16/16 success', r1.body && r1.body.ok === true && r1.body.pass === 16 && r1.body.fail === 0, 'roundId=' + (r1.body && r1.body.roundId) + ' dur=' + (r1.body && r1.body.totalDur));
    T('workflow16 round within 30s', r1.body && r1.body.totalDur <= 30000, 'dur=' + (r1.body && r1.body.totalDur));

    // ── 2. 连续 3 轮全通过 ──
    const r2 = await req('POST', '/v1/workflow16/run');
    const r3 = await req('POST', '/v1/workflow16/run');
    T('workflow16 round 2 16/16', r2.body && r2.body.ok === true && r2.body.pass === 16 && r2.body.fail === 0, 'dur=' + (r2.body && r2.body.totalDur));
    T('workflow16 round 3 16/16', r3.body && r3.body.ok === true && r3.body.pass === 16 && r3.body.fail === 0, 'dur=' + (r3.body && r3.body.totalDur));

    // ── 3. 状态端点包含 history/last/roundId ──
    const st = await req('GET', '/v1/workflow16');
    T('workflow16 status has history', st.body && st.body.ok === true && Array.isArray(st.body.history) && st.body.history.length >= 3, 'hist=' + (st.body && st.body.history?.length));
    T('workflow16 status last round 16/16', st.body && st.body.last && st.body.last.pass === 16 && st.body.last.fail === 0, 'last=' + JSON.stringify(st.body?.last).slice(0,200));
    T('workflow16 status roundId increments', st.body && st.body.roundId === 3, 'roundId=' + (st.body && st.body.roundId));

    // ── 4. boot/stop 端点可用（可选）──
    const boot = await req('POST', '/v1/workflow16/boot');
    T('workflow16 boot endpoint ok', boot.body && boot.body.ok === true);
    const stop = await req('POST', '/v1/workflow16/stop');
    T('workflow16 stop endpoint ok', stop.body && stop.body.ok === true);

  } finally {
    try { store.write(JSON.parse(snap)); } catch (e) {}
  }
  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  finish(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); finish(1); });