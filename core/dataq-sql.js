// core/dataq-sql.js — 通用智能问数（Text-to-SQL-lite，对标 SQLBot 范式）
//
// 【与 dataq.js 的分工】
//   · dataq.js   = 固定 12 意图的「预设问法」层（关键词路由 → 现成聚合器，零 LLM、最快最稳）
//   · dataq-sql.js = 「通用问法」层：任意 NL 问题 → LLM 生成受限查询计划 → 白名单校验 →
//     在 JSON store 上只读安全执行。这是 SQLBot 的核心价值（Text-to-SQL），但我们
//     **不引入它的独立全栈 / SQL 底座**（与全仓零 native 依赖 + Electron 打包纪律冲突）。
//
// 【安全设计（与全仓「无 1 条真实记录」纪律一致）】
//   · 不走 SQL 引擎：查询计划是受限 JSON（白名单 op/字段/聚合函数），**无 SQL 注入面**
//   · 反幻觉闸：collection/字段/聚合函数必须真实存在于 store 采样 schema，LLM 幻觉出的
//     字段一律拒绝执行——对应 SQLBot 提示词约束「只使用给定表字段，不做任意假设」
//   · 全程只读：执行器只调 store.list/read，绝不写；limit 强制 clamp 防全量 dump
//   · 无 LLM 时回落 dataq.js 的 12 意图（永远有答案，不脑补）
//   · 口径透明：聚合查询返回结果时标注 collection + 过滤条件 + 口径说明（对应 SQLBot
//     「聚合查询需说明口径」）

'use strict';
const store = require('./store');
function safe(fn, fb) { try { const r = fn(); return r == null ? fb : r; } catch (e) { return fb; } }

// 聚合函数白名单（对应 SQLBot 的聚合口径约束）
const AGG_FNS = new Set(['count', 'sum', 'avg', 'min', 'max', 'distinct', 'count_distinct']);
// 过滤算子白名单
const FILTER_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'like']);
// 单集合最多给 LLM 的字段数 / 样例数（控制上下文长度）
const SCHEMA_FIELD_CAP = 16;
const SAMPLE_CAP = 20;
const LIMIT_MAX = 100;

// ---- 1) schema 自省：采样推断各集合字段 + 类型（LLM 的「表结构」）----
function describe(opt) {
  const db = safe(() => store.read(), null);
  if (!db) return {};
  const out = {};
  for (const key of Object.keys(db)) {
    const v = db[key];
    if (Array.isArray(v)) {
      const sample = v.slice(-SAMPLE_CAP);
      const fieldCount = {};
      sample.forEach(r => { if (r && typeof r === 'object') Object.keys(r).forEach(f => { fieldCount[f] = (fieldCount[f] || 0) + 1; }); });
      const fields = Object.entries(fieldCount)
        .map(([name, c]) => ({ name, coverage: Math.round(c * 100 / Math.max(1, sample.length)), type: inferType(v, name) }))
        .filter(f => f.coverage >= 30)
        .sort((a, b) => b.coverage - a.coverage)
        .slice(0, opt && opt.fieldCap ? opt.fieldCap : SCHEMA_FIELD_CAP);
      out[key] = { rows: v.length, fields };
    } else if (v && typeof v === 'object') {
      out[key] = { rows: Object.keys(v).length, fields: Object.keys(v).slice(0, SCHEMA_FIELD_CAP).map(n => ({ name: n, coverage: 100, type: 'scalar' })) };
    }
  }
  return out;
}
function inferType(arr, field) {
  for (const r of arr) {
    if (r && typeof r === 'object' && field in r) {
      const t = typeof r[field];
      if (t === 'number') return 'number';
      if (Array.isArray(r[field])) return 'array';
      if (r[field] && typeof r[field] === 'object') return 'object';
      if (r[field] != null) return 'string';
    }
  }
  return 'any';
}

