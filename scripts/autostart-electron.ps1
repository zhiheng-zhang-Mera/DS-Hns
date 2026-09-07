# Hidden wrapper used by the Windows logon autostart shortcut.
$ErrorActionPreference = 'Stop'
Start-Sleep -Seconds 5
$root = Split-Path -Parent $PSScriptRoot
$log = "$root\logs\app\autostart-" + (Get-Date -Format 'yyyyMMdd') + '.out.log'
$errLog = "$root\logs\app\autostart-" + (Get-Date -Format 'yyyyMMdd') + '.err.log'
New-Item -ItemType Directory -Path (Split-Path $log -Parent) -Force | Out-Null
$run = "$root\scripts\run.ps1"
$proc = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $run) `
  -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errLog -PassThru
Write-Output "autostart launcher started (PID $($proc.Id))"
