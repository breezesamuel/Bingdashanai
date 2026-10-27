// core/team.js — 动态组队 · 员工自演化 · 任务自动认领（第 4 条需求）
//
// 【需求原文】"组织大脑中的员工人数是不定的，可以随时学习进化，也可以自行选择，
//             为了完成任务而选择不同的员工，可以完全配合决策中心更好的完成任务"
//
// 【现状与差距】staff 表里 12 名员工，字段只有 id/name/role/skills/status。
// 也就是说：
//   1. 人数**写死**在初始化脚本里，产品层面无法增删——需求要"人数不定"；
//   2. skills 只是标签，没有等级、没有负载、没有成长记录——需求要"学习进化"；
//   3. 任务和员工之间**没有任何关联**——需求要"为了完成任务而选择不同的员工"；
//   4. 第 3 条的决策焦点派发了指向性任务，但没人认领——这就是断点。
//
// 【解法】本模块把"人"变成可调度资源：
//   plan()      根据待办任务的技能需求，算出需要多少人、什么角色 → **该招人就招人**
//   assign()    为每个待办任务**自动选最合适的员工**（自行选择，不是随机分配）
//   evolve()    任务完成后员工涨级/解锁新技能（学习进化）
//   syncWithFocus() 决策焦点一变，立刻重新组队（第 3 条与第 4 条的接缝）
//
// 【设计红线：不伪造"已完成"】员工涨级只由**真实完成的任务**驱动。
// 不能靠"派了任务就算成长"——那只是把数字做漂亮，人没有变强。

const store = require('./store');

// —— 能力域：任务描述里出现这些词，就说明需要对应能力 ——
const SKILL_DOMAINS = [
  { key: '战略', words: ['战略', '方向', '定位', '竞争', '格局', '决策', '取舍'] },
  { key: '增长', words: ['增长', '获客', '线索', '转化', '成交', '营销', '推广', '漏斗', '拓客'] },
  { key: '财务', words: ['营收', '收款', '定价', '成本', '预算', '结算', '付费', '订阅', '抽成', '分润'] },
  { key: '产品', words: ['需求', '功能', '体验', '界面', 'ui', '交互', '原型'] },
  { key: '技术', words: ['系统', '架构', '代码', 'api', '性能', '卡顿', '部署', '修复', 'bug', '打包', '数据库'] },
  { key: '数据', words: ['数据', '统计', '报表', '看板', '指标', '分析', '口径'] },
  { key: '内容', words: ['文案', '写稿', '脚本', '视频', '配音', '配音', '出图', '海报', '发布', '素材'] },
  { key: '运营', words: ['运营', '排期', '流程', '协作', '监控', '告警', '自动化'] },
  { key: '风险', words: ['风险', '合规', '安全', '审核', '风控', '异常'] },
  { key: '学习', words: ['学习', '进化', '技能', '培训', '沉淀', '研究'] }
];

// 招人模板：按能力域开缺，来了才有对应能力
const HIRE_PLAN = {
  '战略': { role: '战略顾问', base: ['战略', '决策', '竞争分析'] },
  '增长': { role: '增长负责人', base: ['增长', '获客', '转化', '内容'] },
  '财务': { role: '财务经理', base: ['财务', '结算', '定价'] },
  '产品': { role: '产品经理', base: ['产品', '需求', '交互'] },
  '技术': { role: '工程师', base: ['技术', '代码', '性能'] },
  '数据': { role: '数据分析师', base: ['数据', '指标', '报表'] },
  '内容': { role: '内容主理人', base: ['内容', '文案', '视频'] },
  '运营': { role: '运营专员', base: ['运营', '流程', '监控'] },
  '风险': { role: '风控专员', base: ['风险', '合规', '安全'] },
  '学习': { role: '研究员', base: ['学习', '研究', '技能'] }
};

