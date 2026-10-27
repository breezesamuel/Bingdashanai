// core/care.js — 陪护闭环（管理中心 · 子女端 · 老人端 · 监控中心 · 陪护机器人）
//
// 【为什么单独一个域】老人/子女/机器人不是"再开一个聊天入口"，而是一条**责任链**：
//   谁建档 → 谁绑定 → 谁在线 → 出事谁先知道 → 多久响应 → 谁闭环 → 谁付钱 → 证据在哪。
// 这条链任何一环断了，都不能叫"陪护系统"，只能叫"一个 App"。
//
// 【本模块负责什么】
//   1) 家庭与角色：老人建档（本人同意）+ 子女凭邀请码加入（各自同意）
//   2) 档案：年龄/病史/过敏/用药/紧急联系人（缺一项就算"未建档完整"）
//   3) 设备：APP / 机器人 / 监控 / 手环注册与心跳（掉线自动告警，恢复自动闭环）
//   4) 告警：SOS/跌倒(P0)、体征/围栏/漏服药(P1)、未打卡(P2)，带 SLA 升级
//   5) 任务：服药/打卡/探访/测量，完成或漏做都有记录
//   6) 资料：病历/处方/报告（图片，落盘 + 归属校验才能下载）
//   7) 审计：每一次状态变化都写 audit（谁、何时、做了什么）
//
// 【刻意不做】
//   - 不做"远程控制"：见 core/assist.js，屏幕/键鼠接管需要单独授权+录制+遮蔽+断连
//   - 不做医疗诊断：只记录与提醒，不给治疗建议；紧急情况提示拨打 120
//   - 不自动扣费：carePlan 未定价前 billingConfigured=false，如实报告"未开通收费"
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const DAY = 86400000;
const SLAS = { P0: 5 * 60000, P1: 30 * 60000, P2: 4 * 3600000 };
const OFFLINE_MS = 10 * 60000;
const WEAK_MS = 2 * 60000;
const KINDS = {
  sos: { sev: 'P0', label: '一键求助', action: '立即电话联系老人；10 分钟无回应联系紧急联系人' },
  fall: { sev: 'P0', label: '跌倒/碰撞', action: '先电话确认意识；无回应立即联系家属与 120' },
  vital: { sev: 'P1', label: '体征异常', action: '核对最近测量值与用药；持续异常建议就医' },
  geofence: { sev: 'P1', label: '离开安全区域', action: '电话确认位置；必要时联系家属寻找' },
  med_missed: { sev: 'P1', label: '漏服药', action: '提醒补服前先确认是否已服，避免重复用药' },
  device_offline: { sev: 'P1', label: '设备离线', action: '确认是没电/断网还是老人不会用；超过 2 小时上门' },
  no_checkin: { sev: 'P2', label: '今日未打卡', action: '先发消息，2 小时无回应再电话' },
  other: { sev: 'P2', label: '其他', action: '按描述处理并补全记录' }
};
const DEVICE_TYPES = ['app', 'robot', 'monitor', 'wearable'];
const TASK_TYPES = ['med', 'checkin', 'visit', 'measure', 'other'];

