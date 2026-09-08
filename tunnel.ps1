# ============================================================
# feishuprint tunnel manager (Windows PowerShell)
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tunnel.ps1 start
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tunnel.ps1 restart   <- restart tunnel and show new URL
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tunnel.ps1 stop
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tunnel.ps1 status
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tunnel.ps1 url
#
# Or double-click tunnel.bat (same as restart).
#
# Features:
#   - auto start / reuse dev server on localhost:5173
#   - start cloudflared quick tunnel (random host, see note below)
#   - extract public URL from logs, save to tunnel-url.txt and print it
#
# NOTE about fixed URL: quick tunnels always get a random hostname.
# A permanent hostname requires a named tunnel + your own domain on Cloudflare.
# ============================================================
param(
  [string]$Command = 'start'
)

$ErrorActionPreference = 'Stop'

$APP_DIR    = Split-Path -Parent $MyInvocation.MyCommand.Path
$PORT       = '5173'
$RUN_DIR    = Join-Path $APP_DIR '.run'
$SERVER_LOG = Join-Path $RUN_DIR 'server.log'
$TUNNEL_LOG = Join-Path $RUN_DIR 'tunnel.log'
$TUNNEL_ERR = Join-Path $RUN_DIR 'tunnel.err.log'
$URL_FILE   = Join-Path $APP_DIR 'tunnel-url.txt'
$URL_RE     = 'https://[a-zA-Z0-9-]+\.trycloudflare\.com'
$MAX_ATTEMPTS = 4

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
  # 1) cloudflared.exe on PATH (winget install)
  $c = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  # 2) npm global package embedded binary
  $p1 = Join-Path $env:APPDATA 'QClaw\npm-global\node_modules\cloudflared\bin\cloudflared.exe'
  if (Test-Path $p1) { return $p1 }
  # 3) winget package folder
  $p2 = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter 'cloudflared.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($p2) { return $p2.FullName }
  return $null
}

function Ensure-DevServer {
  if (Test-PortListening $PORT) {
    Write-Ok "dev server already listening on :$PORT"
    return
  }
  Write-Info "dev server not running, starting npm run start ..."
  $cmd = "npm run start > `"$SERVER_LOG`" 2>&1"
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WorkingDirectory $APP_DIR -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    if (Test-PortListening $PORT) {
      Write-Ok "dev server is up on :$PORT"
      return
    }
  }
  Write-Err "dev server failed to start within 90s. Check $SERVER_LOG"
  exit 1
}

function Stop-Tunnel {
  $procs = Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue
  if ($procs) {
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 1
    Write-Ok "stopped old cloudflared process(es)"
  } else {
    Write-Info "no cloudflared process running"
  }
}

function Start-Tunnel {
  $exe = Find-CloudflaredExe
  if (-not $exe) {
    Write-Err "cloudflared.exe not found. Run deploy.ps1 install first, or install via: winget install Cloudflare.cloudflared"
    exit 1
  }

  # Unstable DNS may kill cloudflared early; retry up to $MAX_ATTEMPTS times.
  for ($attempt = 1; $attempt -le $MAX_ATTEMPTS; $attempt++) {
    if ($attempt -gt 1) {
      Write-Warn "cloudflared exited early, retrying ($attempt/$MAX_ATTEMPTS) in 3s..."
      Start-Sleep -Seconds 3
      Stop-Tunnel
      Start-Sleep -Seconds 1
    }

    Write-Info "starting cloudflared tunnel -> http://localhost:$PORT (attempt $attempt/$MAX_ATTEMPTS)"
    Remove-Item $TUNNEL_LOG, $TUNNEL_ERR -Force -ErrorAction SilentlyContinue
    $args = @('tunnel', '--protocol', 'http2', '--edge-ip-version', '4', '--url', "http://localhost:$PORT")
    Start-Process -FilePath $exe -ArgumentList $args -RedirectStandardOutput $TUNNEL_LOG -RedirectStandardError $TUNNEL_ERR -WindowStyle Hidden | Out-Null

    # Wait for the tunnel URL in logs (up to 45s per attempt)
    $deadline = (Get-Date).AddSeconds(45)
    $url = $null
    while ((Get-Date) -lt $deadline -and -not $url) {
      Start-Sleep -Seconds 2
      foreach ($f in @($TUNNEL_LOG, $TUNNEL_ERR)) {
        if (Test-Path $f) {
          $raw = Get-Content $f -Raw -ErrorAction SilentlyContinue
          if ($raw) {
            $m = [regex]::Match($raw, $URL_RE)
            if ($m.Success) { $url = $m.Value; break }
          }
        }
      }
    }

    if ($url) {
      $url | Set-Content -Path $URL_FILE -Encoding UTF8
      Write-Ok "Public URL: $url"
      Write-Ok "Saved to: $URL_FILE"
      Write-Warn "NOTE: temporary tunnel URL changes on every restart. Fixed URL requires a named tunnel + your own domain."
      # Wait a bit to confirm the process stays alive (registered connection)
      Start-Sleep -Seconds 8
      $alive = Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue
      if (-not $alive) {
        Write-Warn "URL appeared but process died (network hiccup?), will retry..."
        $url = $null
        continue
      }
      return
    }
  }

  Write-Warn "Could not establish tunnel after $MAX_ATTEMPTS attempts."
  Write-Warn "Check logs: Get-Content `"$TUNNEL_ERR`" -Tail 30"
  exit 1
}

function Show-Status {
  if (Test-PortListening $PORT) { Write-Ok "dev server: running on :$PORT" }
  else                          { Write-Warn "dev server: NOT running" }
  $procs = Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue
  if ($procs) { Write-Ok ("cloudflared: running (PID " + (($procs | ForEach-Object Id) -join ', ') + ")") }
  else        { Write-Warn "cloudflared: NOT running" }
  if (Test-Path $URL_FILE) {
    Write-Ok ("Last public URL: " + (Get-Content $URL_FILE -Raw).Trim())
  } else {
    Write-Warn "No URL recorded yet (run restart first)."
  }
}

function Show-Url {
  if (Test-Path $URL_FILE) {
    Write-Host ((Get-Content $URL_FILE -Raw).Trim())
  } else {
    Write-Err "No URL recorded yet. Run: .\tunnel.ps1 restart"
  }
}

switch ($Command.ToLower()) {
  'start'   { Ensure-DevServer; Stop-Tunnel; Start-Tunnel }
  'restart' { Ensure-DevServer; Stop-Tunnel; Start-Tunnel }
  'stop'    { Stop-Tunnel }
  'status'  { Show-Status }
  'url'     { Show-Url }
  default   { Write-Err "Unknown command: $Command"; Write-Host "Usage: start / restart / stop / status / url" }
}
