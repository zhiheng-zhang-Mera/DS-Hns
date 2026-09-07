$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
$node = (Get-Command node).Source
Push-Location "$ROOT\tests"
try {
  $files = @(Get-ChildItem -LiteralPath "$ROOT\tests\unit" -Filter '*.test.js' -File | ForEach-Object { $_.FullName })
  & $node --test $files 2>&1
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