// 紧凑 schema（喂给 LLM）
function schemaForLlm() {
  const d = describe();
  const lines = [];
  for (const k of Object.keys(d)) {
    lines.push(k + '(' + d[k].rows + '行): ' + d[k].fields.map(f => f.name + ':' + f.type).join(', '));
  }
  return lines.join('\n');
}

// ---- 2) 反幻觉闸：校验 LLM 生成的查询计划 ----
function validate(plan) {
  const errs = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['计划非对象'] };
  const schema = describe();
  if (!plan.collection || !schema[plan.collection]) errs.push('collection "' + (plan.collection || '?') + '" 不存在于 store（可用：' + Object.keys(schema).join('/') + '）');
  else {
    const validFields = new Set(schema[plan.collection].fields.map(f => f.name));
    validFields.add('id'); validFields.add('createdAt'); // 隐式字段
    (plan.filters || []).forEach((f, i) => {
      if (!f.field || !validFields.has(f.field)) errs.push('filter[' + i + '].字段 "' + (f.field || '?') + '" 不存在');
      if (f.op && !FILTER_OPS.has(f.op)) errs.push('filter[' + i + '].算子 "' + f.op + '" 不在白名单（' + [...FILTER_OPS].join('/') + '）');
    });
    if (plan.groupBy && !validFields.has(plan.groupBy)) errs.push('groupBy 字段 "' + plan.groupBy + '" 不存在');
    if (plan.aggregate) {
      if (!AGG_FNS.has(plan.aggregate.fn)) errs.push('aggregate.fn "' + plan.aggregate.fn + '" 不在白名单（' + [...AGG_FNS].join('/') + '）');
      if (plan.aggregate.field && plan.aggregate.fn !== 'count' && !validFields.has(plan.aggregate.field)) errs.push('aggregate.字段 "' + plan.aggregate.field + '" 不存在');
    }
    if (plan.orderBy && plan.orderBy.field && !validFields.has(plan.orderBy.field)) errs.push('orderBy.字段 "' + plan.orderBy.field + '" 不存在');
  }
  if (errs.length) return { ok: false, errors: errs, plan };
  // 通过 → clamp limit
  const p = JSON.parse(JSON.stringify(plan));
  p.limit = Math.min(LIMIT_MAX, Math.max(1, Number(p.limit) || 20));
  p.filters = (p.filters || []).filter(f => f && f.field);
  return { ok: true, plan: p };
}

