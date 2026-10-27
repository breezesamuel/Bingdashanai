// core/autopilot.js — 24 小时全托管自主运营引擎
// 无论何时，系统都在做：采集外部情报 → 学习沉淀 → 记忆归档 → 进化日志 → 优化策略
// 真实能力：新闻摘录转知识、自检水位盘点、决策框架轮巡、优化建议、生成每日自运营报告
// 不依赖任何模型密钥；每轮产出的内容全部落库可审计。

const store = require('./store');
const brain = require('./brain');
const skills = require('./skills');
const decision = require('./decision');
const providers = require('./providers');
const intel = require('./intel');
const opmods = require('./opmods');

const RUN_IDLE = 900;        // 默认节奏基准：15 分钟（实际生效值由 devcap 按设备能力推导，见 autoIntervalSec）
const MIN_INTERVAL = 60;    // 节奏下限：60s，防止误设成高频把外部源打爆
const MAX_INTERVAL = 86400; // 节奏上限：24h
// 启动后延后再跑首轮：单轮要 10–30s 同步 I/O，立刻跑会卡住 Electron 主进程
const FIRST_RUN_DELAY_MS = 12000;
// 单轮最多执行几个步骤。必须 >= STEP_DEFS 中非 optimize 的步数，
// 否则末尾步骤（获客/记忆/员工）会被永久饿死 —— 这正是原来 acquire 只跑 1 次的原因。
// 实际每轮步数由 devcap.maxStepsPerRound 按设备能力下调（弱机少做几步 = 少堵事件循环）。
let MAX_TICK = 6;
const MAX_LOG = 400;         // 运营日志上限
let STEP_TIMEOUT = 45000;  // 单步超时：外部源不可达时不让一步拖死整轮（弱机由 devcap 下调）
// 整轮兜底护栏。必须大于「步数上限 x 单步超时」的最坏耗时，
// 否则护栏会在轮次跑到一半时复位 running（步骤仍在飞），状态机被写坏、
// 甚至让两轮并发跑。原来固定 120s 而最坏耗时 6x45s=270s，是隐藏的定时炸弹。
let ROUND_TIMEOUT = MAX_TICK * STEP_TIMEOUT + 30000;
const MAX_CONSEC_FAILS = 3;  // 连续失败达到该值自动熔断暂停（无人值守自保）

// 设备能力（第 7 项）：启动时扫描软硬件，据此推导节奏/步数/超时——弱机降速而非卡死。
let DEV = null;
function devcap() {
  if (DEV) return DEV;
  try { DEV = require('./devcap').plan(); } catch (e) { DEV = null; }
  return DEV;
}
function autoIntervalSec() { const d = devcap(); return d ? d.autopilotIntervalSec : RUN_IDLE; }
function applyDevcap() {
  const d = devcap(); if (!d) return;
  MAX_TICK = Math.max(4, d.maxStepsPerRound);   // 至少保底 4 步（collect/evolve/acquire/memory）
  STEP_TIMEOUT = d.stepTimeoutMs;
  ROUND_TIMEOUT = MAX_TICK * STEP_TIMEOUT + 30000;
}

// 状态机
let running = false;
let lastRound = null;
let roundNo = 0;
let consecFails = 0;        // 连续失败轮数（成功即清零）
let lastError = '';         // 最近一次轮次级错误摘要
let backoff = 1;            // 退避倍数（1=正常，4=降级慢试）；不持久化，重启从正常节奏重来
let nextAt = 0;             // 下轮预计触发时刻（0=已暂停/未排程）
let timer = null;           // 可重排的后台定时器（替代固定 setInterval）

// ---- 托管配置：启停 + 节奏（持久化到 settings.autopilot，跨重启生效）----
function cfg() {
  const s = store.getSetting('autopilot') || {};
  let sec = Number(s.intervalSec);
  // 未显式设置时用设备能力推导的节奏（弱机自动 1h 一轮，而不是硬跑 15min）
  if (!isFinite(sec) || sec <= 0) sec = autoIntervalSec();
  sec = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(sec)));
  return { enabled: s.enabled !== false, intervalSec: sec };
}
function saveCfg(patch) {
  const cur = cfg();
  const next = { enabled: patch.enabled !== undefined ? !!patch.enabled : cur.enabled, intervalSec: patch.intervalSec !== undefined ? patch.intervalSec : cur.intervalSec };
  next.intervalSec = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(Number(next.intervalSec) || RUN_IDLE)));
  store.setSetting('autopilot', next);
  return next;
}

function lastStoredNo() {
  try {
    const db = store.read();
    // 取全库最大 no（历史有过重启归零，顶部≠最大；用最大值防止轮次号重复）
    const max = (db.autopilot || []).reduce((m, x) => Math.max(m, Number(x.no) || 0), 0);
    return max;
  } catch (e) { return 0; }
}

// 排下一轮：先排后跑，避免一轮耗时把节奏整体后移
function schedule() {
  if (timer) { clearTimeout(timer); timer = null; }
  const c = cfg();
  if (!c.enabled) { nextAt = 0; return; }
  const sec = Math.min(MAX_INTERVAL, c.intervalSec * backoff);
  nextAt = Date.now() + sec * 1000;
  timer = setTimeout(() => {
    timer = null;
    runOnce().catch(() => {}).then(schedule);
  }, sec * 1000);
  if (timer && timer.unref) timer.unref();
}

function boot() {
  roundNo = lastStoredNo(); // 跨重启续编号：轮次号不归零
  applyDevcap();            // 设备能力扫描 → 调整每轮步数/单步超时（第 7 项）
  const c = cfg();
  // 启动即跑一轮（暂停状态下不自动跑，交由人工/接口触发），然后进入后台循环。
  // 首轮刻意延后 FIRST_RUN_DELAY_MS：单轮要 10–30s（大量同步读写 1.4MB db.json +
  // 外部网络请求），若在服务刚起就同步跑，Electron 主进程事件循环会被占住数秒，
  // 表现为「打开 exe 电脑卡死、窗口无响应」。延后启动让首屏先可用。
  if (c.enabled) {
    const t = setTimeout(() => {
      runOnce().catch(() => {}).then(schedule);
    }, FIRST_RUN_DELAY_MS);
    if (t.unref) t.unref();
  } else schedule();
}

// ---- 启停与节奏（对外运维接口）----
function pause(reason) {
  const c = saveCfg({ enabled: false });
  if (timer) { clearTimeout(timer); timer = null; }
  try {
    store.push('audit', { ev: 'autopilot-pause', at: Date.now() }, '暂停自主运营',
      (reason || '人工暂停') + ' · 节奏 ' + c.intervalSec + 's');
  } catch (e) {}
  return { ok: true, enabled: false, reason: reason || '人工暂停' };
}
function resume() {
  const c = saveCfg({ enabled: true });
  consecFails = 0; lastError = '';
  schedule();
  try {
    store.push('audit', { ev: 'autopilot-resume', at: Date.now() }, '恢复自主运营', '节奏 ' + c.intervalSec + 's');
  } catch (e) {}
  return { ok: true, enabled: true, intervalSec: c.intervalSec };
}
function setIntervalSec(sec) {
  const n = Number(sec);
  if (!isFinite(n) || n <= 0) return { ok: false, error: '节奏必须是正数秒' };
  const c = saveCfg({ intervalSec: n });
  schedule(); // 立即按新节奏重排
  try {
    store.push('audit', { ev: 'autopilot-interval', at: Date.now() }, '调整自主运营节奏', c.intervalSec + 's');
  } catch (e) {}
  return { ok: true, intervalSec: c.intervalSec, min: MIN_INTERVAL, max: MAX_INTERVAL };
}

