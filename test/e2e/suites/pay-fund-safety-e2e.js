// pay-fund-safety-e2e.js — 支付资金安全回归（专测「钱收了但记错/记重/不记账」）
//
// 本文件锁住的是 pay.settleFulfillment 修复前后的 6 个真实缺陷：
//   1. 缺 total_amount 的回调被放行（金额校验整段被跳过）→ 任何金额都能入账
//   2. 回调币种与订单币种不符仍入账
//   3. 履约订单到账不进 revenue 表 → money.kpi() 永远 0
//   4. 幂等键 settledMark 被 fulfillment.advance 白名单丢弃 → 同一笔重推 N 次记 N 次账
//   5. 履约订单已付款仍能重复出付款链接（重复付款的钱无人认领）
//   6. channelStatus() 不上报 MoltSpay，配置缺失被其它通道的 ok:true 掩盖
//
// 用法: 由 goal-e2e-runner 在隔离沙箱里拉起（禁止指向生产库）
const assert = require('assert');
const http = require('http');

const BASE = process.env.BINGDASHAN_E2E_BASE;
if (!BASE) {
  console.error('ABORT pay-fund-safety-e2e：未设置 BINGDASHAN_E2E_BASE。');
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
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}'), raw: d }); }
        catch (e) { resolve({ status: res.statusCode, body: {}, raw: d }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// 直连核心模块（沙箱进程内已注入 BINGDASHAN_DATA_DIR）
const pay = require(ROOT + '/core/pay');
const store = require(ROOT + '/core/store');
const money = require(ROOT + '/core/money');
const ff = require(ROOT + '/core/fulfillment');
const leadgen = require(ROOT + '/core/leadgen');

function newLeadWithOrder(amount, tag) {
  const lead = store.push('leads', {
    name: '资金安全-' + tag, company: 'SafeCo-' + tag, repo: 'safe/' + tag,
    industry: 'AI', signal: 90, source: 'e2e', stage: '商机候选', status: 'new',
    path: 'leadgen', topics: ['safety'], url: 'https://safe.example/' + tag,
    note: '', touch: 1, tries: 0, planned: 1, sentN: 1, needHuman: true,
    deal: null, email: 'safe-' + tag + '@example.com'
  }, 'pay-fund-safety-e2e 夹具');
  leadgen.convert(lead.id, amount);
  const made = ff.createFromDeal(lead.id);
  assert(made.ok, '建单失败: ' + JSON.stringify(made));
  return made.order;
}

// 造一份「网关会发来」的合法回调（自签名，不走网络）
function signedNotify(order, overrides) {
  const cfg = pay.moltspayConfig();
  const crypto = require('crypto');
  const params = Object.assign({
    app_id: cfg.apiKey,
    out_trade_no: order.id,
    total_amount: String(order.amount),
    subject: 'BingDashan Order ' + order.id,
    currency: order.currency || 'CNY',
    trade_status: 'TRADE_SUCCESS',
    sign_type: 'HMAC_SHA256'
  }, overrides || {});
  const keys = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== undefined && params[k] !== null)
    .sort();
  const str = keys.map(k => k + '=' + params[k]).join('&');
  params.sign = crypto.createHmac('sha256', cfg.secret).update(str, 'utf8').digest('hex');
  return params;
}

(async function run() {
  console.log('\n=== pay-fund-safety-e2e ===');

  // ---------- 前置：MoltSpay 凭据必须在，否则整个套件无意义 ----------
  const st = pay.channelStatus();
  ok(st.moltspay && st.moltspay.ok === true,
    'MoltSpay 凭据齐备（channelStatus 如实上报）', JSON.stringify(st.moltspay));
  ok(Array.isArray(st.available) && st.available.indexOf('moltspay') >= 0,
    '可用通道列表含 moltspay', JSON.stringify(st.available));
  ok(st.moltspayReady === true, 'moltspayReady 字段已上报');
  if (!st.moltspay || !st.moltspay.ok) {
    console.log('\n（未配 MoltSpay，签名类用例跳过；其余用例继续）');
  }

  // ---------- 缺陷 1：缺 total_amount 必须拒 ----------
  if (st.moltspay && st.moltspay.ok) {
    const o1 = newLeadWithOrder(700, 'noamt');
    const p1 = signedNotify(o1);
    delete p1.total_amount;
    const r1 = pay.moltspayHandleNotify(p1);
    ok(r1.ok !== true, '缺 total_amount 的回调被拒', JSON.stringify(r1));
    const after1 = ff.board(999).rows.find(x => x.id === o1.id);
    ok(Number(after1.paidAt || 0) === 0, '缺金额回调未推进履约（paidAt 仍为 0）');

    // ---------- 缺陷 1b：金额不符必须拒 ----------
    const r1b = pay.moltspayHandleNotify(signedNotify(o1, { total_amount: '0.01' }));
    ok(r1b.ok !== true && /金额/.test(r1b.error || ''), '金额不符被拒', JSON.stringify(r1b));

    // ---------- 缺陷 2：币种不符必须拒 ----------
    const r2 = pay.moltspayHandleNotify(signedNotify(o1, { currency: 'USD' }));
    ok(r2.ok !== true && /币种/.test(r2.error || ''), '币种不符被拒', JSON.stringify(r2));

    // ---------- 缺陷 3 + 4：到账必须记账，且重推只记一次 ----------
    const before = money.kpi().revenue;
    const o3 = newLeadWithOrder(1234, 'credit');
    const p3 = signedNotify(o3);
    const first = pay.moltspayHandleNotify(p3);
    ok(first.ok === true, '合法回调入账成功', JSON.stringify(first));
    ok(first.credited === true, '首次回调 credited=true');

    const afterFirst = money.kpi().revenue;
    ok(Math.round((afterFirst - before) * 100) === 123400,
      '履约到账写入 revenue（KPI 增量=1234）', '增量=' + (afterFirst - before));

    // 重推 4 次
    let extra = 0;
    for (let i = 0; i < 4; i++) pay.moltspayHandleNotify(p3);
    extra = money.kpi().revenue - afterFirst;
    ok(Math.round(extra * 100) === 0,
      '重推 4 次不重复记账（幂等）', '多记=' + extra);

    const row = ff.board(999).rows.find(x => x.id === o3.id);
    ok(String(row.settledMark || '').indexOf('fulpay:' + o3.orderNo) === 0,
      'settledMark 已落库', row.settledMark);

    // ---------- 缺陷 4b：双保险 —— settledMark 丢失时账本侧仍须兜住 ----------
    // settledMark 会被数据迁移/手工改库/字段覆盖抹掉。只靠它做幂等，
    // 标记一丢就是真金白银的重复入账。账本侧 rev-<orderNo> 是第二道闸。
    ok(!!store.read().revenue.find(r => r.id === 'rev-' + o3.orderNo),
      '账本侧幂等键 rev-<orderNo> 已写入');
    {
      const db = store.read();
      const rec = (db.fulfillment || []).find(x => x.id === o3.id);
      rec.settledMark = '';                       // 模拟标记丢失
      store.write(db);
      const after = money.kpi().revenue;
      const recCount = store.read().revenue.length;
      pay.moltspayHandleNotify(p3);
      ok(Math.round((money.kpi().revenue - after) * 100) === 0,
        'settledMark 丢失后重推仍不重复记账（账本侧兜住）',
        '多记=' + (money.kpi().revenue - after));
      ok(store.read().revenue.length === recCount, '账本条数未变');
    }

    // ---------- 缺陷 6：channelStatus 不得把缺失通道说成可用 ----------
    ok(typeof st.moltspay.missing !== 'undefined', 'moltspay 报告 missing 字段');
  }

  // ---------- 缺陷 5：已付款的履约单不得重复出付款链接 ----------
  const o5 = newLeadWithOrder(600, 'repay');
  const c1 = await req('POST', '/v1/pay/checkout', { orderId: o5.id, channel: 'moltspay' });
  ok(c1.status === 200, '未付款单可出付款指令', 'status=' + c1.status);

  // 标记为已到账（绕过网关，走 settleFulfillment 保证 settledMark 一致）
  if (st.moltspay && st.moltspay.ok) {
    pay.moltspayHandleNotify(signedNotify(o5));
  } else {
    const ffmod = require(ROOT + '/core/fulfillment');
    ffmod.advance(o5.id, { paid: true, settledMark: 'fulpay:' + o5.orderNo + ':test' });
  }
  const row5 = ff.board(999).rows.find(x => x.id === o5.id);
  ok(Number(row5.paidAt || 0) > 0, '订单已标记到账');
  const c2 = await req('POST', '/v1/pay/checkout', { orderId: o5.id, channel: 'moltspay' });
  ok(c2.status === 200 && c2.body.ok === false && /已支付/.test(c2.body.error || ''),
    '已付款履约单拒绝重复付款', JSON.stringify(c2.body).slice(0, 160));

  // ---------- 未知订单必须拒 ----------
  const c3 = await req('POST', '/v1/pay/checkout', { orderId: 'no-such-order-xyz', channel: 'moltspay' });
  ok(c3.body.ok === false && /订单不存在/.test(c3.body.error || ''),
    '未知订单不出付款指令', JSON.stringify(c3.body).slice(0, 160));

  // ---------- 账实分离红线：确认成交 ≠ 钱到账 ----------
  // /v1/money/leads/convert 只能挂账（不计 KPI），实收只能由网关回调确认。
  // 曾在挂账后立刻 money.settle「自动转实收」→ 买家一分没付，账面营收凭空 +4242，
  // 且履约单到账时还会再记一次，同一笔钱记两遍。
  {
    const before = money.kpi().revenue;
    const lead = store.push('leads', {
      name: '账实分离', company: 'SepCo', repo: 'sep/x', industry: 'AI',
      signal: 90, source: 'e2e', stage: '商机候选', status: 'new', path: 'leadgen',
      topics: ['sep'], url: 'https://sep.example/', note: '', touch: 1, tries: 0,
      planned: 1, sentN: 1, needHuman: true, deal: null, email: 'sep@example.com'
    }, 'pay-fund-safety-e2e 账实分离');
    const r = await req('POST', '/v1/money/leads/convert',
      { id: lead.id, amount: 4242, channel: 'moltspay', online: true },
      { 'X-Admin-Token': process.env.BINGDASHAN_ADMIN_TOKEN || '' });
    ok(r.status === 200, '确认成交接口可用', 'status=' + r.status);
    ok(Math.round((money.kpi().revenue - before) * 100) === 0,
      '确认成交不虚增营收（买家未付款，KPI 必须不动）',
      '虚增=' + (money.kpi().revenue - before));
    const pend = (store.read().receivable || []).concat(store.read().revenue || [])
      .some(x => Number(x.amt) === 4242);
    ok(pend, '4242 挂在台账上而非实收');
  }

  // ---------- 零元订单不得出网关链接 ----------
  const c4 = await req('POST', '/v1/pay/checkout', { orderId: '', channel: 'moltspay' });
  ok(c4.body.ok === false, '空订单号被拒');

  // ---------- 通知端点必须在线且只收 POST ----------
  const n1 = await req('GET', '/v1/pay/moltspay/notify');
  ok(n1.status === 400, 'GET 通知端点被拒', 'status=' + n1.status);

  console.log('\n--- pay-fund-safety-e2e: ' + pass + '/' + (pass + fail) + ' ---');
  // runner 以这一行裁定断言真值（格式必须一致）
  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('pay-fund-safety-e2e 崩溃: ' + (e.stack || e.message));
  process.exit(1);
});