'use strict';
// core/license.js — 授权码（License Key）离线激活：让"下载到本机的桌面/原生 App"也有收费墙。
//
// ── 为什么必须有这一层 ──────────────────────────────────────────────
// 服务端收费墙（core/subs.js + core/paywall.js）是按**访客**算的，对公网部署有效。
// 但交付给客户的桌面版（Electron）与原生壳（Capacitor）跑在**用户自己的电脑**上：
//   · 所有请求都来自 127.0.0.1 → isLoopback() 为真；
//   · 用户删掉本地 data 目录就能重置"免费 10 次"；
//   · 用户就是本机管理员，能直接 POST /v1/paywall/toggle 把墙关掉。
// 结果：下载版**没有**收费墙。这不是"配置问题"，是那一层的设计缺口。
//
// ── 解法 ────────────────────────────────────────────────────────────
// 1) 非对称签名：运营方服务器持有**私钥**签发授权码；客户端只内置**公钥**。
//    客户端能验签、但**无法伪造**授权码（Ed25519）。
// 2) 授权码里带 plan / 到期时间 / 可选机器指纹(fp)。
// 3) 激活 = 用授权码在本机换出一条与公网订阅同构的 sublist 记录，
//    于是所有既有闸门（gate/gatePool/autoGate）**不改一行**就生效。
// 4) 客户端模式（BINGDASHAN_CLIENT=1）下：收费墙强制开启、且禁止开关，
//    签发接口不可用（私钥不在客户端），换 Key 换不了权益。
//
// ── 诚实边界（不吹） ────────────────────────────────────────────────
// 纯离线 DRM 不可能 100% 防破解：有能力的用户仍可改 asar/内存。本层的作用是
// **让正常用户买得到、也让白嫖不再是"点一下就行"**，并把商业闭环接上；
// 真正不可绕过的收费墙是"联网走托管服务端"那一版（见 CROSS-PLATFORM.md 的 Hosted 模式）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const store = require('./store');

const FMT = 'BDS1';
const PUB_FILE = path.join(__dirname, '..', 'license.pub');
const KEY_FILE = path.join(__dirname, '..', 'license.key');
const DAY = 86400000;

// 数据目录中的文件路径。
// 【坑，实测踩过】store.dataPath() 内部会 mkdirSync（它是"目录"语义）：拿它拼**文件**路径，
// 第一次把 license.key 顶成了一个**目录** → readFileSync 报 EISDIR → 签发静默失效。
// 所以这里的文件路径一律自己 join(DATA_DIR)。唯一真源，别处不要再拼。
function dataFile(name) {
  const dir = store.DATA_DIR || path.join(__dirname, '..', 'data');
  return path.join(dir, String(name));
}

// ── 客户端模式判定 ──────────────────────────────────────────────────
// 打包进桌面/原生壳时由壳注入 BINGDASHAN_CLIENT=1（见 electron/main.cjs / capacitor.config.json）。
// 也允许用设置项打开（本地自测用）。env 优先——用户在界面里关不掉它。
function isClientMode() {
  const env = String(process.env.BINGDASHAN_CLIENT || '').toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes') return true;
  return store.getSetting('clientMode') === true;
}

