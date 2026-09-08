$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
$node = (Get-Command node).Source

$syntaxFiles = @(
  "$ROOT\app\desktop-main.cjs",
  "$ROOT\app\extensions\manager.cjs",
  "$ROOT\app\extensions\mega\index.cjs",
  "$ROOT\app\extensions\mega\deepseek\official-session-client.js",
  "$ROOT\app\extensions\mega\scheduler\scheduler.js",
  "$ROOT\app\extensions\mega\scheduler\system.js",
  "$ROOT\app\extensions\mega\ui\preload.cjs",
  "$ROOT\app\extensions\mega\ui\renderer.js",
  "$ROOT\app\extensions\mega\ui\dock.js"
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
