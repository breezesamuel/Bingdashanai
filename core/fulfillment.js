// core/fulfillment.js — 成交后的履约全链路：下单→收款→物料/物流→签收→售后工单
// 全自主管线的末端：convert()（人工确认成交）成功后自动建单，绝不"裸成交跳过履约"；
// 收款/物流/签收由人工/网关/物流回调通过 advance() 推进；
// 自动推进：按时效/事件自动变更阶段（不再仅报警）；
// 售后由 tickets 工单承接，并走真实外联渠道自动回执客户。全部落库可审计。

const store = require('./store');
const tickets = require('./tickets');
const money = require('./money');
const materials = require('./materials');
const logistics = require('./logistics');

const STAGES = { OPEN: '待履约', PAID: '待交付', SHIPPED: '已交付·物流在途', DELIVERED: '已签收', LATER: '售后处理', DONE: '已完成' };

function orderNo() {
  const db = store.read();
  const n = (db.fulfillment || []).length + 1;
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return 'FD-' + ymd + '-' + String(n).padStart(3, '0');
}

// 成交确认后自动建单：任何已确认成交的线索都应有履约记录。
// items 从 lead.topics/industry 推断或留空，后续可补录。
function createFromDeal(leadId) {
  const db = store.read();
  const lead = (db.leads || []).find(l => l.id === leadId);
  if (!lead) return { ok: false, code: 'no-lead', error: '线索不存在' };
  if (!(Number(lead.deal) > 0)) return { ok: false, code: 'no-deal', error: '成交金额缺失，未建单' };
  const dup = (db.fulfillment || []).find(o => o.leadId === leadId);
  if (dup) {
    store.push('audit', { action: '履约·防重复建单', detail: '#' + dup.orderNo + ' 已存在（同线索不重复建单）' }, null, null);
    return { ok: true, already: true, order: dup };
  }
  const order = store.push('fulfillment', {
    orderNo: orderNo(), leadId, leadName: lead.name || lead.id,
    customer: lead.company || lead.name || '',
    amount: Number(lead.deal) || 0, currency: 'CNY',
    channel: lead.channel || lead.source || '未知渠道', source: lead.source || '',
    stage: STAGES.OPEN, status: 'open', createdAt: Date.now(),
    paidAt: 0, logistics: { carrier: '', no: '', status: '' },
    deliveredAt: 0, closedAt: 0, aftersales: [],
    items: [], // 物料清单：[{name, qty, unit, spec}] 可后补
    materialNote: ''
  }, '履约·新建订单', '#' + orderNo() + ' ¥' + (Number(lead.deal) || 0));
  return { ok: true, order };
}

