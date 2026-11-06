// regress_api_mismatch.js — 「调不存在导出方法」运行时冒烟回归（2026-11-06）
//
// 【为什么钉这个】2026-11-06 审计发现一类隐蔽 bug：模块 A 调用 B.method()，
// 但 B 的 module.exports 根本没导出 method → 运行期 TypeError（多渠道 webhook 渠道
// 因此全死：outreach-multichannel 调 outreach.webhookSend，而 webhookSend 是内部函数、
// 从未出现在 module.exports 里）。静态正则扫不全（单字母变量跨函数复用、作用域影子），
// 只有「真跑一遍」能抓。本回归把「require 全部 core 模块 + 跑全部 capability run()」
// 钉成常驻防线：任何后续编辑若再造成「调不存在的方法」即 FAIL。
//
// 按仓库约定：require('./_isolate.js')（独立临时数据目录，零污染），断言不依赖单源实现。
'use strict';
require('./_isolate.js');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log('  [PASS] ' + name);
  else { failed++; console.log('  [FAIL] ' + name + (detail ? ' — ' + detail : '')); }
}

// 切到仓库根，保证相对 require('./core/...') 正确
process.chdir(ROOT);

console.log('=== 「调不存在导出方法」运行时冒烟回归 ===');

// ---- 1) 全部 core 模块可加载（load-time 无断链/语法错）----
const coreDir = path.join(ROOT, 'core');
const mods = fs.readdirSync(coreDir).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, ''));
let loadFail = 0; const loadErrs = [];
for (const m of mods) {
  try { delete require.cache[require.resolve(path.join(coreDir, m + '.js'))]; require(path.join(coreDir, m + '.js')); }
  catch (e) { loadFail++; loadErrs.push(m + ': ' + String(e.message).slice(0, 100)); }
}
check('全部 ' + mods.length + ' 个 core 模块可加载（load 失败 ' + loadFail + '）', loadFail === 0, loadErrs.join(' | '));

// ---- 2) 每个 capability 项 run() 不崩（运行期无「调不存在方法」）----
const cap = require(path.join(coreDir, 'capability.js'));
let caps;
check('capability.allCaps() 可用', (caps = cap.allCaps()) && Array.isArray(caps) && caps.length > 0, 'caps=' + (caps && caps.length));
if (Array.isArray(caps)) {
  let crash = 0; const crashErrs = [];
  for (const c of caps) {
    try { c.run(); }
    catch (e) {
      crash++;
      if (/is not a function|undefined\.|not defined|Cannot read prop/i.test(String(e.message))) crashErrs.push(c.id + ': ' + String(e.message).slice(0, 90));
    }
  }
  check('全部 ' + caps.length + ' 项 capability run() 无运行期崩', crash === 0, crashErrs.slice(0, 6).join(' | '));
}

// ---- 3) 定向：outreach.webhookSend 已导出（A 修复不回归）----
const outreach = require(path.join(coreDir, 'outreach.js'));
check('outreach.webhookSend 已导出（多渠道 webhook 不再 TypeError）', typeof outreach.webhookSend === 'function', 'typeof=' + typeof outreach.webhookSend);
check('outreach.sendRaw 已导出（webhook 主链路）', typeof outreach.sendRaw === 'function', 'typeof=' + typeof outreach.sendRaw);

// ---- 4) 定向：新增 3 个去孤岛 capability 已注册 ----
const ids = (caps || []).map(x => x.id);
check('cap.maturity / cap.dataqsql / cap.workflow16 已注册', ids.includes('cap.maturity') && ids.includes('cap.dataqsql') && ids.includes('cap.workflow16'), 'found=' + ['cap.maturity','cap.dataqsql','cap.workflow16'].filter(x => ids.includes(x)).join(','));
check('cap.anomalyscan 已注册 + anomaly-scan 可加载', ids.includes('cap.anomalyscan') && (() => { try { const A = require('../core/anomaly-scan'); return typeof A.scan === 'function' && typeof A.status === 'function' && typeof A.review === 'function' && typeof A.calibration === 'function' && typeof A.runOnce === 'function'; } catch (e) { return false; } })(), 'anomaly-scan 导出缺失');
check('anomaly-scan IQR 稀疏序列判定 + k 映射（纯函数，不依赖数据）', (() => { try { const I = require('../core/anomaly-scan')._internal; const hit = I.iqrDetect([0, 0, 0, 0, 0, 0, 10], 1.5); const flat = I.iqrDetect([5, 5, 5, 5, 5, 5, 5], 1.5); return hit.hit === true && hit.dir === 'spike' && flat.hit === false && I.kToIqrMult(3) === 1.5 && I.kToIqrMult(6) === 2.5; } catch (e) { return false; } })(), 'IQR 判定或 k 映射异常');

console.log('\n=== ' + (failed ? failed + ' FAILED' : 'ALL PASS') + ' ===');
process.exit(failed ? 1 : 0);