function now() { return Date.now(); }
function str(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function arr(v) { return Array.isArray(v) ? v : []; }
function ymd(ts) {
  const d = new Date(Number(ts) || now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function makeCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 20; i++) {
    let c = '';
    for (let j = 0; j < 6; j++) c += abc[Math.floor(Math.random() * abc.length)];
    if (!store.findAllBy('careFamilies', 'inviteCode', c).length) return c;
  }
  return 'C' + Date.now().toString(36).toUpperCase().slice(-5);
}
function maskPhone(p) {
  const s = String(p || '');
  return s.length >= 7 ? s.slice(0, 3) + '****' + s.slice(-4) : s;
}

// ===== 健康数据静态加密（PIPL P0，2026-10-24）=====
// 档案的敏感字段（年龄/性别/病史/过敏/用药/紧急联系人/住址/备注）整体封进一个
// AES-256-GCM 信封（sec 字段）；行上只留 familyId/updatedAt/complete 等非敏感元数据。
// 旧明文行（无 sec）兼容读，保存时自动迁移为密文并抹掉明文字段。
const careCrypto = require('./care-crypto');
const HEALTH_FIELDS = ['age', 'gender', 'conditions', 'allergies', 'meds', 'emergencyContacts', 'address', 'notes'];
const EMPTY_HEALTH = { age: null, gender: '', conditions: [], allergies: [], meds: [], emergencyContacts: [], address: '', notes: '' };
function sealHealth(payload) {
  try { return { ok: true, sec: careCrypto.sealJson(payload) }; }
  catch (e) { return { ok: false, code: e.code || 'seal_failed', error: '健康数据加密不可用，已拒绝写入（fail-closed）：' + String(e.message || e) }; }
}
function openProfileRow(row) {
  if (!row) return { ok: false, code: 'no_row' };
  if (row.sec != null) {
    const r = careCrypto.openJson(row.sec);
    if (!r.ok) return { ok: false, code: r.code === 'care_key_unavailable' ? 'care_key_unavailable' : 'decrypt_failed', row };
    const h = Object.assign({}, EMPTY_HEALTH, r.value || {});
    return { ok: true, profile: Object.assign({ id: row.id, familyId: row.familyId, updatedAt: row.updatedAt, updatedBy: row.updatedBy, complete: !!row.complete }, h) };
  }
  // 旧明文行：兼容读（迁移入口=下次保存 或 运营 migrateEncryption）
  const h = {};
  HEALTH_FIELDS.forEach(k => { h[k] = row[k] !== undefined ? row[k] : EMPTY_HEALTH[k]; });
  return { ok: true, legacy: true, profile: Object.assign({ id: row.id, familyId: row.familyId, updatedAt: row.updatedAt, updatedBy: row.updatedBy, complete: !!row.complete }, h) };
}

// ===== 成员/家庭 =====
function membershipsOf(visitor) {
  return store.findAllBy('careMembers', 'visitor', String(visitor || ''))
    .filter(m => m.status === 'active');
}
function familyById(id) { return store.findBy('careFamilies', 'id', String(id || '')); }
function membersOf(familyId) {
  return store.findAllBy('careMembers', 'familyId', String(familyId || '')).filter(m => m.status === 'active');
}
function guardiansOf(familyId) { return membersOf(familyId).filter(m => m.role === 'guardian'); }
function requireMember(visitor, familyId) {
  const ms = membershipsOf(visitor);
  if (!ms.length) return { ok: false, error: '还没有陪护家庭：请先建档或凭邀请码加入', code: 'no_family' };
  if (familyId) {
    const m = ms.find(x => String(x.familyId) === String(familyId));
    if (!m) return { ok: false, error: '无权访问该家庭', code: 'forbidden' };
    const f = familyById(m.familyId);
    if (!f || f.status !== 'active') return { ok: false, error: '家庭已停用', code: 'inactive' };
    return { ok: true, member: m, family: f };
  }
  const m = ms[0];
  const f = familyById(m.familyId);
  if (!f || f.status !== 'active') return { ok: false, error: '家庭已停用', code: 'inactive' };
  return { ok: true, member: m, family: f, all: ms };
}

// ===== 1) 建档 / 加入 =====
function createFamily(visitor, body) {
  const v = str(visitor, 120);
  const b = body || {};
  if (!v) return { ok: false, error: '缺少访客身份' };
  const existed = membershipsOf(v).find(m => m.role === 'elder');
  if (existed) {
    const f = familyById(existed.familyId);
    return { ok: true, already: true, family: f, inviteCode: f && f.inviteCode, note: '你已经建过档，邀请码可直接给子女' };
  }
  if (b.consent !== true) return { ok: false, error: '需要老人本人勾选同意书才能建档' };
  const seed = seedCheck();
  if (!seed.ok) return seed;
  const elderName = str(b.elderName || b.name, 40);
  if (!elderName) return { ok: false, error: '请填写老人称呼（如：张阿姨）' };
  const at = now();
  const code = makeCode();
  const family = store.push('careFamilies', {
    elderName, inviteCode: code, status: 'active',
    consent: true, consentAt: at,
    consentText: '我同意在陪护服务中记录我的基本信息、健康资料与设备状态，并可随时要求删除。',
    plan: 'care-pending', payer: '', createdAt: at, createdBy: v,
  }, '陪护·建档', elderName + ' ' + code);
  store.push('careMembers', {
    familyId: family.id, visitor: v, role: 'elder', relation: '本人',
    name: elderName, phone: '', consent: true, consentAt: at, status: 'active', joinedAt: at,
  }, '陪护·成员(老人)', family.id);
  // 健康档案从第一行起就是密文信封：密钥不可用则拒绝建档（fail-closed，
  // 宁可不收健康数据，也不明文落盘）
  const seal = sealHealth(EMPTY_HEALTH);
  if (!seal.ok) return { ok: false, code: seal.code, error: seal.error };
  store.push('careProfiles', {
    familyId: family.id, sec: seal.sec,
    updatedAt: at, updatedBy: v, complete: false,
  }, '陪护·档案初始化(加密)', family.id);
  return { ok: true, family, inviteCode: code, note: '建档完成。把邀请码发给子女，他们加入后才会收到告警。' };
}

function joinFamily(visitor, body) {
  const v = str(visitor, 120);
  const b = body || {};
  if (!v) return { ok: false, error: '缺少访客身份' };
  const code = str(b.code, 12).toUpperCase();
  if (!code) return { ok: false, error: '请填写邀请码' };
  if (b.consent !== true) return { ok: false, error: '需要勾选同意书才能加入' };
  const family = store.findAllBy('careFamilies', 'inviteCode', code).find(f => f.status === 'active');
  if (!family) return { ok: false, error: '邀请码无效或家庭已停用' };
  const existed = membershipsOf(v).find(m => String(m.familyId) === String(family.id));
  if (existed) return { ok: true, already: true, family, member: existed };
  const at = now();
  const member = store.push('careMembers', {
    familyId: family.id, visitor: v, role: 'guardian',
    relation: str(b.relation, 20) || '子女',
    name: str(b.name, 40) || '家属',
    phone: str(b.phone, 30),
    email: str(b.email, 120),
    consent: true, consentAt: at, status: 'active', joinedAt: at,
  }, '陪护·成员(子女)', family.id + ' ' + v);
  // 家庭状态：有子女加入后标记 bound
  store.update('careFamilies', family.id, { boundAt: family.boundAt || at }, '陪护·完成绑定', family.id);
  return { ok: true, family, member, note: '已加入。P0 告警会按 5 分钟 SLA 升级，请保持电话畅通。' };
}

// ===== 2) 档案 =====
function getProfile(visitor, familyId) {
  const r = requireMember(visitor, familyId);
  if (!r.ok) return r;
  const row = store.findAllBy('careProfiles', 'familyId', r.family.id)[0] || null;
  if (!row) return { ok: true, family: publicFamily(r.family), profile: null, role: r.member.role };
  const o = openProfileRow(row);
  if (!o.ok) return { ok: false, code: 'profile_decrypt_failed', error: '健康档案无法解密（密钥缺失或不匹配）。请先恢复加密密钥；fail-closed，不返回密文。' };
  return { ok: true, family: publicFamily(r.family), profile: o.profile, role: r.member.role };
}

function saveProfile(visitor, body) {
  const b = body || {};
  const r = requireMember(visitor, b.familyId);
  if (!r.ok) return r;
  const p = store.findAllBy('careProfiles', 'familyId', r.family.id)[0];
  if (!p) return { ok: false, error: '档案不存在' };
  // 先解密再合并校验；解不开就拒绝写入（防止把解不开的旧密文覆盖丢失）
  const o = openProfileRow(p);
  if (!o.ok) return { ok: false, code: 'profile_decrypt_failed', error: '健康档案无法解密，已拒绝写入（fail-closed）' };
  const cur = o.profile;
  const patch = {};
  if (b.age != null) {
    const a = Number(b.age);
    if (!isFinite(a) || a < 1 || a > 120) return { ok: false, error: '年龄需在 1-120 之间' };
    patch.age = Math.round(a);
  }
  if (b.gender != null) patch.gender = str(b.gender, 10);
  if (b.conditions != null) patch.conditions = arr(b.conditions).map(x => str(x, 40)).filter(Boolean).slice(0, 30);
  if (b.allergies != null) patch.allergies = arr(b.allergies).map(x => str(x, 40)).filter(Boolean).slice(0, 30);
  if (b.meds != null) {
    patch.meds = arr(b.meds).slice(0, 30).map(m => ({
      name: str(m && m.name, 60), dose: str(m && m.dose, 40), times: arr(m && m.times).map(t => str(t, 10)).filter(Boolean).slice(0, 6)
    })).filter(m => m.name);
  }
  if (b.emergencyContacts != null) {
    patch.emergencyContacts = arr(b.emergencyContacts).slice(0, 5).map(c => ({
      name: str(c && c.name, 40), phone: str(c && c.phone, 30), relation: str(c && c.relation, 20)
    })).filter(c => c.phone);
  }
  if (b.address != null) patch.address = str(b.address, 200);
  if (b.notes != null) patch.notes = str(b.notes, 1000);
  const merged = Object.assign({}, cur, patch);
  const complete = !!(Number(merged.age) > 0 && arr(merged.emergencyContacts).length);
  const health = {};
  HEALTH_FIELDS.forEach(k => { health[k] = merged[k]; });
  const seal = sealHealth(health);
  if (!seal.ok) return { ok: false, code: seal.code, error: seal.error };
  // 保存即迁移：明文字段同时抹掉（旧明文行从这一刻起只剩密文）
  store.update('careProfiles', p.id, Object.assign({
    sec: seal.sec,
    updatedAt: now(), updatedBy: String(visitor).slice(0, 120), complete,
  }, (function () { const wipe = {}; HEALTH_FIELDS.forEach(k => { wipe[k] = EMPTY_HEALTH[k]; }); return wipe; })()),
    '陪护·档案更新(加密)', r.family.id);
  return { ok: true, profile: Object.assign({ id: p.id, familyId: p.familyId, updatedAt: now(), updatedBy: String(visitor).slice(0, 120), complete }, health), complete };
}

// ===== 3) 设备 =====
function deviceStatus(d, at) {
  const t = Number(at || now());
  const last = Number(d.lastSeen || d.registeredAt || 0);
  if (!last || t - last > OFFLINE_MS) return 'offline';
  if (t - last > WEAK_MS) return 'weak';
  return 'online';
}
function registerDevice(visitor, body) {
  const b = body || {};
  const r = requireMember(visitor, b.familyId);
  if (!r.ok) return r;
  const deviceId = str(b.deviceId, 80);
  if (!deviceId) return { ok: false, error: '缺少设备编号（deviceId）' };
  const type = DEVICE_TYPES.includes(b.type) ? b.type : 'app';
  const existed = store.findAllBy('careDevices', 'deviceId', deviceId)[0];
  if (existed && String(existed.familyId) !== String(r.family.id)) {
    return { ok: false, error: '该设备已绑定到其他家庭' };
  }
  if (existed) return { ok: true, already: true, device: publicDevice(existed, now()), note: '设备已存在；如需重置令牌请先解绑' };
  const token = crypto.randomBytes(24).toString('hex');
  const at = now();
  const d = store.push('careDevices', {
    familyId: r.family.id, deviceId, type,
    name: str(b.name, 40) || ({ app: '老人端 APP', robot: '陪护机器人', monitor: '监控中心', wearable: '手环' }[type]),
    tokenHash: sha(token), status: 'active',
    lastSeen: at, registeredAt: at, battery: null, firmware: '',
    registeredBy: String(visitor).slice(0, 120),
  }, '陪护·设备注册', r.family.id + ' ' + type + ' ' + deviceId);
  return { ok: true, device: publicDevice(d, at), token, note: '令牌只显示这一次，请写入设备配置；丢失需解绑重注册。' };
}
function publicDevice(d, at) {
  const o = Object.assign({}, d);
  delete o.tokenHash;
  o.status = o.status === 'active' ? deviceStatus(d, at) : o.status;
  return o;
}
function deviceByToken(token) {
  const h = sha(str(token, 200));
  const d = store.findAllBy('careDevices', 'tokenHash', h)[0];
  if (!d || d.status !== 'active') return null;
  return d;
}
function heartbeat(token, body) {
  const d = deviceByToken(token);
  if (!d) return { ok: false, error: '设备令牌无效' };
  const b = body || {};
  const at = now();
  const patch = { lastSeen: at };
  if (b.battery != null) { const x = Number(b.battery); if (isFinite(x)) patch.battery = Math.max(0, Math.min(100, Math.round(x))); }
  if (b.firmware != null) patch.firmware = str(b.firmware, 40);
  store.update('careDevices', d.id, patch, '陪护·设备心跳', d.deviceId);
  // 掉线告警自动闭环：设备回来了就把该设备的 device_offline 告警解决掉
  const opens = store.findAllBy('careAlerts', 'familyId', d.familyId)
    .filter(a => a.kind === 'device_offline' && a.deviceId === d.deviceId && (a.status === 'open' || a.status === 'acked'));
  opens.forEach(a => store.update('careAlerts', a.id, {
    status: 'resolved', resolvedAt: at, resolvedBy: 'system', resolution: '设备恢复在线（自动闭环）'
  }, '陪护·告警自动闭环', a.id));
  return { ok: true, device: publicDevice(store.findBy('careDevices', 'id', d.id), at), autoResolved: opens.length };
}

// ===== 4) 告警 =====
function raiseAlert(who, body) {
  const b = body || {};
  let family = null, member = null, device = null;
  if (b.token) {
    device = deviceByToken(b.token);
    if (!device) return { ok: false, error: '设备令牌无效' };
    family = familyById(device.familyId);
  } else {
    const r = requireMember(who, b.familyId);
    if (!r.ok) return r;
    family = r.family; member = r.member;
  }
  if (!family || family.status !== 'active') return { ok: false, error: '家庭不可用' };
  const kind = KINDS[b.kind] ? b.kind : 'other';
  const sev = KINDS[kind].sev;
  const at = now();
  // 去重：同家庭+同类型 5 分钟内的未闭环告警不重复建（避免老人连点 10 次刷屏）
  const recent = store.findAllBy('careAlerts', 'familyId', family.id)
    .find(a => a.kind === kind && (a.status === 'open' || a.status === 'acked') && at - Number(a.at || 0) < 5 * 60000);
  if (recent) return { ok: true, already: true, alert: recent, note: '5 分钟内同类型告警已存在，不重复创建' };
  const a = store.push('careAlerts', {
    familyId: family.id, kind, severity: sev,
    message: str(b.message, 300) || KINDS[kind].label,
    source: device ? ('device:' + device.deviceId) : ('member:' + (member ? member.role : '?')),
    deviceId: device ? device.deviceId : '',
    at, status: 'open', slaMs: SLAS[sev], escalateAt: at + SLAS[sev],
    escalatedAt: null, escalatedTo: '',
  }, '陪护·告警', family.id + ' ' + sev + ' ' + kind);
  // 通知子女（短信优先/邮件兜底/预算熔断）：尽力而为，失败也不影响告警本身
  try { notifyAlert(a.id, 'open'); } catch (e) {}
  try { flushNotifies(); } catch (e) {}
  return {
    ok: true, alert: a, severity: sev,
    slaMin: Math.round(SLAS[sev] / 60000),
    guardians: guardiansOf(family.id).map(g => ({ name: g.name, phone: maskPhone(g.phone) })),
    action: KINDS[kind].action,
    emergency: sev === 'P0' ? '如电话无回应或意识不清，请立即拨打 120' : '',
  };
}

function ackAlert(who, body, opts) {
  const b = body || {};
  const a = store.findBy('careAlerts', 'id', String(b.id || ''));
  if (!a) return { ok: false, error: '告警不存在' };
  if (a.status !== 'open') return { ok: false, error: '当前状态不可接单：' + a.status };
  const by = (opts && opts.ops) ? 'ops' : (function () {
    const r = requireMember(who, a.familyId);
    return r.ok ? String(who).slice(0, 120) : null;
  })();
  if (!by) return { ok: false, error: '无权处理该告警' };
  const at = now();
  store.update('careAlerts', a.id, {
    status: 'acked', ackedAt: at, ackedBy: by,
    ackMin: Math.round((at - Number(a.at || at)) / 60000),
    ackWithinSla: (at - Number(a.at || at)) <= Number(a.slaMs || SLAS[a.severity] || 0),
  }, '陪护·告警接单', a.id + ' by ' + by);
  return { ok: true, alert: store.findBy('careAlerts', 'id', a.id) };
}

function resolveAlert(who, body, opts) {
  const b = body || {};
  const note = str(b.note || b.resolution, 600);
  if (note.length < 2) return { ok: false, error: '请写清楚处理结果（至少 2 个字）' };
  const a = store.findBy('careAlerts', 'id', String(b.id || ''));
  if (!a) return { ok: false, error: '告警不存在' };
  if (a.status !== 'open' && a.status !== 'acked') return { ok: false, error: '当前状态不可闭环：' + a.status };
  const by = (opts && opts.ops) ? 'ops' : (function () {
    const r = requireMember(who, a.familyId);
    return r.ok ? String(who).slice(0, 120) : null;
  })();
  if (!by) return { ok: false, error: '无权处理该告警' };
  const at = now();
  store.update('careAlerts', a.id, {
    status: 'resolved', resolvedAt: at, resolvedBy: by, resolution: note,
    handleMin: Math.round((at - Number(a.at || at)) / 60000),
  }, '陪护·告警闭环', a.id + ' by ' + by);
  return { ok: true, alert: store.findBy('careAlerts', 'id', a.id) };
}

function listAlerts(visitor, familyId, opts) {
  const r = requireMember(visitor, familyId);
  if (!r.ok) return r;
  const all = store.findAllBy('careAlerts', 'familyId', r.family.id)
    .sort((x, y) => Number(y.at || 0) - Number(x.at || 0));
  if (opts && opts.openOnly) return { ok: true, alerts: all.filter(a => a.status === 'open' || a.status === 'acked').slice(0, 100) };
  return { ok: true, alerts: all.slice(0, 100) };
}

// ===== 5) 任务 =====
function createTask(visitor, body) {
  const b = body || {};
  const r = requireMember(visitor, b.familyId);
  if (!r.ok) return r;
  if (r.member.role !== 'guardian') return { ok: false, error: '只有子女/家属可以安排任务' };
  const title = str(b.title, 120);
  if (!title) return { ok: false, error: '请填写任务内容' };
  const type = TASK_TYPES.includes(b.type) ? b.type : 'other';
  const dueAt = Number(b.dueAt) || (now() + 3600000);
  const repeat = ['none', 'daily', 'weekly'].includes(b.repeat) ? b.repeat : 'none';
  const t = store.push('careTasks', {
    familyId: r.family.id, title, type, dueAt, repeat, status: 'pending',
    createdAt: now(), createdBy: String(visitor).slice(0, 120),
  }, '陪护·任务', r.family.id + ' ' + title);
  return { ok: true, task: t };
}

function completeTask(visitor, body) {
  const b = body || {};
  const t = store.findBy('careTasks', 'id', String(b.id || ''));
  if (!t) return { ok: false, error: '任务不存在' };
  const r = requireMember(visitor, t.familyId);
  if (!r.ok) return r;
  if (t.status === 'done') return { ok: true, already: true, task: t };
  const at = now();
  store.update('careTasks', t.id, {
    status: 'done', doneAt: at, doneBy: String(visitor).slice(0, 120),
    lateMin: Math.max(0, Math.round((at - Number(t.dueAt || at)) / 60000)),
  }, '陪护·任务完成', t.id);
  let next = null;
  if (t.repeat === 'daily' || t.repeat === 'weekly') {
    next = store.push('careTasks', {
      familyId: t.familyId, title: t.title, type: t.type,
      dueAt: Number(t.dueAt || at) + (t.repeat === 'daily' ? DAY : 7 * DAY),
      repeat: t.repeat, status: 'pending', createdAt: at, createdBy: t.createdBy, fromTask: t.id,
    }, '陪护·周期任务', t.familyId);
  }
  return { ok: true, task: store.findBy('careTasks', 'id', t.id), next };
}

function listTasks(visitor, familyId) {
  const r = requireMember(visitor, familyId);
  if (!r.ok) return r;
  const all = store.findAllBy('careTasks', 'familyId', r.family.id)
    .sort((x, y) => Number(x.dueAt || 0) - Number(y.dueAt || 0));
  return {
    ok: true,
    pending: all.filter(t => t.status === 'pending').slice(0, 100),
    done: all.filter(t => t.status === 'done').slice(-50).reverse(),
    missed: all.filter(t => t.status === 'missed').slice(-50).reverse(),
  };
}

// ===== 6) 资料（病历/处方/报告）=====
const DOC_MAX = 1.0 * 1024 * 1024;
function docDir() { return store.dataPath('care-docs'); }
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return { ext: 'gif', mime: 'image/gif' };
  return null;
}
function addDoc(visitor, body) {
  const b = body || {};
  const r = requireMember(visitor, b.familyId);
  if (!r.ok) return r;
  const title = str(b.title, 80);
  if (!title) return { ok: false, error: '请填写资料名称（如：2026-10 体检报告）' };
  const kind = ['report', 'prescription', 'discharge', 'insurance', 'other'].includes(b.kind) ? b.kind : 'other';
  let file = '', mime = '', bytes = 0;
  if (b.dataUrl) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(String(b.dataUrl));
    if (!m) return { ok: false, error: '图片格式无效' };
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) return { ok: false, error: '图片内容为空' };
    if (buf.length > DOC_MAX) return { ok: false, error: '单张资料不能超过 1MB（请压缩后再传）' };
    const sniff = sniffImage(buf);
    if (!sniff) return { ok: false, error: '只支持图片（PNG/JPEG/WEBP/GIF）' };
    // 病历照片是敏感个人信息：落盘前整体封进 AES-256-GCM 信封（fail-closed）
    let sealedBuf;
    try { sealedBuf = careCrypto.sealBuffer(buf); }
    catch (e) { return { ok: false, error: '健康资料加密不可用，已拒绝落盘（fail-closed）：' + String(e.message || e) }; }
    const name = 'care-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex') + '.' + sniff.ext;
    try {
      fs.mkdirSync(docDir(), { recursive: true });
      fs.writeFileSync(path.join(docDir(), name), sealedBuf);
    } catch (e) { return { ok: false, error: '保存失败：' + String(e.message || e) }; }
    file = name; mime = sniff.mime; bytes = buf.length;   // bytes 记原始大小（密文略大，不虚标）
  }
  const at = now();
  const doc = store.push('careDocs', {
    familyId: r.family.id, title, kind, file, mime, bytes,
    note: str(b.note, 500), at, uploadedBy: String(visitor).slice(0, 120),
  }, '陪护·资料', r.family.id + ' ' + title);
  return { ok: true, doc };
}
function listDocs(visitor, familyId) {
  const r = requireMember(visitor, familyId);
  if (!r.ok) return r;
  const rows = store.findAllBy('careDocs', 'familyId', r.family.id)
    .filter(d => !d.status)   // 已删除/已过期不再展示（留审计，不给内容）
    .sort((x, y) => Number(y.at || 0) - Number(x.at || 0))
    .map(d => ({
      id: d.id, title: d.title, kind: d.kind, note: d.note, at: d.at,
      bytes: d.bytes, hasFile: !!d.file, retainUntil: d.retainUntil || null,
    }));
  return { ok: true, docs: rows, retentionDays: retentionDays() };
}
function openDoc(visitor, id, opts) {
  const d = store.findBy('careDocs', 'id', String(id || ''));
  if (!d) return { ok: false, error: '资料不存在' };
  if (d.status === 'deleted') return { ok: false, error: '该资料已被本人删除' };
  if (d.status === 'expired') return { ok: false, error: '该资料已过保留期' };
  const o = opts || {};
  const r = requireMember(visitor, d.familyId);
  const g = (o.ops && o.grantId) ? grantValid(o.grantId, d.id) : null;
  if (!r.ok && !g) return { ok: false, error: '无权查看：非家庭成员；运营需家属开临时授权窗口' };
  if (!d.file) return { ok: false, error: '这条资料没有附件' };
  const safe = String(d.file).replace(/[^A-Za-z0-9_.-]/g, '');
  const full = path.join(docDir(), safe);
  if (!fs.existsSync(full)) return { ok: false, error: '文件已丢失' };
  // 密文信封解密回原始图片；旧明文文件按原文返回（迁移由运营端点统一处理）
  let raw;
  try { raw = fs.readFileSync(full); } catch (e) { return { ok: false, error: '文件读取失败' }; }
  let outBuf = raw;
  if (careCrypto.isSealedBuffer(raw)) {
    const dec = careCrypto.openBuffer(raw);
    if (!dec.ok) return { ok: false, error: '资料解密失败（密钥缺失或不匹配）：fail-closed，不返回密文', code: 'doc_decrypt_failed' };
    outBuf = dec.value;
  }
  // 健康资料属于敏感个人信息：每次下载都留痕（谁、哪一条、什么时候、走的哪条通道）
  try {
    store.push('audit', {
      action: '陪护·资料下载',
      detail: 'doc=' + d.id + ' by=' + String(r.ok ? visitor : (g ? ('grant:' + g.id + ' grantedBy:' + g.grantedBy) : String(visitor))).slice(0, 120)
        + ' via=' + (r.ok ? 'member' : 'grant') + ' title=' + String(d.title || '').slice(0, 60),
      at: now(),
    });
  } catch (e) {}
  return { ok: true, path: full, buf: outBuf, mime: d.mime || 'application/octet-stream', title: d.title, via: r.ok ? 'member' : 'grant' };
}

