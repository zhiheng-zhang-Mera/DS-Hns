param(
  [switch]$NoLaunch,
  [switch]$NoShortcuts,
  [switch]$SkipTests,
  [ValidateSet('Prompt', 'Configure', 'Later')]
  [string]$ApiKeyMode = 'Prompt',
  # The optional community plugins. They are asked about one at a time, and these three parameters
  # are how a person answers without being asked -- and how an unattended install says what it wants.
  [switch]$InstallMarket,
  [switch]$InstallWallpaper,
  [switch]$SkipOptionalPlugins,
  # The Harness profile the community plugins are installed into. The product boots `web`.
  [string]$Profile = '',
  # Ask nothing: the optional community plugins are then skipped unless -InstallMarket /
  # -InstallWallpaper named one. Unlike a redirected stdin (which the command line detects and treats
  # as skip), this says so outright, and combines with a plugin parameter as a contradiction rather
  # than being silently overridden.
  [switch]$NonInteractive,
  # Test seam, and only that: a JSON file mapping a community plugin's package name to a local
  # directory that stands in for it, so the *installation channel* can be exercised without a
  # registry. It is a parameter rather than an environment variable on purpose -- a variable left set
  # in a shell could silently redirect a real installation at a local directory, while a flag has to
  # be typed. Never used by a person installing DS-Harness.
  [string]$CommunityFixtureMap = '',
  # Test seam: comma-separated extra arguments for the Harness plugin CLI, so a test can make the
  # community channel refuse. Never used by a person installing DS-Harness.
  [string]$CommunityExtraArgs = '',
  # Skip step 1/9's stale-runtime sweep.
  #
  # The sweep refuses to run while an unrelated process holds the port this
  # instance would serve on, and it is right to: it stops *this* repository's
  # processes and nothing else. That refusal is exactly what makes a real clean
  # installation impossible to rehearse while another DS-Harness (a development
  # instance, the one this documentation was written against) is serving. This
  # switch says "I know; the runtime is somebody else's; install the files anyway"
  # -- and it is a switch a person has to type, never a fallback.
  [switch]$SkipRuntimeCleanup,
  # How much of the repository's own qualification this installation performs.
  #
  #   Fast           installing during development, over and over. Syntax, the
  #                  required files, the dependency reuse decision and a critical
  #                  installer smoke check. No test suite, no verification, no
  #                  performance measurement.
  #
  #   Standard       the default for a person installing the product. Everything
  #                  Fast does, plus profile/plugin correctness, a small
  #                  deterministic smoke set and the verifier. It never runs the
  #                  whole repository suite and never runs a benchmark as a gate.
  #
  #   Qualification  a release, CI, a major refactor, or an explicit owner
  #                  request: the full suite, the architecture checks, the
  #                  dual-instance acceptance and the performance qualification.
  #
  # The distinction this encodes is the one that was missing: INSTALLATION
  # CORRECTNESS, REPOSITORY QUALIFICATION and PERFORMANCE BENCHMARK are three
  # different questions, and only the first is the installer's to answer.
  [ValidateSet('Fast', 'Standard', 'Qualification')]
  [string]$Mode = 'Standard',
  # Skip step 7/9's verifier. `-SkipTests` already skips the test tier; this is
  # its counterpart, and it exists because verification was previously impossible
  # to skip at all -- a bootstrap or a recovery install had to pay for it.
  [switch]$SkipVerify,
  # Print what was reused and what was re-done, and why. This is the evidence for
  # the incremental install: it names each skipped unit of work and the reason the
  # fingerprint considered it still valid.
  [switch]$ReportReuse,
  # A simulated host capability profile, as a JSON file.
  #
  # This is the seam the low-capacity acceptance needs: it makes the installer
  # behave as though it were running on the host the profile describes, so "a
  # 2-core 4 GB machine installs successfully" is a test that can be run on the
  # machine in front of you rather than a claim about a machine nobody has. It
  # replaces measurement *only*; every decision made from the profile is the same
  # code path a measured host takes.
  #
  # Never used by a person installing DS-Harness.
  [string]$HostProfileFixture = ''
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

<#
Resolve a Node executable for the installer's own bookkeeping (the install-state fingerprint and the
host capability calibration).

`install-deps.ps1` puts a Node on PATH, but it does that *after* this script already needs one, and it
runs as a child process whose environment changes do not come back here. So the same preference order
is repeated locally: the checkout's bundled runtime first, then PATH. Not finding one is not fatal --
both callers treat a missing Node as "cannot compute", never as a bad installation.
#>
function Resolve-InstallerNode {
  $runtimeDir = Join-Path $ROOT 'runtime'
  if (Test-Path -LiteralPath $runtimeDir) {
    $candidate = Get-ChildItem -LiteralPath $runtimeDir -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like 'node-v*-win-x64' } |
      Sort-Object Name |
      Select-Object -Last 1
    if ($candidate) {
      $exe = Join-Path $candidate.FullName 'node.exe'
      if (Test-Path -LiteralPath $exe) { return $exe }
    }
  }
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return ''
}

