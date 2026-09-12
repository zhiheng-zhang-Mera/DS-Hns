<#
  win32-input.ps1 - the PowerShell fallback backend for computer-use/drivers/win32.cjs.

  WHY THIS EXISTS
  The primary desktop backend talks to user32/kernel32 through koffi FFI, but
  koffi is only a transitive dependency of this repository: on a machine where
  it was pruned, deduped away or failed to build, a desktop controller must
  still be able to see windows and send input. PowerShell 5.1 ships with every
  supported Windows and can P/Invoke the same functions, so it is the fallback
  and never the primary - it costs one process spawn per operation.

  PROTOCOL
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File win32-input.ps1 -Request <jsonFile>
  The request file is UTF-8 JSON: {"op":"listWindows", ...}. Exactly one line of
  JSON is written to stdout: {"ok":true,"result":...} or
  {"ok":false,"error":"...","code":"..."}. The exit code is always 0 because the
  caller parses the JSON, not the status; a host that dies without printing a
  response is reported by the caller as a missing response, never as success.

  Every coordinate in a request and in a response is an integer in PHYSICAL
  pixels. Absolute mouse input is normalised to the 0..65535 virtual-desktop
  space internally, because that is the only form SendInput accepts together
  with MOUSEEVENTF_ABSOLUTE.

  The struct plumbing (the INPUT union) lives in the C# below on purpose:
  mutating nested value-type fields from PowerShell is fragile, while C# gets
  the layout right for the actual process bitness for free.
#>
[CmdletBinding()]
param(
  [string]$Request = ''
)

$ErrorActionPreference = 'Stop'

# Without this, PowerShell 5.1 encodes redirected stdout with the OEM code page
# and every non-ASCII window title reaches Node as mojibake.
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
  # A host without a console keeps its default encoding; ASCII survives anyway.
}

$nativeSource = @'
using System;
using System.Collections;
using System.Runtime.InteropServices;
using System.Text;

public static class DshWin32
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr lprcMonitor, IntPtr dwData);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, ref RECT lpRect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
    private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

    public static IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex)
    {
        if (IntPtr.Size == 8) return GetWindowLongPtr64(hWnd, nIndex);
        return new IntPtr(GetWindowLong32(hWnd, nIndex));
    }

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool OpenClipboard(IntPtr hWndNewOwner);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EmptyClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetClipboardData(uint uFormat);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalFree(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalLock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GlobalUnlock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool QueryFullProcessImageName(IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref uint lpdwSize);

    public const uint CF_UNICODETEXT = 13;
    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x1000;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;

    public static INPUT MouseInput(int dx, int dy, int mouseData, uint flags)
    {
        INPUT input = new INPUT();
        input.type = 0;
        input.u.mi.dx = dx;
        input.u.mi.dy = dy;
        input.u.mi.mouseData = (uint)mouseData;
        input.u.mi.dwFlags = flags;
        return input;
    }

    public static INPUT KeyInput(int virtualKey, int scanCode, uint flags)
    {
        INPUT input = new INPUT();
        input.type = 1;
        input.u.ki.wVk = (ushort)virtualKey;
        input.u.ki.wScan = (ushort)scanCode;
        input.u.ki.dwFlags = flags;
        return input;
    }

    /** Sends one batch and reports how many events the OS actually accepted. */
    public static uint Send(IList inputs)
    {
        if (inputs == null || inputs.Count == 0) return 0;
        INPUT[] array = new INPUT[inputs.Count];
        for (int i = 0; i < inputs.Count; i++) array[i] = (INPUT)inputs[i];
        return SendInput((uint)array.Length, array, Marshal.SizeOf(typeof(INPUT)));
    }

    public static int InputSize() { return Marshal.SizeOf(typeof(INPUT)); }

    public static string GetClipboardText()
    {
        if (!OpenClipboard(IntPtr.Zero)) throw new InvalidOperationException("OpenClipboard failed: another process is holding the clipboard");
        try
        {
            IntPtr handle = GetClipboardData(CF_UNICODETEXT);
            if (handle == IntPtr.Zero) return string.Empty;
            IntPtr pointer = GlobalLock(handle);
            if (pointer == IntPtr.Zero) return string.Empty;
            try { return Marshal.PtrToStringUni(pointer); }
            finally { GlobalUnlock(handle); }
        }
        finally { CloseClipboard(); }
    }

    public static void SetClipboardText(string text)
    {
        if (text == null) throw new ArgumentNullException("text");
        int bytes = (text.Length + 1) * 2;
        IntPtr handle = GlobalAlloc(0x0042, new UIntPtr((ulong)bytes));
        if (handle == IntPtr.Zero) throw new InvalidOperationException("GlobalAlloc failed for the clipboard buffer");
        bool handedOver = false;
        try
        {
            IntPtr pointer = GlobalLock(handle);
            if (pointer == IntPtr.Zero) throw new InvalidOperationException("GlobalLock failed for the clipboard buffer");
            try
            {
                Marshal.Copy(text.ToCharArray(), 0, pointer, text.Length);
                Marshal.WriteInt16(pointer, text.Length * 2, 0);
            }
            finally { GlobalUnlock(handle); }
            if (!OpenClipboard(IntPtr.Zero)) throw new InvalidOperationException("OpenClipboard failed: another process is holding the clipboard");
            try
            {
                if (!EmptyClipboard()) throw new InvalidOperationException("EmptyClipboard failed");
                if (SetClipboardData(CF_UNICODETEXT, handle) == IntPtr.Zero) throw new InvalidOperationException("SetClipboardData failed");
                handedOver = true;
            }
            finally { CloseClipboard(); }
        }
        finally
        {
            // After a successful SetClipboardData the clipboard owns the block.
            if (!handedOver) GlobalFree(handle);
        }
    }
}
'@

