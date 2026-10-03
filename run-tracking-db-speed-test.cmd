@echo off
setlocal
cd /d "%~dp0"
echo Starting Tracking Database Speed Test...
echo.
node tracking-db-speed-test.mjs
pause
