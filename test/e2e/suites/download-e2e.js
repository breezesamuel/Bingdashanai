// test/e2e/suites/download-e2e.js — 客户自助下载（下载页 / 发布清单 / 安装包响应头）端到端
//
// 守护的纪律（每条都对应一个真会砸招牌的缺口）：
//   1. 清单里的 SHA256 / 大小必须和磁盘上的**同一份文件**对得上（防"改了包忘了更新清单"）；
//   2. 声明 published:true 就必须真有东西可下——绝不放会 404 的假下载按钮；
//   3. 没产出的平台必须照实写原因（macOS 需 Mac、iOS 需 Xcode、鸿蒙需 DevEco…）；
//   4. 安装包必须 Content-Disposition: attachment + 二进制 MIME（否则被当文本内联打开）；
//   5. Service Worker 不许缓存 /releases.json 与 /downloads/*（否则用户永远看到旧版本）。
const ROOT = process.env.BINGDASHAN_E2E_ROOT || 'C:/Users/Think/project/BingDashan';
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { requireIsolated } = require('./_guard');
const BASE = requireIsolated('download-e2e');

const DL_DIR = ROOT + '/web/downloads';
const MAN_PATH = ROOT + '/web/releases.json';
let pass = 0, fail = 0;

function T(name, cond, detail) {
  pass += cond ? 1 : 0;
  fail += cond ? 0 : 1;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' . ' + detail : ''));
}

