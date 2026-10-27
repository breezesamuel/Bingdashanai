// core/partner.js — 合伙人分润台账（合规优先设计）
//
// ===== 合规红线（写进代码，不靠口头约定）=====
// 《禁止传销条例》第七条(三)：形成上下线关系、以"下线的销售业绩"为依据给付报酬 = 传销。
// 2026-06 市监总局修订征求意见稿进一步收紧（违法所得 3 倍罚款 + 处罚到人 + 3 年信用惩戒）。
// 因此本模块只允许一种结构：
//
//        客户成交 → 平台抽成 → 净收入 → 该笔成交的【唯一】直接服务人（合伙人）
//                                        └─ 封顶：只此一层，绝不向下穿透
//
// 硬约束（代码层强制，违规请求直接拒绝并留审计）：
//   1. 单层封顶    —— 佣金归属唯一服务人，任何"上级再抽成"请求一律 400。
//   2. 锚定真实成交 —— 佣金来自 ledger 里已登记的【真实交付 + 成交】，不接受"人头数"计酬。
//   3. 零入门费     —— 合伙人注册不收费、不设资格费（收即触犯第七条二）。
//   4. 不可继承/永续 —— 不产生"永久下线收益"，分润随单笔结算即终。
//
// 诚实红线：净收入不足、交付未验收、成交未确认 → 一律不算佣金，**不预支、不估算**。

const store = require('./store');

// ===== 抽成与分润：单一事实来源 =====
//
// 此前存在两套互相冲突、且只有一套真正生效的口径：
//   A) settings.platformFee.revenueTiers = 3%/5%/3%（年营收阶梯）+ 广告代管 20%
//      —— 看起来最权威（按 2026-09 Polsia 竞品对标写入），但**全代码库无人读取**，
//         从未参与任何一笔结算，是死配置。
//   B) 本模块硬编码 partnerSharePct = 60%（平台留 40%）—— 这才是实际生效的唯一口径。
// 也就是说：设置里写着"平台抽 3–5%"，账上实际抽 40%。看板与设置页互相矛盾。
//
// 现在统一为**一条规则**：
//   平台抽成 = settings.platformFee.revenueTiers 中，按【近 12 个月已结算实收】命中的那一档
//   合伙人分润 = 100% − 平台抽成（单层封顶，绝不向下穿透）
// 非合伙人渠道：平台全额留存，仅按 money.js 的 5% 计提推广预算池（那是自留获客成本，不是抽成）。
//
// partnerSharePct 保留为**已废弃的覆盖项**：若显式设置且与阶梯冲突，按阶梯执行并写审计告警，
// 避免历史数据静默改变口径；不设置（或设为 0）时完全由阶梯决定。

const DEFAULT_FEE_TIERS = [
  { maxAnnual: 100000, pct: 3, note: '年营收<10万：获客期，平台补贴获客' },
  { maxAnnual: 1000000, pct: 5, note: '年营收10万–100万：规模化收费' },
  { maxAnnual: null, pct: 3, note: '规模化后回落：规模效应' }
];
const FALLBACK_FEE_PCT = 5;      // 阶梯配置缺失/损坏时的兜底（取中档，不取最优档）
const MIN_PLATFORM_PCT = 1;      // 硬下限：平台抽成不得为 0，防止把平台抽成压到 0
const MAX_PLATFORM_PCT = 90;     // 硬上限：平台留存不得低于 10%，合伙人分润不得低于 10%
const MIN_PAYOUT = 1;            // 低于 1 元不发起分润（避免刷单噪声）

