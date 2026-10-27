// core/mailer.js — 零依赖 SMTP 客户端（纯 Node：tls + net），用于 24h 监控告警邮件。
// 服务：smtp.qq.com:465（TLS），AUTH LOGIN，支持收件人/主题/正文（自动 UTF-8 Base64）。
// 不落地依赖：失败静默降级 + 审计留痕，绝不抛到调用链。

const tls = require('tls');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('./store');

// 邮箱授权码只从环境变量 / .env 读取（MAIL_SENDER / MAIL_AUTH）。
// 红线：源码与二进制内绝不保留任何真实授权码——曾经内置过演示值，等于把密钥发进了安装包。
// 未配置时 send() 明确失败并留痕，绝不静默降级、也绝不"假装发过"。
//
// 【2026-10-21 凭据兜底】原先只认 MAIL_SENDER/MAIL_AUTH，而 .env 里实际写的是
// SMTP_USER/SMTP_PASS/SMTP_FROM（部署脚本注入的那套）→ 邮件**全部**因"未配置"失败
// （收据/续费提醒都发不出去）。现在两套命名都认，SMTP_* 优先。
const IN_ASAR = __dirname.includes('app.asar');
const ENV_CANDIDATES = [
  path.join(__dirname, '..', '.env'),
  IN_ASAR ? path.join(process.env.APPDATA || path.join(os.homedir(), '.bingdashan'), 'BingDashanAI', '.env') : null
].filter(Boolean);
function envVal(name) {
  if (process.env[name]) return process.env[name];
  for (const p of ENV_CANDIDATES) {
    try {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
      }
    } catch (e) {}
  }
  return '';
}
function envFirst(names) {
  for (const n of names) { const v = envVal(n); if (v) return v; }
  return '';
}

const HOST = envFirst(['MAIL_HOST', 'SMTP_HOST']) || 'smtp.qq.com';
const PORT = Number(envFirst(['MAIL_PORT', 'SMTP_PORT'])) || 465;
const SENDER = envFirst(['MAIL_SENDER', 'SMTP_USER', 'SMTP_FROM']);
const AUTH_CODE = envFirst(['MAIL_AUTH', 'SMTP_PASS', 'SMTP_AUTH']);
const CONFIGURED = !!(SENDER && AUTH_CODE);

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
function headersFor(to, subject, html) {
  return 'From: =?UTF-8?B?' + b64('BingDashan Monitor') + '?= <' + SENDER + '>\r\n' +
    'To: <' + to + '>\r\n' +
    'Subject: =?UTF-8?B?' + b64(subject) + '?=\r\n' +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: text/html; charset=UTF-8\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    Buffer.from(html, 'utf8').toString('base64');
}

// smtp send promise：逐步握手，带超时保护
function smtpSend(to, subject, html) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: HOST, port: PORT }, () => {
      buf = '';
      sock.write('EHLO bingdashan.local\r\n');
    });
    let buf = '';
    let step = 0;
    const timeout = setTimeout(() => { try { sock.destroy(); } catch (e) {} reject(new Error('SMTP timeout')); }, 15000);
    sock.setEncoding('utf8');
    sock.on('data', d => {
      buf += d;
      // 多行应答以最后一行的状态码为准
      const lines = buf.split(/[\r\n]+/).filter(Boolean);
      const last = lines[lines.length - 1];
      const code = parseInt(last, 10);
      if (isNaN(code)) return;
      // 只有以空格结尾的行才是最终应答（4xx/5xx 仍以码判断）
      if (!/[0-9]{3}-/.test(last)) {
        if (code >= 500) { clearTimeout(timeout); try { sock.end(); } catch (e) {} reject(new Error('SMTP ' + code + ' ' + last)); return; }
        if (code >= 400) { clearTimeout(timeout); try { sock.end(); } catch (e) {} reject(new Error('SMTP 4xx ' + last)); return; }
        if (step === 0 && code === 250) { step = 1; sock.write('AUTH LOGIN\r\n'); buf = ''; }
        else if (step === 1 && code === 334) { step = 2; sock.write(b64(SENDER) + '\r\n'); buf = ''; }
        else if (step === 2 && code === 334) { step = 3; sock.write(b64(AUTH_CODE) + '\r\n'); buf = ''; }
        else if (step === 3 && code === 235) { step = 4; sock.write('MAIL FROM:<' + SENDER + '>\r\n'); buf = ''; }
        else if (step === 4 && code === 250) { step = 5; sock.write('RCPT TO:<' + to + '>\r\n'); buf = ''; }
        else if (step === 5 && code === 250) { step = 6; sock.write('DATA\r\n'); buf = ''; }
        else if (step === 6 && code === 354) { step = 7; sock.write(headersFor(to, subject, html) + '\r\n.\r\n'); buf = ''; }
        else if (step === 7 && code === 250) { step = 8; sock.write('QUIT\r\n'); buf = ''; }
        else if (step === 8 && code === 221) { clearTimeout(timeout); try { sock.end(); } catch (e) {} resolve({ ok: true, code }); }
        else if (code >= 400) { clearTimeout(timeout); try { sock.end(); } catch (e) {} reject(new Error('SMTP step' + step + ' ' + last)); }
      }
    });
    sock.on('error', e => { clearTimeout(timeout); reject(e); });
    sock.on('close', () => { clearTimeout(timeout); });
  });
}

