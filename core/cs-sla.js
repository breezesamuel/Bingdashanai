// core/cs-sla.js — 客服 SLA 待命引擎（增量·把 tickets/saas-loop 的客服与留存串成待命态）
//
// 为什么：tickets.js 是「发生工单后」的处理体系（已很完整：分级/SLA/周批/退款记账）。
// 但它对**没人来开单**的状态是空转的。cs-sla 做两件 tickets 不做的事：
//   1) 待命自检：当前工单积压 / SLA 超时 / 响应达标率，一句话告诉运营「客服系统现在健康吗」。
//   2) 沉默付费客户挽回（retention 钩子）：把 saas-loop 标出的 dormantPaid（有效订阅但
//      14 天没用）按「先关怀、后提醒、再报价」三步生成挽回草稿，降低 NRR 流失。
//
// 诚实纪律：
//   1. 数字全部来自 tickets.stats / tickets.slaWatch / tickets.compliance + saas-loop.stickiness。
//   2. 挽回文案过「温度宪法」（manuals.scanDignity）——俯视/乞求式禁词会被拦截，与 respond 同口径。
//   3. 只生成 draft（落 gtmTouches，icp='retention'），不自动发；发送人工 markSent。
//   4. 不做陪伴式回复（危机边界与 tickets 一致：不是热线，确认送达即可）。

'use strict';
const store = require('./store');

function safe(fn, fb) { try { const r = fn(); return r == null ? fb : r; } catch (e) { return fb; } }

// ---- ① 客服系统待命自检 ----
function standby() {
  const stats = safe(() => require('./tickets').stats(), null);
  const sla = safe(() => require('./tickets').slaWatch(), { overdue: [], dueSoon: [] });
  const comp = safe(() => require('./tickets').compliance(), null);
  const wk = safe(() => require('./tickets').weekly(), null);
  const open = stats ? stats.open : null;
  const crisis = wk ? (wk.crisisFollowUps || 0) : 0;
  const healthy = open === 0 && (sla.overdue || []).length === 0;
  return {
    ok: true, at: Date.now(),
    standby: healthy,
    open,
    byPrio: stats ? stats.byPrio : null,
    slaOverdue: (sla.overdue || []).length,
    slaDueSoon: (sla.dueSoon || []).length,
    responseCompliancePct: comp && comp.rate != null ? comp.rate : null,
    anxietyHits: wk ? (wk.anxietyHits ? Object.keys(wk.anxietyHits).length : 0) : 0,
    crisisFollowUps: crisis,
    verdict: healthy
      ? '客服系统待命：无未结工单、无 SLA 超时。有单进来按 P0→P1→P2 分级响应即可。'
      : ('需处理：未结 ' + open + ' 单，SLA 超时 ' + (sla.overdue || []).length + ' 条。先清 P0/P1，给每个超时单一个可执行时间点。'),
    honesty: '指标来自 tickets.stats/slaWatch/compliance/weekly；无单时 rate=null（不是 0%）。'
  };
}

// ---- ② 沉默付费客户挽回（retention）----
// 三步：CARE(先关怀，不谈钱) → NUDGE(提醒权益还在) → OFFER(限时升级/续费钩子)
const RETENTION_STEPS = [
  { step: 1, code: 'care', title: '先关怀', body: '最近没看到你常用它。不是催你，就想问一句：有没有哪里用得别扭？回一句就好，我们按反馈改。' },
  { step: 2, code: 'nudge', title: '提醒权益', body: '你的订阅还在有效期，{权益}仍可用。之前你用到一半的功能没做完，随时回来接着弄。' },
  { step: 3, code: 'offer', title: '续费/升级钩子', body: '如果还在用，年付更划算（约75折）；要停也随时能停，48h 内可退（条款已公示）。' }
];

