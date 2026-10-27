// regress_quota_toast.js — 402 额度提示的两类 bug 回归（2026-10-22）
// 背景：真实客户遇到连环弹窗轰炸：
//   ① 「decision」quotaDailyDone (10/10) quotaDailyHint——文案键名被原样显示。
//      根因：hookWall 用 PT（查 PL 收银台词典）取 quota* 键，而键只在 I18N 里有 → 兜底显示键名。
//      本回归读源码断言：PL.zh / PL.en / PL.ar 三语都必须包含全部 quota* 键。
//   ② 同一分区每 5 秒重复弹同一条 toast（连轰）。
//      根因：每条 402 都独立 toast，没有节流。
//      本回归用 jsdom 式手写 DOM stub 跑 hookWall，断言：同分区 90s 只 toast 一次；
//      5s 窗口内不同分区合并成一条。
'use strict';
const fs = require('fs');
const path = require('path');
const VM = require('vm');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + name + (cond ? '' : '  -> ' + (extra || '')));
  if (cond) pass++; else fail++;
};

const bizPath = path.join(__dirname, '..', 'web', 'biz.js');
const src = fs.readFileSync(bizPath, 'utf8');

// ===== 1. 静态断言：PL 三语词典都有 quota* 键 =====
const plBlock = src.slice(src.indexOf('const PT ='), 0); // unused placeholder
const plIdx = src.indexOf('const PL = {');
const ptIdx = src.indexOf("const PT =");
const PL_SRC = src.slice(plIdx, ptIdx);   // PL 定义区（含三语对象主体）

for (const key of ['quotaDailyDone', 'quotaDailyHint', 'quotaFreeHead', 'quotaHeavyTag', 'quotaUnlimitedTag', 'quotaTrialTag']) {
  // 每个键至少出现 3 次（zh/en/ar 各一次）
  const count = (PL_SRC.match(new RegExp(key + ':', 'g')) || []).length;
  ok(count >= 3, 'PL 词典三语包含 ' + key, '出现 ' + count + ' 次（需要 ≥3）');
}

// hookWall 里不再直接用原始键名字符串拼接
ok(!/quotaDailyDone'\)/.test(src) || /PT\('quotaDailyDone'\)/.test(src), 'hookWall 使用 PT() 取文案');

// ===== 2. 动态断言：hookWall 节流逻辑 =====
// 手写最小 DOM stub 跑 biz.js 的 hookWall 相关代码——不求全渲染，只验证节流行为。
function runHookWall() {
  const toasts = [];
  const timers = [];
  let seq = 0;
  function makeCtx() {
    const origFetch = async (url, init) => ({
      status: Number(url.json402 || 402), ok: false, headers: null,
      clone() { return this; },
      json: async () => url.body
    });
    const sandbox = {
      document: {
        querySelector: () => null, documentElement: { lang: 'zh' },
        addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, remove() {} }),
      },
      fetch: origFetch,
      Headers: function (init) { Object.assign(this, init || {}); },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      location: { search: '' }, navigator: { language: 'zh', userAgent: 'x' },
      performance: { now: () => Date.now() - 0 },
      setTimeout: (fn, ms) => { timers.push({ fn, ms, id: ++seq }); return seq; },
      clearTimeout: (id) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
      setInterval: () => 1, clearInterval() {}, Date, JSON, Object, Math, encodeURIComponent, decodeURIComponent, escape, unescape,
      URLSearchParams: class { get() { return null; } },
      console, Promise, Error, String, Number, Boolean, Array, RegExp, Function,
      _toastWrap_toasts: toasts
    };
    sandbox.Headers.prototype.set = function () {};
    sandbox.Headers.prototype.get = function (k) { return this[k]; };
    sandbox.window = sandbox;
    return new VM.createContext(sandbox);
  }
  return { toasts, timers, makeCtx };
}

