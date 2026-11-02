# Installs the night watch (agent/scripts/night-watch.mjs) as a Scheduled Task: no admin needed.
#   install-night-watch.ps1 [-State <state root>] [-Build <build folder>] [-Apply] [-Remove]
# It copies the script to <state>\nightwatch\ (so no update of the app touches it), starts it at logon and every
# 5 minutes if it is not running (one at a time), and starts it now. It only looks and logs, unless -Apply is given.
param([string]$State = (Join-Path $env:LOCALAPPDATA 'shubham-agentic'), [string]$Build = '', [switch]$Apply, [switch]$Remove, [string]$TaskName = 'ShubhamAgenticNightWatch')
$ErrorActionPreference = 'Stop'
$dir = Join-Path $State 'nightwatch'
if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; "Removed the task $TaskName." }
  # Its process, by the exact PID it recorded.
  $pidFile = Join-Path $dir 'watch.pid'
  if (Test-Path $pidFile) { $p = [int](Get-Content $pidFile); $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue; if ($proc -and $proc.CommandLine -match 'night-watch\.mjs') { Stop-Process -Id $p -Force; "Stopped the watch (pid $p)." } }
  return
}
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'night-watch.mjs') (Join-Path $dir 'night-watch.mjs') -Force
$node = (Get-Command node).Source
$args2 = "`"$dir\night-watch.mjs`" --state `"$State`""
if ($Build) { $args2 += " --build `"$Build`"" }
if ($Apply) { $args2 += ' --apply' }
# A hidden launcher that waits, so the task stays "running" for as long as the watch does (and a second start is ignored).
$vbs = Join-Path $dir 'watch hidden.vbs'
Set-Content -Path $vbs -Encoding ASCII -Value @(
  "' Runs the night watch with no window and waits for it. Made by install-night-watch.ps1.",
  "Set sh = CreateObject(""WScript.Shell"")",
  "WScript.Quit sh.Run(""""""$node"""" $($args2.Replace('"','""'))"", 0, True)"
)
$user = "$env:USERDOMAIN\$env:USERNAME"
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Looks at Shubham Agentic every few seconds and keeps a night log (log only unless -Apply).</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>$(& $esc $user)</UserId><Delay>PT30S</Delay></LogonTrigger>
    <TimeTrigger><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled><Repetition><Interval>PT5M</Interval></Repetition></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$(& $esc $user)</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>$(& $esc "`"$vbs`"")</Arguments><WorkingDirectory>$(& $esc $dir)</WorkingDirectory></Exec></Actions>
</Task>
"@
Register-ScheduledTask -TaskName $TaskName -Xml $xml -Force | Out-Null
"Task ${TaskName}: at logon and every 5 minutes, one at a time. Mode: $(if ($Apply) { 'apply allowed (if the switch is on)' } else { 'log only' })."
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 4
$log = Join-Path $State 'agent\agentic\night-log.jsonl'
if (Test-Path $log) { "Night log: $log"; Get-Content $log -Tail 2 }
