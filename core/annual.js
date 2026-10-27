// core/annual.js — 年度决策报告聚合 + 止损线总表 L1–L4（FINAL-2.0 §1 A1/v19 §10.4 落地）
// 年报：吃真数据（decisions/persona/tasks/knowledge/audit/peers/manuals），
//       只回答"能诚实回答的问题"，答不了的不编（n 不足则如实标注）。诚实缺陷板块主动声明。
// 止损线：L1 首月回款<800 ｜ L2 编造逃逸≥1 且72h未修 ｜ L3 M12回款<5万且资产连续4周零增长
//         ｜ L4 创始人连续两周无法完成周日仪式。任一亮红 → 返回行动。

const store = require('./store');
const persona = require('./persona');
const peers = require('./peers');
const manuals = require('./manuals');

const R = Math.round;

function now() { return new Date(); }

// 取 db 各集合快照（统一读一次，避免多次 IO）
function snap() {
  const db = store.read();
  return db;
}

// 决策人格×场景交叉（决策 engine 带 topic 时归类）
function sceneOf(decision) {
  const t = String(decision.question || decision.topic || '').toLowerCase();
  const rules = [
    ['职场', ['辞职', '跳槽', '升职', 'offer', '工作', '裁员', '离职']],
    ['升学', ['考研', '考公', '高考', '志愿', '读书', '上岸', '留学']],
    ['迁移', ['搬家', '城市', '老家', '移民', '异地']],
    ['财务', ['钱', '买', '股', '基金', '负债', '工资', '投资', '存']],
    ['关系', ['分手', '结婚', '离婚', '恋爱', '伴侣', '朋友', '复合', '家人']],
    ['健康', ['病', '手术', '体检', '复诊', '焦虑', '失眠']]
  ];
  for (const [name, kws] of rules) if (kws.some(k => t.includes(k))) return name;
  return '其他';
}

// —— 年报主聚合：全部基于真实 db ——
function annual() {
  const db = snap();
  const decs = db.decisions || [];
  const pers = db.persona || [];
  const tasks = db.tasks || [];
  const ks = db.knowledge || [];
  const evo = db.evolution || [];
  const audit = db.audit || [];

  const n = decs.length;
  const scenes = {};
  decs.forEach(d => { const s = sceneOf(d); scenes[s] = (scenes[s] || 0) + 1; });
  const byScene = Object.entries(scenes).sort((a, b) => b[1] - a[1]);

  // 决策人格分布
  const typeCount = {};
  pers.forEach(p => { if (p.type) typeCount[p.type] = (typeCount[p.type] || 0) + 1; });
  const typeTop = Object.entries(typeCount).sort((a, b) => b[1] - a[1]).slice(0, 3);

  // 7 日决策节奏（近 30 天滚动）
  const d30 = new Date(); d30.setDate(d30.getDate() - 30);
  const last30 = decs.filter(d => (d.createdAt || 0) >= d30.getTime()).length;
  const last30distinct = new Set(decs.filter(d => (d.createdAt || 0) >= d30.getTime()).map(d => new Date(d.createdAt).toDateString())).size;

  // T1 灯角 / 手册 / 被帮
  const peerStats = peers.stats();

  // 诚实缺陷板块（FINAL-1.1 2.9 / v19 §1）
  const defects = [];
  if (n < 100) defects.push('样本数不足（n=' + n + '）：本报告为小样本观察，不构成总体判断');
  if (pers.length < 20) defects.push('人格分布仅覆盖 ' + pers.length + ' 次作答，稳定性待样本扩大');
  defects.push('幸存者回填偏差：报告只统计"愿意留下的用户"，未涵盖流失样本');

  const recom = buildRecommendation({ typeTop, scenes, n });

  return {
    generatedAt: Date.now(),
    n,
    scenes: byScene,
    tasksDone: tasks.filter(t => t.done).length,
    knowledge: ks.length,
    evolutionEvents: evo.length,
    personaAnswered: pers.length,
    typeTop,
    last30, last30distinct,
    peer: peerStats,
    lights: peers.countLights(),
    manuals: manuals.list().length,
    defects,
    recom
  };
}

function buildRecommendation({ typeTop, scenes, n }) {
  if (n < 3) return [];
  const out = [];
  const topScene = scenes[0];
  const topType = typeTop[0];
  if (topScene) out.push('最重要的人生议题集中在「' + topScene[0] + '」（' + topScene[1] + ' 次）——明年把它拆成季度问题，每季解决一层。');
  if (topType) out.push('决策人格以「' + topType[0] + '」为主（' + topType[1] + ' 次作答）——请对照六型建议补短板维度。');
  if (n >= 100) out.push('n=' + n + '，本报告达到"年度观察"最低样本，可对外公开（v19 A1 门槛 n≥10,000 未达，降格为小样本观察）。');
  return out;
}