$node = Resolve-InstallerNode

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
  # Canonical name always wins. DeepSeek_API is accepted as a compatibility
  # alias and is mapped only into this process as DEEPSEEK_API_KEY.
  $candidates = @(
    @{ Name = 'DEEPSEEK_API_KEY'; Scope = 'Process/inherited'; Value = $env:DEEPSEEK_API_KEY },
    @{ Name = 'DEEPSEEK_API_KEY'; Scope = 'User'; Value = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User') },
    @{ Name = 'DEEPSEEK_API_KEY'; Scope = 'Machine'; Value = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'Machine') },
    @{ Name = 'DeepSeek_API'; Scope = 'Process/inherited'; Value = $env:DeepSeek_API },
    @{ Name = 'DeepSeek_API'; Scope = 'User'; Value = [Environment]::GetEnvironmentVariable('DeepSeek_API', 'User') },
    @{ Name = 'DeepSeek_API'; Scope = 'Machine'; Value = [Environment]::GetEnvironmentVariable('DeepSeek_API', 'Machine') }
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

# ---------------------------------------------------------------------------------------------
# The optional community plugins
#
# Two plugins DS-Hns offers but does not depend on: the plugin market (`@dsh-market/plugin`,
# `2BingLing/dsh-market`) and the wallpaper engine (`dsh-plugin-wallpaper-engine`,
# `elysia395/dsh-wallpaper-engine`). Both are DeepSeek Harness *client* plugins, so their only
# installation channel is the Harness' own CLI -- and all of the policy, the pinned reference, the
# channel dispatch and the adapter-layer compatibility check live in Node, where the product already
# implements them (`app\extensions\mega\plugins\`). This section is the interaction: it asks, it
# calls that command line, and it prints what happened. It installs nothing itself.
#
# Three rules, from the requirement:
#   * each plugin is asked about separately, with its own question and its own default;
#   * without an explicit parameter, an unattended install skips them -- nothing optional is ever
#     installed by a default nobody chose;
#   * a failure is a warning with its reason and never a failed installation.
# ---------------------------------------------------------------------------------------------

function Get-CommunityPlan {
  param([string]$Root, [string]$ProfileName, [string]$DshHome, [string]$NodeExe, [string]$Cli)
  # The report is written to a file and read back as UTF-8 rather than parsed from captured stdout:
  # Windows PowerShell decodes a native command's output through the console code page, which is one
  # decoding step that can be got wrong, and this file is the answer the summary depends on.
  $reportFile = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-community-plan-$PID.json"
  Remove-Item -LiteralPath $reportFile -Force -ErrorAction SilentlyContinue
  try {
    & $NodeExe $Cli '--describe' "--profile=$ProfileName" "--dsh-home=$DshHome" "--root=$Root" "--report=$reportFile" 2>$null | Out-Null
    if (-not (Test-Path -LiteralPath $reportFile)) { return $null }
    $text = [System.IO.File]::ReadAllText($reportFile, [System.Text.Encoding]::UTF8).Trim()
    if (-not $text) { return $null }
    return ($text | ConvertFrom-Json)
  } catch {
    return $null
  } finally {
    Remove-Item -LiteralPath $reportFile -Force -ErrorAction SilentlyContinue
  }
}

Write-Host 'DS-Harness one-click installer' -ForegroundColor Green
Write-Host "Root: $ROOT"

# What the completion summary reports about the plugin DS-Hns signs into the profile (step 4/9). It is
# a script-scope value rather than a local one so the summary at the end reads the same fact the step
# established, instead of re-deriving it.
$script:MegaCoreState = 'NOT INSTALLED'

if (($InstallMarket -or $InstallWallpaper) -and ($SkipOptionalPlugins -or $NonInteractive)) {
  # Two different instructions, and a tool that silently picks one has decided something the person
  # did not say. This is a usage error, so it is raised the way the other bad invocations are. The
  # message names the parameters that were actually given, because "which two?" is the first question.
  $named = @()
  if ($InstallMarket) { $named += '-InstallMarket' }
  if ($InstallWallpaper) { $named += '-InstallWallpaper' }
  $against = if ($SkipOptionalPlugins) { '-SkipOptionalPlugins' } else { '-NonInteractive' }
  throw "$($named -join ' and ') cannot be combined with $against : one says install an optional community plugin and the other says do not."
}

Write-Step '0/9 PowerShell parser preflight'
$criticalScripts = @(
  (Join-Path $PSScriptRoot 'cleanup-runtime.ps1'),
  (Join-Path $PSScriptRoot 'ensure-node.ps1'),
  (Join-Path $PSScriptRoot 'ensure-icon.ps1'),
  (Join-Path $PSScriptRoot 'install-deps.ps1'),
  (Join-Path $PSScriptRoot 'install-profile-plugin.ps1'),
  (Join-Path $PSScriptRoot 'install-bundled-plugins.ps1'),
  (Join-Path $PSScriptRoot 'install-community-plugins.ps1'),
  (Join-Path $PSScriptRoot 'test-all.ps1'),
  (Join-Path $PSScriptRoot 'verify.ps1')
)
foreach ($scriptPath in $criticalScripts) {
  Assert-ScriptParses $scriptPath
  Write-Host "  OK $([System.IO.Path]::GetFileName($scriptPath))"
}

Write-Step '1/9 Clean stale runtime and bootstrap directories'
$cleanupScript = Join-Path $PSScriptRoot 'cleanup-runtime.ps1'
if ($SkipRuntimeCleanup) {
  Write-Host 'Stale-runtime cleanup skipped by -SkipRuntimeCleanup.'
} else {
  & $cleanupScript
}

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

# --- Install state -------------------------------------------------------------------------------
#
# Everything above is installation. Everything below decides how much of the *repository's* own
# qualification this run is responsible for, and how much of the work already done can be kept.
#
# The state is computed once, before the steps that consult it, and written once at the end. It is
# deliberately advisory: `install-deps.ps1` and `install-profile-plugin.ps1` remain the things that
# install and repair, and this only tells them whether they are *needed*. A wrong "reuse" would be a
# broken installation, which is why every reuse decision re-checks that the installed files exist.
$fingerprintScript = Join-Path $PSScriptRoot 'install-fingerprint.cjs'
$profileName = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } elseif ($Profile) { $Profile } else { 'web' }
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $ROOT 'data' }
$electronExe = Join-Path $ROOT 'app\node_modules\electron\dist\electron.exe'
$megaCoreDir = Join-Path $ROOT 'app\plugins\mega-core'
$installState = $null
$installStateFile = Join-Path $dshHome 'state\install-state.json'
if ((Test-Path -LiteralPath $fingerprintScript) -and $node) {
  try {
    $installStateJson = & $node @($fingerprintScript, 'describe', '--root', $ROOT, '--dsh-home', $dshHome, '--profile', $profileName, '--plugin-dir', $megaCoreDir, '--electron-exe', $electronExe, '--node-version', (& $node --version)) 2>&1
    $installState = ($installStateJson | Select-Object -Last 1) | ConvertFrom-Json
  } catch {
    Write-Warning "Install state could not be computed; this run will do the full work: $($_.Exception.Message)"
    $installState = $null
  }
} elseif (Test-Path -LiteralPath $fingerprintScript) {
  Write-Host 'Install state lookup deferred until the dependency step bootstraps Node.'
}

Write-Step '2/9 Resolve/reuse dependencies'
$dependencyScript = Join-Path $PSScriptRoot 'install-deps.ps1'

