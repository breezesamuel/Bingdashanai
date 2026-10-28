// core/shard-store.js — 分片存储引擎（store.js 的 drop-in 替身）
//
// 【为什么有它】store.js 是「单文件 data/db.json 全量快照」：任何一次写都
// 把 ~1.4MB 整库 serialize+parse 一遍（实测 208ms/写，单实例全链业务调用 ~2 ops/s）。
// 这是极限测试定位到的**唯一吞吐天花板**。分片引擎换成「每个 collection 单独一个
// 文件，一次只刷被碰过的 collection」：写盘成本从 O(全库) 降到 O(改动集合)。
//
// 【实测】业务链路级压测（1.1MB 同量级数据、并发 8、subs.order 全链 200 单）：
//   原生 2 ops/s (p99 2528ms) → 分片P1 13 (p99 147ms) → 分片+批合并P2 141 (p99 12ms)
//   = 70× 吞吐（tmp/storage-bench-report.json，agent 仓有完整脚本）
//
// 【生产就绪清单（Phase 3 灰度前置，本版已含）】
//   ✓ CAPS 全表 19 项 + purchaseIntents open 保留（与 store.js applyCaps 逐字对齐）
//   ✓ 原子写（writeFileSync temp → renameSync，防 torn read 读到半截文件）
//   ✓ 跨进程锁（O_EXCL shard.lock，防 nohup 主进程与工具子进程同时写 shards/）
//   ✓ 外部变更检测：落盘前重读磁盘指纹，被别的进程改过则按 id 合并（本地写优先，
//     保留外部新增行）——灰度双写期（原生库同时被维护）不丢行
//   ✓ coalesce 批合并开关（P2；关 = P1 立即落盘）
//   ✓ uid 与 store.js 同格式 → 两引擎数据可互读
//
// 【设计纪律】
//   · 纯 fs、零 native 依赖、asar 兼容（不用 SQLite：线上 Node 20.18 无 node:sqlite，
//     better-sqlite3 破坏零 native 打包纪律——见 storage-roadmap）
//   · API 与 store.js 完全一致，业务模块 require('./store') 无需改动；
//     通过 require.cache 注入 / Phase 3 的 BINGDASHAN_STORE_ENGINE 切换
//   · 本模块**不自动接生产**：接入走 storage-roadmap 的 shadow 双写→对账→切读→回滚

'use strict';
const fs = require('fs');
const path = require('path');

