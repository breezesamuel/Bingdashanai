// regress_maturity.js — 成熟度校准脚本回归（2026-10-23）
'use strict';
require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
const path = require('path');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, n, ex) => {
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + n + (c ? '' : '  -> ' + (ex || '')));
  c ? pass++ : fail++;
};

// 模块可加载
const mat = require(path.join(ROOT, 'core', 'maturity.js'));
ok(typeof mat.suggest === 'function', 'mat.suggest 导出');
ok(typeof mat.report === 'function', 'mat.report 导出');
ok(typeof mat.persist === 'function', 'mat.persist 导出');

// report 结构
const rep = mat.report();
ok(Array.isArray(rep.rows) && rep.rows.length === 11, 'report.rows 有 11 行（每个分区一条）', `实际 ${rep.rows ? rep.rows.length : 'null'}`);
const first = rep.rows[0] || {};
ok(typeof first.usage7d === 'number', 'row.usage7d 为数字', `实际: ${first.usage7d}`);
ok(typeof first.faults24h === 'number', 'row.faults24h 为数字');
ok(['experimental','beta','tested'].includes(first.maturity), 'row.maturity 合法', `实际: ${first.maturity}`);
ok(Array.isArray(rep.suggestions), 'report.suggestions 是数组');
ok(typeof rep.ts === 'string' && rep.ts.length > 0, 'report.ts 有 ISO 时间戳');
ok(typeof rep.note === 'string' && rep.note.includes('人工'), 'report.note 含人工确认提示');

// suggest() 空故障场景：所有 experimental 且用量≥10 的会建议升 beta
const sug = mat.suggest();
ok(Array.isArray(sug), 'suggest() 返回数组');
sug.forEach(s => {
  ok(['experimental','beta','tested'].includes(s.current), `suggestion[${s.section}].current 合法`);
  ok(['experimental','beta','tested', s.suggested].includes(s.suggested) || s.suggested === s.current, `suggestion[${s.section}].suggested 合法或不变`);
});

// ===== 关键：persist() 必须真的能跑通（2026-10-23 修补 store.upsert 不存在的 bug）=====
// 之前只断言了 typeof persist === 'function'，运行时却抛 TypeError，
// 这类"函数存在但一调用就炸"的 bug 必须用真实调用来捕获。
let persistOk = false, persistErr = '';
try {
  const pr = mat.persist();
  persistOk = !!(pr && typeof pr.ts === 'string' && Array.isArray(pr.rows));
} catch (e) {
  persistErr = String(e && e.message || e);
}
ok(persistOk, 'persist() 真实调用成功（不只是存在）', persistErr);

// 存档应可读回，且是追加历史（不覆盖）
try {
  const store = require(path.join(ROOT, 'core', 'store.js'));
  const hist = store.list('maturity-reports', 50) || [];
  ok(hist.length >= 1, 'maturity-reports 存档可读回', `实际 ${hist.length} 条`);
  const last = hist[hist.length - 1] || {};
  ok(typeof last.ts === 'string' && Array.isArray(last.suggestions), '存档记录含 ts 与 suggestions');
  ok(!!last.id && !!last.createdAt, 'store.push 自动补 id/createdAt');
} catch (e) {
  ok(false, 'maturity-reports 存档可读回', String(e && e.message || e));
}

// ===== 2026-10-24：真实故障源接通（faultsLast24h 不再恒为 0）=====
const store2 = require(path.join(ROOT, 'core', 'store.js'));
ok(typeof mat.recordFault === 'function', 'mat.recordFault 导出');
ok(Object.keys(mat.faultsLast24h()).length === 0, '初始无故障记录 → faultsLast24h 为空');
mat.recordFault('@public', '公共端点不该记');
mat.recordFault('', '空分区不该记');
ok(store2.list('faults', 99).length === 0, '@public/空分区不落 faults（公共端点不是故障面）');
mat.recordFault('decision', 'POST /v1/x → 500');
mat.recordFault('decision', 'POST /v1/y → 500');
mat.recordFault('decision', 'POST /v1/z → 500');
const f24 = mat.faultsLast24h();
ok(f24.decision === 3, '3 次 recordFault → faultsLast24h.decision=3', JSON.stringify(f24));
// 降级建议真的会被触发（此前该路径因恒 0 从未生效）
const sugF = mat.suggest().find(s => s.section === 'decision');
ok(!!sugF && sugF.current === 'tested' && sugF.suggested === 'beta' && /故障 3 次/.test(sugF.reason),
  'decision 24h 3 故障 → 建议 tested 降 beta（降级规则首次真数据生效）', JSON.stringify(sugF));
// report 里 faults24h 如实反映
ok(mat.report().rows.find(r => r.section === 'decision').faults24h === 3, 'report.rows.faults24h 反映真实故障数');
// 封顶清理不炸
for (let i = 0; i < 505; i++) mat.recordFault('music', 'cap-test-' + i);
ok(store2.list('faults', 9999).length <= 500 + 4, 'faults 表封顶 ≤500（扫描器打爆 5xx 撑不穿库）', String(store2.list('faults', 9999).length));

console.log('pass=' + pass + ' fail=' + fail);
console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
process.exit(fail === 0 ? 0 : 1);
