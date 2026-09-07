$ErrorActionPreference = 'Stop'
$outDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\sounds'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$sampleRate = 44100

function New-Sound([string]$name, [scriptblock]$toneFn, [double]$duration) {
  $samples = [int]([math]::Floor($duration * $sampleRate))
  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)
  $dataSize = $samples * 2
  $writer.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
  $writer.Write([int](36 + $dataSize))
  $writer.Write([System.Text.Encoding]::ASCII.GetBytes('WAVE'))
  $writer.Write([System.Text.Encoding]::ASCII.GetBytes('fmt '))
  $writer.Write([int]16)
  $writer.Write([int16]1)
  $writer.Write([int16]1)
  $writer.Write([int]$sampleRate)
  $writer.Write([int]($sampleRate * 2))
  $writer.Write([int16]2)
  $writer.Write([int16]16)
  $writer.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
  $writer.Write([int]$dataSize)
  for ($i = 0; $i -lt $samples; $i++) {
    $t = $i / $sampleRate
    $fade = [math]::Min(1.0, [math]::Min($t / 0.02, ($duration - $t) / 0.12))
    if ($fade -lt 0) { $fade = 0 }
    $v = [double](& $toneFn $t) * $fade * 0.7
    if ($v -gt 1) { $v = 1 } elseif ($v -lt -1) { $v = -1 }
    $writer.Write([int16]($v * 32767))
  }
  $writer.Flush()
  [System.IO.File]::WriteAllBytes((Join-Path $outDir $name), $stream.ToArray())
  $writer.Dispose()
  $stream.Dispose()
  Write-Output "generated $name"
}

# Completed: bright ascending two-note chime.
New-Sound 'completed.wav' { param($t)
  if ($t -lt 0.18) { [math]::Sin(2 * [math]::PI * 880 * $t) * 0.9 }
  else { [math]::Sin(2 * [math]::PI * 1174.66 * ($t - 0.18)) * 0.9 }
} 0.8

# Failed: low descending saw-like warning.
New-Sound 'failed.wav' { param($t)
  $freq = if ($t -lt 0.45) { 196 } else { 130.81 }
  $phase = ($t % (1 / $freq)) * $freq
  (2 * $phase - 1) * 0.8
} 1.0

# Interrupted: three mid pulses.
New-Sound 'interrupted.wav' { param($t)
  $pulse = [math]::Floor($t / 0.16)
  if ($pulse -ge 3) { return 0 }
  $local = $t - $pulse * 0.16
  if ($local -gt 0.11) { return 0 }
  $freq = if (($pulse % 2) -eq 0) { 440 } else { 523.25 }
  [math]::Sin(2 * [math]::PI * $freq * $t) * 0.75
} 0.62

Get-ChildItem -LiteralPath $outDir | Select-Object Name, Length
