// core/goalpilot.js — 赚钱目标无人驾驶引擎（24h 暗线闭环）
// 每天不间断在暗线中做三件事：
//   ① 查询赚钱目标进展（半年 KPI + 本季进度 + 今日入账，全是真实台账）
//   ② 优化目标（诚实重算：计划节奏 vs 实际节奏 → 需要的日均 / 本周可及目标 / 达成日期）
//   ③ 逼近目标（真实动作：落后则拨推广池去获客、推进成交漏斗、落账+进化+记忆）
// 设计原则与 autopilot 一致：零模型依赖、全部落库可审计、每日按日期幂等去重、重启自动补跑。

const store = require('./store');
const brain = require('./brain');
const money = require('./money');

const DAY = 86400000;
const MAX_LOG = 90;          // goalpilot 台账上限
// 每 15 分钟自查一次（是否该执行每日闭环）。实际间隔由 devcap 按设备能力推导：弱机 2h，
// 避免在小内存机器上频繁同步读 1.4MB db.json 把事件循环堵死。
let TICK_MS = 15 * 60 * 1000;
// 启动后延后再跑首轮，避免与服务启动/autopilot 首轮叠加占满事件循环
const FIRST_DELAY_MS = 20000;

function todayKey() { return new Date().toDateString(); }
// 周标识：周一为起点，返回该周周一的日期串（同比/环比锚点用）
// 格式固定为 YYYY-MM-DD（本地时区）：此前用 toDateString() 会产出
// "Mon Sep 28 2026" 这样的英文串，直接写进大脑记忆/台账，前端展示很难看。
function weekKey(d) {
  const x = new Date(d || Date.now());
  const dow = (x.getDay() + 6) % 7; // 周一=0
  x.setDate(x.getDate() - dow);
  x.setHours(0, 0, 0, 0);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const dd = String(x.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}

// —— ① 查询赚钱目标进展：半年 KPI + 本季 + 今日 + 7 日均 ——
function probe() {
  const db = store.read();
  const k = money.kpi();
  const now = Date.now();
  // 【口径统一·2026-10】与 money.kpi() 同一把尺：自测单（本机下单自行确认的钱）不是营收。
  // 此前这里只按 isSettled 过滤，导致 kpi.revenue=0 而 todayRevenue=101 的自相矛盾晨报
  //（「今日 +¥101」配「已入账 ¥0」），并把 7 日均、paceStatus 全按假账算。
  const orderById = new Map((db.orders || []).map(o => [String(o.id), o]));
  const revs = (db.revenue || []).filter(r => r.amt && money.isSettled(r) && !money.isSelfTest(r, orderById));
  const today = now;
  const todayN = revs.filter(r => sameDay(r.at, today)).reduce((s, r) => s + r.amt, 0);
  // 近 7 天日均（不含未来）
  const week = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now - i * DAY);
    week.push(revs.filter(r => sameDay(r.at, d)).reduce((s, r) => s + r.amt, 0));
  }
  const weekAvg = Math.round(week.reduce((a, b) => a + b, 0) / 7 * 100) / 100;
  // 本季进度（对齐 goal_quarter）
  const dq = new Date(now);
  const q = Math.floor(dq.getMonth() / 3) + 1;
  const qEnd = new Date(dq.getFullYear(), q * 3, 0);
  const qLeft = Math.max(0, Math.round((qEnd - dq) / DAY));
  // 状态判定：实际日均 ≥ 计划节奏 = 达标；>0 但落后 = 努力追赶；=0 = 停滞
  let status;
  if (weekAvg >= k.pacePlan) status = '达标';
  else if (weekAvg > 0) status = '追赶';
  else status = '停滞';
  return {
    kpi: k,
    todayRevenue: Math.round(todayN * 100) / 100,
    week7Avg: weekAvg, week7: week.map(x => Math.round(x * 100) / 100),
    status,
    quarter: q, quarterDaysLeft: qLeft,
    at: now
  };
}

