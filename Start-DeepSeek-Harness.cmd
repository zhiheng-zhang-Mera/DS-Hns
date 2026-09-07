@echo off
setlocal
rem ============================================================
rem  DeepSeek Harness 桌面客户端启动器
rem  安装根目录 = 本脚本所在目录（app 的上级），运行时在其下
rem  生成 data / cache / downloads / logs / temp / runtime。
rem ============================================================

rem ---- 安装根目录（去除结尾反斜杠）----
set "DSH_ROOT=%~dp0"
if "%DSH_ROOT:~-1%"=="\" set "DSH_ROOT=%DSH_ROOT:~0,-1%"

rem ---- 运行环境变量：用户数据 / npm 缓存 / 临时目录 ----
set "DSH_HOME=%DSH_ROOT%\data"
set "npm_config_cache=%DSH_ROOT%\cache\npm"
set "TEMP=%DSH_ROOT%\temp"
set "TMP=%DSH_ROOT%\temp"

if not exist "%DSH_HOME%" mkdir "%DSH_HOME%"
if not exist "%npm_config_cache%" mkdir "%npm_config_cache%"
if not exist "%TEMP%" mkdir "%TEMP%"
if not exist "%DSH_ROOT%\logs" mkdir "%DSH_ROOT%\logs"

rem ---- 定位 Node.js：优先 runtime\ 下自带运行时，其次系统 PATH ----
set "NODE_DIR="
for /d %%D in ("%DSH_ROOT%\runtime\node-v*") do set "NODE_DIR=%%D"
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js：请在 "%DSH_ROOT%\runtime" 下放置自带运行时，
  echo        或将 Node.js 加入系统 PATH 后重试。
  pause
  exit /b 1
)

cd /d "%DSH_ROOT%\app"

rem ---- 首次运行：按 package-lock.json 还原依赖（@deepseek-ai/dsh、Electron）----
if not exist "%DSH_ROOT%\app\node_modules\@deepseek-ai\dsh\lib\bin.js" (
  echo [首次运行] 正在安装依赖，请稍候（需要联网）...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

rem ---- 启动桌面客户端（端口 3080 已被占用时会弹窗提示）----
start "DeepSeek Harness" "%DSH_ROOT%\app\node_modules\electron\dist\electron.exe" "%DSH_ROOT%\app\desktop-main.cjs"
exit /b %ERRORLEVEL%
