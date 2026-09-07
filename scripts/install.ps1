param(
  [switch]$NoLaunch,
  [switch]$NoShortcuts,
  [switch]$SkipTests,
  [ValidateSet('Prompt', 'Configure', 'Later')]
  [string]$ApiKeyMode = 'Prompt'
)
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$text) {
  Write-Host ''
  Write-Host "== $text ==" -ForegroundColor Cyan
}

function Test-RealApiKey([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $false }
  $v = $value.Trim()
  return ($v -ne 'sk-...') -and ($v -ne 'YOUR_API_KEY') -and ($v -ne 'YOUR_DEEPSEEK_API_KEY')
}

function Get-DotEnvValue([string]$file, [string]$key) {
  if (-not (Test-Path -LiteralPath $file)) { return '' }
  $pattern = '^\s*' + [regex]::Escape($key) + '\s*='
  foreach ($line in [System.IO.File]::ReadAllLines($file)) {
    if ($line -match $pattern) {
      $value = $line.Substring($line.IndexOf('=') + 1).Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      return $value
    }
  }
  return ''
}

function Set-DotEnvValue([string]$file, [string]$key, [string]$value) {
  $dir = Split-Path -Parent $file
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $lines = if (Test-Path -LiteralPath $file) { @([System.IO.File]::ReadAllLines($file)) } else { @() }
  $pattern = '^\s*' + [regex]::Escape($key) + '\s*='
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match $pattern) {
      $lines[$i] = "$key=$value"
      $found = $true
      break
    }
  }
  if (-not $found) { $lines += "$key=$value" }
  [System.IO.File]::WriteAllLines($file, $lines, (New-Object System.Text.UTF8Encoding($false)))
}

function Ensure-ProjectEnvFile([string]$envFile) {
  if (Test-Path -LiteralPath $envFile) { return }
  $template = Join-Path $ROOT 'config\.env.example'
  if (Test-Path -LiteralPath $template) {
    Copy-Item -LiteralPath $template -Destination $envFile
  } else {
    [System.IO.File]::WriteAllText(
      $envFile,
      "DEEPSEEK_API_KEY=`r`nDSH_TELEMETRY_MODE=DISABLED`r`nDSH_PERMISSION_MODE=workspace-write`r`n",
      (New-Object System.Text.UTF8Encoding($false))
    )
  }
}

function Get-SystemApiKey {
  $candidates = @(
    @{ Scope = 'Process/inherited'; Value = $env:DEEPSEEK_API_KEY },
    @{ Scope = 'User'; Value = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User') },
    @{ Scope = 'Machine'; Value = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'Machine') }
  )
  foreach ($item in $candidates) {
    if (Test-RealApiKey ([string]$item.Value)) { return $item }
  }
  return $null
}

