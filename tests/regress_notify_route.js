require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 回归测试：收款监听端点（POST /v1/pay/auto-settle）的真实 HTTP 行为
// 做法：起一个**隔离实例**（临时数据目录 + 独立端口），用真实 HTTP 打，
//       验证「没授权拒、授权才通、通了也只唯一匹配才开通」。
// 【隔离】BINGDASHAN_DATA_DIR 指到临时目录 → 绝不碰线上 data/db.json；
//         端口也另开 → 不与线上 3721 抢。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
// 【端口】原来写死 3979 + pid%200 —— 相邻测试可能拿到**同一端口**，
// 而上一个实例还没退干净 → 新实例起不来 → 测试连到**旧实例**（旧数据目录）→ 随机挂。
// 现在让 OS 分配一个空闲端口，根治这种偶发失败。
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-notify-route-'));
const NOTIFY_KEY = 'test-notify-key-' + process.pid;

let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + extra : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }

function req(method, p, body, headers) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch (e) { /* 非 JSON 也如实返回原文 */ }
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
      BD_NOTIFY_KEY: NOTIFY_KEY,
      NODE_ENV: 'test',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  // 等服务起来
  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const r = await req('GET', '/v1/pay/channels');
    if (r.status === 200) { up = true; break; }
  }
  if (!up) {
    ok(false, '隔离实例启动成功', out.slice(-400));
    try { child.kill(); } catch (e) {}
    process.exit(1);
  }
  ok(true, '隔离实例启动成功（端口 ' + PORT + '，数据目录 ' + DATA + '）');

  section('1. 未授权必须被拒（不能「点一下就开通」）');
  {
    const r1 = await req('POST', '/v1/pay/auto-settle', { amount: 99, currency: 'CNY', channel: 'alipay' });
    ok(r1.status === 403, '无任何凭证 → 403', r1.status);
    const r2 = await req('POST', '/v1/pay/auto-settle', { amount: 99, currency: 'CNY', channel: 'alipay' }, { 'x-bd-notify-key': 'wrong-key' });
    ok(r2.status === 403, '错误通知密钥 → 403', r2.status);
    const r3 = await req('POST', '/v1/pay/auto-settle', { amount: 99, currency: 'CNY', channel: 'alipay' }, { 'x-admin-token': 'wrong-token' });
    ok(r3.status === 403, '错误管理令牌 → 403', r3.status);
  }

  // 取管理令牌（站点惰性生成：上面那次错误令牌请求已经触发了生成）
  const dbPath = path.join(DATA, 'db.json');
  let token = '';
  for (let i = 0; i < 20; i++) {
    try {
      const d = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      if (d.settings && d.settings.adminToken) { token = d.settings.adminToken; break; }
    } catch (e) { /* 还没写/还没落盘 */ }
    await sleep(300);
  }
  ok(!!token, '拿到管理令牌', token ? 'ok' : '未生成');

  section('2. 授权后可用（但只做「匹配」，不凭空开通）');
  {
    const r = await req('GET', '/v1/pay/auto-settle/status', null, { 'x-bd-notify-key': NOTIFY_KEY });
    ok(r.status === 200 && r.body && r.body.ok === true, '通知密钥 → 状态接口 200', r.status);
    ok(r.body && typeof r.body.pendingOrders === 'number', '状态含待支付订单数', r.body && r.body.pendingOrders);
    const r2 = await req('GET', '/v1/pay/auto-settle/status', null, { 'x-admin-token': token });
    ok(r2.status === 200, '管理令牌 → 状态接口 200', r2.status);
  }

  section('3. 真实下单 → 到账信号 → 自动开通（走真实接口）');
  {
    // 用站点自己的下单接口造一笔真实待支付订单
    const sub = await req('POST', '/v1/subs/order', { plan: 'm', lang: 'zh' });
    ok(sub.status === 200 && sub.body && sub.body.ok === true, '下单成功', sub.status);
    const oid = sub.body && sub.body.order && sub.body.order.id;
    ok(!!oid, '拿到订单号', oid);
    const amount = sub.body && sub.body.order && sub.body.order.amount;
    ok(!!amount, '拿到订单金额', amount);

    // 金额对不上 → 不开通
    const bad = await req('POST', '/v1/pay/auto-settle', { amount: Number(amount) + 1, currency: 'CNY', channel: 'alipay' }, { 'x-bd-notify-key': NOTIFY_KEY });
    ok(bad.status === 200 && bad.body && bad.body.matched === false, '金额对不上 → 不开通', JSON.stringify(bad.body && bad.body.status));

    // 金额对得上 → 自动开通
    const good = await req('POST', '/v1/pay/auto-settle', { amount: Number(amount), currency: 'CNY', channel: 'alipay', ref: 'r-' + Date.now() }, { 'x-bd-notify-key': NOTIFY_KEY });
    ok(good.status === 200 && good.body && good.body.ok === true, '金额对得上 → 自动开通', JSON.stringify({ ok: good.body && good.body.ok, st: good.body && good.body.status }));

    // 重复信号 → 幂等
    const again = await req('POST', '/v1/pay/auto-settle', { amount: Number(amount), currency: 'CNY', channel: 'alipay', ref: 'r2-' + Date.now() }, { 'x-bd-notify-key': NOTIFY_KEY });
    ok(again.status === 200 && again.body && again.body.ok === true, '重复信号 → 幂等返回', JSON.stringify({ ok: again.body && again.body.ok, st: again.body && again.body.status }));

    // 站点数据：订单已付款 + 收入只入账一次
    const d = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const ord = (d.orders || []).find((x) => x.id === oid);
    ok(ord && ord.paid === true, '订单已标记 paid');
    const revs = (d.revenue || []).filter((x) => String(x.id || '').indexOf('rev-' + oid) === 0);
    ok(revs.length === 1, '收入恰好一条（不重复入账）', revs.length);
  }

  try { child.kill('SIGTERM'); } catch (e) {}
  await sleep(600);
  try { child.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}

  console.log('');
  console.log('pass=' + pass + ' fail=' + fail);
  if (fail === 0) console.log('ALL PASS'); else console.log('FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main();
