import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CrmClient } from './service.ts'

// F-126: the CRM bridge for the Windows drive host (crm-fs.exe). The host is the old agentic-claude-manager's CRM Files drive and talks to "the manager" at /api/crm-proxy/... ; here that is
// this agent, on a loopback port of its own that lives only while the drive runs, behind a secret that is new every run (the host gets it in its environment, never on a command line
// and never written to a file). It forwards to the CRM with the session this PC holds (the same proxy the page uses), so the host holds no credential.
//
// Closed on purpose: only 127.0.0.1 with this port in the Host header (no DNS rebinding), no Origin (not a browser page), the secret in x-crm-fs-token, only /api/crm-proxy/org/... and
// /api/crm/session, and NEVER a DELETE.

export interface Bridge {
  /** http://127.0.0.1:<port> */
  base: string
  port: number
  /** The secret the host must send. */
  token: string
  close(): Promise<void>
}

export interface BridgeOptions {
  /** Forwards one request of the host to the CRM (agentic/crmproxy.ts `handle`). */
  forward: (req: http.IncomingMessage, res: http.ServerResponse, sub: string, search: string) => Promise<void>
  client: Pick<CrmClient, 'request'>
  /** Tests: a fixed secret. */
  token?: string
  log?: { warn(m: string): void }
}

export async function startBridge(o: BridgeOptions): Promise<Bridge> {
  const token = o.token ?? randomBytes(32).toString('base64url')
  const want = Buffer.from(token)
  let org: string | null = null

  const json = (res: http.ServerResponse, status: number, data: unknown) => {
    const body = JSON.stringify(data)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
    res.end(body)
  }

  async function orgId(): Promise<string | null> {
    if (org) return org
    try {
      const r = await o.client.request('GET', 'v1/auth/me')
      if (!r.ok) return null
      const j = (await r.json()) as { organization?: { organizationId?: unknown; id?: unknown } | null }
      const id = j.organization?.organizationId ?? j.organization?.id
      if (typeof id === 'string' && id) org = id
    } catch {
      // no answer: the host asks again
    }
    return org
  }

  let port = 0
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const host = String(req.headers.host ?? '')
        if (host !== `127.0.0.1:${port}` || req.headers.origin !== undefined) return json(res, 403, { error: 'not for this' })
        const given = Buffer.from(String(req.headers['x-crm-fs-token'] ?? ''))
        if (given.length !== want.length || !timingSafeEqual(given, want)) return json(res, 401, { error: 'no' })
        const method = (req.method ?? 'GET').toUpperCase()
        if (method === 'DELETE') return json(res, 405, { error: 'CRM files are never deleted from here.' })
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname === '/api/crm/session') {
          const id = await orgId()
          return json(res, 200, { identity: id ? { organization: { id } } : null })
        }
        const m = /^\/api\/crm-proxy\/(org\/.*)$/.exec(url.pathname)
        if (!m || m[1].includes('..')) return json(res, 404, { error: 'no such call' })
        await o.forward(req, res, m[1], url.search)
      } catch (e) {
        if (res.headersSent) return void res.destroy()
        const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : 502
        json(res, status, { error: e instanceof Error ? e.message : 'failed' })
      }
    })()
  })
  server.requestTimeout = 0
  server.keepAliveTimeout = 30_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    token,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
