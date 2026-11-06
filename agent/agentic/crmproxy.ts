import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { CrmSessionInfo } from '../../shared/crm.ts'
import { apiError } from '../api.ts'
import { SESSION_MS, trimUrl } from '../claude/crm.ts'

// F-054: the CRM built into the page talks to the CRM's backend through this. The backend allows
// only the CRM's own sites as origins, so a call from this app's address would be refused by CORS;
// forwarded from here, where CORS doesn't apply, it is not. It is also what makes one sign-in
// serve both: the CRM session this PC already holds (crm-session.json, from Settings › Devices'
// sign-in) is attached here, so the page never has the CRM's cookie, and the CRM's own login
// form isn't needed (agentic-claude-manager's /api/crm-proxy, ported). The session, its cookie and
// the CSRF token are never logged, never put in an answer, and never written anywhere else.

/** The most a request body may be: it is held whole (a CSRF retry needs to send it again). */
const MAX_BODY = 25 * 1024 * 1024
const TIMEOUT_MS = 120_000

/** Not passed to the CRM: hop-by-hop, ours to set, or this app's own credentials and origin. */
const NOT_FORWARDED = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'host', 'origin', 'referer', 'content-length', 'accept-encoding', 'cookie', 'x-csrf-token', 'x-sad-token', 'x-sad-chat-key',
])
/** Not passed back: ours to set, or about the CRM's own site (the page is not a frame of it, nor a CORS client). */
const NOT_RETURNED = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'set-cookie', 'strict-transport-security',
  'content-security-policy', 'x-frame-options', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'cross-origin-embedder-policy',
])

interface Login {
  /** The CRM, without a trailing slash. */
  url: string
  /** "crm_token=<JWT>". Never leaves this file. */
  cookie: string
  name: string
  username: string | null
  expiresAt: number
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** This PC's CRM session, read as it is now (Settings › Devices signs in and out under it), or null. */
export function readLogin(file: string, now = Date.now()): Login | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isObject(raw)) return null
    const url = text(raw.url)
    const cookie = text(raw.cookie)
    const signedIn = Date.parse(String(raw.signedInAt))
    if (!url || !cookie || !/^https?:\/\//.test(url) || !Number.isFinite(signedIn)) return null
    const expiresAt = signedIn + SESSION_MS
    if (now >= expiresAt) return null
    const user = isObject(raw.user) ? raw.user : {}
    return { url: trimUrl(url), cookie, name: text(user.name) ?? text(user.username) ?? 'Signed in', username: text(user.username), expiresAt }
  } catch {
    return null
  }
}

export interface CrmProxyOptions {
  /** crm-session.json. */
  file: string
  fetch?: typeof fetch
  now?: () => number
}

