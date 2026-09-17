# DS-Harness: uninstall -- remove the supervisor's runtime footprint, then say honestly what remains.
#
# What this script owns, and what it deliberately does not:
#
#   * **It removes the Harness-profile entries for the built-in plugins** through the same channel
#     that installed them (`install-bundled-plugins.ps1 -Uninstall` -> the Harness' own CLI). Asking
#     our own store to remove a profile plugin would remove nothing and report success.
#   * **It stops the restart supervisor's companion** and verifies it is gone. The companion owns the
#     application process, so leaving it running would be an orphan process holding a pid file and a
#     restart budget -- exactly the leftover the requirement forbids.
#   * **It clears the supervisor's own state directory** (pid file, stop file, lock, budget journal).
#     Those are this product's files and nothing else reads them.
#   * **It removes the Desktop and Start Menu shortcuts** it can find, and reports the ones it cannot.
#   * **It does NOT delete the repository, `data\`, or the user's configuration.** A user's sessions,
#     skills, API key and settings are theirs; an uninstaller that deleted them would be destroying
#     data it did not create. `-PurgeData` is the explicit opt-in for that, and it says what it will
#     delete before it does.
#
# Exit code: 0 when nothing the script owns is left behind, 1 when something could not be removed.
param(
  [switch]$PurgeData,
  [switch]$KeepShortcuts,
  [switch]$Json,
  [string]$DshHome = ''
)
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$dshHomePath = if ($DshHome) { $DshHome } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $ROOT 'data' }
$stateDir = Join-Path $dshHomePath 'state\restart-supervisor'

$steps = @()
$failures = 0
function Step([string]$id, [bool]$ok, [string]$detail = '') {
  $script:steps += @{ id = $id; ok = $ok; detail = $detail }
  if (-not $ok) { $script:failures++ }
  $colour = if ($ok) { 'Green' } else { 'Yellow' }
  Write-Host ("  {0} {1}" -f $id.PadRight(34), $(if ($ok) { 'OK' } else { "FAILED: $detail" })) -ForegroundColor $colour
}

Write-Host 'DS-Harness uninstall'
Write-Host "  root:     $ROOT"
Write-Host "  DSH_HOME: $dshHomePath"

# ---- 1. The companion first: it owns the application process, so nothing else can be cleaned while
#         it might still be watching.
Write-Host ''
Write-Host 'Restart supervisor companion'
$companionEntry = Join-Path $ROOT 'app\plugins\restart-supervisor\companion\main.cjs'
$pidFile = Join-Path $stateDir 'companion.pid'
$companionPid = $null
if (Test-Path -LiteralPath $pidFile) {
  try {
    $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    if ($record.pid) { $companionPid = [int]$record.pid }
  } catch {
    $companionPid = $null
  }
}
if ($companionPid) {
  # Ask first, so the companion can leave the application running and then exit.
  try {
    & node $companionEntry '--stop' 2>$null | Out-Null
  } catch { }
  Start-Sleep -Milliseconds 400
  $alive = Get-Process -Id $companionPid -ErrorAction SilentlyContinue
  if ($alive) {
    # The graceful ask did not land in time: terminate the companion's own tree, and only that.
    $taskkill = Join-Path $env:WINDIR 'System32\taskkill.exe'
    & $taskkill /PID $companionPid /T /F 2>$null | Out-Null
    Start-Sleep -Milliseconds 300
  }
  $still = Get-Process -Id $companionPid -ErrorAction SilentlyContinue
  Step 'companion stopped' (-not $still) $(if ($still) { "pid $companionPid is still running" } else { '' })
} else {
  Step 'companion stopped' $true 'no companion pid file; nothing was running'
}

# ---- 2. The state files this product owns.
Write-Host ''
Write-Host 'Supervisor state'
if (Test-Path -LiteralPath $stateDir) {
  try {
    Remove-Item -LiteralPath $stateDir -Recurse -Force
    Step 'supervisor state removed' $true $stateDir
  } catch {
    Step 'supervisor state removed' $false $_.Exception.Message
  }
} else {
  Step 'supervisor state removed' $true 'no state directory'
}
$resumeIntent = Join-Path $dshHomePath 'state\governance-bridge.json'
if (Test-Path -LiteralPath $resumeIntent) {
  # A discovery file from a previous run names a port and a token that no longer exist. Removing it is
  # what stops the official page reporting a bridge that is not there.
  try {
    Remove-Item -LiteralPath $resumeIntent -Force
    Step 'stale bridge discovery removed' $true
  } catch {
    Step 'stale bridge discovery removed' $false $_.Exception.Message
  }
} else {
  Step 'stale bridge discovery removed' $true 'none present'
}

