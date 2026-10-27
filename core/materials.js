// materials.js — 物料/库存（轻量 MRP 语义）
//
// 归因：GitHub 调研后选型——不引 mrpSolver 全家桶，按同语义自实现：
//   onHand 真实水位（没有库存不伪造），出库过扣 = 欠料异常（记录并如实拒绝），
//   orderUpTo / reorderPoint 给出补货建议（suggestQty = orderUpTo - onHand，恒 ≥ 0）。
//
// 采购闭环契约（诚实链路）：
//   intent()        只登记意向，不花钱、不造库存（open）；
//   confirmIntent() 才走 money.spend（预算不足如实失败、不动库）→ 到货 move(+delta) 入库；
//   cancelIntent()  允许取消未采购的意向。
// plan() 会把 open 意向从建议采购量里净扣（open 已在路上，不重复建议），
//   并纳入"已收款·未交付"订单的预留需求（reservedDemand）。

const store = require('./store');
const money = require('./money');

function now() { return Date.now(); }

// 登记（幂等）：同 SKU 全字段以本次为准（含 onHand 覆盖，属"校准"不是"移动"）。
function register(m) {
  const db = store.read();
  const sku = String((m && m.sku) || '').trim().toUpperCase();
  if (!sku) return { ok: false, error: 'SKU 缺失' };
  const unit = String((m && m.unit) || '件').trim();
  const base = {
    name: String((m && m.name) || sku).trim(), unit,
    spec: String((m && m.spec) || '').trim(),
    reorderPoint: Number(m && m.reorderPoint) || 0,
    orderUpTo: Number(m && m.orderUpTo) || 0,
    unitCost: Number(m && m.unitCost) || 0,
    updatedAt: Date.now()
  };
  const exist = (db.materials || []).find(x => x.sku === sku);
  let rec;
  let action;
  if (exist) {
    action = '物料·更新';
    const next = Object.assign({}, exist, base, { onHand: Number(m && m.onHand) >= 0 ? Number(m.onHand) : exist.onHand });
    store.update('materials', exist.id, next, action, 'SKU ' + sku);
    rec = next;
  } else {
    rec = store.push('materials', Object.assign({ sku, onHand: Number(m && m.onHand) >= 0 ? Number(m.onHand) : 0 }, base));
    action = '物料·登记';
  }
  store.push('materialMovements', { sku, at: now(), kind: 'register', qty: 0, balance: rec.onHand, unit, note: action + ' ' + sku }, null, null);
  return { ok: true, material: store.list('materials', 999).find(x => x.id === rec.id) };
}

// 库存移动：body { sku, delta(+入库/-出库), ref, note }
// 出库（delta<0）必须先有可用水位；欠料则记录异常并拒绝（绝不透支）。
function move(b) {
  const db = store.read();
  const sku = String((b && b.sku) || '').trim().toUpperCase();
  const mat = (db.materials || []).find(x => x.sku === sku);
  if (!mat) return { ok: false, code: 'no-material', error: '物料不存在（未登记）' };
  const delta = Number(b && b.delta);
  if (!delta) return { ok: false, code: 'no-qty', error: '移动量必须为非零' };
  const isOut = delta < 0;
  const q = Math.abs(delta);
  const after = isOut ? mat.onHand - q : mat.onHand + q;
  if (isOut && after < 0) {
    store.push('materialShortages', { at: now(), sku, note: String((b && b.note) || (b && b.ref) || '出库') });
    return { ok: false, code: 'shortage', error: '库存不足（欠料）：' + sku + ' onHand=' + mat.onHand + ' 需 ' + q, shortage: true, onHand: mat.onHand };
  }
  const next = Object.assign({}, mat, { onHand: after, updatedAt: now() });
  store.update('materials', mat.id, next, '物料·' + (isOut ? '出库' : '入库'), 'SKU ' + sku);
  store.push('materialMovements', { sku, at: now(), kind: (b && b.ref) || (isOut ? 'issue' : 'receipt'), qty: isOut ? -q : q, balance: after, unit: mat.unit, note: String((b && b.note) || (b && b.ref) || '') }, null, null);
  return { ok: true, onHand: after, balance: after };
}

