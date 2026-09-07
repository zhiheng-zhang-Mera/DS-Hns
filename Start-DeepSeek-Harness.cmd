@echo off
setlocal
rem ============================================================
rem  DS-Harness 启动器 (DeepSeek Harness Desktop)
rem  主界面 = 官方 dsh Web;视图菜单可切换 调度中心(聊天/监控/设置)
rem ============================================================
set "DSH_ROOT=%~dp0"
if "%DSH_ROOT:~-1%"=="\" set "DSH_ROOT=%DSH_ROOT:~0,-1%"

rem ---- 自带 Node 运行时优先(runtime\node-v*-win-x64)----
set "NODE_DIR="
for /d %%D in ("%DSH_ROOT%\runtime\node-v*") do set "NODE_DIR=%%D"
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js:请在 "%DSH_ROOT%\runtime" 下放置自带运行时,或将 Node.js 加入系统 PATH。
  pause
  exit /b 1
)

rem ---- 首次运行:还原依赖(dsh core + Electron)----
if not exist "%DSH_ROOT%\app\node_modules\@deepseek-ai\dsh\lib\bin.js" (
  pushd "%DSH_ROOT%\app"
  echo [首次运行] 正在安装依赖(npm ci),请稍候(需要联网)...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败,请检查网络后重试。
    popd
    pause
    exit /b 1
  )
  popd
)

rem ---- 启动(脚本自动建目录、拉起 Electron 与调度中心服务)----
powershell -NoProfile -ExecutionPolicy Bypass -File "%DSH_ROOT%\scripts\run.ps1" %*
exit /b %ERRORLEVEL%
