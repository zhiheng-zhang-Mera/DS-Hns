@echo off
setlocal EnableExtensions
rem ============================================================
rem  DS-Harness launcher (DeepSeek Harness Desktop)
rem  Main window = official dsh Web; 视图 menu switches to the
rem  调度中心 (chat / monitor / settings).
rem
rem  Features:
rem    1. If DS-Harness is already running -> bring up / focus its window.
rem    2. If bringing it up fails (unhealthy / no response) -> force close
rem       the running instance and start a fresh one.
rem    3. Auto-repair: if Node.js is missing, download a portable runtime into
rem       runtime\ (scripts\ensure-node.ps1) and continue automatically.
rem    4. First run installs dependencies via scripts\install-deps.ps1.
rem ============================================================
set "DSH_ROOT=%~dp0"
if "%DSH_ROOT:~-1%"=="\" set "DSH_ROOT=%DSH_ROOT:~0,-1%"
set "APP_DIR=%DSH_ROOT%\app"
set "HELPER=%DSH_ROOT%\scripts\launcher-helper.ps1"
set "ENSURE_NODE=%DSH_ROOT%\scripts\ensure-node.ps1"
set "INSTALL_DEPS=%DSH_ROOT%\scripts\install-deps.ps1"
set "ELECTRON_EXE=%APP_DIR%\node_modules\electron\dist\electron.exe"
set "PID_FILE=%DSH_ROOT%\data\state\ds-desktop.pid"
set "PORTS_FILE=%DSH_ROOT%\data\state\ports.json"
set "PIDS_TMP=%DSH_ROOT%\data\state\launcher-pids.tmp"
set "DS_RUNNING=0"
set "DS_HEALTHY=0"
set "DS_UI_PORT=3300"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "NODE_DIR="

if not exist "%PS%" (
  echo [error] PowerShell not found: "%PS%"
  pause
  exit /b 1
)

rem ---------- 1. Node.js: bundled runtime -> PATH -> auto-download repair ----------
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "NODE_DIR="
for /d %%D in ("%DSH_ROOT%\runtime\node-v*") do set "NODE_DIR=%%D"
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
where node >nul 2>nul
if not errorlevel 1 goto :deps

echo [repair] Node.js not found on PATH or in runtime\ - downloading a portable runtime...
for /f %%N in ('call "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%ENSURE_NODE%"') do set "NODE_DIR=%%N"
if "%NODE_DIR%"=="" goto :node_failed
set "PATH=%NODE_DIR%;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto :node_failed
echo [repair] Node.js ready: %NODE_DIR%
goto :deps

:node_failed
echo.
echo [error] Could not obtain Node.js automatically.
echo         Please either:
echo           - run:  powershell -ExecutionPolicy Bypass -File "%ENSURE_NODE%"
echo           - or install Node.js LTS (>=20) from https://nodejs.org and add it to PATH.
pause
exit /b 1

rem ---------- 2. Dependencies (dsh core + Electron) ----------
:deps
if exist "%APP_DIR%\node_modules\@deepseek-ai\dsh\lib\bin.js" if exist "%ELECTRON_EXE%" goto :deps_done
echo [deps] installing project dependencies via npm ci (first run only)...
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_DEPS%"
if errorlevel 1 (
  echo [error] dependency install failed. Check the network and retry.
  pause
  exit /b 1
)
:deps_done

call :read_ui_port

rem ---------- 3. Is DS-Harness already running? ----------
call :detect_running
if "%DS_RUNNING%"=="1" goto :focus_existing
goto :fresh_start

rem ============================================================
:fresh_start
echo [start] launching DS-Harness...
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%DSH_ROOT%\scripts\run.ps1"
echo [done] DS-Harness started (main window = dsh Web; view menu = dispatch center).
exit /b 0

rem ============================================================
:focus_existing
echo [info] DS-Harness is already running - bringing up its window...
call :snapshot_pids
call :focus_once
call :wait_health 12
if "%DS_HEALTHY%"=="1" goto :focused

echo [info] bringing up the existing window failed - no response from the app.
echo [info] force closing the existing DS-Harness instance and reopening...
call :kill_ours
if exist "%PID_FILE%" del /q "%PID_FILE%"
if exist "%PORTS_FILE%" del /q "%PORTS_FILE%"
goto :fresh_start

rem ============================================================
:focused
echo [done] DS-Harness is running and its window has been brought to front.
exit /b 0

rem ============================================================
:detect_running
set "DS_RUNNING=0"
if exist "%PID_FILE%" (
  for /f "usebackq" %%P in ("%PID_FILE%") do (
    tasklist /FI "PID eq %%P" 2>nul | findstr /R /C:"%%P" >nul
    if not errorlevel 1 set "DS_RUNNING=1"
  )
)
if "%DS_RUNNING%"=="1" goto :eof
rem Fallback: any electron.exe of THIS project is running.
for /f %%P in ('call "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" our-electron-ids "%DSH_ROOT%"') do set "DS_RUNNING=1"
goto :eof

rem -------- snapshot pids of our electron instances (for force close) --------
:snapshot_pids
if exist "%PIDS_TMP%" del /q "%PIDS_TMP%"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" our-electron-ids "%DSH_ROOT%" > "%PIDS_TMP%"
if exist "%PID_FILE%" (
  for /f "usebackq" %%P in ("%PID_FILE%") do echo %%P>> "%PIDS_TMP%"
)
goto :eof

rem -------- ask the running instance to show itself (single-instance lock) --------
:focus_once
start "" "%ELECTRON_EXE%" "%APP_DIR%"
goto :eof

rem -------- force close every DS-Harness electron process we know --------
:kill_ours
if exist "%PIDS_TMP%" (
  for /f "usebackq delims=" %%P in ("%PIDS_TMP%") do (
    taskkill /PID %%P /T /F >nul 2>&1
  )
  del /q "%PIDS_TMP%"
)
goto :eof

rem -------- wait until the monitor API answers (arg1 = seconds) --------
:wait_health
set "DS_HEALTHY=0"
for /L %%I in (1,1,%1) do (
  "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" health "%DS_UI_PORT%" >nul 2>&1
  if not errorlevel 1 (
    set "DS_HEALTHY=1"
    goto :eof
  )
  timeout /t 1 /nobreak >nul
)
goto :eof

rem -------- actual monitor port from data\state\ports.json (fallback 3300) --------
:read_ui_port
if not exist "%PORTS_FILE%" goto :eof
for /f %%Q in ('call "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" ui-port "%PORTS_FILE%"') do set "DS_UI_PORT=%%Q"
goto :eof
