<#
  uia.ps1 - the UI Automation backend behind uia.cjs.

  Why PowerShell and not a native Node addon: UI Automation is only reachable
  through the .NET client assemblies, and powershell.exe (5.1) is the one .NET
  host that exists on every supported Windows build without shipping a compiler
  or a native dependency.

  Contract with uia.cjs: Node writes one JSON request to a temp file, runs this
  script once per operation, and reads exactly ONE line of JSON from stdout:

    {"ok":true,"result":...}   or   {"ok":false,"error":"...","code":"..."}

  Nothing else may reach stdout (diagnostics go to stderr), and the process
  always exits 0 because the caller trusts the JSON payload, not the exit code.
  Every failure therefore has to be reported as JSON, which is why the whole
  operation is wrapped in a single try/catch.
#>
param(
  # Deliberately NOT mandatory: a mandatory parameter would make powershell.exe
  # prompt on stdin when Node forgets it, and a hung driver is worse than a
  # reported failure.
  [string]$Request
)

$ErrorActionPreference = 'Stop'
$script:Backend = 'powershell-uia'
$script:Clock = [System.Diagnostics.Stopwatch]::StartNew()
$script:TimeoutDefaultMs = 8000
$script:MaxNodesDefault = 4000
$script:MaxDepthDefault = 24
$script:LimitDefault = 50
$script:DeadlineMs = 0
$script:MaxSiblingScan = 4096

# JSON travels over a redirected stdout, whose encoding follows the console code
# page unless it is pinned here; a window title with a non-ASCII character would
# otherwise arrive mangled at the Node side.
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

