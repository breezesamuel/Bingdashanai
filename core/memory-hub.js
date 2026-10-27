// core/memory-hub.js — 全模块记忆 · 学习 · 进化中枢（第 8 条需求）
//
// 【需求原文】"记忆学习进化中不仅仅是一些skill的进化还应该是全部项目中所有功能模块程序
//             的记忆学习进化的中心，UI界面需要完善和优化"
//
// 【现状与差距】"大脑"页第一屏是个**文件转换器**，而记忆/学习/进化只是散落在页面深处的几个面板。
// 更实质的问题是：系统里确实在到处产生"经验"——
//   evolution 500 条、lessons、intel 40、autopilot 253、conductor 200、agentcenter_log 45、
//   knowledge 8、memory 5、playbook 5、harness（提示词自优化）……
// 但它们**分属不同模块、不同字段、不同口径**。用户打开"记忆·学习·进化"看到的是一堆列表，
// 回答不了两个真正该回答的问题：
//   1. **这个系统整体学到了什么？**（跨模块的沉淀）
//   2. **哪个模块最近变强了、哪个在退步？**（进化的健康度）
//
// 【解法】一个统一中枢，把各模块的学习产出**归一化**成同一种"学习条目"，
// 再从"沉淀量 / 验证率 / 近期活跃度 / 退化告警"四个维度给整体与各模块打分。
//
// 【口径诚实】每条都标注 `verified`（是否经过验证）。未验证的经验照样展示，
// 但明确标为"待验证"——把没验证过的结论当结论用，正是学习系统最常见的自欺。

const store = require('./store');

// 模块 → 其学习产出的来源。**刻意穷举 core 下所有会学习/会沉淀的模块**，
// 因为需求要的是"全部功能模块"，漏一个就等于对这个模块的进化视而不见。
const SOURCES = [
  { mod: 'skills',    label: '技能军械库', fields: ['lessons'],            desc: '技能调用的成败经验' },
  { mod: 'harness',   label: '提示词进化', fields: ['evolution'],          desc: '系统提示词与上下文策略自优化' },
  { mod: 'autopilot', label: '24h 自主运营', fields: ['autopilot'],        desc: '无人值守巡航的轮次结论' },
  { mod: 'conductor', label: '作战指挥塔', fields: ['conductor'],          desc: '每轮指挥的推进结果' },
  { mod: 'agents',    label: 'Agent 管理中心', fields: ['agentcenter_log'], desc: '多 Agent 会诊与分工记录' },
  { mod: 'intel',     label: '情报引擎', fields: ['intel'],               desc: '抓取与研判积累' },
  { mod: 'knowledge', label: '知识库', fields: ['knowledge'],            desc: '人工确认的问答沉淀' },
  { mod: 'brain',     label: '大脑记忆', fields: ['memory'],              desc: '对话与主题结论记忆' },
  { mod: 'playbook',  label: '打法手册', fields: ['playbook'],            desc: '可复用打法沉淀' },
  { mod: 'watchdog',  label: '监控自愈', fields: ['reports'],             desc: '故障与自愈记录' },
  { mod: 'evidence',  label: '证据与 ROI', fields: ['tickets'],           desc: '投入产出的可核查证据' },
  { mod: 'gtm',       label: '获客实战', fields: ['gtmTouches', 'leads'], desc: '真实触达与线索推进' },
  { mod: 'materials', label: '物料采购', fields: ['purchaseIntents'],    desc: '采购意向与到货履约台账' },
  { mod: 'crawler',   label: '网页爬虫→知识', fields: ['crawl'],         desc: '蜘蛛深爬入库与页面完善记录' }
];

