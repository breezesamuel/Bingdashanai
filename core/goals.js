// core/goals.js — 目标任务中心（第 16 条需求）
//
// 【需求原文】"半年千万kpi是项目的暂定目标名称可以改为目标任务，是所有功能模块程序的
//             最核心指导目标，可以设立指导目标的添加窗口实现多样化"
//
// 【为什么要单独抽一个模块，而不是继续用 annual.js 里的硬编码常量】
// 原先 annual.js 里 `annual()` 直接把"半年 1000 万"写死在函数体中。后果是：
//   1. 用户改不了目标 —— 名字叫"暂定目标"，但实际上没有暂定不暂定的区别；
//   2. 只能有一条目标 —— 需求明确要求"多样化"，多条目标无处安放；
//   3. 别的模块读不到它 —— conductor / autopilot / goalpilot 各自算各自的 KPI，
//      全局没有一个"最核心指导目标"可对齐，模块之间会朝不同方向使劲。
//
// 本模块把目标变成**数据**，放在 settings.goals 里：
//   - 多条并存，每条有 id / 标题 / 目标值 / 单位 / 周期；
//   - 其中一条是 primary（核心目标），conductor、autopilot、goalpilot 统一读它；
//   - 不再设 primary 时自动把第一条提升为核心，避免"有目标但没人认领"的空转。
//
// 兼容性：老库没有 settings.goals 时，primary() 会返回一个由旧常量构造的默认目标，
// 保证升级后指挥塔/目标引擎不会因为拿不到目标而报错或归零。

const store = require('./store');
const money = require('./money');

const DEFAULT_GOAL = {
  id: 'default-annual',
  title: '半年营收 1000 万',
  target: 10000000,
  unit: 'CNY',
  period: 'P6M',
  primary: true,
  builtin: true,          // 内置项：可以改，但不允许误删导致无处对齐
  createdAt: 0,
  startedAt: 0            // 0 = 未单独设定，回落到全局 goalStartedAt / 自今天起算
};

function all() {
  const db = store.read();
  const list = Array.isArray(db.settings && db.settings.goals) ? db.settings.goals.slice() : [];
  if (!list.length) {
    // 旧库 / 首次启动：补一条内置核心目标，让所有引擎立刻有准绳
    list.push(Object.assign({}, DEFAULT_GOAL));
    save(list);
  }
  // 保证恰好有一个 primary：多���标记时取最早一条，零标记时提升第一条
  const prim = list.filter(g => g.primary);
  if (prim.length !== 1) {
    const keep = prim[0] || list[0];
    list.forEach(g => { g.primary = (g === keep); });
    save(list);
  }
  return list;
}

function save(list) {
  // 【踩坑记录】最初这里写的是 store.update(s => { s.goals = list; })，
  // 以为 store.update 接受回调。实际签名是 update(key, id, patch, action)
  // ——按 id 更新**顶层数组**元素。传函数进去后 db[fn] 是 undefined，
  // findIndex 直接返回 -1，函数静默 return null。
  // 后果：三条目标全部没落盘，而 all() 每次又补一条内置默认，
  // 表面上"始终有 1 条目标"，实际用户加的永远存不住。
  // 现在走 setSetting——它才是写 settings 子键的正路。
  store.setSetting('goals', list);
}

function primary() {
  return all().find(g => g.primary) || all()[0];
}

function add(input) {
  const list = all();
  const g = {
    id: store.uid(),
    title: String((input && input.title) || '').trim() || '未命名目标',
    target: Number(input && input.target) || 0,
    unit: String((input && input.unit) || 'CNY'),
  period: String((input && input.period) || 'P6M'),
    primary: !!(input && input.primary) || list.length === 0,
    builtin: false,
    createdAt: Date.now(),
    startedAt: Number(input && input.startedAt) || (Number(store.read().settings && store.read().settings.goalStartedAt) > 0 ? 0 : Date.now())
  };
  if (g.primary) list.forEach(x => { x.primary = false; });
  list.push(g);
  save(list);
  store.push('audit', { action: '新增目标任务', detail: g.title + (g.target ? ' · 目标 ' + g.target : ''), at: Date.now() });
  return g;
}

