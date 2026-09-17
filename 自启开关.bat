@echo off
chcp 65001 >nul
setlocal EnableExtensions
pushd "%~dp0"

rem ============================================================
rem  Logon autostart switch
rem
rem    self-name on    -> enable logon autostart
rem    self-name off   -> disable logon autostart
rem    double click    -> show current state, then ask
rem
rem  Delegates to server/setupCore.js autostart on|off, which prints
rem  all Chinese explanations (safer than echoing Chinese from a .bat).
rem  Manual removal also works: delete feishuprint-autostart.vbs from
rem  the Startup folder.
rem
rem  ASCII-only on purpose: cmd.exe desyncs on multi-byte chars under cp65001.
rem ============================================================

set "ACT=%~1"
if /i "%ACT%"=="on"  goto :DO
if /i "%ACT%"=="off" goto :DO

echo.
call "%~dp0deploy.bat" autostart
echo.
set "ACT="
set /p "ACT=type on / off then Enter ^(blank = cancel^): "

if /i "%ACT%"=="on"  goto :DO
if /i "%ACT%"=="off" goto :DO
echo.
echo  cancelled, nothing changed.
echo.
pause
popd
endlocal & exit /b 0

:DO
call "%~dp0deploy.bat" autostart %ACT%
popd
endlocal & exit /b %ERRORLEVEL%
