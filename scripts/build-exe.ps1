# build-exe.ps1 - BingDashanAI one-shot Windows build + verify + publish
#
# Usage (run from C:\Users\Think\project\BingDashan):
#   powershell -File scripts\build-exe.ps1
#   powershell -File scripts\build-exe.ps1 -Tag v2026.0.3
#
# Outputs:
#   app\BingDashanAI-<ver>-win-x64.exe
#   web\downloads\BingDashanAI-<ver>-win-x64.exe
#   web\releases.json
#
# Discipline: sha256/size measured, never hand-typed; verify-release.js gate; exit 1 on failure.

[CmdletBinding()]
param(
  [string]$Tag = ""
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot - Parent)

function Step([string]$m) {
  Write-Host "`n=== $m ===" -ForegroundColor Cyan
}

Step "0/5 preflight"
$pn  = Get-Content .\package.json | ConvertFrom-Json
$ver = $pn.version
$exeRel = "app\BingDashanAI-$($ver)-win-x64.exe"
$exeAbs = Join-Path $PWD $exeRel
if (-not (Test-Path ".\node_modules\.bin\electron-builder.cmd")) {
  throw "electron-builder not found. Run: npm install -D electron-builder electron"
}
Write-Host "Version $ver -> $exeRel"

Step "1/5 Capacitor sync"
& cmd /c "npm run cap:sync 2>cap-sync.log" | Out-Null

Step "2/5 electron-builder --win (NSIS x64)"
& cmd /c "npx electron-builder --win 2>builder.log"
if ($LASTEXITCODE -ne 0) {
  Get-Content builder.log -Tail 30
  throw "electron-builder failed"
}

Step "3/5 verify new exe exists + is fresh + not empty"
if (-not (Test-Path $exeAbs)) { throw "exe not found: $exeAbs" }
$fi     = Get-Item $exeAbs
$ageMin = [int]((Get-Date) - $fi.LastWriteTime).TotalMinutes
if ($fi.Length -lt 10MB) {
  $mb = [math]::Round($fi.Length/1MB,1)
  throw "exe only ${mb}MB - aborting"
}
$sha    = (Get-FileHash $exeAbs -Algorithm SHA256).Hash.ToLower()
Write-Host "  $($fi.Name)  $($fi.Length)B  built $ageMin min ago  sha256=$sha"

Step "4/5 make-release.js --copy (publish to web/downloads/ + write releases.json)"
if ($Tag) {
  node scripts\make-release.js --copy --tag $Tag
} else {
  node scripts\make-release.js --copy
}
if ($LASTEXITCODE -ne 0) { throw "make-release.js failed" }

Step "5/5 verify-release.js gate"
node scripts\verify-release.js
if ($LASTEXITCODE -ne 0) {
  throw "verify-release.js gate failed - NOT customer-downloadable. Do not ship."
}

Write-Host "`nOK - Windows installer built, verified, published to web/downloads." -ForegroundColor Green
$exeName = $fi.Name
Write-Host "Download page:  web/download.html  (reads /releases.json, points to /downloads/$exeName)" -ForegroundColor Green
