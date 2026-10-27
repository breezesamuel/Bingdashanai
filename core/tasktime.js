// core/tasktime.js — 后台任务耗时登记表
//
// 【2026-09】为什么需要它：loopWatch 只能告诉你"事件循环被堵了 2.5 秒"，
// 却说不出**是谁**堵的。而本项目里会跑后台任务的地方至少有 5 个
// （autopilot / goalpilot / conductor / watchdog / opmods），它们互相调用、还都写库。
// 靠读代码猜"大概是哪个"已经错过两次（一次猜成 zodiac、一次猜成 loopWatch 自己）。
//
// 做法：任何后台任务跑完调一次 record(name, ms)，环形保留最近若干条最慢的。
// 与 loopWatch 互补：loopWatch 说"堵了多久"，本表说"谁干的"。
//
// 零常态开销：只在任务结束时调一次；排序/裁剪放在 report() 里，不放在 record() 里。

const MAX = 60;
const _rows = [];            // { name, ms, at }
const _total = new Map();    // name -> { n, ms, max }

// 超过这个毫秒数才值得记（低于它属于噪声）
const WORTH = 200;

function record(name, ms) {
  const m = Math.round(Number(ms) || 0);
  if (!(m >= WORTH)) return;
  _rows.push({ name: String(name || 'unknown'), ms: m, at: Date.now() });
  if (_rows.length > MAX) _rows.shift();
  const t = _total.get(name) || { n: 0, ms: 0, max: 0 };
  t.n++; t.ms += m; if (m > t.max) t.max = m;
  _total.set(name, t);
}

function report() {
  const totals = [..._total.entries()]
    .map(([name, t]) => ({ name, calls: t.n, totalMs: t.ms, avgMs: Math.round(t.ms / t.n), maxMs: t.max }))
    .sort((a, b) => b.maxMs - a.maxMs);
  return {
    worthMs: WORTH,
    slowRows: _rows.slice().sort((a, b) => b.ms - a.ms).slice(0, 12),
    totals
  };
}

function reset() { _rows.length = 0; _total.clear(); }

module.exports = { record, report, reset, WORTH };
