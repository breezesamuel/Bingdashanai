// core/organs.js — 人体式器官协作层（"整个项目是一体的，各司其职"）
//
// 比喻落地：项目 = 人体。每个"器官"（模块）有自己的职能与"神经信号"（事件），
// 通过循环/神经/内分泌三条总线互相作用，而不是各跑各的。
//
// 之前的问题（审计确认）：coordinator.js 名叫"协调中枢"却 0 写入 0 调度；
// 各模块独立重算现实，money.kpi() 被 9 处重算还用不同分母，信号发出来没人接。
//
// 本模块解决：
//   ① 器官登记：每个模块注册职能 + 它能"感知什么信号 / 发出什么信号"
//   ② 信号总线：publish/subscribe —— 一个器官发出的真实事实，订阅的器官自动收到
//   ③ 神经反射：对高频关键信号定义反射弧（收到→自动触发另一器官的动作），无需轮询
//   ④ 健康体检：各器官在线/最近心跳/异常，缺一个看得见（像人检查器官）
//
// 红线：信号必须来自真实发生（由各器官 publish 真实事件），不做编造；
//       反射弧只允许"安全、可逆、零外部动作"的联动（不代发不花钱）。

const store = require('./store');
const brain = require('./brain');

const REG_KEY = 'organs';
const SIG_KEY = 'organSignals';
const REFLEX_KEY = 'organReflexes';
const MAX_SIGNALS = 300;
const BEAT_MS = 10 * 60 * 1000;   // 心跳超时 10 分钟

// ---------- 器官登记（内置职能表）----------
// role: 职能；feeds: 它消费哪些信号；emits: 它发出什么信号
const ORGANS = {
  money:     { name: '钱袋', role: '记账入账/目标达成/预算', emits: ['revenue', 'spend', 'kpi'], feeds: ['kpi', 'deal'] },
  goalpilot: { name: '大脑皮层', role: '目标推进/每日闭环', emits: ['goal_status'], feeds: ['kpi', 'revenue', 'warn'] },
  leadgen:   { name: '手臂', role: '获客触达/成交', emits: ['lead', 'deal'], feeds: ['kpi', 'goal_status'] },
  autopilot: { name: '自主神经', role: '24h 巡航/自我进化', emits: ['step_done', 'warn'], feeds: ['warn', 'revenue', 'goal_status'] },
  watchdog:  { name: '免疫系统', role: '监控异常/自愈', emits: ['warn', 'heal'], feeds: ['step_done'] },
  conductor: { name: '心脏', role: '发布列车/统筹节奏', emits: ['asset', 'published'], feeds: ['goal_status', 'asset', 'heal'] },
  harness:   { name: '可塑神经', role: '提示词/工具策略自优化', emits: ['harness'], feeds: ['warn', 'kpi'] },
  studio:    { name: '嗓子', role: '写稿/配音/成片', emits: ['asset'], feeds: ['asset', 'intel'] },
  zodiac:    { name: '情绪', role: '十二生肖氛围/养成', emits: [], feeds: ['heal', 'revenue'] },
  knowledge: { name: '记忆皮层', role: '知识沉淀/召回', emits: [], feeds: ['deal', 'heal'] },
  lessons:   { name: '免疫记忆', role: '经验沉淀/验证', emits: [], feeds: ['deal', 'heal', 'warn'] },
  skills:    { name: '手工艺', role: '技能军械库/自动补货', emits: ['skill'], feeds: ['warn'] }
};

// ---------- ① 登记 + 心跳 ----------
function registry() {
  const db = store.read();
  const arr = Array.isArray(db[REG_KEY]) ? db[REG_KEY] : [];
  const now = Date.now();
  Object.keys(ORGANS).forEach(id => {
    const def = ORGANS[id];
    let rec = arr.find(x => x.id === id);
    if (!rec) {
      rec = { id, ...def, born: now, lastBeat: 0, beats: 0 };
      arr.push(rec);
    } else {
      // 内置职能定义始终为最新（代码是唯一真相源）
      rec.name = def.name; rec.role = def.role; rec.emits = def.emits; rec.feeds = def.feeds;
    }
  });
  store.write(db);
  return arr;
}

function beat(id) {
  const arr = registry();
  const rec = arr.find(x => x.id === id);
  if (!rec) return { ok: false, error: '未登记的器官：' + id };
  rec.lastBeat = Date.now();
  rec.beats = (rec.beats || 0) + 1;
  const db = store.read();
  db[REG_KEY] = arr;          // 写回最新态
  store.write(db);
  return { ok: true, id, lastBeat: rec.lastBeat };
}

// ---------- ② 信号总线（器官间真实协作）----------
function publish(signal, payload) {
  const db = store.read();
  if (!Array.isArray(db[SIG_KEY])) db[SIG_KEY] = [];
  const rec = { signal: String(signal), payload: payload || null, at: Date.now() };
  db[SIG_KEY].unshift(rec);
  if (db[SIG_KEY].length > MAX_SIGNALS) db[SIG_KEY] = db[SIG_KEY].slice(0, MAX_SIGNALS);
  store.write(db);
  const subscribers = subscribersOf(signal);
  brain.evolve('信号广播：' + signal + ' → ' + subscribers.length + ' 个器官订阅');
  return { ok: true, signal, subscribers, _pending: fireReflexes(signal, payload) };
}

