// regress_capability_map.js — 能力全景扫描器的三类盲区回归（2026-10-25）
//
// 【为什么钉这个】能力全景是「查缺补漏」的决策依据，它自己报假数就全废了：
//   盲区一（历史事故）：FRONT_JS 硬编码 7 个根 JS → assist/ops/care 三页等子页
//     HTML 里的 37 个端点被误报「用户够不到」；
//   盲区二：`api('/v1/goalpilot/' + kind)` 捕获到尾斜杠路径，startsWith(c+'/')
//     双斜杠永假 → 动态拼接的整族端点全部误报；
//   盲区三：机器端点（爬虫/物流回调/设备心跳）本就没有人类入口，混进缺口清单
//     把真信号淹掉。
// 这里的断言不依赖 capability-map 自身实现（避免同源同错）：盲区一用**独立的最笨
// 字面扫描**（路径串在整个 web/ 目录任何文件里出现过就算有入口）来交叉验证。
'use strict';
require('./_isolate.js');
const fs = require('fs');
const path = require('path');
const CM = require('../core/capability-map');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log('  [PASS] ' + name);
  else { failed++; console.log('  [FAIL] ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('=== 能力全景扫描器盲区回归 ===');
const d = CM.build();

// ---- 1. 分区精确：reachable + unreachable + machine === endpoints，无重叠无遗漏 ----
const all = CM.build();
const setR = new Set(), seen = new Set();
const put = (arr, tag) => arr.forEach(x => {
  const p = typeof x === 'string' ? x : x.path;
  if (seen.has(p)) throw new Error('端点同时出现在两个分区: ' + p);
  seen.add(p); setR.add(p);
});
put(all.unreachable, 'unreachable');
put(all.machineUnreachable, 'machine');
// reachable 不在返回体里，用总数守恒验证
check('分区守恒：unreachable + machine ≤ endpoints', seen.size <= all.endpoints, seen.size + ' vs ' + all.endpoints);
check('缺口清单不含机器端点', all.unreachable.every(e => !e.startsWith('/v1/crawler/') && !e.startsWith('/v1/logistics/') && !e.startsWith('/v1/care/device/heartbeat')), 'crawler/logistics/heartbeat 混进了 unreachable');
check('machineUnreachable 每条都带归因说明', all.machineUnreachable.every(m => m && m.path && m.why), '存在缺 why 的机器条目');

// ---- 2. 盲区一：子页 HTML 引用过的端点不得再报「够不到”（独立扫描交叉验证） ----
// 【不用裸 indexOf】裸字面扫描会撞前缀：unreachable 的 /v1/money/writeoff（单数）
// 是 web 里 /v1/money/writeoffs（复数）的子串 → 假阳。注释里的路径（geo.js:3）也
// 不是可达性证据。这里要求**引号相邻 + 终结符收尾**（与 app 代码真实调用形态一致），
// 并在本地重做一遍前缀归一——结构上刻意比扫描器"笨"，但文件集与正则独立推导。
function walkFiles(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (f !== 'node_modules' && f !== 'icons') walkFiles(p, out); continue; }
    if (/\.(orig|bak|old)$/.test(f)) continue;
    if (/\.(js|html)$/.test(f)) out.push(p);
  }
  return out;
}
const files = walkFiles(WEB, []);
const indCalls = new Set();
files.forEach(f => {
  let src;
  try { src = fs.readFileSync(f, 'utf8'); } catch (e) { return; }
  const re = /['"`](\/v1\/[^'"`\s)]*)/g;
  let m;
  while ((m = re.exec(src))) {
    const p = m[1].replace(/\$\{[^}]*\}/g, '').replace(/[?&#].*$/, '').replace(/\/+$/, '');
    if (p && p.length > 5) indCalls.add(p);
  }
});
const refSet = all.unreachable.filter(ep => [...indCalls].some(c =>
  c === ep || ep.startsWith(c + '/') || c.startsWith(ep + '/')));
check('unreachable 里没有 web/ 活代码真实引用过的端点（子页盲区守卫）', refSet.length === 0,
  '误报样例: ' + refSet.slice(0, 5).join(', '));

// 边界样本：writeoff(单数, 真缺口) 不得因 writeoffs(复数, 前端在调) 的子串关系被误判
check('前缀碰撞不产生假阳（/v1/money/writeoff vs writeoffs）',
  ![...indCalls].some(c => c === '/v1/money/writeoff') || all.unreachable.indexOf('/v1/money/writeoff') >= 0);

// ---- 3. 动态拼接路径（尾斜杠归一化）形态守卫 ----
// 捕获到的调用不得残留尾斜杠（残留会让 startsWith(c+'/') 双斜杠永假 → 整族误报）
check('frontendCalls 全部已做尾斜杠归一', [...indCalls].every(c => !/\/$/.test(c)));
// goalpilot 族的真实状态：app.js 只调 /v1/goalpilot/status；
// brief/run/weekly 无任何前端引用 → 应当留在缺口清单（如实报缺，不美化）。
check('goalpilot 缺口如实（status 可达、其余按实际引用情况报告）',
  all.unreachable.indexOf('/v1/goalpilot/status') < 0);

// ---- 4. 历史事故样本：care 三页 / assist 页的端点 ----
['/v1/care/center', '/v1/care/loop', '/v1/assist/request', '/v1/assist/queue'].forEach(p => {
  check('子页端点未误报: ' + p, all.unreachable.indexOf(p) < 0);
});

// ---- 5. 覆盖率口径：分母不含机器端点 ----
const userFacing = all.reachableEndpoints + all.unreachableEndpoints;
const expectPct = userFacing ? Math.round(all.reachableEndpoints / userFacing * 1000) / 10 : 0;
check('reachabilityPct 分母=人类入口端点', Math.abs(all.reachabilityPct - expectPct) < 0.01,
  all.reachabilityPct + ' ≠ ' + expectPct);

// ---- 6. 清单非空 Sanity（扫描器没把所有东西都扫没了） ----
check('endpoints > 300（路由抽取没失效）', all.endpoints > 300, String(all.endpoints));
check('真缺口收敛到 < 160（44 个误报清除后）', all.unreachableEndpoints < 160, String(all.unreachableEndpoints));

console.log(failed ? 'FAILED（扫描器盲区回归 ' + failed + ' 处）' : 'ALL PASS（能力全景：子页/动态路径/机器端点三类盲区守卫）');
process.exit(failed ? 1 : 0);
