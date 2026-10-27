require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 回归测试：规模化身份/权益不失忆（2026-10-21）
// 红线：站点访客数早已超过 999（生产实测 2805），而原实现用
//   store.list('visitors', 999) 找身份 —— 那是**最近 999 个**的窗口。
// 后果（真实发生）：老访客被当成新访客**重建记录** → 免费额度重置、身份分裂；
//   老订单查不到 → 客户申请退款报「订单不存在」；老订阅查不到 → 权益消失；
//   24h 临时权益回收只扫最近 999 单 → 老单永不过期（白嫖漏洞）。
// 本测试造 >1000 个访客/订单后，验证：
//   ① 最早的访客仍能被找到（不会重建、额度不重置）
//   ② 最早的订单仍可按 id 找到
//   ③ 最早的订阅仍生效（status 显示已订阅）
//   ④ 我的订单列表包含最早的订单
// 【零污染】使用临时数据目录（BINGDASHAN_DATA_DIR）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let PORT = 0;
function freePort() {
  return new Promise((resolve) => {
    const s = require('net').createServer();
    s.on('error', () => resolve(0));
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-scale-'));
let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + (typeof extra === 'object' ? JSON.stringify(extra).slice(0, 200) : extra) : ''));
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
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, body: null, raw: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  PORT = await freePort();
  // 造数据：**在起服之前**写盘（store 有读缓存 + 写合并，运行时外部改库会被内存态覆盖）
  const now = Date.now();
  const firstKey = 'ip:10.0.0.1:old';
  const db = {
    meta: { createdAt: now, rev: 0 },
    settings: { paywallOn: true, adminToken: 'test-admin-token-123456', visitorSecret: 'test-visitor-secret-abcdef123456' },
    visitors: [],
    orders: [],
    sublist: [],
    revenue: [],
    audit: [],
    provisional: [],
  };
  db.visitors.push({ id: 'v-old', visitor: firstKey, freeLeft: 0, used: 42, paid: 1, monthsCredit: 0, invite: [], invitedBy: null, inviteCode: 'BDOLDTST', trialUsed: true, createdAt: now - 86400000 });
  for (let i = 0; i < 1200; i++) {
    db.visitors.push({ id: 'v-' + i, visitor: 'ip:10.0.0.2:' + i, freeLeft: 10, used: 0, paid: 0, monthsCredit: 0, invite: [], invitedBy: null, inviteCode: 'BD' + i, trialUsed: false, createdAt: now });
  }
  db.orders.push({ id: 'ord-old', visitor: firstKey, plan: 'm', amount: 99, currency: 'CNY', paid: true, status: 'paid', at: now - 86400000, createdAt: now - 86400000 });
  for (let i = 0; i < 1200; i++) {
    db.orders.push({ id: 'ord-' + i, visitor: 'ip:10.0.0.2:' + i, plan: 'm', amount: 99, currency: 'CNY', paid: false, status: 'pending', at: now, createdAt: now });
  }
  db.sublist.push({ id: 's-old', visitor: firstKey, plan: 'm', tier: 'basic', expireAt: now + 20 * 86400000, grantedOrders: ['ord-old'] });
  db.revenue.push({ id: 'rev-ord-old', amt: 99, currency: 'CNY', settled: true, status: 'paid', source: '订阅-m', at: now });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'db.json'), JSON.stringify(db), 'utf8');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      BINGDASHAN_DATA_DIR: DATA,
      BINGDASHAN_PORT: String(PORT),
      BINGDASHAN_HOST: '127.0.0.1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let up = false;
  child.stdout.on('data', (d) => { if (String(d).includes('listening')) up = true; });
  for (let i = 0; i < 40 && !up; i++) { await sleep(300); const h = await req('GET', '/v1/status'); if (h.status === 200) { up = true; break; } }
  if (!up) { console.log('  [FAIL] 服务未能启动'); process.exit(1); }

  // 身份只认服务端签发的 vid（HMAC）→ 先换签，再带 X-Visitor 访问
  section('1. 超过 999 个访客后，老访客身份仍在（不重建、额度不重置）');
  const id = await req('POST', '/v1/subs/identity', { key: firstKey });
  ok(id.status === 200 && id.body && id.body.vid, '拿到签名身份', id.body && String(id.body.vid).slice(0, 24));
  const VH = { 'X-Visitor': id.body.vid };
  const st = await req('GET', '/v1/subs/status', null, VH);
  ok(st.status === 200 && st.body && st.body.visitor === firstKey, '状态里仍是同一个访客', st.body && st.body.visitor);
  ok(st.body && st.body.sub && st.body.sub.plan === 'm', '老访客的订阅仍然生效（权益没丢）', st.body && st.body.sub);
  ok(st.body && st.body.paidEver === 1, '老访客的已付记录被认到（不是新人）', st.body && st.body.paidEver);

  section('2. 超过 999 单后，老订单仍可按 id 找到（退款/查询不再报「订单不存在」）');
  // 访客视角走 ordersOf()：HTTP 路径在本机回环下按设计返回全量（核账台要用），
  // 所以这里直接对**模块**断言访客隔离与老单可见性。
  process.env.BINGDASHAN_DATA_DIR = DATA;   // 让本进程也读到同一份账本
  const subsMod = require(path.join(ROOT, 'core', 'subs.js'));
  const own = subsMod.ordersOf(firstKey, 50);
  ok(Array.isArray(own) && own.some((o) => o.id === 'ord-old'),
    '访客视角能看到最早那笔（>999 单之后仍可见）', (own || []).map((o) => o.id).slice(0, 3));
  ok(Array.isArray(own) && own.every((o) => o.visitor === firstKey),
    '访客视角只看到自己的订单（不泄露他人）', (own || []).length);
  const st2 = subsMod.status(firstKey);
  ok(st2 && st2.sub && st2.sub.plan === 'm' && st2.paidEver === 1,
    '模块级 status：老访客权益与付费历史都在', st2 && { sub: st2.sub, paidEver: st2.paidEver });

  // 直接读账本校验（不依赖 store 模块，避免读缓存干扰）
  section('3. 访客记录数没有因为查找而暴涨（没有重复重建）');
  const db2 = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
  const same = (db2.visitors || []).filter((x) => x.visitor === firstKey);
  ok(same.length === 1, '同一访客只有一条记录（无重复身份）', 'count=' + same.length);
  ok((db2.visitors || []).length <= 1300, '访客总数没有被异常放大', 'visitors=' + (db2.visitors || []).length);

  section('4. 匿名身份按 IP×小时收敛（不带 Cookie 的请求不再每次新建访客）');
  const before = (db2.visitors || []).length;
  await req('GET', '/v1/status');
  await req('GET', '/v1/status');
  const db3 = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
  const grew = (db3.visitors || []).length - before;
  ok(grew <= 1, '连续两次无 Cookie 请求最多新增 1 条匿名记录（原来每次都新增）', 'grew=' + grew);

  child.kill('SIGKILL');
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  console.log('\npass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  process.exit(fail === 0 ? 0 : 1);
})();
