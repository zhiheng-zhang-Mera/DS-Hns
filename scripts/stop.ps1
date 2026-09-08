# DS-Harness stop helper.
# Uses the same repository-owned cleanup rules as the installer.
# Windows PowerShell 5.1 compatible and ASCII-only.
$ErrorActionPreference = 'Stop'
$cleanup = Join-Path $PSScriptRoot 'cleanup-runtime.ps1'
if (-not (Test-Path -LiteralPath $cleanup)) {
  throw "Missing cleanup helper: $cleanup"
}
& $cleanup -AllowForeignPort
Write-Output 'All DS-Harness processes owned by this repository are stopped.'
