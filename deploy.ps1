# ============================================================
# feishuprint Windows 一键部署脚本（长期挂机用）
# 依赖：Node.js 16+、npm、PowerShell 5.1+
# 本脚本会自动安装（如缺失）：pm2、cloudflared
#
# 用法（在仓库目录下用 PowerShell 运行）：
#   .\deploy.ps1 install    首次安装依赖（npm 依赖 + pm2 + cloudflared）
#   .\deploy.ps1 deploy     一键部署（推荐）：拉起 dev server + 复用/生成内网穿透地址
#   .\deploy.ps1 start      同 deploy（兼容旧用法）
#   .\deploy.ps1 new        强制换新地址（不使用上一次的地址，谨慎）
#   .\deploy.ps1 stop       停止服务
#   .\deploy.ps1 restart    重启服务（复用优先：地址能用就不换）
#   .\deploy.ps1 status     查看进程状态与穿透地址
#   .\deploy.ps1 logs       查看实时日志（Ctrl+C 退出）
#   .\deploy.ps1 startup    配置开机/登录自启（需管理员权限）
#   .\deploy.ps1 tunnel     查看固定域名命名隧道配置步骤
#
# 重要说明（内网穿透地址为什么以前每次都变）：
#   cloudflared 临时隧道的域名由 Cloudflare 随机分配，客户端无法指定；但它在
#   cloudflared 进程存活期间**保持不变**。旧版 start 会先 delete 再 start，等于
#   每次都重启隧道进程，所以地址每次都变。现在改为「复用优先」：先探测上一次的
#   地址是否仍能回连本机，可用就直接复用，绝不重启隧道。
#   隧道统一由 dev server 提供的 /api/tunnel/* 管理（server/tunnelApi.js）。
#
# 端口：默认 5173，可用 $env:PORT=5199 后 .\deploy.ps1 deploy 自定义
# ============================================================
param(
  [string]$Command = 'deploy'
)

$ErrorActionPreference = 'Stop'
$APP_DIR = $PSScriptRoot
$APP_NAME = 'feishuprint'
$TUNNEL_NAME = 'feishuprint-tunnel'
$PORT = if ($env:PORT) { $env:PORT } else { '5173' }
$PM2_HOME = if ($env:PM2_HOME) { $env:PM2_HOME } else { Join-Path $env:USERPROFILE '.pm2' }
$LOG_DIR = Join-Path $PM2_HOME 'logs'
$TUNNEL_API = "http://127.0.0.1:$PORT/api/tunnel"

function Write-Info($m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "[OK]   $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Write-Err($m)  { Write-Host "[ERR]  $m" -ForegroundColor Red }

function Test-Command($c) { Get-Command $c -ErrorAction SilentlyContinue }

function Test-PortListening($port) {
  $line = netstat -ano | Select-String (":$port\s.*LISTENING")
  return ($null -ne $line)
}

function Wait-Port($port, $seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    if (Test-PortListening $port) { return $true }
  }
  return $false
}

# 调用 dev server 的一键部署接口（复用优先，真正的逻辑在 server/tunnelApi.js）
function Invoke-TunnelDeploy([bool]$Force) {
  $body = if ($Force) { '{"force":true}' } else { '{"force":false}' }
  $r = Invoke-RestMethod -Uri "$TUNNEL_API/deploy" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 300
  if (-not $r.ok) { Write-Err ("部署失败：" + $r.message); exit 1 }
  Write-Host ""
  if ($r.reused) { Write-Ok $r.message } else { Write-Ok $r.message }
  if ($r.changed) {
    Write-Warn "地址已变更（旧地址：$($r.previousUrl)）"
    Write-Warn "请到飞书多维表格 → 插件配置里把「插件地址」改成新地址"
  }
  Write-Host ("  内网穿透地址：$($r.url)") -ForegroundColor Green
  if ($r.ready -eq $false) { Write-Warn "地址刚生成，可能还要几秒才能访问" }
  Write-Host ""
  return $r
}

# 确保 Node/npm 在场
function Assert-Node {
  if (-not (Test-Command node) -or -not (Test-Command npm)) {
    Write-Err "未检测到 Node.js / npm。请先安装 Node.js 16+ 并加入 PATH。"
    exit 1
  }
}

