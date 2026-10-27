// core/decision_engine.js — Colibri式决策推理引擎（"权重的JIT"应用于决策框架路由）
//
// 思想移植自 colibri（蜂鸟，JustVugg/colibri）：把大模型 MoE 的"统一内存层级+按需流式路由专家"
// 抽象到决策中心——56 个决策框架就是"专家"，用户问题就是"token"：
//   · Route   : 对本问题给全部框架打分（关键词/词组/类别热度），选出候选集（top-k 专家）
//   · Union   : 批量并集——同批次的相似问题只算一次共享关键词，避免重复读权重
//   · Place   : 分层放置——热框架常驻(top能稳定进前三)、温框架走LRU、冷框架流式计算
//   · Overlap : 预取——统计"上一问题→下一相关问题"的主题关联，提前备好后续可能命中的专家
//   · Learn   : 学习——每次路由/采纳都写 usage，固定最热专家（越用越快）、衰减退冷的固定位
//
// 与 colibri 一致的设计原则：放置只决定速度，不改变语义——概率与推荐永远来自同一套评分，
// 只是"热框架更快命中"。Brio 模式只读概率、不生成（脱胎于 colibri 只读模式）。

const store = require('./store');
const decision = require('./decision');

// —— 分层常量（类比 colibri 的 VRAM/RAM/磁盘三级）——
const TOP_HOT = 6;      // 学习型固定区容量：最热专家常驻数（类比 PIN_GB）
const LRU_CAP = 12;     // LRU 缓存容量：最近常命中专家数
const HOT_DECAY_MS = 30 * 86400000; // 固定位热度衰减周期（30天不命中自动让位）
const PREFS_CAP = 8;    // 预取主题关联缓存条数

function usage() {
  const db = store.read();
  if (!db.decision_engine) db.decision_engine = { routes: {}, lru: [], fixed: [], prefs: [], history: [] };
  return db.decision_engine;
}

// —— 标的签名：框架 id 集合（冒泡排序便于可复现比较）——
function sig(expertIds) { return expertIds.slice().sort().join(','); }

// —— 评分核心：对全部 56 个框架独立打分（复用 decision.js 导出，无副作用）——
// 关键词/词组/类别热度与 suggestV2 相同逻辑，但输出全量分（不只 top3），
// 供引擎做分层路由（colibri 的"路由器对所有专家打分，只取 top-k 激活"）。
function routeScores(topic) {
  const t = decision.cleanTopic(topic);
  if (!t) return { topic: '', scores: [] };
  const tl = t.toLowerCase();
  const pairs = decision.wordPairs(t);
  const KEYWORDS = decision.KEYWORDS || {};
  const catHot = { 战略: 1, 运营: 1, 风险: 2 };
  const scored = decision.FRAMEWORKS.map(f => {
    const hayName = (f.name + ' ' + f.cat).toLowerCase();
    const hayFull = (f.name + ' ' + f.desc + ' ' + f.cat).toLowerCase();
    let s = 0;
    (KEYWORDS[f.id] || []).forEach(k => {
      if (tl.includes(k.toLowerCase())) {
        s += (k.length <= 1 ? 1 : 4 + Math.min(6, k.length * 1.5));
        if (hayName.includes(k.toLowerCase())) s += 3;
      }
    });
    pairs.forEach(p => {
      if (hayFull.includes(p)) s += 2;
      if (hayName.includes(p)) s += 1;
    });
    if (catHot[f.cat]) s += catHot[f.cat];
    if (s > 0) return { id: f.id, name: f.name, cat: f.cat, emoji: f.emoji, score: s };
    return null;
  }).filter(Boolean);
  scored.sort((a, b) => b.score - a.score);
  return { topic: t, scores: scored };
}

