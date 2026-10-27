// core/firecrawl.js — Firecrawl 适配器（竞品/定价情报）
//
// 用途：把竞品官网/定价页转成干净 Markdown，用于扒信息缺口与定价策略。
//
// API 契约核实自官方文档（2026-09），勿凭印象改：
//   POST https://api.firecrawl.dev/v1/scrape
//   Authorization: Bearer fc-XXXX
//   body: { url, formats:['markdown','links'], onlyMainContent, waitFor, timeout, maxAge }
//   resp: { success, data: { markdown, html, links, metadata } }
//   402 = 欠费；429 = 限流
//   maxAge 默认 2 天，命中缓存可显著提速（官方称约 500%）
//
// 设计纪律（与 memoryext / webfetch 一致，不可放宽）：
//   1. 无 key 时自动降级到本地 webfetch，绝不让抓取失败。
//   2. 欠费(402)/限流(429) 明确区分并回报，不静默吞掉——这两者决定用户要不要充值。
//   3. 零新增依赖。

const path = require('path');
const fs = require('fs');
const webfetch = require('./webfetch');

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
    } catch (e) { /* 视为未配置 */ }
  }
  return '';
}

function config() {
  // 优先读 settings 注册表（支持运行时热改），回落 env
  let key = '', base = 'https://api.firecrawl.dev', timeout = 60000;
  try {
    const s = require('./store').read().settings || {};
    if (s.firecrawlApiKey) key = s.firecrawlApiKey;
    if (s.firecrawlBase) base = s.firecrawlBase;
    if (s.firecrawlTimeout) timeout = Number(s.firecrawlTimeout) * 1000;
  } catch (e) {}
  if (!key) key = envGet('FIRECRAWL_API_KEY') || '';
  if (!base) base = (envGet('FIRECRAWL_API_URL') || 'https://api.firecrawl.dev').replace(/\/+$/, '');
  if (!timeout) timeout = Number(envGet('FIRECRAWL_TIMEOUT') || 60000);
  return {
    key, base: base.replace(/\/+$/, ''),
    hasKey: !!key,
    timeout
  };
}

// SSRF 防护：拒绝内网/环回/链路本地地址。只做字面判断，不做 DNS 解析
// （解析后再校验存在 TOCTOU 绕过；真正的防护应交由出口网络策略，这里是纵深防御的第一层）
const BLOCKED_HOST = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,          // 含云元数据 169.254.169.254
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,  // CGNAT 100.64/10
  /\.local$/i
];
function validateUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (e) { return 'url 非法：无法解析'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'url 非法：必须以 http(s):// 开头';
  const h = u.hostname;
  for (const re of BLOCKED_HOST) if (re.test(h)) return 'url 被拒绝：目标为内网/环回/链路本地地址';
  return null;
}

