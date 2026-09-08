param(
  [switch]$NoLaunch,
  [switch]$NoShortcuts,
  [switch]$SkipTests,
  [ValidateSet('Prompt', 'Configure', 'Later')]
  [string]$ApiKeyMode = 'Prompt'
)
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$selfPowerShell = (Get-Process -Id $PID).Path
if (-not $selfPowerShell) {
  $selfPowerShell = Join-Path $PSHOME 'powershell.exe'
}

function Write-Step([string]$text) {
  Write-Host ''
  Write-Host "== $text ==" -ForegroundColor Cyan
}

function Test-RealApiKey([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $false }
  $v = $value.Trim()
  if ($v -eq 'sk-...') { return $false }
  if ($v -eq 'YOUR_API_KEY') { return $false }
  if ($v -eq 'YOUR_DEEPSEEK_API_KEY') { return $false }
  return $true
}

function Get-DotEnvValue([string]$file, [string]$key) {
  if (-not (Test-Path -LiteralPath $file)) { return '' }
  $pattern = '^\s*' + [regex]::Escape($key) + '\s*='
  foreach ($line in [System.IO.File]::ReadAllLines($file)) {
    if ($line -match $pattern) {
      $value = $line.Substring($line.IndexOf('=') + 1).Trim()
      if ($value.Length -ge 2) {
        $first = $value.Substring(0, 1)
        $last = $value.Substring($value.Length - 1, 1)
        if ((($first -eq '"') -and ($last -eq '"')) -or (($first -eq "'") -and ($last -eq "'"))) {
          $value = $value.Substring(1, $value.Length - 2)
        }
      }
      return $value
    }
  }
  return ''
}

function Set-DotEnvValue([string]$file, [string]$key, [string]$value) {
  $dir = Split-Path -Parent $file
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  if (Test-Path -LiteralPath $file) {
    $lines = @([System.IO.File]::ReadAllLines($file))
  } else {
    $lines = @()
  }
  $pattern = '^\s*' + [regex]::Escape($key) + '\s*='
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match $pattern) {
      $lines[$i] = "$key=$value"
      $found = $true
      break
    }
  }
  if (-not $found) {
    $lines += "$key=$value"
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($file, $lines, $utf8NoBom)
}

function Ensure-ProjectEnvFile([string]$envFile) {
  if (Test-Path -LiteralPath $envFile) { return }
  $template = Join-Path $ROOT 'config\.env.example'
  if (Test-Path -LiteralPath $template) {
    Copy-Item -LiteralPath $template -Destination $envFile
    return
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $content = "DEEPSEEK_API_KEY=`r`nDSH_TELEMETRY_MODE=DISABLED`r`nDSH_PERMISSION_MODE=workspace-write`r`n"
  [System.IO.File]::WriteAllText($envFile, $content, $utf8NoBom)
}

function Get-SystemApiKey {
  $candidates = @(
    @{ Scope = 'Process/inherited'; Value = $env:DEEPSEEK_API_KEY },
    @{ Scope = 'User'; Value = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User') },
    @{ Scope = 'Machine'; Value = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'Machine') }
  )
  foreach ($item in $candidates) {
    if (Test-RealApiKey ([string]$item.Value)) {
      return $item
    }
  }
  return $null
}

function Read-ApiKeySecurely {
  $secure = Read-Host 'Enter DEEPSEEK_API_KEY (input is hidden)' -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function Assert-ScriptParses([string]$scriptPath) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors -and $errors.Count -gt 0) {
    $details = ($errors | ForEach-Object { $_.Message }) -join '; '
    throw "PowerShell parser preflight failed for $scriptPath : $details"
  }
}

Write-Host 'DS-Harness one-click installer' -ForegroundColor Green
Write-Host "Root: $ROOT"

Write-Step '0/7 PowerShell parser preflight'
$criticalScripts = @(
  (Join-Path $PSScriptRoot 'cleanup-runtime.ps1'),
  (Join-Path $PSScriptRoot 'ensure-node.ps1'),
  (Join-Path $PSScriptRoot 'install-deps.ps1'),
  (Join-Path $PSScriptRoot 'test-all.ps1'),
  (Join-Path $PSScriptRoot 'verify.ps1')
)
foreach ($scriptPath in $criticalScripts) {
  Assert-ScriptParses $scriptPath
  Write-Host "  OK $([System.IO.Path]::GetFileName($scriptPath))"
}

Write-Step '1/7 Clean stale runtime and bootstrap directories'
$cleanupScript = Join-Path $PSScriptRoot 'cleanup-runtime.ps1'
& $cleanupScript

$dirs = @(
  'app', 'config', 'assets\sounds', 'runtime', 'workspace\active', 'workspace\completed', 'workspace\temp',
  'cache\pip', 'cache\npm', 'cache\electron', 'cache\pnpm', 'cache\downloads', 'cache\build', 'cache\temp',
  'cache\huggingface', 'cache\models', 'data\sessions', 'data\sounds', 'data\state', 'data\task-history',
  'data\usage', 'data\pricing', 'logs\app', 'logs\harness'
)
foreach ($d in $dirs) {
  New-Item -ItemType Directory -Path (Join-Path $ROOT $d) -Force | Out-Null
}
Write-Host 'Directory structure ready.'

Write-Step '2/7 Resolve/reuse dependencies'
$dependencyScript = Join-Path $PSScriptRoot 'install-deps.ps1'
& $dependencyScript -Full

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
    Write-Host '  [2] Configure later in DS-Harness settings (Ctrl+Shift+M -> Harness / Settings)'
    $rawChoice = ''
    while (($rawChoice -ne '1') -and ($rawChoice -ne '2')) {
      $rawChoice = (Read-Host 'Choose 1 or 2').Trim()
    }
    if ($rawChoice -eq '1') {
      $choice = 'Configure'
    } else {
      $choice = 'Later'
    }
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
    Write-Host 'API key deferred. Configure later with Ctrl+Shift+M in Mega Extensions settings.'
  }
}

# Restore canonical project runtime variables after install-time cache reuse.
. (Join-Path $PSScriptRoot 'env.ps1')

Write-Step '4/7 Unit and architecture tests'
if ($SkipTests) {
  Write-Host 'Tests skipped by -SkipTests.'
} else {
  & $selfPowerShell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'test-all.ps1')
  if ($LASTEXITCODE -ne 0) {
    throw 'Unit/architecture tests failed.'
  }
}

Write-Step '5/7 Verification'
& $selfPowerShell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'verify.ps1') -SkipTests
if ($LASTEXITCODE -ne 0) {
  throw 'Verification failed.'
}

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
