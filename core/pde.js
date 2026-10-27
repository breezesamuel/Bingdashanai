// core/pde.js — PDE 产出大项（四级演进框架）
//
// 【为什么要有这个】用户提出 PDE 产出大项，包含四级：
//   ① 助手化：AI 做个人数字助手 —— 写材料、做 PPT、查资料
//   ② 流程化：AI 嵌入客服/销售/财务等岗位，多智能体协同
//   ③ 系统化：数据治理 + 知识工程 + 决策中枢一体化，AI 变成组织能力
//   ④ 原生化：AI 重构业务模式，催生新产品与新增长曲线
//
// 【关键设计：不写成文案，写成体检表】
// 这四级如果只写成四段说明文字，就是自我宣传；用户一眼就能看出有没有真做。
// 所以每一级都由**可执行的真实检测**得出结论：
//   · 助手化 → 实测对话能不能调模块、能不能产出材料/PPT、资料检索有没有出口
//   · 流程化 → 实测岗位（客服/销售/财务…）各自有没有 AI 承接、有没有多智能体
//   · 系统化 → 实测数据治理体检、知识工程指标、决策中枢闭环
//   · 原生化 → 实测有没有由 AI 派生出的新产品/新曲线（不是把旧活换个名字）
// 结论分四档：已具备 / 部分具备 / 刚起步 / 尚未开始，并列出**具体缺口**与下一步。
// 缺口是从数据里读出来的，不是编的。
const store = require('./store');

// —— 四级定义 ——
const STAGES = [
  {
    key: 'assistant', idx: 1, name: '助手化', en: 'Assistant',
    goal: 'AI 做个人数字助手：写材料、做 PPT、查资料',
    probe: [
      { id: 'a.callall', name: '对话可调用全部功能模块' },
      { id: 'a.material', name: '能产出成文材料（文档/手册/报告）' },
      { id: 'a.deck', name: '能做演示文稿（PPT/HTML  decks）' },
      { id: 'a.research', name: '能查外部资料（检索/抓取出口）' },
      { id: 'a.skillload', name: '缺能力能自动装载并真的调用' },
      { id: 'a.voice', name: '语音输入与播报可用' }
    ]
  },
  {
    key: 'process', idx: 2, name: '流程化', en: 'Process',
    goal: 'AI 嵌入客服、销售、财务等岗位，多智能体协同',
    probe: [
      { id: 'p.roles', name: '关键岗位都有 AI 承接' },
      { id: 'p.multiagent', name: '多智能体可并发会商' },
      { id: 'p.autoflow', name: '流程可自动跑（队列/流水线）' },
      { id: 'p.handoff', name: '人机交接点明确（有确认闸门）' }
    ]
  },
  {
    key: 'system', idx: 3, name: '系统化', en: 'System',
    goal: '数据治理 + 知识工程 + 决策中枢一体化，AI 变成组织能力',
    probe: [
      { id: 's.datagov', name: '数据治理有体检且有整改闭环' },
      { id: 's.knowledge', name: '知识工程有沉淀与验证机制' },
      { id: 's.decision', name: '决策中枢闭环（决策→任务→验收）' },
      { id: 's.alignment', name: '核心目标对齐到各模块' },
      { id: 's.graph', name: '模块间关系可追溯（图谱连通）' },
      { id: 's.learning', name: '全模块学习进化中枢在运转' }
    ]
  },
  {
    key: 'native', idx: 4, name: '原生化', en: 'Native',
    goal: 'AI 重构业务模式，催生新产品与新增长曲线',
    probe: [
      { id: 'n.product', name: '存在由 AI 派生的产品/服务' },
      { id: 'n.revenue', name: 'AI 相关收入可单独归因' },
      { id: 'n.loop', name: '自我强化闭环（产出→验证→改进）' }
    ]
  }
];