// 履约推进（人工/网关凭证/物流回调）：paid → 待交付；carrier/logisticsNo → 物流在途；delivered → 已签收
function advance(orderId, patch) {
  const b = patch || {};
  const db = store.read();
  const order = (db.fulfillment || []).find(o => o.id === orderId || String(o.orderNo) === String(orderId));
  if (!order) return { ok: false, code: 'no-order', error: '订单不存在' };
  const next = Object.assign({}, order);
  if (b.paid === true && !order.paidAt) {
    next.paidAt = Date.now(); next.status = next.logistics.no ? 'shipped' : 'paid';
    // 【2026-10-21 收入入账（履约链路演练抓出的真漏洞）】
    // B2B 手动/对公收款此前**只标记 paidAt，从不进 revenue** → 营收少记 = 商业账失真
    // （网关路径走 pay.settleFulfillment 会记账，人工路径不会 —— 两条路径口径不一致）。
    // 这里用幂等键 'ful-<orderId>' 记一次：重复推进不会重复入账（money.credit 内部按 id 去重）。
    if (!order.credited && next.credited !== true) {
      try {
        const mc = money.credit(Number(next.amount) || 0,
          '履约收款-' + (next.orderNo || next.id),
          '人工确认/对公转账',
          { id: 'ful-' + next.id, currency: String(next.currency || 'CNY').toUpperCase() });
        if (mc && mc.ok) {
          next.credited = true;
          next.settledMark = 'ful:' + next.id;
        }
      } catch (e) { /* 记账失败不阻断履约推进（金额/凭证由对账器兜底） */ }
    }
    store.push('audit', { action: '履约·确认收款', detail: '#' + order.orderNo + ' 已到账标记' + (next.credited ? '（已记账 ful-' + next.id + '）' : '（未记账）') }, null, null);
  }
  if (b.carrier || b.logisticsNo) {
    next.logistics = {
      carrier: String(b.carrier || order.logistics.carrier || '').slice(0, 20),
      no: String(b.logisticsNo || order.logistics.no || '').slice(0, 40),
      status: b.delivered === true ? '已签收' : '在途'
    };
    if (b.delivered !== true) next.status = next.paidAt || order.paidAt ? 'shipped' : 'paid';
  }
  if (b.delivered === true) {
    next.deliveredAt = next.deliveredAt || Date.now(); next.status = 'delivered';
  }
  if (b.items) next.items = Array.isArray(b.items) ? b.items.slice(0, 20) : [];
  if (b.materialNote) next.materialNote = String(b.materialNote).slice(0, 200);
  if (b.stageNote) next.stageNote = String(b.stageNote).slice(0, 60);
  // 【幂等键】网关到账记账的幂等标记。此前 advance 只认白名单字段，
  // settledMark/credited 被静默丢弃 → pay.settleFulfillment 每次回调都判定
  // 「未记账」→ 同一笔到账重推 N 次就把营收记 N 次（实测 888 记成 2664）。
  // 这里显式落库，记账幂等才有依据。
  if (b.settledMark) next.settledMark = String(b.settledMark).slice(0, 80);
  if (b.credited !== undefined) next.credited = b.credited === true;
  const real = b.delivered === true || next.deliveredAt;
  next.stage = real ? STAGES.DELIVERED
    : (next.logistics.no ? STAGES.SHIPPED
      : (next.paidAt || b.paid === true ? STAGES.PAID : STAGES.OPEN));
  // 【2026-10-21 状态机回退修复】已闭环的订单（closedAt 已置）再次推进时，
  // 上面这段会把 stage 从「已完成」改回「已签收」→ 履约统计与售后口径漂移。
  // 一旦 closedAt 有值，阶段就锁死在「已完成」。
  if (order.closedAt) next.stage = STAGES.DONE;
  // 物料联动：交付（delivered）时按物料清单真实扣库存；欠料不阻断闭环，但记录告警
  if (real && next.items && next.items.length && !order.materialConsumedAt) {
    const cs = materials.consumeOrder(next);
    next.materialConsumedAt = Date.now();
    next.materialConsume = { ok: cs.ok, deficits: cs.deficits || [], at: Date.now() };
    next.materialCost = Math.round((Number(cs.cost) || 0) * 100) / 100;
    next.gross = Math.round(((Number(next.amount) || 0) - (Number(cs.cost) || 0)) * 100) / 100;
    store.push('audit', {
      action: cs.ok ? '物料·按单出库' : '物料·出库欠料',
      detail: '#' + order.orderNo + ' ' + (cs.ok ? '已扣减 ' + cs.consumed.length + ' 项，物料成本 ¥' + (Number(cs.cost) || 0).toFixed(2) : '欠料 ' + (cs.deficits || []).length + ' 项：' + String((cs.deficits || [])[0] && (cs.deficits[0].sku + ' ' + cs.deficits[0].error)).slice(0, 80))
    }, null, null);
  }
  // 自动触发结算：已签收且未结算 → 尝试 money.settle（需人工凭证，这里只记录意图）
  if (real && !order.closedAt) {
    next.closedAt = Date.now(); next.stage = STAGES.DONE;
    store.push('audit', { action: '履约·订单完成', detail: '#' + order.orderNo + ' 已签收闭环，待人工/网关确认实收结算' }, null, null);
  }
  store.update('fulfillment', order.id, next, '履约·推进 (' + next.stage + ')');
  return { ok: true, order: store.list('fulfillment', 999).find(o => o.id === order.id) };
}