function pick(row, mod) {
  // 各模块字段结构不同，统一抽"一句话可读内容"。抽不出就跳过，不硬凑。
  //
  // 【踩坑记录】初版只认 detail/note/summary/content/text 五个键，结果 12 个来源里
  // autopilot / agents / intel / evidence 四个**整模块被丢成 0 条**——因为它们的行结构
  // 根本不叫那几个名字（autopilot 是 report，agents 是 msg，intel 是 q+a，tickets 是 subject）。
  // 页面上显示"覆盖 5 个模块"，实际上另外 7 个模块的学习产出被静默丢弃了。
  // 这类"静默少数据"比报错更难发现，所以下面按模块逐个对上真实字段名。
  switch (mod) {
    case 'knowledge': return row.q ? ('Q: ' + row.q + ' → A: ' + String(row.answer || row.a || '')) : null;
    case 'brain':     return row.key ? ('[' + row.key + '] ' + row.value) : null;
    case 'playbook':  return row.day ? ('打法 ' + row.day + '：' + (row.status || '已记录')) : null;
    case 'gtm':       return row.note ? (row.key || row.channel ? '[' + (row.channel || row.key || '') + '] ' + row.note : String(row.note)) : (row.outcome ? String(row.outcome) : null);
    case 'skills':    return row.detail ? String(row.detail) : (row.text ? String(row.text) : null);
    case 'evidence':  return row.subject ? ('[' + (row.prio || '-') + '] ' + row.subject + '（' + (row.status || '处理中') + '）') : null;
    case 'watchdog':  return row.topic ? (row.kind + '·' + row.topic + '：' + String(row.content || '').slice(0, 160)) : (row.title ? String(row.title) : null);
    case 'autopilot': return row.report ? String(row.report).slice(0, 260)
      : row.done ? ('完成 ' + (Array.isArray(row.done) ? row.done.length : 0) + ' 项') : null;
    case 'agents':    return row.msg ? String(row.msg) : null;
    case 'intel':     return row.q ? (row.q + ' → ' + String(row.a || '')) : null;
    case 'conductor': return row.reason ? ('本轮：' + String(row.reason).slice(0, 200)) : (row.detail ? String(row.detail) : null);
    case 'materials': return row.sku ? (row.status === 'open' ? '采购意向 SKU ' + row.sku + ' x' + (row.qty || row.estQty || '') + '（预计 ¥' + (row.estCost || 0) + '，在途）' : '采购 ' + row.sku + ' x' + (row.qty || row.estQty || '') + ' → ' + (row.status || '')) : (row.note ? String(row.note) : null);
    case 'crawler':   return row.kind ? ('采集·' + row.kind + (row.repo ? ' ' + row.repo : '') + (row.title ? '：' + row.title : '') + (row.reason || row.error ? '（' + String(row.reason || row.error).slice(0, 80) + '）' : '')) : (row.detail ? String(row.detail) : null);
    case 'harness':   // evolution 集合的字段是 note，不是 detail
      return row.note ? String(row.note)
        : row.detail ? String(row.detail)
        : row.what ? String(row.what) : null;
    default:
      return row.detail ? String(row.detail)
        : row.note ? String(row.note)
        : row.summary ? String(row.summary)
        : row.content ? String(row.content)
        : row.text ? String(row.text)
        : row.msg ? String(row.msg)
        : null;
  }
}

function rowAt(row) {
  return row.at || row.createdAt || row.updatedAt || 0;
}

