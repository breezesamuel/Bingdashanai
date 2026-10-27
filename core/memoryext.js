// core/memoryext.js — 外部语义记忆层适配器
//
// 目标：给现有的关键词检索（knowledge.recall）补上真正的语义/混合检索。
//
// 设计纪律（不可放宽）：
//   1. 默认关闭。未配置 SUPERMEMORY_API_URL 时 available() 恒为 false，对现有行为零影响。
//   2. 永不抛出。所有网络失败降级为空结果，绝不把异常冒泡给调用方。
//   3. 故障不拖慢主流程。健康状态带 TTL 缓存，服务端挂了不会每次调用都等超时。
//   4. 零新增依赖。用 Node 内置 fetch，不引入 SDK。
//
// 已知事实（核实自 supermemory 官方文档，勿凭印象改）：
//   - 自托管是单二进制、无需 Docker，默认本地嵌入模型（不花 API 费）
//   - 自托管版 **不含 MCP server**，MCP 仅托管版提供 → 所以这里走 HTTP API
//   - 默认监听 http://127.0.0.1:6767，首次启动生成 API key
//   - 检索走 /v4/search，写入走 /v3/documents

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TIMEOUT_MS = 2500;
const HEALTH_TTL = 60000;

const IN_ASAR = __dirname.includes('app.asar');
const USER_ENV_DIR = IN_ASAR
  ? path.join(process.env.APPDATA || '', 'BingDashan')
  : ROOT;
const ENV_PATHS = [
  path.join(USER_ENV_DIR, '.env'),
  path.join(ROOT, '.env')
];

// 极简 .env 解析：只取需要的键，容忍空格与引号
function envGet(key) {
  if (process.env && process.env[key]) return String(process.env[key]).trim();
  for (const p of ENV_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const txt = fs.readFileSync(p, 'utf8');
      for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (m && m[1] === key) {
          let v = m[2].trim();
          if (/^"(.*)"$/.test(v)) v = v.replace(/^"|"$/g, '');
          else if (/^'(.*)'$/.test(v)) v = v.replace(/^'|'$/g, '');
          else v = v.split('#')[0].trim();
          if (v) return v;
        }
      }
    } catch (e) { /* 读不到就当没配 */ }
  }
  return '';
}

function config() {
  const url = (envGet('SUPERMEMORY_API_URL') || '').replace(/\/+$/, '');
  const key = envGet('SUPERMEMORY_API_KEY') || '';
  return { url, key, enabled: !!url };
}

let health = { at: 0, ok: false, detail: '未探测' };

async function probe(url, key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url + '/v4/search?q=ping&limit=1', {
      method: 'GET',
      headers: key ? { Authorization: 'Bearer ' + key } : {},
      signal: ctrl.signal
    });
    return { ok: res.ok, detail: 'HTTP ' + res.status };
  } catch (e) {
    return { ok: false, detail: (e && e.name === 'AbortError') ? '超时' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

// 可用性：配置齐全 且 （健康缓存有效 或 现场探测）
async function available(force) {
  const c = config();
  if (!c.enabled) return false;
  const fresh = Date.now() - health.at < HEALTH_TTL;
  if (!force && fresh) return health.ok;
  health = Object.assign({ at: Date.now() }, await probe(c.url, c.key));
  return health.ok;
}

async function req(pathname, opts) {
  const c = config();
  if (!c.enabled) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(c.url + pathname, {
      method: (opts && opts.method) || 'GET',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        c.key ? { Authorization: 'Bearer ' + c.key } : {}
      ),
      body: (opts && opts.body) ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null; // 降级：调用方拿到 null 当作"没有外部结果"
  } finally {
    clearTimeout(timer);
  }
}

// 语义/混合检索：返回 [{content, title, url, score, id}]，不可用时返回 []
async function search(query, limit) {
  if (!query || !(await available())) return [];
  const q = encodeURIComponent(String(query).slice(0, 500));
  const n = Math.max(1, Math.min(Number(limit) || 5, 20));
  const data = await req('/v4/search?q=' + q + '&limit=' + n, { method: 'GET' });
  const arr = (data && (data.results || data.documents || data.memories)) || [];
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, n).map((d, i) => ({
    id: d.id || d.documentId || ('sm' + i),
    content: String(d.content || d.text || d.summary || d.chunk || '').slice(0, 2000),
    title: d.title || d.name || '',
    url: d.url || '',
    tag: d.containerTag || d.space || '',
    score: typeof d.score === 'number' ? d.score : null,
    at: d.createdAt || d.updatedAt || null
  })).filter(x => x.content);
}

// 写入一条记忆
async function save(content, meta) {
  if (!content || !(await available())) return null;
  const data = await req('/v3/documents', {
    method: 'POST',
    body: {
      content: String(content).slice(0, 20000),
      metadata: meta || {}
    }
  });
  return (data && (data.document || data)) || null;
}

// 可观测性：给 /v1 端点用
async function status() {
  const c = config();
  const ok = await available();
  return {
    enabled: c.enabled,
    ok,
    url: c.url ? c.url.replace(/:\/\/[^@/]*@/, '://***@') : '',
    hasKey: !!c.key,
    lastProbeAt: health.at || null,
    lastProbe: health.detail,
    note: c.enabled
      ? (ok ? '已接入；knowledge.recall 会合并语义结果' : '已配置但连不上，当前静默降级为纯关键词检索')
      : '未配置（设 SUPERMEMORY_API_URL 启用）；对现有行为零影响'
  };
}

// 重置健康缓存（测试/手工恢复用）
function reset() { health = { at: 0, ok: false, detail: '未探测' }; }

module.exports = { config, available, search, save, status, reset, GRADE: null };