// 自检：系统运行水位
function health(pl) {
  const db = store.read();
  const hasKey = pl.filter(p => p.hasKey);
  const learn = brain.learnStats();
  const okRate = learn.length ? Math.round(learn.reduce((s, x) => s + x.rate, 0) / learn.length) : 0;
  // 链路诚实度：最近一轮采集是否处于离线兜底。断网时不能还报「一切正常」。
  const last = (db.autopilot || [])[0] || {};
  const lastCollect = (last.steps || []).find(s => s.id === 'collect') || {};
  const offline = !!lastCollect.offline;
  return {
    链路: offline ? '离线兜底（外部源不可达，用缓存）' : '在线',
    通道: (hasKey.length ? hasKey.length + '/' : '') + pl.length + (hasKey.length ? ' 已配' : ' 全待配'),
    决策: (db.decisions || []).length, 员工: (db.staff || []).length,
    项目: (db.projects || []).length, 任务: (db.tasks || []).length,
    记忆: (db.memory || []).length, 知识: (db.knowledge || []).length,
    进化: (db.evolution || []).length, 成功: okRate + '%'
  };
}

// 自动采集：外部情报（真实抓取，失败静默降级）
// 情报沉淀到独立的 intel 采集库（封顶 40 条），不污染精选知识库 knowledge。
// 入库去重：同 q 且同摘要内容不再重复进库，避免多轮采集把同一热点刷满整个库。
const INTEL_MAX = 40;
function intelStore(q, a) {
  const db = store.read();
  if (!Array.isArray(db.intel)) db.intel = [];
  const body = String(a || '');
  const dup = db.intel.some(x => x.q === String(q) && String(x.a || '') === body);
  if (dup) return { dedup: true };
  db.intel.push({ q: String(q).slice(0, 30), a: body.slice(0, 160), tag: 'intel', createdAt: Date.now() });
  if (db.intel.length > INTEL_MAX) db.intel = db.intel.slice(-INTEL_MAX);
  store.write(db);
  return { dedup: false };
}
// 断网兜底：外部源全不可达时，用已入库的真实情报继续产出，而不是干等。
//
// 纪律（与 D14 同一套口径）：
//   1) 只读 db.intel 里**已经存过**的条目，绝不生成/推测/补全任何「热点」；
//   2) 每条都带真实时��，让下游知道这是缓存不是新鲜情报；
//   3) 返回真实年龄，超过 CACHE_MAX_AGE_H 明确说「已过期，仅供参考」；
//   4) 缓存为空就如实说没有 —— 不拿旧数据假装有新料。
const CACHE_MAX_AGE_H = 48;
function offlineFallback(reason) {
  const out = [];
  const db = store.read();
  const now = Date.now();
  const rows = (db.intel || [])
    .map(x => ({ q: String(x.q || ''), a: String(x.a || ''), at: Number(x.createdAt || x.at || 0) }))
    .filter(x => x.at > 0 && x.q)
    .sort((a, b) => b.at - a.at);
  if (!rows.length) {
    out.push('离线兜底：' + reason + '，且情报库为空，本轮无缓存可复用（不编造）');
    return { out, produced: false, cached: 0, freshestAgeH: null };
  }
  const ageH = (now - rows[0].at) / 3600000;
  const usable = rows.filter(x => (now - x.at) / 3600000 <= CACHE_MAX_AGE_H);
  out.push('离线兜底：' + reason + ' → 复用情报库缓存 ' + usable.length + '/' + rows.length +
    ' 条（限 ' + CACHE_MAX_AGE_H + 'h 内），最新一条 ' + ageH.toFixed(1) + ' 小时前');
  usable.slice(0, 3).forEach(x => {
    const h = ((now - x.at) / 3600000).toFixed(1);
    out.push('  · [' + h + 'h 前·缓存] ' + x.q.slice(0, 60));
  });
  if (!usable.length) {
    out.push('  缓存均已超过 ' + CACHE_MAX_AGE_H + 'h，仅列时间线供参考，不作决策依据');
  }
  return { out, produced: usable.length > 0, cached: usable.length, freshestAgeH: ageH };
}

async function collect() {
  const out = [];
  // 真实成功计数：原来三个源各自吞掉异常、从不抛出，导致 collectStep.ok 恒为 true，
  // onRoundOutcome 的降级/退避/熔断永远不会触发 —— 断网时系统照样报「成功」。
  // 这里显式计数，全失败才交给兜底或如实报错。
  let live = 0;
  let failReason = '';
  // 1) 全网热点（GitHub 趋势 + HN + 科技日报，真实抓取）→ intel 采集库
  try {
    const h = await intel.headlines();
    const items = h.items || [];
    if (items.length) {
      const sample = items.slice(0, 4).map(x => '[' + x.src + '] ' + x.title).join(' | ');
      intelStore('自动采集：全网热点', sample.slice(0, 200));
      out.push('采集全网热点 ' + items.length + ' 条，入情报采集库');
      live++;
    } else { failReason = failReason || '热点源无内容'; }
  } catch (e) { failReason = failReason || ('热点源不可达(' + (e && e.message ? e.message : '未知') + ')'); out.push('热点源暂不可达，自动跳过'); }
  // 2) 新闻（tech 源）→ intel 采集库（静默直调 skilllib，不写审计/进化——引擎内嵌采集非用户操作）
  try {
    const skilllib = require('./skilllib');
    const news = await skilllib.invokeSkill('news', { q: 'tech' }).then(r => r.output || String(r));
    const cut = String(news).split('\n').slice(0, 4).join(' ');
    const kws = cut.split(/\s{2,}/).slice(0, 3);
    if (kws.length) {
      intelStore('自动采集：行业动态', cut.slice(0, 120));
      out.push('采集新闻 1 条入情报采集库');
      live++;
    } else { failReason = failReason || '新闻源无内容'; }
  } catch (e) { failReason = failReason || '新闻源不可达'; out.push('新闻源暂不可达，自动跳过'); }
  try {
    const skilllib = require('./skilllib');
    const w = await skilllib.invokeSkill('weather', { q: '北京' }).then(r => r.output || String(r));
    brain.remember('气象快照', '自动气象观测：' + String(w).split('\n')[0].slice(0, 40), true); // 滚动单条
    out.push('采集今日气象并写入记忆');
    live++;
  } catch (e) { failReason = failReason || '气象源不可达'; out.push('气象源暂不可达'); }

  // 全线不可达 → 兜底产出（真实缓存），并如实标记本轮为离线
  if (live === 0) {
    const fb = offlineFallback(failReason || '外部源全部不可达');
    out.push.apply(out, fb.out);
    if (fb.produced) return { __offline: true, out: out };  // 有缓存可复用：降级但有产出
    throw new Error('外部源全不可达且情报库无可用缓存（' + (failReason || '未知') + '）');
  }
  if (live < 3) out.push('部分源可达：' + live + '/3，采集降级但仍有实时数据');
  return out;
}

