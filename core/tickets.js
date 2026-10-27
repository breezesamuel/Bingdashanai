// core/tickets.js — E3 单人客服工单体系（FINAL-2.0 §3 落地）
// 一张 tickets 表 + 后台单页就是单人项目的客服复杂度上限（不上第三方系统）。
// 四通道（刻意做窄）：站内反馈表（唯一正式工单源）/ 邮箱 / 平台店铺消息 / 危机转介回访
// SLA 对自己狠，对外才可信：
//   P0 资损/隐私/安全/编造指控 → 当日响应，72h 结论
//   P1 退款/功能故障 → 48h（48 小时可退条款自动化：站内一键退）
//   P2 咨询/建议 → 周批（并入周日共建批阅同一场）
// 危机回访：只确认送达，不追问、不做陪伴式回复（我们不是热线，边界写进 SOP）。
// 温度宪法：所有回复模板过禁词扫描；给结论必给理由。
// 周报：工单量 / 响应达标率 / 焦虑感反馈关键词计数。

const store = require('./store');
const manuals = require('./manuals');

const SLA = {
  P0: { respondH: 24, concludeH: 72, name: '资损/隐私/安全/编造指控' },
  P1: { respondH: 48, concludeH: null, name: '退款/功能故障' },
  P2: { respondH: null, name: '咨询/建议（周批）' }
};

// 通道（刻意做窄）
const CHANNELS = ['站内反馈表', '邮箱', '平台店铺消息', '危机转介回访'];

// 模板库（封顶 20 封，全部过温度宪法审）。reply 里带 {0} 占位
const TEMPLATES = [
  { id: 'refund_ack', name: '退款确认', prio: 'P1',
    reply: '退款已受理，款项将按平台规则退回原支付渠道（0）。48 小时内可自助办理，有问题随时回执。' },
  { id: 'fault_apology', name: '故障道歉+退额度', prio: 'P1',
    reply: '给你添麻烦了。功能故障已定位，本次故障补偿 1 次免费完整推演额度，已发放到账。' },
  { id: 'suggest_ack', name: '建议受理', prio: 'P2',
    reply: '建议已受理并进入周批（0）。采纳与否都会在下一次月度公示里写明理由。' },
  { id: 'decline', name: '不予采纳说明（给理由）', prio: 'P2',
    reply: '这条建议本期不予采纳。理由：0。我们不调曲线只调设计——这条暂时不装上车。' },
  { id: 'crisis_followup', name: '危机回访（只确认，不追问）', prio: 'P0-crisis',
    reply: '你前次遇到的状况，我们确认过你已拿到 12356 热线卡。今天只想确认一句：你愿意的话回个表情即可，不用展开。我们不是热线，陪伴回复做不了，但确认送达是我们分内的事。' },
  { id: 'plagiarism', name: '抄袭与侵权举报', prio: 'P0',
    reply: '举报已收到，进入 72h 处理流程。若属实将按要求下架并公示。侵权线索请附原文链接与出处。' },
  { id: 'refund_rule', name: '48h 可退条款', prio: 'P1',
    reply: '按 48 小时可退条款，本单在【时限内/时限外】：时限内站内一键退，时限外恕不退回（购买前已公示条款）。' },
  { id: 'privacy', name: '隐私与数据问询', prio: 'P0',
    reply: '数据存储与使用边界已在隐私说明里列明。如需删除/导出你的档案，请回复确认，我们按档案规则执行并回执。' }
];

// 焦虑感反馈关键词（周报计数数据源）
const ANXIETY_WORDS = ['焦虑', '睡不着', '害怕', '担心', '无助', '压力好大', '慌', '难受', '撑不下去', '失眠', '绝望'];

// P0/P1/P2 自动分级：命中关键词 + 通道判断（叫价别叫高，宁可先兜住再降级）
function classify(body, channel) {
  const txt = String(body.msg || body.text || body.content || body.message || '').toLowerCase();
  const q = txt + ' ' + String(body.subject || '') + ' ' + String(body.title || '');
  let prio = 'P2';
  if (/退款|退钱|退费|资损|扣款|多扣|少到账/.test(q)) prio = 'P1';
  if (/崩溃|打不开|报错|bug|故障|登录不了|白屏|闪退/.test(q)) prio = 'P1';
  if (/隐私|泄露|数据|盗号|被黑|安全|编造|虚假|侵权|抄袭/.test(q)) prio = 'P0';
  if (/自杀|不想活|想死|活不下去|结束生命|自残/.test(q)) prio = 'P0-crisis';
  return prio;
}

