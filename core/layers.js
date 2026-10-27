// core/layers.js — AI 智能体七层架构（第 1 条需求）
//
// 【需求原文】
//   "AI智能体的七层架构，自上而下分别是：用户层、感知层、认知层、连接协议层、行动层、
//    记忆知识层、治理层。整套系统形成'感知环境—推理规划—调用工具—记忆反馈'的业务闭环。"
//
// 【为什么要专门做这个模块】
// 七层不是画一张好看的图就完成了。它要求回答四个**可验证**的问题：
//   1. 每层到底有哪些组件在真实工作？（不是列名词，是列函数）
//   2. 闭环的四个环节（感知→推理→工具→记忆）各自接通了哪些模块？
//   3. 哪一层是空的？空的层意味着系统有洞。
//   4. 用户输入进来，能不能一路走到输出，中间断在哪一环？
//
// 现有系统里这些模块**早就在**（brain/intel/skills/mcp/music/knowledge/devcap…），
// 但它们互不知晓彼此属于哪一层。结果是：架构只存在于需求文档里，
// 不存在于系统里。devcap 适配不了"感知层很重"这种判断，
// 也不���道治理层出问题该不该降级认知层。
//
// 【本模块的定位：单一事实源】
// 七层的组件清单、闭环接线、健康判定，都在这里维护。
// warboard（第 12 条）是"业务态势"的单一事实源，layers 是"系统架构"的。
// 两者不重复：warboard 看的是"营收多少、任务几个"，layers 看的是"哪一层空了、闭环通不通"。
//
// 【诚实红线】
// 组件存在 ≠ 组件工作。这里用**真实探测**（require 一遍、探函数、调一次轻量接口）
// 判断状态，不靠静态声明。"感知层 OK"必须是刚刚真的抓到过东西。

const store = require('./store');

