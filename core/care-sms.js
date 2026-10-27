// core/care-sms.js — 陪护告警短信（阿里云 Dysmsapi · fail-closed）
//
// 【原则】
//   · 未配置密钥/签名/模板 → configured()=false，调用方必须走"人工电话"兜底，绝不假装发出
//   · 预算熔断在 core/care.js（当日条数上限），这里只负责"怎么发"
//   · 秘钥存 settings.careSms（accessKey/secret/signName/templateCode），不写进代码
//   · 腾讯云同能力但签名协议不同：未实现前如实返回 not_implemented，不降级伪造成功
'use strict';

const crypto = require('crypto');

function cfg() {
  try {
    const store = require('./store');
    const s = store.getSetting('careSms') || {};
    return {
      provider: String(s.provider || '').toLowerCase(),
      accessKey: String(s.accessKey || ''),
      secret: String(s.secret || ''),
      signName: String(s.signName || ''),
      templateCode: String(s.templateCode || ''),
    };
  } catch (e) { return {}; }
}

function configured() {
  const c = cfg();
  return !!(c.provider === 'aliyun' && c.accessKey && c.secret && c.signName && c.templateCode);
}

// 阿里云 RPC 签名（云短信 Dysmsapi 2017-05-26）
function encodeRFC3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}
function aliyunSign(params, secret) {
  const sorted = Object.keys(params).sort();
  const canon = sorted.map(k => encodeRFC3986(k) + '=' + encodeRFC3986(String(params[k]))).join('&');
  const stringToSign = 'GET&%2F&' + encodeRFC3986(canon);
  return crypto.createHmac('sha1', secret + '&').update(stringToSign, 'utf8').digest('base64');
}

/**
 * 发送短信（fire & forget 语义：调用方 await 也要能接受失败）
 * @param {string} phone 11 位手机号
 * @param {object} vars 模板变量 { elder, sev, reason }（模板侧自行取舍）
 * @returns {Promise<{ok:boolean, requestId?:string, code?:string, error?:string}>}
 */
async function send(phone, vars) {
  const c = cfg();
  if (!configured()) {
    return { ok: false, code: 'not_configured', error: '短信未配置（settings.careSms）：请填 provider/accessKey/secret/signName/templateCode，当前走人工电话兜底' };
  }
  if (c.provider !== 'aliyun') {
    return { ok: false, code: 'not_implemented', error: '暂只支持阿里云短信；腾讯云通道未实现，不伪造成功' };
  }
  const p = String(phone || '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(p)) return { ok: false, code: 'bad_phone', error: '手机号无效：' + p.slice(0, 3) + '****' };

  const params = {
    AccessKeyId: c.accessKey,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: p,
    RegionId: 'cn-hangzhou',
    SignName: c.signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomBytes(12).toString('hex'),
    SignatureVersion: '1.0',
    TemplateCode: c.templateCode,
    TemplateParam: JSON.stringify({
      elder: String((vars && vars.elder) || '').slice(0, 8),
      sev: String((vars && vars.sev) || '').slice(0, 2),
      reason: String((vars && vars.reason) || '').slice(0, 10),
    }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2017-05-26',
  };
  params.Signature = aliyunSign(params, c.secret);

  const qs = Object.keys(params).map(k => k + '=' + encodeRFC3986(params[k])).join('&');
  try {
    const res = await fetch('https://dysmsapi.aliyuncs.com/?' + qs, {
      method: 'GET', signal: AbortSignal.timeout(10000),
    });
    const t = await res.text();
    let j = null; try { j = JSON.parse(t); } catch (e) {}
    if (j && (j.Code === 'OK' || j.code === 'OK')) return { ok: true, requestId: (j.RequestId || j.requestId || '') };
    return { ok: false, code: (j && (j.Code || j.code)) || 'HTTP_' + res.status, error: t.slice(0, 200) };
  } catch (e) {
    return { ok: false, code: 'network', error: String(e.message || e) };
  }
}

module.exports = { configured, send, cfg };
