@echo off
rem ============================================================
rem  _find_node.bat -- helper for other bats: locate a usable node.exe
rem  Result is written to the variable NODE_EXE (full path; "node" = already on PATH).
rem  NOTE: no setlocal on purpose -- the variable must survive for the caller.
rem  ASCII-only on purpose: cmd.exe desyncs on multi-byte chars under cp65001.
rem
rem  Lookup order:
rem    1) system PATH
rem    2) WorkBuddy bundled Node (recursive node.exe search, version-agnostic)
rem    3) common install locations
rem    4) first line of node-path.txt in the project root (manual override)
rem ============================================================

set "NODE_EXE="

where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if defined NODE_EXE goto :eof

for /f "delims=" %%i in ('where /r "%USERPROFILE%\.workbuddy\binaries\node\versions" node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if defined NODE_EXE goto :eof

for /f "delims=" %%i in ('where /r "%LOCALAPPDATA%\.workbuddy\binaries\node\versions" node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if defined NODE_EXE goto :eof

if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODE_EXE goto :eof
if exist "C:/Program Files/nodejs/node.exe" set "NODE_EXE=C:/Program Files\nodejs\node.exe"
if defined NODE_EXE goto :eof
if exist "C:/Program Files (x86)/nodejs/node.exe" set "NODE_EXE=C:/Program Files (x86)\nodejs\node.exe"
if defined NODE_EXE goto :eof

rem manual override: put the full path to node.exe on line 1 of node-path.txt
if not exist "%~dp0node-path.txt" goto :eof
set /p NODE_EXE=<"%~dp0node-path.txt"
if not defined NODE_EXE goto :eof
if exist "%NODE_EXE%" goto :eof
set "NODE_EXE="
goto :eof