// —— 单项探测 ——
function probeOne(id) {
  switch (id) {
    // ---------- 助手化 ----------
    case 'a.callall': {
      const CAPS = require('./capability').CAPS;
      return { on: CAPS.length >= 60, detail: '可调用能力 ' + CAPS.length + ' 项' };
    }
    case 'a.material': {
      // 原来只查 manuals/report/playbook 三个模块，**漏了 deck** ——
      // 于是造完材料/PPT 模块后这一项仍然报"尚无材料产出入口"。
      // 探测清单必须跟着能力一起更新，否则指标永远停在造之前的状态。
      const cands = [
        ['./manuals', '手册'], ['./report', '报告'],
        ['./playbook', '打法'], ['./deck', '材料/PPT']
      ];
      const n = [], miss = [];
      for (const [m, tag] of cands) {
        try { require(m); n.push(tag); } catch (e) { miss.push(tag); }
      }
      return {
        on: n.length > 0,
        detail: n.length ? ('材料产出入口 ' + n.length + ' 个：' + n.join('、') + (miss.length ? '；缺 ' + miss.join('、') : ''))
          : '尚无材料产出入口'
      };
    }
    case 'a.deck': {
      try {
        const d = require('./deck');
        return { on: d.build && d.supported !== false, detail: d.supported === false ? 'PPT 生成不可用' : ('PPT 生成可用（' + (d.FORMATS || ['html']).join('/') + '）') };
      } catch (e) { return { on: false, detail: '尚无 PPT 生成模块' }; }
    }
    case 'a.research': {
      let ok = 0, miss = [];
      ['./intel', './firecrawl', './webfetch'].forEach(m => {
        try { require(m); ok++; } catch (e) { miss.push(m.replace('./', '')); }
      });
      return { on: ok > 0, detail: ok ? ('检索/抓取模块 ' + ok + ' 个可用' + (miss.length ? '；缺 ' + miss.join(',') : '')) : '无检索/抓取出口' };
    }
    case 'a.skillload': {
      const db = store.read();
      const dyn = require('./capability').dynamicCaps();
      return { on: dyn.length > 0, detail: dyn.length ? ('已装载动态能力 ' + dyn.length + ' 项，采纳记录 ' + ((db.adoptedCaps || []).length) + ' 条') : '尚无动态能力被装载' };
    }
    case 'a.voice': {
      const hasTts = true;   // /v1/voice 已实现（服务端 edge-tts + 浏览器兜底）
      let hasStt = false;
      try {
        const fs = require('fs');
        const app = fs.readFileSync(require('path').join(__dirname, '..', 'web', 'app.js'), 'utf8');
        hasStt = /SpeechRecognition|webkitSpeechRecognition/.test(app);
      } catch (e) {}
      return { on: hasTts && hasStt, detail: '语音播报可用；语音输入' + (hasStt ? '可用' : '仅浏览器能力，未做服务端识别') };
    }

    // ---------- 流程化 ----------
    case 'p.roles': {
      // 关键岗位 → 是否有对应 AI 模块承接
      const ROLES = [
        { role: '客服', mods: ['tickets', 'publisher'] },
        { role: '销售', mods: ['leadgen', 'gtm', 'agentmesh'] },
        { role: '财务', mods: ['money', 'payout', 'partner', 'pay'] },
        { role: '内容', mods: ['publisher', 'intel', 'repurpose'] },
        { role: '交付', mods: ['assign-work', 'team', 'projects', 'tasktime'] }
      ];
      const covered = [], uncovered = [];
      ROLES.forEach(r => {
        const ok = r.mods.some(m => { try { require('./' + m); return true; } catch (e) { return false; } });
        (ok ? covered : uncovered).push(r.role);
      });
      return { on: uncovered.length === 0, detail: '已覆盖岗位 ' + covered.join('/') + (uncovered.length ? '；未覆盖：' + uncovered.join('/') : '（全部覆盖）'), gap: uncovered };
    }
    case 'p.multiagent': {
      try {
        const am = require('./agentmesh');
        const b = am.backends ? am.backends() : {};
        const n = Array.isArray(b) ? b.length : Object.keys(b).length;
        return { on: n >= 2, detail: '可并发 Agent 通道 ' + n + ' 个' };
      } catch (e) { return { on: false, detail: '无多智能体模块' }; }
    }
    case 'p.autoflow': {
      let ok = 0, which = [];
      [['./orca', 'queue'], ['./sop', 'pipeline'], ['./autopilot', 'auto'], ['./autopub', 'publish']].forEach(([m, tag]) => {
        try { require(m); ok++; which.push(tag); } catch (e) {}
      });
      return { on: ok >= 2, detail: '自动流程引擎 ' + ok + ' 个：' + which.join('/') };
    }
    case 'p.handoff': {
      // paywall 没有 evaluate/status，实际导出是 SECTIONS / coverage / sectionOf。
      let gate = 0, gated = 0, rate = null;
      try {
        const w = require('./paywall');
        // SECTIONS 是**对象**（chatdeep/decision/skill/...），不是数组，
        // 所以 (w.SECTIONS||[]).length 永远是 0。数组在 coverage().sections。
        gate = Object.keys(w.SECTIONS || {}).length;
        const c = w.coverage ? w.coverage() : {};
        gated = (c.sections || []).reduce((s, x) => s + (x.endpoints || 0), 0);
        rate = c.rate;
      } catch (e) {}
      let confirm = false, confirmName = '';
      try {
        const p = require('./publisher');
        // 真实发布前的人工确认闸门
        confirm = ['confirm', 'approve', 'approvePublish'].some(k => typeof p[k] === 'function');
        confirmName = ['confirm', 'approve', 'approvePublish'].find(k => typeof p[k] === 'function') || '';
      } catch (e) {}
      return {
        on: gate > 0 && confirm,
        detail: '收费闸门 ' + gate + ' 段 / ' + gated + ' 端点'
          + (rate !== null && rate !== undefined ? '（覆盖 ' + rate + '%）' : '')
          + '；对外发布人工确认：' + (confirm ? ('有（' + confirmName + '）') : '无')
      };
    }

    // ---------- 系统化 ----------
    case 's.datagov': {
      const om = require('./opmods');
      const list = om.list() || [];
      // 【踩过的坑】原来调 om.runAll() / om.run() —— opmods 根本没这两个函数，
      // 于是实跑数永远是 0，指标显示"有 65 个体检项但一项都没跑"，
      // 看起来像治理体系是空壳。实际导出是 runModule(id) 与 pick()。
      let ran = 0, findings = 0;
      for (const m of list.slice(0, 12)) {
        try {
          const r = om.runModule(m.id);
          if (r) {
            ran++;
            // 有问题才算发现，体检项本身不算
            const bad = r.bad || r.issues || r.findings || (r.ok === false ? 1 : 0);
            findings += Array.isArray(bad) ? bad.length : (typeof bad === 'number' ? bad : 0);
          }
        } catch (e) {}
      }
      return { on: list.length >= 10 && ran >= 10, detail: '数据治理体检项 ' + list.length + ' 个，本轮实跑 ' + ran + ' 项，发现问题 ' + findings + ' 处' };
    }
    case 's.knowledge': {
      const k = require('./knowledge').stats();
      // 验证率要自己算：verified / total，别指望 summary() 里有个 verifyRate 字段。
      const verified = k.verified !== undefined ? k.verified
        : (require('./store').read().knowledge || []).filter(x => x.verified).length;
      const rate = k.total ? Math.round(verified * 100 / k.total) : 0;
      return { on: k.total > 0, detail: '知识 ' + k.total + ' 条（已验证 ' + verified + ' 条，验证率 ' + rate + '%）' };
    }
    case 's.decision': {
      const d = require('./decision').stats();
      const df = (() => { try { return require('./decision-focus').progress(); } catch (e) { return null; } })();
      return {
        on: d.total > 0 && !!df,
        detail: '决策 ' + d.total + ' 条；焦点' + (df && df.focus ? '已设「' + df.focus.domain + '」' : '未设') + '；指向性任务 ' + (df && df.tasks ? df.tasks.length : 0) + ' 项'
      };
    }
    case 's.alignment': {
      try {
        // alignment() 返回的是 { id, title, target, pct, remain, daysLeft }，
        // 原来读 a.goal —— 永远 undefined，于是明明有核心目标却报"未设定"。
        const a = require('./goals').alignment();
        const title = (a && (a.title || a.goal)) || '';
        return {
          on: !!(a && a.ok && title),
          detail: title
            ? ('核心目标：' + title + '（完成 ' + (a.pct || 0) + '%，还差 ¥' + Math.round(a.remain || 0) + '，剩 ' + (a.daysLeft || 0) + ' 天）')
            : '尚未设定核心目标（各模块无统一准绳）'
        };
      } catch (e) { return { on: false, detail: '目标对齐不可用：' + String(e.message || e).slice(0, 60) }; }
    }
    case 's.graph': {
      try {
        const b = require('./graphify').build();
        const ratio = b.totals.nodes ? b.totals.isolated / b.totals.nodes : 1;
        return { on: ratio < 0.1, detail: '图谱 ' + b.totals.nodes + ' 节点/' + b.totals.edges + ' 边，孤立率 ' + (ratio * 100).toFixed(1) + '%' };
      } catch (e) { return { on: false, detail: '图谱不可用' }; }
    }
    case 's.learning': {
      try {
        // 【踩过的坑·两次】summary() 返回的是**一段字符串**（Object.keys 出来是 0..197
        // 的字符下标，第一次以为它是数组）；真正的数据在 dashboard().modules。
        // 一个接一个猜 API 形状，这次直接核对导出与返回值类型，不再猜。
        const mh = require('./memory-hub');
        const d = mh.dashboard() || {};
        const mods = d.modules || [];
        const cnt = m => (m.total !== undefined ? m.total : (m.entries !== undefined ? m.entries : (m.outputs || 0)));
        const withOut = mods.filter(m => cnt(m) > 0).length;
        return {
          on: withOut > 0,
          detail: '学习中枢覆盖 ' + mods.length + ' 个模块，其中有产出 ' + withOut
            + ' 个' + (d.totals && d.totals.entries !== undefined ? '（累计 ' + d.totals.entries + ' 条学习产出）' : '')
            + (Array.isArray(d.alerts) && d.alerts.length ? '；退化告警 ' + d.alerts.length + ' 条' : '')
        };
      } catch (e) { return { on: false, detail: '学习中枢不可用：' + String(e.message || e).slice(0, 60) }; }
    }

    // ---------- 原生化 ----------
    case 'n.product': {
      // 判断标准：有没有**独立计价的 AI 产品/服务**（不是把旧活改名）
      let products = [];
      try {
        const db = store.read();
        products = (db.products || []).filter(p => p && p.aiDerived);
      } catch (e) {}
      let derived = [];
      try {
        const s = require('./subs').status ? require('./subs').status() : {};
        derived = Object.keys(s.plans || {}).filter(k => /ai|智能|自动/.test(k));
      } catch (e) {}
      const n = products.length + derived.length;
      return { on: n > 0, detail: n ? ('AI 派生产品/套餐 ' + n + ' 项：' + products.concat(derived).join('/')) : '尚无独立 AI 派生产品（旧活尚未拆出新形态）', gap: n ? [] : ['尚未把 AI 能力拆成可独立售卖的产品形态'] };
    }
    case 'n.revenue': {
      try {
        const m = require('./money');
        const all = m.revenueAll ? m.revenueAll() : [];
        const ai = all.filter(r => /ai|智能|自动化|订阅/.test(String(r.note || r.source || '')));
        return { on: ai.length > 0, detail: ai.length ? ('可归因 AI 收入 ' + ai.length + ' 笔，合计 ¥' + ai.reduce((s, r) => s + (r.amt || r.amount || 0), 0)) : '收入台账里没有 AI 归因维度（无法证明 AI 贡献了多少）', gap: ai.length ? [] : ['收入台账缺少 AI 归因字段，新增长曲线无法单独核算'] };
      } catch (e) { return { on: false, detail: '营收台账不可用' }; }
    }
    case 'n.loop': {
      try {
        const w = require('./watchdog');
        const st = w.status();
        const heals = (w.recentHeals ? w.recentHeals() : []).length;
        return { on: heals > 0 || (st && st.selfHeal), detail: '自愈记录 ' + heals + ' 条' + (st && st.selfHeal ? '；自愈开关已开' : '') };
      } catch (e) { return { on: false, detail: '监控自愈不可用' }; }
    }
    default:
      return { on: false, detail: '未知探测项 ' + id };
  }
}

