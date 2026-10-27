// core/webfetch.js — 可插拔网页抓取后端
//
// 背景：现有 intel.js 全部走裸 fetch（RSS / GitHub API），对「JS 渲染后才出内容」的页面无能为力。
// 本模块提供统一入口 fetchPage()，后端可切换：
//   fetch      —— 默认。裸 HTTP，零依赖，最稳，但拿不到 JS 渲染结果
//   lightpanda —— 可选。走 CDP 连无头浏览器，能渲染 JS
//
// 关键设计（不要放宽）：
//   1. lightpanda 是「可选加速/补能」，不是「替换」。它挂了必须自动回落 fetch，绝不让抓取整体失败。
//   2. 默认不启用。需显式设 BROWSE_BACKEND=lightpanda 才会尝试连接。
//   3. lightpanda 处于 pre-1.0，其 CDP 覆盖度未经全量验证；因此默认只对明确需要渲染的目标启用，
//      且每次都会回报实际使用的后端，便于发现「以为在渲染、其实在裸取」。
//   4. 零新增依赖。用 Node 原生 fetch / WebSocket。
//
// lightpanda 的项目自述数字（轻 16 倍 / 快 9 倍）来自其作者，本模块不对其做性能背书。

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const IN_ASAR = __dirname.includes('app.asar');
const USER_ENV_DIR = IN_ASAR ? path.join(process.env.APPDATA || '', 'BingDashan') : ROOT;
const ENV_PATHS = [path.join(USER_ENV_DIR, '.env'), path.join(ROOT, '.env')];

function envGet(key) {
  if (process.env && process.env[key]) return String(process.env[key]).trim();
  for (const p of ENV_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (m && m[1] === key) {
          let v = m[2].trim();
          if (/^"(.*)"$/.test(v)) v = v.replace(/^"|"$/g, '');
          else if (/^'(.*)'$/.test(v)) v = v.replace(/^'|'$/g, '');
          else v = v.split('#')[0].trim();
          if (v) return v;
        }
      }
    } catch (e) { /* 读不到即视为未配置 */ }
  }
  return '';
}

function settings() {
  return {
    backend: (envGet('BROWSE_BACKEND') || 'fetch').toLowerCase(),
    lightpandaUrl: (envGet('LIGHTPANDA_CDP_URL') || 'http://127.0.0.1:9222').replace(/\/+$/, ''),
    navTimeout: Number(envGet('BROWSE_NAV_TIMEOUT') || 12000),
    fetchTimeout: Number(envGet('BROWSE_FETCH_TIMEOUT') || 12000)
  };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/122.0 Safari/537.36 BingDashan/1.0';

// ---------- 后端 A：裸 fetch ----------
async function viaFetch(url, timeoutMs) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/json,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await r.text();
  return { ok: r.ok, status: r.status, body, rendered: false };
}

// ---------- 后端 B：lightpanda（CDP over WebSocket） ----------
// 取 /json/version 拿 webSocketDebuggerUrl
async function lpWsUrl(cfg) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch(cfg.lightpandaUrl + '/json/version', { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || !j.webSocketDebuggerUrl) throw new Error('无 webSocketDebuggerUrl');
    return j.webSocketDebuggerUrl;
  } finally { clearTimeout(t); }
}

function cdp(ws) {
  let id = 0;
  const waiters = new Map();
  ws.addEventListener('message', ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); msg.error ? w.rej(new Error(msg.error.message || 'CDP error')) : w.res(msg.result); }
  });
  return {
    send(method, params) {
      return new Promise((res, rej) => {
        const mid = ++id;
        waiters.set(mid, { res, rej });
        try { ws.send(JSON.stringify({ id: mid, method, params: params || {} })); }
        catch (e) { waiters.delete(mid); rej(e); }
      });
    }
  };
}