const NAME_POOL = ['砚清', '望舒', '子澈', '慕白', '怀瑾', '既明', '青芜', '灼华', '知行', '允中',
  '清和', '疏影', '长风', '棠雪', '临川', '朝云', '见山', '拾阶', '安然', '昭华'];

// 从任务标题/验收标准里推断需要哪些能力
function requiredSkills(t) {
  const s = (String(t.title || '') + ' ' + String(t.accept || '') + ' ' + String(t.desc || '')).toLowerCase();
  const out = [];
  SKILL_DOMAINS.forEach(d => {
    if (d.words.some(w => s.indexOf(String(w).toLowerCase()) >= 0)) out.push(d.key);
  });
  return out;
}

// 员工能力评分：技能命中 + 等级加成 + 负载惩罚
function scoreStaff(s, need, loadMap) {
  const sk = (s.skills || []).map(x => String(x).toLowerCase());
  let hit = 0;
  need.forEach(n => {
    const nl = String(n).toLowerCase();
    if (sk.some(x => x === nl)) hit += 3;
    else if (sk.some(x => x.indexOf(nl) >= 0 || nl.indexOf(x) >= 0)) hit += 2;   // 近似也算
    else if (s.role && String(s.role).toLowerCase().indexOf(nl) >= 0) hit += 2;
  });
  const lv = s.level || 1;
  const load = (loadMap && loadMap[s.id]) || 0;
  // 命中不足时分数归零，避免"什么活都派给同一个人"
  const base = hit === 0 ? 0 : hit * 10 + (lv - 1) * 6 - load * 8;
  return base;
}

function staff() { return store.read().staff || []; }

function loadMap() {
  const m = {};
  (store.read().tasks || []).forEach(t => {
    if (t.done || !t.owner) return;
    m[t.owner] = (m[t.owner] || 0) + 1;
  });
  return m;
}

// —— 招人：按缺口动态补齐，人数随任务量浮动 ——
// 返回实际招聘列表。幂等：同能力域已有人则不再招（除非该域全员满载）。
// 【重要】招聘人数由**该域的未认领任务量**决定，不是"缺人就补 3 个"。
// 初版写死 maxPerDomain=3，结果为 1 个"加密货币钱包结算"任务招了 3 个财务经理——
// 需求要的是"人数不定"，不等于"缺一个就雇三个"。人也是成本。
function hire(missingDomains, opt) {
  const o = opt || {};
  const cap = o.cap || 60;          // 安全上限，防止任务文本异常导致无限招人
  const list = staff();
  if (list.length >= cap) return { hired: [], capped: true };
  const lm = loadMap();

  // 该域还有多少未认领任务 —— 决定要补几个人
  const demand = {};
  (store.read().tasks || []).forEach(t => {
    if (t.done || t.owner) return;
    requiredSkills(t).forEach(d => { demand[d] = (demand[d] || 0) + 1; });
  });

  const hired = [];
  missingDomains.forEach(dom => {
    const tpl = HIRE_PLAN[dom];
    if (!tpl) return;
    // 该域现有在岗且还有余力的人数
    const have = list.filter(s => s.status !== 'off' && scoreStaff(s, [dom], lm) > 0);
    const spare = have.filter(s => (lm[s.id] || 0) === 0).length;
    const need = demand[dom] || 1;
    // 招的人数 = 需求 - 现有空闲人力。至少 1（确属能力缺口时），最多 3。
    let room = Math.max(need - have.length, need - spare, 1);
    room = Math.min(room, o.maxPerDomain || 3);
    for (let i = 0; i < room; i++) {
      if (list.length + hired.length >= cap) break;
      const nm = NAME_POOL[(list.length + hired.length) % NAME_POOL.length];
      const rec = {
        id: store.uid(),
        createdAt: Date.now(),
        name: nm,
        role: tpl.role,
        skills: tpl.base.slice(),
        status: 'on',
        level: 1,            // 第 4 条：等级制，支撑"学习进化"
        xp: 0,
        hiredBy: 'auto',     // 标记为系统按任务自动招聘，便于区分人与 AI 招的
        done: 0
      };
      hired.push(rec);
      list.push(rec);
    }
  });
  if (hired.length) {
    const db = store.read();
    db.staff = list;
    store.write(db);
    store.push('audit', {
      action: '组织·自动增员',
      detail: hired.map(h => h.role + '·' + h.name).join('、') + '（为补齐 ' + missingDomains.join('/') + ' 能力缺口）',
      at: Date.now()
    });
  }
  return { hired, capped: false };
}