// send：对外主入口。成功→审计留痕；失败→静默记录（监控告警不能因邮件失败而崩溃）
// 未配置授权码时：明确返回失败原因并留痕，不假装已发送。
// 【2026-10-21 韧性】原来**只试一次**、15 秒超时 → 一次瞬时抖动就让收据/续费提醒永久丢失
// （收据是客户唯一凭证、提醒是复购收入）。现在失败会**再试一次**（间隔 3s），
// 并把最终结果如实留痕。
function send(to, subject, html, opts) {
  const email = String(to || '').trim();
  if (!email) return Promise.resolve({ ok: false, error: '收件人必填' });
  // 【2026-10-21 离线开关】MAIL_DISABLE=1 → 不连网、不假装发过（测试与"临时停发信"用）
  if (envFirst(['MAIL_DISABLE', 'BD_MAIL_DISABLE']) === '1') {
    const err = '邮件发送已禁用（MAIL_DISABLE=1）';
    store.push('mail', { to: email, subject: String(subject || '').slice(0, 100), ok: false, error: err, at: Date.now() }, '邮件禁用', email);
    return Promise.resolve({ ok: false, error: err });
  }
  if (!CONFIGURED) {
    const err = '邮件未配置：请在 .env 设置 MAIL_SENDER 与 MAIL_AUTH（授权码），或用系统设置页填写。';
    store.push('mail', { to: email, subject: String(subject || '').slice(0, 100), ok: false, error: err, at: Date.now() }, '邮件未配置', email);
    return Promise.resolve({ ok: false, error: err });
  }
  const attempts = Math.max(1, Number((opts && opts.attempts) || 2));
  const tryOnce = (n) => smtpSend(email, String(subject || '监测告警').slice(0, 100), String(html || '')).then(r => ({ r, n }));
  const loop = (n) => tryOnce(n).then(({ r, n: used }) => {
    if (r && r.ok) return r;
    if (used < attempts) return new Promise((res) => setTimeout(res, 3000)).then(() => loop(used + 1));
    throw new Error((r && r.error) || 'unknown');
  });
  return loop(1).then(r => {
    store.push('mail', { to: email, subject: String(subject || '').slice(0, 100), ok: true, at: Date.now() }, '邮件发送', email + ' ' + String(subject || '').slice(0, 40));
    return r;
  }).catch(e => {
    store.push('mail', { to: email, subject: String(subject || '').slice(0, 100), ok: false, error: String(e.message || e).slice(0, 200), at: Date.now() }, '邮件失败', email + ' ' + String(e.message || '').slice(0, 40));
    return { ok: false, error: String(e.message || e) };
  });
}

// 最近 N 条外发记录（监控/战情室展示）
function log(n) {
  return store.list('mail', n || 20);
}

module.exports = { send, log, smtpSend, SENDER, HOST, PORT, CONFIGURED };