$script:VkTable = @{
  'backspace' = 0x08; 'tab' = 0x09; 'enter' = 0x0D; 'return' = 0x0D
  'shift' = 0x10; 'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'menu' = 0x12
  'pause' = 0x13; 'capslock' = 0x14; 'esc' = 0x1B; 'escape' = 0x1B
  'space' = 0x20; 'pageup' = 0x21; 'pagedown' = 0x22; 'end' = 0x23; 'home' = 0x24
  'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
  'printscreen' = 0x2C; 'insert' = 0x2D; 'delete' = 0x2E; 'del' = 0x2E
  'win' = 0x5B; 'lwin' = 0x5B; 'rwin' = 0x5C; 'apps' = 0x5D
  'numlock' = 0x90; 'scrolllock' = 0x91
  ';' = 0xBA; '=' = 0xBB; ',' = 0xBC; '-' = 0xBD; '.' = 0xBE; '/' = 0xBF
  '`' = 0xC0; '[' = 0xDB; '\' = 0xDC; ']' = 0xDD; "'" = 0xDE
}

function Get-VirtualKey {
  param([string]$Name)
  if ([string]::IsNullOrEmpty($Name)) { throw 'empty key name' }
  $key = $Name.Trim().ToLowerInvariant()
  if ($script:VkTable.ContainsKey($key)) { return [int]$script:VkTable[$key] }
  if ($key.Length -eq 1) {
    $code = [int][char]$key
    if ($code -ge 97 -and $code -le 122) { return $code - 32 }
    if ($code -ge 48 -and $code -le 57) { return $code }
    if ($code -eq 32) { return 0x20 }
  }
  if ($key -match '^f([1-9]|1[0-2])$') { return 0x6F + [int]$Matches[1] }
  if ($key -match '^numpad([0-9])$') { return 0x60 + [int]$Matches[1] }
  throw "unsupported key name: $Name"
}

function Test-ModifierKey {
  param([string]$Name)
  $key = $Name.Trim().ToLowerInvariant()
  return ($key -eq 'ctrl' -or $key -eq 'control' -or $key -eq 'alt' -or $key -eq 'shift' -or
    $key -eq 'win' -or $key -eq 'lwin' -or $key -eq 'rwin')
}

function Get-Prop {
  param($Object, [string]$Name, $Default = $null)
  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Default }
  return $property.Value
}

function Get-IntProp {
  param($Object, [string]$Name, [int]$Default = 0)
  $value = Get-Prop -Object $Object -Name $Name -Default $null
  if ($null -eq $value) { return $Default }
  $parsed = 0
  if ([int]::TryParse([string]$value, [ref]$parsed)) { return $parsed }
  return $Default
}

function Get-Handle {
  param($Object, [string]$Name)
  $value = Get-Prop -Object $Object -Name $Name -Default $null
  if ($null -eq $value) { throw "$Name is required" }
  $parsed = [int64]0
  if (-not [int64]::TryParse([string]$value, [ref]$parsed)) { throw "$Name is not a window handle: $value" }
  $handle = [IntPtr]::new($parsed)
  if ($handle -eq [IntPtr]::Zero -or -not [DshWin32]::IsWindow($handle)) { throw "no such window: $parsed" }
  return $handle
}

function Get-WindowText {
  param([IntPtr]$Handle)
  $buffer = New-Object System.Text.StringBuilder 1024
  [void][DshWin32]::GetWindowText($Handle, $buffer, $buffer.Capacity)
  return $buffer.ToString()
}

function Get-WindowClass {
  param([IntPtr]$Handle)
  $buffer = New-Object System.Text.StringBuilder 512
  [void][DshWin32]::GetClassName($Handle, $buffer, $buffer.Capacity)
  return $buffer.ToString()
}

function Get-ProcessName {
  param([int]$ProcessId)
  $handle = [DshWin32]::OpenProcess(0x1000, $false, [uint32]$ProcessId)
  if ($handle -eq [IntPtr]::Zero) { return $null }
  try {
    $buffer = New-Object System.Text.StringBuilder 1024
    $size = [uint32]$buffer.Capacity
    if ([DshWin32]::QueryFullProcessImageName($handle, 0, $buffer, [ref]$size)) { return $buffer.ToString() }
    return $null
  } finally {
    [void][DshWin32]::CloseHandle($handle)
  }
}

