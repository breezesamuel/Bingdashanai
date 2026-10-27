// core/mcp-client.js — MCP 协议客户端（协议适配的另一半）
//
// 为什么需要它：
//   服务端（core/mcp-protocol.js）让别人用我们的能力；客户端让我们用别人的能力。
//   有了客户端，"接到 instinct / Pipecat / MechAgent / Agent-Reach…" 就不再是
//   把 10 套异构栈（Python/Go/Apple）硬塞进这个 Node 项目，而是**说同一种协议**：
//   任何 MCP 服务器（stdio 本地进程 或 HTTP 远程）都能被挂进来当工具用。
//
// 两条传输：
//   · stdio：spawn 一个子进程，换行分隔的 JSON-RPC 走 stdin/stdout（stderr 只当日志）
//   · HTTP ：Streamable HTTP，POST 一条 JSON-RPC，收 JSON（或 SSE 帧）
//
// 纪律：
//   · 所有请求带超时，且超时必须 reject —— 绝不让一个卡死的子进程吊住整个 Agent。
//   · 请求 id 递增并用 map 关联回包；乱序回来也能对上。
//   · 子进程退出 / 连接断开 → 拒绝所有在途请求，避免永久 pending。

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT = 20000;

class McpStdioClient extends EventEmitter {
  constructor(command, args, opts) {
    super();
    this.command = command;
    this.args = args || [];
    this.opts = opts || {};
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = '';
    this.info = null;
    this.closed = false;
  }

  async start() {
    if (this.proc) return this;
    this.proc = spawn(this.command, this.args, {
      cwd: this.opts.cwd || process.cwd(),
      env: Object.assign({}, process.env, this.opts.env || {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', d => this._onData(d));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', d => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
      if (this.opts.verbose) console.error('[mcp-client stderr] ' + String(d).trim());
    });
    this.proc.on('error', e => this._failAll('子进程启动失败：' + e.message));
    this.proc.on('close', code => this._failAll('MCP 子进程已退出（code=' + code + '）'));
    await this.initialize();
    return this;
  }

  _onData(d) {
    this.buf += d;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // 服务器主动请求（如 sampling/roots）暂不支持：回 -32601，别把连接吊死
    if (msg && msg.method && msg.id !== undefined && msg.id !== null) {
      this._write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Client does not support: ' + msg.method } });
      return;
    }
    if (!msg || msg.id === undefined || msg.id === null) return; // 通知
    const slot = this.pending.get(msg.id);
    if (!slot) return;
    this.pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (msg.error) slot.reject(new Error(msg.error.message || 'MCP error ' + msg.error.code));
    else slot.resolve(msg.result);
  }

  _write(obj) {
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); }
    catch (e) { /* 关断中，忽略 */ }
  }

  _failAll(reason) {
    this.closed = true;
    for (const [, slot] of this.pending) { clearTimeout(slot.timer); slot.reject(new Error(reason)); }
    this.pending.clear();
  }

  request(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(new Error('MCP 连接已断开'));
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('MCP 请求超时（' + (timeoutMs || DEFAULT_TIMEOUT) + 'ms）：' + method));
      }, timeoutMs || DEFAULT_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this._write(msg);
    });
  }

  notify(method, params) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this._write(msg);
  }

  async initialize() {
    const timeoutMs = this.opts.timeoutMs || DEFAULT_TIMEOUT;
    const res = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'bingdashan-ai', version: '2026.0.1' }
    }, timeoutMs);
    this.info = res || {};
    this.notify('notifications/initialized');
    return this.info;
  }

  async listTools() {
    const r = await this.request('tools/list', {}, this.opts.timeoutMs);
    return (r && r.tools) || [];
  }

  async callTool(name, args) {
    return this.request('tools/call', { name, arguments: args || {} }, this.opts.timeoutMs);
  }

  close() {
    this.closed = true;
    this._failAll('客户端主动关闭');
    try { if (this.proc) this.proc.kill(); } catch (e) {}
  }
}

class McpHttpClient {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts || {};
    this.info = null;
    this.sessionId = null;
  }

  _headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return Object.assign(h, this.opts.headers || {});
  }

  async _post(msg, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || DEFAULT_TIMEOUT);
    try {
      const r = await fetch(this.url, { method: 'POST', headers: this._headers(), body: JSON.stringify(msg), signal: ctrl.signal });
      const sid = r.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const ct = r.headers.get('content-type') || '';
      const text = await r.text();
      if (!r.ok) throw new Error('MCP HTTP ' + r.status + '：' + text.slice(0, 200));
      if (ct.indexOf('text/event-stream') >= 0) {
        // SSE：取最后一条含 result/error 的 data 帧
        const frames = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
        for (let i = frames.length - 1; i >= 0; i--) {
          try {
            const j = JSON.parse(frames[i]);
            if (j && (j.result !== undefined || j.error)) return j;
          } catch (e) {}
        }
        throw new Error('MCP SSE 无有效响应帧');
      }
      return text ? JSON.parse(text) : {};
    } finally { clearTimeout(timer); }
  }

  async _request(method, params, timeoutMs) {
    const id = (this._id = (this._id || 0) + 1);
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    const res = await this._post(msg, timeoutMs);
    if (res && res.error) throw new Error(res.error.message || 'MCP error');
    return res && res.result;
  }

  async initialize() {
    const timeoutMs = this.opts.timeoutMs || DEFAULT_TIMEOUT;
    const res = await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, clientInfo: { name: 'bingdashan-ai', version: '2026.0.1' }
    }, timeoutMs);
    this.info = res || {};
    await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutMs).catch(() => {});
    return this.info;
  }

  async listTools() {
    const r = await this._request('tools/list', {}, this.opts.timeoutMs);
    return (r && r.tools) || [];
  }

  async callTool(name, args) {
    return this._request('tools/call', { name, arguments: args || {} }, this.opts.timeoutMs);
  }

  close() { /* HTTP 无长连接 */ }
}

// 工厂：按 transport 建客户端并完成握手
async function connect(server, opts) {
  const t = String(server.transport || 'stdio').toLowerCase();
  if (t === 'http') {
    const c = new McpHttpClient(server.url, Object.assign({}, opts, { headers: server.headers }));
    await c.initialize();
    return c;
  }
  const c = new McpStdioClient(server.command, server.args, opts);
  await c.start();
  return c;
}

module.exports = { McpStdioClient, McpHttpClient, connect, PROTOCOL_VERSION, DEFAULT_TIMEOUT };
