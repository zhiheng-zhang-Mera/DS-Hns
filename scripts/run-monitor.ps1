$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
$node = (Get-Command node).Source
if (-not $node) { throw 'Node.js not found' }
& $node "$ROOT\app\ui\server.js"
