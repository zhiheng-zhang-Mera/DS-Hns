# Start only the Node 调度中心 monitor (no Electron window, no dsh Web engine).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
$node = (Get-Command node).Source
if (-not $node) { throw 'Node.js not found' }
& $node "$ROOT\app\monitor\ui\server.js"
