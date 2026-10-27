// core/store.js — JSON 文件存储（零 native 依赖，启动即用）
// 职责：对话 messages / 决策 decisions / 组织 staff / 项目 projects / 审计 audit / 设置 settings
// 设计：单文件 data/db.json，读-改-写；所有写操作 append 审计，供"审计日志"块展示。

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
// asar 只读环境 -> 数据落到用户数据目录（可写）；开发模式 -> 项目 data/
// （可选）BINGDASHAN_DATA_DIR 显式指定数据目录：测试/便携部署与主实例隔离数据用。
const IN_ASAR = __dirname.includes('app.asar');
const DATA_DIR = process.env.BINGDASHAN_DATA_DIR
  || (IN_ASAR
    ? path.join(process.env.APPDATA || path.join(os.homedir(), '.bingdashan'), 'BingDashanAI', 'data')
    : path.join(ROOT, 'data'));
const DB_PATH = path.join(DATA_DIR, 'db.json');
const BAK_PATH = DB_PATH + '.bak';

// 【2026-09·打包版路径 bug 的统一出口】
// 下面 6 处曾各自硬编码 path.join(__dirname, '..', 'data', ...)，打包后解析到
// resources/app.asar/data —— **asar 是只读的**，于是：
//   - conductor 的定时任务每次都抛 ENOENT「指挥塔评估失败」（实测审计里反复出现）
//   - studio / gamestudio / autopub / devcap 全部无法落地文件
//   - conductor 反复重试还顺带造成周期性 ~500ms 事件循环阻塞
// 现在统一走 dataPath()，它会尊重 BINGDASHAN_DATA_DIR 与 asar 环境，并确保目录存在。
function dataPath(...segments) {
  const p = segments.length ? path.join(DATA_DIR, ...segments) : DATA_DIR;
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) { /* 不可写时调用方会拿到明确错误 */ }
  return p;
}
// 备份节流：全量 copy 1.4MB 很贵，自愈锚点按 5s 间隔滚动即可
const BAK_INTERVAL_MS = 5000;
let lastBakAt = 0;

const EMPTY = {
  messages: [],   // {id, role, content, provider, engine, createdAt}
  decisions: [],  // {id, question, answer, engine, source, createdAt}
  staff: [],      // {id, name, role, skills[], createdAt}
  projects: [],   // {id, name, desc, status, progress, owner, members[], createdAt}
  tasks: [],      // {id, title, due, ref, done, createdAt}
  audit: [],      // {id, action, detail, at}
  knowledge: [],  // {id, q, a, tag, createdAt}
  memory: [],     // {id, key, value, at}
  evolution: [],  // {id, note, at}
  learn: {},      // provider -> {ok, fail, totalMs, n}
  settings: { theme: 'emerald', sound: true, lang: 'zh', provider: 'deepseek' }
};