# The fast path, before any work is done.
#
# `install-deps.ps1` already reuses a version-matched tree internally, but it gets there by resolving
# Node, reading both package manifests and probing four paths -- and, when the state says nothing
# changed, the *answer is already known*. So the state is consulted first, and only a run that cannot
# prove reuse falls through to the script.
#
# The proof is deliberately conservative: the lockfile hash, the manifest hash, the Node build, the
# expected versions, and the existence of `lib/bin.js`, `electron/install.js` and `electron.exe`. A
# missing file fails the check, so the fast path can never skip a repair that is actually needed.
$depsReuse = $false
if ($installState -and $installState.decisions -and $installState.decisions.dependencies) {
  $depsReuse = [bool]$installState.decisions.dependencies.reuse
}
if ($depsReuse) {
  Write-Host "  reuse: $($installState.decisions.dependencies.reason)"
  Write-Host '  dsh and Electron are installed, version-matched and present; npm will not run.'
} else {
  if ($installState -and $installState.decisions -and $installState.decisions.dependencies) {
    Write-Host "  reinstall: $($installState.decisions.dependencies.reason)"
  }
  & $dependencyScript -Full
}

# Dependency resolution owns Node bootstrap. Resolve again in this scope before using Node for
# host calibration or the final install-state write; a child PowerShell script cannot update `$node`.
$node = Resolve-InstallerNode

# Host capability, measured rather than assumed. It is printed as information and cached for the
# Runtime to use; nothing below fails an installation because this machine is slow. See
# app/runtime/host-capability.cjs for why a static machine table was rejected in favour of a short
# calibration, and why the performance numbers are reporting rather than gating.
$hostProfile = $null
if ($HostProfileFixture) {
  # A simulated host. The profile is read, classified and cached by the same code a
  # measured one goes through, so the policy under test is the real policy.
  $fixturePath = if (Test-Path -LiteralPath $HostProfileFixture) { $HostProfileFixture } else { Join-Path $ROOT $HostProfileFixture }
  if ($node) {
    try {
      $hostProfile = (& $node @($fingerprintScript, 'host-profile', '--fixture', $fixturePath) 2>&1 | Select-Object -Last 1) | ConvertFrom-Json
      Write-Host "Host capability: SIMULATED from $fixturePath"
    } catch {
      Write-Warning "The host profile fixture could not be read, so this host will be measured instead: $($_.Exception.Message)"
      $hostProfile = $null
    }
  }
}
if (-not $hostProfile -and $node) {
  $capabilityScript = Join-Path $ROOT 'app\runtime\runtime.cjs'
  if (Test-Path -LiteralPath $capabilityScript) {
    try {
      $hostProfile = (& $node @($capabilityScript, '--json', 'capability') 2>&1 | Select-Object -Last 1) | ConvertFrom-Json
    } catch {
      Write-Warning "The host capability profile could not be measured; installation will continue without its cached measurements: $($_.Exception.Message)"
      $hostProfile = $null
    }
  }
}
if ($hostProfile) {
  $capacity = $hostProfile.capacity.class
  $cores = $hostProfile.cpu.logicalCores
  $memoryMb = $hostProfile.memory.totalMB
  Write-Host "Host capability: $capacity ($cores logical cores, ${memoryMb} MB RAM)."
  Write-Host "  worker ceiling: $($hostProfile.workers.recommended) ($($hostProfile.workers.label) scaling)"
  Write-Host "  measured node spawn p95: $($hostProfile.calibration.nodeSpawnP95Ms) ms"
  if ($capacity -eq 'LOW_CAPACITY' -or $capacity -eq 'CONSERVATIVE') {
    # Reported as a *policy*, not as an error: a small machine gets conservative defaults and the
    # installation continues to completion.
    Write-Host '  this host is treated as conservative: lower worker concurrency and longer timeouts.'
  }
  # Recorded for the Runtime, so the worker ceiling it uses is the one measured here rather than a
  # default chosen on a faster machine.
  try {
    $profileFile = Join-Path $dshHome 'state\host-profile.json'
    New-Item -ItemType Directory -Path (Split-Path -Parent $profileFile) -Force | Out-Null
    $hostProfile | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $profileFile -Encoding UTF8
  } catch {
    Write-Warning "The host capability profile could not be cached: $($_.Exception.Message)"
  }
}

Write-Step '3/9 Resolve DeepSeek API key'
$envFile = Join-Path $ROOT 'config\.env'
Ensure-ProjectEnvFile $envFile
$systemKey = Get-SystemApiKey
$projectKey = Get-DotEnvValue $envFile 'DEEPSEEK_API_KEY'