// —— ② 优化目标：诚实重算路线（不篡改原目标，只给可执行的优化档与里程碑）——
function optimize(p) {
  const k = p.kpi;
  const adv = [];
  // 关键差距：目标尚差多少、按现状节奏需要多久、本周可及目标
  const gap = Math.max(0, k.target - k.revenue);
  const needDaysByActual = k.revenue > 0 && p.week7Avg > 0 ? Math.ceil(gap / p.week7Avg) : null;
  const weekReach = Math.round(p.week7Avg * 7);           // 按现状节奏 7 天可达
  const weekPlan = Math.round(k.pacePlan * 7);             // 按计划节奏 7 天应收
  const milestone = { weekReach, weekPlan, gap, needDaysByActual, paceDaily: k.needDaily };
  if (p.status === '达标') {
    adv.push('连续达标：保持现节奏。加码条件——推广池余 ¥' + Math.round(k.promo.avail) + '，可把每周推广额上调 20% 换更高斜率');
  } else if (p.status === '追赶') {
    adv.push('落后于计划：日均仅 ¥' + Math.round(p.week7Avg) + '（计划 ¥' + Math.round(k.pacePlan) + '）。按现状需约 ' + (needDaysByActual || '?') + ' 天完成——必须把' + (k.daysLeft > 60 ? '半年' : '当前') + '目标切成周目标，先啃最近一周');
    if (weekReach < weekPlan) adv.push('本周可及 ¥' + weekReach + '（计划 ¥' + weekPlan + '）——优化档：从"线索→成交"抠出 1 个本周能成交的高意向客户，比广撒网更有用');
  } else {
    adv.push('停滞状态：近 7 天无入账。优化目标=先破零——不是算半年，是把第一笔 ¥' + Math.ceil(k.needDaily) + ' 做出来（定价/成交/收款任一处落地）');
  }
  if (k.promo.avail >= 20 && p.status !== '达标') adv.push('推广池可用 ¥' + Math.round(k.promo.avail) + '：落后时建议拿出 ≥¥20 走"自主投放→线索→成交"闭环');
  if (p.status !== '达标' && k.daysLeft < 60 && gap > 0) adv.push('临门期（剩 ' + k.daysLeft + ' 天）：停止新方向，砍到只剩"能直接产生收入"的动作');
  return { milestone, advises: adv };
}

// —— ② 周目标盘算：本周至今 vs 本周计划 + 剩余天 ——
function weekProbe(p) {
  const db = store.read();
  const wk = weekKey();
  const wkStart = new Date(wk).getTime();
  const now = Date.now();
  const dayOfWeek = Math.min(7, Math.floor((now - wkStart) / DAY) + 1);
  const leftInWeek = Math.max(0, 7 - dayOfWeek);
  const _wbyId = new Map((db.orders || []).map(o => [String(o.id), o]));
  const inWeek = (db.revenue || []).filter(r => r.amt && money.isSettled(r) && !money.isSelfTest(r, _wbyId) && r.at >= wkStart && r.at <= now).reduce((s, r) => s + r.amt, 0);
  const weekPlan = Math.round(p.kpi.pacePlan * 7);      // 本周计划应收
  const needThisWeek = Math.max(0, weekPlan - inWeek);   // 本周还差多少
  const avgActual = dayOfWeek ? inWeek / dayOfWeek : 0;
  let wstatus;
  if (avgActual >= p.kpi.pacePlan) wstatus = '达标';
  else if (avgActual > 0) wstatus = '追赶';
  else wstatus = '停滞';
  return {
    weekKey: wk, dayOfWeek, leftInWeek,
    inWeek: Math.round(inWeek * 100) / 100,
    weekPlan, needThisWeek: Math.round(needThisWeek * 100) / 100,
    avgActual: Math.round(avgActual * 100) / 100,
    status: wstatus
  };
}

