// core/commercial-loop.js — 商业闭环编排器
//
// 把获客 → 沟通 → 成交 → 支付 → 物流 → 履约 → 售后 → 自我进化
// 串成一个完整闭环，每个阶段如实报告「是否有真实数据」。
//
// 铁律：
//   - 每个阶段只报告真实数据，没有就是「未启动」，绝不用模板填充
//   - 每个阶段关联对应的 skill（知识/模板）和 evidence 维度（真实证据）
//   - 闭环健康的唯一标准：每个阶段都有真实数据在流转

const store = require('./store');
const pipe = require('./evidence-pipeline');
const me = require('./market-evidence');
// 不直接引用 scheduler，避免循环依赖；goal 数据由 loop-integration 注入

// 商业闭环八阶段定义
// 每阶段：name, skill(关联 skill), evidenceDim(关联证据维度), hasData(是否有真实数据)
const STAGES = [
  {
    id: 'acquisition', name: '获客',
    desc: '找到真实潜在客户',
    skills: ['cold-outreach', 'social-selling', 'lead-qualification'],
    evidenceDim: 'ICP',
    metrics: (db) => ({
      leads: (db.leads || []).length,
      withEmail: (db.leads || []).filter(l => l.email).length,
      // 【诚实口径·2026-10】此前按 phase==='sent' 统计，把"发送失败"的尝试也算成已触达：
      // 实测 db.outbound 500 条里 476 条 ok:false，却被报成「已触达 437」——把失败的群发
      // 粉饰成获客进展，直接违反「没有就是 0」的铁律。成功只认 ok===true。
      outboundSent: (db.outbound || []).filter(x => x.phase === 'sent' && x.ok === true).length,
      outboundAttempted: (db.outbound || []).filter(x => x.phase === 'sent').length,
      consentedLeads: (db.leads || []).filter(l => l.email && (l.consent === true || l.consent === 'true' || l.stage === '已同意')).length
    })
  },
  {
    id: 'communication', name: '沟通',
    desc: '真实触达与对话',
    skills: ['discovery-calls', 'objection-handling'],
    evidenceDim: 'JTBD',
    metrics: (db) => ({
      replies: (db.outbound || []).filter(x => x.phase === 'reply').length,
      optouts: (db.outbound || []).filter(x => x.phase === 'optout').length,
      serviceTickets: (db.outbound || []).filter(x => x.phase === 'reply-service').length
    })
  },
  {
    id: 'conversion', name: '成交',
    desc: '商机推进与转化',
    skills: ['deal-review', 'forecast-discipline', 'crm-hygiene'],
    evidenceDim: 'WTP',
    metrics: (db) => ({
      candidates: (db.leads || []).filter(l => l.stage === '商机候选').length,
      customers: (db.customers || []).length,
      pipelineValue: (db.leads || []).filter(l => l.stage === '商机候选').reduce((s, l) => s + (Number(l.deal) || 0), 0)
    })
  },
  {
    id: 'payment', name: '支付',
    desc: '真实资金到账',
    skills: [],
    evidenceDim: null,
    metrics: (db) => {
      const rev = db.revenue || [];
      // 自测单（本机下单自行确认的钱）不是真金白银，不计入「真实资金到账」——
      // 与 money.kpi() 同一口径，否则闭环面板会把联调测试当成营收（实测虚增 ¥201）。
      const selfTestRows = [];
      let selfTest = 0, selfTestCount = 0;
      try {
        const money = require('./money');
        const byId = new Map((db.orders || []).map(o => [String(o.id), o]));
        rev.forEach(r => {
          if (r && r.amt && r.settled === true && money.isSelfTest(r, byId)) {
            selfTest += Number(r.amt); selfTestCount++; selfTestRows.push(r);
          }
        });
      } catch (e) {}
      const realRows = rev.filter(r => r.settled === true && selfTestRows.indexOf(r) < 0);
      const realized = realRows.reduce((s, r) => s + (Number(r.amt) || 0), 0);
      const refunded = rev.filter(r => r.refunded === true).reduce((s, r) => s + (Number(r.amt) || 0), 0);
      const pending = rev.filter(r => r.settled !== true && r.refunded !== true && r.status !== 'refunded').reduce((s, r) => s + (Number(r.amt) || 0), 0);
      return { realized, selfTest: Math.round(selfTest * 100) / 100, selfTestCount, refunded, pending };
    }
  },
  {
    id: 'logistics', name: '物流',
    desc: '订单履约配送',
    skills: [],
    evidenceDim: null,
    metrics: (db) => {
      const f = db.fulfillment || [];
      return {
        orders: f.length,
        shipped: f.filter(o => o.status === 'SHIPPED' || o.status === '已交付·物流在途' || o.logistics?.no).length,
        delivered: f.filter(o => o.status === 'DELIVERED' || o.status === '已签收' || o.deliveredAt).length
      };
    }
  },
  {
    id: 'fulfillment', name: '履约',
    desc: '服务交付与采用',
    skills: ['adoption-playbook', 'activation-map'],
    evidenceDim: 'RETENTION',
    metrics: (db) => {
      const t = db.tickets || [];
      return {
        tickets: t.length,
        resolved: t.filter(ti => ti.status === 'resolved' || ti.status === 'closed').length
      };
    }
  },
  {
    id: 'aftersales', name: '售后',
    desc: '客户成功与留存',
    skills: ['retention-dashboard', 'sentiment-feedback-loop', 'risk-scoring-framework', 'save-play-library'],
    evidenceDim: 'RETENTION',
    metrics: (db) => ({
      afterSalesTickets: (db.outbound || []).filter(x => x.phase === 'reply-service').length,
      muted: (db.leads || []).filter(l => l.muted).length
    })
  },
  {
    id: 'evolution', name: '自我进化',
    desc: '基于真实证据迭代',
    skills: ['experiment-design-kit', 'guardrail-scorecard', 'hypothesis-library'],
    evidenceDim: null,
    metrics: (db) => ({
      evidenceCount: (db.marketEvidence || []).length,
      confirmedEvidence: (db.marketEvidence || []).filter(e => e.confirmed).length,
      skillCount: 28
    })
  }
];

