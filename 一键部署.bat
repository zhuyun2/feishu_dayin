@echo off
rem ============================================================
rem  feishuprint one-click deploy -- Chinese-named wrapper.
rem
rem  Double-click this file. It simply forwards to deploy.bat,
rem  which holds the real logic. The wrapper exists so the entry
rem  point has a friendly Chinese name; its CONTENT stays pure
rem  ASCII because cmd.exe desyncs on multi-byte characters when
rem  the code page is 65001.
rem ============================================================
call "%~dp0deploy.bat" %*
