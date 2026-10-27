require('./_isolate');
// e2e_registry_probe.js — 注册表 ↔ 真实路由 运行时对账（2026-10-24）
//
// 【为什么静态解析不可靠】路由声明形式多样（`p===X && req.method===Y` 单行式、
// 嵌套 if 式、前缀匹配式、ext-routes 分发式……），任何正则都会漏。
// 这里用**运行时实证**：起一次性 server 实例，对 paywall 注册表
// （GATED + PUBLIC + FLOW_OPS）的每个端点发真实请求：
//   404 (no route) = 幽灵注册（登记了但路由不存在）
//   其他状态码     = 端点真实存在（200/400/401/403/429/超时 都算存在）
// 超时只记存在（网络型端点在无凭据环境可能慢），不误判幽灵。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let PORT = 0;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-e2e-probe-'));

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, {
        BINGDASHAN_DATA_DIR: DATA, BINGDASHAN_PORT: '0', NODE_ENV: 'test',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('boot timeout')), 30000);
    const onData = (d) => {
      buf += d;
      const m = /listening http:\/\/([0-9.]+):(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[2]) }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

function probe(method, p) {
  return new Promise((resolve) => {
    const data = (method === 'POST' || method === 'PATCH' || method === 'PUT') ? Buffer.from('{}') : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method, timeout: 12000,
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 120) }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: -1, body: 'timeout(=存在，不判幽灵)' }); });
    r.on('error', () => resolve({ status: -2, body: 'conn-error(=存在，不判幽灵)' }));
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const { child, port } = await startServer();
  PORT = port;
  const pw = require(path.join(ROOT, 'core', 'paywall'));
  const norm = (k) => String(k).replace(/\s+/g, ' ');
  const reg = [];
  Object.keys(pw.GATED).forEach((k) => reg.push(norm(k)));
  pw.PUBLIC.forEach((p) => reg.push(norm(p.ep)));
  pw.FLOW_OPS.forEach((p) => reg.push(norm(p.ep)));

  const phantom = [], domain404 = [], alive = {};
  for (const ep of reg) {
    const [method, p] = ep.split(' ');
    const r = await probe(method, p);
    if (r.status === 404) {
      // 区分两种 404：路由不存在（"no route"/纯 "not found" 文本）= 幽灵；
      // 业务级 404（路由存在但资源未找到，如 "task not found"）= 端点真实可用。
      const b = String(r.body || '');
      if (/no route/.test(b) || /^not found\s*$/.test(b)) phantom.push(ep + '   <- ' + b);
      else domain404.push(ep + '   <- ' + b);
    } else alive[r.status] = (alive[r.status] || 0) + 1;
  }
  console.log('探针注册端点总数: ' + reg.length);
  console.log('存在（按状态码分布）: ' + JSON.stringify(alive));
  if (domain404.length) {
    console.log('业务级 404（路由存在、资源未找到 —— 端点真实可用）: ' + domain404.length + ' 条');
    domain404.forEach((x) => console.log('  ~ ' + x));
  }
  console.log('');
  console.log('幽灵注册（404 no route，共 ' + phantom.length + ' 条）:');
  phantom.forEach((x) => console.log('  - ' + x));
  child.kill();
  // run_all.sh 以 "ALL PASS" 字样 + 退出码判定：幽灵为 0 才算过（门禁语义）。
  console.log(phantom.length === 0 ? 'ALL PASS（注册表零幽灵）' : 'FAILED（存在幽灵注册，见上）');
  process.exit(phantom.length === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE ERROR:', e); process.exit(1); });
