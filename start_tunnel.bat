@echo off
chcp 65001 >nul
setlocal EnableExtensions
pushd "%~dp0"
set "LOG=%~dp0deploy-log.txt"

rem ============================================================
rem  feishuprint LEGACY entry -- identical to tunnel.bat.
rem  Kept so old shortcuts keep working. Prefer deploy.bat.
rem  ASCII-only on purpose: cmd.exe desyncs on multi-byte chars under cp65001.
rem ============================================================

echo ==================== start_tunnel.bat %DATE% %TIME% ==================== > "%LOG%"
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
echo  [hint] logs: deploy-log.txt , .run\tunnel-cli.log
pause
popd
endlocal & exit /b %RC%

:NONODE
echo.
echo  [ERROR] Node.js not found.
echo          Searched: system PATH, WorkBuddy bundled dirs, Program Files, node-path.txt
echo          Fix: write the full path to node.exe into node-path.txt in the project root.
echo.
pause
popd
endlocal & exit /b 1
