@echo off
setlocal
chcp 65001 >nul 2>nul
title DS-Harness One-Click Installer
cd /d "%~dp0"

echo ============================================================
echo  DS-Harness One-Click Installer
echo  Reuses compatible local dependencies and cached downloads.
echo ============================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [ERROR] Installation failed with exit code %RC%.
  echo Review the messages above, then run this installer again.
  pause
  exit /b %RC%
)

echo.
echo Installation completed successfully. DS-Harness is launching.
timeout /t 2 /nobreak >nul
exit /b 0