function Read-ApiKeySecurely {
  $secure = Read-Host '请输入 DEEPSEEK_API_KEY（输入内容不会显示）' -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

Write-Host 'DS-Harness one-click installer' -ForegroundColor Green
Write-Host "Root: $ROOT"

Write-Step '1/7 Bootstrap directories'
$dirs = @(
  'app', 'config', 'assets\sounds', 'runtime', 'workspace\active', 'workspace\completed', 'workspace\temp',
  'cache\pip', 'cache\npm', 'cache\electron', 'cache\pnpm', 'cache\downloads', 'cache\build', 'cache\temp',
  'cache\huggingface', 'cache\models', 'data\sessions', 'data\sounds', 'data\state', 'data\task-history',
  'data\usage', 'data\pricing', 'logs\app', 'logs\harness'
)
foreach ($d in $dirs) { New-Item -ItemType Directory -Path (Join-Path $ROOT $d) -Force | Out-Null }
Write-Host 'Directory structure ready.'

Write-Step '2/7 Resolve/reuse dependencies'
& (Join-Path $PSScriptRoot 'install-deps.ps1') -Full
if ($LASTEXITCODE -ne 0) { throw 'dependency installation failed' }

Write-Step '3/7 Resolve DeepSeek API key'
$envFile = Join-Path $ROOT 'config\.env'
Ensure-ProjectEnvFile $envFile
$systemKey = Get-SystemApiKey
$projectKey = Get-DotEnvValue $envFile 'DEEPSEEK_API_KEY'

if ($systemKey) {
  $env:DEEPSEEK_API_KEY = [string]$systemKey.Value
  Write-Host "Found DEEPSEEK_API_KEY in $($systemKey.Scope) environment. Reusing it; no key is copied or logged."
} elseif (Test-RealApiKey $projectKey) {
  $env:DEEPSEEK_API_KEY = $projectKey
  Write-Host 'No system API key found; existing project config\.env key will be reused.'
} else {
  $choice = $ApiKeyMode
  if ($choice -eq 'Prompt') {
    Write-Host 'No DEEPSEEK_API_KEY was found in Process/User/Machine environment variables.' -ForegroundColor Yellow
    Write-Host '  [1] Configure now (stored only in this project: config\.env)'
    Write-Host '  [2] Configure later in DS-Harness settings (Ctrl+Shift+M -> Harness / 提醒)'
    do { $rawChoice = (Read-Host 'Choose 1 or 2').Trim() } while ($rawChoice -notin @('1', '2'))
    $choice = if ($rawChoice -eq '1') { 'Configure' } else { 'Later' }
  }

  if ($choice -eq 'Configure') {
    $plainKey = Read-ApiKeySecurely
    if (Test-RealApiKey $plainKey) {
      Set-DotEnvValue $envFile 'DEEPSEEK_API_KEY' $plainKey
      $env:DEEPSEEK_API_KEY = $plainKey
      $plainKey = ''
      Write-Host 'API key saved to project config\.env. It was not printed to the console.'
    } else {
      Write-Host 'No valid key entered. Installation will continue without an API key.' -ForegroundColor Yellow
      Set-DotEnvValue $envFile 'DEEPSEEK_API_KEY' ''
    }
  } else {
    Set-DotEnvValue $envFile 'DEEPSEEK_API_KEY' ''
    Write-Host 'API key deferred. You can configure it later from Mega Extensions settings.'
  }
}

# Restore the canonical project runtime environment after install-time cache reuse.
. (Join-Path $PSScriptRoot 'env.ps1')

Write-Step '4/7 Unit and architecture tests'
if ($SkipTests) {
  Write-Host 'Tests skipped by -SkipTests.'
} else {
  & (Join-Path $PSScriptRoot 'test-all.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'unit/architecture tests failed' }
}

Write-Step '5/7 Verification'
& (Join-Path $PSScriptRoot 'verify.ps1') -SkipTests
if ($LASTEXITCODE -ne 0) { throw 'verification failed' }

Write-Step '6/7 Shortcuts'
if ($NoShortcuts) {
  Write-Host 'Shortcut creation skipped by -NoShortcuts.'
} else {
  try {
    & (Join-Path $PSScriptRoot 'shortcuts.ps1') -NoAutoStart
    Write-Host 'Desktop and Start Menu shortcuts are ready. Autostart was not enabled.'
  } catch {
    Write-Warning "Shortcut creation failed, but installation is otherwise usable: $($_.Exception.Message)"
  }
}

Write-Step '7/7 Complete'
Write-Host 'DS-Harness installation is complete.' -ForegroundColor Green
if ($systemKey) {
  Write-Host "API: system environment ($($systemKey.Scope))"
} elseif ($env:DEEPSEEK_API_KEY) {
  Write-Host 'API: project configuration'
} else {
  Write-Host 'API: not configured yet (configure later with Ctrl+Shift+M).'
}
Write-Host 'Primary UI: official DeepSeek Harness (Alien-derived shell).'
Write-Host 'Mega tools: Ctrl+Shift+M.'
Write-Host 'Pure Alien diagnostic mode: scripts\run.ps1 -PureAlien.'

if (-not $NoLaunch) {
  Write-Host 'Launching DS-Harness...'
  Start-Process -FilePath (Join-Path $ROOT 'Start-DeepSeek-Harness.cmd') -WorkingDirectory $ROOT
} else {
  Write-Host 'Launch skipped by -NoLaunch.'
}
