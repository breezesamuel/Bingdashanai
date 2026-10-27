// test/e2e/suites/license-e2e.js — 授权码（下载版的"订阅墙"）端到端
//
// 守护的纪律（每一条都对应一个真会丢钱的缺口）：
//   1. 客户端只有公钥：篡改过 / 攻击者自签的授权码必须被拒。
//   2. 激活要真的换出权益：激活后既有闸门（subs.status/gate）必须直接放行，
//      否则"提示激活成功、实际还要付费"就是假闭环。
//   3. 机器绑定与防复用必须真生效：绑了别的机器不给过；同一枚码不能给第二个账号。
//   4. 过期码要拒，且说清到期时间（不能静默失败）。
//   5. 签发/配公钥是运营端能力，必须带令牌。
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { requireIsolated } = require('./_guard');
const http = require('http');
const store = require(ROOT + '/core/store');
const subs = require(ROOT + '/core/subs');
const lic = require(ROOT + '/core/license');
const BASE = requireIsolated('license-e2e');
const ADMIN = process.env.BINGDASHAN_ADMIN_TOKEN || '';

let pass = 0, fail = 0;
function T(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? ' . ' + detail : '')); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' . ' + detail : '')); }
}
function req(method, p, body, extra) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (ADMIN) h['X-Admin-Token'] = ADMIN;
    Object.assign(h, extra || {});
    const r = http.request(BASE + p, { method, headers: h }, resp => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => { try { res({ code: resp.statusCode, body: JSON.parse(d) }); } catch (e) { res({ code: resp.statusCode, body: { raw: d } }); } });
    });
    r.end(data || undefined);
  });
}
const uniq = n => n + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
const vid = tag => subs.issue(uniq('license-e2e-' + tag)).vid;
const bare = v => subs.verify(v);
const unlimitedOf = v => subs.status(bare(v)).unlimited === true;
function rawSign(privB64, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(body), crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64url'), format: 'der', type: 'pkcs8' })).toString('base64url');
  return 'BDS1-' + body + '.' + sig;
}

