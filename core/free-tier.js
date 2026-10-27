// core/free-tier.js — 官方免费额度聚合 · 健康/配额感知轮换引擎
//
// 【这条路径到底是什么】
// 不是「去 GitHub 找免费 token」（那是盗用 Key = 数据泄露 + ToS 违规 + 供应链攻击）。
// 而是一条**合规且可持续的特别路径**：
//   把 10+ 家主流 AI 服务商**官方公布的免费额度（free tier）**聚合起来，做成一
//   「一个用完、自动切下一个」的**零成本 AI 通道层**。官方免费额度是服务商主动
//   发给开发者的，不是盗用；加起来是 50+ 个官方免费模型，够撑起一个真实的免费档。
//
// 【为什么这不是"简单轮询"（这才是特别之处）】
//   1) 动态自发现：OpenRouter 的 /models 会返回每个模型的 pricing，可精确筛出
//      prompt==0 && completion===0 的**真·免费模型**；其余通道从 /models 拉真实清单。
//      → 模型列表**不会过期**，不需要人肉维护（静态清单几周就烂）。
//   2) 健康感知：连错 3 次的通道进入冷却，冷却到期自动放回（自愈），
//      不会每次都去撞一个已经挂掉的通道。
//   3) 配额感知：按声明 RPM/RPD 做本地滚动窗口计数，接近上限自动降权，
//      避免"撞 429 才发现超额"。
//   4) 评分排序：健康 × 在配额内 ÷ 延迟，挑当前最优；不是盲目轮询。
//   5) 早期客户免费额度（免费→付费漏斗）：按访客每日计量，把免费池变成留存钩子。
//
// 红线：只连官方公布的免费端点；Operator 自己申请自己的 Key；没配就如实跳过；
//       全部失败如实上报，绝不伪造成功。

const fs = require('fs');
const store = require('./store');
const providers = require('./providers');

