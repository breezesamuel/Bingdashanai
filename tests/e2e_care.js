require('./_isolate');
// e2e_care.js — 陪护链路 HTTP 端到端回归（2026-10-24）
//
// 【为什么】regress_care.js 是进程内直调 core/care.js；server.js 的路由层
// （bd_care Cookie 身份、下载 buf 分支、迁移端点鉴权）此前只有临时脚本验过。
// 这里起真实服务进程，用三个独立"浏览器"（独立 bd_care Cookie）走真 HTTP：
//   ① 同 IP 双身份不串号（老人/子女各自 Cookie —— 同 WiFi 教训的永久回归锁）
//   ② 建档同意门 → 邀请码加入 → SOS P0 → 接单 → 闭环
//   ③ 健康档案加密落库（db.json 检索不到敏感词）
//   ④ 资料上传 CENC1 落盘 → HTTP 下载解密回原始字节
//   ⑤ 越权下载拒绝；中心/迁移端点无令牌 403、带令牌可用
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let PORT = 0;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-e2e-care-'));
let pass = 0, fail = 0;
function ok(c, label, extra) {
  pass += c ? 1 : 0; fail += c ? 0 : 1;
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined && !c ? '  ->  ' + (typeof extra === 'object' ? JSON.stringify(extra).slice(0, 240) : extra) : ''));
}
const section = (t) => { console.log(''); console.log('=== ' + t); };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeJar() { return { cookie: '' }; }
function req(jar, method, p, body, headers) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign({ 'content-type': 'application/json' }, jar.cookie ? { cookie: jar.cookie } : {}, headers || {}),
    }, (res) => {
      const sc = String(res.headers['set-cookie'] || '');
      if (sc && !jar.cookie) {
        const m = /bd_care=([^;]+)/.exec(sc);
        if (m) jar.cookie = 'bd_care=' + m[1];
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const b = Buffer.concat(chunks);
        let j = null; try { j = JSON.parse(b); } catch (e) {}
        resolve({ status: res.statusCode, body: j, raw: b, headers: res.headers });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: null, raw: Buffer.from(String(e.message)) }));
    if (data) r.write(data);
    r.end();
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, {
        BINGDASHAN_DATA_DIR: DATA, BINGDASHAN_PORT: '0', NODE_ENV: 'test',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('boot timeout: ' + buf.slice(-300))), 30000);
    const onData = (d) => {
      buf += d;
      const m = /listening http:\/\/([0-9.]+):(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[2]) }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

