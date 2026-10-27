// regress_i18n_audit.js — 全站三语覆盖审计包装（2026-10-24）
//
// scripts/i18n_audit.js 本身就是带退出码的门禁（0=全覆盖，1=有漏翻），
// 这里包一层，让 run_all.sh 统一以 "ALL PASS" 字样判定。
// 【为什么必须进门禁】语言夹生（"用邮箱找回Subscribe"这类）曾长期无人发现——
// 贪婪分段翻译只翻词表里有的词，新功能上线只要没配整句词条就必然夹生。
// 审计每跑一次，就把当天的增量夹生拦在部署前。
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'i18n_audit.js')], {
  encoding: 'utf8', timeout: 120000,
});
const out = String(r.stdout || '') + String(r.stderr || '');
// 摘录关键行（接线异常 / 漏翻合计）
const key = out.split(/\r?\n/).filter(l => /接线|漏翻合计|覆盖对象|MISS/.test(l));
key.forEach(l => console.log('  ' + l.slice(0, 160)));

const wiredBad = /接线异常:\s*[1-9]/.test(out);
const missTotal = (out.match(/漏翻合计:\s*(\d+)/) || [])[1];
const failed = r.status !== 0 || wiredBad || (missTotal && Number(missTotal) > 0);

console.log(failed ? 'FAILED' : 'ALL PASS（三语覆盖：接线 0 异常、漏翻 0）');
process.exit(failed ? 1 : 0);
