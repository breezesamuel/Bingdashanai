#!/usr/bin/env node
// scripts/evidence-pipeline-test.js — 证据管线机制自测（自清理，不污染真实 db）
const store = require('../core/store');
const pipe = require('../core/evidence-pipeline');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

// 记录原始 marketEvidence 状态，测试结束恢复
const orig = store.read().marketEvidence;

console.log('=== 证据管线机制自测 ===');

// 1. 短句拒绝（不写入）
const r1 = pipe.captureReply({ leadId: 't1', channel: 'email', quote: '想看' });
ok(r1.ok === false, '短句(<8字)被拒绝');
ok((store.read().marketEvidence || []).length === 0, '短句未写入 db');

// 2. 臆测词拒绝
const r2 = pipe.captureReply({ leadId: 't2', channel: 'email', quote: '我觉得这个产品 internal 自用不错，可以试试' });
ok(r2.ok === false, '含臆测词被拒绝');

// 3. 合法真实感原话接受
const r3 = pipe.captureReply({
  leadId: 'lead_test', name: '测试线索', channel: '企业微信',
  quote: '我们正在找能减少选型盲目的工具，你们这个比市面上的方案怎么样？'
});
ok(r3.ok === true, '合法原话被接受');
const ev = r3.evidence;
ok(ev && ev.sourceType === 'chat', '触达回复默认 sourceType=chat');
ok(ev.quote.length >= 8, '逐字原话已存');
ok(Array.isArray(ev.tags) && ev.tags.length >= 1, '自动打标签: ' + (ev.tags || []).join(','));
ok(ev.confirmed === false, '新证据默认待确认');

// 4. 未确认不计入门禁
let st = pipe.status();
ok(st.total === 1 && st.confirmed === 0, '未确认不计入 confirmed');

// 5. 人工确认后计入
const c = pipe.confirm(ev.id);
ok(c.ok === true, '确认成功');
st = pipe.status();
ok(st.confirmed === 1, '确认后 confirmed=1');
const dims = st.dims.filter(d => d.confirmed >= 1).map(d => d.dim);
ok(dims.length >= 1, '有维度达标: ' + dims.join(','));

// 6. captureManual 必须带 sourceType + 原话
const m1 = pipe.captureManual({ sourceType: 'email', channel: '邮件', quote: '我们愿意付费试用，预算大概多少？' });
ok(m1.ok === true, '人工录入合法对话成功');
const m2 = pipe.captureManual({ sourceType: 'invalid', quote: '随便什么来源' });
ok(m2.ok === false, '无效 sourceType 被拒绝');

// ===== 自清理：恢复原始 marketEvidence =====
const db = store.read();
if (Array.isArray(orig)) db.marketEvidence = orig;
else delete db.marketEvidence;
store.write(db);

const after = pipe.status();
ok(after.total === 0, '测试后 db 已清理，无残留证据');

console.log('');
console.log('结果: pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
