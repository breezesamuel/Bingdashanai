const { finish } = require('./_exit');
const { requireIsolated } = require('./_guard');
const http = require('http');
const BASE = requireIsolated('biz-e2e');

let pass = 0, fail = 0, V = '';
// 沙箱管理令牌：/v1/subs/confirm 走 adminAuthedStrict（回环也强制）。
// 本套件的 confirm 是 5 条断言的前置（confirm → 墙解除 → 报告解锁 → KPI 计营收 → trial 核销），
// 令牌一缺就是「一红带五红」，症状看着像 5 个独立 bug，其实同一个根因。
const ADMIN = process.env.BINGDASHAN_ADMIN_TOKEN || '';
function req(method, p, body, visitor, extraHeaders, opts) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json', 'X-Visitor': visitor || V };
    // 默认带管理令牌（/v1/subs/confirm 等运营端点需要）。
    // opts.noAdmin=true 时**不带**：收费墙断言必须以公网访客身份发，否则回环会被当成运营。
    if (ADMIN && !(opts && opts.noAdmin)) h['X-Admin-Token'] = ADMIN;
    Object.assign(h, extraHeaders || {});
    const r = http.request(BASE + p, { method, headers: h }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { res({ code: resp.statusCode, body: JSON.parse(d) }); } catch (e) { res({ code: resp.statusCode, body: { raw: d } }); } });
    }); r.end(data || undefined);
  });
}
const T = (name, ok, extra) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' . ' + extra : ';')); };
// 公网访客视角：伪造代理头（模拟经 nginx 的公开请求）→ 服务端 isLoopback=false、adminAuthed=false，
// 收费墙才会真正生效；且不带管理令牌。回环直连会被当成运营，永远测不到 402。
function reqPublic(method, p, body, visitor, extra) {
  return req(method, p, body, visitor, Object.assign({ 'X-Forwarded-For': '203.0.113.9' }, extra || {}), { noAdmin: true });
}