// —— 组队：为所有未完成且无主的任务自动选人 ——
function assign(opt) {
  const o = opt || {};
  const db = store.read();
  const tasks = (db.tasks || []).filter(t => !t.done && !t.owner);
  if (!tasks.length) return { assigned: [], reason: '没有待认领任务' };

  const list = staff().filter(s => s.status !== 'off');
  if (!list.length) return { assigned: [], reason: '无在岗员工' };

  // 第一步：先看能力缺口，缺就招人（第 4 条"人数不定"的落点）
  let hireResult = { hired: [] };
  if (o.autoHire !== false) {
    const needAll = {};
    tasks.forEach(t => requiredSkills(t).forEach(d => { needAll[d] = (needAll[d] || 0) + 1; }));
    const lmv = loadMap();
    const missing = Object.keys(needAll).filter(dom => {
      const can = list.filter(s => requiredSkills({ title: dom }).length
        && scoreStaff(s, [dom], lmv) > 0).length;
      return can === 0;
    });
    if (missing.length) hireResult = hire(missing, o);
    if (hireResult.hired.length) o._hired = hireResult.hired;
  }

  const pool = staff().filter(s => s.status !== 'off');
  const lm = loadMap();
  const assigned = [];
  // 决策焦点派发的任务优先派（ref 以 decision: 开头）——第 3 条与第 4 条的接缝
  const ordered = tasks.slice().sort((a, b) => (String(b.ref || '').indexOf('decision:') === 0 ? 1 : 0) - (String(a.ref || '').indexOf('decision:') === 0 ? 1 : 0));
  ordered.forEach(t => {
    const need = requiredSkills(t);
    if (!need.length) need.push('运营');
    let best = null, bestScore = 0;
    pool.forEach(s => {
      const sc = scoreStaff(s, need, lm);
      if (sc > bestScore) { bestScore = sc; best = s; }
    });
    if (!best) return;           // 没有一个能接 → 宁可留空，也不要错配
    t.owner = best.id;
    t.ownerName = best.name;
    t.role = best.role;
    t.need = need;
    t.status = 'running';        // 派出去即"在跑"，第 6 条的口径
    t.assignedAt = Date.now();
    lm[best.id] = (lm[best.id] || 0) + 1;   // 同一人不再连拿（负载惩罚生效）
    assigned.push({ taskId: t.id, title: t.title, owner: best.name, role: best.role, score: bestScore, need });
  });
  if (assigned.length) {
    store.write(db);
    store.push('audit', { action: '组织·自动派工', detail: assigned.length + ' 项任务已认领', at: Date.now() });
  }
  return { assigned, hired: hireResult.hired || [], capped: hireResult.capped || false };
}

