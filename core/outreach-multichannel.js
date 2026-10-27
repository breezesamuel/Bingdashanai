// core/outreach-multichannel.js — 多渠道触达系统
//
// 支持渠道：
//   1. email (SMTP) - 已有
//   2. github_issue - 新增（利用 intel.createIssue）
//   3. webhook (企微/钉钉/飞书) - 已有
//   4. linkedin/twitter - 预留接口
//
// 策略：多触点序列（每渠道不同频率，避免骚扰）
//   第1触点：邮件（SPARK个性化）
//   第2触点：GitHub Issue（技术语境下的自然触达）
//   第3触点：Webhook/企微（如有联系方式）

const intel = require('./intel');
const ob = require('./outreach');
const store = require('./store');

// 渠道配置
const CHANNELS = {
  email: { name: '邮件', dailyCap: 30, hourlyCap: 5, cooldownMs: 24*3600*1000 },
  github_issue: { name: 'GitHub Issue', dailyCap: 10, hourlyCap: 2, cooldownMs: 48*3600*1000 },
  webhook: { name: '企微/钉钉', dailyCap: 20, hourlyCap: 3, cooldownMs: 12*3600*1000 }
};

// 获取渠道传输配置
function getTransport(channel) {
  if (channel === 'email') return ob.transport();
  if (channel === 'github_issue') {
    const tk = intel.gitToken ? intel.gitToken() : '';
    return tk ? { kind: 'github_issue', token: tk } : null;
  }
  if (channel === 'webhook') {
    const st = store.read().settings || {};
    if (st.outreachWebhookUrl) return { kind: 'webhook', url: st.outreachWebhookUrl };
  }
  return null;
}

// 渠道频率检查
function checkChannelLimits(db, channel) {
  const cfg = CHANNELS[channel];
  if (!cfg) return { canSend: false };
  const today = dayKey();
  const thisHour = hourKey();
  const sent = (db.outbound || []).filter(x => x.channel === cfg.name && x.ok);
  const sentToday = sent.filter(x => dayKey(x.at) === today).length;
  const sentThisHour = sent.filter(x => hourKey(x.at) === thisHour).length;
  return {
    canSend: sentToday < cfg.dailyCap && sentThisHour < cfg.hourlyCap,
    sentToday, sentThisHour,
    dailyRemaining: Math.max(0, cfg.dailyCap - sentToday),
    hourlyRemaining: Math.max(0, cfg.hourlyCap - sentThisHour),
    cooldownMs: cfg.cooldownMs
  };
}