export interface CrmProxy {
  /** Whether the CRM is signed in on this PC, and as whom. */
  session(): CrmSessionInfo
  /** Forwards one request of the page to the CRM, with the session; `sub` is the path after /crm-proxy/. */
  handle(req: IncomingMessage, res: ServerResponse, sub: string, search: string): Promise<void>
  /**
   * F-126: one call from this agent itself (the CRM files), with the session and, for a change, the CSRF pair (mended once, as in `handle`). `sub` is the path on the CRM, e.g. "org/files?all=true".
   * Throws a CrmNotSignedIn when nobody is signed in. The answer is the CRM's, untouched; the caller reads it.
   */
  request(method: string, sub: string, init?: { json?: unknown; body?: string | Buffer; headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response>
}

/** F-126: no CRM session on this PC (or it ran out). */
export class CrmNotSignedIn extends Error {
  constructor() {
    super('The CRM is not signed in on this PC: sign in from the CRM page, or Devices')
    this.name = 'CrmNotSignedIn'
  }
}

const MUTATES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

async function bodyOf(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw apiError(413, `A request to the CRM is at most ${MAX_BODY / 1024 / 1024} MB here`)
    chunks.push(chunk as Buffer)
  }
  return chunks.length ? Buffer.concat(chunks) : undefined
}

export function createCrmProxy(o: CrmProxyOptions): CrmProxy {
  const fetchFn = o.fetch ?? fetch
  const now = o.now ?? Date.now
  /** The CSRF token the CRM gave this session (its double-submit pair, middleware/csrf.js): kept in memory only. */
  let csrf: { cookie: string; token: string } | null = null

  async function csrfFor(login: Login, force = false): Promise<string | null> {
    if (!force && csrf && csrf.cookie === login.cookie) return csrf.token
    try {
      const r = await fetchFn(`${login.url}/v1/auth/csrf-token`, { headers: { cookie: login.cookie, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
      const body: unknown = await r.json().catch(() => null)
      const token = isObject(body) ? text(body.csrfToken) : null
      if (r.status !== 200 || !token || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) return null
      csrf = { cookie: login.cookie, token }
      return token
    } catch {
      return null
    }
  }

  return {
    async request(method, sub, init = {}) {
      const login = readLogin(o.file, now())
      if (!login) throw new CrmNotSignedIn()
      const m = method.toUpperCase()
      const base = new URL(login.url)
      const target = new URL(`/${sub.replace(/^\/+/, '')}`, base)
      if (target.origin !== base.origin) throw apiError(400, 'That is not a path on the CRM')
      const body = init.json !== undefined ? JSON.stringify(init.json) : init.body
      const send = async (force: boolean) => {
        const h: Record<string, string> = { accept: 'application/json', ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers, cookie: login.cookie }
        if (MUTATES.has(m)) {
          const token = await csrfFor(login, force)
          if (token) {
            h.cookie = `${login.cookie}; crm_csrf=${token}`
            h['x-csrf-token'] = token
          }
        }
        return fetchFn(target, { method: m, headers: h, body, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) })
      }
      let r = await send(false)
      if (MUTATES.has(m) && r.status === 403) {
        const peek = await r.clone().text().catch(() => '')
        if (/csrf/i.test(peek)) r = await send(true)
      }
      return r
    },

    session() {
      const login = readLogin(o.file, now())
      return login
        ? { signedIn: true, name: login.name, username: login.username, expiresAt: new Date(login.expiresAt).toISOString() }
        : { signedIn: false, name: null, username: null, expiresAt: null }
    },

    async handle(req, res, sub, search) {
      const login = readLogin(o.file, now())
      if (!login) throw apiError(401, 'The CRM is not signed in on this PC: sign in from the CRM page, or Devices')
      const method = (req.method ?? 'GET').toUpperCase()
      if (method === 'OPTIONS') {
        res.writeHead(204, { 'Cache-Control': 'no-store' })
        return void res.end()
      }
      if (!['GET', 'HEAD', ...MUTATES].includes(method)) throw apiError(405, `The CRM proxy doesn't forward ${method}`)

      // Only a path on the CRM: never another host, whatever the page asks for.
      const base = new URL(login.url)
      const target = new URL(`/${sub.replace(/^\/+/, '')}${search}`, base)
      if (target.origin !== base.origin) throw apiError(400, 'That is not a path on the CRM')

      const body = MUTATES.has(method) ? await bodyOf(req) : undefined
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || NOT_FORWARDED.has(k.toLowerCase()) || k.toLowerCase().startsWith('sec-')) continue
        headers[k] = Array.isArray(v) ? v.join(', ') : v
      }

      const send = async (force: boolean) => {
        const h: Record<string, string> = { ...headers, cookie: login.cookie }
        if (MUTATES.has(method)) {
          const token = await csrfFor(login, force)
          if (token) {
            h.cookie = `${login.cookie}; crm_csrf=${token}`
            h['x-csrf-token'] = token
          }
        }
        return fetchFn(target, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
      }

      let upstream: Response
      try {
        upstream = await send(false)
        // A rejected CSRF pair is mended once: ask for a new token and send it again.
        if (MUTATES.has(method) && upstream.status === 403) {
          const peek = await upstream.clone().text().catch(() => '')
          if (/csrf/i.test(peek)) upstream = await send(true)
        }
      } catch (e) {
        const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { name?: string }).name ?? 'error'
        throw apiError(502, `Couldn't reach the CRM at ${base.host}: ${code}`)
      }

      const out: Record<string, string> = { 'Cache-Control': 'no-store' }
      upstream.headers.forEach((v, k) => {
        const key = k.toLowerCase()
        if (NOT_RETURNED.has(key) || key.startsWith('access-control-') || key === 'cache-control') return
        out[k] = v
      })
      res.writeHead(upstream.status, out)
      if (!upstream.body || method === 'HEAD') return void res.end()
      Readable.fromWeb(upstream.body as never).pipe(res)
      await new Promise<void>(resolve => {
        res.once('close', resolve)
        res.once('finish', resolve)
      })
    },
  }
}