// 读取阶梯抽成配置。返回生效档 + 命中的年营收 + 命中的依据，供审计与看板复现。
function feePolicy() {
  const cfg = store.getSetting('platformFee') || {};
  const tiers = Array.isArray(cfg.revenueTiers) && cfg.revenueTiers.length
    ? cfg.revenueTiers
    : DEFAULT_FEE_TIERS;
  let annual = 0;
  try { annual = require('./money').annualSettled().total; } catch (e) { annual = 0; }
  const sorted = tiers.slice().sort((a, b) => {
    const av = a.maxAnnual === null || a.maxAnnual === undefined ? Infinity : Number(a.maxAnnual);
    const bv = b.maxAnnual === null || b.maxAnnual === undefined ? Infinity : Number(b.maxAnnual);
    return av - bv;
  });
  const tier = sorted.find(t => {
    const cap = t.maxAnnual === null || t.maxAnnual === undefined ? Infinity : Number(t.maxAnnual);
    return annual < cap;
  }) || sorted[sorted.length - 1] || { pct: FALLBACK_FEE_PCT, maxAnnual: null, note: '' };
  let pct = Number(tier.pct);
  if (!isFinite(pct)) pct = FALLBACK_FEE_PCT;
  pct = Math.round(Math.min(MAX_PLATFORM_PCT, Math.max(MIN_PLATFORM_PCT, pct)));

  // 废弃项冲突检测：partnerSharePct 隐含的"平台抽成"与阶梯不一致时，阶梯为准并留痕。
  const legacy = Number(store.getSetting('partnerSharePct'));
  let conflict = null;
  if (isFinite(legacy) && legacy > 0) {
    const legacyPlatformPct = 100 - legacy;
    if (legacyPlatformPct !== pct) {
      conflict = { legacySharePct: legacy, legacyPlatformPct, tierPlatformPct: pct, applied: 'tier' };
    }
  }
  return { platformPct: pct, partnerPct: 100 - pct, tier, tiers, annualSettled: annual, conflict };
}

// ---- 注册合伙人：零门槛、零费用 ----
function enroll(body) {
  const name = String((body && body.name) || '').trim().slice(0, 40);
  if (!name) return { ok: false, error: '合伙人姓名/主体必填' };
  // 合规：任何形式的入门费一律拒绝（不设"加盟费"字段，因为存在即违法）
  const db = store.read();
  const exist = (db.partners || []).find(p => p.name === name);
  if (exist) return { ok: true, partner: exist, existed: true, note: '已存在，未重复创建' };
  const rec = store.push('partners', {
    name,
    contact: String((body && body.contact) || '').slice(0, 60),
    intro: String((body && body.intro) || '').slice(0, 200),
    joinedAt: Date.now(),
    status: 'active',
    paidOut: 0,      // 累计已付
    earned: 0,       // 累计已确认应得
    entryFee: 0      // 恒为 0：合规字段，用于审计"未收任何入门费"
  }, '合伙人登记（零门槛·无入门费）', name);
  store.push('audit', { action: '合规校验·合伙人注册', detail: name + '：entryFee=0（未收入门费，合法）', at: Date.now() }, null, null);
  return { ok: true, partner: rec };
}

// ---- 登记真实交付（佣金的唯一合法来源）----
// 交付必须有可核验事实：服务内容 + 交付物 + 工时。空话不算数。
function deliver(body) {
  const p = findPartner(body && body.partnerId);
  if (!p) return { ok: false, error: '合伙人不存在：' + (body && body.partnerId) };
  const what = String((body && body.what) || '').trim();
  if (!what || what.length < 4) return { ok: false, error: '必须写明真实交付内容（≥4字），佣金只认可核验的交付' };
  const hours = Number((body && body.hours) || 0);
  if (!(hours > 0)) return { ok: false, error: '必须登记交付工时（>0）' };
  const rec = store.push('deliveries', {
    partnerId: p.id,
    customer: String((body && body.customer) || '').slice(0, 60),
    what: what.slice(0, 200),
    deliverable: String((body && body.deliverable) || '').slice(0, 200),
    hours: Math.round(hours * 10) / 10,
    amount: Number((body && body.amount) || 0) || 0, // 该交付对应的成交额（真实到账金额）
    accepted: false,
    at: Date.now()
  }, '合伙人交付登记', p.name + ' · ' + what.slice(0, 40));
  return { ok: true, delivery: rec };
}

