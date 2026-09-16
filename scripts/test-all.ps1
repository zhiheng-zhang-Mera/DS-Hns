$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
$node = (Get-Command node).Source

$syntaxFiles = @(
  "$ROOT\app\desktop-main.cjs",
  "$ROOT\app\runtime-process.cjs",
  "$ROOT\app\harness-profile.cjs",
  "$ROOT\app\extensions\manager.cjs",
  "$ROOT\app\sub-worker\manager.cjs",
  "$ROOT\app\sub-worker\runtime.cjs",
  "$ROOT\app\sub-worker\protocol.cjs",
  "$ROOT\app\sub-worker\state.cjs",
  "$ROOT\app\sub-worker\permissions.cjs",
  "$ROOT\app\sub-worker\event-bus.cjs",
  "$ROOT\app\sub-worker\reporter.cjs",
  "$ROOT\app\sub-worker\task-runner.cjs",
  "$ROOT\app\sub-worker\yaml.cjs",
  "$ROOT\app\sub-worker\resource-config.cjs",
  "$ROOT\app\sub-worker\profiler.cjs",
  "$ROOT\app\sub-worker\resources.cjs",
  "$ROOT\app\sub-worker\dag.cjs",
  "$ROOT\app\sub-worker\ownership.cjs",
  "$ROOT\app\sub-worker\snapshot.cjs",
  "$ROOT\app\sub-worker\metrics.cjs",
  "$ROOT\app\sub-worker\pool.cjs",
  "$ROOT\app\sub-worker\scheduler.cjs",
  "$ROOT\app\sub-worker\integration.cjs",
  "$ROOT\app\extensions\mega\index.cjs",
  "$ROOT\app\extensions\mega\deepseek\official-session-client.js",
  "$ROOT\app\extensions\mega\scheduler\scheduler.js",
  "$ROOT\app\extensions\mega\scheduler\lifecycle.js",
  "$ROOT\app\extensions\mega\scheduler\system.js",
  "$ROOT\app\extensions\mega\billing\balance-service.js",
  "$ROOT\app\extensions\mega\notifications\notification-service.js",
  "$ROOT\app\extensions\mega\notifications\terminal-dispatch.js",
  "$ROOT\app\extensions\mega\tracker\terminal-observer.js",
  "$ROOT\app\extensions\mega\tracker\session-reader.js",
  "$ROOT\app\extensions\mega\updater\harness-updater.js",
  "$ROOT\app\extensions\mega\updater\update-runner.js",
  "$ROOT\app\extensions\mega\ui\preload.cjs",
  "$ROOT\app\extensions\mega\ui\balance-module.js",
  "$ROOT\app\extensions\mega\ui\dock.js",
  "$ROOT\app\official-surface-views.cjs",
  "$ROOT\app\frontend-mode\model.cjs",
  "$ROOT\app\frontend-mode\backend.cjs",
  "$ROOT\app\frontend-mode\adapter.cjs",
  "$ROOT\app\frontend-mode\probe.cjs",
  "$ROOT\app\frontend-mode\index.cjs",
  "$ROOT\app\extensions\mega\theme\surface.js",
  "$ROOT\app\extensions\mega\theme\assets\planner.js",
  "$ROOT\app\extensions\mega\theme\assets\generator.js",
  "$ROOT\app\extensions\mega\theme\assets\processor.js",
  "$ROOT\app\extensions\mega\theme\assets\validator.js",
  "$ROOT\app\extensions\mega\theme\assets\fallback.js",
  "$ROOT\app\extensions\mega\theme\official\overlay-layout.js",
  "$ROOT\app\extensions\mega\theme\official\overlay-safety.js"
)
foreach ($file in $syntaxFiles) {
  & $node --check $file
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Push-Location "$ROOT\tests"
try {
  # Computer Use coverage (tests\unit\computer-use-*.test.js), including the
  # long-running execution modules (Update-Plan/24h.md Tasks 1-20). The unit
  # directory is globbed, so a new file is picked up automatically; the presence
  # assert below is what keeps a renamed or deleted file from silently dropping
  # the coverage instead of failing the gate.
  $computerUseTests = @(
    'computer-use-acceptance.test.js',
    'computer-use-architecture.test.js',
    'computer-use-contract.test.js',
    'computer-use-device.test.js',
    'computer-use-drivers.test.js',
    'computer-use-executor-boundaries.test.js',
    'computer-use-isolation.test.js',
    'computer-use-longrun-acceptance.test.js',
    'computer-use-longrun-modules.test.js',
    'computer-use-production-wiring.test.js',
    'computer-use-resource-growth.test.js',
    'computer-use-routing-safety.test.js',
    'computer-use-runtime.test.js',
    'computer-use-soak.test.js',
    'computer-use-stabilization.test.js',
    'computer-use-verification-recovery.test.js',
    'computer-use-wiring.test.js'
  )
  # The engineering runtime (Update-Plan/24h-1.md) is a separate subsystem with its
  # own suite; it is asserted here for the same reason: a renamed file must fail the
  # gate rather than silently drop its coverage.
  $engineeringTests = @(
    'engineering-checkpoint.test.js',
    'engineering-context.test.js',
    'engineering-plan.test.js',
    'engineering-scenarios.test.js',
    'engineering-verifier.test.js',
    'engineering-wiring.test.js'
  )
  # The plugin runtime core (Update-Plan/accleration.md): the platform every plugin
  # is mounted through, asserted here for the same reason as the others.
  $coreTests = @(
    'core-model-capability.test.js',
    'core-plugin-runtime.test.js',
    'plugin-acceleration.test.js',
    'plugin-acceleration-cache.test.js',
    'plugin-acceleration-high-performance.test.js',
    'plugin-acceleration-mounted.test.js',
    'plugin-acceleration-parallel.test.js',
    'plugin-acceleration-patch-first.test.js',
    'plugin-acceleration-persistent-tools.test.js',
    'plugin-mounted-set.test.js',
    'plugin-ui-wiring.test.js',
    'official-frontend.test.js',
    'mega-features.test.js',
    'mega-feature-wiring.test.js',
    'mega-plugin-manager.test.js',
    'mega-plugin-store.test.js',
    'mega-store-github.test.js',
    'mega-store-installer.test.js',
    'plugin-store-mount.test.js',
    'plugin-compat.test.js',
    # The plugin adapter framework: the layer that turns an external plugin format into the
    # platform's own model. Asserted by name for the same reason as the rest: a renamed file must
    # fail the gate rather than silently drop the coverage of the isolation requirement.
    'plugin-adapters-contract.test.js',
    'plugin-adapters-detection.test.js',
    'plugin-adapters-lifecycle.test.js',
    'plugin-adapters-framework.test.js',
    'plugin-adapters-fault-injection.test.js',
    'plugin-adapters-compatibility.test.js',
    # The Cordis/DSH community adapter and its controlled bridge. The bridge suite is the one that
    # asserts a community plugin is handed no HNS Core object, so a renamed file here would drop
    # the coverage of a security-shaped claim rather than a feature.
    'plugin-cordis-structure.test.js',
    'plugin-cordis-bridge.test.js',
    'plugin-cordis-dsh.test.js',
    'ui-bilingual.test.js',
    'ui-layout-contract.test.js',
    'ui-panel-load.test.js',
    # The Appearance panel is the frosted-glass layer's control surface and the end of the dock's
    # skin, so its suite is asserted by name for the same reason as the others: a renamed file must
    # fail the gate rather than silently drop the coverage.
    'appearance-panel.test.js',
    'ui-glass.test.js'
  )
  foreach ($name in $coreTests) {
    if (-not (Test-Path (Join-Path "$ROOT\tests\unit" $name))) {
      Write-Error "missing plugin runtime test file: tests\unit\$name"
      exit 1
    }
  }
  foreach ($name in $engineeringTests) {
    if (-not (Test-Path (Join-Path "$ROOT\tests\unit" $name))) {
      Write-Error "missing engineering test file: tests\unit\$name"
      exit 1
    }
  }
  foreach ($name in $computerUseTests) {
    if (-not (Test-Path (Join-Path "$ROOT\tests\unit" $name))) {
      Write-Error "missing Computer Use test file: tests\unit\$name"
      exit 1
    }
  }
  $files = @(Get-ChildItem -LiteralPath "$ROOT\tests\unit" -Filter '*.test.js' -File | ForEach-Object { $_.FullName })
  if ($files.Count -lt ($computerUseTests.Count + $engineeringTests.Count + $coreTests.Count)) {
    Write-Error "the unit test directory holds fewer files than the required suites"
    exit 1
  }
  & $node --test --test-concurrency=2 $files 2>&1
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