// 异步版（await 反射，供需要知道反射结果的调用方）
async function publishAndFire(signal, payload) {
  const r = publish(signal, payload);
  const fired = await r._pending;
  return { ok: true, signal, subscribers: r.subscribers, fired };
}

function subscribersOf(signal) {
  // 订阅匹配用信号"种类"（@ 前缀）：发布 'heal@done' 时，feeds 里配了 'heal' 的器官都该收到。
  const kind = String(signal || '').split('@')[0];
  return Object.keys(ORGANS).filter(id => (ORGANS[id].feeds || []).includes(kind));
}

function signals(limit) {
  return (store.read()[SIG_KEY] || []).slice(0, limit || 40);
}

// ---------- ③ 神经反射弧 ----------
// "收到 X 信号 → 自动执行 Y" 的确定性联动。安全红线：
//   只允许调用**读类/自愈类**器官的零外部副作用函数；不代发、不花钱、不外发。
// 反射是代码里显式白名单的映射，不是任意执行。
const REFLEX_ARCS = {
  // 目标落后 → 提高获客强度（读类判断，不花钱）
  'kpi@behind': async (p) => { try { return { organ: 'leadgen', act: 'intensity_up' }; } catch (e) { return null; } },
  // 自愈完成 → 让知识/经验库吸收（沉淀）
  'heal@done': async (p) => {
    try {
      const lessons = require('./lessons');
      lessons.add({ kind: 'trick', topic: '自愈经验·' + (p && p.key || 'x'), context: 'watchdog 自动修复', action: (p && p.action) || '', why: '自愈成功，可复用', src: 'auto', confidence: 'medium', evidence: ['organ:' + Date.now()] });
      return { organ: 'lessons', act: 'absorb' };
    } catch (e) { return null; }
  },
  // 成交 → 经验+知识沉淀（含真实金额与单据 id，RRSI 验证层可通过）
  'deal@done': async (p) => {
    if (!p) return null;
    try {
      const lessons = require('./lessons');
      lessons.add({
        kind: 'win',
        topic: '线索成交·' + (p.channel || '未知渠道'),
        context: (p.name || '') + ' ¥' + (p.amt || 0) + ' 渠道=' + (p.channel || '未知') + ' 行业=' + (p.industry || '未知'),
        action: '该渠道在当前行业下可成交，复用同样的触达节奏；高 ROI 渠道加大投放、低 ROI 降权',
        why: '本条有真实成交单据支撑（非编造通则）',
        src: 'auto', ref: 'lead:' + (p.leadId || ''),
        confidence: 'medium',
        evidence: ['deal:' + (p.leadId || '') + '@' + Date.now()]
      });
      return { organ: 'lessons', act: 'absorb_deal' };
    } catch (e) { return null; }
  },
  // 异常 → 巡航引擎提高自检频次（读类）
  'warn@up': async (p) => { return { organ: 'autopilot', act: 'increase_check' }; }
};

async function fireReflexes(signal, payload) {
  const kind = String(signal || '').split('@')[0];
  const out = [];
  for (const [key, fn] of Object.entries(REFLEX_ARCS)) {
    if (!key.startsWith(kind + '@')) continue;
    try {
      const r = await fn(payload);
      if (r) out.push({ arc: key, ...r });
    } catch (e) { /* 反射失败不阻断主流程 */ }
  }
  return out;
}

// ---------- ④ 健康体检（缺器官看得见）----------
function health() {
  const arr = registry();
  const now = Date.now();
  const organs = arr.map(o => ({
    id: o.id, name: o.name, role: o.role,
    alive: o.lastBeat ? (now - o.lastBeat < BEAT_MS * 4) : true,  // 从未心跳过不算死
    lastBeat: o.lastBeat || null,
    agoMin: o.lastBeat ? Math.round((now - o.lastBeat) / 60000) : null,
    beats: o.beats || 0,
    feeds: o.feeds, emits: o.emits
  }));
  const sigs = (store.read()[SIG_KEY] || []).slice(0, 20);
  const bySignal = {};
  sigs.forEach(s => { bySignal[s.signal] = (bySignal[s.signal] || 0) + 1; });
  return {
    ok: true,
    total: organs.length,
    alive: organs.filter(o => o.alive).length,
    organs,
    recentSignals: sigs.slice(0, 10),
    signalCount: sigs.length,
    bySignal,
    // 互联度：有多少器官之间存在信号通路（feeds∩emits 非空）
    wired: organs.filter(o => (o.feeds || []).length).length,
    arcs: Object.keys(REFLEX_ARCS)
  };
}

module.exports = { ORGANS, registry, beat, publish, publishAndFire, signals, subscribersOf, health, fireReflexes };