(async () => {
  const id = (await req('POST', '/v1/subs/identity', { key: 'bize2e-' + Date.now() })).body;
  V = id.vid;
  T('signed identity issued', !!id.vid && id.vid.includes('.'));
  // 【前置条件必须自证】收费墙开关默认是**暂停**（core/paywall.js 注释、paywallState 默认关）。
  // 暂停时 gate()/gateSection() 一律旁路，report/seven 只会 200，下面三条 402 断言永远不可能过。
  // 之前这三条一直在红，根因就是"拿一个关掉的闸门断言它会拦人"。这里显式开闸，测完立刻复位。
  await req('POST', '/v1/paywall/toggle', { on: true });
  // 关键回归：底层 key 以 internal 开头也不得特权；额度耗尽后照常 402。
  const idI = (await req('POST', '/v1/subs/identity', { key: 'internal-fake-' + Date.now() })).body;
  for (let i = 0; i < 10; i++) await req('POST', '/v1/subs/gate', { key: idI.vid });
  const iSev = await reqPublic('POST', '/v1/report/seven', { topic: 'internal 前缀伪造', answer: '' }, idI.vid);
  T('internal-prefix key walled after quota', iSev.code === 402, 'code=' + iSev.code);
  for (let i = 0; i < 10; i++) await req('POST', '/v1/subs/gate', { key: V });
  const st = (await req('GET', '/v1/subs/status')).body;
  T('paywall quota exhausted -> wall', !!st.wall, 'freeLeft=' + st.freeLeft);
  const sev = await reqPublic('POST', '/v1/report/seven', { topic: '被裁后立刻回老家吗', answer: '补充' });
  T('report/seven blocked 402', sev.code === 402 && sev.body.wall, 'code=' + sev.code);
  const sevX = await reqPublic('POST', '/v1/report/seven', { topic: '伪造 X-Internal 头', answer: '' }, null, { 'X-Internal': '1' });
  T('forged X-Internal header still 402', sevX.code === 402, 'code=' + sevX.code);
  // 复位闸门：本套件只借用它验证"访客会被 402 拦"，后续套件不应被这层墙影响。
  await req('POST', '/v1/paywall/toggle', { on: false });
  // 定价断言不再硬编码金额（2026-09 竞品对标已重定价），改为从 API 取值 + 校验阶梯结构，
  // 这样以后调价不会又红一次，同时把「阶梯必须递减」变成一条真正的回归护栏。
  const plansC = st.plans.CN || [];
  const pT = plansC.find(x => x.id === 't');
  const pM = plansC.find(x => x.id === 'm');
  const pQ = plansC.find(x => x.id === 'q');
  const pY = plansC.find(x => x.id === 'y');
  T('plans expose trial+monthly+quarterly+yearly', !!(pT && pM && pQ && pY), JSON.stringify(plansC.map(x => x.id + ':' + x.amount)));
  T('trial is cheapest & flagged once-per-person', !!pT.trial && pT.amount < pM.amount, 'trial=' + pT.amount + ' m=' + pM.amount);
  // 结构护栏：季/年必须比「全按月卡买」便宜，且折合月单价必须严格递减（月 ≥ 季 ≥ 年）
  const perM = pM.amount, perQ = pQ.amount / pQ.months, perY = pY.amount / pY.months;
  T('period plans cheaper than 12x monthly', pQ.amount < perM * pQ.months && pY.amount < perM * pY.months,
    'q=' + perQ + '/mo y=' + perY + '/mo m=' + perM + '/mo');
  T('effective monthly price strictly decreasing', perM > perQ && perQ > perY,
    perM + ' > ' + perQ + ' > ' + perY);
  const o = (await req('POST', '/v1/subs/order', { plan: 'm', lang: 'CN' })).body;
  T('order monthly price matches plan', o.order && o.order.amount === pM.amount, 'amount=' + (o.order && o.order.amount));
  const ot = (await req('POST', '/v1/subs/order', { plan: 't', lang: 'CN' })).body;
  T('order trial accepted', ot.ok && ot.order.amount === pT.amount, 'amount=' + (ot.order && ot.order.amount));
  const c = (await req('POST', '/v1/subs/confirm', { orderId: o.order.id })).body;
  T('confirm -> sub active', !!c.ok, 'bonus=' + JSON.stringify(c.inviteBonus || ''));
  const st2 = (await req('GET', '/v1/subs/status')).body;
  T('wall cleared after subscribe', !st2.wall && !!st2.sub, 'days=' + (st2.sub && st2.sub.daysLeft));
  const sev2 = await req('POST', '/v1/report/seven', { topic: '复工第一步做啥' });
  T('report/seven works after subscribe', sev2.code === 200 && sev2.body.ok, 'code=' + sev2.code);
  const k1 = (await req('GET', '/v1/money/kpi')).body;
  T('kpi revenue reflects monthly order', k1.revenue >= pM.amount, 'rev=' + k1.revenue + ' plan=' + pM.amount);
  // 推广池断言一律用**增量**，不用绝对值：本套件可能排在 sec 等会写营收的套件之后，
  // 绝对值断言会把执行顺序变成隐式依赖（之前就因为这个红过一轮）。
  const promoBeforeTrial = k1.promo.allotted;
  const st3 = (await req('GET', '/v1/subs/status')).body;
  T('trial not consumed before payment', st3.trialUsed === false, 'trialUsed=' + st3.trialUsed);
  const ct = (await req('POST', '/v1/subs/confirm', { orderId: ot.order.id })).body;
  const st4 = (await req('GET', '/v1/subs/status')).body;
  T('trial consumed only after payment', ct.ok && st4.trialUsed === true, 'ok=' + ct.ok + ' trialUsed=' + st4.trialUsed);
  const ot2 = (await req('POST', '/v1/subs/order', { plan: 't', lang: 'CN' })).body;
  T('trial rejected second time (server-side gate)', ot2.ok === false && !!ot2.error, 'err=' + ot2.error);
  const kTrial = (await req('GET', '/v1/money/kpi')).body;
  T('trial order does not allocate promo budget', Math.abs(kTrial.promo.allotted - promoBeforeTrial) < 0.011,
    'before=' + promoBeforeTrial + ' after=' + kTrial.promo.allotted);
  const promoBefore = kTrial.promo.allotted;
  const cr = (await req('POST', '/v1/money/credit', { amt: 100, source: '私教' })).body;
  T('credit ¥100 + promo ¥5', !!cr.ok && cr.promo === 5, 'promo=' + cr.promo);
  // 用 allotted（累计拨款，永不被夹取）做断言基数，**不能用 avail**：
  // core/money.js 的 budget() 里 avail = max(0, rawAvail) —— 库里若存在"冲回"记录
  // （某笔营收未到账撤回计提），rawAvail 会是负数而 avail 被夹到 0，
  // 于是基于 avail 的增量算术在非空沙箱上必然算错（本套件会随执行顺序随机红）。
  // 增量断言的基数必须是 **rawAvail**，不是 allotted 也不是 avail：
  //   allotted = 累计拨款(in)，spend 减的是支出(out)，两者都**不会**因 spend 而变；
  //   avail    = max(0, rawAvail) 被夹取，库里若有"冲回"(rawAvail<0) 增量算术必错；
  //   rawAvail = in - out，从不夹取，是唯一在任何沙箱状态下都能做加减的量。
  const k2 = (await req('GET', '/v1/money/kpi')).body;
  T('promo allotted tracks +5', Math.abs(k2.promo.allotted - (promoBefore + 5)) < 0.011,
    'allotted=' + k2.promo.allotted + ' expected=' + (promoBefore + 5));
  // 推广池支出：按当前可用额度分两种**都正确**的分支断言，不能假设一定花得出去。
  // core/money.js 的 budget() 是 avail = max(0, rawAvail)；
  // 当库里存在"冲回"记录使 rawAvail < 0 时 avail 为 0，spend() 的守卫会**正确地拒绝**支出。
  // 之前的断言硬性要求 spend 成功，在非空沙箱（有冲回）上必然红——那是测试假设错了，不是产品错。
  const avail0 = k2.promo.avail;
  const sp = (await req('POST', '/v1/money/spend', { amt: 3, note: '投流' })).body;
  const k3 = (await req('GET', '/v1/money/kpi')).body;
  if (avail0 >= 3) {
    T('promo spend 成功且 rawAvail 减 3', !!sp.ok && Math.abs((k2.promo.rawAvail - k3.promo.rawAvail) - 3) < 0.011,
      '扣减=' + (k2.promo.rawAvail - k3.promo.rawAvail) + '（期望 3）');
  } else {
    T('推广池不足时**诚实拒绝**支出（avail=' + avail0 + '）', sp.ok === false && /预算不足/.test(String(sp.error || '')),
      'ok=' + sp.ok + ' err=' + sp.error);
  }
  T('promo avail 永不为负', k3.promo.avail >= 0, 'avail=' + k3.promo.avail + ' rawAvail=' + k3.promo.rawAvail);
  T('avail 夹到 0 但 rawAvail 仍如实暴露', k3.promo.rawAvail < 0 ? k3.promo.avail === 0 : k3.promo.avail === k3.promo.rawAvail,
    'avail=' + k3.promo.avail + ' rawAvail=' + k3.promo.rawAvail + ' reversed=' + k3.promo.reversed);
  // 榜单：姓名带本轮唯一后缀，否则重复跑会撞名（实测同沙箱跑两次出现两个 92，
  // 严格差值断言必然失败 —— 测试自身不可重入，不是产品 bug）
  const RT = Date.now().toString(36).slice(-4);
  const N1 = '王一' + RT, N2 = '李二' + RT, N3 = '赵三' + RT, N4 = '钱四' + RT;
  await req('POST', '/v1/rank/enter', { name: N1, score: 96, field: 'score' });
  await req('POST', '/v1/rank/enter', { name: N2, score: 92, field: 'score' });
  await req('POST', '/v1/rank/enter', { name: N3, score: 90, field: 'score' });
  const b1 = (await req('GET', '/v1/rank?field=score')).body;
  const mine = [N1, N2, N3].map(n => (b1.rows || []).find(r => r.name === n)).filter(Boolean);
  T('rank 入榜三人都在且按分降序', mine.length === 3 && mine[0].score === 96 && mine[1].score === 92 && mine[2].score === 90,
    JSON.stringify(mine.map(r => r.name + ':' + r.score)));
  // 差值语义：榜首的 aheadBy 恒为 null（没人比他高，这是设计如此，不是缺陷），
  // 所以只校验第 2、3 名相对前一名名的差值：96-92=4、92-90=2。
  T('rank 严格差值>=1（第2/3名相对前一名）',
    mine.length === 3 && mine[1].aheadBy === 4 && mine[2].aheadBy === 2,
    'aheadBy=' + JSON.stringify(mine.map(r => r.aheadBy)) + '（榜首为 null 属正常）');
  T('rank 榜首 aheadBy 为 null（无人领先）', mine.length === 3 && mine[0].aheadBy === null,
    'top aheadBy=' + (mine[0] && mine[0].aheadBy));
  const tie = (await req('POST', '/v1/rank/enter', { name: N4, score: 92, field: 'score' })).body;
  const b5 = (await req('GET', '/v1/rank?field=score')).body;
  T('tie -> integrity violation flagged', tie.ok && !b5.integrity.ok, 'bad=' + JSON.stringify((b5.integrity.bad || []).map(x => x.name + '|' + x.diff)));
  const w = (await req('GET', '/v1/watch')).body;
  T('watchdog endpoint shape', typeof w.scanMs === 'number' && !!w.inbox, 'running=' + w.running + ' scanMs=' + w.scanMs);
  const sc = (await req('POST', '/v1/watch/scan')).body;
  T('watch scan count numeric', typeof sc.count === 'number', 'count=' + sc.count);
  const mail = (await req('POST', '/v1/mail', { to: '460123249@qq.com', subject: 'BingDashan 监控自检', text: '自动巡检自检邮件。' })).body;
  // 邮件：未配置 MAIL_AUTH 时必须**明确失败**（源码不留任何授权码）。沙箱无密钥属预期，
  // 断言"要么真发出、要么明确报未配置"，绝不容忍静默成功或崩溃。
  T('mailer honest send result', !!mail.ok || /未配置|授权码/.test(mail.error || ''), 'err=' + (mail.error || 'sent'));
  const ml = (await req('GET', '/v1/mail/log?limit=5')).body;
  T('mail log entry present (failed sends are logged too)', (ml.mails || []).length >= 1, 'entries=' + (ml.mails || []).length);
  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  finish(fail ? 1 : 0);
})();
