# Makes the guard keep this PC's Shubham Agentic up (F-058). No admin needed.
#   Install-Guard.cmd                 install, take over from whatever runs now, start the guard
#   Install-Guard.cmd -Role hub       the first time on the hub (the role is remembered after that)
#   Install-Guard.cmd -Remove         take the guard out and go back to Start.cmd, the old way
# What it does:
#   1. registers the Scheduled Task ShubhamAgenticGuard for this user: it runs "Guard hidden.vbs" at logon
#      and every minute. The scheduler ignores a start while the guard still runs, so there is one guard
#      only; and if the guard is ever killed, the next minute starts it again;
#   2. makes the Startup launcher (shubham-agentic.vbs) run the guard instead of Start.cmd. That is what
#      Christopher on 4740 ran by hand at 22:15 on 31 Oct: now it can be run at any time, it starts nothing twice;
#   3. takes over from the old restart loop (Start.cmd's shell), by exact PID. The app it started is
#      left running: the guard adopts it, so there is no moment without the app;
#   4. starts the guard now, through the task, and waits for it to answer.
# Options for a test copy: -TaskName <name>, -NoStartup (leave the Startup folder), -NoTakeover, -NoStart.
param([string]$Role = '', [switch]$Remove, [string]$TaskName = 'ShubhamAgenticGuard', [switch]$NoStartup, [switch]$NoTakeover, [switch]$NoStart)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$launcher = Join-Path $startup 'shubham-agentic.vbs'

# guard.env (KEY=VALUE), next to this file, is the guard's environment: a test copy uses it for its own ports and state folder.
$conf = @{}
$confFile = Join-Path $here 'guard.env'
if (Test-Path $confFile) { foreach ($l in Get-Content $confFile) { if ($l -match '^\s*([^#=\s][^=]*)=(.*)$') { $conf[$matches[1].Trim()] = $matches[2].Trim() } } }
$guardPort = if ($conf['SAD_GUARD_PORT']) { [int]$conf['SAD_GUARD_PORT'] } elseif ($env:SAD_GUARD_PORT) { [int]$env:SAD_GUARD_PORT } else { 21228 }
$stateRoot = if ($conf['SAD_HOME']) { $conf['SAD_HOME'] } elseif ($env:SAD_HOME) { $env:SAD_HOME } else { Join-Path $env:LOCALAPPDATA 'shubham-agentic' }

function Get-GuardStatus {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$guardPort/status" -TimeoutSec 3 } catch { $null }
}

# The old restart loop: the cmd.exe running Start.cmd from this folder. Ended by its exact PID only (never
# with /t, never by name): what it started goes on running.
function Stop-OldLoop {
  $folder = [regex]::Escape($here)
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match $folder -and $_.CommandLine -match 'Start\.cmd' })) {
    Stop-Process -Id $p.ProcessId -Force
    "  stopped the old restart loop (Start.cmd, pid $($p.ProcessId)); the app it started goes on"
  }
}

function Set-Launcher([string]$vbs) {
  $target = (Join-Path $here $vbs).Replace('"', '""')
  Set-Content -Path $launcher -Encoding ASCII -Value @(
    "' Starts Shubham Agentic (the build) at logon, through $vbs. Made by Install-Guard.ps1 in the build folder.",
    "CreateObject(""WScript.Shell"").Run ""wscript.exe """"$target"""""", 0, False"
  )
  "  $launcher -> $vbs"
}

if ($Remove) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; "Removed the task $TaskName." } else { "There was no task $TaskName." }
  $status = Get-GuardStatus
  if ($status) {
    $tokenFile = Join-Path $stateRoot 'agent\api-token'
    if (-not (Test-Path $tokenFile)) { throw "The guard runs, but $tokenFile is missing, so it can't be asked to stop." }
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$guardPort/stop" -Headers @{ 'x-sad-token' = (Get-Content $tokenFile -Raw).Trim() } -TimeoutSec 5 | Out-Null
    for ($i = 0; $i -lt 30 -and (Get-GuardStatus); $i++) { Start-Sleep -Milliseconds 500 }
    "Stopped the guard (and the app it kept)."
  }
  if (-not $NoStartup) { Set-Launcher 'Start hidden.vbs' }
  if (-not $NoStart) {
    $line = "wscript.exe `"$(Join-Path $here 'Start hidden.vbs')`"" + $(if ($Role) { " --role $Role" } else { '' })
    $null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line; CurrentDirectory = $here }
    "Started the old way (Start.cmd)."
  }
  return
}

foreach ($tool in 'node', 'git', 'npm') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool isn't installed (or not on PATH). Install it, then run this again." }
}
Set-Location $here
if (-not (Test-Path (Join-Path $here 'node_modules'))) {
  '1. Installing its packages (npm ci)...'
  & npm ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed: see above.' }
} else { '1. Its packages are installed.' }

'2. Registering the task...'
$user = "$env:USERDOMAIN\$env:USERNAME"
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$arguments = "`"$(Join-Path $here 'Guard hidden.vbs')`"" + $(if ($Role) { " --role $Role" } else { '' })
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Keeps Shubham Agentic running: starts it at logon, and every minute if it is not running (F-058).</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>$(& $esc $user)</UserId><Delay>PT10S</Delay></LogonTrigger>
    <TimeTrigger><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled><Repetition><Interval>PT1M</Interval></Repetition></TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>$(& $esc $user)</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>wscript.exe</Command><Arguments>$(& $esc $arguments)</Arguments><WorkingDirectory>$(& $esc $here)</WorkingDirectory></Exec>
  </Actions>
</Task>
"@
Register-ScheduledTask -TaskName $TaskName -Xml $xml -Force | Out-Null
"  task ${TaskName}: at logon and every minute, one at a time"

'3. Starting it at logon through the guard...'
if ($NoStartup) { '  (left the Startup folder alone)' } else { Set-Launcher 'Guard hidden.vbs' }

'4. Taking over from the old restart loop...'
if ($NoTakeover) { '  (left it alone)' } else { Stop-OldLoop }

'5. Starting the guard...'
if ($NoStart) { '  (not started)'; return }
Start-ScheduledTask -TaskName $TaskName
$up = $null
for ($i = 0; $i -lt 90 -and -not $up; $i++) {
  Start-Sleep -Seconds 1
  $s = Get-GuardStatus
  if ($s -and $s.agent.state -eq 'up') { $up = $s }
}
if ($up) {
  "  The guard runs (pid $($up.guard.pid)); the app answers$(if ($up.agent.adopted) { ' (it was already running; the guard watches it, and starts it again if it ever stops)' } else { '' })."
  if ($up.agent.adopted) {
    "  That app was started the old way, so for now it still serves the page and runs RustDesk's servers itself. It goes under the guard completely"
    "  the next time it restarts (an Update, or at a quiet moment: node agent\guard.ts restart): then the page on $($up.guard.uiPort) never closes while it restarts,"
    "  RustDesk goes on apart from it, and the chats that were open come back by themselves."
  } else {
    "  The page is on port $($up.guard.uiPort), served by the guard: it stays open while the app restarts."
  }
} else {
  "  The guard has not reported the app up yet: see $stateRoot\guard-console.log and agent-console.log"
}