// 履约按单出库：交付时逐项真实扣减；库存不够的项记入 deficits，不抵扣、不造假。
function consumeOrder(order) {
  const db = store.read();
  const consumed = [];
  const deficits = [];
  let cost = 0;
  (order.items || []).forEach(it => {
    const sku = String((it && it.sku) || '').trim().toUpperCase();
    const mat = (db.materials || []).find(x => x.sku === sku);
    const need = Number(it && it.qty) || 0;
    if (!mat || need <= 0) return;
    if (mat.onHand >= need) {
      move({ sku, delta: -need, ref: 'deliver', note: '按单交付 #' + (order.orderNo || '') });
      cost += need * (Number(mat.unitCost) || 0);
      consumed.push({ sku, qty: need });
    } else {
      deficits.push({ sku, need, onHand: mat.onHand, error: '库存不足（欠料）：onHand=' + mat.onHand + ' 需 ' + need });
      // 欠料是实打实的履约风险：既进订单 materialConsume，也落欠料警铃（与 move 出库欠料同口径），
      // 指挥塔/optimize 才能在看板上看到"已收款订单交不出来"。
      // need 冗余存一份用途：警铃消警时用当前存量对照"当时欠多少"判断是否已能覆盖。
      store.push('materialShortages', { at: now(), sku, need, note: '按单交付欠料 #' + (order.orderNo || '') + '：onHand=' + mat.onHand + ' 需 ' + need, orderNo: order.orderNo || '' });
    }
  });
  return { ok: deficits.length === 0, consumed, deficits, cost };
}

// 补货计划：
//   · rows[] 每物料含 reservedDemand = 已收款·未交付订单 items 的合计预留；
//   · low[]  建议采购清单（suggestQty = orderUpTo - onHand - 预留，净扣 open 在途意向）；
//   · 汇总 suggestedPurchaseQty / suggestedPurchaseCost/ openDemand / openIntents。
function plan() {
  const db = store.read();
  const mats = (db.materials || []).map(m => Object.assign({}, m));
  // 预留需求：已收款（paid/shipped）未交付的订单 items
  const reserved = {};
  let openDemand = 0;
  (db.fulfillment || []).forEach(o => {
    if (o.deliveredAt || o.status === 'done' || o.status === 'delivered') return;
    if (!o.paidAt) return;
    (o.items || []).forEach(it => {
      const sku = String((it && it.sku) || '').trim().toUpperCase();
      const q = Number(it && it.qty) || 0;
      if (!sku || q <= 0) return;
      reserved[sku] = (reserved[sku] || 0) + q;
      openDemand++;
    });
  });
  const openIntents = (db.purchaseIntents || []).filter(i => i.status === 'open');
  const rows = mats.map(m => {
    const reservedDemand = reserved[m.sku] || 0;
    const open = openIntents.filter(i => i.sku === m.sku).reduce((a, i) => a + (Number(i.qty) || 0), 0);
    const suggestQty = Math.max(0, (Number(m.orderUpTo) || 0) - (Number(m.onHand) || 0) - reservedDemand - open);
    return Object.assign({}, m, { reservedDemand, openIntents: open, suggestQty, suggested: suggestQty > 0, unitCost: Number(m.unitCost) || 0 });
  });
  const low = rows.filter(r => !!(Number(r.reorderPoint) || Number(r.orderUpTo)) && r.suggestQty > 0);
  const suggestedPurchaseQty = rows.reduce((a, r) => a + r.suggestQty, 0);
  const suggestedPurchaseCost = rows.reduce((a, r) => a + r.suggestQty * (Number(r.unitCost) || 0), 0);
  return {
    ok: true,
    rows, low,
    openDemand,
    openIntents,
    reservedDemand: Object.keys(reserved).reduce((a, k) => a + (reserved[k] || 0), 0),
    suggestedPurchaseQty: Math.round(suggestedPurchaseQty * 100) / 100,
    suggestedPurchaseCost: Math.round(suggestedPurchaseCost * 100) / 100
  };
}

