# Small probes used by Start-DeepSeek-Harness.cmd (keeping tricky quoting out
# of batch). Actions:
#   our-electron-ids <rootPath>  -> prints PIDs of electron.exe under rootPath
#   health <port>                -> exit 0 when http://127.0.0.1:<port>/api/health answers 200
#   ui-port <portsJsonPath>      -> prints the ui port stored in data\state\ports.json
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Arg
)
$ErrorActionPreference = 'SilentlyContinue'
switch ($Action) {
  'our-electron-ids' {
    Get-Process -Name electron -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -like ($Arg.TrimEnd('\') + '*') } |
      ForEach-Object { $_.Id }
    exit 0
  }
  'health' {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:" + $Arg + "/api/health") -TimeoutSec 2
      if ($r.StatusCode -eq 200) { exit 0 }
    } catch {
      # fall through to exit 1
    }
    exit 1
  }
  'ui-port' {
    try {
      (Get-Content -LiteralPath $Arg -Raw | ConvertFrom-Json).ui
    } catch {
      # nothing
    }
    exit 0
  }
  default {
    exit 2
  }
}
