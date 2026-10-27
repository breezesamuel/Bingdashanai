require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 回归测试：已购永久订阅的客户再买一单，24h 超时回收**绝不能**摧毁原订阅
const store = require('../core/store');
const subs  = require('../core/subs');
const pay   = require('../core/pay');

const VIS = 'regress:' + Date.now();
let fail = 0;
function ok(cond, label, extra) {
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  -> ' + extra : ''));
  if (!cond) fail++;
}

console.log('=== 场景：客户已有永久订阅，再走人工通道买一单 ===');
// 本测试专注"临时开通隔离"逻辑，屏蔽滥用防护（年龄闸会拦掉立即提交）
const _prevAge = store.getSetting('manualMinOrderAgeSec');
const _prevMax = store.getSetting('manualMaxProvisionalPerDay');
pay.setGuardOverride({ minAgeSec: 0, maxPerDay: 0, maxConcurrent: 0 });
const v1 = subs.visitorBy(VIS);
store.update('visitors', v1.id, { freeLeft: 0 }, 'regress');

// 第一单：已确认（真实付费）→ 产生永久订阅
const o1 = subs.order(VIS, 'm', 'zh', '127.0.0.1');
ok(o1.ok, '第一单创建', o1.ok ? o1.order.id : o1.error);
if (o1.ok) {
  pay.settleOrder(o1.order.id, 'regress');
  let st = subs.status(VIS);
  ok(st.unlimited === true, '第一单后 unlimited=true');
  const before = st.sub ? st.sub.expireAt : 0;
  const beforeDays = st.sub ? st.sub.daysLeft : 0;
  console.log('     永久订阅 expireAt=' + before + ' daysLeft=' + beforeDays);

  // 第二单：人工通道乐观开通
  const o2 = subs.order(VIS, 'm', 'zh', '127.0.0.1');
  ok(o2.ok, '第二单创建', o2.ok ? o2.order.id : o2.error);
  if (o2.ok) {
    pay.recordTransferProof(o2.order.id, VIS);
    st = subs.status(VIS);
    ok(st.unlimited === true, '乐观开通后仍 unlimited=true');
    console.log('     provisional=' + st.provisional + ' (false=已有永久订阅，属正常)');

    // 模拟 24h 超时
    for (const x of store.list('provisional', 999)) {
      if (x.orderId === o2.order.id) store.update('provisional', x.id, { reviewUntil: Date.now() - 1000 }, 'regress 超时');
    }
    const sw = pay.sweepManual();
    console.log('     回收: ' + JSON.stringify(sw));

    st = subs.status(VIS);
    ok(st.unlimited === true, '★ 超时回收后仍然 unlimited=true（原永久订阅未被摧毁）');
    ok(st.sub && st.sub.expireAt === before, '★ 原订阅 expireAt 未变', st.sub ? st.sub.expireAt : 'null');
    ok(st.sub && st.sub.daysLeft >= beforeDays - 1, '★ 原订阅剩余天数未被清零', st.sub ? st.sub.daysLeft : 'null');

    // sublist 里不能出现 provisional 标记
    const marked = store.list('sublist', 999).filter(x => x.provisional);
    ok(marked.length === 0, '★ sublist 中没有任何 provisional 标记（隔离生效）', marked.length);

    // 内部确认第二单 → 应转正并加时长
    pay.confirmManual(o2.order.id, 'regress');
    st = subs.status(VIS);
    ok(st.unlimited === true, '确认后 unlimited=true');
    ok(st.sub && st.sub.expireAt > before, '★ 确认后订阅被顺延（>原 expireAt）', st.sub ? st.sub.expireAt : 'null');
    const prov2 = store.list('provisional', 999).filter(x => x.orderId === o2.order.id);
    ok(prov2.length === 1 && prov2[0].status === 'confirmed', '乐观授权标记为 confirmed', prov2[0] ? prov2[0].status : 'none');
  }
}

