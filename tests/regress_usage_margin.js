// regress_usage_margin.js — 用量×毛利看板回归（2026-10-23）
//
// 验证：
//   ① 未带管理令牌 → 403（经营数据不得公开）
//   ② 带令牌 → 200，字段齐全
//   ③ 口径诚实：营收不含自测；成本标注覆盖率；note 明确"非财务凭证"
//   ④ 数字自洽：margin = revenue - cost（在四舍五入误差内）
//   ⑤ 端点已登记到收费墙 FLOW_OPS（不成为覆盖率漏网）
'use strict';
require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, n, ex) => {
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + n + (c ? '' : '  -> ' + (ex || '')));
  c ? pass++ : fail++;
};

const PORT = 43000 + Math.floor(Math.random() * 800);
const BASE = 'http://127.0.0.1:' + PORT;

function get(pathname, headers) {
  return fetch(BASE + pathname, { headers: headers || {} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ===== 静态：FLOW_OPS 已登记 =====
  const pw = require(path.join(ROOT, 'core', 'paywall.js'));
  ok((pw.FLOW_OPS || []).some(x => x.ep === 'GET /v1/usage/margin'), '端点已登记到 FLOW_OPS（覆盖率不漏网）');

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { BINGDASHAN_PORT: String(PORT) }),
    stdio: 'ignore',
    windowsHide: true,
  });
  // Windows：让子进程不阻塞事件循环（否则 process.exit 时 libuv 会在
  // async handle 关闭阶段触发断言崩溃，退出码变成 0xC0000409，CI 误判失败）。
  if (srv.unref) srv.unref();

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { const r = await fetch(BASE + '/v1/status'); if (r.ok) { up = true; break; } } catch (e) {}
  }
  if (!up) { console.log('  [FAIL] 服务器未启动'); process.exit(1); }
  ok(true, '服务器已启动 :' + PORT);

  try {
    // ① 无令牌 → 403
    const noTok = await get('/v1/usage/margin');
    ok(noTok.status === 403, '无管理令牌返回 403', '实际 ' + noTok.status);

    // 取管理令牌（rotateAdminToken 返回 {ok, token}；不是裸字符串）
    const subs = require(path.join(ROOT, 'core', 'subs.js'));
    const rot = subs.rotateAdminToken();
    const tok = rot && rot.token;
    ok(!!tok && String(tok).length > 8, '取得管理令牌');

    // ② 带令牌 → 200 + 字段
    const r = await get('/v1/usage/margin?days=30', { 'X-Admin-Token': tok });
    ok(r.status === 200, '带令牌返回 200', '实际 ' + r.status);
    const b = r.body || {};
    ok(b.ok === true, 'ok=true');
    for (const f of ['windowDays', 'revenue', 'cost', 'margin', 'marginRate', 'costKnown', 'byProvider', 'usageToday', 'notes']) {
      ok(b[f] !== undefined, '字段存在: ' + f);
    }
    ok(b.windowDays === 30, 'windowDays 生效', String(b.windowDays));

    // ③ 诚实口径
    ok(b.notes && /估算/.test(b.notes.cost || ''), 'cost.note 明示估算');
    ok(b.notes && /不是财务凭证|非财务凭证/.test(JSON.stringify(b.notes)), 'notes 明示非财务凭证');
    ok(typeof b.pricedCoverage === 'number' || b.pricedCoverage === null, 'pricedCoverage 为数字或 null');
    ok(typeof b.undatedRevenueRows === 'number', 'undatedRevenueRows 有计数（无时间戳行不被静默吞掉）');

    // ④ 数字自洽（仅当成本已知；calls=0 时 margin 必须为 null，不许假报 100%）
    if (b.costKnown === false) {
      ok(b.margin === null && b.marginRate === null, '成本未知时 margin/marginRate 为 null（不许假报毛利）', JSON.stringify({ m: b.margin, r: b.marginRate }));
    } else {
      const diff = Math.abs((Number(b.revenue) - Number(b.cost)) - Number(b.margin));
      ok(diff < 0.01, 'margin = revenue − cost', `diff=${diff}, rev=${b.revenue}, cost=${b.cost}, margin=${b.margin}`);
    }

    // ⑤ 窗口参数边界
    const big = await get('/v1/usage/margin?days=99999', { 'X-Admin-Token': tok });
    ok(big.status === 200 && big.body.windowDays === 365, 'days 上限收敛到 365', String(big.body && big.body.windowDays));

    // ⑥ 报告可如实返回 0 成本（不虚构）
    ok(Number(b.cost) >= 0, 'cost 非负');
  } catch (e) {
    ok(false, '流程异常', String(e && e.message || e));
  } finally {
    try { srv.kill(); } catch (e) {}
    // Windows 上立刻 process.exit 会在子进程 handle 关闭时触发 libuv 断言崩溃，
    // 因此等子进程真正退出再结束（Linux 无此问题，但等待无害）。
    await new Promise(r => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; srv.once('exit', fin); setTimeout(fin, 1500); });
  }

  console.log('pass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  // 不用 process.exit：让事件循环自然退出（Windows 上强制退出会触发 libuv 断言）
  process.exitCode = fail === 0 ? 0 : 1;
})();
