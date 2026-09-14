param([int]$X, [int]$Y)

# Which window would a click at (X, Y) land on, and what is the root window of that target?
#
# `WindowFromPoint` is the call Windows itself uses for that question, and it *skips* windows that are
# transparent to the mouse - so this is the operating system's own answer to "does the wallpaper
# layer take the click?", asked in the same words the shell uses.
#
# The process is made DPI-aware first: a DPI-unaware process is handed virtualised coordinates, and
# the answer would be about a different point than the one asked for.

Add-Type -Namespace Win -Name HitTest -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern System.IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr h, uint flags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder t, int n);
[DllImport("user32.dll")] public static extern int GetClassName(System.IntPtr h, System.Text.StringBuilder t, int n);
'@

[Win.HitTest]::SetProcessDPIAware() | Out-Null

$point = New-Object Win.HitTest+POINT
$point.X = $X
$point.Y = $Y

$under = [Win.HitTest]::WindowFromPoint($point)
$root = [Win.HitTest]::GetAncestor($under, 2)
$title = New-Object System.Text.StringBuilder 512
$class = New-Object System.Text.StringBuilder 512
$rect = New-Object Win.HitTest+RECT
[Win.HitTest]::GetWindowText($under, $title, 512) | Out-Null
[Win.HitTest]::GetClassName($under, $class, 512) | Out-Null
[Win.HitTest]::GetWindowRect($under, [ref]$rect) | Out-Null

Write-Output "under=0x$($under.ToString('X')) class=$($class.ToString()) rect=$($rect.Left),$($rect.Top)-$($rect.Right),$($rect.Bottom) visible=$([Win.HitTest]::IsWindowVisible($under))"
Write-Output "root=0x$($root.ToString('X'))"
