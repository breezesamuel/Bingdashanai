require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 回归测试：收款监听自动开通通道（core/pay-notify.js）
// 【关键】本套件把数据目录指到临时目录，**绝不碰线上 data/db.json**：
//   run_all.sh 的清理只删 visitors/orders/provisional/sublist，**不删 revenue** ——
//   若测试在真实账本上跑一次，就会留下永远抹不掉的假收入。
process.env.BINGDASHAN_DATA_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'bd-notify-')
);

const store = require('../core/store');
const subs = require('../core/subs');
const payNotify = require('../core/pay-notify');

let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + extra : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }

// 造一笔真实待支付订单（走 subs.order，和线上下单同路径）
function mkOrder(visitor, plan) {
  const r = subs.order(visitor, plan || 'm', 'zh', '127.0.0.1');
  if (!r || !r.ok) return null;
  return store.list('orders', 999).find((x) => x.id === r.order.id);
}

// 各节之间清理本套件自己的待支付订单。
// 【为什么必须清理】匹配是「唯一候选」口径：同额的历史待支付订单会让候选 >1 → 判定歧义。
// 那是模块的正确行为，但会让用例互相干扰。收入/订阅不做清理（用相对增量断言）。
function cleanup() {
  for (const o of store.list('orders', 999)) {
    const v = String(o.visitor || '');
    const id = String(o.id || '');
    if (v.indexOf('regress-notify') === 0 || id.indexOf('regress-notify') === 0) {
      try { store.remove('orders', o.id, '测试清理'); } catch (e) { /* ignore */ }
    }
  }
}

section('1. 金额/通道/币种不匹配 → 绝不匹配（fail-closed）');
{
  const o = mkOrder('regress-notify:a', 'm');
  ok(!!o, '订单创建成功', o && o.id);
  const amt = Number(o.amount) || 0;
  ok(amt > 0, '订单有金额', amt);

  const m1 = payNotify.matchOrder({ amount: amt + 1, currency: 'CNY', channel: 'alipay' });
  ok(m1.status === 'unmatched', '金额对不上 → unmatched', m1.status);
  const m2 = payNotify.matchOrder({ amount: amt, currency: 'USD', channel: 'alipay' });
  ok(m2.status === 'rejected', '币种不支持 → rejected', m2.reason);
  const m3 = payNotify.matchOrder({ amount: amt, currency: 'CNY', channel: 'paypal' });
  ok(m3.status === 'rejected', '通道不支持 → rejected', m3.reason);
  const m4 = payNotify.matchOrder({ amount: 0, currency: 'CNY', channel: 'alipay' });
  ok(m4.status === 'rejected', '金额非法 → rejected', m4.reason);
}

section('2. 唯一匹配 / 歧义 / 时间窗');
{
  cleanup();
  const o = mkOrder('regress-notify:b', 'm');
  const amt = Number(o.amount) || 0;

  const m = payNotify.matchOrder({ amount: amt, currency: 'CNY', channel: 'alipay', paidAt: Date.now() });
  ok(m.status === 'matched' && m.order.id === o.id, '唯一候选 → matched', m.status);

  const late = payNotify.matchOrder({ amount: amt, currency: 'CNY', channel: 'alipay', paidAt: Date.now() + 2 * 3600 * 1000 });
  ok(late.status === 'unmatched', '付款时间超出 90 分钟窗 → unmatched', late.status);

  // 再造一笔同金额的待支付订单 → 歧义
  store.push('orders', {
    id: 'regress-notify-amb', amount: amt, currency: 'CNY', status: 'pending',
    channel: 'alipay', visitor: 'regress-notify:c', at: Date.now(), plan: 'm',
  }, '测试', '歧义用例');
  const amb = payNotify.matchOrder({ amount: amt, currency: 'CNY', channel: 'alipay', paidAt: Date.now() });
  ok(amb.status === 'ambiguous' && amb.count === 2, '两笔同金额 → ambiguous（绝不开通）', amb.status + '/' + amb.count);
  const dry = payNotify.dryRun({ amount: amt, currency: 'CNY', channel: 'alipay' });
  ok(dry.matched === false && dry.status === 'ambiguous', '干跑也如实报歧义', dry.status);
}

section('3. 结算：自动开通 + 只入账一次');
{
  cleanup();
  const o = mkOrder('regress-notify:d', 'm');
  const amt = Number(o.amount) || 0;
  // 清掉歧义用例
  store.remove('orders', 'regress-notify-amb', '测试');

  const before = store.list('revenue', 999).length;
  const r = payNotify.settleFromNotification({
    amount: amt, currency: 'CNY', channel: 'alipay', ref: 'ref-A', tradeNo: 'T-A',
  });
  ok(r.ok === true && r.orderId === o.id, '自动开通成功', JSON.stringify({ ok: r.ok, id: r.orderId, st: r.status }));

  const after = store.list('orders', 999).find((x) => x.id === o.id);
  ok(after && after.paid === true, '订单已标记 paid');
  const rev = store.list('revenue', 999);
  ok(rev.length === before + 1, '收入恰好入账一次', (rev.length - before));
  ok(store.list('sublist', 999).length >= 1, '订阅已开通', store.list('sublist', 999).length);

  // 重复的到账信号（不同 ref）→ 幂等，不再入账
  const r2 = payNotify.settleFromNotification({
    amount: amt, currency: 'CNY', channel: 'alipay', ref: 'ref-B', tradeNo: 'T-B',
  });
  ok(r2.ok === true, '重复信号返回 ok（幂等）', r2.status);
  ok(store.list('revenue', 999).length === before + 1, '重复信号未重复入账', store.list('revenue', 999).length);
  const st = payNotify.status();
  ok(st.ok === true && typeof st.pendingOrders === 'number', '通道就绪视图可读', 'pending=' + st.pendingOrders);
}

section('4. 未匹配只留痕、不开通');
{
  cleanup();
  const revBefore = store.list('revenue', 999).length;
  const r = payNotify.settleFromNotification({
    amount: 888.88, currency: 'CNY', channel: 'alipay', ref: 'ref-C',
  });
  ok(r.ok === false && r.matched === false, '未匹配 → 不开通', r.status);
  ok(store.list('revenue', 999).length === revBefore, '未匹配不产生收入');
  const aud = store.list('audit', 999).filter((a) => String(a.action || '').indexOf('收款监听') >= 0);
  ok(aud.length >= 1, '未匹配已留痕待人工', aud.length);
}

console.log('');
console.log('pass=' + pass + ' fail=' + fail);
if (fail === 0) console.log('ALL PASS');
else console.log('FAILED');
process.exit(fail === 0 ? 0 : 1);
