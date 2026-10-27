// core/providers.js — 8 家大模型适配器（OpenAI 兼容协议）
// 职责：注册 8 家 provider、读取 .env 密钥状态、统一调用 chat 接口。
// 约定：无密钥时 chat() 抛出中文可读错误，前端显示"待配置"。

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
// 8 家：id / 显示名 / .env 变量名 / base_url / 默认模型 / 首字母logo色
const PROVIDERS = [
  { id: 'agnes',       name: 'Agnes',      env: 'AGNES_API_KEY',       base: 'https://apihub.agnes-ai.com/v1',     models: ['agnes-2.5-flash', 'agnes-3.0-flash'], color: '#7c5cff' },
  { id: 'zhipu',       name: '智谱',        env: 'ZHIPU_API_KEY',       base: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-flash', 'glm-4-plus'],        color: '#2f6bff' },
  { id: 'deepseek',    name: 'DeepSeek',   env: 'DEEPSEEK_API_KEY',    base: 'https://api.deepseek.com/v1',        models: ['deepseek-chat', 'deepseek-reasoner'],color: '#12a57a' },
  { id: 'siliconflow', name: '硅基流动',    env: 'SILICONFLOW_API_KEY', base: 'https://api.siliconflow.cn/v1',      models: ['Qwen/Qwen2.5-72B-Instruct', 'THUDM/glm-4-9b-chat'], color: '#ff6a00' },
  { id: 'volcengine',  name: '火山引擎',    env: 'VOLCENGINE_API_KEY',  base: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-32k', 'doubao-lite-32k'], color: '#0f7cff' },
  { id: 'minimax',     name: 'MiniMax',    env: 'MINIMAX_API_KEY',     base: 'https://api.minimax.chat/v1',        models: ['abab6.5s-chat', 'abab5.5-chat'],     color: '#e5484d' },
  { id: 'moonshot',    name: 'Kimi',       env: 'MOONSHOT_API_KEY',    base: 'https://api.moonshot.cn/v1',         models: ['moonshot-v1-8k', 'moonshot-v1-32k'], color: '#1c1c1e' },
  { id: 'nvidia',      name: 'NVIDIA',     env: 'NVIDIA_API_KEY',      base: 'https://integrate.api.nvidia.com/v1', models: ['nvidia/llama-3.1-nemotron-70b-instruct', 'mistralai/mistral-7b-instruct-v0.3'], color: '#76b900' }
];

// 打包后 asar 只读：密钥写到用户级 .env（真实可配置），覆盖包内文件
const IN_ASAR = __dirname.includes('app.asar');
const USER_ENV_DIR = IN_ASAR
  ? path.join(process.env.APPDATA || path.join(os.homedir(), '.bingdashan'), 'BingDashanAI')
  : ROOT;
const USER_ENV_PATH = path.join(USER_ENV_DIR, '.env');
const KEY_WHITELIST = PROVIDERS_KEYS();

function PROVIDERS_KEYS() {
  return ['AGNES_API_KEY','ZHIPU_API_KEY','DEEPSEEK_API_KEY','SILICONFLOW_API_KEY','VOLCENGINE_API_KEY','VOLCENGINE_MODEL','MINIMAX_API_KEY','MOONSHOT_API_KEY','NVIDIA_API_KEY','GITHUB_TOKEN'];
}
// 合并 .env：包内(低优先) + 用户级(高优先) + 进程环境(最高)
//
// 【2026-09·启动与响应提速】原来每次调用都**同步读两个 .env 文件**并逐行解析。
// 而 list() 里对 8 个 provider 各调一次 getKey()，getKey() 内部又调 envFiles()
// → 一次 list() = 1 + 8 = **9 次 envFiles() = 18 次磁盘读**。
// /v1/status 前端高频轮询，实测 providers.list() 单次 3.45ms，全花在读文件上。
//
// 改为按 mtime+size 缓存（与 core/store.js 的 db 缓存同一套思路）：
// 文件没变就直接返回同一个对象；变了（用户改了密钥）自动失效重读。
// 密钥保存后必须能立刻生效——saveUserKeys 写完会主动 bump 缓存版本。
let _envCache = null;   // { sig, data }
function envSig() {
  let sig = '';
  [ENV_PATH, USER_ENV_PATH].forEach(p => {
    if (!p) return;
    try { const st = fs.statSync(p); sig += p + '|' + st.mtimeMs + '|' + st.size + ';'; } catch (e) { sig += p + '|none;'; }
  });
  return sig;
}
function envFiles() {
  const sig = envSig();
  if (_envCache && _envCache.sig === sig) return _envCache.data;
  const files = [];
  try { const t = fs.readFileSync(ENV_PATH, 'utf8'); files.push(t); } catch (e) {}
  if (USER_ENV_PATH !== ENV_PATH) { try { const t = fs.readFileSync(USER_ENV_PATH, 'utf8'); files.push(t); } catch (e) {} }
  const out = {};
  files.forEach(txt => txt.split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const i = t.indexOf('=');
    if (i < 0) return;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }));
  _envCache = { sig, data: out };
  return out;
}
// 写完密钥后主动失效，保证"保存即生效"不受缓存影响
function invalidateEnvCache() { _envCache = null; }

