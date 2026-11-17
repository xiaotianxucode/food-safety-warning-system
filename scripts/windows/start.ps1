$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $projectRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '请先安装 Node.js 24 或更新版本。' }
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
if (-not (Test-Path -LiteralPath 'node_modules')) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' } }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw '构建失败，请检查上方输出。' }
Write-Host '系统将运行于 http://127.0.0.1:3000，按 Ctrl+C 停止。'
& npm.cmd start
