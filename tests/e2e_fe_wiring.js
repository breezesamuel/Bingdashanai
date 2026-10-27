require('./_isolate');
// e2e_fe_wiring.js — 前端 → 后端接线审计（2026-10-24）
//
// 【为什么】注册表探针（e2e_registry_probe）只证明"登记的都存在"，
// 但前端可能在调用**没登记也不存在**的端点（死按钮）。真实可用 = 用户点得到的
// 按钮背后有真端点。本脚本：
//   1) 扫描 web/*.js、web/*.html、web/care/*.html 里全部 /v1/ 路径字面量
//      （含拼接动态段的"前缀"单独归类，用哑参数探测）
//   2) 起一次性真实服务，对每个路径 GET+POST 各探一次
//   3) 两种方法都是 "no route"/"not found" = 死链（前端调了但端点不存在）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-e2e-fewire-'));

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

function probe(port, method, p) {
  return new Promise((resolve) => {
    const data = method === 'POST' ? Buffer.from('{}') : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 12000, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 160) }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: -1, body: 'timeout' }); });
    r.on('error', () => resolve({ status: -2, body: 'conn-error' }));
    if (data) r.write(data);
    r.end();
  });
}

// —— 提取前端全部 /v1/ 引用 ——
function scanFrontend() {
  const files = [];
  const walk = (dir) => {
    fs.readdirSync(dir).forEach((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (st.isDirectory()) { if (f !== 'downloads' && f !== 'assets' && f !== 'icons') walk(full); return; }
      if (/\.(js|html)$/.test(f)) files.push(full);
    });
  };
  walk(path.join(ROOT, 'web'));
  const exact = {};    // 完整路径 → [files]
  const dynamic = {};  // 动态前缀（'.../' + 变量）→ [files]
  const skipRe = /\.(png|jpg|jpeg|svg|css|map)$/i;
  files.forEach((f) => {
    if (skipRe.test(f)) return;
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    // 单引号/双引号/反引号里的完整 /v1/ 路径（可带 ?query，后面不跟 + 拼接）
    const re = /['"`](\/v1\/[a-zA-Z0-9/_-]+)(\?[^'"`]*)?['"`]/g;
    let m;
    while ((m = re.exec(src))) {
      const p = m[1];
      exact[p] = exact[p] || [];
      if (exact[p].indexOf(rel) < 0) exact[p].push(rel);
    }
    // 动态拼接：'/v1/xxx/' + var 或 `/v1/xxx/${...}`
    const reD = /['"`](\/v1\/[a-zA-Z0-9/_-]+\/?)['"`]\s*\+/g;
    while ((m = reD.exec(src)) || false) {
      const p = m[1].replace(/\/$/, '');
      dynamic[p] = dynamic[p] || [];
      if (dynamic[p].indexOf(rel) < 0) dynamic[p].push(rel);
    }
    const reT = /(\/v1\/[a-zA-Z0-9/_-]+)\$\{/g;
    while ((m = reT.exec(src))) {
      dynamic[m[1]] = dynamic[m[1]] || [];
      if (dynamic[m[1]].indexOf(rel) < 0) dynamic[m[1]].push(rel);
    }
  });
  // 动态前缀里如果 exact 已有同路径（静态注册过），不算动态
  Object.keys(dynamic).forEach((k) => { if (exact[k]) delete dynamic[k]; });
  return { exact, dynamic, files };
}

(async () => {
  const { child, port } = await startServer();
  const { exact, dynamic, files } = scanFrontend();
  console.log('扫描前端文件: ' + files.length + ' 个');
  console.log('完整路径引用: ' + Object.keys(exact).length + ' 个；动态前缀引用: ' + Object.keys(dynamic).length + ' 个');
  console.log('');

  const dead = [];
  const alive = {};
  // 动态路由变体：server.js 里存在大量 p.match(/^\/v1\/xxx\/:id...$/) 形状的正则路由
  //（如 /v1/autopilot/modules/<id>/run、/v1/manuals/<no>、/v1/skills/<name>/invoke）。
  // 前端字面量带着尾部斜杠（'/v1/manuals/' + no），直接探会误报死链；
  // 判死前先用哑参数试「本体 / <id> / <id>/run」三种形状，任一命中即视为活链。
  const noRoute = (r) => r.status === 404 && (/no route/.test(r.body) || /^not found\s*$/.test(r.body));
  async function anyAlive(base) {
    for (const suffix of ['', '/bd-probe-dummy', '/bd-probe-dummy/run']) {
      const g = await probe(port, 'GET', base + suffix);
      if (!noRoute(g)) return true;
      const po = await probe(port, 'POST', base + suffix);
      if (!noRoute(po)) return true;
    }
    return false;
  }
  for (const p of Object.keys(exact).sort()) {
    const base = p.replace(/\/+$/, '');
    if (await anyAlive(base)) {
      const g = await probe(port, 'GET', base);
      const po = await probe(port, 'POST', base);
      const key = noRoute(g) ? 'POST-only' : (noRoute(po) ? 'GET-only' : 'both');
      alive[key] = (alive[key] || 0) + 1;
      continue;
    }
    dead.push({ p, files: exact[p] });
  }
  const dynDead = [];
  for (const p of Object.keys(dynamic).sort()) {
    // 动态前缀：用哑参数探测该前缀是否有路由接手（如 /v1/report/<id>）
    const g = await probe(port, 'GET', p + '/bd-probe-dummy');
    const po = await probe(port, 'POST', p + '/bd-probe-dummy');
    const gDead = g.status === 404 && (/no route/.test(g.body) || /^not found\s*$/.test(g.body));
    const pDead = po.status === 404 && (/no route/.test(po.body) || /^not found\s*$/.test(po.body));
    if (gDead && pDead) dynDead.push({ p, files: dynamic[p] });
  }

  console.log('完整路径：存在 ' + JSON.stringify(alive) + '；死链 ' + dead.length + ' 个');
  dead.forEach((d) => console.log('  ✗ ' + d.p + '   <- ' + d.files.join(', ')));
  console.log('动态前缀：死链 ' + dynDead.length + ' 个');
  dynDead.forEach((d) => console.log('  ✗ ' + d.p + '/…   <- ' + d.files.join(', ')));

  child.kill();
  const n = dead.length + dynDead.length;
  console.log(n === 0 ? 'ALL PASS（前端零死链）' : 'FAILED（前端存在死链 ' + n + ' 处）');
  process.exit(n === 0 ? 0 : 1);
})().catch((e) => { console.error('FE WIRING ERROR:', e); process.exit(1); });
