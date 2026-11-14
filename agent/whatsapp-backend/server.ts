import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import path from 'node:path'
import { WA_PREFIX } from '../../shared/whatsapp.ts'
import { writeAtomic } from '../config.ts'
import type { Logger } from '../log.ts'
import { createWhatsApp, type WhatsApp, type WhatsAppOptions } from '../whatsapp/index.ts'

// Order o8d7e (F-223): WhatsApp's backend as its own server, on this Server only.
// - Listens on 127.0.0.1 and nowhere else; the port is 50000 or higher (WA_BACKEND_PORT). The agent's API (21221) is untouched.
// - Every request needs the backend's token (x-sad-token, from <dir>\token, made on first start, compared in constant time),
//   a Host of 127.0.0.1 or localhost, and no Origin (a browser page is refused until the page is wired in).
// - Sends are refused here: nothing can send, not even through the token (the send signer always refuses).
// - No public tunnel, no CRM or cloud sync, no deploy: nothing in this server reaches beyond this PC.

export const BACKEND_MIN_PORT = 50000
const BODY_MAX = 256 * 1024
const TOKEN_FILE = 'token'

export interface BackendOptions {
  port: number
  /** Its state folder: the token, the login and WhatsApp's packages (<dir>\lib). */
  dir: string
  log: Logger
  /** Tests: the WhatsApp part's options (script, ready, install, chrome...). */
  whatsapp?: Partial<WhatsAppOptions>
}

export interface Backend {
  port: number
  token: string
  server: Server
  wa: WhatsApp
  close(): Promise<void>
}

export function checkPort(port: number): number {
  if (!Number.isInteger(port) || port < BACKEND_MIN_PORT || port > 65535) throw new Error(`the WhatsApp backend's port must be ${BACKEND_MIN_PORT} or higher (got ${port})`)
  return port
}

/** The token for this backend: read from <dir>\token, or made (32 random bytes) on first start. */
export function backendToken(dir: string): string {
  const file = path.join(dir, TOKEN_FILE)
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(t)) return t
  }
  mkdirSync(dir, { recursive: true })
  const t = randomBytes(32).toString('hex')
  writeAtomic(file, `${t}\n`)
  return t
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

function fail(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: message }))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > BODY_MAX) throw Object.assign(new Error('the request is too large'), { status: 413 })
    chunks.push(c as Buffer)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('the body is not JSON'), { status: 400 })
  }
}

export function startBackend(o: BackendOptions): Promise<Backend> {
  const port = checkPort(o.port)
  const token = backendToken(o.dir)
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const wa = createWhatsApp({
    dir: path.join(o.dir, 'whatsapp'),
    log: o.log.child('whatsapp'),
    // Sends are refused on this server, whatever is asked of it.
    human: () => {
      throw Object.assign(new Error('sending is not open on this backend'), { status: 403 })
    },
    ...o.whatsapp,
  })

  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host === undefined || !hosts.has(req.headers.host)) return fail(res, 403, 'not this address')
      if (req.headers.origin !== undefined) return fail(res, 403, 'browser pages are not allowed here yet')
      const sent = req.headers['x-sad-token']
      if (typeof sent !== 'string' || !same(sent, token)) return fail(res, 401, 'the token is missing or wrong')
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (!url.pathname.startsWith(`${WA_PREFIX}/`) && url.pathname !== WA_PREFIX) return fail(res, 404, 'no such path')
      const rest = url.pathname.slice(WA_PREFIX.length) || '/'
      const method = (req.method ?? 'GET').toUpperCase()
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)
      const answer = await wa.mount.http({ method, rest, query: url.searchParams, body, headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(answer ?? { ok: true }))
    } catch (e) {
      const status = typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : 500
      if (status >= 500) o.log.error(`WhatsApp backend: ${(e as Error).name}`)
      fail(res, status, status >= 500 ? 'the backend could not answer' : (e as Error).message)
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      o.log.info(`WhatsApp backend on 127.0.0.1:${port} (this Server only)`)
      resolve({
        port,
        token,
        server,
        wa,
        async close() {
          await wa.close()
          await new Promise<void>(r => server.close(() => r()))
        },
      })
    })
  })
}
