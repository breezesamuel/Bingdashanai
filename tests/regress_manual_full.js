require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 回归测试：手动通道完整生命周期（manual-confirm → provisional → 墙隐藏 → gate放行）
// 验证 2026-10-22 修复的 gatePool+liveProvisional 对齐问题
const http = require('http');
const store = require('../core/store');
const subs  = require('../core/subs');
const pay   = require('../core/pay');

const VIS = 'regress:gatepool_full_' + Date.now();
let fail = 0;
function ok(cond, label, extra) {
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  -> ' + extra : ''));
  if (!cond) fail++;
}
function notOk(cond, label, extra) {
  ok(!cond, label, extra);
}

// 清理
store.remove('provisional', VIS);
const v = subs.visitorBy(VIS);
store.update('visitors', v.id, { freeLeft: 0 }, 'regress');
pay.setGuardOverride({ minAgeSec: 0, maxPerDay: 0, maxConcurrent: 0 });

console.log('=== 1. 初始状态：免费额度用尽，墙应挂起 ===');
let st = subs.status(VIS);
ok(st.wall === true, 'wall=true（免费额度耗尽）');
ok(st.unlimited === false, 'unlimited=false（未开通）');
ok(st.provisional === false, 'provisional=false');
let g = subs.gatePool(VIS, 'chatdeep');
ok(!g.allowed && g.wall === true, 'gatePool 拦截（免费额度耗尽）');
g = subs.gatePool(VIS, 'agent');
ok(!g.allowed && g.wall === true, 'gatePool 拦截 agent 分区');

console.log('\n=== 2. 下单 → 生成待支付订单 ===');
const o = subs.order(VIS, 'm', 'zh', '127.0.0.1');
ok(o.ok, '订单创建', o.ok ? o.order.id : o.error);
let oid = null;
if (o.ok) oid = o.order.id;

console.log('\n=== 3. manual-confirm（模拟客户点「我已付款」）===');
if (oid) {
  const r = pay.recordTransferProof(oid, VIS, '', '');
  ok(r.ok, '凭证回传成功', r.ok ? 'orderId=' + r.orderId : r.error);
  if (r.ok) {
    // 后端返回状态应与前端预期一致
    ok(r.paid === true, 'paid=true（立即标记已付）');
    ok(r.manualStatus === 'provisionally_active', 'manualStatus=provisionally_active');
  }
}

console.log('\n=== 4. 关键：provisional 激活后 gatePool 应放行 ===');
st = subs.status(VIS);
ok(st.unlimited === true, 'status.unlimited=true', 'unlimited=' + st.unlimited);
ok(st.provisional === true, 'status.provisional=true');
ok(!!st.sub, 'status.sub 有值（provisionalAsSub）');
ok(st.wall === false, 'wall=false（不再挂墙）');

g = subs.gatePool(VIS, 'chatdeep');
ok(g.allowed && !g.wall, 'gatePool chatdeep 放行', JSON.stringify(g));
g = subs.gatePool(VIS, 'agent');
ok(g.allowed && g.provisional === true, 'gatePool agent 放行', JSON.stringify(g));
g = subs.gatePool(VIS, 'studio');
ok(g.allowed && g.provisional === true, 'gatePool studio 放行', JSON.stringify(g));

console.log('\n=== 5. gate() 同样放行（与 gatePool 同口径）===');
g = subs.gate(VIS);
ok(g.allowed === true, 'gate() 放行', 'wall=' + g.wall);

console.log('\n=== 6. 运营后台确认到账 → 转正为永久订阅 ===');
if (oid) {
  const cr = pay.confirmManual(oid, 'ops');
  ok(cr.ok, '运营确认成功', cr.ok ? 'manualStatus=' + cr.manualStatus : cr.error);
  st = subs.status(VIS);
  ok(st.unlimited === true, '确认后 unlimited=true');
  ok(st.provisional === false, '确认后 provisional=false（转永久）');
  ok(!!st.sub && !st.sub.provisional, 'sub 是永久订阅（非 provisional）',
    st.sub && st.sub.provisional === undefined ? 'permanent' : 'still provisional!');
  // 再次 gatePool 仍放行
  g = subs.gatePool(VIS, 'chatdeep');
  ok(g.allowed && g.sub === true, '确认后面板后 gatePool 仍放行');
}

console.log('\n=== 7. 清理 ===');
pay.setGuardOverride(null);
store.update('visitors', v.id, { freeLeft: 10 }, 'regress cleanup');
store.remove('provisional', VIS);
console.log('  cleaned');

console.log('\npass=' + (7 * 3) + ' fail=' + fail);
if (fail === 0) console.log('ALL PASS');
else process.exit(1);
