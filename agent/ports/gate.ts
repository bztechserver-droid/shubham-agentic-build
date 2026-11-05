import http from 'node:http'
import net from 'node:net'
import { Duplex } from 'node:stream'
import tls from 'node:tls'
import type { Identity } from './identity.ts'

// F-114: the Ports gate. Tailscale hands it the connections to the ports this agent shares (`tailscale serve --tcp=<port> --proxy-protocol=1 tcp://127.0.0.1:<gate>`).
// Copied in shape from the phone gate (christopher-remote/proxy.mjs, read only): identity by PROXY line + whois, an Origin check, the Host rewrite, redirect rewrite, WebSockets.
// What is new: the first byte after the PROXY line says what the visitor speaks. 0x16 is a TLS ClientHello, and the gate answers it itself with this PC's real certificate;
// anything else is plain http, served as it is. So https://<name>:<port> (real certificate) and http://<100.x.y.z>:<port> (no warning) both open on ONE port.
// With `tlsBy: tailscale` (the old way) Tailscale does the TLS and everything that arrives here is plain http.
//
// Safety, in the order a visitor meets it:
//  1. No PROXY line (not through Tailscale serve)  -> dropped.
//  2. whois says the source is not a device of this tailnet (or Tailscale does not know it, or it is shared in) -> dropped.
//  3. The Host header's port must be one this agent shares right now, else 404.
//  4. A request with an Origin whose host is not one of this PC's own names or addresses is refused (403): another website cannot use a visitor's browser to drive a shared page.
//  5. Headers that Tailscale adds for its own web serve (Tailscale-User-*) are removed from the request, so a visitor cannot forge them to a program that trusts them.
//  6. F-118: every request that gets through (http, https, WebSocket) carries `x-sad-via: tailnet` and, when Tailscale names the person, `x-sad-via-login: <login>`.
//     Any `x-sad-via*` header the visitor sent is removed first (and so is its name in a Connection header), so nobody can forge it or make it vanish.
//     The agent's Accounts (sign-in level "remote") reads it. Only this gate sets it: a visit that never came through here has none.

export interface Shared {
  /** 'agent': this gate does the TLS; 'tailscale': Tailscale already did (the old way / the fallback). */
  tlsBy: 'agent' | 'tailscale'
}

export interface GateOptions {
  /** 0 = any free port. */
  port: number
  identity: Identity
  /** The TLS context of this PC's certificate, or null (then https is dropped; plain http still works). */
  cert: () => tls.SecureContext | null
  /** The ports this agent shares now. */
  shared: () => ReadonlyMap<number, Shared>
  /** Host names (lower case) that may appear as the host of an Origin: this PC's tailnet name, its short name, its Tailscale addresses. */
  originHosts: () => ReadonlySet<string>
  /**
   * F-117: plain http by this PC's NAME, on a share where this gate does the TLS, is sent on to https by name (308) so the browser lands on the padlock page, whatever was typed.
   * null = off (the setting is off, tlsBy is 'tailscale', or there is no certificate yet, so https would not open). `name` is the full tailnet name the redirect points to;
   * `hosts` are the names (the full one and the short one, lower case) that count as "by name". A bare IP (v4 or [v6]) is never redirected: no certificate can name an IP.
   */
  redirect?: () => { name: string; hosts: ReadonlySet<string> } | null
  log?: { info(m: string): void; warn(m: string): void }
  /** Test hook: the host the programs are reached on (default 'localhost'). */
  upstreamHost?: string
}

export interface Gate {
  /** The port it listens on (127.0.0.1). */
  port: number
  close(): Promise<void>
  stats(): { open: number; tls: number; plain: number; dropped: number; tlsFailed: number }
}

interface Conn {
  scheme: 'http' | 'https'
  ip: string
  /** F-118: the Tailscale login behind the device, when Tailscale names one. */
  login?: string
}

/** F-118: the header every request gets that came through this gate. */
export const VIA_HEADER = 'x-sad-via'
export const VIA_LOGIN_HEADER = 'x-sad-via-login'

/** A header value must be printable ASCII: anything else (a space, a control character, a letter outside ASCII) is percent-encoded, and the length is capped. */
export function headerSafe(v: string): string {
  let out = ''
  for (const ch of v) out += /^[\x21-\x7e]$/.test(ch) ? ch : encodeURIComponent(ch)
  return out.slice(0, 200)
}

const LOOPBACK = '127.0.0.1'

/** Wrap a connected socket (with `first` already read from it) as a plain Duplex, so TLS reads it from JS: a TLSSocket on a real socket would take its handle and lose `first`. */
function asDuplex(socket: net.Socket, first: Buffer): Duplex {
  const d = new Duplex({
    read() {
      socket.resume()
    },
    write(chunk, enc, cb) {
      socket.write(chunk, enc, cb)
    },
    final(cb) {
      socket.end(() => cb())
    },
    destroy(err, cb) {
      socket.destroy(err ?? undefined)
      cb(err)
    },
  })
  if (first.length) d.push(first)
  socket.on('data', c => {
    if (!d.push(c)) socket.pause()
  })
  socket.on('end', () => d.push(null))
  socket.on('error', e => d.destroy(e))
  socket.on('close', () => d.destroy())
  return d
}

