// core/lightning.js — Agent Lightning 式「模型代理层」的本地实现（零改 agent 业务代码）
//
// 背景：microsoft/agent-lightning（MIT，Python）的核心是——
//   在 agent 与底层模型之间插一个代理层（API Gateway），以"旁观者"身份记录每次模型调用、
//   工具使用与最终反馈，在**不改 agent 代码**的前提下，把真实运行轨迹变成强化学习训练样本；
//   奖励函数（任务是否完成/耗时/调用次数）由框架自动收集后做策略优化。
//
// 诚实边界（务必知情）：
//   · 真正的 RL 训练（Trainer = verl + vLLM + CUDA）本机/本项目**跑不了**：那是 Python+GPU 栈
//     （uv sync + scripts/setup_verl.sh）。本文件**不**训练任何模型，也**不**声称能复现
//     "SWE-bench +14.6pt"（那是微软在其 GPU 环境下的公开数据，不是本项目的实测）。
//   · 本文件做的是能在 Node 里真跑的那一半：**代理层 + 轨迹采集 + 奖励计算 + 训练样本导出**。
//     产物（data/lightning.jsonl）可直接喂给外部 RL 训练管线。
//   · "训练与部署共用同一套 harness"：代理层在开发与生产是同一份代码、同一条链路。
//
// 两种接入方式（都不改 agent 业务逻辑）：
//   A. 进程内：把 `providers.chat(...)` 换成 `lightning.proxiedChat(...)`（一行）
//   B. 进程外：外部 agent 把 base_url 指向 `POST /v1/lightning/v1/chat/completions`（真正零改动）

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const ROLLOUTS = 'lightningRollouts';
const JSONL_NAME = 'lightning.jsonl';
const MAX_JSONL_BYTES = 64 * 1024 * 1024; // 超 64MB 轮转
const MAX_READ_BYTES = 8 * 1024 * 1024;   // 读取上限：文件很大时只读尾部（否则 stats 会阻塞事件循环）
const PREVIEW = 2000;                     // 事件内容预览上限

// —— 环境期（ambient rollout）：把「一次请求 / 一次 agent 运行」内发生的所有模型调用
// 归到同一个 rollout，靠 AsyncLocalStorage 传递上下文 —— agent 业务代码一行都不用改。
// 与显式 rollout（写 db.lightningRollouts）的区别：环境期**只写 JSONL**，不落 db，
// 避免每个 HTTP 请求都往 JSON 存储里塞一条记录（db.json 会膨胀、读-改-写放大）。
const _als = new AsyncLocalStorage();

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : Number(x) || 0; }
function round3(x) { return Math.round(Number(x || 0) * 1000) / 1000; }
function preview(v, n) {
  const t = String(v == null ? '' : v);
  return t.length > (n || PREVIEW) ? t.slice(0, n || PREVIEW) : t;
}

// —— 奖励函数注册表（内置；composite 加权组合）——
const REWARD_FNS = {
  task_done: sig => (sig.success === true ? 1 : 0),
  no_error: sig => (Number(sig.errors || 0) > 0 ? 0 : 1),
  fast: sig => clamp01(1 - Number(sig.latencyMs || 0) / 30000),
  few_steps: sig => clamp01(1 - Number(sig.modelCalls || 0) / 20),
  few_tools: sig => clamp01(1 - Number(sig.toolCalls || 0) / 20)
};
const DEFAULT_WEIGHTS = { task_done: 1, no_error: 0.2, few_steps: 0.1, fast: 0.1 };

function scoreSignals(sig, opts) {
  const sigs = sig || {};
  const fn = (opts && opts.fn) || 'composite';
  if (fn !== 'composite') {
    const f = REWARD_FNS[fn];
    if (!f) throw new Error('未知奖励函数：' + fn + '（可选：' + Object.keys(REWARD_FNS).join('/') + '/composite）');
    return { reward: round3(f(sigs)), fn, parts: { [fn]: round3(f(sigs)) } };
  }
  const w = Object.assign({}, DEFAULT_WEIGHTS, (opts && opts.weights) || {});
  let sum = 0, wsum = 0; const parts = {};
  for (const k of Object.keys(w)) {
    const f = REWARD_FNS[k];
    if (!f || !(w[k] > 0)) continue;
    const v = f(sigs);
    parts[k] = round3(v);
    sum += v * w[k];
    wsum += w[k];
  }
  return { reward: wsum ? round3(sum / wsum) : 0, fn: 'composite', parts, weights: w };
}

