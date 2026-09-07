# Generates assets\icon\ds-harness.ico :
#   透明背景 + 黑色 DeepSeek 鲸鱼(右向剪影,带白瞳)+ 右下角缩小版 Electron 粒子(原子环)。
# Outputs ds-harness.ico (多尺寸 PNG-based ICO) + ds-harness-256.png 预览。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $scriptDir
$outDir = Join-Path $root 'assets\icon'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent) # 透明背景

  $s = $size / 256.0
  function PX([double]$v) { [float]($v * $s) }
  function PT([double]$x, [double]$y) { return [System.Drawing.PointF]::new([float]($x * $s), [float]($y * $s)) }

  $black = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 10, 10, 10))
  $whiteEye = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 250, 250, 250))
  $atomPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, 63, 161, 255), [float](PX 4.2))
  $dotBlue = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 110, 190, 255))

  # ---- 鲸鱼剪影(右向) ----
  $whale = New-Object System.Drawing.Drawing2D.GraphicsPath
  $w = @(
    (PT 26 128), (PT 66 92), (PT 132 76), (PT 198 108),
    (PT 240 122), (PT 242 158), (PT 200 172),
    (PT 168 200), (PT 96 196), (PT 44 182),
    (PT 24 168), (PT 22 150), (PT 26 138)
  )
  $whale.AddBezier($w[0], $w[1], $w[2], $w[3])
  $whale.AddBezier($w[3], $w[4], $w[5], $w[6])
  $whale.AddBezier($w[6], $w[7], $w[8], $w[9])
  $whale.AddBezier($w[9], $w[10], $w[11], $w[12])
  $whale.CloseFigure()
  $g.FillPath($black, $whale)

  # 尾鳍缺口:让剪影更像鲸鱼
  $notch = New-Object System.Drawing.Drawing2D.GraphicsPath
  $nt = @(
    (PT 60 126), (PT 48 116), (PT 40 158), (PT 74 148),
    (PT 62 156), (PT 66 166), (PT 54 166),
    (PT 72 136), (PT 66 118)
  )
  $notch.AddBezier($nt[0], $nt[1], $nt[2], $nt[3])
  $notch.AddBezier($nt[3], $nt[4], $nt[5], $nt[6])
  $notch.AddBezier($nt[6], $nt[7], $nt[8], $nt[0])
  $notch.CloseFigure()
  $g.FillPath($black, $notch)

  # 眼睛(白点,增强辨识)
  $g.FillEllipse($whiteEye, (PX 196), (PX 118), (PX 16), (PX 16))

  # ---- 右下角:缩小版 Electron 粒子(透明底上可见的原子环) ----
  $g.DrawEllipse($atomPen, (PX 182), (PX 210), (PX 52), (PX 16))
  $g.DrawEllipse($atomPen, (PX 200), (PX 192), (PX 16), (PX 52))
  $g.DrawEllipse($atomPen, (PX 194), (PX 204), (PX 28), (PX 28))
  $g.FillEllipse($dotBlue, (PX 204), (PX 214), (PX 8), (PX 8))
  $g.FillEllipse($dotBlue, (PX 201), (PX 197), (PX 6), (PX 6))

  $g.Dispose()
  return $bmp
}

# 预览 256
$p256 = New-IconBitmap 256
$pngPath = Join-Path $outDir 'ds-harness-256.png'
$p256.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$sizes = @(256, 128, 64, 48, 32, 16)
$pngs = @()
foreach ($s in $sizes) {
  $bmp = New-IconBitmap $s
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += , @($s, $ms.ToArray())
  $ms.Dispose(); $bmp.Dispose()
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
$bw.Dispose(); $out.Dispose(); $p256.Dispose()
Write-Output "generated $icoPath"
