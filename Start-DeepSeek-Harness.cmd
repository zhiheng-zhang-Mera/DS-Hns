@echo off
setlocal
rem ============================================================
rem  DS-Harness — normal launcher after installation.
rem  If the local install is incomplete, delegate to the canonical
rem  one-click installer instead of running a second bootstrap path.
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

set "INSTALL_REQUIRED=0"
if not exist "%DSH_ROOT%\app\node_modules\@deepseek-ai\dsh\lib\bin.js" set "INSTALL_REQUIRED=1"
if not exist "%DSH_ROOT%\app\node_modules\electron\dist\electron.exe" set "INSTALL_REQUIRED=1"

set "NODE_DIR="
for /d %%D in ("%DSH_ROOT%\runtime\node-v*") do set "NODE_DIR=%%D"
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
where node >nul 2>nul
if errorlevel 1 set "INSTALL_REQUIRED=1"

if "%INSTALL_REQUIRED%"=="1" (
  echo [DS-Harness] Local installation is incomplete.
  echo [DS-Harness] Handing off to Install-DS-Harness.cmd ...
  if not exist "%DSH_ROOT%\Install-DS-Harness.cmd" (
    echo [ERROR] Install-DS-Harness.cmd is missing.
    pause
    exit /b 1
  )
  call "%DSH_ROOT%\Install-DS-Harness.cmd"
  exit /b %ERRORLEVEL%
)

rem For pure Alien regression mode, launch from a terminal with:
rem   set DSH_DISABLE_MEGA=1
rem then run this file. Mega tools shortcut when enabled: Ctrl+Shift+M.
start "DS-Harness" "%DSH_ROOT%\app\node_modules\electron\dist\electron.exe" "%DSH_ROOT%\app\desktop-main.cjs"
exit /b %ERRORLEVEL%