// —— 存储 ——
function _store() { return require('./store'); }
// 【踩坑记录】必须 join 目录 + 文件名，不能写 store.dataPath('lightning.jsonl')：
// dataPath() 会对传入的整段路径 mkdir -p，传文件名时它会把 lightning.jsonl **建成一个目录**，
// 之后 appendFileSync 全部 EISDIR 被静默吞掉（采集失败不阻断主流程）→ 轨迹永远是空的。
function _jsonlPath() { return path.join(_store().dataPath(), JSONL_NAME); }

function _readJsonl(maxLines) {
  const p = _jsonlPath();
  let txt = '';
  try {
    if (fs.existsSync(p)) {
      const sz = fs.statSync(p).size;
      if (sz > MAX_READ_BYTES) {
        // 只读尾部：大文件全量读会阻塞事件循环（本项目的已知痛点）
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(MAX_READ_BYTES);
        try { fs.readSync(fd, buf, 0, MAX_READ_BYTES, sz - MAX_READ_BYTES); } finally { fs.closeSync(fd); }
        txt = buf.toString('utf8');
        const nl = txt.indexOf('\n');
        if (nl >= 0) txt = txt.slice(nl + 1); // 丢掉被截断的首行
      } else {
        txt = fs.readFileSync(p, 'utf8');
      }
    }
  } catch (e) { return []; }
  const lines = txt.split('\n').filter(Boolean);
  const lim = maxLines && maxLines > 0 ? lines.slice(-maxLines) : lines;
  const out = [];
  for (const l of lim) { try { out.push(JSON.parse(l)); } catch (e) {} }
  return out;
}

// —— Rollout（一次 agent 运行）——
function startRollout(meta) {
  let m = {};
  try { m = meta ? JSON.parse(JSON.stringify(meta)) : {}; } catch (e) { m = { note: preview(meta, 200) }; }
  const rec = _store().push(ROLLOUTS, { status: 'open', startedAt: Date.now(), meta: m }, 'Lightning rollout 开始');
  appendRaw({ ts: Date.now(), rolloutId: rec.id, type: 'rollout_start', meta: m });
  return { ok: true, id: rec.id, startedAt: rec.startedAt };
}

function _getRollout(id) {
  return _store().list(ROLLOUTS, 5000).find(r => r.id === id) || null;
}

