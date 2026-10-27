#!/usr/bin/env node
// mcp-server.js — MCP stdio 传输入口（真正的 Model Context Protocol）
//
// 用法（Claude Desktop / Cursor / Cline 的 mcpServers 配置）：
//   { "mcpServers": { "bingdashan": { "command": "node",
//       "args": ["C:/Users/Think/project/BingDashan/mcp-server.js"] } } }
//
// 纪律：
//   · stdout 只允许出现协议帧（换行分隔的 JSON-RPC 2.0）。任何日志一律走 stderr，
//     否则客户端会把日志当成协议消息解析，连接直接崩。
//   · 不碰生产库？——MCP 工具读取的是 BINGDASHAN_DATA_DIR 指向的数据。默认与
//     主服务同库；要隔离就设 BINGDASHAN_DATA_DIR 后再起。
//   · 协议逻辑全在 core/mcp-protocol.js，本文件只负责「读 stdin 一行 → 回一行」。

const proto = require('./core/mcp-protocol');

function log(...a) { try { process.stderr.write('[bingdashan-mcp] ' + a.join(' ') + '\n'); } catch (e) {} }

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let buf = '';
function handleLine(line) {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch (e) {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  let res;
  try { res = proto.handle(msg); }
  catch (e) { res = { jsonrpc: '2.0', id: (msg && msg.id) || null, error: { code: -32603, message: String((e && e.message) || e) } }; }
  if (res) write(res);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    handleLine(line);
  }
});

process.stdin.on('end', () => { log('stdin closed, exiting'); process.exitCode = 0; });
process.stdin.on('error', e => { log('stdin error: ' + e.message); });
process.on('uncaughtException', e => log('uncaught: ' + (e && e.stack || e)));

log('MCP stdio server ready (' + proto.SERVER_INFO.name + ' v' + proto.SERVER_INFO.version + ', protocol ' + proto.PROTOCOL_VERSION + ')');
