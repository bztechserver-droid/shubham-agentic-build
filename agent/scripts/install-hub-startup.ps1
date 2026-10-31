# Makes this PC's hub agent start at logon (F-004): a small launcher in the current user's
# Startup folder runs agent\scripts\start-hub.vbs, which keeps `node agent/main.ts --role hub`
# running in the background. No admin needed.
#   powershell -ExecutionPolicy Bypass -File agent\scripts\install-hub-startup.ps1           install
#   powershell -ExecutionPolicy Bypass -File agent\scripts\install-hub-startup.ps1 -Remove   remove
param([switch]$Remove)

$startup = [Environment]::GetFolderPath('Startup')
$launcher = Join-Path $startup 'shubham-agentic-hub.vbs'
$target = Join-Path $PSScriptRoot 'start-hub.vbs'

if ($Remove) {
  if (Test-Path $launcher) { Remove-Item $launcher; "Removed $launcher" } else { "Nothing to remove" }
  return
}

# The launcher only points at the repo's script, so a git pull updates what runs.
$quoted = $target.Replace('"', '""')
Set-Content -Path $launcher -Encoding ASCII -Value @(
  "' Starts the shubham-agentic hub agent at logon. Made by agent\scripts\install-hub-startup.ps1.",
  "CreateObject(""WScript.Shell"").Run ""wscript.exe """"$quoted"""""", 0, False"
)
"Installed $launcher -> $target"
