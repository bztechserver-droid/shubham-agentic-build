import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CRM_FILES_MAX_UPLOAD, CRM_FILES_REASONS, type CrmNode } from '../../shared/crm-files.ts'
import { driveType } from '../drive/mime.ts'
import { CrmFilesError, type CrmFilesService } from './service.ts'

// F-126 (Linux): the CRM files as WebDAV, for GNOME's gvfs (`gio mount dav://127.0.0.1:<port>/crm/`). It runs inside the agent and calls the CRM files service directly
// (no token anywhere). The rights are the old drive's: browse, open, new files, new folders in a project, rename, move, save over a file as a new version, NEVER delete.
//   PROPFIND browse · GET/HEAD open · PUT new name = a new file, PUT over a file = a new version · MKCOL a new folder · MOVE rename/move · COPY a new file
//   DELETE 403 with plain words · LOCK/UNLOCK advisory (so office programs save) · PROPPATCH accepted and ignored
// Names: the CRM's own names, made legal for Linux ('/' and NUL become '_'); two siblings with the same name get a stable suffix from their id.
// The little files programs make beside a document (LibreOffice's .~lock.*#, editors' backups, ~$ files) and an empty new file (Files' "New Document") are kept in this
// process only, so they never become CRM records. An empty new file goes to the CRM once something is saved into it.

export const CRM_DAV_BASE = '/crm'
const MAX_XML = 256 * 1024
/** The most the memory-only side files may hold together. */
const SIDE_MAX = 64 * 1024 * 1024

export interface CrmDavOptions {
  service(): CrmFilesService | null
  /** The time used for folders the CRM gives no time (the root, a category): fixed, so a file manager does not think they changed. */
  started?: number
  log?: { info(m: string): void; warn(m: string): void }
}

/** A side file, or an empty new file waiting for its first bytes. */
interface Side {
  bytes: Buffer
  mtime: number
  /** An empty file of a normal name: becomes a CRM file on its first save. */
  pending: boolean
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Names programs make next to a document: kept in memory here, never sent to the CRM. */
export function isSideName(name: string): boolean {
  return /^(\.~lock\..*#|~\$.*|\.goutputstream-.*|\.#.*|\._.*|.*~|.*\.sw[a-p]|.*\.tmp|\.directory|\.hidden|desktop\.ini|thumbs\.db|\.ds_store)$/i.test(name)
}

/** The CRM's name made legal for Linux. */
export function legalName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const n = name.replace(/[/\u0000]/g, '_')
  return n === '' || n === '.' || n === '..' ? `_${n}` : n
}

const idTail = (id: string) => (id.split(':').pop() ?? id).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'x'

/** The children under their names on the drive: legal, and unique (the first by id keeps the name, the others get " (<id>)" before the extension). */
export function namesOf(children: CrmNode[]): Map<string, CrmNode> {
  const groups = new Map<string, CrmNode[]>()
  for (const c of children) {
    const n = legalName(c.name)
    groups.set(n, [...(groups.get(n) ?? []), c])
  }
  const out = new Map<string, CrmNode>()
  for (const [n, list] of groups) {
    const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    sorted.forEach((c, i) => {
      if (i === 0) return void out.set(n, c)
      const dot = c.isFolder ? -1 : n.lastIndexOf('.')
      const stem = dot > 0 ? n.slice(0, dot) : n
      const ext = dot > 0 ? n.slice(dot) : ''
      out.set(`${stem} (${idTail(c.id)})${ext}`, c)
    })
  }
  return out
}

/** The names a request path holds, decoded one by one (an encoded slash is refused). Null when it is not under /crm. */
export function partsOf(pathname: string): string[] | null {
  if (pathname !== CRM_DAV_BASE && !pathname.startsWith(`${CRM_DAV_BASE}/`)) return null
  const out: string[] = []
  for (const p of pathname.slice(CRM_DAV_BASE.length).split('/')) {
    if (p === '') continue
    let d: string
    try {
      d = decodeURIComponent(p)
    } catch {
      throw new CrmFilesError(400, 'badname', 'Malformed path.')
    }
    if (d.includes('/') || d.includes('\u0000')) throw new CrmFilesError(400, 'badname', 'A name cannot hold a slash.')
    out.push(d)
  }
  return out
}

const hrefOf = (parts: string[], dir: boolean) => `${CRM_DAV_BASE}/${parts.map(encodeURIComponent).join('/')}${dir && parts.length ? '/' : ''}`

function destinationParts(header: string | undefined): string[] {
  if (!header) throw new CrmFilesError(400, 'badname', 'No Destination.')
  let p = header
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(header)
  if (m) p = m[1] ?? '/'
  const parts = partsOf(p.split('?')[0])
  if (!parts) throw new CrmFilesError(400, 'badname', 'That is not on the CRM drive.')
  return parts
}

async function readAll(req: Readable, max: number): Promise<Buffer> {
  const parts: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += (c as Buffer).length
    if (n > max) throw new CrmFilesError(413, 'toolarge', 'That is too large for this.')
    parts.push(c as Buffer)
  }
  return Buffer.concat(parts)
}

