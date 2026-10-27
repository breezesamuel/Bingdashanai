require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 全面边界与幂等性测试
const store = require('../core/store');
const subs  = require('../core/subs');
const pay   = require('../core/pay');

let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  -> ' + extra : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }

// 本测试不测滥用防护
pay.setGuardOverride({ minAgeSec: 0, maxPerDay: 0, maxConcurrent: 0 });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const created = [];
function mkorder(vis, plan) {
  const o = subs.order(vis, plan || 'm', 'zh', '127.0.0.1');
  if (o.ok) created.push(o.order.id);
  return o;
}
function cleanup() {
  for (const id of created) {
    try { store.remove('orders', id); } catch (e) {}
    for (const x of store.list('provisional', 999)) if (x.orderId === id) { try { store.remove('provisional', x.id); } catch (e) {} }
    for (const x of store.list('sublist', 999)) if ((x.grantedOrders || []).includes(id)) { try { store.remove('sublist', x.id); } catch (e) {} }
    for (const x of store.list('revenue', 999)) if (String(x.id) === 'rev-' + id) { try { store.remove('revenue', x.id); } catch (e) {} }
  }
  for (const v of store.list('visitors', 999)) {
    if (/^edge:/.test(v.visitor || '')) { try { store.remove('visitors', v.id); } catch (e) {} }
  }
}

section('1. 重复提交幂等（连点两次「我已付款」）');
{
  const VIS = 'edge:idem_' + Date.now();
  const v = subs.visitorBy(VIS);
  store.update('visitors', v.id, { freeLeft: 0 }, 'edge');
  const o = mkorder(VIS);
  const r1 = pay.recordTransferProof(o.order.id, VIS);
  const r2 = pay.recordTransferProof(o.order.id, VIS);
  ok(r1.ok === true, '第一次提交成功');
  ok(r2.ok === true && r2.already === true, '第二次返回 already（不重复开通）', JSON.stringify(r2).slice(0, 90));
  const provs = store.list('provisional', 999).filter(x => x.orderId === o.order.id);
  ok(provs.length === 1, '乐观授权记录只有 1 条（不重复创建）', provs.length);
  const st = subs.status(VIS);
  ok(st.unlimited === true, 'unlimited=true');
  const subs1 = store.list('sublist', 999).filter(x => (x.grantedOrders || []).includes(o.order.id));
  ok(subs1.length === 0, '乐观阶段不写 sublist（时长未发）', subs1.length);
}

section('2. 内部确认重复调用幂等（不能重复加时长）');
{
  const VIS = 'edge:confirm_' + Date.now();
  const v = subs.visitorBy(VIS);
  store.update('visitors', v.id, { freeLeft: 0 }, 'edge');
  const o = mkorder(VIS);
  pay.recordTransferProof(o.order.id, VIS);
  const c1 = pay.confirmManual(o.order.id, 'edge');
  ok(c1.ok === true, '第一次确认成功');
  let st = subs.status(VIS);
  const exp1 = st.sub ? st.sub.expireAt : 0;
  const rev1 = store.list('revenue', 999).filter(r => String(r.id) === 'rev-' + o.order.id).length;
  ok(rev1 === 1, 'revenue 记账 1 条', rev1);
  const c2 = pay.confirmManual(o.order.id, 'edge');
  ok(c2.ok === true && c2.already === true, '第二次确认返回 already', JSON.stringify(c2).slice(0, 80));
  st = subs.status(VIS);
  ok(st.sub && st.sub.expireAt === exp1, 'expireAt 未变（时长没被重复加）', st.sub ? st.sub.expireAt : 'null');
  const rev2 = store.list('revenue', 999).filter(r => String(r.id) === 'rev-' + o.order.id).length;
  ok(rev2 === 1, 'revenue 仍为 1 条（没重复记账）', rev2);
  const subRows = store.list('sublist', 999).filter(x => (x.grantedOrders || []).includes(o.order.id));
  ok(subRows.length === 1, 'sublist 只有 1 条正式订阅', subRows.length);
}