// —— ③ 真实执行动作：把"逼近目标"从建议变执行（发布列车装增长件 + 决策喂内容复用）——
// 只在状态非"达标"时触发且幂等（列车格子占满/素材已喂过即跳过），全部落库可审计。
async function actClose(p, opt, week) {
  const acted = [];
  const w = week || weekProbe(p);
  // 3a) 落后时：记录一条"本周要成交的一笔"到任务（可执行、可回溯）
  try {
    if (p.status !== '达标' && !(opt.milestone || {}).taskCreated) {
      const db = store.read();
      const dup = (db.tasks || []).some(t => !t.done && /赚钱目标/.test(t.title || ''));
if (!dup) {
        store.push('tasks', { title: '赚钱目标逼近：本周' + (w.leftInWeek > 0 ? '还差 ¥' + Math.round(w.needThisWeek) + '（剩 ' + w.leftInWeek + ' 天，日均需 ¥' + Math.ceil(w.needThisWeek / Math.max(1, w.leftInWeek)) + '）' : '收官，冲刺缺口 ¥' + Math.round(w.needThisWeek)), due: '本周', ref: 'goalpilot', done: false }, '赚钱目标周逼近', 'goalpilot 周任务');
        acted.push('周任务落库：本周还差 ¥' + Math.round(w.needThisWeek) + '（剩 ' + w.leftInWeek + ' 天）');
        // 第 6 条：goalpilot 直接 store.push 建的任务没人认领 → 任务台永远"在跑 0"。
        // 建完立刻走统一认领，让这活带上人、进入 running（ref decision: 仍优先）。
        try { const AW = require('./assign-work'); const cr = AW.claimPending({ autoHire: true }); if (cr.assigned && cr.assigned.length) acted.push('周任务已认领：' + cr.assigned.length + ' 项'); } catch (e) {}
      }
    }
  } catch (e) {}
  // 3b) 发布列车：落后时给本班 growth 格装一个增长件（火车不等人，本班不满就下班）
  try {
    if (p.status !== '达标') {
      const train = require('./train');
      const tb = train.board();
      const cur = tb.current || {};
      if (!cur.released && !(cur.slots && cur.slots.growth)) {
        const goal = week || w || weekProbe(p);
        const feature = train.load({ slot: 'growth', title: '赚钱目标逼近：本周营收缺口 ¥' + Math.round(goal.needThisWeek || 0), desc: 'goalpilot 自动装载：' + p.status + '，本周还有 ' + goal.leftInWeek + ' 天，把最靠近成交的线索推成正单', by: 'goalpilot' });
        acted.push('发布列车已装增长件：' + feature.title.slice(0, 30));
      }
    }
  } catch (e) {}
  // 3c) 内容复用：把最近一条真实决策喂进生产线变形（一料五吃，授权边界由 human 勾选）
  try {
    if (p.status !== '达标') {
      const repurpose = require('./repurpose');
      const ds = store.read().decisions || [];
      const last = ds.slice().reverse().find(d => d.question && d.answer && !/report|autopilot/.test(String(d.engine || '')));
      if (last) {
        const src = 'goalpilot:' + last.id;
        const exists = repurpose.list().some(m => m.source === src);
        if (!exists && !(opt.milestone || {}).fed) {
          const text = String(last.answer || '').slice(0, 800);
          const mat = repurpose.feedMaterial({ raw: 'R3', source: src, text: text || '「' + last.question.slice(0, 60) + '」决策记录' });
          const variants = repurpose.repurpose(mat.id, []);
          const pub = (variants.variants || []).filter(v => v.publishable).length;
          acted.push('最近决策已喂内容复用：变形 ' + (variants.variants || []).length + ' 种（可发布 ' + pub + '，授权待勾选）');
          if (!opt.milestone) opt.milestone = {};
          opt.milestone.fed = true;
        }
      }
    }
  } catch (e) {}
  return acted;
}

