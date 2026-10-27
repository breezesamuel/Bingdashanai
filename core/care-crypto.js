// core/care-crypto.js — 健康数据静态加密（PIPL 敏感个人信息，2026-10-24 P0）
//
// 【为什么必须有】db.json 明文存着年龄/病史/过敏/用药/紧急联系人，资料目录明文存着
// 病历照片。PIPL 把健康数据列为敏感个人信息：一旦库文件/备份泄露，泄露的就是
// 一个个老人的病史。字段级加密 + 密钥分离把"拿到 db.json"和"能读健康数据"分开。
//
// 【设计】
//   · 算法 AES-256-GCM：每条数据独立随机 IV，认证标签防篡改
//   · 密钥分离：密钥**不在 db.json**。来源优先级：
//       1) 环境变量 CARE_DATA_KEY（生产推荐：密钥管理/独立卷注入）
//       2) data/care-data.key 密钥文件（首次使用自动生成 32B hex，0600）
//       3) 都没有 → fail-closed：拒绝加密写入，绝不静默降级为明文
//   · 轮换：换钥匙时旧钥匙放 CARE_DATA_KEY_OLD（只用于解密），
//     存量数据在下一次保存时自动重封为新钥，随后可撤销 OLD。
//   · 兼容：旧明文数据不带信封前缀，读路径按明文处理（迁移由运营端点执行）。
//
// 【诚实红线】密钥不可用时报错而不是装作加密了；解密失败返回失败而不是返回密文。
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const ENV_PRIMARY = 'CARE_DATA_KEY';       // 主密钥（hex64 / base64(32B)）
const ENV_OLD = 'CARE_DATA_KEY_OLD';       // 轮换旧密钥（仅解密兜底）
const KEY_FILE = 'care-data.key';          // 位于 DATA_DIR，与 db.json 同级但分离
const PREFIX = 'careenc1.';                // 文本信封前缀（识别密文 vs 旧明文）
const FILE_MAGIC = Buffer.from('CENC1');   // 二进制信封魔数（资料文件）

function parseKey(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  const b = Buffer.from(s, 'base64');
  return b.length === 32 ? b : null;
}

// 密钥文件：懒加载 + 进程内缓存（每次 seal/open 只读一次磁盘）。
// 注意：不能走 store.dataPath()——它会对结果路径做 mkdirSync，会把密钥名建成目录。
function keyFilePath() { return path.join(store.DATA_DIR, KEY_FILE); }
let _fileKeyCache = null;
function loadFileKey() {
  if (_fileKeyCache) return _fileKeyCache;
  const p = keyFilePath();
  try {
    const k = parseKey(fs.readFileSync(p, 'utf8'));
    if (k) { _fileKeyCache = k; return k; }
  } catch (e) { /* 不存在或不可读 → 尝试自动生成 */ }
  const k = crypto.randomBytes(32);
  try {
    fs.writeFileSync(p, k.toString('hex') + '\n', { mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch (e2) { /* Windows 等环境 chmod 受限 */ }
    _fileKeyCache = k;
    return k;
  } catch (e2) {
    return null;   // 目录不可写且无 env 密钥 → 调用方 fail-closed
  }
}

function primary() {
  const env = parseKey(process.env[ENV_PRIMARY]);
  if (env) return env;
  return loadFileKey();
}
function decryptKeys() {
  const list = [primary()];
  const old = parseKey(process.env[ENV_OLD]);
  if (old) list.push(old);
  const seen = [];
  return list.filter(k => {
    if (!k) return false;
    if (seen.some(x => x.equals(k))) return false;
    seen.push(k);
    return true;
  });
}

function keyFail() {
  const e = new Error('健康数据加密密钥不可用（CARE_DATA_KEY 未设置且 ' + KEY_FILE + ' 无法生成）');
  e.code = 'care_key_unavailable';
  return e;
}

// —— 文本信封（档案字段 JSON）：careenc1.<iv>.<tag>.<ct>（均为 base64，'.' 不在 base64 字母表）——
function isSealed(s) { return typeof s === 'string' && s.indexOf(PREFIX) === 0; }

function sealText(plain) {
  const k = primary();
  if (!k) throw keyFail();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
}
function openText(env) {
  if (!isSealed(env)) return { ok: false, code: 'not_sealed' };
  const parts = String(env).slice(PREFIX.length).split('.');
  if (parts.length !== 3) return { ok: false, code: 'bad_envelope' };
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const ct = Buffer.from(parts[2], 'base64');
  const keys = decryptKeys();
  if (!keys.length) return { ok: false, code: 'care_key_unavailable' };
  for (const k of keys) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
      d.setAuthTag(tag);
      const pt = Buffer.concat([d.update(ct), d.final()]);
      return { ok: true, value: pt.toString('utf8') };
    } catch (e) { /* 试下一把钥匙（轮换期） */ }
  }
  return { ok: false, code: 'decrypt_failed' };
}

function sealJson(obj) { return sealText(JSON.stringify(obj == null ? null : obj)); }
function openJson(env) {
  const r = openText(env);
  if (!r.ok) return r;
  try { return { ok: true, value: JSON.parse(r.value) }; }
  catch (e) { return { ok: false, code: 'bad_json' }; }
}

// —— 二进制信封（资料文件）：CENC1 + iv(12) + tag(16) + ct ——
function isSealedBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length > FILE_MAGIC.length + 12 + 16
    && buf.slice(0, FILE_MAGIC.length).equals(FILE_MAGIC);
}
function sealBuffer(buf) {
  const k = primary();
  if (!k) throw keyFail();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([FILE_MAGIC, iv, c.getAuthTag(), ct]);
}
function openBuffer(buf) {
  if (!isSealedBuffer(buf)) return { ok: false, code: 'not_sealed' };
  const off = FILE_MAGIC.length;
  const iv = buf.slice(off, off + 12);
  const tag = buf.slice(off + 12, off + 28);
  const ct = buf.slice(off + 28);
  const keys = decryptKeys();
  if (!keys.length) return { ok: false, code: 'care_key_unavailable' };
  for (const k of keys) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
      d.setAuthTag(tag);
      return { ok: true, value: Buffer.concat([d.update(ct), d.final()]) };
    } catch (e) { }
  }
  return { ok: false, code: 'decrypt_failed' };
}

// 运营可见的密钥状态（不泄露密钥本体）
function keyStatus() {
  const envSet = !!parseKey(process.env[ENV_PRIMARY]);
  const oldSet = !!parseKey(process.env[ENV_OLD]);
  const fileKey = loadFileKey();
  return {
    available: !!(envSet || fileKey),
    algo: 'aes-256-gcm',
    source: envSet ? ('env:' + ENV_PRIMARY) : (fileKey ? ('file:' + KEY_FILE) : 'unavailable'),
    keyFile: keyFilePath(),
    envOverride: envSet,
    rotationConfigured: oldSet,
    envelope: { text: PREFIX + '…', file: FILE_MAGIC.toString('ascii') + '…' },
  };
}

module.exports = {
  isSealed, sealText, openText, sealJson, openJson,
  isSealedBuffer, sealBuffer, openBuffer, keyStatus,
};
