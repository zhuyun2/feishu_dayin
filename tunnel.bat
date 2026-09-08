@echo off
rem ============================================================
rem  feishuprint 内网穿透一键重启（双击运行）
rem  效果：拉起/复用 dev server -> 重启 cloudflared -> 显示新地址
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo  [feishuprint] 正在重启内网穿透，请稍候...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tunnel.ps1" restart

echo.
echo  ============================================================
echo   公网地址已显示在上方（也保存在 tunnel-url.txt）
echo   如需固定地址（不随机变化）：需 Cloudflare 命名隧道 + 自有域名
echo  ============================================================
echo.
pause