// 通用：集合上限（单点强制，调用方无需改动）
//
// 写盘成本 ∝ 全库字节数，与改动条数无关。当前 1.46MB 库里 autopilot 单键就占 510KB(35%)，
// 而它只是**运行日志**。若放任增长，单键到 400 条上限时约 1.0MB，全库写盘会再慢一倍以上，
// 于是"每轮 autopilot 写一次"变成"每轮把近 1MB 序列化一遍"——这正是"越用越卡"的来源。
//
// 这里只约束**日志型**集合（可再生、非业务资产）。刻意**不**约束 leads / customers /
// revenue / orders / sublist / staff / projects / tasks / knowledge / skills_ext / geo /
// rank / visitors —— 那些是业务数据或用户产出，删一条就是丢真实信息，宁可慢也不自动删。
const CAPS = {
  audit: 1000,              // 审计（与 MAX_AUDIT 同步，见下）
  evolution: 600,           // 进化日志
  autopilot: 400,           // 自主运营轮次
  mail: 200,                // 邮件发送记录（成败都记）
  outbound: 500,            // 真实触达外发记录（成败/回复都记）
  crawl: 500,               // 蜘蛛入料日志（登记/深爬/失败都记）
  agentcenter_log: 200,     // agentcenter 操作日志
  scoutLog: 200,            // 技能侦察日志
  ticketBatch: 100,         // 协同会批次
  harnessRuns: 40,
  materialMovements: 300,   // 物料流水（登记/出入库都记）
  materialShortages: 200,   // 欠料异常（只增不减的警铃，收敛防旧料无界）
  purchaseIntents: 200,     // 采购意向台账（open 在途意向永不裁剪，只收拢已完结的历史）
  funnelSnapshots: 365,      // 每日漏斗快照（保留 1 年）
  wallAbuse: 2000,           // 撞墙/新访客观测（2026-10-21：日志型，之前只增不减 → 生产已 8109 条）
  llmUsage: 2000,             // LLM 调用与成本估算（2026-10-21 新增：日志型，够算近 30 天毛利）
  careOrders: 500,            // 陪护订阅订单台账（未付/已开通都留；2026-10-24 商业闭环）
  careNotifies: 1000,         // 陪护告警通知行（含成功/失败/跳过；预算熔断要算当天条数）
  careGrants: 500,           // 家属临时授权窗口（单份资料，可撤回）
};

// 写盘时统一收敛：条数超限就砍掉最旧的（这些集合的读取都是"最近 N 条"语义）。
// 例外：purchaseIntents 的 open（在途）意向是活账，绝不能因台账堆砌被静默裁掉。
function applyCaps(db) {
  for (const k of Object.keys(CAPS)) {
    const arr = db && db[k];
    if (!Array.isArray(arr) || arr.length <= CAPS[k]) continue;
    if (k === 'purchaseIntents') {
      const open = arr.filter(r => r && r.status === 'open');
      const done = arr.filter(r => !r || r.status !== 'open');
      db[k] = done.slice(-CAPS[k]).concat(open);
      continue;
    }
    db[k] = arr.slice(-CAPS[k]);
  }
}

function ensure() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY, null, 2), 'utf8');
  } catch (e) { /* 存储区不可写时静默降级，进程不崩溃 */ }
}

// 写合并串行化：内存保存上一次提交的顶层状态，write 时只把“相对上次提交有变更”的顶层键
// 覆盖到磁盘最新态上，其余键保留磁盘现值——避免并发读改写（如自动巡逻 + 两个 HTTP 写
// 同时改不同键）互相清空对方的提交。同一键内部的竞争仍为最后的写者胜出。
let lastCommitted = null;

// 读缓存：db.json 已达 1.4MB+，每次请求都 parse + 深拷贝整份会把 Node 单线程堵死
//（接口耗时 3–20s，前端直接报"服务器连接异常"）。这里缓存解析结果，用 mtime+size 判定失效：
// 外部进程改了文件、或本进程 write 后，缓存自动失效重读。
let cache = null;        // { mtimeMs, size, data }
let cacheFresh = false;  // write() 成功后置位：本次写入的内存态即最新态，无需回读磁盘

// 自己最后一次成功落盘的指纹。用于 writeSync 里跳过"回读磁盘真值"这一步——
// 那一步占单次写 43ms（实测 208ms 里最大的一项），而当磁盘状态确实就是我们刚写下的那份时，
// 回读得到的结果与内存态**完全等价**，纯属浪费。
// 安全性：指纹不匹配（别的进程改过 / 我们写失败过）→ 一律回读，跨进程合并语义不变。
let selfWrite = null;    // { mtimeMs, size }

function dbStat() {
  try {
    const st = fs.statSync(DB_PATH);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) { return { mtimeMs: 0, size: -1 }; }
}

// 磁盘当前态是否就是我们内存里这份（没有任何外部写入）
function diskMatchesMemory() {
  if (!selfWrite || !cache) return false;
  const st = dbStat();
  return st.mtimeMs === selfWrite.mtimeMs && st.size === selfWrite.size;
}

