require('./_isolate');   // 【隔离】绝不写生产库
// regress_renewal.js — 续费/到期链路回归（2026-10-24）
//
// 【为什么必须有】renewalState / dueList / activate 顺延此前**零测试覆盖**：
// 续费是存量收入的唯一来源，这条链上的任何"时长算错/漏扫/重复加"都是直接的钱损。
// 覆盖：
//   ① renewalState 四态：none / ok / expiring(urgent) / expired
//   ② activate 时长叠加：第二单从当前到期点顺延（不是从 now 重算）
//   ③ 同一订单重复激活幂等（绝不多加时长）
//   ④ dueList 临期扫描窗口：7 天内入选、参数可收窄、过期即出局
//   ⑤ 体验档 t 按天（7 天）而非按月激活
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const store = require(path.join(ROOT, 'core', 'store'));
const subs = require(path.join(ROOT, 'core', 'subs'));

let pass = 0, fail = 0;
const ok = (c, n, ex) => {
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + n + (c ? '' : '  -> ' + (ex || '')));
  c ? pass++ : fail++;
};
const DAY = 86400000;
const V = 'regress:renewal_' + Date.now();

// ===== ① 无订阅：state=none =====
const s0 = subs.renewalState(V);
ok(s0.state === 'none', '新访客 renewalState=none', JSON.stringify(s0));

// ===== ② 激活月卡 + 状态 ok =====
const a1 = subs.activate(V, 'm', 'ord-r1');
ok(!!a1 && a1.expireAt > Date.now(), 'activate(m) 生成有效订阅', JSON.stringify(a1 && { expireAt: a1.expireAt }));
const d1 = Math.ceil((a1.expireAt - Date.now()) / DAY);
ok(d1 === 30, '月卡时长 30 天', String(d1));
const s1 = subs.renewalState(V);
ok(s1.state === 'ok' && s1.daysLeft >= 29 && s1.daysLeft <= 30, '激活后 renewalState=ok（daysLeft≈30）', JSON.stringify(s1));

// ===== ③ 顺延叠加：第二单从当前到期点续，不从 now 重算 =====
const a2 = subs.activate(V, 'm', 'ord-r2');
ok(String(a2.id) === String(a1.id), '顺延写入同一条 sublist（不建新行）');
ok(a2.expireAt === a1.expireAt + 30 * DAY, '第二单顺延 +30 天（从到期点续，不吞已用时长）',
  JSON.stringify({ a1: a1.expireAt, a2: a2.expireAt }));
const row = store.findAllBy('sublist', 'visitor', subs.visitorBy(V).visitor)[0];
ok(Array.isArray(row.grantedOrders) && row.grantedOrders.join(',') === 'ord-r1,ord-r2',
  'grantedOrders 记账两单（退款按单回收的依据）', JSON.stringify(row.grantedOrders));

// ===== ④ 同单重复激活幂等 =====
const a3 = subs.activate(V, 'm', 'ord-r1');
ok(a3.expireAt === a2.expireAt, '同一订单重复 activate 不多加时长（幂等）');

// ===== ⑤ 临期窗口：7 天内 expiring，≤3 天 urgent =====
store.update('sublist', row.id, { expireAt: Date.now() + 3 * DAY }, 'seed expiring 3d');
const s2 = subs.renewalState(V);
ok(s2.state === 'expiring' && s2.urgent === true, '剩 3 天 → expiring + urgent', JSON.stringify(s2));
store.update('sublist', row.id, { expireAt: Date.now() + 6 * DAY }, 'seed expiring 6d');
const s3 = subs.renewalState(V);
ok(s3.state === 'expiring' && s3.urgent === false, '剩 6 天 → expiring 但不 urgent', JSON.stringify(s3));
store.update('sublist', row.id, { expireAt: Date.now() + 8 * DAY }, 'seed ok 8d');
ok(subs.renewalState(V).state === 'ok', '剩 8 天（>RENEW_WINDOW）→ 回到 ok');

// ===== ⑥ dueList 临期扫描 =====
store.update('sublist', row.id, { expireAt: Date.now() + 3 * DAY }, 'seed due');
const dl = subs.dueList();
ok(dl.ok === true && Array.isArray(dl.rows) && dl.rows.some(x => x.visitor === subs.visitorBy(V).visitor),
  'dueList() 默认 7 天窗口抓到临期订阅', JSON.stringify(dl).slice(0, 120));
const dl2 = subs.dueList(2);
ok(Array.isArray(dl2.rows) && !dl2.rows.some(x => x.visitor === subs.visitorBy(V).visitor), 'dueList(2) 收窄窗口后 3 天临期不入选');

// ===== ⑦ 过期：expired 态 + dueList 出局 + 续费重建 =====
store.update('sublist', row.id, { expireAt: Date.now() - 2 * DAY }, 'seed expired');
const s4 = subs.renewalState(V);
ok(s4.state === 'expired' && s4.daysAgo === 2, '过期 2 天 → expired/daysAgo=2', JSON.stringify(s4));
ok(!subs.dueList().rows.some(x => x.visitor === subs.visitorBy(V).visitor), '已过期订阅不再进 dueList（那是召回清单不是墓碑）');
const a4 = subs.activate(V, 'm', 'ord-r3');
ok(a4.id !== row.id && a4.expireAt > Date.now(), '过期后续费 → 新订阅行、时长从 now 起算', JSON.stringify({ id: a4.id, old: row.id }));
ok(Math.ceil((a4.expireAt - Date.now()) / DAY) === 30, '重建订阅时长 30 天');

// ===== ⑧ 体验档按天激活（7 天，非 0 月立即过期） =====
const VT = 'regress:renewal_trial_' + Date.now();
const at = subs.activate(VT, 't', 'ord-rt1');
const dt = Math.ceil((at.expireAt - Date.now()) / DAY);
ok(dt === 7, '体验档 t 激活 7 天（days 字段生效，不再按 0 月立即过期）', String(dt));
ok(subs.renewalState(VT).state === 'expiring', '体验档 7 天天然落在续费提醒窗口内（首周即可引导转正）');

// ===== ⑨ 契约常量 =====
ok(subs.RENEW_WINDOW_DAYS === 7, '续费提醒窗口常量 = 7 天（对外文案依赖）');

console.log('pass=' + pass + ' fail=' + fail);
console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
process.exit(fail === 0 ? 0 : 1);