function Get-RectObject {
  param($Rect)
  return @{
    x = [int]$Rect.Left
    y = [int]$Rect.Top
    width = [int]($Rect.Right - $Rect.Left)
    height = [int]($Rect.Bottom - $Rect.Top)
  }
}

function Get-DshWindowInfo {
  param([IntPtr]$Handle, [IntPtr]$Foreground)
  $rect = [DshWin32+RECT]::new()
  [void][DshWin32]::GetWindowRect($Handle, [ref]$rect)
  $processId = [uint32]0
  [void][DshWin32]::GetWindowThreadProcessId($Handle, [ref]$processId)
  return @{
    handle = $Handle.ToInt64().ToString()
    title = Get-WindowText -Handle $Handle
    className = Get-WindowClass -Handle $Handle
    processId = [int]$processId
    processName = Get-ProcessName -ProcessId ([int]$processId)
    bounds = Get-RectObject -Rect $rect
    visible = [bool][DshWin32]::IsWindowVisible($Handle)
    minimized = [bool][DshWin32]::IsIconic($Handle)
    foreground = ($Handle -eq $Foreground)
    ownerHandle = [DshWin32]::GetWindow($Handle, 4).ToInt64().ToString()
  }
}

# The same filtering rules as the koffi backend, for the same reason: the shell
# and the XAML hosts keep a pile of visible, titled, non-interactive windows
# around, and a controller that lists them sees phantom targets. The three
# include flags exist so that waiting for a window that is still untitled or
# still invisible works on this backend too.
function Test-KeepWindow {
  param(
    [IntPtr]$Handle,
    [string]$ClassName,
    [string]$Title,
    [bool]$IncludeUntitled = $false,
    [bool]$IncludeToolWindows = $false,
    [bool]$IncludeInvisible = $false
  )
  if (-not $IncludeInvisible -and -not [DshWin32]::IsWindowVisible($Handle)) { return $false }
  if (-not $IncludeUntitled -and [string]::IsNullOrWhiteSpace($Title)) { return $false }
  if ($ClassName -eq 'Progman' -or $ClassName -eq 'WorkerW') { return $false }
  if ($ClassName -eq 'Shell_TrayWnd' -or $ClassName -eq 'Shell_SecondaryTrayWnd') { return $false }
  if ($ClassName -eq 'Windows.UI.Core.CoreWindow') { return $false }
  if ($ClassName -eq 'Windows.UI.Composition.DesktopWindowContentBridge') { return $false }
  if ($ClassName -eq 'ForegroundStaging' -or $ClassName -eq 'MultitaskingViewFrame') { return $false }
  if ($ClassName -eq 'XamlExplorerHostIslandWindow' -or $ClassName -eq 'SysShadow') { return $false }
  try {
    $exStyle = [DshWin32]::GetWindowLongPtr($Handle, -20).ToInt64()
    if (-not $IncludeToolWindows -and ($exStyle -band 0x00000080) -ne 0) { return $false } # WS_EX_TOOLWINDOW
  } catch {
    # An unknown extended style is not a reason to hide a real window.
  }
  return $true
}

function Get-DshWindowList {
  param(
    [bool]$IncludeUntitled = $false,
    [bool]$IncludeToolWindows = $false,
    [bool]$IncludeInvisible = $false
  )
  $windows = New-Object System.Collections.ArrayList
  $foreground = [DshWin32]::GetForegroundWindow()
  $callback = [DshWin32+EnumWindowsProc] {
    param([IntPtr]$Handle, [IntPtr]$Param)
    try {
      $title = Get-WindowText -Handle $Handle
      $className = Get-WindowClass -Handle $Handle
      if (Test-KeepWindow -Handle $Handle -ClassName $className -Title $title -IncludeUntitled $IncludeUntitled -IncludeToolWindows $IncludeToolWindows -IncludeInvisible $IncludeInvisible) {
        [void]$windows.Add((Get-DshWindowInfo -Handle $Handle -Foreground $foreground))
      }
    } catch {
      # A window can die between EnumWindows and the property reads; skipping it
      # is correct, aborting the whole listing is not.
    }
    return $true
  }
  [void][DshWin32]::EnumWindows($callback, [IntPtr]::Zero)
  return $windows
}

