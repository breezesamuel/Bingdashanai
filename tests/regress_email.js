require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 回归测试：买家邮箱采集链路（下单带邮箱 / 付款后补邮箱 / 只能改自己的订单）
// 【隔离】BINGDASHAN_DATA_DIR 指到临时目录 → 绝不碰线上 data/db.json
process.env.BINGDASHAN_DATA_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'bd-email-')
);

const store = require('../core/store');
const subs = require('../core/subs');

let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + extra : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }

section('1. 邮箱格式校验（严格：拒绝注入与畸形）');
{
  const cases = [
    ['a@b.com', 'a@b.com', '正常'],
    ['  User@Example.COM ', 'user@example.com', '去空格 + 转小写'],
    ['a.b+tag@sub.example.co', 'a.b+tag@sub.example.co', '带 + 与多点'],
    ['bad', '', '无 @'],
    ['a@b', '', '无点'],
    ['a b@c.com', '', '含空格'],
    ['a@b.com\r\nBcc: x@y.com', '', '含 CR/LF（邮件头注入）'],
    ['', '', '空'],
    ['x'.repeat(70) + '@e.com', '', '本地部分过长'],
  ];
  for (const [input, want, label] of cases) {
    const got = subs.normEmail(input);
    ok(got === want, 'normEmail ' + label, got || '(空)');
  }
  const long = 'a'.repeat(200) + '@e.com';
  ok(subs.normEmail(long) === '', 'normEmail 超长整体拒绝');
}

section('2. 下单带邮箱 → 订单携带；不带 → 为空');
{
  const r1 = subs.order('regress-email:u1', 'm', 'zh', '127.0.0.1', 'Buyer@Example.com');
  ok(r1 && r1.ok === true, '下单成功', r1 && r1.order && r1.order.id);
  const o1 = store.list('orders', 999).find(x => x.id === r1.order.id);
  ok(o1 && o1.email === 'buyer@example.com', '订单携带规范化后的邮箱', o1 && o1.email);

  const r2 = subs.order('regress-email:u2', 'm', 'zh', '127.0.0.1');
  const o2 = store.list('orders', 999).find(x => x.id === r2.order.id);
  ok(!o2.email, '未提供邮箱 → 订单不带邮箱（闭环会如实记 skipped）', o2.email);
}

section('3. 补邮箱：只能改自己的订单');
{
  const r = subs.order('regress-email:u3', 'm', 'zh', '127.0.0.1');
  const oid = r.order.id;

  const bad = subs.attachEmail(oid, 'regress-email:u3', 'not-an-email');
  ok(bad.ok === false, '非法邮箱被拒', bad.error);

  const other = subs.attachEmail(oid, 'regress-email:someone-else', 'x@y.com');
  ok(other.ok === false, '别人的身份不能改这单', other.error);

  const good = subs.attachEmail(oid, 'regress-email:u3', 'me@mine.com');
  ok(good.ok === true, '订单主人可以补邮箱', good.error);
  const o = store.list('orders', 999).find(x => x.id === oid);
  ok(o.email === 'me@mine.com', '邮箱已落到订单上', o.email);

  const again = subs.attachEmail(oid, 'regress-email:u3', 'me@mine.com');
  ok(again.ok === true && again.reused === true, '重复补同一邮箱 → 幂等', JSON.stringify({ ok: again.ok, reused: again.reused }));

  const noOrder = subs.attachEmail('nope', 'regress-email:u3', 'a@b.com');
  ok(noOrder.ok === false, '订单不存在被拒', noOrder.error);
}

console.log('');
console.log('pass=' + pass + ' fail=' + fail);
if (fail === 0) console.log('ALL PASS');
else console.log('FAILED');
process.exit(fail === 0 ? 0 : 1);
