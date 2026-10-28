// core/dataq.js — 智能问数（ChatBI-lite）：自然语言 → 意图路由 → 现成聚合器 → 答案 + 图表
//
// 【为什么是这个形态】对标 SQLBot（dataease，LLM+RAG Text-to-SQL）的**问数范式**，
// 但不引入它的独立全栈/SQL 底座（与全仓「零 native 依赖 + Electron 打包」冲突）。
// 我们的数据全在 JSON store 的集合里，且已有 10+ 个真实聚合器（money/saas-loop/crm/
// revenue-ops/gtm/…）。问数缺的不是 SQL 引擎，而是「NL → 该调哪个聚合器」的路由层。
// 本模块补这一层，全程只读、无匹配就如实说能答什么，绝不编数（与 report.js 同纪律）。
//
// 图表：前端已加载 chart.js，本模块产出的 chart 字段是标准 ECharts/Chart.js 配置，
// 可直接渲染；无意义的意图不给图，不硬凑。

'use strict';
const store = require('./store');
function safe(fn, fb) { try { const r = fn(); return r == null ? fb : r; } catch (e) { return fb; } }

// 图表基座（柱状）
function bar(label, data, color) {
  return {
    type: 'bar',
    data: { labels: label.map(x => x.label || x), datasets: [{ label: '数值', data: label.map((x, i) => data[i]), backgroundColor: color || '#38a169', borderRadius: 4 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  };
}

// ---- 各意图（关键词加权匹配 → 调现成聚合器 → 答案 + 可选图表）----
const INTENTS = {
  revenue: {
    label: '营收', keys: ['营收', '收入', '赚', '到账', '结算', '回款', 'revenue'],
    run() {
      const money = require('./money');
      const k = safe(() => money.kpi(), {});
      const lines = [];
      if (k.revenue != null) lines.push('已结算实收 ¥' + k.revenue + '（自测单已剔除 ¥' + (k.testRevenue || 0) + '）');
      if (k.pending != null) lines.push('挂账未付 ¥' + (k.pending || 0));
      if (k.refunded != null) lines.push('退款 ¥' + (k.refunded || 0));
      if (k.onTrack != null) lines.push('千万目标进度 ' + (k.pct || 0) + '%（' + (k.onTrack ? '在轨道上' : '落后') + '）');
      const has = lines.length > 0;
      return {
        answer: has ? lines.join('；') : '营收口径当前无数据（尚无结算/挂账记录）。',
        chart: has ? { type: 'metric', items: [
          { label: '实收', value: k.revenue || 0 }, { label: '自测剔除', value: k.testRevenue || 0 },
          { label: '挂账', value: k.pending || 0 }, { label: '退款', value: k.refunded || 0 }
        ] } : null
      };
    }
  },
  funnel: {
    label: '订阅漏斗', keys: ['漏斗', '转化', '各阶段', '访问', '订阅漏斗', 'funnel'],
    run() {
      const saas = require('./saas-loop');
      const f = safe(() => saas.funnel(), null);
      const stages = (f && f.stages) || [];
      if (!stages.length) return { answer: '订阅漏斗当前无数据。', chart: null };
      return {
        answer: stages.map(x => x.name + ' ' + x.count + (x.conversionPct != null ? '(' + x.conversionPct + '%)' : '')).join(' → '),
        chart: bar(stages.map(x => x.name), stages.map(x => x.count))
      };
    }
  },
  stickiness: {
    label: '粘性/留存', keys: ['粘性', '留存', '活跃', 'WAU', 'MAU', '周活'],
    run() {
      const saas = require('./saas-loop');
      const s = safe(() => saas.stickiness(), null);
      if (!s || s.wau == null) return { answer: '粘性指标当前无使用埋点数据。', chart: null };
      const pct = s.stickinessPct == null ? '（MAU=0，不可计算）' : s.stickinessPct + '%';
      return { answer: '周活 ' + s.wau + ' / 月活 ' + s.mau + '，粘性率 ' + pct + '（沉默付费 ' + (s.dormantPaid != null ? s.dormantPaid : 0) + '）。', chart: { type: 'metric', items: [
        { label: '周活', value: s.wau }, { label: '月活', value: s.mau }, { label: '沉默付费', value: s.dormantPaid != null ? s.dormantPaid : 0 } ] } };
    }
  },
  crm: {
    label: '客户/线索', keys: ['客户', '线索', 'CRM', '商机', '成交'],
    run() {
      const crm = require('./crm');
      const s = safe(() => crm.summary(), {});
      const parts = [];
      if (s.leads != null) parts.push('线索 ' + s.leads);
      if (s.opportunities != null) parts.push('商机 ' + s.opportunities);
      if (s.customers != null) parts.push('客户 ' + s.customers);
      return { answer: parts.length ? parts.join('，') : 'CRM 当前无线索/商机/客户记录。', chart: null };
    }
  },
  nrr: {
    label: '复购/NRR', keys: ['复购', 'NRR', '净收入留存', '扩张', 'repeat'],
    run() {
      const ro = require('./revenue-ops');
      const n = safe(() => ro.nrr(), null);
      if (!n || n.repeatPayers == null) return { answer: 'NRR 当前无法计算（无付费历史）。', chart: null };
      const pct = n.nrr == null ? '有复购/退款，NRR 需按口径核算（本模块只观测不脑补）' : n.nrr + '%';
      return { answer: '复购付款人 ' + n.repeatPayers + '（非体验付费单 ' + n.repeatPayOrders + '），NRR ' + pct + '。', chart: null };
    }
  },
  leak: {
    label: '漏钱诊断', keys: ['漏钱', '哪里漏', '诊断', '漏水'],
    run() {
      const ro = require('./revenue-ops');
      const l = safe(() => ro.leak(), {});
      const items = l.issues || [];   // 字符串数组（非对象）
      return { answer: items.length ? '发现 ' + items.length + ' 处漏钱点：' + items.slice(0, 3).join('；') : '未发现明显漏钱点（漏斗无断点、无挂账/退款）。', chart: null };
    }
  },
  todo: {
    label: '今日赚钱动作', keys: ['今天', '待办', '下一步', '先做', '动作'],
    run() {
      const ro = require('./revenue-ops');
      const t = safe(() => ro.todaysActions(), {});
      const acts = Array.isArray(t) ? t : (t.actions || []);
      return { answer: acts.length ? '建议先做：' + acts.slice(0, 3).map(a => a.title || a).join(' → ') : '当前无待办赚钱动作。', chart: null };
    }
  },
  partner: {
    label: '合伙人', keys: ['合伙人', '分成', '招募', '分润'],
    run() {
      const p = require('./partner');
      const b = safe(() => p.board(), {});
      const n = Array.isArray(b.partners) ? b.partners.length : (b.partners || 0);
      return { answer: '合伙人 ' + n + '，平台抽成 ' + (b.platformPct || 0) + '% / 合伙人 ' + (b.partnerPct || 0) + '%（单层·零入门费·锚定真实成交）。', chart: null };
    }
  },
  ticket: {
    label: '客服/工单', keys: ['工单', '客服', 'SLA', '售后'],
    run() {
      const cs = require('./cs-sla');
      const b = safe(() => cs.board(), {}) || {};
      const c = b.cs || {};
      return { answer: '客服' + (c.standby ? '待命' : '有积压未结工单 ' + (c.open || 0)) + '，SLA 超时 ' + (c.slaOverdue || 0) + '，沉默付费客户 ' + (b.dormantPaid != null ? b.dormantPaid : 0) + '（可关怀挽回）。', chart: null };
    }
  },
  trial: {
    label: '试用转正', keys: ['试用', '未转正', '转正'],
    run() {
      const tc = require('./trial-conversion');
      const b = safe(() => tc.board(), {});
      return { answer: '真实试用未转正 ' + (b.realTrialers ? b.realTrialers.length : 0) + '（自测 ' + (b.selfTestExcluded || 0) + ' 已剔除）。', chart: null };
    }
  },
  stress: {
    label: '性能/压测', keys: ['压测', '性能', 'RPS', '瓶颈', '吞吐'],
    run() {
      const sl = require('./stresslab');
      const b = safe(() => sl.board(), {});
      return { answer: '压测目标 ' + (b.availableTargets || []).length + ' 个（' + (b.availableTargets || []).join('/') + '），阈值 ' + JSON.stringify(b.config || {}).slice(0, 60) + '。', chart: null };
    }
  },
  storage: {
    label: '存储引擎', keys: ['存储', '引擎', '分片', 'shard'],
    run() {
      const se = require('./storage-engine');
      const b = safe(() => se.board(), {});
      return { answer: '当前引擎 ' + (b.engine ? b.engine.engine : '?') + '（injected=' + (b.engine ? b.engine.injected : '?') + '），迁移闸 ' + (b.migrateReadiness ? b.migrateReadiness.ok : '?') + '。', chart: null };
    }
  }
};

// 意图匹配（关键词加权，命中多者胜；无命中→返回「能答什么」清单，不编）
function ask(question) {
  const q = String(question || '').trim().toLowerCase();
  let best = null, bestScore = 0;
  for (const name of Object.keys(INTENTS)) {
    const keys = INTENTS[name].keys;
    let score = 0;
    for (const k of keys) { if (q.includes(k.toLowerCase())) score += k.length; } // 长词更精确
    if (score > bestScore) { bestScore = score; best = name; }
  }
  if (!best) {
    return {
      ok: true, matched: null,
      answer: '没有匹配的问数意图。我能答的：' + Object.values(INTENTS).map(x => x.label).join('、') + '。',
      canAnswer: Object.values(INTENTS).map(x => x.label), chart: null
    };
  }
  const res = INTENTS[best].run();
  return { ok: true, matched: INTENTS[best].label, intent: best, answer: res.answer, chart: res.chart };
}

// 面板：列出全部可问意图（只读）
function board() {
  return {
    ok: true, at: Date.now(),
    intents: Object.keys(INTENTS).map(n => ({ intent: n, label: INTENTS[n].label, keys: INTENTS[n].keys.slice(0, 4) })),
    howto: 'POST /v1/dataq/ask {question:"…"} 或 GET /v1/dataq/ask?q=…',
    honesty: '全程只读调现有聚合器；无匹配不编数；图表为 chart.js 配置，前端可直接渲染。'
  };
}

module.exports = { INTENTS, ask, board };
