// core/loop-integration.js — 证据管线 + 商业闭环追踪 + 真实转化优化集成
//
// 统一入口：每轮 tick 后调用 integrate()，完成：
//   1. 证据管线：outbound/reply 自动沉淀为 evidence
//   2. 商业闭环：更新 8 阶段真实数据
//   3. 转化优化：基于真实数据调整触达策略

const store = require('./store');
const pipe = require('./evidence-pipeline');
const cl = require('./commercial-loop');
const mc = require('./outreach-multichannel');
const ob = require('./outreach');
const lg = require('./leadgen');
const sch = require('./scheduler');

// ============ 1. 证据管线集成 ============

// outbound 记录自动转证据（仅 reply 阶段的真实客户回复）
function syncOutboundToEvidence() {
  const db = store.read();
  const outbound = db.outbound || [];
  let synced = 0;

  for (const o of outbound) {
    // 只处理真实回复，且未同步过的
    if (o.phase === 'reply' && !o.evidenceSynced) {
      const r = pipe.captureReply({
        leadId: o.leadId,
        name: o.name,
        channel: o.channel,
        quote: o.text || o.subject || '客户回复',
        outboundRef: outbound.indexOf(o)
      });
      if (r.ok) {
        o.evidenceSynced = true;
        synced++;
      }
    }
    // 退订/售后也记录
    if ((o.phase === 'optout' || o.phase === 'reply-service') && !o.evidenceSynced) {
      const r = pipe.captureManual({
        sourceType: 'email',
        channel: o.channel,
        quote: o.text || o.subject || '客户操作',
        name: o.name,
        leadId: o.leadId,
        note: 'phase=' + o.phase
      });
      if (r.ok) {
        o.evidenceSynced = true;
        synced++;
      }
    }
  }

  if (synced > 0) store.write(db);
  return { ok: true, synced };
}

// ============ 2. 商业闭环状态更新 ============

function updateCommercialLoop() {
  // commercial-loop.js 的 status() 已经读取真实 db 数据
  // 这里注入 goal 数据（避免循环依赖）
  const db = store.read();
  if (!db.goalStart) {
    db.goalStart = Date.now();
    store.write(db);
  }
  const status = cl.status();
  const goal = sch.goalProgress();
  status.goal = goal;
  return status;
}

// ============ 3. 真实转化优化 ============

function optimizeConversion() {
  const db = store.read();
  const status = cl.status();
  const g = status.summary; // commercial-loop 返回 summary 包含 goal 进度

  // 根据真实漏斗数据调整策略
  const adjustments = [];

  // 回复率低 → 优化邮件内容/渠道
  if (g.sent >= 10 && g.replyRate < 5) {
    adjustments.push({
      type: 'low_reply_rate',
      action: '增加 GitHub Issue 渠道权重，优化 SPARK 个性化',
      priority: 'high'
    });
  }

  // 有回复但无成交 → 优化跟进
  if (g.replied >= 3 && g.customers === 0) {
    adjustments.push({
      type: 'no_conversion',
      action: '强化 followUp 跨渠道跟进，发送案例/演示',
      priority: 'high'
    });
  }

  // 证据不足 → 增加人工录入引导
  if (g.evidenceCount < 10) {
    adjustments.push({
      type: 'insufficient_evidence',
      action: '提示人工录入真实对话证据 (scripts/evidence-capture.js)',
      priority: 'medium'
    });
  }

  // 每日触达不足 → 扩大搜索/放宽筛选
  if (g.sent < 10 && g.daysLeft < 150) {
    adjustments.push({
      type: 'low_volume',
      action: '增加每轮搜索目标数到 30，放宽星标筛选',
      priority: 'medium'
    });
  }

  // 写入调整记录
  if (adjustments.length) {
    if (!db.conversionAdjustments) db.conversionAdjustments = [];
    adjustments.forEach(a => {
      db.conversionAdjustments.push({ at: Date.now(), ...a });
    });
    // 只保留最近 50 条
    if (db.conversionAdjustments.length > 50) db.conversionAdjustments = db.conversionAdjustments.slice(-50);
    store.write(db);
  }

  return { ok: true, adjustments };
}

// ============ 统一集成入口 ============

async function integrate() {
  const results = {
    evidence: syncOutboundToEvidence(),
    commercialLoop: updateCommercialLoop(),
    optimization: optimizeConversion()
  };
  return results;
}

// ============ 统一状态查询 ============

function getUnifiedStatus() {
  const loopStatus = cl.status();
  const pipeStatus = pipe.status();
  const mcStatus = mc.CHANNELS ? 'ready' : 'not_loaded';
  const g = sch.goalProgress(); // scheduler 的 goalProgress 包含完整漏斗数据

  return {
    commercialLoop: loopStatus.summary,
    evidence: {
      total: pipeStatus.total,
      confirmed: pipeStatus.confirmed,
      dims: pipeStatus.dims,
      retention: pipeStatus.retention
    },
    outreach: {
      multichannel: mcStatus,
      totalSent: g.sent,
      totalReplied: g.replied,
      replyRate: g.replyRate
    },
    conversion: {
      customers: g.customers,
      candidates: g.candidates,
      funnelHealth: g.funnelHealth,
      stage: g.stage,
      convRate: g.convRate
    },
    goal: {
      progressPct: g.progressPct,
      daysLeft: g.daysLeft,
      dailyNeeded: g.dailyNeeded,
      realized: g.realized,
      pending: g.pending
    },
    adjustments: (store.read().conversionAdjustments || []).slice(-5)
  };
}

module.exports = { integrate, getUnifiedStatus, syncOutboundToEvidence, updateCommercialLoop, optimizeConversion };