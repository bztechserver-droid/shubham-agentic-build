import net from 'node:net'
import type { Runner } from '../drive/tailscale.ts'
import { isTailnet } from '../net.ts'

// F-114: who may open a shared page. Shubham's choice (5 Nov 2026): every device on THIS tailnet, whatever account it is signed in with; nobody from outside it.
//  - The connection arrives through `tailscale serve` with a PROXY v1 line that names the visitor's tailnet IP.
//  - `tailscale whois --json <ip>` says what that IP is. In: a node whose name ends with this tailnet's suffix (and, when both are known, whose StableTailnetID is this tailnet's),
//    that is not shared in from another tailnet (`Sharer`), and that Tailscale knows. Out: everything else, including an IP Tailscale does not know.
//  - Answers are cached 5 minutes, failures 10 seconds (the old phone gate's numbers).

export interface SelfNode {
  /** e.g. "server.tail36192f.ts.net" (no trailing dot). */
  dnsName: string
  /** e.g. "tail36192f.ts.net". */
  suffix: string
  ips: string[]
  /** This tailnet's stable ID from whois of itself, or null when it could not be read. */
  tailnetId: string | null
}

export interface PeerCheck {
  ok: boolean
  /** Why not, in a few plain words (logged by the gate, never with secrets). */
  why: string
}

export interface Identity {
  check(ip: string): Promise<PeerCheck>
  /** Forget what was learned (the tailnet changed). */
  reset(): void
}

/** A Tailscale address: 100.64.0.0/10 or fd7a:115c:a1e0::/48. */
export function isTailscaleIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isTailnet(ip)
  return net.isIPv6(ip) && ip.toLowerCase().startsWith('fd7a:115c:a1e0:')
}

/** `status --json` and `whois --json <own ip>` → what this node is, or null when Tailscale is not up. */
export async function readSelf(run: Runner): Promise<SelfNode | null> {
  const r = await run(['status', '--json']).catch(() => null)
  if (!r || r.code !== 0) return null
  try {
    const j = JSON.parse(r.stdout) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] }; MagicDNSSuffix?: string }
    const dnsName = j.Self?.DNSName?.replace(/\.$/, '').toLowerCase()
    const ips = (j.Self?.TailscaleIPs ?? []).filter(isTailscaleIp)
    if (!dnsName || ips.length === 0 || (j.BackendState && j.BackendState !== 'Running')) return null
    const suffix = (j.MagicDNSSuffix?.replace(/\.$/, '') || dnsName.split('.').slice(1).join('.')).toLowerCase()
    let tailnetId: string | null = null
    const w = await run(['whois', '--json', ips[0]]).catch(() => null)
    if (w && w.code === 0) {
      try {
        const id = (JSON.parse(w.stdout) as { Node?: { StableTailnetID?: unknown } }).Node?.StableTailnetID
        if (typeof id === 'string' && id) tailnetId = id
      } catch {
        // the id stays unknown; the name suffix still decides
      }
    }
    return { dnsName, suffix, ips, tailnetId }
  } catch {
    return null
  }
}

export function createIdentity(o: { run: Runner; self: () => SelfNode | null; now?: () => number }): Identity {
  const now = o.now ?? Date.now
  const cache = new Map<string, { result: PeerCheck; until: number }>()
  // A browser opens several connections at once from an address nobody has asked about: they share one question (and one answer).
  const asking = new Map<string, Promise<PeerCheck>>()

  async function ask(ip: string): Promise<PeerCheck> {
    const self = o.self()
    if (!self) return { ok: false, why: 'this PC does not know its own tailnet right now' }
    const r = await o.run(['whois', '--json', ip]).catch(() => null)
    if (!r || r.code !== 0) return { ok: false, why: `${ip} is unknown to Tailscale` }
    let node: { Name?: unknown; StableTailnetID?: unknown; Sharer?: unknown; IsWireGuardOnly?: unknown } | undefined
    try {
      node = (JSON.parse(r.stdout) as { Node?: typeof node }).Node
    } catch {
      return { ok: false, why: `Tailscale's answer for ${ip} could not be read` }
    }
    const name = typeof node?.Name === 'string' ? node.Name.replace(/\.$/, '').toLowerCase() : ''
    if (!name) return { ok: false, why: `${ip} is unknown to Tailscale` }
    if (node?.Sharer) return { ok: false, why: `${name} is shared in from another tailnet` }
    if (node?.IsWireGuardOnly === true) return { ok: false, why: `${name} is not a Tailscale device` }
    if (!name.endsWith('.' + self.suffix)) return { ok: false, why: `${name} is not on this tailnet (${self.suffix})` }
    if (self.tailnetId && typeof node?.StableTailnetID === 'string' && node.StableTailnetID !== self.tailnetId) return { ok: false, why: `${name} is on another tailnet` }
    return { ok: true, why: name }
  }

  return {
    async check(ip) {
      if (!isTailscaleIp(ip)) return { ok: false, why: `${ip.slice(0, 64)} is not a Tailscale address` }
      const hit = cache.get(ip)
      if (hit && hit.until > now()) return hit.result
      let pending = asking.get(ip)
      if (!pending) {
        pending = ask(ip)
          .then(result => {
            cache.set(ip, { result, until: now() + (result.ok ? 300_000 : 10_000) })
            if (cache.size > 2000) cache.clear()
            return result
          })
          .finally(() => asking.delete(ip))
        asking.set(ip, pending)
      }
      return pending
    },
    reset: () => cache.clear(),
  }
}