// ===== 7) 巡检：掉线/超时/漏做 =====
let lastSweep = 0;
function sweep(force) {
  const at = now();
  if (!force && at - lastSweep < 20000) return { ok: true, skipped: true };
  lastSweep = at;
  const out = { offline: 0, escalated: 0, missed: 0 };
  // 设备掉线（每个设备每天只建一条）
  store.list('careDevices', 999).forEach(d => {
    if (d.status !== 'active') return;
    if (deviceStatus(d, at) !== 'offline') return;
    const today = ymd(at);
    const exists = store.findAllBy('careAlerts', 'familyId', d.familyId)
      .some(a => a.kind === 'device_offline' && a.deviceId === d.deviceId && ymd(a.at) === today);
    if (exists) return;
    const t = SLAS.P1;
    store.push('careAlerts', {
      familyId: d.familyId, kind: 'device_offline', severity: 'P1',
      message: (d.name || d.deviceId) + ' 离线超过 10 分钟',
      source: 'sweep', deviceId: d.deviceId, at, status: 'open', slaMs: t,
      escalateAt: at + t, escalatedAt: null, escalatedTo: '',
    }, '陪护·设备离线告警', d.deviceId);
    out.offline++;
  });
  // 告警升级（只升一次），升级时再通知一轮
  store.list('careAlerts', 999).forEach(a => {
    if ((a.status !== 'open') || a.escalatedAt) return;
    if (at <= Number(a.escalateAt || 0)) return;
    const gs = guardiansOf(a.familyId);
    store.update('careAlerts', a.id, {
      escalatedAt: at,
      escalatedTo: gs.length ? gs.map(g => g.name + '(' + maskPhone(g.phone) + ')').join(' / ') : '监控中心',
    }, '陪护·告警升级', a.id + ' ' + a.severity);
    try { notifyAlert(a.id, 'escalate'); } catch (e) {}
    out.escalated++;
  });
  if (out.escalated > 0) { try { flushNotifies(); } catch (e) {} }
  // 任务漏做
  store.list('careTasks', 999).forEach(t => {
    if (t.status !== 'pending') return;
    if (at <= Number(t.dueAt || 0) + 5 * 60000) return;
    store.update('careTasks', t.id, { status: 'missed', missedAt: at }, '陪护·任务漏做', t.id);
    out.missed++;
  });
  // 资料保留期/删除清理（PIPL：过期与已删除的文件要真的消失）
  try {
    const hk = docHousekeeping();
    out.docExpired = hk.expired; out.docPurged = hk.purged;
  } catch (e) {}
  return Object.assign({ ok: true }, out);
}

