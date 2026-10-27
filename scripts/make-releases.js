#!/usr/bin/env node
/* scripts/make-releases.js — 生成 web/releases.json（下载页 /download.html 的数据源）
 *
 * 【为什么需要】下载渠道三件套里，serveStatic 已带二进制 MIME/attachment/断点续传，
 * download.html 已按 releases.json 诚实渲染（没有安装包就显示原因，绝不放假按钮）。
 * 缺的只是"把 web/downloads/ 里的产物变成带 sha256 的清单"这一步——打包机产出
 * exe/apk 后跑本脚本，渠道即刻就绪。
 *
 * 用法：node scripts/make-releases.js [--version 1.0.0] [--tag stable]
 * 产物写 web/releases.json（静态托管，/download.html 以 no-store 拉取）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DL = path.join(ROOT, 'web', 'downloads');
const OUT = path.join(ROOT, 'web', 'releases.json');

// 平台判定（按扩展名）：产物命名建议 bingdashan-<version>-<plat>.<ext>
// label 是 download.html 的显示名（artBlock/renderPrimary 读 a.label，
// 只给 file 会让推荐位显示"undefined"——2026-10-25 装载不足事故的根因之一）。
const PLATFORM_BY_EXT = {
  '.exe': 'windows', '.msi': 'windows',
  '.dmg': 'macos', '.pkg': 'macos',
  '.appimage': 'linux', '.deb': 'linux',
  '.apk': 'android',
};
const LABEL_BY_PLAT = {
  windows: 'Windows 安装包', macos: 'macOS 安装包', linux: 'Linux 安装包', android: 'Android 安装包（APK）',
};
const ALL_PLATFORMS = ['windows', 'macos', 'linux', 'android'];

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
let version = argOf('version', '');
try { version = version || (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || ''); } catch (e) {}
if (!version) version = new Date().toISOString().slice(0, 10) + '-dev';
const tag = argOf('tag', 'stable');

function sha256(fp) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(fp).on('data', c => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

(async () => {
  const artifacts = [];
  const seen = new Set();
  try {
    for (const f of fs.readdirSync(DL).sort()) {
      const ext = path.extname(f).toLowerCase();
      const plat = PLATFORM_BY_EXT[ext];
      if (!plat || seen.has(plat + f)) continue;
      const fp = path.join(DL, f);
      const st = fs.statSync(fp);
      if (!st.isFile()) continue;
      artifacts.push({
        platform: plat, file: f, url: '/downloads/' + encodeURIComponent(f),
        label: LABEL_BY_PLAT[plat] + ' · ' + version,
        size: st.size, sha256: await sha256(fp),
        published: true, releasedAt: st.mtimeMs,
      });
      seen.add(plat + f);
    }
  } catch (e) { /* downloads 目录不存在 = 全平台待发布 */ }

  // 没有产物的平台如实登记原因（下载页原样展示，不伪造可用状态）。
  // 覆盖全部六个平台卡片：harmonyos/ios 无原生包是常态，理由写清 PWA 路径，
  // 否则页面落到泛化文案"该平台尚未产出构建产物"，信息量不足。
  const REASON_BY_PLAT = {
    windows: '安装包尚未生成——打包流水线见 docs/desktop-mobile-packaging-2026-10-25.md；现阶段请使用网页版。',
    macos: '安装包尚未生成——打包流水线见 docs/desktop-mobile-packaging-2026-10-25.md；现阶段请使用网页版。',
    linux: '安装包尚未生成——打包流水线见 docs/desktop-mobile-packaging-2026-10-25.md；现阶段请使用网页版。',
    android: '安装包尚未生成——打包流水线见 docs/desktop-mobile-packaging-2026-10-25.md；现阶段可用 PWA（添加到主屏幕）。',
    harmonyos: '原生 HAP 需 DevEco Studio 构建；现阶段用华为浏览器"添加到桌面"即可当 App 使用。',
    ios: '原生包需 Mac + Xcode + Apple 开发者账号；现阶段用 Safari"添加到主屏幕"即可当 App 使用。',
  };
  const unavailable = ['windows', 'macos', 'linux', 'android', 'harmonyos', 'ios']
    .filter(p => !artifacts.some(a => a.platform === p))
    .map(p => ({ platform: p, reason: REASON_BY_PLAT[p] }));

  const man = {
    ok: true, version, tag, generatedAt: new Date().toISOString(),
    artifacts, unavailable,
    channels: { web: '/', download: '/download.html', pwa: '/manifest.webmanifest' },
  };
  fs.writeFileSync(OUT, JSON.stringify(man, null, 2), 'utf8');
  console.log('releases.json 已生成：版本 ' + version
    + ' · 产物 ' + artifacts.length + ' 个 · 待发布平台 ' + unavailable.length + ' 个');
  artifacts.forEach(a => console.log('  ' + a.platform + ' ← ' + a.file + ' (' + Math.round(a.size / 1048576) + 'MB, sha256 ' + a.sha256.slice(0, 12) + '…)'));
})();
