// notify-verify-test.js — 验证 alipayVerify 修复：裸 base64 支付宝公钥能否正确验签
// 用临时密钥对，不碰 .env，不发任何网络请求
const { finish } = require('./_exit');
const crypto = require('crypto');
const ROOT = 'C:/Users/Think/project/BingDashan';
const bare = s => String(s || '').replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');

// 生成临时「支付宝」密钥对，模拟支付宝公钥为裸 base64（与真实 .env 形态一致）
const k = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const alipayPubBare = k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'); // 裸 base64，无 PEM 头

// 另生成一对独立的「应用」密钥（应用私钥与支付宝公钥必然不同源）
const appPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const alipayPriv = appPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

// 注入环境变量（仅本进程生效）
process.env.ALIPAY_PUBLIC_KEY = alipayPubBare;
process.env.ALIPAY_APP_PRIVATE_KEY_RSA2 = alipayPriv;

const pay = require(ROOT + '/core/pay.js');
const alipaySort = o => Object.keys(o).filter(k => o[k] !== '' && o[k] !== undefined && k !== 'sign').sort().map(k => k + '=' + o[k]).join('&');

const params = {
  out_trade_no: 'BD_TEST_ORDER_001',
  trade_no: '2026092622001',
  trade_status: 'TRADE_SUCCESS',
  total_amount: '60.00',
  app_id: '2021006197622702'
};

// 用「支付宝私钥」对参数签名（模拟支付宝回调的真实签名）
const data = alipaySort(params);
const signer = crypto.createSign('RSA-SHA256');
signer.update(data);
const sig = signer.sign(k.privateKey, 'base64');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + '  (期望 ' + expected + '，实际 ' + actual + ')');
}

console.log('=== alipayVerify 裸 base64 公钥验签 ===');
check('合法签名应通过', pay.alipayVerify(Object.assign({}, params, { sign: sig })), true);
check('缺少 sign 应拒绝', pay.alipayVerify(Object.assign({}, params)), false);
check('空 sign 应拒绝', pay.alipayVerify(Object.assign({}, params, { sign: '' })), false);

const tampered = Object.assign({}, params, { sign: sig, total_amount: '9999.00' });
check('篡改金额应拒绝', pay.alipayVerify(tampered), false);

const badSig = Object.assign({}, params, { sign: Buffer.from('not-a-signature').toString('base64') });
check('伪造签名应拒绝', pay.alipayVerify(badSig), false);

console.log('');
console.log('=== alipayHandleNotify 金额/币种核对（签名通过 ≠ 金额对得上）===');
if (process.env.BINGDASHAN_DATA_DIR || process.env.BINGDASHAN_E2E_DATA_DIR) {
  // 沙箱内直接操作 store（runner 每次都给隔离数据目录）；非 runner 运行跳过，
  // 避免默认数据目录被测试单污染。
  const store = require(ROOT + '/core/store');
  const cur = store.read();
  const bk = {
    orders: (cur.orders || []).slice(),
    revenue: (cur.revenue || []).slice(),
    promo: (cur.promo || []).slice(),
    sublist: (cur.sublist || []).slice(),
    visitors: (cur.visitors || []).slice(),
    auditN: (cur.audit || []).length
  };
  const signOf = p => { const s = crypto.createSign('RSA-SHA256'); s.update(alipaySort(p)); return s.sign(k.privateKey, 'base64'); };
  const pushOrd = (id, amount, currency) => store.push('orders', {
    id, visitor: 'notify-verify-f2', plan: 'm', amount, currency, months: 1,
    status: 'pending', paid: false, at: Date.now(), invitedBy: null, trial: false
  }, null, null);
  const oidA = 'NV_CNY_' + Date.now();
  const oidU = 'NV_USD_' + Date.now();
  try {
    pushOrd(oidA, 99, 'CNY');
    const base = { trade_no: 'nv' + Date.now(), trade_status: 'TRADE_SUCCESS', app_id: '2021006197622702' };
    const wrongAmt = Object.assign({}, base, { out_trade_no: oidA, total_amount: '0.01' });
    wrongAmt.sign = signOf(wrongAmt);
    const r1 = pay.alipayHandleNotify(wrongAmt);
    check('金额不符拒绝', r1.ok === false && /金额/.test(r1.error || ''), true);
    const stillPending = (store.list('orders', 999).find(x => x.id === oidA) || {}).paid;
    check('金额不符未入账', stillPending !== true, true);

    pushOrd(oidU, 12, 'USD');
    const usdP = Object.assign({}, base, { out_trade_no: oidU, total_amount: '12.00' });
    usdP.sign = signOf(usdP);
    const r2 = pay.alipayHandleNotify(usdP);
    check('USD 订单拒绝支付宝回调', r2.ok === false && /币种/.test(r2.error || ''), true);

    const goodP = Object.assign({}, base, { out_trade_no: oidA, total_amount: '99.00' });
    goodP.sign = signOf(goodP);
    const r3 = pay.alipayHandleNotify(goodP);
    check('金额一致正常入账', r3.ok === true, true);
    const r4 = pay.alipayHandleNotify(Object.assign({}, goodP, { sign: signOf(goodP) }));
    check('重复回调幂等自愈', r4.ok === true, true);
  } finally {
    const d = store.read();
    d.orders = bk.orders;
    d.revenue = bk.revenue;
    d.promo = bk.promo;
    d.sublist = bk.sublist;
    d.visitors = bk.visitors;
    d.audit = (d.audit || []).slice(0, bk.auditN);
    store.write(d);
  }
} else {
  console.log('  SKIP  F2 核对依赖沙箱数据目录，非 runner 运行跳过');
}

console.log('');
console.log('=== alipaySign/alipayVerify 自洽（应用私钥 -> 支付宝公钥非同源，应拒绝）===');
const appSigned = pay.alipaySign({ app_id: '2021006197622702', method: 'alipay.trade.query' });
check('非同源签名应拒绝', pay.alipayVerify({ app_id: '2021006197622702', method: 'alipay.trade.query', sign: appSigned }), false);

console.log('');
console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
finish(fail ? 1 : 0);