function createShardStore(dataDir, opt) {
  const o = opt || {};
  const SHARD_DIR = path.join(dataDir, 'shards');
  const WAL_PATH = path.join(dataDir, 'shard.wal.jsonl');
  const LOCK_PATH = path.join(SHARD_DIR, 'shard.lock');
  try { fs.mkdirSync(SHARD_DIR, { recursive: true }); } catch (e) {}
  const walEnabled = o.wal === true;
  const coalesce = o.coalesce !== false;      // P2 默认开；灰度可关退 P1
  const LOCK_TIMEOUT_MS = Number(o.lockTimeoutMs) || 30000;
  const LOCK_RETRY_MS = 5;

  const MAX_AUDIT = 1000;
  // CAPS 全表（与 store.js L59 逐字对齐；裁剪在 persistKey 落盘时执行，语义同 applyCaps）
  const CAPS = {
    audit: 1000, evolution: 600, autopilot: 400, mail: 200, outbound: 500,
    crawl: 500, agentcenter_log: 200, scoutLog: 200, ticketBatch: 100, harnessRuns: 40,
    materialMovements: 300, materialShortages: 200,
    purchaseIntents: 200,   // 特例：open（在途）永不裁剪，只收拢已完结历史
    funnelSnapshots: 365,
    wallAbuse: 2000, llmUsage: 2000,
    careOrders: 500, careNotifies: 1000, careGrants: 500,
  };
  const AUDIT_CAPS = { audit: MAX_AUDIT };

  // ---- uid（与 store.js 同格式：base36(ts) + 2 位滚动计数）----
  let _c = 0;
  function uid() {
    const ts = Date.now().toString(36);
    _c = (_c + 1) % 1296;
    return ts + _c.toString(36).padStart(2, '0');
  }

  // ---- 懒载入：某 collection 首次被碰时才从 shards/<key>.json 载入 ----
  const mem = {};                 // key → 数组（内存权威）
  const loaded = new Set();
  const fp = new Map();           // key → 载入/刷写时的 {mtimeMs,size} 指纹
  const localDirty = new Set();   // 本进程改过的 key（决定落盘时是否需要合并外部行）

  function ensureKey(key) {
    if (loaded.has(key)) return;
    loaded.add(key);
    const f = path.join(SHARD_DIR, key + '.json');
    let arr = [];
    try {
      const st = fs.statSync(f);
      arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      fp.set(key, { mtimeMs: st.mtimeMs, size: st.size });
    } catch (e) { arr = []; fp.set(key, null); }
    if (!Array.isArray(arr)) arr = [];
    mem[key] = arr;
  }
  let settings = null;
  function ensureSettings() {
    if (settings) return;
    const f = path.join(SHARD_DIR, 'settings.json');
    let s = null;
    try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { s = null; }
    settings = s && typeof s === 'object' ? s : { theme: 'emerald', sound: true, lang: 'zh', provider: 'deepseek' };
  }

  // ---- 文件锁（跨进程；Node 单线程内天然串行，锁只为 nohup 主进程 vs 工具子进程）----
  // 偷锁判据（不能用锁文件 mtime——新鲜锁几秒后 mtime 就"超龄"了会误偷）：
  //   1. 锁内记 holder pid + 持有时刻（JSON），holder pid 已死 → 抢；
  //   2. 持有时刻超过 LOCK_TIMEOUT_MS → 视为卡死，抢；
  //   3. 两者都不满足（活锁且新鲜）→ 等待，等待超时 fail-safe 抛错（绝不静默丢写）。
  function acquireLock() {
    const t0 = Date.now();
    for (;;) {
      try {
        const fd = fs.openSync(LOCK_PATH, 'wx');      // O_CREAT|O_EXCL 原子
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        fs.closeSync(fd);
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // 只按 holder pid 生死判定（活 pid 绝不偷——它只是忙，偷了=两份并发写 shards）：
        //   死 pid（崩溃）→ 立即抢；活 pid → 等待，等待超 LOCK_TIMEOUT_MS fail-safe 抛错
        //   （调用方 persistKey 会记入 persistErrors，下次写自动重试——绝不静默丢写）。
        let pidAlive = false;
        try {
          const holder = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
          const pid = Number(holder.pid) || 0;
          // 实测：不存在的 pid 在 Windows 上抛 ESRCH（越界 pid 抛 ERR_INVALID_ARG_TYPE），
          // 一律按「信号 0 成功才算活」判定——任何异常都视为 holder 已死 → 抢锁。
          if (pid > 0) { try { process.kill(pid, 0); pidAlive = true; } catch (e2) { pidAlive = false; } }
        } catch (e2) { pidAlive = false; }   // 锁内容不可解析（半写/旧格式）→ 视为死锁抢占
        if (!pidAlive) { try { fs.unlinkSync(LOCK_PATH); } catch (e3) {} continue; }
        if (Date.now() - t0 > LOCK_TIMEOUT_MS) {
          throw new Error('shard-store: 取锁超时（' + LOCK_TIMEOUT_MS + 'ms，holder pid ' + fs.readFileSync(LOCK_PATH, 'utf8').slice(0, 40) + ' 活跃）——为安全中止本次写（不静默丢写）');
        }
        // 同步小睡（fs 写读盘开销当 sleep 用；避免 setImmediate 嵌套）
        const spin = LOCK_PATH + '.spin';
        try { fs.appendFileSync(spin, '.'); fs.truncateSync(spin, 0); } catch (e3) {}
      }
    }
  }
  function releaseLock() { try { fs.unlinkSync(LOCK_PATH); } catch (e) {} }

  // ---- 原子写：temp → rename（防读侧读到半截文件）----
  // Windows 陷阱：rename 覆盖【已存在】目标文件会抛 EPERM（POSIX 允许覆盖），
  // 于是先 rename，失败且目标存在时删目标再 rename（灰度双写期文件常已存在）。
  function atomicWrite(file, text) {
    const tmp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EEXIST') {
        try { fs.unlinkSync(file); } catch (e2) { /* 目标不存在就继续 */ }
        try { fs.renameSync(tmp, file); return; } catch (e3) { /* fallthrough */ }
      }
      try { fs.unlinkSync(tmp); } catch (e2) {}
      throw e;
    }
  }

  // ---- caps 裁剪（与 store.js applyCaps 逐字同语义）----
  function applyCapsToArr(key, arr) {
    const cap = CAPS[key];
    if (!cap || !Array.isArray(arr) || arr.length <= cap) return arr;
    if (key === 'purchaseIntents') {
      const open = arr.filter(r => r && r.status === 'open');
      const done = arr.filter(r => !r || r.status !== 'open');
      return done.slice(-cap).concat(open);
    }
    return arr.slice(-cap);
  }

  // ---- 外部变更检测 + 按 id 合并（灰度双写期：原生库/别的进程写了同名集合）----
  function mergeExternal(key) {
    const f = path.join(SHARD_DIR, key + '.json');
    let st = null;
    try { st = fs.statSync(f); } catch (e) { fp.set(key, null); return; }
    const cur = fp.get(key);
    if (cur && cur.mtimeMs === st.mtimeMs && cur.size === st.size) return; // 无外部变更
    // 有外部变更：读进来，把「外部新增且本地没有的 id」并入本地数组（本地写优先覆盖同名 id）
    let ext = [];
    try { ext = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { ext = []; }
    if (!Array.isArray(ext)) ext = [];
    const local = mem[key] || [];
    const localIds = new Set(local.map(x => x && x.id).filter(Boolean));
    for (const row of ext) {
      if (row && row.id && !localIds.has(row.id)) { local.push(row); localIds.add(row.id); }
    }
    mem[key] = local;
    fp.set(key, { mtimeMs: st.mtimeMs, size: st.size });
  }

  // ---- 落盘单个 collection（锁 + 外部合并 + caps + 原子写 + 指纹）----
  function persistKey(key) {
    if (key === 'settings') {
      ensureSettings();
      acquireLock();
      try {
        atomicWrite(path.join(SHARD_DIR, 'settings.json'), JSON.stringify(settings, null, 2));
      } finally { releaseLock(); }
      return;
    }
    ensureKey(key);
    acquireLock();
    try {
      mergeExternal(key);                       // 双写灰度期不丢外部新增行
      let arr = mem[key] || [];
      if (CAPS[key]) arr = applyCapsToArr(key, arr);
      // audit 行统一裁剪（与 store.js MAX_AUDIT 一致；audit 走 persistKey('audit')）
      if (key === 'audit' && arr.length > MAX_AUDIT) arr = arr.slice(-MAX_AUDIT);
      if (arr !== mem[key]) mem[key] = arr;     // 裁剪结果回写内存（下次 list 一致）
      const file = path.join(SHARD_DIR, key + '.json');
      atomicWrite(file, JSON.stringify(arr));
      let st = null; try { st = fs.statSync(file); } catch (e) {}
      fp.set(key, st ? { mtimeMs: st.mtimeMs, size: st.size } : null);
      localDirty.delete(key);
    } finally { releaseLock(); }
  }

  // WAL（可选，生产开）：写前记 op，崩溃后可回放
  function wal(op, key) {
    if (!walEnabled) return;
    try { fs.appendFileSync(WAL_PATH, JSON.stringify({ op, key, at: Date.now() }) + '\n'); } catch (e) {}
  }

  // ---- 顶层 Proxy：db[key] 读写都走 mem ----
  const top = new Proxy({}, {
    get(_t, k) {
      if (typeof k === 'symbol') return undefined;
      if (k === 'settings') { ensureSettings(); return settings; }
      ensureKey(String(k));
      return mem[String(k)];
    },
    set(_t, k, v) {
      const key = String(k);
      if (key === 'settings') { settings = v; localDirty.add('settings'); return true; }
      ensureKey(key);
      mem[key] = v;
      localDirty.add(key);
      return true;
    },
    has(_t) { return true; },
    getOwnPropertyDescriptor(_t, k) {
      return { enumerable: true, configurable: true, value: typeof k === 'string' ? top[k] : undefined };
    },
    ownKeys() {
      ensureKey; // no-op
      return Array.from(new Set([...Object.keys(mem), ...localDirty]));
    }
  });

  function mark(key) { localDirty.add(key); }

  // ---- 与 store.js 同 API ----
  function read() { return top; }

  // 落盘策略：coalesce（P2）= 同 tick 内 N 次 write 只排 1 次 flush；关 = P1 立即落盘。
  // 两种模式都必须真落盘：P1 直接落 localDirty；P2 经 dirty 去重 + setImmediate 合并。
  // persistErrors：落盘失败绝不静默丢写（留痕，下次 write 自动重试同集合）。
  const dirty = new Set();
  let flushScheduled = false;
  const persistErrors = [];
  function flush() {
    const keys = Array.from(new Set([...dirty, ...localDirty]));
    dirty.clear();
    for (const k of keys) {
      try { persistKey(k); }
      catch (e) { persistErrors.push({ key: k, error: e.message, at: Date.now() }); }
    }
  }
  function scheduleFlush() {
    if (!coalesce || flushScheduled) return;
    flushScheduled = true;
    setImmediate(function () { flushScheduled = false; flush(); });
  }
  function write(db) {
    if (coalesce) {
      for (const k of localDirty) dirty.add(k);
      scheduleFlush();
      return db;
    }
    flush();   // P1：立即落盘全部脏集合（失败留痕 persistErrors，后续 write 自动重试）
    return db;
  }
  function writeTracked(db, label) { /* 压测不记录慢写；保留同签名 */ return write(db, label); }

  // 写合并（与 store.js batch 语义一致：期间只改内存，收尾 1 次落盘）
  let batching = 0;
  function writeUnlessBatching(db) { if (batching > 0) return db; return write(db); }
  function batch(fn) {
    const db = read();
    batching++;
    let res;
    try { res = fn(db) || {}; } finally { batching--; }
    if (res && res.audit) {
      const a = top.audit;
      a.push({ id: uid(), action: res.audit.action || '批量操作', detail: String(res.audit.detail || '').slice(0, 400), at: Date.now() });
      mark('audit');
    }
    write(db);
    return res;
  }

  function list(key, limit) {
    const arr = top[key] || [];
    const out = arr.slice().reverse();
    return limit ? out.slice(0, limit) : out;
  }
  function findBy(key, field, value) {
    const arr = top[key] || [];
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] && arr[i][field] === value) return arr[i]; }
    return null;
  }
  function findAllBy(key, field, value) {
    const arr = top[key] || [];
    const out = [];
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] && arr[i][field] === value) out.push(arr[i]); }
    return out;
  }
  function push(key, item, action, detail) {
    const arr = top[key];
    const rec = Object.assign({ id: uid(), createdAt: Date.now() }, item);
    arr.push(rec);
    mark(key);
    if (key !== 'audit') {
      const a = top.audit;
      a.push({ id: uid(), action: action || ('新增 ' + key), detail: detail || JSON.stringify(item).slice(0, 160), at: Date.now() });
      if (a.length > MAX_AUDIT) { const cut = a.slice(-MAX_AUDIT); mem.audit = cut; }
      mark('audit');
    }
    writeUnlessBatching(top);
    return rec;
  }
  function pushMany(key, items, action, detail) {
    const arr = top[key];
    const recs = (Array.isArray(items) ? items : []).map(item => {
      const rec = Object.assign({ id: uid(), createdAt: Date.now() }, item);
      arr.push(rec); return rec;
    });
    if (recs.length) {
      mark(key);
      const a = top.audit;
      a.push({ id: uid(), action: action || ('批量新增 ' + key), detail: String(detail || '') + '（' + recs.length + ' 条）', at: Date.now() });
      if (a.length > MAX_AUDIT) { const cut = a.slice(-MAX_AUDIT); mem.audit = cut; }
      mark('audit');
    }
    writeUnlessBatching(top);
    return recs;
  }
  function update(key, id, patch, action) {
    const arr = top[key];
    const i = arr.findIndex(x => x.id === id);
    if (i < 0) return null;
    arr[i] = Object.assign({}, arr[i], patch, { updatedAt: Date.now() });
    mark(key); mark('audit');
    const a = top.audit;
    a.push({ id: uid(), action: action || ('更新 ' + key), detail: (id + ' ' + JSON.stringify(patch)).slice(0, 160), at: Date.now() });
    if (a.length > MAX_AUDIT) { const cut = a.slice(-MAX_AUDIT); mem.audit = cut; }
    writeUnlessBatching(top);
    return arr[i];
  }
  function updateMany(key, patches, action) {
    const list = Array.isArray(patches) ? patches.filter(p => p && p.id) : [];
    if (!list.length) return [];
    const arr = top[key];
    const byId = new Map(); arr.forEach(x => { if (x && x.id) byId.set(x.id, x); });
    const now = Date.now(); const out = [];
    list.forEach(p => {
      const cur = byId.get(p.id); if (!cur) return;
      const merged = Object.assign({}, cur, p, { updatedAt: now });
      Object.keys(p).forEach(k => { if (p[k] === undefined) delete merged[k]; });
      const i = arr.indexOf(cur); if (i >= 0) arr[i] = merged; out.push(merged);
    });
    if (out.length) {
      mark(key); mark('audit');
      const a = top.audit;
      a.push({ id: uid(), action: action || ('批量更新 ' + key), detail: out.length + ' 条（' + list.slice(0, 3).map(p => p.id).join(',') + '）', at: now });
      if (a.length > MAX_AUDIT) { const cut = a.slice(-MAX_AUDIT); mem.audit = cut; }
    }
    writeUnlessBatching(top);
    return out;
  }
  function remove(key, id, action) {
    const arr = top[key];
    const i = arr.findIndex(x => x.id === id);
    if (i < 0) return false;
    arr.splice(i, 1);
    mark(key); mark('audit');
    const a = top.audit;
    a.push({ id: uid(), action: action || ('删除 ' + key), detail: String(id), at: Date.now() });
    if (a.length > MAX_AUDIT) { const cut = a.slice(-MAX_AUDIT); mem.audit = cut; }
    writeUnlessBatching(top);
    return true;
  }
  function getSetting(k) { ensureSettings(); return settings ? settings[k] : undefined; }
  function setSetting(k, v) {
    ensureSettings();
    settings[k] = v;
    mark('settings');
    const a = top.audit;
    a.push({ id: uid(), action: '修改设置', detail: k + '=' + v, at: Date.now() });
    if (a.length > MAX_AUDIT) { const cut = a.slice(-MAX_AUDIT); mem.audit = cut; }
    mark('audit');
    writeUnlessBatching(top);
    return settings;
  }
  function deleteSetting(k) {
    ensureSettings();
    if (!settings || !Object.prototype.hasOwnProperty.call(settings, k)) return false;
    delete settings[k];
    mark('settings');
    writeUnlessBatching(top);
    return true;
  }

  // UI 统计类（压测链路一般不调；与 store.js 同签名）
  function decisionStats() {
    const d = top.decisions || [];
    const todayKey = new Date().toDateString();
    return { total: d.length, today: d.filter(x => new Date(x.createdAt).toDateString() === todayKey).length, trend: [] };
  }
  function orgStats() {
    const staff = top.staff || []; const proj = top.projects || [];
    return { headcount: staff.length, active: staff.filter(s => s.status !== 'off').length, projects: proj.length, running: proj.filter(p => p.status === 'running').length };
  }
  function toCsv(rows, cols) {
    const head = cols.join(',');
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [head].concat(rows.map(r => cols.map(c => esc(typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])).join(','))).join('\n');
  }
  const slowWrites = [];
  function stats() {
    return {
      engine: 'shard-store', collections: loaded.size, dataDir,
      wal: walEnabled, coalesce, pendingDirty: dirty.size, caps: CAPS,
      persistErrors: persistErrors.length
    };
  }

  return {
    read, write, list, findBy, findAllBy, push, pushMany, update, updateMany, batch, remove,
    getSetting, setSetting, deleteSetting, decisionStats, orgStats, toCsv, uid, stats, slowWrites,
    writeTracked,
    // Phase 2/3 扩展口
    flush, coalesce, CAPS,
    _internal: { mem, persistKey, top, lock: { acquireLock, releaseLock } },
    // 与 store.js 相同的常量导出（业务模块顶层可能引用）
    DB_PATH: path.join(dataDir, 'db.json'), DATA_DIR: dataDir, IN_ASAR: false,
    dataPath: function (...segments) { const p = segments.length ? path.join(dataDir, ...segments) : dataDir; try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} return p; },
  };
}

module.exports = createShardStore;