# 安装 npm 项目依赖
function Install-Deps {
  Assert-Node
  Write-Info "安装 npm 依赖（位于 $APP_DIR）..."
  Push-Location $APP_DIR
  try { npm install } finally { Pop-Location }
  Write-Ok "npm 依赖安装完成"
}

# 确保 pm2 全局可用
function Ensure-Pm2 {
  if (-not (Test-Command pm2)) {
    Write-Info "未检测到 pm2，正在全局安装（npm i -g pm2）..."
    npm install -g pm2
  }
  $pm2 = (Get-Command pm2).Source
  Write-Ok "pm2 就绪：$pm2"
}

# 确保 cloudflared 在场（优先 winget，失败则提示手动下载）
function Ensure-Cloudflared {
  if (Test-Command cloudflared) { Write-Ok "cloudflared 已就绪"; return }
  Write-Info "未检测到 cloudflared，尝试通过 winget 安装..."
  if (Test-Command winget) {
    winget install --id Cloudflare.cloudflared -e --accept-package-agreements --accept-source-agreements
    if (Test-Command cloudflared) { Write-Ok "cloudflared 安装完成"; return }
  }
  Write-Warn "自动安装失败。请手动下载并加入 PATH："
  Write-Host "  https://github.com/cloudflare/cloudflared/releases  (下载 cloudflared-windows-amd64.exe，改名 cloudflared.exe 放入 PATH)"
}

# 安装阶段：依赖 + 工具
function Do-Install {
  Install-Deps
  Ensure-Pm2
  Ensure-Cloudflared
  Write-Ok "安装完成。运行 .\deploy.ps1 deploy 启动服务。"
}

# dev server 已在监听就复用，不重启（重启会让隧道无谓地换地址）
function Ensure-DevServerViaPm2 {
  if (Test-PortListening $PORT) {
    Write-Ok "dev server 已在 :$PORT 运行，复用"
    return
  }
  pm2 delete $APP_NAME 2>$null
  Write-Info "启动 dev server（端口 $PORT）..."
  pm2 start --name $APP_NAME --cwd "$APP_DIR" npm -- run start
  if (-not (Wait-Port $PORT 120)) {
    Write-Err "dev server 120 秒内未能启动，请执行 .\deploy.ps1 logs 查看日志"
    exit 1
  }
  Write-Ok "dev server 已就绪 :$PORT"
}

# 一键部署：dev server + 复用/生成内网穿透地址
function Do-Deploy([bool]$Force) {
  Assert-Node
  Ensure-Pm2
  Ensure-Cloudflared

  # 隧道改由 /api/tunnel/* 统一管理，清掉历史遗留的 pm2 隧道进程，避免两个隧道打架
  pm2 delete $TUNNEL_NAME 2>$null

  Ensure-DevServerViaPm2

  if ($Force) { Write-Info "强制重新生成地址（不使用上一次的地址）..." }
  else        { Write-Info "正在部署（优先复用上一次的内网穿透地址）..." }

  Invoke-TunnelDeploy $Force | Out-Null
  pm2 save 2>$null | Out-Null
}

function Do-Start { Do-Deploy $false }

function Do-Stop {
  # 先停隧道，再停 dev server
  if (Test-PortListening $PORT) {
    try { Invoke-RestMethod -Uri "$TUNNEL_API/stop" -Method Post -TimeoutSec 60 | Out-Null } catch { }
  }
  pm2 delete $APP_NAME 2>$null
  pm2 delete $TUNNEL_NAME 2>$null
  Write-Ok "已停止服务"
}

function Do-Restart {
  Assert-Node
  Ensure-Pm2
  Ensure-Cloudflared
  pm2 delete $TUNNEL_NAME 2>$null
  if (Test-PortListening $PORT) { pm2 restart $APP_NAME 2>$null | Out-Null; if (-not (Test-PortListening $PORT)) { Ensure-DevServerViaPm2 } }
  else { Ensure-DevServerViaPm2 }
  Write-Info "正在重启（复用优先：地址仍可用就不换）..."
  Invoke-TunnelDeploy $false | Out-Null
  pm2 save 2>$null | Out-Null
}