// —— 线索派工（第 4 条深化：线索也要有人认领）——
// 【为什么单独做】实测 462 条线索的 owner 字段**全部为空**。
// 原因是原 assign() 只处理 tasks，从没处理 leads。后果：
//   1. 线索是"工作"，但没人认领，等于数百件待办悬空；
//   2. Graphify 里 lead↔staff 边一条都建不出来；
//   3. 第 12 条指挥建议会一直报"有 N 项待办无人认领"却漏掉线索。
//
// 【派工口径：按获客阶段所需能力，不按技术栈】
// 我最初按线索的 industry（技术栈）匹配员工技能，结果只有 18/354 命中。
// 查了词表才明白原因：**两套词表完全不重叠**——
//   员工技能：战略/增长/转化/数据/自动化/QA/SEO/预算（业务能力）
//   线索 industry：Python/TypeScript/Rust/Go（编程语言）
// 一个做增长的人不会因为"线索是 Go 写的"而更适合它，反之亦然。
// 放宽匹配凑够数字 = **错配**，比不派更糟。
// 真实分工是：线索是**待触达的销售目标**，谁擅长触达谁认领，与它用什么语言无关。
// 技术栈不丢——它作为线索属性留在 Graphify 里（lead_stack 边），将来招技术人时有用。
function leadAbility(l) {
  // 线索处在哪一步，就该由具备哪一步能力的人来做
  const stage = String(l.stage || '');
  const icp = String(l.icpCat || '');
  if (stage === '待成交' || l.deal) return ['转化', '支持', '合规'];
  if (/内容|创作者/.test(icp)) return ['内容', 'SEO', '投放'];
  if (/开发者|AI团队/.test(icp)) return ['增长', 'SEO', '转化'];
  return ['增长', '获客', '转化'];
}

// 能力词 → 员工技能词的映射。
// 刻意保守：只映射业务上真正等价的能力，不做"沾边就算"。
const ABILITY_MAP = {
  '增长': ['增长', 'SEO', '投放', '转化'],
  '获客': ['增长', 'SEO', '投放'],
  '转化': ['转化', '支持', '合规'],
  '内容': ['内容', 'SEO', '动效'],
  '支持': ['支持', '合规'],
  '合规': ['合规', 'QA']
};

