// core/smart.js — 智能对话增强层（让对话"能干活"，而不只是聊天）
// 职责：
//   1) 意图识别：把自然语言映射到**全量**技能/数据模块（不再只认 8 个硬编码）
//   2) 自动工具调用：命中即先跑真实技能，把结果喂给 LLM（工具增强 = 认知升级）
//   3) 联网情报接入：话题含"最新/趋势/开源"时自动抓 GitHub/热点作为证据
//   4) 上下文注入：把项目真实数据（KPI/线索/技能/决策/线索 ROI…）喂给模型
//
// 修复的历史问题（用户实测反馈"聊天调不动项目里的数据和技能"）：
//   旧实现只有 8 条句首正则（/^天气/…），必须句中匹配才行；skilllib 的 120 个技能
//   一个都调不到，用户只能去技能面板手动点。现改为全量语义路由：
//   ① 技能名/别名/分类 直接命中（含句中、不限句首）
//   ② 未命中则按 desc 做关键词打分，取最高分
//   ③ 命中不了则注入项目数据快照，让模型基于真实数据回答而不是空谈。

const skills = require('./skills');
const skilllib = require('./skilllib');
const intel = require('./intel');
const decision = require('./decision');

// ---- 技能索引：id/name/cat/desc + 触发词 → 供全量语义匹配 ----
const INDEX = (() => {
  const arr = [];
  try {
    (skilllib.SKILLS || []).forEach(s => {
      const trig = [s.id, s.name, s.cat, s.desc].filter(Boolean).join(' ');
      arr.push({ id: s.id, name: s.name, cat: s.cat, trig: trig.toLowerCase() });
    });
  } catch (e) {}
  return arr;
})();

// 显式别名（用户口语 → 技能 id），覆盖正则抓不到的高频说法
const ALIAS = [
  [/盈亏平衡|保本点|回本/, 'break_even'],
  [/ROI|投资回报|回报率/, 'roi_calc'],
  [/贷款|房贷|月供|按揭/, 'loan_pmt'],
  [/转化|漏斗|获客/, 'funnel'],
  [/病毒系数|virality|传播系数/i, 'viral_k'],
  [/帕累托|80\/20|二八法则/, 'pareto'],
  // 天气：允许"今天/明天/现在"等前缀，不限句首（旧实现 ^天气 导致"今天天气"抓不到）
  [/(天气|气温|多少度|下雨|湿度|冷不冷|热不热)/, 'weather'],
  [/^(新闻|今日新闻|要闻)|新闻头条/, 'news'],
  [/全网检索|检索开源|找开源|github/i, 'search'],
  [/^(热点|趋势|风口)|行业热点/, 'trends'],
  [/情感|舆情|态度/, 'sentiment'],
  [/预测|测算/, 'forecast']
];

// 意图识别：返回 { type, ... }，type ∈ skill/websearch/decision/data/chat
function detect(text) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();

  // ① 别名优先（精确、便宜）
  for (const [re, id] of ALIAS) {
    if (re.test(t)) {
      if (id === 'search') return { type: 'websearch', q: t };
      if (id === 'trends') return { type: 'skill', id: 'trends', args: {} };
      if (id === 'weather' || id === 'news' || id === 'sentiment' || id === 'forecast') {
        return { type: 'skill', id, args: { q: t, text: t, data: t } };
      }
      return { type: 'skill', id, args: { raw: t } };
    }
  }

  // ② 全量技能：句中命中技能名/类别 → 直接调（不限句首，这是关键修复）
  //    匹配策略：先全名匹配；再按技能名的"核心词"匹配（去掉"分析/测算/计算"等通用后缀，
  //    因为用户说的是"帕累托分析"而不是全名"帕累托 80/20 分析"）。
  for (const s of INDEX) {
    const nm = String(s.name || '');
    if (nm.length >= 2 && low.includes(nm.toLowerCase())) {
      return { type: 'skill', id: s.id, args: { raw: t, q: t } };
    }
  }
  for (const s of INDEX) {
    const core = String(s.name || '')
      .replace(/分析|测算|计算|模型|方法|工具|评估|诊断/g, ' ')   // 去通用后缀
      .replace(/[0-9%\/\s]+/g, ' ')                                 // 去数字与符号
      .trim();
    // 核心词至少 2 字才可靠（如"帕累托""病毒系数"），且需在用户话里出现
    if (core.length >= 2 && low.includes(core.toLowerCase())) {
      return { type: 'skill', id: s.id, args: { raw: t, q: t } };
    }
  }
  // ③ 全量技能：按 desc 打分，取最高（阈值 2 分，避免乱触发）
  let best = null, bestScore = 0;
  for (const s of INDEX) {
    const words = String(s.desc || '').split(/[\s、，,：:\/]+/).filter(w => w.length >= 2);
    let sc = 0;
    words.forEach(w => { if (low.includes(w.toLowerCase())) sc++; });
    if (s.cat && t.includes(s.cat)) sc += 2;
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  if (best && bestScore >= 2) return { type: 'skill', id: best.id, args: { raw: t, q: t } };

  // ④ 项目自身数据优先于"决策"：问"我们的营收/线索怎么样"要的是**真实数字**，
  //    不是框架建议。旧顺序让「怎么样」被决策规则抢走，导致答非所问。
  //    preferDataFirst 由 harness.toolPolicy 控制（RRSI 可优化它）。
  let policy = { preferSkill: true, preferDataFirst: true, webOnNovelTopic: true, maxToolsPerTurn: 2 };
  try { const h = require('./harness').current(); if (h && h.toolPolicy) Object.assign(policy, h.toolPolicy); } catch (e) {}
  if (policy.preferDataFirst && /(我们的|我的|项目|营收|KPI|客户|线索|获客|转化|收益|赚了多少|库存|欠款|对账|成交)/.test(t)) {
    return { type: 'data', q: t };
  }
  // ⑤ 决策类
  if (/(要不要|该不该|怎么样|怎么选|如何决策|SWOT|波特|矩阵)/i.test(t) || (/框架/.test(t) && /(选|该|做|投入|上马|推进|布局|建议)/.test(t))) {
    const fw = decision.suggest(t.replace(/(要不要|该不该|怎么样|怎么选|如何决策|框架)/g, ''));
    return { type: 'decision', suggest: fw.picks, topic: fw.topic };
  }
  // ⑥ 联网检索（webOnNovelTopic 由 harness 控制）
  let pol2 = { webOnNovelTopic: true };
  try { const h = require('./harness').current(); if (h && h.toolPolicy) Object.assign(pol2, h.toolPolicy); } catch (e) {}
  if (pol2.webOnNovelTopic && /(github|开源|repo|最新|热点|趋势)/i.test(t)) return { type: 'websearch', q: t };
  return { type: 'chat' };
}

