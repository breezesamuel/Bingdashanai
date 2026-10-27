// refund-e2e.js — 退款记账闭环回归
//
// 修复前的现状：全系统没有退款记账能力。
//   · money 模块无 refund，isSettled 也不认识「已退款」
//   · tickets.refund 只在工单上打 refundProcessed 标记，revenue 原封不动
//   · 后果：退完的钱继续计入 KPI 营收，5% 推广费也照提 —— 退款只存在于话术里
//   · 推广费记录没有 revId，就算想按单回退也匹配不到
//
// 本套件锁住：
//   1. 无凭证不得记账
//   2. 退款后 KPI 营收必须回落
//   3. 退款必须回退 5% 推广费，且推广池可用额正确回升（不得反向变少）
//   4. 退款幂等：重复退不二次冲减
//   5. 工单退款缺 revId 必须拒绝（不许出现「账没退、工单写已退」）
//   6. 已核销记录不可退款
const assert = require('assert');
const http = require('http');

const BASE = process.env.BINGDASHAN_E2E_BASE;
if (!BASE) {
  console.error('ABORT refund-e2e：未设置 BINGDASHAN_E2E_BASE。');
  console.error('本套件会写库，禁止指向生产实例。请通过 npm test（goal-e2e-runner）运行。');
  process.exit(2);
}
const ROOT = process.env.BINGDASHAN_E2E_ROOT || 'C:/Users/Think/project/BingDashan';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers || {})
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }); } catch (e) { resolve({ status: res.statusCode, body: {}, raw: d }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const money = require(ROOT + '/core/money');
const store = require(ROOT + '/core/store');
const tickets = require(ROOT + '/core/tickets');

console.log('\n=== refund-e2e ===');

(async function main() {
// ---------- 1. 无凭证不得记账 ----------
ok(money.refund('no-such-rev', '').ok === false, '无凭证退款被拒');
ok(money.refund('no-such-rev', 'x').ok === false, '不存在的营收记录退款被拒');

// ---------- 2/3. 退款回落 KPI + 回退推广费 ----------
const AMT = 20000;
const ID = 'rev-e2e-refund-' + Date.now();
const revBefore = money.kpi().revenue;
const poolBefore = money.budget().rawAvail;

const c = money.credit(AMT, '退款e2e夹具', 'Test', { settled: true, id: ID });
ok(c.ok === true, '夹具入账成功', JSON.stringify(c).slice(0, 120));

const revAfterCredit = money.kpi().revenue;
const poolAfterCredit = money.budget().rawAvail;
ok(Math.round((revAfterCredit - revBefore) * 100) === AMT * 100, '入账后 KPI 上升', '增量=' + (revAfterCredit - revBefore));
const expectedPromo = Math.round(AMT * money.PROMO_RATE * 100) / 100;
ok(Math.round((poolAfterCredit - poolBefore) * 100) === Math.round(expectedPromo * 100),
  '入账按 5% 计提推广费', '计提=' + Math.round((poolAfterCredit - poolBefore) * 100) / 100 + ' 期望=' + expectedPromo);

// 推广费记录必须带 revId（否则退款无法回退）
{
  const rec = (store.read().promo || []).find(x => x.revId === ID);
  ok(!!rec, '推广费记录带 revId（可按单回退）');
}

const r = money.refund(ID, '平台退款单号 R-E2E-1');
ok(r.ok === true, '退款记账成功', JSON.stringify(r).slice(0, 160));
ok(Math.round((money.kpi().revenue - revBefore) * 100) === 0,
  '退款后 KPI 回落到退款前（营收不残留）', '残留=' + (money.kpi().revenue - revBefore));
ok(Math.round(r.promoReturned * 100) === Math.round(expectedPromo * 100),
  '退款回退 5% 推广费', '回退=' + r.promoReturned + ' 期望=' + expectedPromo);
ok(Math.round((money.budget().rawAvail - poolBefore) * 100) === 0,
  '退款后推广池完全复原（不得反向变少）', '差额=' + Math.round((money.budget().rawAvail - poolBefore) * 100) / 100);

{
  const rec = (store.read().promo || []).find(x => x.revId === ID && x.kind === '冲回');
  ok(!!rec, '冲回记录已留痕（可审计，不是静默删除）');
  const stillThere = (store.read().promo || []).some(x => x.revId === ID && x.kind === '拨款');
  ok(stillThere, '原计提记录被保留（赚过又退了，痕迹要留）');
}

// ---------- 4. 幂等 ----------
{
  const rev = money.kpi().revenue, pool = money.budget().rawAvail;
  const again = money.refund(ID, '重复退');
  ok(again.ok === true && again.already === true, '重复退款幂等返回 already', JSON.stringify(again).slice(0, 120));
  ok(Math.round((money.kpi().revenue - rev) * 100) === 0, '重复退款不再二次冲减营收');
  ok(Math.round((money.budget().rawAvail - pool) * 100) === 0, '重复退款不再二次回退推广费');
}

// ---------- 5. 工单退款必须带 revId ----------
{
  const tk = tickets.create({ subject: '退款e2e', message: '客户要求退', channel: '资金' });
  let threw = '';
  try { tickets.refund(tk.id, true, '客户申请', {}); }
  catch (e) { threw = String(e.message || e); }
  ok(/revId|营收记录号/.test(threw), '工单退款缺 revId 被拒（不许账没退却写已退）', threw);
  const row = store.read().tickets.find(x => x.id === tk.id);
  ok(row && row.refundProcessed !== true, '被拒后工单未被标记为已退');

  const ID2 = 'rev-e2e-refund-tk-' + Date.now();
  // 基线必须取在入账**之前**：退款会让这笔钱消失，比的是「回到入账前的水平」，
  // 而不是「退款前后不变」（后者只在不退款时成立，写出来必然是错的断言）。
  const rev0 = money.kpi().revenue, pool0 = money.budget().rawAvail;
  money.credit(8000, '退款e2e工单夹具', 'Test', { settled: true, id: ID2 });
  ok(Math.round((money.kpi().revenue - rev0) * 100) === 800000, '工单夹具入账生效');
  const done = tickets.refund(tk.id, true, '客户申请退款', { revId: ID2, evidence: '平台退款单 R-E2E-2' });
  ok(done.money && done.money.revId === ID2, '工单退款完成真实记账', JSON.stringify(done.money));
  ok(Math.round((money.kpi().revenue - rev0) * 100) === 0,
    '工单退款后 KPI 回到入账前', '差额=' + (money.kpi().revenue - rev0));
  ok(Math.round((money.budget().rawAvail - pool0) * 100) === 0,
    '工单退款后推广池回到入账前', '差额=' + Math.round((money.budget().rawAvail - pool0) * 100) / 100);
}

// ---------- 退款不得虚增挂账 ----------
// kpi 的分桶是 settled→total / written_off→writtenOff / 其余→pending。
// 退款后 isSettled=false 且 status 不是 written_off，若不显式分桶，
// 这笔已退的钱会落进 pending —— 营收归零的同时挂账凭空多出同额。
(function () {
  const ID5 = 'rev-e2e-pend-' + Date.now();
  const p0 = money.kpi().pending;
  money.credit(5000, '挂账污染夹具', 'Test', { settled: true, id: ID5 });
  const p1 = money.kpi().pending;
  money.refund(ID5, '退款 R-PEND');
  const p2 = money.kpi().pending;
  ok(Math.round((p1 - p0) * 100) === 0, '实收不影响挂账余额', '增量=' + (p1 - p0));
  ok(Math.round((p2 - p0) * 100) === 0, '退款不虚增挂账（钱已退出账本）', '虚增=' + (p2 - p0));
})();

// ---------- 外币退款：USD 从 foreign / foreignPending 双桶正确退出 ----------
  // kpi 对外币分两个桶：已结算 → foreign[币种]，未结算 → foreignPending。
  // 退款必须同时把两个桶都摘干净，否则 USD 营收/挂账会永久残留。
  {
    const IDU = 'rev-e2e-usd-' + Date.now();
    const f0 = money.kpi().foreign.USD || 0;
    money.credit(300, '外币挂账夹具', 'Test', { settled: false, id: IDU + '-p', currency: 'USD' });
    ok(Math.round(money.kpi().foreignPending * 100) === 30000, 'USD 挂账进 foreignPending', 'pending=' + money.kpi().foreignPending);
    money.refund(IDU + '-p', '退款 R-USD-P');
    ok(Math.round(money.kpi().foreignPending * 100) === 0, 'USD 挂账退款后不残留', '残留=' + money.kpi().foreignPending);

    money.credit(500, '外币实收夹具', 'Test', { settled: true, id: IDU, currency: 'USD' });
    ok(Math.round(((money.kpi().foreign.USD || 0) - f0) * 100) === 50000, 'USD 实收进 foreign', 'foreign=' + JSON.stringify(money.kpi().foreign));
    money.refund(IDU, '退款 R-USD');
    ok(Math.round(((money.kpi().foreign.USD || 0) - f0) * 100) === 0, 'USD 退款从 foreign 退出', 'foreign=' + JSON.stringify(money.kpi().foreign));
  }

// ---------- 6. 已核销不可退款 ----------
{
  const ID3 = 'rev-e2e-wo-' + Date.now();
  money.credit(3000, '核销夹具', 'Test', { settled: false, id: ID3 });
  const wo = money.writeoff(ID3, '测试核销', 'e2e');
  ok(wo.ok === true, '挂账记录可核销');
  const rr = money.refund(ID3, '退款凭证');
  ok(rr.ok === false, '已核销记录不可退款（本就未到账）', JSON.stringify(rr));
}

// ---------- HTTP 端点透传 ----------
{
  const ID4 = 'rev-e2e-http-' + Date.now();
  const revH = money.kpi().revenue;   // 基线同样取在入账之前
  money.credit(6000, '退款e2e端点夹具', 'Test', { settled: true, id: ID4 });
  const tk = tickets.create({ subject: '退款e2e端点', message: '端点退款', channel: '资金' });
  const resp = await req('POST', '/v1/tickets/refund',
    { id: tk.id, processed: true, note: '端点退款', revId: ID4, evidence: 'R-E2E-4' },
    { 'X-Admin-Token': process.env.BINGDASHAN_ADMIN_TOKEN || '' });
  ok(resp.body.ok === true && resp.body.money, '退款端点返回记账结果', JSON.stringify(resp.body).slice(0, 180));
  // 端点在**服务进程**执行，这里必须重新拉一次看板（不能沿用旧快照）
  const revAfter = money.kpi().revenue;
  ok(Math.round((revAfter - revH) * 100) === 0,
    '退款端点真实冲减 KPI（服务进程写入对测试进程可见）', '差额=' + (revAfter - revH));
}

console.log('\n--- refund-e2e: ' + pass + '/' + (pass + fail) + ' ---');
})().catch(e => {
  console.error('refund-e2e 崩溃: ' + (e.stack || e.message));
  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  process.exit(1);
});

console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
process.exit(fail ? 1 : 0);
