const { finish } = require('./_exit');
const { requireIsolated } = require('./_guard');
const { freePort } = require('../../../scripts/_port');
const http = require('http');
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const store = require(ROOT + '/core/store');
const BASE = requireIsolated('outreach-e2e');
const ADMIN = process.env.BINGDASHAN_ADMIN_TOKEN || '';

let pass = 0, fail = 0;
function T(name, ok, extra) {
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' . ' + extra : ''));
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
  const done = new Promise(r => { doneTimer = setTimeout(r, 120000, 'TIMEOUT'); });
  const run = (async () => {
    const snap = JSON.stringify(store.read());
    const received = [];
    const HOOK_PORT = await freePort(18329);
    const hook = http.createServer((rq, rs) => {
      let d = ''; rq.on('data', c => d += c); rq.on('end', () => {
        let b = {}; try { b = JSON.parse(d); } catch (e) { b = { raw: d }; }
        received.push({ url: rq.url, body: b });
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({ ok: true, echoed: new Date().toISOString() }));
      });
    });
    await new Promise(r2 => hook.listen(HOOK_PORT, '127.0.0.1', r2));
    try {
      const leadData = email => ({
        name: 'e2e/' + email.split('@')[0], company: 'E2E ' + email.split('@')[0],
        repo: 'e2e/outreach-' + email.split('@')[0], industry: 'AI',
        signal: 80, source: 'e2e 触达用例', stage: '促单', status: 'new',
        path: 'leadgen', topics: ['mcp', 'agent'], url: 'https://github.com/e2e/outreach',
        note: 'e2e outreach', touch: 0, tries: 0, planned: 1, sentN: 0, email
      });

      // ── 初始诚实态：默认开关关闭 ──
      const st0 = (await req('GET', '/v1/outreach')).body;
      T('outreach status endpoint public', st0.ok === true, 'enabled=' + st0.enabled);
      T('outreach disabled by default (honest no-fire)', st0.enabled === false);

      // ── 配置：开启 + webhook 通道 + 回复令牌 + 秘密凭据（经管理员端点）──
      const cfg = await req('POST', '/v1/outreach/config', {
        outreachEnabled: true,
        outreachWebhookUrl: 'http://127.0.0.1:' + HOOK_PORT + '/hook',
        outreachWebhookChannel: '企业微信',
        outreachReplyToken: 'rt-secret-token',
        smtpHost: 'smtp.qq.com', smtpPort: 465, smtpUser: 'a@b.com', smtpPass: 'secretpass1234',
        outreachDailyCap: 20, outreachMaxPerLead: 3, outreachCooldownH: 1
      });
      T('config applies outreach+secrets', cfg.body.ok === true, JSON.stringify(cfg.body.rejected || []));
      const cfgM = (await req('GET', '/v1/outreach/config')).body.config;
      T('config get masks smtpPass (no plaintext leak)', cfgM.smtpPass && cfgM.smtpPass.indexOf('secretpass1234') < 0, 'mask=' + cfgM.smtpPass);
      const st1 = (await req('GET', '/v1/outreach')).body;
      T('status reflects webhook transport', st1.enabled === true && st1.transport && st1.transport.kind === 'webhook', JSON.stringify(st1.transport));

      // ── 隔离：把**本套件之前**就存在的可发线索全部推入冷却 ──
      // runner 让所有套件共用同一个沙箱，前面的 autopilot/leadfunnel 等会留下
      // 处于「促单」且带邮箱的线索。runOnce 每轮最多发 3 条，会把这些历史线索
      // 一起发出去，于是：
      //   · received[0] 不一定是本套件的 A → 收件人断言随执行顺序漂移
      //   · webhookHits 全局计数 > 1 → 「不得重复外发」永远红
      // 这类失败与被测代码无关，纯粹是测试之间互相污染。
      // 处理：把历史线索的 lastSentAt 推到冷却窗口之外（不是删数据，只是不参与本轮）。
      {
        const iso = store.read();
        const FAR = Date.now() + 3650 * 86400000;
        let neutralized = 0;
        (iso.leads || []).forEach(l => {
          if (l.stage === '促单' && !l.muted) { l.lastSentAt = FAR; neutralized++; }
        });
        store.write(iso);
        T('isolation neutralized pre-existing 促单 leads', neutralized >= 0, 'neutralized=' + neutralized);
      }

      // ── 播种线索：A 待发，B 屏蔽，C 冷却中（做退订测试），D 无联系邮箱（已缓存为无）──
      const la = store.push('leads', leadData('lead-a@test.local'), 'e2e 播种');
      const lb = store.push('leads', leadData('lead-b@test.local'), 'e2e 播种');
      const lc = store.push('leads', Object.assign(leadData('lead-c@test.local'), { lastSentAt: Date.now() }), 'e2e 播种');
      const ld = leadData('');
      store.push('leads', ld, 'e2e 播种');
      const dCached = store.read();
      dCached.contactCache = dCached.contactCache || {};
      dCached.contactCache[ld.id] = { ok: false, email: '', source: 'no-contact', checkedAt: Date.now() };
      store.write(dCached);

      T('seeded 4 outreach leads', store.read().leads.filter(l => l.stage === '促单').length >= 4);

      await req('POST', '/v1/outreach/mute', { id: lb.id, mute: true });
      T('mute hides a lead from outbound', (store.read().leads.find(l => l.id === lb.id)).muted === true);

      // ── 第一轮真实外发：只有 A 被发出（B 屏蔽、C 冷却、D 无邮箱）──
      const r1 = (await req('POST', '/v1/outreach/run', {})).body;
      T('run#1 sent exactly the one eligible lead', r1.sent === 1, 'sent=' + r1.sent + ' noContact=' + (r1.skipped && r1.skipped.noContact));
      T('webhook actually received the outward message', received.filter(x => x.url === '/hook').length >= 1);
      const w1 = received[0] && received[0].body;
      T('webhook payload carries the real recipient', w1 && w1.to === 'lead-a@test.local', 'to=' + (w1 && w1.to));
      T('webhook payload carries generated subject/html', w1 && !!w1.subject && !!w1.html, 'subj=' + (w1 && w1.subject));

      const la1 = store.read().leads.find(l => l.id === la.id);
      T('first real delivery counts as real touch (touch=1)', Number(la1.touch) === 1, 'touch=' + la1.touch);
      T('sentN tracks the delivery', Number(la1.sentN) === 1, 'sentN=' + la1.sentN);
      T('lead stays in 促单 waiting for human reply', la1.stage === '促单', la1.stage);
      const st2 = (await req('GET', '/v1/outreach')).body;
      T('daily counter increments', st2.today.sentToday >= 1, 'sentToday=' + st2.today.sentToday);

      // ── 回复门禁：令牌错误必拒；令牌正确 + 已送达 → 商机候选 ──
      const bad = (await req('POST', '/v1/outreach/reply', { token: 'wrong', leadId: la.id, text: '想了解' })).body;
      T('reply rejects wrong token even on loopback', bad.ok === false, JSON.stringify(bad));
      const okR = (await req('POST', '/v1/outreach/reply', { token: 'rt-secret-token', leadId: la.id, text: '有兴趣，约个时间聊聊' })).body;
      T('reply ingests and promotes to 商机候选', okR.ok === true && okR.promoted === true, JSON.stringify(okR));
      const la2 = store.read().leads.find(l => l.id === la.id);
      T('promoted lead gated at 2 real touches', Number(la2.touch) === 2 && la2.touchesAtGate === 2, 'touch=' + la2.touch + ' gate=' + la2.touchesAtGate);
      T('reply boosts signal with cap', Number(la2.signal) === 86, 'signal=' + la2.signal);
      T('商机候选 requires human confirm, no fabricated amount', la2.stage === '商机候选' && la2.needHuman === true && (la2.deal === null || la2.deal === undefined));

      // ── 退订：客户说退 → 屏蔽，不再外发 ──
      const opt = (await req('POST', '/v1/outreach/reply', { token: 'rt-secret-token', leadId: lc.id, text: '请退订，别再发了' })).body;
      T('opt-out reply mutes the lead', opt.ok === true && opt.muted === true, JSON.stringify(opt));
      T('opt-out persisted on lead', (store.read().leads.find(l => l.id === lc.id)).muted === true);

      // ── 第二轮：无人可发（A 已晋级、B 屏蔽、C 退订、D 无邮箱）──
      const r2 = (await req('POST', '/v1/outreach/run', {})).body;
      T('run#2 sends nothing (no fabricated reuse)', r2.sent === 0, 'sent=' + r2.sent + ' noContact=' + (r2.skipped && r2.skipped.noContact));
      const wN = received.filter(x => x.url === '/hook').length;
      T('no spam on repeat run', wN <= 1, 'webhookHits=' + wN);

      // ── 日配额记账：一轮发多条时，计数必须恰好等于实发条数 ──
      // 【双向回归】轮次内 `sent++; sentToday++;` 就在循环体里，
      // 因此 db.outreach.sent = sentToday + 1 本身就是「本轮累计到第几条」的准确值。
      // 用「恰好等于」而不是「>=」，把两个方向都锁死：
      //   · 少记（恒记 1）→ 日配额虚低 → 重复骚扰客户
      //   · 多记（再叠一个本轮偏移 sent）→ 日配额虚高 → 提前触顶、白白少发
      // 「run#1 sent=1」的场景两种写法结果相同，抓不到任何一种，
      // 所以必须单独开一轮发多条的场景。
      {
        const s0 = (store.read().outreach || {}).sent || 0;
        for (const em of ['q-1@test.local', 'q-2@test.local', 'q-3@test.local']) {
          store.push('leads', leadData(em), 'e2e 配额夹具');
        }
        const rq = (await req('POST', '/v1/outreach/run', {})).body;
        T('一轮发出多条', rq.sent === 3, 'sent=' + rq.sent);
        const s1 = (store.read().outreach || {}).sent || 0;
        T('日配额恰好按实发条数累加（不多记也不少记）',
          Number(s1) - Number(s0) === 3, 'delta=' + (Number(s1) - Number(s0)) + ' s0=' + s0 + ' s1=' + s1);
        const rq2 = (await req('POST', '/v1/outreach/run', {})).body;
        T('第二轮不再外发（配额已正确记账）', rq2.sent === 0, 'sent=' + rq2.sent);
      }

      // ── 自检邮件：真实通道探测 ──
      const tt = (await req('POST', '/v1/outreach/test', { to: 'probe@test.local' })).body;
      T('sendTest flows through the same real channel', tt.ok === true && tt.channel === '企业微信', JSON.stringify(tt));
      const wl = received[received.length - 1] && received[received.length - 1].body;
      T('test payload reaches the relay', wl && wl.to === 'probe@test.local', 'to=' + (wl && wl.to));

      // ── 秘密不回显：/v1/settings 拒绝写入；/v1/status 不泄露 ──
      const sp = (await req('POST', '/v1/settings', { smtpPass: 'HACKED', outreachReplyToken: 'HACKED2' })).body;
      T('protected secrets rejected by public settings write',
        (sp.rejected || []).some(x => x.key === 'smtpPass') && (sp.rejected || []).some(x => x.key === 'outreachReplyToken'),
        JSON.stringify((sp.rejected || []).map(x => x.key)));
      T('settings response never echoes secrets', !sp.settings || (sp.settings.smtpPass === undefined && sp.settings.outreachReplyToken === undefined));
      const statusBody = (await req('GET', '/v1/status')).body;
      T('/v1/status masks outreach secrets', statusBody.settings && statusBody.settings.smtpPass === undefined && statusBody.settings.outreachReplyToken === undefined);
    } finally {
      try { store.write(JSON.parse(snap)); } catch (e) {}
      try { hook.close(); } catch (e) {}
    }
  })();
  const r = await Promise.race([run, done]);
  clearTimeout(doneTimer);
  if (r === 'TIMEOUT') { fail++; console.log('FAIL TIMEOUT'); }
  console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  if (fail) { console.error('FAILED'); process.exit(1); }
  finish(fail ? 1 : 0);
})();