// ── 机器指纹：绑定授权到某台设备（可选）───────────────────────────────
// 用 hostname + 平台 + 架构 + 第一个非内网网卡 MAC。取不到 MAC 时退化为前三项，
// 不抛错——否则无网卡的机器（部分容器）会完全无法激活。
function machineFingerprint() {
  const parts = [os.hostname() || 'nohost', os.platform(), os.arch()];
  try {
    const nets = os.networkInterfaces();
    let mac = '';
    for (const name of Object.keys(nets)) {
      for (const ni of nets[name] || []) {
        if (ni && !ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') { mac = ni.mac; break; }
      }
      if (mac) break;
    }
    if (mac) parts.push(mac);
  } catch (e) { /* 无网卡也能激活（仅不绑定 MAC） */ }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

// ── 信任的公钥环 ────────────────────────────────────────────────────
// 客户端模式只认「内置/环境变量」公钥：绝不能允许从设置里读，
// 否则破解者写入自己的公钥就能自签自验，整个机制归零。
function trustedPubs() {
  const out = [];
  const env = String(process.env.BINGDASHAN_LICENSE_PUBKEY || '').trim();
  if (env) out.push(env);
  try { const t = fs.readFileSync(PUB_FILE, 'utf8').trim(); if (t) out.push(t); } catch (e) {}
  if (!isClientMode()) {
    try { const t = fs.readFileSync(dataFile('license.pub'), 'utf8').trim(); if (t) out.push(t); } catch (e) {}
    const s = store.getSetting('licensePublicKey');
    if (s) out.push(String(s).trim());
  }
  return out.filter(Boolean);
}
function pubConfigured() { return trustedPubs().length > 0; }
// 公钥来源审计：便于运营端自查"这把码到底认哪把公钥"，避免装了新包还用旧公钥的乌龙。
function pubSources() {
  const out = [];
  if (String(process.env.BINGDASHAN_LICENSE_PUBKEY || '').trim()) out.push('env:BINGDASHAN_LICENSE_PUBKEY');
  try { if (fs.readFileSync(PUB_FILE, 'utf8').trim()) out.push('file:license.pub'); } catch (e) {}
  if (!isClientMode()) {
    try { if (fs.readFileSync(store.dataPath('license.pub'), 'utf8').trim()) out.push('data:license.pub'); } catch (e) {}
    if (store.getSetting('licensePublicKey')) out.push('setting:licensePublicKey');
  }
  return out;
}
function publicKeyObject(b64) { return crypto.createPublicKey({ key: Buffer.from(b64, 'base64url'), format: 'der', type: 'spki' }); }

// ── 运营方密钥对（只在"服务端/发码机"上生成，私钥绝不出机器）─────────
function genKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
}
function genKeyPairTo(dir) {
  const kp = genKeyPair();
  const base = dir || path.join(__dirname, '..');
  fs.writeFileSync(path.join(base, 'license.pub'), kp.pub + '\n');
  fs.writeFileSync(path.join(base, 'license.key'), kp.priv + '\n', { mode: 0o600 });
  return { pub: kp.pub, priv: kp.priv, pubFile: path.join(base, 'license.pub'), keyFile: path.join(base, 'license.key') };
}
// 私钥来源：env → 数据目录 license.key → 仓库根 license.key。
// 【为什么不缓存】运营端轮换私钥后不必重启；也避免测试/运维期"改了文件却still用旧key"的静默错。
// 数据目录优先于仓库根：真实密钥属于"运行期机密"，不该跟代码放一起（仓库根那份只作为开发便利）。
function privateKeySource() {
  const env = String(process.env.BINGDASHAN_LICENSE_KEY || '').trim();
  if (env) return { where: 'env:BINGDASHAN_LICENSE_KEY', b64: env };
  const cands = [dataFile('license.key'), KEY_FILE];
  for (const f of cands) {
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return { where: f, b64: t }; } catch (e) { /* 换下一个 */ }
  }
  throw Object.assign(new Error('运营端未配置签发私钥。请把 license.key 放到数据目录（' + dataFile('license.key')
    + '）或用环境变量 BINGDASHAN_LICENSE_KEY 提供。签发私钥绝不下发客户端。'), { code: 'NO_PRIVKEY' });
}
function signingReady() { try { privateKeySource(); return true; } catch (e) { return false; } }
function signingSource() { try { return privateKeySource().where; } catch (e) { return null; } }
function privateKeyObject() {
  const src = privateKeySource();
  return crypto.createPrivateKey({ key: Buffer.from(src.b64, 'base64url'), format: 'der', type: 'pkcs8' });
}

// ── 签发 ────────────────────────────────────────────────────────────
// plans: t(=7天体验) / m(1月) / q(3月) / y(1年) / p(永久≈100年，做"买断"档)
const PLAN_DAYS = { t: 7, m: 30, q: 90, y: 365, p: 36500 };
function issue(opts) {
  const o = opts || {};
  const plan = String(o.plan || 'm');
  const days = Number(o.days) > 0 ? Number(o.days) : (PLAN_DAYS[plan] || 30);
  const now = Date.now();
  const payload = {
    v: 1,
    id: String(o.id || crypto.randomBytes(8).toString('hex')),
    plan,
    iat: now,
    exp: Number(o.exp) > now ? Number(o.exp) : now + days * DAY,
    fp: o.fp ? String(o.fp).slice(0, 64) : null,   // 绑机器（可空＝不绑）
    who: o.who ? String(o.who).slice(0, 80) : null, // 备注：买家邮箱/账号，便于对账
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(body), privateKeyObject()).toString('base64url');
  return { key: FMT + '-' + body + '.' + sig, payload };
}