section('3. 已确认订单再提交凭证（不能重新计时）');
{
  const VIS = 'edge:reopen_' + Date.now();
  const v = subs.visitorBy(VIS);
  store.update('visitors', v.id, { freeLeft: 0 }, 'edge');
  const o = mkorder(VIS);
  pay.recordTransferProof(o.order.id, VIS);
  pay.confirmManual(o.order.id, 'edge');
  const st1 = subs.status(VIS);
  const exp = st1.sub ? st1.sub.expireAt : 0;
  const r = pay.recordTransferProof(o.order.id, VIS);
  ok(r.ok === true, '再次提交返回成功');
  const st2 = subs.status(VIS);
  ok(st2.sub && st2.sub.expireAt === exp, 'expireAt 未变（已确认单不因重复提交延长）', st2.sub ? st2.sub.expireAt : 'null');
  const subRows = store.list('sublist', 999).filter(x => (x.grantedOrders || []).includes(o.order.id));
  ok(subRows.length === 1, 'sublist 仍只有 1 条', subRows.length);
}

section('4. 超时回收后 sublist 里的正式订阅不受影响');
{
  const VIS = 'edge:keep_' + Date.now();
  const v = subs.visitorBy(VIS);
  store.update('visitors', v.id, { freeLeft: 0 }, 'edge');
  const a = mkorder(VIS);
  pay.recordTransferProof(a.order.id, VIS);
  pay.confirmManual(a.order.id, 'edge');
  const before = subs.status(VIS);
  const b = mkorder(VIS);
  pay.recordTransferProof(b.order.id, VIS);
  for (const x of store.list('provisional', 999)) {
    if (x.orderId === b.order.id) store.update('provisional', x.id, { reviewUntil: Date.now() - 1000 }, 'edge 超时');
  }
  pay.sweepManual();
  const after = subs.status(VIS);
  ok(after.unlimited === true, '回收后仍 unlimited=true（正式订阅未被回收）');
  ok(after.sub && after.sub.expireAt === before.sub.expireAt, 'expireAt 未变', after.sub ? after.sub.expireAt : 'null');
  const provs = store.list('provisional', 999).filter(x => x.orderId === b.order.id);
  ok(provs.length === 1 && provs[0].status === 'expired', 'B 单的乐观授权被标记 expired', provs[0] ? provs[0].status : 'none');
}

section('5. 补交截图必须带真图（无图/假图都要拒）');
{
  const VIS = 'edge:shot_' + Date.now();
  const v = subs.visitorBy(VIS);
  store.update('visitors', v.id, { freeLeft: 0 }, 'edge');
  const o = mkorder(VIS);
  pay.recordTransferProof(o.order.id, VIS);
  const r1 = pay.resubmitProof(o.order.id, VIS, 'no image');
  ok(r1.ok === false && r1.needImage === true, '无图被拒', r1.error);
  const fake = 'data:text/plain;base64,' + Buffer.from('definitely not an image').toString('base64');
  const r2 = pay.resubmitProof(o.order.id, VIS, 'fake', fake);
  ok(r2.ok === false, '假图被拒（按魔数识别）', r2.error);
  const r3 = pay.resubmitProof(o.order.id, VIS, 'real', PNG);
  ok(r3.ok === true, '真图被接受', r3.error);
  const st = subs.status(VIS);
  ok(st.unlimited === true, '补交后 unlimited=true');
}

section('6. 不存在的订单号');
{
  const r = pay.recordTransferProof('mv_does_not_exist_xyz', 'edge:ghost');
  ok(r.ok === false, '不存在的订单被拒', r.error);
  const r2 = pay.resubmitProof('mv_does_not_exist_xyz', 'edge:ghost', 'x', PNG);
  ok(r2.ok === false, '不存在的订单补交被拒', r2.error);
  const r3 = pay.confirmManual('mv_does_not_exist_xyz', 'edge');
  ok(r3.ok === false, '不存在的订单确认被拒', r3.error);
}

section('7. 访客无授权时 gate 仍然拦（免费额度用尽）');
{
  const VIS = 'edge:gate_' + Date.now();
  const v = subs.visitorBy(VIS);
  store.update('visitors', v.id, { freeLeft: 0 }, 'edge');
  const g1 = subs.gate(VIS);
  ok(g1.allowed === false && g1.wall === true, '无订阅时被墙拦住');
  store.update('visitors', v.id, { freeLeft: 3 }, 'edge');
  const g2 = subs.gate(VIS);
  ok(g2.allowed === true && g2.freeLeft === 2, '有免费额度时放行并扣减', g2.freeLeft);
  const o = mkorder(VIS);
  pay.recordTransferProof(o.order.id, VIS);
  const g3 = subs.gate(VIS);
  ok(g3.allowed === true && g3.unlimited === true, '乐观开通后 gate 放行');
  const g4 = subs.gate(VIS);
  ok(g4.unlimited === true, 'gate 不消耗免费额度');
}

