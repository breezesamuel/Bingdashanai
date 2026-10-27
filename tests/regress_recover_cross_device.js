require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 回归测试：付钱后能正确使用（跨设备恢复 + 账号安全）
// 红线：
//   ① 客户在 A 设备下单付款（邮箱写在订单上）→ 换到 B 设备 → 用邮箱找回
//      → B 上立刻拥有已付权益（墙自动开、额度/订单都在）——落地页承诺"换设备订阅自动恢复"。
//   ② 权益**镜像**而不是叠加：同一次付款不能买出两份时长，收入也不能重复记账。
//   ③ 【安全】没有验证码不得换取他人身份（原实现 code 可选 = 账号接管漏洞）。
//
// 【为什么恢复部分用进程内模块测】服务进程有自己的读缓存与内存态，
// 另一个进程改 db.json 它看不见（跨进程状态不同步）→ 恢复链路必须在**同一进程**里
// 跑才能测准；HTTP 部分只验证"缺验证码/错验证码被拒"这类不依赖共享状态的安全断言。
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-recover-'));
process.env.BINGDASHAN_DATA_DIR = DATA;      // 进程内模块用这份数据
let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + (typeof extra === 'object' ? JSON.stringify(extra).slice(0, 220) : extra) : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  // ── 进程内：完整的"付款 → 换设备找回"链路 ──
  const subs = require(path.join(ROOT, 'core', 'subs.js'));
  const auth = require(path.join(ROOT, 'core', 'auth.js'));
  const store = require(path.join(ROOT, 'core', 'store.js'));
  const MAIL = 'buyer@example.com';
  const keyA = 'device-A-' + Date.now();

  section('1. A 设备：下单 → 绑邮箱 → 付款开通（真实结算链）');
  const ord = subs.order(keyA, 'm', 'zh', '1.2.3.4', MAIL);
  ok(ord && ord.ok && ord.order && ord.order.id, '订单创建', ord && (ord.error || ord.order.id));
  const oid = ord.order.id;
  const att = subs.attachEmail(oid, keyA, MAIL);
  ok(att && att.ok, '订单绑定邮箱', att && att.error);
  const vrec = store.findBy('visitors', 'visitor', keyA);
  ok(vrec && String(vrec.email || '').toLowerCase() === MAIL, '邮箱同时挂到访客身份（跨设备找回的锚点）', vrec && vrec.email);
  // 直接结算（等效邮件到账信号走完的最终效果）
  const settle = require(path.join(ROOT, 'core', 'pay-notify.js'));
  const m = settle.matchOrder({ amount: ord.order.amount, currency: 'CNY', channel: 'alipay', paidAt: Date.now() });
  ok(m && m.status === 'matched', '到账信号匹配到该订单', m && m.status);
  if (m && m.order) {
    const paid = require(path.join(ROOT, 'core', 'pay.js'));
    const r = paid.settleOrder ? paid.settleOrder(m.order.id, '测试：收账核账确认') : null;
    ok(r && r.ok !== false, '结算并开通权益', r && (r.error || 'ok'));
  }
  const stA = subs.status(keyA);
  ok(stA && stA.sub && stA.sub.plan === 'm', 'A 设备已订阅', stA && stA.sub);

  section('2. B 设备：全新身份 → 无订阅（用完免费额度后会撞墙）');
  const keyB = 'device-B-' + Date.now();
  const stB = subs.status(keyB);
  ok(stB && !stB.sub && stB.paidEver === 0, 'B 设备无订阅、无付费历史（不是同一个人）', stB && { sub: stB.sub, paidEver: stB.paidEver });

  section('3. B 设备用邮箱找回 → 立刻拥有已付权益');
  // 验证码：直接写进本进程的 store（同一进程，服务端读得到）
  const crypto = require('crypto');
  const code = '246810';
  const hash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 16);
  store.setSetting('auth_code_email:' + MAIL, JSON.stringify({ hash, expiresAt: Date.now() + 600000, attempts: 0 }));
  const vr = auth.verifyCode(MAIL, 'email', code);
  ok(vr && vr.ok, '邮箱验证码校验通过', vr && vr.error);
  const login = auth.loginContact(MAIL, 'email', { verified: true });
  ok(login && login.ok && login.vid, '找回成功（返回签名身份）', login && (login.error || login.visitor));
  const stB2 = subs.status(login && login.visitor ? login.visitor : keyB);
  ok(stB2 && stB2.sub && stB2.sub.plan === 'm', '换设备后立刻拥有已付权益 → 墙自动开（浏览器换成原付款身份）', stB2 && stB2.sub);
  ok(stB2 && stB2.paidEver >= 1, '付费历史也回来了（不是新人）', stB2 && stB2.paidEver);
  ok(login && login.visitor === keyA, '找回的是**原付款身份**（历史、额度、沉淀都在）', login && login.visitor);

  section('4. 权益是"镜像"不是叠加（不能买出两份时长、不能重复记账）');
  const db = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
  const revCount = (db.revenue || []).filter((r) => r.id === 'rev-' + oid).length;
  ok(revCount === 1, '同一笔付款在收入账本里只有一条（没重复记账）', 'count=' + revCount);
  const subsOfOrder = (db.sublist || []).filter((s) => (s.grantedOrders || []).includes(oid));
  ok(subsOfOrder.length <= 2, '该订单对应的权益记录不超过 2 条（原身份 + 镜像）', 'count=' + subsOfOrder.length);
  const exps = subsOfOrder.map((s) => Number(s.expireAt || 0)).filter(Boolean);
  ok(exps.length === 0 || (Math.max.apply(null, exps) - Math.min.apply(null, exps)) < 1000, '镜像的到期时间与原权益一致（没有多给时长）', JSON.stringify(exps));

  // ── HTTP：安全断言（缺验证码/错验证码必须被拒）──
  section('5. 安全：没有验证码不得换取他人身份');
  PORT = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      BINGDASHAN_DATA_DIR: DATA, BINGDASHAN_PORT: String(PORT), BINGDASHAN_HOST: '127.0.0.1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let up = false;
  child.stdout.on('data', (d) => { if (String(d).includes('listening')) up = true; });
  // 真正等服务就绪（用 /v1/status 探测；只看 stdout 会 flaky）
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(300);
    const h = await new Promise((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port: PORT, path: '/v1/status', method: 'GET' }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      rq.on('error', () => resolve(0));
      rq.end();
    });
    if (h === 200) { up = true; break; }
  }
  if (!up) { console.log('  [FAIL] HTTP 子服务未能就绪'); }
  function post(p, body) {
    return new Promise((resolve) => {
      const data = Buffer.from(JSON.stringify(body || {}));
      const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
        let b = '';
        res.on('data', (c) => b += c);
        res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
      });
      r.on('error', (e) => resolve({ status: 0, body: null }));
      r.write(data); r.end();
    });
  }
  const noCode = await post('/v1/auth/login', { target: MAIL, type: 'email' });
  ok(noCode.status === 400 && noCode.body && noCode.body.ok === false, '缺验证码 → 拒绝（原来可直接换身份 = 账号接管）', noCode.body && noCode.body.error);
  const badCode = await post('/v1/auth/login', { target: MAIL, type: 'email', code: '000000' });
  ok(badCode.status === 400 && badCode.body && badCode.body.ok === false, '错误验证码 → 拒绝', badCode.body && badCode.body.error);

  child.kill('SIGKILL');
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  console.log('\npass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  process.exit(fail === 0 ? 0 : 1);
})();
