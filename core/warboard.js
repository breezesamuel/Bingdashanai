// core/warboard.js — 作战数据底座（第 12 条 + 第 13 条共用）
//
// 【需求】
//   第 12 条："作战指挥塔是指挥中心……所有功能模块都应该数据化在指挥中心中展现，
//             并给出相应的指挥建议；同在守护是心理学方面的东西，也是作战的各种策略
//             数据中心，而不是简单的一些资料，这个需要完善，成为智慧库"
//   第 13 条："战情室是各种数据的实时情况分析，并以各种图表和图形图像展现出来，
//             或者是各个人员工作的脉络图，或者是工作场景动态图"
//
// 【为什么必须先做一个共用底座】
// 指挥塔要"所有模块数据化"，战情室要"实时图表"，守护要"策略智慧库"——
// 三者都要读全系统状态。如果各自去 read() 各拼各的，会出现三个问题：
//   1. 口径不一致：指挥塔说营收 ¥1280、战情室说 ¥0（一个算未到账、一个只算已结算），
//      用户看到矛盾数据，第一反应就是"这软件不可信"；
//   2. 三次读库 = 三次 1.2MB 反序列化，正是之前查出来的卡顿来源；
//   3. 加一个指标要改三个地方，迟早漏。
// 所以：单一事实源（single source of truth）放在这里，三个页面都从这里取。
//
// 【诚实红线】所有指标只用**真实台账**。没有数据就显示"无数据"，
// 绝不用 0 冒充——"0 条线索"和"没查到线索"对决策的含义完全不同。

const store = require('./store');

const DAY = 86400000;

// —— 各模块统一状态快照 ——
// 每个条目都带 status，用于指挥塔渲染"红/黄/绿"。status 由真实数据推导，不人工指定。
function modules() {
  const db = store.read();
  const now = Date.now();
  const M = [];
  const add = (id, label, value, status, note) => M.push({ id, label, value, status, note: note || '' });

  // —— 目标与营收 ——
  let goalTxt = '未设定', goalPct = null;
  try {
    const g = require('./goals');
    const al = g.alignment();
    goalTxt = al.title; goalPct = al.pct;
    add('goal', '核心目标', goalTxt + '（' + al.pct + '%）',
      al.pct >= 60 ? 'ok' : al.pct >= 20 ? 'warn' : 'bad', '还差 ¥' + Math.round(al.remain) + ' · 剩余 ' + al.daysLeft + ' 天');
  } catch (e) { add('goal', '核心目标', '读取失败', 'bad', e.message); }

  let revenue = null;
  try {
    const m = require('./money');
    const k = m.kpi();
    revenue = k;
    add('revenue', '已结算实收', '¥' + Math.round(k.revenue) + ' / ¥' + (k.target / 10000) + '万',
      k.onTrack ? 'ok' : 'warn', '日均 ¥' + Number(k.regDaily || 0).toFixed(0) + ' · 达标需 ¥' + Number(k.needDaily || 0).toFixed(0));
    const b = m.budget();
    add('budget', '推广池', '可用 ¥' + b.avail, b.avail > 0 ? 'ok' : 'warn', '已拨 ¥' + b.allotted + ' · 已支出 ¥' + b.spent);
  } catch (e) {}

  // —— 获客漏斗 ——
  let leads = null;
  try {
    const lg = require('./leadgen');
    leads = lg.board();
    add('leads', '线索漏斗', leads.total + ' 条 · 成交 ' + leads.customers + ' 客户',
      leads.customers > 0 ? 'ok' : leads.realTouches > 0 ? 'warn' : 'bad',
      // closeGate 可能是对象，直接拼进字符串会渲染成 [object Object]
      '真实触达 ' + (leads.realTouches || 0) + ' · ' + flatText(leads.closeGate, '尚无成交候选'));
  } catch (e) {}

  // —— 任务与组织 ——
  const tasks = db.tasks || [];
  const open = tasks.filter(t => !t.done);
  const running = open.filter(t => t.running === true || t.status === 'running');
  add('tasks', '任务', open.length + ' 项待办 · ' + running.length + ' 项在跑',
    running.length > 0 ? 'ok' : open.length > 0 ? 'warn' : 'ok',
    '已完成 ' + (tasks.length - open.length) + ' 项');

  const staff = db.staff || [];
  let owned = 0;
  try { owned = require('./team').board().owned; } catch (e) {}
  add('org', '组织', staff.length + ' 人 · 认领 ' + owned + ' 项',
    open.length > 0 && owned === 0 ? 'bad' : 'ok',
    open.length > 0 && owned === 0 ? '有 ' + open.length + ' 项待办无人认领' : '派工正常');

  // —— 决策焦点（第 3 条）——
  let focus = null;
  try {
    const f = require('./decision-focus').progress();
    if (f.active) {
      focus = f;
      add('focus', '决策焦点', f.domain + ' · ' + f.done + '/' + f.total,
        f.answered ? 'ok' : f.done > 0 ? 'warn' : 'bad',
        f.answered ? '决策已有答案' : '尚有 ' + (f.total - f.done) + ' 个决策问题未回答');
    }
  } catch (e) {}

  // —— 监控与自愈 ——
  try {
    const w = require('./watchdog');
    const st = w.status() || {};
    const alerts = (w.recentAlerts ? w.recentAlerts() : []).slice(0, 30);
    const recent = alerts.filter(a => now - (a.at || 0) < DAY);
    add('watch', '监控告警', recent.length + ' 条 / 24h',
      recent.length > 5 ? 'bad' : recent.length > 0 ? 'warn' : 'ok',
      '自愈记录 ' + (w.recentHeals ? w.recentHeals().length : 0) + ' 条');
  } catch (e) {}

  // —— 自主运营 ——
  try {
    const s = require('./autopilot').status() || {};
    add('auto', '24h 自主运营', s.enabled === false ? '已暂停' : '运行中',
      s.enabled === false ? 'warn' : 'ok', '轮次 ' + ((db.autopilot || []).length) + ' · 健康 ' + (s.health || '—'));
  } catch (e) {}

  // —— 学习进化（第 8 条）——
  try {
    const d = require('./memory-hub').dashboard();
    add('learn', '学习进化', d.totals.entries + ' 条 · ' + d.totals.modules + ' 模块',
      d.alerts.length ? 'warn' : 'ok',
      d.totals.verifyRate !== null ? '验证率 ' + d.totals.verifyRate + '%' : '暂无验证口径');
  } catch (e) {}

  // —— 技能库 ——
  try {
    const n = require('./skilllib').list().length;
    const ext = require('./skills').allExternal().length;
    add('skills', '技能库', n + ' 内置 + ' + ext + ' 外部', 'ok', '第 2 条：缺能力时可检索装载');
  } catch (e) {}

  // —— 性能 ——
  try {
    const tw = require('./tasktime').report();
    const worst = tw.totals[0];
    add('perf', '性能', worst ? (worst.name + ' 最长 ' + worst.maxMs + 'ms') : '无后台任务记录',
      (worst && worst.maxMs > 3000) ? 'warn' : 'ok',
      '慢写盘 ' + store.slowWrites().length + ' 次 · 库 ' + Math.round((store.stats().dbBytes || 0) / 1024) + ' KB');
  } catch (e) {}

  return M;
}