// 只允许提升已存在的目标为核心；不提供"取消核心"，因为那样系统就没有准绳了
function setPrimary(id) {
  const list = all();
  if (!list.some(g => g.id === id)) return null;
  list.forEach(g => { g.primary = (g.id === id); });
  save(list);
  return primary();
}

function remove(id) {
  const list = all();
  const hit = list.find(g => g.id === id);
  if (!hit) return false;
  if (hit.builtin) return { ok: false, reason: 'builtin' };   // 内置核心目标不可删
  const wasPrimary = hit.primary;
  const rest = list.filter(g => g.id !== id);
  if (wasPrimary && rest.length) rest[0].primary = true;       // 核心被删时自动顶上
  save(rest);
  return { ok: true };
}

// —— 给各引擎用的对齐信息：距核心目标还差多少、进度多少 ——
// conductor / autopilot / goalpilot 都调它，保证全系统朝同一个数字使劲。
function alignment() {
  const g = primary();
  if (!g) return { ok: false, reason: 'no-goal' };
  const target = Number(g.target) || 0;
  // 已结算实收才算数：未到账的挂单不能拿来"完成"目标，否则目标会虚高
  // 【口径统一·2026-10】自测单不算营收，与 money.kpi() 保持一致：
  // 否则 conductor/autopilot/goalpilot 会拿本机联调测试钱当完成度去追 1000 万。
  const _odb = store.read();
  const _obyId = new Map((_odb.orders || []).map(o => [String(o.id), o]));
  const revenue = (_odb.revenue || [])
    .filter(r => money.isSettled(r) && !money.isSelfTest(r, _obyId))
    .reduce((a, r) => a + Number(r.amt || r.amount || 0), 0);
  const pct = target > 0 ? Math.min(100, Math.round((revenue / target) * 1000) / 10) : 0;
  return {
    ok: true,
    id: g.id, title: g.title, target, unit: g.unit, period: g.period,
    revenue, pct,
    remain: Math.max(0, target - revenue),
    // 还剩多少天（按周期折算），让引擎知道该加速还是该稳
    daysLeft: daysLeftOf(g.period, g)
  };
}