// —— 注册表：官方免费 tier（models 为精选种子；discover=true 时会被在线发现覆盖）——
const REGISTRY = [
  { id: 'zhipu-flash', name: '智谱 GLM-4-Flash（官方免费）', env: 'ZHIPU_API_KEY', base: 'https://open.bigmodel.cn/api/paas/v4',
    signup: 'https://open.bigmodel.cn/', note: '智谱官方免费模型 GLM-4-Flash，按 RPM 限流，允许商用',
    rpm: 20, rpd: 200, discover: true,
    models: ['glm-4-flash'] },

  { id: 'groq', name: 'Groq', env: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1',
    signup: 'https://console.groq.com/keys', note: '免费约 30 RPM / 1000 RPD，LPU 极快，允许商用',
    rpm: 30, rpd: 1000, discover: true,
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it', 'mixtral-8x7b-32768'] },

  { id: 'cerebras', name: 'Cerebras', env: 'CEREBRAS_API_KEY', base: 'https://api.cerebras.ai/v1',
    signup: 'https://cloud.cerebras.ai/', note: '免费约 30 RPM / 100 万 token 一天，吞吐极高，允许商用',
    rpm: 30, rpd: 1000, discover: true,
    models: ['llama3.1-8b', 'llama-3.3-70b'] },

  { id: 'openrouter', name: 'OpenRouter（:free 模型）', env: 'OPENROUTER_API_KEY', base: 'https://openrouter.ai/api/v1',
    signup: 'https://openrouter.ai/keys', note: '动态发现所有 0 价模型；免费 20 RPM / 50 RPD（充 $10 提升）',
    rpm: 20, rpd: 50, discover: true, freeOnly: true,
    models: ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-2-9b-it:free', 'qwen/qwen-2.5-72b-instruct:free'] },

  { id: 'gemini', name: 'Google Gemini', env: 'GEMINI_API_KEY', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    signup: 'https://aistudio.google.com/apikey', note: '免费 tier：Flash 系列，100 万上下文',
    rpm: 15, rpd: 1500, discover: false,
    models: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-8b'] },

  { id: 'nvidia', name: 'NVIDIA NIM', env: 'NVIDIA_API_KEY', base: 'https://integrate.api.nvidia.com/v1',
    signup: 'https://build.nvidia.com/', note: '官方免费额度：约 40 RPM',
    rpm: 40, rpd: 1000, discover: true,
    models: ['meta/llama-3.1-8b-instruct', 'meta/llama-3.3-70b-instruct', 'mistralai/mistral-7b-instruct-v0.3'] },

  { id: 'sambanova', name: 'SambaNova', env: 'SAMBANOVA_API_KEY', base: 'https://api.sambanova.ai/v1',
    signup: 'https://cloud.sambanova.ai/', note: '免费 tier：Llama 系列，速率较快',
    rpm: 30, rpd: 1000, discover: true,
    models: ['Meta-Llama-3.1-8B-Instruct', 'Meta-Llama-3.1-70B-Instruct', 'Meta-Llama-3.3-70B-Instruct'] },

  { id: 'mistral', name: 'Mistral', env: 'MISTRAL_API_KEY', base: 'https://api.mistral.ai/v1',
    signup: 'https://console.mistral.ai/', note: '免费/实验 tier（部分模型限非商用，商用请核对条款）',
    rpm: 5, rpd: 500, discover: true,
    models: ['mistral-small-latest', 'open-mistral-nemo', 'open-mixtral-8x7b'] },

  { id: 'github', name: 'GitHub Models', env: 'GITHUB_TOKEN', base: 'https://models.inference.ai.azure.com',
    signup: 'https://github.com/marketplace/models', note: '有 GitHub 账号即可用；约 15 RPM / 150 RPD',
    rpm: 15, rpd: 150, discover: false,
    models: ['gpt-4o-mini', 'gpt-4o', 'Phi-3.5-mini-instruct', 'Mistral-Nemo'] },

  { id: 'cloudflare', name: 'Cloudflare Workers AI', env: 'CLOUDFLARE_API_KEY', base: 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/v1',
    signup: 'https://dash.cloudflare.com/', note: '免费 1 万 Neurons/天；需另配 CLOUDFLARE_ACCOUNT_ID',
    rpm: 300, rpd: 10000, discover: false, needAccount: true,
    models: ['@cf/meta/llama-3.1-8b-instruct', '@cf/qwen/qwen1.5-14b-chat-awq', '@cf/mistral/mistral-7b-instruct-v0.2'] },

  { id: 'hyperbolic', name: 'Hyperbolic', env: 'HYPERBOLIC_API_KEY', base: 'https://api.hyperbolic.xyz/v1',
    signup: 'https://app.hyperbolic.xyz/', note: '新账号赠送额度，OpenAI 兼容',
    rpm: 30, rpd: 500, discover: true,
    models: ['meta-llama/Meta-Llama-3.1-8B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'] },

  { id: 'ollama-local', name: 'Ollama 本地（无需 Key）', env: 'OLLAMA_LOCAL_KEY', base: 'http://127.0.0.1:11434/v1',
    signup: 'https://ollama.com/download', note: '本机 Ollama：零成本、零网络、零泄露；装了 Ollama 即自动可用',
    rpm: 999, rpd: 999999, discover: true, local: true,
    models: ['llama3.2', 'qwen2.5:7b', 'gemma2:9b', 'phi3.5'] }
];

// 任务分级 → 优先模型族（简单启发式：名字含大参数/旗舰词优先给强档）
function tierRank(id, model) {
  const m = String(model).toLowerCase();
  if (/70b|72b|405b|large|ultra|gpt-4o\b|sonnet|pro|120b|235b|dbrx/.test(m)) return 3;
  if (/8b|7b|9b|mini|small|flash|instant|lite|nano|3b|2b/.test(m)) return 1;
  return 2;
}
// 从一个通道的模型里按档位挑一个（比"永远取第一个"稳得多）
function pickModel(id, tier) {
  const list = modelsOf(id);
  if (!list.length) return null;
  const rank = m => tierRank(id, m);
  const chatty = m => (/instruct|chat|:free|generative/i.test(String(m)) ? 1 : 0);
  const sorted = list.slice().sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (tier === 3) return (rb - ra) || (chatty(b) - chatty(a));
    if (tier === 1) return (ra - rb) || (chatty(b) - chatty(a));
    const da = Math.abs(ra - 2), db = Math.abs(rb - 2);
    return (da - db) || (chatty(b) - chatty(a));
  });
  return sorted[0];
}

// ══════════ 持久化状态：健康 / 发现缓存 / 配额计数 / 免费赠量 ══════════
// 状态文件：数据目录下的普通文件（注意 dataPath() 是为"目录"准备的，会 mkdir，
// 传文件名会误建成目录——故用 path.join(dataPath(), ...) 取文件路径）
const STATE_PATH = (() => { try { return require('path').join(store.dataPath(), 'free-tier.json'); } catch (e) { return null; } })();
let _state = null;
let _saveTimer = null;

function loadState() {
  if (_state) return _state;
  let s = { providers: {}, grant: {}, updatedAt: 0 };
  try { if (STATE_PATH) s = Object.assign(s, JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))); } catch (e) {}
  if (!s.providers) s.providers = {};
  if (!s.grant) s.grant = {};
  _state = s;
  return _state;
}
function saveSoon() {
  if (_saveTimer || !STATE_PATH) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try { const s = loadState(); s.updatedAt = Date.now(); fs.writeFileSync(STATE_PATH, JSON.stringify(s)); } catch (e) {}
  }, 2000);
  if (_saveTimer.unref) _saveTimer.unref();
}
function pstate(id) {
  const s = loadState();
  if (!s.providers[id]) s.providers[id] = { ok: 0, fail: 0, consecFail: 0, ema: 0, cooldownUntil: 0, lastErr: '', lastOkAt: 0, quota: {} };
  const p = s.providers[id];
  if (!p.quota) p.pools = {}; // 兼容
  return s.providers[id];
}