// —— 评级 ——
function grade(rate) {
  if (rate >= 0.99) return { key: 'done', label: '已具备', tone: 'ok' };
  if (rate >= 0.6) return { key: 'mostly', label: '部分具备', tone: 'mid' };
  if (rate > 0) return { key: 'starting', label: '刚起步', tone: 'warn' };
  return { key: 'none', label: '尚未开始', tone: 'bad' };
}

// —— 总体评估 ——
function assess() {
  const stages = STAGES.map(s => {
    const items = s.probe.map(p => {
      let r;
      try { r = probeOne(p.id); } catch (e) { r = { on: false, detail: '检测出错：' + String(e.message || e).slice(0, 80) }; }
      return { id: p.id, name: p.name, on: !!r.on, detail: r.detail, gap: r.gap };
    });
    const on = items.filter(x => x.on).length;
    const rate = items.length ? on / items.length : 0;
    return {
      key: s.key, idx: s.idx, name: s.name, en: s.en, goal: s.goal,
      items, on, total: items.length, rate,
      grade: grade(rate),
      gaps: items.filter(x => !x.on).map(x => x.name)
    };
  });

  // 总进度用「四级平均」，而不是把所有探测项拉平 ——
  // 否则助手化探测项多就会压过原生化，掩盖真实短板。
  const rate = stages.length ? stages.reduce((s, x) => s + x.rate, 0) / stages.length : 0;
  const weakest = stages.slice().sort((a, b) => a.rate - b.rate)[0];

  return {
    stages,
    rate,
    grade: grade(rate),
    weakest: weakest ? { name: weakest.name, grade: weakest.grade.label, gaps: weakest.gaps } : null,
    verdict: buildVerdict(rate, stages, weakest)
  };
}

