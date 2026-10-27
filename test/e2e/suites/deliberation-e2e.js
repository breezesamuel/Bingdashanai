// test/e2e/suites/deliberation-e2e.js — 多 Agent 协同账本回归
//
// 守护的纪律：
//   1. 没有真实会诊结果就不许开会 —— 禁止事后编造专家意见。
//   2. 角色 id 必须已知：写错会让该条意见在复盘里无法归集，属静默污染审计链。
//   3. 采纳/否决必须给理由，无理由的裁决不可追溯。
//   4. AI 产出的行动项默认 C 级；升 A/B 必须提供实测依据，不允许模型自封高等级。
//   5. pushMany 一次落盘、只留一条汇总审计（不冲垮审计日志）。
//
// 断言一律用「增量」而非绝对计数：本套件会在同一沙箱里连开多场会，
// 写死绝对值会被自己后面的探针冲掉。
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const { finish } = require('./_exit');
const store = require(ROOT + '/core/store');
const D = require(ROOT + '/core/deliberation');

let pass = 0, fail = 0; const failures = [];
function T(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? ' . ' + detail : '')); }
  else { fail++; failures.push(name); console.log('FAIL ' + name + (detail ? ' . ' + detail : '')); }
}
const claims = () => D.review(50).coverage.totalClaims;
const roles = () => D.review(50).roleStats.length;