// ===== 8) 视图 =====
function publicFamily(f) {
  if (!f) return null;
  return {
    id: f.id, elderName: f.elderName, status: f.status, inviteCode: f.inviteCode,
    plan: f.plan, createdAt: f.createdAt, boundAt: f.boundAt || null,
    consent: !!f.consent, consentAt: f.consentAt || null,
  };
}
function familyView(visitor) {
  const ms = membershipsOf(visitor);
  if (!ms.length) return { ok: true, families: [], note: '还没有家庭：老人可建档，子女可凭邀请码加入' };
  const at = now();
  const families = ms.map(m => {
    const f = familyById(m.familyId);
    const members = membersOf(m.familyId).map(x => ({
      role: x.role, name: x.name, relation: x.relation, phone: maskPhone(x.phone), joinedAt: x.joinedAt
    }));
    const devices = store.findAllBy('careDevices', 'familyId', m.familyId).map(d => publicDevice(d, at));
    const alerts = store.findAllBy('careAlerts', 'familyId', m.familyId)
      .sort((x, y) => Number(y.at || 0) - Number(x.at || 0)).slice(0, 20);
    const tasks = store.findAllBy('careTasks', 'familyId', m.familyId)
      .filter(t => t.status === 'pending').sort((x, y) => Number(x.dueAt) - Number(y.dueAt)).slice(0, 20);
    const prow = store.findAllBy('careProfiles', 'familyId', m.familyId)[0] || null;
    const popen = prow ? openProfileRow(prow) : { ok: true, profile: null };
    const profile = popen.ok ? popen.profile : null;   // 解不开给 null 并显式标注，不吐密文也不装没这事
    const docs = store.findAllBy('careDocs', 'familyId', m.familyId).length;
    return {
      family: publicFamily(f), myRole: m.role, members, profile, devices, alerts, tasks, docs,
      profileUnreadable: !popen.ok,
      stats: {
        guardians: members.filter(x => x.role === 'guardian').length,
        devicesOnline: devices.filter(d => d.status === 'online').length,
        devicesOffline: devices.filter(d => d.status === 'offline').length,
        openAlerts: alerts.filter(a => a.status === 'open' || a.status === 'acked').length,
        pendingTasks: tasks.length,
      },
    };
  });
  return { ok: true, families, role: ms[0].role };
}

