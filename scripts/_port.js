// scripts/_port.js — E2E 动态端口分配
//
// 为什么需要：原来 goal-e2e-runner 硬编码 3729。端口被占时子进程 spawn 不报错，
// 整套 E2E 会打到一个残留的旧实例上（或整轮卡死），症状是"跑到一半静默消失、
// stderr 全空"，极难定位。改成优先 3729，被占就另取。
//
// 契约：freePort(preferred) -> Promise<number>
//   - preferred 空闲 → 直接返回 preferred（保持日常可复现）
//   - preferred 被占 → 顺延探测，返回一个确定空闲的端口
//   - 永不返回生产端口（3721/3722），与 test/e2e/suites/_guard.js 的闸门对齐：
//     即使 preferred 恰好是生产端口，也必须跳过，绝不让沙箱打到真实实例上。
const net = require('net');

// 与 _guard.js PRODUCTION_PORTS 保持一致：3721 主实例 / 3722 sec-e2e LAN 实例
const PRODUCTION_PORTS = new Set(['3721', '3722']);

function isFree(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    // 探占用后立刻 destroy：这里只要"此刻没人监听"，不需要保持占用。
    // 真正的占用由 runner 里的 spawn server.js 完成，中间存在 TOCTOU 窗口，
    // 已被 runner 的 waitUp() 兜底（拿不到 /v1/status 就直接判失败退出）。
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen({ port, host, exclusive: true });
  });
}

async function freePort(preferred = 3729, { host = '127.0.0.1', tries = 200 } = {}) {
  if (!PRODUCTION_PORTS.has(String(preferred)) && await isFree(preferred, host)) {
    return preferred;
  }
  for (let p = preferred + 1; p < preferred + 1 + tries; p++) {
    if (PRODUCTION_PORTS.has(String(p))) continue;
    if (await isFree(p, host)) return p;
  }
  throw new Error('freePort: ' + tries + ' 次探测仍未找到空闲端口（起于 ' + preferred + '）');
}

module.exports = { freePort, isFree, PRODUCTION_PORTS };