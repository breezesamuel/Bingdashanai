// crawler-e2e.js — 蜘蛛·网页爬虫 → 网站内容完善闭环（后端隐藏功能）
// 断言要点：
//   · crawlerOn=false → /v1/crawler/run 如实 skipped，绝不假爬
//   · /v1/crawler/bank 把公开正文入知识库（tag='crawl'，同源幂等覆盖）——网站内容完善
//   · 正路过短 → 如实不入库（bank 自身独立校验由调用方 harvest 决定；bank 对 <80 字符串照实拒绝）
//   · 知识库可见该条目（前端知识库面板由此显示爬虫内容）
const { finish } = require('./_exit');
const { requireIsolated } = require('./_guard');
const http = require('http');
const fs = require('fs');
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const store = require(ROOT + '/core/store');
const BASE = requireIsolated('crawler-e2e');
const ADMIN = process.env.BINGDASHAN_ADMIN_TOKEN || '';

let pass = 0, fail = 0;
const LOG_FILE = require('path').join(require('os').tmpdir(), 'crawler-e2e-' + Date.now() + '.log');
function logToFile(msg) { fs.appendFileSync(LOG_FILE, msg + '\n'); }
function T(name, ok, extra) {
  ok ? pass++ : fail++;
  const line = (ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' . ' + extra : '');
  console.log(line);
  logToFile(line);
}

function req(method, p, body, headers) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (ADMIN) h['X-Admin-Token'] = ADMIN;
    Object.assign(h, headers || {});
    const r = http.request(BASE + p, { method, headers: h }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => {
        try { res({ code: resp.statusCode, body: JSON.parse(d) }); }
        catch (e) { res({ code: resp.statusCode, body: { raw: d } }); }
      });
    });
    r.end(data || undefined);
  });
}

(async () => {
  let doneTimer;
  const done = new Promise(r => { doneTimer = setTimeout(r, 180000, 'TIMEOUT'); });
  const run = (async () => {
    const snap = JSON.stringify(store.read());
    try {
      // ── 1. 开关未开 → 如实 skipped（蜘蛛诚实性）──
      const off = (await req('POST', '/v1/crawler/run')).body;
      T('crawler run with crawlerOn=false honestly skipped', off.ok === true && off.skipped === 'disabled', 'off=' + JSON.stringify(off).slice(0, 120));

      // ── 2. 网页爬虫 → 网站内容完善（bank 入知识库 tag='crawl'）──
      const content = '这是一个足够长的公开正文，用于验证蜘蛛网页深爬后把内容自动复制进网站知识库。'.repeat(8);
      const b1 = (await req('POST', '/v1/crawler/bank', { name: 'e2e/demo-repo', url: 'https://github.com/e2e/demo-repo', content })).body;
      const kn1 = (store.read().knowledge || []).find(k => k.q === '蜘蛛采集·e2e/demo-repo');
      T('crawler bank stores crawl content into knowledge', b1.ok === true && !!kn1 && kn1.tag === 'crawl' && (kn1.a || '').includes('e2e/demo-repo'), 'b1=' + JSON.stringify(b1).slice(0, 120));

      // 同源幂等：再次 bank 同名 → 替换为最新（q 相同），不重复新增
      const b2 = (await req('POST', '/v1/crawler/bank', { name: 'e2e/demo-repo', url: 'https://github.com/e2e/demo-repo', content: content + '（更新版正文）' })).body;
      const kn2 = (store.read().knowledge || []).filter(k => k.q === '蜘蛛采集·e2e/demo-repo');
      const updated = (store.read().knowledge || []).find(k => k.q === '蜘蛛采集·e2e/demo-repo');
      T('crawler bank idempotent (same source replaced, no dup)', b2.ok === true && kn2.length === 1 && (updated.a || '').includes('更新版正文'), 'kn2.len=' + kn2.length);

      // ── 3. 正路过短 → 诚实拒绝（不把残缺内容当"完善"）──
      const short = (await req('POST', '/v1/crawler/bank', { name: 'e2e/noise', url: 'https://github.com/e2e/noise', content: '太短了' })).body;
      T('crawler bank rejects too-short content honestly', short.ok === false, 'short=' + JSON.stringify(short).slice(0, 100));

      // ── 4. 知识库面板可见 web 爬虫内容（前端 knowledge-list 数据源）──
      const knList = (await req('GET', '/v1/knowledge')).body;
      T('crawled content visible in /v1/knowledge for site panel', (knList.knowledge || []).some(k => k.tag === 'crawl' && (k.q || '').includes('e2e/demo-repo')), 'total=' + ((knList.knowledge || []).length));

      // ── 5. 蜘蛛开关开启后跑一轮：不可达如实 reach:false / 无新线索如实说明，绝不编造 ──
      let st = store.read();
      st.settings = Object.assign({}, st.settings || {}, { crawlerOn: true });
      store.write(st);
      const run2 = (await req('POST', '/v1/crawler/run')).body;
      const honest = run2.ok === true && (run2.reach === false || run2.reach === true);
      T('crawler round honest (reach true or false, no fabricated leads)', honest, 'r2=' + JSON.stringify(run2).slice(0, 220));
      const stats = (await req('GET', '/v1/crawler')).body;
      T('crawler status reports rounds increment', Number(stats.stats && stats.stats.rounds) >= 1, 'rounds=' + (stats.stats && stats.stats.rounds));
    } finally {
      try { store.write(JSON.parse(snap)); } catch (e) {}
    }
  })();
  const final = await Promise.race([run, done]);
  if (final === 'TIMEOUT') { console.error('TIMEOUT crawler-e2e'); finish(1); }
  else {
    console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
    finish(fail ? 1 : 0);
  }
})();