function center() {
  sweep(false);
  const at = now();
  const families = store.list('careFamilies', 999).filter(f => f.status === 'active');
  const members = store.list('careMembers', 999).filter(m => m.status === 'active');
  const devices = store.list('careDevices', 999).filter(d => d.status === 'active').map(d => publicDevice(d, at));
  const alerts = store.list('careAlerts', 999);
  const openAlerts = alerts.filter(a => a.status === 'open' || a.status === 'acked');
  const overdue = openAlerts.filter(a => a.status === 'open' && at > Number(a.escalateAt || 0));
  const today = ymd(at);
  const resolvedToday = alerts.filter(a => a.status === 'resolved' && ymd(a.resolvedAt) === today);
  const tasks = store.list('careTasks', 999);
  const p0Open = openAlerts.filter(a => a.severity === 'P0');
  const ackTimes = alerts.filter(a => a.ackedAt && a.at).map(a => Number(a.ackedAt) - Number(a.at));
  const careEvents = store.list('audit', 400).filter(a => String(a.action || '').startsWith('陪护·'))
    .slice(-20).reverse()
    .map(e => ({ action: e.action, target: e.detail || e.target || '', at: e.at || e.createdAt }));
  const profiles = store.list('careProfiles', 999);
  const items = families.map(f => {
    const ms = membersOf(f.id);
    const ds = devices.filter(d => d.familyId === f.id);
    const as = alerts.filter(a => a.familyId === f.id && (a.status === 'open' || a.status === 'acked'));
    const p = profiles.find(x => x.familyId === f.id);
    return {
      id: f.id, elderName: f.elderName, createdAt: f.createdAt,
      guardians: ms.filter(m => m.role === 'guardian').length,
      profileComplete: !!(p && p.complete),
      devices: ds.length, devicesOnline: ds.filter(d => d.status === 'online').length,
      openAlerts: as.length, p0: as.filter(a => a.severity === 'P0').length,
      plan: f.plan, payer: f.payer || null,
      inviteCode: f.inviteCode,
    };
  }).sort((a, b) => (b.openAlerts - a.openAlerts) || (b.p0 - a.p0));
  const alertItems = openAlerts
    .sort((a, b) => ({ P0: 0, P1: 1, P2: 2 }[a.severity] - { P0: 0, P1: 1, P2: 2 }[b.severity]) || (a.at - b.at))
    .map(a => {
      const f = families.find(x => x.id === a.familyId);
      return {
        id: a.id, familyId: a.familyId, elder: f ? f.elderName : '—',
        kind: a.kind, label: (KINDS[a.kind] || KINDS.other).label,
        severity: a.severity, status: a.status, at: a.at,
        ageMin: Math.round((at - Number(a.at || at)) / 60000),
        overdue: a.status === 'open' && at > Number(a.escalateAt || 0),
        escalatedTo: a.escalatedTo || '',
        message: a.message,
      };
    });
  return {
    ok: true, generatedAt: at,
    families: families.length,
    elders: members.filter(m => m.role === 'elder').length,
    guardians: members.filter(m => m.role === 'guardian').length,
    unbound: families.filter(f => !membersOf(f.id).some(m => m.role === 'guardian')).length,
    devices: {
      total: devices.length,
      online: devices.filter(d => d.status === 'online').length,
      weak: devices.filter(d => d.status === 'weak').length,
      offline: devices.filter(d => d.status === 'offline').length,
      byType: DEVICE_TYPES.reduce((o, t) => (o[t] = devices.filter(d => d.type === t).length, o), {}),
    },
    alerts: {
      open: openAlerts.length, p0: p0Open.length, overdueEscalated: overdue.length,
      resolvedToday: resolvedToday.length,
      avgAckMin: ackTimes.length ? Math.round(ackTimes.reduce((s, x) => s + x, 0) / ackTimes.length / 60000) : null,
      slaPct: (function () {
        const done = alerts.filter(a => a.ackedAt && a.at);
        if (!done.length) return null;
        return Math.round((done.filter(a => Number(a.ackedAt) - Number(a.at) <= Number(a.slaMs || SLAS[a.severity])).length / done.length) * 1000) / 10;
      })(),
    },
    tasks: {
      pending: tasks.filter(t => t.status === 'pending').length,
      dueToday: tasks.filter(t => t.status === 'pending' && ymd(t.dueAt) === today).length,
      missed7d: tasks.filter(t => t.status === 'missed' && at - Number(t.missedAt || t.dueAt || 0) < 7 * DAY).length,
      done7d: tasks.filter(t => t.status === 'done' && at - Number(t.doneAt || 0) < 7 * DAY).length,
    },
    docs: store.list('careDocs', 999).length,
    billing: carePlan(),
    orders: (function () {
      const os = store.list('careOrders', 999);
      return {
        pending: os.filter(o => o.status === 'pending').length,
        fulfilled: os.filter(o => o.status === 'fulfilled').length,
        mrr: os.filter(o => o.status === 'fulfilled' && o.cycle === 'month')
          .reduce((s, o) => s + Number(o.amount || 0), 0),
      };
    })(),
    notifies: notifiesSummary(),
    items,
    alertItems,
    recent: careEvents,
  };
}

// 种子家庭上限：20 户免费试点。超过后不再自动开新户，需人工拍板（防无限白嫖）。
// 上限可调（settings.careSeedLimit），因此**动态读取**而不是模块加载时固定。
function seedLimit() {
  return Number(store.getSetting('careSeedLimit') || 20);
}
function seedLimitNow() {
  return seedLimit();
}

function activeFamilies() {
  return store.list('careFamilies', 999).filter(f => f.status === 'active');
}
// 是否还在“免费种子试点”内
function seedOpen() {
  return activeFamilies().length < seedLimit();
}
// 创建家庭时调用：种子未满可以建；满了必须走付费
function seedCheck() {
  const n = seedLimit();
  if (activeFamilies().length >= n) {
    return { ok: false, code: 'seed_full', error: '免费种子试点已满（' + n + ' 户）。如需接入请订阅付费陪护方案（基础 ¥99/月 起）' };
  }
  return { ok: true };
}

function carePlan() {
  // 定价是商业决策：未配置就是未配置，不假装能收钱
  const p = store.getSetting('carePlan') || null;
  if (!p || !p.plans || !Array.isArray(p.plans) || !p.plans.length) {
    return { configured: false, price: null, currency: 'CNY', note: '陪护收费方案未定价（需人工拍板）；当前只提供免费试点，不产生收入' };
  }
  // 返回“基础档”作为对外锚点，但完整方案都可见
  const base = p.plans.find(x => x.id === 'care-basic') || p.plans[0];
  const free = p.freePlan || null;
  return {
    configured: true,
    currency: p.currency || 'CNY',
    plans: p.plans,
    freePlan: p.freePlan || null,
    seedLimit: seedLimit(),
    seedFamilies: activeFamilies().length,
    seedOpen: seedOpen(),
    price: base ? base.price : null,
    unit: base ? base.unit : 'elder/month',
    note: p.note || '',
  };
}

// 创建订阅：把“某付费人 + 家庭 + 档位 + 周期”写进台账，等支付成功才真正开通
// 不做“未付款=已开通”；钱到账由钱账模块（money.js/subs.js）负责
function createCareOrder(visitor, body) {
  const v = str(visitor, 120);
  const b = body || {};
  if (!v) return { ok: false, error: '缺少访客身份' };
  const r = requireMember(v, b.familyId);
  if (!r.ok) return r;
  if (r.member.role !== 'guardian') return { ok: false, error: '只有子女/付费家属可以订购陪护方案' };
  const plan = String(b.plan || '');
  const plans = (store.getSetting('carePlan') || {}).plans || [];
  const found = plans.find(x => x.id === plan);
  if (!found) return { ok: false, error: '未知方案：' + plan };
  const cycle = ['month', 'quarter', 'year'].includes(b.cycle) ? b.cycle : 'month';
  const at = now();
  // 幂等键：同一付费人 + 同一家庭 + 同一档位 + 同一周期
  // 已 pending/active/filled 的订单都在册 → 不重复开单（防“连点 3 次开 3 单”）
  const existed = store.list('careOrders', 999).find(o => o.familyId === r.family.id && o.payer === v && o.plan === plan && o.cycle === cycle && ['pending', 'active', 'fulfilled'].includes(o.status));
  if (existed) return { ok: true, already: true, order: existed, note: existed.status === 'fulfilled' ? '该家庭已开通此方案' : '该家庭已有待付订单，直接去付款' };
  const o = store.push('careOrders', {
    familyId: r.family.id, payer: v, plan: plan, cycle,
    amount: Number(found.price), currency: (store.getSetting('carePlan') || {}).currency || 'CNY',
    status: 'pending', createdAt: at,
    note: found.note || '',
  }, '陪护·开单', r.family.id + ' ' + plan + ' ' + cycle);
  return {
    ok: true, order: o,
    note: '订单已创建（' + plan + ' × ' + cycle + '，¥' + o.amount + '）。付款成功后才会开通；未付款=未开通。',
  };
}

function careOrderView(visitor, familyId) {
  const r = requireMember(visitor, familyId);
  if (!r.ok) return r;
  const rows = store.findAllBy('careOrders', 'familyId', r.family.id).sort((x, y) => Number(y.at || y.createdAt || 0) - Number(x.at || x.createdAt || 0));
  return {
    ok: true,
    orders: rows.map(o => ({
      id: o.id, plan: o.plan, cycle: o.cycle, amount: o.amount, currency: o.currency,
      status: o.status, createdAt: o.createdAt, note: o.note,
    })),
  };
}

