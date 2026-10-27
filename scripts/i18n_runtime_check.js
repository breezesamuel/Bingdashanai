#!/usr/bin/env node
'use strict';
// scripts/i18n_runtime_check.js — 驾驶舱（index.html）i18n **运行时**回归测试
//
// 与 scripts/i18n_audit.js（静态审计：扫 HTML 判定"有没有词"）互补：
// 本脚本真的把 web/i18n-console.js + web/i18n.js 跑起来（迷你 DOM），断言
//   1) 词表确实被 i18n.js 惰性合并进 TRANS（mergeConsole 生效）；
//   2) 文本节点走 trSegment 后 = [en]/[ar]，且无中文残留；
//   3) placeholder/title/alt/aria-label 走 trAttrs 后 = [en]/[ar]，且无中文残留；
//   4) 切回 zh 后**逐字还原**为原文（铁律 B：切语言必须可还原）；
//   5) 再切回 en 结果与首次一致（幂等）。
// 任何一项失败 → 退出码非 0，可作 CI 门禁。
//
// 为什么需要它：静态审计发现不了"脚本没引、mergeConsole 没调、trAttrs 写错"这类**接线**问题，
// 而这一层恰恰是"代码改了但界面没变"的高发区。

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const CJK = /[\u4e00-\u9fa5]/;

