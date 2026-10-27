// core/cost.js — LLM 成本记账（让毛利可见）
//
// 【为什么必须有】收入侧是精确的（money.credit 幂等记账），但**成本侧是黑的**：
// 站点调 LLM 的地方不少（agents / agentmesh / studio / game / harness / 报告 …），
// 而 providers.chat 连 usage 都没读 → 用多少 token、花多少钱**完全不知道** →
// 毛利是黑箱，"这单赚不赚钱"只能靠感觉。
//
// 【诚实原则】
//   · 单价是**估算表**（每百万 token，人民币），必须标注"估算，需按实际账单校准"；
//   · 没拿到 usage 就不编数字（记 calls、tokens=null、cny=null）；
//   · 成本**只进成本台账**，绝不混进 revenue（收入口径不许被污染）。
const store = require('./store');

// 估算单价（元 / 百万 token）：{ 输入, 输出 }
// 【可校准】运营拿到真实账单后，用 settings.costPrices 覆盖（{providerId:{in,out}}）即可，
// 不必改代码 —— 估算表必须能随实际账单修正，否则"毛利"永远只是猜测。
const DEFAULT_PRICES = {
  deepseek: { in: 2, out: 8, note: 'deepseek-chat 估算' },
  zhipu: { in: 1, out: 5, note: 'glm-4-plus 估算' },
  // 同一家供应商不同模型价格可能差 10 倍以上：支持 provider:model 精确覆盖。
  'zhipu:glm-4-flash': { in: 0, out: 0, note: 'GLM-4-Flash 官方免费（2026-10 实测可用）' },
  moonshot: { in: 4, out: 12, note: 'moonshot-v1 估算' },
  minimax: { in: 1, out: 4, note: 'minimax-chat 估算' },
  siliconflow: { in: 1.5, out: 4.5, note: 'siliconflow 混合模型估算' },
  nvidia: { in: 1, out: 3, note: 'nvidia nim 估算' },
  volcengine: { in: 0.8, out: 2, note: 'doubao-pro 估算' },
  ark: { in: 0.8, out: 2, note: 'doubao-pro 估算（火山方舟别名）' },
  // 价格未知就不编 0：unknown=true → cny=null → 不进"已定价调用"，毛利保持"不可计算"
  agnes: { in: 0, out: 0, unknown: true, note: '价格未知（当前走免费额度；429 限流），不计金额' },
};
const PRICES = (() => {
  const out = Object.assign({}, DEFAULT_PRICES);
  try {
    const ov = store.getSetting('costPrices');
    if (ov && typeof ov === 'object') {
      for (const k of Object.keys(ov)) {
        const v = ov[k];
        if (v && typeof v === 'object' && (v.in != null || v.out != null)) {
          out[k] = { in: Number(v.in) || 0, out: Number(v.out) || 0, unknown: !!v.unknown, note: v.note || '运营自定义' };
        }
      }
    }
  } catch (e) { /* 读不到就用默认表 */ }
  return out;
})();
const DEFAULT_PRICE = { in: 0, out: 0, note: '未知供应商，按 0 记（宁可低估也不虚报）' };
const MAX_ROWS = 2000;

function priceOf(provider, model) {
  const k = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  if (m && PRICES[k + ':' + m]) return PRICES[k + ':' + m];
  // provider:model 键只用于精确匹配，不能参与 includes（否则 'zhipu' 会命中所有 zhipu:*）
  for (const key of Object.keys(PRICES)) {
    if (key.indexOf(':') >= 0) continue;
    if (k.indexOf(key) >= 0) return PRICES[key];
  }
  return DEFAULT_PRICE;
}

/**
 * 估算一次调用的成本。
 * @param {string} provider
 * @param {object} usage 网关返回的 usage（{prompt_tokens, completion_tokens, total_tokens}）
 * @returns {{promptTokens:number|null, completionTokens:number|null, totalTokens:number|null, cny:number|null, price:object}}
 */
function estimate(provider, usage, model) {
  const u = usage || null;
  const pin = u && Number(u.prompt_tokens || u.input_tokens || 0) > 0 ? Number(u.prompt_tokens || u.input_tokens) : null;
  const pout = u && Number(u.completion_tokens || u.output_tokens || 0) > 0 ? Number(u.completion_tokens || u.output_tokens) : null;
  const total = u && Number(u.total_tokens || 0) > 0 ? Number(u.total_tokens) : (pin != null || pout != null ? (pin || 0) + (pout || 0) : null);
  const price = priceOf(provider, model);
  let cny = null;
  if (!price.unknown && (pin != null || pout != null)) {
    cny = Math.round(((pin || 0) / 1e6 * price.in + (pout || 0) / 1e6 * price.out) * 10000) / 10000;
  }
  return { promptTokens: pin, completionTokens: pout, totalTokens: total, cny, price };
}

/**
 * 记一笔调用（进成本台账 llmUsage，不进 revenue）。
 * @param {object} o {provider, model, usage, purpose, visitor, ms}
 */
function record(o) {
  const x = o || {};
  const est = estimate(x.provider, x.usage, x.model);
  const row = {
    provider: String(x.provider || ''), model: String(x.model || ''),
    purpose: String(x.purpose || '').slice(0, 40),
    visitor: String(x.visitor || '').slice(0, 64),
    promptTokens: est.promptTokens, completionTokens: est.completionTokens, totalTokens: est.totalTokens,
    cny: est.cny, priceNote: est.price.note,
    ms: Number(x.ms || 0) || null,
    at: Date.now(),
  };
  try { store.push('llmUsage', row, 'LLM 调用', (row.provider || '') + ' ' + (row.purpose || '')); } catch (e) {}
  return row;
}

/** 成本汇总（默认近 30 天） */
function summary(sinceMs) {
  const from = Number(sinceMs) || (Date.now() - 30 * 86400000);
  let rows = [];
  try { rows = store.list('llmUsage', MAX_ROWS).filter((r) => r && Number(r.at || 0) >= from); } catch (e) { rows = []; }
  const byProvider = {};
  let tokens = 0, cny = 0, priced = 0, calls = rows.length;
  for (const r of rows) {
    const p = r.provider || 'unknown';
    if (!byProvider[p]) byProvider[p] = { calls: 0, tokens: 0, cny: 0 };
    byProvider[p].calls++;
    if (r.totalTokens != null) { byProvider[p].tokens += Number(r.totalTokens) || 0; tokens += Number(r.totalTokens) || 0; }
    if (r.cny != null) { byProvider[p].cny += Number(r.cny) || 0; cny += Number(r.cny) || 0; priced++; }
  }
  return {
    calls, tokens, cny: Math.round(cny * 10000) / 10000, pricedCalls: priced,
    byProvider, since: from,
    note: '成本为**估算**（单价表见 core/cost.js，需按实际账单校准）；未取到 usage 的调用不计入金额',
  };
}

module.exports = { PRICES, estimate, record, summary, MAX_ROWS };
