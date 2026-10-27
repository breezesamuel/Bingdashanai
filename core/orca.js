// core/orca.js — Orca 桌面指挥台（一个桌面指挥所有编排 AI · orca · Orca · AI 编码桌面以及 saas 后台工作流）
//
// 【需求】一个桌面指挥所有编排 AI · orca · Orca · AI 编码桌面以及 saas 后台工作流
//
// 【它与 agentmesh 的区别（否则就是重复造轮子）】
//   agentmesh：把手上可用的通道/CLI/专家**编排起来执行任务**（执行层）
//   orca：**把执行过程可视化、可控制、可复盘**（指挥层）
//   - 任务队列：优先级、依赖、并发槽位、降级与熔断
//   - 执行体画像：每个后端/专家的类型、强项、历史成功率、平均耗时、当前负载
//   - 实时图表：利用率、吞吐、延迟、成功率（24h 滚动）
//   - 人员脉络：谁在做什么、负载分布、协作网络、效能画像
//   - 场景动态图：任务流 DAG、执行时间线、依赖热力
//   - WebSocket 推送：实时更新前端指挥台

const fs = require('fs');
const path = require('path');
const store = require('./store');
const agentmesh = require('./agentmesh');

const MAX_CONCURRENCY = 3;
const QUEUE_KEY = 'orcaQueue';
const JOBS_KEY = 'orcaJobs';

function slots() {
  return Math.max(1, Number(store.getSetting('orcaSlots')) || MAX_CONCURRENCY);
}

function loadQueue() {
  return store.read()[QUEUE_KEY] || [];
}

function saveQueue(q) {
  const db = store.read();
  db[QUEUE_KEY] = q;
  store.write(db);
}

function enqueue(input) {
  const o = input || {};
  const item = {
    id: store.uid(),
    task: String(o.task || '').slice(0, 200),
    arch: o.arch || 'auto',
    priority: Number(o.priority) || 0,
    backend: o.backend || null,
    backendLabel: o.backendLabel || '',
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    ms: null,
    error: null,
    backendUsed: null,
    archResolved: null
  };
  const q = loadQueue();
  q.push(item);
  saveQueue(q);
  return { ok: true, item };
}

function pickExec(name) {
  const be = agentmesh.backends();
  return be.find(b => b.id === name || b.label === name) || null;
}

async function tick(opt) {
  const o = opt || {};
  const q = loadQueue();
  const be = agentmesh.backends();
  const max = slots();
  const running = q.filter(x => x.status === 'running').length;
  if (running >= max) return { ok: true, reason: 'slots full', running, max };

  const queued = q.filter(x => x.status === 'queued')
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  if (!queued.length) return { ok: true, reason: 'nothing queued', running, max };

  const item = queued[0];
  const exec = item.backend ? pickExec(item.backend) : be.find(b => b.available);
  if (!exec) return { ok: true, reason: 'no executor', running, max };

  item.status = 'running';
  item.startedAt = Date.now();
  item.backendUsed = exec.id;
  item.archResolved = exec.arch || 'auto';
  saveQueue(q);

  try {
    const r = await exec.run({ task: item.task, arch: item.archResolved });
    item.status = r.ok ? 'done' : 'failed';
    item.error = r.error || null;
  } catch (e) {
    item.status = 'failed';
    item.error = String(e);
  }
  item.finishedAt = Date.now();
  item.ms = item.finishedAt - item.startedAt;
  saveQueue(q);
  return { ok: true, item };
}

async function runItem(id, opt) {
  const q = loadQueue();
  const item = q.find(x => x.id === id);
  if (!item) return { ok: false, error: 'not found' };
  if (item.status === 'running') return { ok: false, error: 'already running' };
  if (item.status === 'done' || item.status === 'degraded') return { ok: false, error: 'already finished' };
  item.status = 'queued';
  item.priority = (opt && opt.priority) || 999;
  saveQueue(q);
  return { ok: true, item };
}

async function runAll(opt) {
  const o = opt || {};
  const limit = Math.min(200, Number(o.limit) || 50);
  let done = 0;
  for (let i = 0; i < limit; i++) {
    const r = await tick(o);
    if (!r.ok || r.reason) break;
    done++;
    if (o.interval) await new Promise(r => setTimeout(r, o.interval));
  }
  return { ok: true, done };
}

