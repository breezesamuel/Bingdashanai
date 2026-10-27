// core/mcp-protocol.js — 真正的 Model Context Protocol（MCP）协议适配层
//
// 为什么单独做这个：
//   core/mcp.js 只是「自称 MCP」的自定义 HTTP 包装（POST /v1/mcp/call），
//   它不说 MCP 协议（没有 JSON-RPC 2.0、没有 initialize/tools/list/tools/call、
//   没有 stdio/HTTP 传输），所以任何标准 MCP 客户端（Claude Desktop、Cursor、
//   Cline、LibreChat…）都连不上——「协议适配」是空话。
//
// 本文件实现协议本身，与传输无关：handle(msg) 吃一条 JSON-RPC 消息，吐一条响应。
//   · 传输一：mcp-server.js（stdio，换行分隔的 JSON-RPC）——本地 Agent 直接挂载
//   · 传输二：POST /v1/mcp/rpc（HTTP）——远程客户端/网关调用
//
// 只暴露真实、可用的工具，且默认只读/免费；计费工具复用既有 core/mcp.js 的账务红线
// （必须 API key + 预充值，绝不接受自报金额）。

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';
const SERVER_INFO = { name: 'bingdashan-ai', version: '2026.0.1', title: '丙大山 AI Agent · MCP 协议适配层' };

function lazy(p) { return require(p); }

// —— 工具目录：每个工具都有真实 handler；没有 handler 的工具绝不登记 ——
const TOOLS = [
  {
    name: 'case_search',
    description: '检索「活下去手册」案例卡（免费，正文带水印）。',
    inputSchema: {
      type: 'object',
      properties: {
        gua: { type: 'string', description: '可选，处境卦编号 S01–S16' },
        kw: { type: 'string', description: '可选，关键词过滤' }
      },
      additionalProperties: false
    },
    handler: (args) => lazy('./mcp').caseSearch(args || {})
  },
  {
    name: 'manual_get',
    description: '获取「活下去手册」全文（免费，免登录）。',
    inputSchema: {
      type: 'object',
      properties: {
        no: { type: 'integer', description: '手册编号 1–12' },
        slug: { type: 'string', description: '或手册 slug' }
      },
      additionalProperties: false
    },
    handler: (args) => lazy('./mcp').manualGet(args || {})
  },
  {
    name: 'decision_deliberate',
    description: '完整七段推演（计费 ¥0.99/次，需 API key；命中医疗/法律/金融禁区直接拒且不扣费）。',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '命题，≤200 字' },
        context: { type: 'string', description: '可选上下文' },
        key: { type: 'string', description: '开发者 API key（bds_ 开头）' }
      },
      required: ['topic', 'key'],
      additionalProperties: false
    },
    handler: (args) => lazy('./mcp').deliberate(args || {})
  },
  {
    name: 'business_kpi',
    description: '只读：真实经营 KPI（真实到账营收、自测单隔离口径、目标进度）。不含任何敏感数据。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const k = lazy('./money').kpi();
      return {
        ok: true,
        revenue: k.revenue, target: k.target, pct: k.pct, onTrack: k.onTrack,
        testRevenue: k.testRevenue, testCount: k.testCount,
        pending: k.pending, orders: k.orders,
        daysLeft: k.daysLeft, needDaily: k.needDaily
      };
    }
  },
  {
    name: 'evidence_status',
    description: '只读：商业化证据门禁状态（哪些维度已确认、还缺哪些）。没有真实证据时如实返回 0。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const g = lazy('./market-evidence').gateCheck();
      return { ok: true, pass: g.pass, missing: g.missing, dims: g.summary.dims };
    }
  },
  {
    name: 'crm_pipeline',
    description: '只读：CRM-lite 漏斗摘要（线索/商机/待成交/客户 数量、真实到账金额、还等你做什么）。仅聚合数字，不含客户姓名。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => lazy('./crm').summary()
  },
  {
    name: 'org_brain',
    description: '只读：组织大脑概览（在编/在岗人数、项目数、在跑项目数）。仅计数，不含人员隐私。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const s = lazy('./store').orgStats();
      let tickets = null;
      try { const t = lazy('./tickets'); if (t && t.stats) tickets = t.stats(); } catch (e) {}
      return { ok: true, ...s, tickets };
    }
  },
  {
    name: 'decision_stats',
    description: '只读：决策中心统计（累计决策数、7 日趋势）。仅计数，不含决策内容。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const st = lazy('./store').decisionStats();
      return { ok: true, total: st.total, trend: st.trend };
    }
  },
  {
    name: 'funnel_stats',
    description: '只读：获客漏斗各阶段存量 + 真实到账金额。仅聚合数字，不含线索姓名。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const p = lazy('./crm').pipeline();
      return { ok: true, funnel: p.funnel, revenue: p.revenue, customers: p.customers, waitingHuman: p.waitingHuman, note: p.note };
    }
  },
  {
    name: 'lightning_stats',
    description: '只读：Agent Lightning 轨迹采集统计（rollout 数、成功奖励、模型调用次数）。仅计数，不含对话正文。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const s = lazy('./lightning').stats();
      return { ok: true, rollouts: s.rollouts, closed: s.closed, successRate: s.successRate, avgReward: s.avgReward, ambientRollouts: s.ambientRollouts, ambientModelCalls: s.ambientModelCalls, captureEnabled: s.captureEnabled, captureContent: s.captureContent };
    }
  }
];