/** Passes on bytes [start, end] of a stream and drops the rest. */
function slice(start: number, end: number): Transform {
  let at = 0
  return new Transform({
    transform(chunk: Buffer, _e, cb) {
      const from = Math.max(0, start - at)
      const to = Math.min(chunk.length, end + 1 - at)
      at += chunk.length
      cb(null, from < to ? chunk.subarray(from, to) : undefined)
    },
  })
}

function send(res: ServerResponse, code: number, msg = '', headers: Record<string, string | number> = {}) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(msg), ...headers })
  res.end(msg)
}

function sendXml(res: ServerResponse, code: number, body: string, headers: Record<string, string | number> = {}) {
  res.writeHead(code, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers })
  res.end(body)
}

const multistatus = (r: string[]) => `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${r.join('')}</D:multistatus>`

/** What a request path is: a CRM node, a side file, or nothing yet (with the folder it would be in). */
type Found =
  | { kind: 'node'; node: CrmNode; parent: CrmNode | null; parts: string[] }
  | { kind: 'side'; side: Side; parent: CrmNode; name: string; parts: string[] }
  | { kind: 'none'; parent: CrmNode; name: string; parts: string[] }

const ALLOW = 'OPTIONS, GET, HEAD, PUT, MKCOL, MOVE, COPY, PROPFIND, PROPPATCH, LOCK, UNLOCK'

