param([switch]$PureAlien)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
if ($PureAlien) { $env:DSH_DISABLE_MEGA = '1' }
$electron = "$ROOT\app\node_modules\electron\dist\electron.exe"
if (-not (Test-Path -LiteralPath $electron)) { throw 'Electron not installed. Run install.ps1 first.' }
$logDir = "$ROOT\logs\app"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$proc = Start-Process -FilePath $electron -ArgumentList @('.') -WorkingDirectory "$ROOT\app" -WindowStyle Hidden -RedirectStandardOutput "$logDir\electron.out.log" -RedirectStandardError "$logDir\electron.err.log" -PassThru
New-Item -ItemType Directory -Path "$ROOT\data\state" -Force | Out-Null
Set-Content -LiteralPath "$ROOT\data\state\ds-desktop.pid" -Value $proc.Id
Write-Output "DS-Harness started (PID $($proc.Id))."
Write-Output 'Primary UI: official dsh Web at 127.0.0.1:3080 inside Alien-derived Electron shell.'
if ($PureAlien) { Write-Output 'Mega extensions: DISABLED (Pure Alien regression mode).' } else { Write-Output 'Mega extensions: enabled; Ctrl+Shift+M opens the optional tools window.' }