function Get-RequestProperty($request, [string]$name) {
  if ($null -eq $request) { return $null }
  $property = $request.PSObject.Properties[$name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Get-BoundedInt($value, [int]$fallback, [int]$min, [int]$max) {
  if ($null -eq $value) { return $fallback }
  $number = 0
  if (-not [int]::TryParse(([string]$value).Trim(), [ref]$number)) { return $fallback }
  if ($number -lt $min) { return $min }
  if ($number -gt $max) { return $max }
  return $number
}

function Get-RequestBool($value, [bool]$fallback) {
  if ($null -eq $value) { return $fallback }
  if ($value -is [bool]) { return [bool]$value }
  $text = ([string]$value).Trim().ToLowerInvariant()
  if ($text -eq 'true' -or $text -eq '1' -or $text -eq 'yes') { return $true }
  if ($text -eq 'false' -or $text -eq '0' -or $text -eq 'no') { return $false }
  return $fallback
}

function Get-RequestHandle($value) {
  if ($null -eq $value) { return $null }
  $handle = 0L
  if (-not [int64]::TryParse(([string]$value).Trim(), [ref]$handle)) {
    throw (New-UiaFailure 'TARGET_INVALID' ('windowHandle "{0}" is not a window handle' -f $value))
  }
  return $handle
}

function New-UiaFailure([string]$code, [string]$message) {
  $exception = New-Object System.Exception($message)
  # The code rides on Exception.Data so a failure keeps its typed identity even
  # when a defensive catch in the middle of the call stack lets it travel.
  $exception.Data['code'] = $code
  return $exception
}

function Get-FailureCode($errorRecord) {
  try {
    $exception = $errorRecord.Exception
    while ($null -ne $exception) {
      if ($null -ne $exception.Data -and $exception.Data.Contains('code')) { return [string]$exception.Data['code'] }
      $exception = $exception.InnerException
    }
  } catch { }
  return 'CONTROLLER_FAILED'
}

function Get-FailureMessage($errorRecord) {
  try {
    if ($null -ne $errorRecord.Exception -and -not [string]::IsNullOrEmpty($errorRecord.Exception.Message)) {
      return [string]$errorRecord.Exception.Message
    }
  } catch { }
  return 'the UI Automation operation failed without a message'
}

# Coordinates come from providers that report NaN and infinity for elements that
# are being created or destroyed, and an int cast of those throws; a rectangle
# that cannot be believed is reported as the documented empty rectangle.
function ConvertTo-Pixel([double]$value) {
  if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { return 0 }
  if ($value -gt 1000000) { return 1000000 }
  if ($value -lt -1000000) { return -1000000 }
  return [int][math]::Round($value)
}

function Test-Deadline {
  if ($script:DeadlineMs -le 0) { return $false }
  return ($script:Clock.ElapsedMilliseconds -gt $script:DeadlineMs)
}

function Set-TimeBudget($request) {
  $timeout = Get-BoundedInt (Get-RequestProperty $request 'timeoutMs') $script:TimeoutDefaultMs 500 600000
  # Reserve headroom: answering with partial data (and a truncated flag) is
  # useful, being killed by the caller's spawnSync timeout is not, because a
  # killed process emits no JSON at all. The reserve has to cover one more
  # provider call, and a single hung window can block for seconds, so it is
  # generous rather than tight.
  $budget = $timeout - 2500
  if ($budget -lt 500) { $budget = 500 }
  $script:DeadlineMs = $budget
}

function Test-SameElement($left, $right) {
  if ($null -eq $left -or $null -eq $right) { return $false }
  try {
    if ([object]::Equals($left, $right)) { return $true }
  } catch { }
  try {
    $leftId = $left.GetRuntimeId()
    $rightId = $right.GetRuntimeId()
    if ($null -eq $leftId -or $null -eq $rightId) { return $false }
    if ($leftId.Length -ne $rightId.Length) { return $false }
    for ($i = 0; $i -lt $leftId.Length; $i++) {
      if ($leftId[$i] -ne $rightId[$i]) { return $false }
    }
    return $true
  } catch {
    return $false
  }
}

# ---------------------------------------------------------------------------
# Assembly loading: reported through probe, never guessed
# ---------------------------------------------------------------------------

$script:UiaReady = $false
$script:AssemblyError = $null

function Initialize-Uia {
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $script:UiaReady = $true
  } catch {
    $script:UiaReady = $false
    $script:AssemblyError = $_.Exception.Message
  }
}

function Assert-Uia {
  if ($script:UiaReady) { return }
  throw (New-UiaFailure 'CONTROLLER_UNAVAILABLE' ('the UI Automation assemblies are not available in this powershell.exe: {0}' -f $script:AssemblyError))
}

# ---------------------------------------------------------------------------
# Pattern registry
# ---------------------------------------------------------------------------

$script:PatternByLabel = [ordered]@{}
$script:PatternLabels = @{}

function Register-Pattern([string]$label, [scriptblock]$resolve) {
  # Each lookup sits in its own try/catch because the exotic patterns (drag,
  # drop target, annotation) only exist from Windows 8 / .NET 4.5 on, and a
  # missing one must shrink the reported pattern list, not fail the operation.
  try {
    $pattern = & $resolve
    if ($null -ne $pattern) {
      $script:PatternByLabel[$label] = $pattern
      $script:PatternLabels[$pattern.ProgrammaticName] = $label
    }
  } catch { }
}

function Initialize-Patterns {
  if (-not $script:UiaReady) { return }
  Register-Pattern 'Invoke' { [System.Windows.Automation.InvokePattern]::Pattern }
  Register-Pattern 'SelectionItem' { [System.Windows.Automation.SelectionItemPattern]::Pattern }
  Register-Pattern 'ExpandCollapse' { [System.Windows.Automation.ExpandCollapsePattern]::Pattern }
  Register-Pattern 'Toggle' { [System.Windows.Automation.TogglePattern]::Pattern }
  Register-Pattern 'Value' { [System.Windows.Automation.ValuePattern]::Pattern }
  Register-Pattern 'Text' { [System.Windows.Automation.TextPattern]::Pattern }
  Register-Pattern 'Scroll' { [System.Windows.Automation.ScrollPattern]::Pattern }
  Register-Pattern 'ScrollItem' { [System.Windows.Automation.ScrollItemPattern]::Pattern }
  Register-Pattern 'Selection' { [System.Windows.Automation.SelectionPattern]::Pattern }
  Register-Pattern 'Window' { [System.Windows.Automation.WindowPattern]::Pattern }
  Register-Pattern 'Transform' { [System.Windows.Automation.TransformPattern]::Pattern }
  Register-Pattern 'RangeValue' { [System.Windows.Automation.RangeValuePattern]::Pattern }
  Register-Pattern 'Grid' { [System.Windows.Automation.GridPattern]::Pattern }
  Register-Pattern 'GridItem' { [System.Windows.Automation.GridItemPattern]::Pattern }
  Register-Pattern 'LegacyIAccessible' { [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern }
  Register-Pattern 'VirtualizedItem' { [System.Windows.Automation.VirtualizedItemPattern]::Pattern }
  Register-Pattern 'SynchronizeInput' { [System.Windows.Automation.SynchronizedInputPattern]::Pattern }
  Register-Pattern 'Annotation' { [System.Windows.Automation.AnnotationPattern]::Pattern }
  Register-Pattern 'Drag' { [System.Windows.Automation.DragPattern]::Pattern }
  Register-Pattern 'DropTarget' { [System.Windows.Automation.DropTargetPattern]::Pattern }
  Register-Pattern 'Table' { [System.Windows.Automation.TablePattern]::Pattern }
  Register-Pattern 'TableItem' { [System.Windows.Automation.TableItemPattern]::Pattern }
}

# GetSupportedPatterns() answers the whole question in one cross-process call,
# which matters because a node record is built for every element of a walk.
function Get-PatternNames($element) {
  $names = New-Object System.Collections.ArrayList
  try {
    foreach ($pattern in $element.GetSupportedPatterns()) {
      if ($null -eq $pattern) { continue }
      $label = $script:PatternLabels[$pattern.ProgrammaticName]
      if ($null -ne $label -and -not $names.Contains($label)) { [void]$names.Add($label) }
    }
  } catch { }
  return , $names.ToArray()
}

function Get-PatternObject($element, [string]$label) {
  # TryGetCurrentPattern, because a pattern can be reported as supported and
  # still vanish between two calls when the provider is busy.
  $pattern = $script:PatternByLabel[$label]
  if ($null -eq $pattern) { return $null }
  try {
    $current = $null
    if ($element.TryGetCurrentPattern($pattern, [ref]$current)) { return $current }
  } catch { }
  return $null
}

# ---------------------------------------------------------------------------
# Control types
# ---------------------------------------------------------------------------

$script:ControlTypes = @{}

function Initialize-ControlTypes {
  if (-not $script:UiaReady) { return }
  try {
    # ControlType exposes its values as static *fields* on .NET Framework
    # (GetProperties with Static returns none), and an empty map here would
    # silently turn every role filter into a full tree walk, so both member kinds
    # are read rather than trusting one of them.
    $flags = [System.Reflection.BindingFlags]'Public,Static'
    $type = [System.Windows.Automation.ControlType]
    foreach ($field in $type.GetFields($flags)) {
      $value = $field.GetValue($null)
      if ($null -eq $value -or $value -isnot [System.Windows.Automation.ControlType]) { continue }
      $script:ControlTypes[$field.Name.ToLowerInvariant()] = $value
    }
    foreach ($property in $type.GetProperties($flags)) {
      if ($property.PropertyType -ne $type) { continue }
      $script:ControlTypes[$property.Name.ToLowerInvariant()] = $property.GetValue($null)
    }
  } catch { }
}

function Get-ControlTypeName($element) {
  try {
    $controlType = $element.Current.ControlType
    if ($null -eq $controlType) { return 'custom' }
    $programmatic = [string]$controlType.ProgrammaticName
    if ([string]::IsNullOrEmpty($programmatic)) { return 'custom' }
    # ControlType.Button -> button, so a role reads like the ARIA role a caller
    # already knows; anything unrecognised degrades to 'custom', never to ''.
    $name = $programmatic -replace '^ControlType\.', ''
    if ([string]::IsNullOrEmpty($name)) { return 'custom' }
    return $name.ToLowerInvariant()
  } catch {
    return 'custom'
  }
}

function Get-RoleName($element, [string]$ref) {
  # A receipt has to name the same role the caller read from the node, and the
  # desktop root has no control type that says "desktop".
  if ($ref -eq 'w:0') { return 'desktop' }
  return (Get-ControlTypeName $element)
}

# ---------------------------------------------------------------------------
# Element readings
# ---------------------------------------------------------------------------

function Get-CurrentProperty($element, [string]$property, $fallback) {
  try {
    $value = $element.Current.$property
    if ($null -eq $value) { return $fallback }
    return $value
  } catch {
    return $fallback
  }
}

function Get-Bounds($element) {
  $empty = [ordered]@{ x = 0; y = 0; width = 0; height = 0 }
  try {
    $rect = $element.Current.BoundingRectangle
    if ($null -eq $rect -or $rect.IsEmpty) { return $empty }
    return [ordered]@{
      x = ConvertTo-Pixel ([double]$rect.X)
      y = ConvertTo-Pixel ([double]$rect.Y)
      width = ConvertTo-Pixel ([double]$rect.Width)
      height = ConvertTo-Pixel ([double]$rect.Height)
    }
  } catch {
    return $empty
  }
}

function Get-ChildrenView($element, $memo) {
  # The control-view child list of one element, in index order: the same order
  # TreeWalker.ControlViewWalker reports (verified), but in a single provider
  # call. $memo lets one request reuse the list of an ancestor that several hits
  # share, which is where a multi-hit search spends most of its provider calls.
  $key = ''
  try { $key = ($element.GetRuntimeId() -join '.') } catch { $key = '' }
  if ($key.Length -gt 0 -and $null -ne $memo -and $memo.ContainsKey($key)) { return , $memo[$key] }
  $children = @()
  try {
    $children = @($element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Automation]::ControlViewCondition))
  } catch {
    $children = @()
  }
  if ($key.Length -gt 0 -and $null -ne $memo) { $memo[$key] = $children }
  return , $children
}