// ---- 3) 只读安全执行器（纯读 + 白名单算子 + 强制 limit）----
function execute(plan) {
  const v = validate(plan);
  if (!v.ok) return { ok: false, error: '查询计划未通过反幻觉闸：' + v.errors.join('；') + '（拒绝执行，绝不编数）', plan, errors: v.errors };
  const p = v.plan;
  const rows = store.list(p.collection, Infinity).slice(); // 全量取回内存（1.4MB 库可接受），绝不写
  // 过滤
  let out = rows;
  for (const f of p.filters) {
    out = out.filter(r => {
      const val = r ? r[f.field] : undefined;
      switch (f.op || 'eq') {
        case 'eq': return val === f.value;
        case 'ne': return val !== f.value;
        case 'gt': return val > f.value;
        case 'gte': return val >= f.value;
        case 'lt': return val < f.value;
        case 'lte': return val <= f.value;
        case 'in': return Array.isArray(f.value) && f.value.includes(val);
        case 'contains': return typeof val === 'string' && val.toLowerCase().includes(String(f.value).toLowerCase());
        case 'like': return typeof val === 'string' && new RegExp(String(f.value), 'i').test(val);
        default: return true;
      }
    });
  }
  const totalAfterFilter = out.length;
  // 聚合
  if (p.aggregate && p.aggregate.fn) {
    const fn = p.aggregate.fn;
    const field = p.aggregate.field;
    if (p.groupBy) {
      const groups = {};
      out.forEach(r => { const g = r ? String(r[p.groupBy]) : 'null'; (groups[g] = groups[g] || []).push(r); });
      const agg = Object.keys(groups).map(g => {
        const arr = groups[g];
        return { group: g, value: applyAgg(fn, field, arr), n: arr.length };
      }).sort((a, b) => b.n - a.n);
      return finish({ collection: p.collection, mode: 'group', totalAfterFilter, result: agg.slice(0, p.limit), resultCount: agg.length });
    }
    return finish({ collection: p.collection, mode: 'scalar', totalAfterFilter, result: [{ value: applyAgg(fn, field, out), n: out.length }] });
  }
  // 排序 + 投影 + limit
  if (p.orderBy && p.orderBy.field) {
    const dir = p.orderBy.dir === 'asc' ? 1 : -1;
    out = out.slice().sort((a, b) => { const x = a ? a[p.orderBy.field] : 0, y = b ? b[p.orderBy.field] : 0; return (x > y ? 1 : x < y ? -1 : 0) * dir; });
  }
  const projected = p.fields && p.fields.length ? out.map(r => { const o = {}; p.fields.forEach(f => { o[f] = r ? r[f] : undefined; }); return o; }) : out;
  return finish({ collection: p.collection, mode: 'list', totalAfterFilter: out.length, result: projected.slice(0, p.limit), resultCount: out.length });
}
function applyAgg(fn, field, arr) {
  if (fn === 'count') return arr.length;
  if (fn === 'distinct') return new Set(arr.map(r => r && r[field]).filter(v => v != null)).size;
  if (fn === 'count_distinct') return new Set(arr.map(r => r && (r[field] != null ? r[field] : r.id))).size;
  const nums = arr.map(r => r && Number(r[field])).filter(n => isFinite(n));
  if (!nums.length) return null;
  if (fn === 'sum') return Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100;
  if (fn === 'avg') return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 100) / 100;
  if (fn === 'min') return Math.min.apply(null, nums);
  if (fn === 'max') return Math.max.apply(null, nums);
  return null;
}
function finish(run) {
  run.ok = true;
  run.chart = makeChart(run);
  run.口径 = 'collection=' + run.collection + '｜模式=' + run.mode + '｜过滤后 ' + run.totalAfterFilter + ' 行' + (run.resultCount != null && run.resultCount !== run.totalAfterFilter ? '｜展示 ' + run.resultCount : '') + '｜只读（未写任何数据）';
  return run;
}
function makeChart(run) {
  if (run.mode === 'group' && run.result.length) {
    return { type: 'bar', data: { labels: run.result.map(r => String(r.group)), datasets: [{ label: 'value', data: run.result.map(r => r.value == null ? 0 : r.value), backgroundColor: '#38a169', borderRadius: 4 }] }, options: { responsive: true, plugins: { legend: { display: false } } } };
  }
  if (run.mode === 'scalar' && run.result.length) {
    return { type: 'metric', items: [{ label: '值', value: run.result[0].value }] };
  }
  return null;
}

// ---- 4) LLM 生成查询计划（喂 schema + 反幻觉约束），解析 JSON ----
const PLAN_SYSTEM = '你是资深数据分析师，把业务问题转成对数据仓库的受限 JSON 查询计划。只使用给定表(集合)与字段，不做任意假设。' +
  '聚合查询必须注明口径。输出**仅**一个 JSON 对象，字段：' +
  '{collection, filters:[{field,op,value}], groupBy?, aggregate?:{fn,field}, orderBy?:{field,dir}, limit, fields?}。' +
  '算子 op∈' + [...FILTER_OPS] + '；聚合 fn∈' + [...AGG_FNS] + '。无聚合/分组时给 fields 投影 + orderBy + limit。不要输出 JSON 以外内容。';

function parsePlan(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { return null; }
}

