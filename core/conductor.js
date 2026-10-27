// core/conductor.js — 24h 作战指挥塔（联调联动主循环）
// 使命：把散落引擎串成一条朝目标 24h 不间断努力的闭环：
//   目标缺口(goalpilot) → 定本轮主攻 → 真实执行动作 → 验证结果 → 落账/升级异常
// 与 autopilot 的区别：autopilot 是"采集+轮巡+报告"；conductor 专门做"联调执行"——
//   ① 内容产物真实落盘到 data/assets ② 发布列车自动装/到期发车 ③ 线索真实触达登记
//   ④ 技能军械库自动落地 git clone ⑤ 目标缺口驱动优先级（缺口大就重获客/重内容）
// 诚实红线：任何动作失败都如实记录，绝不编造成功；可验证（落盘文件存在、git 落地路径、发车状态）。
// 节奏：15 分钟一轮（与 autopilot 同频），由 server 统一触发 runTick。

const store = require('./store');
const brain = require('./brain');
const money = require('./money');
const fs = require('fs');
const path = require('path');

let TICK_MS = 15 * 60 * 1000;
// 设备自适应（第 7 项）：实际间隔由 devcap 在 boot() 里按机器能力改写（弱机 90min）
// 启动后延后再跑首轮（错峰，避免与 autopilot/goalpilot 同 tick 抢事件循环）
const FIRST_DELAY_MS = 28000;
const MAX_LOG = 200;             // 指挥日志上限
// 【2026-09】原来落在只读的 app.asar/data → 定时任务每次 ENOENT「指挥塔评估失败」，
// 并反复重试造成周期性 ~500ms 事件循环阻塞。改走统一可写数据目录。
const ASSET_ROOT = store.dataPath('assets');

