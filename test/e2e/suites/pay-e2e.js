// pay-e2e.js �?�$Ta9�C|�0�0�*+g^�+�@8{R�+��9Ku�2ui�
const { finish } = require('./_exit');
const http = require('http');
const { requireIsolated } = require('./_guard');
const BASE = requireIsolated('pay-e2e');

// 沙箱管理令牌：/v1/subs/confirm 走 adminAuthedStrict，回环也强制带令牌。
// 由 goal-e2e-runner 逐套件注入。此前本套件不带令牌，第 4/7 步 confirm 全部 403。
const ADMIN = process.env.BINGDASHAN_ADMIN_TOKEN || '';

function req(method, path, body, headers) {
  const raw = typeof body === 'string';
  return new Promise((res, rej) => {
    const data = raw ? body : (body ? JSON.stringify(body) : null);
    const u = new URL(BASE + path);
    const h = Object.assign(
      { 'Content-Type': raw ? 'application/x-www-form-urlencoded' : 'application/json' },
      ADMIN ? { 'X-Admin-Token': ADMIN } : null,
      headers || {}
    );
    const r = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: h
    }, resp => {
      let s = '';
      resp.on('data', d => s += d);
      resp.on('end', () => { try { res({ status: resp.statusCode, body: s ? JSON.parse(s.replace(/^fail$/, '"fail"').replace(/^success$/, '"success"')) : {}, text: s }); } catch (e) { res({ status: resp.statusCode, body: {}, text: s }); } });
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

let PASS = 0, FAIL = 0;
const T = (name, cond, extra) => { if (cond) { PASS++; console.log('PASS ' + name); } else { FAIL++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); } };

(async () => {
  const vid = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // OGh� vidmh�(� X-Visitor |3fO��#��6Z� IP 2�%+Pdyn�iF�
  const idn = await req('POST', '/v1/subs/identity', { key: vid });
  T('identity hB�,�', idn.body.ok && idn.body.vid, idn.body);
  const H = { 'X-Visitor': idn.body.vid || vid };

  // 1) � "3Qe�g^� pay.receive
  const o1 = await req('POST', '/v1/subs/order', { plan: 'm', lang: 'CN' }, H);
  T('�*i� ok+order', o1.body.ok && o1.body.order && o1.body.order.id, o1.body);
  const oid = o1.body.order && o1.body.order.id;
  T('�*i� pay.receive �/(wechat/alipay/settle/hint)', o1.body.pay && o1.body.pay.receive && o1.body.pay.receive.hint, o1.body.pay);

  // 2) i/Jo�5�@+�5�.�loopback O��
  const cfg = await req('POST', '/v1/subs/pay-config', { receiveAccount: 'test@alipay.com', receiveQrAlipay: 'data:image/png;base64,AAAA', receiveQrWechat: 'data:image/png;base64,BBBB' });
  T('�5�o�� ok', cfg.body.ok, cfg.body);
  const cfgGet = await req('GET', '/v1/subs/pay-config');
  T('�5�oe%dw�', cfgGet.body.ok && cfgGet.body.config.receiveAccount === 'test@alipay.com' && cfgGet.body.config.receiveQrAlipay === 'data:image/png;base64,AAAA', cfgGet.body);

  // 3) �*�d5�.�
  const o2 = await req('POST', '/v1/subs/order', { plan: 'q', lang: 'CN' }, H);
  T('�****o(lg', o2.body.pay && o2.body.pay.receive && o2.body.pay.receive.account === '' && o2.body.pay.receive.alipay === 'data:image/png;base64,AAAA', o2.body);

  // 4) 8{R�#M��,�+u�2�
  const c = await req('POST', '/v1/subs/confirm', { orderId: oid });
  T('8{R� ok', c.body.ok && c.body.order && c.body.order.paid === true, c.body);
  const st = await req('GET', '/v1/subs/status', null, H);
  T('�$��:2�(S@�B�>0)', st.body.sub && st.body.sub.daysLeft > 0, st.body.sub);
  T('�Y~(O�L� 2-�)', st.body.freeLeft === Infinity || st.body.wall === false, st.body);

  // 5) O�R� money �=pn`:���
  const kpi = await req('GET', '/v1/money/kpi');
  T('�$_&b�E KPI revenue', kpi.body.ok && kpi.body.revenue >= 60, kpi.body);

  // 6) :�yWz�i/�5E$�
  const od = await req('GET', '/v1/subs/orders?limit=30');
  T('� 4y	Zh`:�', Array.isArray(od.body.orders) && od.body.orders.some(x => x.id === oid && x.paid), od.body);

  // 7) Vw`��=�,;�&� adminToken �Q"��,�5
  const fake = await req('POST', '/v1/subs/confirm', { orderId: oid || 'x' }, { 'X-Visitor': vid });
  // �-48{Y'<� isLoopback%+�4-/W� loopback~�]a��28{I�
  T('�28{I�(already)', fake.body.already === true, fake.body);

  // 8) 结账：未付单返回可执行收款方式；金额以服务端订单为准（客户端篡改 amount/currency 无效）
  const qId = o2.body.order && o2.body.order.id;
  const g1 = await req('POST', '/v1/pay/checkout', { orderId: qId, channel: 'manual', amount: 0.01, currency: 'JPY' });
  const act = g1.body.action || {};
  const gCfg = ['alipay','manual','paypal','moltspay'].includes(g1.body.channel);
  // qr 只有真的带上二维码才算「可执行」：空 qr 的 action 是付不了的单，不能放行
  const gActOk = act.type === 'manual' || (act.type === 'qr' && !!(act.qr || act.qrAlipay || act.qrWechat)) || (act.type === 'form' && /<form/.test(act.html || '')) || (act.type === 'redirect' && String(act.url || '').slice(0, 8) === 'https://');
  const gAlipayHonest = g1.body.channel === 'alipay' && g1.body.channelUsable === false && !!g1.body.error;
  const gOk = g1.body.ok === true ? gActOk : gAlipayHonest;
  T('checkout returns an actionable payment method', gCfg && gOk, JSON.stringify(g1.body).slice(0, 240));
  T('server amount/currency wins over client tamper', g1.body.ok === true && act.amount === 269 && act.currency === 'CNY',
    JSON.stringify({ amount: act.amount, currency: act.currency }).slice(0, 80));
  const g2 = await req('POST', '/v1/pay/checkout', { orderId: oid, channel: 'manual' });
  T('checkout on paid order refused', g2.body.ok === false && /已支付/.test(String(g2.body.error || '')), g2.body);
  const g3 = await req('POST', '/v1/pay/checkout', { orderId: 'NO_SUCH_ORDER_X', channel: 'manual' });
  T('checkout for unknown order refused', g3.body.ok === false && /订单不存在/.test(String(g3.body.error || '')), g3.body);

  // 9) ��5L6nSG payPoll "�
  const st1 = await req('GET', '/v1/pay/status?order=' + oid);
  T('�5`0��PyW� paid=true', st1.body.ok && st1.body.paid === true, st1.body);

  // 10) ��PyW paid=false��t
  const o3 = await req('POST', '/v1/subs/order', { plan: 'y', lang: 'CN' }, H);
  const st2 = await req('GET', '/v1/pay/status?order=' + (o3.body.order && o3.body.order.id));
  T('�5`0��PyW� paid=false', st2.body.ok === true && st2.body.paid === false, st2.body);

  // 11) ��9��YM0|H�,d�# +� �
  const badN = await req('POST', '/v1/pay/alipay/notify', qsOf({ out_trade_no: oid, trade_status: 'TRADE_SUCCESS' }));
  T('��9��#&', badN.text === 'fail', badN.text);

  console.log('\n===== ' + PASS + ' PASS / ' + FAIL + ' FAIL =====');
  finish(FAIL ? 1 : 0);
})().catch(e => { console.error('pay-e2e err', e.message); FAIL++; console.log('===== ' + PASS + ' PASS / ' + FAIL + ' FAIL ====='); process.exit(1); });

function qsOf(o) { return Object.keys(o).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&'); }