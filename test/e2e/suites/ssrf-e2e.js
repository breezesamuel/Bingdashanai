// test/e2e/suites/ssrf-e2e.js — SSRF 与抓取降级回归
// 覆盖 webfetch / firecrawl 两条路径：必须拒绝内网地址，且降级时不抛异常。
const http = require('http');

const { requireIsolated } = require('./_guard');
const BASE = requireIsolated('ssrf-e2e');
const ROOT = 'C:/Users/Think/project/BingDashan';
const { finish } = require('./_exit');
const webfetch = require(ROOT + '/core/webfetch');
const firecrawl = require(ROOT + '/core/firecrawl');

let pass = 0, fail = 0;
const failures = [];
function T(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? ' . ' + detail : '')); }
  else { fail++; failures.push(name); console.log('FAIL ' + name + (detail ? ' . ' + detail : '')); }
}

function P(base, path, method, body) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { 'Content-Type': 'application/json' };
    if (data) h['Content-Length'] = data.length;
    const u = new URL(base + path);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET', headers: h }, resp => {
      let s = ''; resp.on('data', d => s += d);
      resp.on('end', () => {
        let j = null;
        try { j = JSON.parse(s); } catch (e) { /* 保留 _raw */ }
        res({ status: resp.statusCode, ok: resp.statusCode >= 200 && resp.statusCode < 300, body: j, _raw: s.slice(0, 200) });
      });
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  let doneTimer;
  const done = new Promise(r => { doneTimer = setTimeout(r, 90000, 'TIMEOUT'); });
  const run = (async () => {
    // 1. validateUrl 必须拒绝内网/环回/链路本地/元数据地址
    const BAD = [
      'http://127.0.0.1:3721/',
      'http://localhost:3000/',
      'http://169.254.169.254/latest/meta-data/',   // 云元数据
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://172.31.255.1/',
      'http://[::1]:8080/',
      'http://100.64.0.1/',
      'http://foo.local/',
      'file:///etc/passwd',
      'gopher://x',
      'not a url'
    ];
    let blocked = 0;
    for (const u of BAD) if (webfetch.validateUrl(u)) blocked++;
    T('validateUrl rejects all internal/loopback/link-local targets', blocked === BAD.length, blocked + '/' + BAD.length);

    // 2. 172.32 不在私有段内，不应被误杀
    T('does not over-block public 172.x', !webfetch.validateUrl('http://172.32.0.1/'), '172.32 is public');
    T('does not over-block normal public url', !webfetch.validateUrl('https://example.com/'), 'https ok');

    // 3. fetchPage 拒绝后不抛异常，且不发起请求
    const r = await webfetch.fetchPage('http://169.254.169.254/latest/meta-data/');
    T('fetchPage refuses metadata IP', r.ok === false && /拒绝/.test(r.note || ''), r.note);

    // 4. firecrawl 同样拒绝
    const f = await firecrawl.scrape('http://127.0.0.1:3721/');
    T('firecrawl refuses loopback', f.ok === false && /拒绝|非法/.test(f.note || ''), f.note);

    // 5. 降级不抛异常
    let threw = false;
    try { await webfetch.fetchPage('http://198.51.100.1/', { backend: 'lightpanda' }); }
    catch (e) { threw = true; }
    T('unreachable + lightpanda degrades without throwing', !threw);

    // 6. HTTP 层：内网地址必须在入口被 400 拒绝，不能只靠下游 ok:false
    const p1 = await P(BASE, '/v1/intel/page?url=' + encodeURIComponent('http://169.254.169.254/'));
    T('GET /v1/intel/page rejects metadata IP with 400', p1.status === 400, 'HTTP ' + p1.status + ' ' + String(p1.body && p1.body.error).slice(0, 50));

    const p2 = await P(BASE, '/v1/intel/research?url=' + encodeURIComponent('http://127.0.0.1:3721/'));
    T('GET /v1/intel/research rejects loopback with 400', p2.status === 400, 'HTTP ' + p2.status + ' ' + String(p2.body && p2.body.error).slice(0, 50));

    // 7. 状态端点可用
    const s1 = await P(BASE, '/v1/intel/browse');
    T('GET /v1/intel/browse reports backend', s1.ok && !!s1.body.backend, 'backend=' + (s1.body && s1.body.backend));
    const s2 = await P(BASE, '/v1/intel/research/status');
    T('GET /v1/intel/research/status reports key state', s2.ok && typeof s2.body.hasKey === 'boolean', 'hasKey=' + (s2.body && s2.body.hasKey));

    // 8. 定价信号抽取：全局正则不得因 lastIndex 漏匹配
    const md = ['- 每月 A', '- B 每月', '- C / 3个月', '- D / 年'].join('\n');
    const ps = firecrawl.pricingSignals(md);
    T('pricing periods capture both numeric and word forms', ps.periods.length >= 3, ps.periods.join('|'));
  })();
  const r = await Promise.race([run, done]);
  clearTimeout(doneTimer);   // race 一结束就释放，否则进程要干等到超时点才退
  if (r === 'TIMEOUT') { fail++; failures.push('TIMEOUT'); console.log('TIMEOUT'); }
  console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  if (fail) { console.error('FAILED: ' + failures.join(', ')); process.exit(1); }
})();