function board() {
  const q = loadQueue();
  const be = agentmesh.backends();
  const load = {};
  q.forEach(x => { const bk = x.backendUsed || x.backend; if (x.status === 'running' && bk) load[bk] = (load[bk] || 0) + 1; });

  const byStatus = {};
  q.forEach(x => { byStatus[x.status] = (byStatus[x.status] || 0) + 1; });

  const execs = be.map(b => {
    const mine = x => (x.backendUsed || x.backend) === b.id;
    const done = q.filter(x => mine(x) && (x.status === 'done' || x.status === 'degraded'));
    const fail = q.filter(x => mine(x) && x.status === 'failed');
    const ms = done.map(x => x.ms || 0);
    return {
      id: b.id, label: b.label, type: b.type, kind: b.kind, model: b.model,
      strength: b.strength, available: true,
      load: load[b.id] || 0,
      done: done.length, failed: fail.length,
      successRate: (done.length + fail.length) ? Math.round(done.length / (done.length + fail.length) * 100) : null,
      avgMs: ms.length ? Math.round(ms.reduce((a, c) => a + c, 0) / ms.length) : null
    };
  });

  const finished = q.filter(x => x.finishedAt && x.startedAt);
  return {
    queue: {
      total: q.length,
      byStatus,
      queued: byStatus.queued || 0,
      running: byStatus.running || 0,
      slots: slots(),
      maxSlots: MAX_CONCURRENCY,
      utilization: slots() ? Math.round(((byStatus.running || 0) / slots()) * 100) : 0
    },
    execs,
    stats: {
      avgLatency: finished.length ? Math.round(finished.reduce((a, x) => a + ((x.finishedAt - x.startedAt)), 0) / finished.length) : null,
      degraded: byStatus.degraded || 0,
      degradedRate: finished.length ? Math.round((byStatus.degraded || 0) / finished.length * 100) : 0
    },
    recent: q.slice(-12).reverse().map(x => ({
      id: x.id, task: String(x.task).slice(0, 60), status: x.status,
      backend: x.backendLabel || x.backend, arch: x.arch, ms: x.ms,
      error: x.error, createdAt: x.createdAt
    }))
  };
}

// ===== 实时图表数据：时间序列聚合 =====
function chartData() {
  const q = loadQueue();
  const now = Date.now();
  const HOUR = 3600000;
  const bins = 24;
  const utilization = Array(bins).fill(0);
  const throughput = Array(bins).fill(0);
  const latency = Array(bins).fill(0);
  const success = Array(bins).fill(0);
  const count = Array(bins).fill(0);

  q.forEach(x => {
    if (!x.finishedAt || !x.startedAt) return;
    const h = Math.floor((now - x.finishedAt) / HOUR);
    if (h < 0 || h >= bins) return;
    const idx = bins - 1 - h;
    const dur = x.finishedAt - x.startedAt;
    throughput[idx]++;
    latency[idx] += dur;
    if (x.status === 'done' || x.status === 'degraded') success[idx]++;
    count[idx]++;
  });

  for (let i = 0; i < bins; i++) {
    latency[i] = count[i] ? Math.round(latency[i] / count[i]) : 0;
    success[i] = count[i] ? Math.round(success[i] / count[i] * 100) : 100;
  }

  const maxSlots = slots();
  const histUtil = Array(bins).fill(0);
  q.forEach(x => {
    if (!x.startedAt) return;
    const h = Math.floor((now - x.startedAt) / HOUR);
    if (h < 0 || h >= bins) return;
    const idx = bins - 1 - h;
    if (x.status === 'running') histUtil[idx]++;
  });
  for (let i = 0; i < bins; i++) {
    histUtil[i] = maxSlots ? Math.round(histUtil[i] / maxSlots * 100) : 0;
  }

  return {
    labels: Array.from({ length: bins }, (_, i) => {
      const t = new Date(now - (bins - 1 - i) * HOUR);
      return t.getHours() + ':00';
    }),
    utilization: histUtil,
    throughput,
    latency,
    successRate: success,
    count
  };
}

// ===== 人员脉络图：谁在做什么、负载分布、协作网络 =====
function pulseMap() {
  const q = loadQueue();
  const be = agentmesh.backends();
  const now = Date.now();
  const HOUR = 3600000;
  const running = q.filter(x => x.status === 'running');
  const done = q.filter(x => x.status === 'done' || x.status === 'degraded');

  const backendLoad = {};
  running.forEach(x => {
    const bk = x.backendUsed || x.backend;
    if (!bk) return;
    backendLoad[bk] = (backendLoad[bk] || 0) + 1;
  });

  const typeDist = {};
  q.forEach(x => {
    const arch = x.arch || 'unknown';
    typeDist[arch] = (typeDist[arch] || 0) + 1;
  });

  const statusDist = {
    done: done.filter(x => x.status === 'done').length,
    degraded: done.filter(x => x.status === 'degraded').length,
    failed: q.filter(x => x.status === 'failed').length
  };

  const taskGroups = {};
  q.forEach(x => {
    if (!x.task) return;
    if (!taskGroups[x.task]) taskGroups[x.task] = [];
    taskGroups[x.task].push(x);
  });
  const edges = [];
  Object.entries(taskGroups).forEach(([task, items]) => {
    const backends = [...new Set(items.map(i => i.backendUsed || i.backend).filter(Boolean))];
    if (backends.length > 1) {
      for (let i = 0; i < backends.length - 1; i++) {
        edges.push({ source: backends[i], target: backends[i + 1], task });
      }
    }
  });

  const personnel = be.map(b => {
    const mine = x => (x.backendUsed || x.backend) === b.id;
    const myDone = done.filter(mine);
    const myFail = q.filter(x => mine(x) && x.status === 'failed');
    const myRun = running.filter(mine);
    const ms = myDone.map(x => x.ms || 0);
    return {
      id: b.id,
      label: b.label,
      type: b.type,
      running: myRun.length,
      done: myDone.length,
      failed: myFail.length,
      successRate: (myDone.length + myFail.length) ? Math.round(myDone.length / (myDone.length + myFail.length) * 100) : 100,
      avgMs: ms.length ? Math.round(ms.reduce((a, c) => a + c, 0) / ms.length) : 0,
      strength: b.strength,
      load: backendLoad[b.id] || 0
    };
  });

  const recentDone = done.filter(x => x.finishedAt && (now - x.finishedAt) < HOUR);
  const msRecent = recentDone.map(x => x.finishedAt - x.startedAt).filter(Boolean);

  return {
    personnel,
    backendLoad,
    typeDist,
    statusDist,
    edges,
    summary: {
      totalRunning: running.length,
      totalQueued: q.filter(x => x.status === 'queued').length,
      throughputLastHour: recentDone.length,
      avgLatencyLastHour: msRecent.length ? Math.round(msRecent.reduce((a, c) => a + c, 0) / msRecent.length) : 0
    }
  };
}

