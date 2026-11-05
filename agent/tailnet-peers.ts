import type { TailnetCompare } from '../shared/agent-api.ts'
import { defaultRunner, type Runner } from './drive/tailscale.ts'
import { isDnsName, type HubRecord } from './devices.ts'
import { isTailnet } from './net.ts'

// F-110 (5 Nov 2026): finding the hub again after the tailnet changed. A member's stored address and name for the hub go stale when the hub moves to
// another tailnet; the hub itself does not change (same device ID, same key). So the member looks at the PCs on ITS OWN tailnet (`tailscale status --json`,
// read-only, the same command the agent already runs for its own name) and dials the hub's port on each. Who answers is decided by the pin (the hub's
// ID and key hash), never by the name: a PC that is not the hub fails TLS before this PC sends anything. The runner is injected so tests run no command.

export interface TailnetPeer {
  /** The machine's name as Tailscale shows it ("server"), lower case. */
  host: string
  /** Its full name on the tailnet, lower case, no trailing dot ("server.tail36192f.ts.net"), or ''. */
  dns: string
  /** Its IPv4 addresses on the tailnet. */
  ips: string[]
  online: boolean
}

export interface TailnetView {
  /** This PC's own tailnet name suffix ("tail36192f.ts.net"), or null when Tailscale does not say. */
  suffix: string | null
  /** This PC's own addresses, left out of the search. */
  selfIps: string[]
  peers: TailnetPeer[]
}

/** `tailscale status --json` as the search needs it; null when it is not running or says something else. */
export function parseTailnet(stdout: string): TailnetView | null {
  let j: {
    MagicDNSSuffix?: string
    CurrentTailnet?: { MagicDNSSuffix?: string }
    Self?: { DNSName?: string; TailscaleIPs?: string[] }
    Peer?: Record<string, { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean }>
  }
  try {
    j = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof j !== 'object' || j === null || !j.Self) return null
  const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/\.$/, '').toLowerCase() : '')
  const own = clean(j.Self.DNSName)
  const suffix = clean(j.MagicDNSSuffix) || clean(j.CurrentTailnet?.MagicDNSSuffix) || (own.includes('.') ? own.slice(own.indexOf('.') + 1) : '')
  const v4 = (ips: unknown) => (Array.isArray(ips) ? ips.filter((ip): ip is string => typeof ip === 'string' && isTailnet(ip)) : [])
  const peers: TailnetPeer[] = []
  for (const p of Object.values(j.Peer ?? {})) {
    const ips = v4(p.TailscaleIPs)
    if (!ips.length) continue
    const dns = clean(p.DNSName)
    peers.push({ host: clean(p.HostName) || dns.split('.')[0], dns, ips, online: p.Online === true })
  }
  return { suffix: suffix || null, selfIps: v4(j.Self.TailscaleIPs), peers }
}

export interface TailnetPeers {
  /** The tailnet as it is now, or null while Tailscale is not up here or does not answer. Cached a few seconds. */
  get(): Promise<TailnetView | null>
  /**
   * This PC's own tailnet name suffix, at once: what was last read, or null (Tailscale not up here, not read yet, or no answer). It looks again in the background
   * when what it knows is older than a minute, and tells `onChange` when the answer changes, so a page that is shown can follow a PC that signs in to another tailnet.
   */
  suffix(): string | null
}

export interface TailnetPeersOptions {
  run?: Runner
  ttlMs?: number
  now?: () => number
  disabled?: boolean
  /** Is Tailscale up on this PC (does it have an address)? When not, `suffix()` is null and nothing is asked. Default: assumed up. */
  up?: () => boolean
  onChange?: () => void
}

export function createTailnetPeers(o: TailnetPeersOptions = {}): TailnetPeers {
  const run = o.run ?? defaultRunner
  const now = o.now ?? Date.now
  const ttl = o.ttlMs ?? 15_000
  let cached: { at: number; view: TailnetView } | null = null
  let inflight: Promise<TailnetView | null> | null = null
  let known: string | null = null
  let askedAt = Number.NEGATIVE_INFINITY
  const get = (): Promise<TailnetView | null> => {
    if (o.disabled) return Promise.resolve(null)
    if (cached && now() - cached.at < ttl) return Promise.resolve(cached.view)
    inflight ??= run(['status', '--json'])
      .then(r => (r.code === 0 ? parseTailnet(r.stdout) : null))
      .catch(() => null)
      .then(view => {
        // A failed look is not remembered: the next failed connection asks again.
        if (view) cached = { at: now(), view }
        return view
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
  return {
    get,
    suffix() {
      if (o.disabled) return null
      if (o.up && !o.up()) {
        known = null
        askedAt = Number.NEGATIVE_INFINITY
        return null
      }
      if (now() - askedAt >= 60_000) {
        askedAt = now()
        void get().then(view => {
          const next = view?.suffix ?? null
          // A look that fails keeps what was known.
          if (view && next !== known) {
            known = next
            o.onChange?.()
          }
        })
      }
      return known
    },
  }
}

/**
 * F-110: this PC's tailnet against the hub's (shared/agent-api.ts › TailnetCompare), with the sentence the page shows when they differ.
 * `fresh`: the hub said its tailnet on the link that is up now.
 */
export function compareTailnets(mine: string | null, hub: Pick<HubRecord, 'name' | 'tailnetName'>, fresh: boolean): TailnetCompare {
  const theirs = suffixOf(hub.tailnetName)
  const state = mine && theirs ? (mine === theirs ? 'same' : 'different') : 'unknown'
  const message =
    state === 'different'
      ? `This PC is on the tailnet ${mine}, but ${hub.name} ${fresh ? 'is' : 'was last'} on ${theirs}. Sign this PC in to ${theirs}${fresh ? ' to reach it over Tailscale' : ' if it is still there'}.`
      : null
  return { mine, theirs, state, fresh, message }
}

/** The labels this hub is likely to carry on a tailnet: the first label of the name it told us, else its own name as a label ("Server" → "server"). */
export function hubLabels(hub: Pick<HubRecord, 'name' | 'tailnetName'>): string[] {
  const guess = hub.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
  return [...new Set([hub.tailnetName?.split('.')[0], guess].filter((l): l is string => Boolean(l) && isDnsName(l as string)))]
}

/**
 * The addresses to dial on this tailnet, best first: online PCs named like the hub, then the other online PCs; this PC itself and the addresses already tried
 * are left out. At most `cap`, so a big tailnet is not swept.
 */
export function rankPeers(view: TailnetView, hub: Pick<HubRecord, 'name' | 'tailnetName'>, port: number, tried: string[], cap = 12): { named: string[]; others: string[] } {
  const labels = hubLabels(hub)
  const skip = new Set([...view.selfIps, ...tried.map(a => a.replace(/:\d+$/, ''))])
  const named: string[] = []
  const others: string[] = []
  for (const p of view.peers) {
    if (!p.online) continue
    const ip = p.ips.find(a => !skip.has(a))
    if (!ip) continue
    ;(labels.includes(p.host) || labels.includes(p.dns.split('.')[0]) ? named : others).push(`${ip}:${port}`)
  }
  return { named: named.slice(0, cap), others: others.slice(0, Math.max(0, cap - named.length)) }
}

/** The part of a tailnet name after its first label ("server.tail36192f.ts.net" → "tail36192f.ts.net"), or null. */
export const suffixOf = (name: string | undefined): string | null => (name && name.includes('.') ? name.slice(name.indexOf('.') + 1) : null)
