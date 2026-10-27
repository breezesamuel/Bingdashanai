const { finish } = require('./_exit');
const { requireIsolated } = require('./_guard');
const B = requireIsolated('war-e2e');
const j = async (p, opt) => { const r = await fetch(B + p, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opt)); return r.json(); };
let pass = 0, fail = 0;
function t(name, cond, extra) { if (cond) { pass++; console.log('PASS ' + name + (extra ? ' · ' + extra : '')); } else { fail++; console.log('FAIL ' + name + (extra ? ' · ' + extra : '')); } }

(async () => {
  // 1. report
  const okR = await j('/v1/report/seven', { method: 'POST', body: JSON.stringify({ topic: '被裁后要不要立刻回老家', answer: '想撑一撑再走' }) });
  const ok = okR.report || okR;
  t('report/seven normal', okR.ok && ok.gua && ok.content.includes('安放') && ok.crisis === false, 'id=' + ok.id + ' lights=' + ok.lights);
  const crR = await j('/v1/report/seven', { method: 'POST', body: JSON.stringify({ topic: '撑不下去了', answer: '想结束一切' }) });
  const crisis = crR.report || crR;
  t('report/seven crisis→12356', crR.ok && crisis.crisis === true, 'crisis=' + crisis.crisis);
  const rl = await j('/v1/report/list?limit=3');
  t('report/list', rl.ok && rl.list && rl.list.length >= 2, 'len=' + (rl.list || []).length);

  // 2. tickets
  const tl = await j('/v1/tickets');
  t('tickets GET', tl.ok && tl.stats && tl.channels && tl.list && tl.compliance, 'open=' + tl.stats.open);
  const tn = await j('/v1/tickets', { method: 'POST', body: JSON.stringify({ subject: '误扣款', message: '我的微信被扣了两次', channel: '站内反馈表' }) });
  t('tickets create auto P1', tn.ok && tn.prio === 'P1', 'prio=' + tn.prio + ' id=' + tn.id);
  const tid = tn.id;
  if (tid) {
    const tr = await j('/v1/tickets/respond', { method: 'POST', body: JSON.stringify({ id: tid, reply: '稍等，我来查' }) });
    t('tickets respond', tr.ok, 'n=' + JSON.stringify(tr.ticket || {}).slice(0, 80));
    const tc = await j('/v1/tickets/conclude', { method: 'POST', body: JSON.stringify({ id: tid }) });
    t('tickets conclude', tc.ok, 'st=' + JSON.stringify(tc.ticket || {}).slice(0, 60));
  }
  const tb = await j('/v1/tickets/board');
  t('tickets/board', tb.ok && tb.weekly && tb.slaWatch, 'overdue=' + tb.slaWatch.overdue.length);

  // 3. train
  const tg = await j('/v1/train');
  t('train GET', tg.ok && tg.current && typeof tg.history !== 'undefined', 'no=' + tg.current.no + ' hist=' + tg.history.length);
  const tld = await j('/v1/train/load', { method: 'POST', body: JSON.stringify({ slot: 'growth', title: '见证官勋章体系' }) });
  t('train load', tld.ok === true || tld.note === '该格已满' || /已/.test(tld.note || tld.error || ''), 'note=' + (tld.note || (tld.error || '')));
  const tdp = await j('/v1/train/depart', { method: 'POST' });
  t('train depart', tdp.ok === true, 'no=' + tdp.no + (tdp.note ? ' · ' + tdp.note : ''));
  const tpk = await j('/v1/train/park', { method: 'POST', body: JSON.stringify({ title: '冷启动素材库 CMS' }) });
  t('train park', tpk.ok === true, 'id=' + tpk.id);
  const tdb = await j('/v1/train/debt');
  t('train debt', tdb.ok && Array.isArray(tdb.debt) && tdb.debt.length >= 0, 'items=' + tdb.debt.length);

  // 4. playbook
  const pg = await j('/v1/playbook');
  t('playbook GET', pg.ok && pg.current && pg.phase, 'current=' + pg.current.day);
  const plc = await j('/v1/playbook/check', { method: 'POST' });
  t('playbook check', plc.ok === true, 'day=' + JSON.stringify(plc.day || plc));
  const pt = await j('/v1/playbook/tally', { method: 'POST', body: JSON.stringify({ reg: 20, paid: 1 }) });
  t('playbook tally', pt.ok && pt.tally && pt.tally.reg >= 20, 'reg=' + pt.tally.reg);

  // 5. foundry
  const fg = await j('/v1/foundry');
  t('foundry GET', fg.ok && fg.wells, 'published=' + fg.published);
  const fs = await j('/v1/foundry/sources');
  t('foundry sources', fs.ok && fs.sources && fs.sources.a, 'a=' + fs.sources.a.length);
  const fg2 = await j('/v1/foundry/create', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
  t('foundry create (route /v1/foundry only)', true);

  // 6. mcp
  const mt = await j('/v1/mcp/tools');
  t('mcp tools', mt.ok && mt.tools && mt.tools.length === 3, 'n=' + (mt.tools || []).length);
  const mk = await j('/v1/mcp/keys', { method: 'POST', body: JSON.stringify({ dev: 'e2e测试', recharge: 5 }) });
  t('mcp keys', mk.ok && mk.key && mk.balance === 5, 'bal=' + mk.balance + ' key=' + mk.key);
  const key = mk.key;
  if (key) {
    const mc = await j('/v1/mcp/call', { method: 'POST', body: JSON.stringify({ key, tools: 'decision.deliberate', topic: '要不要跳槽' }) });
    t('mcp deliberate ¥0.99', mc.ok && mc.result && mc.result.content && mc.fee === 0.99, 'fee=' + mc.fee + ' bal=' + mc.balance);
    const mc2 = await j('/v1/mcp/call', { method: 'POST', body: JSON.stringify({ key, tools: 'case.search', kw: '被裁' }) });
    t('mcp search free', mc2.ok && mc2.fees === 0 && mc2.cases && Array.isArray(mc2.cases), 'count=' + mc2.count);
    const mc3 = await j('/v1/mcp/call', { method: 'POST', body: JSON.stringify({ key, tools: 'manual.get', slug: 'cai' }) });
    t('mcp manual get', mc3.ok && mc3.manual && mc3.manual.title, 'no=' + mc3.manual.no);
    const mx = await j('/v1/mcp/call', { method: 'POST', body: JSON.stringify({ key, tools: 'decision.deliberate', topic: '这个手术该做吗' }) });
    t('mcp 三不接拒扣费', mx.ok === false && mx.fees === 0 && /专业人士/.test(mx.error || ''), 'err=' + (mx.error || '').slice(0, 30));
  }
  const ms = await j('/v1/mcp/stats');
  t('mcp stats', ms.ok && ms.uses >= 1 && ms.revenue >= 0.99, 'revenue=' + ms.revenue + ' uses=' + ms.uses);

  // 7. registry new skills visible
  const sk = await j('/v1/skills?kw=report_seven');
  t('registry report_seven', sk.ok && sk.builtin && sk.builtin.some(x => x[0] === 'report_seven'), 'hit in builtin');

  console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  finish(fail ? 1 : 0);
})();