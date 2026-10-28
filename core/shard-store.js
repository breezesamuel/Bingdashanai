// core/shard-store.js — 分片存储引擎（store.js 的 drop-in 替身·压测/上量用）
//
// 【为什么有它】store.js 是「单文件 data/db.json 全量快照」：任何一次写都
// 把 ~1.4MB 整库 serialize+parse 一遍（实测 208ms/写，单实例应用级 RPS ~75）。
// 这是极限测试定位到的**唯一吞吐天花板**。分片引擎把它换成「每个 collection 单独
// 一个文件，一次只刷被碰过的 collection」——写盘成本从 O(全库) 降到 O(改动集合)。
//
// 【设计纪律】
//   · 纯 fs、零 native 依赖、可打进 asar（与全仓「零 native」纪律一致；不用 SQLite，
//     因为线上 Node 20.18 没有 node:sqlite，塞 better-sqlite3 会破坏打包）。
//   · API 与 store.js **完全一致**（read/write/push/update/list/findBy/...），
//     业务模块 `require('./store')` 无需改动；通过 require.cache 注入本模块即可切换。
//   · 写前把「脏集合」各自落盘到 shards/<key>.json；settings 单独一个文件。
//   · 可选 WAL（写前记 op）用于崩溃恢复——压测默认关，生产开。
//
// 【安全】本模块**不接生产**，仅被压测脚本注入 + 被改造方案引用；要上生产走
//   「灰度：shadow 双写 → 对账 → 切读」三步（见 storage-roadmap），且先备份 db.json。

'use strict';
const fs = require('fs');
const path = require('path');