// ===== 工作场景动态图：任务流 DAG、执行时间线、依赖热力 =====
function sceneGraph() {
  const q = loadQueue();
  const now = Date.now();
  const HOUR = 3600000;
  const done = q.filter(x => x.status === 'done' || x.status === 'degraded');

  const recent = q.slice(-50);
  const nodes = recent.map((x, i) => ({
    id: x.id,
    label: String(x.task || '').slice(0, 30),
    status: x.status,
    backend: x.backendLabel || x.backend,
    arch: x.arch,
    createdAt: x.createdAt,
    startedAt: x.startedAt,
    finishedAt: x.finishedAt,
    ms: x.ms,
    error: x.error,
    x: i % 10,
    y: Math.floor(i / 10)
  }));

  const taskGroups = {};
  q.forEach(x => {
    if (!x.task) return;
    if (!taskGroups[x.task]) taskGroups[x.task] = [];
    taskGroups[x.task].push(x);
  });
  const edges = [];
  Object.values(taskGroups).forEach(list => {
    list.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    for (let i = 0; i < list.length - 1; i++) {
      if (list[i].finishedAt && list[i + 1].startedAt && list[i].finishedAt <= list[i + 1].startedAt) {
        edges.push({ source: list[i].id, target: list[i + 1].id, type: 'sequential' });
      }
    }
  });

  const timelineBins = 60;
  const timeline = Array(timelineBins).fill(0);
  done.filter(x => x.finishedAt && (now - x.finishedAt) < HOUR).forEach(x => {
    const m = Math.floor((now - x.finishedAt) / 60000);
    if (m >= 0 && m < timelineBins) timeline[timelineBins - 1 - m]++;
  });

  const heatmap = {};
  Object.values(taskGroups).forEach(items => {
    const backs = items.map(i => i.backendUsed || i.backend).filter(Boolean);
    for (let i = 0; i < backs.length - 1; i++) {
      const key = backs[i] + '→' + backs[i + 1];
      heatmap[key] = (heatmap[key] || 0) + 1;
    }
  });

  return { nodes, edges, timeline, heatmap };
}

function jobs(limit) {
  return store.list('orcaJobs', Math.min(50, Number(limit) || 15));
}

function createJob(input) {
  const o = input || {};
  const job = {
    id: store.uid(),
    name: String(o.name || '').slice(0, 120),
    steps: Array.isArray(o.steps) ? o.steps.map(s => ({ task: String(s.task || ''), arch: s.arch || 'auto', backend: s.backend || null })) : [],
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const db = store.read();
  if (!Array.isArray(db[JOBS_KEY])) db[JOBS_KEY] = [];
  db[JOBS_KEY].push(job);
  store.write(db);
  return { ok: true, job };
}

async function runJob(id) {
  const db = store.read();
  const job = (db[JOBS_KEY] || []).find(j => j.id === id);
  if (!job) return { ok: false, error: 'job not found' };
  if (job.status === 'running') return { ok: false, error: 'already running' };
  job.status = 'running';
  job.updatedAt = Date.now();
  store.write(db);

  const results = [];
  for (const step of job.steps) {
    const r = await enqueue({ task: step.task, arch: step.arch, backend: step.backend, priority: 50 });
    results.push(r);
    await new Promise(r => setTimeout(r, 100));
  }
  job.status = 'done';
  job.updatedAt = Date.now();
  store.write(db);
  return { ok: true, job, results };
}

function setSlots(n) {
  const v = Math.max(1, Math.min(10, Number(n) || MAX_CONCURRENCY));
  store.setSetting('orcaSlots', v);
  return { ok: true, slots: v };
}

module.exports = { enqueue, tick, runItem, runAll, board, jobs, createJob, runJob, setSlots, slots, MAX_CONCURRENCY, QUEUE_KEY, chartData, pulseMap, sceneGraph };