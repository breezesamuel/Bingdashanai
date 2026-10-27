// core/ledger-clean.js — 假账清除 + 真挂账核销（增量·默认 dry-run·备份·审计·可回收）
//
// 背景（审计结论）：线上 ¥1486 营收全部是 16 笔「订阅-m ¥99」的**本机自测假账**
//（运营联调时自己下单确认到账，钱没真到账却被标 settled）；真实到账只有 1 笔 ¥1（体验单）。
//
// 本模块做三件事，全部默认 dry-run，不静默删任何东西：
//   1) auditOnly()          只读分类：selfTest(假) / realSettled(真·已到账) / realPending(真·挂账)，各列明细+金额。
//   2) purgeSelfTest({execute})   物理清除自测假账（revenue + 其 5% promo 计提 + 孤儿 receivable），
//                            execute=false 只预览将删清单；execute=true 才真删，且先备份 db。
//   3) writeoffStalePending({hours=24,execute})  真实挂账超 N 小时未付 → money.writeoff 核销（留审计），
//                            对应「真的如果24小时不付钱也清除掉」。
//
// 安全纪律（与 money.js / crm.js 同一套）：
//   · 默认 dry-run：不传 execute 一律只返回预览，不改任何数据。
//   · 误伤防护：realSettled（如那 1 笔 ¥1）永不进清除清单；清除命中数与 preview 严格一致才写。
//   · 先备份：execute 前把 db.json 另存 db.json.purgebak.<ts>（同目录，可回滚）。
//   · 全程写 audit：删了什么、为什么、多少笔，可翻查。
//   · promo/receivable 孤儿连带清：假账的 5% 计提与挂账台账一并摘掉，不留悬空记录。

'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./store');
const money = require('./money');

function orderIndex(db) { return new Map(((db && db.orders) || []).map(o => [String(o.id), o])); }

// ---- ① 只读分类 ----
function auditOnly() {
  const db = store.read();
  const ob = orderIndex(db);
  const rev = db.revenue || [];
  const self = [], realSettled = [], realPending = [];
  let selfSum = 0, realSetSum = 0, pendSum = 0;
  rev.forEach(r => {
    const settled = money.isSettled(r);
    const selfTest = money.isSelfTest(r, ob);
    const amt = Number(r.amt || 0);
    if (selfTest) { self.push({ id: r.id, amt, settled, source: String(r.source || '') }); selfSum += amt; }
    else if (settled) { realSettled.push({ id: r.id, amt, source: String(r.source || ''), settledAt: r.settledAt || r.at }); realSetSum += amt; }
    else { realPending.push({ id: r.id, amt, at: r.at || r.createdAt }); pendSum += amt; }
  });
  const now = Date.now();
  const stalePending = realPending.filter(p => now - Number(p.at || 0) > 24 * 3600000);
  return {
    ok: true, at: now,
    selfTestCount: self.length, selfTestSum: Math.round(selfSum * 100) / 100, selfList: self,
    realSettledCount: realSettled.length, realSettledSum: Math.round(realSetSum * 100) / 100, realSettled: realSettled,
    realPendingCount: realPending.length, realPendingSum: Math.round(pendSum * 100) / 100, realPending,
    stalePendingOver24h: stalePending.length, stalePendingList: stalePending,
    verdict: '自测假账 ' + self.length + ' 笔 ¥' + (Math.round(selfSum * 100) / 100) + '；真实到账 ' +
      realSettled.length + ' 笔 ¥' + (Math.round(realSetSum * 100) / 100) + '；真实挂账 ' +
      realPending.length + ' 笔（超24h未付 ' + stalePending.length + '）',
    honesty: '只读分类；清除/核销必须显式传 execute=true 且先 dry-run 比对命中数。'
  };
}

// ---- 内部：备份 db ----
function backupDb() {
  let dir = null;
  try { dir = store.DATA_DIR; } catch (e) {}
  if (!dir) { try { dir = path.dirname(require('./store').DB_PATH); } catch (e2) {} }
  if (!dir) return { ok: false, error: '定位不到数据目录，无法备份（拒绝在未备份时清除）' };
  const src = path.join(dir, 'db.json');
  const bak = path.join(dir, 'db.json.purgebak.' + Date.now().toString(36));
  try { fs.copyFileSync(src, bak); return { ok: true, backup: bak }; }
  catch (e) { return { ok: false, error: '备份失败（拒绝在未备份时清除）：' + e.message }; }
}

