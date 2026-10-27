// money-e2e: 账实分离契约 —— 成交≠到账；挂账不计 KPI/不提推广费；结算必须带凭证。
// 只打隔离实例（BINGDASHAN_E2E_BASE），绝不碰生产 db。
const { finish } = require('./_exit');
const http = require('http');

let pass = 0, fail = 0;
const T = (name, ok, extra) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' . ' + extra : ';')); };

const { requireIsolated } = require('./_guard');
const BASE = requireIsolated('money-e2e');

function req(method, p, body) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + p, {
      method, headers: { 'Content-Type': 'application/json' }
    }, resp => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => { try { res({ code: resp.statusCode, body: JSON.parse(d) }); } catch (e) { res({ code: resp.statusCode, body: d }); } });
    });
    r.setTimeout(20000, () => { r.destroy(); res({ code: 0, body: { raw: 'timeout' } }); });
    r.on('error', e => res({ code: 0, body: { raw: String(e) } }));
    r.end(data || undefined);
  });
}
const G = p => req('GET', p);
const P = (p, b) => req('POST', p, b || {});
const n = v => Math.round(Number(v) * 100) / 100;

(async () => {
  console.log('--- 账实分离 e2e @ ' + BASE + ' ---');

  // 基线
  const k0 = (await G('/v1/money/kpi')).body;
  const rev0 = n(k0.revenue), promo0 = n(k0.promo.allotted);
  T('KPI 暴露 pending 字段', k0.pending !== undefined, 'pending=' + k0.pending);
  T('KPI 暴露 receivable 摘要', !!(k0.receivable && k0.receivable.awaiting !== undefined), JSON.stringify(k0.receivable));

  // ① 已到账（默认）：应立刻计入 revenue 并计提 5% 推广费
  const c1 = (await P('/v1/money/credit', { amt: 1000, source: 'e2e-已到账', method: '支付宝' })).body;
  T('credit 默认已到账返回 ok', c1.ok === true);
  T('credit 默认 settled=true', c1.settled === true, 'promo=' + c1.promo);
  const k1 = (await G('/v1/money/kpi')).body;
  T('已到账计入 revenue', n(k1.revenue) === n(rev0 + 1000), rev0 + ' -> ' + k1.revenue);
  T('已到账计提 5% 推广费', n(k1.promo.allotted) === n(promo0 + 50), promo0 + ' -> ' + k1.promo.allotted);

  // ② 仅成交未到账：不得计入 revenue、不得计提推广费
  const c2 = (await P('/v1/money/credit', { amt: 800, source: 'e2e-仅成交', method: '工商银行转账', settled: false })).body;
  T('挂账返回 ok', c2.ok === true);
  T('挂账 settled=false', c2.settled === false);
  T('挂账不计提推广费', n(c2.promo) === 0, 'promo=' + c2.promo);
  const k2 = (await G('/v1/money/kpi')).body;
  T('挂账不计入 revenue', n(k2.revenue) === n(rev0 + 1000), 'revenue=' + k2.revenue + '（应仍为 ' + n(rev0 + 1000) + '）');
  T('挂账进 pending', n(k2.pending) === n((k1.pending || 0) + 800), 'pending=' + k2.pending);
  T('挂账不撑推广预算', n(k2.promo.allotted) === n(promo0 + 50), 'allotted=' + k2.promo.allotted);

  // ③ 无凭证结算：必须拒绝
  const s0 = await P('/v1/money/settle', { id: c2.rec.id });
  T('无凭证结算应被拒(400)', s0.code === 400, 'code=' + s0.code);
  const s1 = await P('/v1/money/settle', { id: c2.rec.id, evidence: '   ' });
  T('空白凭证应被拒(400)', s1.code === 400, 'code=' + s1.code);
  const k3 = (await G('/v1/money/kpi')).body;
  T('被拒后 revenue 不变', n(k3.revenue) === n(rev0 + 1000), 'revenue=' + k3.revenue);

  // ④ 不存在的记录
  const s2 = await P('/v1/money/settle', { id: 'no-such-id', evidence: '流水号 X' });
  T('不存在的记录应被拒(400)', s2.code === 400, 'code=' + s2.code);

  // ⑤ 带凭证结算：转实收 + 补提推广费
  const s3 = (await P('/v1/money/settle', { id: c2.rec.id, evidence: '工行流水 622203****2672 入账 800', method: '工商银行转账' })).body;
  T('带凭证结算 ok', s3.ok === true);
  T('结算后 settled=true', s3.settled === true, 'promo=' + s3.promo);
  T('结算补提 5% 推广费', n(s3.promo) === 40, 'promo=' + s3.promo);
  const k4 = (await G('/v1/money/kpi')).body;
  T('结算后计入 revenue', n(k4.revenue) === n(rev0 + 1800), 'revenue=' + k4.revenue);
  T('结算后 pending 归零', n(k4.pending) === n(k1.pending || 0), 'pending=' + k4.pending);
  T('结算后推广费补提入池', n(k4.promo.allotted) === n(promo0 + 90), 'allotted=' + k4.promo.allotted);

  // ⑥ 重复结算应幂等，不重复计提
  const s4 = (await P('/v1/money/settle', { id: c2.rec.id, evidence: '重复提交' })).body;
  T('重复结算幂等 already=true', s4.already === true);
  T('重复结算不重复计提', n(s4.promo) === 0, 'promo=' + s4.promo);
  const k5 = (await G('/v1/money/kpi')).body;
  T('重复结算后 revenue 不变', n(k5.revenue) === n(k4.revenue), 'revenue=' + k5.revenue);
  T('重复结算后推广池不变', n(k5.promo.allotted) === n(k4.promo.allotted), 'allotted=' + k5.promo.allotted);

  // ⑦ 应收台账接口
  const rc = (await G('/v1/money/receivable')).body;
  T('应收台账接口可用', rc.ok === true && Array.isArray(rc.rows), 'rows=' + (rc.rows ? rc.rows.length : 'n/a'));

  console.log('');
  // runner 靠这行裁定断言真值，格式必须与其他套件一致
  console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL =====');
  finish(fail ? 1 : 0);
})().catch(e => { console.log('money-e2e err ' + e.message); fail++; console.log('===== ' + pass + ' PASS / ' + fail + ' FAIL ====='); process.exit(1); });