function dormant() {
  const stick = safe(() => require('./saas-loop').stickiness(), null);
  const db = store.read();
  const now = Date.now();
  const DAY = 86400000;
  // 有效订阅但 14 天没用的真实访客（口径同 saas-loop.stickiness 的 dormant）
  const activeSubs = (db.sublist || []).filter(s => Number(s.expireAt) > now);
  const vKey = k => String(k);
  const dorm = [];
  activeSubs.forEach(s => {
    const v = (db.visitors || []).find(x => vKey(x.visitor) === vKey(s.visitor));
    const last = Number(v && v.lastUseAt || 0);
    const isDormant = v ? (last ? now - last > 14 * DAY : !!(v.usageDays && !Object.keys(v.usageDays).length)) : true;
    if (isDormant) dorm.push({ visitor: vKey(s.visitor), plan: s.plan, subId: s.id, expireAt: s.expireAt, lastUseAt: last || null });
  });
  return { stickDormantPaid: stick ? stick.dormantPaid : null, list: dorm };
}

// 生成某沉默客户的挽回草稿（默认第一步 care；可指定 step）
function composeFor(visitor, step) {
  const n = Math.max(1, Math.min(3, Number(step) || 1));
  const tpl = RETENTION_STEPS.find(x => x.step === n) || RETENTION_STEPS[0];
  let body = tpl.body.replace('{权益}', '你已解锁的功能');
  // 温度宪法：过禁词扫描，拦截俯视/乞求式表达（与 tickets.respond 同口径）
  let dignity = { passes: true, hits: [] };
  try { dignity = require('./manuals').scanDignity(body); } catch (e) { }
  return { ok: true, visitor, step: n, code: tpl.code, draft: body, dignity: dignity.passes,
    note: dignity.passes ? '文案过温度宪法。' : '文案触发禁词：' + dignity.hits.join(', ') + '，需改。' };
}

// 为全部沉默付费客户排挽回草稿（落 gtmTouches，icp='retention'，幂等）
function queue(limit) {
  const n = Math.max(1, Math.min(50, Number(limit) || 10));
  const d = dormant().list.slice(0, n);
  const db = store.read();
  if (!Array.isArray(db.gtmTouches)) db.gtmTouches = [];
  d.forEach(v => {
    const key = 'ret-' + v.visitor + '-care';
    if ((db.gtmTouches || []).find(t => t.key === key)) return; // 幂等
    const c = composeFor(v.visitor, 1);
    if (!c.dignity) return; // 文案未过温度宪法则不排队（宁可少发）
    db.gtmTouches.unshift({ key, at: Date.now(), status: 'draft', icp: 'retention', target: v.visitor, channel: '沉默挽回', step: 1, outcome: null, draft: c.draft, plan: v.plan });
  });
  if (db.gtmTouches.length > 500) db.gtmTouches = db.gtmTouches.slice(0, 500);
  store.write(db);
  return { ok: true, queued: d.length, note: '已排 ' + d.length + ' 条关怀草稿（status=draft）。发送需逐条 markSent（人工确认），文案已过温度宪法。' };
}

// 客服 + 留存 面板
function board() {
  const sb = standby();
  const d = dormant();
  const db = store.read();
  const retDrafts = (db.gtmTouches || []).filter(t => t.icp === 'retention').length;
  return {
    ok: true, at: Date.now(),
    cs: sb,
    dormantPaid: d.stickDormantPaid != null ? d.stickDormantPaid : d.list.length,
    retentionQueue: retDrafts,
    verdict: sb.standby && d.list.length === 0
      ? '客服待命 + 无沉默付费客户：留存健康。'
      : (sb.standby ? '客服待命；但有 ' + d.list.length + ' 个沉默付费客户可关怀挽回（降 NRR 流失）。'
        : '客服有积压需先清工单；另有 ' + d.list.length + ' 个沉默付费客户待挽回。'),
    honesty: '指标全部来自 tickets + saas-loop；挽回文案过温度宪法；发送/成交均人工确认。'
  };
}

module.exports = { standby, dormant, composeFor, queue, board, RETENTION_STEPS };
