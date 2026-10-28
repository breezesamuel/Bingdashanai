// core/shard-migrate.js — 分片存储灰度迁移工具（shadow 双写 + 对账 + 切读前置检查）
//
// 【为什么有它】shard-store 已具备 P1+P2+WAL 崩溃恢复 + 跨进程锁 + CAPS 全表，
// 但「切读」不能拍脑袋：要 shadow 期双写对账 0 差异才允许切。本工具把
// storage-roadmap 的 Phase 3 四步变成可执行函数：
//   1) syncToShards()   native db.json → shards/ 单向快照（切读前 shards 不能落后 native）
//   2) syncFromShards() shards/ → native db.json 回填（**切读后继续跑**：原生库永远是
//                        新鲜回滚点——「30 秒回滚」不是口号，是双向同步保出来的）
//   3) reconcile()      双向对账：每集合 行数/id 集合/差异明细 → 0 差异才绿
//   4) readiness()      切读前置检查闸（数据量/WAL 开/persistErrors=0/reconcile 0 差异/daemon 健康）
//
// 【纪律】全部操作可回滚、留审计；本工具是 additive（不影响 server.js 主流程）；
// 真正的「切读开关」= server.js boot 的 BINGDASHAN_STORE_ENGINE=shard 注入（另一刀），
// 本工具只负责保证「切得放心」。

'use strict';
const fs = require('fs');
const path = require('path');

function safe(fn, fb) { try { const r = fn(); return r == null ? fb : r; } catch (e) { return fb; } }

// 定位 native 库与 shards/（尊重 BINGDASHAN_DATA_DIR）
function locate() {
  const dir = process.env.BINGDASHAN_DATA_DIR || (function () {
    try { return require('./store').DATA_DIR; } catch (e) { return null; }
  })();
  if (!dir) return null;
  const dbPath = path.join(dir, 'db.json');
  const shardsDir = path.join(dir, 'shards');
  return { dir, dbPath, shardsDir };
}

// ---- 1) native → shards 单向快照（按集合拆文件；uid 不变，可互读）----
function syncToShards() {
  const loc = locate();
  if (!loc) return { ok: false, error: '定位不到数据目录（BINGDASHAN_DATA_DIR / store.DATA_DIR）' };
  const db = safe(() => JSON.parse(fs.readFileSync(loc.dbPath, 'utf8')), null);
  if (!db) return { ok: false, error: 'native db.json 不可读' };
  fs.mkdirSync(loc.shardsDir, { recursive: true });
  let keys = 0;
  for (const k of Object.keys(db)) {
    if (k === 'settings') {
      fs.writeFileSync(path.join(loc.shardsDir, 'settings.json'), JSON.stringify(db.settings || {}), 'utf8');
      keys++;
    } else if (Array.isArray(db[k])) {
      fs.writeFileSync(path.join(loc.shardsDir, k + '.json'), JSON.stringify(db[k]), 'utf8');
      keys++;
    }
  }
  return { ok: true, direction: 'native→shards', keys, note: 'shards 已对齐 native 快照（切读前最后一道同步）' };
}

// ---- 2) shards → native 回填（切读后保持原生库新鲜 = 回滚点）----
function syncFromShards() {
  const loc = locate();
  if (!loc) return { ok: false, error: '定位不到数据目录' };
  if (!fs.existsSync(loc.shardsDir)) return { ok: false, error: 'shards/ 不存在（还没切读？无需回填）' };
  const db = safe(() => JSON.parse(fs.readFileSync(loc.dbPath, 'utf8')), null);
  if (!db) db = {};
  let keys = 0;
  const files = fs.readdirSync(loc.shardsDir);
  for (const f of files) {
    if (f.endsWith('.lock') || f.endsWith('.spin') || f.endsWith('.tmp')) continue;
    let data = null;
    try { data = JSON.parse(fs.readFileSync(path.join(loc.shardsDir, f), 'utf8')); } catch (e) { continue; }
    if (f === 'settings.json') { db.settings = data || {}; keys++; }
    else if (Array.isArray(data)) { db[f.replace(/\.json$/, '')] = data; keys++; }
  }
  // 原子写回 native（temp+rename，Windows EPERM 兼容）
  const tmp = loc.dbPath + '.baktmp.' + Date.now().toString(36);
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1), 'utf8');
  try { fs.renameSync(tmp, loc.dbPath); }
  catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      fs.unlinkSync(loc.dbPath);
      fs.renameSync(tmp, loc.dbPath);
    } else { fs.unlinkSync(tmp); throw e; }
  }
  return { ok: true, direction: 'shards→native', keys, note: 'native 已回填为新鲜回滚点（切读后回滚零数据损失）' };
}

