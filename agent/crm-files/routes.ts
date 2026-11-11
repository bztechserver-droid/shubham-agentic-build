import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { ApiMount } from '../api.ts'
import { CRM_DRIVER_CHOICES, CRM_FILES_BASE, CRM_FILES_REASONS, CRM_REVEALS, type CrmFilesErrorCode, type CrmUploadStart } from '../../shared/crm-files.ts'
import { CrmFilesError, type CrmFilesService } from './service.ts'
import type { CrmUploads } from './uploads.ts'

// F-126: the CRM files routes for the page, mounted at /agent-api/agentic/crm-files (shared/crm-files.ts says what each one takes and gives).
// Every route is a "raw" one so the errors carry their `code` and bytes are streamed, never held whole. The guard (x-sad-token, no foreign Origin) is api.ts's, before any of this runs.
// There is NO delete: a DELETE on any path is refused with 405 'nodelete'.

export const CRM_FILES_PREFIX = CRM_FILES_BASE
const MAX_JSON = 64 * 1024

function send(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
  res.end(body)
}

function fail(res: ServerResponse, e: unknown) {
  if (res.headersSent) return void res.destroy()
  // od0b1: a refusal of an upload part carries the upload as it is, so the page goes on from where the agent is.
  const upload = (e as { upload?: unknown })?.upload
  if (e instanceof CrmFilesError) return send(res, e.status, { error: e.message, code: e.code, ...(upload ? { upload } : {}) })
  const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : 500
  const code: CrmFilesErrorCode = status === 404 ? 'notfound' : 'failed'
  send(res, status, { error: e instanceof Error ? e.message : String(e), code })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_JSON) throw new CrmFilesError(413, 'toolarge', 'That request is too large.')
    chunks.push(c as Buffer)
  }
  if (!chunks.length) return {}
  try {
    const j: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof j === 'object' && j !== null && !Array.isArray(j)) return j as Record<string, unknown>
  } catch {
    // falls to the error
  }
  throw new CrmFilesError(400, 'failed', 'That request is not JSON.')
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new CrmFilesError(400, 'failed', `${what} is needed.`)
  return v
}

const q = (url: URL, name: string): string => {
  const v = url.searchParams.get(name)
  if (!v) throw new CrmFilesError(400, 'failed', `${name} is needed.`)
  return v
}

/** The size of a raw upload: Content-Length, which a streamed body must carry (Google needs the size before the first byte). */
function sizeOf(req: IncomingMessage): number {
  const raw = req.headers['content-length']
  const n = Number(raw)
  if (raw === undefined || !Number.isFinite(n) || n < 0) throw new CrmFilesError(411 as number, 'failed', 'An upload must say its size (Content-Length).')
  return n
}

const METHODS: Record<string, string[]> = {
  status: ['GET'],
  children: ['GET'],
  node: ['GET'],
  file: ['GET'],
  versions: ['GET'],
  upload: ['POST'],
  version: ['POST'],
  folder: ['POST'],
  rename: ['POST'],
  move: ['POST'],
  mount: ['GET', 'POST'],
  unmount: ['POST'],
  'mount/auto': ['POST'],
  'mount/reveal': ['POST'],
  'mount/driver': ['POST'],
}

/** od0b1: the uploads in parts (there only when the agent holds them: uploads.ts). */
const UPLOAD_METHODS: Record<string, string[]> = {
  uploads: ['GET'],
  'uploads/start': ['POST'],
  'uploads/part': ['PUT', 'POST'],
  'uploads/pause': ['POST'],
  'uploads/resume': ['POST'],
  'uploads/retry': ['POST'],
  'uploads/cancel': ['POST'],
  'uploads/clear': ['POST'],
}

/** A whole number of bytes from the query (an offset), or NaN. */
const count = (v: string | null): number => (v !== null && /^\d{1,16}$/.test(v) ? Number(v) : Number.NaN)

async function uploadRoute(up: CrmUploads, name: string, req: IncomingMessage, res: ServerResponse, url: URL) {
  switch (name) {
    case 'uploads': {
      const id = url.searchParams.get('id')
      return send(res, 200, id ? up.get(id) : up.list())
    }
    case 'uploads/start':
      return send(res, 200, await up.begin((await readJson(req)) as unknown as CrmUploadStart))
    case 'uploads/part': {
      const raw = req.headers['content-length']
      const length = count(typeof raw === 'string' ? raw : null)
      if (!Number.isFinite(length)) {
        req.destroy()
        throw new CrmFilesError(411, 'failed', 'A part must say its size (Content-Length).')
      }
      return send(res, 200, await up.receive(q(url, 'id'), count(url.searchParams.get('offset')), req, length))
    }
    case 'uploads/pause':
      return send(res, 200, await up.pause(str((await readJson(req)).id, 'id')))
    case 'uploads/resume':
      return send(res, 200, await up.resume(str((await readJson(req)).id, 'id')))
    case 'uploads/retry':
      return send(res, 200, await up.retry(str((await readJson(req)).id, 'id')))
    case 'uploads/cancel':
      return send(res, 200, await up.cancel(str((await readJson(req)).id, 'id')))
    case 'uploads/clear':
      await up.clear(str((await readJson(req)).id, 'id'))
      return send(res, 200, { ok: true })
  }
}