function read() {
  ensure();
  // 【一致性·不可改成 `cache && !cacheFresh`】cacheFresh 只表示「本进程刚写过」，
  // 不表示「磁盘仍是那份」。跳过指纹校验 = 常驻进程对外部写入永久失明：
  // 本进程 write 之后，任何别的进程写入都读不到（e2e 的退订落库断言就是这么红的）。
  // 正确做法：两种状态都校验磁盘指纹，只是「刚写过」时用 selfWrite（省一次 JSON.parse，
  // 仍然是一次 statSync，代价远小于解析 1.4MB+）。
  if (cache) {
    const st = dbStat();
    const hit = cacheFresh
      ? (selfWrite && st.mtimeMs === selfWrite.mtimeMs && st.size === selfWrite.size)
      : (st.mtimeMs === cache.mtimeMs && st.size === cache.size);
    if (hit) {
      lastCommitted = cache.data;
      return cache.data;
    }
    // 磁盘已被外部改写：本地内存态作废，下面的 JSON.parse 会重建缓存
    cacheFresh = false;
    selfWrite = null;
  }
  let out;
  try { out = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch (e) {
    // db.json 损坏/不可解析：先备份现场，再尝试从 .bak（上一次成功写入）自愈，避免后续写入覆盖真实数据
    try { fs.copyFileSync(DB_PATH, DB_PATH + '.corrupt-' + Date.now()); } catch (e2) {}
    try { out = JSON.parse(fs.readFileSync(BAK_PATH, 'utf8')); } catch (e3) { out = JSON.parse(JSON.stringify(EMPTY)); }
  }
  const st = dbStat();
  cache = { mtimeMs: st.mtimeMs, size: st.size, data: out };
  cacheFresh = false;
  lastCommitted = out;
  return out;
}

function writeSync(db) {
  ensure();
  // 统一在此处收敛无界集合（update/remove/setSetting/直连 db.audit.push 都会经过这里）
  try {
    if (db && Array.isArray(db.audit) && db.audit.length > MAX_AUDIT) db.audit = db.audit.slice(-MAX_AUDIT);
    if (db && Array.isArray(db.evolution) && db.evolution.length > MAX_EVOLVE) db.evolution = db.evolution.slice(-MAX_EVOLVE);
    applyCaps(db);
  } catch (e) {}
  // 只把变更键并到磁盘最新态：读回当下文件而不是信任内存快照，防止串行覆盖竞态丢键。
  // 注意：这里必须回读磁盘真值，不能用内存缓存代替——调用方往往就是从 read() 拿到的
  // 缓存对象，latest 与 db 共享引用会导致 a===b、变更被判为"未变更"而静默丢失。
  let latest;
  //
  // 【2026-09 性能·跳过自我回读】"回读磁盘真值"在单进程连续写时是纯浪费：
  // 磁盘内容就是我们上一毫秒才写下的那份。diskMatchesMemory() 用 mtime+size 指纹判定
  // "磁盘未被任何外部进程改动"，此时 latest 直接复用内存态——与回读结果**完全等价**，
  // 但省掉 1.8MB 的 readFileSync + JSON.parse（实测 43ms+22ms，占单次写 208ms 的 31%）。
  // 指纹不匹配（别的进程写过 / 我们上次写失败）→ 一律照旧回读，跨进程合并语义完全不变。
  if (lastCommitted && db && diskMatchesMemory()) {
    // 指纹匹配 = 自上次写入后磁盘没被任何外部进程改过 → 内存态即磁盘真值。
    // 此时 latest 与 db 常常是同一引用，跳过 diff 直接落盘是**正确**的，
    // 也正是上面省掉 43ms 回读的前提。
    // 跨进程丢失的防线不在这里，而在 read()：cacheFresh=true 时同样校验磁盘指纹，
    // 外部写入一旦发生，本进程内存态会被判过期并在下次 read 时重建。
    latest = cache && cache.data ? cache.data : lastCommitted;
  } else {
    try { latest = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
    catch (e) { latest = JSON.parse(JSON.stringify(EMPTY)); }
  }
  if (lastCommitted && latest && db && latest !== db) {
    // 【性能】latest !== db 才需要 diff：当磁盘是我们自己刚写的那份时 latest 与 db 是
    // 同一对象引用，逐键比较必然全部相等，diff 是纯粹的浪费。
    // 实测 1.8MB 库有 ~56 个顶层键，diff 一次要 112 次 JSON.stringify（leads 一个键就
    // 1.5MB）= 22ms/次，占优化后单条 68.5ms 的三分之一。
    //
    // 另：原实现是 JSON.parse(JSON.stringify(latest)) 做**全量深拷贝**，但紧接着就要
    // JSON.stringify(db) 整体序列化——深拷贝纯属浪费。改为浅拷贝顶层键 + 只替换真正变更的键：
    // 合并语义完全等价（未变更的键沿用 latest 的值，变更的键用 db 的值）。
    const merged = Object.assign({}, latest);
    const dbKeys = Object.keys(db);
    for (let i = 0; i < dbKeys.length; i++) {
      const k = dbKeys[i];
      try {
        // 基线取自 latest[k]（上次成功写盘后的磁盘态）。对变更最多的键做两次 stringify
        // 是必要的：leads 有 1.5MB，必须真比较才知道这个键是否变了。
        const a = latest[k] === undefined ? undefined : JSON.stringify(latest[k]);
        const b = JSON.stringify(db[k]);
        if (a !== b) merged[k] = db[k];
      } catch (e2) { merged[k] = db[k]; }
    }
    // db 里没有、但 latest 有且 lastCommitted 也有 → latest[k] 应保留（Object.assign 已保留）
    db = merged;
  }
  // 【2026-09 性能·紧凑 JSON】缩进（null,2）让文件凭空膨胀 20%（1.78MB → 1.42MB），
  // 而序列化 / 写盘 / 回读 / 备份 copy 全部按字节数线性增长。
  // 实测 stringify 35.4→16.2ms、writeFileSync 56.3→20.3ms；parse 两者持平（空白 token 极廉价）。
  // 代价只是文件不再能直接人眼阅读——这是机器数据文件，不是配置文件。
  const data = JSON.stringify(db);
  // 原子写：先写临时文件再 rename，避免进程中途崩溃/磁盘满把 db.json 截断成半截。
  // 写前先取一次指纹，供落盘校验使用。
  const preStat = dbStat();
  try {
    const tmp = DB_PATH + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, DB_PATH);
  } catch (e) {
    // Windows 下 rename 偶发 EPERM（防病毒/句柄占用）→ 退化为直接写目标文件，保证可靠落盘
    try { fs.unlinkSync(DB_PATH + '.tmp-' + process.pid); } catch (e2) {}
    try { fs.writeFileSync(DB_PATH, data, 'utf8'); } catch (e3) { /* 双写仍失败：静默降级，不抛给上层 */ }
  }
  // 落盘校验：基线与缓存只能在确认写盘成功后推进。
  // 否则内存态会领先于磁盘，之后所有同键写入都被判为"未变更"而永久丢失
  //（曾导致新增顶层键如 db.geo 写不进磁盘、查询恒为空）。
  // 这里不回读整份文件比对（1.4MB × parse+stringify，单次写多花约 30ms，
  // 实测一轮 autopilot 写 33 次、累计占用事件循环 1s+）。
  //
  // 判定 = 字节数与目标一致（我们确实写进去这么多字节）
  //       且 文件指纹相对写前确实变了（mtime 或 size 至少一个变）。
  //
  // 【踩过的坑】曾把校验写成 `st.mtimeMs >= Date.now() - 1`，想着"mtime 应该不早于现在"。
  // 结果 NTFS 时间戳精度约 15ms 且**滞后于墙钟 9–24ms**，该条件几乎恒为 false，
  // 于是每次写都判定"未落盘"→ 缓存与自我写指纹全被丢弃 → read()/writeSync 每次冷重读，
  // 性能优化全部失效。**不要拿文件 mtime 和 Date.now() 比**——两者时钟基准不同。
  // 正确做法是 mtime 与写前拿到的 mtime 比（同一时钟基准）。
  const wantSize = Buffer.byteLength(data);
  let persisted = false;
  let post = { mtimeMs: 0, size: -1 };
  try {
    post = fs.statSync(DB_PATH);
    const changed = post.mtimeMs !== preStat.mtimeMs || post.size !== preStat.size;
    persisted = post.size === wantSize && changed;
  } catch (e) { persisted = false; }
  if (!persisted) {
    // 写盘未生效：丢弃缓存与自我写指纹，下一次 read() 强制回读磁盘真实状态
    cache = null; cacheFresh = false;
    selfWrite = null;
    lastCommitted = null;
    return db;
  }
  // 滚动留存上一次成功写入的可靠副本（自愈锚点）。
  // 每写一次就全量 copyFileSync 1.8MB 是持续性 I/O 开销（一轮 autopilot 触发多次），
  // 但自愈锚点只需"距上次备份一段时间内的最新态"即可，故按 BAK_INTERVAL_MS 节流：
  // 距上次备份不足 5 秒则跳过，异常时仍能从较近的锚点恢复。
  const now = Date.now();
  if (!lastBakAt || now - lastBakAt > BAK_INTERVAL_MS) {
    try { fs.copyFileSync(DB_PATH, BAK_PATH); lastBakAt = now; } catch (e) {}
  }
  lastCommitted = db;
  // 同步缓存：刚写入的内存态即磁盘最新态，下一次 read() 不必回读+解析 1.8MB。
  // 同时记录本次落盘指纹，供下次 writeSync 判断能否跳过自我回读。
  const st = dbStat();
  cache = { mtimeMs: st.mtimeMs, size: st.size, data: db };
  cacheFresh = true;
  selfWrite = { mtimeMs: st.mtimeMs, size: st.size };
  return db;
}

// 对外写入口：立即同步落盘（保持原有、久经验证的正确路径）。
// 说明：曾尝试"同 tick 合并写"提速 20 倍（35ms→1.8ms），但实测破坏了 writeSync 的
// 磁盘合并语义——deferred db 基于内存对象累积，与磁盘 latest 比对时丢键
//（50 次 push 只落 1 条、alpha 键丢失）。数据正确性 > 几十毫秒，故回退同步写。
// 正确提速方向已落在两处，二者都与写盘时机无关：
//   1) 批量改动走 updateMany()/batch()，把 N 次写盘压成 1 次；
//   2) writeSync 内部跳过自我回读 + 紧凑 JSON（见上）。
function write(db) {
  return writeTracked(db, 'write');
}

// ===== 写盘耗时统计（诊断用，零常态开销）=====
// 只在超过 SLOW_MS 时把调用栈记一条，用于回答"到底是谁在写盘写这么慢"。
// 用 Error().stack 取栈有成本，所以放在慢路径里，不影响正常写入。
const SLOW_MS = 150;
const _slow = [];
function trackSlow(ms) {
  if (ms < SLOW_MS || _slow.length >= 30) return;
  const stack = (new Error().stack || '').split('\n').slice(2, 6)
    .map(s => s.trim().replace(/^at\s+/, '').replace(/[A-Za-z]:\\[^\\]*\\/, '')).join(' ← ');
  _slow.push({ at: Date.now(), ms, stack });
}
function writeTracked(db, label) {
  const t = Date.now();
  try { return writeSync(db); } finally { trackSlow(Date.now() - t); }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// 通用：列表读取（按时间倒序，limit 截断）
function list(key, limit) {
  const db = read();
  const arr = db[key] || [];
  const out = arr.slice().reverse();
  return limit ? out.slice(0, limit) : out;
}

/**
 * 通用：按字段等值查找（**全量**，不受 list 的 limit 窗口限制）
 * ------------------------------------------------------------------
 * 【为什么需要】身份/权益这类"按唯一键找记录"的场景，用 list(key, 999) 找是**错的**：
 * 一旦记录数超过窗口，早先的记录就"失忆" → 同一个人被当成新访客重建 →
 * 免费额度被重置、权益与订单对不上人（实测生产访客 2805 > 窗口 999）。
 * 这里做全量扫描：从新到旧，找到即返回；**不分配**中间数组（比 list 便宜）。
 * @param {string} key 集合名
 * @param {string} field 字段名
 * @param {*} value 期望值（严格相等）
 */
function findBy(key, field, value) {
  const db = read();
  const arr = db[key] || [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const it = arr[i];
    if (it && it[field] === value) return it;
  }
  return null;
}

/**
 * 通用：按字段等值找出**全部**匹配（全量，不受 limit 窗口限制）。
 * 用途：一个人可能有多条记录（如历史订阅），需要自己挑"当前有效的那条"。
 * @returns {Array<object>}
 */
function findAllBy(key, field, value) {
  const db = read();
  const arr = db[key] || [];
  const out = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const it = arr[i];
    if (it && it[field] === value) out.push(it);
  }
  return out;
}

// 通用：追加一条 + 写审计
// 注意：key === 'audit' 时表示上层直接写审计行，统一规格化存储，避免双写。
const MAX_AUDIT = 1000;   // 审计上限，避免长跑无界增长
const MAX_EVOLVE = 600;   // 进化日志上限
function push(key, item, action, detail) {
  const db = read();
  const rec = Object.assign({ id: uid(), createdAt: Date.now() }, item);
  if (!db[key]) db[key] = [];
  if (key === 'audit') {
    const row = {
      id: uid(),
      action: item.action || action || '记录',
      detail: item.detail || detail || '',
      at: item.at || Date.now()
    };
    db.audit.push(row);
    if (db.audit.length > MAX_AUDIT) db.audit = db.audit.slice(-MAX_AUDIT);
    writeUnlessBatching(db);
    return row;
  }
  db[key].push(rec);
  // 审计日志（audit 块自动下滑展示）
  if (!db.audit) db.audit = [];
  db.audit.push({ id: uid(), action: action || ('新增 ' + key), detail: detail || JSON.stringify(item).slice(0, 160), at: Date.now() });
  if (db.audit.length > MAX_AUDIT) db.audit = db.audit.slice(-MAX_AUDIT);
  writeUnlessBatching(db);
  return rec;
}

// 通用：批量追加 —— 一次 read/write，只留一条汇总审计
// 用途：一次协同会有 N 条成员意见，逐条 push 会造成 N 次落盘 + N 条噪声审计，
// 既慢又把审计日志冲垮（MAX_AUDIT 会被同一次操作占满）。
function pushMany(key, items, action, detail) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return [];
  const db = read();
  if (!db[key]) db[key] = [];
  const recs = arr.map(item => {
    const rec = Object.assign({ id: uid(), createdAt: Date.now() }, item);
    db[key].push(rec);
    return rec;
  });
  if (!db.audit) db.audit = [];
  db.audit.push({
    id: uid(),
    action: action || ('批量新增 ' + key + ' x' + recs.length),
    detail: (detail || '') + '（' + recs.length + ' 条）',
    at: Date.now()
  });
  if (db.audit.length > MAX_AUDIT) db.audit = db.audit.slice(-MAX_AUDIT);
  writeUnlessBatching(db);
  return recs;
}

