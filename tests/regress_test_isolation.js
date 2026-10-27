require('./_isolate');   // 【2026-10-23】隔离测试数据目录，绝不写生产库
// regress_test_isolation.js — 测试隔离守卫（2026-10-23）
//
// 【事故】生产库出现 129 笔 void_test 订单、真实营收被测试单抬高 ¥198、
// 管理令牌被测试轮换 —— 根因是**测试直接跑在生产 data/db.json 上**。
// 本守卫做静态检查：任何会写库的测试文件，必须先 require('./_isolate')。
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let pass = 0, fail = 0;
const ok = (c, n, ex) => {
  console.log((c ? '  [PASS] ' : '  [FAIL] ') + n + (c ? '' : '  -> ' + (ex || '')));
  c ? pass++ : fail++;
};

// 会触碰持久层的测试特征
const MUTATING = [
  /require\(['"][^'"]*core\/(store|subs|money|pay|cost|provisional|subs)['"]\)/,
  /BINGDASHAN_PORT/,
  /spawn\([^)]*server\.js/,
];

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.js') && f !== '_isolate.js' && f !== 'regress_test_isolation.js');
let checked = 0;
files.forEach(f => {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  const mutating = MUTATING.some(re => re.test(src));
  if (!mutating) return;
  checked++;
  ok(src.includes("require('./_isolate')"), `${f} 已隔离数据目录`, '缺少 require(\'./_isolate\')');
});
ok(checked >= 10, '扫描到足够多的写库测试', 'checked=' + checked);

// _isolate 必须在 store 之前设置环境变量
const iso = fs.readFileSync(path.join(DIR, '_isolate.js'), 'utf8');
ok(iso.includes('BINGDASHAN_DATA_DIR'), '_isolate 设置 BINGDASHAN_DATA_DIR');
ok(/if\s*\(!\s*process\.env\.BINGDASHAN_DATA_DIR\)/.test(iso), '_isolate 尊重外部已设置的值（CI 可覆盖）');
ok(iso.indexOf('BINGDASHAN_DATA_DIR') < iso.indexOf('module.exports'), '_isolate 在导出前完成设置');

// 生产路径不得被默认使用
ok(!/BINGDASHAN_DATA_DIR\s*=\s*[^;]*project/i.test(iso), '_isolate 不指向项目目录');

console.log('pass=' + pass + ' fail=' + fail);
console.log(fail === 0 ? 'ALL PASS' : 'FAILED');
process.exit(fail === 0 ? 0 : 1);
