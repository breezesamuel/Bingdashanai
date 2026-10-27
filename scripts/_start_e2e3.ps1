# 启动 e2e runner 后台，输出 PID 到文件
$ErrorActionPreference = 'SilentlyContinue'
Remove-Item "C:\Users\Think\project\BingDashan\tmp\e2e3.out", "C:\Users\Think\project\BingDashan\tmp\e2e3.err" -ErrorAction SilentlyContinue
$env:BINGDASHAN_ADMIN_TOKEN = 'tok-e2e-x7f9q2a4d1k8m5t0'
$p = Start-Process -FilePath "node" -ArgumentList "test/e2e/suites/goal-e2e-runner.js" -WorkingDirectory "C:\Users\Think\project\BingDashan" -RedirectStandardOutput "C:\Users\Think\project\BingDashan\tmp\e2e3.out" -RedirectStandardError "C:\Users\Think\project\BingDashan\tmp\e2e3.err" -WindowStyle Hidden -PassThru
$p.Id | Out-File -FilePath "C:\Users\Think\project\BingDashan\tmp\e2e3.pid" -Encoding ascii
Write-Output ("PID=" + $p.Id)