// 读 .env（KEY=VALUE 行，忽略注释/空行）；保留向后兼容同名导出
function loadEnv() {
  return envFiles();
}

// 写入用户级密钥（仅白名单），打包环境下真实生效。
// 逐行定点改值：保留原文件注释/空行/顺序，仅在缺失时追加。
function saveUserKeys(obj) {
  try {
    if (!fs.existsSync(USER_ENV_DIR)) fs.mkdirSync(USER_ENV_DIR, { recursive: true });
    const keys = {};
    Object.keys(obj).forEach(k => { if (KEY_WHITELIST.includes(k) && String(obj[k] || '').trim()) keys[k] = String(obj[k]).trim(); });
    if (!Object.keys(keys).length) return { ok: false, error: '没有可写入的密钥字段（为空值将被忽略，避免误清空）' };
    let lines = [];
    try { lines = fs.readFileSync(USER_ENV_PATH, 'utf8').split(/\r?\n/); } catch (e) { lines = []; }
    if (!lines.length) lines.push('#' + ' 用户级密钥（丙大山' + 'AI 自动生成）');
    Object.keys(keys).forEach(k => {
      const vi = lines.findIndex(l => {
        const t = l.trim();
        return !t.startsWith('#') && t.split('=')[0].trim() === k;
      });
      const line = k + '=' + keys[k];
      if (vi >= 0) lines[vi] = line; else lines.push(line);
    });
    fs.writeFileSync(USER_ENV_PATH, lines.join('\n'), 'utf8');
    // 主动失效 env 缓存：否则用户刚保存的密钥不会立刻生效（要等 mtime 变化才重读，
    // 而 mtime 精度/时序不保证，这里显式清掉最稳）。
    invalidateEnvCache();
    return { ok: true, path: USER_ENV_PATH, wrote: Object.keys(keys).length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 优先级：进程环境变量 > 设置库 > .env 文件
// 设置库（settings-registry 保存的 secret）优先于 .env，实现"保存即生效"的 BYOK
function getKey(envName, ef) {
  const env = ef || envFiles();
  // 1) 进程环境变量（最高，Docker/CI 注入）
  if (process.env[envName] && process.env[envName].trim()) return process.env[envName].trim();
  // 2) 设置库（用户在界面保存的 BYOK 密钥，type=secret）
  try {
    const store = require('./store');
    const v = store.getSetting(envName);
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  } catch (e) {}
  // 3) .env 文件（包内 + 用户级，最低优先级）
  return (env[envName] || '').trim();
}

// 火山引擎的“模型名”是控制台里的 ep- 端点 ID，不是 doubao-pro-32k；
// 允许用 VOLCENGINE_MODEL 覆盖，避免把端点 ID 硬编码进代码。
function modelOverride(p, ef) {
  if (!p || p.id !== 'volcengine') return '';
  try { return String(getKey('VOLCENGINE_MODEL', ef) || '').trim(); } catch (e) { return ''; }
}
function modelFor(p, wanted, ef) {
  if (wanted) return wanted;
  const ov = modelOverride(p, ef);
  if (ov) return ov;
  return p.models[0];
}

// 列出 8 家状态（含 hasKey / 默认模型）
function list() {
  const ef = envFiles();          // 读一次，8 个 provider 复用（配合 getKey(env, ef) 与 env 缓存）
  return PROVIDERS.map(p => {
    const key = getKey(p.env, ef);
    const ov = modelOverride(p, ef);
    const models = ov ? [ov].concat(p.models.filter(m => m !== ov)) : p.models;
    return {
      id: p.id, name: p.name, base: p.base, color: p.color,
      models, model: models[0],
      hasKey: !!key, keyMask: key ? (key.slice(0, 4) + '****' + key.slice(-4)) : '',
      env: p.env,
      endpointConfigured: p.id === 'volcengine' ? !!ov : undefined,
    };
  });
}

// 统一 chat：OpenAI 兼容 /chat/completions
// opts: { provider, model, messages:[{role,content}], temperature }
async function chat(opts) {
  const ef = loadEnv();
  const p = PROVIDERS.find(x => x.id === opts.provider);
  if (!p) throw new Error('未知模型服务商：' + opts.provider);
  const key = getKey(p.env, ef);
  if (!key) throw new Error(p.name + ' 未配置密钥（请在 .env 填 ' + p.env + '）');

  const model = modelFor(p, opts.model, ef);
  const url = p.base.replace(/\/$/, '') + '/chat/completions';
  const body = {
    model,
    messages: (opts.messages || []).map(m => ({ role: m.role, content: m.content })),
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7,
    stream: false
  };

  // Agent Lightning 式「旁观者」钩子：只留痕，不改业务行为（采集失败静默）。
  const t0 = Date.now();
  const obs = o => { try { require('./lightning').observeChat(o); } catch (e) {} };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    });
  } catch (e) {
    obs({ provider: opts.provider, model, messages: opts.messages, latencyMs: Date.now() - t0, error: 'fetch: ' + e.message, rolloutId: opts.rolloutId });
    throw e;
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    obs({ provider: opts.provider, model, messages: opts.messages, latencyMs: Date.now() - t0, error: 'HTTP ' + res.status, rolloutId: opts.rolloutId });
    throw new Error(p.name + ' 返回 ' + res.status + ': ' + t.slice(0, 200));
  }
  const j = await res.json();
  const content = j && j.choices && j.choices[0] && j.choices[0].message
    ? j.choices[0].message.content : '';
  obs({ provider: opts.provider, model, messages: opts.messages, content, latencyMs: Date.now() - t0, error: content ? null : 'empty', rolloutId: opts.rolloutId });
  if (!content) throw new Error(p.name + ' 返回内容为空');
  // 【2026-10-21 成本记账】读网关返回的 usage → 记一笔成本台账（**不进 revenue**）。
  // 以前连用多少 token 都不知道 → 毛利是黑箱。现在每次调用都有 usage/成本估算可查。
  let usage = null;
  try { usage = (j && j.usage) || null; } catch (e) { usage = null; }
  let cost = null;
  try {
    const cst = require('./cost');
    cost = cst.record({
      provider: opts.provider, model, usage,
      purpose: String(opts.purpose || opts.scene || 'llm'),
      visitor: String(opts.visitor || ''), ms: Date.now() - t0,
    });
  } catch (e) { cost = null; }
  return {
    content, engine: p.name + '/' + model, provider: p.id, model,
    usage: usage || null,
    cost: cost ? { cny: cost.cny, totalTokens: cost.totalTokens } : null,
  };
}