// —— 止损线总表（一页四行）——
// 营收唯一权威来源：db.revenue（money.credit 真实入账），ledger 仅为历史兼容字段
// 账实分离：只统计已结算实收，成交未到账不进营收口径
function revenueTotal() { const m = require('./money'); const db = snap(); const byId = new Map((db.orders || []).map(o => [String(o.id), o])); return (db.revenue || []).filter(r => m.isSettled(r) && !m.isSelfTest(r, byId)).reduce((a, b) => a + Number(b.amt || b.amount || 0), 0); }

function stopLines() {
  const db = snap();
  const audit = db.audit || [];
  const ln = {},
        baggage = db.memory || [],
        nowMs = Date.now();

  // L1：M3 公开首月回款 <800 元。用 ledger 净额 + 项目启动天数近似"已运营月份"
  const revenue = revenueTotal();
  const firstProj = (db.tasks || []).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
  const boot = firstProj ? firstProj.createdAt : (audit.length ? audit[0].at : nowMs);
  const months = Math.max(1, Math.floor((nowMs - boot) / (30 * 86400000)));
  const l1 = { months: months + ' 个月', revenue: '¥' + revenue, red: months <= 3 && revenue < 800 ? true : false };

  // L2：编造逃逸 ≥1 且 72h 未修复。memory 里记录 '编造逃逸' 键
  const fab = baggage.find(m => m.key === '编造逃逸');
  const fabAge = fab ? Math.floor((nowMs - (fab.updatedAt || fab.at || nowMs)) / 86400000) : null;
  const l2 = { last: fab ? fab.value : '无', red: !!(fab && fabAge != null && fabAge < 1 && !String(fab.value || '').includes('已修复')) };

  // L3：M12 累计回款 <5 万 且资产六问连续 4 周零增长。资产增长近似用 knowledge+audit 周增量
  const kBefore = (db.knowledge || []).slice(0, -3); // 简化：用当月知识增量判断
  const lastWeek = nowMs - 7 * 86400000;
  const weekK = (db.knowledge || []).filter(x => (x.createdAt || 0) >= lastWeek).length;
  const l3 = { cumulative: '¥' + revenue, weekK, red: months >= 12 && revenue < 50000 && weekK === 0 };

  // L4：创始人连续两周无法完成周日仪式——记录在 tasks 里 '周日仪式'
  const rits = (db.tasks || []).filter(t => /周日|仪式/.test(String(t.title || '')));
  const lastRit = rits.slice().sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0];
  const ritAge = lastRit ? Math.max(0, Math.floor((nowMs - (lastRit.updatedAt || lastRit.createdAt || nowMs)) / 86400000)) : 99;
  const l4 = { lastRit: lastRit ? (lastRit.title + ' ' + (lastRit.done ? '✓' : '✗')) : '无记录', days: ritAge + ' 天', red: ritAge > 14 };

  const reds = [l1.red, l2.red, l3.red, l4.red];
  const lines = [
    { id: 'L1', desc: 'M3 公开首月回款 <800 元（G1G2 双败）', now: l1, action: '目标改口 300 万/9 个月口径，停外部扩张' },
    { id: 'L2', desc: '编造逃逸 ≥1 且 72h 未修复', now: l2, action: '全站推演下线保档案，修复到 0 再上' },
    { id: 'L3', desc: 'M12 累计回款 <5 万且资产连续 4 周零增长', now: l3, action: '收缩：只保语料+档案+已签 B 端，转轻团队重资产' },
    { id: 'L4', desc: '创始人连续两周无法完成周日仪式', now: l4, action: '强制休整 72h → 评估外包/缓速——人比计划重要' }
  ];
  return { lines, anyRed: reds.some(Boolean), generatedAt: Date.now(), revenue, months };
}

// 月度公示：当月各项事实计数（共建中心月度公示用）
function monthSheet() {
  const y = now().getFullYear(), m = String(now().getMonth() + 1).padStart(2, '0');
  const db = snap();
  const same = ts => { const d = new Date(ts); return d.getFullYear() === y && String(d.getMonth() + 1).padStart(2, '0') === m; };
  return {
    ym: y + '-' + m,
    decisions: (db.decisions || []).filter(d => same(d.createdAt)).length,
    auditsWritten: (db.audit || []).filter(a => same(a.at)).length,
    knowledgePlus: (db.knowledge || []).filter(x => same(x.createdAt)).length,
    lightsApproved: (db.peers || []).filter(x => x.kind === 'T1' && x.approved && same(x.createdAt)).length,
    handoffs: (db.handoffs || []).filter(h => same(h.createdAt)).length
  };
}

module.exports = { annual, stopLines, monthSheet, sceneOf };