(async () => {
  let doneTimer;
  const done = new Promise(r => { doneTimer = setTimeout(r, 60000, 'TIMEOUT'); });
  const run = (async () => {
    const cur = store.read();
    const n0 = (cur.audit || []).length;
    const before = {
      d: (cur.deliberation || []).length,
      r: (cur.deliberationRounds || []).length,
      a: (cur.actions || []).length
    };
    const c0 = claims();

    try {
      // ── 禁止编造 ─────────────────────────────────────────
      T('convene without question rejected', D.convene({ members: [{ id: 'critic', content: 'x' }] }).ok === false);
      T('convene with empty members rejected', D.convene({ question: 'q', members: [] }).ok === false, '不得凭空开会');
      T('rejected convenes wrote nothing', claims() === c0, 'claims=' + claims());

      // ── 开会 ─────────────────────────────────────────────
      const r = D.convene({
        question: '自然 CAC 基线该怎么算',
        members: [
          { id: 'critic', content: '先问：这三条渠道各自花了多少钱？没有成本记录就算不出 CAC。' },
          { id: 'planner', content: '本周只做一件事：把知乎/小红书/朋友招募的推广费与耗时填进台账。' },
          { id: 'analyst', content: '注意：reg=20 与实测 1 冲突，先解决数据可信度再谈 CAC。' }
        ],
        consensus: [{ text: '先补成本记录', n: 3 }],
        divergence: ['critic 要求先查数据冲突'],
        risks: ['台账不可信'],
        actions: ['补成本台账'],
        failed: ['builder']
      });
      T('convene succeeds with real members', r.ok === true);
      T('one row per member', r.rows.length === 3, 'rows=' + r.rows.length);
      T('rows share roundId', r.rows.every(x => x.roundId === r.roundId));
      T('exactly 3 new claims', claims() === c0 + 3, 'c0=' + c0 + ' now=' + claims());
      T('round records failed agent', r.summary.failed.indexOf('builder') >= 0);
      T('role duty attached from ROLES', r.rows[0].duty.length > 0 && r.rows[0].roleKnown === true, r.rows[0].roleName + ' / ' + r.rows[0].duty);
      T('no unknown-role bucket yet', D.review(50).unknownRoles.length === 0);

      // pushMany 落盘审计只留一条（3 行成员 + 1 轮汇总 + 1 条业务审计）
      const auditAfter = (store.read().audit || []).length - n0;
      T('pushMany leaves one audit line, not N', auditAfter === 3, 'audit+' + auditAfter + ' for 3 rows (N would be 5)');

      // ── 裁决必须给理由 ───────────────────────────────────
      T('adjudicate without reason rejected', D.adjudicate(r.roundId, r.rows[0].id, 'adopted').ok === false);
      T('adjudicate with bad verdict rejected', D.adjudicate(r.roundId, r.rows[0].id, 'yeah', '理由').ok === false);
      T('adjudicate unknown row rejected', D.adjudicate(r.roundId, 'nope', 'adopted', '理由').ok === false);
      T('adjudicate with reason succeeds', D.adjudicate(r.roundId, r.rows[0].id, 'adopted', '无成本数据，先补台账').ok === true);
      T('rejected verdict accepted', D.adjudicate(r.roundId, r.rows[1].id, 'rejected', '暂不做，先修数据').ok === true);

      const row0 = store.list('deliberation', 9999).find(x => x.id === r.rows[0].id);
      T('verdict persisted with reason', row0.verdict === 'adopted' && !!row0.verdictReason);
      T('pending verdict accepted', D.adjudicate(r.roundId, r.rows[2].id, 'pending', '等数据修好再议').ok === true);

      // ── 行动项默认 C 级 ───────────────────────────────────
      const a = D.addAction({ text: '填三渠道成本', from: 'critic', cost: 0, impact: 5, roundId: r.roundId });
      T('addAction succeeds', a.ok === true);
      T('AI suggestion defaults to C grade', a.rec.evidence === 'C', 'grade=' + a.rec.evidence);
      T('addAction without text rejected', D.addAction({}).ok === false);

      T('grade to A without proof rejected', D.gradeAction(a.rec.id, 'A').ok === false);
      T('grade to B without proof rejected', D.gradeAction(a.rec.id, 'B').ok === false);
      T('grade with bad letter rejected', D.gradeAction(a.rec.id, 'S', 'x').ok === false);
      T('grade to A with proof accepted', D.gradeAction(a.rec.id, 'A', '工行流水已核对').ok === true);
      T('grade back to C needs no proof', D.gradeAction(a.rec.id, 'C').ok === true);
      T('grade unknown action rejected', D.gradeAction('nope', 'A', 'x').ok === false);

      // ── 复盘视图（此时账本里只有本场会的 3 条）────────────
      const v = D.review(50);
      T('review counts claims', v.coverage.totalClaims === c0 + 3, 'claims=' + v.coverage.totalClaims);
      T('review counts judged', v.coverage.judged === c0 + 3, 'judged=' + v.coverage.judged);
      T('all judged -> no idle warning', /多数意见已被裁决/.test(v.coverage.note), v.coverage.note);
      T('REGRESSION: grade buckets not all zero', v.actionGrades.A + v.actionGrades.B + v.actionGrades.C >= 1, JSON.stringify({ A: v.actionGrades.A, B: v.actionGrades.B, C: v.actionGrades.C }));
      T('three known roles', roles() === 3, 'roles=' + roles());
      T('verdicts tallied per role', v.roleStats.reduce((n, x) => n + x.adopted + x.rejected + x.pending, 0) === 3, JSON.stringify(v.roleStats.map(x => x.role + ':' + x.adopted + '/' + x.rejected + '/' + x.pending)));
      T('open action surfaced', v.openActions.some(x => x.id === a.rec.id));
      T('round appears in review', v.rounds.some(x => x.id === r.roundId));

      // ── 未裁决会触发空转告警（按场次隔离，不能被别场的全裁决掩盖）──
      D.convene({ question: '未裁决告警探针', members: [{ id: 'builder', content: '先做最小版本验收' }, { id: 'grower', content: '一料五吃' }] });
      const v2 = D.review(50);
      T('unjudged round flagged idle per-round', v2.rounds.some(x => x.idle === true), JSON.stringify(v2.rounds.map(x => x.claims + ':' + x.judged + (x.idle ? '(idle)' : ''))));
      T('idleRounds listed', v2.idleRounds.length >= 1, 'n=' + v2.idleRounds.length);
      T('per-round note explains the idle round', /未裁决/.test(v2.coverage.perRoundNote), v2.coverage.perRoundNote);
      T('fully-judged round not flagged idle', v2.rounds.filter(x => x.id === r.roundId).every(x => x.idle === false));

      // ── 未知角色：拒绝，但显式放行时必须在复盘里暴露 ───────
      const cBefore = claims();
      T('unknown role id rejected by default', D.convene({ question: 'q', members: [{ id: 'crit', content: 'x' }] }).ok === false);
      T('rejected unknown-role convene wrote nothing', claims() === cBefore);
      const u = D.convene({ question: '临时角色探针', members: [{ id: 'crit', content: 'x' }], allowUnknown: true });
      T('allowUnknown bypass works', u.ok === true);
      T('allowUnknown row marked roleKnown=false', u.rows[0].roleKnown === false);
      T('allowUnknown rows surfaced in review', D.review(50).unknownRoles.length >= 1, '不可静默归集');
    } finally {
      const d = store.read();
      d.deliberation = (d.deliberation || []).slice(0, before.d);
      d.deliberationRounds = (d.deliberationRounds || []).slice(0, before.r);
      d.actions = (d.actions || []).slice(0, before.a);
      d.audit = (d.audit || []).slice(0, n0);
      store.write(d);
    }
  })();
  const r = await Promise.race([run, done]);
  clearTimeout(doneTimer);   // race 一结束就释放，否则进程要干等到超时点才退
  if (r === 'TIMEOUT') { fail++; failures.push('TIMEOUT'); console.log('TIMEOUT'); }
  console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  if (fail) { console.error('FAILED: ' + failures.join(', ')); }
  finish(fail ? 1 : 0);
})();