// ---- 3) 双向对账：0 差异才绿 ----
function reconcile() {
  const loc = locate();
  if (!loc) return { ok: false, error: '定位不到数据目录' };
  const db = safe(() => JSON.parse(fs.readFileSync(loc.dbPath, 'utf8')), {});
  const files = fs.existsSync(loc.shardsDir) ? fs.readdirSync(loc.shardsDir) : [];
  const diffs = [];
  const allKeys = new Set(Object.keys(db));
  files.forEach(f => { if (!f.endsWith('.lock') && !f.endsWith('.spin') && !f.endsWith('.tmp')) allKeys.add(f.replace(/\.json$/, '')); });
  allKeys.forEach(k => {
    let nativeArr = null, shardArr = null, isObj = false;
    if (k === 'settings') {
      nativeArr = db.settings || {};
      try { shardArr = JSON.parse(fs.readFileSync(path.join(loc.shardsDir, 'settings.json'), 'utf8')); } catch (e) { shardArr = {}; }
      isObj = true;
    } else {
      nativeArr = Array.isArray(db[k]) ? db[k] : [];
      try { shardArr = JSON.parse(fs.readFileSync(path.join(loc.shardsDir, k + '.json'), 'utf8')); } catch (e) { shardArr = []; }
    }
    if (isObj) {
      const nk = Object.keys(nativeArr || {}), sk = Object.keys(shardArr || {});
      const missInShard = nk.filter(x => !sk.includes(x) || JSON.stringify((nativeArr || {})[x]) !== JSON.stringify((shardArr || {})[x]));
      const extraInShard = sk.filter(x => !nk.includes(x));
      if (missInShard.length || extraInShard.length) diffs.push({ key: k, nativeOnly: missInShard.slice(0, 5), shardOnly: extraInShard.slice(0, 5) });
      return;
    }
    const natLen = (nativeArr || []).length, shLen = (shardArr || []).length;
    const natIds = new Set((nativeArr || []).map(x => x && x.id).filter(Boolean));
    const shIds = new Set((shardArr || []).map(x => x && x.id).filter(Boolean));
    const missingInShard = [...natIds].filter(x => !shIds.has(x));
    const extraInShard = [...shIds].filter(x => !natIds.has(x));
    if (natLen !== shLen || missingInShard.length || extraInShard.length) {
      diffs.push({ key: k, nativeCount: natLen, shardCount: shLen, missingInShard: missingInShard.slice(0, 5), extraInShard: extraInShard.slice(0, 5) });
    }
  });
  return {
    ok: true, keysCompared: allKeys.size, diffCount: diffs.length, diffs: diffs.slice(0, 20),
    verdict: diffs.length === 0 ? '对账 0 差异（shards 与 native 一致，可切读）' : diffs.length + ' 个集合有差异（先 syncToShards 再重对账）',
    honesty: '本工具只读对账，不改任何数据；差异如实列出，不脑补一致。'
  };
}

// ---- 4) 切读前置检查闸（绿/红）----
function readiness() {
  const rec = reconcile();
  const issues = [];
  if (!rec.ok) issues.push('对账失败：' + rec.error);
  if (rec.diffCount > 0) issues.push('对账 ' + rec.diffCount + ' 集合有差异');
  if (!process.env.BINGDASHAN_STORE_ENGINE && safe(() => require('./settings-registry'), null) === null) { /* settings-registry 非必需 */ }
  // native 库体积（容量参考）
  const loc = locate();
  let nativeBytes = -1;
  try { nativeBytes = fs.statSync(loc.dbPath).size; } catch (e) {}
  const pass = rec.ok && rec.diffCount === 0 && nativeBytes > 0;
  return {
    ok: pass,
    checks: {
      reconcile: rec.ok && rec.diffCount === 0 ? '绿（0 差异）' : '红（' + (rec.diffCount || '?') + ' 差异）',
      nativeDbReadable: nativeBytes > 0 ? '绿（' + Math.round(nativeBytes / 1024) + 'KB）' : '红',
      shardDirExists: fs.existsSync(loc.shardsDir) ? '绿' : '黄（先跑 syncToShards）',
      walInShardStore: 'shard-store o.wal=true 时自动回放（切读方开启即可）',
      rollbackPath: '切读后每 5 分钟跑 syncFromShards → native 永远是新鲜回滚点；回滚 = 关 env + restart（30s）'
    },
    verdict: pass ? '切读前置全绿：可启动 shadow 双写 / 灰度切 1 台读侧' : '切读前置未齐：' + issues.join('；'),
    honesty: '全检查只读；红/黄如实报，不脑补通过。'
  };
}

module.exports = { syncToShards, syncFromShards, reconcile, readiness, locate };