const harness = (() => {
  const { toasts, timers, makeCtx } = runHookWall();
  // biz.js 里 hookWall 是内嵌 IIFE；直接整体 eval 太重（依赖 DOM），这里只抽出两个函数体执行。
  // 取 hookWall 源码段
  const m = src.match(/function hookWall\(\) \{[\s\S]*?\n  \}/);
  if (!m) { ok(false, 'hookWall 源码可提取'); return done(); }
  const hookSrc = m[0];
  const ctx = makeCtx();
  // 提供测试内需要的自由变量：PT / toast / showWall / vid
  ctx.PT = k => ({ 'quotaDailyDone': '今日此功能额度已用完', 'quotaDailyHint': '明日自动恢复；也可升级更高套餐。', 'quotaEachUsedUp': '（每项额度已用完）', 'quotaSecQuote': '「{s}」', 'quotaSecJoin': '、' }[k] || '[[' + k + ']]');
  // 2026-10-23：toast 的分区名改用 PTf 模板（三语括号），沙箱需同步提供
  ctx.PTf = (k, vars) => ctx.PT(k).replace(/\{(\w+)\}/g, (m, x) => (vars && vars[x] !== undefined) ? vars[x] : m);
  ctx.toast = (msg, kind, ms) => { toasts.push({ msg, kind, ms }); };
  ctx.showWall = () => {};
  ctx.vid = () => 'vtest';
  VM.createContext(ctx);
  try {
    VM.runInContext(hookSrc + '\ntry { hookWall(); } catch(e) { throw e; }', ctx);
  } catch (e) {
    ok(false, 'hookWall 可执行', String(e && e.stack || e).slice(0, 300));
    return done();
  }
  ok(true, 'hookWall 可执行');

  const ctxW = ctx; // sandbox is its own global
  const send402 = async (section) => {
    try {
      return await ctxW.window.fetch({ json402: 402, body: { ok: false, code: 402, wall: true, section, used: 10, quota: 10, unlimited: true } });
    } catch (e) { return { err: e }; }
  };
  const flushTimers = async () => {
    while (timers.length) {
      const t = timers.shift();
      await t.fn();
    }
  };

  done();
  function done() {
    (async () => {
      try {
        // ① 同分区 90s 只提示一次：连发 5 条 decision 402 → 合并窗口结束后只 1 条
        await send402('decision');
        await send402('decision');
        await send402('decision');
        await flushTimers();
        const decisionCount = toasts.filter(t => t.msg.includes('decision')).length;
        ok(decisionCount === 1, '同分区(90s)连环 402 只弹 1 条', '实际 ' + decisionCount + ' 条：' + toasts.map(t => t.msg).join(' | '));

        // ② 文案不是键名：toast 文本包含真实文案、不包含 quotaDailyDone/quotaDailyHint
        const msg = toasts.map(t => t.msg).join(' | ');
        ok(!msg.includes('quotaDailyDone') && !msg.includes('quotaDailyHint'), 'toast 文案无键名泄漏', msg.slice(0, 120));
        ok(msg.includes('今日此功能额度已用完'), 'toast 显示真实文案', msg.slice(0, 120));
        ok(msg.includes('(10/10)') || msg.includes('（10/10）'), 'toast 带用量额度', msg.slice(0, 120));

        // ③ 5s 窗口内不同分区合并成一条
        toasts.length = 0;
        timers.length = 0;
        await send402('agent');
        await send402('decision');   // 已在 90s 静默期 → 不新增
        await send402('evolve');
        await flushTimers();
        const mergedCount = toasts.length;
        ok(mergedCount === 1, '5s 窗口不同分区合并为 1 条', '实际 ' + mergedCount + ' 条');
        ok((toasts[0] && toasts[0].msg.includes('「evolve」') && toasts[0].msg.includes('「agent」')), '合并 toast 同时列出分区', (toasts[0] && toasts[0].msg || '').slice(0, 200));

        // ④ 静默期后重提可再次提示（不再永久静默）
        toasts.length = 0; timers.length = 0;
        // 时间倒流 91 秒（伪造时机）：把 _qtAt 里的时间戳都调早
        ctxW.Date = { now: () => Date.now() + 91000, };
        await send402('decision');
        await flushTimers();
        const again = toasts.length;
        ok(again === 1, '90s 静默期过后可再次提示', '实际 ' + again + ' 条');

        // ⑤ 多分区合并文案：不再只显示第一个分区的 used/quota
        toasts.length = 0; timers.length = 0;
        await send402('agent');
        await flushTimers();
        const merged = toasts.filter(t => t.msg.includes('agent'));
        ok(merged.length === 1 && merged[0].msg.includes('10/10'), '单分区合并保留具体用量', merged[0] && merged[0].msg);

        finish();
      } catch (e) {
        ok(false, '流程异常', String(e && e.stack || e).slice(0, 400));
        finish();
      }
    })();

    function finish() {
      console.log('pass=' + pass + ' fail=' + fail);
      console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
      process.exit(fail === 0 ? 0 : 1);
    }
  }
})();
