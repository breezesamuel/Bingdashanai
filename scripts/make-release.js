#!/usr/bin/env node
'use strict';
// scripts/make-release.js — 生成客户自助下载用的发布清单 web/releases.json
//
// ── 为什么需要它 ────────────────────────────────────────────────────
// 下载页不能靠手写链接：手写的链接会 404、会指向旧版本、会忘记写校验值。
// 本脚本**只扫描真实存在的构建产物**，算真实 SHA256，并明确区分三态：
//   · 有地址（url）      → 页面给可点的下载按钮
//   · 有文件（无地址）   → 页面显示"已构建、未发布"，而不是给一个假链接
//   · 完全没有           → 页面显示"该平台尚未产出构建"并说明原因（如 iOS 需 Mac + Xcode）
// 这样页面上不存在"点了 404"的按钮，也不存在"看起来能下、其实没有"的假象。
//
// 用法：
//   node scripts/make-release.js                     只扫描并写 web/releases.json（url 只有在能确认可达时才有值）
//   node scripts/make-release.js --copy              把产物复制到 web/downloads/ 并写 /downloads/<file> 地址（自托管）
//   node scripts/make-release.js --base https://github.com/OWNER/REPO/releases/download/v2026.0.1
//                                                    用外部地址（例如 GitHub Release）作为下载地址
//   node scripts/make-release.js --tag v2026.0.1     写入版本标签（默认取 package.json 的 version）
//
// 说明：--copy 会把安装包复制进 web/downloads/（Windows 安装包约 81MB），
//       默认已把它加进 .gitignore —— 大文件不要进 git 历史。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const argv = process.argv.slice(2);
function flag(name) { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] || true) : null; }
const OUT = String(flag('out') || path.join(ROOT, 'web', 'releases.json'));
const COPY = !!flag('copy');
const BASE = flag('base') ? String(flag('base')).replace(/\/+$/, '') : null;
const TAG = flag('tag') ? String(flag('tag')) : ('v' + VERSION);

// 产物扫描规则：文件名 → 平台/架构/形态。宁可漏报也不要错报。
// kind 用于下载页决定文案（安装器 / 免安装包 / 手机安装包 …）。
const RULES = [
  { re: /^(?:BingDashanAI-(?:Setup|Installer)|BingDashanAI-[\d.]+-win-x64)\.exe$/i, plat: 'windows', arch: 'x64', kind: 'installer', label: 'Windows 安装包（NSIS，可选安装目录）' },
  { re: /^BingDashanAI-[\d.]+-win-arm64\.exe$/i, plat: 'windows', arch: 'arm64', kind: 'installer', label: 'Windows 安装包（ARM64）' },
  // mac 的 arch 不从规则里写死，交给 archOf() 从文件名抽（dmg/zip 都叫 ...-mac-x64 / ...-mac-arm64）
  { re: /\.dmg$/i, plat: 'macos', arch: 'auto', kind: 'dmg', label: 'macOS 磁盘镜像（.dmg）' },
  { re: /^BingDashanAI-[\d.]+-mac-(?:x64|arm64)\.zip$/i, plat: 'macos', arch: 'auto', kind: 'zip', label: 'macOS 免安装包（.zip）' },
  { re: /\.AppImage$/i, plat: 'linux', arch: 'x64', kind: 'appimage', label: 'Linux 免安装包（AppImage）' },
  { re: /\.deb$/i, plat: 'linux', arch: 'x64', kind: 'deb', label: 'Debian/Ubuntu 安装包（.deb）' },
  { re: /\.apk$/i, plat: 'android', arch: 'universal', kind: 'apk', label: 'Android 安装包（APK）' },
];
// arch 从文件名里再抽一次（如 BingDashanAI-2026.0.1-mac-arm64.dmg）
function archOf(name, fallback) {
  const m = name.match(/-(x64|arm64|ia32|universal|amd64)/i);
  if (m) return m[1].toLowerCase() === 'amd64' ? 'x64' : m[1].toLowerCase();
  return fallback;
}

const SCAN_DIRS = [
  path.join(ROOT, 'app'),
  path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk'),
  path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug'),
  path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release'),
  path.join(ROOT, 'dist'),
];