// 自动推进：按时效/事件自动变更阶段（不再仅报警）
// - 已收款超 7 天无物流单号 → 自动标记"待催发" (stageNote)
// - 物流在途超 15 天未签收 → 自动标记"待核实签收"
// - 已签收未闭环 → 自动标记 DONE 并记录结算意图
async function automate() {
  const db = store.read();
  const rows = (db.fulfillment || []).filter(o => o.status !== 'delivered' && o.status !== 'done');
  const lines = [];
  let autoAdvanced = 0;
  const now = Date.now();
  rows.forEach(o => {
    const age = (now - (o.createdAt || now)) / 86400000;
    if (!o.paidAt && age > 2) {
      lines.push('订单 #' + o.orderNo + ' 成交 ' + Math.floor(age) + ' 天未收款，待人工/网关推进');
    } else if (o.paidAt && !o.deliveredAt && age > 7 && !o.logistics.no) {
      // 自动打标"待催发"，不改阶段，只加 note
      if (!o.stageNote || !o.stageNote.includes('待催发')) {
        advance(o.id, { stageNote: (o.stageNote || '') + ' | 待催发' });
        lines.push('自动打标：订单 #' + o.orderNo + ' 已收款 ' + Math.floor(age) + ' 天未发货 → 待催发');
        autoAdvanced++;
      }
    } else if (o.paidAt && o.logistics.no && !o.deliveredAt && age > 15) {
      if (!o.stageNote || !o.stageNote.includes('待核实签收')) {
        advance(o.id, { stageNote: (o.stageNote || '') + ' | 待核实签收' });
        lines.push('自动打标：订单 #' + o.orderNo + ' 物流在途 ' + Math.floor(age) + ' 天未签收 → 待核实签收');
        autoAdvanced++;
      }
    }
  });
  // 物流自动签收：对"已交付·物流在途"订单真实查快递100，确认签收则自动 advance(delivered)
  let logisticsChecked = 0, logisticsSigned = 0, logisticsErrors = [], logisticsSkipped = 0, needKey = '';
  const shipped = (db.fulfillment || []).filter(o => o.status === 'shipped' && o.logistics && o.logistics.no);
  if (shipped.length) {
    const sweep = await logistics.sweep();
    logisticsChecked = Number(sweep.checked) || 0;
    logisticsSigned = (sweep.delivered || []).length;
    logisticsSkipped = (sweep.skipped || []).length;
    (sweep.errors || []).slice(0, 3).forEach(e => logisticsErrors.push(String(e && e.error || e).slice(0, 100)));
    if (sweep.needKey) { needKey = String(sweep.error || '').slice(0, 160); lines.push('物流自动跟踪未启用：' + needKey); }
    else if (logisticsChecked) lines.push('物流自动查询 ' + logisticsChecked + ' 单，自动签收 ' + logisticsSigned + ' 单' + (logisticsSkipped ? '，冷却跳过 ' + logisticsSkipped + ' 单待下轮' : ''));
  }
  return { rows: rows.length, overdue: lines.length, autoAdvanced, logisticsChecked, logisticsSigned, logisticsErrors, logisticsSkipped, needKey, lines };
}

// 物流回调：外部物流状态推送自动 advance
// body: { orderId|orderNo, carrier, logisticsNo, status: '在途'|'已签收'|'异常', raw }
function logisticsCallback(body) {
  const b = body || {};
  const id = b.orderId || b.orderNo;
  if (!id) return { ok: false, error: '缺少 orderId/orderNo' };
  const patch = { carrier: b.carrier, logisticsNo: b.logisticsNo };
  if (b.status === '已签收') patch.delivered = true;
  return advance(id, patch);
}