if ($systemKey) {
  $env:DEEPSEEK_API_KEY = [string]$systemKey.Value
  Write-Host "Found $($systemKey.Name) in $($systemKey.Scope) environment. Reusing it as DEEPSEEK_API_KEY; no key is copied or logged."
} elseif (Test-RealApiKey $projectKey) {
  $env:DEEPSEEK_API_KEY = $projectKey
  Write-Host 'No system API key found; existing project config\.env key will be reused.'
} else {
  $choice = $ApiKeyMode
  if ($choice -eq 'Prompt') {
    Write-Host 'No DEEPSEEK_API_KEY or DeepSeek_API was found in Process/User/Machine environment variables.' -ForegroundColor Yellow
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

Write-Step '4/9 Sign the shipped plugins into the Harness profile'
# Four plugins DS-Hns ships are installed here, and none of them is optional.
#
#   * `app\plugins\mega-core` draws the orb and the Mega settings page in the official UI, and the
#     official UI mounts it only when the profile this product boots has it installed;
#   * `app\plugins\health-scheduler` and `app\plugins\restart-supervisor` are the two built-in
#     plugins of this release. They run in our own plugin host either way, but the official UI lists
#     a plugin because the *profile* declares it -- so without this step they would be invisible in
#     the one place the requirement says they must be visible.
#
# That install is host-local: `data\*` is git-ignored and the dependency is an absolute `file:` path,
# so no checkout can carry it. Installing it is the Harness' own CLI's job
# (`scripts\install-profile-plugin.ps1`, driven for the whole set by
# `scripts\install-bundled-plugins.ps1`), and it is a step of the installation rather than something
# a fresh host acquires by itself.
#
# This step is **not** a choice: it runs unconditionally, before the optional community plugins are
# ever mentioned, and nothing below may turn any of these three into something a user can skip.
$script:BuiltInPluginStates = [ordered]@{
  'dshns.health-scheduler' = 'NOT INSTALLED'
  'dshns.restart-supervisor' = 'NOT INSTALLED'
}
# What the *runtime* says about them, which is a different question from what the profile holds: the
# registration check fills this in (registered, mounted, or listed in the official UI), and the
# completion summary reports it rather than only the file-level state.
$script:BuiltInRegistration = [ordered]@{
  'dshns.health-scheduler' = 'NOT VERIFIED'
  'dshns.restart-supervisor' = 'NOT VERIFIED'
}
$profileReuse = $false
if ($installState -and $installState.decisions -and $installState.decisions.profile) {
  $profileReuse = [bool]$installState.decisions.profile.reuse
}
try {
  # The orb first, and separately, because its outcome is what the summary's Mega Core line reports.
  # The runtime branch's fingerprint can prove that this exact checkout is already installed; only in
  # that case may the expensive Harness CLI call be skipped. The two required long-host plugins below
  # still run through their own freshness-aware installer and registration probe.
  if ($profileReuse) {
    $script:MegaCoreState = 'ALREADY INSTALLED'
    Write-Host "  reuse: $($installState.decisions.profile.reason)"
  } else {
    if ($installState -and $installState.decisions -and $installState.decisions.profile) {
      Write-Host "  sign-in required: $($installState.decisions.profile.reason)"
    }
    $orbLines = @(& (Join-Path $PSScriptRoot 'install-profile-plugin.ps1') -Plugin 'mega-core' 2>&1 | ForEach-Object { [string]$_ })
    $orbExit = $LASTEXITCODE
    $orbTail = ($orbLines | Select-Object -Last 1)
    if ($orbExit -ne 0) {
      $script:MegaCoreState = 'FAILED'
      Write-Warning 'The orb plugin is not in the Harness profile, so the official UI will show no ball.'
      Write-Warning 'DS-Harness is fully usable without it; re-run scripts\install-profile-plugin.ps1 to add it.'
    } elseif ($orbTail -match 'already-installed') {
      $script:MegaCoreState = 'ALREADY INSTALLED'
    } else {
      $script:MegaCoreState = 'LOADED'
    }
  }

  # Then the two built-in plugins, through the one installer that owns the list.
  $bundledReportFile = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-bundled-plugins-$PID.json"
  Remove-Item -LiteralPath $bundledReportFile -Force -ErrorAction SilentlyContinue
  $bundledLines = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-bundled-plugins.ps1') -Json 2>&1 | ForEach-Object { [string]$_ })
  $bundledExit = $LASTEXITCODE
  foreach ($line in $bundledLines) { if ($line.Trim() -and -not $line.Trim().StartsWith('{')) { Write-Host "  $($line.Trim())" } }
  $bundledJson = ($bundledLines | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
  if ($bundledJson) {
    try {
      $bundledReport = $bundledJson | ConvertFrom-Json
      foreach ($result in @($bundledReport.results)) {
        $id = [string]$result.id
        if (-not $id) { continue }
        $script:BuiltInPluginStates[$id] = if ($result.state -eq 'installed') { 'INSTALLED' } elseif ($result.state -eq 'already-installed') { 'ALREADY INSTALLED' } else { 'FAILED' }
        if ($result.state -eq 'failed' -or $result.state -eq 'missing') { Write-Warning "$id is not in the Harness profile: $($result.reason)" }
      }
    } catch {
      Write-Warning "The built-in plugin report could not be read: $($_.Exception.Message)"
    }
  } elseif ($bundledExit -ne 0) {
    Write-Warning 'The built-in plugin installer produced no report; the plugins may not be in the profile.'
    foreach ($id in @($script:BuiltInPluginStates.Keys)) { $script:BuiltInPluginStates[$id] = 'FAILED' }
  }

  # The proof that matters: the runtime registers what the profile now carries.
  #
  # "The file is installed" and "the plugin is registered, mounted and listed by the official UI" are
  # different claims, and the requirement names the gap between them: a plugin whose files are installed
  # while the system has never registered it. This builds the real plugin host - the same one the product
  # boots, through the same adapter framework - and reports per plugin whether the runtime knows it,
  # whether it mounted, and whether the service row the official Settings page draws exists. A required
  # plugin that is not registered fails the line.
  Write-Host ''
  Write-Host 'Built-in plugin registration'
  $registrationScript = Join-Path $PSScriptRoot 'plugin-registration-check.cjs'
  if (Test-Path -LiteralPath $registrationScript) {
    $previousRegistration = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      # Node is resolved the way the community step below resolves it: the repository's own bundled
      # runtime first (an install may have no system Node at all), then whatever `node` the machine has.
      $registrationExe = ''
      try {
        $registrationNodeDir = & (Join-Path $PSScriptRoot 'ensure-node.ps1') | Select-Object -Last 1
        if ($registrationNodeDir) {
          $candidateRegistrationNode = Join-Path ([string]$registrationNodeDir) 'node.exe'
          if (Test-Path -LiteralPath $candidateRegistrationNode) { $registrationExe = $candidateRegistrationNode }
        }
      } catch {
        $registrationExe = ''
      }
      if (-not $registrationExe) {
        $registrationNodeCommand = Get-Command node -ErrorAction SilentlyContinue
        if ($registrationNodeCommand) { $registrationExe = $registrationNodeCommand.Source }
      }
      if (-not $registrationExe) {
        Write-Warning 'no usable Node.js was found; plugin registration was not verified.'
        $registrationLines = @()
        $registrationExit = 1
      } else {
        $registrationLines = @(& $registrationExe $registrationScript --root $ROOT --json 2>&1 | ForEach-Object { [string]$_ })
        $registrationExit = $LASTEXITCODE
      }
    } finally {
      $ErrorActionPreference = $previousRegistration
    }
    $registrationJson = ($registrationLines | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    if ($registrationJson) {
      try {
        $registration = $registrationJson | ConvertFrom-Json
        foreach ($entry in @($registration.plugins)) {
          $id = [string]$entry.id
          if (-not $id) { continue }
          $state = if ($entry.registered -ne $true) { 'NOT REGISTERED' } elseif ($entry.enabled -eq $true -and $entry.loaded -ne $true) { 'NOT MOUNTED' } elseif ($entry.loaded -eq $true) { 'REGISTERED + MOUNTED' } else { 'REGISTERED (DISABLED BY DEFAULT)' }
          $script:BuiltInRegistration[$id] = $state
          $uiNote = if ($entry.officialUi -eq $true) { 'listed in the official UI' } else { 'NOT in the official UI' }
          Write-Host "  $id : $state; $uiNote"
          if ($entry.registered -ne $true) { Write-Warning "$id is installed but the runtime has no record of it: $($entry.reason)" }
        }
        if (@($registration.duplicateRegistrations).Count) {
          Write-Warning "the runtime registered a plugin more than once: $(@($registration.duplicateRegistrations) -join ', ')"
          $script:BuiltInRegistration['duplicates'] = "DUPLICATE: $(@($registration.duplicateRegistrations) -join ', ')"
        }
      } catch {
        Write-Warning "The plugin registration report could not be read: $($_.Exception.Message)"
      }
    } elseif ($registrationExit -ne 0) {
      Write-Warning 'The plugin registration check produced no report; registration was not verified.'
    }
  } else {
    Write-Warning 'scripts\plugin-registration-check.cjs is missing; registration was not verified.'
  }
} catch {
  $script:MegaCoreState = 'FAILED'
  foreach ($id in @($script:BuiltInPluginStates.Keys)) { $script:BuiltInPluginStates[$id] = 'FAILED' }
  Write-Warning "Signing the shipped plugins into the profile failed, installation continues: $($_.Exception.Message)"
}

Write-Step '5/9 Optional community plugins'
# Both optional plugins are handled here, and neither can fail this installation. See the block of
# comments above Get-CommunityPlan for the policy this step implements.
$profileName = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } elseif ($Profile) { $Profile } else { 'web' }
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $ROOT 'data' }
$communityStateFile = Join-Path $dshHome 'state\optional-plugins.json'
$communityCli = Join-Path $ROOT 'app\extensions\mega\plugins\community-install-cli.cjs'
$communitySelections = [ordered]@{
  '@dsh-market/plugin' = 'NOT SELECTED'
  'dsh-wallpaper-engine' = 'NOT SELECTED'
}
# The community command line's own report, kept for the completion summary. Declared here rather
# than where it is assigned so the summary can read it even when step 5/9 did nothing.
$communityReport = $null
$communityAvailable = $false

# Whether the questions may be asked is decided in **one** place, and it is not here.
#
# The installer passes `--ask` whenever no parameter answered the question, and the Node command line
# asks only when it really has a console: with a terminal it prints the numbered choice and reads the
# answer, and with a redirected or closed stdin `readline` answers end-of-input, which the command line
# treats as *skip*. That split is deliberate -- PowerShell cannot tell a terminal from a pipe reliably
# (`[Console]::IsInputRedirected` is true under `-File`, under a pipe and under a test harness alike),
# and a guess here would either silence a real prompt or hang an unattended install. Node can tell, so
# Node decides, and an unattended install installs nothing.

# Resolve the Node the community command line will run on. This is cheap (a bundled runtime or PATH)
# and is needed by the fast path below, because the channel's availability is part of deciding whether
# there is anything left to do.
$communityNode = ''
try {
  $communityNodeResult = & (Join-Path $PSScriptRoot 'ensure-node.ps1') | Select-Object -Last 1
  if ($communityNodeResult) {
    $candidateNode = Join-Path ([string]$communityNodeResult) 'node.exe'
    if (Test-Path -LiteralPath $candidateNode) { $communityNode = $candidateNode }
  }
} catch {
  $communityNode = ''
}
if (-not $communityNode) {
  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  if ($systemNode) { $communityNode = $systemNode.Source }
}

# The optional fast path, decided before any work.
#
# This step's cost is entirely in the *setup*: resolving Node again, making corepack produce a pnpm
# shim, and then asking the Node command line for a plan. None of that can change the answer when the
# user's decision is already recorded and this run did not ask for anything different -- and re-doing
# it on every Standard install is precisely the "optional plugins should not slow a repeat install"
# rule. The step is skipped only in that case:
#
#   * a parameter this run (`-InstallMarket` / `-InstallWallpaper`) is a new decision, so it runs;
#   * no recorded decision at all means there is something to ask, so it runs;
#   * the optional community channel still has to be *available*; if the plugin CLI or the Harness
#     binary is missing, the step runs so it can report the real reason.
#
# `-SkipOptionalPlugins` and `-NonInteractive` are themselves recorded by `--skip`, so a declined
# plugin is a recorded decision and is not re-asked.
$marketRequested = [bool]$InstallMarket
$wallpaperRequested = [bool]$InstallWallpaper
$skipOptional = [bool]$SkipOptionalPlugins -or [bool]$NonInteractive
$communityCliPath = Join-Path $ROOT 'app\extensions\mega\plugins\community-install-cli.cjs'
$communityDshBin = Join-Path $ROOT 'app\node_modules\@deepseek-ai\dsh\lib\bin.js'
$optionalDecisionAlreadyRecorded = $false
if ($installState -and $installState.optional -and $installState.optional.decisions) {
  $recordedDecisions = @($installState.optional.decisions.PSObject.Properties)
  $optionalDecisionAlreadyRecorded = ($recordedDecisions.Count -gt 0) -and (@($recordedDecisions | Where-Object { $_.Value.state -and $_.Value.state -ne '' }).Count -eq $recordedDecisions.Count)
}
$optionalReuse = $optionalDecisionAlreadyRecorded -and
  (-not $InstallMarket) -and (-not $InstallWallpaper) -and
  (Test-Path -LiteralPath $communityCliPath) -and (Test-Path -LiteralPath $communityDshBin)

if ($optionalReuse) {
  Write-Host "  reuse: every optional community plugin already has a recorded decision"
  foreach ($property in @($installState.optional.decisions.PSObject.Properties)) {
    if ($communitySelections.Contains($property.Name)) {
      switch ([string]$property.Value.state) {
        'installed' { $communitySelections[$property.Name] = 'ALREADY INSTALLED' }
        'already-installed' { $communitySelections[$property.Name] = 'ALREADY INSTALLED' }
        'declined' { $communitySelections[$property.Name] = 'SKIPPED' }
        'skipped' { $communitySelections[$property.Name] = 'SKIPPED' }
        'failed' { $communitySelections[$property.Name] = 'FAILED' }
        'version-drift' { $communitySelections[$property.Name] = 'VERSION DRIFT' }
        default { $communitySelections[$property.Name] = ([string]$property.Value.state).ToUpperInvariant() }
      }
    }
  }
  $communityAvailable = $false
} else {
  $communityAvailable = (Test-Path -LiteralPath $communityCli) -and (Test-Path -LiteralPath $communityDshBin) -and ($communityNode -ne '')
  if (-not $communityAvailable) {
    Write-Host 'The optional community plugins cannot be offered on this machine; the installation continues.'
    if (-not (Test-Path -LiteralPath $communityCli)) { Write-Warning "the community plugin command line is missing: $communityCli" }
    if (-not ($communityNode -ne '')) { Write-Warning 'no usable Node.js was found for the community plugin command line.' }
  }
}

# `dsh plugin` is a thin pnpm forwarder, so the channel needs a pnpm the CLI can spawn. Step 4/9's
# profile-plugin install does the same thing, but it can be skipped or fail without stopping the
# installation -- and a community plugin that cannot start its installer because pnpm is missing is a
# failure with the wrong reason. Doing it here makes this step self-contained: whatever happened above,
# the channel has what it needs or the reason says so.
if ($communityAvailable) {
  $communityShimDir = Join-Path $ROOT 'runtime\bin'
  $pnpmOnPath = Get-Command pnpm -ErrorAction SilentlyContinue
  if (-not $pnpmOnPath) {
    $corepack = Get-Command corepack -ErrorAction SilentlyContinue
    if (-not $corepack) {
      Write-Warning 'pnpm is not on PATH and corepack is not available; the optional community plugins cannot be installed.'
      $communityAvailable = $false
    } else {
      try {
        New-Item -ItemType Directory -Path $communityShimDir -Force | Out-Null
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
          & $corepack.Source enable pnpm --install-directory $communityShimDir > $null 2>&1
        } finally {
          $ErrorActionPreference = $previousPreference
        }
        if (Test-Path -LiteralPath (Join-Path $communityShimDir 'pnpm.cmd')) {
          $env:PATH = "$communityShimDir;$env:PATH"
          Write-Host "  pnpm: provided by corepack in $communityShimDir"
        } else {
          Write-Warning "corepack did not produce a pnpm shim in $communityShimDir; the optional community plugins cannot be installed."
          $communityAvailable = $false
        }
      } catch {
        Write-Warning "a pnpm for the Harness plugin CLI could not be provided: $($_.Exception.Message)"
        $communityAvailable = $false
      }
    }
  }
}

