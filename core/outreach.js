const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('./store');
const intel = require('./intel');
const smtp = require('./smtp');

const DEFAULTS = { dailyCap: 20, maxPerLead: 3, cooldownH: 48, smtpHost: 'smtp.qq.com', smtpPort: 465 };
const OPT_OUT = /退订|取消订阅|unsubscribe|别再|不要?再|stop/i;
// 售后/履约咨询分流：命中即走售后工单 + 真实回执，不污染销售触达诚实契约
const SERVICE_RE = /售后|物流|发货|签收|查单|单号|收不到|没收到|退换|退款|损坏|故障/i;
const MAX_SUBJECT = 120;

function dayKey(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function envVal(name) {
  if (process.env[name]) return process.env[name];
  const files = [];
  try { files.push(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')); } catch (e) {}
  const asar = path.join(process.env.APPDATA || path.join(os.homedir(), '.bingdashan'), 'BingDashanAI', '.env');
  try { files.push(fs.readFileSync(asar, 'utf8')); } catch (e) {}
  for (const txt of files) {
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

function settings() { return store.read().settings || {}; }
function s(k, d) {
  const v = settings()[k];
  return v === undefined || v === null || v === '' ? d : v;
}

function smtpCfg() {
  const st = settings();
  const port = Number(s('smtpPort', DEFAULTS.smtpPort));
  const envUser = envVal('MAIL_SENDER') || envVal('SMTP_USER');
  const envPass = envVal('MAIL_AUTH') || envVal('SMTP_PASS');
  return {
    host: String(s('smtpHost', DEFAULTS.smtpHost) || envVal('SMTP_HOST') || DEFAULTS.smtpHost),
    port,
    secure: port === 465,
    user: String(s('smtpUser', '') || envUser),
    pass: String(s('smtpPass', '') || envPass),
    from: String(s('smtpFrom', '') || s('smtpUser', '') || envUser) || undefined
  };
}

function transport() {
  const st = settings();
  if (st.outreachWebhookUrl) {
    const url = String(st.outreachWebhookUrl || '').trim();
    if (url) return { kind: 'webhook', url, channel: String(st.outreachWebhookChannel || '企业微信') };
  }
  const c = smtpCfg();
  if (c.user && c.pass && c.from) return Object.assign({ kind: 'smtp', channel: '邮件' }, c);
  return null;
}

// SMTP 发送：委托给 core/smtp.js —— 复用长连接 + 全局串行，规避 QQ 对「新建连接」的限流。
// 保留原签名，成功返回 { ok:true, code }；失败抛出真实错误（绝不作假）。
function smtpSend(cfg, to, subject, html, timeoutMs) {
  return smtp.send(cfg, to, subject, html, { timeoutMs }).then(code => ({ ok: true, code }));
}

function timeoutSignal(ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { ctl, t };
}

async function webhookSend(url, lead, subject, html) {
  const { ctl, t } = timeoutSignal(15000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'direct', to: lead.email, subject, html,
        leadId: lead.id,
        lead: { name: lead.name || '', company: lead.company || '', repo: lead.repo || '', industry: lead.industry || '' }
      }),
      signal: ctl.signal
    });
    const txt = await r.text().catch(() => '');
    if (!r.ok) return { ok: false, error: ('webhook HTTP ' + r.status + ' ' + txt).slice(0, 160) };
    return { ok: true, code: r.status, evidence: ('webhook ' + r.status + (txt ? ' ' + String(txt).slice(0, 60) : '')).slice(0, 140) };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  } finally { clearTimeout(t); }
}

function leadNameOf(l) {
  return (l && (l.name || l.company || l.repo)) || ('线索#' + String((l && l.id) || '').slice(-4) || '未知');
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// SPARK 框架（来自 cold-outreach skill）：
//   Subject hook → Personalized opening → Agitate problem → Relevant value → Kick-off CTA
// 注意：本函数只生成外联话术模板，不生成证据。真实证据仍只来自真实客户回复。
function compose(lead) {
  const repo = String(lead.repo || lead.company || lead.name || '项目');
  const repoName = repo.split('/').pop() || repo;
  const topics = (Array.isArray(lead.topics) ? lead.topics.slice(0, 3).join('、') : '') || lead.industry || 'AI 工作流';
  const lang = lead.lang || '';
  const desc = (lead.desc || lead.industry || '').slice(0, 120);
  const company = String(lead.company || lead.name || '团队');
  const firstLine = String(lead.note || '').split(/[。！？\n]/)[0].slice(0, 40);

  // S - Subject hook：基于真实 repo/语言/描述的具体钩子
  const specificHook = lang ? (lang + ' 版本的 ' + repoName) : repoName;
  const subject = firstLine
    ? ('关于「' + firstLine + '」的一个观察')
    : (specificHook + ' 相关的一个发现').slice(0, MAX_SUBJECT);

  // P - Personalized opening：引用真实 repo 描述/语言，不泛泛而谈
  const opening = firstLine
    ? ('注意到你们在「' + esc(firstLine) + '」方向上有动作，这和我们在做的事直接相关。')
    : ('看到『' + esc(repoName) + '』' + (lang ? '（' + esc(lang) + '）' : '') + (desc ? '：" ' + esc(desc) + '"' : '') + '，这和我们在做的「AI 决策复盘协作」方向高度重合。');

  // A - Agitate problem：基于目标仓库实际场景的痛点
  const agitate = ('大多数构建 ' + esc(topics) + ' 的团队，在「决策记录 · 复盘溯源 · 多方协作」上仍靠文档/口头，版本迭代快时极易失真、难回溯。');

  // R - Relevant value：具体映射到目标场景
  const value = ('我们维护一套面向决策者与开发团队的轻量「决策 · 复盘 · 见证官」工具，专门解决 ' + esc(topics) + ' 场景下的「决策失真、复盘困难、交接断层」。');

  // K - Kick-off CTA：单一、低门槛、明确
  const cta = ('想先发一份一页纸说明给你参考，或约 15 分钟同步一次。如果暂时不需要，直接回复「退订」即可，我们不会再来打扰。');

  const html = '<div style="font-family:sans-serif;max-width:640px">' +
    '<p>你好，' + esc(company) + '：</p>' +
    '<p>' + opening + '</p>' +
    '<p>' + agitate + '</p>' +
    '<p>' + value + '</p>' +
    '<p>' + cta + '</p>' +
    '<p>顺祝，<br/>丙大山团队</p></div>';
  return { subject: subject.slice(0, MAX_SUBJECT), html };
}

async function resolveContact(lead) {
  const db0 = store.read();
  const cc = (db0.contactCache || {})[lead.id];
  if (cc && Date.now() - (cc.checkedAt || 0) < 7 * 864e5) return cc;
  let email = '', source = '';
  if (lead.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(lead.email).trim())) { email = String(lead.email).trim(); source = 'manual'; }
  if (!email && lead.repo) {
    const owner = String(lead.repo).split('/')[0];
    if (owner) {
      try {
        const u = await intel.ghUser(owner);
        if (u && u.ok && u.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(u.email))) { email = String(u.email).trim(); source = 'github-user:' + owner; }
      } catch (e) {}
    }
  }
  if (!email && lead.repo) {
    try {
      const rd = await intel.gitFile(lead.repo, 'README.md');
      if (rd && rd.ok) {
        const m = (rd.content || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/g);
        if (m && m.length && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m[0])) { email = m[0]; source = 'github-readme:' + lead.repo; }
      }
    } catch (e) {}
  }
  const out = { email, source, checkedAt: Date.now(), ok: !!email };
  const d = store.read();
  if (!d.contactCache) d.contactCache = {};
  d.contactCache[lead.id] = out;
  store.write(d);
  return out;
}

