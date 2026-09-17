# ============================================================
#  get-node.ps1 —— 新电脑没有 Node.js 时，自动下载便携版到 runtime\node\
#
#  由 deploy 流程调用（一键部署.bat 在找不到 node 时执行本脚本）。
#  下载源按顺序尝试：
#    1) https://nodejs.org/dist/                    （官方）
#    2) https://npmmirror.com/mirrors/node/          （国内镜像，快）
#  版本取官方 index.json 里最新的 LTS，不写死版本号。
#
#  只解压运行时，不装到系统、不改 PATH、不需要管理员权限。
#  解压后项目内会出现 runtime\node\node.exe，后续一键部署直接复用它。
# ============================================================

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root      = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RuntimeDir = Join-Path $Root 'runtime'
$NodeDir   = Join-Path $RuntimeDir 'node'
$TmpDir    = Join-Path $RuntimeDir '_node_dl'

function Info($m) { Write-Host "  · $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  ✓ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  ✗ $m" -ForegroundColor Red }

if (Test-Path (Join-Path $NodeDir 'node.exe')) {
  Ok "runtime\node\node.exe 已存在，跳过下载"
  exit 0
}

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

# ---------- 1. 解析最新 LTS 版本号 ----------
Info '正在查询 Node.js 最新 LTS 版本…'
$ver = $null
foreach ($src in @('https://nodejs.org/dist/index.json', 'https://npmmirror.com/mirrors/node/index.json')) {
  try {
    $index = Invoke-RestMethod -Uri $src -TimeoutSec 25
    $lts = $index | Where-Object { $_.lts -ne $false } | Select-Object -First 1
    if ($lts -and $lts.version) { $ver = $lts.version; break }
  } catch {
    Warn "取版本列表失败（$src）：$($_.Exception.Message)"
  }
}
if (-not $ver) {
  Fail '无法获取 Node.js 版本列表，请检查网络后重试，或手动安装 Node.js 后重新运行一键部署'
  exit 1
}
Info "目标版本：Node $ver (win-x64)"

# ---------- 2. 下载 zip ----------
$fileName = "node-$ver-win-x64.zip"
$zipPath  = Join-Path $TmpDir $fileName
$urls = @(
  "https://nodejs.org/dist/$ver/$fileName",
  "https://npmmirror.com/mirrors/node/$ver/$fileName"
)

$downloaded = $false
foreach ($u in $urls) {
  try {
    Info "下载中：$u"
    $ProgressPreference = 'SilentlyContinue'   # 关掉进度条，速度差几十倍
    Invoke-WebRequest -Uri $u -OutFile $zipPath -TimeoutSec 600 -UseBasicParsing
    if ((Get-Item $zipPath).Length -gt 10MB) { $downloaded = $true; break }
    Warn '下载到的文件体积异常，换下一个源重试'
  } catch {
    Warn "下载失败：$($_.Exception.Message)"
  }
}
if (-not $downloaded) {
  Fail 'Node.js 下载失败。可手动下载便携版 zip，把解压出的 node.exe 放到 runtime\node\ 下'
  exit 1
}
Ok ("下载完成（{0:N1} MB）" -f ((Get-Item $zipPath).Length / 1MB))

# ---------- 3. 解压到 runtime\node ----------
Info '正在解压…'
$extract = Join-Path $TmpDir 'x'
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $extract -Force

$inner = Get-ChildItem $extract -Directory | Select-Object -First 1
if (-not $inner) { Fail '解压结果异常，没有找到目录'; exit 1 }

if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
Move-Item -Path $inner.FullName -Destination $NodeDir
Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue

$nodeExe = Join-Path $NodeDir 'node.exe'
if (-not (Test-Path $nodeExe)) { Fail "解压后没有找到 node.exe：$nodeExe"; exit 1 }

Ok "Node.js 已就绪：$nodeExe"
Ok '（便携版，只放在项目 runtime\ 下，没有改动系统环境）'
exit 0
