// core/tenancy.js — 访客数据归属层（留存根因的最小安全解）
//
// 问题诊断（来自粘性审计）：store 是单一全局 db.json，所有累积资产
// （decisions / knowledge / reports / messages / lessons）都没有访客维度。
// 后果是双向的：
//   ① 留存侧：订阅唯一买到的是"次数"，没有任何东西会因停订而丢失 → 零续费动机。
//   ② 新增侧：新用户一进来就看到别人的全部数据 → 隐私灾难 + 首日流失。
//
// 本模块采取**加法式**策略（不破坏现有全局视图、不做大规模数据迁移）：
//   · markOwned(collection, rec)   给新写入的记录打上 visitor 归属（可选调用，逐步铺开）
//   · ownedBy(collection, vid)    列出某访客自己的记录（"我的数据"入口）
//   · assetCount(vid)             该访客的累积资产盘点（决定续费价值锚点的底数）
//   · myDataSummary(vid)          面向 UI 的"我的沉淀"摘要 + 停订会失去什么的提示
//
// 红线：绝不删除/迁移任何既有数据；老记录没有归属字段就归为"全局/历史"，
// 不硬塞给任何访客（避免把别人的数据变成某个用户的隐私泄漏）。
//
// 设计边界：这是"归属标记 + 可见性"，不是完整的物理隔离。真正的多租户（物理分库）
// 需要迁移全部读写路径，风险与工作量都远大于本轮收益，先用归属层把复购价值锚点做出来。

const store = require('./store');

// 可归属的集合（渐进铺开：从"用户主动产生的资产"开始）
const OWNABLE = ['decisions', 'knowledge', 'reports', 'messages', 'lessons'];

// 给记录打归属（幂等：已有归属不覆盖）
function markOwned(collection, rec, vid) {
  if (!rec || OWNABLE.indexOf(collection) < 0) return rec;
  const key = String(vid || '').trim();
  if (!key) return rec;
  if (rec.visitor && rec.visitor !== key) {
    // 归属冲突：保留原归属，记审计（诚实：归属只有一个主人）
    try { store.push('audit', { action: '数据归属冲突', detail: collection + ' ' + (rec.id || '') + ' 已有归属，拒绝改写', at: Date.now() }, null, null); } catch (e) {}
    return rec;
  }
  if (!rec.visitor) {
    try {
      const fresh = store.read();
      const arr = fresh[collection] || [];
      const hit = arr.find(x => x.id === rec.id);
      if (hit) { hit.visitor = key; store.write(fresh); rec.visitor = key; }
    } catch (e) {}
  }
  return rec;
}

// 列出某访客自己的记录（新建 + 已归属；老的无归属记录不返回）
function ownedBy(collection, vid, limit) {
  const key = String(vid || '').trim();
  if (!key) return [];
  const all = store.list(collection, 999);
  return all.filter(x => x && x.visitor === key).slice(-(limit || 200)).reverse();
}

// 某访客的资产盘点（复购价值锚点的底数）
function assetCount(vid) {
  const key = String(vid || '').trim();
  const out = {};
  let total = 0;
  for (const c of OWNABLE) {
    const all = store.list(c, 999);
    const n = key ? all.filter(x => x && x.visitor === key).length : 0;
    out[c] = n; total += n;
  }
  return { ok: true, visitor: key, byCollection: out, total };
}

// 面向 UI："我的沉淀" 摘要 + 续费价值锚点
//
// 【诚实红线】续费理由只允许陈述**真实收益**，绝不能用"停订就删数据"施压：
//   到期时系统只收起订阅时长（sublist.expireAt），资产数据从不删除、从不迁移
//   （见本模块红线）。把"数据还在"说成"不续费就没了"是勒索式挽留，
//   一旦被用户发现（换台设备登录就看到数据还在），信任一次性归零。
function myDataSummary(vid) {
  const key = String(vid || '').trim();
  const a = assetCount(key);
  const has = a.total > 0;
  return {
    ok: true, visitor: key, ...a,
    hasAssets: has,
    // 价值锚点：把"数据跟着你"变成可见的留存理由，而不是空喊
    message: has
      ? '你已沉淀 ' + a.total + ' 条资产（决策/知识/报告/对话），它们挂在你的账号下。'
      : '还没有专属沉淀——多问几个问题、多沉淀几条知识，之后产生的都会只属于你。',
    // 只能说真话的续费理由：继续无限用 + 资产不会被清掉（不是"会没了"）
    renewAnchor: has
      ? '续费继续无限用；已沉淀的 ' + a.total + ' 条资产不会因到期被清掉'
      : ''
  };
}

module.exports = { OWNABLE, markOwned, ownedBy, assetCount, myDataSummary };
