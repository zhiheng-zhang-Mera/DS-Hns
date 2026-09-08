# Generates assets\icon\ds-harness.ico from <repo root>\icon.jpg:
#   a multi-size PNG-based ICO (256/128/64/48/32/16) plus a 256px PNG preview.
# scripts\shortcuts.ps1 (the launcher shortcuts) and the Electron tray icon all
# reference assets\icon\ds-harness.ico, so regenerating this file is what turns
# icon.jpg into the launcher icon.
# Windows PowerShell 5.1 compatible and ASCII-only.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $scriptDir
$outDir = Join-Path $root 'assets\icon'
$sourcePath = Join-Path $root 'icon.jpg'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "Source image not found: $sourcePath (place icon.jpg in the repo root)"
}

$source = [System.Drawing.Image]::FromFile($sourcePath)
try {
  function New-ScaledBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.Clear([System.Drawing.Color]::White)
      $g.DrawImage($source, 0, 0, $size, $size)
    } finally {
      $g.Dispose()
    }
    return $bmp
  }

  $sizes = @(256, 128, 64, 48, 32, 16)
  $pngs = @()
  foreach ($s in $sizes) {
    $bmp = New-ScaledBitmap $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $data = $ms.ToArray()
    $ms.Dispose()
    $bmp.Dispose()
    $pngs += , @($s, $data)
    if ($s -eq 256) {
      [System.IO.File]::WriteAllBytes((Join-Path $outDir 'ds-harness-256.png'), $data)
    }
  }

  $icoPath = Join-Path $outDir 'ds-harness.ico'
  $count = $pngs.Count
  $out = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($out)
  $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$count)
  $offset = 6 + 16 * $count
  foreach ($item in $pngs) {
    $s = $item[0]; $data = $item[1]
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$data.Length); $bw.Write([uint32]$offset)
    $offset += $data.Length
  }
  foreach ($item in $pngs) { $bw.Write($item[1]) }
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())
  $bw.Dispose(); $out.Dispose()

  Write-Output "generated $icoPath from $sourcePath"
} finally {
  $source.Dispose()
}
