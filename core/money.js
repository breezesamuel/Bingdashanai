// core/money.js — 营收与经营记账：已到账金额计 KPI 并计提 5% 推广费；仅成交未到账的只挂账。
// 目标锚点：180 天 ¥10,000,000 → 要求日均 ≈ ¥55,556（1.66% 放宽容忍：只做趋势，不做假账）。
// 账实分离红线：账面成交 ≠ 现金到账。KPI 只认 settle() 确认过的实收，未到账进 pending。

const store = require('./store');

const TARGET = 10000000;        // 半年目标 1000 万
const DAYS = 180;               // 半年
const PROMO_RATE = 0.05;        // 每赚 1 元计提 5 分推广费
const SETTLE = '支付宝';        // 入账账户恒定：支付宝
const PACE = TARGET / DAYS;     // 日均计划

// 实收判定：只有已结算的营收才算真金白银。
// 显式 settled 字段优先；缺省时兼容历史 status（paid/settled/received 视为已结算）
function isSettled(r) {
  if (!r) return false;
  // 【退款】退掉的钱不再算「已结算到账」。放在最前面短路：
  // 否则 refunded 记录 settled=true，kpi 里 total 继续累加 —— 账上留着已退营收。
  if (r.refunded === true || r.status === 'refunded') return false;
  if (r.settled === true) return true;
  if (r.settled === false) return false;
  const s = String(r.status || '').toLowerCase();
  return s === 'paid' || s === 'settled' || s === 'received';
}

// 退款：退款的唯一合法记账入口。
// 【为什么必须有】此前全系统没有退款记账能力：tickets.refund 只在工单上打一个
// refundProcessed 标记，revenue 记录原封不动 —— 退完的钱仍计入 KPI 营收，
// 5% 推广费也照提。等于「退款只存在于客服话术里，不存在于账上」。
// 口径：
//   · 必须给退款凭证（与 settle 同红线：没有凭证的退款不入账）
//   · 幂等：同一笔重复退返回 already，不二次回退推广费
//   · 回退推广费：实收时已按 PROMO_RATE 计提，退款必须原路退回，否则推广池被
//     一笔已退的单永久占用（越退池子越空）
//   · 已核销（written_off）的记录不能退：它本来就没进账
function refund(revId, evidence, opt) {
  const ev = String(evidence || '').trim().slice(0, 200);
  if (!ev) return { ok: false, error: '必须提供退款凭证（退款流水号/平台退款单号）才能记账' };
  const rec = store.findBy('revenue', 'id', revId);
  if (!rec) return { ok: false, error: '营收记录不存在：' + revId };
  if (rec.status === 'written_off') return { ok: false, error: '该记录已核销（本就未到账），无需退款记账' };
  if (rec.refunded === true) {
    return { ok: true, already: true, rec, promoReturned: 0, kpi: kpi() };
  }
  // 只有「真的进过账」（settled 或挂账后才结算）才需要退推广费
  const wasSettled = isSettled(rec);
  const at = Date.now();
  const updated = store.update('revenue', revId, {
    status: 'refunded', refunded: true, refundedAt: at, evidence: ev,
    note: '退款：' + String((opt && opt.note) || '').slice(0, 160)
  }, '营收退款记账');

  // 回退推广费：只对 CNY、且当初确实计提过的记录
  let promoReturned = 0;
  if (wasSettled && (rec.currency || 'CNY') === 'CNY') {
    try {
      const db = store.read();
      const promos = db.promo || [];
      // 反向匹配：按营收 id 关联的计提项
      const hit = promos.filter(x => x.revId === revId && x.kind === '拨款' && Number(x.amt) > 0);
      hit.forEach(x => {
        promoReturned += Number(x.amt) || 0;
      });
      if (hit.length) {
        // 追加冲回，保留原计提记录（可审计：这笔钱赚过又退了，痕迹要留）
        if (!db.promo) db.promo = [];
        db.promo.push({
          kind: '冲回', amt: Math.round(promoReturned * 100) / 100,
          note: '退款撤回推广费计提', revId: String(revId), at: Date.now()
        });
        store.write(db);
      }
    } catch (e) {
      store.push('audit', { action: '退款·推广费回退失败', detail: revId + '：' + String(e.message || e) }, null, null);
    }
  }
  store.push('audit', {
    action: '营收退款',
    detail: (rec.amt || 0) + ' ' + (rec.currency || 'CNY') + ' 已退款（凭证 ' + ev.slice(0, 40) + '）'
      + (promoReturned ? '，回退推广费 ¥' + Math.round(promoReturned * 100) / 100 : '')
  }, null, null);
  return { ok: true, rec: updated, promoReturned: Math.round(promoReturned * 100) / 100, kpi: kpi() };
}