module.exports = { PROVIDERS, list, chat, verify, loadEnv, envFiles, saveUserKeys, getKey };

// —— 双模型交叉验证（借鉴 Polsia：主模型生成、独立第二模型扮演"找茬架构师"复核）——
// 返回字段语义（务必按此判断，历史上 ok 恒为 true 导致本函数形同装饰）：
//   ok        = 复核**真的跑完了**（有第二通道且成功返回）
//   approved  = 复核认为内容无硬伤
//   skipped   = 未能复核（无第二通道/内容过短/复核通道故障）——此时 approved 仅为占位，不可当"已通过"
//   verdict   = 'pass' | 'reject' | 'skip'（唯一可据以做门禁的字段）
// 设计红线：verify 本身不抛错、不阻断主流程（宁可跳过也不让复核故障拖垮业务），
// 但调用方必须看 verdict 才能声称"双签"——跳过不等于通过。
async function verify(opts) {
  const primary = opts.provider || (settingsPrimary() || 'deepseek');
  const content = opts.content || '';
  const brief = opts.brief || '一段待复核结论';
  if (!content || content.length < 20) return { ok: false, approved: false, verdict: 'skip', skipped: true, note: '内容过短，未复核', engine: null, provider: null };

  // 选一个与主模型不同、且已配置密钥的通道作为"找茬架构师"
  let secondary = null;
  for (const x of list()) {
    if (x.id === primary) continue;
    const def = PROVIDERS.find(p => p.id === x.id);
    if (def && getKey(def.env, loadEnv())) { secondary = x.id; break; }
  }
  if (!secondary) return { ok: false, approved: false, verdict: 'skip', skipped: true, note: '无可用第二模型通道，未复核', engine: null, provider: null };

  const criticMsg = [
    { role: 'system', content: '你是资深架构师复核员。下面是一段 AI 生成的待上线结论。请只做一件事：找出其中明显的硬伤——与已给事实/数据矛盾、数字算错、逻辑跳跃、编造来源。若发现任何硬伤，第一句必须以【异议】开头，随后一行理由。若核实无误，只回复【通过】。不要客套，不要重写内容。' },
    { role: 'user', content: '背景事实：\n' + (opts.facts || '（无额外事实）') + '\n\n待复核结论（' + brief + '）：\n' + content }
  ];

  try {
    const r = await chat({ provider: secondary, messages: criticMsg, temperature: 0.1 });
    const note = (r.content || '').trim();
    // 判定以首句为准：出现"异议"即否决（避免"通过…但有异议"被误判为通过）
    const head = note.split(/[\n\r。]/)[0];
    const approved = !/异议|不一致|算错|矛盾|编造|存疑/.test(note) && /通过|无误|无硬伤|^OK$/i.test(head);
    return {
      ok: true, approved,
      verdict: approved ? 'pass' : 'reject',
      skipped: false,
      note: note.slice(0, 300),
      engine: r.engine, provider: secondary
    };
  } catch (e) {
    return { ok: false, approved: false, verdict: 'skip', skipped: true, note: '复核通道不可用：' + String(e.message || e).slice(0, 80), engine: null, provider: secondary };
  }
}

function settingsPrimary() {
  try {
    const store = require('./store');
    const db = store.read();
    return (db.settings && db.settings.provider) || null;
  } catch (e) { return null; }
}
