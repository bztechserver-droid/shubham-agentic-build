import { readFile, stat } from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { AGENT_API_PREFIX } from '../shared/agent-api.ts'
import { fromApp, hostAllowed } from './local-host.ts'
import type { Logger } from './log.ts'

// F-020: the app as a build has no Vite dev server, so the agent serves the built page itself
// (`--app <dir>`, the build's `app/` folder) on the page port, 5173 as Vite used, so the phone's
// address through the remote gate stays the same. It does the dev server's two jobs:
//   the page   its files, index.html for any other path (the router's), the hashed assets
//              cached for good and everything else not at all
//   the API    /agent-api, HTTP and WebSocket, forwarded to this agent's own API on 127.0.0.1,
//              with the API token added only for the app's own pages (local-host.ts fromApp,
//              Vite's own rule), so the API stays guarded exactly as in dev
// As Vite does, it answers only a Host that is an IP, localhost or *.localhost (a page that
// rebound its own name to this PC is refused), and it listens on localhost only.

export interface UiServerOptions {
  /** The page port (0 picks one, for tests). */
  port: number
  host?: string
  /** The built page: index.html and assets/. */
  appDir: string
  /** The agent's API port, read per request (it may be the configured one or a picked one). */
  apiPort: () => number
  /** The API token: added for the app's own pages, never handed to anything else. */
  token: string
  log?: Logger
}

export interface UiServer {
  port: number
  close(): Promise<void>
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
}

const BLOCKED = 'Blocked request. This host is not allowed.'

function plain(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

/** The headers to forward: Host is the agent's (as Vite's changeOrigin), and the token is ours to add or not. */
function forwardHeaders(req: IncomingMessage, apiPort: number, token: string | null) {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${apiPort}` }
  delete headers['x-sad-token']
  if (token) headers['x-sad-token'] = token
  return headers
}

export function startUiServer(o: UiServerOptions): Promise<UiServer> {
  const root = path.resolve(o.appDir)
  const log = o.log
  const sockets = new Set<Duplex>()

  /** A file under the app folder for this URL path, or null (never outside it). */
  async function fileFor(urlPath: string): Promise<string | null> {
    let rel: string
    try {
      rel = decodeURIComponent(urlPath)
    } catch {
      return null
    }
    const file = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`)
    if (file !== root && !file.startsWith(root + path.sep)) return null
    try {
      return (await stat(file)).isFile() ? file : null
    } catch {
      return null
    }
  }

  async function page(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      return res.end()
    }
    let file = await fileFor(url.pathname)
    // Any other path is the router's: the page itself. A missing asset stays a 404.
    if (!file && !path.extname(url.pathname)) file = path.join(root, 'index.html')
    if (!file) return plain(res, 404, 'Not found')
    let body: Buffer
    try {
      body = await readFile(file)
    } catch {
      return plain(res, 404, 'Not found')
    }
    const hashed = file.startsWith(path.join(root, 'assets') + path.sep)
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      // Built assets carry a hash in their name; the page and the rest must be asked for again.
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  function api(req: IncomingMessage, res: ServerResponse) {
    const port = o.apiPort()
    const upstream = http.request(
      { host: '127.0.0.1', port, method: req.method, path: req.url, headers: forwardHeaders(req, port, fromApp(req.headers) ? o.token : null) },
      up => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    // The agent's API not answering: the API's own error shape, as Vite's proxy gives it.
    upstream.on('error', () => {
      if (res.headersSent) return void res.destroy()
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ error: `Nothing answers on 127.0.0.1:${port}` }))
    })
    req.pipe(upstream)
  }

  const server = http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host)) return plain(res, 403, BLOCKED)
    const url = new URL(req.url ?? '/', 'http://app')
    if (url.pathname === AGENT_API_PREFIX || url.pathname.startsWith(`${AGENT_API_PREFIX}/`)) return api(req, res)
    page(req, res, url).catch(e => {
      log?.error(`page ${url.pathname}: ${e instanceof Error ? e.message : String(e)}`)
      if (!res.headersSent) plain(res, 500, 'Internal error')
      else res.destroy()
    })
  })

  // A WebSocket for /agent-api: the handshake goes on to the agent with the token added for
  // the app's own pages, then bytes both ways; either side closing closes the other.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {})
    const url = new URL(req.url ?? '/', 'http://app')
    if (!hostAllowed(req.headers.host) || !url.pathname.startsWith(`${AGENT_API_PREFIX}/`)) {
      return socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Length: ${BLOCKED.length}\r\nConnection: close\r\n\r\n${BLOCKED}`)
    }
    const port = o.apiPort()
    const upstream = net.connect(port, '127.0.0.1')
    sockets.add(socket)
    sockets.add(upstream)
    const done = () => {
      sockets.delete(socket)
      sockets.delete(upstream)
      socket.destroy()
      upstream.destroy()
    }
    upstream.on('error', () => {
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      done()
    })
    upstream.once('connect', () => {
      const headers = forwardHeaders(req, port, fromApp(req.headers) ? o.token : null)
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    socket.on('close', done)
    upstream.on('close', done)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, o.host ?? 'localhost', () => {
      server.off('error', reject)
      server.on('error', e => log?.error(e.message))
      const port = (server.address() as net.AddressInfo).port
      log?.info(`the app's page: http://localhost:${port} (from ${root})`)
      resolve({
        port,
        close: () =>
          new Promise<void>(r => {
            for (const s of sockets) s.destroy()
            sockets.clear()
            server.close(() => r())
            server.closeAllConnections()
          }),
      })
    })
  })
}
