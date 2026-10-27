// core/devcap.js — 设备能力扫描 + 自适应速率调优（第 7 项）
//
// 为什么需要：此前所有自治节奏都是写死的常量（autopilot 15min / watchdog 60s /
// conductor 15min / goalpilot 15min），与运行机器的真实算力毫无关系。
// 结果是：4 核 i7 上跑得吃力，16 核服务器上又过于保守、白白浪费算力；
// 更糟的是低端机上"事件循环被同步 I/O 堵死 → 界面卡住"（历史上真实发生过，
// 单次同步 I/O 一度 3135ms，事件循环最长阻塞 5586ms，直接导致 exe 打开即卡死）。
//
// 本模块做两件事：
//   ① scan()  扫描软硬件真实参数（CPU 核数/型号、内存、负载、磁盘余量、进程占用、运行时）
//   ② plan()  据此推导**一组节流参数**（自治轮次间隔、监控频率、并发上限、单步超时…）
//      原则：能力越弱 → 拉长间隔、降低并发、缩短单步超时，宁可慢也别卡死。
//
// 诚实红线：扫描结果如实呈现（不做美化），调优参数全部可解释、可覆盖（用户设置优先）。
// 能力不足时**降速而不是伪造**——不假装跑得更快。

const os = require('os');
const fs = require('fs');
const path = require('path');

// ---------- ① 硬件/环境扫描 ----------
function scan() {
  const cpus = os.cpus() || [];
  const totalMem = os.totalmem() || 0;
  const freeMem = os.freemem() || 0;
  const load = os.loadavg();
  const nodeVer = process.versions && process.versions.node;
  const isElectron = !!(process.versions && process.versions.electron);

  // 磁盘：数据目录所在卷的剩余空间（db.json 膨胀会撑爆磁盘，必须提前发现）
  let disk = { free: null, total: null, usedPct: null, path: null };
  try {
    // 【2026-09】原来 probe = path.join(__dirname,'..','data')，打包后落在只读的 app.asar 内，
    // mkdirSync 抛 EROFS/EACCES 被 catch 吞掉 → 磁盘余量永远探测不到（静默降级为 null）。
    // 改用 store 的统一可写数据目录：探测的是真正在写数据的那个卷。
    const probe = require('./store').dataPath();
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(probe);
      disk = {
        free: st.bavail * st.bsize,
        total: st.blocks * st.bsize,
        usedPct: st.blocks ? Math.round((1 - st.bavail / st.blocks) * 100) : null,
        path: probe
      };
    }
  } catch (e) { /* 拿不到就如实留 null，不编造 */ }

  // 当前进程占用（判断是否已被上一轮撑大）
  let mem = null;
  try {
    const m = process.memoryUsage();
    mem = { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external };
  } catch (e) {}

  return {
    at: Date.now(),
    cpu: {
      model: (cpus[0] && cpus[0].model || 'unknown').trim(),
      cores: cpus.length || 1,
      speedMHz: Math.round((cpus[0] && cpus[0].speed) || 0),
      load1: Number((load[0] || 0).toFixed(2)),
      load5: Number((load[1] || 0).toFixed(2)),
      // 单核负载率：Windows 上 loadavg 恒为 0，改用"轮询空转实测"补一个真实指标
      loadRatio: cpus.length ? Number((load[0] / cpus.length).toFixed(2)) : 0
    },
    mem: {
      total: totalMem,
      free: freeMem,
      usedPct: totalMem ? Math.round((1 - freeMem / totalMem) * 100) : null,
      process: mem
    },
    disk,
    runtime: { node: nodeVer, electron: isElectron ? process.versions.electron : null, platform: process.platform, arch: process.arch, release: os.release() }
  };
}

// ---------- ② 能力分级 ----------
// 评分：CPU 核数 + 内存 + 磁盘余量。不用跑分、不联网，纯本地可测。
function tier(s) {
  const cores = s.cpu.cores;
  const memGB = s.mem.total / (1024 * 1024 * 1024);
  let score = 0;
  score += cores >= 16 ? 4 : cores >= 8 ? 3 : cores >= 4 ? 2 : cores >= 2 ? 1 : 0;   // CPU
  score += memGB >= 32 ? 4 : memGB >= 16 ? 3 : memGB >= 8 ? 2 : memGB >= 4 ? 1 : 0; // 内存
  if (s.disk.usedPct !== null) score += s.disk.usedPct > 92 ? -2 : s.disk.usedPct > 80 ? -1 : 1; // 磁盘余量
  // 名称仅用于解释，不是营销话术
  const name = score >= 9 ? '充裕' : score >= 6 ? '够用' : score >= 3 ? '偏弱' : '孱弱';
  return { score, name };
}

// ---------- ③ 由能力推导节流参数（可被用户设置覆盖）----------
// 关键取舍：能力弱 → 间隔变长、并发变低、单步超时变短。
// 宁可"跑得慢但界面不卡"，也不要"跑得快但把事件循环堵死"（那正是历史卡死的根因）。
function plan(s) {
  s = s || scan();
  const t = tier(s);
  const weak = t.score <= 3;
  const mid = t.score <= 5;

  // 并发上限：留足余量给界面渲染与 HTTP，内存小则更保守
  const concurrency = weak ? 1 : mid ? 2 : Math.min(4, Math.max(2, Math.floor(s.cpu.cores / 2)));

  return {
    at: s.at,
    tier: t,
    basis: {
      cores: s.cpu.cores, memGB: Number((s.mem.total / 1073741824).toFixed(1)),
      diskUsedPct: s.disk.usedPct, load1: s.cpu.load1, model: s.cpu.model
    },
    // 自治节奏（秒）
    autopilotIntervalSec: weak ? 3600 : mid ? 1800 : 900,   // 默认 15min → 弱机 1h
    goalpilotTickSec: weak ? 7200 : mid ? 3600 : 900,       // 每日闭环自查
    conductorTickSec: weak ? 5400 : mid ? 2700 : 900,       // 指挥塔
    watchdogScanSec: weak ? 300 : mid ? 120 : 60,           // 60s → 弱机 5min
    // 单步超时（毫秒）——弱机更容易被网络/IO 卡住，超时要短，失败要快
    stepTimeoutMs: weak ? 20000 : mid ? 30000 : 45000,
    roundTimeoutMs: weak ? 90000 : mid ? 180000 : 300000,
    // 单轮每步上限（少做几步 = 少堵事件循环）
    maxStepsPerRound: weak ? 3 : mid ? 5 : 6,
    // 同步解析 db.json 的并发上限（store 是 1.4MB 级 JSON，串行化是性能命门）
    ioConcurrency: weak ? 1 : 2,
    // 慢设备提示：是否要在 UI 上提醒用户"已为你降速"
    degraded: weak
  };
}

// 合并用户覆盖：用户在设置里显式设定的值优先于自动推导（人永远比自动算法优先）
function effective(overrides) {
  const p = plan();
  const o = overrides || {};
  const pick = (k) => (isFinite(Number(o[k])) && Number(o[k]) > 0 ? Number(o[k]) : p[k]);
  return Object.assign({}, p, {
    autopilotIntervalSec: pick('autopilotIntervalSec'),
    goalpilotTickSec: pick('goalpilotTickSec'),
    conductorTickSec: pick('conductorTickSec'),
    watchdogScanSec: pick('watchdogScanSec'),
    concurrency: pick('concurrency'),
    source: isFinite(Number(o.autopilotIntervalSec)) && Number(o.autopilotIntervalSec) > 0 ? 'user' : 'auto'
  });
}

module.exports = { scan, tier, plan, effective };
