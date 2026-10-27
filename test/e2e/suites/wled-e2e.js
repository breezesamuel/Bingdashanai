// test/e2e/suites/wled-e2e.js — WLED 物理通知桥
//
// 诚实边界（务必先读）：
//   本机没有真实 WLED 硬件，也没有真实买家。这里用一个「模拟设备」——实现 WLED 官方
//   文档里的 GET /json/info 与 POST /json/state —— 来验证"桥"本身接得对。
//   这**不**证明我们卖出了任何东西，也**不**证明有收入。灯亮不是钱。
//
// 守护的纪律：
//   1. 桥只能访问「配置里明确指定的主机」；未配置就如实说"未配置"，不瞎连。
//   2. 设备不可达 → {ok:false,error}，HTTP 仍 200，绝不抛异常、绝不阻断经营主流程。
//   3. 只有「真实」事件才触发：金额<=0、自测单(selfTest) 一律不亮灯。
//   4. 灯亮**绝不**制造收入：点完灯，/v1/money/kpi 的 revenue 必须仍是 0。
//   5. 运营级鉴权：公网访客（代理头）拿不到。
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const { requireIsolated } = require('./_guard');
const http = require('http');
const store = require(ROOT + '/core/store');
const wled = require(ROOT + '/core/wled');
const BASE = requireIsolated('wled-e2e');
const ADMIN = process.env.BINGDASHAN_ADMIN_TOKEN || '';

let pass = 0, fail = 0;
function T(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? ' . ' + detail : '')); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' . ' + detail : '')); }
}
function req(method, p, body, extra) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (ADMIN) h['X-Admin-Token'] = ADMIN;
    Object.assign(h, extra || {});
    const r = http.request(BASE + p, { method, headers: h }, resp => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => { try { res({ code: resp.statusCode, body: JSON.parse(d) }); } catch (e) { res({ code: resp.statusCode, body: { raw: d } }); } });
    });
    r.end(data || undefined);
  });
}

// —— 模拟 WLED 设备：严格实现官方 JSON API 的两个端点 ——
function startMock() {
  const hits = [];
  const srv = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', c => b += c);
    rq.on('end', () => {
      let parsed = null; try { parsed = b ? JSON.parse(b) : null; } catch (e) {}
      hits.push({ method: rq.method, url: rq.url, body: parsed });
      const url = String(rq.url || '');
      if (url.indexOf('/json/info') === 0) {
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        return rs.end(JSON.stringify({ ver: '0.15.0-mock', name: 'MOCK-LED', leds: { count: 60 }, arch: 'esp32', mac: 'AA:BB:CC:DD:EE:FF' }));
      }
      if (url.indexOf('/json/state') === 0) {
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        return rs.end(JSON.stringify({ success: true }));
      }
      rs.writeHead(404, { 'Content-Type': 'application/json' });
      rs.end('{}');
    });
  });
  return new Promise(r => {
    srv.listen(0, '127.0.0.1', () => r({ srv, hits, port: srv.address().port }));
  });
}