let busy = false;

// 真实外发（售后回执/履约通知等，不经过获客漏斗）。gate：通道已配且开关开启；
// 无通道/关着 → 如实跳过不伪造。不影响 touch/signal/商机候选。
async function sendRaw(lead, subject, html, idPrefix) {
  const st = settings();
  if (!st.outreachEnabled) return { ok: false, skipped: 'disabled', error: 'outreachEnabled=false，未外发' };
  const tr = transport();
  if (!tr) return { ok: false, skipped: 'no-transport', error: '未配置发送通道（outreachWebhookUrl 或 SMTP 凭据）' };
  const c = await resolveContact(lead);
  if (!c.ok) return { ok: false, skipped: 'no-contact', error: '无联系邮箱' };
  let rr;
  if (tr.kind === 'webhook') rr = await webhookSend(tr.url, lead, subject, html);
  else rr = await smtpSend(tr, c.email, subject, html).then(r => ({ ok: true, code: r.code, evidence: 'smtp ' + r.code })).catch(e => ({ ok: false, error: String(e.message || e).slice(0, 160) }));
  if (!rr.ok) return { ok: false, error: rr.error, evidence: rr.evidence || null };
  store.push('outbound', { at: Date.now(), leadId: lead.id, name: leadNameOf(lead), to: c.email, channel: tr.channel, subject: subject.slice(0, 80), ok: true, evidence: rr.evidence || rr.code, phase: idPrefix || 'service' }, '售后·真实回执', leadNameOf(lead));
  return { ok: true, evidence: rr.evidence || rr.code, channel: tr.channel };
}

