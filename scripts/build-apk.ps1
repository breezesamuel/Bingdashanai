# build-apk.ps1 - BingDashanAI Android APK build (requires Android SDK + JDK)
#
# Prerequisites:
#   1. JDK 17+ : https://adoptium.net  -> set JAVA_HOME
#   2. Android SDK -> set ANDROID_HOME
#   3. Accept licenses: ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager --licenses
#
# Usage (run from C:\Users\Think\project\BingDashan):
#   powershell -File scripts\build-apk.ps1          # debug APK
#   powershell -File scripts\build-apk.ps1 -Release  # release APK
#
# PWA fallback already live: web/manifest.webmanifest + web/sw.js

[CmdletBinding()]
param([switch]$Release)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot - Parent)

function Step([string]$m) {
  Write-Host "`n=== $m ===" -ForegroundColor Cyan
}

Step "0/4 preflight: Java + Android SDK"
if (-not $env:JAVA_HOME) {
  throw "JAVA_HOME not set. Install JDK 17+ then: setx JAVA_HOME <path>"
}
if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) {
  throw "ANDROID_HOME not set. Install Android SDK then: setx ANDROID_HOME <path>"
}
java -version 2>&1 | Select-Object -First 1 | Write-Host
Write-Host "SDK: $env:ANDROID_HOME"

Step "1/4 Capacitor sync"
& cmd /c "npm run cap:sync 2>cap-sync.log" | Out-Null

Step "2/4 gradle build"
$gradlew = "android\gradlew.bat"
if ($Release) {
  & $gradlew "assembleRelease" 2>gradle.log
} else {
  & $gradlew "assembleDebug" 2>gradle.log
}
if ($LASTEXITCODE -ne 0) {
  Get-Content gradle.log -Tail 40
  throw "gradle build failed"
}

Step "3/4 verify APK was produced"
$apkDir = "android\app\build\outputs\apk"
$apkFiles = Get-ChildItem -Path $apkDir -Recurse -Filter "*.apk" -ErrorAction SilentlyContinue
if (-not $apkFiles -or $apkFiles.Count -eq 0) {
  throw "No APK found under $apkDir"
}
foreach ($a in $apkFiles) {
  $sz  = [math]::Round($a.Length/1MB,1)
  $sha = (Get-FileHash $a.FullName -Algorithm SHA256).Hash.ToLower()
  Write-Host "  $($a.Name)  $sz MB  sha256=$sha"
}

Step "4/4 publish + verify-release.js gate"
node scripts\make-release.js --copy
if ($LASTEXITCODE -ne 0) { throw "make-release.js failed" }
node scripts\verify-release.js
if ($LASTEXITCODE -ne 0) {
  throw "verify-release.js failed - Do not ship."
}

Write-Host "`nOK - Android APK built and published to web/downloads." -ForegroundColor Green
