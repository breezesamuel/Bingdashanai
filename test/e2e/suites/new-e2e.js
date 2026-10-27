const { finish } = require('./_exit');
const { requireIsolated } = require('./_guard');
const B = requireIsolated('new-e2e');
const j = async (p, opt) => { const r = await fetch(B + p, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opt)); return r.json(); };
let pass = 0, fail = 0;
function t(name, cond, extra) { if (cond) { pass++; console.log('PASS ' + name + (extra ? ' · ' + extra : '')); } else { fail++; console.log('FAIL ' + name + (extra ? ' · ' + extra : '')); } }
(async () => {
  // foundry sources usable in dropdowns
  const src = await j('/v1/foundry/sources');
  t('sources a+b', src.ok && src.sources.a.length >= 1 && src.sources.b.length >= 1, 'a=' + src.sources.a.length + ' b=' + src.sources.b.length + ' total=' + src.sources.total);
  const wellA = src.sources.a[0];
  const wellB = src.sources.b[0];
  const ttl = '《抉择志·深挖增强轮》' + Date.now().toString(36).slice(-4);
  // form path: POST /v1/foundry with disturb flags (>=3) — the previously-broken path
  const fc = await j('/v1/foundry', { method: 'POST', body: JSON.stringify({ peerId: wellA.id, manualNo: Number(wellB.id), title: ttl, disturbTime: true, disturbCity: true, disturbJob: true, disturbFamily: true }) });
  t('foundry 立项 with disturb', fc.ok && fc.id && fc.station === 'S3', 'id=' + fc.id + ' station=' + fc.station);
  const wid = fc.id;
  // advance S3 → S4
  if (wid) {
    const a4 = await j('/v1/foundry/advance', { method: 'POST', body: JSON.stringify({ id: wid, station: 'S3' }) });
    t('advance S3 outline', a4.ok && (a4.station === 'S4' || a4.verdict), 'station=' + (a4.station || a4.verdict));
    const a5 = await j('/v1/foundry/advance', { method: 'POST', body: JSON.stringify({ id: wid, station: 'S4', approve: true }) });
    t('advance S4 human', a5.ok, 'station=' + (a5.station || a5.verdict));
    const a6 = await j('/v1/foundry/advance', { method: 'POST', body: JSON.stringify({ id: wid, station: 'S5' }) });
    t('advance S5 draft', a6.ok, 'station=' + (a6.station || a6.verdict));
    const a7 = await j('/v1/foundry/advance', { method: 'POST', body: JSON.stringify({ id: wid, station: 'S6', chapterCount: 3, rewriteNote: '改写第2章对白' }) });
    t('advance S6 humanRewrite', a7.ok, 'station=' + (a7.station || a7.verdict));
    const a8 = await j('/v1/foundry/advance', { method: 'POST', body: JSON.stringify({ id: wid, station: 'S7' }) });
    t('advance S7 qc', a8.ok);
    const a9 = await j('/v1/foundry/advance', { method: 'POST', body: JSON.stringify({ id: wid, station: 'S8', selfRecognize: false, colleagueRecognize: false }) });
    t('advance S8 finalReview bypass', a9.ok && a9.station === 'S9', 'station=' + a9.station);
    const a10 = await j('/v1/foundry/advance', { method: 'POST', body: JSON.stringify({ id: wid, station: 'S9' }) });
    t('advance S9 publish', a10.ok && a10.published, 'published=' + a10.published + ' share=' + (a10.share || ''));
    // works list reflects
    const ws = await j('/v1/foundry/works');
    const found = (ws.works || []).find(w => w.id === wid);
    t('works list reflects', ws.ok && found && found.published === true, 'station=' + (found || {}).station);
  }
  // lot-take end-to-end: park real idea, take into an open slot
  const busy = (await j('/v1/train')).current.slots;
  const emptySlot = ['growth', 'retention', 'debt'].find(k => !busy[k]);
  const pk = await j('/v1/train/park', { method: 'POST', body: JSON.stringify({ title: '深挖轮 lot 提取测试' }) });
  if (pk.ok && emptySlot) {
    const lt = await j('/v1/train/lot', { method: 'POST', body: JSON.stringify({ id: pk.id, slot: emptySlot }) });
    t('lot take', lt.ok && lt.slot === emptySlot, 'slot=' + emptySlot + ' taken-idea=' + lt.title);
  } else {
    t('lot take (slot busy this round)', pk.ok === true, 'all 3 slots busy – skipping take');
  }
  // autopilot optimize fused
  const op = await j('/v1/autopilot/optimize');
  t('optimize fused signals', op.ok && op.advises.length >= 0, 'adv=' + op.advises.length);
  // verify page still serves
  const vp = await fetch(B + '/verify/' + (await j('/v1/report/list?limit=1')).list[0].id).then(x => x.text());
  t('verify page serve', vp.includes('七段决策报告'), '');
  console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  finish(fail ? 1 : 0);
})().catch(e => { console.log('SCRIPT-ERR', e.message); process.exit(1); });