// ══════════ Key 与模型 ══════════
function keyOf(p) {
  let key = '';
  try { key = process.env[p.env] || providers.getKey(p.env, providers.loadEnv()) || ''; } catch (e) { key = (process.env[p.env] || ''); }
  if (p.local && !key) key = 'local'; // 本地无需真 Key，给占位；连不上会在调用时被剔除
  return key;
}
function hasKey(p) { return !!keyOf(p); }

// 在线发现可用模型（缓存 24h）。OpenRouter 按价格为 0 过滤，得到"活的"免费模型清单。
function modelsOf(id) {
  const p = REGISTRY.find(x => x.id === id);
  if (!p) return [];
  const st = loadState().providers[id] || {};
  const fresh = st.discoveredAt && (Date.now() - st.discoveredAt < 24 * 3600e3);
  if (fresh && Array.isArray(st.discovered) && st.discovered.length) return st.discovered;
  return p.models || [];
}
async function discover(id) {
  const p = REGISTRY.find(x => x.id === id);
  if (!p || !p.discover) return { ok: false, error: '该通道不支持在线发现' };
  const key = keyOf(p);
  if (!key) return { ok: false, error: '未配置密钥' };
  let base = p.base.includes('{ACCOUNT}')
    ? p.base.replace('{ACCOUNT}', process.env.CLOUDFLARE_ACCOUNT_ID || '')
    : p.base;
  const url = base.replace(/\/$/, '') + '/models';
  try {
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + key }, signal: timeout(15000) });
    if (!res.ok) return { ok: false, error: p.name + ' /models 返回 ' + res.status };
    const j = await res.json();
    const arr = Array.isArray(j) ? j : (j.data || j.models || []);
    let ids = arr.map(x => (typeof x === 'string' ? x : (x.id || x.name || ''))).filter(Boolean);
    // 剔除嵌入/重排类（不能用于对话），否则会被误选为 chat 模型
    ids = ids.filter(m => !/embed|rerank|bge-|bce-|gte-|e5-|colbert/i.test(m));
    if (p.freeOnly) {
      // 只保留 0 价模型：pricing.prompt/completion 均为 0，或 id 以 :free 结尾
      ids = arr.filter(x => {
        if (typeof x === 'string') return /:free$/.test(x);
        const pr = x.pricing || {};
        const isFree = (Number(pr.prompt) === 0 && Number(pr.completion) === 0) || /:free$/.test(String(x.id));
        return isFree;
      }).map(x => (typeof x === 'string' ? x : x.id)).filter(Boolean);
    }
    if (!ids.length) return { ok: false, error: '未发现可用模型' };
    const st = loadState().providers[id] = loadState().providers[id] || {};
    st.discovered = ids.slice(0, 40);
    st.discoveredAt = Date.now();
    saveSoon();
    return { ok: true, id, count: st.discovered.length, models: st.discovered };
  } catch (e) {
    return { ok: false, error: p.name + ' 发现失败：' + (e.message || e) };
  }
}

