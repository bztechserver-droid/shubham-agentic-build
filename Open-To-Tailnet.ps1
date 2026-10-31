#Requires -Version 5.1
<#
.SYNOPSIS
  F-028: opens this PC to the other PCs on its Tailscale network (tailnet): every port.

.DESCRIPTION
  Shubham chose "all ports on the network"; the network here is the tailnet only (Tailscale's
  addresses, 100.64.0.0/10: the PCs signed in to this Tailscale account), never the LAN or the
  internet. It adds one Windows Firewall rule, "Shubham Agentic: all ports from the tailnet",
  allowing every inbound TCP and UDP port from those addresses, on every profile; and it leaves
  the marker that tells the app to serve its page and API on this PC's Tailscale address too
  (http://<this PC's Tailscale IP>:5190, within 30 s, no restart). Anything listening on this PC
  beyond its loopback is then reachable from the other PCs.
  Asks to run as administrator (a Windows prompt). -Remove takes both away.

.EXAMPLE
  Open-To-Tailnet.cmd
.EXAMPLE
  Open-To-Tailnet.cmd -Remove
#>
[CmdletBinding()]
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$rule = 'Shubham Agentic: all ports from the tailnet'
$marker = Join-Path $env:LOCALAPPDATA 'shubham-agentic\agent\open-to-tailnet'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
# The marker is this user's (the app reads it): set first, as whoever runs this.
if ($Remove) { Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue }
else { New-Item -ItemType Directory -Force -Path (Split-Path $marker) | Out-Null; Set-Content -LiteralPath $marker -Value (Get-Date -Format o) -Encoding utf8 }
if (-not $admin) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"") + $(if ($Remove) { '-Remove' } else { @() })
  Write-Host 'Asking Windows to run this as administrator (the firewall rule needs it)...'
  Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait
  exit
}

Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) {
  Write-Host "Removed: $rule. The app's page is on this PC only again (within 30 s)."
  Start-Sleep -Seconds 3
  exit
}
foreach ($proto in 'TCP', 'UDP') {
  New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow -Protocol $proto -RemoteAddress '100.64.0.0/10' -Profile Any | Out-Null
}
Write-Host "Added: $rule (TCP and UDP, every port, from 100.64.0.0/10 only)."
Write-Host "The app's page and API will be on this PC's Tailscale address, port 5190, within 30 s."
Start-Sleep -Seconds 5