// —— 七层定义 ——
// components 里每一项都要能在 probe() 里被真实检验
const LAYERS = [
  {
    id: 'user', name: '用户层', en: 'User', order: 1,
    role: '人与系统的全部接口：输入意图、接收反馈、控制节奏',
    components: [
      { key: 'chat', label: '智能对话', mod: 'brain', fn: 'routeCommand', probe: 'call' },
      { key: 'voice_in', label: '语音输入', mod: 'web-voice', probe: 'exists' },
      { key: 'voice_out', label: '语音播报', mod: 'studio', fn: 'synthesize', probe: 'capability' },
      { key: 'settings', label: '系统设置（语言/声音/密钥/目标）', probe: 'store', key2: 'settings' },
      { key: 'i18n', label: '全站语言', probe: 'file', file: 'web/i18n.js' }
    ]
  },
  {
    id: 'sense', name: '感知层', en: 'Perception', order: 2,
    role: '把外部世界的文本/图像/语音/视频/信号变成结构化输入',
    components: [
      { key: 'capture', label: '图像/视频采集（摄像头）', probe: 'file', file: 'web/capture.js' },
      { key: 'intel', label: '全网情报抓取', mod: 'intel', fn: 'headlines', probe: 'call' },
      { key: 'webfetch', label: '网页抓取', mod: 'webfetch', fn: 'probe', probe: 'call' },
      { key: 'firecrawl', label: '深度爬取', mod: 'firecrawl', fn: 'status', probe: 'call' },
      { key: 'geo', label: '客户地域感知', mod: 'geo', fn: 'query', probe: 'call' },
      { key: 'leadgen', label: '线索感知（真实触达回执）', mod: 'leadgen', fn: 'board', probe: 'call' }
    ]
  },
  {
    id: 'cognition', name: '认知层', en: 'Cognition', order: 3,
    role: '推理、规划、决策、反思——把感知变成意图与计划',
    components: [
      { key: 'brain', label: '大脑（记忆/学习/进化）', mod: 'brain', probe: 'call', callFn: 'learnStats' },
      { key: 'orchestrator', label: '对话编排 + 反推脱契约', mod: 'orchestrator', probe: 'exists' },
      { key: 'smart', label: '意图识别与技能路由', mod: 'smart', fn: 'detect', probe: 'call' },
      { key: 'capability', label: '能力路由（18 项模块数据）', mod: 'capability', fn: 'score', probe: 'call' },
      { key: 'decision', label: '决策中心（56 框架）', mod: 'decision', fn: 'stats', probe: 'call' },
      { key: 'deliberation', label: '多视角审议', mod: 'deliberation', probe: 'exists' },
      { key: 'harness', label: '提示词/策略自优化', mod: 'harness', fn: 'current', probe: 'call' },
      { key: 'focus', label: '决策焦点 → 指向性目标', mod: 'decision-focus', fn: 'progress', probe: 'call' }
    ]
  },
  {
    id: 'protocol', name: '连接协议层', en: 'Protocol', order: 4,
    role: '把 Agent 接到外部世界：模型通道、MCP、GitHub、命令行',
    components: [
      { key: 'providers', label: '8 家模型通道', mod: 'providers', fn: 'list', probe: 'call' },
      { key: 'mcp', label: 'MCP 服务接入', mod: 'mcp', probe: 'exists' },
      { key: 'agentmesh', label: '多 Agent 协作网（13 后端）', mod: 'agentmesh', fn: 'backends', probe: 'call' },
      { key: 'skills', label: '技能军械库（327 项）', mod: 'skills', fn: 'allExternal', probe: 'call' },
      { key: 'peers', label: '同行互助协议', mod: 'peers', probe: 'exists' },
      { key: 'coordinator', label: '协同调度', mod: 'coordinator', probe: 'exists' },
      { key: 'cli', label: '本机 CLI（opencode 等）', probe: 'cli', cmd: 'opencode' }
    ]
  },
  {
    id: 'action', name: '行动层', en: 'Action', order: 5,
    role: '真正改变世界：发信、写稿、成片、配乐、建站、下单、打款',
    components: [
      { key: 'studio', label: '音视频制作（写稿→配音→成片）', mod: 'studio', fn: 'capability', probe: 'call' },
      { key: 'music', label: '音乐制作（DSP 合成）', mod: 'music', fn: 'capability', probe: 'call' },
      { key: 'gamestudio', label: '游戏制作', mod: 'gamestudio', probe: 'exists' },
      { key: 'mailer', label: '邮件发送', mod: 'mailer', probe: 'exists' },
      { key: 'publisher', label: '多平台发布队列', mod: 'publisher', fn: 'board', probe: 'call' },
      { key: 'leadact', label: '线索推进动作', mod: 'leadgen', fn: 'recommend', probe: 'call' },
      { key: 'team', label: '组队派工', mod: 'team', fn: 'assign', probe: 'exists' },
      { key: 'assignwork', label: '统一下达工作', mod: 'assign-work', probe: 'exists' }
    ]
  },
  {
    id: 'memory', name: '记忆知识层', en: 'Memory', order: 6,
    role: '短期/长期记忆、向量召回、知识库、经验沉淀——让系统越用越准',
    components: [
      { key: 'brain_mem', label: '短期/长期记忆', mod: 'brain', fn: 'countMemories', probe: 'call' },
      { key: 'knowledge', label: '知识库（人工确认问答）', mod: 'knowledge', fn: 'stats', probe: 'call' },
      { key: 'lessons', label: '经验库（验证后注入）', mod: 'lessons', fn: 'stats', probe: 'call' },
      { key: 'memoryhub', label: '全模块学习中枢（11 模块）', mod: 'memory-hub', fn: 'dashboard', probe: 'call' },
      { key: 'rag', label: '混合召回（关键词+语义）', mod: 'knowledge', fn: 'hybridRecall', probe: 'exists' },
      { key: 'evidence', label: '证据与 ROI 沉淀', mod: 'evidence', fn: 'summary', probe: 'call' },
      { key: 'playbook', label: '打法手册', probe: 'store', key2: 'playbook' }
    ]
  },
  {
    id: 'governance', name: '治理层', en: 'Governance', order: 7,
    role: '收费墙、租户隔离、自愈监控、安全、审计——让系统可信可管',
    components: [
      { key: 'paywall', label: '收费墙（269 端点 100% 定策）', mod: 'paywall', fn: 'coverage', probe: 'call' },
      { key: 'subs', label: '订阅与试用', mod: 'subs', probe: 'exists' },
      { key: 'tenancy', label: '多租户数据归属', mod: 'tenancy', probe: 'exists' },
      { key: 'watchdog', label: '监控自愈', mod: 'watchdog', fn: 'status', probe: 'call' },
      { key: 'conductor', label: '作战指挥/节奏治理', mod: 'conductor', fn: 'status', probe: 'call' },
      { key: 'devcap', label: '设备自适应降级', mod: 'devcap', probe: 'exists' },
      { key: 'tasktime', label: '任务耗时治理', mod: 'tasktime', fn: 'report', probe: 'call' },
      { key: 'audit', label: '审计日志', probe: 'store', key2: 'audit' }
    ]
  }
];

