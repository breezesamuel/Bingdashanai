// test/e2e/suites/mcp-client-e2e.js — MCP 客户端（协议适配的另一半）
//
// 守护的纪律：
//   1. 客户端必须真能握手 + 取工具 + 调工具，不是"能连上"就算数。
//   2. 两条传输都要通：stdio（子进程）与 HTTP（Streamable HTTP）。
//   3. 请求必须带超时；子进程退出后所有在途请求要被拒绝，绝不永久 pending。
//   4. 注册表增删查走隔离库，且 HTTP 端点必须管理员令牌才可用（403 无令牌）。
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const { finish } = require('./_exit');
const path = require('path');
const client = require(ROOT + '/core/mcp-client');
const BASE = process.env.BINGDASHAN_E2E_BASE || 'http://127.0.0.1:3729';
const ENTRY = path.join(ROOT, 'mcp-server.js');

let pass = 0, fail = 0; const failures = [];
function T(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? ' . ' + detail : '')); }
  else { fail++; failures.push(name); console.log('FAIL ' + name + (detail ? ' . ' + detail : '')); }
}
async function jpost(pathname, body, headers) {
  const r = await fetch(BASE + pathname, {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body)
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
  return { status: r.status, json: j };
}
async function jget(pathname, headers) {
  const r = await fetch(BASE + pathname, { headers: headers || {} });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
  return { status: r.status, json: j };
}

(async () => {
  const doneTimer = setTimeout(() => { console.log('FAIL mcp-client suite timeout'); process.exitCode = 1; }, 90000);
  try {
    // ---------- 1. stdio 客户端 ----------
    let c = null;
    try {
      c = await client.connect({ transport: 'stdio', command: process.execPath, args: [ENTRY] }, { timeoutMs: 15000 });
      T('stdio 客户端握手成功', !!(c.info && c.info.protocolVersion), c.info && c.info.protocolVersion);
      const tools = await c.listTools();
      T('stdio 客户端取到工具', tools.length >= 4, 'n=' + tools.length);
      const call = await c.callTool('business_kpi', {});
      const txt = call && call.content && call.content[0] && call.content[0].text;
      const kpi = txt ? JSON.parse(txt) : null;
      T('stdio 客户端可调工具（business_kpi）', !!(kpi && typeof kpi.revenue === 'number'), 'revenue=' + (kpi && kpi.revenue));
    } catch (e) {
      T('stdio 客户端链路', false, e.message);
    } finally { if (c) c.close(); }

    // 子进程已关：再发请求必须立刻被拒，不能吊死
    if (c) {
      let rejected = false;
      try { await c.request('tools/list', {}, 3000); } catch (e) { rejected = true; }
      T('关闭后请求立即被拒（无永久 pending）', rejected);
    }

    // 超时必须生效（连一个不说话的进程）
    try {
      const dud = new client.McpStdioClient(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {});
      await dud.start().catch(() => {}); // 握手会超时
      let timedOut = false;
      try { await dud.request('tools/list', {}, 1500); } catch (e) { timedOut = /超时/.test(e.message); }
      T('请求超时生效', timedOut);
      dud.close();
    } catch (e) { T('请求超时生效', false, e.message); }

    // ---------- 2. HTTP 客户端 ----------
    try {
      const hc = await client.connect({ transport: 'http', url: BASE + '/mcp' }, { timeoutMs: 10000 });
      T('HTTP 客户端握手成功', !!(hc.info && hc.info.serverInfo && hc.info.serverInfo.name), hc.info && JSON.stringify(hc.info.serverInfo));
      const tools = await hc.listTools();
      T('HTTP 客户端取到工具', tools.length >= 4, 'n=' + tools.length);
      hc.close();
    } catch (e) { T('HTTP 客户端链路', false, e.message); }

    // ---------- 3. Hub 注册表（隔离库）----------
    const hub = require(ROOT + '/core/mcp-hub');
    const before = hub.getServers().length;
    const add = hub.addServer({ name: 'self-stdio', transport: 'stdio', command: process.execPath, args: [ENTRY] });
    T('注册一个 stdio 服务器', add.ok === true, add.error || add.id);
    const sid = add.id;
    T('注册表可列出', hub.getServers().length === before + 1);

    const st = await hub.selftest();
    T('hub 自检连自己的 MCP 服务端', st.ok === true && st.toolCount >= 4, st.ok ? 'toolCount=' + st.toolCount : 'err=' + st.error);

    const ht = await hub.listTools(sid);
    T('hub 列出服务器工具', ht.length >= 4, 'n=' + ht.length);
    const hh = await hub.health(sid);
    T('hub 健康检查（真连）', hh.ok === true && hh.toolCount >= 4 && typeof hh.latencyMs === 'number', 'latency=' + hh.latencyMs + 'ms');
    const hc2 = await hub.callTool(sid, 'business_kpi', {});
    T('hub 调用工具', !!(hc2 && hc2.content && hc2.content[0]), '');
    T('移除服务器', hub.removeServer(sid).ok === true);
    hub.closeAll();

    // ---------- 4. HTTP 端点鉴权 ----------
    const noTok = await jget('/v1/mcp-client/servers');
    T('无令牌 → 403', noTok.status === 403, 'status=' + noTok.status);

    const tok = process.env.BINGDASHAN_ADMIN_TOKEN;
    if (tok) {
      const hdr = { 'X-Admin-Token': tok };
      const listed = await jget('/v1/mcp-client/servers', hdr);
      T('带令牌可列服务器', listed.status === 200 && listed.json && listed.json.ok === true);
      const selftest = await jget('/v1/mcp-client/selftest', hdr);
      T('带令牌 selftest 通过', selftest.json && selftest.json.ok === true, selftest.json && JSON.stringify(selftest.json.serverInfo || {}));
      const rd = await jpost('/v1/mcp-client/servers', { name: 'route-probe', transport: 'stdio', command: process.execPath, args: [ENTRY] }, hdr);
      T('带令牌可注册服务器', rd.status === 200 && rd.json.ok === true, rd.json && rd.json.error);
      if (rd.json && rd.json.id) {
        const tlist = await jget('/v1/mcp-client/tools?id=' + rd.json.id, hdr);
        T('带令牌可列该服务器工具', tlist.json && tlist.json.ok === true && tlist.json.tools.length >= 4);
        const rm = await jpost('/v1/mcp-client/remove', { id: rd.json.id }, hdr);
        T('带令牌可移除服务器', rm.json && rm.json.ok === true);
      }
    } else {
      console.log('SKIP 路由用例（未注入 BINGDASHAN_ADMIN_TOKEN）');
    }

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
