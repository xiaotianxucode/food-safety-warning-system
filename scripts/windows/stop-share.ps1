$ErrorActionPreference = 'Stop'
$shareRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $shareRoot
$stopShareState = Join-Path $shareRoot '.share\state.json'
$stopShareExecutable = Join-Path $shareRoot '.tools\cloudflared.exe'
if (Test-Path -LiteralPath $stopShareState) {
    $stopShareInfo = Get-Content -LiteralPath $stopShareState -Raw | ConvertFrom-Json
    $stopShareProcess = Get-Process -Id $stopShareInfo.processId -ErrorAction SilentlyContinue
    if ($stopShareProcess) {
        if ($stopShareProcess.Path -ne $stopShareExecutable) { throw '进程与本项目隧道不符，停止操作。' }
        Stop-Process -Id $stopShareProcess.Id -Force
    }
    Remove-Item -LiteralPath $stopShareState -Force
}
$stopShareUrl = Join-Path $shareRoot '.share\url.txt'
if (Test-Path -LiteralPath $stopShareUrl) { Remove-Item -LiteralPath $stopShareUrl -Force }
Write-Output '临时分享已停止，本机网站继续运行。'
