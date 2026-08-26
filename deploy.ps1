# ============================================================
# feishuprint Windows 一键部署脚本（长期挂机用）
# 依赖：Node.js 16+、npm、PowerShell 5.1+
# 本脚本会自动安装（如缺失）：pm2、cloudflared
#
# 用法（在仓库目录下用 PowerShell 运行）：
#   .\deploy.ps1 install    首次安装依赖（npm 依赖 + pm2 + cloudflared）
#   .\deploy.ps1 start      启动 dev server + 内网穿透（pm2 守护）
#   .\deploy.ps1 stop       停止服务
#   .\deploy.ps1 restart    重启服务
#   .\deploy.ps1 status     查看进程状态与穿透地址
#   .\deploy.ps1 logs       查看实时日志（Ctrl+C 退出）
#   .\deploy.ps1 startup    配置开机/登录自启（需管理员权限）
#   .\deploy.ps1 tunnel     查看固定域名命名隧道配置步骤
#
# 端口：默认 5173，可用 $env:PORT=5199 后 .\deploy.ps1 start 自定义
# ============================================================
param(
  [string]$Command = 'start'
)

$ErrorActionPreference = 'Stop'
$APP_DIR = $PSScriptRoot
$APP_NAME = 'feishuprint'
$TUNNEL_NAME = 'feishuprint-tunnel'
$PORT = if ($env:PORT) { $env:PORT } else { '5173' }
$PM2_HOME = if ($env:PM2_HOME) { $env:PM2_HOME } else { Join-Path $env:USERPROFILE '.pm2' }
$LOG_DIR = Join-Path $PM2_HOME 'logs'

function Write-Info($m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "[OK]   $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Write-Err($m)  { Write-Host "[ERR]  $m" -ForegroundColor Red }

function Test-Command($c) { Get-Command $c -ErrorAction SilentlyContinue }

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
  # 确保 pm2 在 PATH（npm 全局 bin 通常已在 PATH）
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
  Write-Ok "安装完成。运行 .\deploy.ps1 start 启动服务。"
}

# 启动 dev server + 内网穿透
function Do-Start {
  Assert-Node
  Ensure-Pm2
  Ensure-Cloudflared
  # 若已存在同名进程先删，避免重复
  pm2 delete $APP_NAME 2>$null
  pm2 delete $TUNNEL_NAME 2>$null
  Write-Info "启动 dev server（端口 $PORT）..."
  pm2 start --name $APP_NAME --cwd "$APP_DIR" npm -- run start
  Write-Info "启动内网穿透..."
  # 国内网络 QUIC(UDP) 常被限速/拦截，强制 http2(TCP 443) 更稳定
  pm2 start --name $TUNNEL_NAME cloudflared -- tunnel --protocol http2 --edge-ip-version 4 --url "http://localhost:$PORT"
  pm2 save | Out-Null
  Write-Ok "服务已启动。稍候查看穿透地址："
  Start-Sleep -Seconds 3
  Show-TunnelUrl
}

function Do-Stop {
  pm2 delete $APP_NAME 2>$null
  pm2 delete $TUNNEL_NAME 2>$null
  Write-Ok "已停止服务"
}

function Do-Restart {
  Do-Stop
  Do-Start
}

# 从 pm2 日志文件提取 cloudflared 穿透地址
function Show-TunnelUrl {
  Write-Info "内网穿透地址："
  $url = $null
  if (Test-Path $LOG_DIR) {
    $url = (Get-ChildItem $LOG_DIR -Filter "$TUNNEL_NAME-*.log" -ErrorAction SilentlyContinue |
            Get-Content -ErrorAction SilentlyContinue |
            Select-String -Pattern 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' |
            Select-Object -Last 1).Line
  }
  if ($url) {
    Write-Ok "$url  ← 把这个填进飞书插件配置"
  } else {
    Write-Warn "尚未获取到地址，cloudflared 可能还在启动中，稍后执行 .\deploy.ps1 status"
    Write-Info "手动查看：Get-Content `"$LOG_DIR\$TUNNEL_NAME-out.log`" -Tail 50"
  }
}

function Do-Status {
  pm2 status
  Write-Host ""
  Show-TunnelUrl
}

function Do-Logs {
  pm2 logs $APP_NAME $TUNNEL_NAME
}

# 配置开机/登录自启（计划任务，触发于登录）
function Do-Startup {
  $taskName = 'FeishuDayin'
  $scriptPath = Join-Path $APP_DIR 'deploy.ps1'
  $action = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" start"
  Write-Info "注册计划任务 '$taskName'（登录时自启）..."
  # 用 schtasks 创建（需以管理员身份运行本脚本才能成功注册系统级任务）
  $existing = schtasks /Query /TN $taskName 2>$null
  if ($existing) { schtasks /Delete /TN $taskName /F | Out-Null }
  schtasks /Create /TN $taskName /TR $action /SC ONLOGON /RL HIGHEST /F
  Write-Ok "已创建计划任务。登录 Windows 时会自动执行 .\deploy.ps1 start 拉起服务。"
  Write-Warn "若需‘开机即启动（无需登录）’，请以 SYSTEM 权限运行，或手动在任务计划程序中将‘安全选项’改为‘不管用户是否登录都要运行’并勾选‘使用最高权限’。"
  # 立即保存当前 pm2 进程，便于 resurrect
  pm2 save | Out-Null
}

function Show-TunnelHelp {
  Write-Host @"

固定域名命名隧道（地址不会每次变化）：
1. 准备一个托管在 Cloudflare 的域名（如 print.example.com）。
2. 登录 cloudflared：  cloudflared login
3. 创建命名隧道：      cloudflared tunnel create feishu-dayin
4. 配置 ~/.cloudflared/config.yml：
      tunnel: feishu-dayin
      ingress:
        - hostname: print.example.com
          service: http://localhost:$PORT
        - service: http://localhost:$PORT
5. 用命名隧道启动（替换 start 里的临时隧道）：
      pm2 start --name $TUNNEL_NAME cloudflared -- tunnel --url http://localhost:$PORT run feishu-dayin
6. 在 Cloudflare DNS 将 print.example.com 指向该隧道，飞书插件填 https://print.example.com
"@
}

switch ($Command) {
  'install' { Do-Install }
  'start'   { Do-Start }
  'stop'    { Do-Stop }
  'restart' { Do-Restart }
  'status'  { Do-Status }
  'logs'    { Do-Logs }
  'startup' { Do-Startup }
  'tunnel'  { Show-TunnelHelp }
  default   { Write-Err "未知命令：$Command"; Write-Host "可用：install/start/stop/restart/status/logs/startup/tunnel" }
}