// 通用问数入口：LLM 生成计划 → 校验执行；无 LLM/LLM 失败 → 回落 dataq 固定意图。
// 参数 mockLlm(question, schemaText)→content 可注入（测试/离线用）；真实走 free-tier.chat。
async function ask(question, opt) {
  const o = opt || {};
  const schemaText = schemaForLlm();
  let llm = null;
  if (o.mockLlm) llm = await o.mockLlm(question, schemaText);
  else if (o.noLlm) llm = null;
  else {
    try {
      const ft = safe(() => require('./free-tier'), null);
      if (ft && ft.chat) llm = await ft.chat({ messages: [
        { role: 'system', content: PLAN_SYSTEM + '\n\n数据仓库 schema：\n' + schemaText },
        { role: 'user', content: String(question || '') }
      ], temperature: 0.1, tier: o.tier });
    } catch (e) { llm = null; }
  }
  let plan = llm && llm.ok ? parsePlan(llm.content) : null;
  if (plan) {
    const run = execute(plan);
    if (run.ok) return {
      ok: true, source: 'llm', llmProvider: llm.provider || null, plan,
      answer: summarize(run, question),
      result: run.result, chart: run.chart, 口径: run.口径,
      honesty: '通用 Text-to-SQL-lite：LLM 生成受限查询计划 → 白名单反幻觉闸 → JSON store 只读执行；非 SQL 引擎，无注入面。'
    };
    // LLM 计划未过闸 → 如实告知 + 回落固定意图（不脑补）
    const fallback = safe(() => require('./dataq').ask(question), {});
    return {
      ok: true, source: 'fallback', reason: run.error, planRejected: plan,
      answer: '通用层拒绝了 LLM 的查询计划（' + (run.errors || []).slice(0, 2).join('；') + '），已回落到预设问法：' + (fallback.answer || '（无匹配）'),
      result: null, chart: fallback.chart || null, canAnswer: fallback.canAnswer || [],
      honesty: '反幻觉闸拦截 LLM 幻觉字段，回落固定 12 意图；不编数。'
    };
  }
  // 无 LLM 结果 → 回落
  const fb = safe(() => require('./dataq').ask(question), { answer: '无法解析' });
  return { ok: true, source: 'fallback', reason: 'LLM 未产出有效计划（无可用免费通道或输出不可解析）', answer: fb.answer, result: null, chart: fb.chart || null, canAnswer: fb.canAnswer || [], llm: llm && { ok: llm.ok, error: llm.error, tried: (llm.tried || []).length }, honesty: '无 LLM 时回落固定 12 意图，不脑补。' };
}
function summarize(run, question) {
  if (run.mode === 'scalar') return '「' + question + '」→ ' + run.result[0].value + '（' + run.口径 + '）';
  if (run.mode === 'group') return '「' + question + '」→ ' + run.result.slice(0, 5).map(r => r.group + '=' + r.value).join('，') + (run.result.length > 5 ? '…共 ' + run.resultCount + ' 组' : '') + '（' + run.口径 + '）';
  return '「' + question + '」→ ' + run.totalAfterFilter + ' 行，前 ' + run.result.length + '：' + JSON.stringify(run.result.slice(0, 3)).slice(0, 120) + '（' + run.口径 + '）';
}

// 面板：schema + 能力说明（只读）
function board() {
  const d = describe();
  return {
    ok: true, at: Date.now(),
    collections: Object.keys(d).map(k => ({ collection: k, rows: d[k].rows, fields: d[k].fields.map(f => f.name) })),
    howto: 'POST /v1/dataq-sql/ask {question:"…"}；LLM 生成受限查询计划→反幻觉闸→只读执行→答案+图表；无 LLM 回落 dataq 12 意图',
    safety: '不走 SQL 引擎（无注入面）；collection/字段/聚合函数全部白名单校验；全程只读；limit≤' + LIMIT_MAX,
    honesty: 'LLM 幻觉字段会被闸拦截并回落，不编数；口径随每个结果显式标注。'
  };
}

module.exports = { describe, schemaForLlm, validate, execute, ask, board, AGG_FNS, FILTER_OPS };
