param(
  [Parameter(Mandatory = $true)][string]$Prompt,
  [string]$TaskId = ("task-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss')),
  [switch]$FullAccess,
  [switch]$NoLog
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'env.ps1')
$taskDir = "$ROOT\workspace\active\$TaskId"
New-Item -ItemType Directory -Path $taskDir -Force | Out-Null
if ($FullAccess) { $env:DSH_PERMISSION_MODE = 'danger-full-access' }
$node = (Get-Command node).Source
$dshBin = "$ROOT\app\node_modules\@deepseek-ai\dsh\lib\bin.js"
$logFile = "$ROOT\logs\harness\$TaskId.log"
Write-Output "Task dir : $taskDir"
Write-Output "Log file : $logFile"
Push-Location $taskDir
try {
  & $node $dshBin --profile headless $Prompt 2>&1 | Tee-Object -FilePath $logFile
  $code = $LASTEXITCODE
  Write-Output "Exit code: $code"
  exit $code
} finally {
  Pop-Location
}
