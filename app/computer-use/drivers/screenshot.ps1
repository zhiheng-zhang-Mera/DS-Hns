<#
  Computer Use Runtime: screenshot fallback backend (plan section 4.2).

  This script is backend B of drivers/screenshot.cjs. It exists for the machines
  where the koffi/FFI backend cannot run at all - koffi arrives here as a
  transitive dependency, so "it is installed" is not something the driver may
  assume. Both backends implement the same two capture modes with the same
  Windows APIs, so the Node side sees one contract whichever one answered:

    regions and monitors -> System.Drawing Graphics.CopyFromScreen (BitBlt)
    windows              -> user32 PrintWindow with PW_RENDERFULLCONTENT,
                            because a window that is occluded or behind another
                            window still renders itself there, and a screen copy
                            of the same rectangle would capture the window on top
                            of it instead.

  Contract with the caller (screenshot.cjs), which is deliberately narrow:

    * exactly ONE line of JSON on stdout,
    * everything else - diagnostics, warnings, compiler noise - on stderr,
    * always `exit 0`, so the caller reads a JSON verdict instead of guessing
      what a PowerShell exit code meant.

  The request file is JSON: { op, rect?, handle?, path, timeoutMs? } where `path`
  is the absolute PNG the caller wants written and then reads back.

  Invoked as:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File screenshot.ps1 `
      -Request <request.json> -TimeoutMs <ms>
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Request,
  [int]$TimeoutMs = 15000
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 encodes redirected stdout with the OEM code page, which
# would turn a localized Windows/.NET error message into mojibake for the Node
# side that decodes stdout as UTF-8.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# The time bound is a budget, never a loop: every op below is a single GDI call
# that either returns or fails, so a deadline check before the capture is enough
# to keep a hung desktop from holding the caller's spawnSync slot open.
$script:DshTimeoutMs = [Math]::Max(1000, [Math]::Min(600000, $TimeoutMs))
$script:DshDeadline = [DateTime]::UtcNow.AddMilliseconds($script:DshTimeoutMs)
$script:DshCode = 'SCREENSHOT_FAILED'
$script:DshNativeReady = $false

function Write-DshLog {
  param([string]$Message)
  [Console]::Error.WriteLine("screenshot.ps1: $Message")
}

function Write-DshResponse {
  param([hashtable]$Payload)
  # ConvertTo-Json -Compress emits a single line, and writing it through
  # [Console]::Out keeps PowerShell's formatter from wrapping or decorating it.
  $json = ConvertTo-Json -InputObject $Payload -Depth 8 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Fail-Dsh {
  param([string]$Code, [string]$Message)
  $script:DshCode = $Code
  throw $Message
}

function Assert-DshTime {
  param([string]$Stage)
  if ([DateTime]::UtcNow -gt $script:DshDeadline) {
    Fail-Dsh 'CONTROLLER_TIMEOUT' "the $Stage did not start within the $($script:DshTimeoutMs) ms budget"
  }
}

function Initialize-DshNative {
  if ($script:DshNativeReady) { return }
  Add-Type -AssemblyName System.Drawing
  if (-not ('DshScreenshotNative' -as [type])) {
    # C# 5 only: Windows PowerShell 5.1 compiles this with the legacy CodeDom
    # compiler, so no interpolated strings, no expression-bodied members.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshScreenshotNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
}
'@
  }
  $script:DshNativeReady = $true
}

function Get-DshVirtualScreen {
  # SM_XVIRTUALSCREEN..SM_CYVIRTUALSCREEN: the virtual screen is the bounding box
  # of every monitor, so its origin is negative whenever a monitor sits left of or
  # above the primary one.
  return @{
    x      = [DshScreenshotNative]::GetSystemMetrics(76)
    y      = [DshScreenshotNative]::GetSystemMetrics(77)
    width  = [DshScreenshotNative]::GetSystemMetrics(78)
    height = [DshScreenshotNative]::GetSystemMetrics(79)
  }
}

function Get-DshPrimaryCentre {
  # SM_CXSCREEN/SM_CYSCREEN describe the primary monitor, whose origin is always
  # (0,0) - unlike the virtual screen, whose origin may be negative.
  $probeSize = 4
  $width = [DshScreenshotNative]::GetSystemMetrics(0)
  $height = [DshScreenshotNative]::GetSystemMetrics(1)
  if ($width -le 0 -or $height -le 0) {
    Fail-Dsh 'SCREENSHOT_FAILED' "GetSystemMetrics reported a ${width}x${height} primary monitor, which cannot be captured"
  }
  return @{
    # [int] alone would bank-round 853.5 up; the centre must be deterministic.
    x      = [int][Math]::Floor($width / 2) - [int]($probeSize / 2)
    y      = [int][Math]::Floor($height / 2) - [int]($probeSize / 2)
    width  = $probeSize
    height = $probeSize
  }
}

function Read-DshRect {
  param($Payload, [string]$Op, [bool]$Required = $true)
  $rect = $Payload.rect
  if ($null -eq $rect) {
    if ($Required) { Fail-Dsh 'CONTRACT_INVALID' "op '$Op' requires a rect with x, y, width and height" }
    return $null
  }
  foreach ($key in @('x', 'y', 'width', 'height')) {
    $value = $rect.$key
    if ($null -eq $value) { Fail-Dsh 'CONTRACT_INVALID' "op '$Op' requires rect.$key" }
    if (-not ($value -is [ValueType])) { Fail-Dsh 'CONTRACT_INVALID' "op '$Op' requires rect.$key to be a number, got '$value'" }
  }
  $result = @{
    x      = [int]$rect.x
    y      = [int]$rect.y
    width  = [int]$rect.width
    height = [int]$rect.height
  }
  if ($result.width -le 0 -or $result.height -le 0) {
    Fail-Dsh 'CONTRACT_INVALID' "op '$Op' got an empty rect $($result.width)x$($result.height)+$($result.x)+$($result.y)"
  }
  return $result
}

function Get-DshIntersection {
  param([hashtable]$Rect, [hashtable]$Screen)
  $x = [Math]::Max($Rect.x, $Screen.x)
  $y = [Math]::Max($Rect.y, $Screen.y)
  $right = [Math]::Min($Rect.x + $Rect.width, $Screen.x + $Screen.width)
  $bottom = [Math]::Min($Rect.y + $Rect.height, $Screen.y + $Screen.height)
  if ($right -le $x -or $bottom -le $y) { return $null }
  return @{ x = $x; y = $y; width = $right - $x; height = $bottom - $y }
}

# '800x600+100+50', the compact form Windows tools print rects in - the same
# format the Node side uses, so both sides of a failure read identically.
function Format-DshRect {
  param([hashtable]$Rect)
  return "$($Rect.width)x$($Rect.height)+$($Rect.x)+$($Rect.y)"
}

function Get-DshWindowRect {
  param([IntPtr]$Handle, [string]$HandleText)
  $native = New-Object 'DshScreenshotNative+RECT'
  if (-not [DshScreenshotNative]::GetWindowRect($Handle, [ref]$native)) {
    Fail-Dsh 'SCREENSHOT_FAILED' "GetWindowRect failed for window handle $HandleText"
  }
  return @{
    x      = $native.Left
    y      = $native.Top
    width  = $native.Right - $native.Left
    height = $native.Bottom - $native.Top
  }
}

function New-DshScreenBitmap {
  param([hashtable]$Rect, [string]$Stage)
  Assert-DshTime $Stage
  $bitmap = New-Object System.Drawing.Bitmap($Rect.width, $Rect.height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = $null
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $size = New-Object System.Drawing.Size($Rect.width, $Rect.height)
    # SourceCopy is SRCCOPY. CaptureBlt is deliberately not added: .NET validates
    # the enum and rejects the SRCCOPY|CAPTUREBLT combination that the koffi
    # backend uses, so layered windows are the one thing this fallback can miss.
    $graphics.CopyFromScreen($Rect.x, $Rect.y, 0, 0, $size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  } catch {
    $bitmap.Dispose()
    throw
  } finally {
    if ($graphics) { $graphics.Dispose() }
  }
  return $bitmap
}

function New-DshWindowBitmap {
  param([IntPtr]$Handle, [hashtable]$Rect, [string]$HandleText)
  Assert-DshTime "PrintWindow capture of window $HandleText"
  $bitmap = New-Object System.Drawing.Bitmap($Rect.width, $Rect.height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $hdc = $graphics.GetHdc()
      try {
        # PW_RENDERFULLCONTENT (2) makes PrintWindow ask the window to render its
        # full content instead of only the visible part of its frame.
        $rendered = [DshScreenshotNative]::PrintWindow($Handle, $hdc, 2)
      } finally {
        $graphics.ReleaseHdc($hdc)
      }
    } finally {
      $graphics.Dispose()
    }
    if (-not $rendered) {
      # PrintWindow answers 0 for windows that cannot render themselves right now
      # (minimized, ownerdraw-only, protected). The caller decides what that means.
      $bitmap.Dispose()
      return $null
    }
  } catch {
    $bitmap.Dispose()
    throw
  }
  return $bitmap
}

function Save-DshBitmap {
  param([System.Drawing.Bitmap]$Bitmap, [string]$Path)
  try {
    $directory = [System.IO.Path]::GetDirectoryName($Path)
    if ($directory -and -not [System.IO.Directory]::Exists($directory)) {
      [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    # Dispose before the caller reads the file, otherwise GDI+ keeps it locked.
    $Bitmap.Dispose()
  }
  # Reading the file back through Image.FromFile reports the dimensions of what
  # actually landed on disk (not of what we intended to write) and proves the
  # file is readable and unlocked before the caller is told it exists.
  $image = $null
  try {
    $image = [System.Drawing.Image]::FromFile($Path)
    return @{ width = [int]$image.Width; height = [int]$image.Height }
  } finally {
    if ($image) { $image.Dispose() }
  }
}

function Resolve-DshHandle {
  param($Payload)
  $text = $Payload.handle
  if ($null -eq $text -or "$text".Trim() -eq '') {
    Fail-Dsh 'TARGET_INVALID' "op 'window' requires a window handle"
  }
  $handleText = "$text".Trim()
  $value = [Int64]0
  if ($handleText -match '^0[xX][0-9a-fA-F]+$') {
    $value = [Convert]::ToInt64($handleText.Substring(2), 16)
  } elseif ($handleText -match '^\d+$') {
    $value = [Convert]::ToInt64($handleText)
  } else {
    Fail-Dsh 'TARGET_INVALID' "window handle '$handleText' is not a decimal or 0x-prefixed hexadecimal handle"
  }
  if ($value -le 0) { Fail-Dsh 'TARGET_INVALID' "window handle '$handleText' is not a valid handle" }
  return @{ text = $handleText; value = [IntPtr]$value }
}

$exitCode = 0
try {
  Initialize-DshNative

  $payload = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($Request, [System.Text.Encoding]::UTF8))
  $op = if ($null -eq $payload.op) { 'probe' } else { "$($payload.op)".ToLowerInvariant() }
  $path = if ($null -eq $payload.path) { $null } else { [string]$payload.path }
  if (-not $path) { Fail-Dsh 'CONTRACT_INVALID' 'the request must name an absolute PNG path to write' }
  $path = [System.IO.Path]::GetFullPath($path)
  if ($payload.timeoutMs -is [ValueType]) {
    $script:DshTimeoutMs = [Math]::Max(1000, [Math]::Min(600000, [int]$payload.timeoutMs))
    $script:DshDeadline = [DateTime]::UtcNow.AddMilliseconds($script:DshTimeoutMs)
  }

  $screen = Get-DshVirtualScreen
  if ($screen.width -le 0 -or $screen.height -le 0) {
    Fail-Dsh 'SCREENSHOT_FAILED' "GetSystemMetrics reported a $($screen.width)x$($screen.height) virtual screen, so there is no desktop to capture"
  }

  $rect = $null
  $minimized = $false
  $bitmap = $null
  $handleText = $null

  switch ($op) {
    'probe' {
      $rect = Read-DshRect -Payload $payload -Op $op -Required $false
      if ($null -eq $rect) { $rect = Get-DshPrimaryCentre }
      $rect = Get-DshIntersection -Rect $rect -Screen $screen
      if ($null -eq $rect) { Fail-Dsh 'SCREENSHOT_FAILED' 'the probe rect does not intersect the virtual screen' }
      $bitmap = New-DshScreenBitmap -Rect $rect -Stage 'probe capture'
    }
    'region' {
      $requested = Read-DshRect -Payload $payload -Op $op
      $rect = Get-DshIntersection -Rect $requested -Screen $screen
      if ($null -eq $rect) {
        Fail-Dsh 'SCREENSHOT_FAILED' "the requested region $(Format-DshRect -Rect $requested) does not intersect the virtual screen $(Format-DshRect -Rect $screen)"
      }
      $bitmap = New-DshScreenBitmap -Rect $rect -Stage 'region capture'
    }
    { $_ -eq 'monitor' -or $_ -eq 'full' -or $_ -eq 'screen' } {
      $requested = Read-DshRect -Payload $payload -Op $op -Required $false
      if ($null -eq $requested) { $requested = $screen }
      $rect = Get-DshIntersection -Rect $requested -Screen $screen
      if ($null -eq $rect) { Fail-Dsh 'SCREENSHOT_FAILED' 'the requested monitor rect does not intersect the virtual screen' }
      $bitmap = New-DshScreenBitmap -Rect $rect -Stage 'monitor capture'
    }
    'window' {
      $handle = Resolve-DshHandle -Payload $payload
      $handleText = $handle.text
      if (-not [DshScreenshotNative]::IsWindow($handle.value)) {
        Fail-Dsh 'TARGET_NOT_FOUND' "no window exists for handle $handleText"
      }
      $rect = Read-DshRect -Payload $payload -Op $op -Required $false
      if ($null -eq $rect) { $rect = Get-DshWindowRect -Handle $handle.value -HandleText $handleText }
      if ($rect.width -le 0 -or $rect.height -le 0) {
        Fail-Dsh 'SCREENSHOT_FAILED' "window $handleText reports an empty rect $($rect.width)x$($rect.height)+$($rect.x)+$($rect.y)"
      }
      $minimized = [DshScreenshotNative]::IsIconic($handle.value)
      $bitmap = New-DshWindowBitmap -Handle $handle.value -Rect $rect -HandleText $handleText
      if ($null -eq $bitmap) {
        if ($minimized) {
          # A minimized window sits far off-screen, so a screen copy of its rect
          # would return unrelated pixels. Saying so is the only honest answer.
          Fail-Dsh 'SCREENSHOT_FAILED' "PrintWindow could not render minimized window $handleText, and a screen copy of a minimized window's rect would capture unrelated pixels"
        }
        Write-DshLog "PrintWindow failed for window $handleText, falling back to a screen copy of its rect"
        $bitmap = New-DshScreenBitmap -Rect $rect -Stage "window fallback capture of $handleText"
      }
    }
    default {
      Fail-Dsh 'ACTION_UNSUPPORTED' "op '$op' is not one of probe, region, window or monitor"
    }
  }

  $size = Save-DshBitmap -Bitmap $bitmap -Path $path
  Write-DshResponse @{
    ok     = $true
    result = @{
      op            = $op
      path          = $path
      width         = $size.width
      height        = $size.height
      rect          = @{ x = $rect.x; y = $rect.y; width = $rect.width; height = $rect.height }
      virtualScreen = $screen
      minimized     = $minimized
    }
  }
} catch {
  Write-DshResponse @{
    ok    = $false
    error = $_.Exception.Message
    code  = $script:DshCode
  }
} finally {
  $exitCode = 0
}

exit $exitCode
