require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 回归测试：退款申请的**真实 HTTP 链路 + 前端入口契约**
// 背景：服务端早就有完整的退款状态机（requested → 实际出款 → refunded），
//       但界面**没有入口** → 客户只能找人工、运营手工改库。
//       本测试锁住两件事：
//         1) HTTP 链路的权限与状态语义（本人可申请 / 别人不行 / 未出款不显示已退）
//         2) 前端必须有真实入口（面板、按钮、深链接），且**未确认出款前不显示「已退款」**
// 【隔离】BINGDASHAN_DATA_DIR 指到临时目录 + 独立端口 → 绝不碰线上 data/db.json
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
// 【端口】让 OS 分配空闲端口：写死 pid%200 会与相邻测试撞车（连到旧实例 → 随机挂）
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-refund-ui-'));
const NOTIFY_KEY = 'test-notify-key-' + process.pid;

let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + extra : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }

function req(method, p, body, headers, host) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: host || '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch (e) { /* 非 JSON 如实返回原文 */ }
        resolve({ status: res.statusCode, body: j, raw: b });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: null, raw: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 本机的非回环地址：用来模拟「公网访客」——回环请求会被当成运营本机。 */
function lanIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

async function main() {
  PORT = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      BINGDASHAN_DATA_DIR: DATA,
      BINGDASHAN_PORT: String(PORT),
      BINGDASHAN_HOST: '0.0.0.0',   // 绑全网卡：测试要能从**非回环**地址模拟公网访客
      BD_NOTIFY_KEY: NOTIFY_KEY,
      NODE_ENV: 'test',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(300);
    // 【注意】站点没有 /healthz 路由：未知路径会走 SPA 兜底返回 200（假健康）。
    //   真实健康端点是 /v1/status（Electron 客户端探的就是它）。
    const h = await req('GET', '/v1/status');
    if (h.status === 200) up = true;
  }
  if (!up) {
    console.log('  [FAIL] 隔离实例没起来\n' + out.slice(-1200));
    try { child.kill('SIGKILL'); } catch (e) {}
    await sleep(300);
    process.exit(1);
  }

  const V_A = 'regress-refund-ui:visitorA';
  const V_B = 'regress-refund-ui:visitorB';
  // 【必须用服务端签发的 vid】visitorOf() 只认签名的 X-Visitor；
  //   传裸 key 会被当成未签名 → 回落成 anon 身份 → 订单归属对不上（「无权操作该订单」）。
  const idA = await req('POST', '/v1/subs/identity', { key: V_A });
  const idB = await req('POST', '/v1/subs/identity', { key: V_B });
  ok(idA.body && idA.body.vid, '拿到 A 的签名身份', idA.body && idA.body.vid && idA.body.vid.slice(0, 12) + '…');
  ok(idB.body && idB.body.vid, '拿到 B 的签名身份');
  const hA = { 'X-Visitor': (idA.body && idA.body.vid) || V_A };
  const hB = { 'X-Visitor': (idB.body && idB.body.vid) || V_B };

  try {
    section('1. 客户下单 → 到账自动开通（真实客户路径）');
    const ord = await req('POST', '/v1/subs/order', { plan: 'm', lang: 'zh', email: 'buyer@example.com' }, hA);
    ok(ord.status === 200 && ord.body && ord.body.order && ord.body.order.id, '下单成功', ord.body && ord.body.order && ord.body.order.id);
    const oid = ord.body.order.id;
    const amt = ord.body.order.amount;
    const cur = ord.body.order.currency;

    const st = await req('POST', '/v1/pay/auto-settle', {
      amount: amt, currency: cur, channel: 'alipay', tradeNo: 'T-' + oid, source: 'imap',
    }, { 'X-BD-Notify-Key': NOTIFY_KEY, 'X-Visitor': V_A });
    ok(st.body && st.body.ok === true && st.body.matched === true, '到账信号 → 自动开通（客户零操作）', JSON.stringify(st.body));
    ok(st.body && st.body.status === 'settled', '状态是 settled', st.body && st.body.status);

    section('2. 客户自助申请退款（本人可以）');
    const rf = await req('POST', '/v1/pay/refund', { orderId: oid, reason: '买错了' }, hA);
    ok(rf.status === 200 && rf.body && rf.body.ok === true, '本人申请成功', rf.body && (rf.body.error || 'ok'));
    ok(rf.body && rf.body.status === 'requested', '初始状态是 requested（**不是**已退款）', rf.body && rf.body.status);

    section('3. 别人的订单申请不了（越权必须被拒）');
    const rf2 = await req('POST', '/v1/pay/refund', { orderId: oid, reason: '越权' }, hB);
    ok(rf2.body && rf2.body.ok === false, '别人的身份被拒', rf2.body && rf2.body.error);
    const stB = await req('GET', '/v1/pay/refund/status?orderId=' + encodeURIComponent(oid), null, hB);
    ok(stB.status === 403 || (stB.body && stB.body.ok === false), '别人的身份查不到状态', stB.status + ' ' + (stB.body && stB.body.error));

    section('4. 本人查状态：已受理（未出款）');
    const stA = await req('GET', '/v1/pay/refund/status?orderId=' + encodeURIComponent(oid), null, hA);
    ok(stA.body && stA.body.found === true, '能查到申请', JSON.stringify(stA.body));
    ok(stA.body && stA.body.status === 'requested', '状态仍是 requested（没出款就不许显示已退款）', stA.body && stA.body.status);
    ok(stA.body && Number(stA.body.amount) === Number(amt), '金额与订单一致', stA.body && stA.body.amount);

    section('5. 重复申请被拒');
    const rf3 = await req('POST', '/v1/pay/refund', { orderId: oid, reason: '再来一次' }, hA);
    ok(rf3.body && rf3.body.ok === false, '同一单只允许一笔在途申请', rf3.body && rf3.body.error);

    section('6. 出款确认必须带管理令牌（客户不能自己标「已退款」）');
    const cf = await req('POST', '/v1/pay/refund/confirm', { orderId: oid });
    ok(cf.status === 403, '无令牌确认被拒', cf.status);
    const cf2 = await req('POST', '/v1/pay/refund/confirm', { orderId: oid }, { 'X-Admin-Token': 'wrong-token' });
    ok(cf2.status === 403, '错令牌确认被拒', cf2.status);
    const stA2 = await req('GET', '/v1/pay/refund/status?orderId=' + encodeURIComponent(oid), null, hA);
    ok(stA2.body && stA2.body.status === 'requested', '被拒后状态仍是 requested（没有假「已退款」）', stA2.body && stA2.body.status);

    section('7. 订单列表的数据隔离（原来任何访客都能看到**所有人**的订单）');
    const ip = lanIp();
    if (!ip) {
      ok(false, '拿不到非回环地址，无法模拟公网访客', '跳过');
    } else {
      const ordB = await req('POST', '/v1/subs/order', { plan: 'q', lang: 'zh' }, hB, ip);
      ok(ordB.status === 200 && ordB.body && ordB.body.order, 'B 也下了一单', ordB.body && ordB.body.order && ordB.body.order.id);
      const listA = await req('GET', '/v1/subs/orders?limit=30', null, hA, ip);
      const listB = await req('GET', '/v1/subs/orders?limit=30', null, hB, ip);
      const idsA = (listA.body && listA.body.orders || []).map(o => o.id);
      const idsB = (listB.body && listB.body.orders || []).map(o => o.id);
      ok(idsA.indexOf(oid) >= 0, 'A 能看到自己的订单');
      ok(idsB.indexOf(ordB.body.order.id) >= 0, 'B 能看到自己的订单');
      ok(idsA.indexOf(ordB.body.order.id) < 0, '**A 看不到 B 的订单**（数据隔离生效）', JSON.stringify(idsA));
      ok(idsB.indexOf(oid) < 0, '**B 看不到 A 的订单**（数据隔离生效）', JSON.stringify(idsB));
    }

    section('8. 前端必须有真实入口（否则客户只能找人工）');
    const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    const biz = fs.readFileSync(path.join(ROOT, 'web', 'biz.js'), 'utf8');
    for (const id of ['refundOverlay', 'refundSubmit', 'refundCancel', 'refundReason', 'refundInfo', 'refundHint']) {
      ok(html.indexOf('id="' + id + '"') >= 0, '页面有 #' + id);
    }
    ok(biz.indexOf('/v1/pay/refund') >= 0, '前端调用退款接口');
    ok(biz.indexOf('/v1/pay/refund/status') >= 0, '前端查询退款状态');
    ok(/refund-open/.test(biz), '订单列表里有「申请退款」入口');
    ok(/applyDeepLink/.test(biz) && /get\('plan'\)/.test(biz) && /get\('refund'\)/.test(biz), '支持 ?plan= / ?refund= 深链接（邮件里的续费/退款入口）');
    ok(/refundTitle/.test(biz) && /refundTitle/.test(biz.split('ar:')[1] || ''), '三语文案都补齐（含阿拉伯语）');

    section('9. 诚实性：未确认出款前，界面绝不显示「已退款」');
    const idxDone = biz.indexOf("PT('refundDone')");   // 只看**使用点**，字典里的定义不算
    const idxGuard = biz.indexOf("status === 'refunded'");
    ok(idxGuard >= 0, '存在 refunded 状态判定');
    ok(idxDone >= 0 && idxGuard >= 0 && idxGuard < idxDone, '「已退款」文案在 refunded 判定之后才使用', idxGuard + ' < ' + idxDone);
    ok(!/status\s*===\s*'requested'[^;]{0,200}PT\('refundDone'\)/.test(biz), 'requested 状态不会渲染「已退款」');
  } catch (e) {
    ok(false, '测试异常', String(e && e.message || e).slice(0, 200));
  }

  try { child.kill('SIGTERM'); } catch (e) {}
  await sleep(600);
  try { child.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}

  console.log('');
  console.log('pass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main();