if ($communityAvailable) {
  # The plan is what the summary reads before anything happens: the release pin, the profile's own
  # manifest, and whether each plugin is already there.
  $communityPlan = Get-CommunityPlan -Root $ROOT -ProfileName $profileName -DshHome $dshHome -NodeExe $communityNode -Cli $communityCli
  $plannedPlugins = @()
  if ($communityPlan -and $communityPlan.plugins) { $plannedPlugins = @($communityPlan.plugins) }
  if ($plannedPlugins.Count -eq 0) {
    Write-Warning 'The optional community plugin manifest could not be read; the plugins are skipped rather than guessed at.'
  }
  Write-Host "  Harness profile: $profileName at $dshHome\profiles\$profileName"
  foreach ($entry in $plannedPlugins) {
    $state = if ($entry.installed) { "installed ($($entry.installedVersion))" } else { 'not installed' }
    Write-Host "  $($entry.id) : $state"
  }

  # One plugin, one question, one answer -- and the question is asked by the Node command line, using
  # the bilingual label file, because the installer's PowerShell files have to stay ASCII-only (see
  # the note in `scripts\install-community-plugins.ps1`).
  #
  # The split of responsibility is exact:
  #   * a parameter answered the question (`-InstallMarket`, `-InstallWallpaper`), so `--ask` is *not*
  #     passed and nothing is asked;
  #   * `-SkipOptionalPlugins` or `-NonInteractive` says skip, so `--skip` records both as declined;
  #   * otherwise `--ask` is passed, and the command line decides whether it has a console to ask on:
  #     with one it asks about each plugin separately, and without one it reads end-of-input and skips.
  $cliArgs = @($communityCli)
  if ($InstallMarket) { $cliArgs += '--install-market' }
  if ($InstallWallpaper) { $cliArgs += '--install-wallpaper' }
  if ($skipOptional) { $cliArgs += '--skip' }
  if ((-not $InstallMarket) -and (-not $InstallWallpaper) -and (-not $skipOptional)) { $cliArgs += '--ask' }
  if ($CommunityFixtureMap) { $cliArgs += "--fixture=$CommunityFixtureMap" }
  if ($CommunityExtraArgs) { $cliArgs += "--extra=$CommunityExtraArgs" }
  $cliArgs += "--profile=$profileName"
  $cliArgs += "--dsh-home=$dshHome"
  $cliArgs += "--root=$ROOT"
  $communityReportFile = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-community-report-$PID.json"
  $cliArgs += "--report=$communityReportFile"
  Remove-Item -LiteralPath $communityReportFile -Force -ErrorAction SilentlyContinue

  if ($plannedPlugins.Count -gt 0) {
    Write-Host ''
    $previousPreference = $ErrorActionPreference
    # The CLI writes its progress (and the interactive questions) to stderr, and a non-zero exit is a
    # *warning* here rather than a terminating error: this whole step is optional by construction.
    $ErrorActionPreference = 'Continue'
    try {
      $communityOutput = @(& $communityNode @cliArgs 2>&1 | ForEach-Object { [string]$_ })
      $communityExit = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    # The person's transcript is printed; the machine-readable answer is read from the UTF-8 report
    # file the CLI wrote, because that is the one decoding step that cannot go wrong.
    foreach ($line in $communityOutput) {
      $trimmed = [string]$line
      if ($trimmed.Trim()) { Write-Host "  $($trimmed.Trim())" }
    }
    $communityJson = ''
    if (Test-Path -LiteralPath $communityReportFile) {
      try { $communityJson = [System.IO.File]::ReadAllText($communityReportFile, [System.Text.Encoding]::UTF8).Trim() } catch { $communityJson = '' }
    }
    Remove-Item -LiteralPath $communityReportFile -Force -ErrorAction SilentlyContinue
    if (-not $communityJson) {
      Write-Warning "The community plugin command line produced no report (exit $communityExit); no optional plugin is recorded as installed."
    } else {
      try {
        $communityReport = $communityJson | ConvertFrom-Json
        foreach ($result in @($communityReport.results)) {
          $id = [string]$result.id
          if (-not $id) { continue }
          switch ([string]$result.state) {
            'installed' { $communitySelections[$id] = 'INSTALLED' }
            'already-installed' { $communitySelections[$id] = 'ALREADY INSTALLED' }
            'skipped' { if ($communitySelections[$id] -eq 'NOT SELECTED') { $communitySelections[$id] = 'SKIPPED' } }
            'failed' { $communitySelections[$id] = 'FAILED' }
            default { }
          }
          if ($result.state -eq 'failed') {
            Write-Warning "$id could not be installed: $($result.reason)"
            Write-Warning 'This plugin is optional; DS-Harness itself is installed and usable without it.'
          } elseif ($result.verify -and $result.verify.adapter) {
            Write-Host "  $id verified by the adapter layer: $($result.verify.adapter.id) ($($result.verify.detectedType))."
          }
        }
      } catch {
        Write-Warning "The community plugin report could not be read: $($_.Exception.Message)"
      }
    }
  } elseif ($skipOptional) {
    Write-Host '  Optional community plugins were skipped; the decision is recorded so a later boot cannot install them.'
  }
}

Write-Step "6/9 Installer tests ($Mode tier)"
# Three questions, three answers, and only one of them is the installer's:
#
#   is this installation correct?      -> yes, asserted below, every mode
#   is the repository fully qualified? -> only in Qualification
#   is it as fast as a benchmark says? -> never a gate outside Qualification
#
# `-SkipTests` still means what it always meant: run none of it. It exists for a
# bootstrap or a recovery install, where the point is to get files on disk.
if ($SkipTests) {
  Write-Host 'Tests skipped by -SkipTests.'
} else {
  $tierScript = Join-Path $PSScriptRoot 'install-tests.ps1'
  if (-not (Test-Path -LiteralPath $tierScript)) {
    # Falling back to the full suite would be the worst outcome: it would silently
    # restore the cost this step exists to remove. A missing tier runner is a
    # broken installation, and a broken installation must say so.
    throw "The installer test runner is missing: $tierScript"
  }
  $tierArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tierScript, '-Tier', $Mode)
  if ($Mode -ne 'Fast') { $tierArgs += '-ReportTiming' }
  & $selfPowerShell @tierArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Installer tests failed ($Mode tier)."
  }
}

