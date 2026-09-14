@echo off
rem ============================================================
rem  _find_node.bat —— 供其他 bat 调用：定位可用的 node.exe
rem  结果写入变量 NODE_EXE（完整路径；值为 node 表示已在 PATH 中）。
rem  注意：本文件故意不使用 setlocal —— 变量要留给调用方。
rem
rem  查找顺序：
rem    1) 系统 PATH
rem    2) WorkBuddy 内置 Node（递归查找 node.exe，自动适配版本目录）
rem    3) 常见安装位置 Program Files 等
rem    4) 项目根目录 node-path.txt 的第一行（手动兜底指定）
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
if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if defined NODE_EXE goto :eof
if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
if defined NODE_EXE goto :eof

rem 手动兜底：项目根目录 node-path.txt 第一行写 node.exe 完整路径
if not exist "%~dp0node-path.txt" goto :eof
set /p NODE_EXE=<"%~dp0node-path.txt"
if not defined NODE_EXE goto :eof
if exist "%NODE_EXE%" goto :eof
set "NODE_EXE="
goto :eof