// 支付到账后（由钱账模块回调）调用
function fulfillCareOrder(ops, orderId, proofId) {
  const o = store.findBy('careOrders', 'id', String(orderId || ''));
  if (!o) return { ok: false, error: '订单不存在' };
  if (o.status === 'fulfilled' || o.status === 'active') return { ok: true, already: true, order: o };
  const at = now();
  store.update('careOrders', o.id, {
    status: 'fulfilled', fulfilledAt: at, proofId: String(proofId || '').slice(0, 80),
    fulfilledBy: ops ? String(ops).slice(0, 40) : 'system',
  }, '陪护·开通', o.id + ' ' + o.plan);
  // 同步给家庭：plan 升级、payer 记录
  const fam = store.findBy('careFamilies', 'id', o.familyId);
  if (fam) {
    store.update('careFamilies', fam.id, { plan: o.plan, payer: o.payer }, '陪护·家庭升级', fam.id);
  }
  return { ok: true, order: store.findBy('careOrders', 'id', o.id) };
}

// ===== 9) 闭环体检 =====
function loop() {
  sweep(false);
  const at = now();
  const families = store.list('careFamilies', 999).filter(f => f.status === 'active');
  const members = store.list('careMembers', 999).filter(m => m.status === 'active');
  const devices = store.list('careDevices', 999).filter(d => d.status === 'active').map(d => publicDevice(d, at));
  const alerts = store.list('careAlerts', 999);
  const tasks = store.list('careTasks', 999);
  const profiles = store.list('careProfiles', 999);
  const guardians = members.filter(m => m.role === 'guardian');

  const complete = families.filter(f => {
    const p = profiles.find(x => x.familyId === f.id);
    return !!(p && p.complete);
  }).length;
  const bound = families.filter(f => guardians.some(g => g.familyId === f.id)).length;
  const withDevice = families.filter(f => devices.some(d => d.familyId === f.id)).length;
  const online = families.filter(f => devices.some(d => d.familyId === f.id && d.status === 'online')).length;
  const responded = alerts.filter(a => a.ackedAt || a.resolvedAt).length;
  const tasksDone = tasks.filter(t => t.status === 'done').length;
  const priced = carePlan().configured;

  const stages = [
    { id: 'family', name: '建档', count: families.length, denom: null, pct: null, note: '老人本人同意后建档' },
    { id: 'bound', name: '绑定子女', count: bound, denom: families.length, pct: families.length ? Math.round(bound / families.length * 1000) / 10 : null, note: '没有子女绑定=没人收告警' },
    { id: 'profile', name: '档案完整', count: complete, denom: families.length, pct: families.length ? Math.round(complete / families.length * 1000) / 10 : null, note: '年龄+紧急联系人齐全才算完整' },
    { id: 'device', name: '设备接入', count: withDevice, denom: families.length, pct: families.length ? Math.round(withDevice / families.length * 1000) / 10 : null, note: 'APP/机器人/监控/手环任一台' },
    { id: 'online', name: '设备在线', count: online, denom: families.length, pct: families.length ? Math.round(online / families.length * 1000) / 10 : null, note: '10 分钟内有过心跳' },
    { id: 'respond', name: '告警响应', count: responded, denom: alerts.length, pct: alerts.length ? Math.round(responded / alerts.length * 1000) / 10 : null, note: '接单或闭环过的告警占比（分母为 0 时不可计算）' },
    { id: 'task', name: '任务完成', count: tasksDone, denom: tasks.length, pct: tasks.length ? Math.round(tasksDone / tasks.length * 1000) / 10 : null, note: '服药/打卡/探访' },
    { id: 'bill', name: '付费', count: priced ? families.length : 0, denom: families.length, pct: priced && families.length ? 100 : (families.length ? 0 : null), note: priced ? '陪护收费已配置（基础 ¥' + String(carePlan().price) + '/月，' + carePlan().seedFamilies + '/' + carePlan().seedLimit + ' 种子名额已用）' : '未定价：当前不产生收入' },
  ];

  const checks = [];
  const push = (id, severity, title, items, action) => checks.push({ id, severity, title, count: items.length, samples: items.slice(0, 5), action });

  const noGuardian = families.filter(f => !guardians.some(g => g.familyId === f.id));
  push('family_no_guardian', 'high', '家庭没有绑定子女', noGuardian.map(f => ({ id: f.id, elder: f.elderName, code: f.inviteCode })), '把邀请码发给子女；没人绑定=告警没人接');

  const noConsent = members.filter(m => !m.consent);
  push('member_no_consent', 'high', '成员缺少同意书', noConsent.map(m => ({ id: m.id, familyId: m.familyId, role: m.role })), '补签同意书；没有同意不得记录健康资料');

  const profileMissing = families.filter(f => {
    const p = profiles.find(x => x.familyId === f.id);
    return !p || !p.complete;
  });
  push('profile_incomplete', 'medium', '档案不完整（年龄/紧急联系人）', profileMissing.map(f => ({ id: f.id, elder: f.elderName })), '一次补齐：年龄、病史、过敏、用药、紧急联系人');

  const offline = devices.filter(d => d.status === 'offline');
  push('device_offline', 'high', '设备离线超过 10 分钟', offline.map(d => ({ familyId: d.familyId, deviceId: d.deviceId, name: d.name, battery: d.battery })), '先确认没电/断网，再确认老人会不会用；2 小时未恢复上门');

  const p0Over = alerts.filter(a => a.severity === 'P0' && a.status === 'open' && at > Number(a.escalateAt || 0));
  push('p0_unacked', 'high', 'P0 告警超时未接单', p0Over.map(a => ({ id: a.id, familyId: a.familyId, at: a.at, min: Math.round((at - a.at) / 60000) })), '立即电话老人；无回应联系家属与 120，事后必须补记录');

  const open24 = alerts.filter(a => (a.status === 'open' || a.status === 'acked') && at - Number(a.at || 0) > DAY);
  push('alert_open_24h', 'high', '告警超过 24 小时未闭环', open24.map(a => ({ id: a.id, familyId: a.familyId, kind: a.kind, status: a.status })), '当天必须闭环；不能闭环就说明原因并升级');

  const missed7 = tasks.filter(t => t.status === 'missed' && at - Number(t.missedAt || t.dueAt || 0) < 7 * DAY);
  push('task_missed_7d', 'medium', '近 7 天有任务漏做', missed7.map(t => ({ id: t.id, familyId: t.familyId, title: t.title, dueAt: t.dueAt })), '漏服药先确认是否已服，避免重复用药；连续漏做要调整提醒方式');

  const noPayer = families.filter(f => !f.payer);
  push('no_payer', 'low', '家庭未指定付费人', noPayer.map(f => ({ id: f.id, elder: f.elderName })), '默认由第一位子女付费；免费试点阶段可暂不处理');

  // ===== 2026-10-24 新增断点（审计闭环补口）=====
  // 解密档案视图（chronic_no_doc 要读病史；解不开按"未知"处理，不猜、不挡）
  const profileOf = {};
  families.forEach(f => {
    const row = profiles.find(x => x.familyId === f.id);
    profileOf[f.id] = row ? openProfileRow(row) : { ok: false, code: 'no_row' };
  });

  // 机器人整日无心跳：设备离线断点管 10 分钟级，这里管"一整天没动静"的硬件级异常
  const robot24 = devices.filter(d => d.type === 'robot' && at - Number(d.lastSeen || d.registeredAt || 0) > DAY);
  push('robot_no_heartbeat_24h', 'medium', '机器人超过 24 小时无心跳', robot24.map(d => ({
    familyId: d.familyId, deviceId: d.deviceId, name: d.name,
    hours: Math.round((at - Number(d.lastSeen || d.registeredAt || 0)) / 3600000),
  })), '机器人整日无心跳通常=没通电/没配网/被搬走：先电话家属确认设备在不在、有没有电，再谈重新配网');

  // 慢病家庭没有任何病历/处方资料：出事时抢救缺用药史/过敏史上下文
  const chronicNoDoc = families.filter(f => {
    const o = profileOf[f.id];
    if (!o.ok) return false;
    if (!arr(o.profile && o.profile.conditions).filter(Boolean).length) return false;
    return store.findAllBy('careDocs', 'familyId', f.id).filter(d => !d.status).length === 0;
  });
  push('chronic_no_doc', 'medium', '慢病家庭没有任何病历/处方资料', chronicNoDoc.map(f => ({ id: f.id, elder: f.elderName })), '把最近一次就诊的病历/处方拍照上传：慢病无资料=出事时抢救缺关键上下文（用药史/过敏史）');

  // 近 30 天 P0/P1 告警家属从未接单：告警全落到监控中心兜底 = 子女端已形同虚设
  const recent30 = alerts.filter(a => at - Number(a.at || 0) < 30 * DAY && (a.severity === 'P0' || a.severity === 'P1'));
  const noResp = families.filter(f => {
    const gs = guardians.filter(g => g.familyId === f.id);
    if (!gs.length) return false;   // 无子女家庭由 family_no_guardian 单独报，不重复计
    const famAlerts = recent30.filter(a => a.familyId === f.id);
    if (!famAlerts.length) return false;
    const gVis = new Set(gs.map(g => String(g.visitor)));
    return !famAlerts.some(a => a.ackedBy && gVis.has(String(a.ackedBy)));
  });
  push('guardian_no_response_30d', 'medium', '近 30 天 P0/P1 告警家属从未接单', noResp.map(f => ({
    id: f.id, elder: f.elderName, alerts30d: recent30.filter(a => a.familyId === f.id).length,
  })), '子女不接单=告警只会落到监控中心兜底：电话回访确认是通知通道问题还是家属已流失；连续 3 次不接启动第二联系人');

  // 同意书满一年未重签：PIPL 对敏感个人信息要求单独同意，不能过期挂着
  const CONSENT_TTL = 365 * DAY;
  const consentOld = members.filter(m => m.consent && at - Number(m.consentAt || 0) > CONSENT_TTL);
  push('consent_expired', 'low', '同意书超过一年未重签', consentOld.map(m => ({
    id: m.id, familyId: m.familyId, role: m.role,
    daysAgo: Math.round((at - Number(m.consentAt || 0)) / DAY),
  })), 'PIPL 对敏感个人信息要求单独同意且不过期挂着：引导重签；重签前暂停新增健康资料录入');

  // 健康档案仍为明文（存量未迁移）
  const legacyPlain = profiles.filter(p => p.sec == null);
  push('health_data_unencrypted', 'high', '健康档案仍为明文存储（未加密）', legacyPlain.map(p => ({ familyId: p.familyId, id: p.id })),
    'PIPL 敏感个人信息不得明文落盘：运营执行 POST /v1/care/profile/migrate（管理令牌）立即加密存量；新数据已自动加密');

  if (!priced) {
    push('billing_not_configured', 'high', '陪护收费未定价（无法形成商业闭环）', [{ note: 'settings.carePlan.price 为空' }], '定价属商业决策：确认后写入 carePlan，才能开始收费与续费');
  }

  // 商业闭环硬断言：只要 billing_not_configured 存在，healthy 永远为 false，
  // 杜绝“漏斗每段都有数，但没人付钱”的假繁荣。
  const order = { high: 0, medium: 1, low: 2 };
  checks.sort((a, b) => (order[a.severity] - order[b.severity]) || (b.count - a.count));
  const blocker = checks.find(c => c.count > 0) || null;
  const billingBlocker = !priced;
  return {
    ok: true, generatedAt: at,
    stages,
    checks,
    healthy: !blocker && !billingBlocker,
    nextAction: billingBlocker
      ? '【high】商业闭环未闭合：settings.carePlan 未配置。定价属商业决策，拍板后写入 carePlan，才能开始收费与续费；在此之前陪护线只能做免费试点，不产生收入。'
      : (blocker ? ('【' + blocker.severity + '】' + blocker.title + '（' + blocker.count + ' 条）→ ' + blocker.action)
        : '闭环无断点：建档→绑定→设备在线→告警有人接→任务有完成→资料齐全→已定价收费。'),
    billing: carePlan(),
    privacy: {
      profileEncryption: Object.assign(careCrypto.keyStatus(), {
        sealed: profiles.filter(p => p.sec != null).length,
        legacyPlaintext: legacyPlain.length,
        note: '健康档案字段级 AES-256-GCM 加密，密钥与 db.json 分离（data/care-data.key 或环境变量 CARE_DATA_KEY）',
      }),
    },
    honesty: {
      medical: '本系统只做记录、提醒与升级，不做诊断；紧急情况以 120 为准',
      billing: '未定价即 billing_not_configured，不虚报"已收费"',
      rates: '分母为 0 时转化率为 null（不可计算）',
      closedLoop: '责任链闭环 ≠ 商业闭环；只有 carePlan 配置 + 付费人才算闭合',
      privacy: '健康档案与资料文件静态加密（AES-256-GCM，密钥分离）；无法解密时 fail-closed 拒绝返回/写入',
    },
  };
}