// ---- 验收交付 → 触发放盈（人工确认，防自导自演）----
function accept(deliveryId) {
  const db = store.read();
  const d = (db.deliveries || []).find(x => x.id === deliveryId);
  if (!d) return { ok: false, error: '交付记录不存在' };
  if (d.accepted) return { ok: true, already: true, delivery: d };

  const gross = Number(d.amount) || 0;
  if (!(gross > 0)) {
    // 红线：没有真实成交额 → 不估、不预支。如实标记待补。
    store.push('audit', { action: '分润·暂不计', detail: '交付 ' + deliveryId + ' 无真实成交额，不产生分润（不估算）', at: Date.now() }, null, null);
    return { ok: false, error: '未登记真实成交金额，无法计算分润（不预支、不估算）' };
  }

  const pol = feePolicy();
  const pct = pol.partnerPct;              // 合伙人分润比例（= 100 − 平台抽成）
  const share = Math.round(gross * pct) / 100;
  if (share < MIN_PAYOUT) return { ok: false, error: '分润 ¥' + share + ' 低于起付 ¥' + MIN_PAYOUT + '，不发起' };

  // 平台抽成：与 money.js 的 5% 推广预算池是**两笔不同的钱**，不要混算：
  //   platformFee = 平台服务费（阶梯，随年营收变化）
  //   promoPool   = 自留获客成本（固定 5%，已在 money.credit 里计提）
  const platformFee = Math.round((gross - share) * 100) / 100;
  if (pol.conflict) {
    store.push('audit', {
      action: '抽成口径·废弃项冲突',
      detail: 'partnerSharePct=' + pol.conflict.legacySharePct + '% 隐含平台抽 ' + pol.conflict.legacyPlatformPct +
        '%，与阶梯档位 ' + pol.conflict.tierPlatformPct + '% 冲突；按阶梯执行（该设置已废弃）',
      at: Date.now()
    }, null, null);
  }

  store.update('deliveries', deliveryId, {
    accepted: true, share, platformFee,
    partnerPct: pct, platformPct: pol.platformPct,
    feeAnnualSettled: pol.annualSettled, acceptedAt: Date.now()
  }, '交付验收·分润确认');

  const fresh = store.read();
  const p = (fresh.partners || []).find(x => x.id === d.partnerId);
  if (p) {
    p.earned = Math.round(((p.earned || 0) + share) * 100) / 100;
    fresh.partners = fresh.partners.map(x => x.id === p.id ? p : x);
    store.write(fresh);
  }
  store.push('audit', {
    action: '分润·单层结算',
    detail: '合伙人 ' + (p ? p.name : d.partnerId) + ' · 成交 ¥' + gross + ' → 平台抽 ¥' + platformFee + '（' + pol.platformPct + '%·' + (pol.tier.note || '阶梯') + '） + 合伙人分润 ¥' + share + '（' + pct + '%·单层封顶）',
    at: Date.now()
  }, null, null);
  // 经验沉淀：真实分润结果进跨公司经验库
  try { require('./lessons').add({ kind: 'win', topic: '合伙人分润·' + (p ? p.name : ''), context: '本单成交 ¥' + gross + '，工时 ' + d.hours + 'h', action: '该交付方式可复制复用（按 ' + pct + '% 分润）', why: '真实单层结算记录，非编造通则', src: 'auto', ref: 'delivery:' + deliveryId, confidence: 'medium', evidence: ['settlement:' + deliveryId + '@' + Date.now()] }); } catch (e) {}
  return {
    ok: true, share, platformFee,
    partnerPct: pct, platformPct: pol.platformPct,
    feeTier: pol.tier, feeAnnualSettled: pol.annualSettled,
    legacyConflict: pol.conflict
  };
}

// ---- 合规守卫：任何"向上抽成/多层"请求直接拒绝 ----
// 这是给未来任何人的硬护栏：即使有人想加层级计酬，这里也会 400。
function rejectMultilevel(body) {
  const bad = ['uplineId', 'parentId', 'upline', '上级', '下线业绩', '团队业绩', '层级'];
  const hit = bad.find(k => body && body[k] !== undefined && body[k] !== null && body[k] !== '');
  if (hit) {
    store.push('audit', { action: '合规拦截·拒绝多层计酬', detail: '请求含疑似层级字段「' + hit + '」，已拒绝（《禁止传销条例》第七条）', at: Date.now() }, null, null);
    return { ok: false, error: '合规红线：不允许基于下线/上级业绩计酬（属传销特征）。分润只认"该笔真实成交"的直接服务人。' };
  }
  return { ok: true };
}