function timeout(ms) {
  try { return AbortSignal.timeout(ms); } catch (e) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }
}

// ══════════ 健康 / 配额 / 评分 ══════════
function minuteKey(t) { return 'm' + Math.floor(t / 60000); }
function dayKey(t) { return 'd' + new Date(t).toDateString(); }

function quotaOk(p, st, now) {
  const q = st.quota || {};
  const mk = minuteKey(now), dk = dayKey(now);
  const inMin = q[mk] || 0;
  const inDay = Object.keys(q).filter(k => k[0] === 'd' && k === dk).reduce((n, k) => n + q[k], 0);
  if (p.rpm && inMin >= p.rpm) return false;
  if (p.rpd && inDay >= p.rpd) return false;
  return true;
}
function bumpQuota(st, now) {
  st.quota = st.quota || {};
  const mk = minuteKey(now), dk = dayKey(now);
  st.quota[mk] = (st.quota[mk] || 0) + 1;
  st.quota[dk] = (st.quota[dk] || 0) + 1;
  // 清理：只保留最近 3 天 + 最近 120 分钟
  const keys = Object.keys(st.quota);
  if (keys.length > 400) {
    const keep = new Set([mk, dk]);
    const dCut = now - 3 * 864e5;
    keys.forEach(k => {
      if (keep.has(k)) return;
      if (k[0] === 'm') { const t = Number(k.slice(1)) * 60000; if (t < now - 120 * 60000) delete st.quota[k]; }
      if (k[0] === 'd') { const t = Date.parse(k.slice(1)); if (!t || t < dCut) delete st.quota[k]; }
    });
  }
}

function health(id) {
  const p = REGISTRY.find(x => x.id === id);
  const st = loadState().providers[id] || {};
  const now = Date.now();
  const cooling = (st.cooldownUntil || 0) > now;
  const hasKey = hasImpl(id);
  const inQuota = p ? quotaOk(p, st, now) : false;
  return {
    id, name: p ? p.name : id, hasKey,
    ok: st.ok || 0, fail: st.fail || 0,
    consecutiveFail: st.consecutiveFail || 0,
    latencyMs: Math.round(st.latencyEMA || 0),
    lastError: st.lastError || '',
    cooling, coolingUntil: st.cooldownUntil || 0,
    inQuota,
    usable: hasKey && !cooling && inQuota,
    models: modelsOf(id).length
  };
}

// 评分：可用性优先，其次健康度、延迟、模型档位
function score(id, tier) {
  const p = REGISTRY.find(x => x.id === id);
  if (!p) return -1;
  const st = loadState().providers[id] || {};
  const now = Date.now();
  if (hasImpl(id) === false) return -1;
  if ((st.cooldownUntil || 0) > now) return -1;
  if (!quotaOk(p, st, now)) return -1;
  let s = 100;
  s -= (st.consecutiveFail || 0) * 15;
  s -= Math.min(40, (st.latencyEMA || 0) / 100);
  if (st.latencyEMA) s += 10; // 有成功历史 = 更可信
  if (tier === 3) {
    const best = Math.max.apply(null, (modelsOf(id).map(m => tierRank(id, m))).concat([0]));
    s += best * 8;
  } else if (tier === 1) {
    // 快档：偏好名字含 mini/instant 的
    const hasFast = modelsOf(id).some(m => /mini|instant|flash|lite|nano|8b|7b/i.test(m));
    s += hasFast ? 12 : 0;
  }
  if (p.local) s -= 20; // 本地通道（当前是测试 stub）作兜底，真实远程免费档优先
  return s;
}

