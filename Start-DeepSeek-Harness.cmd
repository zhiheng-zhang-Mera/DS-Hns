@echo off
setlocal EnableExtensions
rem ============================================================
rem  DS-Harness launcher (DeepSeek Harness Desktop)
rem  Main window = official dsh Web; 视图 menu switches to the
rem  调度中心 (chat / monitor / settings).
rem
rem  Added logic:
rem    1. If DS-Harness is already running -> bring up / focus its window.
rem    2. If bringing it up fails (unhealthy / no response) -> force close
rem       the running instance and start a fresh one.
rem ============================================================
set "DSH_ROOT=%~dp0"
if "%DSH_ROOT:~-1%"=="\" set "DSH_ROOT=%DSH_ROOT:~0,-1%"
set "APP_DIR=%DSH_ROOT%\app"
set "HELPER=%DSH_ROOT%\scripts\launcher-helper.ps1"
set "ELECTRON_EXE=%APP_DIR%\node_modules\electron\dist\electron.exe"
set "PID_FILE=%DSH_ROOT%\data\state\ds-desktop.pid"
set "PORTS_FILE=%DSH_ROOT%\data\state\ports.json"
set "PIDS_TMP=%DSH_ROOT%\data\state\launcher-pids.tmp"
set "DS_RUNNING=0"
set "DS_HEALTHY=0"
set "DS_UI_PORT=3300"

rem ---- bundled Node runtime first (runtime\node-v*-win-x64) ----
set "NODE_DIR="
for /d %%D in ("%DSH_ROOT%\runtime\node-v*") do set "NODE_DIR=%%D"
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo [error] Node.js not found. Put a runtime under "%DSH_ROOT%\runtime" or add node to PATH.
  pause
  exit /b 1
)
where powershell >nul 2>nul
if errorlevel 1 (
  echo [error] PowerShell not found.
  pause
  exit /b 1
)

rem ---- first run: restore dependencies (dsh core + Electron) ----
if not exist "%APP_DIR%\node_modules\@deepseek-ai\dsh\lib\bin.js" (
  pushd "%APP_DIR%"
  echo [first run] installing dependencies via npm ci, please wait...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo [error] dependency install failed. Check network and retry.
    popd
    pause
    exit /b 1
  )
  popd
)
if not exist "%ELECTRON_EXE%" (
  echo [error] Electron binary missing: "%ELECTRON_EXE%"
  pause
  exit /b 1
)

call :read_ui_port

rem ---- is DS-Harness already running? ----
call :detect_running
if "%DS_RUNNING%"=="1" goto :focus_existing
goto :fresh_start

rem ============================================================
:fresh_start
echo [start] launching DS-Harness...
powershell -NoProfile -ExecutionPolicy Bypass -File "%DSH_ROOT%\scripts\run.ps1"
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
for /f %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" our-electron-ids "%DSH_ROOT%"') do set "DS_RUNNING=1"
goto :eof

rem -------- snapshot pids of our electron instances (for force close) --------
:snapshot_pids
if exist "%PIDS_TMP%" del /q "%PIDS_TMP%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" our-electron-ids "%DSH_ROOT%" > "%PIDS_TMP%"
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
  powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" health "%DS_UI_PORT%" >nul 2>&1
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
for /f %%Q in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" ui-port "%PORTS_FILE%"') do set "DS_UI_PORT=%%Q"
goto :eof
