// 回归测试：买家侧闭环（收据 / 到期提醒 / 退款回收权益）
// 红线：
//   ① 到账即发收据：发不出也要**如实留痕**（sent/failed/skipped_no_email），绝不假装发过；
//      邮件失败**不得**影响开通与结算。
//   ② 到期前提醒：每个订阅 20 天内最多提醒一次（去重），发不出同样如实留痕。
//   ③ 退款确认后**回收权益**（钱退了服务不能白用）；只回收该订单贡献的那一份。
// 【零污染】临时数据目录；不真发信（本地无 SMTP → 结果如实为 failed，这正是要锁的行为）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-receipt-'));
process.env.BINGDASHAN_DATA_DIR = DATA;
// 邮件离线：不连网（否则会真去连 smtp.qq.com，测试就不确定了）；结果如实为 failed
process.env.MAIL_DISABLE = '1';
let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + (typeof extra === 'object' ? JSON.stringify(extra).slice(0, 220) : extra) : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }

(async () => {
  const store = require(path.join(ROOT, 'core', 'store.js'));
  const subs = require(path.join(ROOT, 'core', 'subs.js'));
  const receipt = require(path.join(ROOT, 'core', 'receipt.js'));
  const refund = require(path.join(ROOT, 'core', 'refund.js'));
  const pay = require(path.join(ROOT, 'core', 'pay.js'));
  const now = Date.now();
  const MAIL = 'buyer2@example.com';
  const key = 'rec-visit-' + now;

  section('1. 到账即发收据：如实留痕，不影响开通');
  const ord = subs.order(key, 'm', 'zh', '1.2.3.4', MAIL);
  const oid = ord.order.id;
  const settled = pay.settleOrder(oid, '测试：收据回归');
  ok(settled && settled.ok, '结算并开通（收据发送不影响开通）', settled && settled.error);
  await new Promise((r) => setTimeout(r, 600));   // 等异步发信落账
  const o2 = store.findBy('orders', 'id', oid);
  ok(o2 && o2.receiptStatus, '订单上有收据状态留痕', o2 && o2.receiptStatus);
  ok(o2 && ['sent', 'failed', 'skipped_no_email'].indexOf(o2.receiptStatus) >= 0, '状态如实（sent/failed/skipped），不假装', o2 && o2.receiptStatus);
  const st = subs.status(key);
  ok(st && st.sub && st.sub.plan === 'm', '订阅已生效（发信失败也不回滚权益）', st && st.sub);

  section('2. 没有邮箱 → 明确 skipped（不假装发过）');
  const key2 = 'rec-visit-noemail-' + now;
  const ord2 = subs.order(key2, 'm', 'zh', '1.2.3.4', '');
  const r2 = await receipt.sendReceipt(store.findBy('orders', 'id', ord2.order.id));
  ok(r2 && r2.status === 'skipped_no_email', '无邮箱 → skipped_no_email', r2 && r2.status);

  section('3. 到期提醒：20 天内只提醒一次（去重）');
  // 造一个 3 天后到期的订阅
  store.push('sublist', {
    visitor: key, plan: 'm', tier: 'basic', expireAt: now + 3 * 86400000, grantedOrders: [oid], remindStatus: '', remindedAt: 0,
  }, '测试：临期订阅', key);
  const s1 = await receipt.sweepRenewalReminders(7);
  ok(s1 && s1.checked >= 1, '扫到临期订阅', s1 && s1);
  const sub1 = store.list('sublist').find((s) => s.visitor === key && s.grantedOrders && s.grantedOrders.includes(oid));
  ok(sub1 && sub1.remindedAt > 0, '提醒已执行并留痕', sub1 && { status: sub1.remindStatus, at: !!sub1.remindedAt });
  const s2 = await receipt.sweepRenewalReminders(7);
  ok(s2 && s2.checked === 0, '20 天内不重复提醒', s2 && s2);

  section('4. 退款确认 → 回收该订单带来的权益');
  const before = subs.status(key);
  const hadSub = !!(before && before.sub);
  const req = refund.request(oid, key, '测试：退款回收权益');
  ok(req && req.ok, '退款申请受理', req && req.error);
  const conf = refund.confirm(oid, 'ops-test');
  ok(conf && conf.ok, '退款出款确认', conf && conf.error);
  ok(conf && conf.revokedEntitlements >= 1, '权益被回收（钱退了服务不能白用）', conf && conf.revokedEntitlements);
  const after = subs.status(key);
  ok(!(after && after.sub && after.sub.plan === 'm' && (after.sub.daysLeft || 0) > 29),
    '退款后该单带来的订阅不再有效', after && after.sub);

  section('5. 过期召回：过期 14 天内提醒一次，且不反复打扰');
  const expKey = 'ip:5.5.5.5:expired1';
  store.push('visitors', { id: 'v-exp', visitor: expKey, freeLeft: 0, used: 0, paid: 1, monthsCredit: 0, invite: [], invitedBy: null, inviteCode: 'BDEXP1', trialUsed: false, createdAt: now }, '测试：过期用户', expKey);
  store.push('sublist', { visitor: expKey, plan: 'm', tier: 'basic', expireAt: now - 3 * 86400000, grantedOrders: ['ord-exp'], at: now - 30 * 86400000 }, '测试：已过期订阅', expKey);
  const e1 = await receipt.sweepRenewalReminders(7);
  ok(e1 && e1.checked >= 1, '扫到过期订阅（进入召回）', e1 && e1);
  const subE = store.list('sublist').find((s) => s.visitor === expKey);
  ok(subE && subE.expireRemindedAt > 0, '过期召回已执行并留痕', subE && { status: subE.expireRemindStatus, at: !!subE.expireRemindedAt });
  const e2 = await receipt.sweepRenewalReminders(7);
  ok(e2 && e2.checked === 0, '同一过期订阅不重复召回', e2 && e2);
  // 过期很久的不打扰
  const oldKey = 'ip:5.5.5.6:oldexp';
  store.push('visitors', { id: 'v-oldexp', visitor: oldKey, freeLeft: 0, used: 0, paid: 1, monthsCredit: 0, invite: [], invitedBy: null, inviteCode: 'BDOLDE', trialUsed: false, createdAt: now }, '测试：久过期用户', oldKey);
  store.push('sublist', { visitor: oldKey, plan: 'm', tier: 'basic', expireAt: now - 90 * 86400000, grantedOrders: ['ord-oldexp'], at: now - 120 * 86400000 }, '测试：久过期订阅', oldKey);
  const e3 = await receipt.sweepRenewalReminders(7);
  ok(e3 && e3.checked === 0, '过期 90 天的老订阅不打扰（不做无效召回）', e3 && e3);

  console.log('\npass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})();