// 统一的事件落盘（JSONL + 计数回写）
function appendRaw(rec) {
  const p = _jsonlPath();
  try {
    // 自愈：旧版 bug 可能已把 lightning.jsonl 建成了**目录**（见 _jsonlPath 注释）。
    // 遇到就删掉这个空目录，否则采集永远 EISDIR 静默失败。
    try { if (fs.existsSync(p) && fs.statSync(p).isDirectory()) fs.rmdirSync(p); } catch (e) {}
    if (fs.existsSync(p) && fs.statSync(p).size > MAX_JSONL_BYTES) {
      try { fs.renameSync(p, p + '.1'); } catch (e) {}
    }
    fs.appendFileSync(p, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) { /* 采集失败不阻断主流程 */ }
  return rec;
}

function _bump(rolloutId, patch) {
  const r = _getRollout(rolloutId);
  if (!r) return;
  _store().update(ROLLOUTS, rolloutId, patch, 'Lightning rollout 更新');
}

function recordModelCall(rec) {
  const o = rec || {};
  const ev = {
    ts: Date.now(), rolloutId: o.rolloutId || null, type: 'model_call',
    provider: preview(o.provider, 60), model: preview(o.model, 80),
    messagesCount: Array.isArray(o.messages) ? o.messages.length : 0,
    messages: Array.isArray(o.messages) ? o.messages.map(mm => ({ role: preview(mm && mm.role, 20), content: preview(mm && mm.content, PREVIEW) })) : undefined,
    content: preview(o.content),
    latencyMs: Number(o.latencyMs || 0),
    error: o.error ? preview(o.error) : null
  };
  appendRaw(ev);
  if (ev.rolloutId) {
    const r = _getRollout(ev.rolloutId);
    if (r) _bump(ev.rolloutId, {
      modelCalls: (r.modelCalls || 0) + 1,
      latencyMs: (r.latencyMs || 0) + ev.latencyMs,
      errors: (r.errors || 0) + (ev.error ? 1 : 0)
    });
  }
  return ev;
}

function recordToolCall(rec) {
  const o = rec || {};
  const ev = {
    ts: Date.now(), rolloutId: o.rolloutId || null, type: 'tool_call',
    name: preview(o.name, 80),
    args: o.args === undefined ? undefined : preview(JSON.stringify(o.args), PREVIEW),
    result: o.result === undefined ? undefined : preview(typeof o.result === 'string' ? o.result : JSON.stringify(o.result), PREVIEW),
    latencyMs: Number(o.latencyMs || 0),
    error: o.error ? preview(o.error) : null
  };
  appendRaw(ev);
  if (ev.rolloutId) {
    const r = _getRollout(ev.rolloutId);
    if (r) _bump(ev.rolloutId, {
      toolCalls: (r.toolCalls || 0) + 1,
      latencyMs: (r.latencyMs || 0) + ev.latencyMs,
      errors: (r.errors || 0) + (ev.error ? 1 : 0)
    });
  }
  return ev;
}

// 结束 rollout：算奖励、封存、写训练样本
function endRollout(id, opts) {
  const r = _getRollout(id);
  if (!r) return { ok: false, error: 'rollout 不存在：' + id };
  const o = opts || {};
  const sig = Object.assign({
    success: o.success === true,
    modelCalls: r.modelCalls || 0,
    toolCalls: r.toolCalls || 0,
    latencyMs: r.latencyMs || 0,
    errors: r.errors || 0
  }, o.signals || {});
  const sc = scoreSignals(sig, { fn: o.rewardFn, weights: o.weights });
  _store().update(ROLLOUTS, id, {
    status: 'closed', endedAt: Date.now(), success: sig.success,
    signals: sig, reward: sc.reward, rewardFn: sc.fn, rewardParts: sc.parts
  }, 'Lightning rollout 结束');
  appendRaw({ ts: Date.now(), rolloutId: id, type: 'rollout_end', success: sig.success, signals: sig, reward: sc.reward, rewardFn: sc.fn, rewardParts: sc.parts, sample: o.sample || undefined });
  return { ok: true, id, reward: sc.reward, fn: sc.fn, parts: sc.parts, signals: sig };
}

// —— 代理调用（进程内，一行替换 providers.chat）——
async function proxiedChat(o) {
  const opts = o || {};
  let rid = opts.rolloutId;
  let auto = false;
  if (!rid) { rid = startRollout({ kind: 'auto', provider: opts.provider }).id; auto = true; }
  const t0 = Date.now();
  let res = null, err = null;
  try { res = await require('./providers').chat(opts); }
  catch (e) { err = String((e && e.message) || e); }
  recordModelCall({
    rolloutId: rid, provider: opts.provider, model: (res && res.model) || opts.model,
    messages: opts.messages, content: res && res.content, latencyMs: Date.now() - t0, error: err
  });
  if (err) { const e2 = new Error(err); e2.rolloutId = rid; e2.auto = auto; throw e2; }
  return { content: res.content, engine: res.engine, provider: res.provider, model: res.model, rolloutId: rid, auto };
}

// —— 代理调用（进程外，OpenAI 兼容，真正零改动）——
function providerForModel(model) {
  const P = require('./providers');
  const def = (P.PROVIDERS || []).find(p => (p.models || []).indexOf(model) >= 0);
  if (def) return def;
  const pid = _store().getSetting('provider') || 'deepseek';
  return (P.PROVIDERS || []).find(p => p.id === pid) || (P.PROVIDERS || [])[0];
}

async function proxyRaw(body, rolloutId) {
  const P = require('./providers');
  const b = body || {};
  const def = providerForModel(b.model);
  if (!def) throw new Error('无可用的模型通道');
  const key = P.getKey(def.env, P.loadEnv());
  if (!key) throw new Error(def.name + ' 未配置密钥（请在 .env 设置 ' + def.env + '）');
  const t0 = Date.now();
  let r, txt = '', j = null;
  try {
    r = await fetch(def.base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(b),
      signal: AbortSignal.timeout(120000)
    });
    txt = await r.text();
    try { j = JSON.parse(txt); } catch (e) {}
  } catch (e) {
    recordModelCall({ rolloutId, provider: def.id, model: b.model, messages: b.messages, latencyMs: Date.now() - t0, error: 'upstream fetch: ' + e.message });
    throw e;
  }
  const content = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
  recordModelCall({
    rolloutId, provider: def.id, model: b.model, messages: b.messages, content,
    latencyMs: Date.now() - t0, error: r.ok ? null : ('HTTP ' + r.status)
  });
  if (!r.ok) { const e = new Error('上游 ' + r.status + '：' + preview(txt, 200)); e.status = r.status; e.body = txt; throw e; }
  return j;
}

