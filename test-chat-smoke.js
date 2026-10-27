const http = require('http');

function chat(msg, history = []) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ text: msg, history, mode: 'text', depth: false });
    const req = http.request({
      hostname: '127.0.0.1', port: 3721, path: '/v1/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, data: d })); });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function run() {
  const h = [];
  for (let i = 1; i <= 10; i++) {
    const r = await chat('第 ' + i + ' 轮：请简短回复"收到"', h);
    console.log('Round', i, 'Status:', r.status, 'Len:', r.data.length);
    if (r.status !== 200) { console.log('ERROR:', r.data); break; }
    try { const j = JSON.parse(r.data); console.log('  Reply:', (j.reply || j.content || '').slice(0, 80)); h.push({ role: 'user', content: '第 ' + i + ' 轮' }); h.push({ role: 'assistant', content: j.reply || j.content || '' }); } catch (e) {}
  }
}
run().catch(console.error);