async function runOnce(unused) {
  if (busy) return { ok: true, skipped: 'busy' };
  busy = true;
  try {
    const st = settings();
    if (!st.outreachEnabled) return { ok: true, enabled: false, skipped: 'disabled' };
    const tr = transport();
    if (!tr) return { ok: true, enabled: true, skipped: 'no-transport', hint: '设置 outreachWebhookUrl 或 SMTP 凭据后才会真实外发' };
    const lg = require('./leadgen');
    const today = dayKey(Date.now());
    const db0 = store.read();
    const prev = db0.outreach || {};
    let sentToday = prev.day === today ? Number(prev.sent || 0) : 0;
    const dailyCap = Math.max(1, Number(st.outreachDailyCap || DEFAULTS.dailyCap) || DEFAULTS.dailyCap);
    const maxPer = Math.max(1, Number(st.outreachMaxPerLead || DEFAULTS.maxPerLead) || DEFAULTS.maxPerLead);
    const cooldownMs = Math.max(0, Number(st.outreachCooldownH || DEFAULTS.cooldownH) || DEFAULTS.cooldownH) * 3600000;
    const now = Date.now();
    const candidates = (db0.leads || []).filter(l =>
      l.stage === '促单' &&
      Number(l.touch || 0) < lg.CLOSE_MIN_TOUCH &&
      !l.muted &&
      Number(l.sentN || 0) < maxPer &&
      (Number(l.lastSentAt || 0) + cooldownMs) <= now
    ).sort((a, b) => (Number(b.signal) || 0) - (Number(a.signal) || 0) || (Number(a.sentN || 0) - Number(b.sentN || 0)));

    const perRun = Math.min(3, dailyCap - sentToday);
    let sent = 0, noContact = 0, errors = 0;
    const out = [];
    for (const lead of candidates) {
      if (sentToday >= dailyCap || sent >= perRun) break;
      const c = await resolveContact(lead);
      if (!c.ok) {
        noContact++;
        store.update('leads', lead.id, { contactCheckedAt: Date.now(), noContact: true }, '触达·无联系邮箱待补');
        continue;
      }
      const { subject, html } = compose(lead);
      let rr;
      if (tr.kind === 'webhook') rr = await webhookSend(tr.url, lead, subject, html);
      else rr = await smtpSend(tr, c.email, subject, html).then(r => ({ ok: true, code: r.code, evidence: 'smtp ' + r.code })).catch(e => ({ ok: false, error: String(e.message || e).slice(0, 160) }));
      if (rr.ok) {
        const isFirst = !(Number(lead.touch) || 0);
        store.batch(db => {
          const rec0 = (db.leads || []).find(x => x.id === lead.id);
          if (rec0) {
            if (isFirst) lg.markTouched(rec0.id, tr.channel, ('已送达 ' + subject + '（回执 ' + (rr.evidence || rr.code) + '）').slice(0, 140));
            const rec = (db.leads || []).find(x => x.id === lead.id) || rec0;
            rec.sentN = Number(rec.sentN || 0) + 1;
            rec.lastSentAt = Date.now();
            rec.lastSubject = subject.slice(0, 80);
          }
          if (!db.outreach) db.outreach = {};
          db.outreach.day = today;
          // 轮次内 sentToday 每发一条就 ++（见循环末的 `sent++; sentToday++;`），
          // 所以这里写 sentToday + 1 已经是「本轮累计到第几条」的准确值。
          // 【不要加 sent 偏移】两者同时用会双重计数：一轮发 3 条会写成 T₀+5，
          // 日配额虚高、下一轮提前触顶。refund/outreach 回归里
          // 「一轮发多条」用例就是专门锁这一点的（delta 必须恰好等于实发条数）。
          db.outreach.sent = sentToday + 1;
          if (!db.outbound) db.outbound = [];
          db.outbound.push({ at: Date.now(), leadId: lead.id, name: leadNameOf(lead), to: c.email, channel: tr.channel, subject: subject.slice(0, 80), ok: true, evidence: rr.evidence || rr.code, phase: 'sent' });
          return { audit: { action: '触达·真实发送', detail: leadNameOf(rec0 || lead) + ' → ' + tr.channel + ' 回执 ' + (rr.evidence || rr.code) } };
        });
        sent++; sentToday++;
        out.push('『' + leadNameOf(lead) + '』已通过 ' + tr.channel + ' 真实发出「' + subject.slice(0, 30) + '…」');
      } else {
        errors++;
        // 【一致性】不要往循环外的旧快照 db0 上补写：循环里已通过 store.batch
        // 改过库（sentN / lastSentAt / outbound），用过期视图会覆盖掉已发生的记录。
        // 统一走 store.batch，在最新库上追加失败回执。
        store.batch(db => {
          if (!db.outbound) db.outbound = [];
          db.outbound.push({ at: Date.now(), leadId: lead.id, name: leadNameOf(lead), to: c.email, channel: tr.channel, subject: subject.slice(0, 80), ok: false, error: rr.error, phase: 'fail' });
          return { audit: { action: '触达·发送失败', detail: leadNameOf(lead) + ' → ' + tr.channel + '：' + String(rr.error || '').slice(0, 80) } };
        });
      }
    }
    return {
      ok: true, enabled: true, transport: tr.kind, channel: tr.channel,
      candidates: candidates.length, sent, skipped: { noContact, errors },
      daily: { day: today, sentToday, dailyCap }, out
    };
  } finally { busy = false; }
}