// get(p, headers?) — headers 必须透传：Range 断点续传用例靠它触发 206/416。
// 【踩过的坑】原来只收 p，调用方传的 { Range } 被静默丢弃，服务器见不到 Range 头
// 就按"无 Range"回 200 整段——4 条 Range 断言全红，却不是服务器的错。
function get(p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + p, { headers: headers || {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout ' + p)));
  });
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

(async () => {
  const pkg = JSON.parse(fs.readFileSync(ROOT + '/package.json', 'utf8'));

  // ── 1) 下载页与激活页确实被服务出来，且指向真实接口 ──
  const dl = await get('/download.html');
  T('/download.html 200', dl.code === 200, 'code=' + dl.code);
  T('/download.html 是 HTML', /text\/html/.test(String(dl.headers['content-type'] || '')), String(dl.headers['content-type']));
  const html = dl.buf.toString('utf8');
  T('下载页从 /releases.json 取数据（非硬编码链接）', html.includes('/releases.json'));
  T('下载页链到激活页', html.includes('/activate.html'));
  T('下载页提示核对 SHA256', html.includes('SHA256'));
  T('下载页含移动端 PWA 安装说明', html.includes('添加到主屏幕'));

  const ac = await get('/activate.html');
  T('/activate.html 200', ac.code === 200, 'code=' + ac.code);
  const ahtml = ac.buf.toString('utf8');
  T('激活页调用 /v1/license/status', ahtml.includes('/v1/license/status'));
  T('激活页调用 /v1/license/activate', ahtml.includes('/v1/license/activate'));
  T('激活页调用 /v1/license/deactivate', ahtml.includes('/v1/license/deactivate'));

  // ── 2) 发布清单：能被服务、能解析、版本一致 ──
  const manRes = await get('/releases.json');
  T('/releases.json 200', manRes.code === 200, 'code=' + manRes.code);
  T('/releases.json 是 JSON 类型', /application\/json/.test(String(manRes.headers['content-type'] || '')), String(manRes.headers['content-type']));
  let MAN = null;
  try { MAN = JSON.parse(manRes.buf.toString('utf8')); } catch (e) {}
  T('/releases.json 可解析', !!MAN, MAN ? '' : manRes.buf.toString('utf8').slice(0, 80));
  T('清单版本与 package.json 一致', !!MAN && MAN.version === pkg.version, MAN ? MAN.version : '');
  T('清单含 generatedAt', !!(MAN && MAN.generatedAt));
  T('清单 artifacts 是数组', !!(MAN && Array.isArray(MAN.artifacts)));

  const arts = (MAN && MAN.artifacts) || [];
  let fieldsOk = true, pubConsistent = true;
  const byPlat = {};
  for (const a of arts) {
    byPlat[a.platform] = true;
    if (!/^[0-9a-f]{64}$/.test(String(a.sha256 || ''))) { fieldsOk = false; console.log('   坏 sha256: ' + JSON.stringify(a)); }
    if (!(a.size > 0) || !a.file || !a.platform || !a.label) { fieldsOk = false; console.log('   缺字段: ' + JSON.stringify(a)); }
    if (!!a.published !== !!a.url) { pubConsistent = false; console.log('   published/url 不一致: ' + JSON.stringify(a)); }
  }
  T('每条产物字段完整（含 64 位 hex SHA256）', fieldsOk, arts.length + ' 条');
  T('published 与 url 严格一致（不存在"假已发布"）', pubConsistent);

  // ── 3) 反"死链"：published 的 /downloads/ 地址，磁盘上必须有同名文件，且大小/SHA256 一致 ──
  for (const a of arts) {
    if (!a.published || !String(a.url || '').startsWith('/downloads/')) continue;
    const file = DL_DIR + '/' + decodeURIComponent(String(a.url).slice('/downloads/'.length));
    T('产物文件存在: ' + a.file, fs.existsSync(file), file);
    if (!fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    T('产物大小与清单一致: ' + a.file, buf.length === a.size, buf.length + ' vs ' + a.size);
    T('产物 SHA256 与清单一致: ' + a.file, sha256(buf) === a.sha256, sha256(buf).slice(0, 16) + ' vs ' + String(a.sha256).slice(0, 16));
  }
  if (!arts.some(a => a.published)) {
    console.log('   （注：当前清单没有任何可下载产物——下载页会引导用户走 PWA，这是允许的诚实状态）');
  }

  // ── 3) 未产出平台必须照实写原因（不能糊弄成"敬请期待"）──
  const unav = (MAN && MAN.unavailable) || [];
  const need = ['macos', 'linux', 'android', 'ios', 'harmonyos'];
  const badReasons = need.filter(p => !byPlat[p] && !unav.some(u => u.platform === p && String(u.reason || '').length > 8));
  T('未产出平台都已写明原因', badReasons.length === 0, badReasons.join(',') || 'ok');

  // ── 4) 安装包响应头：用小探针验证 attachment + 二进制 MIME（不真拉 87MB）──
  try { fs.mkdirSync(DL_DIR, { recursive: true }); } catch (e) {}
  const probe = DL_DIR + '/__e2e_probe.zip';
  const probeBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('e2e-probe-' + Date.now(), 'utf8')]);
  fs.writeFileSync(probe, probeBytes);
  try {
    const r = await get('/downloads/__e2e_probe.zip');
    T('下载路径可访问', r.code === 200, 'code=' + r.code);
    T('安装包强制下载（Content-Disposition: attachment）', /attachment/i.test(String(r.headers['content-disposition'] || '')), String(r.headers['content-disposition']));
    // 详情串必须报 r 的类型；原来误报 manRes（releases.json 的 application/json），
    // 断言明明 PASS 却打出"application/json"，排查时被当成服务器回错类型。
    T('.zip 给的是二进制类型而非 text/html', /application\/zip/.test(String(r.headers['content-type'] || '')), String(r.headers['content-type']));
    T('响应字节与磁盘一致', r.buf.equals(probeBytes), r.buf.length + 'B');

    // ── 下载体验三件套（缺一个，用户在 80MB 安装包上就会遇到"看起来卡住了"）──
    //  · Content-Length：没有它，浏览器不显示进度条/剩余时间；
    //  · Accept-Ranges + Range 处理：断线后能续传，不必从头再来；
    //  · HEAD：下载管理器先用 HEAD 探大小，404 会被当成"文件不存在"而放弃。
    T('响应带 Content-Length（否则没有下载进度）', String(r.headers['content-length']) === String(probeBytes.length), String(r.headers['content-length']) + ' vs ' + probeBytes.length);
    T('声明支持 Range（Accept-Ranges: bytes）', String(r.headers['accept-ranges']) === 'bytes', String(r.headers['accept-ranges']));
    const rg = await get('/downloads/__e2e_probe.zip', { Range: 'bytes=2-5' });
    T('单段 Range 返回 206', rg.code === 206, 'code=' + rg.code);
    T('Range 只回请求的字节', rg.buf.length === 4 && rg.buf.equals(probeBytes.subarray(2, 6)), rg.buf.length + 'B');
    T('Range 带 Content-Range', /^bytes 2-5\/\d+$/.test(String(rg.headers['content-range'] || '')), String(rg.headers['content-range']));
    const over = await get('/downloads/__e2e_probe.zip', { Range: 'bytes=99999-' });
    T('越界 Range 返回 416 + bytes */size', over.code === 416 && String(over.headers['content-range']) === 'bytes */' + probeBytes.length, 'code=' + over.code + ' cr=' + over.headers['content-range']);
    const hd = await new Promise((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port: new URL(BASE).port, path: '/downloads/__e2e_probe.zip', method: 'HEAD' }, s => {
        const buf = []; s.on('data', c => buf.push(c));
        s.on('end', () => resolve({ code: s.statusCode, headers: s.headers, buf: Buffer.concat(buf) }));
      });
      q.on('error', reject); q.setTimeout(10000, () => q.destroy(new Error('timeout'))); q.end();
    });
    T('HEAD 探到大小（下载管理器会先问）', hd.code === 200 && String(hd.headers['content-length']) === String(probeBytes.length), 'code=' + hd.code + ' len=' + hd.headers['content-length']);
    T('HEAD 不返回 body', hd.buf.length === 0, hd.buf.length + 'B');
  } finally {
    try { fs.unlinkSync(probe); } catch (e) {}
  }

  // ── 4) Service Worker 不得缓存发布清单 / 安装包 ──
  const sw = (await get('/sw.js')).buf.toString('utf8');
  T('sw.js 不缓存 /releases.json', sw.includes("'/releases.json'"));
  T('sw.js 不缓存 /downloads/', sw.includes("'/downloads/'"));

  // ── 5) 商务闭环引用的 skill 必须真的读得到 ──
  // 【防的是本轮实录】package.json 的 build.files 有 `"!**/*.md"`，而运行时读的正是
  // skills/agent-skills/<name>/SKILL.md → 装到用户机器上的包里一个 skill 都没有，
  // GET /v1/commercial-loop/skills 永远返回 []，“已装载 29 个方法论包”成了空话。
  const loop = require(ROOT + '/core/commercial-loop');
  const loaded = loop.listSkills();
  T('商务闭环装载的 skill 非空', loaded.length >= 20, loaded.length + ' 个');
  const referenced = Array.from(new Set((loop.STAGES || []).reduce((acc, s) => acc.concat(s.skills || []), [])));
  const notFound = referenced.filter(n => !loaded.some(s => s.name === n));
  T('STAGES 引用的 skill 全部存在', notFound.length === 0, '引用 ' + referenced.length + ' 个' + (notFound.length ? ('，找不到: ' + notFound.join(',')) : ''));

  // ── 6) 清单文件本身在仓库里（部署站点直接用它）──
  T('web/releases.json 存在于仓库', fs.existsSync(MAN_PATH));

  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('套件异常: ' + (e && e.stack || e)); process.exit(2); });
