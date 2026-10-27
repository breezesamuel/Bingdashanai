// core/evidence.js — 打法证据分级与性价比排序
//
// 借鉴 HowToLiveBetter（eternity4719）的表达格式，而非其内容：
//   1. 每条打法显式标注「成本 / 收益 / 证据等级」，不靠语气传递确定性
//   2. 按性价比排序而非按阶段顺序 —— 零成本高收益的排最前
//   3. 诚实暴露不确定性：作者敢标注自己没做到，本模块也统计「你还没做/未验证」的条目
//
// 分级纪律：本文件不得为了让 playbook 好看而虚高评级。C 级就是 C 级。

const GRADE = {
  A: {
    label: 'A',
    desc: '可验证的通用原则',
    detail: '测量、预设止损阈值、复用已验证资产等不依赖特定渠道运气的方法，'
      + '成立与否你自己就能用现有数据检验',
    weight: 3
  },
  B: {
    label: 'B',
    desc: '有较强行业观察证据',
    detail: '大量同类实践反复出现同一方向，但未在你自己的场景验证，且平台机制不透明、'
      + '效应量可能因场景而异',
    weight: 2
  },
  C: {
    label: 'C',
    desc: '经验判断 / 个案',
    detail: '主要靠推理、类比和试错，没有对照证据。可能对，也可能是幸存者偏差',
    weight: 1
  }
};

const COST = {
  0: { label: '零成本', desc: '纯复用已有资产或已有数据，不新增人力与预算' },
  1: { label: '低', desc: '< 1 小时' },
  2: { label: '中', desc: '1–4 小时' },
  3: { label: '高', desc: '> 4 小时，或需要真金白银' }
};

// 逐日元数据：c=成本档 0-3，imp=影响档 1-5，ev=证据等级，m=可度量收益指标
// 影响档定义：5=决定项目生死 4=显著影响漏斗 3=中等 2=边际 1=几乎无
const E = {
  1:  { c: 1, imp: 5, ev: 'C', m: '见证官 50 人清单 + 发放额度台账' },
  2:  { c: 2, imp: 4, ev: 'B', m: '首篇长答的收藏/赞同数与引流数' },
  3:  { c: 2, imp: 3, ev: 'B', m: '第 2 篇对比首篇的边际增益' },
  4:  { c: 2, imp: 2, ev: 'C', m: '第 3 篇是否已明显递减' },
  5:  { c: 1, imp: 3, ev: 'C', m: '小红书首帖的互动率' },
  6:  { c: 1, imp: 4, ev: 'B', m: '回收反馈条数 + 群成员数' },
  7:  { c: 0, imp: 2, ev: 'C', m: '群内首周发言人数（防沉默群）' },
  8:  { c: 1, imp: 3, ev: 'C', m: '合集帖带来的二次注册' },
  9:  { c: 1, imp: 2, ev: 'C', m: '每日一贴的自然流量基线' },
  10: { c: 1, imp: 2, ev: 'C', m: '同上，取多帖中位数而非最高值' },
  11: { c: 1, imp: 2, ev: 'C', m: '同上' },
  12: { c: 1, imp: 2, ev: 'C', m: '同上' },
  13: { c: 2, imp: 3, ev: 'C', m: '置换到的博主粉丝量合计' },
  14: { c: 0, imp: 5, ev: 'A', m: '注册/完读/付费三数入台账（后续一切判断的地基）' },
  15: { c: 1, imp: 5, ev: 'B', m: '两档定价各挂出后的下单分布' },
  16: { c: 1, imp: 5, ev: 'B', m: '通过数 ≥ 3 单' },
  17: { c: 1, imp: 3, ev: 'B', m: '促单动作的转化提升幅度' },
  18: { c: 0, imp: 5, ev: 'A', m: '付费验证截止判定（预设止损，防沉没成本）' },
  19: { c: 2, imp: 4, ev: 'B', m: '灰度放开后的卡库通过率变化' },
  20: { c: 1, imp: 2, ev: 'C', m: '灯角点亮流程实测是否跑通' },
  21: { c: 0, imp: 5, ev: 'A', m: '自然 CAC 基线（此后所有获客成本的参照系）' },
  22: { c: 0, imp: 3, ev: 'B', m: '变体 A 与原版的差异（需样本量支撑）' },
  23: { c: 0, imp: 2, ev: 'B', m: '变体 B 的表现' },
  24: { c: 0, imp: 2, ev: 'B', m: '三条变体的中位数（避免用最高一条自我安慰）' },
  25: { c: 0, imp: 4, ev: 'A', m: '哪条自然流量最稳（可复现性判断）' },
  26: { c: 1, imp: 3, ev: 'B', m: '里程碑帖的公开数据姿态是否带来信任转化' },
  27: { c: 3, imp: 4, ev: 'C', m: '5 份授权访谈（成本最高的一条，素材质量决定后续内容上限）' },
  28: { c: 1, imp: 3, ev: 'C', m: '素材入库条数与可复用比例' },
  29: { c: 1, imp: 3, ev: 'B', m: '资产六问首月填报完整度' },
  30: { c: 0, imp: 5, ev: 'A', m: 'Go/No-Go 判定本身是 A；但 ≥300 注册/≥3 付费这个阈值是拍的，属 C' }
};

