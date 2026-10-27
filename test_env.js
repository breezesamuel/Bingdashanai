const fs = require('fs');
const path = require('path');
const os = require('os');

function envVal(name) {
  if (process.env[name]) return process.env[name];
  const files = [];
  try { files.push(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')); } catch (e) {}
  const asar = path.join(process.env.APPDATA || path.join(os.homedir(), '.bingdashan'), 'BingDashanAI', '.env');
  try { files.push(fs.readFileSync(asar, 'utf8')); } catch (e) {}
  for (const txt of files) {
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

console.log('SMTP_HOST:', envVal('SMTP_HOST'));
console.log('SMTP_PORT:', envVal('SMTP_PORT'));
console.log('SMTP_USER:', envVal('SMTP_USER'));
console.log('SMTP_PASS:', envVal('SMTP_PASS'));
console.log('SMTP_AUTH:', envVal('SMTP_AUTH'));