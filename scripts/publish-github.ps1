$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'Never'
$credentialInput = "protocol=https`nhost=github.com`n`n"
$credentialOutput = $credentialInput | git credential fill 2>$null
if ($LASTEXITCODE -ne 0) { throw '当前 Git 凭据管理器中没有可用的 GitHub 登录。请先登录 GitHub 后重新运行此脚本。' }
$credentialFields = @{}
foreach ($line in $credentialOutput) { if ($line -match '^([^=]+)=(.*)$') { $credentialFields[$matches[1]] = $matches[2] } }
if (-not $credentialFields['password']) { throw '未获取到 GitHub 凭据。' }
$githubHeaders = @{ Authorization = ('Bearer ' + $credentialFields['password']); Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
$account = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $githubHeaders
$repoName = 'food-safety-warning-system'
$repo = $null
try { $repo = Invoke-RestMethod -Uri ('https://api.github.com/repos/' + $account.login + '/' + $repoName) -Headers $githubHeaders }
catch { if ([int]$_.Exception.Response.StatusCode -ne 404) { throw } }
if (-not $repo) {
    $repoBody = @{name=$repoName;private=$true;description='食品安全预警系统：定时采集、模型分析、预警展示与来源追溯';auto_init=$false} | ConvertTo-Json
    $repo = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post -Headers $githubHeaders -Body ([Text.Encoding]::UTF8.GetBytes($repoBody)) -ContentType 'application/json; charset=utf-8'
}
if (-not $repo.private) { throw '同名仓库为公开仓库，停止推送以保护私有代码。' }
$remote = $null
$remoteNames = @(git remote)
if ($remoteNames -contains 'origin') { $remote = git remote get-url origin }
if ($remote -and $remote -ne $repo.clone_url) { throw '现有 origin 与目标仓库不同，停止修改。' }
if (-not $remote) { git remote add origin $repo.clone_url; if ($LASTEXITCODE -ne 0) { throw '添加远程仓库失败。' } }
git push -u origin main
if ($LASTEXITCODE -ne 0) { throw '推送失败，未进行强制覆盖。请检查仓库权限或现有历史。' }
Write-Host ('私有仓库：' + $repo.html_url)
$githubHeaders.Clear()
$credentialFields.Clear()