function Get-ChildrenCount($element) {
  # One explicit, native call in the control view rather than a sibling walk:
  # the walker order and FindAll(Children, ControlViewCondition) order are the
  # same (verified), and a node with a hundred children would otherwise cost a
  # hundred cross-process calls.
  return (Get-ChildrenView $element $null).Length
}

function Get-OwnWindowHandle($element) {
  try {
    return [int64](Get-CurrentProperty $element 'NativeWindowHandle' 0)
  } catch {
    return 0
  }
}

function Get-NodeValue($element, $patterns) {
  # Only ask the provider for a pattern the element already reported, so a plain
  # container costs no extra cross-process call.
  if ($patterns -contains 'Value') {
    $valuePattern = Get-PatternObject $element 'Value'
    if ($null -ne $valuePattern) {
      try { return [string]$valuePattern.Current.Value } catch { return '' }
    }
  }
  if ($patterns -contains 'Toggle') {
    $togglePattern = Get-PatternObject $element 'Toggle'
    if ($null -ne $togglePattern) {
      try { return $togglePattern.Current.ToggleState.ToString().ToLowerInvariant() } catch { return '' }
    }
  }
  return ''
}

function New-NodeRecord($element, [string]$ref, [int64]$windowHandle, [bool]$isDesktop) {
  $patterns = Get-PatternNames $element
  $role = 'custom'
  if ($isDesktop) {
    $role = 'desktop'
  } else {
    $role = Get-ControlTypeName $element
  }
  return [ordered]@{
    ref = $ref
    role = $role
    name = [string](Get-CurrentProperty $element 'Name' '')
    value = Get-NodeValue $element $patterns
    enabled = [bool](Get-CurrentProperty $element 'IsEnabled' $false)
    focusable = [bool](Get-CurrentProperty $element 'IsKeyboardFocusable' $false)
    focused = [bool](Get-CurrentProperty $element 'HasKeyboardFocus' $false)
    offscreen = [bool](Get-CurrentProperty $element 'IsOffscreen' $false)
    bounds = Get-Bounds $element
    patterns = $patterns
    processId = [int](Get-CurrentProperty $element 'ProcessId' 0)
    windowHandle = [string]$windowHandle
    childrenCount = Get-ChildrenCount $element
  }
}

# ---------------------------------------------------------------------------
# Refs: w:<hwnd>[/<child>.<child>...]
# ---------------------------------------------------------------------------

function Get-RefParts([string]$ref) {
  if ([string]::IsNullOrWhiteSpace($ref)) {
    throw (New-UiaFailure 'TARGET_INVALID' 'a ref such as "w:1234/0.3" or "w:0" is required')
  }
  $match = [regex]::Match($ref.Trim(), '^w:(\d+)(?:/(\d+(?:\.\d+)*))?$')
  if (-not $match.Success) {
    throw (New-UiaFailure 'TARGET_INVALID' ('ref "{0}" is not of the form w:<hwnd>[/<child index path>]' -f $ref))
  }
  $path = @()
  if ($match.Groups[2].Success) {
    foreach ($step in $match.Groups[2].Value.Split('.')) { $path += [int]$step }
  }
  return @{ Handle = [int64]$match.Groups[1].Value; Path = $path }
}

function Get-FirstWalkerChild($walker, $element) {
  try { return $walker.GetFirstChild($element) } catch { return $null }
}

function Get-NextWalkerSibling($walker, $element) {
  try { return $walker.GetNextSibling($element) } catch { return $null }
}

function Get-WalkerChildAtIndex($walker, $element, [int]$index) {
  # Index-based lookup stays exact because it re-reads the live child order, and
  # it is bounded by the real sibling count rather than by a loop of our own.
  $child = Get-FirstWalkerChild $walker $element
  $position = 0
  while ($null -ne $child -and $position -lt $script:MaxSiblingScan) {
    if ($position -eq $index) { return $child }
    $position++
    $child = Get-NextWalkerSibling $walker $child
  }
  return $null
}

function Get-ChildIndex($parent, $child, $memo) {
  # Scanning from the first child is unavoidable (UIA exposes no child index),
  # but the scan itself is local: the control-view list arrives in one call and
  # the comparisons never cross a process boundary again.
  $children = Get-ChildrenView $parent $memo
  for ($index = 0; $index -lt $children.Length -and $index -lt $script:MaxSiblingScan; $index++) {
    if (Test-SameElement $children[$index] $child) { return $index }
  }
  return -1
}