// 收入入账：
//   settled=true （默认）—— 钱已到账，计 KPI 并计提 5% 推广费（支付宝/订阅支付成功回调走这里）
//   settled=false          —— 仅「已成交、资金未到账」，只挂账不计 KPI、不提推广费，
//                            等回款凭证到位后由 settle() 转实收
function credit(amt, source, method, opt) {
  const v = Math.round(Number(amt) * 100) / 100;
  if (!(v > 0)) return { ok: false, error: '金额必须>0' };
  const o = opt || {};
  // 幂等键：带 opt.id（订阅单用 'rev-<订单号>'）时先查重。重复确认 / 网关重推的
  // 自愈重入绝不能二次入账——入账是资金动作，宁可挡早也不可记重。
  if (o.id) {
    const dup = store.findBy('revenue', 'id', o.id);
    if (dup) return { ok: true, already: true, rec: dup, settled: !!dup.settled, promo: 0 };
  }
  const settled = o.settled !== false;
  // 账本币种随行记录：KPI/推广池都是 CNY 口径，USD 营收一旦混加进 total 就是
  // 静默少记 7 倍——宁可分列，不可混算（历史行无 currency 视为 CNY，向前兼容）。
  const cur = o.currency === 'USD' ? 'USD' : 'CNY';
  const sym = cur === 'USD' ? '$' : '¥';
  const src = String(source || '订阅').slice(0, 60);
  const mth = String(method || (settled ? SETTLE : '待确认')).slice(0, 20);
  const item = {
    amt: v, currency: cur, source: src, method: mth,
    settle: settled ? SETTLE : '', status: settled ? 'paid' : 'awaiting_fund',
    settled, at: Date.now()
  };
  if (o.id) item.id = String(o.id);
  const rec = store.push('revenue', item, settled ? '营收入账' : '营收挂账',
    settled
      ? ('入账' + SETTLE + ' ' + sym + v + '（' + mth + '）' + src.slice(0, 40))
      : ('挂账未到账 ' + sym + v + '（' + mth + '）' + src.slice(0, 40) + '｜未计入 KPI，待回款凭证后结算'));
  if (!settled) return { ok: true, rec, settled: false, promo: 0 };
  // 外币不入 CNY 推广池：预算池的拨/支全是 ¥，USD 金额不换汇直接计提会污染预算。
  if (cur !== 'CNY') {
    store.push('audit', { action: '外币营收不计提', detail: sym + v + '（' + cur + '）未换汇，不入 CNY 推广池、不计 CNY KPI' }, null, null);
    return { ok: true, rec, settled: true, promo: 0, foreign: true };
  }
  // noPromo：调用方显式豁免计提。用于 ¥1 首月体验这类「不产生可支配预算」的小额单——
  // 否则一笔 ¥1 会往推广台账塞 ¥0.05 的噪声行，污染预算池与审计可读性。
  // 不用「低于 ¥X 不计提」的金额阈值：那会连 ¥99 月卡的 4.95 也一起吃掉。
  if (o.noPromo) {
    store.push('audit', { action: '推广费计提豁免', detail: '¥' + v + '（' + src.slice(0, 30) + '）按小额单豁免' }, null, null);
    return { ok: true, rec, settled: true, promo: 0, promoWaived: true };
  }
  // 自动计提推广费（仅对已到账金额计提——未到账的钱不该撑出可支配预算）
  const promo = Math.round(v * PROMO_RATE * 100) / 100;
  if (promo > 0) {
    store.push('promo', { kind: '拨款', amt: promo, note: '自动拨备 5% 推广费', revId: (o && o.id) ? String(o.id) : undefined, at: Date.now() }, '推广费拨款', '¥' + promo);
    store.push('audit', { action: '5%推广费计提', detail: '¥' + promo + ' → 推广预算池' }, null, null);
  }
  return { ok: true, rec, settled: true, promo };
}