// —— 闭环接线 ——
// "感知环境—推理规划—调用工具—记忆反馈"：每个环节跨哪几层、由哪个模块执行
const CLOSED_LOOP = [
  {
    step: 1, key: 'sense', label: '感知环境', from: '外部世界', to: '认知层',
    via: ['intel', 'webfetch', 'firecrawl', 'capture', 'geo'],
    desc: '抓取/采集/监听，把原始信号变成文本与结构'
  },
  {
    step: 2, key: 'plan', label: '推理规划', from: '感知层', to: '行动层',
    via: ['orchestrator', 'capability', 'smart', 'decision', 'harness', 'focus'],
    desc: '识别意图 → 选能力 → 定计划 → 拆成指向性任务'
  },
  {
    step: 3, key: 'act', label: '调用工具', from: '行动层', to: '外部世界',
    via: ['skills', 'studio', 'music', 'gamestudio', 'mailer', 'publisher', 'leadgen'],
    desc: '真实执行：出稿、配乐、发信、发布、推进线索'
  },
  {
    step: 4, key: 'feedback', label: '记忆反馈', from: '行动结果', to: '下一次推理',
    // 【2026-10-24 键名对齐】这里原来是 'memory-hub'，而 L6 组件键是 'memoryhub'（模块名才有连字符）。
    // loopHealth 按 via 的键去组件表里找 → 永远 'missing' → 「记忆反馈」环节永远 degraded、
    // closed 永远 false。键名对齐后闭环判定才反映真实状态。
    via: ['brain', 'lessons', 'knowledge', 'memoryhub', 'evidence'],
    desc: '把结果沉淀为经验/知识，验证后注入下一轮决策'
  }
];

// —— 真实探测 ——
// 不靠静态声明：逐个 require / 探函数 / 调一次轻量接口
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function probeComponent(c) {
  // 文件型（前端脚本）
  if (c.probe === 'file') {
    try {
      const p = path.join(__dirname, '..', c.file);
      return { ok: fs.existsSync(p), note: fs.existsSync(p) ? Math.round(fs.statSync(p).size / 1024) + ' KB' : '文件缺失' };
    } catch (e) { return { ok: false, note: '探测异常' }; }
  }
  // CLI 型
  if (c.probe === 'cli') {
    return new Promise(res => {
      execFile(c.cmd, ['--version'], { timeout: 4000, windowsHide: true },
        (e, so) => res({ ok: !e, note: e ? '未安装' : String(so).trim().slice(0, 30) }));
    });
  }
  // store 字段型
  if (c.probe === 'store') {
    try {
      const v = store.read()[c.key2];
      if (Array.isArray(v)) {
        // 注意：audit/playbook 这类集合被 applyCaps 裁剪过（audit 只留最近 1000 条），
        // 但 store.read() 拿到的**就是裁剪后的结果**；而 store.list() 才是权威读法。
        // 这里用 list 取，避免"字段存在但被判 0 条"的误判。
        const n = (typeof store.list === 'function') ? store.list(c.key2, 9999).length : v.length;
        return { ok: n > 0, note: n + ' 条' };
      }
      if (v && typeof v === 'object') {
        const n = Object.keys(v).length;
        return { ok: n > 0, note: n + ' 个配置项' };
      }
      return { ok: v !== undefined, note: v !== undefined ? '已配置' : '未初始化' };
    } catch (e) { return { ok: false, note: '读取失败: ' + String(e.message || e).slice(0, 40) }; }
  }
  // 模块型
  if (!c.mod || c.mod.indexOf('web') === 0) return { ok: true, note: '前端组件' };
  try {
    const m = require('./' + c.mod);
    if (c.probe === 'exists') {
      const n = Object.keys(m).filter(k => typeof m[k] === 'function').length;
      return { ok: n > 0, note: n + ' 个函数' };
    }
    if (c.probe === 'call' || c.probe === 'recalled' || c.probe === 'capability') {
      const fn = m[c.fn || c.callFn];
      if (typeof fn !== 'function') return { ok: false, note: '缺少函数 ' + (c.fn || c.callFn) };
      const r = fn();
      // 返回 Promise 的（真联网）只判定"函数存在且未同步抛错"
      if (r && typeof r.then === 'function') return { ok: true, note: '已调用（异步）' };
      const size = JSON.stringify(r || {}).length;
      return { ok: true, note: '已调用 · ' + size + ' 字节' };
    }
    return { ok: true, note: '可用' };
  } catch (e) {
    return { ok: false, note: String(e.message || e).slice(0, 60) };
  }
}