// —— 统计口径：只数，不构造正文 ——
// 【踩坑记录·本模块最严重的一个 bug】原来 entries() 里写的是 arr.slice(0, 200)，
// 意思是"每个字段最多统计 200 条"。看起来像是个性能保护，实际上有两个致命后果：
//   1. **数字是假的**。真实库里 evolution+autopilot+conductor+leads 共 1524 行，
//      中枢对外却声称"学习产出累计 906 条"——少算 618 条（40%）。一个自己报
//      错数的学习看板，比没有看板更糟。
//   2. **截断方向和"最近"相反**。这些数组都是 push 追加的，最新的记录在**尾部**。
//      slice(0,200) 丢掉的是最近 300 条：evolution 全量近 7 天有 385 条，
//      中枢只数得到 85 条；leads 全量近 7 天 383 条，只数得到 121 条。
//      而"近 7 天新增 / 退化告警"正是靠这个数字算的——等于退化告警在看历史。
// 所以统计一律走全量计数（只读 at 字段，不拼正文，很快）；
// 拼正文、给人看的那部分才做 limit，而且要取**最新**的那几条。
function counts() {
  const db = store.read();
  const DAY = 86400000, now = Date.now();
  const byMod = {}, byField = {};
  let totalRows = 0, recent7 = 0, unverifiableRows = 0;
  SOURCES.forEach(s => {
    (s.fields || []).forEach(f => {
      const arr = Array.isArray(db[f]) ? db[f] : [];
      const st = { mod: s.mod, label: s.label, field: f, rows: arr.length, recent7: 0, parsed: 0, unparsed: 0 };
      // 逐行判定能不能解析成一条学习条目——统计的是"有效条目"，不是原始行数
      arr.forEach(row => {
        totalRows++;
        const at = rowAt(row);
        const isRecent = !!at && now - at < 7 * DAY;
        if (isRecent) { recent7++; st.recent7++; }
        if (pick(row, s.mod)) {
          st.parsed++;
          if (isRecent) byMod[s.mod] = true;
        } else {
          // 解析不出来的行：**必须报出来**，不能悄悄消失
          // （当初 12 个来源里有 4 个整模块被丢成 0 条，就是这么发生的）
          st.unparsed++;
          unverifiableRows++;
        }
      });
      byField[s.mod + ':' + f] = st;
    });
  });
  return { totalRows, recent7, unverifiableRows, byField };
}

// 归一化：所有模块的学习产出 → 同一种条目
// 【口径】这里会返回**全量**条目（不再有静默的 slice(0,200)）。
// 展示层要几条就传 opt.limit，且取的是最新的。
function entries(opt) {
  const o = opt || {};
  const db = store.read();
  const out = [];
  SOURCES.forEach(s => {
    (s.fields || []).forEach(f => {
      const arr = Array.isArray(db[f]) ? db[f] : [];
      arr.forEach((row, i) => {
        const body = pick(row, s.mod);
        if (!body) return;
        // 验证状态：只有 lessons 有显式 verified；其余按"是否真的成功"粗判
        let verified = null;
        if (s.mod === 'skills' && row.verified !== undefined) verified = !!row.verified;
        else if (row.ok === true || row.ok === false) verified = !!row.ok;
        else if (s.mod === 'knowledge') verified = true;      // 人工确认的知识视为已验证
        out.push({
          id: s.mod + ':' + f + ':' + (row.id || i),
          mod: s.mod, label: s.label, field: f,
          at: rowAt(row),
          body: String(body).slice(0, 300),
          verified
        });
      });
    });
  });
  out.sort((a, b) => b.at - a.at);
  // 【踩坑记录】原来只有 limit、没有 mod 参数，调用方只能先 limit 再自己 filter，
  // 结果"按模块查看"永远是空的——因为前 N 条早被别的模块占满了。
  // 现在把 mod 收进来，且**必须先筛后截**：筛选条件下不存在"先截断再过滤"这种顺序。
  const filtered = o.mod ? out.filter(x => x.mod === o.mod) : out;
  return o.limit ? filtered.slice(0, o.limit) : filtered;
}