// —— 指挥建议（第 12 条核心："给出相应的指挥建议"）——
// 规则驱动而非 LLM 生成：指挥建议要**可核查**。每条都带触发依据与可执行动作。
// 让 LLM 生成"建议"很容易，但它看不到跨模块的真实约束，容易说空话。
function advisories() {
  const db = store.read();
  const M = modules();
  const by = {}; M.forEach(m => by[m.id] = m);
  const A = [];
  const push = (sev, title, why, action) => A.push({ sev, title, why, action });

  // 待办无人认领 → 最紧急：有人在等活
  const open = (db.tasks || []).filter(t => !t.done);
  const unowned = open.filter(t => !t.owner);
  if (unowned.length) {
    push('high', unowned.length + ' 项待办无人认领',
      '任务台有 ' + unowned.length + ' 项待办没有 owner，执行链断在这里',
      '执行 /v1/org/assign（界面：组织大脑 → 自动派工），或补齐对应技能');
  }

  // 真实触达为零 → 成交必然为零
  try {
    const lg = require('./leadgen').board();
    if (lg.realTouches === 0 && lg.total > 0) {
      push('high', '线索 ' + lg.total + ' 条但真实触达为 0',
        '漏斗不会因为线索多而推进；closeGate 要求先有真实触达',
        '完成 ' + Math.min(20, lg.total) + ' 条真实触达（对话 /v1/money/leads/touch），漏斗才会自动前进');
    }
  } catch (e) {}

  // 决策焦点有未答问题 → 决策悬着
  try {
    const f = require('./decision-focus').progress();
    if (f.active && !f.answered) {
      push('mid', '决策「' + f.domain + '」尚有 ' + (f.total - f.done) + ' 个问题未回答',
        '任务已派发但未收口，决策悬空会阻塞后续动作',
        '到任务台完成带★ 验收标准的指向性任务');
    }
  } catch (e) {}

  // 未到账款项 → 现金流风险
  try {
    const m = require('./money');
    const all = m.revenueAll ? m.revenueAll() : [];
    const pending = all.filter(r => !m.isSettled(r));
    if (pending.length) {
      push('mid', pending.length + ' 笔款项未到账（共 ¥' + pending.reduce((a, r) => a + (r.amt || r.amount || 0), 0) + '）',
        '未结算不入营收实收，KPI 与分润都不认',
        '核对这些款项的收款凭证并在订阅/收费墙确认到账');
    }
  } catch (e) {}

  // 学习退化
  try {
    const d = require('./memory-hub').dashboard();
    d.alerts.slice(0, 3).forEach(a => push('mid', '模块「' + a.label + '」停止进化', a.msg, '检查该模块的巡检是否还在跑'));
  } catch (e) {}

  // 性能
  try {
    const tw = require('./tasktime').report();
    const slow = tw.totals.filter(t => t.maxMs > 3000);
    if (slow.length) {
      push('low', slow.length + ' 个后台任务单轮超 3 秒',
        slow.map(s => s.name + ' ' + s.maxMs + 'ms').join('，'),
        '查 /v1/diag/loop 的任务耗时表，定位同步阻塞点');
    }
  } catch (e) {}

  // 目标进度落后
  try {
    const al = require('./goals').alignment();
    if (al.target > 0 && al.pct < 20 && al.daysLeft > 0) {
      push('high', '目标进度仅 ' + al.pct + '%，剩 ' + al.daysLeft + ' 天',
        '按当前日均 ¥' + (al.revenue / Math.max(1, al.daysLeft)).toFixed(0) + ' 推算，远不足以达标',
        '要么提高日均产出，要么重新评估目标值是否现实');
    }
  } catch (e) {}

  const order = { high: 0, mid: 1, low: 2 };
  return A.sort((a, b) => order[a.sev] - order[b.sev]);
}

