// 回归测试：履约链路（契约→收款→交付→签收→售后）的**钱与状态机**
// 红线（两个真漏洞，由 scripts/ops/fulfillment_rehearse.js 演练器抓出）：
//   ① B2B 手动/对公收款此前**只标记 paidAt，不进 revenue** → 营收少记（商业账失真）
//      （网关路径走 pay.settleFulfillment 会记账，人工路径不会 —— 两条路径口径不一致）
//   ② 已闭环的订单（closedAt 已置）再次推进时，阶段从「已完成」**倒退回「已签收」**
//      → 履约统计与售后口径漂移
//   ③ 幂等：重复推进不能重复入账
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-fulfill-'));
process.env.BINGDASHAN_DATA_DIR = DATA;
let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + (typeof extra === 'object' ? JSON.stringify(extra).slice(0, 220) : extra) : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }

const store = require(path.join(ROOT, 'core', 'store.js'));
const fulfillment = require(path.join(ROOT, 'core', 'fulfillment.js'));

function seedLead() {
  const db = store.read();
  db.leads = db.leads || [];
  db.leads.push({ id: 'lead-1', name: '客户甲', company: '甲公司', deal: 2999, channel: '直客', source: 'test', status: 'won' });
  store.write(db);
  return fulfillment.createFromDeal('lead-1');
}

section('1. 成交 → 自动建履约单（不裸成交跳过履约）');
const made = seedLead();
ok(made && made.ok && made.order && made.order.orderNo, '履约单已建', made && (made.order && made.order.orderNo));
const no = made.order.orderNo;

section('2. 人工确认收款 → 收入必须入账（此前不记 = 营收少记）');
const o1 = store.read().fulfillment.find(x => x.orderNo === no);
const adv1 = fulfillment.advance(o1.id, { paid: true });
ok(adv1 && adv1.ok, '推进成功', adv1 && adv1.error);
const db1 = store.read();
const o1b = db1.fulfillment.find(x => x.orderNo === no);
ok(!!o1b.paidAt, 'paidAt 已落库');
const rev = (db1.revenue || []).find(r => r.id === 'ful-' + o1b.id);
ok(!!rev, '收入已入账（幂等键 ful-<id>）', rev && { id: rev.id, amt: rev.amt });
ok(rev && Number(rev.amt) === Number(o1b.amount), '入账金额 = 履约金额', rev && { rev: rev.amt, order: o1b.amount });
ok(!!o1b.credited, '履约单标记 credited（防重复入账）');

section('3. 幂等：重复推进不重复入账');
const before = (store.read().revenue || []).filter(r => r.id === 'ful-' + o1b.id).length;
fulfillment.advance(o1b.id, { paid: true });
const after = (store.read().revenue || []).filter(r => r.id === 'ful-' + o1b.id).length;
ok(before === 1 && after === 1, '收入仍然只有一条', { before, after });

section('4. 已闭环订单再次推进 → 阶段不得回退');
fulfillment.advance(o1b.id, { carrier: '物流', logisticsNo: 'TN-1' });
fulfillment.advance(o1b.id, { delivered: true });
const o2 = store.read().fulfillment.find(x => x.orderNo === no);
ok(String(o2.stage).indexOf('完成') >= 0, '签收后闭环为「已完成」', o2.stage);
fulfillment.advance(o2.id, { delivered: true });   // 幂等再推进
const o3 = store.read().fulfillment.find(x => x.orderNo === no);
ok(String(o3.stage).indexOf('完成') >= 0, '再次推进后仍是「已完成」（不倒退回已签收）', o3.stage);

console.log('\npass=' + pass + ' fail=' + fail);
console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
process.exit(fail === 0 ? 0 : 1);
