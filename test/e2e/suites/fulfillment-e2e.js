const { finish } = require('./_exit');
const { requireIsolated } = require('./_guard');
const { freePort } = require('../../../scripts/_port');
const http = require('http');
const fs = require('fs');
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const store = require(ROOT + '/core/store');
const BASE = requireIsolated('fulfillment-e2e');
const ADMIN = process.env.BINGDASHAN_ADMIN_TOKEN || '';

let pass = 0, fail = 0;
const LOG_FILE = require('path').join(require('os').tmpdir(), 'fulfillment-e2e-' + Date.now() + '.log');
function logToFile(msg) { fs.appendFileSync(LOG_FILE, msg + '\n'); }
function T(name, ok, extra) {
  ok ? pass++ : fail++;
  const line = (ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' . ' + extra : '');
  console.log(line);
  logToFile(line);
}

function req(method, p, body, headers) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (ADMIN) h['X-Admin-Token'] = ADMIN;
    Object.assign(h, headers || {});
    const r = http.request(BASE + p, { method, headers: h }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
        try { res({ code: resp.statusCode, body: JSON.parse(d) }); }
        catch (e) { res({ code: resp.statusCode, body: { raw: d } }); }
      });
    });
    r.end(data || undefined);
  });
}

(async () => {
  let doneTimer;
  const done = new Promise(r => { doneTimer = setTimeout(r, 180000, 'TIMEOUT'); });
  const run = (async () => {
    const snap = JSON.stringify(store.read());
    const received = []; // webhook 接收的外发消息
    const HOOK_PORT = await freePort(18329);
    try {
      // 启动 webhook 监听（用于验证售后回执真实外发）
    const hook = http.createServer((rq, rs) => {
      let d = ''; rq.on('data', c => d += c); rq.on('end', () => {
        let b = {}; try { b = JSON.parse(d); } catch (e) { b = { raw: d }; }
        received.push({ url: rq.url, body: b });
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({ ok: true, echoed: new Date().toISOString() }));
      });
    });
    await new Promise(r2 => hook.listen(HOOK_PORT, '127.0.0.1', r2));

    // ── 1. crawler 端点：状态 + ingest（验证端点结构与错误处理；无 FIRECRAWL_KEY 时本地抓取可能失败，不视为测试失败）──
    const ingestUrl = 'https://example.com';
    const crSt = (await req('GET', '/v1/crawler')).body;
    T('crawler status endpoint', crSt && crSt.ok === true, 'resp=' + JSON.stringify(crSt).slice(0,200));
    T('crawlerOn default false (hidden, honest)', crSt && crSt.on === false, 'on=' + (crSt && crSt.on));

    const crIng = (await req('POST', '/v1/crawler/ingest', { url: ingestUrl })).body;
    T('crawler ingest endpoint responds', crIng && typeof crIng.ok === 'boolean', 'resp=' + JSON.stringify(crIng).slice(0,200));
    // 无 FIRECRAWL_API_KEY 时本地抓取可能失败，仅验证不抛异常、返回结构正确
    if (crIng.ok === true) {
      T('crawler ingest succeeds when fetch works', crIng.chars > 0, 'chars=' + crIng.chars);
      T('knowledge doc created', crIng.doc && typeof crIng.doc === 'string', 'doc=' + crIng.doc);
    } else {
      T('crawler ingest handles fetch failure gracefully', crIng.error && typeof crIng.error === 'string', 'error=' + crIng.error);
    }

      const crSt2 = (await req('GET', '/v1/crawler')).body;
      T('crawler tail logs ingest', crSt2 && crSt2.tail && crSt2.tail.some(x => x.kind === 'ingest' || x.kind === 'ingest-fail'), 'tail len=' + (crSt2 && crSt2.tail ? crSt2.tail.length : 'no tail'));

      // ── 2. 配置 outreach：启用 webhook + 回复令牌（售后回执需要真实通道）──
      const cfg = await req('POST', '/v1/outreach/config', {
        outreachEnabled: true,
        outreachWebhookUrl: 'http://127.0.0.1:' + HOOK_PORT + '/hook',
        outreachWebhookChannel: '企业微信',
        outreachReplyToken: 'rt-secret-token',
        smtpHost: 'smtp.qq.com', smtpPort: 465, smtpUser: 'a@b.com', smtpPass: 'secretpass1234',
        outreachDailyCap: 20, outreachMaxPerLead: 3, outreachCooldownH: 1
      });
      T('outreach config for service replies', cfg.body.ok === true);

      // ── 3. 播种一条已是「商机候选」的线索（直接可转成交）──
      const leadData = () => ({
        name: 'e2e/fulfillment-lead', company: 'E2E Fulfillment Co',
        repo: 'e2e/fulfillment', industry: 'AI',
        signal: 90, source: 'e2e 成交用例', stage: '商机候选', status: 'new',
        path: 'leadgen', topics: ['mcp', 'agent'], url: 'https://github.com/e2e/fulfillment',
        note: 'e2e fulfillment', touch: 2, tries: 0, planned: 1, sentN: 1,
        needHuman: true, deal: null, email: 'sales@test.example'
      });
      const lead = store.push('leads', leadData(), 'e2e 播种商机候选');
      T('seeded lead in 商机候选', lead && lead.id && lead.stage === '商机候选');

      // ── 4. 人工确认成交（POST /v1/money/leads/convert）──
      const cvt = (await req('POST', '/v1/money/leads/convert', { id: lead.id, amount: 19999, channel: '支付宝', online: true })).body;
      T('convert succeeds with real amount', cvt && cvt.ok === true && cvt.lead && Number(cvt.lead.deal) === 19999, 'cvt=' + JSON.stringify(cvt).slice(0,200));
      T('convert creates receivable? no (online=true)', !(cvt && cvt.receivable && cvt.receivable.id));

      // ── 5. 验证履约订单自动建立（fulfillment board）──
      const fmBoard = (await req('GET', '/v1/fulfillment')).body;
      T('fulfillment board lists the new order', fmBoard && fmBoard.ok === true && fmBoard.total >= 1, 'board=' + JSON.stringify(fmBoard).slice(0,200));
      const order = fmBoard && fmBoard.rows && fmBoard.rows.find(o => o.leadId === lead.id);
      T('order linked to lead', !!order, 'orderNo=' + (order && order.orderNo));
      T('order stage starts at 待履约', order && order.stage === '待履约' && order.status === 'open', 'stage=' + (order && order.stage) + ' status=' + (order && order.status));
      T('order amount matches deal', order && Number(order.amount) === 19999, 'amt=' + (order && order.amount));

      // ── 6. 履约推进：确认收款 → 物流单号 → 签收 ──
      const adv1 = (await req('POST', '/v1/fulfillment/advance', { id: order.id, paid: true })).body;
      T('advance paid moves to 待交付', adv1 && adv1.ok === true && adv1.order && adv1.order.stage === '待交付' && adv1.order.paidAt > 0, 'adv1=' + JSON.stringify(adv1).slice(0,200));

      const adv2 = (await req('POST', '/v1/fulfillment/advance', { id: order.id, carrier: '顺丰', logisticsNo: 'SF1234567890' })).body;
      T('advance logistics moves to 物流在途', adv2 && adv2.ok === true && adv2.order && adv2.order.logistics.no === 'SF1234567890' && adv2.order.logistics.carrier === '顺丰', 'adv2=' + JSON.stringify(adv2).slice(0,200));

      const adv3 = (await req('POST', '/v1/fulfillment/advance', { id: order.id, delivered: true })).body;
      T('advance delivered moves to 已完成(闭环)', adv3 && adv3.ok === true && adv3.order && adv3.order.stage === '已完成' && adv3.order.deliveredAt > 0 && adv3.order.closedAt > 0, 'adv3=' + JSON.stringify(adv3).slice(0,200));

      // ── 7. 售后回复：客户回复含售后关键词 → 自动开工单 + 真实回执 ──
      const svcReply = (await req('POST', '/v1/outreach/reply', {
        token: 'rt-secret-token',
        leadId: lead.id,
        text: '货收到了但有质量问题，想申请售后'
      })).body;
      T('service reply routed to after-sales (not sales promote)', svcReply.ok === true && svcReply.route === 'service', JSON.stringify(svcReply));
      T('service reply creates ticket', svcReply.ticket && typeof svcReply.ticket === 'string', 'ticket=' + svcReply.ticket);
      T('service reply does NOT alter stage (convert set to 待成交)', (store.read().leads.find(l => l.id === lead.id)).stage === '待成交');
      T('service reply does NOT increment touch', Number((store.read().leads.find(l => l.id === lead.id)).touch) === 2);

      // ── 8. 验证真实回执已通过 webhook 发出（ackSent）──
      T('service ack sent via real webhook', svcReply.ackSent === true, 'ackError=' + svcReply.ackError);
      const ackMsg = received.find(x => x.body && x.body.lead && x.body.type === 'direct' && x.body.subject && x.body.subject.indexOf('售后受理') >= 0);
      T('webhook received service ack message', !!ackMsg, 'received count=' + received.length);

      // ── 9. 验证履约订单记录了售后工单 ──
      const fmBoard2 = (await req('GET', '/v1/fulfillment')).body;
      const order2 = fmBoard2.rows.find(o => o.id === order.id);
      T('order aftersales array has the ticket', order2 && Array.isArray(order2.aftersales) && order2.aftersales.length >= 1 && order2.aftersales[0].ticketId === svcReply.ticket);
      // 售后自动分类 + 模板自动回复：P1 退款→refund_ack，P2 咨询→suggest_ack，P0 人工
      // 注意：消息必须匹配 SERVICE_RE（/售后|物流|...|退款|损坏|故障/）才会路由到 afterSales
      const svcP1 = (await req('POST', '/v1/outreach/reply', { token: 'rt-secret-token', leadId: lead.id, text: '售后：我要退款，款项没到账' })).body;
      T('P1 refund auto-classified + auto-replied', svcP1.ok === true && svcP1.route === 'service' && svcP1.prio === 'P1' && svcP1.autoReply === 'refund_ack', 'svcP1=' + JSON.stringify(svcP1).slice(0,180));
      const svcP2 = (await req('POST', '/v1/outreach/reply', { token: 'rt-secret-token', leadId: lead.id, text: '物流：建议增加导出功能' })).body;
      T('P2 suggest auto-classified + auto-replied', svcP2.ok === true && svcP2.route === 'service' && svcP2.prio === 'P2' && svcP2.autoReply === 'suggest_ack', 'svcP2=' + JSON.stringify(svcP2).slice(0,180));
      const svcP0 = (await req('POST', '/v1/outreach/reply', { token: 'rt-secret-token', leadId: lead.id, text: '售后投诉：你们泄露了我的隐私数据' })).body;
      T('P0 privacy NOT auto-replied (manual)', svcP0.ok === true && svcP0.route === 'service' && svcP0.prio === 'P0' && svcP0.autoReply === null, 'svcP0=' + JSON.stringify(svcP0).slice(0,180));
      // 工单状态：P1/P2 已 responded，P0 仍 open
      const tks = store.read().tickets || [];
      const p1t = tks.find(t => t.id === svcP1.ticket);
      const p0t = tks.find(t => t.id === svcP0.ticket);
      T('P1 ticket auto-responded', p1t && p1t.status === 'responded' && p1t.templateId === 'refund_ack', 'p1t=' + JSON.stringify(p1t).slice(0,140));
      T('P0 ticket stays open for manual', p0t && p0t.status === 'open', 'p0t=' + JSON.stringify(p0t).slice(0,140));

      // ── 10. fulfillment detail endpoint ──
      const det = (await req('GET', '/v1/fulfillment/' + order.id)).body;
      T('fulfillment detail endpoint works', det.ok === true && det.order && det.order.id === order.id);

      // ── 11. 隐藏设置不在 /v1/status / /v1/settings/registry ──
      const st = (await req('GET', '/v1/status')).body;
      T('/v1/status hides crawler settings', st.settings && st.settings.crawlerOn === undefined && st.settings.crawlerTopics === undefined);
      const reg = (await req('GET', '/v1/settings/registry')).body;
      T('/v1/settings/registry hides spider group', reg.groups && !reg.groups.some(g => g.key === 'spider'), 'groups=' + (reg.groups || []).map(g => g.key).join(','));

    } finally {
      try { store.write(JSON.parse(snap)); } catch (e) {}
      try { hook.close(); } catch (e) {}
    }
  })();
  const r = await Promise.race([run, done]);
  clearTimeout(doneTimer);
  if (r === 'TIMEOUT') { fail++; console.log('FAIL TIMEOUT'); }
  console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  console.log('Full log: ' + LOG_FILE);
  if (fail) { console.error('FAILED'); process.exit(1); }
  finish(fail ? 1 : 0);
})();