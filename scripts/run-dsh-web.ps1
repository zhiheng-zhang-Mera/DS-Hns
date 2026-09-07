param(
  [switch]$NoOpen,
  [switch]$FullAccess,
  [int]$Port = 3080
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
if ($FullAccess) { $env:DSH_PERMISSION_MODE = 'danger-full-access' }
$node = (Get-Command node).Source
$dshBin = "$ROOT\app\node_modules\@deepseek-ai\dsh\lib\bin.js"
if (-not (Test-Path -LiteralPath $dshBin)) { throw 'dsh not installed. Run install.ps1 first.' }
Push-Location "$ROOT\workspace"
try {
  $args = @($dshBin, 'web', '--host', '127.0.0.1', '--port', "$Port")
  if ($NoOpen) { $args += '--no-open' }
  & $node @args
} finally {
  Pop-Location
}