// 应收台账（银行转账等非在线支付通道，如 B 通道工行）：挂账 → 回款凭证 → received
function receivableAll() { return store.list('receivable', 999); }

function receivableSummary() {
  const rows = receivableAll();
  let aw = 0, awN = 0, rv = 0, rvN = 0, wo = 0, woN = 0;
  rows.forEach(r => {
    if (r.status === 'received') { rv += Number(r.amt) || 0; rvN++; }
    else if (r.status === 'written_off') { wo += Number(r.amt) || 0; woN++; }
    else { aw += Number(r.amt) || 0; awN++; }
  });
  const f = n => Math.round(n * 100) / 100;
  return { awaiting: f(aw), awaitingCount: awN, received: f(rv), receivedCount: rvN, writtenOff: f(wo), writtenOffCount: woN };
}

// 结算入账：买家回款凭证到手，才把挂账转实收，并同步应收台账 + 补提 5% 推广费
function settle(revId, evidence, opt) {
  const ev = String(evidence || '').trim().slice(0, 200);
  if (!ev) return { ok: false, error: '必须提供到账凭证（银行流水号/截图说明）才能结算' };
  const rec = store.findBy('revenue', 'id', revId);
  if (!rec) return { ok: false, error: '营收记录不存在：' + revId };
  if (isSettled(rec)) return { ok: true, already: true, rec, promo: 0, receivable: receivableSummary() };
  // 币种随行：推广池收支全是 ¥，USD 不换汇直接按汇率数字计提会污染 CNY 预算。
  const cur = (rec.currency || 'CNY') === 'USD' ? 'USD' : 'CNY';
  const sym = cur === 'USD' ? '$' : '¥';
  const o = opt || {};
  const at = Date.now();
  const updated = store.update('revenue', revId, {
    status: 'paid', settled: true, settledAt: at, evidence: ev,
    method: String(o.method || rec.method || '待确认').slice(0, 20),
    settle: SETTLE
  }, '营收结算到账');
  // 补提推广费（钱这会儿才真的进来）——只对 CNY 计提
  let promo = 0;
  if (cur === 'CNY') promo = Math.round((Number(rec.amt) || 0) * PROMO_RATE * 100) / 100;
  if (promo > 0) {
    store.push('promo', { kind: '拨款', amt: promo, note: '结算补提 5% 推广费', revId: String(revId), at: Date.now() }, '推广费拨款', '¥' + promo + '（' + revId + ' 结算补提）');
  }
  // 同步应收台账
  receivableAll().filter(r => r.revId === revId).forEach(r => {
    store.update('receivable', r.id, { status: 'received', evidence: ev, receivedAt: at }, '应收确认到账');
  });
  store.push('audit', { action: '营收结算', detail: revId + ' ' + sym + rec.amt + ' 到账，凭证：' + ev.slice(0, 80) + (cur === 'CNY' ? '；补提推广费 ¥' + promo : '；外币不计提 CNY 推广费'), at: Date.now() }, null, null);
  // 【物理通知】真实（非自测）到账 → 可选 WLED 灯闪；失败静默，绝不影响结算结果
  try {
    const _obyId = new Map((store.read().orders || []).map(x => [String(x.id), x]));
    if (!isSelfTest(updated, _obyId)) {
      require('./wled').celebrateRealDeal({ amount: rec.amt, currency: cur, kind: 'payment' }).catch(() => {});
    }
  } catch (e) {}
  return { ok: true, rec: updated, promo, settled: true, receivable: receivableSummary() };
}

