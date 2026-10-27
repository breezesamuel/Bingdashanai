// 回归测试：邀请返利的防刷（"自己邀请自己"不得变成 1 年白嫖）
// 红线：
//   ① 按**去重后的付费人数**计档（不是订单数）——自己连买 10 次月卡只算 1 人；
//   ② **同 IP 的被邀请人视为同一个人**（自造身份不算粉丝）——满 10 人返 1 年这条最肥，必须堵；
//   ③ ¥1 体验单不算"付费好友"；
//   ④ 幂等：重复结算不重复加月。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-invite-'));
process.env.BINGDASHAN_DATA_DIR = DATA;
let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + (typeof extra === 'object' ? JSON.stringify(extra).slice(0, 220) : extra) : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }

(async () => {
  const store = require(path.join(ROOT, 'core', 'store.js'));
  const subs = require(path.join(ROOT, 'core', 'subs.js'));
  const now = Date.now();

  const inviter = 'ip:9.9.9.9:inviter';
  store.push('visitors', { id: 'v-inv', visitor: inviter, freeLeft: 0, used: 0, paid: 0, monthsCredit: 0, invite: [], invitedBy: null, inviteCode: 'BDINV01', trialUsed: false, createdAt: now }, '测试：邀请人', inviter);

  section('1. 同 IP 自造 10 个"粉丝" → 不得拿到 1 年返利');
  // 造 10 个同 IP 的"被邀请人"，各付一笔月卡（真实付费）
  for (let i = 0; i < 10; i++) {
    const vk = 'ip:9.9.9.9:fake' + i;
    store.push('visitors', { id: 'v-f' + i, visitor: vk, freeLeft: 0, used: 0, paid: 1, monthsCredit: 0, invite: [], invitedBy: null, inviteCode: 'BDFK' + i, trialUsed: false, createdAt: now }, '测试：同 IP 假粉丝', vk);
    store.push('orders', {
      id: 'ord-f' + i, visitor: vk, plan: 'm', amount: 99, currency: 'CNY', paid: true, status: 'paid',
      invitedBy: inviter, at: now, createdAt: now, email: 'f' + i + '@example.com',
    }, '测试：同 IP 假粉丝付费单', vk);
  }
  const r1 = subs.settleInvite(inviter, store.findBy('orders', 'id', 'ord-f9'));
  ok(r1 && r1.totalPaidFans === 0, '同 IP 的"粉丝"不计数（自邀请不算）', r1 && r1.totalPaidFans);
  ok(r1 && r1.addedMonths === 0, '因此不产生任何返利月数', r1 && r1.addedMonths);
  const inv = store.findBy('visitors', 'id', 'v-inv');
  ok(inv && (inv.monthsCredit || 0) === 0 && (inv.inviteGrantedMonths || 0) === 0, '邀请人账上没有多发月数', inv && { credit: inv.monthsCredit, granted: inv.inviteGrantedMonths });

  section('2. 真实异 IP 粉丝 → 正常计档（不误伤）');
  const fanKey = 'ip:8.8.8.8:fan1';
  store.push('visitors', { id: 'v-fan', visitor: fanKey, freeLeft: 0, used: 0, paid: 1, monthsCredit: 0, invite: [], invitedBy: null, inviteCode: 'BDFAN1', trialUsed: false, createdAt: now }, '测试：真实粉丝', fanKey);
  store.push('orders', {
    id: 'ord-fan1', visitor: fanKey, plan: 'm', amount: 99, currency: 'CNY', paid: true, status: 'paid',
    invitedBy: inviter, at: now, createdAt: now, email: 'fan1@example.com',
  }, '测试：真实粉丝付费单', fanKey);
  const r2 = subs.settleInvite(inviter, store.findBy('orders', 'id', 'ord-fan1'));
  ok(r2 && r2.totalPaidFans === 1, '异 IP 真实粉丝计入', r2 && r2.totalPaidFans);
  ok(r2 && r2.addedMonths === 1 && r2.grantedMonths === 1, '满 1 人 → 返 1 个月', r2 && { added: r2.addedMonths, granted: r2.grantedMonths });

  section('3. 幂等：重复结算不重复加月');
  const r3 = subs.settleInvite(inviter, store.findBy('orders', 'id', 'ord-fan1'));
  ok(r3 && r3.addedMonths === 0 && r3.grantedMonths === 1, '再次结算不重复加月', r3 && { added: r3.addedMonths, granted: r3.grantedMonths });
  const inv2 = store.findBy('visitors', 'id', 'v-inv');
  ok(inv2 && (inv2.monthsCredit || 0) === 1, '账上只有 1 个月', inv2 && inv2.monthsCredit);

  section('4. ¥1 体验单不算付费好友');
  const trialKey = 'ip:7.7.7.7:trial1';
  store.push('visitors', { id: 'v-tr', visitor: trialKey, freeLeft: 0, used: 0, paid: 0, monthsCredit: 0, invite: [], invitedBy: null, inviteCode: 'BDTR1', trialUsed: true, createdAt: now }, '测试：体验用户', trialKey);
  store.push('orders', {
    id: 'ord-tr1', visitor: trialKey, plan: 't', amount: 1, currency: 'CNY', paid: true, status: 'paid',
    invitedBy: inviter, at: now, createdAt: now, email: 't1@example.com',
  }, '测试：体验付费单', trialKey);
  const r4 = subs.settleInvite(inviter, store.findBy('orders', 'id', 'ord-tr1'));
  ok(r4 && r4.totalPaidFans === 1, '体验单不增加粉丝数（仍只有 1 个真实粉丝）', r4 && r4.totalPaidFans);

  console.log('\npass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})();
