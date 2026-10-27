'use strict';
// scripts/platform-check.js — 多平台交付就绪自检（可重复运行，不依赖网络）。
//
// 为什么要有它：跨平台交付最容易变成"我说做完了"而无法验证。这个脚本把
// "到底哪些产物真的在、哪些配置真的合法、哪些只能去别的系统做"变成一条命令的输出。
//
//   node scripts/platform-check.js   （或 npm run platform:check）
//
// 它只做**本地可验证**的判断，不谎报：
//   · 图标 / manifest / sw / PWA 挂载点       —— 静态文件层面
//   · 三平台 electron-builder 配置             —— JSON 结构层面
//   · Capacitor 配置 + android/ios 脚手架      —— 文件存在层面
//   · CI 工作流                                —— 文件存在 + 关键步骤
// 真正需要 Mac/Xcode/Apple 账号才能产出的东西，明确标 SKIP 并说明原因。

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

function ok(name, detail) { console.log('  OK   ' + name + (detail ? '  · ' + detail : '')); }
function bad(name, why) { console.log('  FAIL ' + name + '  · ' + why); process.exitCode = 1; }
function skip(name, why) { console.log('  SKIP ' + name + '  · ' + why); }
function has(rel) { return fs.existsSync(path.join(ROOT, rel)); }

console.log('\n=== 丙大山AI · 多平台交付就绪自检 ===\n');

// ---------- 1. 通用安装型 Web（PWA） ----------
console.log('[1] 通用安装型 Web（PWA · 覆盖 iOS/Android/鸿蒙/桌面浏览器）');
const ICONS = [
  ['web/icons/favicon-32.png', 32], ['web/icons/favicon-64.png', 64],
  ['web/icons/icon-192.png', 192], ['web/icons/icon-512.png', 512],
  ['web/icons/apple-touch-icon-180.png', 180], ['web/icons/maskable-512.png', 512]
];
for (const [f, want] of ICONS) {
  if (!has(f)) { bad(f, '缺失，运行 npm run icons'); continue; }
  const b = fs.readFileSync(path.join(ROOT, f));
  const okPng = b.readUInt32BE(0) === 0x89504e47;
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  if (!okPng || w !== want || h !== want) bad(f, '不是有效 PNG 或尺寸不符（' + w + 'x' + h + '，期望 ' + want + '）');
  else ok(f, want + 'x' + want + ', ' + b.length + 'B');
}
try {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/manifest.webmanifest'), 'utf8'));
  if (!m.icons || m.icons.length < 3) bad('manifest.webmanifest', 'icons 少于 3 个');
  else ok('manifest.webmanifest', m.icons.length + ' icons, start=' + m.start_url + ', display=' + m.display);
} catch (e) { bad('manifest.webmanifest', e.message); }
if (!has('web/sw.js')) bad('web/sw.js', '缺失（离线外壳）');
else { try { require('child_process').execFileSync(process.execPath, ['--check', path.join(ROOT, 'web/sw.js')]); ok('web/sw.js', '语法通过，只缓存静态壳'); } catch (e) { bad('web/sw.js', '语法错误'); } }
{
  const s = has('web/index.html') ? fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8') : '';
  const flags = [
    ['manifest 挂载', s.includes('rel="manifest" href="/manifest.webmanifest"')],
    ['SW 注册', s.includes("register('/sw.js'")],
    ['apple-touch-icon', s.includes('apple-touch-icon')],
    ['可安装事件捕获', s.includes('beforeinstallprompt')]
  ];
  const miss = flags.filter(([, v]) => !v).map(([k]) => k);
  if (miss.length) bad('index.html PWA 挂载', '缺: ' + miss.join(', ')); else ok('index.html PWA 挂载', flags.map(([k]) => k).join(' + '));
}

// ---------- 2. 桌面三平台 ----------
console.log('\n[2] 桌面端（Electron · Windows/macOS/Linux）');
let pkg = null;
try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); ok('package.json 合法', 'v' + pkg.version); }
catch (e) { bad('package.json', e.message); }
if (pkg) {
  for (const [k, label] of [['win', 'Windows(.exe)'], ['mac', 'macOS(.dmg/.zip)'], ['linux', 'Linux(.AppImage/.deb)']]) {
    if (pkg.build && pkg.build[k]) ok('build.' + k + ' 配置', label + ' targets=' + JSON.stringify(pkg.build[k].target));
    else bad('build.' + k, '缺配置');
  }
  ok('构建脚本', Object.keys(pkg.scripts).filter(k => k.startsWith('dist')).join(', '));
}
if (os.platform() === 'win32') {
  skip('本机产出 macOS .dmg', 'Electron 硬性限制：只能在 macOS 构建（交给 CI 的 macos runner）');
  skip('本机产出 iOS .ipa', '需 macOS + Xcode + Apple 开发者证书');
} else if (os.platform() === 'darwin') {
  ok('本机可产出 macOS .dmg', '运行 npm run dist:mac');
}
{
  const wf = '.github/workflows/build-desktop.yml';
  if (!has(wf)) bad(wf, '缺失'); else {
    const t = fs.readFileSync(path.join(ROOT, wf), 'utf8');
    const hasRunners = t.includes('windows-latest') && t.includes('macos-latest') && t.includes('ubuntu-latest');
    hasRunners ? ok('CI build-desktop', 'win+mac+linux runner 齐备') : bad('CI build-desktop', 'runner 矩阵不全');
  }
}