export function crmFilesMount(svc: CrmFilesService, uploads?: CrmUploads): ApiMount {
  return {
    prefix: CRM_FILES_PREFIX,
    http: async () => {
      throw Object.assign(new Error('No such CRM files call'), { status: 404 })
    },
    raw: (rest, url) => {
      const name = rest.replace(/^\/+/, '').replace(/\/+$/, '')
      const isUpload = !!uploads && Object.hasOwn(UPLOAD_METHODS, name)
      const allowed = Object.hasOwn(METHODS, name) ? METHODS[name] : isUpload ? UPLOAD_METHODS[name] : undefined
      if (!allowed) return null
      return async (req, res) => {
        try {
          const method = (req.method ?? 'GET').toUpperCase()
          if (method === 'DELETE') return send(res, 405, { error: CRM_FILES_REASONS.noDelete, code: 'nodelete' satisfies CrmFilesErrorCode })
          if (!allowed.includes(method)) return send(res, 405, { error: `${method} is not allowed on ${name}`, code: 'failed' satisfies CrmFilesErrorCode })
          if (uploads && isUpload) return await uploadRoute(uploads, name, req, res, url)

          switch (name) {
            case 'status':
              return send(res, 200, await svc.status())
            case 'children':
              return send(res, 200, await svc.children(url.searchParams.get('id') || 'root'))
            case 'node':
              return send(res, 200, await svc.node(q(url, 'id')))
            case 'versions':
              return send(res, 200, { versions: await svc.versions(q(url, 'id')) })
            case 'file': {
              const f = await svc.file(q(url, 'id'))
              const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
              res.writeHead(200, {
                'Content-Type': f.type,
                ...(f.size !== null ? { 'Content-Length': f.size } : {}),
                'Content-Disposition': `${url.searchParams.get('inline') === '1' ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
              })
              res.on('close', () => f.stream.destroy())
              await pipeline(f.stream, res).catch(() => undefined)
              return
            }
            case 'upload':
              return send(res, 200, { node: await svc.upload(q(url, 'parent'), q(url, 'name'), url.searchParams.get('type') ?? '', req, sizeOf(req)) })
            case 'version':
              return send(res, 200, { node: await svc.version(q(url, 'id'), url.searchParams.get('name') ?? '', url.searchParams.get('type') ?? '', req, sizeOf(req)) })
            case 'folder': {
              const b = await readJson(req)
              return send(res, 200, { node: await svc.folder(str(b.parent, 'parent'), str(b.name, 'name')) })
            }
            case 'rename': {
              const b = await readJson(req)
              return send(res, 200, { node: await svc.rename(str(b.id, 'id'), str(b.name, 'name')) })
            }
            case 'move': {
              const b = await readJson(req)
              return send(res, 200, { node: await svc.move(str(b.id, 'id'), str(b.to, 'to')) })
            }
            case 'mount':
              return send(res, 200, method === 'POST' ? await svc.mount.start() : await svc.mount.status())
            case 'unmount':
              return send(res, 200, await svc.mount.stop())
            case 'mount/auto': {
              const b = await readJson(req)
              if (typeof b.on !== 'boolean') throw new CrmFilesError(400, 'failed', 'on is needed (true or false).')
              if (!svc.mount.setAuto) throw new CrmFilesError(400, 'unsupported', CRM_FILES_REASONS.unsupported)
              return send(res, 200, await svc.mount.setAuto(b.on))
            }
            case 'mount/driver': {
              const b = await readJson(req)
              const via = CRM_DRIVER_CHOICES.find(v => v === b.via)
              if (!via) throw new CrmFilesError(400, 'failed', "via must be 'auto', 'winfsp' or 'webdav'.")
              if (!svc.mount.setDriver) throw new CrmFilesError(400, 'unsupported', CRM_FILES_REASONS.unsupported)
              return send(res, 200, await svc.mount.setDriver(via))
            }
            case 'mount/reveal': {
              // Only one of three words; the agent knows where each is. No path from the request is ever used.
              const b = await readJson(req)
              const what = CRM_REVEALS.find(w => w === b.what)
              if (!what) throw new CrmFilesError(400, 'failed', "what must be 'drive', 'pending' or 'recovered'.")
              if (!svc.mount.reveal) throw new CrmFilesError(400, 'unsupported', CRM_FILES_REASONS.unsupported)
              await svc.mount.reveal(what)
              return send(res, 200, { ok: true })
            }
          }
        } catch (e) {
          fail(res, e)
        }
      }
    },
  }
}