// —— ④ 周目标闭环：聚合本周进展 + 执行逼近 + 落账（按周幂等，周一只跑一次）——
// 【2026-09·防崩溃】必须 async：原来这条"已跑过就跳过"的早退分支
// `return { skipped: true, ... }` 返回的是**普通对象**，而调用方（下方定时器）写的是
// `weekly().catch(...)` → 普通对象没有 .catch → 抛 TypeError。
// 定时器回调里的未捕获异常会**直接终止整个 Node 进程**（整个应用消失，不只是功能坏），
// 于是表现为"跑着跑着就没了"。加 async 让所有分支都返回 Promise。
async function weekly() {
  const db = store.read();
  const wk = weekKey();
  if ((db.goalpilotW || []).some(g => g.weekKey === wk)) return { skipped: true, weekKey: wk, last: (db.goalpilotW || []).find(g => g.weekKey === wk) };
  const p = probe();
  const w = weekProbe(p);
  const opt = optimize(p);
  return actClose(p, opt, w).then(acted => {
    const entry = {
      weekKey: wk, at: Date.now(),
      status: p.status,
      week: w,
      advises: opt.advises.slice(0, 4),
      acted: acted.slice(0, 5)
    };
    // actClose 已通过 store 持久化任务/素材，必须重读最新 db 再落账，避免陈旧快照覆盖它们
    const fresh = store.read();
    if (!fresh.goalpilotW) fresh.goalpilotW = [];
    fresh.goalpilotW.unshift(entry);
    if (fresh.goalpilotW.length > 30) fresh.goalpilotW = fresh.goalpilotW.slice(0, 30);
    store.write(fresh);
    store.push('audit', { action: '赚钱目标·周闭环', detail: wk + ' ' + p.status + ' 本周¥' + Math.round(w.inWeek) + '/' + Math.round(w.weekPlan) + '（差¥' + Math.round(w.needThisWeek) + '）', at: Date.now() });
    brain.remember('赚钱目标', '[周] ' + wk + ' ' + p.status + ' 本周 ¥' + Math.round(w.inWeek) + ' / 计划 ¥' + Math.round(w.weekPlan) + '（差 ¥' + Math.round(w.needThisWeek) + '）', true);
    brain.evolve('赚钱目标周盘点：' + w.status + ' 本周入账 ¥' + Math.round(w.inWeek) + '（计划 ¥' + Math.round(w.weekPlan) + '）');
    return entry;
  });
}

// —— 每日闭环：查询 → 优化 → 逼近 → 落账（按日期幂等）——
async function daily() {
  const __t0 = performance.now();   // 【2026-09】tasktime 登记
  try {
    return await __dailyInner();
  } finally {
    try { require('./tasktime').record('goalpilot.daily', performance.now() - __t0); } catch (e) {}
  }
}

