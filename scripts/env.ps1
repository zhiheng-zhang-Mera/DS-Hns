# Shared DeepSeek Harness environment initializer (dot-source from run.ps1 etc.)
# ROOT = the repository root (parent of the scripts\ folder), wherever it is cloned.
$script:ROOT = Split-Path -Parent $PSScriptRoot
$script:envLoaded = $true

$script:requiredDirs = @(
  "$ROOT\workspace",
  "$ROOT\cache\temp",
  "$ROOT\cache\downloads",
  "$ROOT\logs",
  "$ROOT\data\dsh\sessions",
  "$ROOT\runtime\dsh",
  "$ROOT\config"
)

foreach ($dir in $requiredDirs) {
  if (-not (Test-Path -LiteralPath $dir)) {
    Write-Error "$ROOT is not complete: missing $dir"
    return
  }
}

# Write test: make sure $ROOT is actually writable (never fall back to C:).
$probe = Join-Path (Join-Path $ROOT 'cache\temp') ("write-probe-{0}.tmp" -f ([guid]::NewGuid().ToString('N')))
try {
  Set-Content -LiteralPath $probe -Value 'probe' -Encoding ascii
  Remove-Item -LiteralPath $probe -Force
} catch {
  Write-Error "$ROOT is not writable. Refusing to fall back to C:."
  return
}

# Core cache / locale redirection for every Harness child process.
$env:DSH_HOME = "$ROOT\runtime\dsh"
$env:TEMP = "$ROOT\cache\temp"
$env:TMP = "$ROOT\cache\temp"
$env:PIP_CACHE_DIR = "$ROOT\cache\pip"
$env:npm_config_cache = "$ROOT\cache\npm"
$env:pnpm_config_store_dir = "$ROOT\cache\pnpm"
$env:HF_HOME = "$ROOT\cache\huggingface"
$env:HUGGINGFACE_HUB_CACHE = "$ROOT\cache\huggingface\hub"
$env:TRANSFORMERS_CACHE = "$ROOT\cache\huggingface\transformers"
$env:DEEPSEEK_HARNESS_WORKSPACE = "$ROOT\workspace"
$env:DEEPSEEK_HARNESS_LOG_DIR = "$ROOT\logs"

if (-not $env:DSH_TELEMETRY_MODE) { $env:DSH_TELEMETRY_MODE = 'DISABLED' }
if (-not $env:DSH_PERMISSION_MODE) { $env:DSH_PERMISSION_MODE = 'workspace-write' }

# Optional secret layer: config\.env. Explicit caller environment wins.
$envFile = "$ROOT\config\.env"
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
    $trimmed = $line.Trim()
    if ($trimmed -and -not $trimmed.StartsWith('#') -and $trimmed.Contains('=')) {
      $eq = $trimmed.IndexOf('=')
      $key = $trimmed.Substring(0, $eq).Trim()
      $value = $trimmed.Substring($eq + 1).Trim()
      if (-not [System.Environment]::GetEnvironmentVariable($key)) {
        [System.Environment]::SetEnvironmentVariable($key, $value, 'Process')
      }
    }
  }
}
