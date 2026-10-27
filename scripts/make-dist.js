'use strict';
/**
 * make-dist.js - one-command package + verify + publish for BingDashanAI
 *
 * Combines the scattered steps into a single runnable skill:
 *   1. Build Windows EXE (electron-builder --win, local)
 *   2. Scan for real installers in app/ + android/.../apk + dist/
 *   3. Generate web/releases.json with real SHA256
 *      (--copy: self-host to web/downloads/; --base: GitHub Release external link)
 *   4. Run verify-release.js gate; exit 1 if not customer-downloadable
 *
 * Discipline (fail-closed, same as repo conventions):
 *   - Only list binaries that actually exist on disk; never fabricate
 *   - APK: if no .apk under android/.../outputs (normal on machines without Android SDK),
 *     releases.json honestly marks android=unavailable; use .github/workflows/release.yml
 *     for cloud build
 *   - Gate failure means NOT customer-downloadable; do not ship
 *
 * Usage (from C:\Users\Think\project\BingDashan):
 *   node scripts/make-dist.js
 *   node scripts/make-dist.js --base https://github.com/OWNER/REPO/releases/download/v2026.0.3
 *   node scripts/make-dist.js --skip-build
 *   node scripts/make-dist.js --tag v2026.0.3
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const argv = process.argv.slice(2);
function hasFlag(name) { return argv.includes(name); }
function flagVal(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }

const BASE       = flagVal('--base');
const TAG        = flagVal('--tag');
const SKIP_BUILD = hasFlag('--skip-build');
const COPY       = !BASE;   // no external base URL => self-host to web/downloads/

function runNode(script, extraArgs) {
  const r = spawnSync(process.execPath, [script, ...(extraArgs || [])], {
    stdio: 'inherit', cwd: ROOT
  });
  return r.status === 0;
}

console.log('=== BingDashanAI package skill ===');
console.log('Mode: ' + (BASE ? 'GitHub Release ' + BASE : 'self-hosted /downloads/')
  + (SKIP_BUILD ? ' + skip build' : ''));

// 1) Build Windows EXE
if (!SKIP_BUILD) {
  console.log('\n[1/3] electron-builder --win (NSIS x64 installer)');
  const r = spawnSync('npx', ['electron-builder', '--win', '--publish', 'never'], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  });
  if (r.status !== 0) {
    console.error('::error:: electron-builder failed; aborting, NOT marking customer-downloadable.');
    process.exit(1);
  }
} else {
  console.log('\n[1/3] skipped build (--skip-build)');
}

// 2) Generate releases.json with real SHA256
console.log('\n[2/3] Generating web/releases.json (real files only)');
const mkArgs = [];
if (COPY) mkArgs.push('--copy');
if (BASE) mkArgs.push('--base', BASE);
if (TAG)  mkArgs.push('--tag', TAG);
if (!runNode('scripts/make-release.js', mkArgs)) {
  console.error('::error:: make-release.js failed; aborting.');
  process.exit(1);
}

// 3) Gate: verify-release.js
console.log('\n[3/3] Running verify-release.js gate');
if (!runNode('scripts/verify-release.js', [])) {
  console.error('::error:: Gate FAILED. Do NOT ship. Fix issues and re-run.');
  process.exit(1);
}

console.log('\n=== Done ===');
console.log('Manifest: web/releases.json (' + (COPY ? 'self-hosted /downloads/' : 'external ' + BASE) + ')');
console.log('Download page: web/download.html reads /releases.json and renders all 6 platform cards + SHA256 check.');
console.log('APK note: if no .apk on disk, releases.json honestly shows android=unavailable.');
console.log('          For cloud-built APK: push a v* tag to trigger .github/workflows/release.yml.');
