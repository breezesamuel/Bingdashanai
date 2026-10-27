'use strict';
/**
 * commerce-skus.js — 丙大山AI Agent · 新变现 SKU 权威目录（增量式，不改写 live PLANS_CN）
 *
 * 来源：scripts/ops/commerce_sim.js 仿真器出的赢家配置（¥199-999 价格带、NRR>100%、
 *       expand>10%）+ docs/REVENUE-PATHS.md 路径②④⑥ + 312-micro-SaaS 数据集结论
 *       （赢家集中在 $29-49/$99-199，垂直 B2B 62%，NRR>100% 才能下"替换跑步机"）。
 *
 * 纪律（dual-brain / 零污染）：
 *   - 本模块**新增**，不原地改 core/subs.js 的 PLANS_CN 数组（那会污染活 catalog）。
 *   - register(subs) 把 SKU **push 进进程内存**里的 subs.PLANS_CN / PLANS_EN，
 *     供已武装的结账链 order→confirm→settleEffects→money.credit→activate 直接消费。
 *   - 幂等：按 id 查重，重复 register 不产生重复 SKU。
 *   - 生产接入：在站点 boot 里调一次 `require('./commerce-skus').register(require('./subs'))`
 *     即可让结账链认识这些新 SKU；不接 = 不生效（安全默认）。
 *
 * 金额口径：与 core/subs.js 的 PLANS_CN（CNY）/ PLANS_EN（USD）同构；
 *   money.credit/kpi 的 CNY 权威口径不变——这些 SKU 只是**新增可下单档位**，
 *   不改动既有 7 个 plan（t/m/q/y/p/v/s）的金额。
 */

// ── 新 SKU 目录（权威金额） ─────────────────────────────────────
// 每条 = 结账链 plan 对象同构：{ id,label,amount,currency,months,tier,en,tag }
// 一次性交付单 months:0（收钱/交付为准，不授予周期订阅）；包月 months:1。
const CATALOG = {
  cny: [
    {
      id: 'retainer', label: '代运营包月', amount: 199, currency: 'CNY', months: 1, tier: 'pro',
      en: 'Managed Automation Retainer',
      tag: '4 高频任务（线索/报价/单据/邮箱）· 客户拥有实例+JSON导出+退出条款 · 包月'
    },
    {
      id: 'vertbundle', label: '垂直交付套餐', amount: 3999, currency: 'CNY', months: 0, tier: 'sup',
      en: 'Vertical Delivery Bundle',
      tag: '行业交付·一次性验收（范围/验收/周期/退出条款）· 客户拥有交付物'
    },
    {
      id: 'whitebox', label: '决策IP白标引擎', amount: 999, currency: 'CNY', months: 1, tier: 'sup',
      en: 'Decision-IP White-Label Engine',
      tag: '机构贴牌入口（域名/LOGO/声）· 包月含 N 万次决策推演 · 数据权属归我方'
    },
    {
      id: 'addon10', label: '重耗加购×10', amount: 199, currency: 'CNY', months: 0, tier: 'basic',
      en: 'Heavy-Compute Add-on ×10',
      tag: '重耗分区用量×10 · 7 天有效 · 对齐成本护栏（分区级上限）'
    }
  ],
  usd: [
    {
      id: 'retainer', label: 'Managed Automation Retainer', amount: 39, currency: 'USD', months: 1, tier: 'pro',
      en: 'Managed Automation Retainer', tag: '4 core tasks (lead/quote/document/inbox) · you own the instance + JSON export + exit clause · monthly'
    },
    {
      id: 'vertbundle', label: 'Vertical Delivery Bundle', amount: 699, currency: 'USD', months: 0, tier: 'sup',
      en: 'Vertical Delivery Bundle', tag: 'Industry delivery · one-time acceptance (scope/acceptance/exit) · you own the deliverable'
    },
    {
      id: 'whitebox', label: 'Decision-IP White-Label Engine', amount: 199, currency: 'USD', months: 1, tier: 'sup',
      en: 'Decision-IP White-Label Engine', tag: 'Institution white-label entry (domain/logo/voice) · monthly incl. N decision runs · data stays ours'
    },
    {
      id: 'addon10', label: 'Heavy-Compute Add-on ×10', amount: 39, currency: 'USD', months: 0, tier: 'basic',
      en: 'Heavy-Compute Add-on ×10', tag: 'Heavy-section usage ×10 · 7-day valid · aligns per-section cost guardrail'
    }
  ]
};

/**
 * 把新 SKU 增量注册进 subs 模块的 in-memory 价目表（幂等，不改 live 文件）。
 * @param {object} subs core/subs.js 模块（须含 PLANS_CN / PLANS_EN 数组）
 * @returns {number} 本次新增的 SKU 数量（已存在的 id 不计）
 */
function register(subs) {
  if (!subs || !Array.isArray(subs.PLANS_CN) || !Array.isArray(subs.PLANS_EN)) {
    throw new Error('register(subs): 需要一个含 PLANS_CN/PLANS_EN 数组的 subs 模块');
  }
  let added = 0;
  for (const p of CATALOG.cny) {
    if (!subs.PLANS_CN.some(x => x.id === p.id)) { subs.PLANS_CN.push(p); added++; }
  }
  for (const p of CATALOG.usd) {
    if (!subs.PLANS_EN.some(x => x.id === p.id)) { subs.PLANS_EN.push(p); added++; }
  }
  return added;
}

module.exports = { CATALOG, register, IDS: CATALOG.cny.map(p => p.id) };