function hash(s) {
  let h = 5381;
  for (let i = 0; i < String(s).length; i++) h = ((h * 33) ^ String(s).charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// —— 读目标缺口，定本轮回合主攻 ——
// 主攻方向优先级：
//   1. 本班增长件缺口 → 生产并装载一个内容增长件（目标驱动的唯一抓手）
//   2. 滞后且本周剩余天数少 → 加大获客推进（促成交/回炉）
//   3. open 采购意向 → 滚动提醒到货确认（缺钱如实说缺口，不代签）
//   4. 技能军械库空 → 落地一个真实开源技能
//   5. 其余 → 内容产物落盘（让每一轮都有可见产出）
function mission() {
  const db = store.read();
  let gap = null;
  try {
    const k = money.kpi();
    gap = { needDaily: Math.round(k.needDaily), regDaily: Math.round(k.regDaily), daysLeft: k.daysLeft };
  } catch (e) {}
  // 发布列车当前班状态
  let train = null;
  try { train = require('./train').board(); } catch (e) {}
  const cur = (train && train.current) || {};
  const tL = train && train.lineBounds;
  const bound = (train && train.bounds) || {};
  const filledN = [cur.slots && cur.slots.growth, cur.slots && cur.slots.retention, cur.slots && cur.slots.debt].filter(Boolean).length;
  const now = Date.now();
  const expired = bound.end && now > bound.end;

  // —— 统一态势接入（整体性）：先问中枢"现在最该做什么"，而不是各自重算 ——
  // 此前 mission() 只看发布列车槽位，KPI/告警/晨报这些全局信号完全不影响动作选择，
  // 于是"目标停滞"时它照样去装留存件。此处读 coordinator.snapshot()（唯一真相）：
  //   1) 有 error 级告警 → 本轮改为推进漏斗/内容去止血（具体动作仍受下方列车逻辑约束，
  //      这里只做"为什么"的记录与优先级提示，不越权改写列车硬约束）
  //   2) 目标风险 → 记录进 reason，让本轮装 growth 件时明确服务于收入缺口
  let snap = null;
  try { snap = require('./coordinator').snapshot(); } catch (e) {}
  const hasErrAlert = snap && snap.alerts && snap.alerts.some(a => a && a.level === 'error');
  const goalAtRisk = snap && snap.priority && snap.priority.some(p => p.act === 'grow_revenue');
  const why = [];
  if (hasErrAlert) why.push('⚠ 存在 error 级告警（' + (snap.alerts.find(a => a.level === 'error').title || '') + '），本轮优先止血/推进');
  if (goalAtRisk) why.push('📉 目标风险（' + (snap.priority.find(p => p.act === 'grow_revenue').why || '') + '），本轮服务收入缺口');
  const whyStr = why.length ? '｜态势：' + why.join('；') : '';

  // 决策：增长件缺口永远最高优先（目标驱动的核心连接：内容 → 增长件 → 发车 → 收入）
  // 装载来源优先 parking lot（尊重志：已有想法先上车），无则现产内容资产
  // 【2026-10-25 装载不足事故修复】原逻辑是串行闸：增长格空 → 每轮只试 load_growth；
  // 若素材不足（craftGrowthAsset 返回 null → no-material 不装载），增长格**永远**空着，
  // 留存/还债务格被饿死、列车永不满 3 格 → watchdog 每 30 分钟邮件「发布列车装载不足」。
  // 修法：同一班内 load_growth 连续 2 次 no-material 后，本轮放行其余格（growth 下轮再试）；
  // retention 同理。火车不等人——缺料的车厢不能堵死整列车。
  const bndStart = cur ? (require('./train').lineBounds(cur.no).start) : 0;
  const noMatOf = act => (db.conductor || []).filter(e =>
    e && e.act === act && String(e.evidence || '') === 'no-material' && Number(e.at || 0) >= bndStart).length;
  if (cur && !cur.slots.growth) {
    const lot = require('./train').board().lotCount > 0 ? (db.parkinglot || []).find(x => !x.taken) || null : null;
    if (lot) return { act: 'take_growth', reason: '本班增长件空缺且 parking lot 有「' + String(lot.idea).slice(0, 24) + '」：提取上车' + whyStr, lotId: lot.id, train: { no: cur.no, filledN } };
    if (noMatOf('load_growth') < 2) {
      return { act: 'load_growth', reason: '本班增长件空缺：生产一个内容增长件装载' + whyStr, train: { no: cur.no, filledN } };
    }
    // 已两次无料：跳过增长格，先装其余格（下一轮仍会重试增长件）
  }
  if (cur && expired && !cur.released) return { act: 'depart', reason: cur.no + ' 班已到期：三格装 ' + filledN + '/3，自动发车' + whyStr, train: { no: cur.no, filledN } };
  if (cur && !cur.slots.retention && noMatOf('load_retention') < 2) {
    return { act: 'load_retention', reason: '本班留存件空缺：装载一个留存件' + whyStr, train: { no: cur.no, filledN } };
  }
  if (cur && !cur.slots.debt && noMatOf('load_debt') < 2) return { act: 'load_debt', reason: '本班还债格空缺：装载一项还债件' + whyStr, train: { no: cur.no, filledN } };
// 列车装齐未发 → 发车
  if (cur && filledN >= 3 && !cur.released) return { act: 'depart', reason: cur.no + ' 班三格已满：自动发车' + whyStr, train: { no: cur.no, filledN } };
  // 采购到货提醒：有 open 采购意向 → 滚动提醒（缺钱如实说缺口，帮人工决断，绝不替人批准）
  // 排位高于技能部署/内容产出：缺料卡履约，是运营连续性风险，应先于每周技能落地被看见。
  // 防刷屏：同一批意向(签名=id 排序集)最近 12h 内已提醒过就不再重复；状态一变就立刻再提醒
  try {
    const openPis = (db.purchaseIntents || []).filter(i => i && i.status === 'open');
    if (openPis.length) {
      const sig = openPis.map(i => i.id).sort().join(',');
      const lastRemind = (db.conductor || []).find(e => e.act === 'procure_remind');
      const due = !lastRemind || !lastRemind.at || (Date.now() - lastRemind.at) > 12 * 3600e3 || String(lastRemind.evidence || '') !== 'pis:' + sig;
      if (due) {
        const total = openPis.reduce((a, i) => a + (Number(i.estCost) || 0), 0);
        const avail = money.budget().avail;
        const need = Math.max(0, total - avail);
        const names = openPis.slice(0, 3).map(i => i.sku + '×' + i.qty).join('、');
        return { act: 'procure_remind', reason: '采购到货待确认：open 意向 ' + openPis.length + ' 笔（' + names + (openPis.length > 3 ? '…' : '') + '）共 ¥' + total.toFixed(2) + '，可用预算 ¥' + avail.toFixed(2) + (need > 0 ? '，缺口 ¥' + need.toFixed(2) + '——穷不装富，先补预算再确认' : '，可覆盖——提醒人工确认真实采购') + whyStr, pisSig: sig, train: null };
      }
    }
  } catch (e) {}
  // 技能军械库有已收录但未落地的高价值技能包 → 落地一个（仅限技能包类仓库，防误克隆框架工程；每周≤2 次防网络过载）
  const wantSkill = /skill|hack|superpower|headroom|prompt/i;
  const pendingSkill = (db.skills_ext || []).find(x => !x.deployed && !x.deployedAt && !x.deployBlocked && wantSkill.test(String(x.name || x.id)) && String(x.src || '').includes('/'));
  const deployThisWeek = (db.conductor || []).filter(e => e.act === 'deploy_skill' && e.at && e.at > (Date.now() - 7 * 864e5)).length;
if (pendingSkill && deployThisWeek < 2) {
    return { act: 'deploy_skill', reason: '技能军械库发现未落地技能包「' + String(pendingSkill.name || pendingSkill.id).slice(0, 24) + '」：真实验收 git clone' + whyStr, skillId: pendingSkill.id, train: null };
  }
  // 自主发布：有真实未发布内容资产且距上次检查 ≥4h → 全平台状态探测（login 状况如实回报，不静默）
  const haveAsset = (db.conductor || []).some(e => /content_asset|load_growth|load_retention/.test(e.act) && e.evidence && !String(e.evidence).startsWith('no-'));
  const lastPub = (db.conductor || []).find(e => e.act === 'autopub_check');
  const pubDue = !lastPub || !lastPub.at || lastPub.at < (Date.now() - 4 * 3600e3);
  if (haveAsset && pubDue) {
    return { act: 'autopub_check', reason: '有真实内容资产在库：探测各发布平台登录态（诚实报告，供后续自动发布）' + whyStr, train: null };
  }
  // 内容产物落盘：消费最近真实决策/知识/情报，把一料五吃产物落盘
  return { act: 'content_asset', reason: '列车已装齐/在途：本轮把最近真实素材制成对外产物落盘' + whyStr, train: null };
}

// —— 真实执行动作（每轮一个，落 db.conductor 证据）——
async function execute(m) {
  const o = { act: m.act, reason: m.reason, detail: '', ok: false, evidence: '', at: Date.now() };
  try {
    // 0) 从 parking lot 提取真实想法装增长件（尊重志：先让已登记的想法上车）
    if (m.act === 'take_growth') {
      const train = require('./train');
      const r = train.takeFromLot(m.lotId, undefined, 'growth');
      o.detail = '从 parking lot 提取「' + (r.title || '').slice(0, 40) + '」装 ' + r.no + ' 班增长件';
      o.evidence = r.no + ':' + 'growth:' + m.lotId;
      o.ok = true;
    }
    // 1) 内容增长件：把矩阵/快报/知识做成一篇真实内容资产落盘，再装进本班 growth 格
    if (m.act === 'load_growth') {
      const asset = craftGrowthAsset();
      if (asset) {
        const file = writeAsset(asset.title, asset.body);
        const train = require('./train');
        const r = train.load({ slot: 'growth', title: asset.title.slice(0, 60), desc: asset.body.slice(0, 160), by: 'conductor' });
        o.detail = '增长件「' + asset.title.slice(0, 40) + '」已落盘 ' + file + ' 并装载 ' + r.no + ' 班';
        o.evidence = (asset.srcId || 'growth') + '|' + file + '|' + r.no;
        o.ok = true;
      } else {
        o.detail = '增长件素材不足（无真实决策/知识/情报可加工），如实跳过，不进班';
        o.evidence = 'no-material';
        o.ok = true; // 真实无料=诚实结果
      }
    }
    // 2) 到期/满三格发车
    else if (m.act === 'depart') {
      const r = require('./train').depart({});
      o.detail = r.note;
      o.evidence = 'train#' + r.no;
      o.ok = true;
    }
    // 3) 留存件：把最近同路片段做成可复用留存件（若素材够）
    else if (m.act === 'load_retention') {
      const a = craftRetentionAsset();
      if (a) {
        const file = writeAsset(a.title, a.body);
        const r = require('./train').load({ slot: 'retention', title: a.title.slice(0, 60), desc: a.body.slice(0, 160), by: 'conductor' });
        o.detail = '留存件「' + a.title.slice(0, 40) + '」已落盘 ' + file + ' 并装载 ' + r.no;
        o.evidence = file + '|' + r.no;
        o.ok = true;
      } else {
        o.detail = '留存件无真实素材，跳过（不编造）';
        o.evidence = 'no-material';
        o.ok = true;
      }
    }
    // 4) 还债件：从真实技术债清单装载一项（排除无债时的友好提示文案，避免把"没有债"当债装车）
    else if (m.act === 'load_debt') {
      const train = require('./train');
      const debts = (train.techDebt() || []).filter(s => !/无待还技术债记录/.test(String(s)));
      if (debts.length) {
        const r = train.load({ slot: 'debt', title: debts[0].slice(0, 60), desc: debts[0].slice(0, 160), by: 'conductor' });
        o.detail = '还债件「' + debts[0].slice(0, 40) + '」已装载 ' + r.no;
        o.evidence = 'debt:' + debts[0].slice(0, 40) + '|' + r.no;
        o.ok = true;
      } else {
        o.detail = '技术债清单为空，跳过（不编造债务）';
        o.evidence = 'no-debt';
        o.ok = true;
      }
    }
    // 5) 技能军械库落地：把已收录但未落地的高星外部模块真实验收 git clone
    else if (m.act === 'deploy_skill') {
      const skills = require('./skills');
      const db0 = store.read();
      const g = (db0.skills_ext || []).find(x => x.id === m.skillId || x.src === m.skillId);
      if (g) {
        // 护栏：落地最多等 35s（大仓库/慢网络不等 24h 主循环），超时标记失败不阻塞后续轮次
        const r = await Promise.race([
          skills.invoke(g.id, { deploy: true }, {}),
          new Promise((_, rej) => setTimeout(() => rej(new Error('deploy 超时(35s)')), 35000))
        ]).catch(e => ({ ok: false, output: '落地超时/失败：' + String(e.message || e).slice(0, 80) }));
        o.detail = '技能「' + String(g.name || g.id).slice(0, 30) + '」真实验收：' + String(r.output || '').split('\n')[0].slice(0, 60);
        o.evidence = 'skill:' + String(g.src || g.id);
        o.ok = !(/落地失败|超时/.test(String(r.output || '')));
        // 无论成败标记已尝试，避免下轮死循环重试同一仓库
        store.update('skills_ext', g.id, { deployed: true, deployedAt: Date.now(), deployOk: o.ok });
      } else {
        o.detail = '目标技能已不存在，跳过';
        o.evidence = 'gone';
        o.ok = true;
      }
    }
    // 6) 内容资产落盘（列车满载时仍持续产出，供人工发布）
    else if (m.act === 'content_asset') {
      const asset = craftGrowthAsset() || craftRetentionAsset();
      if (asset) {
        const file = writeAsset(asset.title, asset.body);
        o.detail = '对外内容资产「' + asset.title.slice(0, 40) + '」已落盘 ' + file;
        o.evidence = (asset.srcId || 'asset') + '|' + file;
        o.ok = true;
      } else {
        o.detail = '无真实素材可加工，本轮不产出（等待人工投喂）';
        o.evidence = 'no-material';
        o.ok = true;
      }
    }
    // 7) 自主发布检查：探测各发布平台登录态（诚实回报，绝不伪造"已发布"；每轮每次只查一个平台，防开浏览器过载）
    else if (m.act === 'autopub_check') {
      const autopub = require('./autopub');
      const dbCK = store.read();
      const seen = new Set((dbCK.conductor || []).filter(e => /^autopub_ck_/.test(e.evidence || '')).map(e => e.evidence.replace('autopub_ck_', '')));
      const pending = Object.keys(autopub.PLATFORMS).find(pl => !seen.has(pl));
      if (pending) {
        const s = await autopub.statusOne(pending, { headless: true });
        o.detail = pending + '（' + s.name + '）登录态=' + (s.logged ? '在线' : '未登录') + '：' + (s.logged ? '可自动发布' : '需人工扫码接入');
        o.evidence = 'autopub_ck_' + pending;
        o.ok = true;
} else {
        o.detail = '全平台登录态已探测完毕，等待人工扫码接入后可自动发布';
        o.evidence = 'autopub_done';
        o.ok = true;
      }
    }
    // 7b) 采购到货提醒：只登记证据，绝不代签"假到货"——缺钱就摆缺钱，够钱也不动账
    else if (m.act === 'procure_remind') {
      const dbP = store.read();
      const openPis = (dbP.purchaseIntents || []).filter(i => i && i.status === 'open');
      const total = openPis.reduce((a, i) => a + (Number(i.estCost) || 0), 0);
      const avail = money.budget().avail;
      const need = Math.max(0, total - avail);
      o.detail = '在途采购意向 ' + openPis.length + ' 笔需 ¥' + total.toFixed(2) + '，可用预算 ¥' + avail.toFixed(2) + (need > 0 ? '，缺口 ¥' + need.toFixed(2) + '：已滚动提醒，先补预算或人工核对' : '，可覆盖：已耐心等待人工确认真实到货') + '（不代签、不自动扣款）';
      o.evidence = 'pis:' + (m.pisSig || '');
      o.ok = true;
    }
  } catch (e) {
    o.ok = false;
    o.detail = '执行失败：' + String(e.message || e).slice(0, 140);
    o.evidence = 'error:' + String(e.message || '').slice(0, 60);
  }
  return o;
}

// —— 内容素材加工：从真实台账（决策/知识/情报/同路人）挑最新可用一条，生成结构化资产 ——
function craftGrowthAsset() {
  const db = store.read();
  const cand = [];
  (db.decisions || []).forEach(x => { if (x.question && x.answer) cand.push({ kind: 'decision', t: x.question, b: x.answer, src: x.engine || '', id: x.id }); });
  (db.knowledge || []).forEach(x => { if (x.q && x.a) cand.push({ kind: 'knowledge', t: x.q, b: x.a, src: 'knowledge', id: x.id }); });
  (db.intel || []).forEach(x => { if (x.q && x.a) cand.push({ kind: 'intel', t: x.q, b: x.a, src: 'intel', id: 'h' + hash(String(x.a)) }); });
  (db.peers || []).forEach(x => { if (x.text && x.approved === true) cand.push({ kind: 'peer', t: (x.gua || '同路人') + '·灯角', b: x.text, src: 'peer', id: x.id }); });
  if (!cand.length) return null;
  // 只挑最近 1 次尚未产出过资产的素材（conductor 台账里的 evidence 记有来源 id）
  const used = new Set((db.conductor || []).map(e => e.evidence || '').filter(e => /^(decision|knowledge|intel|peer):/.test(e)).map(e => e.split('|')[0]));
  const fresh = cand.filter(c => c.id && !used.has(c.kind + ':' + c.id));
  const pick = (fresh.length ? fresh : cand)[cand.length - 1] || cand[cand.length - 1];
  const title = '决策实录·' + String(pick.t).replace(/[【】]/g, '').slice(0, 40);
  const body = [
    '【' + title + '】',
    '素材来源：' + pick.kind + ':' + (pick.src || '?'),
    '一句话："' + String(pick.t).slice(0, 80) + '"',
    '——',
    String(pick.b).slice(0, 500),
    '——',
    '（AI 辅助整理自系统真实台账，可回查原文；对外发布前请人工确认口径）'
  ].join('\n');
  return { title, body, srcId: pick.kind + ':' + pick.id };
}

function craftRetentionAsset() {
  const db = store.read();
  const peers = (db.peers || []).filter(p => p.text && p.approved === true);
  if (!peers.length) return null;
  const p = peers[peers.length - 1];
  const title = '同路人灯角·' + (p.gua || '走出来的故事');
  const body = [
    '【' + title + '】',
    p.text.slice(0, 300),
    '',
    '（收录自同路人 T1 · 已授权标灯；对外引用请按授权边界，勿加戏）'
  ].join('\n');
  return { title, body };
}

// —— 把资产真实落盘到 data/assets（同名不覆盖：追加时分戳，保证每件产物都是新文件可追溯）——
function writeAsset(title, body) {
  const safe = String(title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 50);
  const ts = new Date().toISOString().slice(0, 10);
  try { fs.mkdirSync(ASSET_ROOT, { recursive: true }); } catch (e) {}
  let file = path.join(ASSET_ROOT, safe + '-' + ts + '.md');
  let n = 2;
  while (fs.existsSync(file)) { file = path.join(ASSET_ROOT, safe + '-' + ts + '-' + n + '.md'); n++; }
  fs.writeFileSync(file, body, 'utf8');
  return path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
}

// —— 本轮指挥：先执行主攻动作，再联动推进其余引擎 ——
//
// 【2026-09·并发守卫】实测单轮 runTick 要跑 **17.4 秒**（大部分是 await 联网，
// 真正同步阻塞约 1.2 秒）。而 boot() 里 setInterval(runTick, TICK_MS) 的 TICK_MS
// 会被 devcap 按机器能力压缩——强机上可能只有 2 分钟。17 秒的任务 + 没有守卫，
// 极端情况下会**多轮叠在一起跑**：同时写库、同时推进同一条线索，
// 表现为毫无规律的卡顿。autopilot 早就有同款 running 守卫，这里补上。
let _tickRunning = false;
async function runTick() {
  if (_tickRunning) return { skipped: true, reason: '上一轮指挥仍在执行' };
  _tickRunning = true;
  const __t0 = performance.now();   // 【2026-09】tasktime 登记
  try {
    return await __runTickInner();
  } finally {
    _tickRunning = false;
    try { require('./tasktime').record('conductor.runTick', performance.now() - __t0); } catch (e) {}
  }
}

async function __runTickInner() {
  // 全局护栏：单轮总时限 70s，超时也不算崩——执行结果按失败记录，主循环照常推进
  const result = await Promise.race([
    (async () => {
      const m = mission();
      return { m, o: await execute(m) };
    })(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('tick 超时(70s)')), 70000))
  ]).catch(e => ({ m: { act: 'overtime', reason: String(e.message || e) }, o: { act: 'overtime', reason: String(e.message || e), detail: '本轮超时被护栏截断', ok: false, evidence: 'timeout', at: Date.now() } }));
  const m = result.m;
  const o = result.o;
  // 联动：目标引擎推进（缺当天闭环就补）+ 情报引擎轮巡（错峰 15s 由 autopilot 负责，不重复）
  let goal = null;
  try {
    const g = require('./goalpilot');
    const r = await g.daily();
    goal = { skipped: !!r.skipped, status: r.status || (r.last && r.last.status) || null };
  } catch (e) { goal = { error: e.message.slice(0, 60) }; }
  // 记录本次指挥回合
  const db = store.read();
  if (!db.conductor) db.conductor = [];
  db.conductor.unshift({ id: store.uid(), ...o, goal });
  if (db.conductor.length > MAX_LOG) db.conductor = db.conductor.slice(0, MAX_LOG);
  store.write(db);
  // 审计：只对"真的动作"记审计；素材不足这类诚实跳过不刷屏（防 audit 污染）
  if (o.ok && o.evidence && !String(o.evidence).startsWith('no-')) {
    store.push('audit', { action: '指挥塔·' + m.act, detail: o.detail.slice(0, 120), at: Date.now() });
  }
  // 失败升级 watchdog——让异常进入告警通道（网络/落地失败是真实风险）
  if (!o.ok) {
    try {
      const w = require('./watchdog');
      const a = w.scanNow();
      const already = a.some(x => x.key === 'conductor-fail');
      if (!already) {
        store.push('audit', { action: '指挥塔执行失败', detail: o.detail.slice(0, 120), at: Date.now() });
      }
    } catch (e) {}
  }
  return { mission: m, outcome: o, goal };
}

function boot() {
  // 延后首跑：runTick 内部会同步读 1.4MB db.json，启动瞬间执行会卡住主进程
  const t = setTimeout(() => runTick().catch(() => {}), FIRST_DELAY_MS);
  if (t.unref) t.unref();
  // 设备自适应（第 7 项）：指挥塔节拍按 devcap 推导，弱机降频
  try {
    const d = require('./devcap').plan();
    TICK_MS = Math.max(120, d.conductorTickSec) * 1000;
  } catch (e) {}
  setInterval(() => { runTick().catch(() => {}); }, TICK_MS);
}

function status() {
  const db = store.read();
  const log = (db.conductor || []).slice(0, 30);
  const last = log[0] || null;
  return {
    ok: true,
    tickMs: TICK_MS,
    logLen: (db.conductor || []).length,
    last,
    history: log.map(x => ({ act: x.act, ok: x.ok, detail: (x.detail || '').slice(0, 60), at: x.at }))
  };
}

module.exports = { boot, runTick, mission, status, writeAsset, ASSET_ROOT };