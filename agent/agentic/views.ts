import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Auth, Caller } from '../auth/index.ts'
import { isPageRequest } from '../auth/types.ts'
import { validSnapshot, type ViewSnapshot } from '../../shared/view-sync.ts'

const canonical = (d: ViewSnapshot) => ({ ownerId: d.ownerId, deviceKind: d.deviceKind, schemaVersion: 1, exists: d.exists, revision: d.revision, updatedAt: d.updatedAt,
  views: d.views.map(v => ({ id: v.id, deviceKind: v.deviceKind, name: v.name, count: v.count, layout: v.layout, slots: v.slots })),
})

// F-144: fixed viewer-only transport. Never reads the PC owner's CRM file.
export async function savedViewsRequest(auth: Auth | undefined, req: IncomingMessage, res: ServerResponse, caller: Caller | undefined, kind: string): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (!auth || !caller?.person || caller.machine || !isPageRequest(req.headers) || !['pc', 'phone'].includes(kind)) return send(403, { code: 'VIEW_PERSON_SESSION_REQUIRED', error: 'Sign in to sync your saved views' })
  const session = auth.viewerCrm(req.headers)
  if (!session || session.user.id.toLowerCase() !== caller.person.id) return send(401, { code: 'VIEW_SYNC_REAUTH_REQUIRED', error: 'Sign in again to sync views.' })
  const method = req.method ?? 'GET'
  if (!['GET', 'PUT'].includes(method)) return send(405, { error: 'Use GET or PUT' })
  let body: string | undefined
  if (method === 'PUT') {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > 96 * 1024) return send(413, { error: 'Saved views request exceeds 96 KiB' })
      chunks.push(chunk as Buffer)
    }
    let raw: unknown
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, { error: 'Invalid saved views JSON' }) }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'baseRevision,schemaVersion,views') return send(400, { error: 'Invalid saved views request' })
    body = JSON.stringify(raw)
  }
  try {
    const request = async () => {
      const headers: Record<string, string> = { cookie: session.cookie, accept: 'application/json' }
      if (method === 'PUT') {
        const pair = await fetch(`${session.url}/v1/auth/csrf-token`, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) })
        const data = await pair.json() as { csrfToken?: unknown }
        if (!pair.ok || typeof data.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(data.csrfToken)) throw new Error('CSRF unavailable')
        headers.cookie += `; crm_csrf=${data.csrfToken}`
        headers['x-csrf-token'] = data.csrfToken
        headers['content-type'] = 'application/json'
      }
      return fetch(`${session.url}/v1/org/agentic-views/mine/${kind}`, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(20_000) })
    }
    let response = await request()
    if (response.status === 403 && /csrf/i.test(await response.clone().text())) response = await request()
    // Revocation/sign-out during the request must not return an old person's snapshot.
    if (auth.viewerCrm(req.headers) !== session) return send(401, { code: 'VIEW_SYNC_REAUTH_REQUIRED', error: 'Sign in again to sync views.' })
    if (response.status === 401) {
      auth.forgetViewerCrm(req.headers)
      return send(401, { code: 'VIEW_SYNC_REAUTH_REQUIRED', error: 'Sign in again to sync views.' })
    }
    // Express's default missing-route response is HTML, not JSON.
    if (response.status === 404) return send(404, { code: 'VIEW_SYNC_UNSUPPORTED', error: 'Saved view sync is not available yet' })
    const data: unknown = await response.json()
    if (response.ok) {
      if (!validSnapshot(data, caller.person.id, kind as 'pc' | 'phone')) return send(502, { error: 'Invalid saved views response' })
      return send(200, { ...canonical(data), crmOrigin: new URL(session.url).origin })
    }
    // Only forward the documented conflict snapshot. Errors never contain CRM response text.
    const d = data as { code?: unknown; snapshot?: unknown }
    return send(response.status, { code: typeof d?.code === 'string' && /^VIEW_[A-Z_]+$/.test(d.code) ? d.code : 'VIEW_UNAVAILABLE', error: 'Saved views could not sync', ...(response.status === 409 && validSnapshot(d.snapshot, caller.person.id, kind as 'pc' | 'phone') ? { snapshot: canonical(d.snapshot) } : {}) })
  } catch {
    return send(503, { code: 'VIEW_UNAVAILABLE', error: 'Saved views could not sync' })
  }
}
