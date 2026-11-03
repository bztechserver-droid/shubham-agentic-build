import { execFile } from 'node:child_process'

// F-097: the one thing the drive asks of Tailscale: an HTTPS address on the tailnet (tailscale serve) in front of the WebDAV listener,
// and who the owner is, so the listener can check the identity Tailscale adds to every request it proxies.
// NEVER funnel (that is the public internet). Never one of the ports other things use. The runner is injected so tests run no command.

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}
export type Runner = (args: string[]) => Promise<RunResult>

export const defaultRunner: Runner = args =>
  new Promise(resolve => {
    execFile('tailscale', args, { timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err ? err.message : '')) })
    })
  })

/** Ports the drive must never take: web (80, 443), the manager (4740), the public preview (8443), the chat host (21229). */
export const RESERVED_PORTS: readonly number[] = [80, 443, 4740, 8443, 21229]
export const DEFAULT_HTTPS_PORT = 8444

export function checkServePort(port: number) {
  if (RESERVED_PORTS.includes(port)) throw new Error(`Port ${port} is used by something else.`)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('The HTTPS port must be between 1024 and 65535.')
}

export interface TailnetInfo {
  /** The machine's name on the tailnet, e.g. server.tailc768e5.ts.net (no trailing dot). */
  dnsName: string
  /** The login of the account that owns this machine, e.g. someone@example.com. */
  owner: string
}

/** Who and where this machine is on the tailnet, or null when Tailscale isn't running. */
export async function tailnetInfo(run: Runner = defaultRunner): Promise<TailnetInfo | null> {
  const r = await run(['status', '--json']).catch(() => null)
  if (!r || r.code !== 0) return null
  try {
    const j = JSON.parse(r.stdout) as {
      Self?: { DNSName?: string; UserID?: number }
      User?: Record<string, { LoginName?: string }>
    }
    const dnsName = j.Self?.DNSName?.replace(/\.$/, '')
    const owner = j.Self?.UserID !== undefined ? j.User?.[String(j.Self.UserID)]?.LoginName : undefined
    return dnsName && owner ? { dnsName, owner } : null
  } catch {
    return null
  }
}

export interface ServeState {
  /** Our entry is on, on this port, to this local port. */
  serving: boolean
  /** The port is on funnel (public). Must never be true for ours. */
  funnel: boolean
}

/** Reads `tailscale serve status --json` for `https://<name>:<port>`. */
export async function serveState(httpsPort: number, localPort: number, run: Runner = defaultRunner): Promise<ServeState> {
  const r = await run(['serve', 'status', '--json']).catch(() => null)
  if (!r || r.code !== 0 || !r.stdout.trim()) return { serving: false, funnel: false }
  try {
    const j = JSON.parse(r.stdout) as {
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
      AllowFunnel?: Record<string, boolean>
    }
    let serving = false
    let funnel = false
    for (const [host, web] of Object.entries(j.Web ?? {})) {
      if (!host.endsWith(`:${httpsPort}`)) continue
      if (j.AllowFunnel?.[host]) funnel = true
      for (const h of Object.values(web.Handlers ?? {})) if (h.Proxy?.includes(`:${localPort}`)) serving = true
    }
    return { serving, funnel }
  } catch {
    return { serving: false, funnel: false }
  }
}

/** Puts `https://<this machine>:<httpsPort>` in front of http://127.0.0.1:<localPort>, on the tailnet only. */
export async function serveOn(httpsPort: number, localPort: number, run: Runner = defaultRunner): Promise<void> {
  checkServePort(httpsPort)
  const r = await run(['serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`])
  if (r.code !== 0) throw new Error(`tailscale serve failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`)
  // Never public: if anything made this port a funnel, take it back off at once.
  const s = await serveState(httpsPort, localPort, run)
  if (s.funnel) {
    await run(['funnel', `--https=${httpsPort}`, 'off']).catch(() => undefined)
    throw new Error('That port turned out to be on the public internet (funnel); it was switched off.')
  }
}

/** Takes our entry away, only ours (the port is checked, so another entry can't be named by mistake). */
export async function serveOff(httpsPort: number, run: Runner = defaultRunner): Promise<void> {
  checkServePort(httpsPort)
  const r = await run(['serve', `--https=${httpsPort}`, 'off'])
  if (r.code !== 0 && !/no serve config|not found|nothing/i.test(r.stderr + r.stdout)) throw new Error(`tailscale serve off failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`)
}

/** What a request that came through `tailscale serve` carries (and a direct one on this PC does not). */
export interface TailnetHeaders {
  [name: string]: string | string[] | undefined
}

/**
 * Where a request to the WebDAV listener came from, by the headers `tailscale serve` adds when it proxies:
 *  - none of them: a program on this PC talking to the loopback port directly ('local');
 *  - the owner's login: a tailnet device of the owner ('owner');
 *  - anything else: refused, including a request through a funnel (`Tailscale-Funnel-Request`), another person's login, and a
 *    proxied request that carries no login (a tagged device or a shared node).
 */
export function originOf(headers: TailnetHeaders, owner: string | null): 'local' | 'owner' | 'refused' {
  const h = (n: string) => {
    const v = headers[n]
    return Array.isArray(v) ? v[0] : v
  }
  if (h('tailscale-funnel-request') !== undefined) return 'refused'
  const proxied = h('x-forwarded-for') !== undefined || h('x-forwarded-proto') !== undefined || h('tailscale-user-login') !== undefined || h('tailscale-user-name') !== undefined
  if (!proxied) return 'local'
  const login = h('tailscale-user-login')
  return owner && login && login.toLowerCase() === owner.toLowerCase() ? 'owner' : 'refused'
}