async function __dailyInner() {
  const db = store.read();
  const key = todayKey();
  const last = (db.goalpilot || []).find(g => g.day === key);
  // 当天已跑但今天有新增真实入账（如人工确认成交）→ 刷新今日账，避免"停滞"却已收¥1280 的矛盾
  if (last) {
    const _tbyId = new Map((db.orders || []).map(o => [String(o.id), o]));
    const token = String((last.acted || []).length) + ':' + (db.revenue || []).filter(r => sameDay(r.at, Date.now()) && r.amt > 0 && money.isSettled(r) && !money.isSelfTest(r, _tbyId)).reduce((s, r) => s + (r.amt || 0), 0);
    if (!last._revToken) { last._revToken = token; } // 兼容老条目：首次读取只记录基线
    if (token !== last._revToken) {
      last._revToken = token;
      const p = probe();
      const opt = optimize(p);
      Object.assign(last, {
        at: Date.now(),
        kpi: { revenue: Math.round(p.kpi.revenue * 100) / 100, target: p.kpi.target, pct: p.kpi.pct, onTrack: p.kpi.onTrack, daysLeft: p.kpi.daysLeft, needDaily: Math.round(p.kpi.needDaily) },
        todayRevenue: p.todayRevenue, week7Avg: p.week7Avg, status: p.status,
        week: weekProbe(p), milestone: opt.milestone, advises: opt.advises.slice(0, 4)
      });
      const fresh = store.read();
      const idx = (fresh.goalpilot || []).findIndex(g => g.day === key);
      if (idx >= 0) { fresh.goalpilot[idx] = last; }
      store.write(fresh);
      store.push('audit', { action: '赚钱目标·追加更新', detail: key + ' 新入账后刷新：累计¥' + Math.round(p.kpi.revenue) + ' ' + p.status, at: Date.now() });
      return last;
    }
    return { skipped: true, day: key, last };
  }
  const p = probe();
  const opt = optimize(p);
  // 每日逼近：拨推广池 + 推漏斗 + 真实执行动作（周闭环里已执行的增量在此复用）
  const acted = [];
  try {
    if (p.status !== '达标') {
      const b = money.budget();
      const amt = Math.min(20, Math.round(Math.min(b.avail, Math.max(5, p.kpi.needDaily * 0.02)) * 10) / 10);
      acted.push('逼近目标：推广池可用 ¥' + b.avail.toFixed(1) + '（真实投放经人工确认后才扣款记账，本轮仅登记意向）');
    }
  } catch (e) {}
  try {
    const leadgen = require('./leadgen');
    const r = await leadgen.funnelStep(Math.floor(Date.now() / DAY));
    acted.push.apply(acted, r);
  } catch (e) {}
  // 周逼近只在本周首次判定运动时执行一次写类动作（幂等由模块保证）
  acted.push.apply(acted, await actClose(p, opt, weekProbe(p)));
  const entry = {
    day: key,
    at: Date.now(),
    kpi: {
      revenue: Math.round(p.kpi.revenue * 100) / 100,
      target: p.kpi.target,
      pct: p.kpi.pct, onTrack: p.kpi.onTrack,
      daysLeft: p.kpi.daysLeft, needDaily: Math.round(p.kpi.needDaily)
    },
    todayRevenue: p.todayRevenue, week7Avg: p.week7Avg,
    quarter: p.quarter, quarterDaysLeft: p.quarterDaysLeft,
    status: p.status,
    week: weekProbe(p),
    milestone: opt.milestone,
    advises: opt.advises.slice(0, 4),
    acted: acted.slice(0, 6)
  };
  // 同上：重读最新 db 再写每日账，保住 actClose/funnelStep/money 已持久化的记录
  const fresh = store.read();
  if (!fresh.goalpilot) fresh.goalpilot = [];
  fresh.goalpilot.unshift(entry);
  if (fresh.goalpilot.length > MAX_LOG) fresh.goalpilot = fresh.goalpilot.slice(0, MAX_LOG);
  store.write(fresh);
  store.push('audit', { action: '赚钱目标·每日闭环', detail: key + ' ' + p.status + ' 累计¥' + Math.round(p.kpi.revenue) + ' ' + p.kpi.pct + '%', at: Date.now() });
  return entry;
}

// —— 24h 心跳：每 15 分钟自查一次，缺当天/本周闭环就补跑（重启/断线自动恢复）——
// 串行执行 daily→weekly：两者都走 actClose 写类动作，并行会重复落任务/素材。
function boot() {
  const once = () => daily().catch(() => {})
    .then(() => Promise.resolve(brief().catch ? brief().catch(() => {}) : brief()))
    .then(() => Promise.resolve(weekly().catch(() => {})));
  // 延后首跑：daily()/weekly() 会同步读 1.4MB db.json 并发起外部请求，
  // 启动瞬间执行会占住事件循环（配合 autopilot 叠加后导致 exe 打开即卡死）。
  const t = setTimeout(once, FIRST_DELAY_MS);
  if (t.unref) t.unref();
  // 设备自适应（第 7 项）：自查间隔按 devcap 推导，弱机降频
  try {
    const d = require('./devcap').plan();
    TICK_MS = Math.max(60, d.goalpilotTickSec) * 1000;
  } catch (e) {}
  setInterval(once, TICK_MS);
}