function assignLeads(opt) {
  const o = opt || {};
  const db = store.read();
  const leads = (db.leads || []).filter(l => !l.owner && l.stage && l.stage !== '探测');
  if (!leads.length) return { assigned: 0, reason: '无待认领线索' };
  const pool = staff().filter(s => s.status !== 'off');
  if (!pool.length) return { assigned: 0, reason: '无在岗员工' };

  // 【负载惩罚的坑】初版用 score += level*2 - load*3。
  // 354 条线索里绝大多数能力需求相同，于是全被少数几个"增长"员工吸走，
  // 后面每条的 load 越大、分数越负，最后 324 条被判"无匹配能力"。
  // 这不是"没能力"，是**分配算法把队列堵死了**。
  // 改成：先按能力匹配度分档（只认档位，档内均衡轮转），
  // 负载只做**排序**不做**否决**——只要有人具备该能力，就一定能分到。
  // 【幂等 + 产能上限的真 bug】原来这里写的是：
  //     leads.forEach(l => { if (l.owner) load[l.owner] = (load[l.owner]||0)+1; });
  // 但 leads 上一行已经被过滤成 `!l.owner` 了——**这个 if 永远不成立**，
  // 于是 load 恒为 {}，产能上限形同虚设：每跑一次就把每个人重新塞到 15 条，
  // 重复执行两次总数从 64 涨到 124，"上限"只是看起来存在。
  // 修：负载必须从**全部**线索统计（含已认领的），否则等于每次都从零开始。
  const load = {};
  (db.leads || []).forEach(l => {
    if (l.owner) load[l.owner] = (load[l.owner] || 0) + 1;
  });

  // 档内候选池：谁具备该需求（按技能命中数排序，不看负载）
  const candidatesFor = (want) => pool
    .map(s => {
      const sk = (s.skills || []).map(x => String(x).toLowerCase());
      let hit = 0;
      want.forEach(w => { if (sk.some(k => k === w)) hit++; });
      return { s, hit };
    })
    .filter(x => x.hit > 0)
    .sort((a, b) => b.hit - a.hit || ((b.s.level || 1) - (a.s.level || 1)));

  let n = 0;
  const reason = {};
  // 【产能上限：不做假问责】
  // 上一版把 354 条线索全派出去，结果 4 个人各扛 88 条。
  // 数字上"100% 派完"很好看，实际上没有人会真的去碰第 88 条——
  // 这就是**假问责**：账面满载、执行为零，比诚实的缺口更糟。
  // 口径：一个人一次能真正推进的线索数是有限的（LEAD_CAPACITY）。
  // 超出部分不派，如实记为 overflow，由指挥台看见"需要扩编/需要自动化触达"。
  const LEAD_CAPACITY = Number(o.capacity || 15);
  let overflow = 0;

  const assignQueue = (list, need) => {
    const want = [];
    need.forEach(a => (ABILITY_MAP[a] || [a]).forEach(s => want.push(String(s).toLowerCase())));
    const cands = candidatesFor(want);
    if (!cands.length) { reason['无该能力在岗'] = (reason['无该能力在岗'] || 0) + list.length; return; }
    list.forEach(l => {
      // 档内选负载最小且未满产能的人；全满则如实记为超出产能
      const avail = cands.filter(c => (load[c.s.id] || 0) < LEAD_CAPACITY);
      if (!avail.length) { overflow++; reason['超出团队触达产能'] = (reason['超出团队触达产能'] || 0) + 1; return; }
      const best = avail.slice().sort((a, b) =>
        ((load[a.s.id] || 0) - (load[b.s.id] || 0)) || (b.hit - a.hit) || ((b.s.level || 1) - (a.s.level || 1))
      )[0];
      l.owner = best.s.id;
      l.ownerName = best.s.name;
      l.assignedAt = Date.now();
      l.assignedBy = 'ability';
      load[best.s.id] = (load[best.s.id] || 0) + 1;
      n++;
    });
  };

  // 按能力需求分桶，同桶内均衡分配
  const buckets = {};
  leads.forEach(l => {
    const key = leadAbility(l).join('+');
    (buckets[key] || (buckets[key] = [])).push(l);
  });
  Object.keys(buckets).forEach(k => assignQueue(buckets[k], k.split('+')));

  if (n) {
    store.write(db);
    store.push('audit', {
      action: '组织·线索认领',
      detail: n + '/' + leads.length + ' 条线索按获客能力匹配认领' +
        (overflow ? '；' + overflow + ' 条超出当前 ' + pool.length + ' 人团队产能（人均上限 ' + LEAD_CAPACITY + '），未派' : '') +
        (Object.keys(reason).length ? '（' + Object.keys(reason).map(k => k + ' ' + reason[k]).join('，') + '）' : ''),
      at: Date.now()
    });
  }
  // 缺编建议只按**有获客技能的在岗人**算产能。
  // 【口径修正】原来用 pool.length（全员 12 人）×15 算"还能接 180 条"，
  // 于是 overflow=290 时算出"再招 20 人"——荒谬：
  // 那 6 个没有获客技能的人（QA/动效/合规/支持/数据/技术）再招几个也不解决触达问题。
  // 真实约束是**具备获客能力的人数**，不是人头总数。
  const qualified = {};
  Object.keys(buckets).forEach(k => {
    const need = k.split('+');
    const want = [];
    need.forEach(a => (ABILITY_MAP[a] || [a]).forEach(s => want.push(String(s).toLowerCase())));
    candidatesFor(want).forEach(c => { qualified[c.s.id] = true; });
  });
  const qualifiedN = Object.keys(qualified).length;
  const realCapacity = qualifiedN * LEAD_CAPACITY;
  // 再招也补不满时，直说"靠人不现实"，指向自动化/批量触达，而不是无限扩编
  const capacityNeeded = overflow ? Math.ceil(overflow / LEAD_CAPACITY) : 0;

  return {
    assigned: n, total: leads.length, overflow,
    capacity: LEAD_CAPACITY,
    staff: pool.length, qualifiedStaff: qualifiedN,
    realCapacity,
    capacityNeeded,
    verdict: overflow === 0 ? '全部可人工触达'
      : (realCapacity >= leads.length ? '扩编可覆盖'
        : '人工触达无法覆盖：' + overflow + ' 条需自动化/批量触达或外部渠道'),
    skipped: reason, buckets: Object.keys(buckets)
  };
}

