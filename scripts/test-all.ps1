$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
$node = (Get-Command node).Source

$syntaxFiles = @(
  "$ROOT\app\desktop-main.cjs",
  "$ROOT\app\runtime-process.cjs",
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
  $files = @(Get-ChildItem -LiteralPath "$ROOT\tests\unit" -Filter '*.test.js' -File | ForEach-Object { $_.FullName })
  & $node --test $files 2>&1
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