// —— 追赶节奏：把目标变成"今天该做多少"——
// 【为什么必须补这个】需求原文说目标"是所有功能模块程序的最核心指导目标"。
// 但 alignment() 只给出 pct / remain / daysLeft，界面上就只显示一个百分比。
// 问题是**百分比不指导行动**：还差 1000 万、剩 180 天 → 到底该加速多少？
// 没有这个换算，目标就只是墙上的一句话，指挥塔 / autopilot / goalpilot
// 也无从据此排优先级——"指导"落不到具体动作上。
//
// 所以这里算 pace（每日需新增），并与"匀速本应完成多少"对比，给出
// 落后 / 领先 / 同步 三种结论。口径诚实：
//   · 目标值为 0 → 无法折算，如实报 computable:false，不编数字；
//   · 剩余天数为 0 → 报 overdue，而不是除零得到 Infinity；
//   · 没设过 goalStartedAt → 按"周期自今天起算"，并在 note 里说明。
function pace(opt) {
  const a = alignment();
  if (!a || !a.ok) return { ok: false, computable: false, reason: (a && a.reason) || 'no-goal' };
  const target = Number(a.target) || 0;
  const revenue = Number(a.revenue) || 0;
  const remain = Math.max(0, target - revenue);
  const daysLeft = a.daysLeft;
  const db = store.read();
  const started = Number((db.settings && db.settings.goalStartedAt)) || 0;
  // 起算日优先级：主目标 startedAt > 全局 goalStartedAt > 0
  const gPrim = primary();
  const startedEff = Number((gPrim && gPrim.startedAt) > 0 ? gPrim.startedAt : started) || 0;
  const from = Number(startedEff) || Date.now();
  const total = periodDaysOf(a.period);
  const used = startedEff ? Math.max(0, Math.floor((Date.now() - startedEff) / 86400000)) : 0;
  const elapsed = Math.max(0, Math.min(total, total - daysLeft));

  const base = {
    ok: true, id: a.id, title: a.title, unit: a.unit, period: a.period,
    target, revenue, remain, daysLeft, pct: a.pct,
    periodDays: total, elapsedDays: elapsed,
    startedFromInstall: !startedEff
  };

  if (target <= 0) {
    return Object.assign(base, {
      computable: false, reason: 'no-target-value', dailyNeed: null,
      note: '核心目标未填目标值，只是一个方向性标题，无法折算每日配额。'
    });
  }
  if (revenue >= target) {
    return Object.assign(base, {
      computable: true, status: 'reached', dailyNeed: 0,
      expectedPct: 100, gapPct: 0,
      note: '已达成核心目标：已结算 ' + Math.round(revenue) + ' ' + a.unit + ' ≥ 目标 ' + target + ' ' + a.unit + '。'
    });
  }
  if (daysLeft <= 0) {
    return Object.assign(base, {
      computable: true, status: 'overdue', dailyNeed: null,
      expectedPct: 100, gapPct: Math.round((100 - a.pct) * 10) / 10,
      note: '周期已到期，仍差 ' + Math.round(remain) + ' ' + a.unit + '（完成 ' + a.pct + '%）。需重设周期或追加目标。'
    });
  }
  const dailyNeed = remain / daysLeft;
  const expectedPct = total > 0 ? Math.round(elapsed / total * 1000) / 10 : 0;
  const gapPct = Math.round((expectedPct - a.pct) * 10) / 10;
  // 差 3 个百分点以内算同步：小差距天天报警等于没报警
  const status = gapPct > 3 ? 'behind' : gapPct < -3 ? 'ahead' : 'ontrack';
  const words = { behind: '落后于时间进度', ahead: '领先于时间进度', ontrack: '与时间进度基本同步' };
  // 【为什么不直接用 dailyNeed>0 判断"要不要加力"】dailyNeed 是连续量，
  // 会被 Math.round 取整成 0：长周期小目标（1 年 100 家 → 0.27/天）会显示"今日需新增 0"，
  // 但缺口明明还在。所以给一个**不依赖取整**的"还有缺口"布尔：remain>0 且未到期即为真。
  const needMore = remain > 0;
  return Object.assign(base, {
    computable: true, status, dailyNeed: Math.round(dailyNeed * 100) / 100,
    needMore,
    expectedPct, gapPct,
    note: words[status] + '：完成 ' + a.pct + '%，按周期应完成 ' + expectedPct + '%；还差 '
      + Math.round(remain) + ' ' + a.unit + '，剩 ' + daysLeft + ' 天，'
      + '即每日需新增 ' + Math.round(dailyNeed) + ' ' + a.unit + '。'
      + (base.startedFromInstall ? '（未设置目标起始日，按周期自今天起算）' : '')
  });
}

// 周期总长（与起始日无关）。【为什么必须和 daysLeftOf 分开】
// daysLeftOf 返回的是"扣掉已过天数后的剩余"，曾被 pace() 当成周期总长用，
// 于是 elapsed = total - daysLeft 恒等于 0 → expectedPct 永远 0 → 时间进度维度整个失效
// （设了 45 天前起算的 P3M 目标，会报"应完成 0%"而不是 50%）。这是个真 bug，已拆开。
function periodDaysOf(period) {
  const map = { P1M: 30, P3M: 90, P6M: 180, P1Y: 365 };
  return map[period] || 180;
}

function setGoalStartedAt(ts) {
  const v = Number(ts) || Date.now();
  store.setSetting('goalStartedAt', v);
  return v;
}

function daysLeftOf(period, g) {
  const total = periodDaysOf(period);
  const db = store.read();
  const started = Number((g && g.startedAt) > 0 ? g.startedAt : (db.settings && db.settings.goalStartedAt)) || 0;
  const from = Number(started) || Date.now();
  const used = Math.floor((Date.now() - from) / 86400000);
  return Math.max(0, total - used);
}

module.exports = { all,   add, remove, setPrimary, primary, alignment, pace, daysLeftOf, periodDaysOf, DEFAULT_GOAL, setGoalStartedAt
};