Write-Step "7/9 Verification"
# The verifier is a *repository* qualification as much as an installation check,
# so its weight follows the mode. Fast skips it (it is measured in tens of
# seconds, which is the whole cost Fast exists to avoid); Standard and
# Qualification run it with tests already handled above.
if ($SkipVerify -or $Mode -eq 'Fast') {
  $why = if ($SkipVerify) { '-SkipVerify' } else { "the $Mode tier" }
  Write-Host "Verification skipped by $why."
} elseif (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'verify.ps1'))) {
  Write-Warning 'This installation has no verifier; nothing to verify.'
} else {
  & $selfPowerShell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'verify.ps1') -SkipTests
  if ($LASTEXITCODE -ne 0) {
    throw 'Verification failed.'
  }
}

Write-Step '8/9 Shortcuts'
if ($NoShortcuts) {
  Write-Host 'Shortcut creation skipped by -NoShortcuts.'
} else {
  # Launcher icon: generated from the repository-root icon.jpg. A failure here
  # may only degrade the shortcut icon, never the installation or the launch.
  try {
    $iconScript = Join-Path $PSScriptRoot 'ensure-icon.ps1'
    $iconResult = & $iconScript
    $iconPath = [string]($iconResult | Select-Object -Last 1)
    if ($iconPath) {
      Write-Host "Launcher icon ready (generated from icon.jpg): $iconPath"
    } else {
      Write-Warning 'Launcher icon could not be generated from icon.jpg; shortcuts will use the default icon.'
    }
  } catch {
    Write-Warning "Launcher icon step failed, installation continues: $($_.Exception.Message)"
  }
  try {
    & (Join-Path $PSScriptRoot 'shortcuts.ps1') -NoAutoStart
    Write-Host 'Desktop and Start Menu shortcuts are ready. Autostart was not enabled.'
  } catch {
    Write-Warning "Shortcut creation failed, but installation is otherwise usable: $($_.Exception.Message)"
  }
}

