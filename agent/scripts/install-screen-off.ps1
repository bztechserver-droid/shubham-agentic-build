# Puts a "Screen off" button on this user's desktop (F-011): it runs agent\scripts\screen-off.vbs,
# which turns the screen off the way Windows' display timeout does, so with "Stay reachable when
# plugged in" on, the PC stays reachable for Control behind the dark screen. No admin needed.
#   powershell -ExecutionPolicy Bypass -File agent\scripts\install-screen-off.ps1           install
#   powershell -ExecutionPolicy Bypass -File agent\scripts\install-screen-off.ps1 -Remove   remove
param([switch]$Remove)

$link = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Screen off.lnk'

if ($Remove) {
  if (Test-Path $link) { Remove-Item $link; "Removed $link" } else { "Nothing to remove" }
  return
}

# The button only points at the repo's script, so a git pull updates what it does.
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcut.Arguments = '"' + (Join-Path $PSScriptRoot 'screen-off.vbs') + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\DisplaySwitch.exe') + ',0'
$shortcut.Description = 'Turns the screen off. Plugged in, this PC stays reachable for Control.'
$shortcut.Save()
"Installed $link"