function Resolve-Element([string]$ref) {
  $parts = Get-RefParts $ref
  $element = $null
  try {
    if ($parts.Handle -eq 0) {
      $element = [System.Windows.Automation.AutomationElement]::RootElement
    } else {
      $element = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$parts.Handle)
    }
  } catch {
    throw (New-UiaFailure 'TARGET_STALE' ('ref "{0}" no longer resolves to a window: {1}' -f $ref, $_.Exception.Message))
  }
  if ($null -eq $element) {
    throw (New-UiaFailure 'TARGET_STALE' ('ref "{0}" no longer resolves to an element' -f $ref))
  }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $step = 0
  foreach ($index in $parts.Path) {
    $next = Get-WalkerChildAtIndex $walker $element $index
    if ($null -eq $next) {
      throw (New-UiaFailure 'TARGET_STALE' ('ref "{0}" is stale: child index {1} at step {2} no longer exists' -f $ref, $index, $step))
    }
    $element = $next
    $step++
  }
  return $element
}

function Get-RefPathFromRoot($walker, $element, $root, [int]$maxDepth, $memo) {
  # Walks up to the searched window to rebuild the index path a ref encodes.
  # Returns $null when the element is not under that window (or sits deeper than
  # maxDepth), which is how the depth cap is enforced on native FindAll hits.
  $steps = New-Object System.Collections.ArrayList
  $current = $element
  $depth = 0
  while ($depth -le $maxDepth) {
    if (Test-SameElement $current $root) {
      $ordered = $steps.ToArray()
      [array]::Reverse($ordered)
      return @{ Path = ($ordered -join '.'); Depth = $depth }
    }
    $parent = $null
    try { $parent = $walker.GetParent($current) } catch { $parent = $null }
    if ($null -eq $parent) { return $null }
    $index = Get-ChildIndex $parent $current $memo
    if ($index -lt 0) { return $null }
    [void]$steps.Add($index)
    $current = $parent
    $depth++
  }
  return $null
}

# ---------------------------------------------------------------------------
# Bounded subtree walks
# ---------------------------------------------------------------------------

function Get-SubtreeNodes($parentElement, [string]$baseRef, [int64]$baseHandle, [int]$depth, [int]$maxNodes, [bool]$useDeadline, $filter) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $nodes = New-Object System.Collections.ArrayList
  $truncated = $false
  $visited = 0
  if ($depth -le 0 -or $maxNodes -le 0) {
    return @{ Nodes = $nodes; Truncated = $false; Visited = 0 }
  }
  # Level-order walk. $Path is the dot-joined child index path relative to the
  # element the ref points at, so a ref always reads w:<hwnd>/0.3.2 no matter
  # how deep the walk went.
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@{ Element = $parentElement; Path = ''; Handle = $baseHandle; Level = 0 })
  while ($queue.Count -gt 0) {
    if ($visited -ge $maxNodes) { $truncated = $true; break }
    if ($useDeadline -and (Test-Deadline)) { $truncated = $true; break }
    $current = $queue.Dequeue()
    if ($current.Level -ge $depth) { continue }
    $child = Get-FirstWalkerChild $walker $current.Element
    $index = 0
    while ($null -ne $child) {
      if ($visited -ge $maxNodes) { $truncated = $true; break }
      $visited++
      $childPath = [string]$index
      if ($current.Path.Length -gt 0) { $childPath = '{0}.{1}' -f $current.Path, $index }
      $childRef = '{0}/{1}' -f $baseRef, $childPath
      $own = Get-OwnWindowHandle $child
      $childHandle = $current.Handle
      if ($own -ne 0) { $childHandle = $own }
      $keep = $true
      if ($null -ne $filter) { $keep = Test-NodeMatches $child $filter }
      # A record costs several provider calls, so a filtered walk only builds one
      # for the nodes that pass; the budget is spent on nodes walked, not matched.
      if ($keep) { [void]$nodes.Add((New-NodeRecord $child $childRef $childHandle $false)) }
      if (($current.Level + 1) -lt $depth) {
        $queue.Enqueue(@{ Element = $child; Path = $childPath; Handle = $childHandle; Level = $current.Level + 1 })
      }
      $index++
      $child = Get-NextWalkerSibling $walker $child
    }
  }
  return @{ Nodes = $nodes; Truncated = $truncated; Visited = $visited }
}

# ---------------------------------------------------------------------------
# Top-level windows
# ---------------------------------------------------------------------------

$script:NativeReady = $false
$script:NativeFailed = $false
$script:NativeError = $null

$script:NativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace DshUiaNative {
  public sealed class WindowInfo {
    public long Handle;
    public string Title;
    public string ClassName;
    public int ProcessId;
    public bool Visible;
  }

  public static class WindowList {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowText")]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassName")]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    public static WindowInfo[] Enumerate() {
      List<WindowInfo> list = new List<WindowInfo>();
      EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
        WindowInfo info = new WindowInfo();
        info.Handle = hWnd.ToInt64();
        StringBuilder title = new StringBuilder(512);
        GetWindowText(hWnd, title, title.Capacity);
        info.Title = title.ToString();
        StringBuilder cls = new StringBuilder(256);
        GetClassName(hWnd, cls, cls.Capacity);
        info.ClassName = cls.ToString();
        uint pid = 0;
        GetWindowThreadProcessId(hWnd, out pid);
        info.ProcessId = unchecked((int)pid);
        info.Visible = IsWindowVisible(hWnd);
        list.Add(info);
        return true;
      }, IntPtr.Zero);
      return list.ToArray();
    }
  }
}
'@

function Initialize-Native {
  if ($script:NativeReady -or $script:NativeFailed) { return }
  try {
    # Compiled lazily: only the window search needs user32, and letting a blocked
    # Add-Type (policy, no csc.exe) fail here keeps every other op working.
    Add-Type -TypeDefinition $script:NativeSource -ErrorAction Stop
    $script:NativeReady = $true
  } catch {
    $script:NativeFailed = $true
    $script:NativeError = $_.Exception.Message
  }
}

