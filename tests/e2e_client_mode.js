// e2e_client_mode.js — 桌面/移动壳（exe/apk）打包前契约冒烟（2026-10-25）
//
// CLIENT_MODE（桌面壳注入 BINGDASHAN_CLIENT=1）的三条生死线：
//   ① 墙强制开启：即使 paywallOn 未开，重耗分区也必须 402（下载版不能免费白用）；
//   ② 运营端点封锁：toggle/confirm/rotate/reset 在壳内 403（买家不能自己关墙）；
//   ③ 支付链可用：plans/order/checkout/free-trial 全通（壳内真实收款不受影响）。
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const http = require('http'); const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
let PORT = 0, fail = 0, pass = 0;
const ok = (c, l, e) => { pass += c ? 1 : 0; fail += c ? 0 : 1; console.log((c ? '  [PASS] ' : '  [FAIL] ') + l + (!c && e !== undefined ? ' -> ' + JSON.stringify(e).slice(0, 200) : '')); };
const req = (m, p, b) => new Promise(r => {
  const d = b ? Buffer.from(JSON.stringify(b)) : null;
  const q = http.request({ host: '127.0.0.1', port: PORT, path: p, method: m, headers: { 'content-type': 'application/json' } }, res => {
    let s = ''; res.on('data', c => s += c);
    res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} r({ status: res.statusCode, body: j }); });
  });
  q.on('error', () => r({ status: 0, body: null })); if (d) q.write(d); q.end();
});
(async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-cm-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { BINGDASHAN_DATA_DIR: DATA, BINGDASHAN_PORT: '0', BINGDASHAN_CLIENT: '1', NODE_ENV: 'test' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('boot timeout')), 30000);
    const on = d => { buf += d; const m = /listening http:\/\/([0-9.]+):(\d+)/.exec(buf); if (m) { clearTimeout(t); PORT = +m[2]; res(); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
  });
  console.log('=== 桌面壳（CLIENT_MODE）打包前契约 ===');
  // ① 墙强制：paywallOn 从未开启
  for (let i = 0; i < 7; i++) await req('GET', '/v1/agents');   // 烧完 agent 日池 6 次
  const w = await req('GET', '/v1/agents');
  ok(w.status === 402, '① 墙强制开启：paywallOn 未设仍 402（第 7 次）', { status: w.status });
  ok(w.body && w.body.wall === true && w.body.plans && w.body.plans.CN, '① 402 契约完整（wall/plans 供壳内弹墙）', w.body);
  ok(w.body && w.body.trialAvail === true, '① 402 带免费试用资格位（壳内也能领 2 天）', w.body && w.body.trialAvail);
  // ② 运营端点封锁
  const tg = await req('POST', '/v1/paywall/toggle', { on: false });
  ok(tg.status === 403, '② 运营关墙端点在壳内 403（买家不能自己免费用）', { status: tg.status });
  // ③ 支付链可用
  const pl = await req('GET', '/v1/plans');
  ok(pl.status === 200 && pl.body && pl.body.plans && pl.body.plans.CN && pl.body.plans.CN.length >= 5, '③ /v1/plans 套餐可读', pl.body);
  const od = await req('POST', '/v1/subs/order', { plan: 'm', lang: 'zh' });
  ok(od.status === 200 && od.body && od.body.ok && od.body.order && od.body.order.id, '③ 下单成功（月卡）', od.body);
  const ck = await req('POST', '/v1/pay/checkout', { orderId: od.body.order.id, currency: 'CNY' });
  ok(ck.status === 200 && ck.body && ck.body.ok, '③ checkout 出付款指引（收款码兜底）', ck.body);
  const ft = await req('POST', '/v1/subs/free-trial');
  ok(ft.status === 200 && ft.body && ft.body.ok === true && ft.body.days === 2, '③ 免费试 2 天壳内可领', ft.body);
  const after = await req('GET', '/v1/agents');
  ok(after.status !== 402, '③ 试用生效后重耗分区放行', { status: after.status });
  child.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  console.log('pass=' + pass + ' fail=' + fail);
  console.log(fail ? 'FAILED' : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E ERROR', e); console.log('FAILED'); process.exit(1); });
