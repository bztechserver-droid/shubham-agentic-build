import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { DriveEntry, DriveMode } from '../../shared/drive.ts'
import { sendFile } from './send-file.ts'
import { driveError, SMALL_FILE_BYTES, type DriveStore } from './store.ts'

// F-097: WebDAV on the Common Drive store, for Windows "Map network drive", Finder, Linux file managers (GNOME Files, Dolphin,
// davfs2) and phone file apps. The same rules as the page: DELETE goes to the Bin, an overwrite keeps a version, a stale save
// (If-Match) is kept beside the original as a conflict copy, names are checked the same way on every system.
// Class 1 + 2: locks are advisory (a token is handed out so Finder and Office will write; nothing is blocked by one, the versions and
// conflict copies are what protect a file). No Windows-only calls.

export const DAV_BASE = '/dav'
const MAX_XML = 256 * 1024

export interface DavOptions {
  store(): Promise<DriveStore | null>
  /** Why there is no store (shown to the client). */
  why(): string
  now?: () => number
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const hrefOf = (rel: string, dir: boolean) => `${DAV_BASE}/${rel.split('/').filter(Boolean).map(encodeURIComponent).join('/')}${dir && rel ? '/' : ''}`

/** The pool path a request URL names: decoded name by name, refusing an encoded slash. Throws 400/404 as an error with `.status`. */
export function relOf(pathname: string): string {
  if (pathname !== DAV_BASE && !pathname.startsWith(`${DAV_BASE}/`)) throw driveError(404, 'notfound', 'Not a Common Drive path.')
  const parts = pathname.slice(DAV_BASE.length).split('/').filter(p => p !== '')
  const out: string[] = []
  for (const p of parts) {
    let d: string
    try {
      d = decodeURIComponent(p)
    } catch {
      throw driveError(400, 'badname', 'Malformed path.')
    }
    if (d.includes('/') || d.includes('\\') || d.includes('\u0000')) throw driveError(400, 'badname', 'A name cannot contain a slash.')
    out.push(d)
  }
  return out.join('/')
}

/** A Destination header (a full URL or a path) as a pool path. */
export function destinationOf(header: string | undefined): string {
  if (!header) throw driveError(400, 'badname', 'No Destination.')
  let p = header
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(header)
  if (m) p = m[1] ?? '/'
  return relOf(p.split('?')[0])
}

async function body(req: IncomingMessage, max = MAX_XML): Promise<string> {
  const parts: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += (c as Buffer).length
    if (n > max) throw driveError(413, 'range', 'That request is too large.')
    parts.push(c as Buffer)
  }
  return Buffer.concat(parts).toString('utf8')
}

const status = (e: unknown): { code: number; text: string } => {
  const x = e as { status?: number; code?: string; message?: string }
  const text = e instanceof Error ? e.message : String(e)
  if (typeof x.status !== 'number') return { code: 500, text: 'The Common Drive could not do that.' }
  // WebDAV's own words for a few: out of room is 507, locked (a program has it open) is 423, the store off is 503.
  if (x.code === 'quota') return { code: 507, text }
  if (x.code === 'busy') return { code: 423, text }
  if (x.code === 'disabled') return { code: 503, text }
  if (x.code === 'case') return { code: 409, text }
  return { code: x.status, text }
}