// 技能自我进化：定期全网发现高价值开源模块并收录（真实 GitHub 检索 + 入库）
async function evolveSkills() {
  const out = [];
  const QUERIES = ['agent skill', 'mcp server', 'awesome llm', 'ai assistant'];
  try {
    const q = QUERIES[Math.floor(Math.random() * QUERIES.length)];
    const s = await intel.gitSearch(q, { per: 5 });
    if (!s.reach) return ['技能自我进化：GitHub 暂不可达'];
    const picked = s.items.filter(x => x.stars >= 1000).slice(0, 2);
    let added = 0;
    for (const it of picked) {
      const r = skills.addExternal({ name: it.name, cat: 'agents', src: it.repo, confidence: 'unverified', note: '自主运营发现 · ★' + it.stars });
      if (r.added) added++;
    }
    out.push('技能自我进化：GitHub 全网检索「' + q + '」，收录 ' + added + ' 个高价值模块');
    brain.evolve('技能自我进化：检索「' + q + '」发现 ' + s.total + ' 项，收录 ' + added);
  } catch (e) { out.push('技能自我进化失败：' + e.message.slice(0, 60)); }
  return out;
}

// 自动优化：基于学习数据给出可执行优化建议
async function optimize() {
  const pl = providers.list();
  const learn = brain.learnStats();
  const db = store.read();
  const advises = [];
  const best = learn.slice().sort((a, b) => b.rate - a.rate)[0];
  const hasNoLearn = learn.length === 0;
  if (hasNoLearn) advises.push('尚无调用样本：先完成 1 次对话/会诊以建立学习曲线');
  else if (best && best.rate < 60) advises.push('当前首选通道成功率不足，建议更换密钥或补充备用通道');
  const low = learn.filter(x => x.n > 3 && x.rate < 40);
  if (low.length) advises.push('下降通道：' + low.map(x => x.provider).join('/') + '，将被自动降级');
  const tasks = (db.tasks || []).filter(t => !t.done);
  if (tasks.length > 10) advises.push('任务积压 ' + tasks.length + ' 项，建议按艾森豪威尔矩阵分级处理');
  const dec = (db.decisions || []).length;
  if (dec < 20) advises.push('决策样本偏少：可用决策中心框架主动登记 5 条决策');
  // —— 战情室六引擎信号融合（零 LLM，纯规则）——
  try {
    const tickets = require('./tickets');
    const w = tickets.slaWatch();
    if (w.overdue.length) advises.push('工单 SLA 超时 ' + w.overdue.length + ' 单：P0 当日响应/72h 结论、P1 48h——对自己狠，对外才可信，优先清这 ' + w.overdue.length + ' 单');
    const wk = tickets.weekly();
    if (wk.anxietyHits) advises.push('周报焦虑感关键词命中 ' + Object.keys(wk.anxietyHits).length + ' 个词：' + Object.keys(wk.anxietyHits).slice(0, 4).join('/') + '——回复里加一句具体可操作的下一步');
  } catch (e) {}
  try {
    const train = require('./train');
    const tb = train.board();
    const filled = [tb.current.slots.growth, tb.current.slots.retention, tb.current.slots.debt].filter(Boolean).length;
    if (filled < 3 && tb.lotCount > 0) advises.push('本班只装了 ' + filled + '/3 格，但 parking lot 还有 ' + tb.lotCount + ' 条想法——从 lot 提取一条补位，别让它空转（火车不等人）');
    if ((tb.techDebt || []).length >= 3) advises.push('技术欠账 ' + tb.techDebt.length + ' 项积压（还债件每班必还一格）：本班 or 下班优先清 ' + tb.techDebt[0]);
  } catch (e) {}
  try {
    const playbook = require('./playbook');
    const pb = playbook.board();
    if (pb.current && pb.current.day !== '—') {
      const done = (pb.phase || []).reduce((a, r) => a + r.done, 0);
      const total = (pb.phase || []).reduce((a, r) => a + r.total, 0);
      if (total && done / total < 0.5) advises.push('冷启动 Playbook 完成度 ' + Math.round(done / total * 100) + '%（' + pb.current.day + '）：E2 节奏偏慢，今天把该天的事做完再睡');
      if (pb.gate && pb.gate.reg < 300) advises.push('D30 门差口：注册 ' + pb.gate.reg + '/300——渠道选窄一点（站内+一个社群），别撒网');
    }
  } catch (e) {}
  try {
    const mcp = require('./mcp');
    const ms = mcp.stats();
    if (ms.balancePool < 20 && ms.developers > 0) advises.push('MCP 预付池余额 ¥' + ms.balancePool + ' 低于 ¥20 底限：完整盘会拒接，主动充值或只放免费引流档');
    if (ms.developers > 0 && ms.uses === 0) advises.push('MCP 已签 ' + ms.developers + ' 个 key 但零调用：补一个 case.search 示例文档给接入方');
  } catch (e) {}
  // —— 新链路信号接入：蜘蛛入料 / 真实触达 / 履约盯盘（查缺补漏：此前裸铺不管收尾）——
  try {
    const cr = require('./crawler');
    const cs = cr.status();
    const st = (cs && cs.stats) || {};
    const crawled = (db.knowledge || []).filter(k => k.tag === 'crawl').length;
    if (st.searched > 0 && crawled === 0) advises.push('蜘蛛已搜 GitHub ' + st.searched + ' 项但知识库尚无网页深爬入站：检查网络/FIRECRAWL key（无 key 用本地抓取，正文过短会如实跳档），让"网页爬虫→网站内容"闭环转起来');
    if (cs && !cs.on && (db.leads || []).filter(l => l.stage === '探测').length === 0) advises.push('蜘蛛开关未开（crawlerOn=false）且无探测线索：找客户回合为空转，建议开启。');
  } catch (e) {}
  try {
    const ob = require('./outreach');
    const os = ob.status && ob.status();
    if (os && !os.enabled && (db.leads || []).filter(l => l.touch > 0).length > 0) advises.push('已积累 ' + (db.leads || []).filter(l => l.touch > 0).length + ' 个有触达线索但 real 外发未开：配置 webhook/SMTP 并设 outreachEnabled=true 才能把这些线索真正推向成交（早开一天早一天回本）');
  } catch (e) {}
  try {
    const fm = require('./fulfillment');
    const fl = await fm.automate();
    if (fl && fl.overdue > 0) advises.push('履约盯盘 ' + fl.overdue + ' 单需人工/网关推进（' + fl.lines.slice(0, 2).join('；') + '）：成交不闭环就没有真营收，先清这 ' + fl.overdue + ' 单');
    if (fl && fl.autoAdvanced > 0) advises.push('履约已自动打标 ' + fl.autoAdvanced + ' 单（超期催发/待核实签收），请人工核对物流真实状态后确认');
    if (fl && fl.logisticsChecked > 0) advises.push('物流自动跟踪查询 ' + fl.logisticsChecked + ' 单，自动签收 ' + fl.logisticsSigned + ' 单' + (fl.logisticsErrors && fl.logisticsErrors.length ? '；' + fl.logisticsErrors.length + ' 单查询失败待人工核实' : ''));
    if (fl && fl.needKey) advises.push('物流自动跟踪未启用：' + fl.needKey);
  } catch (e) {}
  // —— 物料/MRP 补货信号：有订单在途需求或库存低于水位时，给可执行采购建议 ——
  try {
    const mat = require('./materials');
    const mp = mat.plan && mat.plan();
    if (mp && mp.low && mp.low.length && Number(mp.suggestedPurchaseQty) > 0) {
      const top = mp.low.slice(0, 3).map(r => 'SKU ' + r.sku + ' 现存 ' + r.onHand + ' ≤ 安全 ' + r.reorderPoint + '（需求 ' + r.reservedDemand + '，建议补 ' + r.suggestQty + ' ' + r.unit + '）').join('；');
      advises.push('物料告急 ' + mp.low.length + ' 项（' + top + (mp.low.length > 3 ? '…' : '') + '）：建议采购 ' + mp.suggestedPurchaseQty + ' 件，预算约 ¥' + mp.suggestedPurchaseCost.toFixed(2) + '（真实采购经人工确认后才记账）');
      // 该补但没人登记采购意向的 SKU：物料告急只给出建议量，不建意向。
      // 若建议量的 SKU 无一笔 open intent 覆盖（plan 已净扣过），就说明闭环停在"意向登记"这一步。
      const openSkus = new Set((mp.openIntents || []).map(i => i.sku));
      const orphans = mp.low.filter(r => !openSkus.has(r.sku));
      if (orphans.length) {
        const want = orphans.slice(0, 3).map(r => 'SKU ' + r.sku + ' 应补 ' + r.suggestQty).join('、');
        advises.push('该补未登记：' + orphans.length + ' 个 SKU 建议采购但无在途采购意向（' + want + (orphans.length > 3 ? '…' : '') + '）——先 /v1/materials/intent 登记，指挥塔才会滚动跟进到货');
      }
    }
  } catch (e) {}
  // —— 欠料警铃：已收款订单在交付时欠料，落过 materialShortages 的 → 如实摆出（交不出货是最高优先级）。
  //      只报"未消警"的铃：采购到货后存量覆盖欠量的铃已 resolvedAt，不再高挂（否则补完货还天天报警）。
  try {
    const dbS = store.read();
    const bell = (dbS.materialShortages || []).filter(s => s && s.orderNo && !s.resolvedAt).slice(-5);
    if (bell.length) {
      const skuS = bell.slice(0, 3).map(s => 'SKU ' + s.sku + '（' + String(s.note || '').replace(/.*：/, '').slice(0, 40) + '）').join('；');
      advises.push('欠料警铃 ' + bell.length + ' 项：已收款订单交付时欠料（' + skuS + (bell.length > 3 ? '…' : '') + '）——采购入库优先，欠料不补齐就交不了货');
    }
  } catch (e) {}
  // —— 采购意向·在途告警：有 open 意向但同一 SKU 的建议采购已净扣 = 意向在路上，
  //      核对能否用真实预算确认到货；预算不足 → 如实提示先补预算，不替人工"批准"—— ——
  try {
    const mat = require('./materials');
    const st = mat.status && mat.status();
    const openIntents = st && st.openIntents && st.openIntents.filter(i => i && i.status === 'open');
    if (openIntents && openIntents.length) {
      const money = require('./money');
      const b = money.budget();
      const total = openIntents.reduce((a, i) => a + (Number(i.estCost) || 0), 0);
      const lacks = total > b.avail;
      const skus = openIntents.slice(0, 3).map(i => 'SKU ' + i.sku + ' x' + i.qty + '（¥' + (Number(i.estCost) || 0).toFixed(2) + '）').join('；') + (openIntents.length > 3 ? '…' : '');
      if (lacks) advises.push('在途采购意向 ' + openIntents.length + ' 笔待确认到货（' + skus + '）：需预算 ¥' + total.toFixed(2) + '，目前可用 ¥' + b.avail.toFixed(2) + '，缺口如实摆出——穷不装富，先补推广预算或人工确认再说');
      else if (openIntents.length > 0) advises.push('在途采购意向 ' + openIntents.length + ' 笔（' + skus + '）：可用预算覆盖（¥' + b.avail.toFixed(2) + '），可人工确认真实采购到货');
    }
  } catch (e) {}
  // —— 支付网关配置信号：履约订单可被网关回调自动确认收款，但未配支付宝公钥 → 如实提示 ——
  try {
    const pay = require('./pay');
    const pc = pay.channelStatus ? pay.channelStatus() : null;
    if (pc && !pc.alipayReady && (db.fulfillment || []).some(o => o.status === 'open' && (o.channel === '支付宝' || o.channel === '在线'))) {
      // 如实归因：网关不可用的真实原因可能是远端拒签 / 缺 APP_ID / 缺公钥，
      // 一律甩锅给 ALIPAY_PUBLIC_KEY 会让运营照着"补公钥"修不好，白折腾。
      const why = (pc.alipay && pc.alipay.reason) || pc.reason || '未配置支付宝网关';
      advises.push('有订单标记支付宝/在线通道但支付宝网关不可用（' + why + '）：无法自动确认收款，需人工/网关推进');
    }
  } catch (e) {}
  // —— 成交价反哺定价：已完结订单的毛利/成交价反哺材料定价策略 ——
  try {
    const fulfilled = (db.fulfillment || []).filter(o => o.stage === '已完成' && o.materialCost > 0 && o.amount > 0);
    if (fulfilled.length >= 3) {
      const margins = fulfilled.map(o => ((o.amount - o.materialCost) / o.amount * 100).toFixed(1));
      const avgMargin = (margins.reduce((a,b)=>a+Number(b),0)/margins.length).toFixed(1);
      const avgDeal = (fulfilled.reduce((a,o)=>a+o.amount,0)/fulfilled.length).toFixed(0);
      if (avgMargin < 30) {
        advises.push('近 ' + fulfilled.length + ' 单平均毛利 ' + avgMargin + '% 低于 30% 基线：成交均价 ¥' + avgDeal + ' → 建议上调材料定价或压缩采购成本');
      } else if (avgMargin > 60) {
        advises.push('近 ' + fulfilled.length + ' 单平均毛利 ' + avgMargin + '% 高于 60%：成交均价 ¥' + avgDeal + ' → 可考虑降价抢占份额或加大推广投放');
      }
      // 线索质量评分反哺：高毛利渠道的线索来源打高分
      const srcMargin = {};
      fulfilled.forEach(o => {
        const lead = (db.leads || []).find(l => l.id === o.leadId);
        if (lead && lead.source) {
          const m = (o.amount - o.materialCost) / o.amount * 100;
          srcMargin[lead.source] = (srcMargin[lead.source] || []).concat(m);
        }
      });
      const bestSrc = Object.entries(srcMargin).map(([src, arr]) => ({src, avg: (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1)})).sort((a,b)=>b.avg-a.avg)[0];
      if (bestSrc && bestSrc.avg > 40) {
        advises.push('高毛利来源「' + bestSrc.src + '」均毛利 ' + bestSrc.avg + '% → 线索质量评分上调，获客预算向该渠道倾斜');
      }
    }
  } catch (e) {}
  return advises.length ? advises : ['各项指标稳定，维持当前策略'];
}

