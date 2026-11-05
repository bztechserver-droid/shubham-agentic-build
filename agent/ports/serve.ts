import type { Runner } from '../drive/tailscale.ts'
import { RESERVED } from './block.ts'

// F-114: the only `tailscale serve` commands Ports runs, and how it reads `serve status --json`.
//  - NEVER funnel (public). NEVER `serve reset`. A port is added only when it has no entry; an entry is switched off only when this agent made it (the caller keeps the list).
//  - 'raw' (default): `--tcp=<port> --proxy-protocol=1 tcp://127.0.0.1:<gate>`: the bytes reach the agent's gate untouched, so the gate can tell plain http from TLS on one port.
//  - 'tls' (the old way, as the phone gate does it, and the fallback when there is no certificate): `--tls-terminated-tcp=<port> ...`: Tailscale does the TLS, by name only.

export type ServeVia = 'raw' | 'tls'

export interface ServeEntry {
  port: number
  /** 'tcp': raw forward; 'tls-tcp': TLS-terminated forward; 'https'/'http': a Tailscale web serve (the Drive's address, a hand-made one). */
  kind: 'tcp' | 'tls-tcp' | 'https' | 'http'
  /** 'host:port' of the forward target, for the two TCP kinds. */
  forward: string | null
  proxyProtocol: number
  funnel: boolean
}

/** `serve status --json` → one entry per port. Empty on "no serve config" or text that is not JSON. */
export function parseServe(stdout: string): ServeEntry[] {
  const text = stdout.trim()
  if (!text) return []
  let j: { TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string; TerminateTLS?: string; ProxyProtocol?: number }>; AllowFunnel?: Record<string, boolean> }
  try {
    j = JSON.parse(text)
  } catch {
    return []
  }
  const funnelPorts = new Set(Object.entries(j.AllowFunnel ?? {}).filter(([, on]) => on).map(([host]) => Number(host.split(':').at(-1))))
  const out: ServeEntry[] = []
  for (const [p, h] of Object.entries(j.TCP ?? {})) {
    const port = Number(p)
    if (!Number.isInteger(port) || !h) continue
    const kind: ServeEntry['kind'] = h.TCPForward ? (h.TerminateTLS ? 'tls-tcp' : 'tcp') : h.HTTPS ? 'https' : 'http'
    out.push({ port, kind, forward: h.TCPForward ?? null, proxyProtocol: h.ProxyProtocol ?? 0, funnel: funnelPorts.has(port) })
  }
  return out.sort((a, b) => a.port - b.port)
}

export interface Serve {
  /** The current entries; throws when Tailscale does not answer. */
  status(): Promise<ServeEntry[]>
  /** Adds the entry for a port that has none (the caller checked); then checks it is not a funnel (switches it off at once and throws if it is). */
  add(port: number, via: ServeVia, gatePort: number): Promise<void>
  /** Switches off an entry this agent made. */
  off(port: number, via: ServeVia): Promise<void>
}

function guard(port: number) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || RESERVED.includes(port)) throw new Error(`Ports never shares port ${port}`)
}

export function createServe(run: Runner): Serve {
  const fail = (what: string, r: { stderr: string; stdout: string }) => new Error(`tailscale ${what} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`)
  return {
    async status() {
      const r = await run(['serve', 'status', '--json'])
      if (r.code !== 0) {
        if (/no serve config|nothing is being served/i.test(r.stderr + r.stdout)) return []
        throw fail('serve status', r)
      }
      return parseServe(r.stdout)
    },
    async add(port, via, gatePort) {
      guard(port)
      const flag = via === 'raw' ? `--tcp=${port}` : `--tls-terminated-tcp=${port}`
      const r = await run(['serve', '--bg', '--yes', flag, '--proxy-protocol=1', `tcp://127.0.0.1:${gatePort}`])
      if (r.code !== 0) throw fail(`serve ${flag}`, r)
      const now = await run(['serve', 'status', '--json']).catch(() => null)
      if (now && now.code === 0 && parseServe(now.stdout).some(e => e.port === port && e.funnel)) {
        await run(['funnel', `--https=${port}`, 'off']).catch(() => undefined)
        await run(['serve', flag, 'off']).catch(() => undefined)
        throw new Error(`Port ${port} turned out to be on the public internet (funnel); it was switched off.`)
      }
    },
    async off(port, via) {
      guard(port)
      const flag = via === 'raw' ? `--tcp=${port}` : `--tls-terminated-tcp=${port}`
      const r = await run(['serve', flag, 'off'])
      if (r.code !== 0 && !/no serve config|not found|nothing|no handler/i.test(r.stderr + r.stdout)) throw fail(`serve ${flag} off`, r)
    },
  }
}
