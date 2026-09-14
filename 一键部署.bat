@echo off
chcp 65001 >nul
setlocal EnableExtensions
pushd "%~dp0"
set "LOG=%~dp0deploy-log.txt"

rem ============================================================
rem  feishuprint 一键部署 —— 内网穿透地址管理
rem  复用优先：上一次的地址还能用就直接复用，地址不变；
rem  只有地址失效 / 隧道进程没了，才重新生成并打印新地址。
rem  逻辑在 server/tunnelCore.js，与 dev server 的 /api/tunnel/* 同源。
rem ============================================================

echo ==================== 一键部署 %DATE% %TIME% ==================== > "%LOG%"
echo [env] CWD=%CD% >> "%LOG%"
echo [env] PATH=%PATH% >> "%LOG%"

call "%~dp0_find_node.bat"
echo [step] NODE_EXE=%NODE_EXE% >> "%LOG%"
if not defined NODE_EXE goto NONODE

echo [step] run: "%NODE_EXE%" tunnel.js deploy >> "%LOG%"
"%NODE_EXE%" "%~dp0tunnel.js" deploy %*
set "RC=%ERRORLEVEL%"
echo [step] node exit=%RC% >> "%LOG%"

echo.
echo  [提示] 需要排查时看这两个日志：deploy-log.txt、.run\tunnel-cli.log
pause
popd
endlocal & exit /b %RC%

:NONODE
echo.
echo  [错误] 没找到 Node.js
echo         已查找：系统 PATH、WorkBuddy 内置目录、Program Files、node-path.txt
echo         解决办法：把 node.exe 的完整路径写进项目根目录的 node-path.txt 后重试
echo.
pause
popd
endlocal & exit /b 1
