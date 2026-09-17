# ============================================================
# feishuprint fixed-hostname tunnel manager (named tunnel)
#
# Runs:  cloudflared tunnel --protocol http2 run feishuprint
# URL:   https://print.dimeifeishudayin.icu  (permanent)
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tunnel-fixed.ps1 start
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tunnel-fixed.ps1 status
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tunnel-fixed.ps1 stop
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tunnel-fixed.ps1 restart
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tunnel-fixed.ps1 url
# ============================================================
param(
  [string]$Command = 'status'
)

$ErrorActionPreference = 'Stop'

$APP_DIR      = Split-Path -Parent $MyInvocation.MyCommand.Path
$RUN_DIR      = Join-Path $APP_DIR '.run'
$TUNNEL_LOG   = Join-Path $RUN_DIR 'tunnel-fixed.log'
$TUNNEL_ERR   = Join-Path $RUN_DIR 'tunnel-fixed.err.log'
$URL_FILE     = Join-Path $APP_DIR 'tunnel-url.txt'
$FIXED_URL    = 'https://print.dimeifeishudayin.icu'
$TUNNEL_NAME  = 'feishuprint'
$PORT         = '5173'
$CRED_FILE    = Join-Path $env:USERPROFILE ".cloudflared\02abb661-fe4f-4fc8-b898-d27048aae8c1.json"
$CONFIG_FILE  = Join-Path $env:USERPROFILE '.cloudflared\config.yml'

New-Item -ItemType Directory -Force -Path $RUN_DIR | Out-Null

function Write-Info($m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "[OK]   $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Write-Err($m)  { Write-Host "[ERR]  $m" -ForegroundColor Red }

function Test-PortListening($port) {
  $line = netstat -ano | Select-String (":$port\s.*LISTENING")
  return ($null -ne $line)
}

function Find-CloudflaredExe {
  $c = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $p1 = Join-Path $env:APPDATA 'QClaw\npm-global\node_modules\cloudflared\bin\cloudflared.exe'
  if (Test-Path $p1) { return $p1 }
  return $null
}

function Ensure-DevServer {
  if (Test-PortListening $PORT) {
    Write-Ok "dev server on :$PORT"
    return
  }
  Write-Err "dev server NOT running on :$PORT. Start it first: cd $APP_DIR ; npm run start"
  exit 1
}

function Ensure-Prerequisites {
  $exe = Find-CloudflaredExe
  if (-not $exe) { Write-Err "cloudflared.exe not found"; exit 1 }
  if (-not (Test-Path $CRED_FILE)) { Write-Err "credentials file missing: $CRED_FILE"; exit 1 }
  if (-not (Test-Path $CONFIG_FILE)) { Write-Err "config.yml missing: $CONFIG_FILE"; exit 1 }
  return $exe
}

function Stop-Tunnel {
  $procs = Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue
  if ($procs) {
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 1
    Write-Ok "stopped cloudflared"
  } else {
    Write-Info "no cloudflared process"
  }
}

function Start-Tunnel {
  $exe = Ensure-Prerequisites
  Ensure-DevServer
  Stop-Tunnel
  Remove-Item $TUNNEL_LOG, $TUNNEL_ERR -Force -ErrorAction SilentlyContinue
  $args = @('tunnel', '--protocol', 'http2', '--edge-ip-version', '4', 'run', $TUNNEL_NAME)
  Write-Info "starting: cloudflared tunnel ... run $TUNNEL_NAME"
  Start-Process -FilePath $exe -ArgumentList $args `
    -RedirectStandardOutput $TUNNEL_LOG `
    -RedirectStandardError  $TUNNEL_ERR `
    -WindowStyle Hidden | Out-Null

  $deadline = (Get-Date).AddSeconds(90)
  $ready = $false
  while ((Get-Date) -lt $deadline -and -not $ready) {
    Start-Sleep -Seconds 2
    if (Test-Path $TUNNEL_LOG) {
      $content = Get-Content $TUNNEL_LOG -Raw -ErrorAction SilentlyContinue
      if ($content -and $content -match 'Registered tunnel connection') { $ready = $true }
    }
  }
  if ($ready) {
    $FIXED_URL | Set-Content -Path $URL_FILE -Encoding UTF8
    Write-Ok "Public URL: $FIXED_URL  (permanent, will NOT change on restart)"
    Write-Ok "Log: $TUNNEL_LOG"
  } else {
    Write-Warn "tunnel did not register in 90s. Check $TUNNEL_ERR"
    Write-Info "process is still starting - run 'status' in a few seconds"
  }
}

function Show-Status {
  if (Test-PortListening $PORT) { Write-Ok "dev server: running on :$PORT" }
  else                          { Write-Err "dev server: NOT running" }
  $procs = Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue
  if ($procs) { Write-Ok ("cloudflared: running (PID " + (($procs | ForEach-Object Id) -join ', ') + ")") }
  else        { Write-Err "cloudflared: NOT running" }
  Write-Host ""
  Write-Ok "Public URL: $FIXED_URL"
  Write-Host ""
  try {
    $http = C:\Windows\System32\curl.exe -s -o nul -w "%{http_code}" -m 10 $FIXED_URL
    Write-Ok ("Live check: HTTP $http")
  } catch {
    Write-Warn "Live check failed: $($_.Exception.Message)"
  }
}

function Show-Url {
  Write-Host $FIXED_URL
}

switch ($Command.ToLower()) {
  'start'   { Start-Tunnel }
  'stop'    { Stop-Tunnel }
  'restart' { Start-Tunnel }
  'status'  { Show-Status }
  'url'     { Show-Url }
  default   { Write-Err "Unknown command: $Command"; Write-Host "Usage: start / stop / restart / status / url" }
}