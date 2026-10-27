// fee-e2e.js — 抽成与分润口径统一后的回归护栏
//
// 背景：此前存在两套互相冲突、且只有一套真正生效的口径——
//   settings.platformFee.revenueTiers（3%/5%/3%）全代码库无人读取，是死配置；
//   partner.js 硬编码 partnerSharePct=60%（平台留 40%）才是实际生效的唯一口径。
//   即"设置里写着抽 3–5%，账上实际抽 40%"。本套件锁死统一后的行为。

const http = require('http');
const BASE = process.env.BINGDASHAN_E2E_BASE;
const ADMIN = process.env.BINGDASHAN_ADMIN_TOKEN || '';
if (!BASE) { console.error('ABORT fee-e2e：未设置 BINGDASHAN_E2E_BASE'); process.exit(2); }

let P = 0, F = 0;
function T(name, cond, extra) {
  if (cond) { P++; console.log('PASS ' + name + (extra ? ' . ' + extra : '')); }
  else { F++; console.log('FAIL ' + name + (extra ? ' . ' + extra : '')); }
}
function req(method, p, body, headers) {
  return new Promise((res, rej) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({ 'X-Visitor': 'e2e-fee-visitor' }, headers || {});
    if (ADMIN) h['X-Admin-Token'] = ADMIN;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    const r = http.request(BASE + p, { method, headers: h }, resp => {
      let b = '';
      resp.on('data', d => b += d);
      resp.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch (e) {} res({ code: resp.statusCode, body: j }); });
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}
const near = (a, b, eps) => Math.abs(Number(a) - Number(b)) < (eps || 0.011);

(async () => {
  // —— 1) 唯一口径：platformPct + partnerPct 必须互补为 100 ——
  const b0 = (await req('GET', '/v1/partner')).body;
  T('partner board exposes single unified fee policy',
    typeof b0.platformPct === 'number' && typeof b0.partnerPct === 'number',
    'platform=' + b0.platformPct + '% partner=' + b0.partnerPct + '%');
  T('platformPct + partnerPct === 100', b0.platformPct + b0.partnerPct === 100,
    b0.platformPct + '+' + b0.partnerPct + '=' + (b0.platformPct + b0.partnerPct));
  T('fee tiers exposed (阶梯可复现)', Array.isArray(b0.feeTiers) && b0.feeTiers.length >= 3,
    JSON.stringify((b0.feeTiers || []).map(t => t.maxAnnual + '→' + t.pct + '%')));
  T('tier carries the annual denominator', typeof b0.annualSettled === 'number',
    'annualSettled=' + b0.annualSettled);

  // —— 2) 死配置已清除：partnerSharePct 不再与阶梯打架 ——
  T('legacy partnerSharePct no longer conflicts', b0.legacyConflict === null,
    JSON.stringify(b0.legacyConflict));

  // —— 3) 平台抽成下限：阶梯不能把平台抽成压到 0 ——
  const settings = (await req('GET', '/v1/settings')).body;
  const curTiers = (settings.settings && settings.settings.platformFee && settings.settings.platformFee.revenueTiers) || b0.feeTiers;
  const zeroed = curTiers.map(t => (t.maxAnnual === null ? { maxAnnual: null, pct: 0, note: t.note } : Object.assign({}, t, { pct: 0 })));
  await req('POST', '/v1/settings', { platformFee: { revenueTiers: zeroed, adSpendPct: 20 } });
  const bZero = (await req('GET', '/v1/partner')).body;
  T('tier pct=0 clamped to MIN_PLATFORM_PCT', bZero.platformPct === 1,
    'platformPct=' + bZero.platformPct + '% (期望 1)');
  T('partner still gets >=10% after clamp', bZero.partnerPct === 99, 'partnerPct=' + bZero.partnerPct + '%');

  // —— 4) 上限：平台留存不得低于 10% ——
  const greedy = [{ maxAnnual: null, pct: 95, note: '贪婪档' }];
  await req('POST', '/v1/settings', { platformFee: { revenueTiers: greedy, adSpendPct: 20 } });
  const bHi = (await req('GET', '/v1/partner')).body;
  T('tier pct=95 clamped to MAX_PLATFORM_PCT', bHi.platformPct === 90,
    'platformPct=' + bHi.platformPct + '% (期望 90)');

  // —— 5) 损坏配置兜底取中档，不取最优档 ——
  await req('POST', '/v1/settings', { platformFee: { revenueTiers: [{ maxAnnual: 100000, pct: 'abc' }, { maxAnnual: null, pct: null }], adSpendPct: 20 } });
  const bBad = (await req('GET', '/v1/partner')).body;
  T('corrupt tier falls back to 5 (not the cheapest tier)', bBad.platformPct === 5,
    'platformPct=' + bBad.platformPct + '% (期望 5)');

  // —— 6) 阶梯乱序必须正确排序 ——
  const shuffled = [
    { maxAnnual: null, pct: 3, note: '规模让利' },
    { maxAnnual: 100000, pct: 5, note: '正轨' },
    { maxAnnual: 1000000, pct: 4, note: '中轨' }
  ];
  await req('POST', '/v1/settings', { platformFee: { revenueTiers: shuffled, adSpendPct: 20 } });
  const bSh = (await req('GET', '/v1/partner')).body;
  T('shuffled tiers sorted by cap (annual=0 → <100k 档)', bSh.platformPct === 5,
    'platformPct=' + bSh.platformPct + '% 档=' + bSh.feeTier.maxAnnual);

  // —— 7) 端到端：真实成交 → 按阶梯拆分，两笔账加起来必须等于成交额 ——
  const tiersReal = [
    { maxAnnual: 100000, pct: 3, note: '冷启动' },
    { maxAnnual: 1000000, pct: 5, note: '正轨' },
    { maxAnnual: null, pct: 3, note: '规模让利' }
  ];
  await req('POST', '/v1/settings', { platformFee: { revenueTiers: tiersReal, adSpendPct: 20 } });
  const en = (await req('POST', '/v1/partner/enroll', { name: 'e2e合伙人-' + Date.now() })).body;
  T('enroll ok with zero entry fee', en.ok && en.partner.entryFee === 0,
    'entryFee=' + (en.partner && en.partner.entryFee));

  const dv = (await req('POST', '/v1/partner/deliver', {
    partnerId: en.partner.id, what: 'e2e 真实交付内容', hours: 3, amount: 1000, customer: 'e2e客户'
  })).body;
  T('deliver recorded', !!dv.ok && !!dv.delivery, 'id=' + (dv.delivery && dv.delivery.id));

  // 未验收不应计入应得
  const preBoard = (await req('GET', '/v1/partner')).body;
  const prePartner = preBoard.partners.find(x => x.id === en.partner.id);
  T('unaccepted delivery earns nothing', !prePartner || prePartner.earned === 0,
    'earned=' + (prePartner && prePartner.earned));

  const ac = (await req('POST', '/v1/partner/accept', { deliveryId: dv.delivery.id })).body;
  T('accept splits by tier', ac.ok && ac.platformPct === 3 && ac.partnerPct === 97,
    'platform=' + ac.platformFee + '(' + ac.platformPct + '%) partner=' + ac.share + '(' + ac.partnerPct + '%)');
  T('split is exact: platformFee + share === gross', near(ac.platformFee + ac.share, 1000, 0.02),
    ac.platformFee + ' + ' + ac.share + ' = ' + (ac.platformFee + ac.share));
  T('platform fee === gross * tierPct', near(ac.platformFee, 1000 * ac.platformPct / 100, 0.02),
    'expected ' + (1000 * ac.platformPct / 100));

  const postBoard = (await req('GET', '/v1/partner')).body;
  const postPartner = postBoard.partners.find(x => x.id === en.partner.id);
  T('accepted delivery credits earned', near(postPartner.earned, ac.share, 0.02),
    'earned=' + postPartner.earned + ' share=' + ac.share);

  // 幂等：重复验收不重复发
  const ac2 = (await req('POST', '/v1/partner/accept', { deliveryId: dv.delivery.id })).body;
  T('re-accept is idempotent', ac2.already === true && !ac2.share, JSON.stringify(ac2));
  const postBoard2 = (await req('GET', '/v1/partner')).body;
  T('re-accept does not double-credit',
    near(postBoard2.partners.find(x => x.id === en.partner.id).earned, ac.share, 0.02),
    'earned=' + postBoard2.partners.find(x => x.id === en.partner.id).earned);

  // —— 8) 合规红线一条都不能松 ——
  T('multilevel field rejected', (await req('POST', '/v1/partner/deliver', {
    partnerId: en.partner.id, what: 'e2e 真实交付内容', hours: 3, amount: 1000, uplineId: 'x'
  })).body.ok === false);
  T('zero-amount delivery earns nothing', (await req('POST', '/v1/partner/deliver', {
    partnerId: en.partner.id, what: '无金额的交付', hours: 1, amount: 0
  })).body.ok === true && (await req('POST', '/v1/partner/accept', {
    deliveryId: (await req('POST', '/v1/partner/deliver', {
      partnerId: en.partner.id, what: '无金额交付二', hours: 1, amount: 0
    })).body.delivery.id
  })).body.ok === false);

  // 还原阶梯，避免污染后续套件
  await req('POST', '/v1/settings', { platformFee: { revenueTiers: tiersReal, adSpendPct: 20 } });

  console.log('\n===== ' + P + ' PASS / ' + F + ' FAIL =====');
  process.exit(F ? 1 : 0);
})().catch(e => { console.error('fee-e2e err', e && e.message, e && e.stack); process.exit(1); });
