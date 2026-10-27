// core/coordinator.js — 整体协调中枢：明线 / 暗线 双轨总览 + 今日行动
// 明线 = 用户可见面（决策、内容、订阅、聊天、团队）→ 直接操作
// 暗线 = 自主推进面（获客漏斗、自主运营模块、大脑进化、正确率）→ 系统后台驱动
// 一个面板看清全局 + 给出"最值得做的一步"，避免模块各跑各的。

const store = require('./store');
const decision = require('./decision');
const money = require('./money');
const brain = require('./brain');
const subs = require('./subs');

const now = Date.now();
const DAY = 86400000;

function line() {
  const d = store.read();
  const today = new Date().toDateString();
  // 营收字段是 amt（不是 amount），且只统计已结算实收
  // 自测单不算今日营收（口径同 money.kpi）
  const _obyId = new Map((d.orders || []).map(o => [String(o.id), o]));
  const revToday = (d.revenue || []).filter(x => x.at && money.isSettled(x) && !money.isSelfTest(x, _obyId) && new Date(x.at).toDateString() === today).reduce((s, x) => s + (x.amt || 0), 0);
  const decToday = (d.decisions || []).filter(x => x.createdAt && new Date(x.createdAt).toDateString() === today).length;
  const chatToday = (d.messages || []).filter(x => x.at && new Date(x.at).toDateString() === today).length;
  const boards = require('./leadgen').board();
  return { d, today, revToday, decToday, chatToday, boards };
}

// 明线：用户可操作的活跃面
function visible() {
  const x = line();
  return {
    decisionsToday: x.decToday,
    frameworks: decision.stats().total,
    accuracy: decision.benchmark().accTop1 + '%',
    chatToday: x.chatToday,
    revenueToday: '¥' + x.revToday,
    revenueTotal: '¥' + money.kpi().revenue,
    subscribers: (x.d.subs || x.d.sublist || []).filter(s => s.expireAt > now).length,
    teams: (x.d.decisions || []).filter(dd => String(dd.engine || '').startsWith('team@')).length,
    memoryCount: brain.memories(1000).length,
    firstStep: x.decToday === 0 ? '今天还没有做任何决策 -> 去决策中心问一个问题' : '今天已做 ' + x.decToday + ' 次决策 -> 继续用「决策中心」深化主题'
  };
}

// 暗线：系统自主推进面
function hidden() {
  const x = line();
  const leads = x.boards.byStage || {};
  let goalLine = '赚钱目标：暂无台账';
  let goalRecommend = '';
  let weekLine = '';
  try {
    const g = require('./goalpilot').status();
    goalLine = '赚钱目标 Q' + g.probe.quarter + '「' + g.probe.status + '」累计 ¥' + Math.round(g.probe.kpi.revenue) + ' / ' + (g.probe.kpi.target / 10000).toFixed(0) + '万（' + g.probe.kpi.pct + '%·今日+¥' + g.probe.todayRevenue + '）剩 ' + g.probe.kpi.daysLeft + ' 天需日均 ¥' + g.probe.kpi.needDaily;
    weekLine = '本周 ¥' + Math.round(g.week.inWeek) + ' / 计划 ¥' + Math.round(g.week.weekPlan) + '（还剩 ' + g.week.leftInWeek + ' 天·差 ¥' + Math.round(g.week.needThisWeek) + '）' + (g.lastWeekly && g.lastWeekly.acted && g.lastWeekly.acted.length ? ' · 已执行: ' + (g.lastWeekly.acted[0] || '').slice(0, 28) : '');
    goalRecommend = g.lastDaily ? (g.lastDaily.advises[0] || '维持') : '等待今日目标闭环';
  } catch (e) {}
  return {
    autopilotRounds: (x.d.autopilot || []).length,
    leadFunnel: leads, dealTotal: '¥' + x.boards.deals,
    leadLine: '线索 ' + x.boards.total + ' · 成交客户 ' + x.boards.customers,
    goalLine,
    weekLine,
    evolutionCount: brain.evolution().length,
    nextMove: x.boards.total === 0
      ? '暗线起始：无线索 -> leadgen 找客户'
      : '暗线推进：漏斗推进到「' + stageNext(leads) + '」段 -> leadgen/funnelStep',
    goalRecommend
  };
}

function stageNext(byStage) {
  const ORD = ['触达', '探测', '推荐', '选择', '优化', '促单', '成交'];
  for (let i = 0; i < ORD.length; i++) if (byStage[ORD[i]]) return ORD[i];
  return '探测';
}