// 通用：更新（by id）
function update(key, id, patch, action) {
  const db = read();
  const arr = db[key] || [];
  const i = arr.findIndex(x => x.id === id);
  if (i < 0) return null;
  arr[i] = Object.assign({}, arr[i], patch, { updatedAt: Date.now() });
  if (!db.audit) db.audit = [];
  db.audit.push({ id: uid(), action: action || ('更新 ' + key), detail: (id + ' ' + JSON.stringify(patch)).slice(0, 160), at: Date.now() });
  writeUnlessBatching(db);
  return arr[i];
}

// 通用：批量更新（by id）—— 一次 read/write，只留一条汇总审计
//
// 【2026-09·卡死根因修复】逐条 update() 是 O(n·库大小) 的写放大：
// 每次 update 都触发一次完整 writeSync（实测在 1.78MB 真实库上单条 208ms，
// 其中回读 43ms + parse 22ms + stringify 35ms + writeFileSync 56ms + 死缓存重建 25ms）。
// 230 条逐条更新 = 230 次写盘 ≈ 48 秒，**全程堵死 Node 单线程事件循环**：
// HTTP 服务无响应、连带着驱动它的 shell 一起挂住。
// 批量更新把这 N 次写盘压成 1 次，实测 230 条从 ~48s 降到 ~0.2s。
//
// 语义与逐条 update 完全一致：按 id 定位、合并 patch、记 updatedAt、找不到返回 null。
function updateMany(key, patches, action) {
  const list = Array.isArray(patches) ? patches.filter(p => p && p.id) : [];
  if (!list.length) return [];
  const db = read();
  const arr = db[key] || [];
  const byId = new Map();
  arr.forEach(x => { if (x && x.id) byId.set(x.id, x); });
  const now = Date.now();
  const out = [];
  list.forEach(p => {
    const cur = byId.get(p.id);
    if (!cur) return;                       // 与 update() 一致：找不到就跳过
    // patch 里显式 undefined 表示"删除该字段"（逐条 update 用 Object.assign 会保留旧值，
    // 这里为批量操作提供明确的删除语义，与 scripts/reset-touch.js 的清理需求一致）
    const merged = Object.assign({}, cur, p, { updatedAt: now });
    Object.keys(p).forEach(k => { if (p[k] === undefined) delete merged[k]; });
    const i = arr.indexOf(cur);
    if (i >= 0) arr[i] = merged;
    out.push(merged);
  });
  if (out.length) {
    if (!db.audit) db.audit = [];
    db.audit.push({
      id: uid(), action: action || ('批量更新 ' + key),
      detail: out.length + ' 条（' + list.slice(0, 3).map(p => p.id).join(',') + (list.length > 3 ? '…' : '') + '）',
      at: now
    });
    if (db.audit.length > MAX_AUDIT) db.audit = db.audit.slice(-MAX_AUDIT);
    writeUnlessBatching(db);         // N 次 update 压成这 1 次写盘
  }
  return out;
}