(async () => {
  const mock = await startMock();
  const MPORT = mock.port;
  const stateHits = () => mock.hits.filter(h => String(h.url).indexOf('/json/state') === 0);

  // 基线快照（放在任何点灯动作之前）。
  // 【为什么不能写 "revenue 必须等于 0"】整轮回归共用同一个沙箱，跑在本套件前面的
  // settle / checkout / money / refund 等会合法地往里写真实记录。写死 0 等于让
  // 本套件的结论依赖"跑测顺序"——那不是纪律，是脆。要证明的是：
  // **点灯前后，钱和客户一个都没变**，而不是沙箱必须是空的。
  const kpiBase = (await req('GET', '/v1/money/kpi')).body;
  const custBase = (store.list('customers', 999) || []).length;

  // 0) 默认未配置：必须诚实说"未配置"，而不是乱连
  const d0 = (await req('GET', '/v1/wled/config')).body;
  T('配置端点可用且带 API 说明', d0.ok === true && d0.api && d0.api.state === 'POST /json/state', JSON.stringify(d0.api || {}));
  T('未硬编码设备地址（默认 host 为空）', String(d0.baseUrl || '') === '', 'baseUrl=' + d0.baseUrl);
  T('默认未启用（绝不默认往外发）', d0.config && d0.config.enabled === false);
  const n0 = (await req('POST', '/v1/wled/notify', { kind: 'deal' })).body;
  T('未配置时 notify 如实失败而非假装成功', n0.ok === false && !!n0.error, JSON.stringify(n0).slice(0, 120));
  T('未配置时设备零连接（不瞎连）', mock.hits.length === 0, 'hits=' + mock.hits.length);

  // 1) 配置指向模拟设备
  const cfg1 = (await req('POST', '/v1/wled/config', { enabled: true, host: '127.0.0.1', port: MPORT, brightness: 255 })).body;
  T('配置保存并回读 host/port', cfg1.ok === true && cfg1.saved && cfg1.saved.host === '127.0.0.1' && cfg1.saved.port === MPORT,
    JSON.stringify(cfg1.saved || {}));
  T('baseUrl 拼成 http://127.0.0.1:port', cfg1.baseUrl === 'http://127.0.0.1:' + MPORT, cfg1.baseUrl);
  T('回读的 config 就是刚保存的那份（不是旧值）',
    cfg1.config && cfg1.config.enabled === true && cfg1.config.host === '127.0.0.1' && cfg1.config.port === MPORT,
    JSON.stringify(cfg1.config || {}));

  // 2) 连接测试：能拿到 ver/name 才算真的通了
  const info = (await req('POST', '/v1/wled/test')).body;
  T('连接测试拿到模拟设备版本', info.ok === true && info.version === '0.15.0-mock' && info.name === 'MOCK-LED',
    JSON.stringify({ ok: info.ok, ver: info.version, name: info.name }).slice(0, 140));
  T('连接测试命中 GET /json/info', mock.hits.some(h => h.method === 'GET' && String(h.url).indexOf('/json/info') === 0));

  // 2b) 模块级直连（同一份设置）
  const mi = await wled.info();
  T('模块级 info 直达模拟设备', mi.ok === true && mi.version === '0.15.0-mock', JSON.stringify(mi).slice(0, 140));

  // 3) 真实成交 → 灯闪：负载必须是 WLED 官方 state 结构
  const before = stateHits().length;
  const nd = (await req('POST', '/v1/wled/notify', { kind: 'deal' })).body;
  T('notify deal 成功', nd.ok === true, JSON.stringify(nd).slice(0, 160));
  T('notify 产出一条 POST /json/state', stateHits().length === before + 1);
  const st = (stateHits().slice(-1)[0] || {}).body || {};
  T('state 含 on:true', st.on === true, JSON.stringify(st).slice(0, 160));
  T('state 含 seg[].col[0] 为 RGB 三元组', Array.isArray(st.seg) && Array.isArray(st.seg[0].col) && Array.isArray(st.seg[0].col[0])
    && st.seg[0].col[0].length === 3, JSON.stringify((st.seg || [null])[0]));
  T('成交=绿色 [0,255,80]', st.seg[0].col[0][0] === 0 && st.seg[0].col[0][1] === 255 && st.seg[0].col[0][2] === 80,
    JSON.stringify(st.seg[0].col[0]));
  T('state 带 transition（淡入不刺眼）', typeof st.transition === 'number' && st.transition > 0, 't=' + st.transition);

  // 4) 真实到账 → 另一种颜色（与"成交"可区分）
  const np = (await req('POST', '/v1/wled/notify', { kind: 'payment' })).body;
  const stP = (stateHits().slice(-1)[0] || {}).body || {};
  T('notify payment 成功且颜色不同', np.ok === true && stP.seg[0].col[0][0] === 255 && stP.seg[0].col[0][2] === 0,
    JSON.stringify(stP.seg[0].col[0]));

  // 5) 未知 kind 不崩，落到安全预设
  const nu = (await req('POST', '/v1/wled/notify', { kind: '不存在的预设' })).body;
  T('未知 kind 不报错（落安全预设）', nu.ok === true, JSON.stringify(nu).slice(0, 120));

  // 成功次数到此封存：接下来三种"不该亮"的场景，一条都不许多
  const frozenStates = stateHits().length;

  // 6) 关掉开关 → 如实失败，且**一次都不再摸设备**
  const dis = (await req('POST', '/v1/wled/config', { enabled: false })).body;
  T('开关可被关掉', dis.ok === true && dis.saved && dis.saved.enabled === false, JSON.stringify(dis.saved || {}));
  const off = (await req('POST', '/v1/wled/notify', { kind: 'deal' })).body;
  T('已禁用时 notify 如实说明未启用', off.ok === false && /未启用/.test(off.error || ''), JSON.stringify(off).slice(0, 120));

  // 7) 设备不可达 → ok:false + 错误说明，HTTP 仍 200（绝不抛、绝不阻断）
  await req('POST', '/v1/wled/config', { enabled: true, host: '127.0.0.1', port: 1 });
  const dead = (await req('POST', '/v1/wled/test')).body;
  T('设备不可达时 test 如实失败', dead.ok === false && !!dead.error, JSON.stringify(dead).slice(0, 140));
  const deadN = (await req('POST', '/v1/wled/notify', { kind: 'deal' })).body;
  T('设备不可达时 notify 同样如实失败', deadN.ok === false && !!deadN.error, JSON.stringify(deadN).slice(0, 140));
  T('失败不冒充成功（没有假的 success）', dead.ack !== true && deadN.ack !== true);

  // 连不上的设备：既不能假装成功，也不能记一条假 state
  T('设备不可达时连一条假 state 都不记', stateHits().length === frozenStates,
    'stateHits=' + stateHits().length + ' frozen=' + frozenStates);

  // 8) 关回模拟设备，验证「只有真实事件才亮灯」的三条门
  await req('POST', '/v1/wled/config', { enabled: true, host: '127.0.0.1', port: MPORT, brightness: 255 });
  const gate0 = await wled.celebrateRealDeal({ amount: 0, kind: 'deal' });
  T('金额 0 不亮灯（不拿空单制造仪式感）', gate0.ok === false && !!gate0.skipped, JSON.stringify(gate0).slice(0, 120));
  const gateNeg = await wled.celebrateRealDeal({ amount: -50, kind: 'deal' });
  T('负金额不亮灯', gateNeg.ok === false && !!gateNeg.skipped, JSON.stringify(gateNeg).slice(0, 120));
  const gateSelf = await wled.celebrateRealDeal({ amount: 888, kind: 'deal', selfTest: true });
  T('自测单不亮灯（自测不配庆祝）', gateSelf.ok === false && gateSelf.skipped === 'self-test', JSON.stringify(gateSelf).slice(0, 120));
  const shBefore = stateHits().length;
  const gateReal = await wled.celebrateRealDeal({ amount: 300, currency: 'CNY', kind: 'deal' });
  T('真实成交（金额>0 且非自测）才亮灯', gateReal.ok === true && gateReal.amount === 300, JSON.stringify(gateReal).slice(0, 140));
  T('真实成交触发一次 POST /json/state', stateHits().length === shBefore + 1);

  // 9) 【关键诚实门】灯亮绝不等于有钱：营收/客户必须分毫未变
  const kpi = (await req('GET', '/v1/money/kpi')).body;
  const custNow = (store.list('customers', 999) || []);
  T('点完灯 revenue 分毫未增（灯不是收入）',
    kpi.ok === true && kpi.revenue === kpiBase.revenue && kpi.grossRevenue === kpiBase.grossRevenue,
    'before=' + kpiBase.revenue + ' after=' + kpi.revenue + ' (gross ' + kpiBase.grossRevenue + ' -> ' + kpi.grossRevenue + ')');
  T('点完灯没有凭空多出客户',
    custNow.length === custBase, 'before=' + custBase + ' after=' + custNow.length);
  T('valuation 未变化（WLED 不碰经营口径）',
    (kpi.customers || 0) === (kpiBase.customers || 0), 'customers ' + (kpiBase.customers || 0) + ' -> ' + (kpi.customers || 0));

  // 11) 鉴权：公网访客（代理头）拿不到，也改不动配置
  const cfgBefore = wled.cfg();
  const denied = await req('GET', '/v1/wled/config', null, { 'X-Forwarded-For': '203.0.113.9', 'X-Admin-Token': '' });
  T('公网访客 /v1/wled/config → 403', denied.code === 403, 'code=' + denied.code);
  const denied2 = await req('POST', '/v1/wled/notify', { kind: 'deal' }, { 'X-Forwarded-For': '203.0.113.9', 'X-Admin-Token': '' });
  T('公网访客 /v1/wled/notify → 403', denied2.code === 403, 'code=' + denied2.code);
  const denied3 = await req('POST', '/v1/wled/config', { enabled: false, host: 'evil.example' }, { 'X-Forwarded-For': '203.0.113.9', 'X-Admin-Token': '' });
  T('公网访客改不动 WLED 配置（403 且设置原样）',
    denied3.code === 403 && wled.cfg().enabled === cfgBefore.enabled && wled.cfg().host === cfgBefore.host,
    'code=' + denied3.code + ' host=' + wled.cfg().host);

  // 12) 未知子端点 404（不允许什么都回 200）
  const unk = await req('POST', '/v1/wled/no-such-endpoint', { kind: 'deal' });
  T('未知 /v1/wled/* 端点 → 404', unk.code === 404, 'code=' + unk.code);

  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  try { mock.srv.close(); } catch (e) {}
  require('./_exit').finish(fail ? 1 : 0);
})().catch(e => { console.log('FAIL 套件异常: ' + (e && e.stack || e)); console.log('===== ' + pass + ' PASS / ' + (fail + 1) + ' FAIL ====='); require('./_exit').finish(1); });