// ---- ② 物理清除自测假账（默认 dry-run）----
function purgeSelfTest(opt) {
  const o = opt || {};
  const execute = o.execute === true;
  const db = store.read();
  const ob = orderIndex(db);
  const rev = db.revenue || [];
  const toDel = rev.filter(r => money.isSelfTest(r, ob));          // 只删自测
  const delIds = new Set(toDel.map(r => String(r.id)));
  const keepReal = rev.filter(r => !money.isSelfTest(r, ob));     // 真实到账/挂账 永不删
  // promo 孤儿：revId 指向被删 revenue 的 5% 计提
  const delPromo = (db.promo || []).filter(p => p.revId && delIds.has(String(p.revId)));
  const delRecev = (db.receivable || []).filter(rcv => rcv.revId && delIds.has(String(rcv.revId)));

  const preview = {
    willDeleteRevenue: toDel.length, willDeleteSum: Math.round(toDel.reduce((s, r) => s + Number(r.amt || 0), 0) * 100) / 100,
    willDeletePromo: delPromo.length, willDeleteReceivable: delRecev.length,
    keepRealSettled: keepReal.filter(r => money.isSettled(r)).length,
    keepRealPending: keepReal.filter(r => !money.isSettled(r)).length
  };
  if (!execute) return { ok: true, dryRun: true, preview, note: 'dry-run：以上为将删清单。确认无误后传 {execute:true}。' };

  // 误伤防护：命中数必须与 dry-run 一致（重读当前库再核一次）
  const db2 = store.read();
  const ob2 = orderIndex(db2);
  const recheck = (db2.revenue || []).filter(r => money.isSelfTest(r, ob2)).length;
  if (recheck !== toDel.length) {
    return { ok: false, error: '清除命中数变化（' + recheck + '≠' + toDel.length + '），为安全中止，请重新 dry-run。' };
  }
  const bk = backupDb();
  if (!bk.ok) return bk; // 备份失败则拒绝清除

  const selfIds = new Set((db2.revenue || []).filter(r => money.isSelfTest(r, ob2)).map(r => String(r.id)));
  db2.revenue = (db2.revenue || []).filter(r => !selfIds.has(String(r.id)));
  if (delPromo.length) db2.promo = (db2.promo || []).filter(p => !(p.revId && selfIds.has(String(p.revId))));
  if (delRecev.length) db2.receivable = (db2.receivable || []).filter(rcv => !(rcv.revId && selfIds.has(String(rcv.revId))));
  store.write(db2);
  // 审计：留痕（写进新 db）
  try {
    store.push('audit', {
      action: '假账清除（自测营收物理移除）',
      detail: '清除自测营收 ' + toDel.length + ' 笔 ¥' + preview.willDeleteSum +
        '（promo ' + delPromo.length + ' / receivable ' + delRecev.length + ' 连带）；保留真实到账 ' +
        preview.keepRealSettled + ' 笔；备份=' + path.basename(bk.backup), at: Date.now()
    }, null, null);
  } catch (e) {}
  return { ok: true, executed: true, backup: bk.backup, ...preview,
    note: '已清除自测假账并备份。KPI 营收口径随之干净（只剩真实到账）。' };
}

// ---- ③ 真实挂账超 N 小时核销（默认 dry-run）----
function writeoffStalePending(opt) {
  const o = opt || {};
  const hours = Math.max(1, Number(o.hours) || 24);
  const execute = o.execute === true;
  const db = store.read();
  const ob = orderIndex(db);
  const now = Date.now();
  const stale = (db.revenue || []).filter(r => {
    if (money.isSettled(r) || r.status === 'written_off') return false;
    if (money.isSelfTest(r, ob)) return false;   // 自测走 purge，不走核销
    return now - Number(r.at || r.createdAt || 0) > hours * 3600000;
  });
  if (!execute) {
    return { ok: true, dryRun: true, hours, wouldWriteoff: stale.length,
      list: stale.map(r => ({ id: r.id, amt: r.amt, ageH: Math.round((now - Number(r.at || r.createdAt || 0)) / 3600000) })),
      note: 'dry-run：' + stale.length + ' 笔真实挂账超 ' + hours + 'h 未付。确认后续钱也收不回来时传 {execute:true}（写 audit）。' };
  }
  const done = [];
  stale.forEach(r => {
    const w = money.writeoff(r.id, o.reason || '客户失联', '自动核销：挂账超' + hours + 'h未付 ' + r.id);
    done.push({ id: r.id, ok: w.ok, error: w.error });
  });
  return { ok: true, executed: true, hours, writeoffCount: done.filter(d => d.ok).length, done };
}

// ---- 综合：dry-run 报告（默认）/ 执行清除（execute）----
function cleanAll(opt) {
  const o = opt || {};
  const a = auditOnly();
  const result = {
    ok: true, at: a.at, dryRun: o.execute !== true,
    classification: a,
    selfTestPurge: o.execute === true ? purgeSelfTest({ execute: true }) : purgeSelfTest({}),
    staleWriteoff: o.execute === true ? writeoffStalePending({ hours: o.hours, execute: true }) : writeoffStalePending({ hours: o.hours })
  };
  result.verdict = result.dryRun
    ? '【dry-run】自测假账 ' + a.selfTestCount + ' 笔¥' + a.selfTestSum + ' 可清除；真实到账 ' + a.realSettledCount + ' 笔保留；真实挂账超24h ' + a.stalePendingOver24h + ' 笔可核销。传 {execute:true} 执行。'
    : '【已执行】' + JSON.stringify({ purged: result.selfTestPurge, writeoff: result.staleWriteoff });
  return result;
}

module.exports = { auditOnly, purgeSelfTest, writeoffStalePending, cleanAll };
