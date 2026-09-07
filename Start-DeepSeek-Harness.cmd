@echo off
setlocal
rem ============================================================
rem  DS-Harness — Alien-derived desktop launcher
rem  Official dsh Web UI is the primary renderer. Mega is optional.
rem ============================================================
set "DSH_ROOT=%~dp0"
if "%DSH_ROOT:~-1%"=="\" set "DSH_ROOT=%DSH_ROOT:~0,-1%"
set "DSH_HOME=%DSH_ROOT%\data"
set "npm_config_cache=%DSH_ROOT%\cache\npm"
set "TEMP=%DSH_ROOT%\temp"
set "TMP=%DSH_ROOT%\temp"

if not exist "%DSH_HOME%" mkdir "%DSH_HOME%"
if not exist "%npm_config_cache%" mkdir "%npm_config_cache%"
if not exist "%TEMP%" mkdir "%TEMP%"
if not exist "%DSH_ROOT%\logs" mkdir "%DSH_ROOT%\logs"

set "NODE_DIR="
for /d %%D in ("%DSH_ROOT%\runtime\node-v*") do set "NODE_DIR=%%D"
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Put a node-v* runtime under "%DSH_ROOT%\runtime" or add Node.js to PATH.
  pause
  exit /b 1
)

cd /d "%DSH_ROOT%\app"
if not exist "%DSH_ROOT%\app\node_modules\@deepseek-ai\dsh\lib\bin.js" (
  echo [First run] Installing dependencies...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm ci failed.
    pause
    exit /b 1
  )
)

rem For pure Alien regression mode, launch from a terminal with:
rem   set DSH_DISABLE_MEGA=1
rem then run this file. Mega tools shortcut when enabled: Ctrl+Shift+M.
start "DS-Harness" "%DSH_ROOT%\app\node_modules\electron\dist\electron.exe" "%DSH_ROOT%\app\desktop-main.cjs"
exit /b %ERRORLEVEL%