// ---- 3 功能模块轮巡（真实模块，按轮次滚动执行）----
function moduleSweep(no) {
  const picked = opmods.pick(no || 0, 2);
  const lines = [];
  return (async () => {
    for (const m of picked) {
      try {
        const r = await opmods.runModule(m.id, no || 0);
        if (r.output) lines.push(r.output.split('\n')[0].slice(0, 46));
      } catch (e) { lines.push('模块「' + m.name + '」异常，已跳过'); }
    }
    return lines.length ? ['模块轮巡：' + lines.join(' ｜ ')] : [];
  })();
}

// ---- 4 自动记忆：系统水位快照（滚动单条，不无限堆叠）----
function memorySnap(pl) {
  const h = health(pl);
  const line = '系统水位 ' + JSON.stringify(h);
  brain.remember('水位快照', line, true); // replace=true 只保留最新水位
  return ['记忆归档：' + line.slice(0, 50)];
}

// ---- 5 员工技能实时刷新（每 2 轮一次：全网热词同步到在岗员工）----
async function staffRefresh(no) {
  if ((no || 0) % 2 !== 0) return [];
  const db = store.read();
  const staffList = (db.staff || []).filter(s => s.status !== 'off');
  if (!staffList.length) return [];
  const s = await intel.gitSearch('LLM agent MCP RAG AI', { per: 5 });
  if (!(s.reach && s.items && s.items.length)) return [];
  const hotSkills = s.items.slice(0, 4).map(x => x.name || x.repo.split('/').pop());
  let updated = 0;
  staffList.forEach(st => {
    const add = hotSkills[updated % hotSkills.length];
    if (!st.skills) st.skills = [];
    if (!st.skills.includes(add)) { st.skills.push(add); st.skills = st.skills.slice(-12); updated++; }
  });
  store.write(db);
  brain.evolve('员工技能实时刷新：' + updated + ' 人同步全网热词');
  return ['员工技能实时进化：' + updated + ' 名在岗员工同步最新技能'];
}

