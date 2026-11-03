import { open, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { DriveChanges, DriveCommit, DriveEntry, DriveList, DriveMode, DriveUpload } from '../../shared/drive.ts'
import { driveError, type DriveStore } from './store.ts'
import type { SyncRemote } from './sync.ts'

// F-097 part C, for the laptop: the sync folder inside the app reaches the pool over the member link (the link the Agents section already uses),
// not over HTTP. The member sends one request line and gets one answer line; a line is at most 2 MB, so a file goes in pieces of 512 KB (a third more in
// base64). The hub runs the same store calls as for any other device, with the member's name as who did it. Only the calls a sync folder needs exist here;
// there is no settings, Bin or device call on this link.

export const LINK_PIECE_BYTES = 512 * 1024
const MAX_WAIT_MS = 20_000
const MAX_LIST = 1000

export interface LinkPeerInfo {
  id: string
  name: string
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw driveError(400, 'badname', `Expected ${what} as text.`)
  return v
}
const num = (v: unknown, what: string, min = 0): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw driveError(400, 'range', `Expected ${what} as a number.`)
  return v
}
const mode = (v: unknown): DriveMode | undefined => (v === 'create' || v === 'overwrite' || v === 'keepboth' || v === 'ifmatch' ? v : undefined)

/** The hub's end: runs one request from a member PC against the store. */
export function createLinkServer(getStore: () => Promise<DriveStore | null>, why: () => string) {
  return async function linkCall(from: LinkPeerInfo, body: unknown): Promise<unknown> {
    if (!isObject(body) || typeof body.op !== 'string') throw driveError(400, 'range', 'Expected {op}.')
    const store = await getStore()
    if (!store) throw driveError(409, 'disabled', why())
    const ctx = { by: from.name }
    switch (body.op) {
      case 'rev':
        return { rev: store.rev() }
      case 'changes':
        return store.changes(num(body.since, 'since'), { limit: 2000, waitMs: Math.min(MAX_WAIT_MS, num(body.waitMs ?? 0, 'waitMs')) })
      case 'list':
        return store.list(str(body.path ?? '', 'path'), { cursor: typeof body.cursor === 'string' ? body.cursor : undefined, limit: Math.min(MAX_LIST, num(body.limit ?? MAX_LIST, 'limit', 1)) })
      case 'stat': {
        try {
          return { entry: await store.stat(str(body.path ?? '', 'path')) }
        } catch (e) {
          if ((e as { code?: string }).code === 'notfound') return { entry: null }
          throw e
        }
      }
      case 'read': {
        const path = str(body.path, 'path')
        const offset = num(body.offset ?? 0, 'offset')
        const len = Math.min(LINK_PIECE_BYTES, num(body.len ?? LINK_PIECE_BYTES, 'len'))
        const { abs, entry } = await store.fileOf(path)
        const fh = await open(abs, 'r')
        try {
          const buf = Buffer.alloc(len)
          const { bytesRead } = await fh.read(buf, 0, len, offset)
          return { data: buf.subarray(0, bytesRead).toString('base64'), size: entry.size, entry }
        } finally {
          await fh.close()
        }
      }
      case 'upload-start':
        return store.startUpload(
          { path: str(body.path, 'path'), size: num(body.size, 'size'), mode: mode(body.mode), baseEtag: typeof body.baseEtag === 'string' ? body.baseEtag : undefined, modified: typeof body.modified === 'number' ? body.modified : undefined },
          ctx,
        )
      case 'upload-piece': {
        const data = Buffer.from(str(body.data, 'data'), 'base64')
        if (data.length > LINK_PIECE_BYTES) throw driveError(413, 'range', `A piece is at most ${LINK_PIECE_BYTES} bytes.`)
        return store.putPiece(str(body.id, 'id'), num(body.offset, 'offset'), Readable.from([data]))
      }
      case 'upload-commit':
        return store.commitUpload(str(body.id, 'id'))
      case 'upload-abort':
        await store.abortUpload(str(body.id, 'id'))
        return { ok: true }
      case 'mkdir':
        return store.mkdir(str(body.path, 'path'), ctx)
      case 'remove':
        return store.remove(str(body.path, 'path'), ctx)
      default:
        throw driveError(400, 'range', `Unknown drive call: ${body.op.slice(0, 40)}`)
    }
  }
}

/** One request to the hub, one answer back (throws what the hub threw). */
export type HubCall = (body: unknown, timeoutMs?: number) => Promise<unknown>

/** The member PC's end: a SyncRemote that speaks to the hub over the link. */
export function linkRemote(call: HubCall): SyncRemote {
  return {
    async rev() {
      return ((await call({ op: 'rev' })) as { rev: number }).rev
    },

    async changes(since, waitMs) {
      const wait = Math.min(MAX_WAIT_MS, waitMs)
      return (await call({ op: 'changes', since, waitMs: wait }, wait + 15_000)) as DriveChanges
    },

    async list(path, cursor) {
      return (await call({ op: 'list', path, cursor })) as DriveList
    },

    async stat(path) {
      return ((await call({ op: 'stat', path })) as { entry: DriveEntry | null }).entry
    },

    async download(path, dest) {
      const fh = await open(dest, 'w')
      let offset = 0
      let entry: DriveEntry | undefined
      try {
        for (;;) {
          const r = (await call({ op: 'read', path, offset, len: LINK_PIECE_BYTES })) as { data: string; size: number; entry: DriveEntry }
          if (entry && r.entry.etag !== entry.etag) throw new Error('It changed in the Common Drive while it was being fetched; it will be looked at again.')
          entry ??= r.entry
          const buf = Buffer.from(r.data, 'base64')
          if (buf.length) await fh.write(buf, 0, buf.length, offset)
          offset += buf.length
          if (offset >= r.size) break
          if (!buf.length) throw new Error('The Common Drive sent less than it said.')
        }
      } catch (e) {
        await fh.close()
        await rm(dest, { force: true })
        throw e
      }
      await fh.close()
      return entry as DriveEntry
    },

    async upload(path, src, opt): Promise<DriveCommit> {
      const start = (await call({ op: 'upload-start', path, size: opt.size, mode: opt.mode, baseEtag: opt.baseEtag, modified: opt.modified })) as DriveUpload
      try {
        const fh = await open(src, 'r')
        try {
          let offset = 0
          const buf = Buffer.alloc(Math.min(LINK_PIECE_BYTES, start.pieceBytes))
          while (offset < opt.size) {
            const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, opt.size - offset), offset)
            if (bytesRead <= 0) throw new Error('The file changed while it was being sent.')
            await call({ op: 'upload-piece', id: start.id, offset, data: buf.subarray(0, bytesRead).toString('base64') })
            offset += bytesRead
          }
        } finally {
          await fh.close()
        }
        return (await call({ op: 'upload-commit', id: start.id })) as DriveCommit
      } catch (e) {
        await call({ op: 'upload-abort', id: start.id }).catch(() => undefined)
        throw e
      }
    },

    async mkdir(path) {
      await call({ op: 'mkdir', path })
    },

    async remove(path) {
      await call({ op: 'remove', path })
    },
  }
}
