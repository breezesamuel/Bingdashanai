# build-all.ps1 - One-shot build + verify + publish for EXE and APK
#
# Usage (run from C:\Users\Think\project\BingDashan):
#   powershell -File scripts\build-all.ps1          # EXE only (APK skipped if no Android SDK)
#   powershell -File scripts\build-all.ps1 -WithApk # EXE + APK (requires ANDROID_HOME)
#   powershell -File scripts\build-all.ps1 -Tag v2026.0.4
#
# EXE: always built (electron-builder in node_modules).
# APK: skipped with warning if JAVA_HOME or ANDROID_HOME not set (no fake binary).
# After both pass, verify-release.js gate confirms customer-downloadable.

[CmdletBinding()]
param([switch]$WithApk, [string]$Tag = ""
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot - Parent)

Write-Host "=== BingDashanAI Build Pipeline ===" -ForegroundColor Cyan

Write-Host "`n--- Step 1: Windows EXE ---"
if ($Tag) { powershell -File "$PSScriptRoot\build-exe.ps1" -Tag $Tag }
else      { powershell -File "$PSScriptRoot\build-exe.ps1" }

if ($WithApk) {
  $hasJava  = [bool](Get-Command java -ErrorAction SilentlyContinue)
  $hasAndr  = [bool]($env:ANDROID_HOME -or $env:ANDROID_SDK_ROOT)
  if (-not $hasJava -or -not $hasAndr) {
    Write-Host "`n[SKIP] Android SDK/JDK not found." -ForegroundColor Yellow
    Write-Host "       Install JDK 17+ and Android SDK, then re-run with -WithApk."
    Write-Host "       PWA fallback already live: web/manifest.webmanifest + web/sw.js"
  } else {
    Write-Host "`n--- Step 2: Android APK ---"
    powershell -File "$PSScriptRoot\build-apk.ps1"
  }
}

Write-Host "`n=== Build Pipeline Complete ===" -ForegroundColor Green
Write-Host "Running final gate: node scripts\verify-release.js"
node scripts\verify-release.js
if ($LASTEXITCODE -ne 0) {
  Write-Host "GATE FAILED - do not ship until resolved." -ForegroundColor Red
  exit 1
}
Write-Host "All gates passed. Download page: web/download.html" -ForegroundColor Green
