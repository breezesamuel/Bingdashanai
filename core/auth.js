// core/auth.js — 邮箱/手机绑定身份，跨设备保持订阅状态
//
// 设计：
//   1. 访客记录新增 email, phone, emailVerified, phoneVerified, lastLoginAt
//   2. 验证码存储：内存 + 持久化（codeHash, expiresAt, attempts）
//   3. 登录流程：发码 → 验码 → 返回 vid（签名后的完整身份）
//   4. 绑定流程：已有 vid 的用户绑定邮箱/手机，验证后写入 visitor 记录
//   5. 找回流程：输入邮箱/手机 → 发码 → 验码 → 返回原 vid（自动合并配额/订阅）
//   6. 安全：验证码 6 位数字，10 分钟有效，最多 3 次尝试，同 IP/目标 1 分钟限流

const crypto = require('crypto');
const store = require('./store');
const outreach = require('./outreach');

// 内存验证码缓存（重启丢失，配合持久化兜底）
const CODE_STORE = new Map(); // key: "email:xxx" 或 "phone:xxx" → { hash, expires, attempts, ip }

// 验证码配置
const CODE_LEN = 6;
const CODE_TTL_MS = 10 * 60 * 1000; // 10 分钟
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_MS = 60 * 1000; // 同目标 1 分钟只能发 1 次

// 生成 6 位数字验证码
function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// 简单哈希（防止明文存储）
function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex').slice(0, 16);
}

// 验证码 key
function codeKey(target, type) {
  return `${type}:${target.toLowerCase()}`;
}

// 发送验证码
// 投递是同步且真实的：成功才落库并返回成功，失败如实回报（绝不谎报「已发送」）。
// 用短超时（8s）+ 最多 2 次尝试，兼顾可靠与不把用户卡在长等待上。
const SEND_TIMEOUT_MS = 8000;
const SEND_ATTEMPTS = 2;

async function sendCode(target, type, ip) {
  const key = codeKey(target, type);
  const now = Date.now();

  // 限流检查
  const existing = CODE_STORE.get(key);
  if (existing && now - existing.sentAt < RATE_LIMIT_MS) {
    return { ok: false, error: '发送过于频繁，请 1 分钟后重试', retryAfter: Math.ceil((RATE_LIMIT_MS - (now - existing.sentAt)) / 1000) };
  }

  if (type !== 'email') {
    return { ok: false, error: '短信通道尚未开通，请使用邮箱验证' };
  }

  const code = genCode();
  const codeHash = hashCode(code);
  const expiresAt = now + CODE_TTL_MS;

  // 先真实投递；只有投递成功才落库，避免用户拿着一个「永远收不到」的验证码。
  let lastErr = '';
  let sent = false;
  for (let attempt = 1; attempt <= SEND_ATTEMPTS && !sent; attempt++) {
    const r = await outreach.sendVerificationCode({ to: target, code, timeoutMs: SEND_TIMEOUT_MS })
      .catch(e => ({ ok: false, error: String(e.message || e) }));
    sent = !!(r && r.ok);
    if (!sent) lastErr = (r && r.error) || '未知错误';
    if (!sent && attempt < SEND_ATTEMPTS) await new Promise(res => setTimeout(res, 1200));
  }

  if (!sent) {
    return { ok: false, error: '验证码邮件发送失败（' + String(lastErr).slice(0, 80) + '），请稍后重试' };
  }

  CODE_STORE.set(key, { hash: codeHash, expiresAt, attempts: 0, sentAt: Date.now(), ip });
  try { store.setSetting(`auth_code_${key}`, JSON.stringify({ hash: codeHash, expiresAt, attempts: 0 })); } catch (e) {}

  return { ok: true, message: `验证码已发送至 ${maskTarget(target, type)}，${CODE_TTL_MS / 60000} 分钟内有效` };
}

// 掩码显示
function maskTarget(target, type) {
  if (type === 'email') {
    const [local, domain] = target.split('@');
    return local.slice(0, 2) + '***' + '@' + domain;
  }
  return target.slice(0, 3) + '****' + target.slice(-2);
}

