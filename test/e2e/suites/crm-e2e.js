// test/e2e/suites/crm-e2e.js — CRM-lite（线索→商机→成交→复购）漏斗 + 新增 MCP 只读工具的守卫
//
// 守护的纪律：
//   1. 漏斗口径诚实：金额只认「人工确认真实成交」，机器排定的触达计划(planned)**绝不**计入进展或金额。
//   2. 商机候选是人工领地：deal 必须为 null，下一步动作指向人工 convert；自动化不写金额。
//   3. convert 拒绝 0 元/负金额（不许用假金额把漏斗"做漂亮"）。
//   4. 新增 MCP 工具是「只读聚合」：crm_pipeline 只吐计数 —— 不得泄漏客户/商机姓名。
//   5. CRM 运营视图需鉴权：公网访客（代理头）拿不到。
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const { requireIsolated } = require('./_guard');
const http = require('http');
const store = require(ROOT + '/core/store');
const BASE = requireIsolated('crm-e2e');
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

(async () => {
  // —— 夹具：直接写沙箱 DB（不经过 HTTP，保证确定性）——
  const staged = store.push('leads', { stage: '促单', company: '测试未触达公司', touch: 0, planned: 5, signal: 70 }, 'crm-e2e 夹具', '促单无人触达');
  const opp = store.push('leads', { stage: '商机候选', company: '测试商机公司', touch: 2, signal: 80, deal: null, industry: '开发者/AI团队' }, 'crm-e2e 夹具', '商机候选');
  store.push('leads', { stage: '长期跟进', company: '测试搁置公司', blockedOn: 'human-touch', underFollow: true }, 'crm-e2e 夹具', '长期跟进');
  store.push('customers', { company: '测试客户公司', amount: 300, deals: 1, lastAt: Date.now() }, 'crm-e2e 夹具', '客户');

  // 1) 漏斗形状 + 诚实口径
  const p1 = (await req('GET', '/v1/crm/pipeline')).body;
  T('CRM pipeline 返回 8 段漏斗', p1.ok === true && Array.isArray(p1.funnel) && p1.funnel.length === 8, 'len=' + (p1.funnel || []).length);
  T('漏斗段键齐全', ['lead', 'recommend', 'select', 'optimize', 'promote', 'opportunity', 'pending', 'customer'].every(k => (p1.funnel || []).some(f => f.key === k)));
  T('金额=客户实收+待成交（不含计划）', Math.abs(p1.revenue - (p1.customerAmount + p1.pendingAmount)) < 0.001,
    'rev=' + p1.revenue + ' cust=' + p1.customerAmount + ' pend=' + p1.pendingAmount);
  T('plannedOnly 与 realTouches 分开口径', p1.plannedOnly >= 5 && p1.realTouches >= 2,
    'planned=' + p1.plannedOnly + ' real=' + p1.realTouches);
  T('商机候选计入漏斗', (p1.funnel.find(f => f.key === 'opportunity') || {}).count >= 1);
  T('促单无人触达计入 waitingHuman', p1.waitingHuman >= 1, 'waiting=' + p1.waitingHuman);
  T('长期跟进计入 blocked 归因', (p1.blocked && p1.blocked['human-touch'] >= 1), JSON.stringify(p1.blocked));
  T('pipeline 带诚实口径说明', typeof p1.note === 'string' && p1.note.length > 10);

  // 2) 商机清单：人工领地，deal 必须为 null
  const op = (await req('GET', '/v1/crm/opportunities')).body;
  const mine = (op.opportunities || []).find(o => o.id === opp.id);
  T('商机清单含夹具商机', !!mine, 'n=' + (op.opportunities || []).length);
  T('商机不下发 deal（未确认金额不得呈现为成交）', !!mine && mine.deal === undefined && mine.dealConfirmed === false,
    'deal=' + (mine && mine.deal) + ' confirmed=' + (mine && mine.dealConfirmed));
  T('历史遗留的机器估价只作 estimatedDeal 暴露', !mine || mine.estimatedDeal === null || typeof mine.estimatedDeal === 'number',
    'est=' + (mine && mine.estimatedDeal));
  T('商机下一步指向人工 convert', !!mine && /\/convert/.test(mine.nextAction || ''), mine && mine.nextAction);

  // 3) 客户生命周期
  const cs = (await req('GET', '/v1/crm/customers')).body;
  T('客户清单含夹具客户', (cs.customers || []).some(c => c.name === '测试客户公司'), 'n=' + (cs.customers || []).length);

  // 4) convert 拒绝 0 元（不许用假金额把漏斗做漂亮）
  const bad = (await req('POST', '/v1/money/leads/convert', { id: opp.id, amount: 0 })).body;
  T('convert 0 元被拒（诚实金额门）', bad.ok === false && !!bad.error, JSON.stringify(bad).slice(0, 120));
  const stillOpp = (await req('GET', '/v1/crm/opportunities')).body.opportunities.some(o => o.id === opp.id);
  T('拒绝后商机仍在（无副作用）', stillOpp);

  // 5) convert 真实金额 → 待成交
  const good = (await req('POST', '/v1/money/leads/convert', { id: opp.id, amount: 888 })).body;
  T('convert 真实金额成功', good.ok === true, JSON.stringify(good).slice(0, 120));
  const p2 = (await req('GET', '/v1/crm/pipeline')).body;
  T('成交后进入待成交段', (p2.funnel.find(f => f.key === 'pending') || {}).count >= 1);
  T('待成交金额计入 revenue', p2.pendingAmount >= 888, 'pend=' + p2.pendingAmount);

  // 6) 鉴权：公网访客拿不到 CRM
  const denied = await req('GET', '/v1/crm/summary', null, { 'X-Forwarded-For': '203.0.113.9', 'X-Admin-Token': '' });
  T('公网访客 /v1/crm/summary → 403', denied.code === 403, 'code=' + denied.code);

  // 7) 新 MCP 只读工具
  const tools = (await req('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body;
  const names = ((tools.result || {}).tools || []).map(t => t.name);
  T('MCP 暴露 crm_pipeline / org_brain / decision_stats',
    ['crm_pipeline', 'org_brain', 'decision_stats'].every(n => names.indexOf(n) >= 0), names.join(','));
  T('MCP 暴露 funnel_stats / lightning_stats（获客 + 轨迹，只聚合）',
    ['funnel_stats', 'lightning_stats'].every(n => names.indexOf(n) >= 0), names.join(','));

  const call = async (name, args) => {
    const r = (await req('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args || {} } })).body;
    const txt = (((r.result || {}).content || [])[0] || {}).text || '';
    let obj = null; try { obj = JSON.parse(txt); } catch (e) {}
    return { raw: txt, obj };
  };
  const crmCall = await call('crm_pipeline');
  T('MCP crm_pipeline 返回聚合计数', !!(crmCall.obj && typeof crmCall.obj.leads === 'number' && typeof crmCall.obj.opportunities === 'number'), crmCall.raw.slice(0, 140));
  T('MCP crm_pipeline 不泄漏客户姓名', crmCall.raw.indexOf('测试商机公司') < 0 && crmCall.raw.indexOf('测试客户公司') < 0);
  const orgCall = await call('org_brain');
  T('MCP org_brain 返回编制计数', !!(orgCall.obj && typeof orgCall.obj.headcount === 'number' && typeof orgCall.obj.projects === 'number'), orgCall.raw.slice(0, 140));
  const decCall = await call('decision_stats');
  T('MCP decision_stats 返回计数+趋势', !!(decCall.obj && typeof decCall.obj.total === 'number' && Array.isArray(decCall.obj.trend) && decCall.obj.trend.length === 7), decCall.raw.slice(0, 140));

  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  require('./_exit').finish(fail ? 1 : 0);
})().catch(e => { console.log('FAIL 套件异常: ' + (e && e.stack || e)); console.log('===== ' + pass + ' PASS / ' + (fail + 1) + ' FAIL ====='); require('./_exit').finish(1); });
