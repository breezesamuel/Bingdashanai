require('./_isolate');
// e2e_pay_wall.js — 订阅墙 + 支付链路端到端真调用回归（2026-10-24）
//
// 与单测的区别：这里**起真实 server.js 进程**，用真实 HTTP（带 Cookie 的真实访客身份）
// 把「撞墙 → 下单 → 付款（个人收款码兜底）→ 我已转账（24h 临时权益）→ 人工核账转正 →
// 退款 → 权益回收」整条链走一遍。任何一环断掉都会在这里现形。
//
// 验证点：
//   ① 墙关（paywallOn=false）时：直调 gateSection 的端点也不得拦截（paywallOn=false ⇒ 免费）
//   ② 墙开后：402 响应必须是 web/biz.js hookWall 依赖的完整契约
//      （status 402 + body.wall/section/msg/plans{CN,EN}/freeLeft/unlimited/sub）
//   ③ GET /v1/plans 定价端点真实存在（此前注册≠存在，404）
//   ④ 下单 → checkout（无网关凭据时落个人收款码兜底）→ /v1/pay/status 如实回 channel
//   ⑤ 我已转账（订单创建 ≥30s 防刷冷却后）→ 24h 临时权益立即生效（撞墙端点立刻放行）
//   ⑥ 人工核账 → 永久订阅生效
//   ⑦ 退款确认 → 订阅权益随之回收（再撞墙）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let PORT = 0;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-e2e-pay-'));
let fail = 0, pass = 0;
function ok(c, label, extra) {
  pass += c ? 1 : 0; fail += c ? 0 : 1;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined && !c ? '  ->  ' + (typeof extra === 'object' ? JSON.stringify(extra).slice(0, 300) : extra) : ''));
}
function section(t) { console.log(''); console.log('=== ' + t); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每个 jar 是一个独立"浏览器"（独立 bd_vid Cookie → 独立访客身份）
function makeJar() { return { cookie: '' }; }
function req(jar, method, p, body, headers) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign(
        { 'content-type': 'application/json' },
        jar.cookie ? { cookie: jar.cookie } : {},
        headers || {}
      ),
    }, (res) => {
      let b = '';
      const sc = String(res.headers['set-cookie'] || '');
      if (sc && !jar.cookie) {
        const m = /bd_vid=([^;]+)/.exec(sc);
        if (m) jar.cookie = 'bd_vid=' + m[1];
      }
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j = null; try { j = JSON.parse(b); } catch (e) {}
        resolve({ status: res.statusCode, body: j, raw: b });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: null, raw: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, {
        BINGDASHAN_DATA_DIR: DATA,
        BINGDASHAN_PORT: '0',
        NODE_ENV: 'test',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server boot timeout: ' + buf.slice(-400))), 30000);
    const onData = (d) => {
      buf += d;
      const m = /listening http:\/\/([0-9.]+):(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[2]) }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

// 管理令牌：只从磁盘 db.json 直读（绝不在测试进程里 require core/store ——
// 两个进程各持一份内存库再回写，会把服务器的台账覆盖掉）。
// ensureAdminToken 惰性生成：先故意打一次严格管理端点（403）触发生成，再读文件。
function adminTokenFromDisk() {
  try {
    const db = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
    return (db.settings && db.settings.adminToken) || '';
  } catch (e) { return ''; }
}

async function main() {
  const { child, port } = await startServer();
  PORT = port;

  // ===== A. 启动与基础信息 =====
  section('A. 启动 / 定价 / 通道');
  const buyer = makeJar();
  const st = await req(buyer, 'GET', '/v1/status');
  ok(st.status === 200 && st.body && st.body.ok !== false, 'GET /v1/status 200', st.body);

  const plans = await req(buyer, 'GET', '/v1/plans');
  const pcn = plans.body && plans.body.plans && plans.body.plans.CN;
  ok(plans.status === 200 && Array.isArray(pcn) && pcn.length >= 4, 'GET /v1/plans 返回套餐（端点真实存在）', plans.body);
  ok(Array.isArray(pcn) && pcn.some(p => p.id === 't') && pcn.some(p => p.id === 'm'), '含体验款 t 与月款 m');
  ok(plans.body && plans.body.quota && Array.isArray(plans.body.quota.free), 'GET /v1/plans 带免费额度说明');
  ok(plans.body && plans.body.wall && typeof plans.body.wall.on === 'boolean', 'GET /v1/plans 带收费墙状态');

  const quota = await req(buyer, 'GET', '/v1/subs/quota');
  ok(quota.status === 200 && quota.body && Array.isArray(quota.body.free) && quota.body.free.length >= 10,
    'GET /v1/subs/quota 额度说明完整（free 分区表）', quota.body && { free: quota.body.free.length });

  const ch = await req(buyer, 'GET', '/v1/pay/channels');
  console.log('    [通道实测] ' + JSON.stringify(ch.body).slice(0, 300));

  // ===== B. 墙关：直调 gateSection 的端点不得拦截也不得扣量 =====
  section('B. 墙关（paywallOn 未开启）时的行为');
  const offA = makeJar();
  let blocked = 0, lastOff = null;
  for (let i = 0; i < 12; i++) {
    // /v1/decisions/suggest 路由内**直调** gateSection（decision 免费额度 10/日）：
    // 若闸门无视开关，第 11 次就会 402。
    const r = await req(offA, 'GET', '/v1/decisions/suggest?topic=e2e-wall-off');
    if (r.status === 402) { blocked++; lastOff = r.body; }
  }
  ok(blocked === 0, '墙关时连打 12 次 /v1/decisions/suggest（直调闸门，配额 10）不应出现 402', { blocked, last: lastOff });

  // ===== C. 开墙：402 契约 =====
  section('C. 开墙 → 402 契约（前端 hookWall 依赖）');
  const t1 = await req(buyer, 'POST', '/v1/paywall/toggle', { on: true });
  ok(t1.status === 200 && t1.body && t1.body.enabled === true, 'POST /v1/paywall/toggle 开墙', t1.body);

  const walled = makeJar();
  let got402 = null, allowedN = 0;
  for (let i = 0; i < 7; i++) {
    const r = await req(walled, 'GET', '/v1/agents');   // agent 分区免费 6 次/日（路由直调闸门）
    if (r.status === 402) { got402 = r; break; }
    allowedN++;
  }
  ok(!!got402, '第 7 次 GET /v1/agents 撞墙（agent 免费额度 6/日）', { allowedN, status: got402 && got402.status });
  if (got402) {
    const b = got402.body || {};
    ok(got402.status === 402 && b.wall === true, '402 状态码 + body.wall=true');
    ok(typeof b.section === 'string' && b.section === 'agent', '402 带分区 section=agent', b.section);
    ok(typeof b.msg === 'string' && b.msg.length > 0, '402 带 msg 文案', b.msg);
    ok(b.plans && Array.isArray(b.plans.CN) && b.plans.CN.length > 0 && Array.isArray(b.plans.EN),
      '402 带 plans{CN,EN}（showWall 渲染订阅墙依赖）', b.plans && { CN: b.plans.CN.length });
    ok(b.freeLeft !== undefined && b.unlimited === false, '402 带 freeLeft/unlimited（防已订阅用户误弹墙）', { freeLeft: b.freeLeft, unlimited: b.unlimited });
  }

  // ===== D. 下单 → 付款（个人收款码兜底）=====
  section('D. 下单 / checkout / 状态如实');
  const ord = await req(walled, 'POST', '/v1/subs/order', { plan: 't' });
  ok(ord.status === 200 && ord.body && ord.body.ok && ord.body.order && ord.body.order.id, 'POST /v1/subs/order 下单成功（t 体验款）', ord.body);
  const oid = ord.body && ord.body.order && ord.body.order.id;

  const co = await req(walled, 'POST', '/v1/pay/checkout', { orderId: oid });
  ok(co.status === 200 && co.body && co.body.ok !== false, 'POST /v1/pay/checkout 出付款指引（无网关凭据 → 收款码兜底）', co.body);
  console.log('    [checkout 实测] ' + JSON.stringify(co.body).slice(0, 300));

  const ps0 = await req(walled, 'GET', '/v1/pay/status?order=' + encodeURIComponent(oid));
  ok(ps0.status === 200 && ps0.body && ps0.body.channel === 'manual',
    'GET /v1/pay/status 如实回 channel=manual（不再硬编码 alipay）', ps0.body && { channel: ps0.body.channel });
  ok(ps0.body && ps0.body.paid === false, '付款前 paid=false');

  // ===== E. 我已转账 → 24h 临时权益 =====
  section('E. 我已转账（24h 临时权益）');
  // 防刷冷却：订单创建后 30s 内拒绝"我已转账"（设计如此，不是 bug）——先验证冷却生效
  const early = await req(walled, 'POST', '/v1/pay/manual-confirm', { orderId: oid, note: '太早了' });
  ok(early.body && early.body.ok === false && /30 秒/.test(String(early.body.error || '')),
    '订单创建 30s 内 manual-confirm 被防刷冷却拒绝（设计行为）', early.body);
  console.log('    [等待 31s 防刷冷却…]');
  await sleep(31000);
  const mc = await req(walled, 'POST', '/v1/pay/manual-confirm', { orderId: oid, note: 'e2e 回归转账' });
  ok(mc.status === 200 && mc.body && mc.body.ok, 'POST /v1/pay/manual-confirm 回传凭证', mc.body);
  ok(mc.body && (mc.body.sub || mc.body.tempPass), '回传订阅状态（临时权益已生效）', mc.body && { sub: !!mc.body.sub, tempPass: mc.body.tempPass });
  const afterProv = await req(walled, 'GET', '/v1/agents');
  ok(afterProv.status !== 402, '临时权益期间撞墙端点立即放行', { status: afterProv.status });

  // ===== F. 人工核账 → 永久订阅 =====
  section('F. 人工核账（管理令牌）');
  const noTok = await req(walled, 'POST', '/v1/pay/manual-verify', { orderId: oid });
  ok(noTok.status === 403, '无管理令牌 manual-verify 被拒（403）', noTok.status);
  const adm = () => ({ 'x-admin-token': adminTokenFromDisk() });
  ok(!!adminTokenFromDisk(), '管理令牌从 db.json 读到（403 调用已触发惰性生成）', adminTokenFromDisk().slice(0, 6) + '…');
  const mv = await req(walled, 'POST', '/v1/pay/manual-verify', { orderId: oid }, adm());
  ok(mv.status === 200 && mv.body && mv.body.ok, '带管理令牌 manual-verify 转正', mv.body);

  const subSt = await req(walled, 'GET', '/v1/subs');
  const s = subSt.body && (subSt.body.sub || subSt.body);
  ok(subSt.status === 200 && s && Number(s.expireAt) > Date.now(), 'GET /v1/subs 订阅生效（expireAt > now）', s);
  const paySt = await req(walled, 'GET', '/v1/pay/status?order=' + encodeURIComponent(oid));
  ok(paySt.status === 200 && paySt.body && paySt.body.paid === true, 'GET /v1/pay/status 订单已支付', paySt.body);

  const heavyHit = await req(walled, 'GET', '/v1/agents');
  ok(heavyHit.status !== 402, '订阅后重耗分区正常放行', { status: heavyHit.status });

  // ===== G. 退款 → 权益回收 =====
  section('G. 退款闭环');
  const rf = await req(walled, 'POST', '/v1/pay/refund', { orderId: oid, reason: 'e2e 回归退款' });
  ok(rf.status === 200 && rf.body && rf.body.ok, 'POST /v1/pay/refund 申请退款', rf.body);
  const rfSt = await req(walled, 'GET', '/v1/pay/refund/status?orderId=' + encodeURIComponent(oid));
  ok(rfSt.status === 200 && rfSt.body && rfSt.body.found && rfSt.body.status === 'requested',
    'GET /v1/pay/refund/status 状态=requested（申请≠已退）', rfSt.body);
  const rfNoTok = await req(walled, 'POST', '/v1/pay/refund/confirm', { orderId: oid });
  ok(rfNoTok.status === 403, '无管理令牌 refund/confirm 被拒（403）', rfNoTok.status);
  const rfC = await req(walled, 'POST', '/v1/pay/refund/confirm', { orderId: oid }, adm());
  ok(rfC.status === 200 && rfC.body && rfC.body.ok, '运营确认出款 refund/confirm', rfC.body);
  ok(rfC.body && Number(rfC.body.revokedEntitlements || 0) >= 1, '退款确认回收了本单权益（revokedEntitlements≥1）', rfC.body);
  const subAfter = await req(walled, 'GET', '/v1/subs');
  const sAfter = subAfter.body || {};
  const revoked = !sAfter.sub || Number(sAfter.sub.expireAt) <= Date.now();
  ok(revoked && sAfter.unlimited === false, '退款确认后订阅权益回收（sub 为空且 unlimited=false，不再白用）',
    { sub: sAfter.sub, unlimited: sAfter.unlimited });
  const wallBack = await req(walled, 'GET', '/v1/agents');
  ok(wallBack.status === 402, '退款后重耗分区恢复 402（权益与墙一致）', { status: wallBack.status });

  // ===== I. 免费试用 2 天（获客件，2026-10-25）=====
  section('I. 免费试用 2 天');
  ok(wallBack.body && wallBack.body.trialAvail === true,
    '撞墙 402 自带领取资格位 trialAvail=true（前端据此亮「免费试 2 天」按钮，免二次请求）', wallBack.body);
  const ft = await req(walled, 'POST', '/v1/subs/free-trial');
  ok(ft.status === 200 && ft.body && ft.body.ok === true && ft.body.days === 2,
    'POST /v1/subs/free-trial 领取成功（days=2，无需付款）', ft.body);
  const ftSub = await req(walled, 'GET', '/v1/subs');
  const fs2 = ftSub.body || {};
  const twoDays = fs2.sub && Number(fs2.sub.expireAt) > Date.now()
    && Number(fs2.sub.expireAt) <= Date.now() + 2 * 86400000 + 60000;
  ok(fs2.unlimited === true && twoDays && fs2.sub.plan === 'f2',
    '试用生效：unlimited=true 且到期 ≈ +2 天（plan=f2，不是月卡兜底）', fs2.sub);
  const passHit = await req(walled, 'GET', '/v1/agents');
  ok(passHit.status !== 402, '试用期间重耗分区放行', { status: passHit.status });
  const ft2 = await req(walled, 'POST', '/v1/subs/free-trial');
  ok(ft2.status === 400 && ft2.body && ft2.body.ok === false,
    '二次领取被拒（每人一次，服务端强校验）', ft2.body);
  const ftSt = await req(walled, 'GET', '/v1/subs/status');
  ok(ftSt.body && ftSt.body.freeTrialAvailable === false,
    'status.freeTrialAvailable=false（前端隐藏按钮依据）', ftSt.body && { freeTrialAvailable: ftSt.body.freeTrialAvailable });

  // ===== J. 收尾：关墙 =====
  section('J. 收尾');
  const t2 = await req(buyer, 'POST', '/v1/paywall/toggle', { on: false });
  ok(t2.status === 200 && t2.body && t2.body.enabled === false, 'POST /v1/paywall/toggle 关墙（还原）', t2.body);

  child.kill();
  console.log('');
  console.log('pass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E RUN ERROR:', e);
  console.log('pass=' + pass + ' fail=' + (fail + 1));
  console.log('FAILED');
  process.exit(1);
});