# ---- 3. The profile entries, through the channel that installed them.
Write-Host ''
Write-Host 'Built-in plugins in the Harness profile'
$uninstaller = Join-Path $PSScriptRoot 'install-bundled-plugins.ps1'
if (Test-Path -LiteralPath $uninstaller) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $uninstaller -Uninstall -DshHome $dshHomePath 2>&1 | ForEach-Object { [string]$_ })
    $exit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  foreach ($line in $lines) { if ($line.Trim()) { Write-Host "  $($line.Trim())" } }
  Step 'profile plugins removed' ($exit -eq 0) "the plugin installer exited $exit"
} else {
  Step 'profile plugins removed' $false "install-bundled-plugins.ps1 is missing"
}

# ---- 4. An explicit scan for anything the supervisor left behind: a second companion, a pid file, a
#         lock whose owner is gone. This is the check the requirement is really about -- "no orphan
#         process and no leftover startup entry" is a claim, and a claim needs a scan.
Write-Host ''
Write-Host 'Leftover scan'
$orphans = @()
foreach ($row in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
  if ($row.Name -ieq 'node.exe' -and $row.CommandLine -and $row.CommandLine -match 'restart-supervisor[\\/]companion[\\/]main\.cjs') {
    $orphans += $row.ProcessId
  }
}
Step 'no orphan companion process' ($orphans.Count -eq 0) $(if ($orphans.Count) { "pids: $($orphans -join ', ')" } else { '' })
$startupKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startupValues = @()
try {
  $item = Get-ItemProperty -Path $startupKey -ErrorAction SilentlyContinue
  if ($item) {
    foreach ($property in $item.PSObject.Properties) {
      if ($property.Name -match 'DSHns|DS-Harness|restart-supervisor') { $startupValues += $property.Name }
    }
  }
} catch { }
Step 'no supervisor startup entry' ($startupValues.Count -eq 0) $(if ($startupValues.Count) { "values: $($startupValues -join ', ')" } else { '' })
if ($startupValues.Count) {
  # Remove the ones this product added. `DSHnsRebootResume` is the legacy reboot coordinator's
  # one-shot entry; it is named here so an uninstall from a machine that ever scheduled a reboot
  # leaves nothing behind.
  foreach ($value in $startupValues) {
    try {
      Remove-ItemProperty -Path $startupKey -Name $value -Force -ErrorAction Stop
      Write-Host "  removed startup value $value"
    } catch {
      Write-Warning "  startup value $value could not be removed: $($_.Exception.Message)"
    }
  }
}

# ---- 5. Shortcuts.
Write-Host ''
Write-Host 'Shortcuts'
if ($KeepShortcuts) {
  Step 'shortcuts left in place' $true '-KeepShortcuts'
} else {
  $removed = 0
  $candidates = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DS-Harness.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek Harness.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'DS-Harness.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'DeepSeek Harness.lnk')
  )
  foreach ($shortcut in $candidates) {
    if (Test-Path -LiteralPath $shortcut) {
      try {
        Remove-Item -LiteralPath $shortcut -Force
        $removed++
      } catch {
        Write-Warning "  $shortcut could not be removed: $($_.Exception.Message)"
      }
    }
  }
  Step 'shortcuts removed' $true "$removed removed"
}

# ---- 6. The user's own data, only when they say so.
Write-Host ''
Write-Host 'User data'
if ($PurgeData) {
  Write-Host '  -PurgeData was given: sessions, skills, settings, the project config and the installed' -ForegroundColor Yellow
  Write-Host '  dependencies will be deleted. This is not reversible.' -ForegroundColor Yellow
  foreach ($target in @((Join-Path $dshHomePath 'sessions'), (Join-Path $dshHomePath 'skills'), (Join-Path $dshHomePath 'settings.yaml'), (Join-Path $ROOT 'config\.env'), (Join-Path $ROOT 'app\node_modules'))) {
    if (Test-Path -LiteralPath $target) {
      try {
        Remove-Item -LiteralPath $target -Recurse -Force
        Write-Host "  removed $target"
      } catch {
        Write-Warning "  $target could not be removed: $($_.Exception.Message)"
      }
    }
  }
  Step 'user data purged' $true ''
} else {
  Step 'user data kept' $true 'sessions, skills, settings and config\.env were left alone; pass -PurgeData to delete them'
}

$report = @{
  ok = ($failures -eq 0)
  root = $ROOT
  dshHome = $dshHomePath
  purged = [bool]$PurgeData
  at = (Get-Date).ToString('o')
  steps = $steps
}
if ($Json) { Write-Output ($report | ConvertTo-Json -Depth 6 -Compress) }

Write-Host ''
if ($failures -eq 0) {
  Write-Host 'DS-Harness was uninstalled: no supervisor process, no startup entry and no profile plugin is left behind.' -ForegroundColor Green
} else {
  Write-Warning "$failures uninstall step(s) did not complete; the detail is above."
}
exit $failures