// 避免 keyOf 抛错时误判：统一包一层
function hasImpl(id) {
  try {
    const p = REGISTRY.find(x => x.id === id);
    if (!p) return false;
    if (p.needAccount && !process.env.CLOUDFLARE_ACCOUNT_ID) {
      // 账户 ID 也允许写在 .env
      try { const ef = providers.loadEnv(); if (!ef.CLOUDFLARE_ACCOUNT_ID && !process.env.CLOUDFLARE_ACCOUNT_ID) return false; } catch (e) { return false; }
    }
    return !!keyOf(p);
  } catch (e) { return false; }
}

// 排序候选（tier: 1 快 / 2 均衡 / 3 强），可选排除
function candidates(opts) {
  const tier = (opts && opts.tier) || 2;
  const ex = new Set((opts && opts.exclude) || []);
  return REGISTRY
    .filter(p => !ex.has(p.id))
    .map(p => ({ id: p.id, s: score(p.id, tier) }))
    .filter(x => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map(x => x.id);
}

// ══════════ 调用 ══════════
async function callOnce(id, opts) {
  const p = REGISTRY.find(x => x.id === id);
  if (!p) throw new Error('未知免费通道：' + id);
  const key = keyOf(p);
  if (!key) throw new Error(p.name + ' 未配置密钥（' + p.env + '）');

  let base = p.base.includes('{ACCOUNT}')
    ? p.base.replace('{ACCOUNT}', process.env.CLOUDFLARE_ACCOUNT_ID || (() => { try { return providers.loadEnv().CLOUDFLARE_ACCOUNT_ID || ''; } catch (e) { return ''; } })())
    : p.base;
  const url = base.replace(/\/$/, '') + '/chat/completions';

  const started = Date.now();
  const wantTier = (opts && opts.tier) || 2;
  let model = opts && opts.model;
  if (!model) model = pickModel(id, wantTier);
  if (!model) throw new Error(p.name + ' 无可用模型');

  const body = {
    model,
    messages: (opts.messages || []).map(m => ({ role: m.role, content: m.content })),
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7,
    stream: false
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body),
    signal: timeout((opts && opts.timeoutMs) || 60000)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const e = new Error(p.name + ' 返回 ' + res.status + '：' + String(t).slice(0, 160));
    e.status = res.status;
    throw e;
  }
  const j = await res.json();
  const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content) throw new Error(p.name + ' 返回空内容');

  const elapsed = Date.now() - started;
  const st = loadState().providers[id] = loadState().providers[id] || {};
  st.ok = (st.ok || 0) + 1;
  st.consecutiveFail = 0;
  st.latencyEMA = st.latencyEMA ? Math.round(st.latencyEMA * 0.6 + elapsed * 0.4) : elapsed;
  bumpQuota(st, Date.now());
  saveSoon();
  return { content, provider: id, providerName: p.name, model, elapsed };
}

function recordFail(id, msg) {
  const st = loadState().providers[id] = loadState().providers[id] || {};
  st.fail = (st.fail || 0) + 1;
  st.consecutiveFail = (st.consecutiveFail || 0) + 1;
  st.lastError = String(msg || '').slice(0, 160);
  st.lastErrorAt = Date.now();
  // 冷却：连续失败 2 次 → 冷却 10 分钟；3 次以上 → 30 分钟（避免一直撞挂掉的通道）
  const cf = st.consecutiveFail;
  if (cf >= 3) st.cooldownUntil = Date.now() + 30 * 60000;
  else if (cf >= 2) st.cooldownUntil = Date.now() + 10 * 60000;
  saveSoon();
}

// 轮换降级主入口：按评分顺序尝试，成功即返回
async function chat(opts) {
  opts = opts || {};
  const order = candidates({ tier: opts.tier, exclude: opts.exclude });
  if (!order.length) {
    return { ok: false, tried: [], error: '没有可用的免费通道（未配置任何 Key，或全部处于冷却/超额）。在 .env 配置任一免费 tier 的 Key 即可启用，见 /v1/free-tier' };
  }
  const tried = [];
  for (const id of order.slice(0, 8)) {
    try {
      const r = await callOnce(id, opts);
      return { ok: true, content: r.content, provider: id, providerName: r.providerName, model: r.model, elapsed: r.elapsed, tried };
    } catch (e) {
      recordFail(id, e.message);
      tried.push({ id, name: (REGISTRY.find(x => x.id === id) || {}).name || id, error: String(e.message || e).slice(0, 160) });
    }
  }
  return { ok: false, tried, error: '全部免费通道不可用（已尝试 ' + tried.length + ' 个）' };
}

