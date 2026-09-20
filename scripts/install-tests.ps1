# DS-Harness installer test tiers.
#
# The installer used to run the entire 147-file unit suite on every install
# (`test-all.ps1`), which made a second install of an unchanged checkout cost
# exactly as much as the first. It also meant the installer could fail because a
# *benchmark* was slow on a loaded machine.
#
# This script is the split. It selects by tier, and the tier is the whole point:
#
#   Standard       a small, deterministic smoke set. It answers "did this
#                  installation produce a working product?" -- the installer's own
#                  contract, the install fingerprint it now keeps, and the
#                  instance isolation the runtime depends on. It does not run the
#                  repository's full qualification.
#
#   Qualification  everything: the full suite plus the architectural and
#                  dual-instance acceptance. This is for a release, CI, a major
#                  refactor, or an owner who asked for it -- not for a user
#                  installing the product.
#
# The tier is chosen by install.ps1's -Mode and passed here as -Tier. An unknown
# tier is refused rather than silently downgraded, because "I asked for
# qualification and got a smoke test" is the failure this file exists to prevent.
#
# Windows PowerShell 5.1 compatible and ASCII-only.
param(
  [ValidateSet('Fast', 'Standard', 'Qualification')]
  [string]$Tier = 'Standard',
  # Informational only. When set, timings are printed; the exit code is unchanged,
  # which is the rule this repository learned the hard way: a slow host runs
  # slowly, and slowness is not an installation failure.
  [switch]$ReportTiming
)
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot

function Resolve-Node {
  $local = Get-ChildItem -Path (Join-Path $ROOT 'runtime') -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'node-v*-win-x64' } |
    Sort-Object Name |
    Select-Object -Last 1
  if ($local) {
    $exe = Join-Path $local.FullName 'node.exe'
    if (Test-Path -LiteralPath $exe) { return $exe }
  }
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return ''
}

$node = Resolve-Node
if (-not $node) {
  throw 'No Node runtime is available to run the installer tests.'
}
Write-Host "  test tier: $Tier (node: $node)"

# The smoke set. Each entry is here for a reason rather than for coverage
# percentage, and every one is a *deterministic* contract check: none of them
# measures wall-clock time as a pass/fail.
#
#   installer-contract              the installer still does what its contract says
#   installer-timing-gate           no wall-clock number can fail an installation
#   installer-fingerprint           the incremental state decides reuse correctly
#   installer-mode                  the three tiers stay distinct and gated
#   host-capability-profile         capacity is measured, not assumed from a table
#   adaptive-performance-policy     budgets scale with the host and stay bounded
#   instance-isolation              two instances cannot share a port or a lock
#   runtime-bootstrap               the Runtime Host starts, serves and stops alone
$smokeSet = @(
  'installer-contract.test.js',
  'installer-timing-gate.test.js',
  'installer-fingerprint.test.js',
  'installer-mode.test.js',
  'host-capability-profile.test.js',
  'adaptive-performance-policy.test.js',
  'instance-isolation.test.js',
  'runtime-bootstrap.test.js'
)

$testsDir = Join-Path $ROOT 'tests\unit'
if (-not (Test-Path -LiteralPath $testsDir)) {
  Write-Warning 'This installation has no test suite; nothing to run.'
  exit 0
}

if ($Tier -eq 'Qualification') {
  Write-Host '  qualification: the full repository suite'
  $all = Get-ChildItem -LiteralPath $testsDir -File -Filter '*.test.js' | Sort-Object Name
  $files = @($all | ForEach-Object { $_.FullName })
  Write-Host "  $($files.Count) test files"
} else {
  $files = @()
  $absent = @()
  foreach ($name in $smokeSet) {
    $path = Join-Path $testsDir $name
    # A smoke test genuinely absent from this installation is reported and skipped
    # rather than turned into a failed installation: its presence is a fact about
    # the checkout, and refusing to install over it would stop a user whose
    # checkout predates the test. `test-all.ps1` asserts the suite's composition,
    # and that runs in the Qualification tier.
    if (Test-Path -LiteralPath $path) { $files += $path } else { $absent += $name }
  }
  if ($absent.Count -gt 0) {
    Write-Warning "Not present in this installation, skipped: $($absent -join ', ')"
  }
  if ($files.Count -eq 0) {
    Write-Warning 'No installer smoke tests are present; nothing to run.'
    exit 0
  }
  Write-Host "  smoke set: $($files.Count) deterministic files (no benchmark gates, no full suite)"
}

$started = Get-Date
$arguments = @('--test', '--test-concurrency=2') + $files
Push-Location $testsDir
try {
  & $node @arguments
  $exit = $LASTEXITCODE
} finally {
  Pop-Location
}
$elapsed = ((Get-Date) - $started).TotalSeconds

if ($ReportTiming) {
  # Printed, never asserted. See tests/unit/installer-timing-gate.test.js.
  Write-Host ("  [benchmark] test tier {0}: {1:N1}s" -f $Tier, $elapsed)
}

if ($exit -ne 0) {
  throw "Installer tests failed (tier $Tier)."
}
Write-Host "  Installer tests passed (tier $Tier, $([math]::Round($elapsed,1))s)."
