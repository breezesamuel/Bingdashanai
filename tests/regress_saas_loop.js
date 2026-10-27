require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// regress_saas_loop.js — 订阅闭环体检回归（2026-10-23）
//
// 覆盖：
//   ① 漏斗用真实台账算，分母为 0 时转化率必须是 null（不许写 0% 假装精确）
//   ② 内部/本机/测试访客必须剔除，且如实报告剔除数量
//   ③ 闭环断裂检查能抓到：付钱无权益 / 开通不使用 / 待付超时 / 凭证悬挂 / 退款悬空 / 库存低
//   ④ nextAction 只指向最严重且有样本的断点
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const store = require(path.join(ROOT, 'core', 'store'));
const loop = require(path.join(ROOT, 'core', 'saas-loop'));

let pass = 0, fail = 0;
const ok = (c, n, ex) => {
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + n + (c ? '' : '  -> ' + (ex || '')));
  c ? pass++ : fail++;
};
const DAY = 86400000;
const now = Date.now();

// —— 造数：1 个真实付费客户（付费+2 天使用+续费过）、1 个付钱没权益、1 个内部测试 ——
const V1 = 'ip:203_0_113_9:real1';
const V2 = 'ip:198_51_100_7:broken';
const VINT = 'regress:loop_' + now;
const VLOOP = 'ip:127_0_0_1:loopback';

store.push('visitors', { visitor: V1, freeLeft: 10, usageDays: {}, firstUseAt: now - 3 * DAY, lastUseAt: now - DAY, used: 5, invite: [], createdAt: now - 10 * DAY });
store.push('visitors', { visitor: V2, freeLeft: 10, used: 0, invite: [], createdAt: now - 5 * DAY });
store.push('visitors', { visitor: VINT, freeLeft: 10, used: 9, invite: [], createdAt: now - 2 * DAY });
store.push('visitors', { visitor: VLOOP, freeLeft: 10, used: 9, invite: [], createdAt: now - 2 * DAY });

const dkey = ts => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const v1 = store.list('visitors').find(v => v.visitor === V1);
store.update('visitors', v1.id, { usageDays: { [dkey(now - 2 * DAY)]: 3, [dkey(now - DAY)]: 2 } }, 'seed usage');

// 试用 1 笔 + 月付 1 笔（=> paid=1, trial=1, renewed=1）
store.push('orders', { visitor: V1, plan: 't', amount: 1, currency: 'CNY', status: 'paid', paid: true, trial: true, at: now - 5 * DAY });
store.push('orders', { visitor: V1, plan: 'm', amount: 99, currency: 'CNY', status: 'paid', paid: true, at: now - 4 * DAY });
// 第二笔非体验付费 = 真实续费（用于验证续费口径）
store.push('orders', { visitor: V1, plan: 'm', amount: 99, currency: 'CNY', status: 'paid', paid: true, at: now - DAY });
// 付钱但没权益
store.push('orders', { visitor: V2, plan: 'm', amount: 99, currency: 'CNY', status: 'paid', paid: true, at: now - 2 * DAY });
// 待付超 24h
store.push('orders', { visitor: V2, plan: 'q', amount: 269, currency: 'CNY', status: 'pending', paid: false, at: now - 3 * DAY });
// 凭证悬挂
store.push('orders', { visitor: V2, plan: 'm', amount: 99, currency: 'CNY', status: 'pending', paid: false, manualStatus: 'needProof', at: now - DAY });
// 内部测试单（必须被剔除）
store.push('orders', { visitor: VINT, plan: 'm', amount: 99, currency: 'CNY', status: 'paid', paid: true, at: now - DAY });

// V1 有效订阅（开通 4 天）
store.push('sublist', { visitor: V1, plan: 'm', tier: 'basic', expireAt: now + 25 * DAY, createdAt: now - 4 * DAY });
// V3 开通但从未使用（激活缺口）
const V3 = 'ip:203_0_113_10:dormant';
store.push('visitors', { visitor: V3, freeLeft: 0, used: 0, invite: [], createdAt: now - 8 * DAY });
store.push('orders', { visitor: V3, plan: 'm', amount: 99, currency: 'CNY', status: 'paid', paid: true, at: now - 8 * DAY });
store.push('sublist', { visitor: V3, plan: 'm', tier: 'basic', expireAt: now + 22 * DAY, createdAt: now - 8 * DAY });