// —— 环境期采集：真·旁观者（零改 agent 代码）——
// 开关：store 设置 lightningCapture（默认开=只记元数据）/ lightningCaptureContent（默认关=不记正文）。
// 隐私立场：产品里跑的是**用户真实对话**，默认绝不把正文写进轨迹文件；只记
// provider/model/耗时/错误/长度这些能算奖励的信号。要拿正文训练时，显式打开第二个开关。
let _capCache = { at: 0, on: null, content: null };
function _settings() {
  const now = Date.now();
  if (now - _capCache.at < 3000 && _capCache.on !== null) return _capCache;
  let on = true, content = false;
  try { const s = require('./store'); on = s.getSetting('lightningCapture') !== false; content = s.getSetting('lightningCaptureContent') === true; }
  catch (e) { on = false; }
  _capCache = { at: now, on, content };
  return _capCache;
}
function captureEnabled() { try { return _settings().on; } catch (e) { return false; } }
function captureContent() { try { return _settings().content; } catch (e) { return false; } }
// 设置变更后立刻生效（否则 3s 缓存内读到旧值）——配置端点/测试用。
function refreshSettings() { _capCache = { at: 0, on: null, content: null }; return { on: captureEnabled(), content: captureContent() }; }
function currentRolloutId() { const c = _als.getStore(); return (c && c.rolloutId) || null; }

