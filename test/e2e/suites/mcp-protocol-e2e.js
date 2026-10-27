// test/e2e/suites/mcp-protocol-e2e.js — 真正的 MCP（Model Context Protocol）协议适配
//
// 守护的纪律：
//   1. 说 MCP 就得说 MCP 协议：JSON-RPC 2.0 + initialize / tools/list / tools/call。
//      以前 core/mcp.js 只是自称 MCP 的自家 HTTP 包装，标准客户端连不上。
//   2. 通知（无 id）绝不回包 —— 回了就是协议违规，客户端会判定 server 坏掉。
//   3. 未知方法必须回 -32601，非法请求回 -32600，不能吞。
//   4. 登记的工具必须真的有 handler，且真的能跑出结果（不是占位）。
//   5. 两条传输都必须通：stdio（本地挂载）+ HTTP POST /mcp（远程网关）。
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const { finish } = require('./_exit');
const { spawn } = require('child_process');
const proto = require(ROOT + '/core/mcp-protocol');
const BASE = process.env.BINGDASHAN_E2E_BASE || 'http://127.0.0.1:3729';

let pass = 0, fail = 0; const failures = [];
function T(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? ' . ' + detail : '')); }
  else { fail++; failures.push(name); console.log('FAIL ' + name + (detail ? ' . ' + detail : '')); }
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) {}
  return { status: r.status, json: j, text: txt };
}

// stdio 传输：spawn mcp-server.js，喂若干行 JSON-RPC，收 N 条响应
function runStdio(lines, expectCount, timeoutMs) {
  return new Promise(res => {
    const p = spawn(process.execPath, [ROOT + '/mcp-server.js'], {
      cwd: ROOT, env: Object.assign({}, process.env), stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '', err = '', done = false;
    const parse = () => out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    const timer = setTimeout(() => settle(true), timeoutMs || 8000);
    function settle(timedOut) {
      if (done) return; done = true; clearTimeout(timer);
      try { p.kill(); } catch (e) {}
      res({ got: parse(), err, timedOut: !!timedOut });
    }
    p.stdout.on('data', d => { out += d; if (parse().length >= expectCount) settle(false); });
    p.stderr.on('data', d => { err += d; });
    p.on('error', () => settle(false));
    try { p.stdin.write(lines.join('\n') + '\n'); } catch (e) {}
  });
}

(async () => {
  const doneTimer = setTimeout(() => { console.log('FAIL mcp suite timeout'); process.exitCode = 1; }, 60000);
  try {
    // ---------- 1. 协议层（纯逻辑，不起服务）----------
    const init = proto.handle({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } }
    });
    T('initialize 返回 protocolVersion', init && init.result && init.result.protocolVersion === '2025-06-18', init && JSON.stringify(init.result && init.result.serverInfo));
    T('initialize 声明 tools 能力', !!(init.result.capabilities && init.result.capabilities.tools));
    T('initialize 有 serverInfo.name', !!(init.result.serverInfo && init.result.serverInfo.name));

    // 客户端要一个我们不支持的版本 → 回落默认，但不能崩
    const initOld = proto.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    T('未知协议版本回落默认', !!initOld.result && proto.PROTOCOL_VERSIONS.indexOf(initOld.result.protocolVersion) >= 0, initOld.result.protocolVersion);

    // 通知（无 id）必须返回 null —— 绝不回包
    T('notifications/initialized 不回包', proto.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }) === null);

    const list = proto.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const tools = (list.result && list.result.tools) || [];
    T('tools/list 返回工具', tools.length >= 4, 'n=' + tools.length);
    T('tools/list 每个工具有 name/description/inputSchema', tools.every(t => t.name && t.description && t.inputSchema && t.inputSchema.type === 'object'));
    T('包含 case_search', tools.some(t => t.name === 'case_search'));
    T('包含 business_kpi', tools.some(t => t.name === 'business_kpi'));

    // 每个登记工具都能真跑（带最小参数），不得抛异常
    let ran = 0;
    for (const t of tools) {
      const call = proto.handle({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: t.name, arguments: {} } });
      if (call && call.result && Array.isArray(call.result.content) && call.result.content[0] && typeof call.result.content[0].text === 'string') ran++;
    }
    T('全部登记工具都可调用（返回 content）', ran === tools.length, ran + '/' + tools.length);

    // business_kpi 是真数据，且营收是数字（诚实时应为 0）
    const kpiCall = proto.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'business_kpi', arguments: {} } });
    const kpi = JSON.parse(kpiCall.result.content[0].text);
    T('business_kpi.revenue 为数字', typeof kpi.revenue === 'number', 'revenue=' + kpi.revenue);

    // 未知工具 → isError
    const badTool = proto.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    T('未知工具 isError=true', badTool.result && badTool.result.isError === true);

    // 未知方法 → -32601
    const badMethod = proto.handle({ jsonrpc: '2.0', id: 6, method: 'does/not/exist' });
    T('未知方法 -32601', badMethod.error && badMethod.error.code === -32601);

    // 非法请求 → -32600
    const badReq = proto.handle({ foo: 'bar' });
    T('非法请求 -32600', badReq.error && badReq.error.code === -32600);

    // ping
    const ping = proto.handle({ jsonrpc: '2.0', id: 7, method: 'ping' });
    T('ping 返回空结果', ping.result && Object.keys(ping.result).length === 0);

    // ---------- 2. HTTP 传输 ----------
    try {
      const h1 = await post('/mcp', { jsonrpc: '2.0', id: 'h1', method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      T('HTTP POST /mcp initialize 200', h1.status === 200 && h1.json && h1.json.result && !!h1.json.result.serverInfo, 'status=' + h1.status);

      const h2 = await post('/mcp', { jsonrpc: '2.0', id: 'h2', method: 'tools/list' });
      T('HTTP POST /mcp tools/list', h2.status === 200 && h2.json.result.tools.length >= 4);

      const hn = await post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' });
      T('HTTP 通知返回 202 且无 body', hn.status === 202 && !hn.text);
    } catch (e) {
      T('HTTP 传输可用', false, e.message);
    }
    try {
      const g = await fetch(BASE + '/mcp');
      T('GET /mcp 返回 405', g.status === 405, 'status=' + g.status);
    } catch (e) { T('GET /mcp 返回 405', false, e.message); }

    // ---------- 3. stdio 传输 ----------
    const s = await runStdio([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    ], 2, 8000);
    T('stdio 启动并回包', !s.timedOut && s.got.length >= 2, 'got=' + s.got.length);
    T('stdio 只回请求、不回通知（恰好 2 条）', s.got.length === 2, 'got=' + s.got.length);
    T('stdio initialize 有 serverInfo', !!(s.got.find(x => x.id === 1) || {}).result);
    T('stdio tools/list 有工具', (((s.got.find(x => x.id === 2) || {}).result || {}).tools || []).length >= 4);

    console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
    clearTimeout(doneTimer);
    return finish(fail ? 1 : 0);
  } catch (e) {
    console.log('FAIL 套件异常: ' + (e && e.stack || e));
    console.log('===== ' + pass + ' PASS / ' + (fail + 1) + ' FAIL =====');
    clearTimeout(doneTimer);
    return finish(1);
  }
})();
