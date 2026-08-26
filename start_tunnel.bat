@echo off
REM ============================================================
REM feishuprint one-click start: dev server + cloudflared tunnel
REM Double-click to run. Two windows will open:
REM   1) dev server (port 5173, keep it running)
REM   2) cloudflared tunnel - the https://xxx.trycloudflare.com
REM      url printed in this window is the plugin address
REM ============================================================
cd /d "%~dp0"

echo [1/2] Starting dev server on port 5173 ...
start "feishuprint-dev" cmd /k "npm run start"

echo [2/2] Waiting for dev server, then starting cloudflared tunnel ...
timeout /t 12 /nobreak >nul
cloudflared tunnel --protocol http2 --edge-ip-version 4 --url http://localhost:5173

pause