function actions(v, h) {
  v = v || visible(); h = h || hidden();
  const out = [v.firstStep, h.nextMove];
  if (h.goalRecommend) out.push('赚钱目标：' + h.goalRecommend);
  if (h.weekLine) out.push('周目标：' + h.weekLine + ' -> 发布列车装增长件/内容复用变形');
  if (v.subscribers === 0) out.push('尚无订阅 -> 开放订阅墙并投放邀请码');
  if (v.accuracy < 90) out.push('决策正确率 ' + v.accuracy + ' 低于 90% -> 扩充 keyword 语料');
  return out;
}

// —— 统一世界状态快照（整体性的接缝）——
// 背景：本文件此前只输出展示字符串，0 写入、0 调度，"协调中枢"名不副实；
// 各模块各自 store.read() 重新推导现实，money.kpi() 被 9 处独立重算，
// 甚至用三种不同分母各判各的"是否达标"。
// snapshot() 提供**唯一一份**结构化态势对象（含缓存），供 conductor.mission /
// autopilot 等编排器消费：同一份真相 → 同一套动作优先级 → 模块不再各跑各的。
const SNAP_TTL_MS = 15 * 1000; // 快照新鲜期：一轮自治内复用，避免每个模块各解析 1.4MB db.json
let snapCache = null;
function snapshot() {
  if (snapCache && Date.now() - snapCache.at < SNAP_TTL_MS) return snapCache;
  const v = visible();
  const h = hidden();
  const alerts = (() => {
    try { const wd = require('./watchdog'); return wd.recentAlerts ? wd.recentAlerts(10) : (wd.alerts || []); }
    catch (e) { return []; }
  })();
  const kpi = (() => { try { return money.kpi(); } catch (e) { return null; } })();
  const brief = (() => {
    try { const g = require('./goalpilot'); return g.briefs ? g.briefs(1)[0] || null : null; }
    catch (e) { return null; }
  })();
  const lessons = (() => {
    try { return require('./lessons').stats(); } catch (e) { return { total: 0, by: { fail: 0, win: 0, trick: 0 }, top: [] }; }
  })();
  // 统一优先级：把"各模块视角"收敛成一个排序后的动作清单
  const prio = [];
  if (alerts.some(a => a && a.level === 'error')) prio.push({ p: 1, act: 'fix_error', why: '存在 error 级告警，先止损' });
  if (kpi && kpi.onTrack === false) prio.push({ p: 2, act: 'grow_revenue', why: 'KPI 落后（' + (kpi.pct != null ? Math.round(kpi.pct) + '%' : '?') + '），优先获客' });
  if (brief && Array.isArray(brief.focus) && brief.focus.some(f => /停滞|落后|本周仅剩/.test(String(f)))) prio.push({ p: 2, act: 'grow_revenue', why: 'CEO 晨报标记目标风险' });
  if (h.leadFunnel && (h.leadFunnel['触达'] || h.leadFunnel['探测']) > 0) prio.push({ p: 3, act: 'advance_funnel', why: '漏斗有待推进段：' + stageNext(h.leadFunnel) });
  if (v.subscribers === 0) prio.push({ p: 4, act: 'acquire_sub', why: '尚无订阅用户' });
  prio.push({ p: 5, act: 'grow_asset', why: '常态：内容/技能资产积累' });
  snapCache = { at: Date.now(), visible: v, hidden: h, alerts, kpi, brief, lessons, priority: prio.sort((a, b) => a.p - b.p) };
  return snapCache;
}

function invalidate() { snapCache = null; }

function overview() {
  const v = visible(), h = hidden(), a = actions(v, h);
  return [
    '【运营总览】明线（用户可见面）',
    '· 决策 ' + v.decisionsToday + ' 次/今日 · 框架 ' + v.frameworks + ' · 正确率 ' + v.accuracy,
    '· 聊天 ' + v.chatToday + ' 轮 · 记忆 ' + v.memoryCount + ' 条 · 团队会诊 ' + v.teams + ' 次',
    '· 收入 今日 ' + v.revenueToday + ' / 累计 ' + v.revenueTotal + ' · 订阅 ' + v.subscribers + ' 人',
    '',
    '【运营总览】暗线（自主推进面）',
    '· 自主运营轮次 ' + h.autopilotRounds + ' · 进化节点 ' + h.evolutionCount,
    '· ' + h.goalLine,
    '· ' + h.weekLine,
    '· 获客漏斗 ' + JSON.stringify(h.leadFunnel) + ' · ' + h.leadLine,
    '',
    '【今日行动】' + a.map(x => '▪ ' + x).join('\n')
  ].join('\n');
}

module.exports = { overview, visible, hidden, actions, snapshot, invalidate };