// 验证验证码
function verifyCode(target, type, inputCode) {
  const key = codeKey(target, type);
  const now = Date.now();

  let entry = CODE_STORE.get(key);
  if (!entry) {
    // 尝试从持久化恢复
    try {
      const saved = store.getSetting(`auth_code_${key}`);
      if (saved) entry = JSON.parse(saved);
    } catch (e) {}
  }
  if (!entry) return { ok: false, error: '验证码不存在或已过期，请重新获取' };

  if (now > entry.expiresAt) {
    CODE_STORE.delete(key);
    try { store.deleteSetting(`auth_code_${key}`); } catch (e) {}
    return { ok: false, error: '验证码已过期，请重新获取' };
  }

  if (entry.attempts >= MAX_ATTEMPTS) {
    CODE_STORE.delete(key);
    try { store.deleteSetting(`auth_code_${key}`); } catch (e) {}
    return { ok: false, error: '验证次数过多，验证码已失效，请重新获取' };
  }

  entry.attempts++;
  CODE_STORE.set(key, entry);
  try { store.setSetting(`auth_code_${key}`, JSON.stringify(entry)); } catch (e) {}

  if (hashCode(inputCode) !== entry.hash) {
    return { ok: false, error: `验证码错误，还剩 ${MAX_ATTEMPTS - entry.attempts} 次机会` };
  }

  // 验证成功，清理
  CODE_STORE.delete(key);
  try { store.deleteSetting(`auth_code_${key}`); } catch (e) {}
  return { ok: true };
}

// 绑定邮箱/手机到当前 visitor
function bindContact(vid, target, type) {
  const subs = getSubs();
  const visitorKey = subs.verify(vid) || vid; // 兼容传裸 key
  const v = subs.visitorBy(visitorKey);

  const field = type === 'email' ? 'email' : 'phone';
  const verifiedField = type === 'email' ? 'emailVerified' : 'phoneVerified';

  // 检查是否已被其他 visitor 占用
  const all = store.list('visitors', 999);
  const conflict = all.find(x => x[field] && x[field].toLowerCase() === target.toLowerCase() && x.visitor !== v.visitor);
  if (conflict) {
    return { ok: false, error: `该${type === 'email' ? '邮箱' : '手机'}已被其他账号绑定` };
  }

  store.update('visitors', v.id, {
    [field]: target.toLowerCase(),
    [verifiedField]: true,
    lastLoginAt: Date.now()
  }, `绑定${type === 'email' ? '邮箱' : '手机'}`);

  return { ok: true, message: `已绑定${type === 'email' ? '邮箱' : '手机'}，跨设备登录将自动恢复订阅状态` };
}

// 邮箱/手机登录（找回身份）
// opts.verified：调用方（路由层）**刚刚校验过邮箱验证码** → 允许把邮箱正式绑定为已验证。
// 【为什么需要它】邮箱是"找回线索"而不是凭证；只有验证码能证明你拥有这个邮箱。
// 路由层先 verifyCode 成功，才把 verified=true 传进来 —— 模块层自己不会去猜。
function loginContact(target, type, opts) {
  const subs = getSubs();
  const verifiedNow = !!(opts && opts.verified);
  const field = type === 'email' ? 'email' : 'phone';
  const all = store.list('visitors', 999);
  let v = all.find(x => x[field] && x[field].toLowerCase() === target.toLowerCase());

  // 【2026-10-21 跨设备恢复】找不到"绑了这个邮箱的访客"时，**用订单上的邮箱找**：
  // 客户在 A 设备下单付款（邮箱写在订单上），换到 B 设备用邮箱找回 → B 上根本没有
  // 绑定记录 → 旧逻辑报"未找到绑定该账号的身份" → **付了钱却用不了**。
  // 现在：邮箱在**已付订单**上也能定位到原身份。
  let restoredFrom = null;
  const mail = type === 'email' ? String(target).trim().toLowerCase() : '';
  const paidForMail = mail
    ? store.list('orders').filter(o => o && o.paid === true && String(o.email || '').trim().toLowerCase() === mail)
    : [];
  if (!v && type === 'email') {
    for (const o of paidForMail) {
      const owner = all.find(x => x.visitor === o.visitor);
      if (owner) { v = owner; restoredFrom = o.id; break; }
    }
  }
  if (!v) return { ok: false, error: '未找到绑定该账号的身份，请先注册/绑定' };
  if (!v[field + 'Verified']) {
    // 邮箱来自订单（未在身份上验证过）→ 这次**验证码已验证**（路由层传入），可以正式绑定
    const hasBusiness = restoredFrom || paidForMail.length > 0;
    if (verifiedNow && hasBusiness && type === 'email') {
      store.update('visitors', v.id, { email: mail, emailVerified: true, lastLoginAt: Date.now() }, '邮箱验证通过（按订单邮箱恢复身份）', null);
      v = store.findBy('visitors', 'id', v.id);
    } else {
      return { ok: false, error: '该联系方式未验证，请先完成验证' };
    }
  }

  // 权益迁移：把该邮箱名下**其它身份**的已付订阅，镜像到当前身份（不叠加时长、不重复记账）
  let migrated = 0;
  try {
    migrated = migrateEntitlements(v, target, type);
  } catch (e) { /* 迁移失败不阻断登录 */ }

  // 返回签名后的 vid
  const issued = subs.issue(v.visitor);
  store.update('visitors', v.id, { lastLoginAt: Date.now() }, '邮箱/手机登录');
  return { ok: true, vid: issued.vid, visitor: v.visitor, restoredFrom, migrated };
}

