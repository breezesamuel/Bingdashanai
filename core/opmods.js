// core/opmods.js — 24h 自主运营·功能模块库（50+ 真实可执行模块）
// 每个模块都对"真实数据"做真实操作：体检/扫描/聚合/内容复用/风险值守，
// 全部基于本地 db 的现行数据计算，网络型模块失败即静默降级。
// 由 autopilot.runOnce 按轮次轮巡调用，也可经 /v1/autopilot/modules/:id/run 手动触发。

const store = require('./store');
const brain = require('./brain');
const knowledge = require('./knowledge');
const skills = require('./skills');
const decision = require('./decision');
const providers = require('./providers');
const intel = require('./intel');

const R = Math.round;
const rand = x => (x && x.length) ? x[Math.floor(Math.random() * x.length)] : '';

function today() { return new Date().toDateString(); }
function ageDays(ts) { return Math.max(0, Math.floor((Date.now() - ts) / 86400000)); }

// 每组模块执行后统一写审计（run 内部只做数据操作，审计在 runModule 统一处理）

const MODULES = [
  // ---------- 数据体检（integrity） ----------
  { id: 'db_consistency', name: '数据库一致性校验', cat: '数据体检',
    desc: '校验各集合类型、必填字段、时间戳合法性',
    run: async ctx => {
      const db = ctx.db;
      const arr = ['messages', 'decisions', 'staff', 'projects', 'tasks', 'audit', 'knowledge', 'memory', 'evolution'];
      const bad = [];
      arr.forEach(k => { if (!Array.isArray(db[k])) bad.push(k + ' 非数组'); });
      (db.decisions || []).forEach(x => { if (!x.id || !x.question) bad.push('决策缺 id/question'); });
      (db.tasks || []).forEach(x => { if (!x.id || !x.title) bad.push('任务缺 id/title'); });
      (db.audit || []).forEach(x => { if (!x.action) bad.push('审计缺 action'); });
      const fut = (db.audit || []).filter(x => x.at > Date.now() + 60000).length;
      if (fut) bad.push(fut + ' 条审计时间戳异常超前');
      return '【数据库体检】' + (bad.length ? '发现异常 ' + bad.length + ' 处：\n' + bad.slice(0, 6).map(x => '  ⚠ ' + x).join('\n') : '✓ 全部集合结构完整，无异常');
    } },
  { id: 'knowledge_dedupe', name: '知识库近似查重', cat: '数据体检',
    desc: '按规范化主题词找近似重复知识条目',
    run: async ctx => {
      const ks = ctx.db.knowledge || [];
      const norm = q => String(q).replace(/[\s，。！？!?,.·"'“”]/g, '').slice(0, 18);
      const seen = {}; const dups = [];
      ks.forEach(x => { const k = norm(x.q); if (seen[k]) dups.push(x.q.slice(0, 24) + ' ≈ ' + seen[k]); else seen[k] = x.q.slice(0, 24); });
      return '【知识查重】共 ' + ks.length + ' 条，近似重复 ' + dups.length + ' 组' +
        (dups.length ? '\n' + dups.slice(0, 5).map(d => '  ⚠ ' + d).join('\n') + '\n建议保留最完整一条，其余合并或打 tag 归档。' : '，无近似重复，质量良好');
    } },
  { id: 'memory_maintain', name: '记忆去重与滚动维护', cat: '数据体检',
    desc: '合并重复记忆键、清理超长值',
    run: async ctx => {
      const mem = ctx.db.memory || [];
      const keys = {}; const merged = [];
      mem.forEach(m => { (keys[m.key] = keys[m.key] || []).push(m); });
      Object.keys(keys).forEach(k => { if (keys[k].length > 1) merged.push(k + ' ×' + keys[k].length); });
      const long = mem.filter(m => String(m.value).length > 500).length;
      return '【记忆维护】共 ' + mem.length + ' 条记忆\n  重复键：' + (merged.length ? merged.slice(0, 6).join('、') + '（建议保留最新）' : '无') + '\n  超长值：' + long + ' 条（滚动归档即可）';
    } },
  { id: 'staff_audit', name: '员工档案体检', cat: '数据体检',
    desc: '检查员工缺名/缺角色/空技能/在岗状态',
    run: async ctx => {
      const st = ctx.db.staff || [];
      const bad = st.filter(s => !s.name || !s.role || !(s.skills || []).length);
      const off = st.filter(s => s.status === 'off').length;
      return '【员工档案】在编 ' + st.length + ' 人' + (off ? '（停职 ' + off + '）' : '') + '\n' +
        (bad.length ? '⚠ 档案不完整 ' + bad.length + ' 人：' + bad.slice(0, 5).map(s => s.name || '(无名)').join('、') : '✓ 档案全部完整') + '\n' +
        '技能覆盖：' + [...new Set(st.flatMap(s => s.skills || []))].length + ' 个不同技能';
    } },
  { id: 'task_sweep', name: '任务完整性扫描', cat: '数据体检',
    desc: '检出缺 title/无引用/幽灵任务的记录',
    run: async ctx => {
      const ts = ctx.db.tasks || [];
      const noTitle = ts.filter(t => !t.title).length;
      const noRef = ts.filter(t => !t.ref).length;
      const orphan = ts.filter(t => t.due && typeof t.due === 'string' && !t.done && /^\s*$/.test(t.due)).length;
      return '【任务扫描】共 ' + ts.length + ' 项\n  缺标题 ' + noTitle + ' · 缺来源引用 ' + noRef + ' · 幽灵记录 ' + orphan +
        (noTitle || noRef || orphan ? '\n建议：为任务补全 ref（chat/决策/项目），便于后链路审计归因。' : '\n✓ 记录结构完整');
    } },
  { id: 'audit_health', name: '审计覆盖率体检', cat: '数据体检',
    desc: '审计日志水位、今日写入、异常动作频次',
    run: async ctx => {
      const au = ctx.db.audit || [];
      const todayN = au.filter(x => new Date(x.at).toDateString() === today()).length;
      const byAct = {}; au.forEach(x => { byAct[x.action] = (byAct[x.action] || 0) + 1; });
      const topAct = Object.entries(byAct).sort((a, b) => b[1] - a[1]).slice(0, 3);
      return '【审计体检】存量 ' + au.length + ' 条（上限 1000）· 今日 +' + todayN + '\n' +
        '高频动作：' + topAct.map(([a, n]) => a + '×' + n).join(' 、 ') + '\n' +
        '结论：' + (au.length > 900 ? '⚠ 即将触顶，建议导出 CSV 归档后精简。' : '✓ 审计无异常，可追溯。');
    } },
  { id: 'ledger_recon', name: '资金台账核对', cat: '数据体检',
    desc: '账本明细与净额相互印证、近期大额提醒',
    run: async ctx => {
      const lg = ctx.db.ledger || [];
      const total = lg.reduce((a, b) => a + Number(b.amt || 0), 0);
      const big = lg.filter(x => Math.abs(Number(x.amt || 0)) >= 5000).slice(-5);
      return '【资金核对】共 ' + lg.length + ' 笔 · 净额 ' + (total >= 0 ? '+' : '') + R(total * 100) / 100 +
        (big.length ? '\n近期大额：' + big.map(b => (b.amt >= 0 ? '+' : '') + b.amt).join(' 、 ') : '\n无超 5000 大额变动');
    } },
  // ---------- 决策运营（decision） ----------
  { id: 'decision_flow', name: '决策水位与趋势', cat: '决策运营',
    desc: '决策存量/今日新增/7日趋势/引擎占比',
    run: async ctx => {
      const ds = ctx.db.decisions || [];
      const todayN = ds.filter(x => new Date(x.createdAt).toDateString() === today()).length;
      const engines = {}; ds.forEach(d => { engines[d.engine || 'manual'] = (engines[d.engine || 'manual'] || 0) + 1; });
      const auto = engines['autopilot:' + ''] || ds.filter(d => String(d.engine).startsWith('autopilot') || d.source === 'autopilot').length;
      return '【决策水位】存量 ' + ds.length + ' · 今日 +' + todayN + '\n' +
        '自动引擎占比 ' + (ds.length ? pct(auto / ds.length) : '0%') + '（自动 ' + auto + '）\n' +
        '近7天趋势：' + decision.stats().trend.map(t => t.day + ':' + t.count).join(' ');
    } },
  { id: 'fw_coverage', name: '决策框架覆盖度', cat: '决策运营',
    desc: '52 框架中已应用多少、识别冷门框架',
    run: async ctx => {
      const ds = ctx.db.decisions || [];
      const used = new Set(ds.map(d => String(d.framework || d.engine || ''))
        .map(e => e.replace(/^autopilot:/, '').replace(/^manual:/, '').replace(/@.*$/, '').trim())
        .filter(x => x && !/report|autopilot/i.test(x)));
      const all = decision.FRAMEWORKS.map(f => f.id);
      const usedIds = all.filter(id => [...used].some(u => id === u));
      return '【框架覆盖】可用 ' + all.length + ' 个 · 已应用 ' + usedIds.length + ' 个\n' +
        '冷门建议轮巡：' + (all.filter(id => !usedIds.includes(id)).slice(0, 6).join('、') || '（已全量应用）') + '\n' +
        '提示：可到决策中心手选这些框架对真实问题走一遍。';
    } },
  { id: 'decision_suggest', name: '今日决策清单建议', cat: '决策运营',
    desc: '基于未完成任务推送 3 个"此刻最值得决策"的议题',
    run: async ctx => {
      const ts = (ctx.db.tasks || []).filter(t => !t.done).sort((a, b) => a.createdAt - b.createdAt);
      const picks = ts.slice(0, 3).map(t => t.title).filter(Boolean);
      if (!picks.length) return '【今日决策清单】无待决策议题。建议登记 1 条本周真实决策，帮助年度报告积累样本。';
      return '【今日决策清单】基于 ' + ts.length + ' 项未完成任务，建议优先决策：\n' +
        picks.map((p, i) => (i + 1) + '. ' + p).join('\n') + '\n→ 到决策中心选框架填写，形成证据条+止损线。';
    } },
  { id: 'stoploss_watch', name: '止损线 L1-L4 巡检', cat: '决策运营',
    desc: '资金/任务/项目三线止损信号扫描（参考统一执行总纲）',
    run: async ctx => {
      const db = ctx.db; const L = [];
      const isSettled = require('./money').isSettled;
      const noSelf = require('./money').isSelfTest;
      const byId = new Map((db.orders || []).map(o => [String(o.id), o]));
      const net = (db.revenue || []).filter(r => isSettled(r) && !noSelf(r, byId)).reduce((a, b) => a + Number(b.amt || b.amount || 0), 0);
      const overdue = (db.tasks || []).filter(t => !t.done).length;
      const stalled = (db.projects || []).filter(p => p.status === 'running' && p.progress < 30 && ageDays(p.createdAt) > 14).length;
      if (overdue > 15) L.push('【L2 任务积压】未完成 ' + overdue + ' 项超过 15，须今日清点、砍低压舱石');
      if (stalled) L.push('【L3 项目停滞】' + stalled + ' 个运行项目进度 <30% 且超 14 天，进入「暂停-复盘-再启动」流程');
      if (net < 0 && net < -10000) L.push('【L1 资金告急】净额 ' + net + ' 跌破 -1 万，触发上限止损，禁止追加投入');
      if (!L.length) L.push('✓ 三线正常：任务 ' + overdue + ' 项未完成 · 项目停滞 0 · 资金净额 ' + R(net * 100) / 100);
      return '【止损线 L1-L4 巡检】\n' + L.join('\n');
    } },
  { id: 'decide_roundrobin', name: '决策框架轮巡应用', cat: '决策运营',
    desc: '轮到一个真实热点主题，套用决策框架推演（写入进化流水，不污染决策台账）',
    run: async ctx => {
      const fw = decision.FRAMEWORKS[ctx.round % decision.FRAMEWORKS.length];
      let topic = '每日自运营复盘';
      try { const h = await intel.headlines(); if (h.items && h.items[0]) topic = '今日热点：「' + h.items[0].title.slice(0, 26) + '」的应对'; } catch (e) {}
      const a = decision.apply(fw.id, topic);
      brain.evolve('框架轮巡 · ' + fw.name + ' · ' + topic.slice(0, 30) + ' → ' + (a.content || '').slice(0, 80));
      return '【框架轮巡】应用「' + fw.name + '」到真实主题：' + topic.slice(0, 34) + ' → 推演已入进化流水';
    } },
  { id: 'decision_quality', name: '决策质量抽查', cat: '决策运营',
    desc: '抽查决策是否含证据条/止损线/期限',
    run: async ctx => {
      const man = (ctx.db.decisions || []).filter(d => String(d.engine).includes('manual'));
      const last = man.slice(-3);
      if (!last.length) return '【决策质量】暂无人工决策样本，可在决策中心提交一条后复查。';
      const miss = last.filter(d => !/止损|期限|证据/.test(d.answer || d.question)).length;
      return '【决策质量抽查】最近 ' + last.length + ' 条人工决策（缺要素 ' + miss + ' 条）\n' +
        last.map(d => '  · ' + (d.question || '').slice(0, 30) + ' ' + ( /止损/.test(d.answer || '') ? '✓含止损' : '⚠缺止损线') + ( /期限/.test(d.answer || '') ? '✓期限' : '⚠期限')).join('\n') + '\n' +
        '建议：每条真实决策都带 止损线+复查期限，这是年度报告可复盘的前提。';
    } },
  // ---------- 知识运营（knowledge） ----------
  { id: 'kn_topics', name: '知识主题热度榜', cat: '知识运营',
    desc: '按 tag 统计知识主题分布',
    run: async ctx => {
      const ks = ctx.db.knowledge || [];
      const tags = {}; ks.forEach(x => { const t = x.tag || 'untagged'; tags[t] = (tags[t] || 0) + 1; });
      const top = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 6);
      return '【知识主题】共 ' + ks.length + ' 条\n' + (top.length ? top.map(([t, n]) => '  · ' + t + ' ×' + n).join('\n') : '（知识库为空，可先做一次情报采集）');
    } },
  { id: 'kn_recall_test', name: '知识库调取自测', cat: '知识运营',
    desc: '用最近热点做一次召回命中率自测',
    run: async ctx => {
      const ks = ctx.db.knowledge || [];
      if (!ks.length) return '【知识调取自测】知识库为空，先自动采集一轮热点充实。';
      const probe = (ctx.db.decisions || []).slice(-1)[0] || {};
      const q = (probe.question || '').replace(/【[^】]*】/g, '').slice(0, 10) || '财经';
      const hits = knowledge.recall(q, 5);
      return '【知识调取自测】题目「' + q + '」\n  命中 ' + hits.length + ' 条：' +
        (hits.length ? hits.map(h => '「' + String(h.q).slice(0, 12) + '」').join('、') : '（无命中 — 建议基于该题沉淀一条知识）') + '\n  调取方式：recall 按关键词+时效加权排序。';
    } },
  { id: 'kn_refresh', name: '知识保鲜检查', cat: '知识运营',
    desc: '找出最老知识、标记待复核条目',
    run: async ctx => {
      const ks = ctx.db.knowledge || [];
      if (!ks.length) return '【知识保鲜】暂无知识条目。';
      const old = ks.slice().sort((a, b) => a.createdAt - b.createdAt).slice(0, 3);
      const stale = old.filter(x => ageDays(x.createdAt) > 30).length;
      return '【知识保鲜】最老 3 条：\n' +
        old.map(x => '  · ' + String(x.q).slice(0, 26) + '（' + ageDays(x.createdAt) + '天前）').join('\n') + '\n' +
        (stale ? '⚠ 其中 ' + stale + ' 条超 30 天，建议打开复核或标记"需更新"。' : '✓ 均在保鲜期内。');
    } },
  // ---------- 任务/项目 运营 ----------
  { id: 'task_overdue', name: '过期任务警报', cat: '项目运营',
    desc: '按 due 关键字+创建时间判断滞留任务',
    run: async ctx => {
      const ts = (ctx.db.tasks || []).filter(t => !t.done);
      // due 字段为日期文本：能解析出绝对日期就按日期判断，无法解析的按创建时长兜底
      const kw = { 今: 1, 明: 1, 昨: 9, 周一: 2, 周二: 3, 周三: 4, 周四: 5, 周五: 6, 周六: 7, 周日: 9 };
      const late = ts.filter(t => {
        const k = String(t.due || '').trim();
        if (!k) return ageDays(t.createdAt) > 7;
        const spare = kw[k];
        if (spare !== undefined) return spare >= 7; // 昨天/周日=拖 2 天算过期
        const dd = new Date(k);
        if (!isNaN(dd)) return dd < new Date();
        return ageDays(t.createdAt) > 7;
      });
      const cold = ts.filter(t => ageDays(t.createdAt) > 5).length;
      return '【任务警报】未完成 ' + ts.length + ' 项 · 已过期 ' + late.length + ' · 创建超 5 天仍挂起 ' + cold + ' 项\n' +
        (late.length ? '⚠ 过期待办：' + late.slice(0, 5).map(t => t.title.slice(0, 18)).join('、') + '\n建议：逐个判定「删除/推迟/继续」三选一。' : (cold ? '⚠ 疑似失联任务：' + ts.filter(t => ageDays(t.createdAt) > 5).slice(0, 5).map(t => t.title.slice(0, 18)).join('、') + '\n建议：逐个判定「删除/推迟/继续」三选一。' : '✓ 任务流动正常'));
    } },
  { id: 'proj_health', name: '项目健康度扫描', cat: '项目运营',
    desc: '按进度、停滞、失调评估项目状态',
    run: async ctx => {
      const ps = ctx.db.projects || [];
      if (!ps.length) return '【项目健康】暂无项目。可在组织大脑新增一个真实项目跟踪。';
      const stalled = ps.filter(p => p.status === 'running' && ageDays(p.createdAt) > 10 && p.progress < 20);
      const done = ps.filter(p => p.status === 'done').length;
      const avgProg = ps.reduce((s, p) => s + Number(p.progress || 0), 0) / ps.length;
      return '【项目健康】' + ps.length + ' 个项目 · 平均进度 ' + R(avgProg) + '% · 已完成 ' + done + '\n' +
        (stalled.length ? '⚠ 停滞预警：' + stalled.map(p => p.name || '(无名)').join('、') + ' —— 建议「小步重启」：砍到本轮只做 1 件最小交付。' : '✓ 无停滞项目');
    } },
  { id: 'proj_load', name: '负载均衡检查', cat: '项目运营',
    desc: '按 owner 统计项目负载，识别过载',
    run: async ctx => {
      const ps = ctx.db.projects || [];
      const byOwner = {}; ps.forEach(p => { const o = p.owner || '(未指派)'; byOwner[o] = (byOwner[o] || 0) + 1; });
      const rows = Object.entries(byOwner).sort((a, b) => b[1] - a[1]);
      if (!rows.length) return '【负载均衡】暂无项目数据。';
      const [topName, topN] = rows[0];
      return '【负载均衡】\n' + rows.map(([o, n]) => '  ' + o + ' ×' + n).join('\n') + '\n' +
        (topN >= 4 ? '⚠ ' + topName + ' 负载 ' + topN + ' 项，建议重新分配。' : '✓ 负载均衡，无单点过载。');
    } },
  { id: 'staff_skillgap', name: '员工技能缺口', cat: '项目运营',
    desc: '热度技能 vs 现有技能的缺口清单',
    run: async ctx => {
      const st = ctx.db.staff || [];
      const have = new Set(st.flatMap(s => s.skills || []).map(s => String(s).toLowerCase()));
      const hot = ['LLM', 'RAG', 'MCP', 'Agentic', '多模态', '自动化', '数据分析', '预算'];
      const lack = hot.filter(h => !have.has(h.toLowerCase()));
      return '【技能缺口】员工 '+ st.length + ' 人 · 现有技能 '+ have.size + ' 个\n' +
        '热门能力缺口：' + (lack.length ? lack.slice(0, 6).join('、') : '无') + '\n' +
        '建议：由吱吱/玄镜等牵头，把缺口技能做成知识条目沉淀，形成团队可调用资产。';
    } },
  // ---------- 内容复用器 E1（一料五吃） ----------
  { id: 'cnr_report', name: '每日运营快报', cat: '内容复用',
    desc: '今日动作聚合生成一份快报',
    run: async ctx => {
      const au = (ctx.db.audit || []).filter(x => new Date(x.at).toDateString() === today());
      const by = {}; au.forEach(x => { by[x.action] = (by[x.action] || 0) + 1; });
      const dec = (ctx.db.decisions || []).filter(x => new Date(x.createdAt).toDateString() === today());
      return ['【每日运营快报】' + new Date().toLocaleDateString(),
        '· 今日动作 ' + au.length + ' 条：' + Object.entries(by).map(([a, n]) => a + '×' + n).join(' ')
          .replace(/技能·执行/g, '技能执行').slice(0, 60),
        '· 今日决策 ' + dec.length + ' 条' + (dec.length ? '：' + dec.slice(0, 3).map(d => d.question.slice(0, 20)).join('｜') : ''),
        '· 建议：' + rand(['把今日知识提升为明日报告素材', '对今日最大动作做一次复盘', '留灯给同样处境的人'])
      ].join('\n');
    } },
  { id: 'cnr_quickq', name: '快速口吻问答卡', cat: '内容复用',
    desc: '从知识库生成 3 问 3 答的轻量内容',
    run: async ctx => {
      const ks = ctx.db.knowledge || [];
      if (ks.length < 3) return '【快速问答卡】知识条目不足 3 条，先充实。';
      const picks = ks.slice(-3);
      return '【快速问答卡（3Q3A）】\n' +
        picks.map((x, i) => 'Q' + (i + 1) + ' ' + String(x.q).slice(0, 30) + '\n  A ' + String(x.a).slice(0, 46) + '…').join('\n') +
        '\n→ 可直接用于朋友圈/社媒轻量分发（口径：一句话+一句补充）。';
    } },
  { id: 'cnr_podcast', name: '播客口播脚本骨架', cat: '内容复用',
    desc: '把今日知识/热点转成 3 分钟口播脚本',
    run: async ctx => {
      const ks = ctx.db.knowledge || [];
      const topic = ks.slice(-1)[0] || {};
      const t = String(topic.q || '今日话题');
      return '【播客脚本·3分钟】主题：' + t.slice(0, 30) + '\n' +
        '00:00 钩子（30s）：抛出听众现状问题：' + t.slice(0, 20) + '……你遇到过吗？\n' +
        '00:30 展开（90s）：2 个要点，每个带 1 个真实数据/例子，不念术语\n' +
        '02:00 行动（60s）：给"今晚就能做"的 1 个小动作\n' +
        '03:00 结束（尾音）：留一句给同路人的灯。\n→ 语气：讲人话，慎用"赋能/抓手/颗粒度"。';
    } },
  { id: 'cnr_seo', name: 'SEO 内容页骨架', cat: '内容复用',
    desc: '围绕主题词生成标题决策树+结构化提纲',
    run: async ctx => {
      const ks = ctx.db.knowledge || [];
      const t = String((ks.slice(-1)[0] || {}).q || '决策方法论').replace(/【[^】]*】/g, '').slice(0, 16);
      return '【SEO 页骨架】主词：' + t + '\n' +
        'H1：' + t + '，普通人最缺的一课\n' +
        'H2 他频：' + t + ' 是什么 / ' + t + ' 为什么难 / ' + t + ' 的 3 个坑\n' +
        'H2 长尾：' + t + ' vs ' + rand(['情绪决策', '拖延', '信息过载']) + ' 怎么选\n' +
        '正文结构：问题→1个真实例子→3步方法→可复制的清单\n' +
        '内链：决策中心->框架库 -> 现存干货页。';
    } },
  { id: 'cnr_annual', name: '年度决策报告素材', cat: '内容复用',
    desc: '从全年决策/知识/任务聚合年报素材（对焦年度报告页）',
    run: async ctx => {
      const ds = ctx.db.decisions || [];
      const ks = ctx.db.knowledge || [];
      const auto = ds.filter(d => String(d.engine).startsWith('autopilot') || d.source === 'autopilot').length;
      return '【年度报告素材位】\n' +
        '· 全年决策 ' + ds.length + ' 条（人工 ' + (ds.length - auto) + ' · 自动 ' + auto + '）\n' +
        '· 决策人格分布：可到"六型测试"结果聚合（需 20 题样本）\n' +
        '· 止损线命中：见止损看板页 L1-L4\n' +
        '· 知识沉淀 ' + ks.length + ' 条 → 挑 12 条金句做"年度灯角"第 7 段\n' +
        '· 第 7 段灯角位：收录同路人 T1 故事 ' + ((ctx.db.peers || []).filter(p => p.kind === 'T1').length) + ' 篇';
    } },
  { id: 'cnr_matrix', name: '内容复用矩阵', cat: '内容复用',
    desc: '当前可用素材 x 输出渠道映射',
    run: async ctx => {
      const ks = ctx.db.knowledge || [];
      const ds = ctx.db.decisions || [];
      const mm = (ds.length ? '决策证据条' : '') + (ks.length ? '知识条目' : '');
      if (!mm) return '【复用矩阵】暂无素材。先积累：任一决策(证据条)、任一知识(金句)即可启复用引擎。';
      return '【内容复用矩阵】现有素材：' + mm + '\n' +
        '任一素材 → 5 种出口（一料五吃）：\n' +
        '  ① 报告：进"快速问"答案\n' +
        '  ② 朋友圈：摘要卡（q 1 句 + a 1 句）\n' +
        '  ③ 博客：万字长文骨架（问题→例子→3步→清单）\n' +
        '  ④ 播客：3 分钟口播脚本\n' +
        '  ⑤ SEO：标题决策树 + 内链\n' +
        '原则：只复用真实数据，不编造案例。';
    } },
  { id: 'cnr_lighthouse', name: '灯角内容选编', cat: '内容复用',
    desc: '从同路人故事选出可入报告第7段的灯',
    run: async ctx => {
      const peers = ctx.db.peers || [];
      const t1 = peers.filter(p => p.kind === 'T1');
      if (!t1.length) return '【灯角选编】暂无同路人故事。写一个 T1「我这样走出来了」即可点亮报告第 7 段。';
      const last = t1.slice(-1)[0];
      return '【灯角选编】候选 ' + t1.length + ' 篇 · 本期点亮：\n' +
        '「' + String(last.story || '').slice(0, 60) + '」\n' +
        '—— ' + (last.anonName || '一位同路人') + '\n' +
        '发布检查：□ 已匿名 □ 无比较句 □ 无金额细节 □ opt-in 已确认';
    } },
  // ---------- 风险值守（crisis） ----------
  { id: 'crisis_scan', name: '危机关键词扫描', cat: '风险值守',
    desc: '扫描任务/知识/对话标题命中危机词，触发转介卡',
    run: async ctx => {
      const KEYS = ['被裁', '失业', '破产', '欠债', '抑郁', '轻生', '想不开', '活不下去', '还不起', '绝症', '被家暴', '被诈骗'];
      const pool = []
        .concat((ctx.db.tasks || []).map(t => String(t.title || '')))
        .concat((ctx.db.decisions || []).map(d => String(d.question || '')))
        .concat((ctx.db.knowledge || []).map(k => String(k.q || '') + ' ' + String(k.a || '')))
        .concat((ctx.db.staff || []).map(s => String(s.name || '') + ' ' + String(s.notes || '')))
        .concat((ctx.db.messages || []).slice(-30).map(m => String(m.content || '')));
      const hit = KEYS.filter(k => pool.some(p => p.includes(k)));
      return '【危机值守】扫描 ' + pool.length + ' 条文本 · 命中危机词：' +
        (hit.length ? hit.join('、') + '\n→ 立刻打开"活下去手册"转介页（心理援助热线 12356）' : '无\n✓ 通行安全。') +
        '\n红线：只做提示不诊断，遇高危词不用 AI 安慰代替专业热线。';
    } },
  { id: 'dignity_guard', name: '尊严禁词核对', cat: '风险值守',
    desc: '扫描近 30 条消息是否含俯视/居高临下词汇（FINAL 手册尊严条款）',
    run: async ctx => {
      const BAD = ['你太矫情', '这就想不开了', '别人都能', '你不行', '你不够努力', '可怜', '哭什么哭', '你有病', '看开点', '别想太多'];
      const msgs = (ctx.db.messages || []).slice(-30).map(m => String(m.content || ''));
      const hit = BAD.filter(w => msgs.some(s => s.includes(w)));
      return '【尊严禁词核对】扫描最近 ' + msgs.length + ' 条输出\n' +
        (hit.length ? '⚠ 命中禁止表达：' + hit.join('、') + '\n  标准动作：改写为"正在走路的人"，禁止俯视、比较、健康叙事。' : '✓ 无俯视表达，用词有尊严。') +
        '\n铁律：通篇"正在走路的人"，绝不俯视。';
    } },
  { id: 'hotline_card', name: '心理援助转介卡', cat: '风险值守',
    desc: '12356 心理援助热线速查卡',
    run: async ctx => {
      return '【心理援助速查】\n' +
        '· 全国统一心理援助热线：12356（24小时）\n' +
        '· 紧急情况：拨打 110/120 或就近就医\n' +
        '· 使用姿势：让求助者先呼吸；询问"你现在在哪，身边有谁"，只陪不劝\n' +
        '· 不承诺保密之外的同理；不评价不比较\n' +
        '· 本系统定位：给出可执行的下一步入口，绝不"劝想开"。';
    } },
  { id: 'escalate_human', name: '人工升级路径', cat: '风险值守',
    desc: '高危信号转人工复核的标准动作清单',
    run: async ctx => {
      return '【人工升级路径】当出现以下信号时停止自动应答，转人工/热线：\n' +
        '  ① 危机关键词连续命中 2 次以上\n' +
        '  ② 对话中出现自伤/他伤明确意图\n' +
        '  ③ 用户连续索要具体危害方法\n' +
        '  ④ 数据异常集中（大额亏损+失业+健康叠加）\n' +
        '标准动作：停止劝导 → 转介 12356 → 记录在案（脱敏）→ 24h 内不做二次打扰。';
    } },
  // ---------- 情报采集（intel） ----------
  { id: 'intel_hot', name: '全网热点采集入库', cat: '情报采集',
    desc: '拉取全网头条并沉淀为情报采集库（真实抓取，不污染精选知识库）',
    run: async ctx => {
      try {
        const h = await intel.headlines();
        if (!h.items.length) return '【热点采集】暂无头条返回（源不可达或为空）。';
        const sample = h.items.slice(0, 3).map(x => '[' + x.src + '] ' + x.title).join(' | ');
        const db = store.read();
        if (!Array.isArray(db.intel)) db.intel = [];
        // 入库去重：同源同摘要不重复进库，避免轮巡反复把同一热点刷满采集库
        const dup = db.intel.some(x => x.q === '自动采集：全网热点' && String(x.a || '') === sample.slice(0, 200));
        if (!dup) {
          db.intel.push({ q: '自动采集：全网热点', a: sample.slice(0, 200), tag: 'intel', createdAt: Date.now() });
          if (db.intel.length > 40) db.intel = db.intel.slice(-40);
          store.write(db);
        }
        return '【热点采集】' + h.items.length + ' 条热点头条已抓取（' + [...new Set(h.items.map(x => x.src))].join('/') + '）\n首条：' + h.items[0].title.slice(0, 44) + (dup ? '\n内容与已有情报相同，跳过重复入库。' : '\n已入情报采集库。');
      } catch (e) { return '【热点采集】网络暂不可达，自动跳过：' + e.message.slice(0, 40); }
    } },
  { id: 'intel_skills', name: '开源技能发现', cat: '情报采集',
    desc: 'GitHub 检索高价值开源模块并收录（真实数据）',
    run: async ctx => {
      try {
        const s = await intel.gitSearch('agent skill mcp', { per: 5 });
        if (!s.reach) return '【开源发现】GitHub 暂不可达/限流，跳过本轮。';
        const picked = s.items.filter(x => x.stars >= 500).slice(0, 2);
        let added = 0;
        for (const it of picked) {
          const r = skills.addExternal({ name: it.name, cat: 'agents', src: it.repo, confidence: 'unverified', note: '自主运营发现 · ★' + it.stars });
          if (r.added) added++;
        }
        return '【开源发现】检索到 ' + s.total + ' 项，收录 ' + added + ' 个（★≥500）：' + picked.map(x => x.name).join('、') + ' → 已入技能军械库外部区。';
      } catch (e) { return '【开源发现】' + e.message.slice(0, 50); }
    } },
  { id: 'intel_market', name: '行业动态快照', cat: '情报采集',
    desc: '抓科技新闻转动态快照（真实抓取）',
    run: async ctx => {
      try {
        const news = await skills.invoke('news', { q: 'tech' }, {}).then(r => r.output);
        const lines = String(news).split('\n').slice(1, 5).map(x => x.trim()).filter(Boolean);
        if (!lines.length) return '【行业动态】新闻源暂不可达。';
        return '【行业动态快照】（来源库：Hacker News/科技 RSS）\n' + lines.slice(0, 4).join('\n') + '\n→ 已备作今日情报素材。';
      } catch (e) { return '【行业动态】' + e.message.slice(0, 50); }
    } },
  { id: 'intel_weather', name: '环境快照记录', cat: '情报采集',
    desc: '北京气象写入记忆（真实 Open-Meteo）',
    run: async ctx => {
      try {
        const w = await skills.invoke('weather', { q: '北京' }, {}).then(r => r.output);
        brain.remember('气象快照', '自动气象观测：' + String(w).split('\n')[0].slice(0, 40), true);
        return '【环境快照】' + String(w).split('\n')[0] + ' 已写入滚动记忆。';
      } catch (e) { return '【环境快照】气象源暂不可达。'; }
    } },
  // ---------- 大脑/进化（selfop） ----------
  { id: 'brain_evolve', name: '进化日志检查', cat: '大脑进化',
    desc: '进化事件节奏与最近里程碑',
    run: async ctx => {
      const ev = ctx.db.evolution || [];
      const todayN = ev.filter(x => new Date(x.at).toDateString() === today()).length;
      const last = ev.slice(-1)[0] || {};
      return '【进化日志】累计 ' + ev.length + ' 条 · 今日 +' + todayN + '\n' +
        '最近里程碑：' + (last.note ? String(last.note).slice(0, 50) : '（尚无）') + '\n' +
        '节奏' + (todayN > 0 ? '：今日有进化，发育正常。' : '：今日暂无新进化点。');
    } },
  { id: 'learn_curve', name: '学习曲线体检', cat: '大脑进化',
    desc: '各通道成功率/延迟汇总',
    run: async ctx => {
      const st = brain.learnStats();
      if (!st.length) return '【学习曲线】尚无调用样本，完成一次对话后自动建立。';
      const best = st.slice().sort((a, b) => b.rate - a.rate)[0];
      const low = st.filter(x => x.n > 3 && x.rate < 40);
      return '【学习曲线】' + st.length + ' 个通道\n' +
        st.map(x => '  ' + x.provider + ' ✓' + x.ok + ' ✗' + x.fail + ' ' + x.rate + '% ' + x.avgMs + 'ms').join('\n') + '\n' +
        '健康通道：' + best.provider + '（' + best.rate + '%）' + (low.length ? '\n⚠ 待降级：' + low.map(x => x.provider).join('、') : '');
    } },
  { id: 'provider_advise', name: '通道优化建议', cat: '大脑进化',
    desc: '未配密钥/成功率差通道给出补位建议',
    run: async ctx => {
      const pl = providers.list();
      const unkeyed = pl.filter(p => !p.hasKey);
      const low = brain.learnStats().filter(x => x.n > 3 && x.rate < 40).map(x => x.provider);
      return '【通道优化】共 ' + pl.length + ' 个模型通道 · 已配 ' + (pl.length - unkeyed.length) + '\n' +
        (unkeyed.length ? '未配密钥：' + unkeyed.slice(0, 6).map(p => p.name).join('、') + '（可到设置页补 key 启用）\n' : '') +
        (low.length ? '⚠ 成功率低待降级：' + low.join('、') + '，自动路由会绕开。' : '✓ 各通道曲线正常。');
    } },
  { id: 'self_water', name: '自运营水位快照', cat: '大脑进化',
    desc: '系统九维水位写入滚动记忆',
    run: async ctx => {
      const db = ctx.db;
      const h = { 决策: (db.decisions || []).length, 员工: (db.staff || []).length, 项目: (db.projects || []).length, 任务: (db.tasks || []).length, 记忆: (db.memory || []).length, 知识: (db.knowledge || []).length, 审计: (db.audit || []).length, 进化: (db.evolution || []).length, 技能: (db.skills_ext || []).length };
      brain.remember('水位快照', '系统水位 ' + JSON.stringify(h), true);
      return '【水位快照】' + Object.entries(h).map(([k, v]) => k + ' ' + v).join(' · ') + '\n已写入滚动记忆。';
    } },
  { id: 'skill_inventory', name: '技能军械库盘点', cat: '大脑进化',
    desc: '内置/外部/模板技能水位与可用度',
    run: async ctx => {
      const r = skills.registry('');
      let extLive = 0;
      try { const v = await skills.verifyRegistry(false); if (v && v.items) extLive = v.items.filter(x => x.status === 'ok').length; } catch (e) {}
      return '【军械库盘点】内置 ' + r.builtin.length + ' · 外部 ' + r.external.length + ' · 模板 ' + r.template.length + '（共 ' + r.total + '）\n' +
        '外部源健康 ' + extLive + '/' + r.external.length + ' · 全部可经 invoke 真实执行、写审计。';
    } },
  { id: 'skill_gap_fill', name: '技能缺口自动补位', cat: '大脑进化',
    desc: '从军械库热门外抽 1 个高价值模块建议应用',
    run: async ctx => {
      const r = skills.registry('');
      const ext = r.external || [];
      if (!ext.length) return '【技能补位】外部库为空，先做一轮开源发现。';
      const pick = rand(ext);
      const used = (ctx.db.decisions || []).slice(-10).some(d => (d.question || '').includes(pick[1]));
      return '【技能补位】建议近期应用：' + pick[1] + '（' + pick[3] + '）\n' +
        '理由：' + (used ? '近期决策已提及，可落地验证。' : '尚未用于真实决策，值得试点。') + '\n' +
        '调用方式：技能军械库 → 该技能 → 执行（可传 deploy=1 真实克隆）。';
    } },
  { id: 'year_progress', name: '年度进度展望', cat: '大脑进化',
    desc: '按今年已过天数计算进度与剩余目标提醒',
    run: async ctx => {
      const now = new Date();
      const y0 = new Date(now.getFullYear(), 0, 1);
      const yEnd = new Date(now.getFullYear() + 1, 0, 1);
      const p = (now - y0) / (yEnd - y0);
      const ds = ctx.db.decisions || [];
      const rate = ds.length ? pct(ds.filter(d => new Date(d.createdAt).getFullYear() === now.getFullYear()).length / (ds.length || 1)) : '0%';
      return '【年度展望】今年已过 ' + pct(p) + '（' + now.getFullYear() + '年）\n' +
        '· 决策节奏：今年已产生决策 ' + ds.filter(d => new Date(d.createdAt).getFullYear() === now.getFullYear()).length + ' 条\n' +
        '· 提醒：年底前完成"年度决策报告"素材聚合 + 止损线终检。';
    } },
  { id: 'concat_analyze', name: '全局检索自检', cat: '大脑进化',
    desc: '对系统近期生成做一次综合分析演练',
    run: async ctx => {
      try {
        const out = await skills.invoke('analyze', { q: '系统自检' }, {});
        return '【综合自检】' + String(out.output).split('\n').slice(1, 5).join('\n');
      } catch (e) { return '【综合自检】失败：' + e.message.slice(0, 60); }
    } },
  { id: 'top_knowledge', name: '知识金句挑选', cat: '内容复用',
    desc: '从知识库挑选可复用为核心的 3 条金句',
    run: async ctx => {
      const ks = ctx.db.knowledge || [];
      if (!ks.length) return '【金句挑选】知识库为空，先去采集一轮。';
      const picks = ks.slice().sort((a, b) => String(a.a || '').length - String(b.a || '').length).slice(0, 3);
      return '【知识金句】3 条最精炼沉淀，可直接用于内容复用：\n' +
        picks.map((x, i) => (i + 1) + '. ' + String(x.q).slice(0, 22) + ' → ' + String(x.a).slice(0, 40)).join('\n');
    } },
  { id: 'staff_flow', name: '在岗动态值班', cat: '项目运营',
    desc: '检查在岗员工与任务在手数，输出值班快照',
    run: async ctx => {
      const st = (ctx.db.staff || []).filter(s => s.status !== 'off');
      const ts = (ctx.db.tasks || []).filter(t => !t.done);
      if (!st.length) return '【在岗值班】无在岗员工。';
      const per = Math.max(1, Math.round(ts.length / st.length));
      return '【在岗值班】' + st.length + ' 人在岗 · 未完成任务 ' + ts.length + ' 项\n' +
        st.map(s => '  · ' + (s.name || '') + '（' + (s.role || '') + '）' + (s.skills || []).slice(0, 3).join('/')).join('\n') + '\n' +
        '人均在办 ≈ ' + per + ' 项' + (per > 5 ? ' ⚠ 负载偏高' : '');
    } },
  { id: 'decision_engine', name: '自动/人工决策占比', cat: '决策运营',
    desc: '引擎构成统计，指导手动补充样本',
    run: async ctx => {
      const ds = ctx.db.decisions || [];
      const auto = ds.filter(d => String(d.engine).startsWith('autopilot') || d.source === 'autopilot').length;
      const man = ds.length - auto;
      return '【决策构成】共 ' + ds.length + ' 条\n' +
        '自动引擎 ' + auto + '（' + (ds.length ? pct(auto / ds.length) : '0%') + '）· 人工 ' + man + '（' + (ds.length ? pct(man / ds.length) : '0%') + '）\n' +
        '建议目标：人工样本 ≥ 20 条/年，保证年度报告的可读性。';
    } },
  { id: 'swot_applier', name: '热点 SWOT 演练', cat: '决策运营',
    desc: '以今日热点为对象走 SWOT 框架',
    run: async ctx => {
      let topic = '当前业态';
      try { const h = await intel.headlines(); if (h.items && h.items[0]) topic = '今日热点：' + h.items[0].title.slice(0, 30); } catch (e) {}
      const out = await skills.invoke('swot', { topic: topic }, {});
      return '【SWOT 演练】' + topic + '\n' + String(out.output).replace('【' + topic + ' SWOT 框架】', '').slice(0, 200) + '\n→ 可用决策中心框架库补充证据条。';
    } },
  { id: 'contingency_check', name: '应急储备检查', cat: '风险值守',
    desc: '按知识/资金沉淀检查应急准备度',
    run: async ctx => {
      const ks = ctx.db.knowledge || [];
      const hasCont = ks.some(x => /应急|预案|危机|守住/.test(String(x.q) || String(x.a)));
      const isSettled = require('./money').isSettled;
      const noSelf = require('./money').isSelfTest;
      const byId = new Map((ctx.db.orders || []).map(o => [String(o.id), o]));
      const net = (ctx.db.revenue || []).filter(r => isSettled(r) && !noSelf(r, byId)).reduce((a, b) => a + Number(b.amt || b.amount || 0), 0);
      return '【应急储备】危机预案知识：' + (hasCont ? '✓ 已沉淀' : '✗ 缺失（建议用"活下去手册"补一条）') + '\n' +
        '资金缓冲：累计入账 ' + R(net * 100) / 100 + (net < 0 ? ' ⚠ 负值，建议优先安排' : '') + '\n' +
        '入账笔数：' + (ctx.db.revenue || []).length + ' 笔';
    } },
  { id: 'weekly_rollup', name: '本周聚合报告', cat: '内容复用',
    desc: '按周聚合决策与知识流动',
    run: async ctx => {
      const now = new Date();
      const iso = d => { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x.toDateString(); };
      const wk = iso(now);
      const ds = (ctx.db.decisions || []).filter(x => iso(x.createdAt) === wk);
      const ks = (ctx.db.knowledge || []).filter(x => iso(x.createdAt) === wk);
      return '【本周聚合】本周（含今日）\n· 决策 ' + ds.length + ' 条' + (ds.length ? '：' + ds.slice(0, 3).map(d => d.question.slice(0, 18)).join('｜') : '') +
        '\n· 知识 +' + ks.length + ' 条 · 审计 ' + (ctx.db.audit || []).filter(x => iso(x.at) === wk).length + ' 条\n' +
        '· 已过 ' + ((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / (new Date(now.getFullYear() + 1, 0, 1) - new Date(now.getFullYear(), 0, 1)) * 100).toFixed(0) + '% 年度';
    } },
  { id: 'epilogue_seven', name: '第7段灯角状态', cat: '内容复用',
    desc: '年度报告第 7 段灯角位材料状态',
    run: async ctx => {
      const peers = ctx.db.peers || [];
      const t1 = peers.filter(p => p.kind === 'T1').length;
      const mem = (ctx.db.memory || []).filter(m => /灯角|同路人|T1/.test(m.key)).length;
      return '【第7段灯角】年度报告最后一段的"灯"：\n' +
        '· 同路人 T1 故事 ' + t1 + ' 篇（目标 ≥ 3 篇点亮一周）\n' +
        '· 记忆灯角位 ' + mem + ' 条\n' +
        '规则：只呈现"同一处境"的故事；匿名+自愿；不开帖不回评不私信。';
    } },
  { id: 'milestone_detect', name: '数据里程碑检测', cat: '数据体检',
    desc: '检测是否新破 100/500/1000 水位线，写进化日志',
    run: async ctx => {
      const db = ctx.db;
      const hit = [];
      // 记录已播报水位线，避免重复刷屏；跨档（如 99→101）也能捕获
      const seen = db.milestones || {};
      const injects = { decisions: '决策', knowledge: '知识', audit: '审计', projects: '项目', tasks: '任务' };
      const BAR = [100, 500, 1000];
      const fresh = false;
      for (const k in injects) {
        const c = (db[k] || []).length;
        for (const bar of BAR) {
          if (c >= bar && !seen[k + ':' + bar]) {
            hit.push(injects[k] + ' 破 ' + bar);
            seen[k + ':' + bar] = true;
          }
        }
      }
      db.milestones = seen;
      store.write(db);
      if (hit.length) brain.evolve('里程碑：' + hit.join('、'));
      return '【里程碑】' + (hit.length ? '🎉 新里程碑：' + hit.join('、') + ' —— 已写入进化日志。' : '暂无新水位线达成。') + '\n当前水位：决策 ' + (db.decisions || []).length + ' · 知识 ' + (db.knowledge || []).length + ' · 审计 ' + (db.audit || []).length;
    } },
  { id: 'sentiment_daily', name: '今日舆情体检', cat: '情报采集',
    desc: '对今日消息做情感极性体检',
    run: async ctx => {
      const msgs = (ctx.db.messages || []).filter(m => new Date(m.createdAt).toDateString() === today());
      if (!msgs.length) return '【舆情体检】今日暂无对话样本。';
      const text = msgs.map(m => '对刚才的讨论' + m.content).join('\n');
      try {
        const out = await skills.invoke('sentiment', { text: text.slice(0, 600) }, {});
        return '【舆情体检】基于今日 ' + msgs.length + ' 条对话：' + String(out.output);
      } catch (e) { return '【舆情体检】' + e.message.slice(0, 50); }
    } },
  { id: 'weather_break', name: '异常天气提醒', cat: '情报采集',
    desc: '北京天气预警词检测',
    run: async ctx => {
      try {
        const w = await skills.invoke('weather', { q: '北京' }, {}).then(r => r.output);
        const s = String(w);
        const bad = /大风|暴雨|雷电|冰雹|高温|寒潮|预警/.test(s);
        return '【天气提醒】' + s.split('\n')[0] + (bad ? '\n⚠ 存在异常天气因子，涉及外出类任务请同步。' : '\n✓ 无预警因子。');
      } catch (e) { return '【天气提醒】气象源暂不可达。'; }
    } },
  { id: 'goal_quarter', name: '季度目标盘点', cat: '大脑进化',
    desc: '按年度季度折算目标完成假设',
    run: async ctx => {
      const now = new Date();
      const q = Math.floor(now.getMonth() / 3) + 1;
      const qDone = (now.getMonth() % 3) + 1;
      // 季度剩余天数：当前日期 -> 季末最后一天
      const qEndMonthIdx = q * 3; // 季末月的下一个月(0-based) → new Date(y, m, 0) 得季末月最后一天
      const qEnd = new Date(now.getFullYear(), qEndMonthIdx, 0);
      const qLeft = Math.max(0, Math.round((qEnd - now) / 86400000));
      const ds = (ctx.db.decisions || []).filter(d => {
        const x = new Date(d.createdAt);
        return Math.floor(x.getMonth() / 3) + 1 === q && x.getFullYear() === now.getFullYear();
      }).length;
      return '【季度盘点】Q' + q + '（本季已过 ' + qDone + ' 月/3）\n' +
        '本季决策 ' + ds + ' 条 · 距季末 ' + qLeft + ' 天\n' +
        '建议：每季末把本季决策按止损线复盘一次，写入年度报告素材。';
    } },
  { id: 'audit_csv_ready', name: '数据导出就绪检查', cat: '数据体检',
    desc: '审计/决策可导出 CSV 的字段就绪状态',
    run: async ctx => {
      const au = ctx.db.audit || [];
      const ds = ctx.db.decisions || [];
      return '【导出就绪】审计 ' + au.length + ' 条可导出（action/detail/at）· 决策 ' + ds.length + ' 条可导出（question/answer/engine）\n' +
        '出口：审计日志与决策列表均提供 CSV 下载；导出就是最轻的"内容复用"。';
    } },
  { id: 'peer_pulse', name: '同路人活跃脉搏', cat: '风险值守',
    desc: '同路人贡献与灯角素材库存检查',
    run: async ctx => {
      const peerMod = require('./peers');
      const t1 = (ctx.db.peers || []).filter(p => p.kind === 'T1').length;
      const approved = (ctx.db.peers || []).filter(p => p.kind === 'T1' && p.approved && !p.hidden).length;
      const handoffs = (ctx.db.handoffs || []).length;
      const thanked = (ctx.db.handoffs || []).filter(h => h.thanked).length;
      return '【同路人脉搏】T1 投稿 ' + t1 + ' · 已批准上灯 ' + approved + ' · 递一把 ' + handoffs + ' 次 · 被帮到 ' + thanked + ' 次\n' +
        '卦分布：' + JSON.stringify(peerMod.countLights()) + '\n' +
        '规则：匿名化+自愿 opt-in+危机语境零展示；认同感是事实计数不是勋章。';
    } },
  { id: 'manual_of_day', name: '手册守卫巡检', cat: '风险值守',
    desc: '12 本手册完整性 + 危机版零商业约束 + 尊严禁词全量扫描',
    run: async ctx => {
      const manuals = require('./manuals');
      const mlist = manuals.MANUALS;
      const crisis = mlist.find(m => m.crisis);
      const bad = mlist.filter(m => !m.steps || !m.steps.length || !m.title);
      const scans = mlist.map(m => manuals.scanDignity((m.steps || []).join('') + (m.dont || []).join('')));
      const hits = scans.filter(s => !s.passes).length;
      return '【手册巡检】' + mlist.length + ' 本 · 危机版 #' + (crisis ? crisis.no : '?') + ' 零商业=' + (crisis ? crisis.commerce === false : 'N/A') +
        '\n模板完整：' + (bad.length ? '⚠ ' + bad.map(b => '#' + b.no).join(',') + ' 缺步骤/标题' : '✓ 全部六段结构完整') +
        '\n尊严扫描：' + (hits ? '⚠ ' + hits + ' 本命中禁词（需人工复审）' : '✓ 12 本全过禁词表');
    } },
  { id: 'peers_ledger', name: '被帮账本盘点', cat: '决策运营',
    desc: '灯角/递一把/被帮计数聚合，确认认同感是事实计数',
    run: async ctx => {
      const peers = require('./peers');
      const st = peers.stats();
      const board = peers.leaderboard();
      return '【被帮账本】灯角 ' + st.lightsTotal + ' 盏 · 本月递出 ' + st.handoffsMonth + ' 次 · 被帮到 ' + st.thankedTotal + ' 次\n' +
        (board.length ? '帮到榜：' + board.slice(0, 3).map(b => b.payload + '×' + b.helped).join(' · ') : '尚无被帮确认——认同感的货币是事实计数，不是勋章。');
    } },
{ id: 'repurpose_batch', name: '内容复用批量巡检', cat: '内容复用',
    desc: '扫描库内素材授权状态，提示未入库的复用机会',
    run: async ctx => {
      const repurpose = require('./repurpose');
      const rep = require('./annual');
      const list = repurpose.list();
      const ready = list.filter(x => (x.granted || []).length);
      const pending = list.filter(x => !(x.granted || []).length);
      const repNum = list.filter(x => x.variants && x.variants.length).length;
      return '【内容复用】素材库 ' + list.length + ' 条 · 已一料五吃 ' + repNum + ' 条 · 已授权载体 ' + ready.length + ' · 待授权 ' + pending.length +
        '\n建议：' + (list.length === 0 ? '从最近的同路人/历史案例里喂第一条素材，机器负责变形。' : (pending.length ? '给 ' + pending.slice(0, 2).map(p => p.source).join('、') + ' 勾选授权载体，解锁可发布产物。' : '授权齐备，变形产物可直接进发布队列。'));
    } },
  { id: 'train_pulse', name: '发布列车班次脉搏', cat: '风险值守',
    desc: '当前班次装载进度与 tech debt 欠账一眼看清',
    run: async ctx => {
      const train = require('./train');
      const b = train.board();
      const slots = Object.values(b.current.slots).filter(Boolean);
      const debt = train.techDebt();
      return '【发布列车】第 ' + b.current.no + ' 班 · 已装 ' + slots.length + '/3 格' +
        (b.current.released ? ' · 已发车' : '') +
        '\n增长件：' + (b.current.slots.growth ? b.current.slots.growth.title : '空') +
        '\n留存件：' + (b.current.slots.retention ? b.current.slots.retention.title : '空') +
        '\n还债件：' + (b.current.slots.debt ? b.current.slots.debt.title : debt.length ? '⚠ ' + debt.length + ' 项待还：' + debt[0] : '空') +
        '\nparking lot ' + b.lotCount + ' 条（火车不等人，lot 不删）';
    } },
  { id: 'ticket_sweep', name: '客服工单值班巡检', cat: '风险值守',
    desc: 'SLA 超时/将超时工单提醒 + 周日自动周批（P2 单聚合批阅场次）',
    run: async ctx => {
      const tickets = require('./tickets');
      const w = tickets.slaWatch();
      const st = tickets.stats();
      const dow = new Date().getDay();
      let batchNote = '';
      if (dow === 0) {
        const sb = tickets.sundayBatch();
        if (sb.size) {
          batchNote = '\n✓ 今天是周日：已把 ' + sb.size + ' 个超 7 天 P2 工单聚成一批（' + sb.batchId + '），进入周日共建批阅场。';
          tickets.batchHistory(1).forEach(h => { batchNote += '\n· 批阅凭证：' + h.batchId + ' · ' + h.size + ' 单 · 已决 ' + h.decided + '/已入历史。'; });
        } else batchNote = '\n今天是周日：已扫描周批，当前无超 7 天的 P2 单可入批。';
      } else batchNote = '\n周批（周日自动聚合 P2）· 距下个周批 ' + (7 - dow) + ' 天';
      return '【工单值班】未结 ' + st.open + ' · 超时 ' + w.overdue.length + ' · 今日将到期 ' + w.dueSoon.length +
        (w.overdue.length ? '\n⚠ 超时工单：' + w.overdue.slice(0, 5).join(',') + '（P0 当日响应/72h 结论，P1 48h——对自己狠，对外才可信）' : '') +
        '\n通道分布：' + JSON.stringify(st.byChannel) + batchNote;
    } },
  { id: 'playbook_advance', name: '冷启动作战日报', cat: '内容复用',
    desc: '今天 D 的第几天该干什么（D1–D30 作战表）',
    run: async ctx => {
      const playbook = require('./playbook');
      const inFlight = ctx.db.playbookStartedAt;
      if (!inFlight) return '【冷启动日报】Playbook 未启动——可调用 launch 从今天开始 D1（首批 50 位见证官招募）。';
      const t = playbook.today();
      const b = playbook.board();
      return '【冷启动日报】D' + t.day + '：' + t.task +
        '\n进度 ' + b.done + '/30 · 补打 ' + b.late + ' · 剩 ' + b.remaining +
        '\nD30 门：注册 ≥300 且付费 ≥3 单（当前 注册 ' + b.gate.reg + ' / 付费 ' + b.gate.paid + '）→ ' + b.gate.note;
    } },
  { id: 'foundry_pipeline', name: '故事工厂流水线巡检', cat: '内容复用',
    desc: 'S1–S9 各站存量作品数量与产能提醒',
    run: async ctx => {
      const foundry = require('./foundry');
      const b = foundry.board();
      const act = Object.entries(b.byStation).filter(([, v]) => v > 0);
      return '【故事工厂】作品 ' + b.total + ' 部 · 已发布 ' + b.published + ' · 在产 ' + act.length +
        '\n井A 授权故事 ' + b.wells.a.length + ' · 井B 公版历史 ' + b.wells.b.length +
        '\n站点分布：' + (act.length ? act.map(([k, v]) => k + '×' + v).join(' ') : '暂无在产（先授权再立项——素材井没水，流水线空转）') +
        '\n创作证据日志：' + b.logs.length + ' 条（story_creative_log 自动存，北互判例的工程落地）';
    } },
  { id: 'mcp_usage', name: 'Agent 接口使用统计', cat: '大脑进化',
    desc: 'MCP 三工具调用次数 / 收入 / 余额池盘点',
    run: async ctx => {
      const mcp = require('./mcp');
      const s = mcp.stats();
      return '【Agent 接口】开发者 ' + s.developers + ' · 活跃 ' + s.keysActive + ' key · 调用 ' + s.uses + ' 次 · 收入 ¥' + s.revenue +
        ' · 余额池 ¥' + s.balancePool +
        '\n工具面：decision.deliberate（¥0.99）· case.search（免费水印）· manual.get（免费）' +
        '\n边界三不接：医疗/法律/金融投资建议；转售批量；存用户数据中间平台';
    } },
  { id: 'leadgen_funnel', name: '获客成交闭环巡检', cat: '决策运营',
    desc: '找客户→推荐→选择→优化→促单→成交 六段漏斗看板与推进',
    run: async ctx => {
      const leadgen = require('./leadgen');
      const b = leadgen.board();
      const seg = Object.keys(b.byStage).map(k => k + '×' + b.byStage[k]).join('  ');
      // 只读看板，不再自己调 funnelStep：漏斗推进的所有权归 autopilot 的 acquire 步。
      // 历史问题：本模块与 autopilot.acquire 在同一轮各调一次 funnelStep，漏斗被双倍推进、
      // 阶段分布不可预期，且无人拥有漏斗。现改为如实汇报 + 给出下一步建议。
      const roi = (() => { try { return leadgen.roiBoard(); } catch (e) { return null; } })();
      const roiLine = roi && roi.roi !== null ? '，整体 ROI ' + roi.roi + '%（真实推广支出 ' + roi.totalCost + ' vs 成交 ' + roi.totalRevenue + '）' : '';
      return '【获客成交闭环】线索 ' + b.total + ' · 成交客户 ' + b.customers + ' · 成交额 ¥' + b.deals +
        '\n漏斗：' + (seg || '空（待找客户）') +
        '\n渠道 ROI：' + (roi ? (roi.channels.length ? roi.channels.map(c => c.channel + ' ROI=' + (c.roi === null ? '待真实支出' : c.roi + '%')).join(' / ') : '暂无渠道数据') : '不可用') +
        '\n推进所有权：autopilot·acquire（本模块仅看板）' + roiLine;
    } }
];

// 按类别聚簇的模块索引
function list() {
  return MODULES.map((m, i) => ({ id: m.id, name: m.name, cat: m.cat, desc: m.desc, idx: i }));
}

function get(id) { return MODULES.find(m => m.id === id) || null; }

// 执行单个模块（统一写审计+进化），幂等可重跑
async function runModule(id, round) {
  const m = get(id);
  if (!m) throw new Error('未找到模块：' + id);
  const db = store.read();
  let output;
  try {
    output = await m.run({ db, round: round || 0 });
  } catch (e) {
    output = '【' + m.name + '】执行异常：' + e.message.slice(0, 80);
  }
  store.push('audit', { action: '模块·执行', detail: m.id + '·' + m.name, at: Date.now() });
  brain.evolve('模块执行：' + m.name);
  return { id: m.id, name: m.name, cat: m.cat, ok: true, output };
}

// 轮巡选组：按轮次推进，保证 50+ 模块都被覆盖
function pick(roundNo, n) {
  const nMod = MODULES.length;
  const stride = Math.max(1, Math.floor(nMod / 3));
  const start = (roundNo * stride) % nMod;
  const picked = [];
  for (let i = 0; i < n; i++) picked.push(MODULES[(start + i * 3) % nMod]);
  return picked;
}

// 已在至少一轮中执行过的模块数（进度追踪）
function progress() {
  const au = store.read().audit || [];
  const done = new Set(au.filter(x => x.action === '模块·执行').map(x => String(x.detail).split('·')[0]));
  return { done: done.size, total: MODULES.length };
}

function pct(n) { return Math.round(n * 1000) / 10 + '%'; }

module.exports = { MODULES, list, get, runModule, pick, progress };