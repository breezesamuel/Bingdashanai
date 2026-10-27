// core/skillspace.js — 技能军械库中枢（第 9 条）
//
// 【需求】"技能军械库中的UI界面需要优化完善，有覆盖和边界不清等各种问题"
//
// 【诊断出的三个真问题】
//   1. **分类从未暴露**。skilllib.list() 返回的是**数组元组** [id,name,cat,'内置']，
//      不是对象。于是任何写 s.cat 的地方拿到的都是 undefined——
//      页面上"按分类筛选"根本没法做，因为分类数据在 API 层就不存在。
//      我实测 120 个技能的 cat 全是 undefined，这就是"边界不清"的直接来源。
//   2. **重复与近似技能混在一起**，用户分不清该用哪个。
//      例：盈亏平衡分析 / 现金流规划 / 资金消耗跑道，输入相似、输出不同，
//      界面上并列排开，用户只能一个个试。
//   3. **内置技能与外部装载技能没有明确分界**，看不出哪些能用、哪些只是收录未验证。
//
// 【解法】本模块做三件事，全部基于真实数据，不编造：
//   categorize()  分类 + **重叠检测**：用关键词算出每个技能命中哪些能力域，
//                 命中多个就是"边界不清"，直接标出来给用户看，而不是偷偷藏起来
//   clusters()    把用途相近的技能聚成"方案组"，回答"我想做 X 该调哪个"
//   trust()       可用性分级：内置(可直接调) / 外部已验证 / 外部未验证(仅参考)
//
// 【诚实红线】外部技能是 GitHub 收录的代码，**默认未验证**。
// 不因为它出现在列表里就说"已装载可用"——那会诱导用户以为能直接调用。

const skilllib = require('./skilllib');
const skills = require('./skills');

// 能力域 → 关键词。用于重叠检测与聚类。
const DOMAINS = [
  { key: '财务', color: 'rgba(16,185,129,.75)', kw: ['财务', '成本', '盈亏', '保本', '收益', '投资', 'roi', '回本', '回收期', '杠杆', '现金流', '融资', '贷款', '月供', '利息', '复利', '年金', '资金', '消耗', '跑道', '预算', '税', '估值', '定价', '定价'] },
  { key: '营销', color: 'rgba(59,130,246,.75)', kw: ['营销', '增长', '客户', '用户', '渠道', '转化', '留存', '漏斗', '获客', '品牌', '定位', '定价', '促销', '会员', '复购', '线索', '市场规模', '竞品', '定价策略'] },
  { key: '运营', color: 'rgba(245,158,11,.75)', kw: ['运营', '流程', '管理', '质量', '效率', '执行', '标准', 'sop', '排期', '工时', '产能', '交付', '服务', '排队'] },
  { key: '数据', color: 'rgba(168,85,247,.75)', kw: ['数据', '统计', '指标', 'kpi', '分析', '报表', '看板', '归因', '预测', '模型', '口径', '样本', '显著性'] },
  { key: '决策', color: 'rgba(239,68,68,.75)', kw: ['决策', '判断', '选择', '权衡', '评分', '打分', '优先级', '排序', '风险', '评估', '矩阵', '帕累', '机会', '成本效益'] },
  { key: '技术', color: 'rgba(34,211,238,.75)', kw: ['算法', '技术', '架构', '代码', '系统', '编程', '接口', '性能', '缓存', '并发', '数据库', '部署', '运维', 'ai', '智能'] }
];

// 外部技能（GitHub 收录）的 cat 字段是**收藏来源**（scout/agents/ml/dev…），
// 不是能力分类。直接展示会出现 21 个"scout 65 项 / agents 34 项"这种
// 用户完全无法理解的分组——这正是第 9 条说的"覆盖和边界不清"。
// 处置：外部技能**不按原 cat 分组**，改按"命中了哪些能力域"归类；
// 一个域都命不中的，归入「待归类」并显式说明它只有名字、缺描述。
const SOURCE_TAGS = ['scout', 'agents', 'dev', 'ml', 'llm', 'tts', 'mcp', 'fin', 'api', 'desk',
  'governance2', 'industrial', 'monitoring', 'agencies', 'agency', 'office', 'tasks', 'wiki',
  'flow', 'chrome', 'db', 'builder', 'ocr', 'memory', 'reddit', 'ecommerce', 'git', 'net',
  'publish', 'auth', 'ui', 'browser', 'reference', 'ops', 'doc', 'learn', 'game', 'coord', 'governance'];

