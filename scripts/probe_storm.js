#!/usr/bin/env node
/* scripts/probe_storm.js — 100+ 轮探针风暴：稳定性 + 延迟基线（2026-10-25）
 *
 * 【定位】e2e 各套件验证"功能对不对"；本脚本验证"连打 100+ 轮会不会坏"——
 * 内存限流表/缓存/静态服务在持续轮询下的稳定性，以及 p50/p95 延迟基线
 * （后续性能回归拿这次的数据当对照）。
 * 只打只读轻端点 + 静态资产（gzip 生效验证），不碰台账写路径。
 */
'use strict';
require('../tests/_isolate.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUNDS = 11;               // × 10 端点 = 110 轮
const TARGETS = [
  '/v1/status', '/v1/plans', '/v1/subs/status', '/v1/subs/quota',
  '/v1/rank?field=score', '/v1/audit?limit=1', '/v1/messages?limit=1',
  '/app.js', '/i18n-console.js', '/download.html',
];

function startServer(DATA) {
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

function once(port, p, gzip) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = http.request({
      host: '127.0.0.1', port, path: p, method: 'GET',
      headers: gzip ? { 'accept-encoding': 'gzip' } : {},
    }, (res) => {
      let n = 0;
      res.on('data', c => { n += c.length; });
      res.on('end', () => resolve({
        ms: Date.now() - t0, status: res.statusCode, bytes: n,
        enc: String(res.headers['content-encoding'] || ''),
      }));
    });
    r.on('error', (e) => resolve({ ms: Date.now() - t0, status: 0, err: String(e.message) }));
    r.end();
  });
}

(async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-storm-'));
  const { child, port } = await startServer(DATA);
  await once(port, '/v1/status');
  console.log('=== 探针风暴：' + ROUNDS + ' 轮 × ' + TARGETS.length + ' 端点 = ' + (ROUNDS * TARGETS.length) + ' 请求 ===');

  let fails = 0;
  const lat = [];
  for (let i = 0; i < ROUNDS; i++) {
    for (const p of TARGETS) {
      const r = await once(port, p, true);
      lat.push({ p, ms: r.ms });
      if (!r.status || r.status >= 500) {
        fails++;
        if (fails <= 5) console.log('  [FAIL] #' + (i + 1) + ' ' + p + ' → ' + (r.status || r.err));
      }
    }
  }
  const nums = lat.map(x => x.ms).sort((a, b) => a - b);
  const p = (q) => nums[Math.min(nums.length - 1, Math.floor(nums.length * q))];
  console.log('  p50=' + p(0.5) + 'ms  p90=' + p(0.9) + 'ms  p95=' + p(0.95) + 'ms  max=' + nums[nums.length - 1] + 'ms');

  // gzip 生效验证：大 JS 压缩后应明显小于原文件（且带 Content-Encoding: gzip）
  const raw = await once(port, '/app.js', false);
  const gz = await once(port, '/app.js', true);
  const gzOk = gz.enc === 'gzip' && gz.bytes > 0 && gz.bytes < raw.bytes * 0.6;
  console.log('  [gzip] app.js 原始 ' + Math.round(raw.bytes / 1024) + 'KB → 压缩 ' + Math.round(gz.bytes / 1024) + 'KB (' + Math.round(gz.bytes / raw.bytes * 100) + '%) ' + (gzOk ? 'OK' : '异常'));
  if (!gzOk) fails++;

  // 并发风暴：20 路同时打（模拟面板全开），全部 <500 即过
  const burst = await Promise.all(Array.from({ length: 20 }, () => once(port, '/v1/status', true)));
  const burstBad = burst.filter(x => !x.status || x.status >= 500).length;
  console.log('  [burst] 20 并发 /v1/status → ' + (20 - burstBad) + '/20 OK');
  if (burstBad) fails += burstBad;

  child.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  console.log(fails ? 'STORM FAILED（' + fails + '）' : 'STORM ALL PASS（110+ 轮零 5xx，gzip/并发风暴通过）');
  process.exit(fails ? 1 : 0);
})();