// ---- 分步注册表：整轮与单步共用同一份定义，避免两处逻辑漂移 ----
// 【Reflection loop 第 4 项】生成自然语言反思摘要，写入 lessons 经验库，实现跨轮记忆
async function harnessTune() {
  let H, reflectionHelper;
  try { H = require('./harness'); } catch (e) { return ['harness 不可用：' + (e.message || e)]; }
  try { reflectionHelper = require('./harness-reflection'); } catch (e) {}
  const r = await H.runOnce();
  if (reflectionHelper && reflectionHelper.generateReflectionAndPersist) {
    await reflectionHelper.generateReflectionAndPersist(r);  // await async LLM enhancement
  }
  if (r.ok) {
    return ['harness 自我优化：采纳 ' + (r.adopted ? '1' : '0') + ' 项，评分 ' +
      (r.baseScore !== undefined ? r.baseScore + '→' + r.candScore : '（见日志）')];
  }
  if (r.rejected) return ['harness 候选被 critic 驳回：' + String(r.reason || '').slice(0, 80)];
  // skipped 是常态：如实说明缺什么，而不是伪装成"已优化"
  return ['harness 未优化（' + String(r.reason || r.result || '未知') + '）'];
}

const STEP_DEFS = [
  { id: 'collect', label: '情报采集', run: () => collect() },
  { id: 'evolve', label: '技能自我进化', run: () => evolveSkills() },
  // 【新增】回答质量自我优化：放在 evolve 之后 —— 技能库先更新，
  // 紧接着用真实问答样本评测并让 critic 筛一轮配置改动
  { id: 'harness', label: '回答质量自优化', run: () => harnessTune() },
  { id: 'modules', label: '功能模块轮巡', run: ctx => moduleSweep(ctx.no) },
  { id: 'acquire', label: '获客铺市场', run: () => acquire() },
  { id: 'memory', label: '记忆归档', run: ctx => memorySnap(ctx.pl) },
  { id: 'staff', label: '员工技能刷新', run: ctx => staffRefresh(ctx.no) },
  { id: 'optimize', label: '优化建议', run: () => optimize() }
];
function stepDef(id) { return STEP_DEFS.find(s => s.id === id) || null; }

// 单步执行包装：独立计时 + 超时熔断 + 错误捕获（失败不让整轮崩）
function runStepDef(def, ctx) {
  const t0 = Date.now();
  let timer2 = null;
  const timeout = new Promise((_, rej) => {
    timer2 = setTimeout(() => rej(new Error('步骤超时 ' + Math.round(STEP_TIMEOUT / 1000) + 's')), STEP_TIMEOUT);
    if (timer2.unref) timer2.unref();
  });
  return Promise.race([Promise.resolve().then(() => def.run(ctx)), timeout])
    // 步骤可返回 { __offline:true, out:[...] } 声明「降级但仍在产出」。
    // 这类不算失败（否则熔断会把自己关掉），但必须标 offline 让 health/status 诚实显示，
    // 不能 ok 就了事 —— 断网时假装正常，和 D14 那种台账高报是一类自欺。
    .then(out => (out && out.__offline)
      ? { id: def.id, label: def.label, ok: true, offline: true, ms: Date.now() - t0, out: (out.out || []), err: '' }
      : { id: def.id, label: def.label, ok: true, ms: Date.now() - t0, out: out || [], err: '' })
    .catch(e => ({ id: def.id, label: def.label, ok: false, ms: Date.now() - t0, out: [], err: String((e && e.message) || e).slice(0, 120) }))
    .finally(() => { if (timer2) clearTimeout(timer2); });
}

// 单步执行（运维/排障）：只跑指定一步，不落轮次、不改熔断计数
async function runStep(id) {
  const def = stepDef(id);
  if (!def) return { ok: false, error: '未知步骤：' + id, steps: STEP_DEFS.map(s => ({ id: s.id, label: s.label })) };
  let pl = [];
  try { pl = providers.list(); } catch (e) {}
  const r = await runStepDef(def, { no: roundNo, pl });
  return { ok: true, step: r, steps: STEP_DEFS.map(s => ({ id: s.id, label: s.label })) };
}