// 注入项目真实数据快照（让模型基于真实数字回答，而非空谈）
function dataSnapshot() {
  const store = require('./store');
  const parts = [];
  try {
    const money = require('./money');
    const k = money.kpi(), b = money.budget();
    parts.push('【营收 KPI（真实台账）】已入账 ¥' + Math.round(k.revenue) + ' / 目标 ¥' + (k.target / 10000) + '万（' + k.pct + '%）· 实际日均 ¥' + k.regDaily.toFixed(0) + ' · 需日均 ¥' + k.needDaily.toFixed(0) + ' · ' + (k.onTrack ? '达标' : '落后'));
    parts.push('【推广池】拨备 ¥' + b.allotted + ' · 支出 ¥' + b.spent + ' · 可用 ¥' + b.avail);
  } catch (e) {}
  try {
    const lg = require('./leadgen');
    const lb = lg.board();
    parts.push('【获客漏斗（真实）】线索 ' + lb.total + ' · 成交客户 ' + lb.customers + ' · 成交额 ¥' + lb.deals + ' · 各段：' + JSON.stringify(lb.byStage));
  } catch (e) {}
  try {
    const lessons = require('./lessons');
    parts.push('【经验库】已沉淀 ' + lessons.stats().total + ' 条经验（仅注入已验证的）');
  } catch (e) {}
  return parts.join('\n');
}

// 增强上下文：把工具/数据/情报结果注入系统提示，让 LLM 答得"有据可依"
async function enrich(text) {
  const int = detect(text);
  const out = { intent: int.type, tools: [], context: [] };
  try {
    if (int.type === 'skill') {
      const res = await skills.invoke(int.id, int.args || {}, {});
      if (res && res.ok) {
        out.tools.push({ id: int.id, name: res.name || int.id, elapsedMs: res.elapsedMs });
        out.context.push('【已自动调取技能 ' + (res.name || int.id) + '（真实执行结果）】\n' + String(res.output));
      } else if (res && res.error) {
        out.context.push('【技能 ' + int.id + ' 未执行】' + res.error);
      }
    } else if (int.type === 'data') {
      const snap = dataSnapshot();
      if (snap) { out.tools.push({ id: 'data_snapshot' }); out.context.push('【项目真实数据（权威台账，务必据此回答）】\n' + snap); }
    } else if (int.type === 'decision') {
      out.context.push('【决策框架推荐】针对「' + int.topic + '」，建议优先用：' +
        int.suggest.map(s => s.emoji + ' ' + s.name + '(' + s.cat + ')').join('、') +
        '\n说明：这些是数据显示适配当前话题的框架，可让我用其中任一框架展开。');
      out.tools.push({ id: 'suggest', picks: int.suggest });
    } else if (int.type === 'websearch') {
      const h = await intel.headlines().catch(() => ({ items: [] }));
      const s = await intel.gitSearch(text.replace(/(github|开源|repo|项目|方案|工具|框架库里)/gi, '').trim() || 'agent skill', { per: 4 }).catch(() => ({ items: [] }));
      const parts = [];
      if (h.items.length) parts.push('【全网热点（真实抓取）】\n' + h.items.slice(0, 5).map((x, i) => (i + 1) + '. [' + x.src + '] ' + x.title).join('\n'));
      if (s.items.length) parts.push('【GitHub 开源检索（真实数据）】\n' + s.items.map((x, i) => (i + 1) + '. ' + x.repo + ' ★' + x.stars + ' ' + (x.desc || '').slice(0, 60)).join('\n'));
      if (parts.length) { out.tools.push({ id: 'web' }); out.context.push(parts.join('\n\n')); }
    }
  } catch (e) { /* 工具失败不影响主对话，只降级为纯 LLM */ }
  return out;
}

module.exports = { detect, enrich, dataSnapshot, INDEX };