console.log('');
console.log('=== 场景：新客户（无历史订阅）走完整流程 ===');
const VIS2 = 'regress2:' + Date.now();
const v2 = subs.visitorBy(VIS2);
store.update('visitors', v2.id, { freeLeft: 0 }, 'regress');
const o3 = subs.order(VIS2, 'm', 'zh', '127.0.0.1');
ok(o3.ok, '下单', o3.ok ? o3.order.id : o3.error);
if (o3.ok) {
  pay.recordTransferProof(o3.order.id, VIS2);
  let st = subs.status(VIS2);
  ok(st.unlimited === true, '乐观开通 unlimited=true');
  ok(st.sub && st.sub.provisional === true, 'sub 标记 provisional=true（待核账）');
  ok(st.provisional === true, '顶层 provisional=true');

  // 过期回收
  for (const x of store.list('provisional', 999)) {
    if (x.orderId === o3.order.id) store.update('provisional', x.id, { reviewUntil: Date.now() - 1000 }, 'regress 超时');
  }
  pay.sweepManual();
  st = subs.status(VIS2);
  ok(st.unlimited === false, '超时后权益回收 unlimited=false');
  ok(st.needProof === true, 'needProof=true（要求补交截图）');

  // 补交 → 恢复（补交必须带真截图，否则服务端会拒）
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const rs = pay.resubmitProof(o3.order.id, VIS2, 'shot', PNG);
  ok(rs && rs.ok === true, '补交（带截图）被接受', rs && rs.error ? rs.error : 'ok');
  st = subs.status(VIS2);
  ok(st.unlimited === true, '补交后恢复 unlimited=true');

  // 内部确认 → 转正
  pay.confirmManual(o3.order.id, 'regress');
  st = subs.status(VIS2);
  ok(st.unlimited === true, '确认后 unlimited=true');
  const pv = store.list('provisional', 999).filter(x => x.orderId === o3.order.id);
  ok(pv[0] && pv[0].status === 'confirmed', '乐观授权 confirmed');
  const sl = store.list('sublist', 999).filter(x => (x.grantedOrders || []).includes(o3.order.id));
  ok(sl.length === 1 && !sl[0].provisional, 'sublist 有正式订阅且无 provisional 标记');
  const rev = store.list('revenue', 999).filter(r => String(r.id) === 'rev-' + o3.order.id);
  ok(rev.length === 1, 'revenue 记账 1 条', rev.length);
}

console.log('');
console.log('=== 清理 ===');
const allIds = [];
if (o1 && o1.order) allIds.push(o1.order.id);
if (o3 && o3.order) allIds.push(o3.order.id);
try {
  const o2rec = store.list('orders', 999).filter(x => x.manualStatus === 'provisionally_active' || x.manualStatus === 'confirmed');
  for (const x of o2rec) if (x.visitor === VIS) allIds.push(x.id);
} catch (e) {}
for (const id of allIds) {
  if (!id) continue;
  try { store.remove('orders', id); } catch (e) {}
  for (const x of store.list('provisional', 999)) if (x.orderId === id) { try { store.remove('provisional', x.id); } catch (e) {} }
  for (const x of store.list('sublist', 999)) if ((x.grantedOrders || []).includes(id)) { try { store.remove('sublist', x.id); } catch (e) {} }
  for (const x of store.list('revenue', 999)) if (String(x.id) === 'rev-' + id) { try { store.remove('revenue', x.id); } catch (e) {} }
}
for (const vv of [VIS, VIS2]) {
  const rec = store.list('visitors', 999).find(x => x.visitor === vv);
  if (rec) { try { store.remove('visitors', rec.id); } catch (e) {} }
}
// 恢复防护参数（进程内覆盖，公共 settings 从未被改动）
pay.setGuardOverride(null);
console.log('  cleaned');
console.log('');
console.log(fail === 0 ? '>>> ALL PASS' : ('>>> ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
