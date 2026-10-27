// core/graphify.js — Graphify 语义关联知识图谱
//
// 【需求来源】用户建议："做 Graphify 语义知识图谱——它是唯一能同时喂给记忆层、
//            七层架构、学习闭环的基础设施，比再接一个工具更有杠杆。"
//
// 【为什么图谱比列表有杠杆：先量一下现在的实际状况】
// 系统里已经有大量"有关联但没人串起来"的知识：
//   - memory-hub：11 个模块的学习产出（905 条），但是**平铺的**，只有"哪个模块产了多少"
//   - layers：七层架构里 49 个组件，但组件之间的依赖关系只存在于 require 语句里
//   - decisions：每次决策记录了 question/answer/engine，但没说"这条决策源自哪个目标"
//   - leads/tasks/staff：线索、任务、员工之间没有边
//   - lessons/knowledge：经验与知识之间没有相似度边
//
// 结果是：问"哪些模块因为同一个原因在退化"、"这条决策和哪些任务有关"，
// 只能全表扫描。而这恰恰是"学习进化"和"指挥建议"最需要的推理方式。
//
// 【Graphify 的做法：把散落的实体抽成节点，把真实存在的关联抽成边】
// 关键在于**边必须有来源**，不能靠猜：
//   require 边   —— 代码里真实存在的模块依赖
//   闭环边       —— 七层闭环相邻环节
//   产出边       —— 某模块的学习产出了哪条知识/经验
//   决策边       —— 某目标 → 某决策 → 某任务 → 某员工
//   线索边       —— 线索 → 任务 → 员工
//   症状边       —— 告警 → 受影响模块（来自监控与自愈记录）
//
// 【红线：边必须可回溯】每条边都带 evidence（来源字段名），
// 用户能点开看"这条边凭什么存在"。凭空的语义相似度边一律不建——
// 那是编的，不是查出来的。

const store = require('./store');
const fs = require('fs');
const path = require('path');

// 图谱构建统计（供 build() 汇总，如实报出"有多少线索因无关联而未入图"）
const GRAPH_STATS = {};

const NODE_KINDS = [
  { kind: 'layer', label: '架构层', color: '#3b82f6' },
  { kind: 'component', label: '组件', color: '#60a5fa' },
  { kind: 'module', label: '模块', color: '#10b981' },
  { kind: 'goal', label: '目标', color: '#f59e0b' },
  { kind: 'decision', label: '决策', color: '#a855f7' },
  { kind: 'task', label: '任务', color: '#22d3ee' },
  { kind: 'staff', label: '员工', color: '#fb923c' },
  { kind: 'lead', label: '线索', color: '#f472b6' },
  { kind: 'stack', label: '技术栈', color: '#22c55e' },
  { kind: 'channel', label: '获客渠道', color: '#14b8a6' },
  { kind: 'repo', label: '目标仓库', color: '#a3e635' },
  { kind: 'lesson', label: '经验', color: '#34d399' },
  { kind: 'knowledge', label: '知识', color: '#c084fc' },
  { kind: 'module_learn', label: '模块学习', color: '#4ade80' },
  { kind: 'alert', label: '告警', color: '#ef4444' },
  { kind: 'skill', label: '技能', color: '#facc15' }
];