const TOOL_INDEX = new Map(TOOLS.map(t => [t.name, t]));

function ok(id, result) { return { jsonrpc: '2.0', id: id === undefined ? null : id, result }; }
function rpcError(id, code, message, data) {
  const e = { code, message };
  if (data !== undefined) e.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: e };
}

function initializeResult(params) {
  const want = params && params.protocolVersion;
  const version = PROTOCOL_VERSIONS.includes(want) ? want : DEFAULT_PROTOCOL;
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
    serverInfo: SERVER_INFO,
    instructions: '丙大山 MCP：可调用 case_search / manual_get（免费）、decision_deliberate（计费，需 key）、business_kpi / evidence_status / crm_pipeline / org_brain / decision_stats / funnel_stats / lightning_stats（只读经营数据）。'
  };
}

function callTool(params) {
  const name = String((params && params.name) || '').trim();
  const args = (params && params.arguments) || {};
  const tool = TOOL_INDEX.get(name);
  if (!tool) return { content: [{ type: 'text', text: '未知工具：' + name }], isError: true };
  let out;
  try {
    out = tool.handler(args);
  } catch (e) {
    return { content: [{ type: 'text', text: '工具执行失败：' + String(e.message || e) }], isError: true };
  }
  const isErr = out && out.ok === false;
  const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
  const res = { content: [{ type: 'text', text }] };
  if (isErr) res.isError = true;
  return res;
}

// —— 单条消息处理。返回响应对象；通知（无 id）返回 null ——
function handle(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id, -32600, 'Invalid Request');
  }
  const id = msg.id;
  const notification = (id === undefined || id === null);
  const method = msg.method;
  const params = msg.params;
  try {
    switch (method) {
      case 'initialize': return ok(id, initializeResult(params || {}));
      case 'notifications/initialized': return null;
      case 'ping': return { jsonrpc: '2.0', id: id === undefined ? null : id, result: {} };
      case 'tools/list':
        return ok(id, { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case 'tools/call':
        return ok(id, callTool(params));
      case 'resources/list':
        return ok(id, { resources: [] });
      case 'prompts/list':
        return ok(id, { prompts: [] });
      default:
        if (id === undefined || id === null) return null; // 未知名通知：按规范不得回包
        return rpcError(id, -32601, 'Method not found: ' + method);
    }
  } catch (e) {
    return rpcError(id, -32603, String((e && e.message) || e));
  }
}

module.exports = {
  PROTOCOL_VERSION: DEFAULT_PROTOCOL,
  PROTOCOL_VERSIONS,
  SERVER_INFO,
  TOOLS,
  handle,
  initializeResult,
  callTool
};
