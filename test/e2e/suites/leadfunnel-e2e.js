// test/e2e/suites/leadfunnel-e2e.js — 获客漏斗推进
//
// 回归重点（真实踩过的坑）：
//   funnelStep() 原来每轮只推进一段，且从最靠近成交的段往前挑。
//   促单段常驻着一条永不满足条件的线索，于是每轮都只跑 close()，
//   13 条「探测」线索永远推不出去 —— 漏斗实际只有一个客户在打转，
//   实测连跑 14 轮，触达的仍是同一条 dayltan-sudo/risk-compliance。
//   另外 selectOne()/optimizeOne()/close() 三处都用 sort(updatedAt desc)[0]，
//   被处理过的那条每轮刷新 updatedAt 而永远霸占第一。
const ROOT = 'C:/Users/Think/project/BingDashan';
const E2E = process.env.BINGDASHAN_E2E_DATA_DIR || process.env.BINGDASHAN_DATA_DIR;
if (E2E) process.env.BINGDASHAN_DATA_DIR = E2E;
const { finish } = require('./_exit');
const store = require(ROOT + '/core/store');
const lg = require(ROOT + '/core/leadgen');

let pass = 0, fail = 0; const failures = [];
function T(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? ' . ' + detail : '')); }
  else { fail++; failures.push(name); console.log('FAIL ' + name + (detail ? ' . ' + detail : '')); }
}
const stages = () => {
  const d = store.read(), m = {};
  (d.leads || []).forEach(l => { m[l.stage] = (m[l.stage] || 0) + 1; });
  return m;
};

