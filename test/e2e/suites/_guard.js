// test/e2e/suites/_guard.js — 生产数据保护闸门
//
// 为什么需要：这些套件默认 BASE=127.0.0.1:3721，而 3721 就是生产/开发实例的真实端口。
// 直接 `node war-e2e.js` 会把测试数据（假订单、假营收、假线索、MCP key、报告…）
// 写进真实 data/db.json，还会轮换生产 adminToken、清空生产 visitors。
// 历史上已造成 ~190 条污染记录（含 45 条假营收，直接虚增 KPI 与推广池余额）。
//
// 规则：会写库的套件必须显式指定 BINGDASHAN_E2E_BASE（由 goal-e2e-runner 注入的沙箱实例）。
// 未指定 → 直接退出并报错，绝不猜端口、绝不落到生产。
const PRODUCTION_PORTS = ['3721', '3722']; // 3721 主实例 / 3722 sec-e2e 的 LAN 实例

function requireIsolated(suiteName) {
  const base = process.env.BINGDASHAN_E2E_BASE;
  if (!base) {
    console.error('ABORT ' + suiteName + '：未设置 BINGDASHAN_E2E_BASE。');
    console.error('本套件会写库，禁止指向生产实例。请通过 npm test（goal-e2e-runner）运行，');
    console.error('它会拉起隔离沙箱（临时数据目录 + 专用端口 3729）。');
    process.exit(2);
  }
  let port = '';
  try { port = new URL(base).port || String(Number(new URL(base).port || 0)); } catch (e) {}
  if (PRODUCTION_PORTS.includes(port)) {
    console.error('ABORT ' + suiteName + '：BINGDASHAN_E2E_BASE 指向生产端口 ' + port + '，拒绝执行。');
    console.error('请通过 npm test（goal-e2e-runner）运行，它使用临时数据目录与专用端口。');
    process.exit(2);
  }
  return base;
}

module.exports = { requireIsolated, PRODUCTION_PORTS };