// 一轮全托管：采集 → 学习 → 记忆 → 进化 → 优化 → 报告
// opts.manual=true 时忽略暂停状态（人工/接口触发的“立即跑一轮”必须能跑）
async function runOnce(opts) {
  const manual = !!(opts && opts.manual);
  if (running) return { skipped: true, reason: '上一轮仍在执行' };
  if (!manual && !cfg().enabled) return { skipped: true, reason: '已暂停' };
  running = true;
  const t0 = Date.now();
  const __t0 = performance.now();   // 【2026-09】配合 tasktime 登记真实耗时
  const done = [];
  const steps = [];   // 分步耗时与成败（可观测性的最小单位）
  let failed = 0;
  // 护栏：任一步骤整体超时都强制复位 running，防止后续轮次被永久卡死。
  // 注意：guard 只复位状态机标志，不中断在飞任务本身；在飞任务 finally 也会复位并落审计。
  const guard = setTimeout(() => { if (running) { running = false; try { store.push('audit', { ev: 'autopilot-guard', at: Date.now() }, '自动运营护栏', '单轮超时复位（在飞任务继续自行收尾）'); } catch (e) {} } }, ROUND_TIMEOUT);
  guard.unref();
  try {
    let pl;
    try { pl = providers.list(); } catch (e) { pl = []; }

    // 1 采集 → 2 技能进化 → 3 模块轮巡 → 3b 获客铺市场 → 4 记忆归档 → 5 员工技能刷新
    // 全部走 STEP_DEFS 注册表：单步失败只记不崩，后面的步骤照跑（失败隔离）
    //
    // 预算必须按「已执行步数」计，不能按 done.length（输出行数）。
    // 原实现拿 done.length 比 MAX_TICK，而 done 装的是各步的输出文本：
    // collect 常返回 3-4 行（源不可达+热点），evolve 再加 1 行，
    // 于是 modules 跑完就 >=5 而 break，acquire（获客，唯一能带来客户的步骤）
    // 在 66 轮里只执行过 1 次。日志越啰嗦，赚钱的步骤越没机会跑。
    let ran = 0;
    for (const def of STEP_DEFS) {
      if (def.id === 'optimize') break;      // 优化建议在轮末统一算，不进注册表循环
      if (ran >= MAX_TICK) break;            // 单轮最多执行 MAX_TICK 个步骤（不是输出行）
      const r = await runStepDef(def, { no: roundNo, pl });
      steps.push(r);
      ran++;
      if (!r.ok) { failed++; done.push('⚠ ' + r.label + '失败：' + r.err); continue; }
      done.push.apply(done, r.out);
    }

  // 6 自动优化建议（真实学习曲线驱动）
  const adv = await optimize();

  // 7 生成自运营报告（落库，含 KPI 营收线）
  const h = health(pl);
  const db = store.read();
  const money = require('./money');
  const kpiLine = (function () { try { const k = money.kpi(); return '营收 ¥' + k.revenue.toFixed(0) + ' / 目标 ¥' + (k.target / 10000).toFixed(0) + '万（' + k.pct + '%·' + (k.onTrack ? '达标' : '落后') + '）· 推广池 ¥' + k.promo.avail.toFixed(0) + '，日均需 ' + k.needDaily.toFixed(0) + ' 达 ' + (k.inboundDate || ''); } catch (e) { return '营收 KPI 待记账'; } })();
  const report = [
    '【24h 全托管 · 自运营报告 #' + ((roundNo || 0) + 1) + '】',
    '时间 ' + new Date().toLocaleString() + ' · 运行 ' + Math.round((Date.now() - t0) / 1000) + 's',
    '—— 水位 ——', Object.keys(h).map(k => '  ' + k + '：' + h[k]).join('\n'),
    '—— KPI ——', '  ' + kpiLine,
    '—— 分步耗时 ——', (steps.length ? steps.map(s => '  ' + (s.ok ? '✓' : '✗') + ' ' + s.label + ' ' + s.ms + 'ms' + (s.err ? '（' + s.err + '）' : '')).join('\n') : '  （无）'),
    '—— 本次动作 ——', (done.length ? done.map(x => '  ' + (/^⚠/.test(x) ? '✗' : '✓') + ' ' + x).join('\n') : '  （本轮无外部动作）'),
    '—— 优化建议 ——', (adv.length ? adv.map(x => '  · ' + x).join('\n') : '  · 维持现状')
  ].join('\n');
  // 轮次流水不入进化日志（进化只记关键节点：里程碑/降级/收录/修复）；轮次详情已存 db.autopilot
  const roundNoNow = lastStoredNo() + 1;
  const round = {
    no: roundNoNow, at: Date.now(), ms: Date.now() - t0,
    health: h, done, advises: adv, channels: pl.length, kpi: kpiLine,
    // 摘要保留「分步耗时」段（可观测性红线）：整体截断会把这段切掉，导致报告看不出哪步慢/失败
    report: report.slice(0, 200).replace(/[\s\S]*?(?=—— 分步耗时 ——)/, '') + '\n' + report.slice(report.indexOf('—— 分步耗时 ——')).slice(0, 200),
    capabilities: ['情报采集', '技能自我进化', '功能模块轮巡', '员工技能刷新', '获客铺市场'], wheel: opmods.progress(),
    steps, failed, ok: failed === 0
  };
  // —— 每日漏斗快照写入 ——
  try {
    const lg = require('./leadgen');
    const coord = require('./coordinator');
    const b = lg.board();
    const snap = coord.snapshot();
    const day = new Date().toISOString().slice(0, 10);
    const fsRec = {
      day, at: Date.now(),
      leads: b.total || 0,
      byStage: b.byStage || {},
      channels: b.channels || {},
      deals: b.deals || 0,
      lifecycle: b.lifecycle || {},
      alerts: snap.alerts?.length || 0,
      priority: snap.priority || [],
      kpi: snap.kpi || {}
    };
    if (!db.funnelSnapshots) db.funnelSnapshots = [];
    const existing = db.funnelSnapshots.find(x => x.day === day);
    if (existing) Object.assign(existing, fsRec);
    else db.funnelSnapshots.unshift(fsRec);
    if (db.funnelSnapshots.length > 365) db.funnelSnapshots.length = 365;
  } catch (e) { /* 快照失败不阻断主流程 */ }

  if (!db.autopilot) db.autopilot = [];
  db.autopilot.unshift(round);
  if (db.autopilot.length > MAX_LOG) db.autopilot = db.autopilot.slice(0, MAX_LOG);
  trimAutopilotLog(db.autopilot);
  store.write(db);
  roundNo = roundNoNow;
  lastRound = round;
  onRoundOutcome(round);
  return round;
  } finally {
    // 【2026-09】任务耗时登记：loopWatch 只能报"堵了多久"，这个能报"是谁干的"
    try { require('./tasktime').record('autopilot.runOnce', performance.now() - __t0); } catch (e) {}
    clearTimeout(guard); running = false;
  }
}

// 日志分层保留：近期轮次保留全文（排障要看），远期只留骨架。
//
// 【2026-09·写盘成本】autopilot 单键一度占到全库 35%（197 条 = 510KB），
// 其中 steps 317KB / done 270KB / report 149KB / advises 79KB —— 全是文字型叙述。
// 写盘成本 ∝ 全库字节数，于是"每轮 autopilot 写一次"实际是"每轮把近 0.5MB 重新序列化"，
// 越跑越慢。近期的轮次内容对排障有用，远期的只需要"跑过没有、几步、成功与否"。
//
// 不删除任何轮次（no/at/ok/failed/health/steps 骨架全留），只裁剪文字载荷。
const KEEP_FULL = 30;          // 最近 30 轮留全文
const KEEP_TEXT = 300;         // 远期轮次保留的文本截断长度
function trimAutopilotLog(list) {
  if (!Array.isArray(list)) return list;
  for (let i = KEEP_FULL; i < list.length; i++) {
    const r = list[i];
    if (!r) continue;
    if (r.__trimmed) continue;                 // 已裁过，不重复处理
    r.__trimmed = true;
    if (typeof r.report === 'string' && r.report.length > KEEP_TEXT) r.report = r.report.slice(0, KEEP_TEXT) + '…（已归档截断）';
    if (r.done) r.done = trimTextish(r.done);
    if (r.advises) r.advises = trimTextish(r.advises);
    if (Array.isArray(r.steps)) {
      r.steps = r.steps.map(s => ({
        id: s.id, ok: s.ok, ms: s.ms,
        err: s.err ? String(s.err).slice(0, 120) : undefined
      }));
    }
    if (r.capabilities) r.capabilities = undefined;   // 静态常量，无信息量
  }
  return list;
}
// done/advises 可能是字符串或字符串数组；两种都只保留前若干字符
function trimTextish(v) {
  if (typeof v === 'string') return v.length > KEEP_TEXT ? v.slice(0, KEEP_TEXT) + '…（已归档截断）' : v;
  if (Array.isArray(v)) return v.slice(0, 5).map(x => (typeof x === 'string' && x.length > 200) ? x.slice(0, 200) + '…' : x);
  return v;
}