function Get-DshScreenMetrics {
  $virtual = @{
    x = [DshWin32]::GetSystemMetrics(76)
    y = [DshWin32]::GetSystemMetrics(77)
    width = [DshWin32]::GetSystemMetrics(78)
    height = [DshWin32]::GetSystemMetrics(79)
  }
  $monitors = New-Object System.Collections.ArrayList
  $callback = [DshWin32+MonitorEnumProc] {
    param([IntPtr]$Monitor, [IntPtr]$Hdc, [IntPtr]$Clip, [IntPtr]$Param)
    $info = [DshWin32+MONITORINFO]::new()
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DshWin32+MONITORINFO])
    if ([DshWin32]::GetMonitorInfo($Monitor, [ref]$info)) {
      [void]$monitors.Add(@{
        handle = $Monitor.ToInt64().ToString()
        bounds = Get-RectObject -Rect $info.rcMonitor
        workArea = Get-RectObject -Rect $info.rcWork
        primary = (($info.dwFlags -band 1) -ne 0)
      })
    }
    return $true
  }
  [void][DshWin32]::EnumDisplayMonitors([IntPtr]::Zero, [IntPtr]::Zero, $callback, [IntPtr]::Zero)
  $cursor = [DshWin32+POINT]::new()
  [void][DshWin32]::GetCursorPos([ref]$cursor)
  return @{
    virtualScreen = $virtual
    primary = @{
      x = 0
      y = 0
      width = [DshWin32]::GetSystemMetrics(0)
      height = [DshWin32]::GetSystemMetrics(1)
    }
    monitors = @($monitors)
    cursor = @{ x = [int]$cursor.X; y = [int]$cursor.Y }
    metrics = @{
      screenWidth = [DshWin32]::GetSystemMetrics(0)
      screenHeight = [DshWin32]::GetSystemMetrics(1)
      monitorCount = [DshWin32]::GetSystemMetrics(80)
    }
  }
}

# MOUSEEVENTF_ABSOLUTE wants a fraction of the virtual desktop, not a pixel.
function ConvertTo-AbsolutePoint {
  param([int]$X, [int]$Y)
  $metrics = Get-DshScreenMetrics
  $virtual = $metrics.virtualScreen
  $width = [Math]::Max(1, [int]$virtual.width - 1)
  $height = [Math]::Max(1, [int]$virtual.height - 1)
  $nx = [int][Math]::Round((($X - [int]$virtual.x) * 65535.0) / $width)
  $ny = [int][Math]::Round((($Y - [int]$virtual.y) * 65535.0) / $height)
  if ($nx -lt 0) { $nx = 0 }
  if ($nx -gt 65535) { $nx = 65535 }
  if ($ny -lt 0) { $ny = 0 }
  if ($ny -gt 65535) { $ny = 65535 }
  return @{ x = $nx; y = $ny }
}

function New-MouseEntry {
  param([int]$Dx, [int]$Dy, [int]$MouseData, [uint32]$Flags)
  return [DshWin32]::MouseInput($Dx, $Dy, $MouseData, $Flags)
}

# Extended keys (arrows, the navigation cluster, the Win keys, numlock) must
# carry KEYEVENTF_EXTENDEDKEY, or applications see their numpad twin instead.
function Test-ExtendedKey {
  param([int]$VirtualKey)
  if ($VirtualKey -ge 0x21 -and $VirtualKey -le 0x2E) { return $true }
  if ($VirtualKey -eq 0x5B -or $VirtualKey -eq 0x5C -or $VirtualKey -eq 0x5D) { return $true }
  if ($VirtualKey -eq 0x90) { return $true }
  return $false
}

function New-KeyEntry {
  param([int]$VirtualKey, [bool]$KeyUp)
  $flags = [uint32]0
  if ($KeyUp) { $flags = $flags -bor [DshWin32]::KEYEVENTF_KEYUP }
  if (Test-ExtendedKey -VirtualKey $VirtualKey) { $flags = $flags -bor [DshWin32]::KEYEVENTF_EXTENDEDKEY }
  $scan = [int][DshWin32]::MapVirtualKey([uint32]$VirtualKey, 0)
  return [DshWin32]::KeyInput($VirtualKey, $scan, $flags)
}

function Send-DshInputs {
  param($Entries)
  $list = @($Entries)
  if ($list.Count -eq 0) { return 0 }
  $sent = [DshWin32]::Send([System.Collections.ArrayList]$list)
  if ($sent -ne $list.Count) {
    throw "SendInput accepted $sent of $($list.Count) events (a UIPI/UAC boundary or a locked workstation rejects injected input)"
  }
  return $sent
}

function Send-DshKeyPress {
  param([string]$Key, [string]$Action = 'press')
  $virtualKey = Get-VirtualKey -Name $Key
  $entries = New-Object System.Collections.ArrayList
  if ($Action -eq 'down') {
    [void]$entries.Add((New-KeyEntry -VirtualKey $virtualKey -KeyUp $false))
  } elseif ($Action -eq 'up') {
    [void]$entries.Add((New-KeyEntry -VirtualKey $virtualKey -KeyUp $true))
  } else {
    [void]$entries.Add((New-KeyEntry -VirtualKey $virtualKey -KeyUp $false))
    [void]$entries.Add((New-KeyEntry -VirtualKey $virtualKey -KeyUp $true))
  }
  [void](Send-DshInputs -Entries $entries)
  return $true
}