// 通用：事务批处理 —— fn 内可自由 read()/修改，最后只落盘一次。
// 用途：任何"要改很多条、但每条改法不同"的场景（如 scripts/reset-touch.js）。
//
// 【2026-09·防卡死·关键机制】batch() 会**真正合并 fn 内部的嵌套写**：
// push/update/remove/setSetting/pushMany 在 batching 期间只改内存、**不落盘**，
// 由 batch 结束时的那一次 write() 统一持久化。
// 于是任何调用方无需知道 store 内部实现，只要把一段"逻辑上属于一次操作"的代码
// 包进 batch()，N 次同步写盘就变成 1 次。
//
// 为什么这次是安全的，而历史上"同 tick 合并写"被回退过：
//   旧失败模式是把写**推迟到后续 tick**，期间别的进程/请求会写盘，deferred 的内存态
//   与磁盘 latest 比对时丢键（50 次 push 只落 1 条）。
//   现在是**同一个同步调用栈内**完成：batching 期间事件循环不会让出，不可能被穿插；
//   且最后一次 write() 仍走完整的"磁盘 latest vs 内存态"合并逻辑，跨进程安全不变。
//
// 【重要】fn 内部不要做 await（异步会让出事件循环，破坏"同一 tick"前提）。
// 返回 { audit } 时会追加一条汇总审计。
let batching = 0;
function writeUnlessBatching(db) {
  if (batching > 0) return db;      // 事务内：只改内存，由 batch 收尾统一落盘
  return writeTracked(db, 'write');
}
function batch(fn) {
  const db = read();
  batching++;
  let res;
  try {
    res = fn(db) || {};
  } finally {
    batching--;
  }
  if (res && res.audit) {
    if (!db.audit) db.audit = [];
    db.audit.push({
      id: uid(),
      action: res.audit.action || '批量操作',
      detail: String(res.audit.detail || '').slice(0, 400),
      at: Date.now()
    });
    if (db.audit.length > MAX_AUDIT) db.audit = db.audit.slice(-MAX_AUDIT);
  }
  writeTracked(db, 'batch');           // ← 无论 batching 计数如何，收尾这一次必须真落盘
  return res;
}

