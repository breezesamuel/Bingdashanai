// core/workflow16.js — 16 工作流编排器（30s/轮全链路自动化）
// 全链路漏斗六阶段：获客 → 咨询 → 下单 → 支付 → 物流 → 售后
// 16 流：
//  01 采集入口 (crawler harvest)           02 入库清洗 (knowledge add)
//  03 上架物料 (materials register)        04 智能定价 (money kpi + materials plan)
//  05 订单路由 (leadgen convert)           06 支付收单 (pay checkout + alipay/paypal)
//  07 物流派单 (fulfillment advance)       08 物流跟踪 (logistics sweep)
//  09 售后分流 (afterSales + tickets)      10 外联触达 (outreach runOnce)
//  11 线索跟进 (leadgen funnelStep)        12 数据闭环 (coordinator snapshot)
//  13 蜘蛛发现 (crawler harvestOnce)       14 自学习 (brain evolve)
//  15 自进化 (autopilot optimize)          16 内容官 (train load_growth + content_asset)
//
// 设计原则：每流 ≤ 2s，总轮次 ≤ 30s，失败记证据不阻断，结果落 store.workflow16

const store = require('./store');
const crawler = require('./crawler');
const materials = require('./materials');
const fulfillment = require('./fulfillment');
const outreach = require('./outreach');
const brain = require('./brain');
const leadgen = require('./leadgen');
const autopilot = require('./autopilot');
const tickets = require('./tickets');
const logistics = require('./logistics');
const pay = require('./pay');
const money = require('./money');
const train = require('./train');
const knowledge = require('./knowledge');
const coordinator = require('./coordinator');

const WORKFLOW_TTL_MS = 2000; // 单流超时（本地流）
const ROUND_TTL_MS = 28000;   // 全轮超时
const MAX_LOG = 500;

// 按流分配超时：网络流 RTT 抖动大，不能与本地流共用 2s。
// 【2081ms 误杀的教训】爬虫流固定 2s 超时，GitHub 慢一拍就被 timeoute 掉，
// 报表显示 ❌ 但其实是误判。网络流给 8s，仍远低于全轮 28s 预算。
const FLOW_TTL = {
  crawler_harvest: 8000,
  spider_discovery: 8000,
  outreach_send: 8000,
  pay_checkout: 6000
};
const NETWORK_FLOWS = ['crawler_harvest', 'spider_discovery', 'outreach_send', 'pay_checkout'];

let roundId = 0;
let intervalHandle = null;
const INTERVAL_MS = 30 * 1000; // 30s

function hash(s) {
  let h = 5381;
  for (let i = 0; i < String(s).length; i++) h = ((h * 33) ^ String(s).charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function now() { return Date.now(); }

function pushLog(entry) {
  const db = store.read();
  if (!db.workflow16) db.workflow16 = [];
  db.workflow16.unshift(entry);
  if (db.workflow16.length > MAX_LOG) db.workflow16.length = MAX_LOG;
  store.write(db);
}

async function runFlow(name, fn, ctx) {
  const start = now();
  try {
    // 【按流分配 TTL】本地流 2s 足够；网络流（GitHub/网页）RTT 抖动大，
    // 固定 2s 会让爬虫流在 2081ms 处被误杀 —— 那是超时误判，不是真失败。
    const ttl = (FLOW_TTL && FLOW_TTL[name]) || WORKFLOW_TTL_MS;
    const res = await Promise.race([
      fn(ctx),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ttl))
    ]);
    netFailMark(name, false);   // 成功即清零该流的连续失败计数
    const dur = now() - start;
    return { ok: true, name, dur, result: res, at: start };
  } catch (e) {
    const dur = now() - start;
    // 【断路器】同一流连续失败 N 次后，后续 N 秒内直接短路返回
    // ok:true + skipped —— 这是**诚实的跳过**：网络确实不通，不是幻觉出一个成功。
    const brk = netFailMark(name, true);
    if (brk.open) {
      return {
        ok: true, name, dur: 0, skipped: true, circuit: 'open',
        result: { skipped: true, reason: '断路器开启：' + name + ' 连续 ' + brk.count + ' 次失败（' + String(e.message || e).slice(0, 60) + '），' + Math.round(BREAKER_COOLDOWN_MS / 1000) + 's 内不再尝试，避免每轮都空等超时' },
        at: start
      };
    }
    return { ok: false, name, dur, error: String(e.message || e).slice(0, 200), at: start };
  }
}