// ── 验签 ────────────────────────────────────────────────────────────
// 只在验签通过后才解析内容（先验后信，避免把未验签数据当事实）。
function verify(key) {
  const raw = String(key || '').trim();
  if (!raw.startsWith(FMT + '-')) throw Object.assign(new Error('授权码格式不对'), { code: 'BAD_FORMAT' });
  const rest = raw.slice(FMT.length + 1);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) throw Object.assign(new Error('授权码格式不对'), { code: 'BAD_FORMAT' });
  const body = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  const pubs = trustedPubs();
  if (!pubs.length) throw Object.assign(new Error('本机未配置授权公钥（运营方需先执行 npm run license:keygen 并随安装包发布 license.pub）'), { code: 'NO_PUBKEY' });
  let ok = false;
  for (const p of pubs) {
    try {
      if (crypto.verify(null, Buffer.from(body), publicKeyObject(p), Buffer.from(sig, 'base64url'))) { ok = true; break; }
    } catch (e) { /* 换下一把公钥 */ }
  }
  if (!ok) throw Object.assign(new Error('授权码签名无效（可能被修改过）'), { code: 'BAD_SIGN' });
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch (e) { throw Object.assign(new Error('授权码内容损坏'), { code: 'BAD_BODY' }); }
  if (!payload || payload.v !== 1) throw Object.assign(new Error('授权码版本不支持'), { code: 'BAD_VERSION' });
  return payload;
}

// 只读校验（不改状态），给"检查授权码"这类接口用
function inspect(key) {
  const payload = verify(key);
  const now = Date.now();
  return {
    payload,
    expired: !(payload.exp > now),
    daysLeft: Math.max(0, Math.ceil((payload.exp - now) / DAY)),
    fpMatch: !payload.fp || payload.fp === machineFingerprint(),
  };
}

// ── 激活台账：每枚授权码记一条「谁、何时、到期、绑没绑机器」──────
// 【为什么按 licenseId 存，而不是一个全局 licenseInfo 设置】
// 全局设置是**全机唯一**的：A 激活、B 再激活，A 的状态就会被 B 覆盖成"别人的授权"。
// 单机单用户时看不出问题，一旦同机多账号（或客服帮客户在同一台机器上试码）就会
// 出现"A 的到期时间变成 B 的"。所以状态一律从「该访客自己的 sublist 行」反查。
function activationLedger() { return store.getSetting('licenseActivated') || {}; }
function ledgerSet(id, rec) {
  const l = activationLedger();
  l[id] = rec;
  store.setSetting('licenseActivated', l);
}

