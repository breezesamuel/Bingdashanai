require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 滥用防护回归测试
// 【重要】本套件**不修改共享的 settings**（db.json）：防护参数通过 pay.setGuardOverride
// 做进程内覆盖。早期版本直接 store.setSetting，一旦测试中途异常退出，
// 线上服务进程就会悄悄失去防滥用（上限被置 0 = 不设防）。
const store = require('../core/store');
const subs  = require('../core/subs');
const pay   = require('../core/pay');

let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  -> ' + extra : ''));
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// 覆盖是"合并"语义：只改指定项，其余保持当前覆盖值（缺省则用线上真实值）
let _ov = {};
function guard(o) { _ov = Object.assign({}, _ov, o); pay.setGuardOverride(_ov); }
function guardReset() { _ov = {}; pay.setGuardOverride(null); }

const made = [];
function mk(vis, plan) {
  const o = subs.order(vis, plan || 'm', 'zh', '127.0.0.1');
  if (o.ok) made.push(o.order.id);
  return o;
}
function clean() {
  for (const id of made) {
    try { store.remove('orders', id); } catch (e) {}
    for (const x of store.list('provisional', 999)) if (x.orderId === id) { try { store.remove('provisional', x.id); } catch (e) {} }
    for (const x of store.list('sublist', 999)) if ((x.grantedOrders || []).includes(id)) { try { store.remove('sublist', x.id); } catch (e) {} }
    for (const x of store.list('revenue', 999)) if (String(x.id) === 'rev-' + id) { try { store.remove('revenue', x.id); } catch (e) {} }
  }
  for (const v of store.list('visitors', 999)) {
    if (/^guard:/.test(v.visitor || '')) { try { store.remove('visitors', v.id); } catch (e) {} }
  }
}

console.log('=== 0. 线上真实防护参数（不改动，只是读取）');
const live = {
  minAgeSec: Number(store.getSetting('manualMinOrderAgeSec') === undefined ? 30 : store.getSetting('manualMinOrderAgeSec')),
  maxPerDay: Number(store.getSetting('manualMaxProvisionalPerDay') === undefined ? 2 : store.getSetting('manualMaxProvisionalPerDay')),
  maxConcurrent: Number(store.getSetting('manualMaxConcurrentProvisional') === undefined ? 1 : store.getSetting('manualMaxConcurrentProvisional'))
};
console.log('  age=' + live.minAgeSec + ' maxPerDay=' + live.maxPerDay + ' maxConcurrent=' + live.maxConcurrent);
ok(live.minAgeSec > 0, '线上年龄闸是开着的（>0）', live.minAgeSec);
ok(live.maxPerDay > 0, '线上未核销次数上限是开着的（>0）', live.maxPerDay);
ok(live.maxConcurrent > 0, '线上并发上限是开着的（>0）', live.maxConcurrent);

console.log('=== 1. 订单年龄闸');
{
  const VIS = 'guard:age_' + Date.now();
  const v = subs.visitorBy(VIS);
  store.update('visitors', v.id, { freeLeft: 0 }, 'guard');
  const o = mk(VIS);
  const r = pay.recordTransferProof(o.order.id, VIS);
  ok(r.ok === false && r.guarded === true, '刚下单立即提交被拒', r.error);
  guard({ minAgeSec: 0 });
  const r2 = pay.recordTransferProof(o.order.id, VIS);
  ok(r2.ok === true, '年龄闸关闭后可开通', r2.error);
}

console.log('=== 2. 并发待核销上限（同一访客只能有 1 笔在核账）');
{
  const VIS = 'guard:conc_' + Date.now();
  const v = subs.visitorBy(VIS);
  store.update('visitors', v.id, { freeLeft: 0 }, 'guard');
  guard({ minAgeSec: 0 });
  const a = mk(VIS, 'm');
  const b = mk(VIS, 'y');
  const r1 = pay.recordTransferProof(a.order.id, VIS);
  ok(r1.ok === true, '第一笔放行', r1.error);
  const r2 = pay.recordTransferProof(b.order.id, VIS);
  ok(r2.ok === false, '第二笔被拒（并发上限 1）', r2.error);
  const r3 = pay.recordTransferProof(a.order.id, VIS);
  ok(r3.ok === true, '同一笔重复提交仍放行（already）', JSON.stringify(r3).slice(0, 70));
}

console.log('=== 3. 未核销次数上限（已确认的不占额度）');
{
  const VIS = 'guard:quota_' + Date.now();
  const v = subs.visitorBy(VIS);
  store.update('visitors', v.id, { freeLeft: 0 }, 'guard');
  guard({ minAgeSec: 0, maxPerDay: 2, maxConcurrent: 0 });
  const a = mk(VIS, 'm');
  pay.recordTransferProof(a.order.id, VIS);
  pay.confirmManual(a.order.id, 'guard');
  const b = mk(VIS, 'y');
  pay.recordTransferProof(b.order.id, VIS);
  pay.confirmManual(b.order.id, 'guard');
  const c = mk(VIS, 'q');
  const r = pay.recordTransferProof(c.order.id, VIS);
  ok(r.ok === true, '已确认的购买不占未核销额度（第 3 笔仍放行）', r.error);
  pay.confirmManual(c.order.id, 'guard');
  const d = mk(VIS, 'w');
  const r2 = pay.recordTransferProof(d.order.id, VIS);
  ok(r2.ok === true, '第 4 笔（全部已确认，不占额度不占并发）放行', r2.error);
}

console.log('=== 4. 未核销刷单会被挡');
{
  const VIS = 'guard:abuse_' + Date.now();
  const v = subs.visitorBy(VIS);
  store.update('visitors', v.id, { freeLeft: 0 }, 'guard');
  guard({ minAgeSec: 0, maxPerDay: 2, maxConcurrent: 0 });
  const a = mk(VIS, 'm');
  const r1 = pay.recordTransferProof(a.order.id, VIS);
  ok(r1.ok === true, '第 1 笔未核销放行', r1.error);
  for (const x of store.list('provisional', 999)) {
    if (x.orderId === a.order.id) store.update('provisional', x.id, { reviewUntil: Date.now() - 1000 }, 'guard 超时');
  }
  pay.sweepManual();
  const b = mk(VIS, 'y');
  const r2 = pay.recordTransferProof(b.order.id, VIS);
  ok(r2.ok === true, '第 2 笔未核销放行', r2.error);
  for (const x of store.list('provisional', 999)) {
    if (x.orderId === b.order.id) store.update('provisional', x.id, { reviewUntil: Date.now() - 1000 }, 'guard 超时');
  }
  pay.sweepManual();
  const c = mk(VIS, 'q');
  const r3 = pay.recordTransferProof(c.order.id, VIS);
  ok(r3.ok === false, '第 3 笔未核销被拒（24h 内上限 2）', r3.error);
}

console.log('=== 5. 补交截图不受限制');
{
  const VIS = 'guard:resub_' + Date.now();
  const v = subs.visitorBy(VIS);
  store.update('visitors', v.id, { freeLeft: 0 }, 'guard');
  guard({ minAgeSec: 30, maxPerDay: 0, maxConcurrent: 0 });
  const o = mk(VIS);
  const r = pay.resubmitProof(o.order.id, VIS, 'shot', PNG);
  ok(r.ok === true, '补交（带截图）不受年龄/次数限制', r.error);
  const st = subs.status(VIS);
  ok(st.unlimited === true, '补交后 unlimited=true');
}

clean();
guardReset();
console.log('');
console.log('  pass=' + pass + ' fail=' + fail);
console.log(fail === 0 ? '>>> ALL PASS' : ('>>> ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
