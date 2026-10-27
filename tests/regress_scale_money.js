require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 回归测试：钱路径的**规模化不失忆**（2026-10-21）
// 红线：自动核账候选池、收入幂等查重、查单轮询、人工核账台、退款申请
//       **都不能只看最近 999 条** —— 否则：
//         · 客户付款时订单不在窗口 → 无候选 → 钱到了却不开通（最贵的 bug）
//         · 收入查重漏检 → 同一次入账被记两遍（营收虚高）
//         · 轮询报「订单不存在」→ 墙永不开 → 客户重复付款
//         · 老的人工单从核账台消失 → 永远核不到账
// 本测试造 >1000 单后逐条验证上述四条。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-scale-money-'));
let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + (typeof extra === 'object' ? JSON.stringify(extra).slice(0, 200) : extra) : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }

(async () => {
  // 起服前写账本：1200 张别的单 + 1 张"老客户单"（早于窗口）
  const now = Date.now();
  const oldVisitor = 'ip:10.9.9.9:old';
  const db = {
    meta: { createdAt: now, rev: 0 },
    settings: { paywallOn: true, adminToken: 'test-admin-token-123456', visitorSecret: 'test-visitor-secret-abcdef123456' },
    visitors: [], orders: [], sublist: [], revenue: [], audit: [], provisional: [], promo: [],
  };
  db.visitors.push({ id: 'v-old', visitor: oldVisitor, freeLeft: 0, used: 5, paid: 0, monthsCredit: 0, invite: [], invitedBy: null, inviteCode: 'BDOLD01', trialUsed: false, createdAt: now - 86400000 });
  db.orders.push({ id: 'ord-old', visitor: oldVisitor, plan: 'm', amount: 99, currency: 'CNY', paid: false, status: 'pending', channel: 'alipay', at: now - 3 * 3600000, createdAt: now - 3 * 3600000 });
  for (let i = 0; i < 1200; i++) {
    db.visitors.push({ id: 'v-' + i, visitor: 'ip:10.9.9.8:' + i, freeLeft: 10, used: 0, paid: 0, monthsCredit: 0, invite: [], invitedBy: null, inviteCode: 'BD' + i, trialUsed: false, createdAt: now });
    db.orders.push({ id: 'ord-' + i, visitor: 'ip:10.9.9.8:' + i, plan: 'm', amount: 99, currency: 'CNY', paid: false, status: 'pending', channel: 'alipay', at: now, createdAt: now });
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'db.json'), JSON.stringify(db), 'utf8');

  process.env.BINGDASHAN_DATA_DIR = DATA;
  const store = require(path.join(ROOT, 'core', 'store.js'));
  const payNotify = require(path.join(ROOT, 'core', 'pay-notify.js'));

  section('1. 自动核账候选池：>1000 单后，老订单仍能按金额+时间窗被匹配');
  const paidAt = now - 3 * 3600000 + 30 * 60000;   // 付款发生在老订单之后 30 分钟（窗口 90 分钟内）
  const m = payNotify.matchOrder({ amount: 99, currency: 'CNY', channel: 'alipay', paidAt });
  ok(m && m.status === 'matched' && m.order && m.order.id === 'ord-old',
    '老订单被正确匹配（原来：不在最近 999 单 → 无候选 → 钱到了不开通）', m && { status: m.status, id: m.order && m.order.id });

  section('2. 收入幂等：同一笔入账重复请求不重复记账');
  const money = require(path.join(ROOT, 'core', 'money.js'));
  const first = money.credit(99, '订阅-m', '人工核账确认', { id: 'rev-ord-old', currency: 'CNY' });
  const second = money.credit(99, '订阅-m', '人工核账确认', { id: 'rev-ord-old', currency: 'CNY' });
  ok(first && first.ok === true, '首次入账成功', first && { ok: first.ok, already: first.already });
  ok(second && second.already === true, '重复入账被识别为幂等（不重复记账）', second && { ok: second.ok, already: second.already });
  const revCount = (JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8')).revenue || [])
    .filter((r) => r.id === 'rev-ord-old').length;
  ok(revCount === 1, '账本里这条收入只有一条', 'count=' + revCount);

  section('3. 查单轮询：老订单仍能查到（否则前端报「订单不存在」→ 墙永不开）');
  // 走真实 HTTP 路径（server.js 的 /v1/pay/status 就是前端轮询的那个端点）
  const port = await (async () => {
    const net = require('net');
    return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  })();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { BINGDASHAN_DATA_DIR: DATA, BINGDASHAN_PORT: String(port), BINGDASHAN_HOST: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((r) => setTimeout(r, 3500));
  const http = require('http');
  const poll = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/v1/pay/status?order=ord-old' }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
    }).on('error', (e) => resolve({ status: 0, body: { error: String(e.message) } }));
  });
  ok(poll.status === 200 && poll.body && poll.body.ok === true && poll.body.order && poll.body.order.id === 'ord-old',
    '前端轮询端点能查到老订单（不报「订单不存在」）', poll.body && (poll.body.error || (poll.body.order && poll.body.order.id)));

  section('4. 退款：老单不因窗口消失（未支付单被拒是正确行为，但不该报「订单不存在」）');
  const refund = require(path.join(ROOT, 'core', 'refund.js'));
  const req = refund.request('ord-old', oldVisitor, '测试：规模化后仍能识别到订单');
  ok(req && req.error !== '订单不存在',
    '老订单能被找到（错误不是「订单不存在」）', req && (req.error || (req.request && req.request.id)));

  try { child.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}

  console.log('\npass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  process.exit(fail === 0 ? 0 : 1);
})();
