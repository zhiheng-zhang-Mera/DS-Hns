param(
  [switch]$Remove,
  [switch]$NoAutoStart
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$electron = "$root\app\electron\node_modules\electron\dist\electron.exe"
if (-not (Test-Path -LiteralPath $electron)) {
  throw "Electron not installed: $electron"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$startup = [Environment]::GetFolderPath('Startup')
$programs = [Environment]::GetFolderPath('Programs')
$appMenuDir = Join-Path $programs 'DeepSeek Harness'
New-Item -ItemType Directory -Path $appMenuDir -Force | Out-Null

$paths = @{
  DesktopStart  = Join-Path $desktop 'DeepSeek Harness.lnk'
  DesktopStop   = Join-Path $desktop 'Stop DeepSeek Harness.lnk'
  StartMenu     = Join-Path $appMenuDir 'DeepSeek Harness.lnk'
  Autostart     = Join-Path $startup 'DeepSeek Harness Autostart.lnk'
}

function New-Shortcut {
  param(
    [string]$Path,
    [string]$Target,
    [string]$Arguments,
    [string]$WorkingDirectory,
    [string]$Description,
    [string]$Icon,
    [int]$WindowStyle = 1
  )
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($Path)
  $sc.TargetPath = $Target
  $sc.Arguments = $Arguments
  $sc.WorkingDirectory = $WorkingDirectory
  $sc.Description = $Description
  if ($Icon) { $sc.IconLocation = $Icon }
  $sc.WindowStyle = $WindowStyle
  $sc.Save()
}

if ($Remove) {
  foreach ($key in $paths.Keys) {
    $p = $paths[$key]
    if (Test-Path -LiteralPath $p) {
      Remove-Item -LiteralPath $p -Force
      Write-Output "removed $p"
    }
  }
  if ((Get-ChildItem -LiteralPath $appMenuDir -Force -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0) {
    Remove-Item -LiteralPath $appMenuDir -Force -ErrorAction SilentlyContinue
  }
  Write-Output 'Shortcuts removed.'
  exit 0
}

# Desktop quick start (no browser is involved; Electron opens its own window).
New-Shortcut `
  -Path $paths.DesktopStart `
  -Target $electron `
  -Arguments '.' `
  -WorkingDirectory (Join-Path $root 'app\electron') `
  -Description 'DeepSeek Harness - Electron desktop app' `
  -Icon "$electron,0"
Write-Output "created $($paths.DesktopStart)"

# Desktop stop helper (short console so the user can see the result).
$ps = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
New-Shortcut `
  -Path $paths.DesktopStop `
  -Target $ps `
  -Arguments "-NoProfile -ExecutionPolicy Bypass -File `"$root\scripts\stop.ps1`"" `
  -WorkingDirectory $root `
  -Description 'Stop DeepSeek Harness and its task processes' `
  -Icon "$env:WINDIR\System32\shell32.dll,27"
Write-Output "created $($paths.DesktopStop)"

# Start menu entry.
New-Shortcut `
  -Path $paths.StartMenu `
  -Target $electron `
  -Arguments '.' `
  -WorkingDirectory (Join-Path $root 'app\electron') `
  -Description 'DeepSeek Harness - Electron desktop app' `
  -Icon "$electron,0"
Write-Output "created $($paths.StartMenu)"

# Windows logon autostart (hidden wrapper -> run.ps1 -> Electron).
if (-not $NoAutoStart) {
  New-Shortcut `
    -Path $paths.Autostart `
    -Target $ps `
    -Arguments "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\scripts\autostart-electron.ps1`"" `
    -WorkingDirectory $root `
    -Description 'Start DeepSeek Harness automatically at Windows logon' `
    -Icon "$electron,0" `
    -WindowStyle 7
  Write-Output "created $($paths.Autostart) (logon autostart enabled)"
} else {
  Write-Output 'Autostart skipped (-NoAutoStart).'
}

Write-Output ''
Write-Output 'Quick launch is ready. Start now with:'
Write-Output "powershell -ExecutionPolicy Bypass -File $root\scripts\run.ps1"