function Get-EnumeratedWindows {
  Initialize-Native
  if (-not $script:NativeReady) {
    return @{ Ok = $false; Windows = @(); Error = $script:NativeError }
  }
  try {
    return @{ Ok = $true; Windows = @([DshUiaNative.WindowList]::Enumerate()); Error = $null }
  } catch {
    $script:NativeFailed = $true
    return @{ Ok = $false; Windows = @(); Error = $_.Exception.Message }
  }
}

function Get-RootChildWindows {
  # Fallback for a machine where Add-Type cannot compile: the automation root's
  # children are the same top-level windows, just without the Win32 metadata.
  $windows = New-Object System.Collections.ArrayList
  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($child in $children) {
      [void]$windows.Add(@{
        Handle = Get-OwnWindowHandle $child
        Title = [string](Get-CurrentProperty $child 'Name' '')
        ClassName = [string](Get-CurrentProperty $child 'ClassName' '')
        ProcessId = [int](Get-CurrentProperty $child 'ProcessId' 0)
        Visible = $true
        Element = $child
      })
    }
  } catch { }
  return , $windows.ToArray()
}

function Get-SearchWindows($request, $filter) {
  $explicitHandle = Get-RequestHandle (Get-RequestProperty $request 'windowHandle')
  $processValue = Get-RequestProperty $request 'processId'
  $explicitProcess = $null
  if ($null -ne $processValue) {
    $parsed = 0
    if (-not [int]::TryParse(([string]$processValue).Trim(), [ref]$parsed)) {
      throw (New-UiaFailure 'TARGET_INVALID' ('processId "{0}" is not a process id' -f $processValue))
    }
    $explicitProcess = $parsed
  }

  if ($null -ne $explicitHandle) {
    # An explicit handle wins over enumeration: it may name a child or tool
    # window that EnumWindows never reports as top level.
    return @{ Windows = @(@{ Handle = $explicitHandle; Title = ''; ClassName = ''; ProcessId = 0; Visible = $true; Element = $null }); Source = 'windowHandle' }
  }

  $enumerated = Get-EnumeratedWindows
  $candidates = New-Object System.Collections.ArrayList
  $source = 'enumWindows'
  if ($enumerated.Ok) {
    foreach ($info in $enumerated.Windows) {
      if ($null -eq $info) { continue }
      if ($null -ne $explicitProcess -and [int]$info.ProcessId -ne $explicitProcess) { continue }
      $title = [string]$info.Title
      # The documented policy: an untitled top-level window is skipped, because
      # the desktop is full of invisible helper windows that cost a walk each.
      if ($title.Length -eq 0 -and $null -eq $explicitProcess) { continue }
      [void]$candidates.Add(@{
        Handle = [int64]$info.Handle
        Title = $title
        ClassName = [string]$info.ClassName
        ProcessId = [int]$info.ProcessId
        Visible = [bool]$info.Visible
        Element = $null
      })
    }
  } else {
    $source = 'rootChildren'
    foreach ($window in (Get-RootChildWindows)) {
      if ($null -ne $explicitProcess -and [int]$window.ProcessId -ne $explicitProcess) { continue }
      if (([string]$window.Title).Length -eq 0 -and $null -eq $explicitProcess) { continue }
      [void]$candidates.Add($window)
    }
  }

  $all = $candidates.ToArray()
  # Visible windows first (EnumWindows is Z-order, so this is a stable reorder):
  # the window a caller means is almost always one it can see.
  $visible = @($all | Where-Object { $_.Visible })
  $hidden = @($all | Where-Object { -not $_.Visible })
  $ordered = @($visible + $hidden)
  if ($null -ne $filter -and $null -ne $filter.Name) {
    # A name filter is the one thing the caller already told us, and a top-level
    # window whose own title carries that name is where a match almost always is
    # (asking for a name usually means a window, or a control inside the window
    # that announces it). Such windows are searched first, which matters because
    # the desktop sweep is expensive and the window is not always near the front
    # of the Z-order. This only reorders the sweep - every other window is still
    # searched when the budget allows - so it cannot turn a hit into a miss.
    $needle = $filter.Name.ToLowerInvariant()
    $exact = @($ordered | Where-Object { ([string]$_.Title).ToLowerInvariant() -eq $needle })
    $partial = @($ordered | Where-Object {
      $title = ([string]$_.Title).ToLowerInvariant()
      $title.Length -gt 0 -and $title -ne $needle -and $title.Contains($needle)
    })
    $rest = @($ordered | Where-Object {
      $title = ([string]$_.Title).ToLowerInvariant()
      $title.Length -eq 0 -or -not $title.Contains($needle)
    })
    $ordered = @($exact + $partial + $rest)
  }
  return @{ Windows = $ordered; Source = $source }
}

function Get-WindowElement($window) {
  if ($null -ne $window.Element) { return $window.Element }
  if ($window.Handle -eq 0) { return $null }
  try {
    $element = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([int64]$window.Handle))
    if ($null -ne $element) { $window.Element = $element }
    return $element
  } catch {
    return $null
  }
}

# ---------------------------------------------------------------------------
# find
# ---------------------------------------------------------------------------

function New-FindFilter($request) {
  $role = Get-RequestProperty $request 'role'
  if ($null -eq $role) { $role = Get-RequestProperty $request 'controlType' }
  $filter = @{ Name = $null; Exact = $true; Role = $null; AutomationId = $null; ClassName = $null }
  $name = Get-RequestProperty $request 'name'
  if ($null -ne $name -and ([string]$name).Length -gt 0) { $filter.Name = [string]$name }
  $filter.Exact = Get-RequestBool (Get-RequestProperty $request 'exact') $true
  $automationId = Get-RequestProperty $request 'automationId'
  if ($null -ne $automationId -and ([string]$automationId).Length -gt 0) { $filter.AutomationId = [string]$automationId }
  $className = Get-RequestProperty $request 'className'
  if ($null -ne $className -and ([string]$className).Length -gt 0) { $filter.ClassName = [string]$className }
  if ($null -ne $role -and ([string]$role).Length -gt 0) { $filter.Role = ([string]$role).Trim().ToLowerInvariant() }
  return $filter
}