// —— 主题指纹：问题做归一 → 稳定 key（用于预取关联）——
function topicKey(t) {
  return String(t || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').slice(0, 12) || 'unk';
}

// —— 记录一次路由（Learn）——
function learn(topic, expertIds, adopted) {
  const db = store.read();
  const u = db.decision_engine || (db.decision_engine = { routes: {}, lru: [], fixed: [], prefs: [], history: [] });
  const now = Date.now();
  // 1. 专家命中计数
  expertIds.forEach(id => {
    const e = u.routes[id] || { hits: 0, adopted: 0, last: 0 };
    e.hits += 1;
    if (adopted) e.adopted += 1;
    e.last = now;
    u.routes[id] = e;
  });
  // 2. LRU：最近命中的专家（同批只记一次，保持最多 LRU_CAP）
  const fresh = expertIds.filter(id => !u.lru.includes(id));
  u.lru = fresh.concat(u.lru).slice(0, LRU_CAP);
  // 3. 学习型固定：把最高"命中率×衰减后热度"的专家固定（模拟 .coli_usage 自动 pin）
  const heat = Object.keys(u.routes).map(id => {
    const e = u.routes[id];
    const age = Math.max(0, now - (e.last || 0));
    const recency = Math.max(0, 1 - age / HOT_DECAY_MS); // 30天线性衰减
    return { id, key: id, v: (e.adopted / Math.max(1, e.hits)) * 0.5 + recency * 0.5 };
  }).sort((a, b) => b.v - a.v).slice(0, TOP_HOT).map(x => x.id);
  u.fixed = heat;
  // 4. 预取关联：记录"本问题命中的专家集"签名，供下个相似问题预取
  const s = sig(expertIds);
  const nowKey = topicKey(topic);
  u.prefs = u.prefs.filter(x => x.from !== nowKey).concat({ from: nowKey, to: expertIds, at: now }).slice(-PREFS_CAP);
  // 5. 历史（节流：最多留 200 条学习记录）
  u.history.push({ topic: String(topic).slice(0, 60), experts: expertIds, adopted: !!adopted, at: now });
  if (u.history.length > 200) u.history = u.history.slice(-200);
  store.write(db); // 持久化（同一引用）
  return { fixed: u.fixed.slice(), lru: u.lru.slice() };
}

// —— 预取（Overlap）：给定问题，返回前一层已知的候选专家（关联签名命中）——
function prefetch(topic) {
  const u = usage();
  const k = topicKey(topic);
  if (!u.prefs.length) return [];
  // 精确主题 key 命中：直接取上次同主题命中的专家
  const exact = u.prefs.filter(x => x.from === k).pop();
  if (exact) return exact.to;
  // 部分匹配：取签名重叠度最高的（预取命中率的模拟）
  const tScores = routeScores(topic).scores.map(x => x.id);
  const cur = new Set(tScores);
  let best = [], bestOverlap = 0;
  u.prefs.forEach(p => {
    const ov = p.to.filter(id => cur.has(id)).length;
    if (ov > bestOverlap) { bestOverlap = ov; best = p.to; }
  });
  return best;
}

// —— Brio 只读概率：softmax 归一化全集群概率（不生成、无副作用）——
// 类比 colibri 只读概率不生成的定位；temperature 控制锐度（越低越尖）。
function brio(topic, temperature) {
  const T = (temperature === undefined) ? 1.2 : Math.max(0.1, Number(temperature));
  const s = routeScores(topic);
  if (!s.scores.length) return { topic: s.topic, matched: false, probs: [], apex: null, note: '无主题信息，无法路由——请补充具体问题。' };
  const raws = s.scores.map(x => x.score);
  const max = Math.max.apply(null, raws);
  const exps = raws.map(x => Math.exp((x - max) / T));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = s.scores.map((x, i) => ({ id: x.id, name: x.name, cat: x.cat, prob: Math.round(exps[i] / sum * 10000) / 100 }));
  probs.sort((a, b) => b.prob - a.prob);
  const apex = probs[0];
  const aggregate = probs.slice(0, 3).reduce((a, b) => a + b.prob, 0);
  return {
    topic: s.topic, matched: apex.prob > 0, probs, apex,
    apexAggregate: Math.round(aggregate * 100) / 100,
    temperature: T,
    note: 'Brio 只读模式：仅给出全框架路由概率分布，不生成决策内容。' +
      (apex.prob > 0 ? ' 本问题最可能路由到「' + apex.name + '」（' + apex.prob + '%），前三合计 ' + Math.round(aggregate) + '%。' : '')
  };
}

// —— 完整推理：五步流水线（Route→Union→Place→Overlap→Learn）——
function infer(topic, opts) {
  const o = opts || {};
  const t = String(topic || '').trim();
  if (!t) return { ok: false, error: 'topic 必填' };
  const u = usage();

  // 1) Route：全框架打分，取 top-k（k=6 或用户指定）
  const k = Math.min(10, Math.max(2, Number(o.k) || 6));
  const scored = routeScores(t);
  const experts = scored.scores.slice(0, k).map(x => x.id);

  // 2) Union：批量并集——把预取集与当前命中并集（去重），模拟"同批不重复读权重"
  const prefetchSet = o.usePrefetch !== false ? prefetch(t) : [];
  const union = [];
  experts.forEach(id => { if (!union.includes(id)) union.push(id); });
  prefetchSet.forEach(id => { if (!union.includes(id) && union.length < k + 3) union.push(id); });

  // 3) Place：分层——进候选的专家按热度分三层
  const fixed = u.fixed || [];
  const lru = u.lru || [];
  const layered = union.map(id => {
    const f = decision.FRAMEWORKS.find(x => x.id === id);
    let tier = 'cold';
    if (fixed.includes(id)) tier = 'hot';          // 学习型固定（常驻）
    else if (lru.includes(id)) tier = 'warm';       // LRU 缓存
    return { id, name: f && f.name, cat: f && f.cat, tier, hot: fixed.includes(id), fixed: fixed.includes(id) };
  });
  const tierRank = { hot: 0, warm: 1, cold: 2 };
  layered.sort((a, b) => tierRank[a.tier] - tierRank[b.tier]);

  // 4) Overlap 指标：本次预取命中了多少
  const overlap = prefetchSet.filter(id => experts.includes(id)).length;
  const predict = prefetchSet.length ? Math.round(overlap / prefetchSet.length * 100) : 0;

  // 5) Learn：记录路由（采纳 = 推荐命中 top1）
  learn(t, experts, true);

  const top1 = experts[0];
  const fTop = decision.FRAMEWORKS.find(x => x.id === top1);
  return {
    ok: true, topic: scored.topic, apex: top1, apexName: fTop && fTop.name,
    experts, union, layered, prefetched: prefetchSet, overlap,
    predict: predict + '%', fixed: u.fixed.slice(), lru: u.lru.slice(), ts: Date.now(),
    adopted: true, engine: 'infer:' + top1
  };
}

// —— 宏观状态：热度图谱（Brain 页数据源）——
function graph() {
  const u = usage();
  const raw = Object.keys(u.routes).map(id => {
    const e = u.routes[id];
    const f = decision.FRAMEWORKS.find(x => x.id === id);
    return { id, name: f ? f.name : id, cat: f ? f.cat : '?', hits: e.hits, adopted: e.adopted, last: e.last, rate: Math.round(e.adopted / Math.max(1, e.hits) * 100) };
  }).sort((a, b) => b.hits - a.hits);
  return {
    totalExperts: decision.FRAMEWORKS.length,
    exposed: raw.length,
    fixedTop: (u.fixed || []).slice(),
    lruCache: (u.lru || []).slice(),
    experts: raw.slice(0, 200),
    heat: raw.slice(0, TOP_HOT).map(r => ({ id: r.id, name: r.name, hits: r.hits, rate: r.rate })),
    cold: raw.filter(r => r.hits === 1).length,
    prefsCount: (u.prefs || []).length,
    pins: (u.fixed || []).length
  };
}

module.exports = { routeScores, brio, infer, prefetch, learn, graph, usage, topicKey, sig };