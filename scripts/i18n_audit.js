#!/usr/bin/env node
/* scripts/i18n_audit.js — 全站 5 个页面 zh/en/ar 覆盖率审计（退出码 0=全覆盖，1=有漏翻）
 *
 * 背景：语言不能乱，要「audit EVERY page」。此前漏翻审计只跑字典本身，没校验
 * script 是否真的接上 —— 结果 download/activate/architecture 三页的 <script src="">
 * 文件名丢了，i18n 运行时**从未加载**，本地化从未生效却没人发现。所以这里做两件事：
 *   ① 接线检查：每个页面是否真的 <script> 引入了它该用的 i18n 运行时；
 *   ② 覆盖检查：用**真实运行时字典 + 真实匹配算法**去跑页面上的中文。
 *
 * 三套引擎、三种匹配算法，逐字对齐各自源码，不能想当然：
 *   · page-i18n.js   （download/activate/architecture）：nk() 归一 + 字典精确查表
 *   · landing-i18n.js（landing）：整段精确匹配 T()/trText()（含 stripLead 兜底）
 *   · i18n.js        （index）：data-i18n 键 + TRANS **最长优先**贪心逐段 trSegment
 *
 * 三套引擎都用 readyState='loading' 的桩加载，让它们只注册 DOMContentLoaded
 * 而不去摸 DOM —— 这样拿到的是与浏览器完全一致的字典/词表，零依赖、不需浏览器。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const CJK = /[\u4e00-\u9fff]/;
const HAS_CN = /[\u4e00-\u9fa5]/; // 与 i18n.js 的 HAS_CN 同区间

// ── 载入引擎（window === 全局对象，否则 landing 的裸 LANDING_LANG 读不到）────────
function loadVM(files) {
  const g = {
    console,
    location: { search: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { language: 'zh' },
    document: { readyState: 'loading', addEventListener: () => {} }
  };
  g.window = g;
  vm.createContext(g);
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), g, { filename: f });
  }
  return g;
}

// ── 页面公共抽取：剥掉不参与翻译的元素，按 > 与 < 之间取文本节点 ────────────────
const NO_TRANSLATE = /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<!--[\s\S]*?-->/gi;
function textNodes(html, extraTags) {
  let h = html.replace(NO_TRANSLATE, '');
  for (const tag of extraTags) h = h.replace(new RegExp('<' + tag + '(?:\\s[^>]*)?>[\\s\\S]*?</' + tag + '>', 'gi'), '');
  const out = [];
  let m;
  const re = />([^<]*)</g;
  while ((m = re.exec(h))) out.push(m[1]);
  return out;
}
function attrs(html, names) {
  const out = [];
  const re = new RegExp('(?:' + names.join('|') + ')\\s*=\\s*"([^"]*)"', 'gi');
  let m;
  while ((m = re.exec(html))) out.push({ name: m[1], val: m[2] });
  return out;
}
function missLine(s) { return JSON.stringify(String(s).trim().slice(0, 70)); }

let totalMiss = 0;
const report = [];

// ════════════════════════════════════════════════════════════════════════════
// A. 三个独立页：page-i18n.js + page-dicts.js
// ════════════════════════════════════════════════════════════════════════════
function auditOrphans() {
  const g = loadVM(['page-dicts.js', 'page-i18n.js']);
  const D = g.PG.dict;
  function nk(s) {
    return String(s == null ? '' : s).trim()
      .replace(/[\u00a0\u3000]/g, ' ').replace(/\s+/g, ' ')
      .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
      .replace(/[\u201c\u201d\u201f\u2033]/g, '"')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-');
  }
  const DN = {};
  for (const k of Object.keys(D)) DN[nk(k)] = true;

  for (const f of ['download.html', 'activate.html', 'architecture.html']) {
    const raw = fs.readFileSync(path.join(WEB, f), 'utf8');
    const miss = [];
    const seen = new Set();
    // 静态文本节点 + 可翻译属性
    for (const t of textNodes(raw, ['script', 'style', 'noscript'])
      .concat(attrs(raw, ['placeholder', 'title', 'aria-label']).map(a => a.val))) {
      const mid = String(t || '').trim();
      if (!mid || !CJK.test(mid)) continue;
      if (DN[nk(mid)] || seen.has(nk(mid))) continue;
      seen.add(nk(mid)); miss.push(missLine(mid));
    }
    // 动态：内联 script 里的中文串（先剥注释；标签名须 ASCII，避开「<地址>」占位）
    const blocks = [];
    let m; const br = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    while ((m = br.exec(raw))) blocks.push(m[1]);
    blocks.forEach(code => code.split(/\r?\n/).forEach(ln => {
      const s = ln.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      const r = /'([^'\\\n]*)'|"([^"\\\n]*)"/g; let mm;
      while ((mm = r.exec(s))) {
        const v = mm[1] !== undefined ? mm[1] : mm[2];
        if (!CJK.test(v)) continue;
        const parts = /<[a-zA-Z\/!?][^<>]*>/.test(v) ? v.replace(/<[^>]*>/g, '\n').split('\n') : [v];
        for (const p of parts) {
          const q = p.trim();
          if (!q || !CJK.test(q) || DN[nk(q)] || seen.has(nk(q))) continue;
          seen.add(nk(q)); miss.push(missLine(q));
        }
      }
    }));
    report.push([f, miss.length, miss]);
    totalMiss += miss.length;
  }
  return { dict: Object.keys(D).length, label: 'page-i18n 字典条目' };
}

// ════════════════════════════════════════════════════════════════════════════
// B. landing.html：landing-i18n.js（整段精确匹配 T/trText）
// ════════════════════════════════════════════════════════════════════════════
function auditLanding() {
  const g = loadVM(['landing-i18n.js']);
  const T = g.LANDING_T;
  g.LANDING_LANG = 'en'; // 裸 LANDING_LANG 解析到全局 g（g.window === g）
  const stripLead = k => k.replace(/^[\s·•\-\u2013\u2014]+/, '');
  function trText(base) {                 // 与 landing-i18n.js trText() 同款
    const key = String(base).trim();
    if (!key) return base;
    if (!/[A-Za-z\u4e00-\u9fff]/.test(key)) return base;
    const val = T(key);
    if (val !== key) return base.split(key).join(val);
    const k2 = stripLead(key);
    if (k2 && k2 !== key) { const v2 = T(k2); if (v2 !== k2) return base.split(k2).join(v2); }
    return base;
  }
  const raw = fs.readFileSync(path.join(WEB, 'landing.html'), 'utf8');
  const miss = []; const seen = new Set();
  const keep = s => { const k = String(s || '').trim(); if (!k || !CJK.test(k)) return; const out = trText(k); if (CJK.test(out.trim())) { if (!seen.has(k)) { seen.add(k); miss.push(missLine(k)); } } };
  textNodes(raw, ['script', 'style', 'noscript']).forEach(keep);
  attrs(raw, ['alt', 'title', 'placeholder']).forEach(a => keep(a.val));
  report.push(['landing.html', miss.length, miss]);
  totalMiss += miss.length;
  return { dict: 'LDICT', label: 'landing 字典' };
}

// ════════════════════════════════════════════════════════════════════════════
// C. index.html：i18n.js（data-i18n 键 + TRANS 最长优先 trSegment）
// ════════════════════════════════════════════════════════════════════════════
function auditIndex() {
  const g = loadVM(['i18n-console.js', 'i18n.js']);
  const I = g.I18N;
  const DICT = I.DICT, TRANS = I.TRANS;
  // 【与运行时对齐】i18n.js 在 applyI18n 里惰性把 window.__CONSOLE_I18N__ 合并进 TRANS；
  // 审计这里手动做同一件事，否则会误报驾驶舱词表已覆盖的中文为"残留"。
  const CONSOLE_M = g.__CONSOLE_I18N__ || null;
  if (CONSOLE_M) for (const k of Object.keys(CONSOLE_M)) { const nv = CONSOLE_M[k], ov = TRANS[k]; if (!ov || ov[0] !== nv[0] || ov[1] !== nv[1]) TRANS[k] = nv; }
  const lang = 'en';
  // t(key)：与 i18n.js t() 同款（DICT[lang] → DICT.zh → TRANS[key]）
  function t(key) {
    let s = '';
    const L = DICT[lang];
    if (L && key in L) s = L[key];
    else if (DICT.zh && key in DICT.zh) s = DICT.zh[key];
    else { const tr = TRANS[key]; if (tr) s = tr[0] || ''; }
    return s || '';
  }
  const TERM_KEYS = Object.keys(TRANS).sort((a, b) => b.length - a.length);
  function trSegment(seg) {               // 与 i18n.js trSegment() 同款（含单字词边界规则）
    let out = '', i = 0;
    while (i < seg.length) {
      let hit = null;
      for (let k = 0; k < TERM_KEYS.length; k++) {
        const term = TERM_KEYS[k];
        if (term.length > seg.length - i || seg.substr(i, term.length) !== term) continue;
        // 单字键仅两侧非中文时命中：'中' 只能译独立量词，不能插进「中枢」里。
        if (term.length === 1) {
          const prev = i > 0 ? seg.charAt(i - 1) : '';
          const next = i + 1 < seg.length ? seg.charAt(i + 1) : '';
          if ((prev && HAS_CN.test(prev)) || (next && HAS_CN.test(next))) continue;
        }
        hit = term; break;
      }
      if (hit) { out += t(hit); i += hit.length; } else { out += seg.charAt(i); i++; }
    }
    return out;
  }
  const raw = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const miss = []; const seen = new Set();
  const push = (what, s) => { const k = String(s).trim(); if (!k || seen.has(k)) return; seen.add(k); miss.push(what + ' ' + missLine(k)); };

  // ---- 用栈扫描，忠实模拟 applyI18n 的执行顺序 ----
  // 关键：applyI18n 先给 [data-i18n/-html] 设 t(key)（英文），**之后**才 walk 文本节点，
  // 所以 data-i18n 子树里的中文在运行时已被换成英文，不能再当成残留去数；
  // 同理 walk() 跳过 SKIP_TAGS 与 data-i18n-skip 的子树。
  let h = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/i, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  const VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };
  const SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, CODE: 1, PRE: 1, KBD: 1, SAM: 1 };
  const stack = [];
  const opens = [];
  const tok = /<[^>]+>|[^<]+/g;
  let m;
  while ((m = tok.exec(h))) {
    const s = m[0];
    if (s[0] === '<') {
      if (s[1] === '/') { stack.pop(); continue; }
      const nm = /^<\s*([a-zA-Z0-9-]+)/.exec(s);
      if (!nm) continue;
      const tag = nm[1];
      const A = {};
      let am; const are = /([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/g;
      while ((am = are.exec(s))) A[am[1].toLowerCase()] = am[2];
      opens.push({ tag: tag, A: A });
      if (VOID[tag]) continue;
      const skip = !!SKIP[tag.toUpperCase()] || A['data-i18n'] !== undefined
        || A['data-i18n-html'] !== undefined || A['data-i18n-skip'] !== undefined;
      stack.push(skip);
    } else {
      if (stack.some(x => x)) continue;              // 在 data-i18n / SKIP 子树内
      if (!HAS_CN.test(s)) continue;
      const out = trSegment(s);
      if (HAS_CN.test(out)) push('[文本残留]', out);   // 贪心替换后仍剩中文 = 真残留
    }
  }

  // C1. data-i18n / -ph / -title / -html 键：t() 出不来英文（空 或 还是中文）就留着中文
  let m2; const kr = /data-i18n(?:-ph|-title|-html)?\s*=\s*"([^"]+)"/g;
  while ((m2 = kr.exec(raw))) {
    const key = m2[1];
    const out = t(key);
    if (out === '' || HAS_CN.test(out)) push('[data-i18n 缺译] ' + key, out || key);
  }

  // C3. 属性自动翻译路径：与 i18n.js trAttrs() 同款。
  //   运行时对 placeholder/title/alt/aria-label 用同一套词表 trSegment 翻译（无需 data-i18n-* 钩子），
  //   因此审计也按 trSegment 判残留（而不是要求逐个配钩子）——与运行时保持单一事实来源。
  const decEnt = s => String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  for (const o of opens) {
    for (const name of ['placeholder', 'title', 'alt', 'aria-label']) {
      const v = o.A[name];
      if (!v || !HAS_CN.test(v)) continue;
      if (name === 'placeholder' && o.A['data-i18n-ph'] !== undefined) continue;   // 由 C1 覆盖
      if (name === 'title' && o.A['data-i18n-title'] !== undefined) continue;      // 由 C1 覆盖
      const out = trSegment(decEnt(v));
      if (HAS_CN.test(out)) push('[属性残留 ' + name + ' on <' + o.tag + '>]', out);
    }
  }
  report.push(['index.html', miss.length, miss]);
  totalMiss += miss.length;
  return { dict: 'DICT keys=' + Object.keys(DICT.en || {}).length + ' TRANS=' + Object.keys(TRANS).length, label: 'i18n' };
}

// ── 接线检查：每个页面是否真的引入了该用的 i18n 运行时 ────────────────────────
function wiring() {
  const expect = {
    'download.html': ['page-dicts.js', 'page-i18n.js'],
    'activate.html': ['page-i18n.js'],
    'architecture.html': ['page-dicts.js', 'page-i18n.js'],
    'landing.html': ['landing-i18n.js'],
    'index.html': ['i18n-console.js', 'i18n.js']
  };
  let bad = 0;
  for (const f of Object.keys(expect)) {
    const raw = fs.readFileSync(path.join(WEB, f), 'utf8');
    const tags = [];
    let m; const re = /<script\s+src="([^"]*)"/g;
    while ((m = re.exec(raw))) tags.push(m[1]);
    const empty = tags.filter(s => s === '').length;
    const missing = expect[f].filter(n => !tags.some(s => s.indexOf(n) >= 0));
    const ok = empty === 0 && missing.length === 0;
    if (!ok) bad++;
    console.log('接线 ' + (ok ? 'OK   ' : 'BROKEN') + ' ' + f.padEnd(18)
      + ' 缺=[' + (missing.join(',') || '-') + '] 空src=' + empty);
  }
  return bad;
}

// ── run ─────────────────────────────────────────────────────────────────────
const wiredBad = wiring();
console.log('');
auditOrphans();
auditLanding();
auditIndex();
for (const [f, n, miss] of report) {
  console.log(f.padEnd(18) + ' 漏翻 ' + String(n).padStart(4) + ' 处');
  miss.slice(0, 12).forEach(x => console.log('   MISS ' + x));
  if (miss.length > 12) console.log('   … 另有 ' + (miss.length - 12) + ' 处');
}
// 控制台在中文 Windows 下会把 CJK 打成乱码，漏翻清单必须能落盘后按 UTF-8 阅读。
if (process.env.BINGDASHAN_I18N_DUMP) {
  const full = report.map(([f, n, miss]) => ({ file: f, missing: n, items: miss }));
  fs.writeFileSync(process.env.BINGDASHAN_I18N_DUMP, JSON.stringify(full, null, 2), 'utf8');
  console.log('已导出漏翻清单 → ' + process.env.BINGDASHAN_I18N_DUMP);
}
console.log('\n覆盖对象: ' + report.length + ' 页   漏翻合计: ' + totalMiss + '   接线异常: ' + wiredBad);
process.exit(totalMiss === 0 && wiredBad === 0 ? 0 : 1);
