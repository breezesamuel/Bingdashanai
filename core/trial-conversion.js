// core/trial-conversion.js — 试用→7天转正引擎（增量·真实客户优先·自测剔除·人工确认闸口）
//
// 为什么有它：现有 conversion-engine.board() 把「付过¥1体验未转正」全列出来，
// 但里面会混进 ip:127.0.0.1 的本机自测访客——绝不能给自测送 7 天权益（那是刷单）。
// 本模块做三件事：
//   1) realTrialers()  剔除 saas-loop.isInternal 的自测，只留真实外部试用客户。
//   2) grant7(visitor) 对单个真实客户发 7 天【临时授权】(subs.activateProvisional，
//                      独立 provisional 集合，绝不碰已付费 sublist → 安全可回收)。
//   3) nurture(5)/nurture(7)  第5天关怀、第7天转化 offer 草稿（落 gtmTouches，人工 markSent）。
//
// 诚实纪律：
//   · 只给 isInternal=false 的真实客户发权益；自测一律拒发（返回 reason）。
//   · 7 天用 subs.activateProvisional（乐观授权·待核账），不直接改 sublist、不写死金额。
//   · 文案过温度宪法；发送/成交均人工确认。

'use strict';
const store = require('./store');

function safe(fn, fb) { try { const r = fn(); return r == null ? fb : r; } catch (e) { return fb; } }
function isInternal(key) { try { return require('./saas-loop').isInternal(key); } catch (e) { return /^ip:127[._]0[._]0[._]1/i.test(String(key || '')); } }

const TRIAL_DAYS = 7;

// 真实试用未转正客户（剔除自测）
function realTrialers() {
  const conv = safe(() => require('./conversion-engine'), null);
  const all = conv ? conv.trialers() : [];
  return all.map(v => Object.assign({ real: !isInternal(v.visitor) }, v));
}
function realOnly() { return realTrialers().filter(v => v.real); }

// 对单个真实客户发 7 天临时授权（安全·可回收·不碰已付费订阅）
function grant7(visitorKey) {
  const key = String(visitorKey || '').trim();
  if (!key) return { ok: false, error: 'visitor 必填' };
  if (isInternal(key)) return { ok: false, error: '自测访客（本机/回环），按纪律不送 7 天权益', reason: 'self-test' };
  const subs = safe(() => require('./subs'), null);
  if (!subs) return { ok: false, error: 'subs 模块不可用' };
  const db = store.read();
  // 该客户必须真实付过¥1体验（trialUsed）
  const v = (db.visitors || []).find(x => String(x.visitor) === key);
  if (!v || v.trialUsed !== true) return { ok: false, error: '该访客未付过¥1体验，不适用试用转正', reason: 'not-trial' };
  // 已有有效正式订阅 → 不重复发
  const hasSub = (db.sublist || []).some(s => String(s.visitor) === key && Number(s.expireAt) > Date.now() && s.plan !== 'f2' && s.plan !== 't');
  if (hasSub) return { ok: false, error: '该客户已有有效订阅，无需试用转正', reason: 'already-sub' };
  // 发 7 天临时授权：reviewUntil=7天后，走独立 provisional 集合
  const planId = 'm'; // 转正目标 = 标准月卡（转正后走 subs.confirm 转正式）
  const p = subs.activateProvisional(key, planId, null, Date.now() + TRIAL_DAYS * 86400000);
  return {
    ok: true, visitor: key, granted: TRIAL_DAYS + '天临时授权', plan: 'm',
    reviewUntil: p ? p.reviewUntil : null, provisionalId: p ? p.id : null,
    note: '已发 7 天临时授权（provisional 独立集合，不影响已付费订阅）。第5天关怀 + 第7天转化 offer，人工确认后发送。'
  };
}

// 批量给全部真实试用客户发 7 天（自测自动剔除）
function grantAll() {
  const real = realOnly();
  const res = real.map(v => grant7(v.visitor));
  return { ok: true, granted: res.filter(r => r.ok).length, skipped: res.filter(r => !r.ok), totalReal: real.length,
    note: '仅对真实客户发；自测/已有订阅/未试用 的自动跳过并给出原因。' };
}

// 第 N 天动作：5=关怀，7=转化 offer（草稿，人工 markSent）
function nurture(day) {
  const d = Math.max(1, Math.min(7, Number(day) || 5));
  const real = realOnly();
  const db = store.read();
  if (!Array.isArray(db.gtmTouches)) db.gtmTouches = [];
  let queued = 0;
  real.forEach(v => {
    const key = 'conv7-' + v.visitor + '-' + (d >= 7 ? 'offer' : 'care');
    if ((db.gtmTouches || []).find(t => t.key === key)) return;
    let draft = '';
    if (d >= 7) draft = '你的 7 天试用明天到期。这 7 天你用过它（或还没用上）——如果继续需要，月付首月可以直接接上，随时能停；要停我帮你办 48h 可退。';
    else draft = '试用第 5 天了，想问一句：有没有哪一步卡住了？回一句，我按反馈调。不用也没关系。';
    db.gtmTouches.unshift({ key, at: Date.now(), status: 'draft', icp: 'trial7', target: v.visitor, channel: d >= 7 ? '试用到期转化' : '试用第5天关怀', day: d, outcome: null, draft });
    queued++;
  });
  if (db.gtmTouches.length > 500) db.gtmTouches = db.gtmTouches.slice(0, 500);
  store.write(db);
  return { ok: true, day: d, queued, totalReal: real.length,
    note: '已排 ' + queued + ' 条草稿（status=draft）。发送需逐条 markSent（人工确认），成交走 subs.confirm。' };
}

// 面板
function board() {
  const all = realTrialers();
  const real = all.filter(v => v.real);
  const selfTest = all.filter(v => !v.real);
  return {
    ok: true, at: Date.now(),
    trialDays: TRIAL_DAYS,
    realTrialers: real.map(v => ({ visitor: v.visitor, active: v.active, icpHint: v.icpHint })),
    selfTestExcluded: selfTest.length,
    selfTestNote: 'ip:127.0.0.1 等自测访客 ' + selfTest.length + ' 个已按纪律剔除，不送 7 天权益',
    verdict: real.length === 0
      ? '当前没有「真实外部试用未转正」客户（未转正名单里只有自测）。'
      : ('有 ' + real.length + ' 个真实试用客户可发 7 天转正窗口；自测 ' + selfTest.length + ' 个已剔除。'),
    honesty: '7 天走 subs.activateProvisional（独立 provisional，不碰已付费订阅，可回收）；只发真实客户；文案过温度宪法；发送/成交人工确认。'
  };
}

module.exports = { TRIAL_DAYS, realTrialers, realOnly, grant7, grantAll, nurture, board };