export async function startGate(o: GateOptions): Promise<Gate> {
  const conns = new WeakMap<object, Conn>()
  const all = new Set<net.Socket>()
  const counts = { tls: 0, plain: 0, dropped: 0, tlsFailed: 0 }
  const lastDrop = new Map<string, number>()
  const upstreamHost = o.upstreamHost ?? 'localhost'

  const drop = (ip: string, why: string) => {
    counts.dropped++
    const key = ip + why
    const t = Date.now()
    if ((lastDrop.get(key) ?? 0) + 60_000 > t) return
    if (lastDrop.size > 500) lastDrop.clear()
    lastDrop.set(key, t)
    o.log?.warn(`dropped a connection: ${why}`)
  }

  // ---- layer 2: the http side

  function portOf(req: http.IncomingMessage): number {
    try {
      return Number(new URL(`http://${req.headers.host}`).port)
    } catch {
      return 0
    }
  }

  function badOrigin(req: http.IncomingMessage): string | null {
    const origin = req.headers.origin
    if (!origin) return null
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      return 'bad origin'
    }
    return o.originHosts().has(url.hostname.toLowerCase().replace(/^\[|\]$/g, '')) ? null : `origin ${url.hostname.slice(0, 80)} is not one of this PC's names`
  }

  function rewriteRequestHeaders(raw: string[], port: number, conn: Conn | undefined): string[] {
    const authority = `${upstreamHost}:${port}`
    const out: string[] = []
    for (let i = 0; i < raw.length; i += 2) {
      const lower = raw[i].toLowerCase()
      if (lower.startsWith('tailscale-') || lower.startsWith(VIA_HEADER)) continue
      if (lower === 'connection') {
        // A visitor must not be able to make the header disappear further along by naming it here (hop-by-hop).
        const kept = raw[i + 1].split(',').map(s => s.trim()).filter(s => s && !s.toLowerCase().startsWith(VIA_HEADER))
        if (kept.length) out.push(raw[i], kept.join(', '))
        continue
      }
      if (lower === 'host') out.push(raw[i], authority)
      else if (lower === 'origin') {
        // Same-origin (the page's own port) looks like the program's own address to it; a call from another shared port keeps its real Origin so the program's CORS rules still decide.
        let same = false
        try {
          same = Number(new URL(raw[i + 1]).port) === port
        } catch {
          // keep as is
        }
        out.push(raw[i], same ? `http://${authority}` : raw[i + 1])
      } else out.push(raw[i], raw[i + 1])
    }
    // F-118: set by this gate alone, after everything the visitor sent was dropped above.
    out.push(VIA_HEADER, 'tailnet')
    if (conn?.login) out.push(VIA_LOGIN_HEADER, headerSafe(conn.login))
    return out
  }

  function schemeOf(req: http.IncomingMessage, port: number): 'http' | 'https' {
    const c = conns.get(req.socket)
    return o.shared().get(port)?.tlsBy === 'tailscale' ? 'https' : (c?.scheme ?? 'http')
  }

  function rewriteResponseHeaders(raw: string[], req: http.IncomingMessage, port: number): string[] {
    const loopback = new RegExp(`^http://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=[/?#]|$)`, 'i')
    const outside = `${schemeOf(req, port)}://${req.headers.host}`
    const out: string[] = []
    for (let i = 0; i < raw.length; i += 2) out.push(raw[i], raw[i].toLowerCase() === 'location' ? raw[i + 1].replace(loopback, outside) : raw[i + 1])
    return out
  }

  /** Where plain http by name goes: https://<full name>:<port><same path and query>, or null when this request is not one to send on. */
  function redirectTo(req: http.IncomingMessage, port: number): string | null {
    const r = o.redirect?.()
    if (!r) return null
    if (conns.get(req.socket)?.scheme !== 'http') return null
    if (o.shared().get(port)?.tlsBy !== 'agent') return null
    let hostname: string
    try {
      hostname = new URL(`http://${req.headers.host}`).hostname.replace(/\.$/, '')
    } catch {
      return null
    }
    if (hostname.startsWith('[') || net.isIP(hostname) !== 0 || !r.hosts.has(hostname)) return null
    return `https://${r.name}:${port}${req.url?.startsWith('/') ? req.url : '/'}`
  }

  const web = http.createServer((req, res) => {
    const port = portOf(req)
    if (!port || !o.shared().has(port)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('No page is shared on this port.\n')
      return
    }
    const to = redirectTo(req, port)
    if (to) {
      // 308 keeps the method and the body (an API call survives it). Not cached: it must not stick in a browser the way HSTS would, and it follows the setting.
      res.writeHead(308, { location: to, 'cache-control': 'no-store', 'content-type': 'text/plain' }).end(`This page is on https: ${to}\n`)
      return
    }
    const why = badOrigin(req)
    if (why) {
      o.log?.warn(`403 on port ${port}: ${why}`)
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`Forbidden: ${why}\n`)
      return
    }
    // The rewritten headers go as a flat list, so the program sees them in the order and case the visitor sent them.
    const options = { host: upstreamHost, port, autoSelectFamily: true, method: req.method, path: req.url, headers: rewriteRequestHeaders(req.rawHeaders, port, conns.get(req.socket)), setHost: false } as http.RequestOptions
    const upstream = http.request(options, up => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, rewriteResponseHeaders(up.rawHeaders, req, port))
      up.pipe(res)
    })
    upstream.on('error', err => {
      o.log?.warn(`502 on port ${port}: ${(err as NodeJS.ErrnoException).code ?? err.message}`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`Nothing is answering on port ${port} on this PC right now.\n`)
    })
    req.pipe(upstream)
  })

  web.on('upgrade', (req, socket, head) => {
    const port = portOf(req)
    const to = port && o.shared().has(port) ? redirectTo(req, port) : null
    if (to) {
      // A WebSocket cannot follow a redirect: say so, with the address that works.
      const body = `Plain http by name is not used here: connect to ${to.replace('https://', 'wss://')} (the page itself is on ${to}).\n`
      socket.end(`HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nUpgrade: TLS/1.2\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      return
    }
    const why = !port || !o.shared().has(port) ? 'port not shared' : badOrigin(req)
    if (why) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = net.connect({ host: upstreamHost, port, autoSelectFamily: true }, () => {
      const h = rewriteRequestHeaders(req.rawHeaders, port, conns.get(req.socket))
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
      for (let i = 0; i < h.length; i += 2) raw += `${h[i]}: ${h[i + 1]}\r\n`
      upstream.write(raw + '\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    const close = () => {
      socket.destroy()
      upstream.destroy()
    }
    upstream.on('error', close)
    socket.on('error', close)
    socket.on('close', close)
  })
  web.requestTimeout = 0
  web.headersTimeout = 60_000
  web.keepAliveTimeout = 65_000

  // ---- layer 1: the raw side (PROXY line, identity, TLS or plain)

  const server = net.createServer(socket => {
    all.add(socket)
    socket.on('close', () => all.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.setTimeout(10_000, () => socket.destroy())
    let buf = Buffer.alloc(0)
    let ip = ''
    let login: string | undefined

    const onData = async (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (!ip) {
        const eol = buf.indexOf('\r\n')
        if (eol === -1) {
          if (buf.length > 108) socket.destroy()
          return
        }
        const parts = buf.subarray(0, eol).toString('latin1').split(' ')
        buf = buf.subarray(eol + 2)
        if (parts[0] !== 'PROXY' || !/^TCP[46]$/.test(parts[1] ?? '')) {
          drop('', 'no PROXY line (not through Tailscale serve)')
          return void socket.destroy()
        }
        ip = parts[2] ?? ''
        socket.pause()
        const who = await o.identity.check(ip)
        if (!who.ok) {
          drop(ip, who.why)
          return void socket.destroy()
        }
        if (socket.destroyed) return
        login = who.login
        socket.resume()
      }
      if (buf.length === 0) return
      // The first byte decides.
      socket.removeListener('data', onData)
      socket.pause()
      socket.setTimeout(0)
      if (buf[0] === 0x16) {
        const ctx = o.cert()
        if (!ctx) {
          drop(ip, 'https asked but this PC has no certificate yet')
          return void socket.destroy()
        }
        counts.tls++
        const t = new tls.TLSSocket(asDuplex(socket, buf) as unknown as net.Socket, { isServer: true, secureContext: ctx })
        // A handshake that fails is written down (what it was, from which device, at most once a minute each): without this a browser that "cannot connect" leaves no trace here.
        t.on('error', e => {
          counts.tlsFailed++
          drop(ip, `the TLS handshake with ${ip} failed: ${(e as NodeJS.ErrnoException).code ?? ''} ${e.message}`.replace(/\s+/g, ' ').slice(0, 200))
          t.destroy()
        })
        conns.set(t, { scheme: 'https', ip, login })
        web.emit('connection', t)
      } else {
        counts.plain++
        conns.set(socket, { scheme: 'http', ip, login })
        socket.unshift(buf)
        web.emit('connection', socket)
        socket.resume()
      }
    }
    socket.on('data', onData)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, LOOPBACK, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = (server.address() as net.AddressInfo).port
  o.log?.info(`the Ports gate listens on ${LOOPBACK}:${port}`)

  return {
    port,
    stats: () => ({ open: all.size, ...counts }),
    close: () =>
      new Promise<void>(resolve => {
        for (const s of all) s.destroy()
        web.closeAllConnections()
        web.close()
        server.close(() => resolve())
      }),
  }
}