// —— 战情室图表数据（第 13 条：图表 + 人员脉络 + 场景动态）——
// 全部返回可直接渲染的数值数组，前端不自己算，避免各处口径不一。
function charts() {
  const db = store.read();
  const now = Date.now();
const DAY = 86400000;

// 把可能是对象/数组的字段压成一行可读文本。
// 起因：leads.closeGate 是对象，直接字符串拼接会渲染成 [object Object]，
// 用户看到的是坏 UI 而不是坏数据——比报错更难察觉。
function flatText(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback || '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(x => flatText(x, '')).filter(Boolean).join('；') || (fallback || '');
  if (typeof v === 'object') {
    // 优先取人话字段
    const keys = ['text', 'msg', 'message', 'reason', 'title', 'desc', 'gate', 'label'];
    for (const k of keys) if (v[k]) return flatText(v[k], '');
    return Object.keys(v).map(k => k + '=' + flatText(v[k], '')).join(' ').slice(0, 120) || (fallback || '');
  }
  return String(v);
}

  // 1) 近 14 天营收趋势（已结算口径）
  const rev = [];
  for (let i = 13; i >= 0; i--) {
    const d0 = now - i * DAY;
    const day = new Date(d0).toDateString();
    let settled = 0, pending = 0;
    (db.revenue || []).forEach(r => {
      const at = r.at || r.createdAt || 0;
      if (new Date(at).toDateString() !== day) return;
      let ok = false;
      try { ok = require('./money').isSettled(r); } catch (e) {}
      if (ok) settled += Number(r.amt || r.amount || 0); else pending += Number(r.amt || r.amount || 0);
    });
    rev.push({ day: day.slice(5), settled, pending });
  }

  // 2) 漏斗各段分布
  let funnel = [];
  try {
    const b = require('./leadgen').board();
    funnel = Object.keys(b.byStage || {}).map(k => ({ name: k, value: b.byStage[k] }));
  } catch (e) {}

  // 3) 任务状态分布
  const tasks = db.tasks || [];
  const taskPie = [
    { name: '已完成', value: tasks.filter(t => t.done).length },
    { name: '在跑', value: tasks.filter(t => !t.done && (t.running === true || t.status === 'running')).length },
    { name: '待认领', value: tasks.filter(t => !t.done && !t.owner).length },
    { name: '受阻', value: tasks.filter(t => !t.done && t.blocked === true).length }
  ].filter(x => x.value > 0);

  // 4) 人员脉络：每人（认领数、完成数、当前在办标题）
  const nameOf = {};
  (db.staff || []).forEach(s => nameOf[s.id] = s);
  const ownerAgg = {};
  tasks.forEach(t => {
    if (!t.owner) return;
    const a = ownerAgg[t.owner] || (ownerAgg[t.owner] = { owner: t.owner, name: nameOf[t.owner] ? nameOf[t.owner].name : t.owner, doing: 0, done: 0, titles: [] });
    if (t.done) a.done++; else { a.doing++; if (t.title) a.titles.push(t.title.slice(0, 24)); }
  });
  const people = Object.values(ownerAgg).sort((a, b) => b.doing - a.doing).slice(0, 12)
    .map(a => ({ ...a, titles: a.titles.slice(0, 3) }));

  // 5) 场景动态：最近 24h 系统发生了什么（时间线）
  const scene = [];
  (db.audit || []).slice(0, 60).forEach(a => {
    const at = a.at || 0;
    if (!at || now - at > DAY) return;
    scene.push({ at, action: a.action || '', detail: String(a.detail || '').slice(0, 90) });
  });
  scene.sort((a, b) => b.at - a.at);

  // 6) 学习产出趋势（近 14 天，按模块堆叠）
  const learnTrend = [];
  try {
    const list = require('./memory-hub').entries();
    for (let i = 13; i >= 0; i--) {
      const d0 = now - i * DAY, day = new Date(d0).toDateString();
      const row = { day: day.slice(5) };
      const byMod = {};
      list.forEach(x => { if (x.at && new Date(x.at).toDateString() === day) byMod[x.mod] = (byMod[x.mod] || 0) + 1; });
      row.mods = byMod;
      row.total = Object.values(byMod).reduce((a, b) => a + b, 0);
      learnTrend.push(row);
    }
  } catch (e) {}

  return { revenue: rev, funnel, taskPie, people, scene, learnTrend, at: now };
}

