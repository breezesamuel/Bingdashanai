require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// regress_assist.js — 远程协助（协调通道）回归（2026-10-23）
//
// 覆盖：
//   ① 没勾同意书 / 没写问题 / 没写范围 → 一律拒绝（同意书不可默认勾选）
//   ② 正常发起 → 进队列 → 接单 → 完成，状态机每一步只允许合法流转
//   ③ 客户只能撤回自己的请求；运营不能替客户撤回
//   ④ 24h 无人接单 → 自动过期，队列不再显示
//   ⑤ 全流程写审计（谁、什么时候、做了什么）
//   ⑥ 明确不含屏幕控制：响应里 mode 恒为 coordination-only
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const store = require(path.join(ROOT, 'core', 'store'));
const assist = require(path.join(ROOT, 'core', 'assist'));

let pass = 0, fail = 0;
const ok = (c, n, ex) => {
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + n + (c ? '' : '  -> ' + (ex || '')));
  c ? pass++ : fail++;
};
const auditCount = () => store.list('audit', 999).length;

const ME = 'ip:203_0_113_20:assist_me';
const OTHER = 'ip:203_0_113_21:assist_other';

// ===== ① 校验 =====
ok(assist.request(ME, {}).ok === false, '空请求被拒');
ok(assist.request(ME, { topic: '打不开页面', scope: '首页', consent: false }).ok === false, '未勾同意书被拒');
ok(assist.request(ME, { topic: '', scope: '首页', consent: true }).ok === false, '没问题描述被拒');
ok(assist.request(ME, { topic: '打不开页面', scope: '', consent: true }).ok === false, '没范围被拒');

// ===== ② 正常流程 =====
const before = auditCount();
const r1 = assist.request(ME, { topic: '付款后没到账', scope: '订单页与支付结果页', contact: '138****0000', consent: true });
ok(r1.ok === true, '合规请求创建成功', JSON.stringify(r1));
ok(r1.assist.status === 'requested', '初始状态 requested');
ok(r1.assist.mode === 'coordination-only', '明确标注不含屏幕控制');
ok(!!r1.assist.consentAt && r1.assist.consentText.length > 10, '同意书文本与时间已留痕');
ok(auditCount() > before, '创建写审计');

const q1 = assist.queue();
ok(q1.items.some(a => a.id === r1.assist.id), '出现在运营队列');
ok(q1.overdue === 0, '刚创建不算超时');
ok(q1.mode === 'coordination-only', '队列也标注不含屏幕控制');

ok(assist.complete(r1.assist.id, '跳过接单直接完成').ok === false, '未接单不能直接完成');
const acc = assist.accept(r1.assist.id, 'ops-alice');
ok(acc.ok === true && acc.assist.status === 'accepted', '运营接单成功');
ok(acc.assist.opsName === 'ops-alice', '接单人留痕');
ok(assist.accept(r1.assist.id, 'ops-bob').ok === false, '已接单不能重复接单');
const done = assist.complete(r1.assist.id, '已核对银行流水，补开权益并回复客户');
ok(done.ok === true && done.assist.status === 'completed', '完成归档');
ok(typeof done.assist.durationMin === 'number', '处理时长可统计');
ok(done.assist.resolution.indexOf('银行流水') >= 0, '处理结论留痕');

// ===== ③ 撤回权限 =====
const r2 = assist.request(ME, { topic: '不会导出报表', scope: '配额页面', consent: true });
ok(assist.cancel(r2.assist.id, OTHER).ok === false, '别人不能撤回我的请求');
const cancel = assist.cancel(r2.assist.id, ME);
ok(cancel.ok === true && cancel.assist.status === 'cancelled', '本人可撤回');
ok(cancel.assist.revokedBy === 'customer', '撤回方留痕');
ok(assist.cancel(r2.assist.id, ME).ok === false, '已撤回不能再次撤回');

// ===== ④ 过期 =====
store.push('assists', {
  visitor: ME, topic: '过期请求', scope: '测试', mode: 'coordination-only',
  consent: true, status: 'requested', createdAt: Date.now() - 25 * 3600 * 1000,
  expiresAt: Date.now() - 3600 * 1000,
}, 'seed', 'expired seed');
const swept = assist.sweep();
ok(swept >= 1, 'sweep 标记过期请求', String(swept));
const expiredRow = store.list('assists', 500).find(a => a.topic === '过期请求');
ok(expiredRow.status === 'expired', '过期状态落库');
ok(!assist.queue().items.some(a => a.id === expiredRow.id), '队列不再显示过期请求');
ok(assist.accept(expiredRow.id, 'ops').ok === false, '过期请求不能接单');

// ===== ⑤ 统计 =====
const s = assist.stats();
ok(s.ok === true && s.total >= 3, '统计总数正确', String(s.total));
ok(s.byStatus.completed === 1 && s.byStatus.cancelled === 1 && s.byStatus.expired === 1, '按状态分组正确', JSON.stringify(s.byStatus));
ok(typeof s.avgWaitMin === 'number', '平均等待可算');
ok(s.note.indexOf('屏幕控制未实现') >= 0, '统计明示不做屏幕控制');

// ===== ⑥ 客户自查 =====
const mine = assist.status(ME);
ok(mine.ok === true && mine.items.length >= 3, '客户能查到自己的全部请求');
ok(mine.items.every(a => a.visitor === ME), '不会查到别人的请求');

console.log('pass=' + pass + ' fail=' + fail);
console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
process.exit(fail === 0 ? 0 : 1);