function Test-NodeMatches($element, $filter) {
  # The native condition is a superset of these tests; the predicate is what the
  # caller actually asked for, so it is applied to every candidate hit.
  if ($null -ne $filter.Name) {
    $name = [string](Get-CurrentProperty $element 'Name' '')
    if ($filter.Exact) {
      if ($name -cne $filter.Name) { return $false }
    } else {
      if (-not $name.ToLowerInvariant().Contains($filter.Name.ToLowerInvariant())) { return $false }
    }
  }
  if ($null -ne $filter.AutomationId) {
    if ([string](Get-CurrentProperty $element 'AutomationId' '') -cne $filter.AutomationId) { return $false }
  }
  if ($null -ne $filter.ClassName) {
    $className = [string](Get-CurrentProperty $element 'ClassName' '')
    if ($className.ToLowerInvariant() -ne $filter.ClassName.ToLowerInvariant()) { return $false }
  }
  if ($null -ne $filter.Role) {
    if ((Get-ControlTypeName $element) -ne $filter.Role) { return $false }
  }
  return $true
}

function New-SearchCondition($filter) {
  # Every search is scoped to the control view. Refs are built by walking
  # TreeWalker.ControlViewWalker, so an element outside that view has no path to
  # a ref and could never be addressed, and ControlViewCondition is an explicit
  # condition of its own, so FindAll never walks the raw tree unbounded.
  #
  # Only exact values have a native equivalent; a substring name or an unmappable
  # role is left to the predicate that every candidate still goes through.
  $conditions = New-Object System.Collections.ArrayList
  [void]$conditions.Add([System.Windows.Automation.Automation]::ControlViewCondition)
  if ($null -ne $filter.Name -and $filter.Exact) {
    [void]$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $filter.Name)))
  }
  if ($null -ne $filter.AutomationId) {
    [void]$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $filter.AutomationId)))
  }
  if ($null -ne $filter.ClassName) {
    [void]$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, $filter.ClassName)))
  }
  if ($null -ne $filter.Role) {
    $controlType = $script:ControlTypes[$filter.Role]
    if ($null -ne $controlType) {
      [void]$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType)))
    }
  }
  if ($conditions.Count -eq 1) { return $conditions[0] }
  return (New-Object System.Windows.Automation.AndCondition -ArgumentList (, $conditions.ToArray()))
}

function New-FoundNode($element, $windowElement, [int64]$windowHandle, [int]$maxDepth, $memo) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $path = Get-RefPathFromRoot $walker $element $windowElement $maxDepth $memo
  if ($null -eq $path) { return $null }
  $ref = 'w:{0}' -f $windowHandle
  if ($path.Path.Length -gt 0) { $ref = '{0}/{1}' -f $ref, $path.Path }
  $own = Get-OwnWindowHandle $element
  $handle = $windowHandle
  if ($own -ne 0) { $handle = $own }
  return (New-NodeRecord $element $ref $handle $false)
}

function Invoke-FindOp($request) {
  $limit = Get-BoundedInt (Get-RequestProperty $request 'limit') $script:LimitDefault 1 500
  $maxNodes = Get-BoundedInt (Get-RequestProperty $request 'maxNodes') $script:MaxNodesDefault 1 20000
  $depthValue = Get-RequestProperty $request 'depth'
  if ($null -eq $depthValue) { $depthValue = Get-RequestProperty $request 'maxDepth' }
  $maxDepth = Get-BoundedInt $depthValue $script:MaxDepthDefault 1 64
  $filter = New-FindFilter $request
  $condition = New-SearchCondition $filter
  $search = Get-SearchWindows $request $filter
  $matches = New-Object System.Collections.ArrayList
  $searched = 0
  $scanned = 0
  $dropped = 0
  $truncated = $false
  $deadlineHit = $false
  # One request, one memo: a search that returns several hits under the same
  # window reuses that window's child lists instead of re-reading them per hit.
  $memo = @{}

  foreach ($window in $search.Windows) {
    if ($matches.Count -ge $limit) { break }
    if (Test-Deadline) { $truncated = $true; $deadlineHit = $true; break }
    if ($scanned -ge $maxNodes) { $truncated = $true; break }
    $windowElement = Get-WindowElement $window
    if ($null -eq $windowElement) { continue }
    $searched++
    $hits = @()
    try {
      # One native, explicitly conditioned search per window. It covers the window
      # element itself and every descendant in a single provider call, which is
      # what makes a by-name search affordable on a desktop with hundreds of
      # windows: a PowerShell side walk costs milliseconds per node.
      $hits = @($windowElement.FindAll([System.Windows.Automation.TreeScope]::Subtree, $condition))
    } catch { $hits = @() }
    foreach ($hit in $hits) {
      if ($matches.Count -ge $limit) { break }
      if ($scanned -ge $maxNodes) { $truncated = $true; break }
      # Building one node record costs a hundred milliseconds of provider calls,
      # so the clock is checked here too: returning the hits found so far beats
      # being killed with no answer at all.
      if (Test-Deadline) { $truncated = $true; $deadlineHit = $true; break }
      $scanned++
      if (-not (Test-NodeMatches $hit $filter)) { continue }
      $record = New-FoundNode $hit $windowElement $window.Handle $maxDepth $memo
      if ($null -eq $record) {
        # A hit deeper than maxDepth has no ref, so it cannot be handed out; the
        # result is incomplete and says so instead of looking exhaustive.
        $dropped++
        continue
      }
      [void]$matches.Add($record)
    }
  }

  if ($matches.Count -eq 0 -and $deadlineHit) {
    # Reporting "nothing found" would be a lie when the clock, not the desktop,
    # ended the search.
    throw (New-UiaFailure 'CONTROLLER_TIMEOUT' ('the desktop search ran out of its {0} ms budget after {1} window(s) without a match' -f $script:DeadlineMs, $searched))
  }
  if ($dropped -gt 0) { $truncated = $true }

  return @{
    nodes = $matches.ToArray()
    truncated = $truncated
    searched = $searched
    scanned = $scanned
    dropped = $dropped
    windows = $search.Windows.Count
    source = $search.Source
  }
}

# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------

