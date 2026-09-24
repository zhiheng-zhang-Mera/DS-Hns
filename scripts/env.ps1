# DS-Harness shared environment initializer.
# Windows PowerShell 5.1 compatible and ASCII-only.
$ErrorActionPreference = 'Stop'
$script:ROOT = Split-Path -Parent $PSScriptRoot
$script:envLoaded = $true
$script:taskRoot = Split-Path -Parent $ROOT
$script:commandTemp = if ($env:DSH_TEMP_ROOT) {
  [System.IO.Path]::GetFullPath([string]$env:DSH_TEMP_ROOT)
} else {
  Join-Path $script:taskRoot 'temp'
}
$script:runtimeRoot = if ($env:DSH_RUNTIME_ROOT) { [System.IO.Path]::GetFullPath([string]$env:DSH_RUNTIME_ROOT) } else { Join-Path $script:taskRoot 'runtime-data' }
$script:testRoot = if ($env:DSH_TEST_ROOT) { [System.IO.Path]::GetFullPath([string]$env:DSH_TEST_ROOT) } else { Join-Path $script:taskRoot 'test-artifacts' }
$script:localAppData = Join-Path $script:taskRoot '.localappdata'
$script:roamingAppData = Join-Path $script:taskRoot '.appdata'

$script:requiredDirs = @(
  "$ROOT\workspace\active",
  "$ROOT\workspace\completed",
  "$ROOT\workspace\temp",
  $script:commandTemp,
  $script:runtimeRoot,
  $script:testRoot,
  $script:localAppData,
  $script:roamingAppData,
  "$ROOT\cache\npm",
  "$ROOT\cache\electron",
  "$ROOT\cache\downloads",
  "$ROOT\logs\app",
  "$ROOT\logs\harness",
  "$ROOT\data\sessions",
  "$ROOT\data\sounds",
  "$ROOT\data\state",
  "$ROOT\data\task-history",
  "$ROOT\data\pricing",
  "$ROOT\runtime",
  "$ROOT\config"
)
foreach ($dir in $script:requiredDirs) {
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
}

$probe = Join-Path $script:commandTemp ("write-probe-{0}.tmp" -f ([guid]::NewGuid().ToString('N')))
try {
  Set-Content -LiteralPath $probe -Value 'probe' -Encoding ascii
  Remove-Item -LiteralPath $probe -Force
} catch {
  Write-Error "$ROOT is not writable. Refusing to fall back to another location."
  return
}

$env:DSH_ROOT = $ROOT
$env:DSH_HOME = "$ROOT\data"
$env:DSH_TEMP_ROOT = $script:commandTemp
$env:DSH_RUNTIME_ROOT = $script:runtimeRoot
$env:DSH_TEST_ROOT = $script:testRoot
$env:TEMP = $script:commandTemp
$env:TMP = $script:commandTemp
$env:LOCALAPPDATA = $script:localAppData
$env:APPDATA = $script:roamingAppData
$env:PIP_CACHE_DIR = "$ROOT\cache\pip"
$env:npm_config_cache = "$ROOT\cache\npm"
$env:ELECTRON_CACHE = "$ROOT\cache\electron"
$env:pnpm_config_store_dir = "$ROOT\cache\pnpm"
$env:HF_HOME = "$ROOT\cache\huggingface"
$env:HUGGINGFACE_HUB_CACHE = "$ROOT\cache\huggingface\hub"
$env:TRANSFORMERS_CACHE = "$ROOT\cache\huggingface\transformers"
$env:DEEPSEEK_HARNESS_WORKSPACE = "$ROOT\workspace"
$env:DEEPSEEK_HARNESS_LOG_DIR = "$ROOT\logs"

if (-not $env:DSH_TELEMETRY_MODE) {
  $env:DSH_TELEMETRY_MODE = 'DISABLED'
}
if (-not $env:DSH_PERMISSION_MODE) {
  $env:DSH_PERMISSION_MODE = 'workspace-write'
}

# Compatibility alias: some existing machines use DeepSeek_API. Keep the
# system variable untouched and map it only into this process for official DSH.
if (-not $env:DEEPSEEK_API_KEY) {
  $legacyApi = $env:DeepSeek_API
  if (-not $legacyApi) {
    $legacyApi = [Environment]::GetEnvironmentVariable('DeepSeek_API', 'User')
  }
  if (-not $legacyApi) {
    $legacyApi = [Environment]::GetEnvironmentVariable('DeepSeek_API', 'Machine')
  }
  if ($legacyApi) {
    $env:DEEPSEEK_API_KEY = [string]$legacyApi
  }
}

# Optional secret layer. Existing process/user/machine environment wins.
$envFile = "$ROOT\config\.env"
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
    $trimmed = $line.Trim()
    if ($trimmed -and (-not $trimmed.StartsWith('#')) -and $trimmed.Contains('=')) {
      $eq = $trimmed.IndexOf('=')
      $key = $trimmed.Substring(0, $eq).Trim()
      $value = $trimmed.Substring($eq + 1).Trim()
      if (-not [System.Environment]::GetEnvironmentVariable($key)) {
        [System.Environment]::SetEnvironmentVariable($key, $value, 'Process')
      }
    }
  }
}