// 整体看板：沉淀量 / 验证率 / 近期活跃 / 退化告警
function dashboard() {
  const list = entries();          // 全量条目（统计口径，不能再截断）
  const C = counts();              // 全量行数口径（只读时间戳，不拼正文）
  const DAY = 86400000, now = Date.now();
  const recent7 = list.filter(x => x.at && now - x.at < 7 * DAY);

  const byMod = {};
  list.forEach(x => {
    const m = byMod[x.mod] || (byMod[x.mod] = { mod: x.mod, label: x.label, total: 0, recent7: 0, verified: 0, verifiable: 0, failed: 0 });
    m.total++;
    if (x.at && now - x.at < 7 * DAY) m.recent7++;
    if (x.verified === true) m.verified++;
    if (x.verified === false) m.failed++;
    if (x.verified !== null) m.verifiable++;
  });
  const mods = Object.values(byMod).map(m => ({
    ...m,
    verifyRate: m.verifiable ? Math.round(m.verified / m.verifiable * 100) : null,
    // 退化信号：条目很多但近 7 天一条没新增 = 学不动了
    stale: m.recent7 === 0 && m.total > 0
  })).sort((a, b) => b.recent7 - a.recent7 || b.total - a.total);

  const verifiable = list.filter(x => x.verified !== null).length;
  const verified = list.filter(x => x.verified === true).length;
  const failed = list.filter(x => x.verified === false).length;

  // 零沉淀模块：**必须显式列出来**。
  // 原来只有"有产出"的模块才进 byMod，于是"技能军械库"这种真·0 产出的模块
  // 在界面上整个消失——用户分不清"这个模块还没学会"和"根本没这个模块"。
  const zeroMods = SOURCES.filter(s => !byMod[s.mod]).map(s => ({
    mod: s.mod, label: s.label, desc: s.desc,
    fields: s.fields,
    rows: (s.fields || []).reduce((a, f) => a + (((C.byField[s.mod + ':' + f] || {}).rows) || 0), 0)
  }));

  // 解析不出来的行也要报出来。这些是"库里存了但中枢读不懂"的数据，
  // 属于第 18 条的盲区——静默丢弃会让覆盖看起来比实际完整。
  const unparsedFields = Object.values(C.byField).filter(x => x.unparsed > 0)
    .map(x => ({ mod: x.mod, label: x.label, field: x.field, unparsed: x.unparsed, rows: x.rows }))
    .sort((a, b) => b.unparsed - a.unparsed);

  return {
    totals: {
      entries: list.length,
      rows: C.totalRows,
      recent7: recent7.length,
      modules: mods.length,
      sources: SOURCES.length,
      verifyRate: verifiable ? Math.round(verified / verifiable * 100) : null,
      verified, verifiable, failed,
      pending: verifiable - verified,
      // 库里有、但中枢解析不出来 → 如实报数，不静默丢
      unparsed: C.unverifiableRows
    },
    // 退化告警：这里是真的"提醒人去看"，不是装饰
    alerts: mods.filter(m => m.stale).map(m => ({ mod: m.mod, label: m.label, msg: '近 7 天无新增学习产出（累计 ' + m.total + ' 条），该模块可能已停止进化' })),
    modules: mods,
    zeroModules: zeroMods,
    unparsedFields,
    latest: list.slice(0, 20)
  };
}

// 供对话调用（第 2 条能力表会用到）：系统整体学到了什么
function summary() {
  const d = dashboard();
  return '全模块学习产出累计 ' + d.totals.entries + ' 条（库中共 ' + d.totals.rows + ' 行），覆盖 '
    + d.totals.modules + '/' + d.totals.sources + ' 个模块，近 7 天新增 ' + d.totals.recent7 + ' 条'
    + (d.totals.verifyRate !== null ? '\n已验证 ' + d.totals.verified + '/' + d.totals.verifiable + '（验证率 ' + d.totals.verifyRate + '%）' : '')
    + (d.totals.unparsed ? '\n注意：另有 ' + d.totals.unparsed + ' 行数据中枢读不懂（未被计入）' : '')
    + '\n各模块沉淀量：' + d.modules.map(m => m.label + ' ' + m.total).join(' · ')
    + (d.zeroModules.length ? '\n尚无沉淀：' + d.zeroModules.map(m => m.label).join('、') : '')
    + (d.alerts.length ? '\n⚠ 退化告警：' + d.alerts.map(a => a.label).join('、') : '');
}

module.exports = { SOURCES, entries, dashboard, summary, counts, rowAt };