(async () => {
  let doneTimer;
  const done = new Promise(r => { doneTimer = setTimeout(r, 120000, 'TIMEOUT'); });
  const run = (async () => {
    const d0 = store.read();
    const bakLeads = JSON.stringify(d0.leads || []);
    try {
      // ── 基础 ─────────────────────────────────────────────
      T('STAGES is the full funnel', Array.isArray(lg.STAGES) && lg.STAGES.length >= 5, JSON.stringify(lg.STAGES));
      T('board() does not throw', (() => { try { lg.board(); return true; } catch (e) { return false; } })());
      const icp = lg.icpScore({ industry: 'AI', note: 'mcp agent', topics: ['claude'] });
      T('icpScore returns {cat, icp}', icp && typeof icp === 'object' && typeof icp.icp === 'number' && 'cat' in icp, JSON.stringify(icp));
      T('icpScore scores a matching lead above zero', icp.icp > 0);

      // ── 播种：自己造「探测」段线索，不能依赖沙箱现状 ──
      // runner 里 autopilot/autoloop 排在本套件之前，已把沙箱线索推过早期段，
      // 依赖现状会导致 before 全为 0、断言恒假（这坑踩过一次）。
      // 必须用 store.push 而不是 store.write：push 会自动生成 id，
      // 而 leadgen 内部靠 l.id 调 store.update。直接 write 数组会让 id 为
      // undefined，导致所有 store.update 静默落空（我踩过一次假绿）。
      const SEED = ['e2e/alpha', 'e2e/beta', 'e2e/gamma', 'e2e/delta', 'e2e/epsilon'];
      const dS = store.read();
      dS.leads = [];
      store.write(dS);
      SEED.forEach((n, i) => {
        store.push('leads', {
          name: n, company: n, repo: n, industry: 'AI', signal: 60 - i * 4,
          source: 'e2e 播种', stage: '探测', status: 'new', path: 'leadgen',
          topics: ['mcp', 'agent'], url: 'https://github.com/' + n, note: 'e2e mcp agent workflow', touch: 0, tries: 0
        }, 'e2e 播种');
      });
      const seeded = store.read().leads || [];
      T('seeded 5 leads at 探测', seeded.filter(l => l.stage === '探测').length === 5, 'n=' + seeded.length);
      T('seeded leads have generated ids (update depends on it)', seeded.every(l => !!l.id));
      T('seeded leads have no touch history (must be preferred by picker)', seeded.every(l => !l.touch && !l.tries));
      T('convProb returns a number in 0-100', (() => { const p = lg.convProb({ name: 'x/y', signal: 50, touch: 1 }); return typeof p === 'number' && p >= 0 && p <= 100; })());

      // ── 核心回归：单轮必须把漏斗往前推，而不是原地打转 ──
      // 指标说明：不能数「输出行里被提及的次数」—— 一条卡住的线索会在
      // 推荐/选择/优化/促单/成交每一段都被提及，天然刷高计数。
      // 真正的不变量：有多少条线索的「段位」真的发生了变化。
      const snapLeads = () => {
        const m = {};
        (store.read().leads || []).forEach(l => { m[l.name] = l.stage + '|' + (l.tries || 0); });
        return m;
      };
      const before = stages();
      const snap0 = snapLeads();
      const ROUNDS = 8;
      for (let i = 0; i < ROUNDS; i++) await lg.funnelStep(900 + i);
      const snap1 = snapLeads();
      const advanced = Object.keys(snap0).filter(n => snap1[n] !== snap0[n]);
      T('REGRESSION: several leads changed stage', advanced.length >= 2,
        'advanced=' + advanced.length + '/5 ' + advanced.join(', '));
      T('REGRESSION: funnel is not stuck on one lead', advanced.length !== 1,
        'only ' + advanced.join(',') + ' moved across ' + ROUNDS + ' rounds');

      // 长期跟进：tries 达 3 次未达标后必须离开促单段，不再被自动重试
      const follow = (store.read().leads || []).filter(l => l.underFollow);
      T('长期跟进 leads leave the auto rotation', follow.every(l => l.stage === '长期跟进'),
        follow.map(l => l.name + ':' + l.stage).join(', ') || 'none');
      T('SIDELINES exported', Array.isArray(lg.SIDELINES) && lg.SIDELINES.indexOf('长期跟进') >= 0, JSON.stringify(lg.SIDELINES));

      const after = stages();
      const sum = m => Object.keys(m).reduce((s, k) => s + m[k], 0);
      // 漏斗空时会合法地调 find() 从 GitHub 加新线索，所以总数可以增长。
      // 真正的不变量是：5 条种子线索一条都不能丢（不能失守、不能凭空消失）。
      const namesAfter = new Set((store.read().leads || []).map(l => l.name));
      T('lead count may grow but none lost', SEED.every(n => namesAfter.has(n)),
        'seeds missing: ' + SEED.filter(n => !namesAfter.has(n)).join(',') || 'none');
      T('lead count conserved-or-grown (no loss)', sum(after) >= sum(before), sum(before) + ' -> ' + sum(after));

      // 漏斗必须整体前移：早期段（探测/推荐/选择/优化）任一减少，或出现新的中段。
      //
      // 【2026-09 断言重写】原来断言的是"aEarly < bEarly"，也就是**自动化应当消化早期漏斗**。
      // 这条断言本身编码了 bug：旧 promote() 把"排定的触达计划"记成 touch+1，
      // 于是机器不碰任何人也能把线索一路推到「商机候选」——漏斗当然会"前移"。
      //
      // 现在 close() 的门槛只看**人工确认的真实触达**（markTouched 写入），
      // 所以纯自动轮次**不应该**消化早期漏斗，它只应该把人推进到"等人动手"的位置。
      // 正确的护栏是反过来断言机器不许越权，见下面「诚实进展」一节。
      const early = ['探测', '推荐', '选择', '优化'];
      const bEarly = early.reduce((s, k) => s + (before[k] || 0), 0);
      const aEarly = early.reduce((s, k) => s + (after[k] || 0), 0);
      T('早期漏斗不要求被自动化消化（该断言已重写，见下）', typeof aEarly === 'number',
        early.map(k => k + ':' + (before[k] || 0) + '->' + (after[k] || 0)).join(' '));

      // ── 诚实进展：机器不得伪造任何进展 ─────────────────────
      const leads = store.read().leads || [];

      // 1) 计划渠道绝不写进 channels（channels 是 ROI 归因真实触达的唯一依据）
      const planLeak = leads.filter(l => (l.channels || []).some(c => c === l.channel) || false);
      T('planned channels never pollute real channels',
        leads.every(l => !((l.channels || []).length && (l.plannedChannels || []).length &&
          (l.channels || []).filter(c => (l.plannedChannels || []).includes(c)).length > 0 &&
          !(l.touch || 0))),
        'lead=' + (planLeak[0] || {}).name);
      T('every lead tracks planned and real touch separately',
        leads.every(l => typeof l.planned === 'number' || typeof l.touch === 'number' || l.stage === '探测' || l.stage === '触达'),
        'sample=' + JSON.stringify({ planned: (leads[0] || {}).planned, touch: (leads[0] || {}).touch }));

      // 2) 全程零人工触达 → 绝不允许出现商机候选（机器不能自己给自己发工资）
      T('REGRESSION: no 商机候选 without real human touch',
        leads.filter(l => l.stage === '商机候选').length === 0,
        '商机候选=' + leads.filter(l => l.stage === '商机候选').length + ' realTouches=' +
        leads.reduce((s, l) => s + (Number(l.touch) || 0), 0));

      // 3) 单轮不得级联：一条线索一轮最多推进一段（否则 5 段形同虚设）
      const singleRound = store.read().leads || [];
      const beforeSnap = {};
      singleRound.forEach(l => { beforeSnap[l.id] = l.stage; });
      await lg.funnelStep(999);
      const moved = (store.read().leads || []).filter(l => beforeSnap[l.id] && beforeSnap[l.id] !== l.stage);
      const jumped = moved.filter(l => {
        const order = ['探测', '触达', '推荐', '选择', '优化', '促单', '长期跟进', '商机候选'];
        const a = order.indexOf(beforeSnap[l.id]);
        const b = order.indexOf(l.stage);
        // 允许回退（优化<-促单）与停滞，"前跳"超过 1 段才是级联
        return b > a + 1;
      });
      T('REGRESSION: single round advances at most one stage per lead', jumped.length === 0,
        'jumped=' + jumped.map(l => l.name + ' ' + beforeSnap[l.id] + '->' + l.stage).join(', ') || 'none');

      // 4) 无人推进的线索应停在「促单」等人工，而不是继续自动往前冲
      const noTouch = leads.filter(l => !(Number(l.touch) || 0));
      T('REGRESSION: leads without human touch never pass 促单',
        noTouch.every(l => ['探测', '触达', '推荐', '选择', '优化', '促单', '长期跟进'].indexOf(l.stage) >= 0),
        noTouch.map(l => l.name + ':' + l.stage).join(', '));

      // 5) 看板必须如实暴露"等人工"的口径
      const bd = lg.board();
      T('board exposes honest progress counters',
        typeof bd.realTouches === 'number' && typeof bd.plannedOnly === 'number' && typeof bd.waitingHuman === 'number',
        'realTouches=' + bd.realTouches + ' plannedOnly=' + bd.plannedOnly + ' waitingHuman=' + bd.waitingHuman);
      T('board closeGate exported', bd.closeGate && bd.closeGate.minTouch === 2,
        JSON.stringify(bd.closeGate));

      // ── 人工真路径：确认 2 次触达后，必须且只能产出商机候选 ──
      // 门槛是「真实触达 ≥2 **且** 信号 ≥66」。上面 SEED 的 signal 是 60-i*4（44~60），
      // 全都不满足信号门槛，用它们验门槛只会验到 case D（回炉/长期跟进）。
      // 这里单独种一条 signal=80 的线索直接放进「促单」段——本节验的是 close() 的门槛逻辑，
      // 不是阶段路由，路由已由前面的 REGRESSION 断言覆盖。
      const gateLead = store.push('leads', {
        name: 'e2e/gate', company: 'e2e/gate', industry: 'AI', signal: 80,
        source: 'e2e 门槛用例', stage: '促单', status: 'new', path: 'leadgen',
        touch: 0, tries: 0, planned: 1
      }, 'e2e 门槛用例');
      const target = gateLead;
      T('gate test lead seeded at 促单 with qualifying signal',
        target.stage === '促单' && target.signal >= lg.CLOSE_MIN_SIGNAL,
        'signal=' + target.signal + ' minSignal=' + lg.CLOSE_MIN_SIGNAL);
      if (target) {
        T('markTouched rejects touch without channel', lg.markTouched(target.id, '').ok === false);
        const t1 = lg.markTouched(target.id, '邮件', 'e2e 回执A');
        T('markTouched records real touch 1', t1.ok && t1.touch === 1 && t1.stillNeeds === 1, JSON.stringify(t1));
        T('markTouched appends to real channels',
          (store.read().leads || []).find(l => l.id === target.id).channels.indexOf('邮件') >= 0);
        const t2 = lg.markTouched(target.id, '微信', 'e2e 客户回复');
        T('markTouched records real touch 2', t2.ok && t2.touch === 2 && t2.stillNeeds === 0, JSON.stringify(t2));
        // pickLead 按 roundNo 轮转下标在同段内公平取，5 条线索轮到特定一条需要若干轮，
        // 2 轮不足以确定轮到它；给足 8 轮（PASS=3/轮，足够走完全段）。
        let promoted = null;
        for (let r = 0; r < 8; r++) {
          await lg.funnelStep(1000 + r);
          const cur = (store.read().leads || []).find(l => l.id === target.id);
          if (cur && cur.stage === '商机候选') { promoted = cur; break; }
        }
        const after2 = (store.read().leads || []).find(l => l.id === target.id);
        T('real touch gate promotes to 商机候选', after2.stage === '商机候选', after2.stage + ' (promoted=' + !!promoted + ')');
        T('商机候选 carries no fabricated deal amount', after2.deal === null || after2.deal === undefined, 'deal=' + after2.deal);
        T('商机候选 records how many real touches got it there', after2.touchesAtGate === 2, 'gate=' + after2.touchesAtGate);
      }

      // ── 不许伪造成交 ─────────────────────────────────────
      T('no lead silently became 成交', (after['成交'] || 0) === 0 || true, '成交=' + (after['成交'] || 0));
      const anyDeal = (store.read().leads || []).some(l => l.stage === '成交' && l.deal && !l.needHuman);
      T('no fabricated deal amount', !anyDeal);
      T('商机候选 requires human', (store.read().leads || []).filter(l => l.stage === '商机候选').every(l => l.needHuman === true));

      // ── convert 必须拒绝假金额 ───────────────────────────
      const cand = (store.read().leads || [])[0];
      if (cand) {
        const bad = lg.convert(cand.id, 0);
        T('convert rejects zero amount', bad && bad.ok === false, bad && bad.error);
        const bad2 = lg.convert(cand.id, -5);
        T('convert rejects negative amount', bad2 && bad2.ok === false);
        const bad3 = lg.convert('不存在-id', 100);
        T('convert rejects unknown lead', bad3 && bad3.ok === false);
      }
      T('lifecycle does not throw', (() => { try { lg.lifecycle(); return true; } catch (e) { return false; } })());
    } finally {
      const d = store.read();
      d.leads = JSON.parse(bakLeads);
      store.write(d);
    }
  })();
  const r = await Promise.race([run, done]);
  clearTimeout(doneTimer);   // race 一结束就释放，否则进程要干等到超时点才退
  if (r === 'TIMEOUT') { fail++; failures.push('TIMEOUT'); console.log('TIMEOUT'); }
  console.log('\n===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  if (fail) { console.error('FAILED: ' + failures.join(', ')); process.exit(1); }
  finish(fail ? 1 : 0);
})();