function Invoke-ProbeOp {
  $result = [ordered]@{
    backend = $script:Backend
    powershell = $PSVersionTable.PSVersion.ToString()
    assemblies = [bool]$script:UiaReady
    assemblyError = $script:AssemblyError
    root = $null
    rootAvailable = $false
    nodes = 0
    error = $null
  }
  if (-not $script:UiaReady) {
    $result.error = ('the UI Automation assemblies could not be loaded: {0}' -f $script:AssemblyError)
    return $result
  }
  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    if ($null -eq $root) {
      $result.error = 'AutomationElement.RootElement returned no element (no interactive desktop?)'
      return $result
    }
    $result.root = [string](Get-CurrentProperty $root 'Name' '')
    $result.nodes = Get-ChildrenCount $root
    $result.rootAvailable = $true
  } catch {
    $result.error = ('the UI Automation root is not reachable: {0}' -f $_.Exception.Message)
  }
  return $result
}

function Invoke-RootOp {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  if ($null -eq $root) {
    throw (New-UiaFailure 'CONTROLLER_UNAVAILABLE' 'AutomationElement.RootElement returned no element (no interactive desktop?)')
  }
  return @{ node = (New-NodeRecord $root 'w:0' 0 $true) }
}

function Invoke-ChildrenOp($request) {
  $ref = [string](Get-RequestProperty $request 'ref')
  $depth = Get-BoundedInt (Get-RequestProperty $request 'depth') 1 0 64
  $maxNodes = Get-BoundedInt (Get-RequestProperty $request 'maxNodes') $script:MaxNodesDefault 1 20000
  $element = Resolve-Element $ref
  $parts = Get-RefParts $ref
  $handle = $parts.Handle
  $own = Get-OwnWindowHandle $element
  if ($own -ne 0) { $handle = $own }
  $walk = Get-SubtreeNodes $element $ref $handle $depth $maxNodes $true $null
  return @{ nodes = $walk.Nodes.ToArray(); truncated = $walk.Truncated }
}

function Invoke-WindowTreeOp($request) {
  $handle = Get-RequestHandle (Get-RequestProperty $request 'windowHandle')
  if ($null -eq $handle) { $handle = 0L }
  $depth = Get-BoundedInt (Get-RequestProperty $request 'depth') $script:MaxDepthDefault 0 64
  $maxNodes = Get-BoundedInt (Get-RequestProperty $request 'maxNodes') $script:MaxNodesDefault 1 20000
  $element = Resolve-Element ('w:{0}' -f $handle)
  $windowHandle = $handle
  $own = Get-OwnWindowHandle $element
  if ($own -ne 0) { $windowHandle = $own }
  $walk = Get-SubtreeNodes $element ('w:{0}' -f $handle) $windowHandle $depth $maxNodes $true $null
  return @{ nodes = $walk.Nodes.ToArray(); truncated = $walk.Truncated; windowHandle = [string]$handle }
}

function ConvertTo-ActionFailure($errorRecord, [string]$context) {
  $type = ''
  try { $type = $errorRecord.Exception.GetType().Name } catch { $type = '' }
  $message = '{0}: {1}' -f $context, (Get-FailureMessage $errorRecord)
  if ($type -like '*ElementNotAvailable*') { return (New-UiaFailure 'TARGET_STALE' $message) }
  if ($type -like '*ElementNotEnabled*') { return (New-UiaFailure 'TARGET_NOT_ACTIONABLE' $message) }
  return (New-UiaFailure 'CONTROLLER_FAILED' $message)
}

function Invoke-InvokeOp($request) {
  $ref = [string](Get-RequestProperty $request 'ref')
  $element = Resolve-Element $ref
  $name = [string](Get-CurrentProperty $element 'Name' '')
  $role = Get-RoleName $element $ref
  $invoke = Get-PatternObject $element 'Invoke'
  if ($null -ne $invoke) {
    try { $invoke.Invoke() } catch { throw (ConvertTo-ActionFailure $_ ('InvokePattern.Invoke failed on "{0}"' -f $name)) }
    return @{ ok = $true; pattern = 'InvokePattern'; ref = $ref; name = $name; role = $role }
  }
  $selectionItem = Get-PatternObject $element 'SelectionItem'
  if ($null -ne $selectionItem) {
    try { $selectionItem.Select() } catch { throw (ConvertTo-ActionFailure $_ ('SelectionItemPattern.Select failed on "{0}"' -f $name)) }
    return @{ ok = $true; pattern = 'SelectionItemPattern'; ref = $ref; name = $name; role = $role }
  }
  $expand = Get-PatternObject $element 'ExpandCollapse'
  if ($null -ne $expand) {
    try { $expand.Expand() } catch { throw (ConvertTo-ActionFailure $_ ('ExpandCollapsePattern.Expand failed on "{0}"' -f $name)) }
    return @{ ok = $true; pattern = 'ExpandCollapsePattern'; ref = $ref; name = $name; role = $role }
  }
  $toggle = Get-PatternObject $element 'Toggle'
  if ($null -ne $toggle) {
    try { $toggle.Toggle() } catch { throw (ConvertTo-ActionFailure $_ ('TogglePattern.Toggle failed on "{0}"' -f $name)) }
    return @{ ok = $true; pattern = 'TogglePattern'; ref = $ref; name = $name; role = $role }
  }
  throw (New-UiaFailure 'TARGET_NOT_ACTIONABLE' ('"{0}" exposes none of InvokePattern, SelectionItemPattern, ExpandCollapsePattern or TogglePattern' -f $name))
}

