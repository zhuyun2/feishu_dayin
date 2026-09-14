# ============================================================
# feishuprint 内网穿透管理（Windows PowerShell 外壳）
#
# 本文件只是「转发器」：真正的实现在
#     tunnel.js  +  server/tunnelCore.js
# （与 dev server 的 /api/tunnel/* 完全同源，避免两处实现不一致）
#
# 用法（在仓库目录下）：
#   .\tunnel.ps1                一键部署（复用优先）
#   .\tunnel.ps1 deploy         同上
#   .\tunnel.ps1 new            强制换新地址（会更换飞书插件地址，谨慎）
#   .\tunnel.ps1 status         查看隧道与地址状态
#   .\tunnel.ps1 url            只打印当前地址
#   .\tunnel.ps1 stop           停止隧道
#   .\tunnel.ps1 deploy -Port 5199     指定端口
#
# 也可直接双击「一键部署.bat」/「tunnel.bat」。
#
# 注意：本机可能没有系统级安装 Node（只在 WorkBuddy 内置目录里），
#       所以这里不能简单地 `Get-Command node`，要按下面的顺序兜底查找。
# ============================================================
param(
  [Parameter(Position = 0)][string]$Command = 'deploy',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'
$CLI = Join-Path $PSScriptRoot 'tunnel.js'

function Find-NodeExe {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $roots = @(
    (Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'),
    (Join-Path $env:LOCALAPPDATA '.workbuddy\binaries\node\versions')
  )
  foreach ($r in $roots) {
    if (-not (Test-Path $r)) { continue }
    $hit = Get-ChildItem $r -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'node.exe' } |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
    if ($hit) { return $hit }
  }

  foreach ($p in @(
      (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
      'C:\Program Files\nodejs\node.exe',
      'C:\Program Files (x86)\nodejs\node.exe')) {
    if (Test-Path $p) { return $p }
  }

  $override = Join-Path $PSScriptRoot 'node-path.txt'
  if (Test-Path $override) {
    $line = Get-Content $override -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($line -and (Test-Path $line.Trim())) { return $line.Trim() }
  }
  return $null
}

$node = Find-NodeExe
if (-not $node) {
  Write-Host '[错误] 没找到 Node.js' -ForegroundColor Red
  Write-Host '       已查找：系统 PATH、WorkBuddy 内置目录、Program Files、node-path.txt'
  Write-Host '       解决办法：把 node.exe 的完整路径写进项目根目录的 node-path.txt'
  exit 1
}
if (-not (Test-Path $CLI)) {
  Write-Host "[错误] 缺少 $CLI，仓库文件可能不完整。" -ForegroundColor Red
  exit 1
}

$argv = @($CLI, $Command)
if ($Rest) { $argv += $Rest }
& $node @argv
exit $LASTEXITCODE