function decodeEnt(s) {
  return String(s).replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

// ── 迷你 DOM（只实现 i18n.js 用到的子集）────────────────────────────────────
class TNode { constructor(v) { this.nodeType = 3; this.nodeValue = String(v); this.parentNode = null; } }
class ENode {
  constructor(tag) {
    this.nodeType = 1; this.tagName = String(tag).toUpperCase();
    this.childNodes = []; this._attrs = Object.create(null); this.parentNode = null;
    this.id = ''; this.value = ''; this._html = '';
  }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n); }
  getAttribute(n) { return this.hasAttribute(n) ? this._attrs[n] : null; }
  setAttribute(n, v) { this._attrs[n] = String(v); if (n === 'id') this.id = String(v); }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  get textContent() { return this.childNodes.map(c => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join(''); }
  set textContent(v) { this.childNodes = []; if (v !== '') this.appendChild(new TNode(v)); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.childNodes = []; }
  querySelectorAll(sel) { return descendants(this).filter(el => matchesAny(el, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function descendants(root) {
  const out = [];
  (function rec(n) { for (const c of (n.childNodes || [])) if (c.nodeType === 1) { out.push(c); rec(c); } })(root);
  return out;
}
function matches(el, sel) {
  sel = sel.trim();
  if (sel === '*') return true;
  if (sel[0] === '#') return el.id === sel.slice(1);
  if (sel[0] === '[') {
    const m = /^\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(sel);
    if (!m) return false;
    return m[2] === undefined ? el.hasAttribute(m[1]) : el.getAttribute(m[1]) === m[2];
  }
  return el.tagName === sel.toUpperCase();
}
function matchesAny(el, sel) { return sel.split(',').map(s => s.trim()).filter(Boolean).some(s => matches(el, s)); }

function makeDocument() {
  const documentElement = new ENode('html');
  documentElement.appendChild(new ENode('head'));
  const body = new ENode('body');
  documentElement.appendChild(body);
  const doc = {
    readyState: 'complete', documentElement, body, childNodes: [documentElement],
    addEventListener: () => {},
    querySelector: s => descendants(doc).filter(el => matchesAny(el, s))[0] || null,
    querySelectorAll: s => descendants(doc).filter(el => matchesAny(el, s)),
    createTreeWalker: undefined
  };
  return doc;
}

const readWeb = f => fs.readFileSync(path.join(WEB, f), 'utf8');

function main() {
  const doc = makeDocument();
  const g = {
    console, localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '' }, navigator: { language: 'zh' }, document: doc, MutationObserver: undefined
  };
  g.window = g;
  vm.createContext(g);
  vm.runInContext(readWeb('i18n-console.js'), g, { filename: 'i18n-console.js' });
  vm.runInContext(readWeb('i18n.js'), g, { filename: 'i18n.js' });
  const M = g.__CONSOLE_I18N__ || {};
  const I18N = g.I18N;

  const fails = [];
  if (!Object.keys(M).length) fails.push('web/i18n-console.js 未导出 window.__CONSOLE_I18N__（或为空）');
  if (!I18N || typeof I18N.set !== 'function') { fails.push('web/i18n.js 未导出 window.I18N.set'); return finish(fails, 0, 0); }

  // 每一项：kind=text 放独立文本节点；kind=attr 放带该属性的元素。orig 为中文原文。
  const items = [];
  for (const k of Object.keys(M)) {
    const span = new ENode('span'); const tn = new TNode(k);
    span.appendChild(tn); doc.body.appendChild(span);
    items.push({ kind: 'text', tn, name: null, orig: k, label: 'TEXT ' + JSON.stringify(k.slice(0, 24)) });
  }
  const html = readWeb('index.html').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, '');
  const tagFor = { placeholder: 'input', title: 'div', alt: 'img', 'aria-label': 'button' };
  const seen = new Set();
  let am; const are = /\b(placeholder|title|alt|aria-label)\s*=\s*"([^"]*)"/gi;
  while ((am = are.exec(html))) {
    const name = am[1].toLowerCase(); const val = decodeEnt(am[2]);
    const sig = name + '\u0000' + val; if (seen.has(sig)) continue; seen.add(sig);
    if (!(val in M)) continue;                      // data-i18n-* 钩子走另一条路，这里只测自动路径
    const el = new ENode(tagFor[name] || 'div'); el.setAttribute(name, val); doc.body.appendChild(el);
    items.push({ kind: 'attr', el, name, orig: val, label: 'ATTR ' + name + '=' + JSON.stringify(val.slice(0, 24)) });
  }

  const got = it => (it.kind === 'text' ? it.tn.nodeValue : it.el.getAttribute(it.name));
  const want = (it, phase) => {
    if (phase === 'zh') return it.orig;
    const v = M[it.orig]; return v ? (phase === 'ar' ? v[1] : v[0]) : it.orig;
  };
  const cjkExpected = phase => (phase === 'zh' ? items.filter(it => CJK.test(it.orig)).length : 0);

  function run(phase) {
    I18N.set(phase === 'zh' ? 'zh' : phase);
    let bad = 0, cjk = 0; const samples = [];
    for (const it of items) {
      const G = got(it), W = want(it, phase);
      if (CJK.test(String(G))) cjk++;
      if (G !== W) { bad++; if (samples.length < 15) samples.push('  ' + it.label + ' got=' + JSON.stringify(G) + ' want=' + JSON.stringify(W)); }
    }
    const expCJK = cjkExpected(phase);
    if (bad || cjk !== expCJK) fails.push('[' + phase.toUpperCase() + '] 不一致=' + bad + ' 中文残留=' + cjk + '（期望 ' + expCJK + '）' + (samples.length ? '\n' + samples.join('\n') : ''));
    return { bad, cjk };
  }

  run('en'); run('ar'); run('zh'); run('en');   // en→ar→zh→en：含"切回中文还原"与"幂等"两项

  console.log('驾驶舱运行时测试：' + items.length + ' 项（文本 ' + Object.keys(M).length + ' + 属性 ' + (items.length - Object.keys(M).length) + '）× 4 相（en→ar→zh→en）');
  return finish(fails, items.length, Object.keys(I18N.TRANS).length);
}

function finish(fails, n, transCount) {
  console.log('I18N.TRANS 词条数 = ' + transCount);
  if (fails.length) { console.error('\n失败 ' + fails.length + ' 项：\n' + fails.join('\n')); process.exit(1); }
  console.log('全部通过：en/ar 无中文残留，切回 zh 逐字还原，再次切 en 幂等。');
  process.exit(0);
}

main();
