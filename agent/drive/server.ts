import { createHash } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Logger } from '../log.ts'
import { createDavHandler, DAV_BASE } from './dav.ts'
import { createThrottle, type DriveDevices } from './devices.ts'
import type { DriveStore } from './store.ts'
import { originOf } from './tailscale.ts'

// F-097: the drive's own listener, for programs that are not the app: WebDAV today, the sync folder's API later. It listens on this PC's
// loopback only; `tailscale serve` puts an HTTPS address in front of it on the tailnet (agent/drive/tailscale.ts). Three checks on
// every request, in this order:
//   1. where it came from: a program on this PC, the owner's tailnet device, or nothing else (originOf);
//   2. a device name and its own password (HTTP Basic), with failed tries counted per address;
//   3. then the request itself.
// Off until switched on in Settings.

export interface DriveListenerOptions {
  port: number
  /** Loopback only. */
  host?: string
  store(): Promise<DriveStore | null>
  why(): string
  devices: DriveDevices
  /** The tailnet login of this machine's owner, or null when unknown (then nothing proxied from the tailnet gets in). */
  owner(): string | null
  log?: Logger
  /** The page API for sync devices under /api (a route's handler, or null): after the sign-in, with the device's name as the label of its changes. */
  api?: (rest: string) => ((req: IncomingMessage, res: ServerResponse, by?: string) => Promise<void>) | null
  /** One-time pairing: a code in, the device name it was made for out (once); and making that device's password. */
  pairing?: { redeem(code: string): string | null; createDevice(name: string): { name: string; password: string } }
  /** Tests. */
  now?: () => number
}

export interface DriveListener {
  port: number
  close(): Promise<void>
}

const REALM = 'Common Drive'

function plain(res: ServerResponse, code: number, msg: string, headers: Record<string, string | number> = {}) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(msg), ...headers })
  res.end(msg)
}

export async function startDriveListener(o: DriveListenerOptions): Promise<DriveListener> {
  const now = o.now ?? Date.now
  const dav = createDavHandler({ store: o.store, why: o.why, now })
  const throttle = createThrottle(8, 60_000, now)
  const pairThrottle = createThrottle(5, 10 * 60_000, now)
  // A device that just signed in is not asked to prove it again for a minute: scrypt is slow on purpose, and a file manager sends many requests.
  const proven = new Map<string, { user: string; until: number; revision: number }>()

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const where = originOf(req.headers, o.owner())
    if (where === 'refused') return plain(res, 403, 'This drive is for its owner, on the tailnet.')
    const fwd = req.headers['x-forwarded-for']
    const who = `${where}:${(Array.isArray(fwd) ? fwd[0] : fwd) ?? req.socket.remoteAddress ?? '?'}`
    if (throttle.blocked(who)) return plain(res, 429, 'Too many wrong passwords; wait a minute.', { 'Retry-After': 60 })

    // Pairing is the one call with no sign-in: the one-time code is the proof. Few tries, then a wait.
    if (o.pairing && req.method === 'POST' && (req.url ?? '').split('?')[0] === '/api/pair') {
      if (pairThrottle.blocked(who)) return plain(res, 429, 'Too many wrong codes; wait ten minutes.', { 'Retry-After': 600 })
      let code = ''
      try {
        const chunks: Buffer[] = []
        let n = 0
        for await (const c of req) {
          n += (c as Buffer).length
          if (n > 4096) break
          chunks.push(c as Buffer)
        }
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code?: unknown }
        code = typeof j.code === 'string' ? j.code : ''
      } catch {
        // No code: handled below.
      }
      const name = code ? o.pairing.redeem(code) : null
      if (!name) {
        pairThrottle.failed(who)
        o.log?.warn(`drive: a wrong pairing code from ${where}`)
        return plain(res, 403, 'That code is not valid, or it has expired. Make a new one on the Drive page.')
      }
      pairThrottle.ok(who)
      const made = o.pairing.createDevice(name)
      o.log?.info(`drive: "${made.name}" paired`)
      const body = JSON.stringify({ name: made.name, password: made.password })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) })
      return void res.end(body)
    }

    const auth = req.headers.authorization ?? ''
    const key = createHash('sha256').update(auth).digest('hex')
    const known = proven.get(key)
    let user = known && known.until > now() && known.revision === o.devices.revision() ? known.user : undefined
    if (!user) {
      const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(auth)
      const decoded = m ? Buffer.from(m[1], 'base64').toString('utf8') : ''
      const at = decoded.indexOf(':')
      const name = at > 0 ? decoded.slice(0, at) : ''
      const pass = at > 0 ? decoded.slice(at + 1) : ''
      if (!name || !o.devices.verify(name, pass)) {
        if (m) {
          throttle.failed(who)
          o.log?.warn(`drive: a wrong sign-in${name ? ` for "${name.slice(0, 40)}"` : ''} from ${where}`)
        }
        return plain(res, 401, 'Sign in with this device’s name and its drive password.', { 'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"` })
      }
      throttle.ok(who)
      user = name
      proven.set(key, { user: name, until: now() + 60_000, revision: o.devices.revision() })
      if (proven.size > 200) for (const [k, v] of proven) if (v.until < now()) proven.delete(k)
    }

    const path = (req.url ?? '/').split('?')[0]
    if (path === DAV_BASE || path.startsWith(`${DAV_BASE}/`)) return dav(req, res, user)
    if (path.startsWith('/api/')) {
      const handler = o.api?.(path.slice('/api'.length))
      if (handler) return handler(req, res, user)
    }
    if (path === '/') return plain(res, 200, `Common Drive. WebDAV is at ${DAV_BASE}/`)
    return plain(res, 404, 'Not found.')
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      o.log?.error(`drive listener: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
      if (!res.headersSent) plain(res, 500, 'The Common Drive could not do that.')
      else res.destroy()
    })
  })
  // A big file takes as long as it takes.
  server.requestTimeout = 0
  server.headersTimeout = 30_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, o.host ?? '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : o.port
  return {
    port,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