# The caller composes the event order (see composeHotkey in win32.cjs) and this
# only executes it, so the ordering rule lives in exactly one language.
function Send-DshKeySequence {
  param($Sequence)
  $entries = New-Object System.Collections.ArrayList
  foreach ($step in @($Sequence)) {
    $action = [string](Get-Prop -Object $step -Name 'action' -Default 'tap')
    $vk = Get-IntProp -Object $step -Name 'vk' -Default 0
    if ($vk -le 0) { $vk = Get-VirtualKey -Name ([string](Get-Prop -Object $step -Name 'key' -Default '')) }
    if ($action -eq 'down') {
      [void]$entries.Add((New-KeyEntry -VirtualKey $vk -KeyUp $false))
    } elseif ($action -eq 'up') {
      [void]$entries.Add((New-KeyEntry -VirtualKey $vk -KeyUp $true))
    } elseif ($action -eq 'tap') {
      [void]$entries.Add((New-KeyEntry -VirtualKey $vk -KeyUp $false))
      [void]$entries.Add((New-KeyEntry -VirtualKey $vk -KeyUp $true))
    } else {
      throw "unsupported key action: $action"
    }
  }
  $sent = Send-DshInputs -Entries $entries
  return @{ sent = $sent; steps = @($Sequence).Count }
}

# Modifiers go down in the order they were named, the payload is tapped, and the
# modifiers come up in reverse - the order every other automation stack uses,
# because releasing them in place leaves the chord held on some IMEs.
function Send-DshHotkey {
  param($Keys)
  $names = @($Keys)
  if ($names.Count -eq 0) { throw 'hotkey needs at least one key' }
  $entries = New-Object System.Collections.ArrayList
  $held = New-Object System.Collections.ArrayList
  for ($index = 0; $index -lt $names.Count; $index += 1) {
    $name = [string]$names[$index]
    $virtualKey = Get-VirtualKey -Name $name
    if ((Test-ModifierKey -Name $name) -and $index -lt ($names.Count - 1)) {
      [void]$entries.Add((New-KeyEntry -VirtualKey $virtualKey -KeyUp $false))
      [void]$held.Add($virtualKey)
    } else {
      [void]$entries.Add((New-KeyEntry -VirtualKey $virtualKey -KeyUp $false))
      [void]$entries.Add((New-KeyEntry -VirtualKey $virtualKey -KeyUp $true))
    }
  }
  for ($index = $held.Count - 1; $index -ge 0; $index -= 1) {
    [void]$entries.Add((New-KeyEntry -VirtualKey ([int]$held[$index]) -KeyUp $true))
  }
  [void](Send-DshInputs -Entries $entries)
  return @{ keys = @($names) }
}

# KEYEVENTF_UNICODE carries a UTF-16 code unit, so a surrogate pair is emitted
# as its two halves and the receiving application reassembles it. That is what
# makes this path layout independent, unlike the virtual-key path above.
function Send-DshText {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return @{ typed = 0 } }
  $entries = New-Object System.Collections.ArrayList
  $typed = 0
  for ($index = 0; $index -lt $Text.Length; $index += 1) {
    $code = [int][char]$Text[$index]
    if ($code -eq 13) { continue } # the CR of a CRLF pair; Enter is sent for the LF
    if ($code -eq 10 -or $code -eq 9) {
      $virtualKey = 0x0D
      if ($code -eq 9) { $virtualKey = 0x09 }
      [void]$entries.Add((New-KeyEntry -VirtualKey $virtualKey -KeyUp $false))
      [void]$entries.Add((New-KeyEntry -VirtualKey $virtualKey -KeyUp $true))
    } else {
      [void]$entries.Add([DshWin32]::KeyInput(0, $code, [DshWin32]::KEYEVENTF_UNICODE))
      [void]$entries.Add([DshWin32]::KeyInput(0, $code, [uint32]([DshWin32]::KEYEVENTF_UNICODE -bor [DshWin32]::KEYEVENTF_KEYUP)))
    }
    $typed += 1
    if ($entries.Count -ge 64) {
      [void](Send-DshInputs -Entries $entries)
      $entries.Clear()
    }
  }
  if ($entries.Count -gt 0) { [void](Send-DshInputs -Entries $entries) }
  return @{ typed = $typed }
}

function Get-ButtonFlags {
  param([string]$Button)
  if ($Button -eq 'right') {
    return @{ down = [uint32][DshWin32]::MOUSEEVENTF_RIGHTDOWN; up = [uint32][DshWin32]::MOUSEEVENTF_RIGHTUP }
  }
  if ($Button -eq 'middle') {
    return @{ down = [uint32][DshWin32]::MOUSEEVENTF_MIDDLEDOWN; up = [uint32][DshWin32]::MOUSEEVENTF_MIDDLEUP }
  }
  if ($Button -ne 'left') { throw "unsupported mouse button: $Button" }
  return @{ down = [uint32][DshWin32]::MOUSEEVENTF_LEFTDOWN; up = [uint32][DshWin32]::MOUSEEVENTF_LEFTUP }
}