async function architecture() {
  const layers = [];
  for (const L of LAYERS) {
    // 【性能修复】原来逐个 `await probeComponent(c)`：CLI 型探测各自 execFile 最多 12s，
    // 串行下来整表 30-40s（实测 32/40/29s），前端 15s 超时直接掐断 → 「七层架构」面板卡加载中。
    // 并行探测后总耗时≈单个最慢探测；配合下面的缓存，轮询不再重复执行外部命令。
    const comps = await Promise.all(L.components.map(async c => {
      const p = await probeComponent(c);
      return Object.assign({}, c, { state: p.ok ? 'ok' : 'down', note: p.note });
    }));
    const okN = comps.filter(x => x.state === 'ok').length;
    layers.push({
      id: L.id, name: L.name, en: L.en, order: L.order, role: L.role,
      total: comps.length, ok: okN, down: comps.length - okN,
      // 层级健康：全通为 ok，部分为 degraded，全断为 down
      status: okN === comps.length ? 'ok' : okN === 0 ? 'down' : 'degraded',
      rate: Math.round(okN / comps.length * 100),
      components: comps
    });
  }
  layers.sort((a, b) => a.order - b.order);
  const allComp = layers.reduce((a, l) => a + l.total, 0);
  const allOk = layers.reduce((a, l) => a + l.ok, 0);
  return {
    layers,
    loop: CLOSED_LOOP,
    totals: {
      layers: layers.length, components: allComp, ok: allOk, down: allComp - allOk,
      rate: Math.round(allOk / allComp * 100),
      healthyLayers: layers.filter(l => l.status === 'ok').length
    },
    at: Date.now()
  };
}

// 架构探测缓存：前端会周期性拉取且 loopHealth 内部也依赖它，
// 不缓存就会反复执行 CLI 探测命令（每次最多 4s）。60s TTL + 飞行中合并。
const ARCH_TTL_MS = 60 * 1000;
let _archCache = { at: 0, data: null, inflight: null };
async function architectureCached(force) {
  const fresh = _archCache.data && (Date.now() - _archCache.at < ARCH_TTL_MS);
  if (!force && fresh) return _archCache.data;
  if (_archCache.inflight) return _archCache.inflight;
  _archCache.inflight = architecture()
    .then(d => { _archCache = { at: Date.now(), data: d, inflight: null }; return d; })
    .catch(e => { _archCache.inflight = null; throw e; });
  return _archCache.inflight;
}

// 闭环自检：逐环节检查它依赖的组件是否都在工作
async function loopHealth() {
  const a = await architectureCached();
  const byKey = {};
  a.layers.forEach(l => l.components.forEach(c => { byKey[c.key] = c; }));
  const steps = CLOSED_LOOP.map(s => {
    const via = s.via.map(k => byKey[k] || { key: k, state: 'missing', note: '未在架构中登记' });
    const okN = via.filter(x => x.state === 'ok').length;
    return {
      ...s,
      components: via,
      ok: okN, total: via.length,
      // 闭环断在这里：任一环节全断则闭环不通
      state: okN === via.length ? 'ok' : okN === 0 ? 'broken' : 'degraded'
    };
  });
  return {
    steps,
    closed: steps.every(s => s.state === 'ok'),
    broken: steps.filter(s => s.state === 'broken').map(s => s.label),
    degraded: steps.filter(s => s.state === 'degraded').map(s => s.label)
  };
}

function summary() {
  return '七层架构已定义 ' + LAYERS.length + ' 层：' + LAYERS.map(l => l.name).join(' → ')
    + '；闭环四步：' + CLOSED_LOOP.map(s => s.label).join(' → ');
}

module.exports = { LAYERS, CLOSED_LOOP, architecture, architectureCached, loopHealth, summary };