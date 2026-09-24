param([Parameter(Mandatory=$true)][string]$Title)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# An owned real provider, not a mock UIA tree. No input is sent to the desktop.
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Width = 540
$form.Height = 260
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(20, 20)
for ($index = 0; $index -lt 4; $index++) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Title
  $button.Name = 'owned-button-' + $index
  $button.AccessibleName = $Title
  $button.SetBounds(20, 20 + 45 * $index, 480, 35)
  $form.Controls.Add($button)
}
$childOnly = New-Object System.Windows.Forms.Label
$childOnly.Text = $Title + '-child-only'
$childOnly.AccessibleName = $childOnly.Text
$childOnly.SetBounds(20, 205, 480, 20)
$form.Controls.Add($childOnly)
# Parent teardown is primary; this is a bounded backstop after a parent crash.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$script:announced = $false
$timer.Add_Tick({
  if ($script:announced) { $form.Close(); return }
  # windowsHide suppresses the PowerShell console and its first ShowWindow.
  # Re-show only our own form after its event loop starts; never activate/input
  # any unrelated window. Hidden controls are not in UIA's control view.
  $form.Hide()
  $form.Show()
  $script:announced = $true
  $timer.Interval = 60000
  [Console]::Out.WriteLine((@{ handle = $form.Handle.ToInt64().ToString(); processId = $PID; title = $Title } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
})
$timer.Start()
try { [System.Windows.Forms.Application]::Run($form) }
finally { $timer.Dispose(); $form.Dispose() }