function Invoke-SetValueOp($request) {
  $ref = [string](Get-RequestProperty $request 'ref')
  $element = Resolve-Element $ref
  $name = [string](Get-CurrentProperty $element 'Name' '')
  $text = [string](Get-RequestProperty $request 'value')
  $valuePattern = Get-PatternObject $element 'Value'
  if ($null -eq $valuePattern) {
    throw (New-UiaFailure 'TARGET_NOT_ACTIONABLE' ('"{0}" has no ValuePattern, so it accepts no value' -f $name))
  }
  $readOnly = $false
  try { $readOnly = [bool]$valuePattern.Current.IsReadOnly } catch { $readOnly = $false }
  if ($readOnly) {
    # Plan section 30: writing a read-only field would be a silent lie, so it is
    # refused before the provider gets a chance to ignore the write.
    throw (New-UiaFailure 'SAFETY_REFUSED' ('"{0}" is read-only (ValuePattern.IsReadOnly), the write was refused' -f $name))
  }
  try {
    $valuePattern.SetValue($text)
  } catch {
    throw (ConvertTo-ActionFailure $_ ('ValuePattern.SetValue failed on "{0}"' -f $name))
  }
  $observed = $null
  try { $observed = [string]$valuePattern.Current.Value } catch { $observed = $null }
  return @{ ok = $true; pattern = 'ValuePattern'; ref = $ref; name = $name; role = (Get-RoleName $element $ref); requested = $text; observed = $observed; readOnly = $false }
}

function Invoke-FocusOp($request) {
  $ref = [string](Get-RequestProperty $request 'ref')
  $element = Resolve-Element $ref
  $name = [string](Get-CurrentProperty $element 'Name' '')
  $focusable = [bool](Get-CurrentProperty $element 'IsKeyboardFocusable' $false)
  if (-not $focusable) {
    # Asking the provider to focus something it says cannot be focused produces a
    # localized COM error nobody can act on; the property read is the real reason.
    throw (New-UiaFailure 'TARGET_NOT_ACTIONABLE' ('"{0}" reports IsKeyboardFocusable=false, so it cannot take keyboard focus' -f $name))
  }
  try {
    $element.SetFocus()
  } catch {
    throw (ConvertTo-ActionFailure $_ ('SetFocus failed on "{0}"' -f $name))
  }
  $focused = [bool](Get-CurrentProperty $element 'HasKeyboardFocus' $false)
  if (-not $focused) {
    # Focus crosses process boundaries asynchronously, so one short re-read is
    # what separates "the call did nothing" from "the read was too early".
    Start-Sleep -Milliseconds 50
    $focused = [bool](Get-CurrentProperty $element 'HasKeyboardFocus' $false)
  }
  return @{
    ok = $true
    ref = $ref
    name = $name
    role = (Get-RoleName $element $ref)
    focused = $focused
    focusable = $focusable
  }
}

function Invoke-ValueOp($request) {
  $ref = [string](Get-RequestProperty $request 'ref')
  $element = Resolve-Element $ref
  $value = $null
  $readOnly = $null
  $toggle = $null
  $valuePattern = Get-PatternObject $element 'Value'
  if ($null -ne $valuePattern) {
    try { $value = [string]$valuePattern.Current.Value } catch { $value = $null }
    try { $readOnly = [bool]$valuePattern.Current.IsReadOnly } catch { $readOnly = $null }
  }
  $togglePattern = Get-PatternObject $element 'Toggle'
  if ($null -ne $togglePattern) {
    try { $toggle = $togglePattern.Current.ToggleState.ToString().ToLowerInvariant() } catch { $toggle = $null }
  }
  return @{
    ok = $true
    ref = $ref
    name = [string](Get-CurrentProperty $element 'Name' '')
    role = (Get-RoleName $element $ref)
    value = $value
    readOnly = $readOnly
    toggle = $toggle
    patterns = (Get-PatternNames $element)
  }
}

function Invoke-Request($request) {
  $op = [string](Get-RequestProperty $request 'op')
  Set-TimeBudget $request
  switch ($op) {
    'probe' { return @{ ok = $true; result = (Invoke-ProbeOp) } }
    'root' { Assert-Uia; return @{ ok = $true; result = (Invoke-RootOp) } }
    'children' { Assert-Uia; return @{ ok = $true; result = (Invoke-ChildrenOp $request) } }
    'windowTree' { Assert-Uia; return @{ ok = $true; result = (Invoke-WindowTreeOp $request) } }
    'find' { Assert-Uia; return @{ ok = $true; result = (Invoke-FindOp $request) } }
    'invoke' { Assert-Uia; return @{ ok = $true; result = (Invoke-InvokeOp $request) } }
    'setValue' { Assert-Uia; return @{ ok = $true; result = (Invoke-SetValueOp $request) } }
    'focus' { Assert-Uia; return @{ ok = $true; result = (Invoke-FocusOp $request) } }
    'value' { Assert-Uia; return @{ ok = $true; result = (Invoke-ValueOp $request) } }
    default { return @{ ok = $false; error = ('unsupported operation "{0}"' -f $op); code = 'ACTION_UNSUPPORTED' } }
  }
}

function Read-Request([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) {
    throw (New-UiaFailure 'CONTROLLER_UNAVAILABLE' 'uia.ps1 needs -Request <jsonFile>')
  }
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw (New-UiaFailure 'CONTROLLER_UNAVAILABLE' ('the request file "{0}" does not exist' -f $path))
  }
  try {
    $text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
  } catch {
    throw (New-UiaFailure 'CONTROLLER_UNAVAILABLE' ('the request file "{0}" could not be read: {1}' -f $path, $_.Exception.Message))
  }
  if ([string]::IsNullOrWhiteSpace($text)) {
    throw (New-UiaFailure 'CONTROLLER_UNAVAILABLE' ('the request file "{0}" is empty' -f $path))
  }
  try {
    return ($text | ConvertFrom-Json)
  } catch {
    throw (New-UiaFailure 'CONTROLLER_UNAVAILABLE' ('the request file "{0}" is not valid JSON: {1}' -f $path, $_.Exception.Message))
  }
}

# ---------------------------------------------------------------------------
# Entry point: one JSON line out, always exit 0
# ---------------------------------------------------------------------------

Initialize-Uia
Initialize-Patterns
Initialize-ControlTypes

$response = $null
try {
  $parsedRequest = Read-Request $Request
  $response = Invoke-Request $parsedRequest
} catch {
  $response = @{ ok = $false; error = (Get-FailureMessage $_); code = (Get-FailureCode $_) }
}

try {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $response -Depth 10 -Compress))
} catch {
  [Console]::Out.WriteLine('{"ok":false,"error":"the response could not be serialised to JSON","code":"CONTROLLER_FAILED"}')
}

exit 0