// 通用：删除（by id）
function remove(key, id, action) {
  const db = read();
  const arr = db[key] || [];
  const i = arr.findIndex(x => x.id === id);
  if (i < 0) return false;
  arr.splice(i, 1);
  if (!db.audit) db.audit = [];
  db.audit.push({ id: uid(), action: action || ('删除 ' + key), detail: String(id), at: Date.now() });
  writeUnlessBatching(db);
  return true;
}

// 设置：读/写单个键
function getSetting(k) { const db = read(); return db.settings ? db.settings[k] : undefined; }
function setSetting(k, v) {
  const db = read();
  if (!db.settings) db.settings = Object.assign({}, EMPTY.settings);
  db.settings[k] = v;
  if (!db.audit) db.audit = [];
  db.audit.push({ id: uid(), action: '修改设置', detail: k + '=' + v, at: Date.now() });
  writeUnlessBatching(db);
  return db.settings;
}

// 删除单个设置键（验证码「用后即焚」等场景）。
// 注意：auth.js 一直在调用 store.deleteSetting，但 store 从未导出该函数，
// 于是每次调用都在 try/catch 里静默抛错 —— 验证码使用后不会被清除，可被重放。
function deleteSetting(k) {
  const db = read();
  if (!db.settings || !Object.prototype.hasOwnProperty.call(db.settings, k)) return false;
  delete db.settings[k];
  writeUnlessBatching(db);
  return true;
}