function isSourceTag(cat) {
  return SOURCE_TAGS.indexOf(String(cat || '').toLowerCase()) >= 0;
}

// 把所有技能统一成**对象**（修掉元组返回这个坑）
function allSkills() {
  const out = [];
  skilllib.SKILLS.forEach(s => out.push({
    id: s.id, name: s.name, cat: s.cat || '未分类', desc: s.desc || '',
    args: s.args || '', origin: 'builtin', trusted: true, verified: true
  }));
  const ext = skills.allExternal();
  ext.forEach(x => {
    const name = x.name || '';
    const desc = x.note || '';
    // 外部技能没有真描述时，退而用仓库名/技能名本身去判能力域，
    // 否则 113 项会全部落进「待归类」，界面上等于没有分类。
    const probe = desc || name || (x.src || '').split('/').pop();
    out.push({
      id: x.id, name, cat: x.cat || '外部', desc,
      src: x.src, origin: x.dynamic ? 'external' : 'galaxy',
      // 内置白名单里的是随产品分发的；用户动态装载的默认未验证
      trusted: !!x.claimed,
      verified: !!x.claimed,
      hasDesc: !!desc,
      probe
    });
  });
  return out;
}

// 命中哪些能力域。外部技能用 probe（描述缺失时退化到名字）参与判定。
function hitDomains(s) {
  const t = ((s.name || '') + ' ' + (s.desc || '') + ' ' + (s.cat || '') + ' ' + (s.probe || '')).toLowerCase();
  return DOMAINS.filter(d => d.kw.some(k => t.indexOf(String(k).toLowerCase()) >= 0)).map(d => d.key);
}

// 分类 + 重叠检测
function categorize() {
  const all = allSkills();
  const byCat = {};      // 内置技能：按自己的 cat 分（那是真实的人工分类）
  const byDomain = {};   // 外部技能：按命中能力域分（来源标签不能当分类）
  const unclassified = [];
  const overlaps = [];
  DOMAINS.forEach(d => byDomain[d.key] = []);

  all.forEach(s => {
    const hits = hitDomains(s);
    s.domains = hits;
    if (s.origin === 'builtin') {
      // 内置：分类可信；命中 ≥2 域且不含自身分类 → 边界不清，标出来
      if (hits.length >= 2 && hits.indexOf(s.cat) < 0) overlaps.push({ id: s.id, name: s.name, cat: s.cat, domains: hits, origin: 'builtin' });
      (byCat[s.cat] || (byCat[s.cat] = [])).push(s);
    } else {
      // 外部：来源标签不是分类，改按能力域；一个域都不命中且没描述 → 待归类
      if (!hits.length) { unclassified.push(s); s.group = '待归类'; }
      else { hits.forEach(h => byDomain[h].push(s)); s.group = hits[0]; }
    }
  });

  const cats = Object.keys(byCat).map(k => ({ name: k, count: byCat[k].length, items: byCat[k], kind: 'builtin' }))
    .sort((a, b) => b.count - a.count);
  const domains = DOMAINS.map(d => ({ name: d.key, color: d.color, count: byDomain[d.key].length, items: byDomain[d.key], kind: 'domain' }))
    .filter(d => d.count > 0).sort((a, b) => b.count - a.count);

  return {
    total: all.length,
    builtin: all.filter(x => x.origin === 'builtin').length,
    external: all.filter(x => x.origin !== 'builtin').length,
    unverified: all.filter(x => !x.verified).length,
    noDesc: all.filter(x => x.origin !== 'builtin' && !x.hasDesc).length,
    byCat, byDomain, cats, domains,
    unclassified,
    unclassifiedCount: unclassified.length,
    overlaps
  };
}

