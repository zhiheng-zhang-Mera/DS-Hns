# DS-Harness stale-runtime cleanup.
# Stops only processes that can be proven to belong to THIS repository root.
# Windows PowerShell 5.1 compatible and ASCII-only.
param([switch]$AllowForeignPort)
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$taskkill = Join-Path $env:WINDIR 'System32\taskkill.exe'
$dshEntry = [System.IO.Path]::GetFullPath((Join-Path $ROOT 'app\node_modules\@deepseek-ai\dsh\lib\bin.js'))
$electronExe = [System.IO.Path]::GetFullPath((Join-Path $ROOT 'app\node_modules\electron\dist\electron.exe'))
$ownershipFile = Join-Path $ROOT 'runtime\dsh-process.json'

function Same-Path([string]$left, [string]$right) {
  if (-not $left -or -not $right) { return $false }
  try {
    $a = [System.IO.Path]::GetFullPath($left).TrimEnd('\')
    $b = [System.IO.Path]::GetFullPath($right).TrimEnd('\')
    return [string]::Equals($a, $b, [System.StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Stop-ProcessTree([int]$ProcessId, [string]$Reason) {
  if ($ProcessId -le 0) { return }
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) { return }
  Write-Host "  Stop PID $ProcessId ($Reason)"
  & $taskkill /PID $ProcessId /T /F 2>$null | Out-Null
  Start-Sleep -Milliseconds 150
}

Write-Host '[cleanup] Checking stale DS-Harness processes for this repository...'

# First stop Electron instances whose executable itself belongs to this checkout.
$processRows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
foreach ($row in $processRows) {
  if (($row.Name -ieq 'electron.exe') -and $row.ExecutablePath -and (Same-Path $row.ExecutablePath $electronExe)) {
    Stop-ProcessTree ([int]$row.ProcessId) 'repository Electron shell'
  }
}

# Then stop orphaned DSH Node processes that explicitly reference THIS dsh entry.
$processRows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
foreach ($row in $processRows) {
  if (($row.Name -ieq 'node.exe') -and $row.CommandLine) {
    $belongsHere = $row.CommandLine.IndexOf($dshEntry, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    $isWeb = $row.CommandLine -match '(?i)(^|\s)web(\s|$)'
    if ($belongsHere -and $isWeb) {
      Stop-ProcessTree ([int]$row.ProcessId) 'repository DSH web process'
    }
  }
}

if (Test-Path -LiteralPath $ownershipFile) {
  Remove-Item -LiteralPath $ownershipFile -Force -ErrorAction SilentlyContinue
  Write-Host '  Removed stale runtime ownership file.'
}

Start-Sleep -Milliseconds 250
$listener = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $ownerPid = [int]$listener.OwningProcess
  $row = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
  $name = if ($row -and $row.Name) { [string]$row.Name } else { 'unknown' }
  $command = if ($row -and $row.CommandLine) { [string]$row.CommandLine } else { '' }
  $detail = "Port 3080 is still occupied by an unrelated process: PID $ownerPid ($name)."
  if ($command) { $detail = "$detail CommandLine: $command" }
  if ($AllowForeignPort) {
    Write-Warning $detail
  } else {
    throw $detail
  }
} else {
  Write-Host '  Port 3080 is free.'
}

Write-Host '[cleanup] Runtime cleanup complete.'