// ---- 出款：只付已验收的分润 ----
function pay(partnerId) {
  const db = store.read();
  const p = (db.partners || []).find(x => x.id === partnerId);
  if (!p) return { ok: false, error: '合伙人不存在' };
  const due = Math.round(((p.earned || 0) - (p.paidOut || 0)) * 100) / 100;
  if (due < MIN_PAYOUT) return { ok: false, error: '无到期分润（应得 ¥' + (p.earned || 0) + ' - 已付 ¥' + (p.paidOut || 0) + '）' };
  // 真实现金出账走 money 模块（人工事后确认），这里只登记应付，避免自动打款风险
  store.update('partners', partnerId, { pendingPay: due }, '合伙人待出款登记');
  store.push('audit', { action: '分润·待出款', detail: p.name + ' 应得 ¥' + due + '（待人工打款确认）', at: Date.now() }, null, null);
  return { ok: true, pending: due, note: '已登记应付，真实打款请人工确认（系统不自动出款）' };
}

function markPaid(partnerId, evidence) {
  const ev = String(evidence || '').trim();
  if (!ev) return { ok: false, error: '必须提供打款凭证（流水号/截图说明）' };
  const db = store.read();
  const p = (db.partners || []).find(x => x.id === partnerId);
  if (!p) return { ok: false, error: '合伙人不存在' };
  const amt = Number(p.pendingPay) || 0;
  if (!(amt > 0)) return { ok: false, error: '无待出款金额' };
  store.update('partners', partnerId, {
    paidOut: Math.round(((p.paidOut || 0) + amt) * 100) / 100,
    pendingPay: 0, lastPaidAt: Date.now(), lastEvidence: ev.slice(0, 100)
  }, '分润出款确认');
  store.push('audit', { action: '分润·出款确认', detail: p.name + ' ¥' + amt + ' 凭证 ' + ev.slice(0, 40), at: Date.now() }, null, null);
  return { ok: true, paid: amt };
}

// 兼容旧调用点：仍返回"合伙人分润比例"，但现在由阶梯抽成推导（= 100 − 平台抽成）
function sharePct() { return feePolicy().partnerPct; }

function findPartner(id) { return (store.read().partners || []).find(x => x.id === id); }

function board() {
  const db = store.read();
  const pol = feePolicy();
  const partners = (db.partners || []).map(p => {
    const ds = (db.deliveries || []).filter(d => d.partnerId === p.id);
    return {
      id: p.id, name: p.name, status: p.status, joinedAt: p.joinedAt,
      earned: p.earned || 0, paidOut: p.paidOut || 0,
      pending: Math.round(((p.earned || 0) - (p.paidOut || 0)) * 100) / 100,
      pendingPay: p.pendingPay || 0,
      entryFee: p.entryFee || 0, // 恒为 0
      deliveries: ds.length, accepted: ds.filter(d => d.accepted).length
    };
  });
  const adPct = Number((store.getSetting('platformFee') || {}).adSpendPct) || 0;
  return {
    ok: true, partners,
    // —— 统一后的唯一口径 ——
    platformPct: pol.platformPct,          // 平台抽成（阶梯，按近 12 个月已结算实收命中）
    partnerPct: pol.partnerPct,            // 合伙人分润 = 100 − 平台抽成
    feeTier: pol.tier,
    feeTiers: pol.tiers,
    annualSettled: pol.annualSettled,
    adSpendPct: adPct,                      // 广告代管（自留成本，非抽成）
    legacyConflict: pol.conflict,           // 非空 = 设置里那个已废弃的 partnerSharePct 正在与阶梯打架
    legacyNote: pol.conflict
      ? 'settings.partnerSharePct=' + pol.conflict.legacySharePct + '% 已废弃：隐含平台抽 ' +
        pol.conflict.legacyPlatformPct + '%，与阶梯 ' + pol.conflict.tierPlatformPct +
        '% 冲突，当前按阶梯执行。要改口径请改 settings.platformFee.revenueTiers，并把 partnerSharePct 设为 0。'
      : '口径已统一：settings.platformFee.revenueTiers（阶梯）为唯一事实来源。',
    totalEarned: partners.reduce((s, p) => s + p.earned, 0),
    totalPaid: partners.reduce((s, p) => s + p.paidOut, 0),
    compliance: '单层封顶·锚定真实成交·零入门费·无层级计提',
    disclaimer: '本模块按《禁止传销条例》设计：分润只认"该笔真实成交"的直接服务人，禁止任何基于下线/团队业绩的层级计酬。'
  };
}

module.exports = {
  enroll, deliver, accept, pay, markPaid, board, rejectMultilevel,
  sharePct, feePolicy,
  DEFAULT_FEE_TIERS, FALLBACK_FEE_PCT, MIN_PLATFORM_PCT, MAX_PLATFORM_PCT
};