// 创建工单（站内反馈表是唯一正式工单源；危机回访由系统主动触发）
function create(body, channel) {
  const ch = CHANNELS.includes(channel) ? channel : '站内反馈表';
  const msg = String(body.msg || body.text || body.content || body.message || '').trim();
  if (!msg) throw new Error('工单内容必填');
  const prio = classify(body, ch);
  const crisisScan = manuals.scanCrisis(msg);
  const rec = store.push('tickets', {
    channel: ch, prio, subject: String(body.subject || '').trim().slice(0, 80),
    msg: msg.slice(0, 1000), status: 'open',
    crisis: prio === 'P0-crisis' || crisisScan.crisis,
    createdAt: Date.now(),
    responded: null, concluded: null,
    refundProcessed: false
  }, '客服工单 ' + prio, (body.subject || msg).slice(0, 60));
  return { id: rec.id, prio: rec.prio, channel: ch, status: 'open', crisis: rec.crisis };
}

// 响应（记时点，算响应达标率）；回复走模板库或自由文本（过温度扫描）
function respond(id, opts) {
  const cur = store.list('tickets').find(x => x.id === id);
  if (!cur) throw new Error('工单不存在');
  const template = TEMPLATES.find(t => t.id === opts.templateId);
  let reply = '';
  if (template) {
    const fill = String(opts.params || '').trim();
    reply = template.reply.replace('{0}', fill);
  } else {
    reply = String(opts.reply || '').trim().slice(0, 600);
    if (!reply) throw new Error('回复必填（模板或自由文本）');
  }
  // 温度宪法：回复不得含俯视/乞求式表述
  const d = manuals.scanDignity(reply);
  if (!d.passes) throw new Error('回复含禁词（' + d.hits.join(',') + '），请换个表达');
  store.update('tickets', id, {
    status: 'responded', responded: Date.now(),
    reply, templateId: template ? template.id : null,
    responder: opts.responder || 'ai-support'
  }, '工单响应 ' + id);
  return { id, replied: true, templateId: template ? template.id : null };
}

// 结论（P0 用：72h 内给结论）
function conclude(id, conclusion) {
  const cur = store.list('tickets').find(x => x.id === id);
  if (!cur) throw new Error('工单不存在');
  store.update('tickets', id, { status: 'closed', concluded: Date.now(), conclusion: String(conclusion || '').slice(0, 600) }, '工单结论 ' + id);
  return { id, closed: true };
}

// 站内一键退（48h 可退条款自动化）
function refund(id, processed, note, opt) {
  const cur = store.list('tickets').find(x => x.id === id);
  if (!cur) throw new Error('工单不存在');
  const o = opt || {};
  // 【退款必须记账】此前只打一个工单标记，revenue 原封不动：
  // 退完的钱继续计入 KPI 营收、5% 推广费也照提 —— 退款只存在于客服话术里。
  // 现在 processed=true 时按营收 id（revId）调 money.refund 做真实冲减；
  // 拿不到 revId 就如实报错「必须提供营收记录号」，绝不在缺记账的情况下说「已退」。
  let moneyResult = null;
  if (processed === true) {
    const revId = String(o.revId || cur.revId || '').trim();
    if (!revId) {
      throw new Error('退款记账缺少营收记录号（revId）：无法确认退的是哪笔钱，拒绝对账上打「已退」标记');
    }
    const evidence = String(o.evidence || note || '').trim();
    const money = require('./money');
    const r = money.refund(revId, evidence, { note: note || '' });
    if (!r.ok) throw new Error('退款记账失败：' + (r.error || '未知'));
    moneyResult = { revId, already: r.already === true, promoReturned: r.promoReturned || 0 };
  }
  store.update('tickets', id, {
    refundProcessed: processed === true,
    refundAt: processed === true ? Date.now() : 0,
    refundNote: String(note || '').slice(0, 200),
    refundRevId: String(o.revId || cur.revId || '').slice(0, 80)
  }, '工单一键退 ' + id);
  return { id, refundProcessed: processed === true, money: moneyResult };
}

// 周批：P2 统一进入周日共建批阅
function batchApprove(id, decision, note) {
  const cur = store.list('tickets').find(x => x.id === id);
  if (!cur) throw new Error('工单不存在');
  store.update('tickets', id, { status: 'closed', batchDecided: decision === 'accept' ? '采纳' : '不采纳', batchNote: String(note || '').slice(0, 300) }, '周日批阅 ' + id);
  return { id, decided: decision === 'accept' ? '采纳' : '不采纳' };
}