// 核销：确认这笔钱收不回来了（客户放弃、失联、纠纷、交易取消等）
//
// 与 settle 严格对立的设计约束：
//   1. 绝不动 settled/status 里的 paid/settled/received 语义 —— 核销后仍是 isSettled()===false，
//      永远不计入 KPI、营收、推广费。这正是核销与收款的分界。
//   2. 必须给 reason，且 reason 会进审计 —— 不能无声无息地抹掉一笔应收。
//   3. 不补提推广费：钱没进来，没有任何可计提基数。
//   4. 应收台账同步置为 written_off，与 received 明确区分。
//   5. 已结算的记录不允许核销（钱已到手再谈核销是自相矛盾）。
const WRITEOFF_REASONS = ['客户放弃', '客户失联', '交易取消', '纠纷不予支付', '重复记录', '其他（需说明）'];
function writeoff(revId, reason, note) {
  const rs = String(reason || '').trim();
  if (!rs) return { ok: false, error: '必须提供核销原因', allowed: WRITEOFF_REASONS };
  const rec = store.findBy('revenue', 'id', revId);
  if (!rec) return { ok: false, error: '营收记录不存在：' + revId };
  if (isSettled(rec)) return { ok: false, error: '该记录已结算到账，不能核销（要改请先核对回单）' };
  if (rec.status === 'written_off') return { ok: true, already: true, rec };
  const at = Date.now();
  const detail = String(note || '').trim().slice(0, 200);
  const updated = store.update('revenue', revId, {
    status: 'written_off', settled: false, writtenOffAt: at,
    writeoffReason: rs, writeoffNote: detail
  }, '营收核销（未到账，确认收不回）');
  let n = 0;
  receivableAll().filter(r => r.revId === revId).forEach(r => {
    store.update('receivable', r.id, { status: 'written_off', writtenOffAt: at, writeoffReason: rs }, '应收核销');
    n++;
  });
  store.push('audit', {
    action: '营收核销',
    detail: revId + ' ' + ((rec.currency || 'CNY') === 'USD' ? '$' : '¥') + rec.amt + ' 核销：' + rs + (detail ? '（' + detail + '）' : '') + '；未计入 KPI/营收/推广费',
    at
  }, null, null);
  return { ok: true, rec: updated, writtenOff: true, receivableRows: n, receivable: receivableSummary(), kpi: kpi() };
}

// 核销台账：所有被抹掉的应收，可翻查
function writeoffAll() {
  return store.list('revenue').filter(r => r.status === 'written_off')
    .map(r => ({ id: r.id, amt: r.amt, reason: r.writeoffReason, note: r.writeoffNote, at: r.writtenOffAt }));
}

// 推广费支出（可自主支配，须留痕）
// 推广费支出：真实花钱的入口。opt.channel 用于渠道归因（让 ROI 看板按真实支出而非编造成本计算）。
function spend(amt, note, opt) {
  const v = Math.round(Number(amt) * 100) / 100;
  if (!(v > 0)) return { ok: false, error: '金额必须>0' };
  const b = budget();
  if (v > b.avail) return { ok: false, error: '推广预算不足：可用 ¥' + b.avail.toFixed(2) + '，欲支 ¥' + v.toFixed(2) };
  const channel = String((opt && opt.channel) || '').trim().slice(0, 40);
  const rec = store.push('promo', { kind: '支出', amt: v, note: String(note || '投放').slice(0, 120), channel: channel || undefined, at: Date.now() }, '推广费支出', '¥' + v + ' ' + String(note || '').slice(0, 40));
  return { ok: true, rec };
}

// 推广预算池 → {拨备, 支出, 可用}
function budget() {
  const rows = store.list('promo', 999).filter(r => r.synthetic !== true);
  let in_ = 0, out = 0;
  rows.forEach(r => {
    if (r.kind === '拨款') in_ += r.amt;
    else if (r.kind === '支出') out += r.amt;
    // 冲回：退款时撤回当初的 5% 计提，记为负额拨款。
    // 必须落在 in_ 里（而不是删原记录）——删记录会让累计拨款变小、
    // 可用额不升反降，与退款语义完全相反。
    else if (r.kind === '冲回') in_ -= r.amt;
  });
  // 可用余额不能为负：负数来自"冲回"记录（某笔营收未到账、撤回其 5% 计提）。
  // 冲回会让 in_ 变负进而算出负可用——语义错误（预算池不存在"倒欠"）。
  // 这里夹到 0，并如实暴露 raw 供审计；不掩盖，冲回本身仍保留在 promo 台账里。
  const raw = Math.round((in_ - out) * 100) / 100;
  return {
    allotted: Math.round(in_ * 100) / 100,
    spent: Math.round(out * 100) / 100,
    avail: Math.max(0, raw),
    rawAvail: raw, // <0 说明存在冲回导致账实为负，UI/审计可见
    reversed: raw < 0
  };
}