// 决策统计（决策中心块用）
function decisionStats() {
  const db = read();
  const d = db.decisions || [];
  // 7 日趋势
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(); day.setDate(day.getDate() - i);
    const key = day.toDateString();
    trend.push({ day: (day.getMonth() + 1) + '/' + day.getDate(), count: d.filter(x => new Date(x.createdAt).toDateString() === key).length });
  }
  return { total: d.length, today: d.filter(x => sameDay(x.createdAt, Date.now())).length, trend };
}

function sameDay(a, b) {
  const da = new Date(a), dbb = new Date(b);
  return da.getFullYear() === dbb.getFullYear() && da.getMonth() === dbb.getMonth() && da.getDate() === dbb.getDate();
}

// 组织统计（组织大脑块用：员工数/在岗/今日任务）
function orgStats() {
  const db = read();
  const staff = db.staff || [];
  const proj = db.projects || [];
  return {
    headcount: staff.length,
    active: staff.filter(s => s.status !== 'off').length,
    projects: proj.length,
    running: proj.filter(p => p.status === 'running').length
  };
}

// CSV 导出（审计日志/决策 导出 CSV）
function toCsv(rows, cols) {
  const head = cols.join(',');
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const body = rows.map(r => cols.map(c => esc(typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])).join(','));
  return [head].concat(body).join('\n');
}

module.exports = {
  read, write, list, findBy, findAllBy, push, pushMany, update, updateMany, batch, remove,
  getSetting, setSetting, deleteSetting, decisionStats, orgStats, toCsv, uid, DB_PATH,
  DATA_DIR, dataPath, IN_ASAR,
  writeTracked, slowWrites: () => _slow.slice(-30),
  stats: () => ({ dbBytes: (() => { try { return fs.statSync(DB_PATH).size; } catch (e) { return -1; } })(), caps: CAPS, slowCount: _slow.length })
};
