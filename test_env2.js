const fs = require('fs');
const path = require('path');
const os = require('os');

function envVal(name) {
  if (process.env[name]) return process.env[name];
  const files = [];
  const rootEnv = path.join(__dirname, '..', '.env');
  console.log('reading:', rootEnv);
  try { 
    const content = fs.readFileSync(rootEnv, 'utf8');
    console.log('file size:', content.length);
    files.push(content); 
  } catch (e) { console.log('err:', e.message); }
  const asar = path.join(process.env.APPDATA || path.join(os.homedir(), '.bingdashan'), 'BingDashanAI', '.env');
  try { files.push(fs.readFileSync(asar, 'utf8')); } catch (e) {}
  for (const txt of files) {
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === name) {
        console.log('matched:', m[0]);
        return m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
  return '';
}

console.log('SMTP_HOST:', envVal('SMTP_HOST'));
console.log('SMTP_PORT:', envVal('SMTP_PORT'));
console.log('SMTP_USER:', envVal('SMTP_USER'));
console.log('SMTP_PASS:', envVal('SMTP_PASS'));
console.log('SMTP_AUTH:', envVal('SMTP_AUTH'));