Write-Step '9/9 Complete'
Write-Host 'DS-Harness installation is complete.' -ForegroundColor Green
if ($systemKey) {
  Write-Host "API: system environment ($($systemKey.Name), $($systemKey.Scope))"
} elseif ($env:DEEPSEEK_API_KEY) {
  Write-Host 'API: project configuration'
} else {
  Write-Host 'API: not configured yet (configure later with Ctrl+Shift+M).'
}

# The summary reads the installation back rather than remembering what it intended. Every line below
# is a file on disk or a state the installer actually produced:
#
#   * the official Harness UI is the `@deepseek-ai/dsh` install the launcher boots;
#   * Mega Core is `app\plugins\mega-core`, a plugin DS-Hns ships and signs in unconditionally -- it
#     is never a choice, which is why it is a separate line from the two community plugins;
#   * the two community plugins are optional, and their states are what this installation decided;
#   * the adapter registry is the adapter framework's own answer about the selected plugins -- the
#     only thing here that reads the installed packages through the platform's adapter layer;
#   * the governance bridge is a *runtime* connection (`data\state\governance-bridge.json`), so
#     before the first launch the honest answer is that it starts with the product.
$harnessUiState = 'FAILED'
$harnessEntry = Join-Path $ROOT 'app\node_modules\@deepseek-ai\dsh\lib\bin.js'
if ((Test-Path -LiteralPath $harnessEntry) -and (Test-Path -LiteralPath (Join-Path $ROOT 'Start-DeepSeek-Harness.cmd'))) {
  $harnessUiState = 'OK'
}
$runtimeState = 'FAILED'
if ((Test-Path -LiteralPath (Join-Path $ROOT 'app\desktop-main.cjs')) -and (Test-Path -LiteralPath (Join-Path $ROOT 'app\plugin-host.cjs'))) {
  $runtimeState = 'OK'
}
$megaCorePath = Join-Path $ROOT 'app\plugins\mega-core\package.json'
if ((-not (Test-Path -LiteralPath $megaCorePath)) -and ($script:MegaCoreState -ne 'FAILED')) {
  $script:MegaCoreState = 'FAILED'
}
$marketState = 'NOT SELECTED'
$wallpaperState = 'NOT SELECTED'
if ($communitySelections) {
  $marketState = [string]$communitySelections['@dsh-market/plugin']
  $wallpaperState = [string]$communitySelections['dsh-wallpaper-engine']
}
$adapterState = 'NOT CHECKED'
$verified = @()
if ($communityReport -and $communityReport.adapterRegistry -and $communityReport.adapterRegistry.verified) {
  $verified = @($communityReport.adapterRegistry.verified)
}
$installedCount = 0
foreach ($stateValue in @($marketState, $wallpaperState)) {
  if (($stateValue -eq 'INSTALLED') -or ($stateValue -eq 'ALREADY INSTALLED')) { $installedCount++ }
}
if (-not $communityAvailable) {
  $adapterState = 'NOT CHECKED'
} elseif ($installedCount -gt 0 -and $verified.Count -ge $installedCount) {
  $adapterState = 'OK'
} elseif ($installedCount -gt 0) {
  $adapterState = 'FAILED'
} elseif ($installedCount -eq 0) {
  # Nothing was installed, so the layer has nothing to verify -- and saying OK here would be a claim
  # about work that was never done.
  $adapterState = 'NO OPTIONAL PLUGIN TO CHECK'
} else {
  $adapterState = 'FAILED'
}
$bridgeState = 'STARTS WITH THE PRODUCT'
$bridgeFile = Join-Path $dshHome 'state\governance-bridge.json'
if (Test-Path -LiteralPath $bridgeFile) { $bridgeState = 'CONNECTED (last run)' }

