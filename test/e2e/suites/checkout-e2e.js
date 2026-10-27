// test/e2e/suites/checkout-e2e.js — 下单通道选择与付款信息交付
//
// 守护的纪律：
//   1. 默认通道绝不能把国内 CNY 买家静默送去 PayPal；CNY 优先走自动到账网关
//      （支付宝 → 微信，付款即开通、零人工），都不可用才回落到人工收款码 manual。
//      【历史】本套件原写死「默认必须是 manual」——那是仅有人工收款码时代的纪律；
//      接入支付宝自动到账后默认变为 alipay，故改为断言「绝不为 paypal + 必须成功交付」，
//      并按 channelStatus() 的就绪情况断言实际选中的通道。
//   2. manual（显式选择：扫码/人工）必须真的交付「付给谁」。此前返回 {orderId, amount}，
//      买家不知道付给谁，配置形同虚设。
//   3. 显式选择 manual 但未配置任何收款码时必须明确报错，且一条银行信息都不给：
//      不能给买家一个付不了的单，更不能泄露运营银行账号（/v1/pay/checkout 是公开端点）。
//   4. 显式指定了未配置的通道要报错，不能静默改道到别的通道
//      （此前「支付宝」会被静默改成 PayPal）。
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const { finish } = require('./_exit');
const store = require(ROOT + '/core/store');
const pay = require(ROOT + '/core/pay');

let pass = 0, fail = 0; const failures = [];
function T(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? ' . ' + detail : '')); }
  else { fail++; failures.push(name); console.log('FAIL ' + name + (detail ? ' . ' + detail : '')); }
}

