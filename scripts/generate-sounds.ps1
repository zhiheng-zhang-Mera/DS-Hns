# Regenerates the built-in ringtones under assets\sounds (git-tracked presets).
# Pure PowerShell WAV synthesizer: 44.1 kHz mono 16-bit.
#   defaults: completed.wav / failed.wav / interrupted.wav (per-event presets)
#   extras:   ding-soft, bell-clear, chime-major, alert-double, buzz-warn, pop-cheerful
$ErrorActionPreference = 'Stop'
$outDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\sounds'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$sampleRate = 44100

function New-Sound([string]$name, [scriptblock]$toneFn, [double]$duration) {
  $samples = [int][math]::Floor($duration * $sampleRate)
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

# --- defaults ---------------------------------------------------------------
# Completed: bright ascending two-note chime.
New-Sound 'completed.wav' { param($t)
  if ($t -lt 0.18) { [math]::Sin(2 * [math]::PI * 880 * $t) * 0.9 }
  else { [math]::Sin(2 * [math]::PI * 1174.66 * ($t - 0.18)) * 0.9 }
} 0.8

# Failed: low descending saw-like warning.
New-Sound 'failed.wav' { param($t)
  if ($t -lt 0.45) {
    $freq = 196
  } else {
    $freq = 130.81
  }
  $phase = ($t % (1 / $freq)) * $freq
  (2 * $phase - 1) * 0.8
} 1.0

# Interrupted: three mid pulses.
New-Sound 'interrupted.wav' { param($t)
  $pulse = [math]::Floor($t / 0.16)
  if ($pulse -ge 3) { return 0 }
  $local = $t - $pulse * 0.16
  if ($local -gt 0.11) { return 0 }
  if (($pulse % 2) -eq 0) { [math]::Sin(2 * [math]::PI * 440 * $t) * 0.75 }
  else { [math]::Sin(2 * [math]::PI * 523.25 * $t) * 0.75 }
} 0.62

# --- extra presets (可选铃声) -------------------------------------------------
# ding-soft: 柔和单音 (C6)
New-Sound 'ding-soft.wav' { param($t)
  [math]::Sin(2 * [math]::PI * 1046.5 * $t) * 0.85
} 0.55

# bell-clear: 清澈钟声 (E6 + 泛音)
New-Sound 'bell-clear.wav' { param($t)
  ([math]::Sin(2 * [math]::PI * 1318.51 * $t) * 0.9 +
   [math]::Sin(2 * [math]::PI * 2637.02 * $t) * 0.25) * 0.8
} 1.1

# chime-major: C5-E5-G5-C6 上行琶音(轻快完成)
New-Sound 'chime-major.wav' { param($t)
  $notes = @(523.25, 659.25, 783.99, 1046.5)
  $idx = [math]::Min([int][math]::Floor($t / 0.14), 3)
  $local = $t - $idx * 0.14
  if ($local -gt 0.13) { return 0 }
  [math]::Sin(2 * [math]::PI * $notes[$idx] * $t) * 0.85
} 0.9

# alert-double: 双短哔(提醒)
New-Sound 'alert-double.wav' { param($t)
  $pulse = [math]::Floor($t / 0.16)
  if ($pulse -ge 2) { return 0 }
  $local = $t - $pulse * 0.16
  if ($local -gt 0.12) { return 0 }
  [math]::Sin(2 * [math]::PI * 880 * $t) * 0.8
} 0.45

# buzz-warn: 低沉双音(失败备选)
New-Sound 'buzz-warn.wav' { param($t)
  if ($t -lt 0.4) {
    $freq = 155.56
  } else {
    $freq = 116.54
  }
  $phase = ($t % (1 / $freq)) * $freq
  (2 * $phase - 1) * 0.75
} 0.95

# pop-cheerful: 快速上扬双音
New-Sound 'pop-cheerful.wav' { param($t)
  if ($t -lt 0.14) { [math]::Sin(2 * [math]::PI * 660 * $t) * 0.85 }
  else { [math]::Sin(2 * [math]::PI * 990 * $t) * 0.85 }
} 0.5

Get-ChildItem -LiteralPath $outDir | Select-Object Name, Length