function dayKey(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function hourKey(ts) {
  const d = new Date(ts || Date.now());
  return dayKey(ts) + '-' + String(d.getHours()).padStart(2,'0');
}

// 邮件渠道发送
async function sendEmail(lead, subject, html) {
  const cfg = getTransport('email');
  if (!cfg) return { ok: false, error: 'email transport not ready' };
  return ob.smtpSend(cfg, lead.email, subject, html)
    .then(r => ({ ok: true, code: r.code, evidence: 'smtp ' + r.code }))
    .catch(e => ({ ok: false, error: e.message }));
}

// GitHub Issue 渠道发送（真实创建 Issue）
async function sendGitHubIssue(lead, subject, body) {
  const tr = getTransport('github_issue');
  if (!tr) return { ok: false, error: 'github token not configured' };
  return intel.createIssue(lead.repo, subject, body)
    .then(r => ({ ok: r.ok, code: r.issue, evidence: r.ok ? ('github issue #' + r.issue) : r.error, url: r.url }))
    .catch(e => ({ ok: false, error: e.message }));
}

// Webhook 渠道发送
async function sendWebhook(lead, subject, html) {
  const tr = getTransport('webhook');
  if (!tr) return { ok: false, error: 'webhook not configured' };
  return ob.webhookSend(tr.url, lead, subject, html);
}

// 多渠道触达序列：根据触达次数选择渠道
// touch=1: email (SPARK)
// touch=2: github_issue (技术语境)
// touch=3: webhook (如有)
async function executeMultiChannelTouch(lead, touchNumber) {
  const db = store.read();
  const results = [];

  if (touchNumber === 1) {
    // 第1触点：邮件（SPARK 个性化）
    const limits = checkChannelLimits(db, 'email');
    if (limits.canSend && lead.email) {
      const { subject, html } = ob.compose(lead);
      const r = await sendEmail(lead, subject, html);
      await recordOutbound(lead, '邮件', subject, r);
      results.push({ channel: 'email', ok: r.ok });
    }
  } else if (touchNumber === 2) {
    // 第2触点：GitHub Issue（仅对有 repo 的目标）
    const limits = checkChannelLimits(db, 'github_issue');
    if (limits.canSend && lead.repo) {
      const subject = 'Question about ' + (lead.repo?.split('/').pop() || 'your project');
      const body = buildGitHubIssueBody(lead);
      const r = await sendGitHubIssue(lead, subject, body);
      await recordOutbound(lead, 'GitHub Issue', subject, r);
      results.push({ channel: 'github_issue', ok: r.ok });
    }
  } else if (touchNumber >= 3) {
    // 第3+触点：Webhook（如配置了企微/钉钉）
    const limits = checkChannelLimits(db, 'webhook');
    if (limits.canSend) {
      const { subject, html } = ob.compose(lead);
      const r = await sendWebhook(lead, subject, html);
      await recordOutbound(lead, 'Webhook', subject, r);
      results.push({ channel: 'webhook', ok: r.ok });
    }
  }

  return { ok: true, touchNumber, results };
}

// 记录出站触达
async function recordOutbound(lead, channel, subject, result) {
  const db = store.read();
  if (!db.outbound) db.outbound = [];
  db.outbound.push({
    at: Date.now(),
    leadId: lead.id,
    name: lead.name,
    to: lead.email || lead.repo,
    channel,
    subject: subject.slice(0, 80),
    ok: result.ok,
    phase: 'sent',
    evidence: result.evidence || result.code || result.error
  });
  store.write(db);
}

// GitHub Issue 正文构建（技术语境，非推销）
function buildGitHubIssueBody(lead) {
  const repoName = lead.repo?.split('/').pop() || 'project';
  const topics = (lead.topics || []).join(', ');
  return `Hi @${lead.name},

I was exploring \`${lead.repo}\` and noticed you're building **${repoName}** (${topics || 'AI/automation'}) — impressive work.

We're working on a lightweight "decision · review · witness" tool for dev teams that helps with:
- Decision logging that doesn't rot
- Retrospectives with actual traceability
- Handoffs that don't lose context

Since you're deep in ${topics || 'this space'}, I'd value your take: does this problem resonate with your workflow?

If not relevant, feel free to close — no hard feelings. Just thought it might be useful.

Thanks,
丙大山团队`;
}

// 执行完整的多渠道触达轮次
async function runMultiChannelRound() {
  const db = store.read();
  const leads = db.leads || [];

  // 找出需要触达的线索（按 touch 数和阶段）
  const candidates = leads.filter(l => {
    if (l.stage !== '触达' && l.stage !== '推荐' && l.stage !== '选择') return false;
    if (l.muted) return false;
    const touch = Number(l.touch || 0);
    const lastTouch = Number(l.lastTouchAt || 0);
    const cooldown = CHANNELS.email.cooldownMs;
    return touch < 4 && (Date.now() - lastTouch > cooldown || lastTouch === 0);
  }).sort((a, b) => (Number(b.signal||0) - Number(a.signal||0)) || (Number(a.touch||0) - Number(b.touch||0)));

  let executed = 0, results = [];
  for (const lead of candidates) {
    if (executed >= 3) break; // 每轮最多执行 3 个触达

    const touch = Number(lead.touch || 0) + 1;
    const r = await executeMultiChannelTouch(lead, touch);

    // 更新线索 touch 数
    if (r.results.some(x => x.ok)) {
      lead.touch = touch;
      lead.lastTouchAt = Date.now();
      db.leads = db.leads.map(l => l.id === lead.id ? lead : l);
      store.write(db);
      executed++;
    }
    results.push({ lead: lead.name, touch, results: r.results });
  }

  return { ok: true, executed, results };
}

module.exports = {
  CHANNELS,
  getTransport,
  checkChannelLimits,
  sendEmail,
  sendGitHubIssue,
  sendWebhook,
  executeMultiChannelTouch,
  runMultiChannelRound,
  recordOutbound,
  buildGitHubIssueBody
};