// 轮次成败判定 → 降级标记 / 退避 / 硬熔断（无人值守自保，不依赖人工介入）
// 判定口径：采集是整轮的信号源，它挂了就是全局性问题（断网/源挂/密钥过期）；
// 其他步骤失败只算局部抖动，不触发降级。
//
// 离线但有兜底产出时**只退避不停机**：外部源不可达要把节奏放慢（少打无谓请求），
// 但用户要的是「断网也不停歇」，此时缓存仍在产出，硬熔断等于自己把自己关掉。
// 真正该停机的是「离线且无缓存可产出」—— 那才是无事可做。
function onRoundOutcome(round) {
  const collectStep = round.steps.find(s => s.id === 'collect');
  // 兜底产出的判据：collect 标了 offline（降级但有缓存产出）
  const producedOffline = !!collectStep && collectStep.offline === true;
  const collectFailed = !!collectStep && !collectStep.ok;
  if (producedOffline) {
    // 断网但有缓存：放慢节奏继续跑，不停机；也不算「故障」，不累计到熔断
    backoff = 2;
    lastError = '离线兜底运行中（外部源不可达，复用情报库缓存）';
    consecFails = 0;
    try { store.push('audit', { ev: 'autopilot-offline', at: Date.now() }, '离线降级运行', '外部源不可达，转缓存兜底并 2 倍退避（不停机）'); } catch (e) {}
    return;
  }
  const bad = round.steps.length === 0 || collectFailed;
  if (!bad) { consecFails = 0; lastError = ''; backoff = 1; return; }
  consecFails++;
  lastError = '第 ' + round.no + ' 轮采集失败' + (collectStep && collectStep.err ? '：' + collectStep.err : '（无情报源可用）');
  if (consecFails >= MAX_CONSEC_FAILS && consecFails < MAX_CONSEC_FAILS * 3) {
    backoff = 4; // 退避：节奏 ×4 慢慢试，避免把故障源打爆
    try { store.push('audit', { ev: 'autopilot-degraded', at: Date.now() }, '自主运营降级', '连续 ' + consecFails + ' 轮采集失败，转入 4 倍退避重试'); } catch (e) {}
  } else if (consecFails >= MAX_CONSEC_FAILS * 3) {
    backoff = 1;
    saveCfg({ enabled: false }); // 彻底不健康：自动停机，等人工 resume
    try { store.push('audit', { ev: 'autopilot-autopause', at: Date.now() }, '自主运营自动停机', '连续 ' + consecFails + ' 轮采集失败，已自动暂停，人工确认后 resume'); } catch (e) {}
  }
  try { brain.evolve(lastError); } catch (e) {}
}

// 状态
function status() {
  const db = store.read();
  const c = cfg();
  // 离线态：最近一轮采集在走缓存兜底。对外要看得见，
  // 否则运维只会看到 ok:true 却以为链路正常。
  const lastCollect = (((db.autopilot || [])[0] || {}).steps || []).find(s => s.id === 'collect') || {};
  const offline = !!lastCollect.offline;
  return {
    ok: true,
    roundNo,
    running,
    enabled: c.enabled,
    offline,
    intervalSec: c.intervalSec,
    effectiveSec: Math.min(MAX_INTERVAL, c.intervalSec * backoff), // 退避后的真实节奏
    backoff,
    degraded: consecFails > 0 || offline,
    consecFails,
    maxConsecFails: MAX_CONSEC_FAILS,
    lastError,
    nextInMs: c.enabled ? Math.max(0, nextAt - Date.now()) : 0,
    logLen: (db.autopilot || []).length,
    wheel: opmods.progress(),
    // 失败率（近 20 轮）——运维一眼看出哪段在持续出问题
    reliability: (function () {
      const rs = (db.autopilot || []).slice(0, 20).filter(r => Array.isArray(r.steps) && r.steps.length);
      if (!rs.length) return null;
      const bad = rs.filter(r => !r.ok).length;
      return { rounds: rs.length, failedRounds: bad, okPct: Math.round(((rs.length - bad) / rs.length) * 100),
        byStep: STEP_DEFS.map(def => {
          const hit = rs.filter(r => r.steps.some(s => s.id === def.id));
          const f = hit.filter(r => r.steps.find(s => s.id === def.id).ok === false).length;
          return { id: def.id, label: def.label, runs: hit.length, fails: f, avgMs: hit.length ? Math.round(hit.reduce((a, r) => a + r.steps.find(s => s.id === def.id).ms, 0) / hit.length) : 0 };
        }).filter(x => x.runs) };
    })(),
    stepCatalog: STEP_DEFS.map(s => ({ id: s.id, label: s.label })),
    last: lastRound
  };
}