// —— 1. 节点构建 ——
function buildNodes() {
  const N = [];
  const add = (id, kind, label, extra) => N.push(Object.assign({ id, kind, label: String(label || id).slice(0, 60) }, extra || {}));

  // 1) 七层架构：层 + 组件
  try {
    const L = require('./layers');
    L.LAYERS.forEach(l => {
      add('layer:' + l.id, 'layer', l.name, { order: l.order, role: l.role });
      l.components.forEach(c => add('comp:' + c.key, 'component', c.label, { layer: l.id, mod: c.mod || '', probe: c.probe }));
    });
  } catch (e) {}

  // 2) core 模块
  try {
    const dir = path.join(__dirname);
    fs.readdirSync(dir).filter(f => f.endsWith('.js')).forEach(f => {
      const id = f.replace(/\.js$/, '');
      let n = 0;
      try { n = Object.keys(require(path.join(dir, f))).length; } catch (e) { return; }
      add('mod:' + id, 'module', id, { exports: n });
    });
  } catch (e) {}

  // 3) 目标 / 决策 / 任务 / 员工 / 线索 / 经验 / 知识 / 学习产出
  const db = store.read();
  (db.settings && db.settings.goals || []).forEach(g => add('goal:' + g.id, 'goal', g.title, { primary: !!g.primary, target: g.target }));
  (db.decisions || []).slice(0, 200).forEach(d => add('dec:' + d.id, 'decision', String(d.question || '').slice(0, 50), { engine: d.engine, at: d.at || d.createdAt }));
  (db.tasks || []).forEach(t => add('task:' + t.id, 'task', String(t.title || '').slice(0, 50), { done: !!t.done, owner: t.owner, ref: t.ref }));
  (db.staff || []).forEach(s => add('staff:' + s.id, 'staff', s.name, { role: s.role, skills: s.skills || [] }));
  (db.knowledge || []).forEach(k => add('know:' + k.id, 'knowledge', String(k.q || '').slice(0, 50), { a: String(k.a || '').slice(0, 120) }));
  (db.lessons || []).forEach(l => add('les:' + l.id, 'lesson', String(l.detail || l.text || '').slice(0, 50), { verified: l.verified }));

  // 线索只取有推进记录的（462 条全进图会糊成一团）
  (db.leads || []).filter(l => l.stage && l.stage !== '探测').slice(0, 120)
    .forEach(l => add('lead:' + (l.id || l.key || l.name), 'lead', String(l.name || l.company || l.key || '').slice(0, 40), { stage: l.stage }));

  // 模块学习产出（每个模块一个聚合节点，不塞 905 条明细）
  try {
    const M = require('./memory-hub');
    const d = M.dashboard();
    d.modules.forEach(m => add('ml:' + m.mod, 'module_learn', m.label, { total: m.total, recent7: m.recent7, verifyRate: m.verifyRate }));
  } catch (e) {}

  return N;
}