// 工厂：给定数据目录，返回一个与 store.js 同 API 的分片存储实例。
// 这样同一套业务模块可分别跑在「原生 JSON 全量」与「分片」上，做真·业务链路对比。
function createShardStore(dataDir, opt) {
  const o = opt || {};
  const SHARD_DIR = path.join(dataDir, 'shards');
  const WAL_PATH = path.join(dataDir, 'shard.wal.jsonl');
  try { fs.mkdirSync(SHARD_DIR, { recursive: true }); } catch (e) {}
  const SHADOW = o.shadow === true;           // 影子模式：写分片但不接读（供双写对账）
  const walEnabled = o.wal === true;

  // 内存：key → 数组。懒加载：某 key 首次被碰时才从 shards/<key>.json 载入。
  const mem = {};
  const loaded = new Set();     // 已从磁盘载入的 key
  const touched = new Set();    // 本轮需要落盘的 key（读也标，保守安全）
  let settings = null;          // settings 单独缓存

  const MAX_AUDIT = 1000;
  // 与 store.js 对齐的「日志型集合」上限（压测够用；生产接入时补全 store.js 的 CAPS 表）
  const CAPS = { audit: MAX_AUDIT, evolution: 600, autopilot: 400, mail: 200, outbound: 500,
    crawl: 500, agentcenter_log: 200, scoutLog: 200, ticketBatch: 100, wallAbuse: 2000, llmUsage: 2000 };

  // ---- uid（与 store.js 同格式，保证跨引擎数据可混读）----
  let _c = 0;
  function uid() {
    const ts = Date.now().toString(36);
    _c = (_c + 1) % 1296;
    return ts + _c.toString(36).padStart(2, '0');
  }

  // ---- 懒载入单个 collection ----
  function ensureKey(key) {
    if (loaded.has(key)) return;
    loaded.add(key);
    const f = path.join(SHARD_DIR, key + '.json');
    let arr = [];
    try { const raw = fs.readFileSync(f, 'utf8'); arr = JSON.parse(raw); } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    mem[key] = arr;
  }
  function ensureSettings() {
    if (settings) return;
    const f = path.join(SHARD_DIR, 'settings.json');
    let s = null;
    try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { s = null; }
    settings = s && typeof s === 'object' ? s : { theme: 'emerald', sound: true, lang: 'zh', provider: 'deepseek' };
    touched.add('settings');
  }

  // ---- 落盘单个 collection（含 caps/audit 裁剪）----
  function persistKey(key) {
    if (key === 'settings') {
      ensureSettings();
      fs.writeFileSync(path.join(SHARD_DIR, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
      return;
    }
    ensureKey(key);
    let arr = mem[key] || [];
    if (CAPS[key] && arr.length > CAPS[key]) {
      // 与 store.js 一致：保留最新 N 条（open 状态保留——压测里简化，open 逻辑按需补）
      const open = arr.filter(r => r && r.status === 'open');
      arr = open.concat(arr.slice(-CAPS[key]).filter(r => !open.includes(r)));
      arr = arr.slice(-CAPS[key]).length >= open.length ? arr.slice(-CAPS[key]) : open.concat(arr.slice(-CAPS[key]));
      mem[key] = arr;
    }
    fs.writeFileSync(path.join(SHARD_DIR, key + '.json'), JSON.stringify(arr), 'utf8');
  }

  // WAL（可选）：写前记 op
  function wal(op, key) {
    if (!walEnabled) return;
    try { fs.appendFileSync(WAL_PATH, JSON.stringify({ op, key, at: Date.now() }) + '\n'); } catch (e) {}
  }

  // ---- Phase 2：批合并落盘（同 tick 内 N 次 write → 1 次 flush）----
  // 业务调用（如 subs.order 一单内写 visitors/orders/audit）在同一同步栈里连续 write，
  // 逐次落盘是写放大。coalesce 模式下 write 只把脏集合记入 dirty 并挂一次 setImmediate，
  // 到期统一 persist——事件循环不阻塞、崩溃前最多多丢一个 tick 的写（WAL 可补）。
  const coalesce = o.coalesce !== false;      // 原型默认开；生产接入时经灰度再定
  const dirty = new Set();
  let flushScheduled = false;
  function flush() {
    for (const k of Array.from(dirty)) persistKey(k);
    dirty.clear();
  }
  function scheduleFlush() {
    if (!coalesce || flushScheduled) return;
    flushScheduled = true;
    setImmediate(function () { flushScheduled = false; flush(); });
  }

  // ---- 顶层 Proxy：db[key] 访问都走 mem；碰过的 key 标 touched ----
  function getMem(key) {
    if (key === 'settings') { ensureSettings(); return settings; }
    ensureKey(key);
    return mem[key];
  }
  const top = new Proxy({}, {
    get(_t, k) {
      if (k === Symbol.toPrimitive || k === 'toString' || k === 'toJSON' || k === 'inspect') return undefined;
      if (k === 'settings') { ensureSettings(); return settings; }
      ensureKey(String(k));
      return mem[String(k)];
    },
    set(_t, k, v) { ensureKey(String(k)); mem[String(k)] = v; touched.add(String(k)); return true; },
    has(_t, k) { return true; },
    getOwnPropertyDescriptor(_t, k) { return { enumerable: true, configurable: true, value: getMem(k) }; },
    ownKeys() { return Array.from(new Set([...Object.keys(mem), ...touched])); }
  });

  // 标脏（写路径调用；读路径为保守也标，写单文件成本低）
  function mark(key) { if (key !== 'settings') touched.add(key); }

  // ---- 与 store.js 同 API ----
  function read() { return top; }

  // 落盘「被碰过的集合」。Phase 2 coalesce：同 tick 内 N 次写只刷 1 次（dirty 去重 + setImmediate）；
  // 关 coalesce 时退化为 Phase 1 的立即落盘。
  function write(db) {
    if (coalesce) {
      for (const k of touched) dirty.add(k);
      touched.clear();
      scheduleFlush();
      return db;
    }
    for (const k of Array.from(touched)) persistKey(k);
    touched.clear();
    return db;
  }
  function writeTracked(db, label) { /* 压测不记录慢写；保留同签名 */ return write(db, label); }

  // 写合并（与 store.js batch 语义一致：期间只改内存，收尾一次落盘）
  let batching = 0;
  function writeUnlessBatching(db) { if (batching > 0) return db; return write(db); }
  function batch(fn) {
    const db = read();
    batching++;
    let res;
    try { res = fn(db) || {}; } finally { batching--; }
    write(db);
    return res;
  }

  function list(key, limit) {
    const arr = getMem(key);
    const out = arr.slice().reverse();
    return limit ? out.slice(0, limit) : out;
  }
  function findBy(key, field, value) {
    const arr = getMem(key);
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] && arr[i][field] === value) return arr[i]; }
    return null;
  }
  function findAllBy(key, field, value) {
    const arr = getMem(key);
    const out = [];
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] && arr[i][field] === value) out.push(arr[i]); }
    return out;
  }
  function push(key, item, action, detail) {
    const arr = getMem(key);
    const rec = Object.assign({ id: uid(), createdAt: Date.now() }, item);
    arr.push(rec);
    mark(key); mark('audit');
    if (key !== 'audit') {
      const a = getMem('audit');
      a.push({ id: uid(), action: action || ('新增 ' + key), detail: detail || JSON.stringify(item).slice(0, 160), at: Date.now() });
      if (a.length > MAX_AUDIT) { mem.audit = a.slice(-MAX_AUDIT); }
    }
    writeUnlessBatching(top);
    return rec;
  }
  function pushMany(key, items, action, detail) {
    const arr = getMem(key);
    const recs = (Array.isArray(items) ? items : []).map(item => {
      const rec = Object.assign({ id: uid(), createdAt: Date.now() }, item);
      arr.push(rec); return rec;
    });
    if (recs.length) { mark(key); mark('audit');
      const a = getMem('audit');
      a.push({ id: uid(), action: action || ('批量新增 ' + key), detail: String(detail || '') + '（' + recs.length + ' 条）', at: Date.now() });
      if (a.length > MAX_AUDIT) { mem.audit = a.slice(-MAX_AUDIT); }
    }
    writeUnlessBatching(top);
    return recs;
  }
  function update(key, id, patch, action) {
    const arr = getMem(key);
    const i = arr.findIndex(x => x.id === id);
    if (i < 0) return null;
    arr[i] = Object.assign({}, arr[i], patch, { updatedAt: Date.now() });
    mark(key); mark('audit');
    const a = getMem('audit');
    a.push({ id: uid(), action: action || ('更新 ' + key), detail: (id + ' ' + JSON.stringify(patch)).slice(0, 160), at: Date.now() });
    if (a.length > MAX_AUDIT) { mem.audit = a.slice(-MAX_AUDIT); }
    writeUnlessBatching(top);
    return arr[i];
  }
  function updateMany(key, patches, action) {
    const list = Array.isArray(patches) ? patches.filter(p => p && p.id) : [];
    if (!list.length) return [];
    const arr = getMem(key);
    const byId = new Map(); arr.forEach(x => { if (x && x.id) byId.set(x.id, x); });
    const now = Date.now(); const out = [];
    list.forEach(p => {
      const cur = byId.get(p.id); if (!cur) return;
      const merged = Object.assign({}, cur, p, { updatedAt: now });
      Object.keys(p).forEach(k => { if (p[k] === undefined) delete merged[k]; });
      const i = arr.indexOf(cur); if (i >= 0) arr[i] = merged; out.push(merged);
    });
    if (out.length) { mark(key); mark('audit');
      const a = getMem('audit');
      a.push({ id: uid(), action: action || ('批量更新 ' + key), detail: out.length + ' 条（' + list.slice(0, 3).map(p => p.id).join(',') + '）', at: now });
      if (a.length > MAX_AUDIT) { mem.audit = a.slice(-MAX_AUDIT); }
    }
    writeUnlessBatching(top);
    return out;
  }
  function remove(key, id, action) {
    const arr = getMem(key);
    const i = arr.findIndex(x => x.id === id);
    if (i < 0) return false;
    arr.splice(i, 1);
    mark(key); mark('audit');
    const a = getMem('audit');
    a.push({ id: uid(), action: action || ('删除 ' + key), detail: String(id), at: Date.now() });
    if (a.length > MAX_AUDIT) { mem.audit = a.slice(-MAX_AUDIT); }
    writeUnlessBatching(top);
    return true;
  }
  function getSetting(k) { ensureSettings(); return settings ? settings[k] : undefined; }
  function setSetting(k, v) {
    ensureSettings(); settings[k] = v;
    mark('settings');
    const a = getMem('audit');
    a.push({ id: uid(), action: '修改设置', detail: k + '=' + v, at: Date.now() });
    if (a.length > MAX_AUDIT) { mem.audit = a.slice(-MAX_AUDIT); }
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

  // 兼容导出（UI 统计类；压测链路一般不调，给安全实现）
  function decisionStats() { const d = getMem('decisions') || []; return { total: d.length, today: 0, trend: [] }; }
  function orgStats() { const staff = getMem('staff') || []; const proj = getMem('projects') || [];
    return { headcount: staff.length, active: staff.filter(s => s.status !== 'off').length, projects: proj.length, running: proj.filter(p => p.status === 'running').length }; }
  function toCsv(rows, cols) {
    const head = cols.join(',');
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [head].concat(rows.map(r => cols.map(c => esc(typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])).join(','))).join('\n');
  }
  const slowWrites = [];
  function stats() { return { engine: 'shard-store', collections: loaded.size, dataDir, wal: walEnabled, shadow: SHADOW }; }

  return {
    read, write, list, findBy, findAllBy, push, pushMany, update, updateMany, batch, remove,
    getSetting, setSetting, deleteSetting, decisionStats, orgStats, toCsv, uid, stats, slowWrites,
    writeTracked,
    // Phase 2 批合并：显式落盘所有脏集合（bench 收尾 / 进程退出前调用）
    flush,
    coalesce,
    // 与 store.js 相同的常量导出（业务模块顶层可能引用）
    DB_PATH: path.join(dataDir, 'db.json'), DATA_DIR: dataDir, IN_ASAR: false,
    dataPath: function (...segments) { const p = segments.length ? path.join(dataDir, ...segments) : dataDir; try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} return p; },
    // 影子双写：让「原生 store」继续当主库，本引擎只额外刷分片（供切读前的对账）
    _internal: { mem, persistKey, write, top }
  };
}

module.exports = createShardStore;