// 获客铺市场：把最近一篇自产内容（报告/案例）转成对外钩子，登记一条潜客线索，
// 并从 5% 推广池出一笔小额投放（真实记账：leads + promo.spend 全部落审计）
// 获客成交闭环 24h 铺市场：推进六段漏斗（找→荐→选→优→促→成）+ 5% 推广池小额投放（真实记账）。
// 底层 leadgen 每轮推进 1 段：网络可用时用 GitHub 真实仓库探测，离线降级内置公域池。
async function acquire() {
  const out = [];
  // 1) 推进漏斗主流程（契合格言：先把最难的那一步拆开）
  // 强度随 KPI 达成率自适应：半年千万是 24h 全方位运行的硬指标，
  // 进度越落后（paceRatio 越低）本轮获客批次越多，形成"落后 -> 加大投放 -> 追进度"闭环。
  try {
    const leadgen = require('./leadgen');
    let intensity = 1;
    let kpiRatio = null, kpiShould = 0, kpiRev = 0;
    try {
      const money = require('./money');
      const k = money.kpi() || {};
      const rev = k.revenue || 0, target = k.target || 1, days = k.days || 1, left = k.daysLeft != null ? k.daysLeft : days;
      // 应完成进度 = target * (1 - left/days)。刚开局的应完成额可能为 0（还没到第一个检查点），
      // 此时退化为「按绝对达成率」判断：达成 <15% 也算落后，强度拉满。
      const shouldDone = target * (1 - left / days);
      const ratio = shouldDone > target * 0.01 ? rev / shouldDone : rev / target;
      intensity = ratio < 0.15 ? 4 : ratio < 0.4 ? 3 : ratio < 0.75 ? 2 : 1;
      kpiRatio = ratio; kpiShould = shouldDone; kpiRev = rev;
    } catch (e2) {}
    // 1b)【协同收口】以"核心目标"为唯一准绳覆盖强度。
    // 【为什么要这一段】第 16 条把目标做成了可切换的多条（核心目标可以是"签约 100 家客户"，
    // 而不再是内置的"半年营收 1000 万"）。但上面那段只读 money.kpi()——那是**内置营收口径**。
    // 于是把核心目标切到客户数/交付天数之后，自动获客强度仍在按一个不相干的目标调节：
    // 准绳换了，24h 引擎没换。这就是"全面关联协同"里最典型的假协同。
    // 注意：拿到核心目标口径后**不再打印上面 money.kpi 的旧结论**——两个准绳同时报、
    // 还会给出不同强度（实测 ×4 vs ×2），用户根本无法判断该听谁的。
    // 只在没有核心目标可依据时才回落到 kpi 口径，并如实说明这是回落。
    let anchored = 'kpi';
    try {
      const G = require('./goals');
      const pc = G.pace();
      if (pc && pc.ok && pc.computable && pc.status === 'reached') {
        out.push('核心目标「' + String(pc.title).slice(0, 20) + '」已达成（' + pc.pct + '%）：' +
          '获客强度降至 ×1，不再为已完成目标加大投放（省下真实推广费）');
        intensity = 1; anchored = 'goals';
      } else if (pc && pc.ok && pc.computable) {
        const gap = pc.gapPct;               // >0 落后 / <0 领先（百分点）
        // 【口径】强度由两件事共同决定，缺一不可：
        //   1) 时间进度落后多少（gap）——落后越多越该加力；
        //   2) 今天到底还要做多少（dailyNeed）——**这才是真正驱动投放的量**。
        // 原来只看 gap，长周期目标（1 年 100 家）开局 gap=0 就落到 ×2 的兜底档，
        // 与"今天要新增几家"完全脱钩。现在：dailyNeed > 0 才谈得上加力，
        // 且加力幅度按"今天缺口是否仍大"来定；dailyNeed 掉到 0 说明当天目标已够，
        // 强度回到 ×1——**不为不需要的量花钱**（推广池是真金白银）。
        const need = Number(pc.dailyNeed);
        // 用 needMore（remain>0）而不是 dailyNeed>0：长周期小目标日均取整会变 0，
        // 但缺口还在，不能因此停投；而目标真达成时 needMore=false，才降到 ×1。
        let si;
        if (pc.needMore === false) {
          si = 1;   // 目标已达成（无缺口）：最低力度，不为不需要的量花钱
        } else {
          const base = gap > 10 ? 3 : gap > 3 ? 2 : 1;   // 时间进度给的底档
          si = base >= 2 ? 4 : base === 1 ? 2 : 1;        // 有缺口才加力
        }
        intensity = si; anchored = 'goals';
        out.push('按核心目标「' + String(pc.title).slice(0, 20) + '」定获客强度：完成 ' +
          pc.pct + '%（按周期应完成 ' + pc.expectedPct + '%，' +
          (gap > 0 ? '落后 ' + gap : '领先 ' + (-gap)) + ' 个百分点）；今日需新增 ' +
          (need > 0 ? Math.round(need) + ' ' + (pc.unit || '')
                    : (pc.needMore === false ? '0（目标已达成，不再加投）'
                                             : '0（仍差 ' + Math.round(pc.remain) + '，日均不足 1，按低档维持）')) +
          ' → 强度 ×' + si);
      } else {
        const why = (pc && pc.reason) || '无核心目标';
        out.push('核心目标不可用于调节强度（' + why + '）：本轮按内置营收 KPI 口径' +
          (kpiRatio !== null ? '（达成 ' + Math.round(kpiRatio * 100) + '%）' : '') + '，不假装与核心目标已对齐');
      }
    } catch (e3) {}
    if (anchored === 'kpi' && kpiRatio !== null && intensity > 1) {
      out.push('KPI 进度落后（实际 ¥' + kpiRev + ' / 应完成 ¥' + Math.round(kpiShould) +
        '，达成 ' + Math.round(kpiRatio * 100) + '%），本轮获客强度 ×' + intensity);
    }
    const r = await leadgen.funnelStep(roundNo || 0, { intensity });
    out.push.apply(out, r);
  } catch (e) {}
  // 1c)【真自主获客】对「促单」线索真实外发触达（首次送达计入真实触达，回复后自动升商机候选）。
  // 自带 running/冷却锁，与 goalpilot.daily 并发也不重复发送；开关关闭时如实说明不代发。
  try {
    const ob = require('./outreach');
    const rr = await ob.runOnce();
    if (rr && rr.skipped === 'disabled') out.push('真实触达：开关未开启（outreachEnabled=false），本轮不真实外发，仍只排触达计划');
    else if (rr && rr.skipped === 'no-transport') out.push('真实触达：已开启但未配置发送通道（webhook/SMTP），本轮不真实外发');
    else if (rr && rr.sent > 0) out.push('真实触达：已通过 ' + (rr.channel || '') + ' 外发 ' + rr.sent + ' 条，等待客户回复推动商机候选（今日 ' + rr.daily.sentToday + '/' + rr.daily.dailyCap + '）');
  } catch (e) {}
  // 1d)【24h 蜘蛛入料】GitHub 周巡寻客 + 网页深爬回填（crawlerOn 开启才跑，关闭如实说明）
  try {
    const cr = require('./crawler');
    const rr = await cr.harvestOnce();
    if (rr && rr.skipped === 'disabled') out.push('蜘蛛入料：开关未开启（crawlerOn=false），本轮不巡检 GitHub');
    else if (rr && rr.reach === false) out.push(rr.line || ('蜘蛛入料：GitHub 暂不可达，本轮不登记线索'));
    else if (rr && rr.added > 0) out.push.apply(out, rr.lines);
    else if (rr && rr.lines && rr.lines.length) out.push(rr.lines[rr.lines.length - 1]);
  } catch (e) {}
  // 1e)【履约盯盘】成交订单的收款/发货异常如实提示，不替人工做决定
  try {
    const fm = require('./fulfillment');
    const auto = await fm.automate();
    if (auto && auto.overdue > 0) out.push.apply(out, auto.lines.map(t => '履约盯盘：' + t));
    else if (auto && auto.rows === 0) out.push('履约盯盘：当前无待推进订单');
  } catch (e) {}
  // 2) 推广费「待投放登记」：不伪造支出——真实投放须经人工确认（真实扣款动作未发生就不记账）
  try {
    const money = require('./money');
    const b = money.budget();
    const amt = Math.min(8, Math.max(1, Math.round(b.avail * 10) / 10));
    if (amt > 0.5 && b.avail >= amt) {
      out.push('推广费可用 ¥' + b.avail.toFixed(1) + '：本轮仅登记待投放意向（真实投放经人工确认后才扣款记账）');
    }
  } catch (e) {}
  return out;
}

// 最近 N 轮日志
function log(n) {
  const db = store.read();
  return (db.autopilot || []).slice(0, n || 20);
}

module.exports = { boot, runOnce, runStep, optimize, status, log, pause, resume, setIntervalSec, trimAutopilotLog, steps: () => STEP_DEFS.map(s => ({ id: s.id, label: s.label })) };