// KPI 仪表：半年千万的实际/计划斜率（只统计已结算实收）
// 口径统一：优先以核心目标（goals.primary）为准绳；未启用多目标前回落到历史常量（半年前向兼容）
// —— 自测单识别（诚实口径·2026-10）——
// 运营在开发/联调时会在本机下单并自行「确认到账」，产生 settled 记录；这些钱从未真实到账。
// 混入 KPI「已入账」等于把测试当成营收，会让 KPI / pace / goalpilot 晨报全部按假账计算（实测污染 ¥201）。
// 只在有明确证据时判定为自测（宁可漏判、绝不误判真实营收），依据：
//   ① 收入来源自带 test（例：source='test-123'）
//   ② 对应订单的访客键是本机回环（真实买家不可能来自 127.0.0.1）或名字里带 test
// 注意访客键里的 IP 会被安全化：点号替换成下划线（ip:127_0_0_1:xxx），正则两种都要吃。
const LOOPBACK_VISITOR = /^ip:(?:127[._]0[._]0[._]1|::1|0_0_0_0_0_0_0_1)[:_]/i;
function isSelfTest(r, orderById) {
  // 显式标记优先：运营/清理脚本可给记录打 selfTest|synthetic，直接排除，不再揣测来源。
  if (r && (r.selfTest === true || r.synthetic === true)) return true;
  if (/test/i.test(String(r.source || ''))) return true;
  const oid = String(r.id || '').replace(/^rev-/, '');
  const o = oid && orderById ? orderById.get(oid) : null;
  if (!o) return false;
  const vis = String(o.visitor || '');
  return LOOPBACK_VISITOR.test(vis) || /test/i.test(vis);
}

