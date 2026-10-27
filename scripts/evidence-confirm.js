#!/usr/bin/env node
// scripts/evidence-confirm.js — 确认一条证据（确认后才计入门禁）
// 用法: node scripts/evidence-confirm.js <evidenceId>
const pipe = require('../core/evidence-pipeline');

function main() {
  const id = process.argv[2];
  if (!id) { console.error('用法: node scripts/evidence-confirm.js <evidenceId>'); process.exit(1); }
  const r = pipe.confirm(id);
  if (!r.ok) { console.error('[FAIL]', r.error); process.exit(1); }
  console.log('[OK] 证据已确认:', r.evidence.id);
  console.log('  quote:', r.evidence.quote.slice(0, 80));
  console.log('  tags:', (r.evidence.tags || []).join(',') || '(无)');
  console.log('');
  console.log('查看现状: node scripts/evidence-status.js');
}
main();