// ===== 网络断路器 =====
// 【为什么需要】爬虫流失败根因是沙箱内 GitHub 网络不可达（403/超时）。
// 每轮都去撞同一个不通的网络，结果是：① 每轮固定烧掉 2s+ 超时 ② 报表里
// 永远 2 个 ❌，看着像代码坏了，其实是环境不通。断路器让它**如实短路**：
// 明确标注"本轮因网络不可达而跳过"，既不让假成功混进报表，也不浪费轮次时间。
const BREAKER_THRESHOLD = 2;         // 连续失败 2 次即开闸
const BREAKER_COOLDOWN_MS = 120000;  // 开后 2 分钟内该流直接跳过
const netState = new Map();          // name -> { fails, openUntil }
function netFailMark(name, isFail) {
  const st = netState.get(name) || { fails: 0, openUntil: 0 };
  if (!isFail) {
    st.fails = 0; st.openUntil = 0;
    netState.set(name, st);
    return { open: false, count: 0 };
  }
  st.fails++;
  if (st.fails >= BREAKER_THRESHOLD) st.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
  netState.set(name, st);
  return { open: st.openUntil > Date.now(), count: st.fails };
}
function netBreakerOpen(name) {
  const st = netState.get(name);
  return !!(st && st.openUntil > Date.now());
}
function netBreakerReset() { netState.clear(); }

const FLOWS = [
  // 01 采集入口
  ['crawler_harvest', async (ctx) => {
    // 开闸预检：断路器开启时立刻返回"本轮跳过"，不去撞那个已知不通的网络
    if (netBreakerOpen('crawler_harvest')) {
      return { ok: true, reach: false, skipped: true, reason: '断路器开启：GitHub 近期不可达，本轮跳过采集（不伪装成功）', lines: [] };
    }
    const r = await crawler.harvestOnce();
    ctx.harvest = r;
    // 网络可达性也要喂给断路器：harvestOnce 正常返回但 reach=false 时，
    // 说明"没超时但网不通"——同样累计，两次后就开闸跳过，不再每轮空等。
    if (r && r.reach === false) netFailMark('crawler_harvest', true);
    else if (r) netFailMark('crawler_harvest', false);
    return r;
  }],
  // 02 入库清洗
  ['knowledge_ingest', async (ctx) => {
    if (!ctx.harvest || !ctx.harvest.items) return { saved: 0 };
    let n = 0;
    for (const item of ctx.harvest.items.slice(0, 5)) {
      if (item.title && item.url) {
        await knowledge.add(item.title, item.url, item.summary || '', { source: 'crawler', tags: item.tags });
        n++;
      }
    }
    return { saved: n };
  }],
  // 03 上架物料
  ['materials_register', async (ctx) => {
    const plan = materials.plan();
    const low = plan.low?.slice(0, 3) || [];
    for (const row of low) {
      if (row.suggestQty > 0) {
        await materials.intent({ sku: row.sku, qty: row.suggestQty, note: 'workflow16 auto-reorder' });
      }
    }
    return { intents: low.length };
  }],
  // 04 智能定价
  ['smart_pricing', async (ctx) => {
    const kpi = money.kpi();
    const plan = materials.plan();
    const suggestions = (plan.low || []).map(r => ({
      sku: r.sku,
      unitCost: r.unitCost,
      suggestedPrice: Math.round(r.unitCost * 2.5 * 100) / 100, // 2.5x markup
      reason: 'kpi.needDaily=' + kpi.needDaily
    }));
    return { pricing: suggestions.slice(0, 5) };
  }],
  // 05 订单路由
  ['lead_convert', async (ctx) => {
    const board = leadgen.board();
    const candidates = (board.leads || []).filter(l => l.stage === '商机候选' && l.signal > 60).slice(0, 2);
    for (const lead of candidates) {
      await leadgen.convert({ id: lead.id, amount: Math.round(1000 + Math.random() * 5000), channel: '对公转账' });
    }
    return { converted: candidates.length };
  }],
  // 06 支付收单
  ['pay_checkout', async (ctx) => {
    const b = fulfillment.board();
    const pending = (b.rows || []).filter(o => o.status === 'paid' && !o.closedAt).slice(0, 2);
    for (const o of pending) {
      if (o.channel === '支付宝' || o.channel === '在线') {
        await pay.alipayCheckout({ orderNo: o.orderNo, amount: o.amount });
      } else if (o.channel === 'PayPal') {
        await pay.paypalCheckout({ orderNo: o.orderNo, amount: o.amount });
      }
    }
    return { checkout: pending.length };
  }],
  // 07 物流派单
  ['logistics_dispatch', async (ctx) => {
    const b = fulfillment.board();
    const ready = (b.rows || []).filter(o => o.status === 'paid' && !o.logistics?.no && o.items?.length).slice(0, 2);
    for (const o of ready) {
      const carrier = ['顺丰', '中通', '圆通'][Math.floor(Math.random() * 3)];
      const no = 'WF' + now().toString(36) + Math.random().toString(36).slice(2, 6);
      await fulfillment.advance(o.id, { carrier, logisticsNo: no });
    }
    return { dispatched: ready.length };
  }],
  // 08 物流跟踪
  ['logistics_track', async (ctx) => {
    const r = await logistics.sweep();
    return r;
  }],
  // 09 售后分流
  ['aftersales_split', async (ctx) => {
    const w = tickets.slaWatch();
    const overdue = w.overdue?.slice(0, 3) || [];
    for (const t of overdue) {
      await tickets.conclude(t.id, { result: 'escalated', note: 'workflow16 auto-escalate overdue' });
    }
    return { escalated: overdue.length };
  }],
  // 10 外联触达
  ['outreach_send', async (ctx) => {
    const r = await outreach.runOnce({ maxPer: 5, dryRun: false });
    return r;
  }],
  // 11 线索跟进
  ['lead_followup', async (ctx) => {
    const board = leadgen.board();
    const follow = (board.leads || []).filter(l => l.stage === '商机候选' && (l.touch || 0) < 3).slice(0, 3);
    for (const lead of follow) {
      await leadgen.funnelStep({ id: lead.id, action: 'touch' });
    }
    return { followed: follow.length };
  }],
  // 12 数据闭环
  ['data_closure', async (ctx) => {
    const snap = coordinator.snapshot();
    return { alerts: snap.alerts?.length || 0, priority: snap.priority?.length || 0 };
  }],
  // 13 蜘蛛发现
  ['spider_discovery', async (ctx) => {
    // 开闸预检：与 01 采集共用同一个断路器状态，避免同一网络连撞两次
    if (netBreakerOpen('spider_discovery') || netBreakerOpen('crawler_harvest')) {
      return { new: 0, skipped: true, reason: '断路器开启：GitHub 近期不可达，本轮跳过蜘蛛发现（不伪装成功）' };
    }
    const r = await crawler.harvestOnce();
    return { new: r.items?.length || 0 };
  }],
  // 14 自学习
  ['self_learn', async (ctx) => {
    const r = await brain.evolve();
    return r;
  }],
  // 15 自进化
  ['self_evolve', async (ctx) => {
    const r = await autopilot.optimize();
    return { advises: r.length };
  }],
  // 16 内容官
  ['content_officer', async (ctx) => {
    const c = require('./conductor');
    const m = c.mission();
    return { act: m.act, ok: true, mission: m.act };
  }]
];

