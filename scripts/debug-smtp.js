// scripts/debug-smtp.js — 调试 SMTP 通道配置（不回显任何密钥值）
const store = require('../core/store');
const fs = require('fs');
const path = require('path');

function envVal(name) {
  if (process.env[name]) return process.env[name];
  const files = [];
  try { files.push(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')); } catch (e) {}
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

console.log('=== settings() 内容 ===');
const st = settings();
console.log('settings keys:', Object.keys(st).join(', ') || '(empty)');
console.log('outreachEnabled:', st.outreachEnabled);

console.log('');
console.log('=== smtpCfg 逻辑逐行 ===');
const port = Number(s('smtpPort', 465));
const envUser = envVal('MAIL_SENDER') || envVal('SMTP_USER');
const envPass = envVal('MAIL_AUTH') || envVal('SMTP_PASS');
console.log('s("smtpPort",465):', s('smtpPort', 465));
console.log('port:', port);
console.log('envUser:', envUser ? 'SET(len=' + envUser.length + ')' : 'EMPTY');
console.log('envPass:', envPass ? 'SET(len=' + envPass.length + ')' : 'EMPTY');

const host = String(s('smtpHost', 'smtp.qq.com') || envVal('SMTP_HOST') || 'smtp.qq.com');
const user = String(s('smtpUser', '') || envUser);
const pass = String(s('smtpPass', '') || envPass);
const from = String(s('smtpFrom', '') || s('smtpUser', '') || envUser) || undefined;

console.log('host:', host);
console.log('user:', user ? 'SET(len=' + user.length + ')' : 'EMPTY');
console.log('pass:', pass ? 'SET(len=' + pass.length + ')' : 'EMPTY');
console.log('from:', from ? 'SET(len=' + from.length + ')' : 'EMPTY');

console.log('');
console.log('=== transport() 判断 ===');
console.log('c.user && c.pass && c.from =', !!user && !!pass && !!from);

// 直接测试 outreach 的 transport
const ob = require('../core/outreach');
const t = ob.transport();
console.log('');
console.log('outreach.transport():', t ? ('KIND=' + t.kind + ' HOST=' + t.host) : 'NULL');
