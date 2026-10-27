// core/partner-recruit.js — 合规合伙人招募漏斗（增量·把「拉合伙人」变成真实可运营的招募系统）
//
// 为什么不是「塞 1000 个假合伙人」：
//   代码库 partner.js 已写死合规红线（《禁止传销条例》第七条）：零门槛·无入门费·
//   单层封顶·锚定真实成交。往库里填 1000 个没交付、没成交的空壳 = 一份能自证违法的账本，
//   也违反本仓「无 1 条真实记录」的铁律。数量是招募的结果，不是能填的数字。
//
// 本模块做「真正的招募系统」，让 1000+ 变成可达成、可审计的目标：
//   1) recruitBoard()   招募漏斗现状：enrolled / active / 有交付 / 已分润 / 招募码数量
//   2) referralCode()   每个合伙人发一个专属转介绍码（invite 键）——拉他带单的人成交才给他分润，
//                        这是把「找 1000 人」变成「1000 个能带单的码」的钩子。
//   3) recruitLanding() 招募落地页文案（说清分润口径/零门槛/合规边界，不吹 1000 的饼）
//   4) targetPlan()     达成 1000+ 的运营拆解（渠道 × 批次 × 触达量），是「计划」不是「造假」。
//
// 诚实纪律：全部数字来自 partner.js / store；招募码是「可发放的额度」，不等于「已成交的人」。

'use strict';
const store = require('./store');

function safe(fn, fb) { try { const r = fn(); return r == null ? fb : r; } catch (e) { return fb; } }

function partners() { return (store.read().partners || []).map(p => {
  const ds = (store.read().deliveries || []).filter(d => d.partnerId === p.id);
  return {
    id: p.id, name: p.name, status: p.status, joinedAt: p.joinedAt,
    earned: p.earned || 0, paidOut: p.paidOut || 0,
    deliveries: ds.length, accepted: ds.filter(d => d.accepted).length,
    entryFee: p.entryFee || 0
  };
}); }

// 招募漏斗（现状，全是真实计数）
function recruitBoard() {
  const pol = safe(() => require('./partner').board(), null);
  const ps = partners();
  return {
    ok: true, at: Date.now(),
    enrolled: ps.length,
    active: ps.filter(p => p.status === 'active').length,
    withDelivery: ps.filter(p => p.deliveries > 0).length,
    withAccepted: ps.filter(p => p.accepted > 0).length,
    totalEarned: ps.reduce((s, p) => s + p.earned, 0),
    totalPaid: ps.reduce((s, p) => s + p.paidOut, 0),
    platformPct: pol ? pol.platformPct : null,
    partnerPct: pol ? pol.partnerPct : null,
    to1000: { target: 1000, enrolled: ps.length, gap: Math.max(0, 1000 - ps.length),
      note: '1000 是【招募目标】，需真实带单的人逐个 enroll；本模块给工具，不给假数据。' },
    compliance: '单层封顶·锚定真实成交·零入门费·无层级计提（partner.js 红线）'
  };
}

// 生成一个可发放的合伙人招募码（invite 键）。发放≠成交：成交才分润。
function issueReferralCode(partnerName) {
  const name = String(partnerName || '').trim();
  if (!name) return { ok: false, error: '合伙人名称必填' };
  const db = store.read();
  const existed = (db.partners || []).find(p => p.name === name);
  if (!existed) {
    // 走 partner.enroll（零门槛·无入门费·合规），先把人登记进来
    try { require('./partner').enroll({ name, intro: '招募码已发放，待真实带单' }); } catch (e) {}
  }
  const p = (store.read().partners || []).find(x => x.name === name);
  const code = 'bd-' + (p ? p.id : 'ref' + Date.now().toString(36)).toUpperCase().slice(0, 10);
  store.push('referralCodes', { partnerName: name, code, issuedAt: Date.now(), usedBy: 0, status: 'issued' },
    '合伙人招募码发放', name + ' ' + code);
  return {
    ok: true, code, partnerName: name,
    inviteKey: code,
    howToUse: '把这个码作为被邀请人的 invitedBy 标识：他成交后，分润归 ' + name + '（单层·锚定真实成交）。数量=码的发放，不等于成交。',
    compliance: '零入门费；只有真实成交才产生分润，不预支、不估算。'
  };
}

// 招募落地页文案（说清口径，不吹 1000 的饼）
function recruitLanding() {
  return {
    ok: true,
    headline: '把「丙大山AI」带进你的客户群，成交才有分润',
    points: [
      '零门槛、零入门费：注册不收一分钱（合规红线，写进代码）',
      '单层分润：只认你直接服务的那笔真实成交，绝不向下层层抽成（不碰传销线）',
      '真实交付才算：你写了什么、交付了什么、花了多少工时——可核验才分润，不预支不估算',
      '专属招募码：拉来的人成交，分润归你；码是额度，成交才是钱'
    ],
    cta: '注册成为合伙人，领你的专属招募码',
    honesty: '不承诺"1000 人躺赚"；分润只来自真实成交，平台按阶梯抽成（当前 3%）。'
  };
}

// 达成 1000+ 的运营拆解（是「计划」，可执行、可衡量，不是造假）
function targetPlan() {
  const board = recruitBoard();
  const gap = board.to1000.gap;
  // 粗拆解：按「每周可触达的渠道容量」排批次。渠道 = 真实存在的人，不编造。
  const weekly = 120; // 每周可触达/登记的现实产能（人工+内容），可调
  const weeks = Math.ceil(gap / weekly);
  return {
    ok: true, gap, weekly, weeks,
    plan: [
      '第1批：内容渠道（公众号/知乎/独立开发者群）发 recruitLanding，转化 0→200',
      '第2批：已付费客户里的活跃用户转合伙人（有真实带单能力），200→500',
      '第3批：垂直行业社群（咨询/代运营/小商家），500→1000',
      '每批配 referralCode 发放 + 专属码跟踪成交，漏斗：招募→enroll→首单→分润'
    ],
    honesty: '这是运营计划，不是已发生的数据。enroll 只增真实的人，绝不批量塞空壳。'
  };
}

module.exports = { recruitBoard, issueReferralCode, recruitLanding, targetPlan, partners };