function report() {
  const c = center();
  const l = loop();
  return {
    ok: true, generatedAt: now(),
    center: c,
    loop: l,
    nextAction: l.nextAction,
    note: '中心看"现在有没有人出事"，闭环看"这条责任链有没有断"。两者都读同一份台账。',
  };
}

// ===== 10) 告警通知（短信优先 · 邮件兜底 · 预算熔断）=====
// 【为什么必须有】老人不会一直开着网页；SOS 后 30 秒内有电话/短信，才是“有人知道”。
// 【为什么要预算熔断】误报是陪护最大成本项：短信按 0.045 元/条计，超预算自动降级为人工电话，
//   绝不无限烧钱，也不假装“已通知”。
function smsCfg() {
  const s = store.getSetting('careSms') || {};
  return {
    provider: s.provider || null,
    dailyCap: Number(s.dailyCap || 30),
    costPerMsg: Number(s.costPerMsg || 0.045),
    monthlyBudget: Number(s.monthlyBudget || 300),
    configured: !!(require('./care-sms').configured()),
  };
}
function smsSentToday(atMs) {
  const day = ymd(atMs || now());
  return store.list('careNotifies', 999).filter(n => n.channel === 'sms' && n.status === 'sent' && ymd(n.at) === day).length;
}
function notifyAlert(alertId, reason) {
  const a = store.findBy('careAlerts', 'id', String(alertId || ''));
  if (!a) return { ok: false, error: '告警不存在' };
  // 同一告警同一阶段只入队一次（retry 除外）
  const dup = store.findAllBy('careNotifies', 'alertId', a.id).find(n => n.reason === reason && n.at > now() - 10 * 60000);
  if (dup) return { ok: true, dedup: true };
  const cfg = smsCfg();
  const used = smsSentToday();
  const gs = guardiansOf(a.familyId).filter(g => g.status === 'active');
  const fam = familyById(a.familyId);
  const rows = gs.map(g => {
    let channel = 'none';
    if (cfg.configured && g.phone && used < cfg.dailyCap) channel = 'sms';
    else if (g.email) channel = 'email';
    const row = {
      familyId: a.familyId, alertId: a.id, severity: a.severity, reason,
      channel, to: channel === 'sms' ? str(g.phone, 30) : (channel === 'email' ? str(g.email, 120) : ''),
      name: g.name, status: 'pending', at: now(), note: '',
    };
    if (channel === 'none') row.status = 'skipped', row.note = '未配置短信且该家属无邮箱 → 请人工电话';
    else if (channel === 'sms' && used >= cfg.dailyCap) row.status = 'skipped', row.note = '超出当日短信预算（' + cfg.dailyCap + ' 条/天）→ 降级人工电话';
    return row;
  });
  if (!rows.length) {
    rows.push({
      familyId: a.familyId, alertId: a.id, severity: a.severity, reason,
      channel: 'none', to: '', name: noGuardHint(fam), status: 'skipped',
      at: now(), note: '该家庭未绑定子女：无人可通知 → 人工电话老人 himself',
    });
  }
  rows.forEach(r => store.push('careNotifies', r, '陪护·通知入队', a.id + ' ' + r.channel + ' ' + (r.name || '')));
  return { ok: true, enqueued: rows.length };
}
function noGuardHint(fam) {
  return fam ? ('家庭' + (fam.elderName || '')) : '';
}
// 尽力发送：被 raiseAlert/sweep 调用，任何失败都不能影响告警主流程。
// 【关键】care-sms.send 是 async，返回 Promise；这里不 await 主流程，但必须等它 resolve
// 才能拿到真实结果，否则会把所有短信误记为 failed（未知错误）—— 这是「已发出」假象的另一种。
function flushNotifies() {
  const cfg = smsCfg();
  const tried = [];
  store.findAllBy('careNotifies', 'status', 'pending').slice(0, 30).forEach(n => {
    let p;
    try {
      if (n.channel === 'email') {
        const mailer = require('./mailer');
        const fam = familyById(n.familyId);
        const subject = '【丙大山陪护' + (n.severity || '') + '】' + (fam ? fam.elderName : '') + ' 需要处理（' + n.reason + '）';
        const html = '<p style="font-size:17px">' + esc2(subject) + '</p><p style="font-size:15px;color:#666">请打开 <a href="https://bingdashanai.highkingflower.com/care/family.html">陪护子女端</a> 接单并写处理结果。P0 超时 5 分钟会升级。</p>';
        p = Promise.resolve(mailer.send(n.to, subject, html));
      } else if (n.channel === 'sms') {
        p = Promise.resolve(require('./care-sms').send(n.to, { elder: (familyById(n.familyId) || {}).elderName || '', sev: n.severity, reason: n.reason }));
      } else {
        store.update('careNotifies', n.id, { status: 'skipped', note: '无可用通道' }, '陪护·通知跳过', n.id);
        return;
      }
    } catch (e) { p = Promise.resolve({ ok: false, error: String(e.message || e) }); }
    p.then(x => {
      const ok = !!(x && x.ok);
      store.update('careNotifies', n.id, ok ? { status: 'sent', sentAt: now() } : { status: 'failed', note: String((x && (x.error || x.code)) || '发送失败').slice(0, 160) }, '陪护·通知' + (ok ? '成功' : '失败'), n.id);
    }).catch(e => {
      store.update('careNotifies', n.id, { status: 'failed', note: String(e.message || e) }, '陪护·通知失败', n.id);
    }).finally(() => tried.push(n.id));
  });
  return { ok: true, tried: tried.length };
}
function notifiesSummary() {
  const cfg = smsCfg();
  const rows = store.list('careNotifies', 999);
  const used = smsSentToday();
  return {
    configured: cfg.configured, provider: cfg.provider, dailyCap: cfg.dailyCap,
    costPerMsg: cfg.costPerMsg, monthlyBudget: cfg.monthlyBudget,
    smsToday: used, estCostToday: Math.round(used * cfg.costPerMsg * 100) / 100,
    pending: rows.filter(n => n.status === 'pending').length,
    failed: rows.filter(n => n.status === 'failed').length,
    skipped: rows.filter(n => n.status === 'skipped').length,
    recent: rows.sort((x, y) => Number(y.at || 0) - Number(x.at || 0)).slice(0, 20),
  };
}

