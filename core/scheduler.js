// core/scheduler.js — 24/7 自主触达调度器（目标驱动版）
//
// 目标：1000万销售目标，半年到一年内完成
// 路径：触达 → 回复 → 成交 → 收款 → 复购
// 策略：24/7 自动触达 + 智能筛选 + 自动跟进 + 诚实报告
//
// 频率控制：每小时最多 5 封，每天最多 30 封（QQ 邮箱安全线）
// 持久化：所有触达记录写入 db.outbound，重启可恢复
// 诚实：没有数据就是 0，绝不用模板填充

const store = require('./store');
const ob = require('./outreach');

const HOURLY_CAP = 5;
const DAILY_CAP = 30;
// 修复：原为 24*3600*000（=0，等于没有冷却），同一邮箱会被每 5 分钟重复轰炸。
const COOLDOWN_MS = 24 * 3600 * 1000; // 同一邮箱 24h 冷却
const SALES_GOAL = 1000000; // 1000万销售目标
const GOAL_DAYS = 180; // 半年目标

let running = false;
let timer = null;

function dayKey(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function hourKey(ts) {
  const d = new Date(ts || Date.now());
  return dayKey(ts) + '-' + String(d.getHours()).padStart(2, '0');
}

function checkLimits(db) {
  const now = Date.now();
  const today = dayKey(now);
  const thisHour = hourKey(now);
  const sent = db.outbound || [];
  const sentToday = sent.filter(x => dayKey(x.at) === today && x.ok).length;
  const sentThisHour = sent.filter(x => hourKey(x.at) === thisHour && x.ok).length;
  return {
    canSend: sentToday < DAILY_CAP && sentThisHour < HOURLY_CAP,
    sentToday, sentThisHour,
    dailyRemaining: Math.max(0, DAILY_CAP - sentToday),
    hourlyRemaining: Math.max(0, HOURLY_CAP - sentThisHour)
  };
}

function inCooldown(db, email) {
  const sent = (db.outbound || []).filter(x => x.to === email && x.ok);
  if (!sent.length) return false;
  const last = Math.max(...sent.map(x => x.at));
  return (Date.now() - last) < COOLDOWN_MS;
}

// 目标进度追踪
function goalProgress() {
  const db = store.read();
  const m = db.money || {};
  const realized = m.realized || 0;
  const pending = m.pending || 0;
  const customers = (db.customers || []).length;
  const candidates = (db.leads || []).filter(l => l.stage === '商机候选').length;
  const sent = (db.outbound || []).filter(x => x.ok).length;
  const replied = (db.outbound || []).filter(x => x.phase === 'reply').length;
  const evidenceCount = (db.marketEvidence || []).length;
  const confirmedEvidence = (db.marketEvidence || []).filter(e => e.confirmed).length;

  // 转化率
  const replyRate = sent ? Math.round(replied / sent * 1000) / 10 : 0;
  const convRate = replied ? Math.round(customers / replied * 1000) / 10 : 0;

  // 目标完成度
  const progressPct = Math.round(realized / SALES_GOAL * 1000) / 10;
  const daysLeft = Math.max(0, GOAL_DAYS - Math.floor((Date.now() - (db.goalStart || Date.now())) / 86400000));
  const dailyNeeded = daysLeft > 0 ? Math.round((SALES_GOAL - realized) / daysLeft) : SALES_GOAL;

  return {
    goal: SALES_GOAL,
    realized,
    pending,
    customers,
    candidates,
    sent,
    replied,
    replyRate,
    convRate,
    evidenceCount,
    confirmedEvidence,
    progressPct,
    daysLeft,
    dailyNeeded,
    // 漏斗健康度
    funnelHealth: sent > 0 ? Math.min(100, Math.round((replied / sent) * 100 * 2)) : 0,
    // 当前阶段诊断
    stage: customers > 0 ? '成交' : candidates > 0 ? '商机候选' : replied > 0 ? '有回复' : sent > 0 ? '已触达' : '未启动'
  };
}

// 合规开关：默认关闭。只有运营显式开启（settings.outreachEnabled=true）才会外发，
// 且只发送给「已明确同意接收」的线索。绝不向抓取来的陌生地址群发。
function outreachEnabled() {
  try { const v = store.getSetting('outreachEnabled'); return v === true || v === 'true'; } catch (e) { return false; }
}

// 仅返回已 opt-in 的线索（consent === true 或阶段标记为「已同意」）
function consentedLeads(db) {
  return (db.leads || []).filter(l => l && l.email && (l.consent === true || l.consent === 'true' || l.stage === '已同意'));
}

// 跑一轮真实触达：只触达已同意接收的线索（不再抓取 GitHub 用户群发）
async function tick() {
  if (running) return { ok: false, skipped: 'already-running' };
  if (!outreachEnabled()) return { ok: true, skipped: 'outreach-disabled', hint: '默认不外发；设置 outreachEnabled=true 后仅向已同意接收的线索发送' };
  running = true;
  try {
    const db = store.read();
    const limits = checkLimits(db);
    if (!limits.canSend) return { ok: true, skipped: 'rate-limit', limits };

    const targets = consentedLeads(db);
    if (!targets.length) return { ok: true, skipped: 'no-consented-leads', consented: 0 };

    let sent = 0, skipped = 0;
    const results = [];

    for (const lead of targets) {
      if (sent >= limits.hourlyRemaining) break;
      if (inCooldown(db, lead.email)) { skipped++; continue; }

      const { subject, html } = ob.compose(lead);
      const cfg = ob.transport();
      if (!cfg || cfg.kind !== 'smtp') { skipped++; continue; }

      const r = await ob.smtpSend(cfg, lead.email, subject, html)
        .then(r => ({ ok: true, code: r.code }))
        .catch(e => ({ ok: false, error: e.message }));

      // 记录留痕（诚实：成功才记 ok:true）
      const d = store.read();
      if (!d.outbound) d.outbound = [];
      d.outbound.push({
        at: Date.now(), leadId: lead.id, name: lead.name,
        to: lead.email, channel: '邮件', subject: subject.slice(0, 80),
        ok: r.ok, phase: 'sent', evidence: r.ok ? ('smtp ' + r.code) : r.error
      });
      store.write(d);

      if (r.ok) sent++;
      results.push({ name: lead.name, email: String(lead.email).slice(0, 3) + '***@***', ok: r.ok });
    }

    return { ok: true, sent, skipped, consented: targets.length, results, limits, goal: goalProgress() };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    running = false;
  }
}

// 自动跟进：对已回复的线索推进阶段 + 发送跟进邮件（仅在启用外发时执行）
async function followUp() {
  if (!outreachEnabled()) return { ok: true, skipped: 'outreach-disabled' };
  const db = store.read();
  const leads = db.leads || [];
  const replied = (db.outbound || []).filter(x => x.phase === 'reply');
  let advanced = 0, followUpSent = 0;

  for (const r of replied) {
    const lead = leads.find(l => l.id === r.leadId);
    if (!lead) continue;

    // 1. 推进阶段
    if (lead.stage === '触达') {
      lead.stage = '推荐';
      lead.touch = Number(lead.touch || 0) + 1;
      advanced++;
    } else if (lead.stage === '推荐' && lead.touch < 3) {
      lead.stage = '选择';
      lead.touch = Number(lead.touch || 0) + 1;
      advanced++;
    }

    // 2. 发送跟进邮件（每个阶段最多 1 次跟进）
    const followUpKey = 'followup_' + lead.stage;
    if (!lead[followUpKey]) {
      const cfg = ob.transport();
      if (cfg && cfg.kind === 'smtp') {
        // 基于阶段的跟进内容
        const followUpTemplates = {
          推荐: { subject: 'Re: 关于 ' + (lead.repo?.split('/').pop() || '项目') + ' 的跟进', html: followUpHtml(lead, '推荐') },
          选择: { subject: 'Re: 进一步了解 ' + (lead.repo?.split('/').pop() || '项目'), html: followUpHtml(lead, '选择') }
        };
        const tmpl = followUpTemplates[lead.stage];
        if (tmpl) {
          const sent = await ob.smtpSend(cfg, lead.email, tmpl.subject, tmpl.html)
            .then(r => ({ ok: true, code: r.code }))
            .catch(e => ({ ok: false, error: e.message }));
          if (sent.ok) {
            lead[followUpKey] = true;
            followUpSent++;
            if (!db.outbound) db.outbound = [];
            db.outbound.push({ at: Date.now(), leadId: lead.id, name: lead.name, to: lead.email, channel: '邮件', subject: tmpl.subject.slice(0, 80), ok: true, phase: 'followup', evidence: 'smtp ' + sent.code });
          }
        }
      }
    }
  }

  if (advanced > 0 || followUpSent > 0) store.write(db);
  return { ok: true, advanced, followUpSent };
}

function followUpHtml(lead, stage) {
  const repoName = lead.repo?.split('/').pop() || '项目';
  const isRecommend = stage === '推荐';
  return '<div style="font-family:sans-serif;max-width:640px">' +
    '<p>你好，' + esc(lead.name || '团队') + '：</p>' +
    '<p>' + (isRecommend
      ? '上次提到『' + esc(repoName) + '』可能与我们做的「AI 决策复盘协作」有重合，想再确认一下：你们在「决策记录·复盘溯源」上是否有痛点？'
      : '既然你们在构建『' + esc(repoName) + '』，想分享我们在「决策记录·复盘溯源」上的具体做法，可提供公开演示，不做未经验证的效果承诺。') + '</p>' +
    '<p>' + (isRecommend
      ? '想先发一份一页纸对比说明（vs 传统文档/Notion），供参考。'
      : '如果有兴趣，约 15 分钟演示一下实际效果。') + '</p>' +
    '<p>如果不需要，直接回复「退订」即可，不再打扰。</p>' +
    '<p>顺祝，<br/>丙大山团队</p></div>';
}

function start(intervalMs) {
  const ms = Number(intervalMs) || 5 * 60 * 1000;
  if (timer) return { ok: false, already: true };
  timer = setInterval(() => {
    tick().catch(() => {});
    followUp().catch(() => {});
  }, ms);
  if (timer.unref) timer.unref();
  return { ok: true, intervalMs: ms };
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  return { ok: true };
}

function status() {
  const db = store.read();
  const limits = checkLimits(db);
  return {
    outreachEnabled: outreachEnabled(),
    consentedLeads: consentedLeads(db).length,
    running: !!timer,
    limits,
    totalSent: (db.outbound || []).filter(x => x.ok).length,
    totalFailed: (db.outbound || []).filter(x => !x.ok).length,
    goal: goalProgress()
  };
}

module.exports = { tick, followUp, start, stop, status, goalProgress, checkLimits, outreachEnabled, consentedLeads, HOURLY_CAP, DAILY_CAP, SALES_GOAL, GOAL_DAYS };