// —— 2. 边构建：每条边都必须有 evidence ——
function buildEdges(nodes, entry) {
  const E = [];
  // 【结构修复】边构建需要**动态补节点**（线索要先算出关联才决定是否入图），
  // 但 ids 快照是在 push 之前建的，补进来的节点会被误判为"不存在"而丢掉边。
  // 改成：ids 是一个共享 Set，addNode 时同步登记。
  const ids = new Set(nodes.map(n => n.id));
  const addNode = entry && entry.add ? entry.add : function () {};
  const push = (from, to, type, evidence) => {
    if (!ids.has(from) || !ids.has(to) || from === to) return;
    E.push({ from, to, type, evidence });
  };
  const db = store.read();

  // 2a) require 边：代码里真实存在的依赖
  try {
    const dir = path.join(__dirname);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    files.forEach(f => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const re = /require\(['"]\.\/([a-zA-Z0-9_-]+)['"]\)/g;
      let m;
      while ((m = re.exec(src))) {
        push('mod:' + f.replace(/\.js$/, ''), 'mod:' + m[1], 'require', f + '.js:' + src.slice(0, m.index).split('\n').length);
      }
    });
  } catch (e) {}

  // 2b) 七层闭环边：相邻环节 + 组件→所属层
  try {
    const L = require('./layers');
    L.CLOSED_LOOP.forEach((s, i) => {
      if (i > 0) {
        const prev = L.CLOSED_LOOP[i - 1];
        push('comp:' + (s.via[0] || ''), 'comp:' + (prev.via[0] || ''), 'loop', 'CLOSED_LOOP[' + i + ']');
      }
    });
    L.LAYERS.forEach(l => l.components.forEach(c => push('comp:' + c.key, 'layer:' + l.id, 'belongs', l.id)));
  } catch (e) {}

  // 2c) 学习产出 → 模块：某模块的学习来自它依赖的模块
  try {
    const M = require('./memory-hub');
    const nodesByMod = {};
    nodes.forEach(n => { if (n.kind === 'module_learn') nodesByMod[n.id.replace('ml:', '')] = n; });
    const dir = path.join(__dirname);
    fs.readdirSync(dir).filter(f => f.endsWith('.js')).forEach(f => {
      const id = f.replace(/\.js$/, '');
      if (!nodesByMod[id]) return;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const re = /require\(['"]\.\/([a-zA-Z0-9_-]+)['"]\)/g;
      let m;
      while ((m = re.exec(src))) {
        if (nodesByMod[m[1]]) push('ml:' + id, 'ml:' + m[1], 'learn_dep', id + ' requires ' + m[1]);
      }
    });
  } catch (e) {}

  // 2d) 目标 → 决策 → 任务 → 员工：真实的外键链
  (db.decisions || []).slice(0, 200).forEach(d => {
    const q = String(d.question || '');
    (db.tasks || []).forEach(t => {
      const title = String(t.title || '');
      if (title && q && (q.indexOf(title.slice(0, 12)) >= 0 || title.indexOf(q.slice(0, 12)) >= 0)) {
        push('dec:' + d.id, 'task:' + t.id, 'decision_task', 'question/title 文本匹配');
      }
    });
  });
  (db.tasks || []).forEach(t => {
    if (t.owner && ids.has('staff:' + t.owner)) push('task:' + t.id, 'staff:' + t.owner, 'assign', 'task.owner 外键');
  });

  // 线索入图策略：**只让"能连上边"的线索进图**。
  // 【质量修复】原来 462 条线索全部入图且一条边都没有 → 120 个孤立节点。
  // 孤立节点对图谱毫无价值：只增加节点数、不提供任何可推理关联，
  // 反而把真正的枢纽淹没在噪音里（用户打开图谱看到 120 个孤零零的点，
  // 会以为"这些线索之间没关系"，而真实情况是**系统目前没把它们和任何东西关联起来**）。
  //
  // 【字段名踩坑】原来找的是 l.icp，但真实字段叫 **icpCat**（354 条有值，icp 是 0 条）。
  // 于是"与知识同 icp"这条边永远建不出来 —— 又一次"字段名猜错导致静默失效"。
  // 现在按实测字段建边，并且**每条边都注明用的是哪个字段**，便于核对。
  const leadCandidates = (db.leads || []).filter(l => l.stage && l.stage !== '探测').slice(0, 400);
  const lkOf = l => String(l.id || l.key || l.name || l.company || '');
  const taskText = t => String(t.title || '') + ' ' + String(t.accept || '') + ' ' + String(t.ref || '');
  const leadLinks = [];   // {lk, to, type, ev}
  leadCandidates.forEach(l => {
    const lk = lkOf(l);
    if (!lk) return;
    // 1) 员工认领（实测当前 owner 为 0 条，但字段一旦被 team.assign 填上就会自动建边）
    const own = l.owner || l.ownerName || l.assignee;
    if (own) {
      const sid = (db.staff || []).find(s => s.id === own || s.name === own);
      if (sid) leadLinks.push({ lk, to: 'staff:' + sid.id, type: 'lead_owner', ev: 'lead.owner=' + own });
    }
    // 2) 任务提及该线索（公司名/仓库名/线索名）
    (db.tasks || []).forEach(t => {
      const txt = taskText(t);
      if (!txt) return;
      if (txt.indexOf(lk) >= 0 || (l.company && txt.indexOf(String(l.company)) >= 0) || (l.name && txt.indexOf(String(l.name)) >= 0)) {
        leadLinks.push({ lk, to: 'task:' + t.id, type: 'lead_task', ev: '任务标题/验收标准提及该线索' });
      }
    });
    // 3) icpCat（实测字段名，不是 icp）↔ 知识/经验
    if (l.icpCat) {
      (db.knowledge || []).forEach(k => {
        const txt = String(k.q || '') + ' ' + String(k.a || '');
        if (txt.indexOf(String(l.icpCat)) >= 0) leadLinks.push({ lk, to: 'know:' + k.id, type: 'lead_know', ev: 'icpCat「' + l.icpCat + '」出现在知识条目中' });
      });
      (db.lessons || []).forEach(s => {
        const txt = String(s.detail || s.text || '');
        if (txt.indexOf(String(l.icpCat)) >= 0) leadLinks.push({ lk, to: 'les:' + s.id, type: 'lead_lesson', ev: 'icpCat「' + l.icpCat + '」出现在经验条目中' });
      });
    }
    // 4) 技术栈 industry ↔ 技能库：线索是 GitHub 仓库，industry 就是它的语言。
    //    这是**真实且高信息量**的边——"这条线索要 Go" 直接连到会 Go 的技能与工程模块。
    if (l.industry && l.industry !== '未知') {
      const ind = String(l.industry).toLowerCase();
      (db.staff || []).forEach(s => {
        const has = (s.skills || []).some(k => String(k).toLowerCase().indexOf(ind) >= 0 || ind.indexOf(String(k).toLowerCase()) >= 0);
        if (has) leadLinks.push({ lk, to: 'staff:' + s.id, type: 'lead_skill', ev: '线索 industry=' + l.industry + ' 与员工技能匹配' });
      });
      // 技术栈本身作为节点（把 language:go 这种概念纳入图）
      leadLinks.push({ lk, to: 'lang:' + ind, type: 'lead_stack', ev: '线索 industry 字段' });
    }
    // 5) source（线索来源）↔ 技能：source 形如 "GitHub 探测·claude skills"
    if (l.source) {
      const tag = String(l.source).split('·').pop().trim();
      if (tag) leadLinks.push({ lk, to: 'src:' + tag.replace(/[^a-z0-9]+/gi, '_').toLowerCase(), type: 'lead_source', ev: 'lead.source 尾段「' + tag + '」' });
    }
    // 6) 同一个 repo 的多条线索（同一目标被多次记录）→ 它们之间**应该**连边
    //    这是真实的关系（指向同一对象），不是编的。
    if (l.repo) {
      leadLinks.push({ lk, to: 'repo:' + String(l.repo).toLowerCase(), type: 'lead_repo', ev: 'lead.repo 字段' });
    }
  });
  // 阶段2a：**先**建概念节点（技术栈/来源/仓库）
  //
  // 【顺序 bug 修复】原来这里是「先 push 边、后建概念节点」：
  //     line 255  leadLinks.forEach(x => push(...))
  //     line 263  (db.leads||[]).forEach(l => concept('lang:...'))
  // 而 push() 第一行就是 `if (!ids.has(to)) return;` —— 概念节点此刻还不存在，
  // 于是 **lead_repo / lead_stack / lead_source 三类边全被丢弃**。
  // 症状极具迷惑性：节点从 289 涨到 1025（概念节点建出来了），但边只从 327 涨到 363，
  // 孤立节点从 148 飙到 849 —— 看起来"图变大了"，实际质量崩了。
  // 建边前必须先让所有端点存在，这是图的 基本约束。
  const concept = (cid, kind, label, meta) => {
    if (ids.has(cid)) return;
    nodes.push(Object.assign({ id: cid, kind, label }, meta || {}));
    ids.add(cid);
  };
  leadCandidates.forEach(l => {
    if (l.industry && l.industry !== '未知') concept('lang:' + String(l.industry).toLowerCase(), 'stack', l.industry);
    if (l.source) {
      const tag = String(l.source).split('·').pop().trim();
      if (tag) concept('src:' + tag.replace(/[^a-z0-9]+/gi, '_').toLowerCase(), 'channel', tag);
    }
    if (l.repo) concept('repo:' + String(l.repo).toLowerCase(), 'repo', String(l.repo));
  });

  // 阶段2b：建线索节点
  const linkedLeads = [...new Set(leadLinks.map(x => x.lk))];
  linkedLeads.forEach(lk => {
    const l = leadCandidates.find(x => lkOf(x) === lk);
    if (!l) return;
    const node = {
      id: 'lead:' + lk, kind: 'lead',
      label: String(l.name || l.company || lk).slice(0, 40),
      stage: l.stage, icpCat: l.icpCat || '', industry: l.industry || '',
      source: l.source || '', score: l.score || 0
    };
    nodes.push(node);
    ids.add(node.id);      // 关键：同步登记，否则后续 push 会被当成"节点不存在"丢弃
  });
  GRAPH_STATS.leadsTotal = leadCandidates.length;
  GRAPH_STATS.leadsLinked = linkedLeads.length;

  // 阶段2c：此时两端节点都已存在，才可以安全建边
  leadLinks.forEach(x => push('lead:' + x.lk, x.to, x.type, x.ev));


  // 2e) 员工 → 技能：员工会的技能在库里吗
  (db.staff || []).forEach(s => {
    (s.skills || []).forEach(k => {
      push('staff:' + s.id, 'mod:' + String(k).toLowerCase().replace(/[^a-z0-9]/g, ''), 'skill', 'staff.skills');
    });
  });

  // 2f) 告警 → 模块：真实告警记录里出现的模块名
  try {
    const w = require('./watchdog');
    (w.recentAlerts ? w.recentAlerts() : []).slice(0, 30).forEach(a => {
      const txt = String(a.detail || a.msg || '');
      (db.staff || []).forEach(s => { if (txt.indexOf(s.name) >= 0) push('mod:watchdog', 'staff:' + s.id, 'alert', String(a.detail || '').slice(0, 60)); });
    });
  } catch (e) {}

  // 去重（同 from/to/type 只保留一条）
  const seen = new Set();
  return E.filter(e => {
    const k = e.from + '>' + e.to + '>' + e.type;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// —— 3. 图谱查询 ——
function build() {
  Object.keys(GRAPH_STATS).forEach(k => delete GRAPH_STATS[k]);
  const nodes = buildNodes();
  const edges = buildEdges(nodes);
  const byKind = {};
  nodes.forEach(n => { byKind[n.kind] = (byKind[n.kind] || 0) + 1; });
  const byType = {};
  edges.forEach(e => { byType[e.type] = (byType[e.type] || 0) + 1; });
  // 度数：孤立节点是没有关联的知识，那才是真正需要关注的
  const deg = {};
  edges.forEach(e => { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; });
  nodes.forEach(n => { n.degree = deg[n.id] || 0; });
  const isolated = nodes.filter(n => n.degree === 0);
  return {
    nodes, edges, byKind, byType,
    totals: {
      nodes: nodes.length, edges: edges.length,
      density: nodes.length ? Math.round(edges.length / (nodes.length * (nodes.length - 1) / 2) * 10000) / 10000 : 0,
      isolated: isolated.length,
      avgDegree: nodes.length ? Math.round(edges.length * 2 / nodes.length * 10) / 10 : 0
    },
    isolatedSample: isolated.slice(0, 15).map(n => n.kind + ':' + n.label)
  };
}

// 邻域查询：给定节点，返回一跳/两跳邻居 —— 这是图谱真正被"用"起来的方式
function neighborhood(id, depth) {
  const g = build();
  const d = Math.max(1, Math.min(Number(depth) || 1, 3));
  const adj = {};
  g.edges.forEach(e => {
    (adj[e.from] || (adj[e.from] = [])).push({ to: e.to, type: e.type, dir: 'out' });
    (adj[e.to] || (adj[e.to] = [])).push({ to: e.from, type: e.type, dir: 'in' });
  });
  const seen = new Set([id]);
  let frontier = [id];
  const layers = [];
  for (let i = 0; i < d; i++) {
    const next = [];
    const row = [];
    frontier.forEach(n => (adj[n] || []).forEach(e => {
      if (seen.has(e.to)) return;
      seen.add(e.to); next.push(e.to); row.push(e);
    }));
    if (!row.length) break;
    // 【真 bug 修复】原来写的是 `links: row.length`（一个**数字**），而下面返回对象里
    // 又 `layers.flatMap(l => l.links)`——把数字数组摊平，调用方拿到的是 [62, 9]
    // 这种**度数**，完全不是邻接边。任何想读关系类型的调用方都会拿到 undefined。
    // 现在 links 放真正的边对象，linkCount 单独给数字。
    layers.push({
      depth: i + 1,
      linkCount: row.length,
      links: row,
      nodes: next.slice(0, 40)
    });
    frontier = next;
  }
  const nodeMap = {};
  g.nodes.forEach(n => { nodeMap[n.id] = n; });
  return {
    root: nodeMap[id] || null,
    layers,
    nodes: layers.flatMap(l => l.nodes).map(n => nodeMap[n]).filter(Boolean),
    links: layers.flatMap(l => l.links),
    linkCount: layers.reduce((a, l) => a + l.linkCount, 0)
  };
}

// 路径查找：两节点间怎么连上（BFS，最短路径）
// 【命名冲突修复】原来叫 path()，但本文件顶部 import 了 Node 内置 path 模块 ——
// 同名声明会抛 "Identifier 'path' has already been declared"，整个模块加载失败。
// 改名为 shortestPath，语义也更准。
function shortestPath(from, to) {
  const g = build();
  const adj = {};
  g.edges.forEach(e => {
    (adj[e.from] || (adj[e.from] = [])).push(e.to);
    (adj[e.to] || (adj[e.to] = [])).push(e.from);
  });
  const prev = {}, q = [from], seen = new Set([from]);
  while (q.length) {
    const cur = q.shift();
    if (cur === to) break;
    (adj[cur] || []).forEach(nx => { if (!seen.has(nx)) { seen.add(nx); prev[nx] = cur; q.push(nx); } });
  }
  if (!seen.has(to)) return { found: false, reason: '两节点在图上不连通（可能属于不同子图）' };
  const out = [to];
  let cur = to;
  while (cur !== from) { cur = prev[cur]; if (cur === undefined) break; out.unshift(cur); }
  return { found: true, path: out, hops: out.length - 1 };
}

// 中央性：谁连接了最多东西 —— 图谱里最"枢纽"的节点
function centrality(limit) {
  const g = build();
  const deg = {};
  g.edges.forEach(e => { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; });
  return g.nodes.map(n => ({ id: n.id, kind: n.kind, label: n.label, degree: deg[n.id] || 0 }))
    .sort((a, b) => b.degree - a.degree).slice(0, Number(limit) || 20);
}

// 孤立节点诊断：这些是"存在于系统但没和任何东西连起来"的知识/模块
// 这张清单的价值：它直接指出"哪些功能是孤立的、用户看不到它的关联价值"
function orphans(kind) {
  const g = build();
  return g.nodes.filter(n => n.degree === 0 && (!kind || n.kind === kind))
    .map(n => ({ id: n.id, kind: n.kind, label: n.label }));
}

function summary() {
  const g = build();
  return '语义知识图谱：' + g.totals.nodes + ' 节点 / ' + g.totals.edges + ' 边 · 平均度 ' + g.totals.avgDegree
    + ' · 节点类型 ' + Object.keys(g.byKind).length + ' 种 · 边类型 ' + Object.keys(g.byType).length + ' 种'
    + '\n边均有 evidence（来源可回溯），无凭空的语义相似度边'
    + (GRAPH_STATS.leadsTotal ? '；线索 ' + GRAPH_STATS.leadsTotal + ' 条中 ' + GRAPH_STATS.leadsLinked + ' 条有关联而入图，' + (GRAPH_STATS.leadsTotal - GRAPH_STATS.leadsLinked) + ' 条因无任何关联未入图（不拿孤立点充数）' : '')
    + (g.totals.isolated ? '；孤立节点 ' + g.totals.isolated + ' 个（存在但无关联，属待治理）' : '；无孤立节点');
}

module.exports = { build, neighborhood, shortestPath, centrality, orphans, summary, NODE_KINDS };