/**
 * 把「同一邮箱名下、属于其它身份」的已付权益，镜像到当前身份。
 * 【为什么要镜像而不是叠加】叠加时长 = 一次付款买两次月数（亏钱）；
 * 直接改归属 = 抹掉原身份的历史。镜像 = 新身份多一条**同到期时间**的权益，
 * 原身份不受影响，两边都能用（不亏钱、不虚增）。
 */
function migrateEntitlements(v, target, type) {
  if (type !== 'email') return 0;
  const subs = getSubs();
  const mail = String(target).trim().toLowerCase();
  const orders = store.list('orders').filter(o => o && o.paid === true
    && String(o.email || '').trim().toLowerCase() === mail
    && o.visitor && o.visitor !== v.visitor);
  if (!orders.length) return 0;
  const own = store.findAllBy('sublist', 'visitor', v.visitor);
  let n = 0;
  for (const o of orders) {
    const src = store.findAllBy('sublist', 'visitor', o.visitor)
      .filter(s => Number(s.expireAt || 0) > Date.now())
      .sort((a, b) => Number(b.expireAt || 0) - Number(a.expireAt || 0))[0];
    if (!src) continue;
    // 已经有同订单的权益就不重复镜像
    if (own.some(s => Array.isArray(s.grantedOrders) && s.grantedOrders.includes(o.id))) continue;
    store.push('sublist', {
      visitor: v.visitor, plan: src.plan, tier: src.tier || 'basic',
      expireAt: src.expireAt, grantedOrders: [o.id], mirrorOf: src.id, mirroredAt: Date.now(),
    }, '跨设备恢复：镜像已付权益', v.visitor + ' ← ' + o.id);
    n++;
  }
  return n;
}

// 解绑
function unbindContact(vid, type) {
  const subs = getSubs();
  const visitorKey = subs.verify(vid) || vid;
  const v = subs.visitorBy(visitorKey);

  const field = type === 'email' ? 'email' : 'phone';
  const verifiedField = type === 'email' ? 'emailVerified' : 'phoneVerified';

  if (!v[field]) return { ok: false, error: '未绑定该联系方式' };

  store.update('visitors', v.id, { [field]: '', [verifiedField]: false }, `解绑${type === 'email' ? '邮箱' : '手机'}`);
  return { ok: true, message: '已解绑' };
}

// 获取当前访客的绑定状态
function getBindings(vid) {
  const subs = getSubs();
  const visitorKey = subs.verify(vid) || vid;
  const v = subs.visitorBy(visitorKey);
  return {
    ok: true,
    email: v.email || null,
    emailVerified: !!v.emailVerified,
    phone: v.phone || null,
    phoneVerified: !!v.phoneVerified,
    lastLoginAt: v.lastLoginAt ? new Date(v.lastLoginAt).toISOString() : null
  };
}

// 启动时恢复验证码缓存
function restoreCodes() {
  try {
    const settings = store.read().settings || {};
    for (const [k, v] of Object.entries(settings)) {
      if (k.startsWith('auth_code_') && v) {
        try {
          const entry = JSON.parse(v);
          if (entry.expiresAt > Date.now()) {
            CODE_STORE.set(k.slice(10), entry); // 去掉 'auth_code_' 前缀
          } else {
            store.deleteSetting(k);
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
}

// 延迟加载 subs（避免循环依赖）
let _subs;
function getSubs() {
  if (!_subs) _subs = require('./subs');
  return _subs;
}

module.exports = {
  sendCode,
  verifyCode,
  bindContact,
  loginContact,
  unbindContact,
  getBindings,
  restoreCodes,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  RATE_LIMIT_MS
};