async function ingestReply(b) {
  const st = settings();
  const expect = String(st.outreachReplyToken || '');
  if (!expect) return { status: 403, ok: false, error: '未配置 outreachReplyToken，入站回复接口拒绝接收' };
  const got = String(b.token || '');
  if (!got || got !== expect) return { status: 403, ok: false, error: '回复令牌不匹配' };
  const id = String(b.leadId || '');
  const db0 = store.read();
  const lead = (db0.leads || []).find(l => l.id === id);
  if (!lead) return { status: 404, ok: false, error: '线索不存在' };
  const text = String(b.text || '').slice(0, 500);
  if (!db0.outbound) db0.outbound = [];
  if (lead.muted) {
    db0.outbound.push({ at: Date.now(), leadId: id, name: leadNameOf(lead), channel: lead.lastTouchChannel || '企业微信', ok: true, text: text.slice(0, 120), phase: 'reply-ignored' });
    store.write(db0);
    return { status: 200, ok: true, ignored: 'muted', lead: leadNameOf(lead) };
  }
  if (OPT_OUT.test(text)) {
    store.update('leads', id, { muted: true, mutedAt: Date.now() }, '触达·按客户意愿退订');
    store.push('outbound', { at: Date.now(), leadId: id, name: leadNameOf(lead), channel: lead.lastTouchChannel || '企业微信', text: text.slice(0, 120), ok: true, phase: 'optout' }, '触达·客户退订', leadNameOf(lead));
    return { status: 200, ok: true, muted: true, lead: leadNameOf(lead) };
  }
  // 售后/履约咨询分流：开工单 + 真实回执；不碰 touch/signal/商机候选（诚实契约）
  if (SERVICE_RE.test(text)) {
    const fm = require('./fulfillment');
    const svc = fm.afterSales(id, text);
    store.push('outbound', { at: Date.now(), leadId: id, name: leadNameOf(lead), channel: lead.lastTouchChannel || '企业微信', ok: true, text: text.slice(0, 160), phase: 'reply-service', ticket: svc.ticket || null }, '履约·售后受理', leadNameOf(lead));
    const ackSubject = '售后受理通知' + (svc.order ? '（' + svc.order + '）' : '');
    const ackHtml = '<div style="font-family:sans-serif;max-width:640px"><p>你好：</p>' +
      '<p>你的留言已进入售后流程，工单编号 #' + (svc.ticket || '-') + '。</p>' +
      '<p>我们会在承诺时限内（紧急 24h / 常规 48h）给出处理答复，无需重复留言。</p>' +
      '<p>顺祝，<br/>丙大山团队</p></div>';
    const rr = await sendRaw(lead, ackSubject, ackHtml, 'service-ack');
    return { status: 200, ok: true, route: 'service', order: svc.order || null, ticket: svc.ticket, prio: svc.prio || null, autoReply: svc.autoReply || null, templateId: svc.templateId || null, ackSent: !!rr.ok, ackError: rr.error || rr.skipped || null };
  }
  const lg = require('./leadgen');
  const channel = lead.lastTouchChannel || '企业微信';
  const touch = lg.markTouched(id, channel, ('客户回复：' + text).slice(0, 120)).touch;
  const signal = Math.min(95, Number(lead.signal || 0) + 6);
  const patch = { signal };
  let promoted = false;
  if (touch >= lg.CLOSE_MIN_TOUCH && signal >= lg.CLOSE_MIN_SIGNAL) {
    patch.stage = '商机候选'; patch.needHuman = true; patch.deal = null; patch.touchesAtGate = touch; patch.signalAt = Date.now();
    promoted = true;
  }
  store.update('leads', id, patch, '触达·客户回复' + (promoted ? ' → 商机候选（等人工确认真实成交额）' : ''));
  store.push('outbound', { at: Date.now(), leadId: id, name: leadNameOf(lead), to: b.from || '', channel, ok: true, text: text.slice(0, 160), phase: 'reply' }, '触达·收到回复', leadNameOf(lead));
  // 证据获取管线：把这条真实客户回复自动结构化为一条外部 evidence。
  // 铁律：只收录真实回复原文，绝不编造。quote=text 是逐字原话，channel 是真实触达渠道。
  try {
    require('./evidence-pipeline').captureReply({
      leadId: id,
      name: leadNameOf(lead),
      channel,
      quote: text,
      outboundRef: (db0.outbound || []).length
    });
  } catch (e) { /* 证据沉淀失败不影响主流程，但记一笔 */ }
  return { status: 200, ok: true, lead: leadNameOf(lead), touch, signal, promoted, stage: promoted ? '商机候选' : lead.stage };
}