function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.slice(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function collect() {
  const seen = new Set();
  const out = [];
  for (const dir of SCAN_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (e) { continue; }
    for (const name of entries) {
      const full = path.join(dir, name);
      let st; try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile()) continue;
      const rule = RULES.find(r => r.re.test(name));
      if (!rule) continue;
      if (seen.has(name)) continue;                    // 同名只取最先命中的目录
      seen.add(name);
      out.push({ name, full, size: st.size, built: st.mtime.toISOString(), plat: rule.plat, arch: archOf(name, rule.arch), kind: rule.kind, label: rule.label });
    }
  }
  return out.sort((a, b) => (a.plat + a.arch).localeCompare(b.plat + b.arch));
}

function main() {
  const found = collect();
  const copyDir = path.join(ROOT, 'web', 'downloads');
  if (COPY) fs.mkdirSync(copyDir, { recursive: true });

  const artifacts = found.map(a => {
    let url = null;
    let where = a.full;
    if (COPY) {
      const dest = path.join(copyDir, a.name);
      fs.copyFileSync(a.full, dest);
      where = dest;
      url = '/downloads/' + encodeURIComponent(a.name);
    } else if (BASE) {
      url = BASE + '/' + encodeURIComponent(a.name);
    }
    return {
      platform: a.plat, arch: a.arch, kind: a.kind, label: a.label,
      file: a.name, size: a.size, sha256: sha256(where), built: a.built,
      url, published: !!url,
    };
  });

  // 诚实清单：明确写出"这些平台为什么没有产物"，页面照实显示。
  const have = new Set(artifacts.map(a => a.platform));
  const unavailable = [];
  if (!have.has('windows')) unavailable.push({ platform: 'windows', reason: '当前环境未产出 Windows 安装包（执行 npm run dist:win）' });
  if (!have.has('macos')) unavailable.push({ platform: 'macos', reason: 'macOS 安装包必须在 Mac 上构建（需 Apple 账号做签名/公证）；见 .github/workflows/build-desktop.yml 的 macos 任务' });
  if (!have.has('linux')) unavailable.push({ platform: 'linux', reason: 'Linux 产物在 Linux 上构建（AppImage/deb）' });
  if (!have.has('android')) unavailable.push({ platform: 'android', reason: 'Android APK 需 Android SDK 构建；没有 APK 时可先用 PWA 免商店安装（见下载页）' });
  unavailable.push({ platform: 'ios', reason: 'iOS 原生包需 Mac + Xcode + Apple 开发者账号；现阶段请用 PWA（Safari → 添加到主屏幕）' });
  unavailable.push({ platform: 'harmonyos', reason: '鸿蒙原生 HAP 需 DevEco Studio 构建；现阶段请用 PWA' });

  const manifest = {
    product: pkg.productName,
    version: VERSION,
    tag: TAG,
    generatedAt: new Date().toISOString(),
    note: '本清单由 scripts/make-release.js 依据**真实存在的文件**生成；size/sha256 均为实测。published=false 表示已构建但未配置下载地址。',
    artifacts,
    unavailable,
  };
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log('版本 ' + VERSION + '（tag ' + TAG + '）');
  console.log('产物：' + (artifacts.length ? '' : '（无）'));
  for (const a of artifacts) {
    console.log('  ' + (a.published ? '[可下载]' : '[未发布]') + ' ' + a.platform + '/' + a.arch + '  ' +
      (a.size / 1048576).toFixed(1) + 'MB  ' + a.file);
    console.log('      sha256=' + a.sha256 + (a.url ? '  url=' + a.url : ''));
  }
  if (!artifacts.length) {
    console.log('  提示：先执行 npm run dist:win / dist:mac / dist:linux，或让 CI 产出产物后重跑本脚本。');
  }
  for (const u of manifest.unavailable) console.log('  [缺] ' + u.platform + '：' + u.reason);
  console.log('\n已写入 ' + path.relative(ROOT, OUT));
  if (!COPY && !BASE) console.log('提示：加 --copy（自托管到 web/downloads/）或 --base <URL>（GitHub Release）后，页面才会出现可点的下载按钮。');
}

main();