async function viaLightpanda(url, cfg) {
  const wsEndpoint = await lpWsUrl(cfg);
  const ws = new WebSocket(wsEndpoint);
  const opened = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('WS 连接超时')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); res(true); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('WS 连接失败')); }, { once: true });
  });
  if (!opened) throw new Error('WS 未打开');
  const c = cdp(ws);
  try {
    const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    // flatten 模式下 CDP 消息需带 sessionId，这里按 lightpanda 的实现直接发顶层方法
    const sc = { send: (m, p) => c.send(m, Object.assign({ sessionId }, p || {})) };
    await sc.send('Page.enable');
    await sc.send('Page.navigate', { url });
    // 给 JS 一点执行时间；lightpanda 无 networkidle 事件可等，用固定沉降
    await new Promise(r => setTimeout(r, 1200));
    const r = await sc.send('Runtime.evaluate', {
      expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
      returnByValue: true
    });
    const html = (r && r.result && r.result.value) || '';
    try { await sc.send('Target.closeTarget', { targetId }); } catch (e) { /* 关不掉无所谓 */ }
    return { ok: !!html, status: 200, body: html, rendered: true };
  } finally {
    try { ws.close(); } catch (e) { /* ignore */ }
  }
}

// SSRF 防护：拒绝内网/环回/链路本地/云元数据地址（纵深防御第一层）
const BLOCKED_HOST = [
  /^localhost$/i, /^127\./, /^0\./, /^10\./, /^192\.168\./,
  /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/, /^\[?f[cd][0-9a-f]{2}:/i,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /\.local$/i
];
function validateUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (e) { return 'url 非法：无法解析'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'url 非法：必须以 http(s):// 开头';
  for (const re of BLOCKED_HOST) if (re.test(u.hostname)) return 'url 被拒绝：目标为内网/环回/链路本地地址';
  return null;
}

// 统一入口
// opts: { backend } 强制指定后端；'auto' = 有 lightpanda 就渲染，否则 fetch
// 返回 { ok, status, body, rendered, backend, ms, note, fellBack }
async function fetchPage(url, opts) {
  const cfg = settings();
  const o = opts || {};
  const want = (o.backend || cfg.backend || 'fetch').toLowerCase();
  const t0 = Date.now();
  const base = { ok: false, status: 0, body: '', rendered: false, ms: 0, note: '', fellBack: false };

  const bad = validateUrl(url);
  if (bad) return Object.assign(base, { url, ms: Date.now() - t0, note: bad });

  if (want === 'lightpanda' || want === 'auto') {
    try {
      const r = await viaLightpanda(url, cfg);
      return Object.assign(base, r, { backend: 'lightpanda', ms: Date.now() - t0, note: 'JS 已渲染' });
    } catch (e) {
      if (want === 'lightpanda') {
        // 显式要求渲染却失败：如实报错，但同时回落 fetch 给出未渲染内容
        try {
          const r = await viaFetch(url, cfg.fetchTimeout);
          return Object.assign(base, r, { backend: 'fetch', ms: Date.now() - t0, fellBack: true, note: 'lightpanda 不可用(' + String(e.message).slice(0, 60) + ')，已回落 fetch：内容未渲染' });
        } catch (e2) {
          return Object.assign(base, { ms: Date.now() - t0, note: 'lightpanda 与 fetch 均失败: ' + String(e2.message).slice(0, 60) });
        }
      }
      // auto 模式：静默回落
    }
  }

  try {
    const r = await viaFetch(url, cfg.fetchTimeout);
    return Object.assign(base, r, { backend: 'fetch', ms: Date.now() - t0, note: want === 'auto' ? 'lightpanda 不可用，已回落 fetch：内容未渲染' : '裸 HTTP，未渲染' });
  } catch (e) {
    return Object.assign(base, { ms: Date.now() - t0, note: '抓取失败: ' + String((e && e.message) || e).slice(0, 80) });
  }
}

// 提取正文文本（够用即可，不追求完美 readability）
function toText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function status() {
  const cfg = settings();
  return {
    backend: cfg.backend,
    lightpandaUrl: cfg.lightpandaUrl,
    note: cfg.backend === 'fetch'
      ? '当前为裸 fetch：拿不到 JS 渲染内容。竞品页/前端渲染站需设 BROWSE_BACKEND=lightpanda'
      : '已选择 ' + cfg.backend + '；未连上会自动回落 fetch 并在返回值标记 fellBack'
  };
}

async function probe() {
  const cfg = settings();
  try {
    const u = await lpWsUrl(cfg);
    return { reachable: true, ws: u.replace(/:\/\/[^@/]*@/, '://***@') };
  } catch (e) {
    return { reachable: false, error: String((e && e.message) || e).slice(0, 80) };
  }
}

module.exports = { fetchPage, toText, status, probe, settings, validateUrl, reset: () => {} };