function entryXml(e: { rel: string; entry?: DriveEntry; root?: { limit: number; used: number } }): string {
  const en = e.entry
  const dir = !en || en.kind === 'dir'
  const when = new Date(en?.mtime ?? 0)
  const props = [
    `<D:displayname>${esc(en?.name ?? '')}</D:displayname>`,
    `<D:resourcetype>${dir ? '<D:collection/>' : ''}</D:resourcetype>`,
    `<D:creationdate>${when.toISOString()}</D:creationdate>`,
    `<D:getlastmodified>${when.toUTCString()}</D:getlastmodified>`,
    ...(dir ? [] : [`<D:getcontentlength>${en?.size ?? 0}</D:getcontentlength>`, `<D:getcontenttype>${esc(en?.mime ?? 'application/octet-stream')}</D:getcontenttype>`]),
    ...(en ? [`<D:getetag>"${esc(en.etag)}"</D:getetag>`] : []),
    '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>',
    ...(e.root ? [`<D:quota-available-bytes>${Math.max(0, e.root.limit - e.root.used)}</D:quota-available-bytes>`, `<D:quota-used-bytes>${e.root.used}</D:quota-used-bytes>`] : []),
  ]
  return `<D:response><D:href>${hrefOf(e.rel, dir)}</D:href><D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
}

const multistatus = (responses: string[]) => `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`

/** The tags inside a PROPPATCH body's <prop>, echoed back so the client sees each one accepted. */
function echoProps(xml: string): string {
  const ns = new Map<string, string>()
  for (const m of xml.matchAll(/xmlns:([A-Za-z0-9_]+)="([^"]+)"/g)) ns.set(m[1], m[2])
  const dflt = /xmlns="([^"]+)"/.exec(xml)?.[1]
  const out = new Set<string>()
  for (const block of xml.matchAll(/<(?:[A-Za-z0-9_]+:)?prop[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?prop>/g)) {
    for (const t of block[1].matchAll(/<(?:([A-Za-z0-9_]+):)?([A-Za-z0-9_]+)(?=[\s/>])/g)) {
      const [, p, name] = t
      if (p && ns.has(p)) out.add(`<${p}:${name} xmlns:${p}="${esc(ns.get(p) as string)}"/>`)
      else if (!p && dflt) out.add(`<${name} xmlns="${esc(dflt)}"/>`)
    }
  }
  return [...out].join('')
}

interface Lock {
  token: string
  owner: string
  expires: number
}

/** Hands the bytes of a request to the store in pieces (a file of any size, never whole in memory). */
export async function putStream(
  s: DriveStore,
  rel: string,
  req: Readable,
  length: number | null,
  opt: { mode: DriveMode; baseEtag?: string; modified?: number },
  by: string,
): Promise<ReturnType<DriveStore['putFile']>> {
  if (length === null || length <= SMALL_FILE_BYTES) return s.putFile(rel, req, { ...opt, size: length ?? undefined }, { by })
  const up = await s.startUpload({ path: rel, size: length, mode: opt.mode, baseEtag: opt.baseEtag, modified: opt.modified }, { by })
  try {
    let offset = 0
    let parts: Buffer[] = []
    let heldLen = 0
    /** Sends whole pieces of exactly pieceBytes (all of what is held when `all`). */
    const flush = async (all: boolean) => {
      if (!heldLen || (!all && heldLen < up.pieceBytes)) return
      let held = Buffer.concat(parts, heldLen)
      while (held.length >= up.pieceBytes || (all && held.length > 0)) {
        const piece = held.subarray(0, up.pieceBytes)
        held = held.subarray(piece.length)
        await s.putPiece(up.id, offset, Readable.from([piece]))
        offset += piece.length
      }
      parts = held.length ? [held] : []
      heldLen = held.length
    }
    for await (const chunk of req) {
      parts.push(chunk as Buffer)
      heldLen += (chunk as Buffer).length
      await flush(false)
    }
    await flush(true)
    return await s.commitUpload(up.id)
  } catch (e) {
    await s.abortUpload(up.id)
    throw e
  }
}

export function createDavHandler(o: DavOptions) {
  const now = o.now ?? Date.now
  const locks = new Map<string, Lock>()
  const lockOf = (rel: string) => {
    const l = locks.get(rel)
    if (l && l.expires < now()) {
      locks.delete(rel)
      return undefined
    }
    return l
  }
  const lockXml = (l: Lock) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth><D:owner>${esc(l.owner)}</D:owner><D:timeout>Second-${Math.max(1, Math.round((l.expires - now()) / 1000))}</D:timeout><D:locktoken><D:href>${l.token}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`

  const text = (res: ServerResponse, code: number, msg = '', headers: Record<string, string | number> = {}) => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(msg), ...headers })
    res.end(msg)
  }
  const xml = (res: ServerResponse, code: number, doc: string, headers: Record<string, string | number> = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(doc), ...headers })
    res.end(doc)
  }

  async function statOrNull(s: DriveStore, rel: string): Promise<DriveEntry | null> {
    try {
      return await s.stat(rel)
    } catch (e) {
      if ((e as { code?: string }).code === 'notfound') return null
      throw e
    }
  }
  const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
  const requireParent = async (s: DriveStore, rel: string) => {
    const p = await statOrNull(s, parentOf(rel))
    if (!p || p.kind !== 'dir') throw Object.assign(driveError(409, 'notfound', 'The folder above does not exist.'), { status: 409 })
  }

  return async function dav(req: IncomingMessage, res: ServerResponse, by: string): Promise<void> {
    const method = req.method ?? 'GET'
    try {
      const url = new URL(req.url ?? '/', 'http://dav')
      if (method === 'OPTIONS') {
        res.writeHead(200, {
          DAV: '1, 2',
          'MS-Author-Via': 'DAV',
          Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, PROPFIND, PROPPATCH, LOCK, UNLOCK',
          'Content-Length': 0,
        })
        return void res.end()
      }
      const rel = relOf(url.pathname)
      const s = await o.store()
      if (!s) return text(res, 503, o.why())

      switch (method) {
        case 'PROPFIND': {
          const depth = String(req.headers.depth ?? '1')
          await body(req)
          if (depth === 'infinity') return text(res, 403, 'Use Depth 0 or 1.')
          const en = rel === '' ? null : await statOrNull(s, rel)
          if (rel !== '' && !en) return text(res, 404, 'Not found.')
          const st = rel === '' ? await s.status() : null
          const root = st ? { limit: st.limitBytes, used: st.usedBytes } : undefined
          const top: DriveEntry = en ?? { name: '', path: '', kind: 'dir', size: 0, mtime: st?.now ?? now(), etag: 'd-root' }
          const out = [entryXml({ rel, entry: top, root })]
          if (top.kind === 'dir' && depth !== '0') {
            let cursor: string | undefined
            do {
              const page = await s.list(rel, { cursor, limit: 1000 })
              for (const c of page.entries) out.push(entryXml({ rel: c.path, entry: c }))
              cursor = page.next
            } while (cursor)
          }
          return xml(res, 207, multistatus(out))
        }

        case 'PROPPATCH': {
          const echoed = echoProps(await body(req))
          if (rel !== '' && !(await statOrNull(s, rel))) return text(res, 404, 'Not found.')
          const doc = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:"><D:response><D:href>${hrefOf(rel, false)}</D:href><D:propstat><D:prop>${echoed}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`
          return xml(res, 207, doc)
        }

        case 'GET':
        case 'HEAD':
          return await sendFile(req, res, s, rel, { download: false })

        case 'PUT': {
          if (rel === '') return text(res, 405, 'Cannot write to the top folder.')
          const existing = await statOrNull(s, rel)
          if (existing?.kind === 'dir') return text(res, 405, 'That is a folder.')
          await requireParent(s, rel)
          const len = req.headers['content-length']
          const length = len === undefined ? null : Number(len)
          if (length === null && req.headers['transfer-encoding'] === undefined) return text(res, 411, 'Length required.')
          const ifMatch = String(req.headers['if-match'] ?? '').replace(/^W\//, '').replace(/"/g, '')
          const noOverwrite = req.headers['if-none-match'] === '*'
          let mode: DriveMode = 'create'
          if (existing) {
            if (noOverwrite) return text(res, 412, 'It already exists.')
            mode = ifMatch && ifMatch !== '*' ? 'ifmatch' : 'overwrite'
          }
          const modified = Date.parse(String(req.headers['x-oc-mtime'] ?? ''))
          const done = await putStream(s, rel, req, length, { mode, baseEtag: ifMatch || undefined, modified: Number.isFinite(modified) ? modified : undefined }, by)
          if (done.conflict) return text(res, 201, 'Saved beside the original: it changed meanwhile.', { Location: hrefOf(done.entry.path, false), 'Content-Location': hrefOf(done.entry.path, false) })
          return text(res, existing ? 204 : 201, '', { ETag: `"${done.entry.etag}"` })
        }

        case 'DELETE': {
          if (rel === '') return text(res, 403, 'Cannot delete the top folder.')
          if (!(await statOrNull(s, rel))) return text(res, 404, 'Not found.')
          await s.remove(rel, { by })
          locks.delete(rel)
          return text(res, 204)
        }

        case 'MKCOL': {
          if ((await body(req)).length) return text(res, 415, 'No body allowed.')
          if (rel === '' || (await statOrNull(s, rel))) return text(res, 405, 'It already exists.')
          await requireParent(s, rel)
          await s.mkdir(rel, { by })
          return text(res, 201)
        }

        case 'MOVE':
        case 'COPY': {
          const to = destinationOf(String(req.headers.destination ?? ''))
          if (rel === '' || to === '') return text(res, 403, 'Not the top folder.')
          if (!(await statOrNull(s, rel))) return text(res, 404, 'Not found.')
          if (to.toLowerCase() === rel.toLowerCase() && to === rel) return text(res, 403, 'Source and destination are the same.')
          const target = await statOrNull(s, to)
          const keep = String(req.headers.overwrite ?? 'T').toUpperCase() === 'F'
          if (target && keep) return text(res, 412, 'The destination exists.')
          await requireParent(s, to)
          const mode: DriveMode = target ? 'overwrite' : 'create'
          if (method === 'MOVE') await s.move(rel, to, mode, { by })
          else await s.copy(rel, to, mode, { by })
          return text(res, target ? 204 : 201)
        }

        case 'LOCK': {
          const reqBody = await body(req)
          const held = lockOf(rel)
          const timeout = Math.min(7200, Math.max(60, Number(/Second-(\d+)/i.exec(String(req.headers.timeout ?? ''))?.[1] ?? 3600)))
          const exists = rel === '' || (await statOrNull(s, rel)) !== null
          if (held && reqBody.length === 0) {
            held.expires = now() + timeout * 1000
            return xml(res, 200, lockXml(held))
          }
          const owner = /<(?:[A-Za-z0-9_]+:)?owner[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?owner>/.exec(reqBody)?.[1]?.replace(/<[^>]+>/g, '').trim() || by
          const lock: Lock = { token: `opaquelocktoken:${randomUUID()}`, owner, expires: now() + timeout * 1000 }
          locks.set(rel, lock)
          return xml(res, exists ? 200 : 201, lockXml(lock), { 'Lock-Token': `<${lock.token}>` })
        }

        case 'UNLOCK':
          locks.delete(rel)
          return text(res, 204)

        default:
          return text(res, 405, 'Not supported.', { Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, PROPFIND, PROPPATCH, LOCK, UNLOCK' })
      }
    } catch (e) {
      if (res.headersSent) return void res.destroy()
      const { code, text: msg } = status(e)
      text(res, code, msg)
    }
  }
}
