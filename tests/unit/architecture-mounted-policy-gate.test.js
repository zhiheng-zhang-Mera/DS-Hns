'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..', '..')
const verify = fs.readFileSync(path.join(root, 'scripts/verify.ps1'), 'utf8')
const gate = verify.split(/\r?\n/).find(line => line.startsWith("Check 'Both built-in plugins are part of the shipped set, mounted through the one adapter' "))
assert.ok(gate, 'the mounted-plugin architecture check must exist')

// Execute the actual PowerShell gate with controlled source inputs. The mutation
// cases catch a gate weakened to mere factory-name presence or default config.
const cases = [
  { name: 'current shipped policy wiring', want: true },
  { name: 'missing Health factory', from: 'healthSchedulerPlugin(', to: 'missingHealth(', want: false },
  { name: 'missing Restart factory', from: 'restartSupervisorPlugin(', to: 'missingRestart(', want: false },
  { name: 'Health silently uses defaults', from: 'healthSchedulerPlugin({ config: options.healthConfig })', to: 'healthSchedulerPlugin()', want: false },
  { name: 'Restart loses owner policy', from: 'config: options.restartConfig', to: 'config: undefined', want: false },
  { name: 'policies are swapped', from: 'config: options.healthConfig', to: 'config: options.restartConfig', want: false }
]
const encodedCases = Buffer.from(JSON.stringify(cases), 'utf8').toString('base64')
const command = `
$ErrorActionPreference = 'Stop'
function Check([string]$label, [bool]$ok) { $ok }
$cases = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedCases}')) | ConvertFrom-Json
$source = Get-Content -LiteralPath '${path.join(root, 'app/plugins/mounted/index.cjs').replace(/'/g, "''")}' -Raw
$results = @(foreach ($case in $cases) {
  $mountedIndex = $source
  if ($case.from) {
    if (-not $source.Contains($case.from)) { throw 'Mutation no longer matches its input' }
    $mountedIndex = $source.Replace($case.from, $case.to)
  }
  ${gate}
})
ConvertTo-Json -Compress -InputObject $results
`
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
  encoding: 'utf8', windowsHide: true, timeout: 30_000
})
assert.equal(result.status, 0, result.stderr || result.error?.message)
const observed = JSON.parse(result.stdout.trim())
for (const [index, fixture] of cases.entries()) {
  test(`mounted architecture gate: ${fixture.name}`, () => {
    assert.equal(observed[index], fixture.want, fixture.name)
  })
}