function Send-DshMouseClick {
  param([int]$X, [int]$Y, [string]$Button = 'left', [int]$Clicks = 1)
  $point = ConvertTo-AbsolutePoint -X $X -Y $Y
  $flags = Get-ButtonFlags -Button $Button
  $count = [Math]::Max(1, $Clicks)
  $entries = New-Object System.Collections.ArrayList
  [void]$entries.Add((New-MouseEntry -Dx $point.x -Dy $point.y -MouseData 0 -Flags $script:MouseMoveFlags))
  for ($index = 0; $index -lt $count; $index += 1) {
    [void]$entries.Add((New-MouseEntry -Dx $point.x -Dy $point.y -MouseData 0 -Flags ([uint32]($script:MouseMoveFlags -bor $flags.down))))
    [void]$entries.Add((New-MouseEntry -Dx $point.x -Dy $point.y -MouseData 0 -Flags ([uint32]($script:MouseMoveFlags -bor $flags.up))))
  }
  [void](Send-DshInputs -Entries $entries)
  return @{ x = $X; y = $Y; button = $Button; clicks = $count }
}

function Send-DshMouseDrag {
  param([int]$FromX, [int]$FromY, [int]$ToX, [int]$ToY, [string]$Button = 'left', [int]$DurationMs = 300)
  $flags = Get-ButtonFlags -Button $Button
  $start = ConvertTo-AbsolutePoint -X $FromX -Y $FromY
  $end = ConvertTo-AbsolutePoint -X $ToX -Y $ToY
  $entries = New-Object System.Collections.ArrayList
  [void]$entries.Add((New-MouseEntry -Dx $start.x -Dy $start.y -MouseData 0 -Flags $script:MouseMoveFlags))
  [void]$entries.Add((New-MouseEntry -Dx $start.x -Dy $start.y -MouseData 0 -Flags ([uint32]($script:MouseMoveFlags -bor $flags.down))))
  # A drag that teleports is not a drag: applications sample the path, so the
  # move is interpolated in steps the way a human hand would produce them.
  $steps = [Math]::Max(1, [int]([Math]::Max(1, $DurationMs) / 16))
  for ($index = 1; $index -le $steps; $index += 1) {
    $dx = [int][Math]::Round($start.x + (($end.x - $start.x) * $index / $steps))
    $dy = [int][Math]::Round($start.y + (($end.y - $start.y) * $index / $steps))
    [void]$entries.Add((New-MouseEntry -Dx $dx -Dy $dy -MouseData 0 -Flags $script:MouseMoveFlags))
  }
  [void]$entries.Add((New-MouseEntry -Dx $end.x -Dy $end.y -MouseData 0 -Flags ([uint32]($script:MouseMoveFlags -bor $flags.up))))
  [void](Send-DshInputs -Entries $entries)
  return @{ from = @{ x = $FromX; y = $FromY }; to = @{ x = $ToX; y = $ToY }; button = $Button; steps = $steps }
}

function Get-DshOpenApplication {
  param($Body)
  $target = [string](Get-Prop -Object $Body -Name 'target' -Default '')
  if ([string]::IsNullOrWhiteSpace($target)) { throw 'openApplication needs a target' }
  $argumentList = @(Get-Prop -Object $Body -Name 'args' -Default @())
  $cwd = [string](Get-Prop -Object $Body -Name 'cwd' -Default '')
  $waitForWindowMs = Get-IntProp -Object $Body -Name 'waitForWindowMs' -Default 0
  $startArgs = @{ FilePath = $target; PassThru = $true }
  if ($argumentList.Count -gt 0) { $startArgs['ArgumentList'] = $argumentList }
  if (-not [string]::IsNullOrWhiteSpace($cwd)) { $startArgs['WorkingDirectory'] = $cwd }
  $process = Start-Process @startArgs
  if ($null -eq $process) { throw "Start-Process returned no process for $target" }
  $window = $null
  if ($waitForWindowMs -gt 0) {
    $deadline = (Get-Date).AddMilliseconds($waitForWindowMs)
    while ((Get-Date) -lt $deadline -and $null -eq $window) {
      foreach ($candidate in @(Get-DshWindowList)) {
        if ([int]$candidate.processId -eq [int]$process.Id) { $window = $candidate; break }
      }
      if ($null -eq $window) { Start-Sleep -Milliseconds 100 }
    }
  }
  return @{ processId = [int]$process.Id; window = $window }
}

