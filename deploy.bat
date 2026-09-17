@echo off
chcp 65001 >nul
setlocal EnableExtensions
pushd "%~dp0"
set "LOG=%~dp0deploy-log.txt"

rem ============================================================
rem  feishuprint one-click deploy (fixed hostname tunnel)
rem
rem  NOTE: this file is intentionally ASCII-only.
rem  cmd.exe loses byte sync on multi-byte characters when the code
rem  page is 65001, which makes garbage fragments get executed.
rem  Every Chinese message is printed by node (server/setupCore.js).
rem
rem  On a fresh machine a folder copy is enough. It will:
rem    1. locate Node  ->  runtime\node\node.exe, else system/WorkBuddy node
rem    2. if still missing, download a portable Node into runtime\node
rem    3. hand over to server/setupCore.js, which ensures cloudflared,
rem       installs the tunnel credentials, starts the dev server plus the
rem       fixed-hostname tunnel, and registers logon autostart.
rem
rem  Usage:
rem    deploy.bat                      one-click deploy (default)
rem    deploy.bat --silent             quiet, no pause (logon script uses this)
rem    deploy.bat --no-autostart       do not register logon autostart
rem    deploy.bat --no-download        never download anything
rem    deploy.bat --force              restart the tunnel
rem    deploy.bat status | doctor | stop | restart | url
rem    deploy.bat profiles | list-domains      list configured fixed domains
rem    deploy.bat add-domain <tag> <hostname>  create a new fixed domain
rem    deploy.bat --profile <tag>              pick which domain to deploy
rem    deploy.bat autostart on | autostart off
rem ============================================================

set "SILENT="
for %%a in (%*) do if /i "%%a"=="--silent" set "SILENT=1"

echo ==================== deploy %DATE% %TIME% ==================== > "%LOG%"
echo [env] CWD=%CD% >> "%LOG%"
echo [env] PATH=%PATH% >> "%LOG%"

rem ---------- 1. prefer the portable node carried with the project ----------
set "NODE_EXE="
if exist "%~dp0runtime\node\node.exe" set "NODE_EXE=%~dp0runtime\node\node.exe"
if defined NODE_EXE goto :HAVE_NODE

rem ---------- 2. fall back to system / WorkBuddy bundled node ----------
call "%~dp0_find_node.bat"
if defined NODE_EXE goto :HAVE_NODE

rem ---------- 3. still nothing -> fetch a portable Node ----------
if not defined SILENT echo.
if not defined SILENT echo  Node.js not found - downloading portable Node.js ^(~30MB, first run only^) ...
echo [step] node not found, downloading portable node >> "%LOG%"

set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" set "PS_EXE=powershell.exe"

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\get-node.ps1"
echo [step] get-node.ps1 exit=%ERRORLEVEL% >> "%LOG%"

if exist "%~dp0runtime\node\node.exe" set "NODE_EXE=%~dp0runtime\node\node.exe"
if not defined NODE_EXE goto :NONODE

:HAVE_NODE
echo [step] NODE_EXE=%NODE_EXE% >> "%LOG%"

rem ---------- forward to setupCore, keeping real subcommands intact ----------
rem Any first arg that is NOT a known subcommand is treated as a deploy flag
rem (e.g. --profile print2 / --silent), so the subcommand list must stay complete:
rem a missing entry here silently turns "deploy.bat profiles" into a full deploy.
set "SUB="
for %%a in (status doctor stop restart url autostart profiles list-domains add-domain add) do if /i "%~1"=="%%a" set "SUB=1"
if defined SUB goto :RUN_SUB

echo [step] run: setupCore deploy %* >> "%LOG%"
"%NODE_EXE%" "%~dp0server\setupCore.js" deploy %*
set "RC=%ERRORLEVEL%"
goto :AFTER

:RUN_SUB
echo [step] run: setupCore %* >> "%LOG%"
"%NODE_EXE%" "%~dp0server\setupCore.js" %*
set "RC=%ERRORLEVEL%"

:AFTER
echo [step] setupCore exit=%RC% >> "%LOG%"
if defined SILENT goto :END
echo.
echo  [hint] logs: deploy-log.txt , .run\named-tunnel.err.log
echo         diagnose: %~nx0 doctor
pause
goto :END

:NONODE
echo.
echo  [ERROR] Node.js is missing and could not be downloaded automatically.
echo.
echo  Two ways to fix:
echo    1^) connect to the internet and retry, or download a portable zip from
echo       https://nodejs.org/dist/  and put node.exe here:
echo          %~dp0runtime\node\node.exe
echo    2^) copy the whole runtime\node\ folder from the old computer
echo.
echo  Offline installs: use --no-download and do option 2.
echo.
set "RC=1"
if defined SILENT goto :END
pause

:END
echo [step] final exit=%RC% >> "%LOG%"
popd
endlocal & exit /b %RC%