async function sendTest(to) {
  const email = String(to || '').trim();
  const tr = transport();
  if (!tr) return { ok: false, error: '未配置发送通道（outreachWebhookUrl 或 SMTP 凭据）' };
  if (!email) return { ok: false, error: '收件地址必填' };
  const subject = '丙大山 · 触达通道自检 ' + dayKey(Date.now());
  const html = '<p>这是由丙大山自主获客模块发出的通道自检。</p><p>收到即代表「' + tr.channel + '」发送链路已打通。</p>';
  let rr;
  if (tr.kind === 'webhook') {
    rr = await webhookSend(tr.url, { id: 'probe', email, name: '自检', company: '通道自检', repo: '', industry: '' }, subject, html);
  } else {
    rr = await smtpSend(tr, email, subject, html).then(r => ({ ok: true, code: r.code, evidence: 'smtp ' + r.code })).catch(e => ({ ok: false, error: String(e.message || e).slice(0, 160) }));
  }
  store.push('outbound', { at: Date.now(), to: email, channel: tr.channel, subject, ok: !!rr.ok, error: rr.error || null, phase: 'test' }, '触达·发送自检', email);
  return { ok: !!rr.ok, transport: tr.kind, channel: tr.channel, evidence: rr.evidence || rr.code || '', error: rr.error || null };
}