(async () => {
  let doneTimer;
  const done = new Promise(r => { doneTimer = setTimeout(r, 90000, 'TIMEOUT'); });
  const run = (async () => {
    const bk = {
      a: store.getSetting('receiveAccount'),
      q: store.getSetting('receiveQrAlipay'),
      w: store.getSetting('receiveQrWechat')
    };
    const setAll = (a, q, w) => {
      store.setSetting('receiveAccount', a || '');
      store.setSetting('receiveQrAlipay', q || '');
      store.setSetting('receiveQrWechat', w || '');
    };
    // F1 金额篡改防护使 checkout 只认服务端订单：先建一批真实 pending 单（E1–E5）
    const cur0 = store.read();
    const bkOrders = (cur0.orders || []).slice();
    const mkOrder = (id, amount) => store.push('orders', {
      id, visitor: 'checkout-e2e', plan: 'm', amount, currency: 'CNY',
      months: 1, status: 'pending', paid: false, at: Date.now(), invitedBy: null, trial: false
    }, null, null);
    mkOrder('E1', 60);
    mkOrder('E2', 1280);
    mkOrder('E3', 60);
    mkOrder('E4', 60);
    mkOrder('E5', 60);

    try {
      // ── 1. 默认通道：CNY 优先自动到账网关，绝不静默送去 PayPal ──────
      setAll('acct@test', 'data:image/png;base64,QR', '');
      const d = await pay.checkout({ orderId: 'E1', amount: 60, currency: 'CNY' });
      T('CNY default never silently routes to PayPal', d.channel !== 'paypal', 'channel=' + d.channel);
      T('CNY default checkout succeeds (auto gateway, else manual fallback)', d.ok === true, 'channel=' + d.channel);
      const st1 = pay.channelStatus() || {};
      if (st1.alipayReady) T('CNY default prefers Alipay gateway when ready', d.channel === 'alipay', 'channel=' + d.channel);
      else if (st1.wechatReady) T('CNY default prefers WeChat gateway when Alipay absent', d.channel === 'wechat', 'channel=' + d.channel);
      else T('CNY default falls back to manual when no gateway ready', d.channel === 'manual', 'channel=' + d.channel);

      // ── 2. 显式人工收款码：必须真的交付「付给谁」 ─────────────
      const dm = await pay.checkout({ orderId: 'E1', amount: 60, currency: 'CNY', channel: 'manual' });
      T('manual checkout succeeds', dm.ok === true && dm.channel === 'manual');
      T('manual QR configured -> action.type=qr', dm.action.type === 'qr', 'type=' + dm.action.type);
      T('manual QR delivered to buyer', String(dm.action.qr || '').indexOf('base64,QR') >= 0);
      T('manual returns no bank account to buyer', dm.action.account === '' && dm.action.bank === null, 'account=' + dm.action.account);
      T('manual needProof always true', dm.action.needProof === true);
      T('manual notice carries order id as anchor', String(dm.action.notice).indexOf('E1') >= 0);

      // ── 3. 未配置收款码：绝不泄露运营银行账号（合规/隐私），失败时不留半份指令 ──
      // /v1/pay/checkout 是公开端点。此前这里会回落到 data/payout.json 的银行账户，
      // 等于把运营的个人银行卡号挂在公网上。现改为绝不交付银行信息。
      // 注意：产品内置了兜底收款码图（/pay/alipay.png、/pay/wechat.png，528×528 PNG），
      // 因此「未配置」时通常仍会交付内置收款码——本组守护的红线是「绝不泄露银行信息」，
      // 对「成功交付兜底码」与「诚实失败」两种结果都校验。
      setAll('', '', '');
      const b = await pay.checkout({ orderId: 'E2', amount: 1280, currency: 'CNY', channel: 'manual' });
      const rawB = JSON.stringify(b);
      T('no configured QR never leaks bank info to buyer',
        !/6222031001026162672|廖献云|工商银行|branchCode|institutionCode/.test(rawB), rawB.slice(0, 120));
      if (b.ok === false) {
        T('failed checkout returns no action', b.action === null || b.action === undefined);
        T('error tells operator how to fix it', /pay-config|收款码|PayPal/.test(String(b.error)), String(b.error).slice(0, 60));
      } else {
        T('bundled fallback QR delivered, still no bank info',
          b.channel === 'manual' && !!(b.action && b.action.qr) && b.action.account === '' && b.action.bank === null);
        T('fallback manual still needs proof + carries order anchor',
          b.action.needProof === true && String(b.action.notice).indexOf('E2') >= 0);
      }

      // ── 4. 显式通道不静默改道 ─────────────────────────────
      const al = await pay.checkout({ orderId: 'E3', amount: 60, currency: 'CNY', channel: 'alipay' });
      if (al.ok === false) {
        T('explicit unavailable channel fails loudly', /不可用|未配置|签名/.test(String(al.error)), String(al.error).slice(0, 50));
        T('no silent reroute to paypal', al.channel !== 'paypal', 'channel=' + al.channel);
      } else {
        T('explicit alipay accepted (gateway configured)', al.channel === 'alipay');
      }
      const bogus = await pay.checkout({ orderId: 'E4', amount: 60, currency: 'CNY', channel: 'wechatpay' });
      T('unknown channel never silently rerouted', bogus.channel !== 'paypal', 'channel=' + bogus.channel);

      // ── 5. 显式 manual 可用 ───────────────────────────────
      setAll('acct@test', 'data:image/png;base64,QR', '');
      const m = await pay.checkout({ orderId: 'E5', amount: 60, currency: 'CNY', channel: 'manual' });
      T('explicit manual honoured', m.ok === true && m.channel === 'manual');

      // ── 6. 金额篡改防护：服务端订单为准；未知/已付单拒绝 ──
      const t1 = await pay.checkout({ orderId: 'E1', amount: 0.01, currency: 'JPY', channel: 'manual' });
      T('client amount ignored, server order wins', t1.ok === true && t1.action.amount === 60 && t1.action.currency === 'CNY',
        JSON.stringify({ amount: t1.action.amount, currency: t1.action.currency }));
      const unk = await pay.checkout({ orderId: 'E_NOPE', amount: 60, currency: 'CNY', channel: 'manual' });
      T('unknown order refused', unk.ok === false && /不存在/.test(String(unk.error)), String(unk.error).slice(0, 40));
      store.update('orders', 'E5', { paid: true, status: 'paid' }, 'checkout-e2e 标记已付');
      const re = await pay.checkout({ orderId: 'E5', amount: 60, currency: 'CNY', channel: 'manual' });
      T('paid order refused', re.ok === false && /已支付/.test(String(re.error)), String(re.error).slice(0, 40));
    } finally {
      const d = store.read();
      d.orders = bkOrders;
      store.write(d);
      setAll(bk.a, bk.q, bk.w);
    }
  })();
  const r = await Promise.race([run, done]);
  clearTimeout(doneTimer);   // race 一结束就释放，否则进程要干等到超时点才退
  if (r === 'TIMEOUT') { fail++; failures.push('TIMEOUT'); console.log('TIMEOUT'); }
  console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  if (fail) { console.error('FAILED: ' + failures.join(', ')); }
  finish(fail ? 1 : 0);
})();