(async () => {
  const { child, port } = await startServer();
  PORT = port;
  const adminToken = () => {
    try { return (JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8')).settings || {}).adminToken || ''; }
    catch (e) { return ''; }
  };

  const elder = makeJar(), childJ = makeJar(), stranger = makeJar();

  // ===== A. 建档 / 双身份 =====
  section('A. 建档与双身份（同 IP 独立 Cookie）');
  const no1 = await req(elder, 'POST', '/v1/care/family/create', { elderName: 'HTTP张奶奶' });
  const fam = await req(elder, 'POST', '/v1/care/family/create', { elderName: 'HTTP张奶奶', consent: true });
  ok(no1.body && no1.body.ok === false && /同意/.test(String(no1.body.error)), '无同意不能建档（HTTP 层）');
  ok(fam.body && fam.body.ok === true && fam.body.inviteCode, '建档成功 + 邀请码');
  const fid = fam.body.family.id;
  await req(stranger, 'GET', '/v1/care/family');   // 预先给第三个浏览器发身份
  const childJoin = await req(childJ, 'POST', '/v1/care/family/join', { code: fam.body.inviteCode, consent: true, name: '张小小', relation: '孙女', phone: '13733334444' });
  ok(childJoin.body && childJoin.body.ok === true && childJoin.body.member.role === 'guardian', '子女凭码加入（不同 Cookie ≠ 同一人）');
  const elderView = await req(elder, 'GET', '/v1/care/family');
  const ev = (elderView.body.families || [])[0];
  ok(ev && ev.members.length === 2 && ev.members.every(m => !m.phone || (String(m.phone).indexOf('****') >= 0 && String(m.phone).indexOf('3333') < 0)),
    '成员列表手机号脱敏（保留尾 4 位，中段不可见）', JSON.stringify(ev && ev.members.map(m => m.phone)));

  // ===== B. SOS → 接单 → 闭环 =====
  section('B. SOS / 接单 / 闭环（HTTP）');
  const sos = await req(elder, 'POST', '/v1/care/alert', { familyId: fid, kind: 'sos', message: '胸口闷' });
  ok(sos.body && sos.body.ok === true && sos.body.severity === 'P0' && sos.body.slaMin === 5, 'SOS → P0 / 5 分钟 SLA');
  const ackS = await req(stranger, 'POST', '/v1/care/alert/ack', { id: sos.body.alert.id });
  ok(ackS.body && ackS.body.ok === false, '陌生人不能接单');
  const ack = await req(childJ, 'POST', '/v1/care/alert/ack', { id: sos.body.alert.id });
  ok(ack.body && ack.body.ok === true && ack.body.alert.status === 'acked', '子女接单成功');
  const res1 = await req(childJ, 'POST', '/v1/care/alert/resolve', { id: sos.body.alert.id, note: '' });
  ok(res1.body && res1.body.ok === false, '闭环必须写处理结果');
  const res2 = await req(childJ, 'POST', '/v1/care/alert/resolve', { id: sos.body.alert.id, note: '电话确认已休息缓解' });
  ok(res2.body && res2.body.ok === true && res2.body.alert.status === 'resolved', '写明结果后闭环成功');

  // ===== C. 档案加密落库 =====
  section('C. 健康档案加密（HTTP 层）');
  const sp = await req(elder, 'POST', '/v1/care/profile', { familyId: fid, age: 76, conditions: ['房颤'], meds: [{ name: '华法林', dose: '2.5mg', times: ['19:00'] }], emergencyContacts: [{ name: '张小小', phone: '13733334444', relation: '孙女' }] });
  ok(sp.body && sp.body.ok === true && sp.body.complete === true, '档案保存成功');
  const gp = await req(elder, 'GET', '/v1/care/profile?familyId=' + encodeURIComponent(fid));
  ok(gp.body && gp.body.ok === true && gp.body.profile.meds[0].name === '华法林', '读回解密一致（ meds[0]=华法林）');
  const dbRaw = fs.readFileSync(path.join(DATA, 'db.json'), 'utf8');
  // 加密面=健康档案字段（病史/用药）；careMembers 里的联系手机号是通知通道必需，按设计明文
  ok(dbRaw.indexOf('华法林') < 0 && dbRaw.indexOf('房颤') < 0, 'db.json 检索不到病史/用药明文（档案字段已加密）');

  // ===== D. 资料加密上传/下载 =====
  section('D. 资料上传（CENC1）与下载（解密回原始字节）');
  const up = await req(elder, 'POST', '/v1/care/doc', { familyId: fid, title: '出院小结', kind: 'discharge', dataUrl: PNG });
  ok(up.body && up.body.ok === true && up.body.doc.id, '资料上传成功');
  const dbDocs = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8')).careDocs;
  const meta = dbDocs.find(d => d.id === up.body.doc.id);
  const disk = fs.readFileSync(path.join(DATA, 'care-docs', meta.file));
  ok(disk.slice(0, 5).toString('ascii') === 'CENC1' && disk[0] !== 0x89, '磁盘为 CENC1 密文（非裸 PNG）');
  const dl = await req(elder, 'GET', '/v1/care/doc/file?id=' + encodeURIComponent(meta.id));
  ok(dl.status === 200 && dl.raw[0] === 0x89 && dl.raw.slice(1, 4).toString('ascii') === 'PNG'
    && Number(dl.headers['content-length']) === dl.raw.length, 'HTTP 下载解密回原始 PNG（Content-Length 如实）',
    { len: dl.headers['content-length'], real: dl.raw.length });
  const dlStranger = await req(stranger, 'GET', '/v1/care/doc/file?id=' + encodeURIComponent(meta.id));
  ok(dlStranger.body && dlStranger.body.ok === false, '非成员下载被拒');

  // ===== E. 中心 / 体检 / 迁移端点鉴权 =====
  section('E. 运营端点（管理令牌）');
  const c403 = await req(elder, 'GET', '/v1/care/center');
  ok(c403.status === 403, '中心无令牌 403');
  await req(elder, 'GET', '/v1/wall/stats');  // 触发令牌惰性生成
  const tokH = { 'x-admin-token': adminToken() };
  const c200 = await req(elder, 'GET', '/v1/care/center', null, tokH);
  ok(c200.body && c200.body.ok === true && c200.body.families >= 1, '中心带令牌可用（家庭数≥1）');
  const lp = await req(elder, 'GET', '/v1/care/loop', null, tokH);
  const ids = (lp.body && lp.body.checks || []).map(c => c.id);
  ok(['robot_no_heartbeat_24h', 'chronic_no_doc', 'guardian_no_response_30d', 'consent_expired', 'health_data_unencrypted']
    .every(id => ids.indexOf(id) >= 0), '体检含 5 个新断点', JSON.stringify(ids));
  ok(lp.body && lp.body.privacy && lp.body.privacy.profileEncryption.available === true, '体检带 privacy.profileEncryption（可用）');
  const m403 = await req(elder, 'POST', '/v1/care/profile/migrate', {});
  ok(m403.status === 403, '迁移无令牌 403');
  const m200 = await req(elder, 'POST', '/v1/care/profile/migrate', {}, tokH);
  ok(m200.body && m200.body.ok === true && m200.body.profiles && m200.body.profiles.failed === 0, '迁移带令牌可用（幂等）', m200.body);

  child.kill();
  console.log('');
  console.log('pass=' + pass + ' fail=' + fail);
  console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('E2E CARE RUN ERROR:', e);
  console.log('pass=' + pass + ' fail=' + (fail + 1));
  console.log('FAILED');
  process.exit(1);
});