// 用途聚类：回答"我想做 X，该调哪个"
const USE_CASES = [
  { key: '算账', kw: ['成本', '盈亏', '保本', '现金流', '预算', '税', '贷款', '复利', '资金'], hint: '算清这笔生意到底赚不赚' },
  { key: '定价', kw: ['定价', '价格', '促销', '盈亏'], hint: '定出既不吓跑客户又能赚钱的价格' },
  { key: '获客', kw: ['获客', '线索', '漏斗', '渠道', '客户', '市场规模'], hint: '找到并接触潜在客户' },
  { key: '转化', kw: ['转化', '留存', '复购', '流失', '会员'], hint: '让已经来的客户留下并再买' },
  { key: '排优先级', kw: ['优先级', '排序', '评分', '打分', '帕累', '取舍', '机会成本'], hint: '先做哪件事最划算' },
  { key: '判断风险', kw: ['风险', '评估', '矩阵', '不确定', '置信'], hint: '这件事会不会出事' },
  { key: '看数据', kw: ['数据', '指标', 'kpi', '报表', '归因', '预测', '显著性'], hint: '用数据而不是感觉做判断' },
  { key: '提效率', kw: ['效率', '流程', '排期', '产能', '质量', '交付'], hint: '让同样的产出更省力' }
];
function clusters() {
  const all = allSkills();
  return USE_CASES.map(u => {
    const items = all.filter(s => u.kw.some(k => ((s.name || '') + ' ' + (s.desc || '')).toLowerCase().indexOf(k) >= 0));
    return { key: u.key, hint: u.hint, count: items.length, items: items.slice(0, 12).map(s => ({ id: s.id, name: s.name, cat: s.cat, verified: s.verified })) };
  }).filter(c => c.count > 0);
}

// 可用性分级（第 9 条"覆盖不清"的另一半）
function trust() {
  const c = categorize();
  return {
    // 内置 = 随产品分发，代码在我们手里，可直接 invoke
    usable: c.total - c.unverified,
    // 外部收录但未验证：只作参考，不能当作"装好就能用"
    referenceOnly: c.unverified,
    note: '外部技能来自 GitHub 收录，未经验证；需在技能军械库点「装载」并核验后才可调用。'
  };
}

// 一次拿全所有体检结论，UI 和测试都走这一个入口（避免各处各算一套数）
function audit() {
  const c = categorize();
  return {
    categorize: c,
    clusters: clusters(),
    trust: trust(),
    gaps: gaps(c),
    nameless: nameless(c),
    multiDomain: multiDomain(c),
    nearDup: nearDup(c)
  };
}

// —— 覆盖体检（第 9 条"覆盖不清"的那一半）——
// 上面的 categorize() 只回答"东西在哪儿"，没回答**哪儿没东西**。
// 三个盲区，都是真问题，不是补充说明：
//   1. domains 里 count=0 的能力域被 .filter(d=>d.count>0) 直接删掉
//      → 用户看不到"数据域一个外部技能都没有"，覆盖空洞是隐形的。
//   2. unclassified 只有一个数字，看不到**是哪几个**，用户没法补描述。
//   3. 外部技能命中 ≥2 域时被 s.group = hits[0] 静默塞进第一个域，
//      界面上看不出"这个技能横跨财务+营销"，这正是"边界不清"的本体。
function gaps(cat) {
  const c = cat || categorize();
  const domains = DOMAINS.map(d => ({
    key: d.key, count: c.byDomain[d.key].length,
    builtin: c.byCat[d.key] ? c.byCat[d.key].length : 0
  }));
  return {
    // 一个外部技能都没有的能力域 = 真实覆盖空洞
    emptyDomains: domains.filter(d => d.count === 0).map(d => d.key),
    // 只有 1 项的内置分类 = 形同虚设
    thinCats: c.cats.filter(x => x.count <= 1).map(x => x.name),
    domains
  };
}

// 待归类 / 无描述 的**具体条目**（原来只有计数，用户补不回来）
function nameless(cat) {
  const c = cat || categorize();
  const brief = s => ({ id: s.id, name: s.name, src: s.src || '', origin: s.origin, cat: s.cat });
  // 无描述：外部技能里 desc/note 为空的那些。它们的域归属是**猜**的
  const noDescItems = allSkills().filter(s => s.origin !== 'builtin' && !s.hasDesc)
    .map(s => ({ id: s.id, name: s.name, src: s.src || '', group: s.group || '' }));
  return {
    unclassified: c.unclassified.slice(0, 40).map(brief),
    unclassifiedTotal: c.unclassified.length,
    noDesc: noDescItems.slice(0, 40),
    noDescTotal: noDescItems.length,
    note: '这些条目缺少描述，能力域归属由名称推断，可靠性低；补上描述后分类才可信。'
  };
}

