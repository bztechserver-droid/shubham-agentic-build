import { Readable } from 'node:stream'
import { nameProblem, pathProblem } from '../../shared/drive.ts'
import { apiError, type MountRequest } from '../api.ts'
import { driveError, type DriveStore } from './store.ts'

// F-097 slice 2: uploads from the phone ("Share → Common Drive" in Chris). The phone has no app token, only its device key (voice pairing);
// agent/drive/DRIVE-PROTOCOL.md part E. Files only: a phone puts files into its own inbox, `Phone/<device name>/…`, and can do nothing else: it
// can't list, download, delete, overwrite or change settings. The device is named by its KEY; nothing in a body says who it is. JSON with
// base64 pieces, so the agent's guard needs nothing new (a mount's `ownAuth` routes already take a device key and refuse a browser page).

export const PHONE_PIECE_BYTES = 512 * 1024
/** A body for a piece: the base64 of a full piece, and the JSON round it. */
export const PHONE_BODY_BYTES = 1024 * 1024
export const PHONE_MAX_FILE_BYTES = 4 * 1024 ** 3
export const PHONE_MAX_OPEN = 8
export const PHONE_INBOX = 'Phone'
const MAX_DIR_LEVELS = 3
const MAX_DIRS = 20

export interface PhoneDevice {
  id: string
  name: string
}

export interface PhoneHost {
  store(): Promise<DriveStore | null>
  why(): string
  /** The paired phone a request's Authorization: Bearer key belongs to, or null. */
  phoneDevice(headers: MountRequest['headers']): PhoneDevice | null
}

/** A folder name for a phone: its own name, made safe. */
export function inboxOf(deviceName: string): string {
  const clean = [...deviceName]
    .map(c => ('<>:"/\\|?*'.includes(c) || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? '_' : c))
    .join('')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 40)
  return clean && !nameProblem(clean) ? `${PHONE_INBOX}/${clean}` : `${PHONE_INBOX}/Phone`
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function createPhoneRoutes(host: PhoneHost) {
  /** The uploads a phone has open: the ones in its inbox. The store keeps them (also across a restart of the agent), so a phone that lost its own record can see and drop them. */
  const openOf = (store: DriveStore, inbox: string) => store.listUploads().filter(u => u.path.startsWith(`${inbox}/`))

  /** The inbox's sub-folders, newest first (one level, at most 20): what a share could go into. */
  const dirsOf = async (store: DriveStore, inbox: string): Promise<string[]> => {
    try {
      const page = await store.list(inbox, { limit: 2000 })
      return page.entries
        .filter(e => e.kind === 'dir')
        .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : 1))
        .slice(0, MAX_DIRS)
        .map(e => e.name)
    } catch {
      return []
    }
  }

  /** An upload the phone owns (it is in its inbox), or a 404 that says nothing about other phones' uploads. */
  const mineOrNotFound = (store: DriveStore, dev: PhoneDevice, id: string) => {
    const none = () => apiError(404, 'There is no such upload (it may have been finished or dropped).')
    let info
    try {
      info = store.uploadInfo(id)
    } catch {
      throw none()
    }
    if (!info.path.startsWith(`${inboxOf(dev.name)}/`)) throw none()
    return info
  }

  return async function phone(r: MountRequest): Promise<unknown> {
    const dev = host.phoneDevice(r.headers)
    if (!dev) throw apiError(401, 'Missing or wrong device key: this phone is not paired (or was removed).')
    const store = await host.store()
    if (!store) throw apiError(409, host.why())
    const inbox = inboxOf(dev.name)
    const ctx = { by: dev.name }
    const rest = r.rest.replace(/^\/phone/, '')
    const body = isObject(r.body) ? r.body : {}

    if (r.method === 'GET' && rest === '/status') {
      const s = await store.status()
      return { device: dev.name, inbox, pieceBytes: PHONE_PIECE_BYTES, maxFileBytes: PHONE_MAX_FILE_BYTES, freeBytes: Math.max(0, s.limitBytes - s.usedBytes), open: openOf(store, inbox), dirs: await dirsOf(store, inbox) }
    }

    if (r.method === 'POST' && rest === '/upload') {
      const name = body.name
      if (typeof name !== 'string') throw apiError(400, 'Expected the file name as "name".')
      const why = nameProblem(name)
      if (why) throw apiError(400, why)
      const size = body.size
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw apiError(400, 'Expected the size in bytes as "size".')
      if (size > PHONE_MAX_FILE_BYTES) throw apiError(413, `A file may be at most ${PHONE_MAX_FILE_BYTES} bytes.`)
      const dir = body.dir === undefined || body.dir === '' ? [] : typeof body.dir === 'string' ? body.dir.split('/') : null
      if (dir === null) throw apiError(400, 'Expected "dir" as text.')
      if (dir.length > MAX_DIR_LEVELS) throw apiError(400, `A folder may be at most ${MAX_DIR_LEVELS} levels deep.`)
      const path = [inbox, ...dir, name].join('/')
      const bad = pathProblem(path)
      if (bad) throw apiError(400, bad)
      if (openOf(store, inbox).length >= PHONE_MAX_OPEN) throw apiError(409, `This phone already has ${PHONE_MAX_OPEN} uploads open; finish or drop one first.`)
      const modified = typeof body.modified === 'number' && Number.isFinite(body.modified) ? body.modified : undefined
      // Never over an existing file: a name that is taken gets "(2)".
      const up = await store.startUpload({ path, size, mode: 'keepboth', modified }, ctx)
      return { id: up.id, path, pieceBytes: Math.min(up.pieceBytes, PHONE_PIECE_BYTES), received: 0 }
    }

    const m = /^\/upload\/([^/]+)(?:\/(piece|commit|abort))?$/.exec(rest)
    if (m) {
      const id = m[1]
      const op = m[2]
      const info = mineOrNotFound(store, dev, id)
      if (r.method === 'GET' && !op) return info
      if (r.method === 'POST' && op === 'piece') {
        if (typeof body.offset !== 'number' || !Number.isSafeInteger(body.offset) || body.offset < 0) throw apiError(400, 'Expected the piece’s place as "offset".')
        if (typeof body.data !== 'string') throw apiError(400, 'Expected the piece as base64 "data".')
        const bytes = Buffer.from(body.data, 'base64')
        if (bytes.length > PHONE_PIECE_BYTES) throw apiError(413, `A piece is at most ${PHONE_PIECE_BYTES} bytes.`)
        return store.putPiece(id, body.offset, Readable.from([bytes]))
      }
      if (r.method === 'POST' && op === 'commit') {
        const done = await store.commitUpload(id)
        return { entry: done.entry, renamed: done.entry.path !== info.path }
      }
      if (r.method === 'POST' && op === 'abort') {
        await store.abortUpload(id)
        return { ok: true }
      }
    }
    throw driveError(404, 'notfound', `No such phone call: ${r.method} ${rest}`)
  }
}
