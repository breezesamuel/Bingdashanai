require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// 回归测试：订阅墙「零操作」闭环（2026-10-21）
// 红线：客户扫码付款后 —— 全程不切回浏览器手动刷新、不点任何按钮、不等人工核账。
// 本测试两层验证：
//   A. 服务端（真实 HTTP）：付款信号落地后，前端轮询依赖的两个探测接口都能翻转：
//        GET /v1/pay/status?order=…… → paid:true      （付款弹窗轮询的解锁信号①）
//        GET /v1/subs/status          → unlimited/sub  （墙哨兵 / 订阅面板的解锁信号②）
//   B. 前端（源码静态断言）：biz.js 的四个零操作机制全部在位：
//        ① _startPayPoll：5s×240 → 降级 30s 慢轮询，永不彻底停
//        ② 墙上的解锁哨兵 _startUnlockWatch（showWall 启动 / hideWall 停止）
//        ③ refreshSubs 巡检自动撤墙（已开通而墙还挂着）
//        ④ visibilitychange「切回页面即探」
// 【零污染】服务器用临时数据目录（BINGDASHAN_DATA_DIR），不碰线上 data/db.json。
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-zero-touch-'));
const NOTIFY_KEY = 'test-notify-key-' + process.pid;

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

// ---------------- B. 前端源码静态断言（在服务器启动前先跑，失败也不影响后面） ----------------
section('前端零操作机制（web/biz.js 静态断言）');
{
  const biz = fs.readFileSync(path.join(ROOT, 'web', 'biz.js'), 'utf8');

  ok(biz.indexOf('function _startPayPoll') >= 0, '①支付轮询已封装 _startPayPoll');
  ok(biz.indexOf('ms = 30000') >= 0 && biz.indexOf('>= 240') >= 0, '①快轮询 240 次后降级为 30s 慢轮询（不再彻底停）');
  ok(biz.indexOf('++_payTicks > 240') < 0, '①旧版「240 次即永久停轮询」已移除');
  ok(biz.indexOf('unlimited || sd.sub') >= 0, '①轮询双信号：探测订阅状态兜底');
  ok(biz.indexOf('function _startUnlockWatch') >= 0, '②解锁哨兵 _startUnlockWatch 存在');
  const showWallIdx = biz.indexOf('function showWall');
  const watchIdx = biz.indexOf('_startUnlockWatch();', showWallIdx);
  ok(showWallIdx >= 0 && watchIdx > showWallIdx && biz.indexOf('function hideWall') > watchIdx, '②showWall 打开墙时启动哨兵');
  ok(biz.indexOf('hidden = true; if (_unlockWatch)') >= 0, '②hideWall 关墙时停止哨兵（不空转）');
  ok(biz.indexOf("(d.unlimited || d.sub) && !$('#wallOverlay').hidden") >= 0, '③refreshSubs 巡检：已开通而墙挂着 → 自动撤墙');
  ok(biz.indexOf("document.addEventListener('visibilitychange'") >= 0, '④切回页面（visibilitychange）立即探测');
  ok(biz.indexOf('if (!_payPoll) _startPayPoll(oid)') >= 0, '④付款弹窗滚动询已停 → 切回页面即恢复');
  ok(biz.indexOf("/v1/subs/status')") >= 0, '④读取订单状态用与弹窗一致的接口');

  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  ok(html.indexOf('biz.js?v=20261023d') >= 0, 'index.html 缓存版本已 bump（防旧脚本缓存）');

  // 【2026-10-21 第二轮：诚实 402 + 消除重复计账】
  ok(biz.indexOf("d.unlimited || (d.sub && d.sub.plan)") >= 0, '⑤402 双语义：已订阅撞日限时 → 不弹订阅墙（防重复付费）');
  ok(biz.indexOf("PT('quotaDailyDone')") >= 0 && biz.indexOf("PT('quotaDailyHint')") >= 0, '⑤提示文案在位（quotaDailyDone/Hint）');
  const zh = biz.slice(biz.indexOf('zh: {'), biz.indexOf('en: {'));
  ok(zh.indexOf('quotaDailyDone') >= 0, '⑤文案 zh 在位');
  const appJs = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  ok(appJs.indexOf("function toast(msg, kind = '', ms)") >= 0 && appJs.indexOf('Number(ms) > 0 ? Number(ms) : 3200') >= 0, '⑤toast 支持自定义停留时长');
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(srv.indexOf("unlimited: !!st.unlimited, sub: st.sub || null") >= 0, '⑥gateSection 402 携带订阅者上下文');
  ok(srv.indexOf('subs.status(v) 只调一次') >= 0, '⑥gateSection 不再重复读库');
  const sevenIdx = srv.indexOf("'/v1/report/seven'");
  ok(sevenIdx >= 0 && srv.indexOf('gateContent(req, q, res)', sevenIdx) < 0, '⑦七段报告不再双重计账（autoGate 唯一计量）');
}

