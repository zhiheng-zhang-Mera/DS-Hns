# Generates assets\icon\ds-harness.ico :
#   黑色圆角方形 + 白色 "DS" (DeepSeek 风格) ,右下角叠加缩小版 Electron 原子环图标。
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
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $scale = $size / 256.0
  function PX([double]$v) { return [float]($v * $scale) }

  # 黑色圆角方块(近黑渐变感:底部略亮)
  $rectF = New-Object System.Drawing.RectangleF((PX 8), (PX 8), (PX 240), (PX 240))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = PX 46
  $path.AddArc($rectF.X, $rectF.Y, $r, $r, 180, 90)
  $path.AddArc($rectF.Right - $r, $rectF.Y, $r, $r, 270, 90)
  $path.AddArc($rectF.Right - $r, $rectF.Bottom - $r, $r, $r, 0, 90)
  $path.AddArc($rectF.X, $rectF.Bottom - $r, $r, $r, 90, 90)
  $path.CloseFigure()
  $lg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rectF, [System.Drawing.Color]::FromArgb(255, 30, 30, 38), [System.Drawing.Color]::FromArgb(255, 2, 2, 6), 90)
  $g.FillPath($lg, $path)

  # DeepSeek 风格白字 DS(大) + deepseek 小字
  $dsFont = New-Object System.Drawing.Font('Segoe UI', (PX 88), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $txtRect = New-Object System.Drawing.RectangleF((PX 10), (PX 46), (PX 236), (PX 128))
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 236, 240, 245))
  $g.DrawString('DS', $dsFont, $white, $txtRect, $sf)
  $subFont = New-Object System.Drawing.Font('Segoe UI', (PX 26), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $subRect = New-Object System.Drawing.RectangleF((PX 10), (PX 176), (PX 236), (PX 34))
  $grey = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 140, 152, 166))
  $g.DrawString('deepseek', $subFont, $grey, $subRect, $sf)

  # 右下角:缩小版 Electron 原子(圆环 x3 + 中心点 + 轨道点)
  $cx = PX 196; $cy = PX 190
  $atomPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 77, 163, 255), [float](PX 9))
  $penLite = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 150, 200, 255), [float](PX 6))
  $rx = PX 42; $ry = PX 15
  $g.DrawEllipse($atomPen, (PX(196 - 42)), (PX(190 - 15)), (PX 84), (PX 30))
  $g.DrawEllipse($penLite, (PX(196 - 30)), (PX(190 - 42)), (PX 60), (PX 84))
  $g.DrawEllipse($penLite, (PX(196 - 28)), (PX(190 - 28)), (PX 56), (PX 56))
  # 中心点 + 一个轨道电子点(高亮)
  $centerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 240, 245, 250))
  $g.FillEllipse($centerBrush, (PX(196 - 10)), (PX(190 - 10)), (PX 20), (PX 20))
  $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 120, 200, 255))
  $g.FillEllipse($dotBrush, (PX(230 - 12)), (PX(182 - 12)), (PX 24), (PX 24))

  $g.Dispose()
  return $bmp
}

# 预览 256
$p256 = New-IconBitmap 256
$pngPath = Join-Path $outDir 'ds-harness-256.png'
$p256.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

# 各尺寸 PNG(存内存)
$sizes = @(256, 128, 64, 48, 32, 16)
$pngs = @()
foreach ($s in $sizes) {
  $bmp = New-IconBitmap $s
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += , @($s, $ms.ToArray())
  $ms.Dispose()
  $bmp.Dispose()
}

# 写入 ICO(ICONDIR + PNG entries,Win Vista+ 支持)
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
  $bw.Write([uint32]$data.Length)
  $bw.Write([uint32]$offset)
  $offset += $data.Length
}
foreach ($item in $pngs) { $bw.Write($item[1]) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())
$bw.Dispose(); $out.Dispose()
$p256.Dispose()
Write-Output "generated $icoPath"
Get-ChildItem $outDir | Select-Object Name, Length
