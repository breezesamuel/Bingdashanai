// core/mcp-hub.js — 外部 MCP 服务器注册表 + 连接池
//
// 解决"接入异构 Agent"的正确姿势：不把别人的栈塞进来，而是登记它们的 MCP 端点，
// 需要时连上、握手、取工具、调用。stdio（本地进程）与 HTTP（远程）统一到这里。
//
// 安全边界（重要）：
//   · 登记服务器 = 允许在本机启动任意命令 / 访问任意 URL，属**运营级**危险操作。
//     所有增删查调一律走管理员令牌（server.js 里 adminAuthedStrict），绝不对买家开放。
//   · 服务器清单存 store 设置项，不落任何凭据到公开端点。

const crypto = require('crypto');
const client = require('./mcp-client');

const SETTING_KEY = 'mcpClientServers';
const pool = new Map(); // id -> client 实例

function _store() { return require('./store'); }

function getServers() {
  const list = _store().getSetting(SETTING_KEY);
  return Array.isArray(list) ? list : [];
}

function _save(list) { _store().setSetting(SETTING_KEY, list); }

function _public(s) {
  return {
    id: s.id, name: s.name, transport: s.transport,
    command: s.command, args: s.args, url: s.url,
    enabled: s.enabled !== false, at: s.at
  };
}

function addServer(input) {
  const b = input || {};
  const transport = String(b.transport || 'stdio').toLowerCase();
  const name = String(b.name || '').trim();
  if (!name) return { ok: false, error: 'name 必填' };
  const s = { id: 'mcp_' + crypto.randomBytes(5).toString('hex'), name: name.slice(0, 60), transport, enabled: b.enabled !== false, at: Date.now() };
  if (transport === 'http') {
    const url = String(b.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'HTTP 服务器需要合法的 url' };
    s.url = url;
    if (b.headers && typeof b.headers === 'object') s.headers = b.headers;
  } else {
    const command = String(b.command || '').trim();
    if (!command) return { ok: false, error: 'stdio 服务器需要 command（如 node / npx / python）' };
    s.command = command;
    s.args = Array.isArray(b.args) ? b.args.map(String) : [];
    if (b.cwd) s.cwd = String(b.cwd);
  }
  const list = getServers();
  if (list.length >= 20) return { ok: false, error: '服务器数量上限 20' };
  list.push(s);
  _save(list);
  _store().push('audit', { action: '登记 MCP 服务器', detail: name + ' [' + transport + ']', at: Date.now() });
  return { ok: true, id: s.id, server: _public(s) };
}

function removeServer(id) {
  const list = getServers();
  const next = list.filter(s => s.id !== id);
  if (next.length === list.length) return { ok: false, error: '服务器不存在：' + id };
  const hit = pool.get(id);
  if (hit) { try { hit.close(); } catch (e) {} pool.delete(id); }
  _save(next);
  _store().push('audit', { action: '移除 MCP 服务器', detail: String(id), at: Date.now() });
  return { ok: true, removed: id };
}

function _find(id) { return getServers().find(s => s.id === id) || null; }

async function _client(id) {
  const s = _find(id);
  if (!s) throw new Error('服务器不存在：' + id);
  if (s.enabled === false) throw new Error('服务器已停用：' + s.name);
  const cached = pool.get(id);
  if (cached && !cached.closed) return cached;
  const c = await client.connect(s, { cwd: s.cwd, timeoutMs: 20000 });
  pool.set(id, c);
  return c;
}

async function listTools(id) {
  const c = await _client(id);
  const tools = await c.listTools();
  return tools.map(t => Object.assign({}, t, { serverId: id }));
}

// 聚合所有已启用服务器的工具（用于让 Agent/UI 看到"我现在能用什么"）
async function aggregateTools() {
  const out = [];
  for (const s of getServers()) {
    if (s.enabled === false) continue;
    try {
      const c = await _client(s.id);
      const tools = await c.listTools();
      tools.forEach(t => out.push({ server: s.name, serverId: s.id, name: t.name, description: t.description, inputSchema: t.inputSchema }));
    } catch (e) {
      out.push({ server: s.name, serverId: s.id, error: String(e.message || e) });
    }
  }
  return out;
}

async function callTool(id, name, args) {
  const c = await _client(id);
  return c.callTool(name, args || {});
}

// 健康检查：真连一次、握手、取工具数，并测延迟 —— 不猜，只报实测
async function health(id) {
  const t0 = Date.now();
  try {
    const c = await _client(id);
    const tools = await c.listTools();
    return {
      ok: true, id,
      latencyMs: Date.now() - t0,
      protocolVersion: (c.info && c.info.protocolVersion) || null,
      serverInfo: (c.info && c.info.serverInfo) || null,
      toolCount: tools.length
    };
  } catch (e) {
    return { ok: false, id, latencyMs: Date.now() - t0, error: String(e.message || e) };
  }
}

function closeAll() {
  for (const [, c] of pool) { try { c.close(); } catch (e) {} }
  pool.clear();
}

// 自检：连我们自己的 stdio MCP 服务端，证明客户端链路真的通
async function selftest() {
  const path = require('path');
  const entry = path.join(__dirname, '..', 'mcp-server.js');
  const tmp = { id: 'selftest', name: 'selftest', transport: 'stdio', command: process.execPath, args: [entry], enabled: true };
  let c;
  try {
    c = await client.connect(tmp, { timeoutMs: 15000 });
    const tools = await c.listTools();
    const call = await c.callTool('business_kpi', {});
    return {
      ok: true,
      protocolVersion: (c.info && c.info.protocolVersion) || null,
      serverInfo: (c.info && c.info.serverInfo) || null,
      toolCount: tools.length,
      sample: call && call.content && call.content[0] ? String(call.content[0].text).slice(0, 200) : null
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally { if (c) try { c.close(); } catch (e) {} }
}

module.exports = { getServers, addServer, removeServer, listTools, callTool, health, closeAll, selftest, _public };