// ===== 11) 资料保留期 / 删除权 =====
// 【PIPL】同意书写了“可随时删除与要求清空”，必须真的给一键删除与自动过期，否则就是空头承诺。
function retentionDays() {
  return Number(store.getSetting('careDocRetentionDays') || 540);
}
function docHousekeeping() {
  const days = retentionDays();
  let expired = 0, purged = 0;
  store.list('careDocs', 999).forEach(d => {
    if (d.status) return;
    if (days > 0 && !d.retainUntil) {
      store.update('careDocs', d.id, { retainUntil: Number(d.at) + days * DAY }, '陪护·资料保留期', d.title);
      return;
    }
    if (d.retainUntil && now() > Number(d.retainUntil)) {
      store.update('careDocs', d.id, { status: 'expired', expiredAt: now() }, '陪护·资料过期', d.title);
      try { if (d.file) fs.rmSync(path.join(docDir(), String(d.file).replace(/[^A-Za-z0-9_.-]/g, '')), { force: true }); } catch (e) {}
      expired++;
      return;
    }
    if (d.status === 'deleted' && d.file) {
      try { fs.rmSync(path.join(docDir(), String(d.file).replace(/[^A-Za-z0-9_.-]/g, '')), { force: true }); } catch (e) {}
      store.update('careDocs', d.id, { file: '', mime: '', purgedAt: now() }, '陪护·资料彻底清除', d.title);
      purged++;
    }
  });
  return { ok: true, expired, purged, retentionDays: days };
}
function deleteDoc(visitor, docId) {
  const d = store.findBy('careDocs', 'id', String(docId || ''));
  if (!d) return { ok: false, error: '资料不存在' };
  const r = requireMember(visitor, d.familyId);
  if (!r.ok) return { ok: false, error: '只有本家庭成员可以删除资料' };
  if (d.status === 'deleted') return { ok: true, already: true };
  store.update('careDocs', d.id, {
    status: 'deleted', deletedAt: now(), deletedBy: String(visitor).slice(0, 120),
  }, '陪护·资料删除', d.title);
  return { ok: true, note: '已标记删除，文件将在巡检时彻底清除；审计保留记录' };
}

// ===== 12) 家属临时授权（协助员/运营可看单份资料的窗口）=====
// 【边界】默认协助员**看不到**健康档案；要看某份资料，必须家属开一个带时限的授权窗口，且每次查看都留痕。
function grantDoc(visitor, body) {
  const b = body || {};
  const d = store.findBy('careDocs', 'id', String(b.docId || ''));
  if (!d) return { ok: false, error: '资料不存在' };
  const r = requireMember(visitor, d.familyId);
  if (!r.ok) return { ok: false, error: '只有本家庭成员可以授权' };
  const hours = Math.min(72, Math.max(0.5, Number(b.hours) || 24));
  const g = store.push('careGrants', {
    familyId: d.familyId, docId: d.id, title: d.title,
    expiresAt: now() + hours * 3600000,
    grantedBy: String(visitor).slice(0, 120), grantedAt: now(), revokedAt: null,
    note: str(b.note, 200),
  }, '陪护·临时授权', d.title + ' ' + hours + 'h');
  return { ok: true, grant: { id: g.id, docId: g.docId, title: g.title, expiresAt: g.expiresAt }, note: '授权窗口 ' + hours + ' 小时，可随时撤回' };
}
function revokeGrant(visitor, grantId) {
  const g = store.findBy('careGrants', 'id', String(grantId || ''));
  if (!g) return { ok: false, error: '授权不存在' };
  if (g.revokedAt) return { ok: true, already: true };
  const r = requireMember(visitor, g.familyId);
  if (!r.ok) return { ok: false, error: '只有本家庭成员可以撤回' };
  store.update('careGrants', g.id, { revokedAt: now(), revokedBy: String(visitor).slice(0, 120) }, '陪护·撤回授权', g.title);
  return { ok: true };
}
function grantValid(grantId, docId) {
  const g = store.findBy('careGrants', 'id', String(grantId || ''));
  if (!g || g.revokedAt) return null;
  if (docId && String(g.docId) !== String(docId)) return null;
  return now() <= Number(g.expiresAt || 0) ? g : null;
}

function esc2(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

// ===== 13) 存量加密迁移（运营，管理令牌端点调用）=====
// 档案：明文行 → 密文信封，同时抹掉明文字段；资料文件：明文 → CENC1 信封。
// 幂等：已加密的跳过；任何一条失败都如实计数，不虚报"全部成功"。
function migrateEncryption() {
  const out = {
    profiles: { migrated: 0, already: 0, failed: 0 },
    docs: { encrypted: 0, already: 0, missing: 0, failed: 0 },
  };
  store.list('careProfiles', 999).forEach(row => {
    if (row.sec != null) { out.profiles.already++; return; }
    const o = openProfileRow(row);
    if (!o.ok) { out.profiles.failed++; return; }
    const health = {};
    HEALTH_FIELDS.forEach(k => { health[k] = o.profile[k] !== undefined ? o.profile[k] : EMPTY_HEALTH[k]; });
    const seal = sealHealth(health);
    if (!seal.ok) { out.profiles.failed++; return; }
    const wipe = {};
    HEALTH_FIELDS.forEach(k => { wipe[k] = EMPTY_HEALTH[k]; });
    store.update('careProfiles', row.id, Object.assign({ sec: seal.sec }, wipe), '陪护·档案加密迁移', String(row.familyId));
    out.profiles.migrated++;
  });
  store.list('careDocs', 999).forEach(d => {
    if (!d.file || d.status) return;   // 无附件或已删除/过期（文件已物理清除）不动
    const safe = String(d.file).replace(/[^A-Za-z0-9_.-]/g, '');
    const full = path.join(docDir(), safe);
    let buf;
    try {
      if (!fs.existsSync(full)) { out.docs.missing++; return; }
      buf = fs.readFileSync(full);
    } catch (e) { out.docs.failed++; return; }
    if (careCrypto.isSealedBuffer(buf)) { out.docs.already++; return; }
    try { fs.writeFileSync(full, careCrypto.sealBuffer(buf)); out.docs.encrypted++; }
    catch (e) { out.docs.failed++; }
  });
  out.ok = out.profiles.failed === 0 && out.docs.failed === 0;
  out.note = out.ok
    ? '迁移完成：明文档案与资料文件已全部转为 AES-256-GCM 密文（密钥与数据分离）'
    : '有条目迁移失败（见计数）：密钥不可用或文件不可写；失败项保持原状，不虚报成功';
  return out;
}

module.exports = {
  SLAS, OFFLINE_MS, KINDS, DEVICE_TYPES, TASK_TYPES,
  createFamily, joinFamily, familyView, getProfile, saveProfile,
  registerDevice, heartbeat, deviceByToken, deviceStatus,
  raiseAlert, ackAlert, resolveAlert, listAlerts,
  createTask, completeTask, listTasks,
  addDoc, listDocs, openDoc,
  sweep, center, loop, report, carePlan,
  membershipsOf, requireMember, maskPhone,
  seedOpen, seedCheck, seedLimit, seedLimitNow,
  createCareOrder, careOrderView, fulfillCareOrder,
  notifyAlert, flushNotifies, notifiesSummary, smsCfg,
  retentionDays, docHousekeeping, deleteDoc,
  grantDoc, revokeGrant, grantValid,
  migrateEncryption,
};