// —— 状态：最新闭环 + 实时进展 + 台账 ——
function status() {
  const db = store.read();
  const logs = (db.goalpilot || []).slice(0, 30);
  return {
    ok: true,
    probe: probe(),
    week: weekProbe(probe()),
    lastDaily: logs[0] || null,
    daysTracked: (db.goalpilot || []).length,
    lastWeekly: (db.goalpilotW || [])[0] || null,
    weeksTracked: (db.goalpilotW || []).length,
    log: logs.map(g => ({ day: g.day, status: g.status, today: g.todayRevenue, total: g.kpi.revenue, pct: g.kpi.pct }))
  };
}

function sameDay(a, b) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

// —— 复盘报告：把"查询赚钱目标实现情况"落成一页可读账（零模型，全真实台账聚合）——
function report() {
  const db = store.read();
  const p = probe();
  const wk = weekProbe(p);
  const budget = money.budget();
  const logs = (db.goalpilot || []).slice(0, 14);
  const weeks = (db.goalpilotW || []).slice(0, 6);
  const leadCtx = (() => {
    try { const b = require('./leadgen').board(); return { total: b.total, byStage: b.byStage, deals: b.deals, customers: b.customers }; }
    catch (e) { return null; }
  })();
  const trainCtx = (() => {
    try { const t = require('./train').board(); return { no: t.current.no, growth: !!(t.current.slots && t.current.slots.growth), released: t.current.released, lot: t.lotCount }; }
    catch (e) { return null; }
  })();
  const lines = [];
  lines.push('【赚钱目标·无人驾驶复盘】' + todayKey());
  lines.push('— 目标 —');
  lines.push('· ' + money.SETTLE + ' 半年 ¥' + (p.kpi.target / 10000).toFixed(0) + '万 · 已入账 ¥' + Math.round(p.kpi.revenue) + '（' + p.kpi.pct + '%）· 已过 ' + p.kpi.daysPast + ' 天且剩 ' + p.kpi.daysLeft + ' 天');
  lines.push('· 实际日均 ¥' + p.kpi.regDaily + ' vs 计划 ¥' + p.kpi.pacePlan + ' → ' + p.status + '（今日 +¥' + p.todayRevenue + '，7日均 ¥' + p.week7Avg + '）');
  lines.push('— 本周（' + wk.weekKey + '）—');
  lines.push('· 已入 ¥' + Math.round(wk.inWeek) + ' / 计划 ¥' + Math.round(wk.weekPlan) + ' · 还差 ¥' + Math.round(wk.needThisWeek) + '（本周第 ' + wk.dayOfWeek + ' 天·剩 ' + wk.leftInWeek + ' 天·日均需 ¥' + (wk.leftInWeek ? Math.ceil(wk.needThisWeek / Math.max(1, wk.leftInWeek)) : 0) + '）');
  lines.push('— 攻势 —');
  lines.push('· 推广池 拨备 ¥' + budget.allotted + ' · 已支 ¥' + budget.spent + ' · 可用 ¥' + budget.avail);
  if (leadCtx) lines.push('· 获客漏斗 ' + leadCtx.total + ' 线索 → ' + JSON.stringify(leadCtx.byStage) + ' · 成交 ' + leadCtx.customers + ' 家 ¥' + leadCtx.deals);
  if (trainCtx) lines.push('· 发布列车 第' + trainCtx.no + '班 ' + (trainCtx.released ? '已发车' : '装配中') + (trainCtx.growth ? ' [增长件已装]' : ' [增长件待装]') + ' · parking lot ' + trainCtx.lot + ' 条');
  lines.push('— 台账 —');
  lines.push('· 每日闭环 ' + (db.goalpilot || []).length + ' 天 · 周闭环 ' + (db.goalpilotW || []).length + ' 周');
  if (logs.length) {
    lines.push('· 近况：' + logs.slice(0, 5).map(g => g.day.slice(0, 10) + ' ' + g.status).join(' | '));
    lines.push('· 最近建议：' + (logs[0].advises || []).slice(0, 2).map(a => '「' + a + '」').join('\n        '));
    lines.push('· 最近动作：' + (logs[0].acted || []).slice(0, 4).map(a => '✓ ' + a).join('\n        '));
  }
  if (weeks.length) lines.push('· 周况：' + weeks.slice(0, 4).map(g => g.weekKey.slice(0, 6) + '¥' + Math.round(g.week.inWeek)).join(' | '));
  return {
    ok: true, at: Date.now(), status: p.status,
    kpi: { target: p.kpi.target, revenue: p.kpi.revenue, pct: p.kpi.pct, daysPast: p.kpi.daysPast, daysLeft: p.kpi.daysLeft, pace: p.kpi.pacePlan, regDaily: p.kpi.regDaily },
    week: wk,
    promo: budget,
    lead: leadCtx, train: trainCtx,
    daysTracked: (db.goalpilot || []).length, weeksTracked: (db.goalpilotW || []).length,
    lastDaily: logs[0] || null, lastWeekly: weeks[0] || null,
    text: lines.join('\n')
  };
}