section('8. 乐观授权不影响别的访客');
{
  const V1 = 'edge:iso1_' + Date.now();
  const V2 = 'edge:iso2_' + Date.now();
  const v1 = subs.visitorBy(V1);
  const v2 = subs.visitorBy(V2);
  store.update('visitors', v1.id, { freeLeft: 0 }, 'edge');
  store.update('visitors', v2.id, { freeLeft: 0 }, 'edge');
  const o = mkorder(V1);
  pay.recordTransferProof(o.order.id, V1);
  const s1 = subs.status(V1);
  const s2 = subs.status(V2);
  ok(s1.unlimited === true, 'V1 已开通');
  ok(s2.unlimited === false && s2.wall === true, 'V2 未开通（互不影响）');
  const g2 = subs.gate(V2);
  ok(g2.allowed === false, 'V2 仍被墙拦');
}

section('9. 时长起算点用付款时刻（不是核账时刻）');
{
  const VIS = 'edge:base_' + Date.now();
  const v = subs.visitorBy(VIS);
  store.update('visitors', v.id, { freeLeft: 0 }, 'edge');
  const o = mkorder(VIS);
  pay.recordTransferProof(o.order.id, VIS);
  const paidAt = Number(store.list('orders', 999).find(x => x.id === o.order.id).paidAt);
  // 把核账时间往后推 1 小时（模拟核账延迟 1 小时）
  store.update('orders', o.order.id, { confirmedAt: Date.now() + 3600000 }, 'edge');
  pay.confirmManual(o.order.id, 'edge');
  const st = subs.status(VIS);
  const plan = st.sub ? st.sub.plan : null;
  const durMs = (plan === 'm') ? 30 * 86400000 : 0;
  const drift = Math.abs((st.sub.expireAt - paidAt) - durMs);
  ok(drift < 60000, 'expireAt = 付款时刻 + 完整时长（未因核账延迟被吞掉）', 'drift=' + Math.round(drift / 1000) + 's');
}

section('10. 过期回收不误伤其它 provisional 记录');
{
  const VIS = 'edge:multi_' + Date.now();
  const v = subs.visitorBy(VIS);
  store.update('visitors', v.id, { freeLeft: 0 }, 'edge');
  // 注意：同一访客同一方案的未付订单会被复用（防重复下单），所以要用不同方案造两单
  const a = mkorder(VIS, 'm');
  const b = mkorder(VIS, 'y');
  ok(a.order.id !== b.order.id, '不同方案产生不同订单', a.order.id + ' vs ' + b.order.id);
  pay.recordTransferProof(a.order.id, VIS);
  pay.recordTransferProof(b.order.id, VIS);
  const provs = store.list('provisional', 999).filter(x => x.visitor === v.visitor);
  ok(provs.length === 2, '两条乐观授权', provs.length);
  for (const x of provs) {
    if (x.orderId === a.order.id) store.update('provisional', x.id, { reviewUntil: Date.now() - 1000 }, 'edge 超时');
  }
  pay.sweepManual();
  const after = store.list('provisional', 999).filter(x => x.visitor === v.visitor);
  const aRec = after.find(x => x.orderId === a.order.id);
  const bRec = after.find(x => x.orderId === b.order.id);
  ok(aRec && aRec.status === 'expired', 'A 已过期');
  ok(bRec && bRec.status === 'active', 'B 仍有效（未被误伤）', bRec ? bRec.status : 'none');
}

section('11. 已付订单不被复用（再订阅同方案应新建单）');
{
  const VIS = 'edge:reuse_' + Date.now();
  const v = subs.visitorBy(VIS);
  store.update('visitors', v.id, { freeLeft: 0 }, 'edge');
  const a = mkorder(VIS, 'm');
  pay.recordTransferProof(a.order.id, VIS);
  pay.confirmManual(a.order.id, 'edge');
  const b = mkorder(VIS, 'm');
  ok(b.order.id !== a.order.id, '已付订单未被复用（新建了单）', b.order.id + ' vs ' + a.order.id);
  ok(b.order && b.order.paid === false, '新单为未付状态');
  const st = subs.status(VIS);
  ok(st.unlimited === true, '已确认订阅仍然有效');
}

cleanup();
pay.setGuardOverride(null);
console.log('');
console.log('  pass=' + pass + ' fail=' + fail);
console.log(fail === 0 ? '>>> ALL PASS' : ('>>> ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
