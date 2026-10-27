// core/assist.js — 远程协助请求（协调通道，不是屏幕控制）
//
// 【这是什么】客户遇到问题时，可以**主动发起**一次协助请求：说明问题、授权范围、
// 联系方式，并勾选同意书。运营在队列里接单 → 处理 → 归档。全过程写审计。
//
// 【为什么不直接做屏幕控制】真正的远程控制（屏幕共享/键鼠接管）需要：
//   ① 单独的可撤回授权书；② 会话录制与留存；③ 敏感信息遮蔽；④ 断连即止。
//   在没有这四样之前就做"远程控制"，等于给客户电脑开后门 —— 本项目明确拒绝。
//   所以这里只做**协调与留痕**：同意、范围、时限、处理人、结论，一条不少。
//
// 状态机：requested → accepted → completed
//                     ↘ cancelled（客户自己撤回）
//                     ↘ expired（24h 无人接单）
'use strict';
const store = require('./store');

const MODE = 'coordination-only';
const TTL_MS = 24 * 3600 * 1000;       // 请求 24h 无人接单自动过期
const OVERDUE_MS = 30 * 60 * 1000;     // 排队超过 30 分钟算超时（运营侧预警）

const CONSENT_TEXT = '我同意运营人员在本次协助中查看我主动提供的信息，并知晓本次协助不包含远程控制；我可随时撤回。';

function now() { return Date.now(); }
function str(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }

function sweep() {
  const at = now();
  const rows = store.list('assists', 500).filter(a => a.status === 'requested' && Number(a.expiresAt || 0) <= at);
  rows.forEach(a => store.update('assists', a.id, { status: 'expired', expiredAt: at }, '协助·过期', a.id));
  return rows.length;
}

// 发起协助（仅本人；必须勾选同意书）
function request(visitor, body) {
  const v = str(visitor, 120);
  if (!v) return { ok: false, error: '缺少访客标识' };
  const b = body || {};
  const topic = str(b.topic, 200);
  const scope = str(b.scope, 500);
  const contact = str(b.contact, 120);
  if (!topic) return { ok: false, error: '请填写遇到的问题（一句话）' };
  if (!scope) return { ok: false, error: '请填写需要查看/协助的范围' };
  if (b.consent !== true) return { ok: false, error: '需要先勾选同意书才能发起协助' };
  const at = now();
  const rec = store.push('assists', {
    visitor: v, topic, scope, contact,
    mode: MODE,
    consent: true, consentText: CONSENT_TEXT, consentAt: at,
    status: 'requested',
    createdAt: at, expiresAt: at + TTL_MS,
  }, '协助·请求', v + ' ' + topic.slice(0, 40));
  return { ok: true, assist: rec, consentText: CONSENT_TEXT, mode: MODE, note: '已进入运营队列；本次协助仅为协调与留痕，不含远程控制。' };
}

function queue(includeAll) {
  sweep();
  const at = now();
  const rows = store.list('assists', 500)
    .filter(a => (includeAll ? true : a.status === 'requested' || a.status === 'accepted'))
    .sort((x, y) => Number(x.createdAt || 0) - Number(y.createdAt || 0));
  return {
    ok: true, mode: MODE, overdueMs: OVERDUE_MS,
    total: rows.length,
    requested: rows.filter(a => a.status === 'requested').length,
    accepted: rows.filter(a => a.status === 'accepted').length,
    overdue: rows.filter(a => a.status === 'requested' && at - Number(a.createdAt || 0) > OVERDUE_MS).length,
    items: rows.slice(0, 100).map(a => Object.assign({}, a, {
      ageMin: Math.round((at - Number(a.createdAt || 0)) / 60000),
      overdue: a.status === 'requested' && at - Number(a.createdAt || 0) > OVERDUE_MS,
    })),
  };
}

function accept(id, opsName) {
  const a = store.findBy('assists', 'id', String(id || ''));
  if (!a) return { ok: false, error: '协助请求不存在' };
  if (a.status !== 'requested') return { ok: false, error: '当前状态不可接单：' + a.status };
  const at = now();
  if (Number(a.expiresAt || 0) <= at) {
    store.update('assists', a.id, { status: 'expired', expiredAt: at }, '协助·过期', a.id);
    return { ok: false, error: '请求已过期' };
  }
  store.update('assists', a.id, { status: 'accepted', acceptedAt: at, opsName: str(opsName, 60) || 'ops' }, '协助·接单', a.id);
  return { ok: true, assist: store.findBy('assists', 'id', a.id) };
}

function complete(id, note) {
  const a = store.findBy('assists', 'id', String(id || ''));
  if (!a) return { ok: false, error: '协助请求不存在' };
  if (a.status !== 'accepted') return { ok: false, error: '只能结束已接单的协助：' + a.status };
  const at = now();
  store.update('assists', a.id, {
    status: 'completed', completedAt: at,
    resolution: str(note, 2000),
    durationMin: Math.round((at - Number(a.acceptedAt || at)) / 60000),
  }, '协助·完成', a.id);
  return { ok: true, assist: store.findBy('assists', 'id', a.id) };
}

function cancel(id, visitor) {
  const a = store.findBy('assists', 'id', String(id || ''));
  if (!a) return { ok: false, error: '协助请求不存在' };
  if (String(a.visitor) !== String(visitor || '')) return { ok: false, error: '只能撤回自己的请求' };
  if (a.status !== 'requested' && a.status !== 'accepted') return { ok: false, error: '当前状态不可撤回：' + a.status };
  store.update('assists', a.id, { status: 'cancelled', cancelledAt: now(), revokedBy: 'customer' }, '协助·客户撤回', a.id);
  return { ok: true, assist: store.findBy('assists', 'id', a.id) };
}

function status(visitor) {
  sweep();
  const rows = store.list('assists', 500).filter(a => a.visitor === String(visitor || ''))
    .sort((x, y) => Number(y.createdAt || 0) - Number(x.createdAt || 0));
  return { ok: true, mode: MODE, consentText: CONSENT_TEXT, total: rows.length, items: rows.slice(0, 20) };
}

function stats() {
  const rows = store.list('assists', 500);
  const at = now();
  const by = {};
  rows.forEach(a => { by[a.status] = (by[a.status] || 0) + 1; });
  const done = rows.filter(a => a.status === 'completed');
  const waits = rows.filter(a => a.acceptedAt).map(a => Number(a.acceptedAt) - Number(a.createdAt || 0));
  return {
    ok: true, mode: MODE, total: rows.length, byStatus: by,
    overdue: rows.filter(a => a.status === 'requested' && at - Number(a.createdAt || 0) > OVERDUE_MS).length,
    avgWaitMin: waits.length ? Math.round(waits.reduce((s, x) => s + x, 0) / waits.length / 60000) : null,
    avgHandleMin: done.length ? Math.round(done.reduce((s, a) => s + Number(a.durationMin || 0), 0) / done.length) : null,
    note: '协助为协调与留痕通道；屏幕控制未实现（需单独授权书+录制+遮蔽+断连机制，未具备前不做）。',
  };
}

module.exports = { MODE, CONSENT_TEXT, TTL_MS, OVERDUE_MS, request, queue, accept, complete, cancel, status, stats, sweep };