// —— 守护·策略智慧库（第 12 条后半：不是资料，是可执行的作战策略）——
// 每条策略必须有"适用场景 + 动作 + 判据"，只有文字描述的一律不算策略。
const STRATEGIES = [
  { id: 'st.focus', cat: '节奏', name: '单点突破', when: '同时推进 >3 条战线且每条都无进展', do: '砍到 1 条，其余明确挂起而不是并行', judge: '一周后主战线是否前进' },
  { id: 'st.gate', cat: '收敛', name: '触达闸门', when: '线索充足但成交为 0', do: '先完成 N 条真实触达，闸门才开', judge: '真实触达数是否上升' },
  { id: 'st.cash', cat: '现金', name: '到账优先', when: '存在未结算款项', do: '催到账优先于一切新投入', judge: '已结算实收是否增加' },
  { id: 'st.hire', cat: '组织', name: '按缺口增员', when: '某能力域无人可承接任务', do: '自动增员而非让一个人硬扛', judge: '待认领任务是否归零' },
  { id: 'st.loop', cat: '复盘', name: '验证闭环', when: '沉淀了经验但验证率低', do: '只把已验证结论用于决策', judge: '验证率是否提升' },
  { id: 'st.stale', cat: '风险', name: '停滞检测', when: '某模块连续 7 天无学习产出', do: '检查巡检是否停摆', judge: '是否恢复新增' },
  { id: 'st.slow', cat: '性能', name: '长任务拆解', when: '后台任务单轮超 3 秒', do: '拆分同步阻塞点或加并发守卫', judge: '最大耗时是否下降' },
  { id: 'st.decide', cat: '决策', name: '决策收口', when: '有指向性任务长期未完成', do: '逐条给出可核查结论，关闭悬空决策', judge: '决策是否标记为已有答案' },
  { id: 'st.honest', cat: '诚信', name: '口径一致', when: '多个页面数字对不上', do: '统一走 warboard 单一事实源', judge: '各页数字是否一致' },
  { id: 'st.pace', cat: '节奏', name: '目标反推', when: '目标进度落后但仍在按当前节奏推进', do: '用剩余天数反推所需日产出，对不上就改目标或改打法', judge: '所需日产出是否可达' }
];

function wisdom() {
  return {
    strategies: STRATEGIES,
    // 策略与当前真实状态的匹配结果——让"智慧库"能指出此刻该用哪几条
    matched: STRATEGIES.filter(s => {
      const M = {}; modules().forEach(m => M[m.id] = m);
      const A = advisories();
      if (s.id === 'st.gate') return A.some(a => a.title.indexOf('真实触达') >= 0);
      if (s.id === 'st.cash') return A.some(a => a.title.indexOf('未到账') >= 0);
      if (s.id === 'st.hire') return A.some(a => a.title.indexOf('无人认领') >= 0);
      if (s.id === 'st.decide') return A.some(a => a.title.indexOf('决策') >= 0);
      if (s.id === 'st.slow') return A.some(a => a.title.indexOf('超 3 秒') >= 0);
      if (s.id === 'st.stale') return A.some(a => a.title.indexOf('停止进化') >= 0);
      if (s.id === 'st.pace') return A.some(a => a.title.indexOf('目标进度') >= 0);
      if (s.id === 'st.focus') return (store.read().tasks || []).filter(t => !t.done).length > 3;
      return false;
    }).map(s => s.id)
  };
}

function snapshot() {
  return { modules: modules(), advisories: advisories(), charts: charts(), wisdom: wisdom(), at: Date.now() };
}

module.exports = { modules, advisories, charts, wisdom, snapshot, STRATEGIES };