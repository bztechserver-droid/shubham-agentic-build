import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { ApiMount, MountRequest, WsSocket } from '../api.ts'
import type { DriveBackupInfo, DriveBackupState, DriveDeviceCreated, DriveLocalSync, DriveMode, DriveSettings, DriveSyncPairing, DriveWebdav } from '../../shared/drive.ts'
import { createPhoneRoutes, PHONE_BODY_BYTES } from './phone.ts'
import { sendFile } from './send-file.ts'
import { driveError, SMALL_FILE_BYTES, type DriveStore } from './store.ts'

// F-097: the Common Drive's routes for the page (agent/agentic/DRIVE-PROTOCOL.md part A), mounted at /agent-api/agentic/drive.
// Every route is a "raw" one so the errors carry their `code` (api.ts only knows {error}) and bytes are streamed, never held whole.
// The guard (x-sad-token, no foreign Origin) is api.ts's, before any of this runs.

export { parseRange } from './send-file.ts'

export const DRIVE_PREFIX = '/agentic/drive'
const MAX_JSON = 64 * 1024

/** What the routes need from the drive: the store (null when it is switched off or isn't on this PC) and how to switch it. */
export interface DriveHost {
  /** The open store, or null with `why` saying so. */
  store(): Promise<DriveStore | null>
  /** Why there is no store right now (shown to the person). */
  why(): string
  /** The settings as saved, whether or not the store is open. */
  settings(): DriveSettings
  /** Applies and saves a settings change (opens or closes the store when `enabled` changes). */
  patch(patch: Partial<DriveSettings>): Promise<DriveSettings>
  /** The status of a drive that is off (zeros), so the page can say so. */
  offStatus(): Promise<unknown>
  /** The label of this PC for changes with no `x-drive-client`. */
  device: string
  /** WebDAV: its state, the devices that may sign in, and the tailnet address in front of it. */
  webdav(): Promise<DriveWebdav>
  webdavCreateDevice(name: string): Promise<DriveDeviceCreated>
  webdavRevokeDevice(name: string): Promise<DriveWebdav>
  webdavTailscale(on: boolean): Promise<DriveWebdav>
  /** A one-time code for a new sync device called `name`: the sync program swaps it for that device's password on the drive listener. */
  syncPair(name: string): Promise<DriveSyncPairing>
  /** The built sync program (one .mjs file) to hand to a person, or null when this build has none. */
  syncProgram(): string | null
  /** The backup: where it is, the last pass, what is held. */
  backup(): Promise<DriveBackupInfo>
  /** The backup's state, for the status call. */
  backupState(): DriveBackupState
  /** The full check now (and a pass over the changes). */
  backupRun(): Promise<DriveBackupInfo>
  /** A person confirmed the removals the brake held: the next pass takes those copies away (into the target's trash). */
  backupAllowDeletes(): Promise<DriveBackupInfo>
  /** F-097: the paired phone a request's device key belongs to, or null (phone uploads; agent/drive/phone.ts). */
  phoneDevice(headers: MountRequest['headers']): { id: string; name: string } | null
  /** The sync folder of THIS PC (the hub's own, or a member PC's over the link). Works on every PC, unlike the rest. */
  localSync(): DriveLocalSync
  localSyncSet(patch: { enabled?: boolean; folder?: string | null }): Promise<DriveLocalSync>
  localSyncRun(): Promise<DriveLocalSync>
  localSyncAllowDeletes(): Promise<DriveLocalSync>
}

type Handler = (ctx: Ctx) => Promise<void>
interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  host: DriveHost
  id: string
  by: string
}

const METHODS: Record<string, string[]> = {
  status: ['GET'],
  list: ['GET'],
  stat: ['GET'],
  search: ['GET'],
  file: ['GET', 'HEAD', 'PUT'],
  upload: ['POST'],
  'upload/id': ['GET', 'PUT', 'DELETE'],
  'upload/commit': ['POST'],
  mkdir: ['POST'],
  move: ['POST'],
  copy: ['POST'],
  delete: ['POST'],
  bin: ['GET'],
  'bin/restore': ['POST'],
  'bin/purge': ['POST'],
  versions: ['GET'],
  'versions/restore': ['POST'],
  settings: ['GET', 'PATCH'],
  changes: ['GET'],
  webdav: ['GET'],
  'sync/pair': ['POST'],
  'sync/local': ['GET', 'PATCH'],
  'sync/local/run': ['POST'],
  'sync/local/allow-deletes': ['POST'],
  backup: ['GET'],
  'backup/run': ['POST'],
  'backup/allow-deletes': ['POST'],
  'sync/program': ['GET', 'HEAD'],
  'webdav/devices': ['POST'],
  'webdav/devices/revoke': ['POST'],
  'webdav/tailscale': ['POST'],
}

