// test/e2e/suites/settle-e2e.js — 收款口径与核销红线
//
// 本套件守护三条不可越过的红线：
//   1. settle（确认到账）必须有凭证；无凭证不得入账营收。
//   2. writeoff（核销）绝不等价于收款：核销后 isSettled 仍为 false，
//      不计 revenue、不计 KPI、不补提推广费。钱没进来就没有任何计提基数。
//   3. 已结算的记录不允许再核销（钱已到手再谈核销是自相矛盾）。
// 另含付款指令完整性：缺网点号/机构代码不得生成半份指令。
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const { finish } = require('./_exit');
const fs = require('fs');
const store = require(ROOT + '/core/store');
const money = require(ROOT + '/core/money');
const payout = require(ROOT + '/core/payout');

let pass = 0, fail = 0; const failures = [];
function T(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? ' . ' + detail : '')); }
  else { fail++; failures.push(name); console.log('FAIL ' + name + (detail ? ' . ' + detail : '')); }
}

(async () => {
  let doneTimer;
  const done = new Promise(r => { doneTimer = setTimeout(r, 90000, 'TIMEOUT'); });
  const run = (async () => {
    const cur = store.read();
    const bk = {
      revenue: (cur.revenue || []).slice(),
      receivable: (cur.receivable || []).slice(),
      promo: (cur.promo || []).slice(),
      auditN: (cur.audit || []).length,
      orders: (cur.orders || []).slice(),
      visitors: (cur.visitors || []).slice(),
      sublist: (cur.sublist || []).slice()
    };
    const rid = 'e2e_wo_' + Date.now();

    try {
      // ── 1. settle 必须有凭证 ────────────────────────────────
      cur.revenue = bk.revenue.concat([{ id: rid, amt: 1280, currency: 'CNY', status: 'awaiting_fund', at: Date.now() }]);
      cur.receivable = bk.receivable.concat([{ id: 'e2e_q_' + Date.now(), revId: rid, amt: 1280, status: 'awaiting_fund' }]);
      cur.promo = bk.promo.slice();
      store.write(cur);

      T('settle without evidence is rejected', money.settle(rid, '').ok === false);
      T('settle of unknown id is rejected', money.settle('nope_' + rid, '流水 x').ok === false);

      const k0 = money.kpi();
      T('rejected settle left revenue untouched', money.kpi().revenue === k0.revenue, 'revenue=' + k0.revenue);
      T('rejected settle left pending amount untouched', money.kpi().pending === k0.pending, 'pending=' + k0.pending);

      // ── 2. 核销红线 ───────────────────────────────────────
      T('writeoff without reason is rejected', money.writeoff(rid, '').ok === false);
      T('writeoff of unknown id is rejected', money.writeoff('nope_' + rid, '客户放弃').ok === false);

      const w = money.writeoff(rid, '客户放弃', '超过约定天数无回单，电话未接');
      T('writeoff succeeds', w.ok === true, 'rows=' + w.receivableRows);

      const rec = store.list('revenue', 9999).find(r => r.id === rid);
      T('CRITICAL: written_off is NOT settled', money.isSettled(rec) === false, 'isSettled=' + money.isSettled(rec));
      T('written_off carries reason + timestamp', !!rec.writeoffReason && !!rec.writtenOffAt, rec.writeoffReason);

      const k1 = money.kpi();
      T('CRITICAL: writeoff does not raise revenue', k1.revenue === k0.revenue, k0.revenue + ' -> ' + k1.revenue);
      T('CRITICAL: writeoff removes it from pending', k1.pending === k0.pending - 1280, k0.pending + ' -> ' + k1.pending);
      T('written_off surfaced separately in kpi', k1.writtenOff === k0.writtenOff + 1280, 'writtenOff=' + k1.writtenOff);
      T('receivable summary shows writtenOff bucket', k1.receivable.writtenOffCount >= 1, JSON.stringify(k1.receivable));

      const promoAdded = store.list('promo', 9999).filter(p => String(p.detail || '').indexOf(rid) >= 0 || String(p.note || '').indexOf(rid) >= 0);
      T('CRITICAL: writeoff accrues no promo', promoAdded.length === 0, 'n=' + promoAdded.length);

      T('writeoff is idempotent', money.writeoff(rid, '客户放弃').already === true);
      T('writeoff ledger lists the record', money.writeoffAll().some(x => x.id === rid));

      // ── 3. 已结算不可核销 ──────────────────────────────────
      const rid2 = rid + '_s';
      store.write(Object.assign(store.read(), {
        revenue: (store.read().revenue || []).concat([{ id: rid2, amt: 300, status: 'paid', settled: true, at: Date.now() }])
      }));
      T('settled record cannot be written off', money.writeoff(rid2, '客户放弃').ok === false);

      // ── 4. 付款指令完整性 ──────────────────────────────────
      // 【2026-09】core/payout.js 的配置路径已从 <项目>/data/payout.json 改为
      // store.dataPath()（可写数据目录）—— 打包后前者落在只读的 app.asar 内，
      // 而 config() 还要 writeFileSync 写回它，asar 里必然失败。
      // 副作用：沙箱（BINGDASHAN_DATA_DIR）里没有 payout.json，下面整段 if(cfg) 会被跳过，
      // 断言数从 40 掉到 18 —— 覆盖率悄悄掉了。所以这里**自己种一份**，
      // 让付款指令这条链路在任何沙箱状态下都被真正验证。
      if (!payout.config()) {
        const seeded = payout.save({
          bank: '中国工商银行', account: '6222031001026162672', holder: '测试户名',
          branchCode: '2993', institutionCode: '102290029937',
          branchName: '测试支行', branchAddress: '测试地址', alipay: 'test@example.com'
        });
        T('payout config seeded into sandbox (asar-safe path)', seeded.ok === true, seeded.error || '');
      }
      const cfg = payout.config();
      if (cfg) {
        T('payout config validates', payout.validate().ok === true, 'missing=' + JSON.stringify(payout.validate().missing || []));
        const m = payout.masked();
        T('masked view never returns full account', m && m.accountMasked && m.accountMasked.indexOf(String(cfg.account)) < 0, m && m.accountMasked);

        const ins = payout.instruction({ revId: rid, amt: 1280, title: '测试', from: 'tester' });
        T('instruction generated', ins.ok === true, ins.error || '');
        if (ins.ok) {
          const md = fs.readFileSync(ins.file, 'utf8');
          T('instruction includes branch code', md.indexOf(String(cfg.branchCode)) >= 0, 'branchCode=' + cfg.branchCode);
          T('instruction includes institution code', md.indexOf(String(cfg.institutionCode)) >= 0);
          T('instruction carries order id as reconciliation anchor', md.indexOf(rid) >= 0);
          T('instruction states it is not proof of payment', /不等于|未到账|待到账/.test(md));
          T('instruction keeps blank lines (markdown intact)', /\n\n/.test(md));
        }
        T('instruction without revId rejected', payout.instruction({ amt: 100 }).ok === false);
        T('instruction with zero amount rejected', payout.instruction({ revId: rid, amt: 0 }).ok === false);
        T('incomplete config rejected by save', payout.save({ bank: 'x', account: 'y' }).ok === false);

        // ── 5. 催款函 ────────────────────────────────────────
        const dl = payout.dunningLetter({ revId: rid, amt: 1280, payer: 'manishiitg', title: '定制服务', round: 2, overdueDays: 5 });
        T('dunning letter generated', dl.ok === true, dl.error || '');
        if (dl.ok) {
          const md = fs.readFileSync(dl.file, 'utf8');
          T('letter carries order id as anchor', md.indexOf(rid) >= 0);
          T('letter carries amount', /1,280\.00/.test(md));
          T('letter includes branch code', md.indexOf(String(cfg.branchCode)) >= 0);
          T('letter includes institution code', md.indexOf(String(cfg.institutionCode)) >= 0);
          T('letter states payment not received', /未收到/.test(md));
          T('letter offers appeal path if already paid', /已付款|已付/.test(md));
          // 催款函不得凭空造出不存在的约定或威胁
          T('letter invents no penalty/threat', !/(违约金|滞纳金|诉讼|起诉|法务|拉黑|曝光)/.test(md), '不得编造约定或威胁客户');
          T('letter keeps markdown blank lines', /\n\n/.test(md));
          T('letter round number rendered', /第 2 次/.test(md));
        }
        T('dunning without revId rejected', payout.dunningLetter({ amt: 100 }).ok === false);
        T('dunning with zero amount rejected', payout.dunningLetter({ revId: rid, amt: 0 }).ok === false);

        // ── 6. 网关到账 settleOrder 与人工确认口径必须完全同步（逐行对账）──
        // 此前两行分叉吞了两宗账错：
        //   ① settleOrder 不传 noPromo → 网关成交的 ¥1 体验单也拨走 5% 推广费；
        //   ② settleOrder 不置位 trialUsed → 「首月体验每人一次」闸门被网关彻底绕过。
        const subs = require(ROOT + '/core/subs');
        const pay = require(ROOT + '/core/pay');
        const vid = 'visitor-trial-settle';
        if (!store.list('visitors', 999).some(v => v.visitor === vid)) {
          store.push('visitors', { visitor: vid, freeLeft: 3, used: 0, paid: 0, monthsCredit: 0, inviteGrantedMonths: 0, createdAt: Date.now() }, '建访客', vid);
        }
        const tO = store.push('orders', {
          visitor: vid, plan: 't', amount: 1, currency: 'CNY',
          months: 1, status: 'pending', paid: false, at: Date.now(), trial: true, invitedBy: null
        }, '测试下单', vid + ' ¥1/trial');
        const r0 = pay.settleOrder(tO.id);
        const o1 = store.list('orders', 999).find(x => x.id === tO.id);
        T('settleOrder trial order marked paid', r0.ok === true && o1 && o1.paid === true, r0.error || '');
        const v1 = store.list('visitors', 999).find(x => x.visitor === vid);
        T('trialUsed flipped on gateway settle', v1 && v1.trialUsed === true, v1 && v1.trialUsed);
        const promoAfter = store.list('promo', 999).filter(p => p.note && p.note.indexOf('5%') >= 0);
        const marker = store.list('audit', 999).some(a => a.action === '推广费计提豁免');
        T('gateway-settled trial contributes 0 promo rows', marker, 'promoWaived audit present');
        // 幂等：第二次 settleOrder 仍返回 already，不重复入账
        const revN = store.list('revenue', 999).length;
        const r1 = pay.settleOrder(tO.id);
        T('settleOrder idempotent (already)', r1.ok === true && r1.already === true);
        T('no double revenue entry on repeat settle', store.list('revenue', 999).length === revN, 'rev=' + (store.list('revenue', 999).length - revN));
        // subs.confirm 路径对照同样置位 trialUsed
        const tO2 = store.push('orders', {
          visitor: vid, plan: 't', amount: 1, currency: 'CNY',
          months: 1, status: 'pending', paid: false, at: Date.now(), trial: true, invitedBy: null
        }, '测试下单', vid + ' ¥1/trial seq2');
        const r2 = subs.confirm(tO2.id);
        const sublistNow = store.list('sublist', 999).filter(x => x.visitor === vid);
        T('subs.confirm returns paid order', r2.ok === true, r2.error || '');
        T('confirm path keeps subscription active', sublistNow.length > 0, 'sublist=' + sublistNow.length);

        // ── 7. 端到端深挖回归：半程单自愈 / 体验单漏斗不死锁 / 外币不混算 ──
        // ① 半程单自愈：paid 已置但副作用为零（模拟置位后、入账前崩溃）。
        //    旧代码 already 直接 return，把「钱没入账/订阅没开通」永久跳过。
        const oH = store.push('orders', {
          visitor: vid, plan: 'm', amount: 99, currency: 'CNY',
          months: 1, status: 'paid', paid: true, paidAt: Date.now(), at: Date.now(), invitedBy: null, trial: false
        }, '测试下单', vid + ' heal');
        const revH0 = store.list('revenue', 999).length;
        const subH0 = store.list('sublist', 999).find(x => x.visitor === vid && x.expireAt > Date.now());
        const expH0 = subH0 && subH0.expireAt;
        const h1 = subs.confirm(oH.id);
        T('heal confirm runs side effects on paid order', h1.ok === true && h1.already === true, h1.error || '');
        T('heal credited the missing revenue', store.list('revenue', 999).some(r => r.id === 'rev-' + oH.id),
          'delta=' + (store.list('revenue', 999).length - revH0));
        const subH1 = store.list('sublist', 999).find(x => x.visitor === vid && x.expireAt > Date.now());
        T('heal extended subscription by plan months', subH1 && expH0 && (subH1.expireAt - expH0) === subs.MONTH_MS,
          'deltaMs=' + (subH1 ? subH1.expireAt - expH0 : 'n/a'));
        const revH1 = store.list('revenue', 999).length, expH1 = subH1.expireAt;
        const h2 = subs.confirm(oH.id);
        T('2nd confirm heals nothing new (no dup revenue)', store.list('revenue', 999).length === revH1,
          'delta=' + (store.list('revenue', 999).length - revH1));
        const subH2 = store.list('sublist', 999).find(x => x.visitor === vid && x.expireAt > Date.now());
        T('2nd confirm heals nothing new (no dup months)', subH2.expireAt === expH1, 'deltaMs=' + (subH2.expireAt - expH1));
        // ② activate 同一 orderId 只加一次时长（grantedOrders 幂等键）
        const expA = subH2.expireAt;
        subs.activate(vid, 'm', 'ord-idem-test');
        subs.activate(vid, 'm', 'ord-idem-test');
        const subA = store.list('sublist', 999).find(x => x.visitor === vid && x.expireAt > Date.now());
        T('activate same orderId grants exactly once', subA.expireAt - expA === subs.MONTH_MS, 'deltaMs=' + (subA.expireAt - expA));
        // ③ 体验单漏斗：未付 pending 单复用而不是一拒到底（旧逻辑刷新后永锁）
        const vid2 = 'visitor-reuse-test';
        if (!store.list('visitors', 999).some(v => v.visitor === vid2)) {
          store.push('visitors', { visitor: vid2, freeLeft: 3, used: 0, paid: 0, monthsCredit: 0, inviteGrantedMonths: 0, createdAt: Date.now() }, '建访客', vid2);
        }
        const ru1 = subs.order(vid2, 't', 'CN');
        const ru2 = subs.order(vid2, 't', 'CN');
        T('fresh trial order created', ru1.ok === true && !!ru1.order, ru1.error || '');
        T('pending trial order reused with same id', ru2.ok === true && ru2.reused === true && ru2.order.id === ru1.order.id,
          JSON.stringify({ reused: ru2.reused, id: ru2.order && ru2.order.id }));
        T('reused trial order carries fresh pay guide', !!(ru2.pay && ru2.pay.receive && ru2.pay.confirmBy));
        // ④ 外币不混算：USD 入账不进 CNY KPI 分子、不进 CNY 推广池；credit 幂等键查重
        const k0 = money.kpi();
        // 【基线必须是 foreign.USD 的当前值，不能写死 12】
        // runner 让所有套件共用同一个沙箱，前面的 refund-e2e 也会记 USD 实收。
        // 断言绝对值 foreign.USD === 12 会随**执行顺序**而红（实测跑到 512）。
        // 要验的是「这笔 USD 进了 foreign 且只进 12」，所以比较增量。
        const usdBefore = Number(k0.foreign && k0.foreign.USD) || 0;
        const usd = money.credit(12, '订阅-m(USD)', 'PayPal', { id: 'rev-usd-e2e', currency: 'USD' });
        const k1 = money.kpi();
        T('USD credit ok with currency', usd.ok === true && usd.rec && usd.rec.currency === 'USD', JSON.stringify(usd).slice(0, 120));
        T('USD excluded from CNY KPI revenue', k1.revenue === k0.revenue, k0.revenue + ' -> ' + k1.revenue);
        T('USD tracked in foreign map', Math.round(((k1.foreign && k1.foreign.USD) || 0) - usdBefore) === 12,
          'delta=' + Math.round(((k1.foreign && k1.foreign.USD) || 0) - usdBefore) + ' before=' + usdBefore + ' after=' + JSON.stringify(k1.foreign));
        T('USD adds no promo to CNY budget pool', !store.list('promo', 999).some(p => p.kind === '拨款' && p.amt === 0.6),
          'no $12*5% row');
        const usdDup = money.credit(12, '订阅-m(USD)', 'PayPal', { id: 'rev-usd-e2e', currency: 'USD' });
        T('credit with same id is deduplicated', usdDup.already === true, JSON.stringify(usdDup).slice(0, 120));
        // ⑤ USD 挂账结算：确认到账但绝不往 CNY 推广池补提（推广池收支全是 ¥）
        const ridU = 'e2e_usd_settle_' + Date.now();
        store.push('revenue', { id: ridU, amt: 12, currency: 'USD', source: '订阅-m(USD)', method: 'PayPal', give: null, status: 'awaiting_fund', settled: false, at: Date.now() }, '测试挂账', ridU);
        const su = money.settle(ridU, 'PayPal 到账 $12 截图');
        const k2 = money.kpi();
        T('USD settle ok', su.ok === true && su.settled === true, JSON.stringify(su).slice(0, 120));
        T('USD settle adds no CNY promo', su.promo === 0 && !store.list('promo', 999).some(p => p.kind === '拨款' && p.amt === 0.6),
          'promo=' + su.promo);
        T('USD settle still excluded from CNY KPI revenue', k2.revenue === k0.revenue, k0.revenue + ' -> ' + k2.revenue);
      } else {
        T('payout config present (skipped detail checks)', true, 'no data/payout.json in sandbox');
      }
    } finally {
      const d = store.read();
      d.revenue = bk.revenue;
      d.receivable = bk.receivable;
      d.promo = bk.promo;
      d.orders = bk.orders;
      d.visitors = bk.visitors;
      d.sublist = bk.sublist;
      d.audit = (d.audit || []).slice(0, bk.auditN);
      store.write(d);
    }
  })();
  const r = await Promise.race([run, done]);
  clearTimeout(doneTimer);   // race 一结束就释放，否则进程要干等到超时点才退
  if (r === 'TIMEOUT') { fail++; failures.push('TIMEOUT'); console.log('TIMEOUT'); }
  console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  if (fail) { console.error('FAILED: ' + failures.join(', ')); }
  finish(fail ? 1 : 0);
})();
