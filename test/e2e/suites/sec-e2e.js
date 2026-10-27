// sec-e2e: secret-leak sweep / forged vid / oversized body / invite tiers / admin-gated ops.
// Remote-403 checks run against a throwaway LAN-bound server (192.168.x -> not loopback).
const { finish } = require('./_exit');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');

let pass = 0, fail = 0;
const T = (name, ok, extra) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' . ' + extra : ';')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 沙箱管理令牌：资金类接口回环也强制校验（adminAuthedStrict）。
// 由 goal-e2e-runner 注入并逐套件刷新。part5 轮换后要就地更新本变量。
let ADMIN = process.env.BINGDASHAN_ADMIN_TOKEN || '';

// 【作用域坑】req 定义在模块层，BASE 却在 async IIFE 里用 const 声明。
// req 若直接引用 BASE，会解析到模块层这个根本不存在的变量 → ReferenceError。
// 而 ReferenceError 发生在 http.request(...) 之前，被 waitUp 的 try/catch 吞掉，
// 于是 waitUp 一路重试到超时，只报一句「LAN server not reachable」——
// 症状与"端口没起来"一模一样，真正的原因（变量未定义）完全不显形。
// 解法：BASE 提到模块层，IIFE 内改为赋值。
let BASE = '';
let LAN_KNOWN_TOKEN = '';   // 部署者预置到 LAN 数据目录的管理令牌（part0 写库时赋值）
const fs_mkdirpSync = d => { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} };

function req(base, method, p, body, headers) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    // 只给沙箱 BASE 自动带上令牌；LAN 实例故意不带——part0/line187 要验证的就是
    // 「远端无令牌 → 403」与「过期令牌 → 403」，自动注入会把这两条测废。
    const autoAdmin = (ADMIN && base === BASE) ? { 'X-Admin-Token': ADMIN } : {};
    const h = Object.assign({ 'Content-Type': 'application/json' }, autoAdmin, headers || {});
    const r = http.request(base + p, { method, headers: h }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { res({ code: resp.statusCode, body: JSON.parse(d) }); } catch (e) { res({ code: resp.statusCode, body: d }); } });
    });
    r.setTimeout(8000, () => { r.destroy(); res({ code: 0, body: { raw: 'client timeout' } }); });
    r.on('error', e => res({ code: 0, body: { raw: String(e) } }));
    r.end(data || undefined);
  });
}
// 对偶发的事件循环阻塞（后台引擎启动时可能卡住几十~几百 ms）做一次重试：
// 只对 code===0（连不上/超时）重试；真实 403/200 原样返回，绝不掩盖判定。
async function reqWithRetry(base, method, p, body, headers) {
  const first = await req(base, method, p, body, headers);
  if (first.code !== 0) return first;
  await sleep(400);
  return req(base, method, p, body, headers);
}

async function waitUp(base, tries) {
  for (let i = 0; i < (tries || 30); i++) {
    try { const r = await req(base, 'GET', '/v1/status'); if (r.code === 200) return true; } catch (e) {}
    await sleep(400);
  }
  return false;
}

function fmtDeep(o) { try { return JSON.stringify(o); } catch (e) { return String(o); } }