function Write-SummaryLine([string]$label, [string]$state) {
  $dots = '.'
  $pad = 30 - $label.Length
  if ($pad -lt 2) { $pad = 2 }
  $dots = $dots * $pad
  $colour = 'Gray'
  if (($state -match 'FAILED') -or ($state -match 'DEGRADED')) { $colour = 'Yellow' }
  elseif (($state -match '^OK') -or ($state -match 'LOADED') -or ($state -match 'INSTALLED') -or ($state -match 'CONNECTED')) { $colour = 'Green' }
  Write-Host ("{0} {1} {2}" -f $label, $dots, $state) -ForegroundColor $colour
}

Write-Host ''
Write-Host 'Installation summary'
Write-SummaryLine 'Mode' $Mode
Write-SummaryLine 'Official Harness UI' $harnessUiState
Write-SummaryLine 'DS-Hns runtime' $runtimeState
Write-SummaryLine 'Mega Core' $script:MegaCoreState
Write-SummaryLine 'Health Scheduler' ([string]$script:BuiltInPluginStates['dshns.health-scheduler'])
Write-SummaryLine 'Restart Supervisor' ([string]$script:BuiltInPluginStates['dshns.restart-supervisor'])
# The runtime's answer, next to the profile's: what the official UI will actually list.
Write-SummaryLine 'Health Scheduler (runtime)' ([string]$script:BuiltInRegistration['dshns.health-scheduler'])
Write-SummaryLine 'Restart Supervisor (runtime)' ([string]$script:BuiltInRegistration['dshns.restart-supervisor'])
Write-SummaryLine 'Plugin Market' $marketState
Write-SummaryLine 'Wallpaper Engine' $wallpaperState
Write-SummaryLine 'Adapter registry' $adapterState
Write-SummaryLine 'Governance bridge' $bridgeState
Write-Host ''
if (($marketState -eq 'FAILED') -or ($wallpaperState -eq 'FAILED')) {
  Write-Warning 'An optional community plugin failed. The reason is printed above; DS-Harness itself is installed.'
}
if (([string]$script:BuiltInPluginStates['dshns.health-scheduler']) -eq 'FAILED' -or ([string]$script:BuiltInPluginStates['dshns.restart-supervisor']) -eq 'FAILED') {
  Write-Warning 'A built-in plugin is not in the Harness profile, so the official UI will not list it. The reason is printed above.'
  Write-Warning 'The product runs either way; re-run scripts\install-bundled-plugins.ps1 -Repair to put it back.'
}
Write-Host 'Built-in plugins (Health Scheduler, Restart Supervisor) are part of the installation, never a choice.'
Write-Host 'Community plugins are optional: DS-Harness runs and the official UI opens without either of them.'
Write-Host "Optional plugin decisions are recorded in $communityStateFile."
Write-Host 'Primary UI: official DeepSeek Harness (Alien-derived shell).'
Write-Host 'Mega tools: Ctrl+Shift+M.'
Write-Host 'Orb: the ball in the official UI comes from the Mega Core profile plugin (step 4/9).'
Write-Host 'Pure Alien diagnostic mode: scripts\run.ps1 -PureAlien.'

# --- Persist the install state ---------------------------------------------------------------------
#
# Written last, and only when every step above succeeded: a state file written after a partial install
# would claim work that did not happen. The next run reads it and skips what has not changed, which is
# what makes a warm reinstall cheap instead of a repeat of the first one.
if (Test-Path -LiteralPath $fingerprintScript) {
  try {
    $writeResult = & $node @($fingerprintScript, 'write', '--root', $ROOT, '--dsh-home', $dshHome, '--profile', $profileName, '--plugin-dir', $megaCoreDir, '--electron-exe', $electronExe, '--node-version', (& $node --version)) 2>&1
    $written = ($writeResult | Select-Object -Last 1) | ConvertFrom-Json
    if ($written -and $written.write -and $written.write.ok) {
      Write-Host "Install state recorded: $installStateFile"
      if ($ReportReuse) {
        Write-Host '  reuse decisions for this run:'
        foreach ($name in @('dependencies', 'profile')) {
          if ($written.decisions.$name) {
            Write-Host ("    {0}: {1} ({2})" -f $name, $(if ($written.decisions.$name.reuse) { 'reuse' } else { 'install' }), $written.decisions.$name.reason)
          }
        }
      }
    } else {
      Write-Warning 'The install state could not be recorded; the next run will do the full work.'
    }
  } catch {
    Write-Warning "The install state could not be recorded: $($_.Exception.Message)"
  }
}

if (-not $NoLaunch) {
  Write-Host 'Launching DS-Harness...'
  Start-Process -FilePath (Join-Path $ROOT 'Start-DeepSeek-Harness.cmd') -WorkingDirectory $ROOT
} else {
  Write-Host 'Launch skipped by -NoLaunch.'
}
