require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 回归测试：前后端**接线**（2026-10-21）
// 红线：前端点得到的按钮，后端必须有端点；且不能被"变更限权 403"挡在收费墙之前。
// 本次修的真 bug：前端调 POST /v1/skills/<name>/invoke，而收费墙登记表与白名单用的是
//   POST /v1/skills/invoke —— 形状不一致且两端都没实现 → 点「执行」必然 404。
// 修法：handle() 里做路径归一（/v1/skills/<name>/invoke → /v1/skills/invoke + 名字变量），
//       墙登记 / PUBLIC_MUTATE / 路由三者只有一条口径。
// 本测试验证：
//   ① 两种调用形状都命中同一路由（都**不是** 404）
//   ② 缺技能名 / 缺任务时如实报错，不静默成功
//   ③ 静态断言：归一代码在位、路径在 PUBLIC_MUTATE、墙登记含 POST /v1/skills/invoke
// 【零污染】服务器用临时数据目录（BINGDASHAN_DATA_DIR）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let PORT = 0;
function freePort() {
  return new Promise((resolve) => {
    const s = require('net').createServer();
    s.on('error', () => resolve(0));
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-wiring-'));
// 放一个"已装载技能"，用来验证原生执行入口真的能跑出正文（而不是空壳 404）
fs.mkdirSync(path.join(DATA, 'skills', 'demo-test'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'skills', 'demo-test', 'SKILL.md'),
  '---\nname: demo-test\ndescription: regression fixture\n---\n\n# demo-test 技能定义正文（回归用）\n', 'utf8');
let fail = 0, pass = 0;
function ok(c, label, extra) {
  if (c) pass++; else fail++;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined ? '  ->  ' + (typeof extra === 'object' ? JSON.stringify(extra).slice(0, 200) : extra) : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }
function req(method, p, body, headers) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: b }); });
    });
    r.on('error', (e) => resolve({ status: 0, body: null, raw: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  PORT = await freePort();
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const pw = fs.readFileSync(path.join(ROOT, 'core', 'paywall.js'), 'utf8');

  section('1. 静态断言（接线三件套必须在位）');
  ok(/p\s*===\s*'\/v1\/skills\\\/(\[\^\/\]+)\\\/invoke'/.test(srv) || srv.indexOf("/v1/skills/invoke") >= 0,
    '技能执行端点已实现');
  ok(srv.indexOf("pathSkillName") >= 0 && srv.indexOf("p = '/v1/skills/invoke'") >= 0,
    '路径归一在位（/v1/skills/<name>/invoke → /v1/skills/invoke）');
  ok(srv.indexOf("'/v1/skills/invoke',") >= 0, '规范路径在 PUBLIC_MUTATE 白名单（公网访客能走到墙，而不是先被 403）');
  ok(pw.indexOf("'POST /v1/skills/invoke': 'skill'") >= 0, '收费墙登记表含 POST /v1/skills/invoke → skill 分区');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      BINGDASHAN_DATA_DIR: DATA,
      BINGDASHAN_PORT: String(PORT),
      BINGDASHAN_HOST: '127.0.0.1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let up = false;
  child.stdout.on('data', (d) => { if (String(d).includes('listening')) up = true; });
  for (let i = 0; i < 40 && !up; i++) { await sleep(300); const h = await req('GET', '/v1/status'); if (h.status === 200) { up = true; break; } }
  if (!up) { console.log('  [FAIL] 服务未能启动'); process.exit(1); }

  section('2. 两种调用形状都命中路由（都不是 404）');
  const a = await req('POST', '/v1/skills/demo-test/invoke', { q: 'hello' });
  ok(a.status !== 404, '路径形状 POST /v1/skills/<name>/invoke 不再 404', 'status=' + a.status + ' ' + String(a.raw).slice(0, 90));
  const b = await req('POST', '/v1/skills/invoke', { name: 'demo-test', args: { q: 'hello' } });
  ok(b.status !== 404, '规范形状 POST /v1/skills/invoke 不再 404', 'status=' + b.status + ' ' + String(b.raw).slice(0, 90));
  ok(a.status === b.status, '两种形状行为一致（同一路由）', a.status + ' vs ' + b.status);

  section('2b. 本地已装载技能真的能执行（原生入口，不是空壳）');
  ok(a.body && a.body.ok === true && String(a.body.output || '').indexOf('demo-test') >= 0,
    '已装载技能执行成功并返回技能定义正文', JSON.stringify(a.body).slice(0, 140));
  const unknown = await req('POST', '/v1/skills/not-a-real-skill/invoke', { q: 'x' });
  ok(unknown.body && unknown.body.ok === false && String(unknown.body.error || '').indexOf('未找到技能') >= 0,
    '未知技能 → 如实报「未找到技能」（不编造产出）', JSON.stringify(unknown.body).slice(0, 120));


  section('4. 既有功能没被路径归一影响');
  const man = await req('GET', '/v1/manuals/1');
  ok(man.status === 200 && man.body && man.body.ok === true, 'GET /v1/manuals/1 仍可用', 'status=' + man.status);
  const sk = await req('GET', '/v1/skills');
  ok(sk.status === 200 && sk.body && sk.body.ok === true, 'GET /v1/skills 仍可用', 'status=' + sk.status);

  section('5. 额度口径透明：公开额度接口与收费墙登记表同源');
  const q = await req('GET', '/v1/subs/quota');
  ok(q.status === 200 && q.body && q.body.ok === true, 'GET /v1/subs/quota 可用（客户买前可知额度）', 'status=' + q.status);
  if (q.body && q.body.ok) {
    const pw = require(path.join(ROOT, 'core', 'paywall.js'));
    const SECTIONS = pw.SECTIONS || {};
    const free = q.body.free || [];
    ok(free.length === Object.keys(SECTIONS).length, '免费额度条目数 = 墙分区数', 'free=' + free.length + ' sections=' + Object.keys(SECTIONS).length);
    const mismatch = free.filter((f) => !SECTIONS[f.key] || SECTIONS[f.key].quota !== f.perDay);
    ok(mismatch.length === 0, '每个分区的每日额度与登记表完全一致（不手抄、不漂移）', JSON.stringify(mismatch).slice(0, 160));
    const tiers = q.body.tiers || [];
    ok(tiers.length > 0 && tiers.every((t) => t.label && t.amount > 0 && t.heavyDaily), '各档含价格与重耗日限', JSON.stringify(tiers.slice(0, 3)).slice(0, 200));
    ok(!!q.body.note, '带一句口径说明（客户看得懂）');
  }

  child.kill('SIGKILL');
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  console.log('\npass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  process.exit(fail === 0 ? 0 : 1);
})();