// ══════════ 早期客户免费赠量（免费→付费漏斗的钩子）══════════
const DEFAULT_GRANT = 20; // 每访客每日免费次数
function grantLimit() {
  try { const n = Number(store.getSetting('freeTierDaily')); return n > 0 ? n : DEFAULT_GRANT; } catch (e) { return DEFAULT_GRANT; }
}
function grantStatus(visitorId) {
  const vid = String(visitorId || 'anon');
  const st = loadState().grant;
  const today = dayKey(Date.now());
  const rec = st[visitorId] || {};
  const used = rec.day === today ? (rec.used || 0) : 0;
  const limit = DEFAULT_GRANT; // 状态查询用默认值展示
  const cap = grantLimit();
  return { visitorId: vid, day: new Date().toDateString(), used, limit: cap, remaining: Math.max(0, cap - used) };
}
function consumeGrant(visitorId) {
  const vid = String(visitorId || 'anon');
  const now = Date.now();
  const dk = dayKey(now);
  const st = loadState();
  const g = st.grant[vid] || { day: dk, used: 0 };
  if (g.day !== dk) { g.day = dk; g.used = 0; }
  const cap = Number(store.getSetting('freeTierDaily') || 0) || 20;
  if (g.used >= cap) { loadState().grant[vid] = g; return { ok: false, used: g.used, cap, error: '今日免费额度已用完（' + cap + ' 次）' }; }
  g.used += 1;
  loadState().grant[vid] = g;
  // 裁剪：只留最近 3000 个访客
  const gk = Object.keys(loadState().grant);
  if (gk.length > 3000) gk.slice(0, gk.length - 3000).forEach(k => delete loadState().grant[k]);
  saveSoon();
  return { ok: true, used: g.used, cap, remaining: cap - g.used };
}

// ══════════ 对外视图 ══════════
function list() {
  const provs = REGISTRY.map(p => {
    const h = health(p.id);
    return {
      id: p.id, name: p.name, env: p.env, base: p.base, signup: p.signup, note: p.note,
      rpm: p.rpm, rpd: p.rpd, modelCount: modelsOf(p.id).length, models: modelsOf(p.id).slice(0, 12),
      hasKey: h.hasKey, usable: h.usable, cooling: h.cooling, ok: h.ok, fail: h.fail,
      latencyMs: h.latencyMs, inQuota: h.inQuota, lastError: h.lastError
    };
  });
  const totalModels = provs.reduce((n, p) => n + p.modelCount, 0);
  return { providers: provs, totalProviders: provs.length, totalModels, usableProviders: provs.filter(p => p.usable).length };
}
function available() {
  return REGISTRY.filter(p => hasImpl(p.id)).map(p => ({
    id: p.id, name: p.name, models: modelsOf(p.id).length,
    usable: health(p.id).usable, cooling: health(p.id).cooling, latencyMs: health(p.id).latencyMs, note: p.note
  }));
}
function status() {
  const l = list();
  return {
    totalProviders: l.totalProviders, totalModels: l.totalModels, usableProviders: l.usableProviders,
    freeDailyQuota: Number(store.getSetting('freeTierDaily') || 0) || 20,
    providers: l.providers
  };
}
async function refreshAll() {
  const out = [];
  for (const p of REGISTRY) {
    if (!p.discover || !hasImpl(p.id)) { out.push({ id: p.id, skipped: true }); continue; }
    out.push(await discover(p.id));
  }
  return out;
}

// 语义化别名（server.js 里读起来更顺）
const consumeFreeGrant = (vid) => consumeGrant(vid);

module.exports = {
  REGISTRY, list, available, status, chat, candidates, health, modelsOf, discover, refreshAll,
  grant: consumeFreeGrant, grantStatus, consumeGrant,
  _internal: { score, quotaOk, loadState }
};