// —— 学习进化：任务完成后员工涨经验；连续完成会升级并解锁新技能 ——
// 红线：只由**真实完成**驱动。派了任务不算成长。
const LEVEL_XP = [0, 100, 260, 500, 850, 1300];   // 升到 2/3/4/5/6 级所需累计 XP
function evolve(taskId) {
  const db = store.read();
  const t = (db.tasks || []).find(x => x.id === taskId);
  if (!t || !t.owner) return { ok: false, error: '任务不存在或无人认领' };
  const s = (db.staff || []).find(x => x.id === t.owner);
  if (!s) return { ok: false, error: '认领人已不在花名册' };
  s.xp = (s.xp || 0) + 60;
  s.done = (s.done || 0) + 1;
  let leveled = false;
  while ((s.level || 1) < LEVEL_XP.length && s.xp >= LEVEL_XP[s.level - 1]) { s.level++; leveled = true; }
  // 升级解锁相邻能力域（成长要有方向，不是纯数值膨胀）
  const unlocked = [];
  if (leveled) {
    const have = (s.skills || []).map(x => String(x));
    SKILL_DOMAINS.forEach(d => {
      if (s.level >= 3 && have.indexOf(d.key) < 0 && d.key !== '战略') { have.push(d.key); unlocked.push(d.key); }
    });
    s.skills = have;
  }
  t.status = 'done';
  store.write(db);
  store.push('audit', {
    action: '组织·成长',
    detail: s.name + ' 完成「' + String(t.title).slice(0, 30) + '」 XP+' + 60 + (leveled ? '，升到 ' + s.level + ' 级' + (unlocked.length ? '，解锁 ' + unlocked.join('/') : '') : ''),
    at: Date.now()
  });
  return { ok: true, staff: s, leveled, unlocked };
}

// —— 决策焦点联动：焦点一设，立刻重新组队（第 3 条 → 第 4 条）——
function syncWithFocus() {
  let f = null;
  try { f = require('./decision-focus').progress(); } catch (e) { return { ok: false, error: e.message }; }
  if (!f || !f.active) return { ok: true, assigned: [], reason: '无进行中的决策焦点' };
  const r = assign({ autoHire: true });
  // 线索也要有人认领（第 4 条深化）：任务派了、线索悬空，同样是执行链断裂
  let leads = null;
  try { leads = assignLeads({ autoHire: false }); } catch (e) { leads = { assigned: 0, error: e.message }; }
  return { ok: true, domain: f.domain, ...r, leads };
}

function board() {
  const list = staff();
  const lm = loadMap();
  const byRole = {};
  list.forEach(s => { byRole[s.role] = (byRole[s.role] || 0) + 1; });
  const tasks = store.read().tasks || [];
  return {
    headcount: list.length,
    active: list.filter(s => s.status !== 'off').length,
    autoHired: list.filter(s => s.hiredBy === 'auto').length,
    byRole,
    load: lm,
    owned: tasks.filter(t => t.owner && !t.done).length,
    avgLevel: list.length ? Math.round(list.reduce((a, s) => a + (s.level || 1), 0) / list.length * 10) / 10 : 0,
    list: list.map(s => ({
      id: s.id, name: s.name, role: s.role, status: s.status,
      level: s.level || 1, xp: s.xp || 0, done: s.done || 0,
      load: lm[s.id] || 0, skills: s.skills || [], hiredBy: s.hiredBy || 'manual'
    }))
  };
}

module.exports = { staff, board, assign, assignLeads, hire, evolve, syncWithFocus, requiredSkills, scoreStaff, SKILL_DOMAINS, HIRE_PLAN };