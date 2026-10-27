// core/monitor.js — 实时监控告警：关键事件自动推送 Webhook
// 支持：企微/钉钉/飞书/Slack/Discord 等兼容 Incoming Webhook 的平台

const store = require('./store');
const outreachMC = require('./outreach-multichannel');

function getWebhookUrl() {
  return store.getSetting('monitorWebhookUrl') || '';
}

function getWebhookChannel() {
  return store.getSetting('monitorWebhookChannel') || 'webhook';
}

async function push(title, text, level = 'info') {
  const url = getWebhookUrl();
  if (!url) return { ok: false, reason: 'no_webhook_url' };
  // 【冗余清理】PLACEHOLDER 占位符不算真实配置：照发只会每告警一轮打一次注定失败的请求。
  // 如实返回 not_configured，等运营在 /ops.html 换上真实 webhook 后自动恢复推送。
  if (/PLACEHOLDER/i.test(url)) return { ok: false, reason: 'webhook_not_configured' };
  const payload = {
    msgtype: 'markdown',
    markdown: { content: `[${level.toUpperCase()}] **${title}**\n${text}\n\n> 丙大山AI 监控 · ${new Date().toLocaleString('zh-CN')}` }
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 关键事件检查（由 scheduler/loop-integration 调用）
async function checkAndAlert() {
  const db = store.read();
  const money = require('./money');
  const kpi = money.kpi();
  const li = require('./loop-integration');
  const us = li.getUnifiedStatus();
  const pipe = require('./evidence-pipeline');
  const ev = pipe.status();

  const alerts = [];

  // 1. 收到实收
  if (kpi.revenue > 0 && kpi.history.length > 0) {
    const last = kpi.history[kpi.history.length - 1];
    if (!last._alerted) {
      alerts.push({ title: '💰 实收到账', text: `¥${last.amt} (${last.currency}) via ${last.method}`, level: 'success' });
      last._alerted = true;
    }
  }

  // 2. 证据新确认
  if (ev.confirmed > 0) {
    const lastAlertedCount = store.getSetting('monitorLastEvidenceAlerted') || 0;
    if (ev.confirmed > lastAlertedCount) {
      const gate = require('./market-evidence').gateCheck();
      alerts.push({ title: '✅ 新证据确认', text: `已确证据 ${ev.confirmed}/${ev.total}，门禁 ${gate.pass ? 'GO' : 'NO-GO'}`, level: 'info' });
      store.setSetting('monitorLastEvidenceAlerted', ev.confirmed);
    }
  }

  // 3. 目标严重偏离
  if (kpi.pct < 50 && kpi.daysLeft < 90) {
    alerts.push({ title: '⚠️ 目标偏离预警', text: `进度 ${kpi.pct.toFixed(1)}%，剩余 ${kpi.daysLeft} 天，日需 ¥${kpi.needDaily.toFixed(0)}`, level: 'warning' });
  }

  // 4. 触达异常（长时间无回复）
  if (us.outreach.totalSent > 10 && us.outreach.totalReplied === 0) {
    alerts.push({ title: '📭 触达无回复', text: `已发 ${us.outreach.totalSent} 封，0 回复，建议检查模板/渠道`, level: 'warning' });
  }

  // 5. 商业闭环阶段推进
  const lastStageAlerted = store.getSetting('monitorLastStageAlerted') || 0;
  if (us.commercialLoop.stagesStarted > lastStageAlerted) {
    alerts.push({ title: '🔄 闭环阶段推进', text: `${us.commercialLoop.stagesStarted}/8 阶段已启动`, level: 'success' });
    store.setSetting('monitorLastStageAlerted', us.commercialLoop.stagesStarted);
  }

  // 发送告警
  for (const a of alerts) {
    await push(a.title, a.text, a.level);
  }

  return { alerts, kpi: { revenue: kpi.revenue, pct: kpi.pct }, stages: us.commercialLoop.stagesStarted, evidence: ev.confirmed };
}

// 定时检查（可由外部 cron/定时器调用）
function startInterval(ms = 60000) {
  setInterval(() => checkAndAlert().catch(console.error), ms);
  console.log('[monitor] 启动，间隔', ms, 'ms');
}

module.exports = { push, checkAndAlert, startInterval };