#Requires -Version 5.1
<#
.SYNOPSIS
  Windows Firewall rules that let other PCs reach this hub's hbbs and hbbr (F-004).

.DESCRIPTION
  Adds three inbound allow rules, each limited to one program and one port:
    SAD hbbs TCP   hbbs.exe   TCP 21216
    SAD hbbs UDP   hbbs.exe   UDP 21216
    SAD hbbr TCP   hbbr.exe   TCP 21217
  on the Private and Public profiles (this PC's Wi-Fi is Public). Running it again replaces
  them, and -Remove deletes them. No other rule is changed. Needs an elevated PowerShell.
  Other enabled rules for the same two programs are reported with the command that removes
  them: a block rule (it beats these), or an allow rule wider than these (any address, all
  ports), which leaves the scope asked for not in effect.

.PARAMETER Scope
  LocalSubnet (phase 1, the default): only PCs on this LAN.
  Any (phase 2): from anywhere, once the router forwards the ports.

.PARAMETER Remove
  Delete the three rules instead.

.PARAMETER BinDir
  Where hbbs.exe and hbbr.exe are. Default: where npm run setup:hub puts them.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File agent\scripts\firewall-hub.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File agent\scripts\firewall-hub.ps1 -Scope Any
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File agent\scripts\firewall-hub.ps1 -Remove
#>
[CmdletBinding()]
param(
  [ValidateSet('LocalSubnet', 'Any')]
  [string]$Scope = 'LocalSubnet',
  [switch]$Remove,
  [string]$BinDir = (Join-Path $env:LOCALAPPDATA 'shubham-agentic\rustdesk-server'),
  [ValidateRange(1, 65535)]
  [int]$HbbsPort = 21216,
  [ValidateRange(1, 65535)]
  [int]$HbbrPort = 21217
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'This script changes Windows Firewall rules, so it needs an elevated PowerShell.' -ForegroundColor Red
  Write-Host 'Right-click PowerShell, choose "Run as administrator", and run it again. Nothing was changed.'
  exit 1
}

$hbbs = Join-Path $BinDir 'hbbs.exe'
$hbbr = Join-Path $BinDir 'hbbr.exe'
$rules = @(
  @{ Name = 'SAD hbbs TCP'; Program = $hbbs; Protocol = 'TCP'; Port = $HbbsPort; What = 'hbbs (ID/rendezvous server)' },
  @{ Name = 'SAD hbbs UDP'; Program = $hbbs; Protocol = 'UDP'; Port = $HbbsPort; What = 'hbbs (ID/rendezvous server)' },
  @{ Name = 'SAD hbbr TCP'; Program = $hbbr; Protocol = 'TCP'; Port = $HbbrPort; What = 'hbbr (relay server)' }
)

# Only ever our three rules: matched by exact display name (no wildcard characters in them).
foreach ($rule in $rules) {
  $existing = @(Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -ceq $rule.Name })
  if ($existing.Count -gt 0) {
    $existing | Remove-NetFirewallRule
    Write-Host "Removed: $($rule.Name)"
  }
}

if ($Remove) {
  Write-Host 'Done: the SAD hbbs/hbbr rules are gone.'
  exit 0
}

foreach ($exe in @($hbbs, $hbbr)) {
  if (-not (Test-Path -LiteralPath $exe)) {
    Write-Warning "$exe is not there yet (run npm run setup:hub). The rule is added anyway and applies once it is."
  }
}

foreach ($rule in $rules) {
  $params = @{
    DisplayName   = $rule.Name
    Description   = "shubham-agentic-dev F-004: lets other PCs reach this hub's $($rule.What). Made by agent\scripts\firewall-hub.ps1 -Scope $Scope."
    Group         = 'shubham-agentic'
    Direction     = 'Inbound'
    Action        = 'Allow'
    Program       = $rule.Program
    Protocol      = $rule.Protocol
    LocalPort     = $rule.Port
    RemoteAddress = $Scope
    Profile       = @('Private', 'Public')
    Enabled       = 'True'
  }
  New-NetFirewallRule @params | Out-Null
  Write-Host ("Added:   {0} -> {1} {2}/{3} from {4}" -f $rule.Name, (Split-Path -Leaf $rule.Program), $rule.Protocol, $rule.Port, $Scope)
}

# Other rules for the same two programs, which are not ours to delete, so they are reported:
#  - A block rule wins over any allow rule. Windows makes one when its first-listen prompt is
#    cancelled.
#  - An allow rule that is wider than ours (any address, more ports or protocols) lets in what
#    ours keep out, so the scope above is not what applies while it is enabled. Windows makes
#    one (named after the exe: all ports, any address, TCP and UDP) when someone allows the
#    program at that prompt. Seen on this PC on 2026-10-29.
$ours = @{ $hbbs = @{ TCP = @("$HbbsPort"); UDP = @("$HbbsPort") }; $hbbr = @{ TCP = @("$HbbrPort") } }
$wider = 0
foreach ($exe in @($hbbs, $hbbr)) {
  $ourPorts = $ours[$exe]
  $others = @(Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue |
      Get-NetFirewallRule -ErrorAction SilentlyContinue |
      Where-Object { $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' -and $_.Group -ne 'shubham-agentic' -and -not $_.DisplayName.StartsWith('SAD ') })
  foreach ($rule in $others) {
    if ($rule.Action -eq 'Block') {
      Write-Warning ("Inbound block rule '{0}' (Name {1}) for {2} overrides these allow rules. Remove it in wf.msc, or with: Remove-NetFirewallRule -Name '{1}'" -f $rule.DisplayName, $rule.Name, (Split-Path -Leaf $exe))
      continue
    }
    if ($rule.Action -ne 'Allow') { continue }
    $portFilter = @($rule | Get-NetFirewallPortFilter)
    $remote = @($rule | Get-NetFirewallAddressFilter | ForEach-Object { $_.RemoteAddress })
    $protocols = @($portFilter | ForEach-Object { "$($_.Protocol)" })
    $localPorts = @($portFilter | ForEach-Object { $_.LocalPort } | ForEach-Object { "$_" })
    $why = @()
    if ($Scope -eq 'LocalSubnet' -and @($remote | Where-Object { $_ -notin @('LocalSubnet', 'LocalSubnet4', 'LocalSubnet6') }).Count -gt 0) {
      $why += "from $($remote -join ', ')"
    }
    foreach ($protocol in $protocols) {
      if ($protocol -eq 'Any') { $why += 'any protocol'; continue }
      $allowed = if ($ourPorts.ContainsKey($protocol)) { $ourPorts[$protocol] } else { @() }
      $extra = @($localPorts | Where-Object { $_ -notin $allowed })
      if ($extra.Count -gt 0) { $why += "$protocol on ports $($localPorts -join ', ')" }
    }
    if ($why.Count -eq 0) { continue }
    $wider++
    Write-Warning ("Inbound allow rule '{0}' (Name {1}) lets {2} in {3}: wider than these rules, so -Scope {4} is not in effect while it is enabled. Remove it in wf.msc, or with: Remove-NetFirewallRule -Name '{1}'" -f $rule.DisplayName, $rule.Name, (Split-Path -Leaf $exe), ($why -join '; '), $Scope)
  }
}

if ($wider -gt 0) {
  Write-Host "Done, but not in effect yet: $wider wider allow rule(s) for hbbs/hbbr above still apply. Scope asked for: $Scope." -ForegroundColor Yellow
} else {
  Write-Host "Done. Scope: $Scope. Profiles: Private, Public."
}