// 阶段是否有真实数据在流转
function stageHasData(metrics) {
  const vals = Object.values(metrics);
  return vals.some(v => typeof v === 'number' && v > 0);
}

// 闭环整体状态
function status() {
  const db = store.read();
  const evStatus = pipe.status();
  const gate = me.gateCheck();
  const retention = evStatus.retention || {};

  const stages = STAGES.map(s => {
    const metrics = s.metrics(db);
    const hasData = stageHasData(metrics);
    const evDim = s.evidenceDim ? evStatus.dims.find(d => d.dim === s.evidenceDim) : null;
    return {
      id: s.id, name: s.name, desc: s.desc,
      hasData,
      metrics,
      skills: s.skills,
      evidenceDim: s.evidenceDim || null,
      evidenceConfirmed: evDim ? evDim.confirmed : null
    };
  });

  const startedStages = stages.filter(s => s.hasData).length;
  const evidenceDimsReady = evStatus.dims.filter(d => d.confirmed >= 1).length;

  // 【诚实口径纠偏 2026-10】原来 loopHealth = 已建管道段数/总段数，会在"零成交、零证据"时
  // 报出 0.88 的假健康，误导运营者以为闭环快成了。改为：
  //   loopHealth = 已确认证据维度 / 总维度（真实产出占比，0成交=0）
  //   管道进度单独放 wiringPct，两个数分开看：管道齐备 ≠ 闭环成立。
  const evidenceScore = evStatus.dims.length
    ? Math.round((evidenceDimsReady / evStatus.dims.length) * 100) / 100
    : 0;
  const wiringPct = Math.round((startedStages / stages.length) * 100) / 100;

  return {
    ok: true,
    summary: {
      stagesTotal: stages.length,
      stagesStarted: startedStages,
      stagesPending: stages.length - startedStages,
      evidenceDimsReady,
      evidenceDimsTotal: evStatus.dims.length,
      evidenceTotal: evStatus.total,
      evidenceConfirmed: evStatus.confirmed,
      retention,
      // 闭环健康度：只认真实产出证据。零成交时必须是 0，不给"管道建好了"记虚分。
      loopHealth: evidenceScore,
      wiringPct,
      stagesWired: startedStages,
      loopHealthNote: '闭环健康度=已确认证据维度/总维度（真实产出）。管道进度看 wiringPct，两者分开计：管道齐备不等于闭环成立。',
      gatePass: gate.pass,
      gateMissing: gate.missing
    },
    stages,
    evidence: {
      dims: evStatus.dims,
      gate: { pass: gate.pass, missing: gate.missing }
    },
    // 当前最该做的一件事（诚实建议：按真实证据给，不按"管道段数"）
    nextAction: gate.pass
      ? '闭环已成立：守住复购与留存（RETENTION），把真实客户案例沉淀为可复用证据'
      : evStatus.confirmed === 0
        ? '管道已建好但零真实证据。今天只做一件事：拿到第 1 个真实买家的 ICP 证据（他是谁、为什么买）'
        : '继续补全 7 道证据门（当前 ' + evidenceDimsReady + '/7），全过才算商业闭环成立'
  };
}

// 获取某个 skill 的 SKILL.md 内容（供系统/面板读取）
function readSkill(name) {
  const fs = require('fs');
  const path = require('path');
  const p = path.join(__dirname, '..', 'skills', 'agent-skills', name, 'SKILL.md');
  try {
    const content = fs.readFileSync(p, 'utf8');
    const descMatch = content.match(/description:\s*(.+)/);
    return {
      name,
      exists: true,
      description: descMatch ? descMatch[1].trim() : '',
      content
    };
  } catch (e) {
    return { name, exists: false, description: '', content: '' };
  }
}

// 列出所有已装载 skills
function listSkills() {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'skills', 'agent-skills');
  try {
    return fs.readdirSync(dir).filter(f => {
      try { return fs.statSync(path.join(dir, f)).isDirectory(); } catch (e) { return false; }
    }).map(name => readSkill(name)).filter(s => s.exists);
  } catch (e) { return []; }
}

module.exports = { status, readSkill, listSkills, STAGES };