// 采购意向登记（诚实第一步）：只记账，不花钱不动库。estCost 在响应根上（套件在 it.estCost 断言）。
function intent(body) {
  const db = store.read();
  const sku = String((body && body.sku) || '').trim().toUpperCase();
  const mat = (db.materials || []).find(x => x.sku === sku);
  if (!mat) return { ok: false, error: '物料不存在（未登记）' };
  const qty = Number(body && body.qty);
  if (!(qty > 0)) return { ok: false, error: '数量必须为正数' };
  const unitCost = Number(mat.unitCost) || 0;
  const estCost = Math.round(qty * unitCost * 100) / 100;
  const dup = (db.purchaseIntents || []).find(i => i.sku === sku && i.status === 'open');
  if (dup) return { ok: true, already: dup, estCost, error: '该 SKU 已有在途采购意向 #' + dup.id };
  const rec = store.push('purchaseIntents', {
    sku, qty, estQty: qty, estCost, status: 'open',
    note: String((body && body.note) || ''), createdAt: now(), updatedAt: now()
  }, '物料·登记采购意向', 'SKU ' + sku + ' x' + qty + ' 预计 ¥' + estCost);
  return { ok: true, intent: store.list('purchaseIntents', 999).find(x => x.id === rec.id), estCost };
}

// 确认采购意向（诚实第二步）：预算足够才 spend + move 入库，缺钱如实失败、不动库。
function confirmIntent(id) {
  const db = store.read();
  const it = (db.purchaseIntents || []).find(x => x.id === id);
  if (!it) return { ok: false, error: '意向不存在' };
  if (it.status !== 'open') return { ok: false, error: '意向状态必须为 open（当前 ' + it.status + '）' };
  const sp = money.spend(Number(it.estCost) || 0, '采购到货：' + it.sku + ' x' + it.qty, { channel: '对公转账' });
  if (!sp.ok) return { ok: false, error: '预算不足，如实保留意向（未花钱未动库）：' + sp.error, spend: sp };
  const mv = move({ sku: it.sku, delta: Number(it.qty) || 0, ref: '采购到货', note: '采购确认 #' + it.id });
  if (!mv.ok) {
    return { ok: false, error: '到货入库失败：' + mv.error, spend: sp };
  }
  store.update('purchaseIntents', it.id, { status: 'purchased', resolvedAt: now(), spendAmount: Number(it.estCost) || 0, receivedAt: now() }, '物料·采购到货', 'SKU ' + it.sku);
  // 到货后自动消掉已被当前存量覆盖的欠料警铃（不挂旧账，也不误伤未覆盖的铃）
  let bells = 0;
  try { bells = resolveBellsBySku(it.sku); } catch (e) {}
  return { ok: true, received: true, onHand: mv.onHand, spend: sp, bells: bells, intent: store.list('purchaseIntents', 999).find(x => x.id === it.id) };
}

// 取消采购意向（未采购前允许）。
function cancelIntent(id) {
  const db = store.read();
  const it = (db.purchaseIntents || []).find(x => x.id === id);
  if (!it) return { ok: false, error: '意向不存在' };
  store.update('purchaseIntents', it.id, { status: 'cancelled', resolvedAt: now() }, '物料·采购意向取消', 'SKU ' + it.sku);
  return { ok: true, intent: store.list('purchaseIntents', 999).find(x => x.id === it.id) };
}

// 欠料警铃消警：该 SKU 当前存量已能覆盖当时欠量 → 标记 resolvedAt（不再当活跃欠料报警）。
// 警铃只增不减是"有料才算数"：补货到货时自动消最related 的铃，不造假、不高挂。
function resolveBellsBySku(sku) {
  const db = store.read();
  const mat = (db.materials || []).find(m => m.sku === sku);
  if (!mat) return 0;
  let n = 0;
  (db.materialShortages || []).forEach(b => {
    if (b && b.sku === sku && !b.resolvedAt && Number(b.need) > 0 && Number(mat.onHand) >= Number(b.need)) {
      store.update('materialShortages', b.id, { resolvedAt: now(), resolvedNote: '采购到货后已覆盖欠量（onHand=' + mat.onHand + ' ≥ 需 ' + b.need + '）' }, '物料·欠料消警', 'SKU ' + sku);
      n++;
    }
  });
  return n;
}

// 统计视图（物料台账 + 计划 + 意向 + 近期移动/欠料）
function status() {
  const db = store.read();
  const p = plan();
  return {
    ok: true,
    materials: (db.materials || []).map(m => Object.assign({}, m)),
    plan: p,
    intents: (db.purchaseIntents || []).map(i => Object.assign({}, i)),
    openIntents: (db.purchaseIntents || []).filter(i => i.status === 'open'),
    movements: (db.materialMovements || []).slice(-20),
    shortages: (db.materialShortages || []).slice(-20)
  };
}

module.exports = { register, move, consumeOrder, plan, intent, confirmIntent, cancelIntent, resolveBellsBySku, status };