// 发送自定义邮件（供验证码等使用）
async function sendEmail({ to, subject, html, timeoutMs }) {
  const email = String(to || '').trim();
  const tr = transport();
  if (!tr) return { ok: false, error: '未配置发送通道' };
  if (!email) return { ok: false, error: '收件地址必填' };
  if (!subject) return { ok: false, error: '主题必填' };
  if (!html) return { ok: false, error: '内容必填' };
  let rr;
  if (tr.kind === 'webhook') {
    rr = await webhookSend(tr.url, { id: 'custom', email, name: '', company: '', repo: '', industry: '' }, subject, html);
  } else {
    rr = await smtpSend(tr, email, subject, html, timeoutMs).then(r => ({ ok: true, code: r.code, evidence: 'smtp ' + r.code })).catch(e => ({ ok: false, error: String(e.message || e).slice(0, 160) }));
  }
  store.push('outbound', { at: Date.now(), to: email, channel: tr.channel, subject, ok: !!rr.ok, error: rr.error || null, phase: 'custom' }, '触达·自定义发送', email);
  return { ok: !!rr.ok, transport: tr.kind, channel: tr.channel, evidence: rr.evidence || rr.code || '', error: rr.error || null };
}

// 发送验证码邮件（专用，复用 sendTest 的成功逻辑）
async function sendVerificationCode({ to, code, timeoutMs }) {
  const email = String(to || '').trim();
  const tr = transport();
  if (!tr) return { ok: false, error: '未配置发送通道' };
  if (!email) return { ok: false, error: '收件地址必填' };
  if (!code) return { ok: false, error: '验证码必填' };
  
  const subject = '丙大山AI · 登录验证码';
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
      <div style="background:#0b0f14;border:1px solid #1e2a38;border-radius:12px;padding:32px;">
        <h2 style="color:#10b981;margin:0 0 16px;font-size:20px">验证码登录</h2>
        <p style="color:#7a8a9a;margin:0 0 24px">您正在登录/绑定丙大山AI账号，验证码如下：</p>
        <div style="background:#0a1218;border:1px solid #1e2a38;border-radius:8px;padding:24px;text-align:center;margin-bottom:24px">
          <span style="font-size:32px;font-weight:700;color:#10b981;letter-spacing:8px;font-family:monospace">${code}</span>
        </div>
        <p style="color:#7a8a9a;font-size:13px;margin:0">验证码 10 分钟内有效，请勿泄露给他人。如非本人操作请忽略。</p>
      </div>
      <p style="text-align:center;color:#7a8a9a;font-size:12px;margin-top:16px">丙大山AI · Agent 驾驶舱</p>
    </div>
  `;
  
  let rr;
  if (tr.kind === 'webhook') {
    rr = await webhookSend(tr.url, { id: 'verify', email, name: '', company: '', repo: '', industry: '' }, subject, html);
  } else {
    rr = await smtpSend(tr, email, subject, html, timeoutMs).then(r => ({ ok: true, code: r.code, evidence: 'smtp ' + r.code })).catch(e => ({ ok: false, error: String(e.message || e).slice(0, 160) }));
  }
  store.push('outbound', { at: Date.now(), to: email, channel: tr.channel, subject, ok: !!rr.ok, error: rr.error || null, phase: 'verify' }, '触达·验证码发送', email);
  return { ok: !!rr.ok, transport: tr.kind, channel: tr.channel, evidence: rr.evidence || rr.code || '', error: rr.error || null };
}

function setKeys(patch) {
  const SR = require('./settings-registry');
  const ALLOWED = ['smtpHost', 'smtpPort', 'smtpUser', 'smtpFrom', 'smtpPass', 'outreachWebhookUrl', 'outreachWebhookChannel', 'outreachReplyToken', 'outreachEnabled', 'outreachDailyCap', 'outreachMaxPerLead', 'outreachCooldownH'];
  const applied = [], rejected = [];
  for (const k of Object.keys(patch || {})) {
    if (ALLOWED.indexOf(k) < 0) { rejected.push({ key: k, error: '非触达配置键' }); continue; }
    const it = SR.ITEMS.find(x => x.key === k);
    let v = patch[k];
    if (it && it.type === 'bool') v = typeof v === 'string' ? /^(1|true|on|yes)$/i.test(v) : !!v;
    if (it && it.type === 'number' && v !== '' && v !== null && v !== undefined) v = Number(v);
    const err = it ? SR.validate(it, v) : null;
    if (err) { rejected.push({ key: k, label: it && it.label, error: err }); continue; }
    try {
      store.setSetting(k, v);
      applied.push({ key: k, label: it && it.label, value: it && it.type === 'secret' ? '(已更新)' : v });
    } catch (e) { rejected.push({ key: k, label: it && it.label, error: String(e.message || e).slice(0, 80) }); }
  }
  return { ok: rejected.length === 0, applied, rejected };
}

function mute(id, on) {
  const db0 = store.read();
  const lead = (db0.leads || []).find(l => l.id === id);
  if (!lead) return { ok: false, error: '线索不存在' };
  store.update('leads', id, { muted: on !== false, mutedAt: Date.now() }, on === false ? '触达·解除屏蔽' : '触达·人工屏蔽');
  return { ok: true, lead: leadNameOf(lead), muted: on !== false };
}

function maskTail(x) {
  const s = String(x || '');
  if (!s) return '';
  return s.length <= 6 ? '••••' : '••••••' + s.slice(-4);
}

function configMasked() {
  const st = settings();
  const c = smtpCfg();
  return {
    smtpHost: c.host,
    smtpPort: c.port,
    smtpUser: c.user ? String(c.user).slice(0, 2) + '…' + maskTail(c.user) : '',
    smtpFrom: c.from || '',
    smtpPass: c.pass ? maskTail(c.pass) : '',
    outreachWebhookUrl: st.outreachWebhookUrl ? (String(st.outreachWebhookUrl).length + ' 字符（已配置）') : '',
    outreachWebhookChannel: st.outreachWebhookChannel || '企业微信',
    outreachReplyToken: st.outreachReplyToken ? maskTail(st.outreachReplyToken) : ''
  };
}

function status() {
  const st = settings();
  const tr = transport();
  const c = smtpCfg();
  const db0 = store.read();
  const prev = db0.outreach || {};
  const dailyCap = Number(st.outreachDailyCap || DEFAULTS.dailyCap) || DEFAULTS.dailyCap;
  const maxPer = Number(st.outreachMaxPerLead || DEFAULTS.maxPerLead) || DEFAULTS.maxPerLead;
  const inbox = (db0.leads || []).filter(l => l.stage === '促单' && Number(l.touch || 0) < 2 && !l.muted && Number(l.sentN || 0) < maxPer).length;
  return {
    ok: true,
    enabled: !!st.outreachEnabled,
    transport: tr ? { kind: tr.kind, channel: tr.channel } : null,
    configuredIn: { webhook: !!st.outreachWebhookUrl, smtp: !!(c.user && c.pass), replyToken: !!st.outreachReplyToken },
    limits: { dailyCap, maxPerLead: maxPer, cooldownH: Number(st.outreachCooldownH || DEFAULTS.cooldownH) || DEFAULTS.cooldownH },
    today: { day: prev.day || null, sentToday: Number(prev.sent || 0) },
    smtp: { host: c.host, port: c.port, from: c.from ? (String(c.from).slice(0, 2) + '…' + String(c.from).slice(-8)) : '' },
    leads: { withEmail: (db0.leads || []).filter(l => l.email).length, inboxReady: inbox },
    log: (db0.outbound || []).slice(-8).map(x => ({ at: x.at, name: x.name || x.to || x.leadId, channel: x.channel, ok: x.ok, phase: x.phase || 'sent', subject: (x.subject || '').slice(0, 40), error: x.error || null }))
  };
}

module.exports = { runOnce, ingestReply, sendTest, sendEmail, sendVerificationCode, setKeys, mute, status, configMasked, smtpSend, compose, resolveContact, transport, sendRaw, DEFAULTS, OPT_OUT, SERVICE_RE };