function of(day) {
  const d = Number(day);
  return E[d] || null;
}

// 性价比 = 影响 / (成本 + 0.5)
// +0.5 使零成本条目获得额外权重，但不至于让「免费但没用」压过「贵但关键」
function roi(day) {
  const e = of(day);
  if (!e) return 0;
  return Math.round((e.imp / (e.c + 0.5)) * 100) / 100;
}

// 按性价比排序（HowToLiveBetter 的核心主张：零成本高收益排最前）
function ranked(days) {
  const list = (days || []).map(d => ({ day: d, ...(of(d) || {}) })).filter(x => x.ev);
  return list.sort((a, b) => (b.roi !== undefined ? b.roi : roi(b.day)) - (a.roi !== undefined ? a.roi : roi(a.day)));
}

// 汇总：等级分布、成本分布、建议优先做的条目
function summary(days) {
  const rows = (days || []).map(d => ({ day: d, ...(of(d) || {}) })).filter(x => x.ev);
  const byEv = { A: [], B: [], C: [] };
  rows.forEach(r => { if (byEv[r.ev]) byEv[r.ev].push(r.day); });
  const byCost = { 0: [], 1: [], 2: [], 3: [] };
  rows.forEach(r => { if (byCost[r.c] !== undefined) byCost[r.c].push(r.day); });
  const top = ranked(rows.map(r => r.day)).slice(0, 5);
  return {
    total: rows.length,
    byEv: {
      A: { n: byEv.A.length, days: byEv.A },
      B: { n: byEv.B.length, days: byEv.B },
      C: { n: byEv.C.length, days: byEv.C }
    },
    byCost: {
      0: { n: byCost[0].length, days: byCost[0], desc: COST[0].label },
      1: { n: byCost[1].length, days: byCost[1], desc: COST[1].label },
      2: { n: byCost[2].length, days: byCost[2], desc: COST[2].label },
      3: { n: byCost[3].length, days: byCost[3], desc: COST[3].label }
    },
    top,
    caveat: 'C 级占比 ' + (byEv.C.length && rows.length ? Math.round(byEv.C.length / rows.length * 100) : 0)
      + '%：这些是经验判断，效应量未知。冷启动期试错便宜所以可做，但不要把它们当成已验证结论去投钱。'
  };
}

// 诚实检查：你自称有把握的，和实际有证据支撑的，差多少
function honestyCheck(days, doneDays) {
  const rows = (days || []).map(d => ({ day: d, ...(of(d) || {}) })).filter(x => x.ev);
  const done = new Set((doneDays || []).map(Number));
  const doneRows = rows.filter(r => done.has(r.day));
  const doneC = doneRows.filter(r => r.ev === 'C');
  const notStarted = ranked(rows.filter(r => !done.has(r.day)).map(r => r.day)).map(r => r.day);
  return {
    done: doneRows.length,
    doneByEv: {
      A: doneRows.filter(r => r.ev === 'A').length,
      B: doneRows.filter(r => r.ev === 'B').length,
      C: doneRows.filter(r => r.ev === 'C').length
    },
    zeroCostNotDone: notStarted.filter(d => of(d).c === 0),
    caveat: doneC.length
      ? '已完成的 ' + doneRows.length + ' 条里有 ' + doneC.length + ' 条是 C 级经验判断 —— 结论别下太早'
      : '已完成的条目里没有纯 C 级判断，可信度较好'
  };
}

module.exports = { GRADE, COST, E, of, roi, ranked, summary, honestyCheck };