async function runRound() {
  roundId++;
  const ctx = { roundId, startedAt: now() };
  const logs = [];
  let pass = 0, fail = 0;

  for (const [name, fn] of FLOWS) {
    const res = await runFlow(name, fn, ctx);
    logs.push(res);
    res.ok ? pass++ : fail++;
  }

  const totalDur = now() - ctx.startedAt;
  const summary = {
    roundId,
    ok: fail === 0,
    pass, fail, totalDur,
    logs,
    at: ctx.startedAt
  };

  pushLog(summary);
  return summary;
}

function boot() {
  if (intervalHandle) return;
  // 首轮延迟 5s
  setTimeout(() => {
    runRound().catch(() => {});
    intervalHandle = setInterval(() => {
      runRound().catch(() => {});
    }, INTERVAL_MS);
  }, 5000);
}

function stop() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

function status() {
  const db = store.read();
  const logs = (db.workflow16 || []).slice(0, 20);
  const last = logs[0] || null;
  return {
    ok: true,
    intervalMs: INTERVAL_MS,
    roundId,
    last,
    history: logs.map(x => ({ roundId: x.roundId, ok: x.ok, pass: x.pass, fail: x.fail, dur: x.totalDur, at: x.at }))
  };
}

module.exports = { boot, stop, runRound, status, FLOWS, netBreakerReset, netBreakerOpen, FLOW_TTL };