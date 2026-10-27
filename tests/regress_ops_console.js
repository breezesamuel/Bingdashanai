require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 回归测试：运营台（退款待办台接口 + 运营台页面）
// 做法：起一个**隔离实例**（临时数据目录 + 独立端口），用真实 HTTP 打。
// 锁死：
//   1. 退款待办台**必须**带管理令牌（回环也不例外）—— 资金数据不能裸奔
//   2. 申请 ≠ 已退款：队列里待出款的单必须显示 requested
//   3. 运营台页面能打开、且**不硬编码**任何令牌
process.env.BINGDASHAN_DATA_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'bd-ops-')
);

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.BINGDASHAN_DATA_DIR;

let PORT = 0;
function freePort() {
  return new Promise((resolve) => {
    const s = require('net').createServer();
    s.on('error', () => resolve(0));
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + extra : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }

// cookie jar：访客身份是**签名过的 bd_vid cookie**（X-Visitor 头只认签名值）。
// 不带 cookie 的每次请求都会被当成新访客 → 退款申请自然"无权操作该订单"。
let COOKIE = '';
function req(method, p, body, headers) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = Object.assign({ 'content-type': 'application/json' }, headers || {});
    if (COOKIE) h.cookie = COOKIE;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method, headers: h,
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc && sc.length) {
          const v = String(sc[0]).split(';')[0];
          if (v.indexOf('bd_vid=') === 0) COOKIE = v;
        }
        let j = null;
        try { j = JSON.parse(b); } catch (e) { /* 非 JSON 原样返回 */ }
        resolve({ status: res.statusCode, body: j, raw: b });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: null, raw: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  PORT = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      BINGDASHAN_DATA_DIR: DATA,
      BINGDASHAN_PORT: String(PORT),
      BINGDASHAN_HOST: '127.0.0.1',
      NODE_ENV: 'test',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const r = await req('GET', '/v1/pay/channels');
    if (r.status === 200) { up = true; break; }
  }
  if (!up) {
    ok(false, '隔离实例启动成功', out.slice(-500));
    try { child.kill(); } catch (e) {}
    process.exit(1);
  }
  ok(true, '隔离实例启动成功（端口 ' + PORT + '）');

  // 取管理令牌
  const dbPath = path.join(DATA, 'db.json');
  let token = '';
  await req('GET', '/v1/pay/refund/queue');   // 触发惰性生成（严格鉴权会先确保令牌存在）
  for (let i = 0; i < 20; i++) {
    try {
      const d = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      if (d.settings && d.settings.adminToken) { token = d.settings.adminToken; break; }
    } catch (e) { /* 还没落盘 */ }
    await sleep(300);
  }
  ok(!!token, '拿到管理令牌');

  section('1. 退款待办台：没令牌一律拒（哪怕是回环）');
  {
    const r1 = await req('GET', '/v1/pay/refund/queue');
    ok(r1.status === 403, '无令牌 → 403（回环也免不掉）', r1.status);
    const r2 = await req('GET', '/v1/pay/refund/queue', null, { 'x-admin-token': 'wrong' });
    ok(r2.status === 403, '错误令牌 → 403', r2.status);
    ok(!r1.raw.includes('orderId'), '拒绝时不得回吐任何订单信息');
  }

  section('2. 退款待办台：带令牌可用，且申请 ≠ 已退款');
  {
    const vis = 'regress-ops:v1';
    const o = await req('POST', '/v1/subs/order', { plan: 'm', lang: 'zh' }, { 'x-visitor': vis });
    ok(o.status === 200 && o.body && o.body.order, '下单成功', o.status);
    const oid = o.body && o.body.order && o.body.order.id;
    // 运营确认到账（这一步才让订单变成 paid）
    const c = await req('POST', '/v1/subs/confirm', { orderId: oid }, { 'x-admin-token': token });
    ok(c.status === 200 && c.body && c.body.ok, '确认到账成功', c.raw.slice(0, 120));
    // 客户申请退款
    const rf = await req('POST', '/v1/pay/refund', { orderId: oid, reason: '运营台回归' }, { 'x-visitor': vis });
    ok(rf.status === 200 && rf.body && rf.body.ok, '退款申请成功', rf.raw.slice(0, 120));
    ok(rf.body && rf.body.status === 'requested', '申请后状态是 requested（**不是**已退款）', rf.body && rf.body.status);

    const q = await req('GET', '/v1/pay/refund/queue', null, { 'x-admin-token': token });
    ok(q.status === 200 && q.body && q.body.ok, '待办台可读', q.status);
    const rows = (q.body && q.body.rows) || [];
    ok(rows.length === 1, '队列里有 1 笔', rows.length);
    const row = rows[0] || {};
    ok(row.orderId === oid, '订单号对得上', row.orderId);
    ok(row.status === 'requested', '待出款单显示 requested（不许显示已退款）', row.status);
    ok(row.suspicious === false, '已付款订单的退款不算异常', row.suspicious);
    ok(q.body.stat && q.body.stat.pending === 1, '待出款计数 = 1', q.body.stat && q.body.stat.pending);
  }

  section('3. 运营台页面能打开，且不硬编码令牌');
  {
    const p = await req('GET', '/ops.html');
    ok(p.status === 200, '/ops.html 可访问', p.status);
    ok(p.raw.includes('运营台'), '页面标题正确');
    ok(!/[A-Za-z0-9_-]{24,}/.test(p.raw.replace(/BingDashan/gi, '')), '页面里没有长串硬编码密钥');
    const j = await req('GET', '/ops.js');
    ok(j.status === 200, '/ops.js 可访问', j.status);
    ok(j.raw.includes('/v1/pay/refund/queue'), '运营台调用退款待办台');
    ok(j.raw.includes('/v1/subs/confirm'), '运营台能确认到账');
    ok(j.raw.includes('/v1/pay/refund/confirm'), '运营台能确认出款');
    ok(j.raw.includes('无数据'), '缺数据显示「无数据」');
    ok(!/bd_adminToken['"]\s*[:,]\s*['"][A-Za-z0-9_-]{16,}/.test(j.raw), '令牌只从 localStorage 读，不写死');
  }

  try { child.kill(); } catch (e) {}
  console.log('');
  console.log('pass=' + pass + ' fail=' + fail);
  if (fail) { console.log('FAILED'); process.exit(1); }
  console.log('ALL PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