function _ambientId() {
  return 'amb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// 把 fn（同步或异步）放进一个环境 rollout 里跑；结束时按信号算奖励并封口（仅 JSONL）。
// 采集自身出任何错都**不影响** fn 的返回值/异常（旁观者不能挡路）。
function withRollout(meta, fn) {
  if (!captureEnabled()) return fn();
  const rid = _ambientId();
  const startedAt = Date.now();
  let m = {};
  try { m = meta ? JSON.parse(JSON.stringify(meta)) : {}; } catch (e) { m = { note: preview(meta, 200) }; }
  appendRaw({ ts: startedAt, rolloutId: rid, type: 'rollout_start', meta: Object.assign({ ambient: true }, m) });
  const ctx = { rolloutId: rid, calls: 0, tools: 0, errors: 0, t0: startedAt };
  const close = () => {
    try {
      const sig = { success: !ctx.error, modelCalls: ctx.calls, toolCalls: ctx.tools, errors: ctx.errors, latencyMs: Date.now() - startedAt };
      const sc = scoreSignals(sig, {});
      appendRaw({ ts: Date.now(), rolloutId: rid, type: 'rollout_end', ambient: true, signals: sig, reward: sc.reward, rewardFn: sc.fn, parts: sc.parts });
    } catch (e) {}
  };
  let out;
  try { out = _als.run(ctx, () => fn(rid)); }
  catch (e) { ctx.error = String((e && e.message) || e); close(); throw e; }
  if (out && typeof out.then === 'function') {
    return out.then(v => { close(); return v; }, e => { ctx.error = String((e && e.message) || e); close(); throw e; });
  }
  close();
  return out;
}

// providers.chat 的旁观者钩子：默认只记元数据；正文开关打开时才记 messages/content。
function observeChat(o) {
  try {
    const p = o || {};
    const rolloutId = p.rolloutId || currentRolloutId();
    if (!rolloutId) return null;                 // 没有轨迹上下文就不记（保持 JSONL 干净）
    const content = captureContent();
    const msgs = Array.isArray(p.messages) ? p.messages : null;
    const ev = {
      ts: Date.now(), rolloutId, type: 'model_call', source: preview(p.source || 'providers', 30),
      provider: preview(p.provider, 60), model: preview(p.model, 80),
      messagesCount: msgs ? msgs.length : 0,
      promptChars: msgs ? msgs.reduce((a, mm) => a + String((mm && mm.content) || '').length, 0) : 0,
      contentChars: String(p.content || '').length,
      latencyMs: Number(p.latencyMs || 0),
      error: p.error ? preview(p.error, 300) : null
    };
    if (content) {
      ev.messages = Array.isArray(p.messages) ? p.messages.map(mm => ({ role: preview(mm && mm.role, 20), content: preview(mm && mm.content, PREVIEW) })) : undefined;
      ev.content = preview(p.content);
    }
    appendRaw(ev);
    // 同一 async 上下文里的所有模型调用归到同一条轨迹
    const cur = _als.getStore();
    if (cur) { cur.calls = (cur.calls || 0) + 1; if (p.error) cur.errors = (cur.errors || 0) + 1; }
    return ev;
  } catch (e) { return null; }
}

function datasetJsonl(limit) {
  const rows = dataset(limit);
  return rows.length ? rows.map(x => JSON.stringify(x)).join('\n') + '\n' : '';
}

// —— 轨迹总览（含环境期采集的 ambient rollout）——
// 直接从 append-only JSONL 重建，不用 db，因此能反映「真实请求里发生的模型调用」。
function trajectories(limit) {
  const evs = _readJsonl(50000);
  const byR = new Map();
  for (const e of evs) {
    if (!e.rolloutId) continue;
    let g = byR.get(e.rolloutId);
    if (!g) {
      g = { rolloutId: e.rolloutId, ambient: false, startedAt: null, endedAt: null, meta: null,
            modelCalls: 0, toolCalls: 0, errors: 0, reward: null, provider: null, model: null, summary: null };
      byR.set(e.rolloutId, g);
    }
    if (e.type === 'rollout_start') { g.startedAt = e.ts; if (e.meta) { g.meta = e.meta; if (e.meta.ambient) g.ambient = true; } }
    else if (e.type === 'rollout_end') { g.endedAt = e.ts; g.reward = e.reward; g.rewardFn = e.rewardFn; g.signals = e.signals; }
    else if (e.type === 'model_call') { g.modelCalls++; g.provider = g.provider || e.provider; g.model = g.model || e.model; if (e.error) g.errors++; g.summary = g.summary || preview(e.content, 80); }
    else if (e.type === 'tool_call') { g.toolCalls++; if (e.error) g.errors++; }
  }
  const arr = Array.from(byR.values()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return limit && limit > 0 ? arr.slice(0, limit) : arr;
}

// —— 查询 / 导出 ——
function getRollout(id) {
  const r = _getRollout(id);
  if (!r) return null;
  const events = _readJsonl(20000).filter(e => e.rolloutId === id);
  return Object.assign({}, r, { events });
}

function listRollouts(limit) {
  const l = _store().list(ROLLOUTS, limit || 50);
  return l.map(r => ({
    id: r.id, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt,
    success: r.success, reward: r.reward, modelCalls: r.modelCalls || 0,
    toolCalls: r.toolCalls || 0, latencyMs: r.latencyMs || 0, errors: r.errors || 0, meta: r.meta
  }));
}

// 训练样本：一条 rollout = 一个样本（轨迹 + 奖励），可直接喂外部 RL 训练管线
function dataset(limit) {
  const closed = _store().list(ROLLOUTS, 5000).filter(r => r.status === 'closed');
  const events = _readJsonl(20000);
  const byR = {};
  for (const e of events) { if (e.rolloutId) (byR[e.rolloutId] = byR[e.rolloutId] || []).push(e); }
  const chosen = limit && limit > 0 ? closed.slice(-limit) : closed;
  return chosen.map(r => ({
    rolloutId: r.id,
    meta: r.meta,
    success: r.success === true,
    reward: r.reward,
    rewardFn: r.rewardFn,
    rewardParts: r.rewardParts,
    signals: r.signals,
    trajectory: (byR[r.id] || []).filter(e => e.type === 'model_call' || e.type === 'tool_call')
  }));
}

function datasetJsonl(limit) {
  const rows = dataset(limit);
  return rows.length ? rows.map(x => JSON.stringify(x)).join('\n') + '\n' : '';
}

function stats() {
  const all = _store().list(ROLLOUTS, 5000);
  const closed = all.filter(r => r.status === 'closed');
  const sum = k => closed.reduce((a, r) => a + Number(r[k] || 0), 0);
  // 环境期（ambient）轨迹只存在 JSONL 里，单独统计
  let amb = [];
  try { amb = trajectories(5000).filter(t => t.ambient); } catch (e) {}
  return {
    ok: true,
    rollouts: all.length,
    open: all.filter(r => r.status === 'open').length,
    closed: closed.length,
    successRate: closed.length ? round3(closed.filter(r => r.success).length / closed.length) : 0,
    avgReward: closed.length ? round3(sum('reward') / closed.length) : 0,
    avgLatencyMs: closed.length ? Math.round(sum('latencyMs') / closed.length) : 0,
    totalModelCalls: sum('modelCalls'),
    totalToolCalls: sum('toolCalls'),
    totalErrors: sum('errors'),
    // 真实运行（旁观者）采集
    captureEnabled: captureEnabled(),
    captureContent: captureContent(),
    ambientRollouts: amb.length,
    ambientModelCalls: amb.reduce((a, t) => a + (t.modelCalls || 0), 0),
    jsonlPath: _jsonlPath(),
    rewardFns: Object.keys(REWARD_FNS)
  };
}

module.exports = {
  REWARD_FNS, DEFAULT_WEIGHTS, scoreSignals,
  startRollout, recordModelCall, recordToolCall, endRollout,
  proxiedChat, proxyRaw, providerForModel,
  // 旁观者采集（零改 agent 代码）
  captureEnabled, captureContent, currentRolloutId, withRollout, observeChat, trajectories, refreshSettings,
  getRollout, listRollouts, dataset: dataset, datasetJsonl, stats
};