// —— 每日 CEO 晨报（借鉴 Polsia：AI CEO 每天凌晨审计账户/流失率，给创始人留一张便条）——
// 与 report() 不同：brief() 只保留"今天该关注什么"的压缩要点，每天按日期幂等落一条，
// 供🐝 战情室 / 作战指挥塔首屏展示 + 提供"昨日→今日"差分（哪些数字变坏了）。
// 零模型：全真实台账聚合，绝不让 AI 编造结论。
function brief() {
  const db = store.read();
  const p = probe();
  const wk = weekProbe(p);
  const dateKey = todayKey();
  const prev = (db.goalpilot || []).find(g => g.day === dateKey); // 仅当 daily 已跑过才最有信息量，否则补一份表现层
  const last = (db.morning || []).find(m => m.day === dateKey);

  // 昨收 vs 今日目标：昨天不漏，今天怎么追
  const ySeq = (db.goalpilot || []).slice(0, 2);
  const y = ySeq.find(g => g.day !== dateKey) || ySeq[0] || null;
  const revToday = p.todayRevenue;
  const revYest = y && typeof y.todayRevenue === 'number' ? y.todayRevenue : null;

const points = [];
  points.push(('目标 ' + (p.kpi.pct) + '% · 已入 ¥' + Math.round(p.kpi.revenue) + ' / 半年 ¥' + (p.kpi.target / 10000).toFixed(0) + '万 · 剩 ' + p.kpi.daysLeft + ' 天 → ' + p.status).slice(0, 90));
  points.push(('本周 ¥' + Math.round(wk.inWeek) + ' / 计划 ¥' + Math.round(wk.weekPlan) + ' · 还差 ¥' + Math.round(wk.needThisWeek) + ' · 日均需 ¥' + (wk.leftInWeek ? Math.ceil(wk.needThisWeek / Math.max(1, wk.leftInWeek)) : 0)).slice(0, 90));
  // 【深挖：时间维度】goalpilot 的 p.status 只看"当前日均 vs 计划日均"（速度），
  // 缺"已花掉多少时间、应完成多少"这半边。goals.pace() 补的正是这块：
  // 落后 = 同一时刻应完成的进度 > 实际完成。两个口径都来自真实台账，且口径同源
  // （revenue 都读已结算），只在判断维度上互补——速度达标不代表时间没被落后吃掉。
  let paceLine = null, paceFocus = null, paceSt = null;
  try {
    const GP = require('./goals');
    const pc = GP.pace();
    if (pc && pc.ok && pc.computable) {
      const stLabel = ({ behind: '落后', ahead: '领先', ontrack: '同步', overdue: '已到期', reached: '已达成' }[pc.status] || pc.status);
      paceSt = pc.status;
      const unitSym = pc.unit === 'CNY' ? '¥' : (pc.unit || '');
      const title = pc.title || '核心目标';
      points.push((title + ' · 完成 ' + pc.pct + '%（应 ' + pc.expectedPct + '%）' + (pc.dailyNeed !== null ? ' · 今日需新增 ' + unitSym + Math.round(pc.dailyNeed) : '') + ' · 剩 ' + pc.daysLeft + ' 天 → ' + stLabel).slice(0, 90));
      if (pc.status === 'behind') paceFocus = '🔴 时间进度落后：应完成 ' + pc.expectedPct + '% 但只完成 ' + pc.pct + '% · 今日至少需新增 ' + unitSym + Math.round(pc.dailyNeed);
      else if (pc.status === 'overdue') paceFocus = '🚨 核心目标周期已到期仍未达成（差 ' + Math.round(pc.remain) + (unitSym || '') + '）— 需要重设周期或追加目标';
      else if (pc.status === 'ahead') paceFocus = '🟢 领先时间进度：应 ' + pc.expectedPct + '% 已完成 ' + pc.pct + '% — 可释放资源给新方向';
    }
  } catch (e) {}
  if (revYest !== null) {
    const d = revToday - revYest;
    points.push(('今日 +¥' + revToday + (d >= 0 ? '  ↑+¥' + d : '  ↓-¥' + (-d)) + ' vs 昨日').slice(0, 90));
  }
  // 关注点：异常优先（减退步、漏水、停滞）
  const focus = [];
  if (paceFocus) focus.push(paceFocus);
  if (p.status === '停滞') focus.push('🔴 目标停滞');
  else if (p.status === '追赶') focus.push('🟡 目标落后，需要日均 ¥' + p.kpi.pacePlan + ' 才能保线');
  if (wk.needThisWeek > 0 && wk.leftInWeek <= 2) focus.push('⚠ 本周仅剩 ' + wk.leftInWeek + ' 天');
  // 结合 watchdog 最新异常（如有）——此前误读 w.alerts（watchdog 未导出该键），
  // 导致这里永远拿不到数据、🚨 行形同虚设。改走导出的 recentAlerts()。
  try {
    const w = require('./watchdog');
    const alerts = (typeof w.recentAlerts === 'function' ? w.recentAlerts(20) : (w.alerts || []));
    const errs = (alerts || []).filter(a => a && a.level === 'error').slice(0, 2);
    errs.forEach(a => focus.push('🚨 ' + (a.title || a.key)));
  } catch (e) {}
  if (!focus.length) focus.push('✅ 关键指标无异常');

const lines = [];
  lines.push('☀️ CEO 晨报 · ' + dateKey);
  lines.push('— 今日必读 —');
  // 全部必读点都要打出来：progress 只印 points[0..1] 会把 pace 的时间维度点算出来却漏掉
  for (let i = 0; i < points.length; i++) lines.push('· ' + points[i]);
  lines.push('— 关注 —');
  lines.push('· ' + focus.join('\n· '));
  if (prev && prev.advises && prev.advises.length) lines.push('— 昨日建议执行 —\n· ' + prev.advises.slice(0, 3).map(a => '「' + a + '」').join('\n· '));

const entry = {
    ok: true, day: dateKey, at: Date.now(),
    pct: p.kpi.pct, revenue: p.kpi.revenue, target: p.kpi.target,
    daysLeft: p.kpi.daysLeft, status: p.status,
    inWeek: wk.inWeek, weekPlan: wk.weekPlan, needThisWeek: wk.needThisWeek,
    todayRevenue: revToday, yestRevenue: revYest,
    // 时间维度（goals.pace）：与速度维度互补，另行存一列，UI 可单独引用
    paceStatus: paceSt,
    focus: focus.slice(0, 4), advises: (prev ? prev.advises || [] : []).slice(0, 4),
    text: lines.join('\n')
  };

  const fresh = store.read();
  if (!Array.isArray(fresh.morning)) fresh.morning = [];
  if (last) Object.assign(last, entry); else fresh.morning.push(entry);
  if (fresh.morning.length > 60) fresh.morning = fresh.morning.slice(-60);
  store.write(fresh);
  return entry;
}

function briefs(limit) {
  const db = store.read();
  return (db.morning || []).slice().reverse().slice(0, limit || 7);
}

module.exports = { boot, daily, weekly, probe, optimize, weekProbe, status, report, brief, briefs };