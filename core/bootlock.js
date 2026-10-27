// core/bootlock.js — 进程级启动锁 + 后台定时器台账
//
// 【为什么必须挂在 globalThis】
// Electron 桌面壳（electron/main.cjs）在服务失活时会 `delete require.cache` 后重新
// require server.js。模块级的 `let timer` / `if (timer) return` 守卫只活在**单次模块实例**里，
// 缓存一删就失忆 —— 旧实例的 setInterval 还在跑，新实例又起一套，最终双重扣费/双重推进。
// globalThis 在同一进程内跨 require 缓存删除存活，把锁与定时器句柄放这里才挡得住重载。
//
// 用法：
//   boot() 首行：const bootlock = require('./bootlock'); if (!bootlock.claim('goalpilot')) return;
//   起定时器：  bootlock.interval(fn, ms)   （等价 setInterval，但句柄进台账）
//   重载前：    bootlock.resetAll()          （清掉所有登记定时器 + 释放全部锁，再 re-require）
const KEY = '__bdBootlockV1';

function reg() {
  if (!globalThis[KEY]) {
    globalThis[KEY] = { claims: Object.create(null), timers: new Set() };
  }
  return globalThis[KEY];
}

// 认领启动权：同一进程内同名只认第一次。返回 true=本次应启动；false=已有实例在跑，必须直接返回。
function claim(name) {
  const r = reg();
  if (r.claims[name]) return false;
  r.claims[name] = Date.now();
  return true;
}

function release(name) {
  try { delete reg().claims[name]; } catch (e) {}
}

// 句柄台账：登记后才能被 resetAll 清掉
function track(t) { try { reg().timers.add(t); } catch (e) {} return t; }
function untrack(t) { try { reg().timers.delete(t); } catch (e) {} }

// 带台账的 setInterval（与原生签名一致）
function interval(fn, ms) {
  const t = setInterval(fn, ms);
  if (t && t.unref) { /* 不主动 unref：语义与原生保持一致，由各调用点自行决定 */ }
  return track(t);
}

// 暴力重载前的唯一安全入口：清掉所有登记定时器 + 释放全部启动锁。
// 之后 re-require server.js 才会得到"干净的一套"，而不是与旧实例叠加。
function resetAll() {
  const r = reg();
  for (const t of r.timers) {
    try { clearInterval(t); } catch (e) {}
    try { clearTimeout(t); } catch (e) {}
  }
  r.timers.clear();
  r.claims = Object.create(null);
}

// 只读诊断：哪些模块持锁、台账里有多少定时器
function status() {
  const r = reg();
  return { claims: Object.assign({}, r.claims), timers: r.timers.size };
}

module.exports = { claim, release, track, untrack, interval, resetAll, status };
