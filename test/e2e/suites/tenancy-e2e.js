// test/e2e/suites/tenancy-e2e.js — 访客数据归属层（"我的沉淀"）
//
// 守护的纪律（都是真出过事的）：
//   1. 资产归属必须**按访客隔离**：A 的沉淀绝不进 B 的列表（隐私 + 信任）。
//   2. 归属一旦打上就不能被改写（记录只有一个主人），且冲突要留审计。
//   3. 【诚实红线】续费理由只许陈述真实收益。到期只收起订阅时长，数据从不删除
//      —— 所以绝不允许出现"保住/失去/删掉"这类假威胁。用恐吓留人，
//      用户换设备登录发现数据还在，信任一次性归零。
//   4. 未归属的老记录不会被硬塞给任何访客。
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const { requireIsolated } = require('./_guard');
const http = require('http');
const store = require(ROOT + '/core/store');
const subs = require(ROOT + '/core/subs');
const tenancy = require(ROOT + '/core/tenancy');
const BASE = requireIsolated('tenancy-e2e');
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

(async () => {
  // 两个互不相干的访客（服务端签名身份，不是伪造）
  // verify() 把签名句柄还原成真正的身份键——归属记录里存的是这个身份键，不是句柄本身。
  const A = subs.issue('tenancy-e2e-A-' + Date.now()).vid;
  const B = subs.issue('tenancy-e2e-B-' + Date.now()).vid;
  const IDA = subs.verify(A), IDB = subs.verify(B);
  const HA = { 'X-Visitor': A }, HB = { 'X-Visitor': B };

  // 0) OWNABLE 口径固定：只有这 5 类可归属
  T('可归属集合固定为 5 类', JSON.stringify(tenancy.OWNABLE) === JSON.stringify(['decisions', 'knowledge', 'reports', 'messages', 'lessons']),
    JSON.stringify(tenancy.OWNABLE));

  // 1) A 沉淀一条决策
  const mk = (await req('POST', '/v1/decisions', {
    question: '归属测试：A 的第一个决策问题？',
    answer: '答案A：先跑通再放大。', engine: 'manual', source: 'manual'
  }, HA)).body;
  T('A 成功写入决策', mk.ok === true && !!mk.decision, JSON.stringify(mk).slice(0, 120));
  T('写入即带上 visitor 归属', !!mk.decision && mk.decision.visitor === IDA,
    'visitor=' + (mk.decision && mk.decision.visitor));

  // 2) A 的资产盘点包含它
  const ma = (await req('GET', '/v1/my/assets', null, HA)).body;
  const sa = (ma.summary || {});
  T('A 的资产盘点 >= 1', sa.ok === true && sa.total >= 1, 'total=' + sa.total);
  T('A 的决策计数 >= 1', (sa.byCollection || {}).decisions >= 1, JSON.stringify(sa.byCollection || {}));
  T('A 的资产清单含刚写入的那条', (ma.decisions || []).some(d => d.id === (mk.decision || {}).id));

  // 3) B 看不到 A 的沉淀（隔离）
  const mb = (await req('GET', '/v1/my/assets', null, HB)).body;
  const sb = (mb.summary || {});
  T('B 的决策计数为 0（A 的沉淀不泄漏给 B）', (sb.byCollection || {}).decisions === 0, JSON.stringify(sb.byCollection || {}));
  T('B 的清单不含 A 的决策', !(mb.decisions || []).some(d => d.id === (mk.decision || {}).id));

  // 4) 未归属的老记录不硬塞给任何人
  const orphanRec = store.push('decisions', { question: '无归属的老决策', answer: '历史遗留', engine: 'manual', source: 'manual' }, 'tenancy-e2e 夹具', '无归属老记录');
  const ma2 = (await req('GET', '/v1/my/assets', null, HA)).body;
  T('无归属老决策不计入 A 的资产', !(ma2.decisions || []).some(d => d.id === orphanRec.id));

  // 5) 归属不可改写 + 冲突留审计
  const before = (store.list('decisions', 999).find(x => x.id === (mk.decision || {}).id) || {});
  const after = tenancy.markOwned('decisions', Object.assign({}, before), IDB);
  T('归属冲突拒绝改写（记录只有一个主人）', after.visitor === IDA, 'visitor=' + after.visitor);
  const conflictAudit = (store.list('audit', 999) || []).some(x => /数据归属冲突/.test(x.action || ''));
  T('归属冲突写入审计', conflictAudit);
  const ma3 = (await req('GET', '/v1/my/assets', null, HA)).body;
  T('冲突后 A 仍拥有该条', (ma3.decisions || []).some(d => d.id === (mk.decision || {}).id));

  // 6) 【诚实红线】话术里不许出现假威胁
  const msg = String(sa.message || '') + ' ' + String(sa.renewAnchor || '');
  T('话术不得声称"保住"（数据不会消失，不能拿它施压）', msg.indexOf('保住') < 0, msg.slice(0, 120));
  T('话术不得声称"失去"/"删除"', msg.indexOf('失去') < 0 && msg.indexOf('删除') < 0, msg.slice(0, 120));
  T('有资产时 renewAnchor 必须明说"不会因到期被清掉"',
    sa.hasAssets === true && String(sa.renewAnchor || '').indexOf('不会因到期被清掉') >= 0,
    JSON.stringify(sa.renewAnchor));
  T('有资产时 message 说明"挂在你的账号下"', String(sa.message || '').indexOf('挂在你的账号下') >= 0, sa.message);

  // 7) 空资产的访客拿到的是引导，不是恐吓
  const C = subs.issue('tenancy-e2e-C-' + Date.now()).vid;
  const mc = (await req('GET', '/v1/my/assets', null, { 'X-Visitor': C })).body;
  const sc = mc.summary || {};
  T('空资产访客 hasAssets=false', sc.hasAssets === false, 'total=' + sc.total);
  T('空资产时 renewAnchor 为空（没有可威胁的东西）', !sc.renewAnchor, JSON.stringify(sc.renewAnchor));
  T('空资产话术是引导而非恐吓', String(sc.message || '').indexOf('多问几个问题') >= 0, sc.message);

  // 8) reports 归属：A 生成报告，B 看不到
  const rpt = (await req('POST', '/v1/report/seven', { topic: '归属测试报告', answer: '这是测试答案' }, HA)).body;
  T('A 生成报告成功', rpt.ok === true && !!rpt.report, JSON.stringify(rpt).slice(0, 120));
  const maR = (await req('GET', '/v1/my/assets', null, HA)).body;
  const saR = maR.summary || {};
  T('A 的资产盘点含 reports', (saR.byCollection || {}).reports >= 1, JSON.stringify(saR.byCollection || {}));
  T('A 的 reports 清单含刚生成的', (maR.reports || []).some(x => x.id === (rpt.report || {}).id));
  const mbR = (await req('GET', '/v1/my/assets', null, HB)).body;
  T('B 的 reports 计数为 0', ((mbR.summary || {}).byCollection || {}).reports === 0, JSON.stringify((mbR.summary || {}).byCollection || {}));

  // 9) lessons 归属：A 记录经验，B 看不到
  const les = (await req('POST', '/v1/lessons', { topic: '归属测试经验', context: '测试上下文', action: '测试动作', why: '测试原因', src: 'manual', evidence: ['test-evid'] }, HA)).body;
  T('A 记录经验成功', les.ok === true && !!les.lesson, JSON.stringify(les).slice(0, 120));
  const maL = (await req('GET', '/v1/my/assets', null, HA)).body;
  const saL = maL.summary || {};
  T('A 的资产盘点含 lessons', (saL.byCollection || {}).lessons >= 1, JSON.stringify(saL.byCollection || {}));
  T('A 的 lessons 清单含刚记录的', (maL.lessons || []).some(x => x.id === (les.lesson || {}).id));
  const mbL = (await req('GET', '/v1/my/assets', null, HB)).body;
  T('B 的 lessons 计数为 0', ((mbL.summary || {}).byCollection || {}).lessons === 0, JSON.stringify((mbL.summary || {}).byCollection || {}));

  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  require('./_exit').finish(fail ? 1 : 0);
})().catch(e => { console.log('FAIL 套件异常: ' + (e && e.stack || e)); console.log('===== ' + pass + ' PASS / ' + (fail + 1) + ' FAIL ====='); require('./_exit').finish(1); });
