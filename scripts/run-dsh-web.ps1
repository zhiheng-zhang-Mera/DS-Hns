param(
  [switch]$NoOpen,
  [switch]$FullAccess,
  [int]$Port = 3080
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
if ($FullAccess) { $env:DSH_PERMISSION_MODE = 'danger-full-access' }
$dsh = "$ROOT\app\harness\node_modules\.bin\dsh.cmd"
if (-not (Test-Path -LiteralPath $dsh)) { throw "dsh not installed. Run install.ps1 first." }
Push-Location "$ROOT\workspace"
try {
  $args = @('web', '--host', '127.0.0.1', '--port', "$Port")
  if ($NoOpen) { $args += '--no-open' }
  & $dsh @args
} finally {
  Pop-Location
}