function Do-Status {
  pm2 status
  Write-Host ""
  if (-not (Test-PortListening $PORT)) {
    Write-Warn "dev server 未运行，无法读取隧道状态。请执行 .\deploy.ps1 deploy"
    return
  }
  $st = Invoke-RestMethod -Uri "$TUNNEL_API/status" -Method Get -TimeoutSec 120
  Write-Host ("  cloudflared      " + $(if ($st.cloudflared.running) { "运行中 (PID " + ($st.cloudflared.pids -join ', ') + ")" } else { '未运行' }))
  if ($st.url) { Write-Host ("  内网穿透地址     $($st.url)") -ForegroundColor Green } else { Write-Host "  内网穿透地址     （暂无）" }
  Write-Host ("  地址可用         " + $(if ($st.urlHealthy) { '是（部署时会复用，不会更换）' } else { '否（部署时会重新生成）' }))
  Write-Host ("  提示             $($st.hint)")
  Write-Host ""
  Write-Info "本地部署页： http://localhost:$PORT/deploy"
}

function Do-Logs {
  pm2 logs $APP_NAME
  Write-Info "隧道日志： Get-Content `"$APP_DIR\.run\tunnel.err.log`" -Tail 50"
}

# 配置开机/登录自启（计划任务，触发于登录）
function Do-Startup {
  $taskName = 'FeishuDayin'
  $scriptPath = Join-Path $APP_DIR 'deploy.ps1'
  $action = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" deploy"
  Write-Info "注册计划任务 '$taskName'（登录时自启）..."
  # 用 schtasks 创建（需以管理员身份运行本脚本才能成功注册系统级任务）
  $existing = schtasks /Query /TN $taskName 2>$null
  if ($existing) { schtasks /Delete /TN $taskName /F | Out-Null }
  schtasks /Create /TN $taskName /TR $action /SC ONLOGON /RL HIGHEST /F
  Write-Ok "已创建计划任务。登录 Windows 时会自动执行 .\deploy.ps1 deploy 拉起服务。"
  Write-Warn "若需‘开机即启动（无需登录）’，请以 SYSTEM 权限运行，或手动在任务计划程序中将‘安全选项’改为‘不管用户是否登录都要运行’并勾选‘使用最高权限’。"
  # 立即保存当前 pm2 进程，便于 resurrect
  pm2 save | Out-Null
}

function Show-TunnelHelp {
  Write-Host @"

固定域名命名隧道（地址永远不变，重启电脑也不变）：
  临时隧道（默认）的域名是 Cloudflare 随机分配的，只能「尽量复用」不能「永久固定」。
  要做到永久固定，需要一个托管在 Cloudflare 的域名：
1. 准备一个托管在 Cloudflare 的域名（如 print.example.com）。
2. 登录 cloudflared：  cloudflared login
3. 创建命名隧道：      cloudflared tunnel create feishu-dayin
4. 配置 ~/.cloudflared/config.yml：
      tunnel: feishu-dayin
      credentials-file: <第3步生成的隧道ID>.json
      ingress:
        - hostname: print.example.com
          service: http://localhost:$PORT
        - service: http_status:404
5. 路由 DNS：          cloudflared tunnel route dns feishu-dayin print.example.com
6. 用命名隧道启动：
      cloudflared tunnel run feishu-dayin
   （也可写成 pm2 进程长期守护；此时地址固定为 https://print.example.com）
7. 飞书插件地址填 https://print.example.com 后就不用再改。
"@
}

switch ($Command) {
  'install' { Do-Install }
  'deploy'  { Do-Deploy $false }
  'start'   { Do-Start }
  'new'     { Do-Deploy $true }
  'stop'    { Do-Stop }
  'restart' { Do-Restart }
  'status'  { Do-Status }
  'logs'    { Do-Logs }
  'startup' { Do-Startup }
  'tunnel'  { Show-TunnelHelp }
  default   { Write-Err "未知命令：$Command"; Write-Host "可用：install/deploy/start/new/stop/restart/status/logs/startup/tunnel" }
}