function kpi() {
  // 延时加载避免顶层循环依赖（money ↔ goals：都读 store）
  let GP = null; try { GP = require('./goals'); } catch (e) {}
  const g = GP && GP.primary ? GP.primary() : null;
  const isCurrencyGoal = g && ['CNY','RMB','¥','元'].some(u => String(g.unit||'').includes(u));
  const TARGET_G = isCurrencyGoal && Number(g.target) > 0 ? Number(g.target) : TARGET;
  const DAYS_G = GP && GP.periodDaysOf ? GP.periodDaysOf(g && g.period) : DAYS;
  const SETTLE_G = g && String(g.unit || SETTLE) === 'CNY' ? SETTLE : (g && g.unit) || SETTLE;
  const startedEff = GP && GP.pace ? (() => {
    const db = require('./store').read();
    return Number((g && g.startedAt) > 0 ? g.startedAt : (db.settings && db.settings.goalStartedAt)) || Date.now();
  })() : (store.getSetting('kpiStart') || Date.now());
  const targetStart = startedEff;
  const daysPast = Math.max(0, (Date.now() - targetStart) / 86400000);
  const daysLeft = Math.max(0, DAYS_G - daysPast);
  let total = 0, pending = 0, pendingCount = 0, writtenOff = 0, writtenOffCount = 0;
  let testTotal = 0, testCount = 0;       // 自测入账：不是真钱，不进 KPI 分子（见 isSelfTest）
  let refunded = 0, refundedCount = 0;   // 已退款：不计实收，也不计待回款（钱已退出账本）
  // 外币营收分列：CNY 目标（半年千万）的分子绝不混入未换汇的 USD。
  const foreign = {};
  let foreignPending = 0, foreignPendingCount = 0;
  // 【2026-10-21 全量】① 订单索引要全量：窗口外的订单查不到 → 回环/测试收入会被误判成真钱（虚拟钱进营收）
  // ② 收入也要全量：只看最近 999 笔会让**总营收少算**（钱少了但报表不说）。
  const orderById = new Map(store.list('orders').map(o => [String(o.id), o]));
  store.list('revenue').forEach(r => {
    if (!r.amt) return;
    if (r.currency && r.currency !== 'CNY') {
      if (isSettled(r)) foreign[r.currency] = Math.round(((foreign[r.currency] || 0) + Number(r.amt)) * 100) / 100;
      else if (r.refunded === true || r.status === 'refunded') { refunded += Number(r.amt); refundedCount++; }
      else if (r.status !== 'written_off') { foreignPending += Number(r.amt); foreignPendingCount++; }
      return;
    }
    if (isSettled(r)) {
      if (isSelfTest(r, orderById)) { testTotal += r.amt; testCount++; }
      else { total += r.amt; }
      return;
    }
    // 退款：这笔钱已经退出账本，既不是实收也不是待回款。
    // 漏掉这一分支会让退款凭空变成「挂账」——营收归零的同时挂账多出同额。
    if (r.refunded === true || r.status === 'refunded') { refunded += r.amt; refundedCount++; return; }
    if (r.status === 'written_off') { writtenOff += r.amt; writtenOffCount++; return; }
    pending += r.amt; pendingCount++;
  });
  const regDaily = daysPast ? total / daysPast : 0;
  const pacePlan = DAYS_G > 0 ? TARGET_G / DAYS_G : PACE;
  const needDaily = daysLeft > 0 ? Math.max(0, (TARGET_G - total) / daysLeft) : Math.max(0, TARGET_G - total);
  const onTrack = regDaily >= pacePlan;
  const pct = Math.min(100, Math.round(total / TARGET_G * 1000) / 10);
  const date = new Date(targetStart + DAYS_G * 86400000).toLocaleDateString('zh-CN');
  return {
    target: TARGET_G, days: DAYS_G, pacePlan: Math.round(pacePlan * 100) / 100, daysPast: Math.floor(daysPast), daysLeft: Math.floor(daysLeft),
    revenue: Math.round(total * 100) / 100, regDaily: Math.round(regDaily), needDaily: Math.round(needDaily),
    // 诚实分列：revenue=真实到账（目标进度分子）；grossRevenue=台账全额；自测单列不混入进度
    grossRevenue: Math.round((total + testTotal) * 100) / 100,
    testRevenue: Math.round(testTotal * 100) / 100, testCount,
    onTrack, pct, inboundDate: date, settle: SETTLE_G,
    pending: Math.round(pending * 100) / 100, pendingCount,
    writtenOff: Math.round(writtenOff * 100) / 100, writtenOffCount,
    refunded: Math.round(refunded * 100) / 100, refundedCount,
    foreign, foreignPending: Math.round(foreignPending * 100) / 100, foreignPendingCount,
    receivable: receivableSummary(),
    promo: budget(), orders: store.list('orders', 0).length,
    history: store.list('revenue', 30)
  };
}

function revenueAll() { return store.list('revenue'); }
function promoAll() { return store.list('promo', 999); }

// 近 12 个月已结算实收（阶梯抽成的分母）。
// 口径与 KPI 的 revenue 对齐：只算已到账（isSettled），不含挂账与已核销，
// 否则"抽成"会按收不到的钱计提——那等于凭空放大平台收入。
// 用滚动 365 天而非自然年：跨年切换时不会突然从低档跳到高档。
function annualSettled() {
  const since = Date.now() - 365 * 86400000;
  const rows = store.list('revenue').filter(r => {
    if (!(Number(r.amt) > 0) || !isSettled(r)) return false;
    // 抽成分母是 CNY 口径：外币未换汇不并入（与 kpi() 同一条不混算原则）
    if (r.currency && r.currency !== 'CNY') return false;
    const at = Number(r.settledAt || r.at || 0);
    return at >= since;
  });
  const total = rows.reduce((s, r) => s + Number(r.amt), 0);
  return { total: Math.round(total * 100) / 100, count: rows.length, windowDays: 365 };
}

module.exports = { credit, settle, refund, spend, budget, kpi, revenueAll, promoAll, receivableAll, receivableSummary, isSettled, isSelfTest, writeoff, writeoffAll, annualSettled, WRITEOFF_REASONS, TARGET, DAYS, PROMO_RATE, PACE, SETTLE };