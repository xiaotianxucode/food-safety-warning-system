$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$shareRoot = $PSScriptRoot
$shareDirectory = Join-Path $shareRoot '.share'
$shareExecutable = Join-Path $shareRoot '.tools\cloudflared.exe'
$shareStateFile = Join-Path $shareDirectory 'state.json'
if (Test-Path -LiteralPath $shareStateFile) {
    $previousShare = Get-Content -LiteralPath $shareStateFile -Raw | ConvertFrom-Json
    $previousProcess = Get-Process -Id $previousShare.processId -ErrorAction SilentlyContinue
    if ($previousProcess -and $previousProcess.Path -eq $shareExecutable) {
        Write-Output ('分享链接：' + $previousShare.url)
        exit 0
    }
}
try { $localHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 5 }
catch { throw '网站尚未启动，请先运行 start.cmd，再启动临时分享。' }
if (-not $localHealth.ok) { throw '网站健康检查未通过。' }
if (-not (Test-Path -LiteralPath $shareExecutable)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $shareExecutable) -Force | Out-Null
    Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.5/cloudflared-windows-amd64.exe' -OutFile $shareExecutable
}
$shareHash = (Get-FileHash -LiteralPath $shareExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($shareHash -ne 'db4e4c413612a0916f3e1679d3caaf376f94911952d163028fb726fb2e0516a9') { throw 'cloudflared 校验失败，请使用官方 2026.10.5 Windows x64 版本。' }
New-Item -ItemType Directory -Path $shareDirectory -Force | Out-Null
$shareOutput = Join-Path $shareDirectory 'tunnel.stdout.log'
$shareErrors = Join-Path $shareDirectory 'tunnel.stderr.log'
$shareProcess = Start-Process -FilePath $shareExecutable -ArgumentList @('tunnel','--url','http://127.0.0.1:3000','--no-autoupdate','--protocol','http2') -WorkingDirectory $shareRoot -WindowStyle Hidden -RedirectStandardOutput $shareOutput -RedirectStandardError $shareErrors -PassThru
$shareUrl = $null
for ($shareAttempt = 0; $shareAttempt -lt 45; $shareAttempt++) {
    if ($shareProcess.HasExited) { throw ('隧道启动失败，请查看 ' + $shareErrors) }
    $shareLog = if (Test-Path -LiteralPath $shareErrors) { Get-Content -LiteralPath $shareErrors -Raw } else { '' }
    $shareLog = ' ' + $shareLog
    $shareUrlMatch = [regex]::Match([string]$shareLog, 'https://[-a-z0-9]+\.trycloudflare\.com')
    if ($shareUrlMatch.Success -and $shareLog -match 'Registered tunnel connection') { $shareUrl = $shareUrlMatch.Value; break }
    Start-Sleep -Seconds 1
}
if (-not $shareUrl) {
    if (-not $shareProcess.HasExited) { Stop-Process -Id $shareProcess.Id -Force }
    throw ('尚未连通 Cloudflare，请查看 ' + $shareErrors)
}
$shareState = @{processId=$shareProcess.Id;url=$shareUrl;startedAt=(Get-Date).ToUniversalTime().ToString('o')}
[IO.File]::WriteAllText($shareStateFile,($shareState | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $shareDirectory 'url.txt'),$shareUrl,(New-Object Text.UTF8Encoding($false)))
Write-Output ('分享链接：' + $shareUrl)
Write-Output '朋友仍需网站账号登录。保持电脑、网站和隧道运行；停止分享请运行 stop-share.cmd。'
