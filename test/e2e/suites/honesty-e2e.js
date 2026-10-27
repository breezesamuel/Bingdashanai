// test/e2e/suites/honesty-e2e.js — 诚实三数与 D30 门口径回归
//
// 核心红线：付费只认「已结算实收」。挂账未到账、台账手填都不得让 gate 判为已付。
// 断言一律用「不变量」而非具体数值 —— 沙箱预置数据的实收笔数未知且会变。
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const { finish } = require('./_exit');
const store = require(ROOT + '/core/store');
const money = require(ROOT + '/core/money');
const PB = require(ROOT + '/core/playbook');

let pass = 0, fail = 0; const failures = [];
function T(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? ' . ' + detail : '')); }
  else { fail++; failures.push(name); console.log('FAIL ' + name + (detail ? ' . ' + detail : '')); }
}

(async () => {
  let doneTimer;
  const done = new Promise(r => { doneTimer = setTimeout(r, 60000, 'TIMEOUT'); });
  const run = (async () => {
    const cur = store.read();
    const origRev = (cur.revenue || []).slice();
    const origCs = cur.coldstart ? Object.assign({}, cur.coldstart) : null;
    const origAudit = (cur.audit || []).length;

    try {
      // 基线：沙箱预置的实测已结算实收笔数（未知，只作相对比较基准）
      const basePaid = PB.estimatePaid();

      // 造一笔「已成交但未到账」：settle=awaiting_fund
      const pendingId = 'e2e_pending_' + Date.now();
      cur.revenue = origRev.concat([{
        id: pendingId, amt: 888, currency: 'CNY',
        settle: 'awaiting_fund', status: 'awaiting_fund', at: Date.now()
      }]);
      // 台账故意高报
      cur.coldstart = { reg: 20, paid: 9999 };
      store.write(cur);

      T('money.isSettled rejects awaiting_fund', money.isSettled(cur.revenue[cur.revenue.length - 1]) === false);
      T('adding pending revenue does not raise paid', PB.estimatePaid() === basePaid, 'base=' + basePaid + ' now=' + PB.estimatePaid());

      const g = PB.gate();
      T('gate.paid equals measured settled, ignores ledger 9999', g.paid === basePaid, 'gate.paid=' + g.paid + ' base=' + basePaid);
      T('gate reports ledger raw value untouched', g.ledger && g.ledger.paid === 9999, 'ledger.paid=' + (g.ledger && g.ledger.paid));
      T('gate flags ledger over-report conflict', g.conflicts.some(c => /付费/.test(c)), JSON.stringify(g.conflicts).slice(0, 90));

      const h = PB.honestCounts();
      T('honestCounts counts the pending record', h.pending.count >= 1, 'pending=' + h.pending.count + ' amt=' + h.pending.amount);
      T('honestCounts excludes pending from paid', h.measured.paid === basePaid, 'measured.paid=' + h.measured.paid);
      T('honestCounts exposes ledger raw 9999', h.ledger && h.ledger.paid === 9999);
      T('honestAnswer names the conflict', /冲突/.test(h.honestAnswer), h.honestAnswer.slice(0, 70));

      // tally 高报必须当场告警
      const t = PB.tally({ paid: 9999 });
      T('tally warns when paid > measured', Array.isArray(t.warnings) && t.warnings.length >= 1, (t.warnings[0] || '').slice(0, 60));

      // 标记为已结算实收后，付费应恰好 +1
      const d2 = store.read();
      const rec = d2.revenue.find(x => x.id === pendingId);
      rec.settle = '工商银行转账';
      rec.status = 'received';
      store.write(d2);
      T('gate.paid rises by exactly 1 after settlement', PB.gate().paid === basePaid + 1, 'now=' + PB.gate().paid + ' expect=' + (basePaid + 1));

      // 还原为未到账，付费应回落
      const d3 = store.read();
      d3.revenue.find(x => x.id === pendingId).settle = 'awaiting_fund';
      d3.revenue.find(x => x.id === pendingId).status = 'awaiting_fund';
      store.write(d3);
      T('un-settling lowers paid back', PB.gate().paid === basePaid, 'now=' + PB.gate().paid);

      // board 原有字段未破坏
      const b = PB.board();
      T('board legacy fields intact', b.total === 30 && typeof b.done === 'number' && !!b.phase, 'total=' + b.total);
      T('board exposes evidence + honesty', !!b.evidence && !!b.honesty, 'ev.total=' + (b.evidence && b.evidence.total));

      // 零成本 A 级：应可枚举且按 ROI 降序
      const z = PB.ranked().filter(r => r.c === 0 && r.ev === 'A');
      T('zero-cost A-grade actions enumerable', z.length >= 4, 'n=' + z.length);
      const roiSeq = z.map(r => Math.round((r.imp / 0.5) * 100) / 100);
      const desc = roiSeq.every((v, i) => i === 0 || roiSeq[i - 1] >= v);
      T('zero-cost A-grade sorted by ROI descending', desc, 'D' + z.map(r => r.day).join(',') + ' roi=' + roiSeq.join('>'));
      const full = PB.ranked();
      const fullRoi = full.map(r => Math.round((r.imp / (r.c + 0.5)) * 100) / 100);
      T('full ranked list is ROI descending', fullRoi.every((v, i) => i === 0 || fullRoi[i - 1] >= v), 'head=' + fullRoi.slice(0, 5).join('>'));
    } finally {
      const d4 = store.read();
      d4.revenue = origRev;
      if (origCs) d4.coldstart = origCs; else delete d4.coldstart;
      d4.audit = (d4.audit || []).slice(0, origAudit);
      store.write(d4);
    }
  })();
  const r = await Promise.race([run, done]);
  clearTimeout(doneTimer);   // race 一结束就释放，否则进程要干等到超时点才退
  if (r === 'TIMEOUT') { fail++; failures.push('TIMEOUT'); console.log('TIMEOUT'); }
  console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  if (fail) { console.error('FAILED: ' + failures.join(', ')); }
  finish(fail ? 1 : 0);
})();
