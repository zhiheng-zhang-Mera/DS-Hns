# Ensures assets\icon\ds-harness.ico is the generated artifact of the
# repository-root icon.jpg.
#
#   icon.jpg                        source asset (single source of truth)
#     -> assets\icon\ds-harness.ico generated artifact / cache
#
# The .ico is never maintained by hand: this script regenerates it whenever
# icon.jpg is newer (or when -Force is used), and every launcher/Electron/
# tray/notification icon reads the generated file.
#
# Printed output: the icon path on success.
# Exit code: 0 with an icon path, 1 when no icon can be produced. Callers must
# degrade to a launcher without a custom icon, never to a missing launcher.
param([switch]$Force)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'icon.jpg'
$iconDir = Join-Path $root 'assets\icon'
$ico = Join-Path $iconDir 'ds-harness.ico'
$generator = Join-Path $root 'assets\icon\generate-icon.ps1'

function Test-IconUsable {
  if (-not (Test-Path -LiteralPath $ico)) { return $false }
  if (-not (Test-Path -LiteralPath $source)) { return $true }
  $src = (Get-Item -LiteralPath $source).LastWriteTimeUtc
  $dst = (Get-Item -LiteralPath $ico).LastWriteTimeUtc
  return ($dst -ge $src)
}

if ((-not $Force) -and (Test-IconUsable)) {
  Write-Output $ico
  exit 0
}

if ((Test-Path -LiteralPath $generator) -and (Test-Path -LiteralPath $source)) {
  New-Item -ItemType Directory -Path $iconDir -Force | Out-Null
  # The generator is Windows PowerShell 5.1 compatible and ASCII-only, so it is
  # invoked in its own 5.1 host to stay independent of the caller's edition.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $generator > $null 2>&1
  } catch {
    Write-Warning "icon generation failed: $($_.Exception.Message)"
  } finally {
    $ErrorActionPreference = $previous
  }
}

if (Test-Path -LiteralPath $ico) {
  Write-Output $ico
  exit 0
}

Write-Warning "no launcher icon available (source: $source)"
exit 1