const ID_RE = /^[a-z0-9]{6,12}-[a-f0-9]{8}$/

function which(rest: string): { name: string; id: string } | null {
  const plain = rest.replace(/^\//, '')
  if (plain in METHODS) return { name: plain, id: '' }
  const m = /^upload\/([^/]+)(\/commit)?$/.exec(plain)
  if (m && ID_RE.test(m[1])) return { name: m[2] ? 'upload/commit' : 'upload/id', id: m[1] }
  return null
}

function json(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function fail(res: ServerResponse, e: unknown) {
  const status = (e as { status?: unknown }).status
  const code = typeof status === 'number' && status >= 400 && status < 600 ? status : 500
  if (res.headersSent) return void res.destroy()
  const extra = e as { code?: unknown; received?: unknown }
  json(res, code, {
    error: code === 500 ? 'The Common Drive could not do that.' : e instanceof Error ? e.message : String(e),
    ...(typeof extra.code === 'string' && /^[a-z]+$/.test(extra.code) ? { code: extra.code } : {}),
    ...(typeof extra.received === 'number' ? { received: extra.received } : {}),
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = []
  let n = 0
  for await (const chunk of req) {
    const b = chunk as Buffer
    n += b.length
    if (n > MAX_JSON) throw driveError(413, 'range', 'That request is too large.')
    parts.push(b)
  }
  if (!n) return {}
  try {
    const v: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    // Falls through.
  }
  throw driveError(400, 'range', 'Expected a JSON object.')
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw driveError(400, 'badname', `Expected ${what} as text.`)
  return v
}
const optMode = (v: unknown): DriveMode | undefined => {
  if (v === undefined) return undefined
  if (v === 'create' || v === 'overwrite' || v === 'keepboth' || v === 'ifmatch') return v
  throw driveError(400, 'range', 'Unknown mode.')
}
const intParam = (v: string | null, dflt: number) => {
  if (v === null || v === '') return dflt
  const n = Number(v)
  if (!Number.isFinite(n)) throw driveError(400, 'range', 'Expected a number.')
  return n
}

const handlers: Record<string, Handler> = {
  async status({ res, host }) {
    const s = await host.store()
    json(res, 200, s ? { ...(await s.status()), backup: host.backupState() } : await host.offStatus())
  },

  async list({ res, url, host }) {
    const s = await need(host)
    json(res, 200, await s.list(url.searchParams.get('path') ?? '', { cursor: url.searchParams.get('cursor') ?? undefined, limit: intParam(url.searchParams.get('limit'), 500) }))
  },

  async stat({ res, url, host }) {
    json(res, 200, await (await need(host)).stat(url.searchParams.get('path') ?? ''))
  },

  async search({ res, url, host }) {
    json(res, 200, { entries: await (await need(host)).search(url.searchParams.get('q') ?? '', Math.min(200, intParam(url.searchParams.get('limit'), 200))) })
  },

  async file({ req, res, url, host, by }) {
    const s = await need(host)
    const p = url.searchParams.get('path') ?? ''
    if (req.method === 'PUT') {
      const declared = req.headers['content-length']
      if (declared !== undefined && Number(declared) > SMALL_FILE_BYTES) throw driveError(413, 'range', `Use the upload calls for files over ${SMALL_FILE_BYTES} bytes.`)
      const mode = optMode(url.searchParams.get('mode') ?? undefined)
      const baseEtag = url.searchParams.get('baseEtag') ?? undefined
      const modified = url.searchParams.get('modified')
      return json(res, 200, await s.putFile(p, req, { mode, baseEtag, modified: modified ? intParam(modified, 0) : undefined }, { by }))
    }
    await sendFile(req, res, s, p, { version: url.searchParams.get('version') ?? undefined, download: url.searchParams.get('download') === '1' })
  },

  async upload({ req, res, host, by }) {
    const s = await need(host)
    const b = await readJson(req)
    json(
      res,
      200,
      await s.startUpload(
        {
          path: str(b.path, 'path'),
          size: Number(b.size),
          mode: optMode(b.mode),
          baseEtag: typeof b.baseEtag === 'string' ? b.baseEtag : undefined,
          modified: typeof b.modified === 'number' ? b.modified : undefined,
        },
        { by },
      ),
    )
  },

  async 'upload/id'({ req, res, url, host, id }) {
    const s = await need(host)
    if (req.method === 'GET') return json(res, 200, s.uploadInfo(id))
    if (req.method === 'DELETE') {
      await s.abortUpload(id)
      return json(res, 200, { ok: true })
    }
    const declared = req.headers['content-length']
    if (declared !== undefined && Number(declared) > s.pieceBytes) throw driveError(413, 'range', `A piece is at most ${s.pieceBytes} bytes.`)
    json(res, 200, await s.putPiece(id, intParam(url.searchParams.get('offset'), -1), req))
  },

  async 'upload/commit'({ res, host, id }) {
    json(res, 200, await (await need(host)).commitUpload(id))
  },

  async mkdir({ req, res, host, by }) {
    json(res, 200, await (await need(host)).mkdir(str((await readJson(req)).path, 'path'), { by }))
  },

  async move({ req, res, host, by }) {
    const b = await readJson(req)
    json(res, 200, await (await need(host)).move(str(b.from, 'from'), str(b.to, 'to'), optMode(b.mode), { by }))
  },

  async copy({ req, res, host, by }) {
    const b = await readJson(req)
    json(res, 200, await (await need(host)).copy(str(b.from, 'from'), str(b.to, 'to'), optMode(b.mode), { by }))
  },

  async delete({ req, res, host, by }) {
    json(res, 200, await (await need(host)).remove(str((await readJson(req)).path, 'path'), { by }))
  },

  async bin({ res, host }) {
    json(res, 200, { items: await (await need(host)).binList() })
  },

  async 'bin/restore'({ req, res, host, by }) {
    const b = await readJson(req)
    json(res, 200, await (await need(host)).binRestore(str(b.id, 'id'), typeof b.to === 'string' ? b.to : undefined, { by }))
  },

  async 'bin/purge'({ req, res, host, by }) {
    const b = await readJson(req)
    json(res, 200, await (await need(host)).binPurge(b.all === true ? { all: true } : { id: str(b.id, 'id') }, { by }))
  },

  async versions({ res, url, host }) {
    json(res, 200, { versions: await (await need(host)).versions(url.searchParams.get('path') ?? '') })
  },

  async 'versions/restore'({ req, res, host, by }) {
    const b = await readJson(req)
    json(res, 200, await (await need(host)).restoreVersion(str(b.path, 'path'), str(b.id, 'id'), { by }))
  },

  async settings({ req, res, host }) {
    if (req.method === 'GET') return json(res, 200, host.settings())
    const b = await readJson(req)
    const patch: Partial<DriveSettings> = {}
    for (const k of ['enabled', 'webdavEnabled', 'backupEnabled'] as const) if (b[k] !== undefined) patch[k] = b[k] as boolean
    for (const k of ['limitBytes', 'binDays', 'versionsKept'] as const) if (b[k] !== undefined) patch[k] = b[k] as number
    json(res, 200, await host.patch(patch))
  },

  async webdav({ res, host }) {
    json(res, 200, await host.webdav())
  },

  async 'webdav/devices'({ req, res, host }) {
    json(res, 200, await host.webdavCreateDevice(str((await readJson(req)).name, 'name')))
  },

  async 'webdav/devices/revoke'({ req, res, host }) {
    json(res, 200, await host.webdavRevokeDevice(str((await readJson(req)).name, 'name')))
  },

  async 'sync/program'({ req, res, host }) {
    const file = host.syncProgram()
    if (!file) throw driveError(404, 'notfound', 'This build has no sync program yet (it is made with: npm run build:drive-sync).')
    const size = (await stat(file)).size
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Disposition': 'attachment; filename="common-drive-sync.mjs"',
      'Content-Length': size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') return void res.end()
    await pipeline(createReadStream(file), res).catch(() => undefined)
  },

  async backup({ res, host }) {
    json(res, 200, await host.backup())
  },

  async 'backup/run'({ res, host }) {
    json(res, 200, await host.backupRun())
  },

  async 'backup/allow-deletes'({ res, host }) {
    json(res, 200, await host.backupAllowDeletes())
  },

  async 'sync/local'({ req, res, host }) {
    if (req.method === 'GET') return json(res, 200, host.localSync())
    const b = await readJson(req)
    const patch: { enabled?: boolean; folder?: string | null } = {}
    if (b.enabled !== undefined) patch.enabled = b.enabled === true
    if (b.folder !== undefined) patch.folder = b.folder === null ? null : str(b.folder, 'folder')
    json(res, 200, await host.localSyncSet(patch))
  },

  async 'sync/local/run'({ res, host }) {
    json(res, 200, await host.localSyncRun())
  },

  async 'sync/local/allow-deletes'({ res, host }) {
    json(res, 200, await host.localSyncAllowDeletes())
  },

  async 'sync/pair'({ req, res, host }) {
    json(res, 200, await host.syncPair(str((await readJson(req)).name, 'name')))
  },

  async 'webdav/tailscale'({ req, res, host }) {
    const b = await readJson(req)
    if (typeof b.on !== 'boolean') throw driveError(400, 'range', 'Expected {on: true or false}.')
    json(res, 200, await host.webdavTailscale(b.on))
  },

  async changes({ res, url, host }) {
    const s = await need(host)
    const ac = new AbortController()
    res.on('close', () => ac.abort())
    json(res, 200, await s.changes(intParam(url.searchParams.get('since'), 0), { limit: intParam(url.searchParams.get('limit'), 500), waitMs: intParam(url.searchParams.get('wait'), 0), signal: ac.signal }))
  },
}

async function need(host: DriveHost): Promise<DriveStore> {
  const s = await host.store()
  if (!s) throw driveError(409, 'disabled', host.why())
  return s
}

/** The `x-drive-client` label ("Web", "Phone"), or this PC's name. */
function byOf(req: IncomingMessage, device: string): string {
  const h = req.headers['x-drive-client']
  const v = typeof h === 'string' ? [...h].filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join('').trim().slice(0, 40) : ''
  return v || device
}

/** The routes a device outside the app (the sync folder) may use: files in and out, and nothing that changes settings, empties the Bin or manages devices. */
export const SYNC_ROUTES: readonly string[] = ['status', 'list', 'stat', 'file', 'upload', 'upload/id', 'upload/commit', 'mkdir', 'move', 'delete', 'changes']

/** A route's handler for `rest` (like '/list'), or null; `allow` limits it to some routes. `by` overrides the x-drive-client label (the listener knows the device). */
export function driveRaw(host: DriveHost, allow?: readonly string[]) {
  return (rest: string): ((req: IncomingMessage, res: ServerResponse, by?: string) => Promise<void>) | null => {
    const w = which(rest)
    if (!w || (allow && !allow.includes(w.name))) return null
    return async (req, res, by) => {
      try {
        if (!METHODS[w.name].includes(req.method ?? 'GET')) throw driveError(405, 'range', `${req.method} is not allowed on ${rest}`)
        await handlers[w.name]({ req, res, url: new URL(req.url ?? '/', 'http://agent'), host, id: w.id, by: by ?? byOf(req, host.device) })
      } catch (e) {
        fail(res, e)
      }
    }
  }
}

export function driveMount(host: DriveHost): ApiMount {
  const route = driveRaw(host)
  const phone = createPhoneRoutes(host)
  const phoneRoute = (rest: string) => rest === '/phone' || rest.startsWith('/phone/')
  return {
    prefix: DRIVE_PREFIX,
    // F-097: the phone's uploads carry its device key, never the app's token (and a browser page is refused); everything else here keeps the page's guard.
    ownAuth: phoneRoute,
    maxBody: rest => (phoneRoute(rest) ? PHONE_BODY_BYTES : undefined),
    http: async (r: MountRequest) => {
      if (phoneRoute(r.rest)) return phone(r)
      throw driveError(404, 'notfound', `No such Common Drive call: ${r.rest}`)
    },
    raw: rest => {
      const h = route(rest)
      return h ? (req, res) => h(req, res) : null
    },
    ws(rest) {
      if (rest !== '/ws') return null
      return (socket: WsSocket) => {
        let off: (() => void) | undefined
        let closed = false
        void host.store().then(s => {
          if (!s || closed) return socket.close(1000, s ? '' : host.why())
          const send = () => socket.sendText(JSON.stringify({ t: 'rev', rev: s.rev() }))
          off = s.onRev(send)
          send()
        })
        socket.onClose(() => {
          closed = true
          off?.()
        })
      }
    },
  }
}
