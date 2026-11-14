import { existsSync, readFileSync } from 'node:fs'
import { WA_BACKEND_PORT, WA_BACKEND_PREFIX, WA_PREFIX } from '../../shared/whatsapp.ts'
import { apiError, type ApiMount, type MountRequest } from '../api.ts'

// Order o8416 (F-223): the WhatsApp page talks to the agent, and the agent passes its requests to the WhatsApp backend on
// 127.0.0.1 (server.ts), adding the backend's token itself. The page never sees the token.
// - This mount is not `scoped`, so the agent's own guard lets only the owner (sbskrrt) through before any of this runs.
// - Only the routes the WhatsApp page uses are passed on; anything else is 404.
// - Sends still need the backend's own answer: the backend refuses them (server.ts), so a page send cannot go through yet.

interface Route {
  method: string
  pattern: RegExp
}

const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/status$/ },
  { method: 'POST', pattern: /^\/setup$/ },
  { method: 'POST', pattern: /^\/open$/ },
  { method: 'POST', pattern: /^\/close$/ },
  { method: 'POST', pattern: /^\/pair-code$/ },
  { method: 'POST', pattern: /^\/unlink$/ },
  { method: 'PATCH', pattern: /^\/settings$/ },
  { method: 'GET', pattern: /^\/chats$/ },
  { method: 'GET', pattern: /^\/messages$/ },
  { method: 'POST', pattern: /^\/send$/ },
  { method: 'DELETE', pattern: /^\/drafts\/[^/]+$/ },
]

export const allowedRoute = (method: string, rest: string): boolean => ROUTES.some(r => r.method === method && r.pattern.test(rest))

export interface ProxyOptions {
  /** The backend's state folder: its token file is <dir>\token. */
  dir: string
  port?: number
  /** Tests: a fetch to use in place of the network. */
  fetchImpl?: typeof fetch
  /** Tests: how long one call may take. */
  timeoutMs?: number
}

export function createWhatsAppBackendProxy(o: ProxyOptions): ApiMount {
  const port = o.port ?? WA_BACKEND_PORT
  const doFetch = o.fetchImpl ?? fetch
  const timeoutMs = o.timeoutMs ?? 20_000
  const tokenFile = `${o.dir}/token`

  /** Read fresh each call: a restarted backend that made a new token is picked up at once. */
  function token(): string {
    if (!existsSync(tokenFile)) throw apiError(503, 'The WhatsApp backend is not set up on this Server yet.')
    const t = readFileSync(tokenFile, 'utf8').trim()
    if (!/^[0-9a-f]{64}$/.test(t)) throw apiError(503, 'The WhatsApp backend has no valid token yet.')
    return t
  }

  return {
    prefix: WA_BACKEND_PREFIX,
    async http(req: MountRequest): Promise<unknown> {
      const { method, rest, query, body } = req
      if (!allowedRoute(method, rest)) throw apiError(404, `No such WhatsApp path: ${method} ${rest}`)
      const qs = query.toString()
      const url = `http://127.0.0.1:${port}${WA_PREFIX}${rest}${qs ? `?${qs}` : ''}`
      const json = method !== 'GET' && method !== 'HEAD' && body !== undefined
      let res: Response
      try {
        res = await doFetch(url, {
          method,
          cache: 'no-store',
          headers: { 'x-sad-token': token(), ...(json ? { 'content-type': 'application/json' } : {}) },
          body: json ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        if ((e as { status?: number }).status !== undefined) throw e
        throw apiError(503, 'The WhatsApp backend is not running on this Server. Start it, then try again.')
      }
      const data = (await res.json().catch(() => null)) as unknown
      if (!res.ok) throw apiError(res.status, typeof (data as { error?: unknown })?.error === 'string' ? (data as { error: string }).error : `The WhatsApp backend answered ${res.status}`)
      return data
    },
  }
}