// 横跨多域的外部技能：静默归到首个域之前，先把边界摊开给用户看
function multiDomain(cat) {
  const c = cat || categorize();
  const out = [];
  c.domains.forEach(d => d.items.forEach(s => {
    if (s.origin === 'builtin') return;
    if ((s.domains || []).length >= 2) out.push({ id: s.id, name: s.name, domains: s.domains, group: s.group, src: s.src || '' });
  }));
  const seen = {};
  return out.filter(x => !seen[x.id] && (seen[x.id] = 1));
}

// 名称相近的技能（**启发式，不是语义判断**）
// 文件头最早记的病根就是它：盈亏平衡分析 / 现金流规划 / 资金消耗跑道 并列排开，
// 用户只能一个个试。这里用字符二元组 Jaccard 做保守筛查，只提示、不自动合并，
// 且阈值卡到 0.5 以上，宁可漏报也不误报（误报会让用户白查）。
function nearDup(cat) {
  const c = cat || categorize();
  const gram = s => {
    const t = String(s || '').replace(/[\s（）()·、,，\-_/]/g, '');
    const g = {};
    for (let i = 0; i < t.length - 1; i++) g[t.slice(i, i + 2)] = 1;
    return g;
  };
  const jac = (a, b) => {
    const A = gram(a), B = gram(b);
    const ka = Object.keys(A), kb = Object.keys(B);
    if (!ka.length || !kb.length) return 0;
    let inter = 0;
    ka.forEach(k => { if (B[k]) inter++; });
    return inter / (ka.length + kb.length - inter);
  };
  const pool = allSkills().filter(s => s.name && s.name.length >= 3);
  const dupes = [], similar = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const sim = jac(pool[i].name, pool[j].name);
      if (sim < 0.5) continue;
      // 名字完全相同 = **重复收录**，不是"功能像"。这两件事后果不同：
      // 重复收录会撑大列表、让用户以为有两个技能；近似只是分不清用哪个。
      const rec = { a: pool[i].name, b: pool[j].name, sim: Math.round(sim * 100) / 100,
        aId: pool[i].id, bId: pool[j].id, aSrc: pool[i].src || '', bSrc: pool[j].src || '' };
      (sim >= 1 ? dupes : similar).push(rec);
    }
  }
  dupes.sort((x, y) => y.a.length - x.a.length);
  similar.sort((x, y) => y.sim - x.sim);
  return {
    dupes: dupes.slice(0, 30), dupesTotal: dupes.length,
    similar: similar.slice(0, 30), similarTotal: similar.length,
    threshold: 0.5,
    note: '「重复收录」是同名条目被收了两遍（真实数据里确实有），会让列表虚胖、误以为有两个技能；'
      + '「名称相近」按名称二元组相似度提示，可能同义也可能只是命名风格不同，需人工确认。两者都不自动合并。'
  };
}

// 给对话用（第 2 条能力表）
function summary() {
  const c = categorize();
  return '技能军械库共 ' + c.total + ' 项：内置 ' + c.builtin + '（按人工分类）· 外部收录 ' + c.external + '（按能力域归类）'
    + '\n内置分类：' + c.cats.slice(0, 10).map(x => x.name + ' ' + x.count).join(' · ')
    + '\n外部按能力域：' + c.domains.map(x => x.name + ' ' + x.count).join(' · ')
    + (c.unclassifiedCount ? '\n待归类 ' + c.unclassifiedCount + ' 项（无描述且名��无法判定能力）' : '')
    + '\n边界重叠 ' + c.overlaps.length + ' 项（按分类找不到但命中多个能力域）'
    + '\n未验证外部技能 ' + c.unverified + ' 项，仅供参考不可直接调用';
}

module.exports = { DOMAINS, allSkills, categorize, clusters, trust, summary, gaps, nameless, multiDomain, nearDup, audit };