// ── 激活：用授权码在本机换出与公网订阅同构的 sublist 记录 ─────────────
function activate(key, visitorKey) {
  const info = inspect(key);
  const p = info.payload;
  if (info.expired) {
    const e = new Error('授权码已过期（到期 ' + new Date(p.exp).toLocaleString('zh-CN') + '），请联系客服续期'); e.code = 'EXPIRED'; throw e;
  }
  if (!info.fpMatch) {
    const e = new Error('此授权码已绑定另一台设备，请用该设备登录或联系客服解绑'); e.code = 'FP_MISMATCH'; throw e;
  }
  const v = require('./subs').visitorBy(visitorKey);
  const led = activationLedger();
  const used = led[p.id];
  if (used && used.visitor && used.visitor !== v.visitor) {
    const e = new Error('此授权码已被其他账号激活，禁止重复使用'); e.code = 'REUSED'; throw e;
  }
  // 与该访客已有订阅顺延（与 subs.activate 口径一致：只延长，不回退）
  const all = store.list('sublist', 999);
  const cur = all.find(x => x.visitor === v.visitor && x.expireAt > Date.now());
  // 【2026-10-21 漏洞修复】授权码激活原本**不写 tier** → gatePool 回落 'legacy'
  // （老订阅"全不限次"的承诺）→ 重耗分区日限被绕过（白嫖算力）。
  // 现在按授权码里的 plan 推导档位；认不出就按基础档（宁可少给，不多给）。
  let licTier = 'basic';
  try { licTier = require('./subs').tierOf(p.plan) || 'basic'; } catch (e) { licTier = 'basic'; }
  if (licTier === 'legacy') licTier = 'basic';
  if (cur && cur.id) {
    store.update('sublist', cur.id, {
      expireAt: Math.max(cur.expireAt, p.exp), licenseId: p.id,
      tier: cur.tier && cur.tier !== 'legacy' ? cur.tier : licTier,
    }, '授权码激活(顺延)');
  } else if (!cur) {
    store.push('sublist', { visitor: v.visitor, plan: 'lic:' + p.plan, tier: licTier, expireAt: p.exp, grantedOrders: [], licenseId: p.id }, '授权码激活', v.visitor);
  } else {
    // 有已过期行但不满足上面的条件（理论不可达），保证一定有一条有效行
    store.push('sublist', { visitor: v.visitor, plan: 'lic:' + p.plan, tier: licTier, expireAt: p.exp, grantedOrders: [], licenseId: p.id }, '授权码激活', v.visitor);
  }
  ledgerSet(p.id, { id: p.id, visitor: v.visitor, at: Date.now(), exp: p.exp, plan: p.plan, who: p.who || null, fp: p.fp || null });
  const digest = crypto.createHash('sha256').update(String(key).trim()).digest('hex').slice(0, 16);
  store.setSetting('licenseKeyDigest', digest);   // 只存摘要，不存原文
  store.push('audit', { action: '授权码激活', detail: 'plan=' + p.plan + ' 到期=' + new Date(p.exp).toISOString().slice(0, 10) + ' 访客=' + v.visitor }, null, null);
  return status(visitorKey);
}

function deactivate(visitorKey) {
  const v = require('./subs').visitorBy(visitorKey);
  const all = store.list('sublist', 999);
  const cur = all.find(x => x.visitor === v.visitor && x.licenseId && x.expireAt > Date.now());
  if (cur && cur.id) store.update('sublist', cur.id, { expireAt: 0 }, '授权码解绑');
  if (cur && cur.licenseId) {
    const l = activationLedger();
    delete l[cur.licenseId];
    store.setSetting('licenseActivated', l);
  }
  store.setSetting('licenseKeyDigest', null);
  store.push('audit', { action: '授权码解绑', detail: '访客=' + v.visitor + (cur && cur.licenseId ? ' 授权=' + cur.licenseId : '') }, null, null);
  return status(visitorKey);
}

// 状态一律从「该访客自己的有效订阅行」反查，绝不用全局设置冒充。
function status(visitorKey) {
  const vk = visitorKey ? require('./subs').visitorBy(visitorKey).visitor : null;
  const now = Date.now();
  const all = store.list('sublist', 999);
  const cur = vk ? all.find(x => x.visitor === vk && x.expireAt > now) : null;
  const info = (cur && cur.licenseId) ? (activationLedger()[cur.licenseId] || null) : null;
  return {
    ok: true,
    clientMode: isClientMode(),
    pubConfigured: pubConfigured(),
    activated: !!(info && info.exp > now),
    subscribed: !!cur,                     // 有任意有效权益（授权码或公网订阅）
    license: info ? {
      id: info.id, plan: info.plan, exp: info.exp,
      daysLeft: Math.max(0, Math.ceil((info.exp - now) / DAY)),
      bound: !!info.fp, who: info.who, at: info.at,
    } : null,
    fingerprint: machineFingerprint(),
    keyDigest: store.getSetting('licenseKeyDigest') || null,
  };
}

module.exports = {
  FMT, DAY, PLAN_DAYS, dataFile,
  isClientMode, machineFingerprint, trustedPubs, pubConfigured, pubSources,
  genKeyPair, genKeyPairTo, issue, verify, inspect,
  signingReady, signingSource,
  activate, deactivate, status,
};
