# Turns this PC's screen off now the way Windows does after "Turn off display after" (F-011), so
# that with "Stay reachable when plugged in" on (agent/screen/power.ts) the PC stays awake and
# reachable behind the dark screen, and Control turns it back on. Not a message to the display
# (SC_MONITORPOWER): Windows takes that for the sleep button ("Reason SleepButton", this PC
# 2026-10-30 17:35:12), and on a Modern Standby PC that is a sleep nothing can reach.
#
# How: the display timeout, plugged in and on battery, is cut to a few seconds and put back once
# the screen has gone dark, that is once nobody has touched this PC for that long and nobody has
# been controlling it through the app for that long either (a Control session keeps the screen on
# for its picture; RustDesk does too while it is connected, which this can't see). Ten minutes at
# most. The timeouts it had are kept in a file first, so a run cut short is put right by the next.
#   powershell -ExecutionPolicy Bypass -File agent\scripts\screen-off.ps1           turn it off
#   powershell -ExecutionPolicy Bypass -File agent\scripts\screen-off.ps1 -Check    only say what it sees
# install-screen-off.ps1 puts it on the desktop as "Screen off".
param([int]$Seconds = 3, [switch]$Check)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SadIdle {
  [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint Size; public uint Time; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
  // Milliseconds since anyone touched this PC: its own mouse and keyboard, or input the app sent.
  public static long Ms() {
    var info = new LastInput { Size = 8 };
    if (!GetLastInputInfo(ref info)) return 0;
    return unchecked((uint)Environment.TickCount - info.Time);
  }
}
'@

$root = if ($env:SAD_HOME) { $env:SAD_HOME } else { Join-Path $env:LOCALAPPDATA 'shubham-agentic' }
$agentDir = Join-Path $root 'agent'
$kept = Join-Path $agentDir 'display-timeout.json'

# Seconds, plugged in and on battery. powercfg's labels follow Windows' language; its last two
# numbers are always those two.
function Get-DisplayTimeout {
  $hex = [regex]::Matches((powercfg /qh SCHEME_CURRENT SUB_VIDEO VIDEOIDLE | Out-String), '0x[0-9a-fA-F]+')
  if ($hex.Count -lt 2) { throw "couldn't read the display timeout" }
  [pscustomobject]@{ ac = [Convert]::ToInt32($hex[$hex.Count - 2].Value, 16); dc = [Convert]::ToInt32($hex[$hex.Count - 1].Value, 16) }
}

function Set-DisplayTimeout([int]$ac, [int]$dc) {
  powercfg /setacvalueindex SCHEME_CURRENT SUB_VIDEO VIDEOIDLE $ac
  powercfg /setdcvalueindex SCHEME_CURRENT SUB_VIDEO VIDEOIDLE $dc
  powercfg /setactive SCHEME_CURRENT
}

# Is anyone controlling this PC through the app? Its agent says; with no agent, nobody is.
function Test-Controlled {
  try {
    $port = 21221
    $config = Join-Path $agentDir 'config.json'
    if (Test-Path $config) {
      $api = (Get-Content $config -Raw | ConvertFrom-Json).ports.api
      if ($api) { $port = $api }
    }
    $token = (Get-Content (Join-Path $agentDir 'api-token') -Raw).Trim()
    $state = Invoke-RestMethod -Uri "http://127.0.0.1:$port/agent-api/state" -Headers @{ 'x-sad-token' = $token } -TimeoutSec 3
    return @($state.appScreen.sessions).Count -gt 0
  } catch {
    return $false
  }
}

if ($Check) {
  $now = Get-DisplayTimeout
  "Display timeout: $($now.ac) s plugged in, $($now.dc) s on battery"
  "Left from a run cut short: $(if (Test-Path $kept) { Get-Content $kept -Raw } else { 'nothing' })"
  "Someone controlling this PC through the app: $(Test-Controlled)"
  "Nobody has touched this PC for $([math]::Round([SadIdle]::Ms() / 1000)) s"
  return
}

# A run cut short left its short timeout in place: the one before it is in the file.
$before = if (Test-Path $kept) { Get-Content $kept -Raw | ConvertFrom-Json } else { Get-DisplayTimeout }
New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
Set-Content -Path $kept -Encoding UTF8 -Value ($before | ConvertTo-Json -Compress)
try {
  Set-DisplayTimeout $Seconds $Seconds
  $dark = ($Seconds + 2) * 1000
  $free = $null
  $deadline = (Get-Date).AddMinutes(10)
  while ((Get-Date) -lt $deadline) {
    # Windows counts the timeout again from when a Control session lets go of the screen.
    if (Test-Controlled) { $free = $null } elseif (-not $free) { $free = Get-Date }
    if ($free -and ((Get-Date) - $free).TotalMilliseconds -ge $dark -and [SadIdle]::Ms() -ge $dark) { break }
    Start-Sleep -Milliseconds 500
  }
} finally {
  Set-DisplayTimeout $before.ac $before.dc
  Remove-Item $kept -ErrorAction SilentlyContinue
}
