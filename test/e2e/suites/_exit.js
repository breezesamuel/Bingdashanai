// test/e2e/suites/_exit.js — 统一的套件退出方式
//
// 为什么要专门做这个：断言跑完后直接 process.exit(code)，此时 global fetch
// （Node 内部 undici）的 keep-alive 连接池里还有空闲 socket 没关。Windows 上
// 在这个状态下硬退出会让连接池 teardown 崩掉，进程以 0xC0000409
// （STATUS_STACK_BUFFER_OVERRUN）退出 —— 表现是「全部断言 PASS，exit≠0」，
// 而且是间歇性的，极易被误判成偶发网络抖动。
//
// 做法：先关掉全局 dispatcher 让连接池干净收口，再只设 process.exitCode，
// 让事件循环自然排空后退出。绝不在还有句柄时硬退。

function closeDispatcher() {
  // Node 未公开 undici 全局 dispatcher，用 symbol 定位（Node 18+ 稳定）
  const syms = Object.getOwnPropertySymbols(globalThis);
  const key = syms.find(s => String(s).toLowerCase().indexOf('undici') >= 0
    && String(s).toLowerCase().indexOf('dispatcher') >= 0);
  const d = key ? globalThis[key] : null;
  return d && typeof d.close === 'function' ? d.close() : Promise.resolve();
}

// 正常结束：code 0 或 1
function finish(code) {
  return closeDispatcher().catch(() => {}).then(() => {
    process.exitCode = code || 0;
    // 【为什么要补这个兜底】原实现只设 exitCode，等事件循环自然排空。
    // 但只要**还有一个句柄没关**（模块里遗留的 setInterval、没 close 的
    // server、未 resolve 的 promise），进程就永远不会退出——而断言早就全 PASS 了。
    // 实测踩过：autopilot-e2e / autoloop-e2e 打印「34 PASS / 0 FAIL」之后
    // 挂住不动，E2E 整轮卡在那里，只能从外部把进程树掐断；掐断后
    // stderr 全空、只留下半截日志，极难判断到底是超时还是被中断。
    //
    // 这里加一个"宽限期后强制退"的兜底：
    //   · unref → 自己不阻止退出。有别的句柄挂着时它照样会到点触发；
    //     真的能自然排空时它永远不会触发，行为与原来完全一致。
    //   · 2s 宽限是为了让 undici 连接池干净 teardown，避开上面说的 0xC0000409。
    const guard = setTimeout(() => {
      try { process.exit(process.exitCode || 0); } catch (e) {}
    }, 2000);
    if (typeof guard.unref === 'function') guard.unref();
  });
}

// 需要硬退的兜底（仅用于 hang/启动失败，句柄状态已不可控）
function bail(code) {
  process.exit(code === undefined ? 1 : code);
}

module.exports = { finish, bail, closeDispatcher };