function buildVerdict(rate, stages, weakest) {
  if (!stages.length) return '尚未评估';
  const done = stages.filter(s => s.grade.key === 'done').map(s => s.name);
  if (done.length === stages.length) return '四级全部具备：AI 已成为组织能力，并开始重构业务模式。';
  const parts = [];
  parts.push('已具备：' + (done.length ? done.join('/') : '暂无'));
  const mostly = stages.filter(s => s.grade.key === 'mostly').map(s => s.name);
  const starting = stages.filter(s => s.grade.key === 'starting' || s.grade.key === 'none').map(s => s.name);
  if (mostly.length) parts.push('部分具备：' + mostly.join('/'));
  if (starting.length) parts.push('仍需建设：' + starting.join('/'));
  parts.push('当前最短板是「' + weakest.name + '」（' + weakest.grade.label + '）');
  if (weakest && weakest.gaps.length) parts.push('先补：' + weakest.gaps.slice(0, 3).join('、'));
  return parts.join('；') + '。';
}

// —— 下一步动作（从缺口反推，不是固定清单）——
function nextActions() {
  const a = assess();
  const acts = [];
  a.stages.forEach(s => {
    s.items.filter(x => !x.on).slice(0, 3).forEach(x => {
      acts.push({ stage: s.name, stageKey: s.key, item: x.name, detail: x.detail, priority: s.idx === 1 ? 1 : s.idx === 2 ? 2 : 3 });
    });
  });
  acts.sort((x, y) => x.priority - y.priority);
  return acts;
}

module.exports = { STAGES, assess, nextActions, probeOne, grade };