// 周日共建批阅聚合：把已过 7 天的 P2/open 工单聚成一批，返回批阅清单（可继续编辑决定）
function sundayBatch(now) {
  const all = store.list('tickets');
  const ms = now || Date.now();
  const week = 7 * 24 * 3600 * 1000;
  const pb = all.filter(t => {
    const batchable = t.status === 'open' && t.prio === 'P2';
    const aged = (ms - (t.createdAt || ms)) >= week;
    return batchable && aged;
  });
  const batchId = 'wk' + new Date(ms).toISOString().slice(0, 10);
  // 幂等：同一自然日只记一场
  const prev = store.list('ticketBatch').find(x => x.batchId === batchId);
  if (!prev) {
    store.push('ticketBatch', {
      batchId, at: ms, size: pb.length,
      ids: pb.map(t => t.id),
      decided: 0
    }, '周日批阅场次', batchId + ' · ' + pb.length + ' 单');
  }
  return {
    batchId, size: pb.length, at: ms,
    tickets: pb.map(t => ({
      id: t.id, subject: t.subject, msg: t.msg, channel: t.channel,
      createdAt: t.createdAt, daysAged: Math.floor((ms - t.createdAt) / 86400000)
    }))
  };
}

// 周日批阅历史（供前端凭证展示）
function batchHistory(limit) {
  return store.list('ticketBatch').slice().sort((a, b) => b.at - a.at).slice(0, Number(limit) || 6)
    .map(x => ({ batchId: x.batchId, at: x.at, size: x.size, decided: x.decided, ids: x.ids.length }));
}

// 自动限时提醒（融入 24h 全托管）：返回即将/已超时未响应/未结论的工单
function slaWatch(now) {
  const all = store.list('tickets');
  const ms = now || Date.now();
  const deadline = {};
  all.forEach(t => {
    if (t.status === 'open') {
      if (t.prio === 'P0') deadline[t.id] = t.createdAt + 24 * 3600000 - ms;       // 当日响应
      if (t.prio === 'P0-crisis') deadline[t.id] = t.createdAt + 4 * 3600000 - ms; // 危机当日更短
      if (t.prio === 'P1') deadline[t.id] = t.createdAt + 48 * 3600000 - ms;       // 48h 响应
    } else if (t.status === 'responded' && t.prio === 'P0' && !t.concluded) {
      deadline[t.id] = t.createdAt + 72 * 3600000 - ms;                             // 72h 结论
    }
  });
  const overdue = Object.entries(deadline).filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]);
  const dueSoon = Object.entries(deadline).filter(([, v]) => v >= 0 && v < 24 * 3600000).sort((a, b) => a[1] - b[1]);
  return {
    overdue: overdue.map(([id]) => id),
    dueSoon: dueSoon.map(([id]) => id)
  };
}

// 响应达标率（当月已回应工单 / 当月到期需回应工单）
function compliance() {
  const all = store.list('tickets');
  const y = new Date().getFullYear(), m = new Date().getMonth();
  const inMonth = t => { const d = new Date(t.createdAt); return d.getFullYear() === y && d.getMonth() === m; };
  const month = all.filter(inMonth);
  const needResponse = month.filter(t => t.prio !== 'P2'); // P2 是周批，不算当日 SLA
  const respondedOnTime = needResponse.filter(t => t.responded && t.responded <= t.createdAt + (t.prio === 'P0' ? 24 * 3600000 : 48 * 3600000));
  return month.length === 0 ? { rate: null, month: y + '-' + (m + 1), need: 0 } : {
    rate: Math.round(respondedOnTime.length / needResponse.length * 100),
    month: y + '-' + (m + 1), need: needResponse.length, onTime: respondedOnTime.length
  };
}

// 周报：工单量 / 响应达标率 / 焦虑感反馈关键词计数
function weekly() {
  const all = store.list('tickets');
  const cases = store.list('crisis');
  const anxiety = {};
  all.forEach(t => { ANXIETY_WORDS.forEach(w => { if (t.msg && t.msg.includes(w)) anxiety[w] = (anxiety[w] || 0) + 1; }); });
  let crisisFollowUps = 0;
  (store.list('handoffs') || []).forEach(h => { if (h.kind === 'crisis_followup') crisisFollowUps++; });
  return {
    total: all.length,
    open: all.filter(t => t.status === 'open').length,
    byPrio: all.reduce((m, t) => { m[t.prio] = (m[t.prio] || 0) + 1; return m; }, {}),
    compliance: compliance(),
    anxietyHits: Object.keys(anxiety).length ? anxiety : null,
    crisisFollowUps,
    crisisRecords: (cases || []).length
  };
}

function stats() {
  const all = store.list('tickets');
  return {
    total: all.length,
    open: all.filter(t => t.status === 'open').length,
    closed: all.filter(t => t.status === 'closed').length,
    byPrio: all.reduce((m, t) => { m[t.prio] = (m[t.prio] || 0) + 1; return m; }, {}),
    byChannel: all.reduce((m, t) => { m[t.channel] = (m[t.channel] || 0) + 1; return m; }, {})
  };
}

module.exports = { SLA, CHANNELS, TEMPLATES, ANXIETY_WORDS, create, respond, conclude, refund, batchApprove, sundayBatch, batchHistory, slaWatch, compliance, weekly, stats, classify };