export function createCrmDav(o: CrmDavOptions) {
  const started = o.started ?? Date.now()
  const sides = new Map<string, Side>()
  const sideKey = (parentId: string, name: string) => `${parentId}\u0000${name}`
  const sidesIn = (parentId: string) => [...sides].filter(([k]) => k.startsWith(`${parentId}\u0000`)).map(([k, v]) => ({ name: k.slice(parentId.length + 1), side: v }))
  const sideBytes = () => [...sides.values()].reduce((n, s) => n + s.bytes.length, 0)
  const locks = new Map<string, { token: string; owner: string; timeout: number }>()

  const svc = (): CrmFilesService => {
    const s = o.service()
    if (!s) throw new CrmFilesError(503, 'failed', 'The CRM files are not ready yet. Try again in a moment.')
    return s
  }

  async function find(parts: string[]): Promise<Found> {
    const s = svc()
    let node = (await s.children('root')).node
    let parent: CrmNode | null = null
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      const last = i === parts.length - 1
      if (!node.isFolder) throw new CrmFilesError(404, 'notfound', 'Not found.')
      const kids = namesOf((await s.children(node.id)).children)
      const next = kids.get(name)
      if (!next) {
        if (!last) throw new CrmFilesError(404, 'notfound', 'Not found.')
        const side = sides.get(sideKey(node.id, name))
        return side ? { kind: 'side', side, parent: node, name, parts } : { kind: 'none', parent: node, name, parts }
      }
      parent = node
      node = next
    }
    return { kind: 'node', node, parent, parts }
  }

  const timeOf = (n: CrmNode) => {
    const t = Date.parse(n.modifiedAt ?? n.createdAt ?? '')
    return Number.isFinite(t) ? t : started
  }
  const etagOf = (n: CrmNode) => `"${n.id.replace(/[^A-Za-z0-9:_-]/g, '')}-${timeOf(n)}-${n.size ?? ''}"`

  function nodeXml(parts: string[], n: CrmNode, name: string): string {
    const when = new Date(timeOf(n))
    const created = new Date(Date.parse(n.createdAt ?? '') || timeOf(n))
    const props = [
      `<D:displayname>${esc(name)}</D:displayname>`,
      `<D:resourcetype>${n.isFolder ? '<D:collection/>' : ''}</D:resourcetype>`,
      `<D:creationdate>${created.toISOString()}</D:creationdate>`,
      `<D:getlastmodified>${when.toUTCString()}</D:getlastmodified>`,
      ...(n.isFolder ? [] : [`<D:getcontentlength>${n.size ?? 0}</D:getcontentlength>`, `<D:getcontenttype>${esc(n.type || 'application/octet-stream')}</D:getcontenttype>`, `<D:getetag>${etagOf(n)}</D:getetag>`]),
      '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>',
    ]
    return `<D:response><D:href>${hrefOf(parts, n.isFolder)}</D:href><D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  }

  function sideXml(parts: string[], name: string, s: Side): string {
    const when = new Date(s.mtime)
    const props = [
      `<D:displayname>${esc(name)}</D:displayname>`,
      '<D:resourcetype></D:resourcetype>',
      `<D:creationdate>${when.toISOString()}</D:creationdate>`,
      `<D:getlastmodified>${when.toUTCString()}</D:getlastmodified>`,
      `<D:getcontentlength>${s.bytes.length}</D:getcontentlength>`,
      `<D:getcontenttype>${esc(driveType(name).type)}</D:getcontenttype>`,
      `<D:getetag>"side-${s.mtime}-${s.bytes.length}"</D:getetag>`,
    ]
    return `<D:response><D:href>${hrefOf(parts, false)}</D:href><D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  }

  const lengthOf = (req: IncomingMessage): number | null => {
    const v = req.headers['content-length']
    if (v === undefined) return null
    const n = Number(v)
    return Number.isInteger(n) && n >= 0 ? n : null
  }

  /** A file into a folder: a new version if the name is a CRM file there, otherwise a new file. */
  async function save(parent: CrmNode, name: string, target: CrmNode | null, body: Readable, size: number): Promise<'new' | 'version'> {
    const type = driveType(name).type
    if (target) {
      await svc().version(target.id, target.name, target.type || type, body, size)
      return 'version'
    }
    await svc().upload(parent.id, name, type, body, size)
    return 'new'
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase()
    const parts = partsOf((req.url ?? '/').split('?')[0])
    if (!parts) return send(res, 404, 'The CRM files are at /crm/.')

    if (method === 'OPTIONS') return send(res, 200, '', { DAV: '1, 2', Allow: ALLOW, 'MS-Author-Via': 'DAV' })

    switch (method) {
      case 'PROPFIND': {
        await readAll(req, MAX_XML)
        const f = await find(parts)
        if (f.kind === 'none') return send(res, 404, 'Not found.')
        if (f.kind === 'side') return sendXml(res, 207, multistatus([sideXml(parts, f.name, f.side)]))
        const self = nodeXml(parts, f.node, parts.at(-1) ?? 'CRM files')
        const depth = String(req.headers.depth ?? '1')
        if (!f.node.isFolder || depth === '0') return sendXml(res, 207, multistatus([self]))
        const kids = namesOf((await svc().children(f.node.id)).children)
        const out = [self, ...[...kids].map(([n, k]) => nodeXml([...parts, n], k, n))]
        for (const { name, side } of sidesIn(f.node.id)) if (!kids.has(name)) out.push(sideXml([...parts, name], name, side))
        return sendXml(res, 207, multistatus(out))
      }

      case 'PROPPATCH': {
        const body = (await readAll(req, MAX_XML)).toString('utf8')
        const f = await find(parts)
        if (f.kind === 'none') return send(res, 404, 'Not found.')
        // Accepted and ignored (gvfs sets a time after a copy; the CRM keeps its own).
        const tags = new Set<string>()
        const ns = new Map<string, string>()
        for (const m of body.matchAll(/xmlns:([A-Za-z0-9_]+)="([^"]+)"/g)) ns.set(m[1], m[2])
        for (const block of body.matchAll(/<(?:[A-Za-z0-9_]+:)?prop[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?prop>/g)) {
          for (const t of block[1].matchAll(/<(?:([A-Za-z0-9_]+):)?([A-Za-z0-9_]+)(?=[\s/>])/g)) {
            const [, p, name] = t
            if (p && ns.has(p)) tags.add(`<${p}:${name} xmlns:${p}="${esc(ns.get(p) as string)}"/>`)
          }
        }
        return sendXml(res, 207, multistatus([`<D:response><D:href>${hrefOf(parts, false)}</D:href><D:propstat><D:prop>${[...tags].join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`]))
      }

      case 'GET':
      case 'HEAD': {
        const f = await find(parts)
        if (f.kind === 'none') return send(res, 404, 'Not found.')
        if (f.kind === 'side') {
          res.writeHead(200, { 'Content-Type': driveType(f.name).type, 'Content-Length': f.side.bytes.length, 'Last-Modified': new Date(f.side.mtime).toUTCString() })
          return void res.end(method === 'HEAD' ? undefined : f.side.bytes)
        }
        const n = f.node
        if (n.isFolder) return send(res, 200, method === 'HEAD' ? '' : 'A folder of the CRM files.')
        const head: Record<string, string | number> = { 'Content-Type': n.type || 'application/octet-stream', ETag: etagOf(n), 'Last-Modified': new Date(timeOf(n)).toUTCString(), 'Accept-Ranges': 'bytes' }
        if (method === 'HEAD') {
          res.writeHead(200, { ...head, ...(n.size !== undefined ? { 'Content-Length': n.size } : {}) })
          return void res.end()
        }
        const file = await svc().file(n.id)
        const size = file.size ?? n.size ?? null
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
        res.on('close', () => file.stream.destroy())
        if (range && size !== null && (range[1] || range[2])) {
          const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
          const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
          if (start > end || start >= size) {
            file.stream.destroy()
            return send(res, 416, '', { 'Content-Range': `bytes */${size}` })
          }
          res.writeHead(206, { ...head, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` })
          return pipeline(file.stream, slice(start, end), res).catch(() => undefined)
        }
        res.writeHead(200, { ...head, ...(size !== null ? { 'Content-Length': size } : {}) })
        return pipeline(file.stream, res).catch(() => undefined)
      }

      case 'PUT': {
        const f = await find(parts)
        if (f.kind === 'node' && f.node.isFolder) return send(res, 405, 'That is a folder.')
        const parent = f.parent
        const name = f.kind === 'node' ? (parts.at(-1) as string) : f.name
        if (!parent) return send(res, 405, 'Not here.')
        if (isSideName(name)) {
          const room = SIDE_MAX - sideBytes() + (f.kind === 'side' ? f.side.bytes.length : 0)
          const bytes = await readAll(req, Math.min(room, 32 * 1024 * 1024))
          const existed = f.kind === 'side'
          sides.set(sideKey(parent.id, name), { bytes, mtime: Date.now(), pending: false })
          return send(res, existed ? 204 : 201)
        }
        const size = lengthOf(req)
        if (size === null) return send(res, 411, 'Send the size of the file (Content-Length).')
        if (size > CRM_FILES_MAX_UPLOAD) return send(res, 413, `A file is at most ${CRM_FILES_MAX_UPLOAD / 1024 / 1024} MB here.`)
        if (size === 0 && f.kind !== 'node') {
          // Files' "New Document", or a program that makes the file before it writes: kept here until it has something in it.
          const existed = f.kind === 'side'
          sides.set(sideKey(parent.id, name), { bytes: Buffer.alloc(0), mtime: Date.now(), pending: true })
          return send(res, existed ? 204 : 201)
        }
        const how = await save(parent, name, f.kind === 'node' ? f.node : null, req, size)
        if (f.kind === 'side') sides.delete(sideKey(parent.id, name))
        o.log?.info(`crm drive: ${how === 'version' ? 'a new version of' : 'a new file'} "${name}"`)
        return send(res, how === 'version' ? 204 : 201)
      }

      case 'MKCOL': {
        if (lengthOf(req)) return send(res, 415, 'No body here.')
        const f = await find(parts)
        if (f.kind !== 'none') return send(res, 405, 'That name is already used here.')
        await svc().folder(f.parent.id, f.name)
        return send(res, 201)
      }

      case 'DELETE': {
        const f = await find(parts)
        if (f.kind === 'side') {
          sides.delete(sideKey(f.parent.id, f.name))
          return send(res, 204)
        }
        if (f.kind === 'none') return send(res, 404, 'Not found.')
        o.log?.info(`crm drive: a delete of "${parts.at(-1) ?? ''}" was refused`)
        return send(res, 403, CRM_FILES_REASONS.noDelete)
      }

      case 'MOVE':
      case 'COPY': {
        const from = await find(parts)
        const toParts = destinationParts(req.headers.destination as string | undefined)
        if (toParts.length === 0) return send(res, 403, 'Not onto the top of the drive.')
        const to = await find(toParts)
        if (from.kind === 'none') return send(res, 404, 'Not found.')
        const toParent = to.parent
        const toName = toParts.at(-1) as string
        if (!toParent) return send(res, 403, 'Not there.')
        const fromParent = from.parent
        if (from.kind === 'node' && to.kind === 'node' && from.node.id === to.node.id) return send(res, 403, 'That is the same place.')
        // A CRM file is never replaced by a move or a copy (it would mean deleting it), except a program's own save: its side file moved over the document.
        if (to.kind === 'node' && !(from.kind === 'side' && method === 'MOVE' && !to.node.isFolder)) return send(res, 412, 'That name is already used there; nothing is replaced here.')

        if (from.kind === 'side') {
          if (isSideName(toName) || (from.side.pending && to.kind !== 'node')) {
            sides.set(sideKey(toParent.id, toName), { ...from.side, bytes: Buffer.from(from.side.bytes), mtime: Date.now() })
          } else {
            await save(toParent, toName, to.kind === 'node' ? to.node : null, Readable.from([from.side.bytes]), from.side.bytes.length)
            if (to.kind === 'side') sides.delete(sideKey(toParent.id, toName))
          }
          if (method === 'MOVE') sides.delete(sideKey(from.parent.id, from.name))
          return send(res, to.kind === 'none' ? 201 : 204)
        }

        const n = from.node
        if (method === 'COPY') {
          if (n.isFolder) return send(res, 403, 'Folders are not copied here. Copy the files in them.')
          if (isSideName(toName)) {
            const file = await svc().file(n.id)
            sides.set(sideKey(toParent.id, toName), { bytes: await readAll(file.stream, 32 * 1024 * 1024), mtime: Date.now(), pending: false })
            return send(res, 201)
          }
          const file = await svc().file(n.id)
          const size = file.size ?? n.size
          if (size === undefined || size === null) {
            file.stream.destroy()
            return send(res, 403, 'The CRM does not say how big that file is, so it cannot be copied here.')
          }
          await svc().upload(toParent.id, toName, n.type || driveType(toName).type, file.stream, size)
          o.log?.info(`crm drive: "${n.name}" copied as a new file "${toName}"`)
          return send(res, 201)
        }

        if (isSideName(toName)) return send(res, 403, 'A CRM file is not renamed to a name programs use for their own files.')
        if (!fromParent) return send(res, 403, 'Not that one.')
        if (fromParent.id !== toParent.id) await svc().move(n.id, toParent.id)
        if (toName !== (parts.at(-1) as string)) await svc().rename(n.id, toName)
        if (to.kind === 'side') sides.delete(sideKey(toParent.id, toName))
        o.log?.info(`crm drive: "${n.name}" ${fromParent.id !== toParent.id ? 'moved' : 'renamed'}${toName !== n.name ? ` to "${toName}"` : ''}`)
        return send(res, 201)
      }

      case 'LOCK': {
        const body = (await readAll(req, MAX_XML)).toString('utf8')
        const key = parts.join('/')
        const timeout = Math.min(7200, Math.max(60, Number(/Second-(\d+)/i.exec(String(req.headers.timeout ?? ''))?.[1] ?? 3600)))
        const held = locks.get(key)
        const lock = held && body.length === 0 ? { ...held, timeout } : { token: `opaquelocktoken:${randomUUID()}`, owner: /<(?:[A-Za-z0-9_]+:)?owner[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?owner>/.exec(body)?.[1]?.replace(/<[^>]+>/g, '').trim() || 'this PC', timeout }
        locks.set(key, lock)
        const xml = `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:owner>${esc(lock.owner)}</D:owner><D:timeout>Second-${lock.timeout}</D:timeout><D:locktoken><D:href>${lock.token}</D:href></D:locktoken><D:lockroot><D:href>${hrefOf(parts, false)}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`
        return sendXml(res, 200, xml, { 'Lock-Token': `<${lock.token}>` })
      }

      case 'UNLOCK':
        locks.delete(parts.join('/'))
        return send(res, 204)

      default:
        return send(res, 405, 'Not supported.', { Allow: ALLOW })
    }
  }

  return async function crmDav(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await handle(req, res)
    } catch (e) {
      const x = e as { status?: unknown; code?: unknown }
      const known = e instanceof CrmFilesError || (typeof x.status === 'number' && typeof x.code === 'string')
      const code = known ? (x.code === 'nodelete' ? 403 : (x.status as number)) : 500
      const msg = known && e instanceof Error ? e.message : 'The CRM files could not do that.'
      if (!known) o.log?.warn(`crm drive: ${e instanceof Error ? e.message : String(e)}`)
      if (!res.headersSent) send(res, code, msg)
      else res.destroy()
      req.resume()
    }
  }
}
