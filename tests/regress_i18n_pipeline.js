// regress_i18n_pipeline.js — 真实翻译管线动态回归（2026-10-24）
//
// 【与 regress_i18n_audit 的分工】
//   audit 是**静态**门禁：index.html 里每条中文都必须有词条（拦"漏配"）。
//   本文件是**动态**回归：把 web/i18n-console.js + web/i18n.js 原样加载进 vm，
//   用**真实的 trSegment 贪心管线**翻一遍，拦"配了词条但翻出来还是夹生"：
//   · 整句词条没被最长优先命中（被更短的词啃碎 → "用邮箱找回Subscribe"）
//   · 单字量词插进中文词内部（"商业In progress枢"——2026-10-24 修的那类）
//   · 驾驶舱词表合并后反而变差（mergeConsole 覆盖方向搞反）
// 【为什么不用浏览器】无头 DOM 桩足够触发同一条代码路径：setLang → applyI18n →
//   mergeConsole → trSegment。翻译正确性只取决于词表与管线，与真实渲染无关。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  [PASS] ' + name); }
  else { failed++; console.log('  [FAIL] ' + name + (detail ? ' — ' + detail : '')); }
}

// ---- 最小 DOM 桩：让 i18n.js 顶层代码加载通过、启动 applyI18n 空转 ----
function fakeEl() {
  return {
    attrs: {}, childNodes: [], nodeValue: '', tagName: 'DIV', nodeType: 1,
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    hasAttribute(n) { return n in this.attrs; },
    removeAttribute(n) { delete this.attrs[n]; },
  };
}
const documentStub = {
  readyState: 'complete',
  childNodes: [],
  documentElement: fakeEl(),
  body: fakeEl(),
  addEventListener() {}, removeEventListener() {},
  querySelectorAll() { return []; },
  getElementById() { return null; },
  createElement() { return fakeEl(); },
};
const windowStub = {
  document: documentStub,
  addEventListener() {}, removeEventListener() {},
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  navigator: { language: 'zh-CN' },
};
windowStub.window = windowStub;

const ctx = vm.createContext({
  window: windowStub, document: documentStub,
  localStorage: windowStub.localStorage, navigator: windowStub.navigator,
  console, setTimeout, clearTimeout,
});
// 先驾驶舱词表、后主引擎 —— 与 index.html 常见顺序一致（mergeConsole 对顺序不敏感，但按真实顺序更可信）
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'i18n-console.js'), 'utf8'), ctx, { filename: 'i18n-console.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'i18n.js'), 'utf8'), ctx, { filename: 'i18n.js' });

const I18N = windowStub.I18N;
const TRANS = I18N.TRANS;
const HAS_CN = /[\u4e00-\u9fa5]/;

console.log('=== i18n 动态管线回归（真实 trSegment）===');

// ---- 1. 驾驶舱词表已合并进主引擎 ----
check('驾驶舱词表已合并（含 🔁 找回订阅整句）', !!TRANS['🔁 换设备了？用邮箱找回订阅']);
check('合并后键量 > 600（console 681 条 + 主表）', Object.keys(TRANS).length > 600, '实际 ' + Object.keys(TRANS).length);

// ---- 2. 本批新词条：真实管线下英文/阿文零夹生 ----
// 来源：index.html 找回订阅面板 + 付款邮箱提示（2026-10-24 补的 9 条整句/片段）
const NEW_KEYS = [
  '🔁 换设备了？用邮箱找回订阅',
  '发送验证码',
  '找回订阅',
  '填了邮箱：付款后自动收到',
  '付款凭证',
  '，换电脑/换浏览器也能用邮箱验证码',
  '（不填则两样都没有）。',
  '付款时填的邮箱',
  '6 位验证码',
  // 顺带守护同面板相邻文案
  '不删除已成交的财务凭证',
  '可选：接收付款凭证与续费提醒的邮箱',
];
for (const k of NEW_KEYS) {
  const tr = TRANS[k];
  check('词条存在且双语齐: ' + k, !!tr && !!tr[0] && !!tr[1], tr ? '缺 ' + (tr[0] ? '' : 'en ') + (tr[1] ? '' : 'ar') : '不存在');
}
check('词表值是 [en, ar] 二元组（历史坑：三元组取错下标 → 全变阿语）',
  !TRANS['🔁 换设备了？用邮箱找回订阅'] || TRANS['🔁 换设备了？用邮箱找回订阅'].length === 2);

I18N.set('en');
for (const k of NEW_KEYS) {
  const out = I18N.trSegment(k);
  check('EN 零夹生: ' + k, !HAS_CN.test(out), '→「' + out + '」');
  check('EN 命中整句词条: ' + k, out === TRANS[k][0], '→「' + out + '」≠「' + TRANS[k][0] + '」');
}
I18N.set('ar');
for (const k of NEW_KEYS) {
  const out = I18N.trSegment(k);
  check('AR 零夹生: ' + k, !HAS_CN.test(out), '→「' + out + '」');
  check('AR 命中整句词条: ' + k, out === TRANS[k][1], '→「' + out + '」≠「' + TRANS[k][1] + '」');
}

// ---- 3. 组合节点：付款邮箱提示在 index.html 里是 4 个相邻文本节点，拼起来要成句 ----
I18N.set('en');
const hintEn = NEW_KEYS.slice(3, 7).map(k => I18N.trSegment(k)).join('');
check('付款邮箱提示 EN 拼句零夹生', !HAS_CN.test(hintEn), '→「' + hintEn + '」');
check('付款邮箱提示 EN 拼句语义完整（含 receipt 与 email code）', /payment receipt/.test(hintEn) && /email code/.test(hintEn), '→「' + hintEn + '」');

// ---- 4. 历史夹生样本守护（单字键规则 + 长词优先）----
const GUARDS = [
  ['商业中枢', 'Business Hub'],   // 曾被啃成「商业In progress枢」
  ['我是丙大山，随时待命 👋', null], // 曾被啃成「我Yes…」
  ['设为焦点并派发任务', null],   // 曾被啃成「设为焦o'clock」
];
I18N.set('en');
for (const [zh, expect] of GUARDS) {
  const out = I18N.trSegment(zh);
  check('历史样本 EN 零夹生: ' + zh, !HAS_CN.test(out), '→「' + out + '」');
  if (expect) check('历史样本 EN 精确: ' + zh, out === expect, '→「' + out + '」≠「' + expect + '」');
}
I18N.set('ar');
for (const [zh] of GUARDS) {
  const out = I18N.trSegment(zh);
  check('历史样本 AR 零夹生: ' + zh, !HAS_CN.test(out), '→「' + out + '」');
}

// ---- 5. 切回中文还原原文（铁律 B：不能卡在外语）----
I18N.set('zh');
check('切回中文后 t() 返回原文', I18N.t('🔁 换设备了？用邮箱找回订阅') === '' ? true : I18N.t('🔁 换设备了？用邮箱找回订阅').indexOf('换设备') >= 0);

console.log(failed ? 'FAILED（动态管线发现夹生 ' + failed + ' 处）' : 'ALL PASS（真实 trSegment 管线：新词条/历史样本 EN+AR 零夹生）');
process.exit(failed ? 1 : 0);
