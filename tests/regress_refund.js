require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 回归测试：退款申请与出款确认（站点侧 + 闭环镜像语义）
// 【隔离】BINGDASHAN_DATA_DIR 指到临时目录 → 绝不碰线上 data/db.json
process.env.BINGDASHAN_DATA_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'bd-refund-')
);

const fs = require('fs');
const path = require('path');
const store = require('../core/store');
const subs = require('../core/subs');
const refund = require('../core/refund');

let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + extra : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }

// 造一笔**已付款**的订单（退款只能针对已付单）
function paidOrder(visitor, amount) {
  const r = subs.order(visitor, 'm', 'zh', '127.0.0.1', 'buyer@example.com');
  const o = store.list('orders', 999).find(x => x.id === r.order.id);
  store.update('orders', o.id, { paid: true, status: 'paid', paidAt: Date.now() }, '测试付款');
  return store.list('orders', 999).find(x => x.id === o.id);
}

section('1. 未付款订单不能申请退款');
{
  const r0 = subs.order('regress-refund:v0', 'm', 'zh', '127.0.0.1');
  const oid = r0.order.id;
  const r = refund.request(oid, 'regress-refund:v0', '不想要了');
  ok(r.ok === false, '未付款订单申请被拒', r.error);
}

section('2. 只能申请自己的订单');
{
  const o = paidOrder('regress-refund:v1', 99);
  const other = refund.request(o.id, 'regress-refund:someone-else', '越权');
  ok(other.ok === false, '别人的身份申请被拒', other.error);
  const self = refund.request(o.id, 'regress-refund:v1', '买错了');
  ok(self.ok === true, '订单主人可以申请', self.error);
  ok(self.request && self.request.status === 'requested', '初始状态是 requested（**不是**已退款）', self.request && self.request.status);
  ok(self.request && self.request.amount === 99, '金额取自订单', self.request && self.request.amount);
}

section('3. 重复申请被拒；申请流已落盘');
{
  const o = paidOrder('regress-refund:v2', 99);
  const a = refund.request(o.id, 'regress-refund:v2', '第一次');
  ok(a.ok === true, '第一次申请成功');
  const b = refund.request(o.id, 'regress-refund:v2', '再来一次');
  ok(b.ok === false, '重复申请被拒（同一单只允许一笔在途）', b.error);

  const lines = fs.readFileSync(refund.REQ_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ok(lines.length >= 2, '申请流已追加落盘（闭环据此建出款待办）', lines.length);
  const mine = lines.filter(l => l.orderId === o.id);
  ok(mine.length === 1 && mine[0].status === 'requested', '申请流里是 requested', JSON.stringify(mine.map(m => m.status)));
}

section('4. 运营确认出款 → refunded（唯一能标已退的路径）');
{
  const o = paidOrder('regress-refund:v3', 50);
  refund.request(o.id, 'regress-refund:v3', '申请');
  const st1 = refund.getRequest(o.id);
  ok(st1 && st1.status === 'requested', '确认前是 requested', st1 && st1.status);

  const c = refund.confirm(o.id, 'ops');
  ok(c.ok === true, '运营确认成功', c.error);
  const st2 = refund.getRequest(o.id);
  ok(st2 && st2.status === 'refunded', '确认后是 refunded', st2 && st2.status);

  // 申请流里应追加一条 paid_out 事件（闭环据此把镜像从 pending_manual 推进到 refunded）
  const lines = fs.readFileSync(refund.REQ_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const paidOut = lines.filter(l => l.orderId === o.id && l.event === 'paid_out');
  ok(paidOut.length === 1, '出款确认事件已写入申请流', paidOut.length);
  ok(paidOut[0] && paidOut[0].status === 'refunded', '事件状态为 refunded', paidOut[0] && paidOut[0].status);

  // 幂等：重复确认不报错
  const again = refund.confirm(o.id, 'ops');
  ok(again.ok === true && again.already === true, '重复确认幂等', JSON.stringify({ ok: again.ok, already: again.already }));
}

section('5. 没有申请单不能确认出款');
{
  const r = refund.confirm('nope', 'ops');
  ok(r.ok === false, '无申请单确认被拒', r.error);
}

console.log('');
console.log('pass=' + pass + ' fail=' + fail);
if (fail === 0) console.log('ALL PASS');
else console.log('FAILED');
process.exit(fail === 0 ? 0 : 1);
