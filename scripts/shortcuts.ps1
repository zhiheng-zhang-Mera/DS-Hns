param(
  [switch]$Remove,
  [switch]$NoAutoStart
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
# Single canonical boot path for every quick-launch entrance (desktop shortcut,
# Start Menu entry, logon autostart, scripts\run.ps1 and
# Start-DeepSeek-Harness.cmd all resolve to this one entry point).
$electron = "$root\app\node_modules\electron\dist\electron.exe"
$entry = "$root\app\desktop-main.cjs"
$appDir = "$root\app"
if (-not (Test-Path -LiteralPath $electron)) {
  throw "Electron not installed: $electron (run Install-DS-Harness.cmd first)"
}
if (-not (Test-Path -LiteralPath $entry)) {
  throw "Harness entry point missing: $entry"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$startup = [Environment]::GetFolderPath('Startup')
$programs = [Environment]::GetFolderPath('Programs')
$appMenuDir = Join-Path $programs 'DS-Harness'
New-Item -ItemType Directory -Path $appMenuDir -Force | Out-Null

$paths = @{
  DesktopStart  = Join-Path $desktop 'DS-Harness.lnk'
  DesktopStop   = Join-Path $desktop 'Stop DS-Harness.lnk'
  StartMenu     = Join-Path $appMenuDir 'DS-Harness.lnk'
  Autostart     = Join-Path $startup 'DS-Harness Autostart.lnk'
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
  # Refresh from scratch: an existing .lnk keeps its previous icon/target
  # otherwise, which could leave a stale icon path from an older installation.
  if (Test-Path -LiteralPath $Path) {
    try {
      Remove-Item -LiteralPath $Path -Force
    } catch {
      Write-Warning "could not refresh existing shortcut $Path : $($_.Exception.Message)"
    }
  }
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($Path)
  $sc.TargetPath = $Target
  $sc.Arguments = $Arguments
  $sc.WorkingDirectory = $WorkingDirectory
  $sc.Description = $Description
  # Only set an icon when a generated icon exists; WScript rejects an empty
  # IconLocation, and a fresh shortcut has a valid default without one.
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

# Launcher icon: generated from the repository-root icon.jpg. A missing or
# unreadable icon may only degrade to a launcher without a custom icon - it must
# never prevent the shortcut from being created.
$appIcon = ''
try {
  $iconScript = Join-Path $PSScriptRoot 'ensure-icon.ps1'
  if (Test-Path -LiteralPath $iconScript) {
    $resolved = & $iconScript
    $candidate = [string]($resolved | Select-Object -Last 1)
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { $appIcon = $candidate }
  }
} catch {
  Write-Warning "icon resolution failed: $($_.Exception.Message)"
}
if (-not $appIcon) {
  Write-Warning 'No launcher icon available from icon.jpg; creating shortcuts with the default icon.'
}

# Desktop quick start (no browser is involved; Electron opens its own window).
New-Shortcut `
  -Path $paths.DesktopStart `
  -Target $electron `
  -Arguments "`"$entry`"" `
  -WorkingDirectory $appDir `
  -Description 'DS-Harness - DeepSeek Harness desktop' `
  -Icon $appIcon
Write-Output "created $($paths.DesktopStart)"

# 按需求不创建 Stop 快捷方式(关闭窗口即自动退出)。

# Start menu entry.
New-Shortcut `
  -Path $paths.StartMenu `
  -Target $electron `
  -Arguments "`"$entry`"" `
  -WorkingDirectory $appDir `
  -Description 'DS-Harness - DeepSeek Harness desktop' `
  -Icon $appIcon
Write-Output "created $($paths.StartMenu)"

# Windows logon autostart (hidden wrapper -> run.ps1 -> the same entry point).
$ps = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not $NoAutoStart) {
  New-Shortcut `
    -Path $paths.Autostart `
    -Target $ps `
    -Arguments "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\scripts\autostart-electron.ps1`"" `
    -WorkingDirectory $root `
    -Description 'Start DeepSeek Harness automatically at Windows logon' `
    -Icon $appIcon `
    -WindowStyle 7
  Write-Output "created $($paths.Autostart) (logon autostart enabled)"
} else {
  Write-Output 'Autostart skipped (-NoAutoStart).'
}

Write-Output ''
Write-Output 'Quick launch is ready. Start now with:'
Write-Output "powershell -ExecutionPolicy Bypass -File $root\scripts\run.ps1"
