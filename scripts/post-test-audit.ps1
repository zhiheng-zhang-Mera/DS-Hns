param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$StartedAtUtc,
  [string]$ReportPath = '',
  [int[]]$ExcludeProcessId = @()
)

$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
$started = [DateTime]::Parse($StartedAtUtc).ToUniversalTime()

# POST_TEST_PROCESS_LEAK_GATE: no Node/Electron process whose command line names
# this checkout may survive a qualification run.
$processLeaks = @(
  Get-CimInstance Win32_Process -ErrorAction Stop |
    Where-Object {
      $_.ProcessId -ne $PID -and
      $_.ProcessId -notin $ExcludeProcessId -and
      $_.Name -match '^(node|electron)(\.exe)?$' -and
      [string]$_.CommandLine -like "*$workspace*"
    } |
    Select-Object ProcessId, Name, CommandLine
)

# C_DRIVE_WRITE_AUDIT: env.ps1 redirects controllable writes to the task's D:
# roots. Inspect the real Windows LocalAppData tree for project-shaped entries
# modified during this test run, independent of the process-local redirection.
$realLocalAppData = [Environment]::GetFolderPath('LocalApplicationData')
$projectPattern = '(?i)(^|[-_.])(dsh|dshns|ds-hns|ds-harness|hns)([-_.]|$)'
$cWrites = @()
if ($realLocalAppData -and ([System.IO.Path]::GetPathRoot($realLocalAppData) -ieq 'C:\')) {
  $auditParents = @($realLocalAppData, (Join-Path $realLocalAppData 'Temp'))
  foreach ($parent in $auditParents) {
    if (-not (Test-Path -LiteralPath $parent)) { continue }
    $cWrites += @(
      Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue |
        Where-Object {
          $_.Name -match $projectPattern -and $_.LastWriteTimeUtc -ge $started
        } |
        Select-Object FullName, LastWriteTimeUtc, PSIsContainer
    )
  }
}

$report = [ordered]@{
  startedAtUtc = $started.ToString('o')
  finishedAtUtc = [DateTime]::UtcNow.ToString('o')
  root = $workspace
  gates = [ordered]@{
    POST_TEST_PROCESS_LEAK_GATE = if ($processLeaks.Count -eq 0) { 'PASS' } else { 'FAIL' }
    C_DRIVE_WRITE_AUDIT = if ($cWrites.Count -eq 0) { 'PASS' } else { 'FAIL' }
  }
  processLeaks = @($processLeaks)
  cDriveWrites = @($cWrites)
}

if ($ReportPath) {
  $reportFile = [System.IO.Path]::GetFullPath($ReportPath)
  $reportDir = Split-Path -Parent $reportFile
  New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportFile -Encoding UTF8
}

Write-Host "  POST_TEST_PROCESS_LEAK_GATE: $($report.gates.POST_TEST_PROCESS_LEAK_GATE)"
Write-Host "  C_DRIVE_WRITE_AUDIT: $($report.gates.C_DRIVE_WRITE_AUDIT)"
if ($processLeaks.Count -gt 0) {
  $processLeaks | Format-Table -AutoSize | Out-String | Write-Host
  throw 'POST_TEST_PROCESS_LEAK_GATE failed.'
}
if ($cWrites.Count -gt 0) {
  $cWrites | Format-Table -AutoSize | Out-String | Write-Host
  throw 'C_DRIVE_WRITE_AUDIT failed.'
}
