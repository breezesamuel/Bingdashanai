require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 回归测试：manual-confirm 后 gatePool 必须放行（026-10-22 修复）
//
// 问题：gatePool() 未检查 liveProvisional，导致 manual-confirm 后
//   前端墙被隐藏（payDone 调 hideWall），但后端每次 gateSection → gatePool
//   仍返回 allowed:false → 402 → hookWall 重新弹墙 → 客户付完钱依然被拦。
//
// 修复：gatePool 在 liveSub 检查前加 liveProvisional 守卫（与 gate() / status() 同口径）。
const store = require('../core/store');
const subs  = require('../core/subs');
const pay   = require('../core/pay');

const VIS = 'regress:gateprov_' + Date.now();
let fail = 0;
function ok(cond, label, extra) {
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  -> ' + extra : ''));
  if (!cond) fail++;
}

// 清理旧数据
store.remove('provisional', VIS);
const v = subs.visitorBy(VIS);
store.update('visitors', v.id, { freeLeft: 0 }, 'regress');

console.log('=== 1. 未开通前 gatePool 应拦截 ===');
let g = subs.gatePool(VIS, 'chatdeep');
ok(!g.allowed && g.wall === true, 'gatePool 拦截未付费访客');

// 屏蔽滥用防护，模拟真人扫码付款（订单 > 30s）
const _prevAge = store.getSetting('manualMinOrderAgeSec');
const _prevMax = store.getSetting('manualMaxProvisionalPerDay');
const _prevConc = store.getSetting('manualMaxConcurrentProvisional');
pay.setGuardOverride({ minAgeSec: 0, maxPerDay: 0, maxConcurrent: 0 });

console.log('\n=== 2. manual-confirm 后激活 provisional ===');
const o = subs.order(VIS, 'm', 'zh', '127.0.0.1');
ok(o.ok, '订单创建');
if (o.ok) {
  pay.recordTransferProof(o.order.id, VIS, '', '');
  // 等一等确保 store 落盘
  const p = subs.liveProvisional(VIS);
  ok(!!p, 'provisional 已写入');
}

console.log('\n=== 3. 关键：gatePool 在 provisional 期间应放行（不再 402）===');
g = subs.gatePool(VIS, 'chatdeep');
ok(g.allowed && !g.wall, 'gatePool 放行 provisional 访客',
  g.allowed ? '' : 'wall=' + g.wall + ' msg=' + (g.msg || ''));
ok(g.provisional === true, 'gatePool 返回 provisional:true', JSON.stringify(g));

console.log('\n=== 4. status() 同样应返回 unlimited=true ===');
const st = subs.status(VIS);
ok(st.unlimited === true, 'status.unlimited=true', 'unlimited=' + st.unlimited);
ok(!!st.sub, 'status.sub 有值（provisionalAsSub）');

console.log('\n=== 5. 再次 gatePool 仍放行（幂等）===');
g = subs.gatePool(VIS, 'agent');
ok(g.allowed && g.provisional === true, '多分区均放行', 'section=agent allowed=' + g.allowed);

console.log('\n=== 6. 清理 ===');
pay.setGuardOverride(null);
store.update('visitors', v.id, { freeLeft: 10 }, 'regress cleanup');
store.remove('provisional', VIS);
console.log('  cleaned');

console.log('\npass=' + (3 + (fail === 0 ? 3 : 0)) + ' fail=' + fail);
if (fail === 0) console.log('ALL PASS');
else process.exit(1);