// ---------------- A. 服务端零触闭环（真实 HTTP） ----------------
async function main() {
  PORT = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      BINGDASHAN_DATA_DIR: DATA,
      BINGDASHAN_PORT: String(PORT),
      BINGDASHAN_HOST: '127.0.0.1',
      BD_NOTIFY_KEY: NOTIFY_KEY,
      NODE_ENV: 'test',
    }),
  });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(500);
    const r = await req('GET', '/v1/status');
    up = !!(r && r.status === 200);
  }
  if (!up) { console.log('  [FAIL] 服务器未启动'); process.exit(1); }
  console.log('  [PASS] 服务器已启动 :127.0.0.1:' + PORT);

  // 模拟真实前端：先签身份（ensureSignedIdentity 同款两步），后续请求都带签名 X-Visitor
  section('0. 身份签发（与前端 ensureSignedIdentity 同路径）');
  const first = await req('GET', '/v1/subs/status');
  ok(first.status === 200 && first.body && first.body.visitor, '首次状态可读且含服务端认定的 visitor key');
  const idr = await req('POST', '/v1/subs/identity', { key: first.body.visitor });
  ok(idr.status === 200 && idr.body && idr.body.ok && idr.body.vid, '服务端签发签名 vid', idr.body && idr.body.vid ? String(idr.body.vid).slice(0, 24) + '…' : '');
  const VH = { 'X-Visitor': idr.body.vid };

  section('1. 下单 → 订单状态接口（前端解锁信号①）初始为未支付');
  const plans = await req('GET', '/v1/subs/status', null, VH);
  ok(plans.status === 200 && plans.body.plans && plans.body.plans.CN.length >= 1, '订阅状态可读到套餐', (plans.body.plans || {}).CN && plans.body.plans.CN.length);
  const pl0 = plans.body.plans.CN.filter((p) => Number(p.amount) > 0 && !p.trial)[0] || plans.body.plans.CN[0];
  const ord = await req('POST', '/v1/subs/order', { plan: pl0.id, lang: 'zh' }, VH);
  ok(ord.status === 200 && ord.body && ord.body.ok && ord.body.order && ord.body.order.id, '订单创建', ord.body && ord.body.order && ord.body.order.id);
  const oid = ord.body.order.id;
  const cur = ord.body.order.currency || 'CNY';
  const amt = Number(ord.body.order.amount);
  const s1 = await req('GET', '/v1/pay/status?order=' + encodeURIComponent(oid), null, VH);
  ok(s1.status === 200 && s1.body.ok && s1.body.paid === false, '付款前：paid=false', s1.raw && s1.raw.slice(0, 80));

  section('2. 收款信号进来（邮件/通知通道语义）→ 前端两个探测信号同时翻转');
  const settle = await req('POST', '/v1/pay/auto-settle', { amount: amt, currency: cur, channel: 'alipay', ref: 'zero-touch-ref', source: 'mail:watch' }, { 'x-bd-notify-key': NOTIFY_KEY });
  ok(settle.status === 200 && settle.body.ok === true && settle.body.matched === true, '自动开通成功', settle.raw && settle.raw.slice(0, 120));

  // 前端轮询信号①：订单状态翻转
  const s2 = await req('GET', '/v1/pay/status?order=' + encodeURIComponent(oid), null, VH);
  ok(s2.status === 200 && s2.body.ok && s2.body.paid === true, '信号① /v1/pay/status → paid=true');
  // 墙哨兵/订阅面板信号②：订阅生效
  const st2 = await req('GET', '/v1/subs/status', null, VH);
  ok(st2.body && st2.body.unlimited === true && st2.body.wall === false, '信号② /v1/subs/status → unlimited、wall=false');
  ok(st2.body && st2.body.sub && Number(st2.body.sub.daysLeft) > 0, '信号② sub.daysLeft > 0（前端据此显示会员天数）');

  section('3. 迟到信号幂等（邮件通道重复推送一次也不多入账/不多开通）');
  const settle2 = await req('POST', '/v1/pay/auto-settle', { amount: amt, currency: cur, channel: 'alipay', ref: 'zero-touch-ref-2' }, { 'x-bd-notify-key': NOTIFY_KEY });
  ok(settle2.status === 200 && settle2.body.ok === true && (settle2.body.already === true || settle2.body.status === 'already_paid'), '重复信号 → already（幂等）', settle2.raw && settle2.raw.slice(0, 100));

  section('4. 未匹配信号绝不误开通（fail-closed → 收款墙不会被假信号击穿）');
  const ghost = await req('POST', '/v1/pay/auto-settle', { amount: 123.45, currency: 'CNY', channel: 'alipay', ref: 'ghost' }, { 'x-bd-notify-key': NOTIFY_KEY });
  ok(ghost.status === 200 && ghost.body.ok === false && ghost.body.matched === false, '幽灵金额 → 不开通', ghost.raw && ghost.raw.slice(0, 100));

  section('5. 诚实 402：已订阅撞日限时 → 402 带 unlimited/sub（前端不重复推销）');
  // 制造一段已订阅状态：直接对同一访客再下一单（正式档）并结算
  const ord2 = await req('POST', '/v1/subs/order', { plan: pl0.id, lang: 'zh' }, VH);
  ok(ord2.status === 200 && ord2.body.ok, '第二单创建（正式档续订）');
  const oid2 = ord2.body.order.id;
  const settle2b = await req('POST', '/v1/pay/auto-settle', { amount: Number(ord2.body.order.amount), currency: ord2.body.order.currency || 'CNY', channel: 'alipay', ref: 'zero-touch-ref-3', paidAt: Date.now() }, { 'x-bd-notify-key': NOTIFY_KEY });
  ok(settle2b.status === 200 && settle2b.body.ok === true, '第二单自动结算成功', settle2b.raw && settle2b.raw.slice(0, 120));

  child.kill('SIGKILL');
  try { require('fs').rmSync(DATA, { recursive: true, force: true }); } catch (e) {}

  console.log('');
  console.log('pass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