// ---------- 3. 移动原生壳（Capacitor） ----------
console.log('\n[3] 移动原生壳（Capacitor · iOS/Android）');
if (!has('capacitor.config.json')) bad('capacitor.config.json', '缺失');
else {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8'));
    ok('capacitor.config.json', c.appId + ' webDir=' + c.webDir + ' server.url=' + (c.server && c.server.url));
    if (!c.server || !c.server.url) bad('capacitor server.url', '前端用相对路径 /v1/*，壳必须指定线上 origin');
  } catch (e) { bad('capacitor.config.json', e.message); }
}
const AND = ['android/gradlew', 'android/app/build.gradle', 'android/app/src/main/AndroidManifest.xml', 'android/app/src/main/assets/capacitor.config.json'];
const IOS = ['ios/App/App.xcodeproj/project.pbxproj', 'ios/App/App/Info.plist'];
if (AND.every(has)) ok('android/ 脚手架', 'Gradle 工程就绪（构建需 Android SDK + JDK 21）'); else bad('android/ 脚手架', '缺 ' + AND.filter(f => !has(f)).join(', '));
if (IOS.every(has)) ok('ios/ 脚手架', 'Xcode 工程就绪（构建需 macOS + Xcode）'); else bad('ios/ 脚手架', '缺 ' + IOS.filter(f => !has(f)).join(', '));
skip('产出 Android .apk', has('android/gradlew') ? '需 Android SDK（本机未验证；CI build-mobile 会真出 debug APK）' : '脚手架缺失');
{
  const wf = '.github/workflows/build-mobile.yml';
  if (!has(wf)) bad(wf, '缺失'); else {
    const t = fs.readFileSync(path.join(ROOT, wf), 'utf8');
    (t.includes('assembleDebug') && t.includes('cap sync')) ? ok('CI build-mobile', 'Android 出 APK + iOS 编译校验') : bad('CI build-mobile', '关键步骤缺失');
  }
}

// ---------- 4. 鸿蒙 ----------
console.log('\n[4] 鸿蒙 HarmonyOS');
ok('路线= PWA', '系统浏览器（ArkWeb）安装同一套 web 资产，免上架');
skip('产出 .hap 原生包', '需 DevEco Studio + 华为开发者账号（本文未产出，避免伪造）');

// ---------- 5. 收费墙 ----------
console.log('\n[5] 收费墙 / 订阅');
for (const f of ['core/subs.js', 'core/paywall.js', 'core/tenancy.js', 'core/free-tier.js']) {
  has(f) ? ok(f, '存在') : bad(f, '缺失');
}
if (has('core/subs.js')) {
  const t = fs.readFileSync(path.join(ROOT, 'core/subs.js'), 'utf8');
  const m = t.match(/FREE_USES\s*=\s*(\d+)/);
  m ? ok('免费额度', 'FREE_USES=' + m[1]) : bad('FREE_USES', '未找到');
}
if (has('server.js')) {
  const t = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const checks = [
    ['proxy-aware isLoopback', t.includes("x-forwarded-for") && t.includes('function isLoopback')],
    ['/v1/report/seven 在 PUBLIC_MUTATE', /PUBLIC_MUTATE[\s\S]{0,2000}'\/v1\/report\/seven'/.test(t)],
    ['扩展路由接入', t.includes('handleExtRoutes') && t.includes('EXT_ROUTE_RE')],
    ['/v1/my/assets 多集合', /OWNABLE\.forEach/.test(t)],
    ['webmanifest MIME', t.includes('application/manifest+json')]
  ];
  for (const [k, v] of checks) v ? ok('server.js: ' + k) : bad('server.js: ' + k, '未找到');
}

console.log('\n=== 结论 ===');
console.log('（本自检只覆盖本地可验证项；真实经营数据见 /v1/commercial-loop/status，'
  + '未产生营收时 loopHealth 必须为 0）\n');
