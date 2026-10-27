// materials-e2e.js — 物料/库存 + 物流跟踪（快递100，未配 key 如实提示）
// 归因：GitHub 调研后选型——物流用快递100官方对接方式（零依赖自实现，key 门控），
// 物料按 mrpSolver 语义自实现轻量 MRP（无 onHand 不伪造水位，出库过扣=欠料异常）。
// 断言要点：
//   · /v1/materials/register 登记与幂等
//   · /v1/materials/move 入库/出库/欠料拒绝
//   · 履约 delivered 时按 items 自动扣减物料（materialConsumed）
//   · 无 KUAIDI100 key 时 /v1/logistics/query 如实 needKey（绝不伪造状态）
//   · 指挥塔 procure_remind：open 采购意向滚动提醒（签名去重、确认即重提醒）
// 注：本套件只在隔离沙箱运行（_guard 要求 BINGDASHAN_E2E_BASE）。
const { finish } = require('./_exit');
const { requireIsolated } = require('./_guard');
const http = require('http');
const fs = require('fs');
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const store = require(ROOT + '/core/store');
const BASE = requireIsolated('materials-e2e');
const ADMIN = process.env.BINGDASHAN_ADMIN_TOKEN || '';

let pass = 0, fail = 0;
const LOG_FILE = require('path').join(require('os').tmpdir(), 'materials-e2e-' + Date.now() + '.log');
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
    try {
      // ── 1. 物料登记 ──
      const reg = (await req('POST', '/v1/materials/register', { sku: 'SKU-M1', name: '测试物料一', unit: '件', onHand: 10, reorderPoint: 2 })).body;
      T('materials register creates', reg.ok === true && reg.material && reg.material.sku === 'SKU-M1' && Number(reg.material.onHand) === 10, 'reg=' + JSON.stringify(reg).slice(0,200));

      const reg2 = (await req('POST', '/v1/materials/register', { sku: 'SKU-M1', name: '测试物料一(更新)', unit: '件', onHand: 20 })).body;
      T('materials register idempotent-updates', reg2.ok === true && reg2.material && Number(reg2.material.onHand) === 20, 'reg2=' + JSON.stringify(reg2).slice(0,200));

      const regMiss = (await req('POST', '/v1/materials/register', { name: '无SKU', onHand: 1 })).body;
      T('materials register rejects missing sku', regMiss.ok === false && regMiss.error, 'regMiss=' + JSON.stringify(regMiss).slice(0,120));

      const st0 = (await req('GET', '/v1/materials')).body;
      T('materials status lists material', st0.ok === true && st0.materials && st0.materials.some(m => m.sku === 'SKU-M1'), 'total=' + (st0 && st0.materials ? st0.materials.length : 'x'));

      // ── 2. 出入库 ──
      const in1 = (await req('POST', '/v1/materials/move', { sku: 'SKU-M1', delta: 5, ref: '收货入库', note: '采购到货' })).body;
      T('materials move +5 in-stock', in1.ok === true && Number(in1.onHand) === 25, 'in1=' + JSON.stringify(in1).slice(0,120));

      const out1 = (await req('POST', '/v1/materials/move', { sku: 'SKU-M1', delta: -3, ref: '领用', note: '生产领用' })).body;
      T('materials move -3 out-stock', out1.ok === true && Number(out1.onHand) === 22, 'out1=' + JSON.stringify(out1).slice(0,120));

      const over = (await req('POST', '/v1/materials/move', { sku: 'SKU-M1', delta: -999, ref: '超领' })).body;
      T('materials move shortage rejected (no fake negative)', over.ok === false && over.code === 'shortage', 'over=' + JSON.stringify(over).slice(0,120));

      const mtNoSku = (await req('POST', '/v1/materials/move', { delta: -1 })).body;
      T('materials move rejects missing sku', mtNoSku.ok === false, 'mtNoSku=' + JSON.stringify(mtNoSku).slice(0,120));

      // ── 3. 履约 delivered 时自动按 items 扣减 ──
      const lead = store.push('leads', {
        name: 'e2e/materials-lead', company: 'E2E Materials Co', repo: 'e2e/materials',
        industry: 'AI', signal: 90, source: 'e2e 物料用例', stage: '商机候选', status: 'new',
        path: 'leadgen', topics: ['mcp'], url: 'https://github.com/e2e/materials',
        note: 'e2e materials', touch: 1, tries: 0, planned: 1, sentN: 1,
        needHuman: true, deal: null, email: 'sales2@test.example'
      }, 'e2e 播种物料线索');
      const cvt = (await req('POST', '/v1/money/leads/convert', { id: lead.id, amount: 5888, channel: '对公转账', online: true })).body;
      T('convert creates order for materials case', cvt.ok === true && cvt.lead && Number(cvt.lead.deal) === 5888, 'cvt=' + JSON.stringify(cvt).slice(0,150));

      const brd = (await req('GET', '/v1/fulfillment')).body;
      const order = (brd.rows || []).find(o => o.leadId === lead.id);
      T('order auto-created for materials lead', !!order, 'orderNo=' + (order && order.orderNo));

      const adv = (await req('POST', '/v1/fulfillment/advance', {
        id: order.id, paid: true,
        items: [{ sku: 'SKU-M1', name: '测试物料一', qty: 4, unit: '件' }],
        materialNote: '订单含 4 件测试物料一'
      })).body;
      T('advance paid + items recorded', adv.ok === true && adv.order && adv.order.items && adv.order.items.length === 1 && adv.order.items[0].qty === 4, 'adv=' + JSON.stringify(adv.order ? adv.order.items : null).slice(0,150));

      const afterItems = (store.read().materials || []).find(m => m.sku === 'SKU-M1');
      T('items recorded do NOT auto-deduct before delivered', afterItems && Number(afterItems.onHand) === 22, 'onHand=' + (afterItems && afterItems.onHand));

      const advDel = (await req('POST', '/v1/fulfillment/advance', { id: order.id, delivered: true })).body;
      T('advance delivered closes order', advDel.ok === true && advDel.order && advDel.order.stage === '已完成' && advDel.order.closedAt > 0, 'advDel=' + JSON.stringify(advDel).slice(0,160));

      const after = (store.read().materials || []).find(m => m.sku === 'SKU-M1');
      T('materials auto-deducted on delivered (onHand 22→18)', after && Number(after.onHand) === 18, 'onHand=' + (after && after.onHand));
      const order2 = (store.read().fulfillment || []).find(o => o.id === order.id);
      T('order records materialConsume at delivery', order2 && order2.materialConsumedAt > 0 && order2.materialConsume && order2.materialConsume.ok === true, 'consume=' + JSON.stringify(order2 && order2.materialConsume).slice(0,140));

      // ── 3.5 物料成本与订单毛利（unitCost 登记 → 交付后扣减成本）──
      const costReg = (await req('POST', '/v1/materials/register', { sku: 'SKU-BOM', name: '成本件', unit: '套', onHand: 50, reorderPoint: 5, orderUpTo: 20, unitCost: 12.5 })).body;
      T('materials register with unitCost/orderUpTo', costReg.ok === true && Number(costReg.material.unitCost) === 12.5 && Number(costReg.material.orderUpTo) === 20, 'costReg=' + JSON.stringify(costReg).slice(0,160));

      const lead2 = store.push('leads', {
        name: 'e2e/cost-lead', company: 'E2E Cost Co', repo: 'e2e/cost',
        industry: 'AI', signal: 90, source: 'e2e 成本用例', stage: '商机候选', status: 'new',
        path: 'leadgen', topics: ['mcp'], url: 'https://github.com/e2e/cost',
        note: 'e2e cost', touch: 1, tries: 0, planned: 1, sentN: 1,
        needHuman: true, deal: null, email: 'sales4@test.example'
      }, 'e2e 播种成本线索');
      await req('POST', '/v1/money/leads/convert', { id: lead2.id, amount: 1000, channel: '对公转账', online: true });
      const cBrd = (await req('GET', '/v1/fulfillment')).body;
      const cOrder = (cBrd.rows || []).find(o => o.leadId === lead2.id);
      await req('POST', '/v1/fulfillment/advance', { id: cOrder.id, paid: true, items: [{ sku: 'SKU-BOM', name: '成本件', qty: 10, unit: '套' }] });
      const cAdv = (await req('POST', '/v1/fulfillment/advance', { id: cOrder.id, delivered: true })).body;
      T('orders record material cost on delivery', cAdv.ok === true && cAdv.order && Number(cAdv.order.materialCost) === 125, 'cost=' + (cAdv.order && cAdv.order.materialCost));
      T('orders record gross margin (amount - material cost)', cAdv.ok === true && cAdv.order && Number(cAdv.order.gross) === 875, 'gross=' + (cAdv.order && cAdv.order.gross));

      // ── 3.55 欠料警铃：已收款订单交付时欠料 → 落 materialShortages + optimize 如实报警 ──
      await req('POST', '/v1/materials/register', { sku: 'SKU-BELL', name: '欠料件', unit: '个', onHand: 0, reorderPoint: 3, orderUpTo: 10, unitCost: 1 });
      const bellLead = store.push('leads', {
        name: 'e2e/bell-lead', company: 'E2E Bell Co', repo: 'e2e/bell',
        industry: 'AI', signal: 90, source: 'e2e 欠料用例', stage: '商机候选', status: 'new',
        path: 'leadgen', topics: ['mcp'], url: 'https://github.com/e2e/bell',
        note: 'e2e bell', touch: 1, tries: 0, planned: 1, sentN: 1,
        needHuman: true, deal: null, email: 'sales7@test.example'
      }, 'e2e 播种欠料线索');
      await req('POST', '/v1/money/leads/convert', { id: bellLead.id, amount: 888, channel: '对公转账', online: true });
      const bBrd = (await req('GET', '/v1/fulfillment')).body;
      const bOrder = (bBrd.rows || []).find(o => o.leadId === bellLead.id);
      await req('POST', '/v1/fulfillment/advance', { id: bOrder.id, paid: true, items: [{ sku: 'SKU-BELL', name: '欠料件', qty: 2, unit: '个' }] });
      const bDel = (await req('POST', '/v1/fulfillment/advance', { id: bOrder.id, delivered: true })).body;
      T('delivered order with stock deficit still closes (deficits honest)', bDel.ok === true && bDel.order && bDel.order.materialConsume && bDel.order.materialConsume.deficits && bDel.order.materialConsume.deficits.some(d => d.sku === 'SKU-BELL'), 'consume=' + JSON.stringify(bDel.order && bDel.order.materialConsume).slice(0,140));
      const bellRec = (store.read().materialShortages || []).filter(s => s && s.sku === 'SKU-BELL' && s.orderNo);
      T('stock deficit rings materialShortages bell (with orderNo)', bellRec.length >= 1, 'bell=' + JSON.stringify(bellRec).slice(0,160));
      const opBell = (await req('GET', '/v1/autopilot/optimize')).body;
      const bellAdv = (opBell.advises || []).find(a => /欠料警铃/.test(a));
      T('optimize reports stock-deficit bell honestly', opBell.ok === true && !!bellAdv && /SKU-BELL/.test(bellAdv), 'bellAdv=' + (bellAdv || '').slice(0,180));
      // 采购到货补上欠量 → 警铃消警：resolvedAt 落库，optimize 不再高挂该 SKU 的欠料
      store.push('promo', { kind: '拨款', amt: 20, note: 'e2e 欠料消警预算', at: Date.now() });
      const bellIt = (await req('POST', '/v1/materials/intent', { sku: 'SKU-BELL', qty: 2 })).body;
      const bellCfm = await req('POST', '/v1/materials/confirm', { id: bellIt.intent.id });
      const bellResolved = (store.read().materialShortages || []).find(s => s.sku === 'SKU-BELL' && s.orderNo && s.resolvedAt > 0);
      T('stock deficit bell resolved after restock', bellCfm.body && bellCfm.body.ok === true && !!bellResolved, 'bellResolved=' + JSON.stringify(bellResolved).slice(0,140));
      const opBell2 = (await req('GET', '/v1/autopilot/optimize')).body;
      const bellAdv2 = (opBell2.advises || []).find(a => /欠料警铃/.test(a));
      T('optimize drops resolved bell (no stale alarm)', opBell2.ok === true && (!bellAdv2 || !/SKU-BELL/.test(bellAdv2)), 'bellAdv2=' + (bellAdv2 || '').slice(0,180));

      // ── 3.6 MRP 补货计划：低水位 + 在途需求 → 建议采购量 ──
      // 预留需求源：一单「已收款 · 未交付」订单带着 SKU-BOM×10 → 需求应计入计划
      const resLead = store.push('leads', {
        name: 'e2e/reserve-lead', company: 'E2E Reserve Co', repo: 'e2e/reserve',
        industry: 'AI', signal: 90, source: 'e2e 预留需求用例', stage: '商机候选', status: 'new',
        path: 'leadgen', topics: ['mcp'], url: 'https://github.com/e2e/reserve',
        note: 'e2e reserve', touch: 1, tries: 0, planned: 1, sentN: 1,
        needHuman: true, deal: null, email: 'sales6@test.example'
      }, 'e2e 播种预留需求线索');
      await req('POST', '/v1/money/leads/convert', { id: resLead.id, amount: 500, channel: '对公转账', online: true });
      const rBrd = (await req('GET', '/v1/fulfillment')).body;
      const rOrder = (rBrd.rows || []).find(o => o.leadId === resLead.id);
      const rAdv = (await req('POST', '/v1/fulfillment/advance', { id: rOrder.id, paid: true, items: [{ sku: 'SKU-BOM', name: '成本件', qty: 10, unit: '套' }] })).body;
      T('reserve order paid + items (open demand)', rAdv.ok === true && rAdv.order && rAdv.order.status === 'paid', 'reserve=' + (rAdv.order && rAdv.order.status));

      const plan = (await req('GET', '/v1/materials/plan')).body;
      T('materials plan endpoint ok', plan.ok === true && Array.isArray(plan.rows), 'plan=' + JSON.stringify(plan).slice(0,120));
      const bomRow = (plan.rows || []).find(r => r.sku === 'SKU-BOM');
      T('plan reflects reserved demand (10 reserved from unpaid-deliver order)', bomRow && Number(bomRow.reservedDemand) === 10, 'bomRow=' + JSON.stringify(bomRow).slice(0,160));
      T('plan openDemand > 0', Number(plan.openDemand) >= 1, 'openDemand=' + plan.openDemand);

      // 造一个低水位物料 → 自动出现在建议采购清单
      await req('POST', '/v1/materials/register', { sku: 'SKU-LOW', name: '告急件', unit: '个', onHand: 1, reorderPoint: 10, orderUpTo: 30, unitCost: 4 });
      const plan2 = (await req('GET', '/v1/materials/plan')).body;
      const lowRow = (plan2.low || []).find(r => r.sku === 'SKU-LOW');
      T('low-stock material flagged in plan.low', !!lowRow && Number(lowRow.suggestQty) === 29, 'lowRow=' + JSON.stringify(lowRow).slice(0,160));
      T('plan totals suggested purchase qty/cost', plan2.suggestedPurchaseQty >= 29 && plan2.suggestedPurchaseCost >= 116, 'qty=' + plan2.suggestedPurchaseQty + ' cost=' + plan2.suggestedPurchaseCost);

      // ── 3.7 optimize() 融合指标：物料告急 + 履约盯盘如实进 advises ──
      // 先造一单「已收款·物流在途」→ 未配快递100 key 时应如实出现在 advises（needKey，不伪造签收）
      const shipLead = store.push('leads', {
        name: 'e2e/ship-lead', company: 'E2E Ship Co', repo: 'e2e/ship',
        industry: 'AI', signal: 90, source: 'e2e 物流用例', stage: '商机候选', status: 'new',
        path: 'leadgen', topics: ['mcp'], url: 'https://github.com/e2e/ship',
        note: 'e2e ship', touch: 1, tries: 0, planned: 1, sentN: 1,
        needHuman: true, deal: null, email: 'sales5@test.example'
      }, 'e2e 播种物流线索');
      await req('POST', '/v1/money/leads/convert', { id: shipLead.id, amount: 300, channel: '对公转账', online: true });
      const sBrd = (await req('GET', '/v1/fulfillment')).body;
      const sOrder = (sBrd.rows || []).find(o => o.leadId === shipLead.id);
      await req('POST', '/v1/fulfillment/advance', { id: sOrder.id, paid: true });
      const shipped = (await req('POST', '/v1/fulfillment/advance', { id: sOrder.id, carrier: '中通', logisticsNo: 'ZT20261009SHIP' })).body;
      T('shipped order seeded for logistics sweep', shipped.ok === true && shipped.order && shipped.order.status === 'shipped', 'st=' + (shipped.order && shipped.order.status));

      const op = (await req('GET', '/v1/autopilot/optimize')).body;
      T('optimize returns advises', op.ok === true && Array.isArray(op.advises), 'adv=' + (op.advises || []).length);
      const matAdv = (op.advises || []).find(a => /物料告急/.test(a));
      T('optimize advises materials reorder plan', !!matAdv, 'matAdv=' + (matAdv || '').slice(0,120));
      const lgAdv = (op.advises || []).find(a => /物流自动跟踪未启用/.test(a));
      T('optimize advises logistics needKey honestly', !!lgAdv, 'lgAdv=' + (lgAdv || '').slice(0,140));

      // ── 3.8 采购闭环（诚实）：意向登记 → 无预算确认必须失败且不动作 → 可取消 ──
      const it1 = (await req('POST', '/v1/materials/intent', { sku: 'SKU-LOW', qty: 29, note: '安全水位回补' })).body;
      T('purchase intent registered (no spend, no stock)', it1.ok === true && it1.intent && it1.intent.status === 'open' && Number(it1.estCost) === 116, 'it1=' + JSON.stringify(it1).slice(0,160));
      const itDup = (await req('POST', '/v1/materials/intent', { sku: 'SKU-LOW', qty: 29 })).body;
      T('duplicate intent for same sku deduped', itDup.ok === true && itDup.already && itDup.already.status === 'open', 'itDup=' + JSON.stringify(itDup).slice(0,120));

      const itMiss = (await req('POST', '/v1/materials/intent', { sku: 'NO-SUCH-M', qty: 5 })).body;
      T('intent rejects unregistered material', itMiss.ok === false, 'itMiss=' + JSON.stringify(itMiss).slice(0,100));

      // 确定性地清空推广池（此前套件可能留下拨款，导致「空预算」断言不稳）→ 再确认必须如实失败
      const budget1 = (await req('GET', '/v1/money/budget')).body;
      const avail0 = Number((budget1.budget && budget1.budget.avail) || 0);
      if (avail0 > 0) {
        await req('POST', '/v1/money/spend', { amt: avail0, note: 'e2e 清空推广池', channel: 'e2e排水' });
      }
      const budget2 = (await req('GET', '/v1/money/budget')).body;
      T('promo pool drained to zero for empty-budget test', Number((budget2.budget && budget2.budget.avail) || 0) === 0, 'avail=' + (budget2.budget && budget2.budget.avail));

      const cf = (await req('POST', '/v1/materials/confirm', { id: it1.intent.id })).body;
      T('confirm with empty budget → honest fail, no fake spend/stock', cf.ok === false && (store.read().materials || []).find(m => m.sku === 'SKU-LOW').onHand === 1, 'cf=' + JSON.stringify(cf).slice(0,160));

      // open 意向还悬着 + 预算为 0 → optimize 必须如实报「在途采购意向·待确认到货·缺口」，不替人工批准
      const opGap = (await req('GET', '/v1/autopilot/optimize')).body;
      const gapAdv = (opGap.advises || []).find(a => /待确认到货/.test(a));
      T('optimize reports in-flight intent budget gap honestly', opGap.ok === true && !!gapAdv && /在途采购意向/.test(gapAdv) && /缺口/.test(gapAdv), 'gap=' + (gapAdv || '').slice(0,220));

      // 造预算：给促销池拨款（money/promo 拨款是真实记账动作）—— 5% 计提 5000 → ¥250 可用
      await req('POST', '/v1/money/credit', { amt: 5000, source: 'e2e 物料采购拨款', method: '对公转账' });
      const cf2 = (await req('POST', '/v1/materials/confirm', { id: it1.intent.id })).body;
      T('confirm with budget → real spend + in-stock', cf2.ok === true && cf2.received === true && Number(cf2.onHand) === 30, 'cf2=' + JSON.stringify(cf2).slice(0,160));
      const cf3 = (await req('POST', '/v1/materials/confirm', { id: it1.intent.id })).body;
      T('confirm second time rejected (idempotent)', cf3.ok === false, 'cf3=' + JSON.stringify(cf3).slice(0,100));

      const it2 = (await req('POST', '/v1/materials/intent', { sku: 'SKU-M1', qty: 3 })).body;
      const cxl = (await req('POST', '/v1/materials/cancel', { id: it2.intent.id })).body;
      T('intent cancel allowed before purchase', cxl.ok === true && (store.read().purchaseIntents || []).find(i => i.id === it2.intent.id).status === 'cancelled', 'cxl=' + JSON.stringify(cxl).slice(0,100));

      const plan3 = (await req('GET', '/v1/materials/plan')).body;
      T('plan nets saved purchase (open intent withheld)', plan3.openIntents && plan3.openIntents.length === 0 && Number(plan3.suggestedPurchaseQty) >= 0, 'open=' + (plan3.openIntents || []).length);

      // 该补未登记：低库存 SKU 无 open 意向 → optimize 必须如实提示先登记意向（闭环断在意向登记前）
      await req('POST', '/v1/materials/register', { sku: 'SKU-ORG', name: '孤儿采购件', unit: '件', onHand: 0, reorderPoint: 4, orderUpTo: 12, unitCost: 2 });
      const opOr1 = (await req('GET', '/v1/autopilot/optimize')).body;
      const orAdv = (opOr1.advises || []).find(a => /该补未登记/.test(a));
      T('optimize flags low SKU with no purchase intent (loop hole)', opOr1.ok === true && !!orAdv && /SKU-ORG/.test(orAdv), 'orAdv=' + (orAdv || '').slice(0,200));
      // 登记后该 SKU 被意向覆盖 → 不再列为孤独立项
      const orInt = (await req('POST', '/v1/materials/intent', { sku: 'SKU-ORG', qty: 12 })).body;
      const opOr2 = (await req('GET', '/v1/autopilot/optimize')).body;
      const orAdv2 = (opOr2.advises || []).find(a => /该补未登记/.test(a));
      T('intent covering low SKU removes orphan flag', orInt.ok === true && (!orAdv2 || !/SKU-ORG/.test(orAdv2)), 'orAdv2=' + (orAdv2 || '').slice(0,200));
      const orCx = (await req('POST', '/v1/materials/cancel', { id: orInt.intent.id })).body;
      T('orphan test intent cancelled (state restored)', orCx.ok === true, 'orCx=' + JSON.stringify(orCx).slice(0,100));

      // ── 4. 物流跟踪端点：未配 key 如实 needKey，绝不伪造 ──
      const lgSt = (await req('GET', '/v1/logistics/status')).body;
      T('logistics status endpoint reports configured flag', lgSt.ok === true && typeof lgSt.configured === 'boolean', 'lgSt=' + JSON.stringify(lgSt).slice(0,200));

      const lgQ = (await req('POST', '/v1/logistics/query', { no: 'SF1234567890', carrier: '顺丰' })).body;
      T('logistics query without key returns honest needKey (never fake)', lgQ.ok === false && lgQ.code === 'need-key', 'lgQ=' + JSON.stringify(lgQ).slice(0,160));

      const lgQNo = (await req('POST', '/v1/logistics/query', { no: '', carrier: '' })).body;
      T('logistics query rejects missing number', lgQNo.ok === false && lgQNo.code === 'no-number', 'lgQNo=' + JSON.stringify(lgQNo).slice(0,120));

      // ── 5. 幂等：同物料流水可回溯，审计存在 ──
      const mvLog = (store.read().materialMovements || []).filter(m => m.sku === 'SKU-M1');
      T('material movements audited', mvLog.length >= 3, 'movements=' + mvLog.length);
      const audit = (store.read().audit || []).some(a => /物料/.test(a.action || ''));
      T('material actions audited', audit === true);

      // ── 6. 履约支付网关桥：无 ALIPAY_PUBLIC_KEY 时回调必须如实拒签（绝不本地臆断到账）──
      // 播种时就带 channel='支付宝'：createFromDeal 的 order.channel 取 lead.channel，
      // 否则会落到 source 上，optimize 的「支付宝通道在途单需网关」信号就探测不到这个单。
      const gOrder = store.push('leads', {
        name: 'e2e/gateway-lead', company: 'E2E Gateway Co', repo: 'e2e/gateway',
        industry: 'AI', signal: 90, source: 'e2e 网关用例', channel: '支付宝', stage: '商机候选', status: 'new',
        path: 'leadgen', topics: ['mcp'], url: 'https://github.com/e2e/gateway',
        note: 'e2e gateway', touch: 1, tries: 0, planned: 1, sentN: 1,
        needHuman: true, deal: null, email: 'sales3@test.example'
      }, 'e2e 播种网关线索');
      const gCvt = (await req('POST', '/v1/money/leads/convert', { id: gOrder.id, amount: 9800, channel: '支付宝', online: true })).body;
      const gBrd = (await req('GET', '/v1/fulfillment')).body;
      const gFulf = (gBrd.rows || []).find(o => o.leadId === gOrder.id);
      T('gateway-lead order auto-created', !!gFulf, 'orderNo=' + (gFulf && gFulf.orderNo));

      const qsOf = o => Object.keys(o).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');
      const gNot = () => {
        const data = qsOf({ out_trade_no: gFulf.orderNo, trade_status: 'TRADE_SUCCESS', total_amount: '9800.00', currency: 'CNY' });
        return new Promise(res => {
          const r = http.request(BASE + '/v1/pay/alipay/notify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, resp => {
            let d = ''; resp.on('data', c => d += c); resp.on('end', () => res(d));
          });
          r.end(data);
        });
      };
      const gR1 = await gNot();
      T('gateway notify without key → honest fail (no local assumption)', gR1 === 'fail', 'resp=' + gR1);
      const gAfter = (store.read().fulfillment || []).find(o => o.id === gFulf.id);
      T('gateway notify does NOT mark paid without signature', gAfter && !gAfter.paidAt, 'paidAt=' + (gAfter && gAfter.paidAt));

      // 支付宝通道的在途 open 履约单 → optimize 的网关告警必须与本机真实网关状态一致：
      // · 本机未配公钥（alipayReady=false）→ 必须如实给「缺 ALIPAY_PUBLIC_KEY」告警；
      // · 本机网关已自洽可用（alipayReady=true）→ 必须不报假警（有单却不该叫，说明接线错了）。
      // 两种环境都成立才叫「诚实合同」：信号随真实配置走，不刻死某一边。
      // 【确定性】此前在测试进程里 require(core/pay) 取 alipayReady —— 那是**另一个进程的另一份缓存**：
      // 服务端为判定告警会异步探测远端验签（null→true/false），测试进程也在各跑各的探测，
      // 「本地快照 true / 服务端已 false」的竞态让断言随网络抖动随机红。
      // 现在改为向**服务端**要状态：先 force 一次让远端验签落定，再读同一份缓存。
      await req('GET', '/v1/pay/alipay/check?force=1');
      // 【形状坑·上一轮红的真因】/v1/pay/alipay/check 回 {ok,usable,verdict,local,remote}，
      // 根本没有 channels；/v1/pay/channels 的 channels 是数组（available 列表），
      // 布尔在 alipay.ready。原来读 pcSnap.channels.alipayReady 恒 undefined →
      // pcAlipayReady 恒 false → 断言被焊死成「必须有告警」，本机支付宝真就绪时
      // （不报假警是正确行为）反而判红。读 alipay.ready 才与 autopilot 用的
      // pay.channelStatus().alipayReady 同源同值，两方向都活。
      const pcSnap = (await req('GET', '/v1/pay/channels')).body;
      const pcAlipayReady = !!(pcSnap.alipay && pcSnap.alipay.ready);
      const op2 = (await req('GET', '/v1/autopilot/optimize')).body;
      const payAdv = (op2.advises || []).find(a => /支付宝网关/.test(a));
      T('optimize paygate advise consistent with real alipay state', op2.ok === true && !!payAdv === !pcAlipayReady, 'alipayReady=' + pcAlipayReady + ' adv=' + JSON.stringify(op2.advises || []).slice(0, 220));

      // ── 7. 指挥塔滚动提醒：open 采购意向 → procure_remind（缺钱摆缺口，够钱等人工，绝不代签）──
      // 列车装齐发车后主攻越过增长/留存/还债段，看向中段；有 open 采购意向时
      // procure_remind 优先于技能部署/内容产出（缺料卡履约 = 运营连续性风险）。
      // 同批意向只提醒一轮（签名去重），确认一笔后签名变化必须立刻再提醒。
      const prTrain = require(ROOT + '/core/train');
      const prC = require(ROOT + '/core/conductor');
      store.push('promo', { kind: '拨款', amt: 100, note: 'e2e procure_remind 预算', at: Date.now() });
      await req('POST', '/v1/materials/register', { sku: 'SKU-PR', name: '采购提醒件', unit: '件', onHand: 0, reorderPoint: 3, orderUpTo: 10, unitCost: 12.5 });
      await req('POST', '/v1/materials/register', { sku: 'SKU-PR2', name: '采购提醒件二', unit: '件', onHand: 0, reorderPoint: 3, orderUpTo: 10, unitCost: 3 });
      const prInt = (await req('POST', '/v1/materials/intent', { sku: 'SKU-PR', qty: 4 })).body;
      const prInt2 = (await req('POST', '/v1/materials/intent', { sku: 'SKU-PR2', qty: 8 })).body;
      T('intent open before conductor remind', prInt.ok === true && prInt.intent && prInt.intent.status === 'open' && Number(prInt.estCost) === 50 && prInt2.ok === true && Number(prInt2.estCost) === 24, 'intent=' + JSON.stringify(prInt.intent).slice(0,120));
      // 把当前班强制置为三格满载已发车，让 mission 越过增长/留存/还债缺口段
      (() => {
        const dbT = store.read();
        if (!dbT.trains) dbT.trains = [];
        const no = prTrain.line();
        let t = dbT.trains.find(x => x.no === no);
        if (!t) { t = { id: store.uid(), no, createdAt: Date.now(), slots: { growth: null, retention: null, debt: null }, released: false, releasedAt: null }; dbT.trains.push(t); }
        t.slots.growth = { title: 'e2e 增长件', desc: 'e2e', by: 'e2e', at: Date.now() };
        t.slots.retention = { title: 'e2e 留存件', desc: 'e2e', by: 'e2e', at: Date.now() };
        t.slots.debt = { title: 'e2e 还债件', desc: 'e2e', by: 'e2e', at: Date.now() };
        t.released = true; t.releasedAt = Date.now();
        store.write(dbT);
      })();
      const prM1 = prC.mission();
      T('conductor mission rolls procure_remind on open intent', prM1 && prM1.act === 'procure_remind' && /在途采购意向|采购到货/.test(prM1.reason || ''), 'm1=' + JSON.stringify(prM1).slice(0,220));
      // 同批签名第二轮不得重复（回落 content_asset 等 routine）。
      // 本轮先按 runTick 惯例把提醒证据落库（签名=pis:<open 意向 id 排序集>），
      // 再重问 mission：同批意向在 12h 去重窗口内绝不再提醒。
      // 【必须自己建表】共享沙箱里各套件执行顺序不定——若前面的套件没建过
      // conductor 表，store.read().conductor 是 undefined，.unshift 直接炸。
      // 断言比增量、不比绝对值；同理，测试也不能假设别的套件替你准备好了数据。
      const condDb = store.read();
      if (!Array.isArray(condDb.conductor)) condDb.conductor = [];
      condDb.conductor.unshift({ id: store.uid(), act: 'procure_remind', ok: true, evidence: 'pis:' + prM1.pisSig, detail: prM1.reason, at: Date.now() });
      store.write(condDb);
      const prM2 = prC.mission();
      T('procure_remind dedups same signature (no spam)', prM2 && prM2.act !== 'procure_remind', 'm2=' + (prM2 && prM2.act));
      // 确认其中一笔后签名变化 → 立刻重新提醒（剩余仍在途）
      const prOpen = (store.read().purchaseIntents || []).find(i => i.sku === 'SKU-PR' && i.status === 'open');
      const prCfm = prOpen ? (await req('POST', '/v1/materials/confirm', { id: prOpen.id })).body : { ok: false };
      const prM3 = prC.mission();
      T('procure_remind re-fires when intent set changes', prCfm.ok === true && prM3 && prM3.act === 'procure_remind' && /SKU-PR2/.test(prM3.reason || ''), 'cfm=' + JSON.stringify(prCfm).slice(0,80) + ' m3=' + (prM3 && prM3.act));

    } finally {
      try { store.write(JSON.parse(snap)); } catch (e) {}
    }
  })();
  const final = await Promise.race([run, done]);
  if (final === 'TIMEOUT') { console.error('TIMEOUT materials-e2e'); finish(1); }
  else {
    console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
    finish(fail === 0 ? 0 : 1);
  }
})().catch(e => { console.error('FATAL', e); finish(1); });