// 端到端 HTTP 自检（带稳定访客身份，验证免费额度真实累加）
const http = require('http');
const subs = require('./core/subs');
const VID = subs.issue('test-http-visitor').vid;   // 稳定且可通过 HMAC 校验的访客身份

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({ 'X-Visitor': VID }, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 3721, path, method, headers: h }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, raw: d.slice(0, 200) }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { try { const s = await req('GET', '/v1/status'); up = s.status === 200; } catch (e) {} if (!up) await sleep(500); }
  console.log('server up:', up, '| visitor:', VID.slice(0, 30) + '...');
  if (!up) process.exit(1);

  console.log('\n=== 免费优先聊天（连发 2 次，验证额度真实累加）===');
  for (let i = 1; i <= 2; i++) {
    const c = await req('POST', '/v1/chat', { text: '第 ' + i + ' 次：请回答我的问题', free: true });
    console.log('#' + i, '| ok', c.json && c.json.ok, '| provider', c.json && c.json.provider, '| free', c.json && c.json.free, '| engine', c.json && c.json.engine);
    if (c.json && c.json.reply) console.log('   reply:', c.json.reply.slice(0, 70).replace(/\n/g, ' '));
    else console.log('   err:', JSON.stringify(c.json || c.raw).slice(0, 160));
  }

  const ft = await req('GET', '/v1/free-tier');
  console.log('\n免费额度台账:', JSON.stringify(ft.json.grant), '| 可用通道', ft.json.usableProviders, '/', ft.json.totalProviders, '| 模型', ft.json.totalModels);

  const cov = await req('GET', '/v1/paywall');
  const c = cov.json.coverage;
  console.log('\n收费墙覆盖率: total', c.total, '| covered', c.covered, '| rate', c.rate + '%', '| uncovered', c.uncoveredCount);
  if (c.uncovered.length) console.log('  uncovered:', c.uncovered.slice(0, 12).join(', '));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