// 抓一个页面为干净 Markdown。opts: { formats, onlyMainContent, waitFor, maxAge, max }
// 无 key 或请求失败时降级到 webfetch（返回纯文本而非 Markdown，如实标记）
async function scrape(url, opts) {
  const c = config();
  const o = opts || {};
  const t0 = Date.now();
  const bad = validateUrl(url);
  if (bad) return { ok: false, url, markdown: '', note: bad, ms: 0 };
  if (!c.hasKey) return fallback(url, '未配置 FIRECRAWL_API_KEY，已降级为本地抓取（非 Markdown）', t0, o);

  const body = {
    url,
    formats: o.formats || ['markdown', 'links'],
    onlyMainContent: o.onlyMainContent !== false,
    timeout: c.timeout
  };
  if (o.waitFor) body.waitFor = o.waitFor;
  if (o.maxAge !== undefined) body.maxAge = o.maxAge;

  try {
    const r = await fetch(c.base + '/v1/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + c.key
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(c.timeout + 5000)
    });
    if (r.status === 402) {
      return { ok: false, url, markdown: '', ms: Date.now() - t0, note: 'Firecrawl 欠费(HTTP 402)：请充值或改用本地抓取' };
    }
    if (r.status === 429) {
      return { ok: false, url, markdown: '', ms: Date.now() - t0, note: 'Firecrawl 限流(HTTP 429)：稍后重试或改用本地抓取' };
    }
    if (!r.ok) {
      return fallback(url, 'Firecrawl HTTP ' + r.status + '，已降级为本地抓取', t0, o);
    }
    const j = await r.json();
    const d = (j && j.data) || {};
    const md = String(d.markdown || '');
    if (!md) return fallback(url, 'Firecrawl 返回空 Markdown，已降级为本地抓取', t0, o);
    return {
      ok: true,
      url,
      markdown: md.slice(0, Number(o.max) || 40000),
      links: Array.isArray(d.links) ? d.links.slice(0, 200) : [],
      title: (d.metadata && d.metadata.title) || '',
      description: (d.metadata && d.metadata.description) || '',
      chars: md.length,
      ms: Date.now() - t0,
      note: 'Firecrawl Markdown'
    };
  } catch (e) {
    return fallback(url, 'Firecrawl 请求失败(' + String((e && e.message) || e).slice(0, 50) + ')，已降级为本地抓取', t0, o);
  }
}

async function fallback(url, note, t0, o) {
  const r = await webfetch.fetchPage(url, { backend: (o && o.backend) || 'fetch' });
  const text = r.ok ? webfetch.toText(r.body) : '';
  return {
    ok: r.ok,
    url,
    markdown: text.slice(0, Number(o && o.max) || 40000),
    links: [],
    title: (r.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '',
    chars: text.length,
    rendered: r.rendered,
    fellBack: true,
    ms: Date.now() - t0,
    note
  };
}

// 定价信号抽取：从 Markdown 里粗提价格/套餐线索（启发式，不保证准确，需人工核对）
const CURRENCY = /(?:¥|￥|\$|USD|CNY|RMB|元)\s?\d[\d,]*(?:\.\d+)?/g;
// 供 test() 使用的非全局副本：避免 /g 的 lastIndex 在循环中被推进而漏匹配
const CURRENCY_TEST = /(?:¥|￥|\$|USD|CNY|RMB|元)\s?\d[\d,]*(?:\.\d+)?/;
function pricingSignals(markdown) {
  const md = String(markdown || '');
  const prices = [];
  let m;
  CURRENCY.lastIndex = 0;
  while ((m = CURRENCY.exec(md)) && prices.length < 60) prices.push(m[0].trim());
  const uniq = Array.from(new Set(prices)).slice(0, 30);
  // 周期：既认「3个月 / 12 months」这类带数字的，也认「每月 / monthly」这类纯词的
  const months = md.match(/(\d+\s*(?:个?月|months?|years?|年))|(\/\s*(?:月|年))|(每月|每年|monthly|yearly|per\s+month|per\s+year)/gi) || [];
  const features = (md.match(/^\s*[-*]\s+(.{3,60})$/gm) || [])
    .map(s => s.replace(/^\s*[-*]\s+/, '').trim())
    .filter(s => s && !CURRENCY_TEST.test(s))
    .slice(0, 40);
  CURRENCY.lastIndex = 0;
  return {
    prices: uniq,
    priceCount: uniq.length,
    periods: Array.from(new Set(months.map(s => s.trim()))).slice(0, 10),
    features,
    caveat: '启发式抽取，未必等于实际在售价格，落地前必须人工核对官网'
  };
}

function status() {
  const c = config();
  return {
    hasKey: c.hasKey,
    base: c.base,
    note: c.hasKey
      ? '已配置 Firecrawl；抓取返回干净 Markdown'
      : '未配置 FIRECRAWL_API_KEY：抓取自动降级为本地裸 fetch（拿不到 Markdown 清洗与 JS 渲染）'
  };
}

module.exports = { config, scrape, pricingSignals, status };