(async () => {
  const t0 = Date.now().toString(36);
  const TEE = 'LAN';
  // 生产保护：本套件 part1–5 会写库（订单/营收/推广费/轮换 adminToken/清空 visitors）。
  // 历史事故：默认 3721 指向真实实例，产出 ~190 条污染记录。必须由 goal-e2e-runner 注入沙箱 base。
  const { requireIsolated } = require('./_guard');
  BASE = requireIsolated('sec-e2e');
  // 【为什么不能硬编码 IP】原来兜底 '192.168.125.92'：DHCP 换 IP / 插拔网线 / 容器网络
// 都会让这个地址不可达，表现为「LAN server up FAIL」——看起来像产品挂了，其实是
// 机器的网卡地址变了。改为枚举真实网卡；全都没有非内部 IPv4 时明确 ABORT 并说明原因，
// 不再拿一个假 IP 去撞运气。
const _ifaces = os.networkInterfaces();
  const lanCandidates = [];
  for (const k in _ifaces) for (const a of (_ifaces[k] || [])) {
    if ((a.family === 'IPv4' || a.family === 4) && !a.internal) lanCandidates.push(a.address);
  }
  const lanIp = lanCandidates[0];
  if (!lanIp) {
    console.error('ABORT sec-e2e：本机没有非内部 IPv4 网卡，无法构造"远端"场景。');
    console.error('「远端无令牌 → 403」依赖非回环来源；只有回环网卡时该断言无法被证明。');
    console.error('（这属于环境限制，不是产品缺陷。接网线/连 WiFi 后重跑。）');
    process.exit(2);
  }
  const LAN_PORT = await require('../../../scripts/_port').freePort(3730);
  const LAN = 'http://' + lanIp + ':' + LAN_PORT;
  console.log('[sec] 远端模拟网卡: ' + lanIp + ' 端口 ' + LAN_PORT + (lanCandidates.length > 1 ? '（备选: ' + lanCandidates.slice(1).join(', ') + '）' : ''));
  const TS = 'sec-' + t0;
  let doneTimer;
  const done = new Promise(res => { doneTimer = setTimeout(res, 80000, 'TIMEOUT'); });
  const run = (async () => {

  // ---- part 0: remote (non-loopback) admin 403 paths on a dedicated LAN-bound server ----
  // 先在 LAN 数据目录预写已知管理令牌（模拟部署者配置好令牌再启动），
  // 这样既能测「远端 + 正确令牌 → 200」（前端 api() 自动注入 X-Admin-Token 的场景），
  // 也能测「远端无令牌/错误令牌 → 403」。若让 server 自己随机生成令牌，则外部无从
  // 预知正确值，「有效令牌 → 200」这条闭环就永远无法被断言。
  const LAN_DATA = process.env.TEMP + '/opencode/sec-e2e-data-' + t0;
  {
    const LAN_TOKEN = 'sec-lan-tok-' + t0;   // 部署者预置的已知令牌
    fs_mkdirpSync(LAN_DATA);
    const dbPath = LAN_DATA + '/db.json';
    let db = { settings: {} };
    try { db = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch (e) {}
    if (!db.settings) db.settings = {};
    db.settings.adminToken = LAN_TOKEN;
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    // 供 part5 二次验证用：把已知令牌记到模块变量
    LAN_KNOWN_TOKEN = LAN_TOKEN;
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: 'C:/Users/Think/project/BingDashan',
    env: Object.assign({}, process.env, {
      // 固定端口会让"上一轮残留实例"吃掉这一轮：spawn 不报错、断言却打到了旧进程上，
      // 而且症状是随机飘。改成动态取端口（避开生产 3721/3722），并给沙箱目录加进程后缀。
      BINGDASHAN_PORT: String(LAN_PORT),
      BINGDASHAN_HOST: '0.0.0.0',
      BINGDASHAN_DATA_DIR: LAN_DATA,
      BINGDASHAN_AGENT_ROOT: process.env.TEMP + '/opencode/sec-e2e-agent-root-' + t0
    }),
    stdio: ['ignore', 'ignore', 'ignore']
  });
  const up = await waitUp(LAN);
  T('LAN server up', up, up ? '' : 'LAN server not reachable');
  if (up) {
    let r = await req(LAN, 'POST', '/v1/subs/confirm', { orderId: 'sec-fake' });
    T('remote confirm w/o admin token -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/subs/reset-visitors', {});
    T('remote reset-visitors w/o token -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/subs/rotate-admin-token', {});
    T('remote rotate-admin-token w/o token -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'GET', '/v1/settings');
    const sj = r.body && r.body.settings ? r.body.settings : {};
    const leakS = !('adminToken' in sj) && !('visitorSecret' in sj) && !('mailAuth' in sj) && !('smtpAuth' in sj);
    T('GET /v1/settings remote hides secrets', leakS, 'keys=' + Object.keys(sj).join(','));
    r = await req(LAN, 'GET', '/v1/status');
    const stj = r.body && r.body.settings ? r.body.settings : {};
    const leakSt = !('adminToken' in stj) && !('visitorSecret' in stj);
    T('GET /v1/status hides secrets', leakSt, 'keys=' + Object.keys(stj).join(','));
    r = await req(LAN, 'POST', '/v1/settings', { 'adminToken': 'H4X0R', visitorSecret: 'H4X0R' });
    const rj = r.body && r.body.settings ? r.body.settings : {};
    const wrote = !('adminToken' in rj) && !('visitorSecret' in rj);
    T('POST /v1/settings cannot write secrets', wrote, 'respKeys=' + Object.keys(rj).join(','));
    // 【真漏洞·已修】光"不回显"不够——原来 adminToken 会经注册表/passthrough 两条路径
    // 真写进 db.settings（匿名者可把管理令牌改成已知值，拿到 confirm/rotate 等资金权限）。
    // 修复后接口必须显式拒绝（rejected 含受保护键），并保留存储中的原令牌不被覆盖。
    const rejectedProt = (r.body && r.body.rejected || []).filter(x => x.key === 'adminToken' || x.key === 'visitorSecret');
    T('POST /v1/settings rejects protected keys', rejectedProt.length === 2, 'rejected=' + (r.body && r.body.rejected || []).map(x => x.key).join(','));
    // —— 全局变更限权门：白名单外的 POST/PUT/PATCH/DELETE，非回环+无令牌 → 403 ——
    // 此前这些「运营杠杆」全都能匿名远程触发（退款/放开收费墙/发件/注入技能/停引擎）。
    r = await req(LAN, 'POST', '/v1/mail', { to: 'x@x.com', text: 'hi' });
    T('remote mail send w/o token -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/tickets/refund', { id: 'x', processed: true });
    T('remote ticket refund w/o token -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/paywall/toggle', { on: true });
    T('remote paywall toggle w/o token -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/skills/inject', { src: 'x' });
    T('remote skills inject w/o token -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/orca/run', {});
    T('remote orca run w/o token -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/autopilot/pause', {});
    T('remote autopilot pause w/o token -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/foundry/grant', {});
    T('remote foundry grant w/o token -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/publish/enqueue', {});
    T('remote publish enqueue w/o token -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/goals', { title: 'x' });
    T('remote goals create w/o token -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/payout/instruction', {});
    T('remote payout instruction w/o token -> 403', r.code === 403, 'code=' + r.code);
    // —— 反向护栏：访客漏斗的 POST 不能被管理令牌 403 掉（否则付费链路断裂）——
    const vs = [];
    vs.push(['gtm touch', await req(LAN, 'POST', '/v1/gtm/touch', {})]);
    vs.push(['zodiac tick', await req(LAN, 'POST', '/v1/zodiac/tick', {})]);
    vs.push(['rank enter', await req(LAN, 'POST', '/v1/rank/enter', { name: 'n', field: 's', score: 1 })]);
    vs.push(['organs beat', await req(LAN, 'POST', '/v1/organs/beat', { id: 'h' })]);
    vs.push(['partner enroll', await req(LAN, 'POST', '/v1/partner/enroll', {})]);
    vs.push(['geo report', await req(LAN, 'POST', '/v1/geo/report', { kind: 'visitor', id: 'v1', lat: 30.1, lng: 120.1 })]);
    const blockedFunnel = vs.filter(([, v]) => v.code === 403).map(([k]) => k);
    T('visitor funnel POSTs not admin-gated', blockedFunnel.length === 0, blockedFunnel.length ? '403 on: ' + blockedFunnel.join(',') : '');
    // agentcenter: remote mutations must be admin-gated; GET status open; not-installed graceful
    r = await req(LAN, 'POST', '/v1/agentcenter/install', {});
    T('remote agentcenter install -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/agentcenter/daemon/start', {});
    T('remote agentcenter daemon/start -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/agentcenter/daemon/stop', {});
    T('remote agentcenter daemon/stop -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/agentcenter/agents/run', { prompt: 'x' });
    T('remote agentcenter agents/run -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/agentcenter/agents/send', { agentId: 'a', prompt: 'x' });
    T('remote agentcenter agents/send -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/agentcenter/agents/stop', { agentId: 'a' });
    T('remote agentcenter agents/stop -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'POST', '/v1/agentcenter/coop', { agentId: 'a', detail: 'x' });
    T('remote agentcenter coop POST -> 403', r.code === 403, 'code=' + r.code);
    r = await req(LAN, 'GET', '/v1/agentcenter');
    T('remote agentcenter GET open + reports not-installed', r.code === 200 && !!(r.body && r.body.ok === true && r.body.installed === false), 'installed=' + String(r.body && r.body.installed));
    r = await req(LAN, 'GET', '/v1/agentcenter/agents');
    T('remote agentcenter agents GET graceful when not installed', r.code === 200 && !!(r.body && r.body.ok === false && /未落地/.test(r.body.error || '')), 'err=' + String(r.body && r.body.error).slice(0, 60));
    r = await req(LAN, 'GET', '/v1/agentcenter/daemon/status');
    T('remote agentcenter daemon/status graceful when not installed', r.code === 200 && !!(r.body && r.body.ok === false && /未落地/.test(r.body.error || '')), 'err=' + String(r.body && r.body.error).slice(0, 60));
  }

  // ---- part 1: secret leak + settings write-guard on main server ----
  const gs = await req(BASE, 'GET', '/v1/settings');
  const gsj = gs.body.settings || {};
  T('main GET /v1/settings hides secrets', !('adminToken' in gsj) && !('visitorSecret' in gsj), 'keys=' + Object.keys(gsj).join(','));
  const gst = await req(BASE, 'GET', '/v1/status');
  const gstj = gst.body.settings || {};
  T('main GET /v1/status hides secrets', !('adminToken' in gstj) && !('visitorSecret' in gstj) && !('smtpAuth' in gstj));

  // ---- agentcenter: input validation on main (loopback admin) ----
  let ac = await req(BASE, 'GET', '/v1/agentcenter');
  T('main agentcenter GET shape', !!ac.body && ac.body.ok === true && typeof ac.body.installed === 'boolean', 'installed=' + String(ac.body && ac.body.installed));
  let acr = await req(BASE, 'POST', '/v1/agentcenter/agents/send', { agentId: 'bad id !', prompt: 'x' });
  T('agentcenter send bad agentId rejected', !!(acr.body && acr.body.ok === false) && /格式不合法/.test(acr.body.error || ''), 'err=' + String(acr.body && acr.body.error).slice(0, 40));
  acr = await req(BASE, 'POST', '/v1/agentcenter/agents/send', { agentId: 'ok-01', prompt: '' });
  T('agentcenter send empty prompt rejected', !!(acr.body && acr.body.ok === false), 'err=' + String(acr.body && acr.body.error).slice(0, 40));
  acr = await req(BASE, 'POST', '/v1/agentcenter/agents/run', { prompt: '' });
  T('agentcenter run empty prompt rejected', !!(acr.body && acr.body.ok === false), 'err=' + String(acr.body && acr.body.error).slice(0, 40));
  acr = await req(BASE, 'POST', '/v1/agentcenter/agents/stop', { agentId: 'bad id !' });
  T('agentcenter stop bad agentId rejected', !!(acr.body && acr.body.ok === false), 'err=' + String(acr.body && acr.body.error).slice(0, 40));
  acr = await req(BASE, 'POST', '/v1/agentcenter/coop', { agentId: 'sec-1', detail: 'coord wrote' });
  T('agentcenter coop POST allowed on loopback', !!(acr.body && acr.body.kind === 'coop'), 'body=' + String(acr.body && acr.body.kind));
  const cg = await req(BASE, 'GET', '/v1/agentcenter/coop?limit=3');
  T('agentcenter coop GET list', !!(cg.body && Array.isArray(cg.body.log)), 'len=' + String(cg.body && cg.body.log && cg.body.log.length));

  // ---- part 2: oversized body rejected without crash ----
  const obody = JSON.stringify({ text: 'x'.repeat(3 * 1024 * 1024) });
  const ob = await req(BASE, 'POST', '/v1/chat', {}, { 'Content-Type': 'application/json' });
  // use raw socket to send a huge body (req helper json-stringifies object, bypass: send string)
  const orr = await new Promise(res => {
    const data = obody;
    const r = http.request(BASE + '/v1/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => res({ code: resp.statusCode, body: d.slice(0, 80) }));
    });
    r.on('error', e => res({ code: 0, body: String(e) }));
    r.write(data); r.end();
  });
  T('oversized body rejected (413)', orr.code === 413, 'code=' + orr.code);
  const alive = await req(BASE, 'GET', '/v1/status');
  T('server alive after oversized body', alive.code === 200, 'code=' + alive.code);

  // ---- part 3: forged vid (wrong signature) does not inherit subscription ----
  const kSub = TS + '-sub';
  const subId = (await req(BASE, 'POST', '/v1/subs/identity', { key: kSub })).body;
  const so = subspec(await req(BASE, 'POST', '/v1/subs/order', { key: subId.vid, plan: 'm', lang: 'CN' }));
  subconf(await req(BASE, 'POST', '/v1/subs/confirm', { orderId: so.id }));
  // now forge: same subscriber key but wrong HMAC tail
  const forged = kSub + '.ffffffffffffffffffffffff';
  const fg = await req(BASE, 'POST', '/v1/subs/gate', { key: forged }, { 'X-Visitor': forged });
  T('forged vid not accepted as subscriber', !!(fg.body && fg.body.allowed === true && fg.body.sub !== true), 'sub=' + String(fg.body && fg.body.sub) + ' wall=' + String(fg.body && fg.body.wall));

  // ---- part 4: invite reward tiers ----
  const inviter = TS + '-inv';
  const invId = (await req(BASE, 'POST', '/v1/subs/identity', { key: inviter })).body;
  // inviter must have an active sub so settleInvite can extend it
  const io = (await req(BASE, 'POST', '/v1/subs/order', { key: invId.vid, plan: 'm', lang: 'CN' })).body.order;
  void (await req(BASE, 'POST', '/v1/subs/confirm', { orderId: io.id }));
  const invSt1 = (await req(BASE, 'GET', '/v1/subs/status', null, { 'X-Visitor': invId.vid })).body;
  const d0 = invSt1.sub.daysLeft;
  // 3 invitees all bind inviter
  const invs = [];
  for (let i = 0; i < 3; i++) {
    const iv = (await req(BASE, 'POST', '/v1/subs/identity', { key: TS + '-invitee' + i })).body;
    void (await req(BASE, 'POST', '/v1/subs/bind', { key: iv.vid, code: inviter }));
    invs.push(iv.vid);
  }
  // invitee1 pays quarter -> tier1 +1
  const o1 = (await req(BASE, 'POST', '/v1/subs/order', { key: invs[0], plan: 'q', lang: 'CN' })).body.order;
  const c1 = await req(BASE, 'POST', '/v1/subs/confirm', { orderId: o1.id });
  T('invite tier1 +1 month (all-q so far)', !!(c1.body && c1.body.inviteBonus && c1.body.inviteBonus.tier === '1' && c1.body.inviteBonus.addedMonths === 1), 'tier=' + String(c1.body && c1.body.inviteBonus && c1.body.inviteBonus.tier));
  // invitee2/3 both quarter -> tier3 +3 (all paidByInvited are q/y)
  const o2 = (await req(BASE, 'POST', '/v1/subs/order', { key: invs[1], plan: 'q', lang: 'CN' })).body.order;
  const o3 = (await req(BASE, 'POST', '/v1/subs/order', { key: invs[2], plan: 'q', lang: 'CN' })).body.order;
  void (await req(BASE, 'POST', '/v1/subs/confirm', { orderId: o2.id }));
  const c3 = await req(BASE, 'POST', '/v1/subs/confirm', { orderId: o3.id });
  T('invite tier3 +3 months (cumulative)', !!(c3.body && c3.body.inviteBonus && c3.body.inviteBonus.tier === '3' && c3.body.inviteBonus.grantedMonths === 3), 'tier=' + String(c3.body && c3.body.inviteBonus && c3.body.inviteBonus.tier) + ' granted=' + String(c3.body && c3.body.inviteBonus && c3.body.inviteBonus.grantedMonths) + ' delta=' + String(c3.body && c3.body.inviteBonus && c3.body.inviteBonus.addedMonths));
  const invSt2 = (await req(BASE, 'GET', '/v1/subs/status', null, { 'X-Visitor': invId.vid })).body;
  T('inviter sub extended', invSt2.sub.daysLeft > d0, 'd0=' + d0 + ' now=' + invSt2.sub.daysLeft);

  // ---- part 5: admin rotation + reset ----
  const rot = await req(BASE, 'POST', '/v1/subs/rotate-admin-token', {});
  const t1 = (rot.body && rot.body.token) || '';
  T('rotate-admin-token returns fresh token', t1.length >= 20, 'len=' + t1.length);
  if (t1) ADMIN = t1;   // 后续 BASE 调用必须用新令牌，否则全 403
  // old token must be rejected after rotation -> use the LAN (non-loopback) server with the now-old token
  if (up) {
    const fwd = await req(LAN, 'POST', '/v1/subs/rotate-admin-token', {}, { 'X-Admin-Token': 'OLD_DUMMY' });
    T('stale token rejected (remote, non-loopback)', fwd.code === 403, 'code=' + fwd.code);
    const scr = await req(BASE, 'POST', '/v1/subs/rotate-admin-token', {});
    const t2 = (scr.body && scr.body.token) || '';
    const oldTokEver = t1 !== t2;
    T('rotation changes token', oldTokEver, 'len(t1)=' + t1.length + ' same? ' + (t1 === t2));
    if (t2) ADMIN = t2;
    // —— 修复闭环：正确令牌 → 远端放行 200 / 错误令牌 → 403 ——
    // 背景：以前只测了「远端无令牌 → 403」，没测「有正确令牌 → 200」。
    // 前端 web/app.js、biz.js 的 api() 现已自动注入 X-Admin-Token，
    // 正式验证服务端 adminAuthed 在非回环来源 + 有效令牌时确实放行。
    // 注意：令牌必须用 LAN_KNOWN_TOKEN（部署者预置到 LAN 数据目录的那个），
    // t2 是沙箱实例 rotate 出来的，LAN 实例不认识它——跨实例令牌不同源。
    const goodTok = await reqWithRetry(LAN, 'GET', '/v1/subs/pay-config', {}, { 'X-Admin-Token': LAN_KNOWN_TOKEN });
    T('remote pay-config allowed with valid admin token', goodTok.code === 200, 'code=' + goodTok.code);
    const badTok = await reqWithRetry(LAN, 'GET', '/v1/subs/pay-config', {}, { 'X-Admin-Token': 'WRONG_TOKEN_XYZ' });
    T('remote pay-config rejected with wrong token', badTok.code === 403, 'code=' + badTok.code);
    const noTok = await reqWithRetry(LAN, 'GET', '/v1/subs/pay-config', {});
    T('remote pay-config rejected without token', noTok.code === 403, 'code=' + noTok.code);
  }

  const res = await req(BASE, 'POST', '/v1/subs/reset-visitors', {});
  T('reset-visitors wipes visitor rows + rotates secret', !!(res.body && res.body.ok && res.body.visitors === 0), 'visitors=' + String(res.body && res.body.visitors));
  const stOld = await req(BASE, 'GET', '/v1/subs/status', null, { 'X-Visitor': subId.vid });
  T('old vid invalid after reset (fresh visitor, no sub)', !!(stOld.body && stOld.body.sub === null), 'sub=' + String(stOld.body && stOld.body.sub));
  child.kill();

  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  finish(fail ? 1 : 0);
  })();
  const verdict = await Promise.race([run, done]);
  clearTimeout(doneTimer);   // race 一结束就释放，否则进程要干等到超时点才退
  if (verdict === 'TIMEOUT') { try { child.kill(); } catch (e) {} console.log('===== TIMEOUT (suite hung) ====='); process.exit(2); }

  function subspec(r) { if (!(r.body && r.body.order)) throw new Error('no order: ' + fmtDeep(r)); return r.body.order; }
  function subconf(r) { if (!(r.body && r.body.ok)) throw new Error('confirm failed: ' + fmtDeep(r)); return r.body; }
})();