// 退款悬空（超 24h）
store.push('refundRequests', { visitor: V2, orderId: 'x-refund', amount: 99, status: 'requested', at: now - 2 * DAY });
// 库存低
store.push('materials', { sku: 'BOX', name: '包装盒', onHand: 1, reorderPoint: 5, orderUpTo: 20, unit: '个' });
// 协助超时
store.push('assists', { visitor: V2, topic: '登录异常', scope: '登录页', mode: 'coordination-only', consent: true, status: 'requested', createdAt: now - 40 * 60000, expiresAt: now + DAY });

(async () => {
  // ===== ① 漏斗 =====
  const f = loop.funnel();
  const st = id => f.stages.find(s => s.id === id);
  ok(st('visit').count === 3, '访问=3（剔除 regress/127.0.0.1 后）', 'got ' + st('visit').count);
  ok(f.excluded.internalVisitors === 2, '剔除内部访客 2 人并如实报告', 'got ' + f.excluded.internalVisitors);
  ok(st('trial').count === 1, '试用=1', 'got ' + st('trial').count);
  ok(st('paid').count === 3, '付费=3（V1/V2/V3）', 'got ' + st('paid').count);
  ok(st('activate').count === 1, '激活=1（只有 V1 付费后有用）', 'got ' + st('activate').count);
  ok(st('retain').count === 1, '留存=1（V1 有 2 个使用日）', 'got ' + st('retain').count);
  ok(st('renew').count === 1, '续费=1（V1 两笔非体验付费）', 'got ' + st('renew').count);
  ok(st('visit').conversionPct === null, '首段无分母时转化率为 null（不写 0%）', String(st('visit').conversionPct));
  ok(f.secondary.trialToPaidPct === 100, '试用→付费=100%（V1 试用后买月付）', String(f.secondary.trialToPaidPct));
  ok(f.secondary.paidDirect === 2, '没试用直接付费=2（V2/V3）', String(f.secondary.paidDirect));

  // ===== ② 粘性 =====
  const s = loop.stickiness();
  ok(s.wau >= 1, 'WAU 有真实使用', 'wau=' + s.wau);
  ok(s.paidActive7 >= 1, '付费客户 7 日活跃 ≥1', 'got ' + s.paidActive7);
  ok(typeof s.avgUsesPerActiveDay === 'number' && s.avgUsesPerActiveDay > 0, '日均使用次数可算', String(s.avgUsesPerActiveDay));

  // ===== ③ 断裂检查 =====
  const checks = loop.integrity();
  const c = id => checks.find(x => x.id === id);
  ok(c('paid_no_entitlement').count === 1, '抓到「付钱无权益」1 条', JSON.stringify(c('paid_no_entitlement').samples));
  ok(c('sub_no_activation').count === 1, '抓到「开通不使用」1 条', JSON.stringify(c('sub_no_activation').samples));
  ok(c('pending_over_24h').count === 1, '抓到「待付超 24h」1 条', String(c('pending_over_24h').count));
  ok(c('proof_waiting').count === 1, '抓到「凭证悬挂」1 条', String(c('proof_waiting').count));
  ok(c('refund_pending').count === 1, '抓到「退款悬空」1 条', String(c('refund_pending').count));
  ok(c('assist_overdue').count === 1, '抓到「协助超时」1 条', String(c('assist_overdue').count));
  ok(c('stock_low').count === 1, '抓到「库存低」1 条', String(c('stock_low').count));
  ok(checks.every(x => x.action && x.severity), '每条断点都有处置动作与严重度');

  // ===== ④ 报告 =====
  const r = loop.report();
  ok(r.integrity.healthy === false, '有断点时 healthy=false');
  ok(/^【high】/.test(r.nextAction), 'nextAction 指向最严重的 high 断点', r.nextAction);
  ok(r.honesty.rates.indexOf('null') >= 0, '报告明示"分母为 0 用 null"');

  console.log('pass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  process.exit(fail === 0 ? 0 : 1);
})();