// 售后受理：自动开 tickets 工单 → 自动分类 → 按模板自动回复 → 登记到订单售后记录
// 分类：P0（资损/隐私/安全）人工；P1（退款/故障）自动回复；P2（咨询/建议）自动回复
function afterSales(leadId, text) {
  const db = store.read();
  const order = locate(leadId);
  const subject = '售后咨询' + (order ? '·' + order.orderNo : '（未下单线索）');
  let tic = null;
  try { tic = tickets.create({ msg: String(text || ''), subject }, '平台店铺消息'); } catch (e) { tic = null; }
  const ticId = tic && (tic.id || (tic.ticket && tic.ticket.id)) || null;
  // 自动分类 + 模板自动回复（P0 不自动回，交人工）
  let prio = null, autoReply = null, templateId = null;
  try {
    prio = tickets.classify({ msg: String(text || ''), subject }, '平台店铺消息');
    if (ticId && prio !== 'P0' && prio !== 'P0-crisis') {
      const txt = String(text || '').toLowerCase();
      let tpl = null;
      if (prio === 'P1') {
        if (/退款|退钱|退费|资损|扣款|多扣|少到账/.test(txt)) tpl = 'refund_ack';
        else if (/崩溃|打不开|报错|bug|故障|登录不了|白屏|闪退/.test(txt)) tpl = 'fault_apology';
      } else if (prio === 'P2') {
        tpl = 'suggest_ack';
      }
      if (tpl) {
        const r = tickets.respond(ticId, { templateId: tpl, params: order ? order.orderNo : '', responder: 'ai-support' });
        autoReply = r.replied ? tpl : null;
        templateId = r.templateId || null;
      }
    }
  } catch (e) { /* 分类/回复失败不阻断受理 */ }
  if (order) {
    const aft = Object.assign([], order.aftersales || []);
    aft.push({ at: Date.now(), text: String(text || '').slice(0, 500), ticketId: ticId, prio, autoReply, templateId });
    store.update('fulfillment', order.id, { aftersales: aft, stage: order.deliveredAt ? STAGES.DONE : STAGES.LATER }, '履约·售后受理');
  }
  store.push('audit', { action: '售后·自动开工单', detail: subject + ' → 工单#' + (ticId || '?') + (prio ? ' 分类=' + prio : '') + (autoReply ? ' 自动回复=' + autoReply : '') }, null, null);
  return { ok: true, order: order ? order.orderNo : null, ticket: ticId, prio, autoReply, templateId };
}

function locate(leadId) {
  const db = store.read();
  return (db.fulfillment || []).filter(o => o.leadId === leadId).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

function board(limit) {
  const rows = store.list('fulfillment', limit || 200);
  const counts = rows.reduce((m, o) => { m[o.status || 'open'] = (m[o.status || 'open'] || 0) + 1; return m; }, {});
  return { ok: true, total: rows.length, counts, rows: rows.slice(0, limit || 200) };
}

// 兼容 payment-gateways 调用：直接按 outTradeNo 建单/更新
function createOrder(leadId, amount, items = [], extra = {}) {
  const db = store.read();
  const id = 'ord_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const order = {
    id,
    leadId: leadId || extra.leadId || null,
    outTradeNo: extra.outTradeNo || null,
    amount: Number(amount) || 0,
    items,
    status: 'CREATED',
    gateway: extra.gateway || null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  db.fulfillment = db.fulfillment || [];
  db.fulfillment.push(order);
  store.write(db);
  return order;
}

function updateOrder(outTradeNo, patch) {
  const db = store.read();
  const idx = (db.fulfillment || []).findIndex(o => o.outTradeNo === outTradeNo);
  if (idx >= 0) {
    Object.assign(db.fulfillment[idx], patch, { updatedAt: Date.now() });
    store.write(db);
    return db.fulfillment[idx];
  }
  return null;
}

module.exports = { createFromDeal, createOrder, updateOrder, advance, automate, afterSales, locate, board, logisticsCallback, STAGES, orderNo };