(async () => {
  // ── 0) 造签发密钥，只把公钥配到服务端（私钥留在运营端）──
  const kp = lic.genKeyPair();
  const cfg = await req('POST', '/v1/license/config', { publicKey: kp.pub });
  T('运营端可配置签发公钥', cfg.code === 200 && cfg.body.ok === true, JSON.stringify(cfg.body).slice(0, 100));
  T('配置接口拒绝错误令牌', (await req('POST', '/v1/license/config', { publicKey: kp.pub }, { 'X-Admin-Token': 'wrong-' + Date.now() })).code === 403);
  T('公钥配置后 pubConfigured=true', lic.pubConfigured() === true);
  // 服务端是**独立进程**：要它能签发，就得让它数据目录里有私钥
  // （私钥来源顺序：env → 数据目录 license.key → 仓库根 license.key，见 core/license.js）。
  const keyPath = lic.dataFile('license.key');
  fs.rmSync(keyPath, { force: true, recursive: true });   // 防上次运行残留同名目录（store.dataPath 的老坑）
  fs.writeFileSync(keyPath, kp.priv + '\n', { mode: 0o600 });
  process.env.BINGDASHAN_LICENSE_KEY = kp.priv;   // 本进程也扮演运营方，便于直接调 lic.issue
  T('私钥落在数据目录（推荐位置，不进仓库）', fs.existsSync(keyPath));

  // ── 1) 未激活 ──
  const A = vid('A'); const HA = { 'X-Visitor': A };
  const s0 = (await req('GET', '/v1/license/status', null, HA)).body;
  T('未激活：activated=false', s0.activated === false, JSON.stringify(s0.license));
  T('未激活：subscribed=false', s0.subscribed === false);
  T('未激活也返回机器指纹（用于绑定/报机器码）', typeof s0.fingerprint === 'string' && s0.fingerprint.length >= 16, s0.fingerprint);
  T('运营端本机 clientMode=false', s0.clientMode === false);
  T('未激活时既有闸门仍是受限的', unlimitedOf(A) === false);

  // ── 2) 正常签发 → 激活 → 权益真的生效 ──
  const m = lic.issue({ plan: 'm', who: 'buyer@example.com' });
  const rAct = await req('POST', '/v1/license/activate', { key: m.key }, HA);
  T('月度授权码激活成功', rAct.code === 200 && rAct.body.activated === true, JSON.stringify(rAct.body).slice(0, 110));
  T('激活后既有闸门直接放行（unlimited=true）', unlimitedOf(A) === true);
  T('激活回传授权内容（plan/id/到期）', !!(rAct.body.license && rAct.body.license.id === m.payload.id && rAct.body.license.plan === 'm'), JSON.stringify(rAct.body.license));
  T('剩余天数≈30', rAct.body.license && rAct.body.license.daysLeft >= 29 && rAct.body.license.daysLeft <= 31, 'daysLeft=' + (rAct.body.license || {}).daysLeft);
  T('激活写入审计', store.list('audit', 999).some(x => /授权码激活/.test(x.action || '')));

  // ── 3) 篡改 / 攻击者自签 一律拒绝 ──
  const tampered = m.key.slice(0, -6) + (m.key.endsWith('AAAAAA') ? 'BBBBBB' : 'ZZZZZZ');
  const rTamper = await req('POST', '/v1/license/activate', { key: tampered }, { 'X-Visitor': vid('tamper') });
  T('被改过的授权码：拒绝（签名无效）', rTamper.code === 400 && rTamper.body.code === 'BAD_SIGN', JSON.stringify(rTamper.body).slice(0, 110));
  const rFmt = await req('POST', '/v1/license/activate', { key: 'not-a-key' }, { 'X-Visitor': vid('fmt') });
  T('格式不对：拒绝', rFmt.code === 400 && rFmt.body.code === 'BAD_FORMAT', JSON.stringify(rFmt.body).slice(0, 110));
  const evil = lic.genKeyPair();
  const evilKey = rawSign(evil.priv, { v: 1, id: 'evil', plan: 'y', iat: Date.now(), exp: Date.now() + 3650 * 86400000, fp: null });
  const rEvil = await req('POST', '/v1/license/activate', { key: evilKey }, { 'X-Visitor': vid('evil') });
  T('攻击者用自己私钥自签：无效（公钥验签兜住）', rEvil.code === 400 && rEvil.body.code === 'BAD_SIGN', JSON.stringify(rEvil.body).slice(0, 110));

  // ── 4) 机器绑定 ──
  const myFp = lic.machineFingerprint();
  const B = vid('B');
  const rBindOk = await req('POST', '/v1/license/activate', { key: lic.issue({ plan: 'q', fp: myFp }).key }, { 'X-Visitor': B });
  T('绑定本机的授权码可激活', rBindOk.code === 200 && rBindOk.body.activated === true, JSON.stringify(rBindOk.body).slice(0, 110));
  T('绑定激活后权益生效', unlimitedOf(B) === true);
  const C = vid('C');
  const rBindOther = await req('POST', '/v1/license/activate', { key: lic.issue({ plan: 'q', fp: 'deadbeefdeadbeefdeadbeefdeadbeef' }).key }, { 'X-Visitor': C });
  T('绑定他机的授权码在本机被拒', rBindOther.code === 400 && rBindOther.body.code === 'FP_MISMATCH', JSON.stringify(rBindOther.body).slice(0, 130));
  T('被拒后未获得权益', unlimitedOf(C) === false);

  // ── 5) 防复用 ──
  const reusable = lic.issue({ plan: 'm' });
  const D = vid('D'), E = vid('E');
  const rD = await req('POST', '/v1/license/activate', { key: reusable.key }, { 'X-Visitor': D });
  const rE = await req('POST', '/v1/license/activate', { key: reusable.key }, { 'X-Visitor': E });
  T('第一账号激活成功', rD.code === 200 && rD.body.activated === true);
  T('第二账号复用同码被拒（REUSED）', rE.code === 400 && rE.body.code === 'REUSED', JSON.stringify(rE.body).slice(0, 130));
  T('第二账号未获权益', unlimitedOf(E) === false);

  // ── 6) 过期码 ──
  const expiredKey = rawSign(kp.priv, { v: 1, id: 'expired-1', plan: 'm', iat: Date.now() - 40 * 86400000, exp: Date.now() - 3 * 86400000, fp: null });
  const F = vid('F');
  const rExp = await req('POST', '/v1/license/activate', { key: expiredKey }, { 'X-Visitor': F });
  T('过期授权码被拒（EXPIRED）', rExp.code === 400 && rExp.body.code === 'EXPIRED', JSON.stringify(rExp.body).slice(0, 130));
  T('过期提示写明到期时间', /到期/.test(String(rExp.body.error || '')), String(rExp.body.error || '').slice(0, 80));
  T('过期后未获权益', unlimitedOf(F) === false);

  // ── 7) inspect：只验不改 ──
  const G = vid('G');
  const rIns = await req('POST', '/v1/license/inspect', { key: lic.issue({ plan: 'm' }).key }, { 'X-Visitor': G });
  T('inspect 验签通过并回传内容', rIns.code === 200 && rIns.body.ok === true && rIns.body.payload && rIns.body.payload.plan === 'm', JSON.stringify(rIns.body).slice(0, 110));
  T('inspect 不给权益（只看不激活）', unlimitedOf(G) === false);
  T('inspect 对坏码返回 400', (await req('POST', '/v1/license/inspect', { key: 'garbage' })).code === 400);

  // ── 8) 解绑 ──
  const rDe = await req('POST', '/v1/license/deactivate', null, { 'X-Visitor': B });
  T('解绑返回 ok', rDe.code === 200 && rDe.body.ok === true, JSON.stringify(rDe.body).slice(0, 100));
  T('解绑后 activated=false', rDe.body.activated === false);
  T('解绑后权益收回（可换机重激活）', unlimitedOf(B) === false);
  const reActB = await req('POST', '/v1/license/activate', { key: lic.issue({ plan: 'm', fp: myFp }).key }, { 'X-Visitor': B });
  T('解绑后可再次激活', reActB.code === 200 && reActB.body.activated === true);

  // ── 9) 运营能力必须带令牌；私钥缺失要给出可执行指引而不是 500 ──
  const cfgGet = (await req('GET', '/v1/license/config', null)).body;
  T('config 自检：公钥已配 + 私钥就绪', cfgGet.ok === true && cfgGet.configured === true && cfgGet.signingReady === true, JSON.stringify(cfgGet).slice(0, 150));
  const rIssueOk = await req('POST', '/v1/license/issue', { plan: 'm' });
  T('签发接口：正确令牌可用', rIssueOk.code === 200 && /^BDS1-/.test(String(rIssueOk.body.key || '')), JSON.stringify(rIssueOk.body).slice(0, 120));
  T('签发接口：错误令牌 403', (await req('POST', '/v1/license/issue', { plan: 'm' }, { 'X-Admin-Token': 'nope-' + Date.now() })).code === 403);
  T('配置接口：错误令牌 403', (await req('POST', '/v1/license/config', { publicKey: kp.pub }, { 'X-Admin-Token': 'nope-' + Date.now() })).code === 403);
  fs.rmSync(keyPath, { force: true, recursive: true });   // 临时撤掉私钥
  const rNoKey = await req('POST', '/v1/license/issue', { plan: 'm' });
  T('无私钥时签发明确报错（NO_PRIVKEY，不静默）', rNoKey.code === 400 && rNoKey.body.code === 'NO_PRIVKEY', 'code=' + rNoKey.code + ' ' + JSON.stringify(rNoKey.body).slice(0, 90));
  T('无私钥时 config 自检 signingReady=false', (await req('GET', '/v1/license/config', null)).body.signingReady === false);
  fs.writeFileSync(keyPath, kp.priv + '\n', { mode: 0o600 });   // 恢复
  T('恢复私钥后可再次签发', (await req('POST', '/v1/license/issue', { plan: 't' })).code === 200);

  // ── 10) 收尾：A 的权益不能被测试步骤误清 ──
  T('收尾：A 仍持有权益', unlimitedOf(A) === true);

  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  require('./_exit').finish(fail ? 1 : 0);
})().catch(e => { console.log('FAIL 套件异常: ' + (e && e.stack || e)); console.log('===== ' + pass + ' PASS / ' + (fail + 1) + ' FAIL ====='); require('./_exit').finish(1); });