function Invoke-DshRequest {
  param($Body)
  $op = [string](Get-Prop -Object $Body -Name 'op' -Default '')
  switch ($op) {
    'probe' {
      $metrics = Get-DshScreenMetrics
      $foreground = [DshWin32]::GetForegroundWindow()
      return @{
        powershell = $PSVersionTable.PSVersion.ToString()
        metrics = @{ width = $metrics.metrics.screenWidth; height = $metrics.metrics.screenHeight }
        virtualScreen = $metrics.virtualScreen
        interactive = ($foreground -ne [IntPtr]::Zero)
        foreground = $foreground.ToInt64().ToString()
        windows = @(Get-DshWindowList).Count
      }
    }
    'listWindows' {
      return @{ windows = @(Get-DshWindowList `
        -IncludeUntitled ([bool](Get-Prop -Object $Body -Name 'includeUntitled' -Default $false)) `
        -IncludeToolWindows ([bool](Get-Prop -Object $Body -Name 'includeToolWindows' -Default $false)) `
        -IncludeInvisible ([bool](Get-Prop -Object $Body -Name 'includeInvisible' -Default $false))) }
    }
    'foregroundWindow' {
      $foreground = [DshWin32]::GetForegroundWindow()
      if ($foreground -eq [IntPtr]::Zero) { return @{ window = $null } }
      return @{ window = (Get-DshWindowInfo -Handle $foreground -Foreground $foreground) }
    }
    'focusWindow' {
      $handle = Get-Handle -Object $Body -Name 'handle'
      if ([DshWin32]::IsIconic($handle)) { [void][DshWin32]::ShowWindow($handle, 9) } # SW_RESTORE
      $requested = [DshWin32]::SetForegroundWindow($handle)
      Start-Sleep -Milliseconds 60
      $foreground = [DshWin32]::GetForegroundWindow()
      return @{
        requested = $requested
        focused = ($foreground -eq $handle)
        foreground = $foreground.ToInt64().ToString()
        window = (Get-DshWindowInfo -Handle $handle -Foreground $foreground)
      }
    }
    'closeWindow' {
      $handle = Get-Handle -Object $Body -Name 'handle'
      $posted = [DshWin32]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) # WM_CLOSE
      return @{ posted = $posted; handle = $handle.ToInt64().ToString() }
    }
    'moveWindow' {
      $handle = Get-Handle -Object $Body -Name 'handle'
      $current = [DshWin32+RECT]::new()
      [void][DshWin32]::GetWindowRect($handle, [ref]$current)
      $x = Get-IntProp -Object $Body -Name 'x' -Default $current.Left
      $y = Get-IntProp -Object $Body -Name 'y' -Default $current.Top
      $width = Get-IntProp -Object $Body -Name 'width' -Default ($current.Right - $current.Left)
      $height = Get-IntProp -Object $Body -Name 'height' -Default ($current.Bottom - $current.Top)
      if ($width -le 0 -or $height -le 0) { throw 'moveWindow needs a positive width and height' }
      # SWP_NOZORDER | SWP_NOACTIVATE: moving a window must not steal focus.
      $moved = [DshWin32]::SetWindowPos($handle, [IntPtr]::Zero, $x, $y, $width, $height, 0x0014)
      $after = [DshWin32+RECT]::new()
      [void][DshWin32]::GetWindowRect($handle, [ref]$after)
      return @{ moved = $moved; bounds = Get-RectObject -Rect $after }
    }
    'cursorPosition' {
      $point = [DshWin32+POINT]::new()
      [void][DshWin32]::GetCursorPos([ref]$point)
      return @{ x = [int]$point.X; y = [int]$point.Y }
    }
    'moveMouse' {
      $x = Get-IntProp -Object $Body -Name 'x' -Default ([int]::MinValue)
      $y = Get-IntProp -Object $Body -Name 'y' -Default ([int]::MinValue)
      if ($x -eq [int]::MinValue -or $y -eq [int]::MinValue) { throw 'moveMouse needs x and y' }
      $point = ConvertTo-AbsolutePoint -X $x -Y $y
      [void](Send-DshInputs -Entries @((New-MouseEntry -Dx $point.x -Dy $point.y -MouseData 0 -Flags $script:MouseMoveFlags)))
      $actual = [DshWin32+POINT]::new()
      [void][DshWin32]::GetCursorPos([ref]$actual)
      return @{ x = [int]$actual.X; y = [int]$actual.Y }
    }
    'click' {
      $x = Get-IntProp -Object $Body -Name 'x' -Default ([int]::MinValue)
      $y = Get-IntProp -Object $Body -Name 'y' -Default ([int]::MinValue)
      if ($x -eq [int]::MinValue -or $y -eq [int]::MinValue) {
        $point = [DshWin32+POINT]::new()
        [void][DshWin32]::GetCursorPos([ref]$point)
        $x = [int]$point.X
        $y = [int]$point.Y
      }
      return (Send-DshMouseClick -X $x -Y $y -Button ([string](Get-Prop -Object $Body -Name 'button' -Default 'left')) -Clicks (Get-IntProp -Object $Body -Name 'clicks' -Default 1))
    }
    'drag' {
      return (Send-DshMouseDrag -FromX (Get-IntProp -Object $Body -Name 'fromX' -Default 0) -FromY (Get-IntProp -Object $Body -Name 'fromY' -Default 0) -ToX (Get-IntProp -Object $Body -Name 'toX' -Default 0) -ToY (Get-IntProp -Object $Body -Name 'toY' -Default 0) -Button ([string](Get-Prop -Object $Body -Name 'button' -Default 'left')) -DurationMs (Get-IntProp -Object $Body -Name 'durationMs' -Default 300))
    }
    'scroll' {
      $x = Get-IntProp -Object $Body -Name 'x' -Default ([int]::MinValue)
      $y = Get-IntProp -Object $Body -Name 'y' -Default ([int]::MinValue)
      if ($x -ne [int]::MinValue -and $y -ne [int]::MinValue) {
        $point = ConvertTo-AbsolutePoint -X $x -Y $y
        [void](Send-DshInputs -Entries @((New-MouseEntry -Dx $point.x -Dy $point.y -MouseData 0 -Flags $script:MouseMoveFlags)))
      }
      $delta = Get-IntProp -Object $Body -Name 'delta' -Default 0
      if ($delta -eq 0) { throw 'scroll needs a non-zero delta' }
      $horizontal = [bool](Get-Prop -Object $Body -Name 'horizontal' -Default $false)
      $flag = [uint32][DshWin32]::MOUSEEVENTF_WHEEL
      if ($horizontal) { $flag = [uint32][DshWin32]::MOUSEEVENTF_HWHEEL }
      [void](Send-DshInputs -Entries @((New-MouseEntry -Dx 0 -Dy 0 -MouseData ($delta * 120) -Flags $flag)))
      $actual = [DshWin32+POINT]::new()
      [void][DshWin32]::GetCursorPos([ref]$actual)
      return @{ x = [int]$actual.X; y = [int]$actual.Y; delta = $delta; horizontal = $horizontal }
    }
    'typeText' { return (Send-DshText -Text ([string](Get-Prop -Object $Body -Name 'text' -Default ''))) }
    'keyPress' {
      $sequence = Get-Prop -Object $Body -Name 'sequence' -Default $null
      if ($null -ne $sequence -and @($sequence).Count -gt 0) { return (Send-DshKeySequence -Sequence $sequence) }
      $keys = Get-Prop -Object $Body -Name 'keys' -Default $null
      if ($null -ne $keys -and @($keys).Count -gt 0) { return (Send-DshHotkey -Keys $keys) }
      $key = [string](Get-Prop -Object $Body -Name 'key' -Default '')
      $action = [string](Get-Prop -Object $Body -Name 'action' -Default 'press')
      [void](Send-DshKeyPress -Key $key -Action $action)
      return @{ key = $key; action = $action }
    }
    'hotkey' { return (Send-DshHotkey -Keys (Get-Prop -Object $Body -Name 'keys' -Default @())) }
    'openApplication' { return (Get-DshOpenApplication -Body $Body) }
    'clipboardRead' { return @{ text = [DshWin32]::GetClipboardText() } }
    'clipboardWrite' {
      $text = [string](Get-Prop -Object $Body -Name 'text' -Default '')
      if ([string]::IsNullOrEmpty($text)) { throw 'clipboardWrite needs a non-empty string' }
      [DshWin32]::SetClipboardText($text)
      return @{ written = $text.Length }
    }
    'screenMetrics' { return (Get-DshScreenMetrics) }
    default { throw "unsupported op: $op" }
  }
}

function Write-DshResponse {
  param($Payload)
  $json = ConvertTo-Json -InputObject $Payload -Compress -Depth 12
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

$response = $null
try {
  Add-Type -TypeDefinition $nativeSource -ErrorAction Stop
  $script:MouseMoveFlags = [uint32]([DshWin32]::MOUSEEVENTF_MOVE -bor [DshWin32]::MOUSEEVENTF_ABSOLUTE -bor [DshWin32]::MOUSEEVENTF_VIRTUALDESK)
} catch {
  Write-DshResponse @{ ok = $false; error = "native declarations failed to compile: $($_.Exception.Message)"; code = 'CONTROLLER_UNAVAILABLE' }
  exit 0
}

try {
  $raw = ''
  if (-not [string]::IsNullOrWhiteSpace($Request)) {
    if (Test-Path -LiteralPath $Request) {
      $raw = [System.IO.File]::ReadAllText($Request, [System.Text.Encoding]::UTF8)
    } elseif ($Request.TrimStart().StartsWith('{')) {
      $raw = $Request
    }
  } elseif ([Console]::IsInputRedirected) {
    $raw = [Console]::In.ReadToEnd()
  }
  if ([string]::IsNullOrWhiteSpace($raw)) { throw 'no request was supplied' }
  $body = ConvertFrom-Json -InputObject $raw
  $result = Invoke-DshRequest -Body $body
  $response = @{ ok = $true; result = $result }
} catch {
  $code = 'CONTROLLER_FAILED'
  $message = $_.Exception.Message
  if ($message -like 'unsupported op:*' -or $message -like 'unsupported key name:*' -or $message -like 'unsupported mouse button:*') { $code = 'ACTION_UNSUPPORTED' }
  elseif ($message -like 'no such window:*') { $code = 'TARGET_NOT_FOUND' }
  elseif ($message -like 'openApplication needs*' -or $message -like 'moveMouse needs*' -or $message -like 'scroll needs*') { $code = 'ACTION_INVALID' }
  $response = @{ ok = $false; error = $message; code = $code }
}

Write-DshResponse $response
exit 0
