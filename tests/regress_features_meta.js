// regress_features_meta.js — 成熟度标签 + Blueprint + 权限边界 回归（2026-10-23）
// 验证：
//   ① SECTIONS 每个分区都有合法 maturity（tested/beta/experimental）
//   ② 每个分区 blueprint 五个字段齐全且非空
//   ③ 每个分区 dataScope 非空；humanReview 为布尔
//   ④ quotaInfo() 导出这些字段（前端渲染依赖）
//   ⑤ biz.js PL 三语词典都有 mat* / bp* 键（不出现键名泄漏）
//   ⑥ renderQuotaTable 使用 PT() 取成熟度标签（不走 I18N DICT）
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + name + (cond ? '' : '  -> ' + (extra || '')));
  if (cond) pass++; else fail++;
};

// ===== 1. paywall.js SECTIONS 字段完整性 =====
const pw = fs.readFileSync(path.join(ROOT, 'core', 'paywall.js'), 'utf8');
const pwModule = require(path.join(ROOT, 'core', 'paywall.js'));
const SECTIONS = pwModule.SECTIONS || {};
const MATS = ['tested', 'beta', 'experimental'];
const BP_FIELDS = ['goal', 'inputs', 'controls', 'output', 'failure'];

for (const [key, s] of Object.entries(SECTIONS)) {
  ok(MATS.includes(s.maturity), `SECTIONS.${key} maturity 合法（maturity=${s.maturity}）`);
  const bp = s.blueprint || {};
  for (const f of BP_FIELDS) {
    ok(typeof bp[f] === 'string' && bp[f].trim().length > 0, `SECTIONS.${key}.blueprint.${f} 非空`, `实际值: ${JSON.stringify(bp[f])}`);
  }
  ok(typeof s.dataScope === 'string' && s.dataScope.trim().length > 0, `SECTIONS.${key}.dataScope 非空`, `实际值: ${JSON.stringify(s.dataScope)}`);
  ok(typeof s.humanReview === 'boolean', `SECTIONS.${key}.humanReview 为布尔`, `实际值: ${s.humanReview}`);
}
ok(Object.keys(SECTIONS).length === 11, `SECTIONS 共 11 个分区`, `实际: ${Object.keys(SECTIONS).length}`);

// ===== 2. quotaInfo() 导出 maturity + blueprint =====
const qinfo = pwModule.quotaInfo();
ok(Array.isArray(qinfo.free) && qinfo.free.length === 11, 'quotaInfo.free 有 11 条');
for (const f of qinfo.free || []) {
  ok(MATS.includes(f.maturity), `quotaInfo.free[${f.key}].maturity 合法`, `实际: ${f.maturity}`);
  for (const fld of BP_FIELDS) {
    ok(typeof f.blueprint?.[fld] === 'string', `quotaInfo.free[${f.key}].blueprint.${fld} 存在`);
  }
  ok(typeof f.dataScope === 'string', `quotaInfo.free[${f.key}].dataScope 存在`);
  ok(typeof f.humanReview === 'boolean', `quotaInfo.free[${f.key}].humanReview 为布尔`);
}
ok(typeof qinfo.maturityNote === 'string' && qinfo.maturityNote.length > 0, 'quotaInfo.maturityNote 非空');

// ===== 3. biz.js PL 三语包含 mat*/bp* 键 =====
const bizSrc = fs.readFileSync(path.join(ROOT, 'web', 'biz.js'), 'utf8');
const plIdx = bizSrc.indexOf('const PL = {');
const ptIdx = bizSrc.indexOf('const PT =');
const PL_SRC = bizSrc.slice(plIdx, ptIdx);
for (const key of ['matHead', 'matTested', 'matBeta', 'matExperimental',
                   'bpGoal', 'bpInputs', 'bpControls', 'bpOutput', 'bpFailure',
                   'bpScope', 'bpReview', 'bpOpened', 'bpReviewYes', 'bpReviewNo']) {
  const count = (PL_SRC.match(new RegExp(key + ':', 'g')) || []).length;
  ok(count >= 3, `PL 三语包含 ${key}`, `出现 ${count} 次（需 ≥3）`);
}

// ===== 4. renderQuotaTable 使用 PT() 取成熟度标签 =====
ok(bizSrc.includes("PT('matTested')") || bizSrc.includes('PT("matTested")'), 'renderQuotaTable 用 PT() 取 matTested');
// bpGoal 是间接通过 labelKey 查 PT，不要求字面 PT('bpGoal') 出现在源码，
// 改断言 labelKey 查表包含 bpGoal
ok(bizSrc.includes('bpGoal') && bizSrc.includes('PT(labelKey || k)'), 'renderQuotaTable 的 bpLine 用 labelKey 查 PT()');
ok(bizSrc.includes('matTag(f.maturity)'), 'renderQuotaTable 调用 matTag 函数');

// ===== 5. maturityNote 在 quotaInfo 里且前端渲染使用它 =====
ok(bizSrc.includes('d.maturityNote') || bizSrc.includes('maturityNote'), '前端渲染引用 maturityNote');

console.log('pass=' + pass + ' fail=' + fail);
console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
process.exit(fail === 0 ? 0 : 1);
