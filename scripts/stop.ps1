$ROOT = Split-Path -Parent $PSScriptRoot
$stateDir = "$ROOT\data\state"
foreach ($name in @('ds-desktop', 'monitor', 'dsh-web')) {
  $pidFile = Join-Path $stateDir "$name.pid"
  if (Test-Path -LiteralPath $pidFile) {
    $pidValue = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pidValue) {
      $proc = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
      if ($proc) {
        # dsh-web is a wrapper process; stop its child process tree too.
        & "$env:WINDIR\System32\taskkill.exe" /PID ([int]$pidValue) /T /F 2>$null | Out-Null
        Write-Output "stopped $name (PID $pidValue)"
      } else {
        Write-Output "$name not running"
      }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
}
# Safety net: kill only processes whose command line belongs to this project.
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -like "*$ROOT\app\node_modules\@deepseek-ai\dsh\lib\bin.js*" -or
    $_.CommandLine -like "*$ROOT\app\monitor\ui\server.js*" -or
    $_.CommandLine -like "*$ROOT\app\desktop-main.cjs*"
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "stopped leftover project process (PID $($_.ProcessId))"
  }
Write-Output 'All local DS-Harness processes stopped.'
