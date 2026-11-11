import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { copyFile, open as openFile, rm, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { CrmNode, CrmSpoolEntry } from '../../shared/crm-files.ts'
import { driveType } from '../drive/mime.ts'
import { isSideName, legalWindowsName, namesOf } from './dav-crm.ts'
import { badName, CrmFilesError, type CrmFilesService } from './service.ts'
import type { AsyncFsHandler, AsyncFsWrites } from './winfsp-bridge.ts'
import { byName, FsStatusError, NT, WRITE_PART, type FsEntry } from './winfsp-ops.ts'

// o6e65 S9a: the CRM tree as the drive's main-thread side: it answers the worker's questions (winfsp-bridge.ts) from the CRM files service. Names are what the Windows WebDAV way shows
// (legalWindowsName/namesOf: forbidden characters become "_", names that differ only by case are told apart by id), so the same file has the same name in both ways.
//
// Reads go through a READ-AHEAD cache of fixed blocks: a read is served from 4 MiB blocks fetched with ranged requests; the next block is fetched ahead when a file is read in order, hiding the
// CRM's latency. MEMORY IS BOUNDED, said here once: at most MAX_BLOCKS blocks (16 × 4 MiB = 64 MiB) are kept (the oldest are dropped), plus the blocks being fetched; nothing else is held.
//
// o6e65 S9b, the saves. A program that writes to the drive writes into a STAGING FILE on this PC (<spool>/.staging/<uuid>.part), never into memory (a write part is at most WRITE_PART). When its last
// handle closes with bytes written, the staging file is MOVED into the agent's spool (spool.ts: a rename on one disk, instant whatever the size) and the save is acknowledged; the spool sends it to the
// CRM in the background and keeps it until the CRM has it. Until then the drive shows it (the folder lists it, a read gives its bytes, a rename moves it). A file that already exists in the CRM
// is changed as a NEW VERSION (its old bytes are first copied into the staging file, unless it was opened to be emptied). Nothing is ever deleted: only a file made in this very session that no
// one has saved yet can be deleted (it is our own staging copy). A CRM file is never replaced by a rename; a file waiting to be saved that is renamed over a document becomes that document's new
// version (a program's "safe save": a temporary file renamed over the original). The little files programs make beside a document (isSideName) are kept on this PC only, as the WebDAV way does.

export const BLOCK_BYTES = 4 * 1024 * 1024
export const MAX_BLOCKS = 16
/** The most an existing file may be to be changed in place (its bytes are copied to the staging file first). A larger one is replaced by saving a whole new file over it (emptied first). */
export const MODIFY_MAX = 256 * 1024 * 1024
export const STAGING_DIR = '.staging'

const entryOf = (name: string, n: CrmNode): FsEntry => {
  const m = Date.parse(n.modifiedAt ?? n.createdAt ?? '')
  const c = Date.parse(n.createdAt ?? n.modifiedAt ?? '')
  return { name, dir: n.isFolder, size: n.isFolder ? 0 : (n.size ?? 0), mtime: Number.isFinite(m) ? m : 0, ctime: Number.isFinite(c) ? c : 0 }
}

const notFound = () => Object.assign(new Error('not found'), { notFound: true })
const nt = (n: number, message?: string) => new FsStatusError(n, message)

/** The status a CRM refusal is answered with. */
function statusOf(e: unknown): number {
  if (e instanceof FsStatusError) return e.nt
  if (e instanceof CrmFilesError) {
    if (e.status === 507) return NT.DISK_FULL
    switch (e.code) {
      case 'forbidden':
      case 'nodelete':
        return NT.ACCESS_DENIED
      case 'notfound':
        return NT.OBJECT_NAME_NOT_FOUND
      case 'conflict':
        return NT.OBJECT_NAME_COLLISION
      case 'badname':
        return NT.OBJECT_NAME_INVALID
      case 'toolarge':
        return NT.DISK_FULL
      case 'crm-signin':
      case 'crm-down':
        return NT.UNEXPECTED_NETWORK_ERROR
      default:
        return NT.IO_DEVICE_ERROR
    }
  }
  if ((e as NodeJS.ErrnoException)?.code === 'ENOSPC') return NT.DISK_FULL
  return NT.IO_DEVICE_ERROR
}

/** Runs a save step; whatever goes wrong becomes the status to answer (never a thrown surprise, never a fake success). */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw e instanceof FsStatusError ? e : nt(statusOf(e), e instanceof Error ? e.message : String(e))
  }
}

export interface CrmFsHandler extends AsyncFsHandler {
  /** Blocks held now (tests: the bound). */
  heldBlocks(): number
  /** Saves are possible through this handler (the service keeps a spool). */
  writes: AsyncFsWrites
  /** At the end of the drive: the temporary copies of the little side files go; nothing a person saved is touched. */
  close(): Promise<void>
  /** Tests: the open save sessions. */
  sessions(): { name: string; size: number; handles: number; dirty: boolean; fresh: boolean }[]
}

export interface CrmFsOptions {
  /** Tests: smaller blocks / fewer kept. */
  blockBytes?: number
  maxBlocks?: number
  /** The "Save into the drive" setting: false = EVERY change is refused (write protected), whatever else is true. Left out = allowed (tests). The drive's start gives it the setting, which is OFF unless the person turned it on. */
  allowWrites?: () => boolean
  /** Tests: where staging files go (default: <spool>/.staging). */
  stagingDir?: string
  modifyMax?: number
  log?: { info(m: string): void; warn(m: string): void }
}

/** One file being written through the drive. */
interface Session {
  sid: number
  /** The folder it is in (changes when it is moved). */
  parent: CrmNode
  /** Its name on the drive (changes when it is renamed). */
  name: string
  /** The CRM file it changes (a new version), or null for a file that is new. */
  node: CrmNode | null
  /** The kept (spooled) copy its bytes started from, when it was opened while waiting to be saved. */
  kept: CrmSpoolEntry | null
  staging: string
  fh: FileHandle | null
  size: number
  mtime: number
  ctime: number
  /** The staging file holds the file's whole content (otherwise it still has to be copied from where the file is). */
  loaded: boolean
  loading: Promise<void> | null
  dirty: boolean
  handles: number
  /** Made in this session (never saved before, nothing of it in the CRM or the spool). */
  fresh: boolean
}

export function createCrmFsHandler(service: () => CrmFilesService | null, opt: CrmFsOptions = {}): CrmFsHandler {
  const BLOCK = opt.blockBytes ?? BLOCK_BYTES
  const MAX = opt.maxBlocks ?? MAX_BLOCKS
  const modifyMax = opt.modifyMax ?? MODIFY_MAX
  const svc = (): CrmFilesService => {
    const s = service()
    if (!s) throw new Error('the CRM files are not ready')
    return s
  }

  /** The children of a folder under their Windows names (a Map from name to node), sorted by name. */
  async function kidsOf(id: string): Promise<[string, CrmNode][]> {
    const { children } = await svc().children(id)
    return [...namesOf(children, legalWindowsName, true)].sort((a, b) => byName(a[0], b[0]))
  }

  // ---- what is kept on this PC (S9b) ----
  const sessions = new Map<number, Session>()
  let nextSid = 1
  const sessionsIn = (parentId: string): Session[] => [...sessions.values()].filter(s => s.fresh && s.parent.id === parentId)
  const sessionOfNode = (id: string): Session | null => [...sessions.values()].find(s => s.node?.id === id) ?? null
  const keptIn = (parentId: string): CrmSpoolEntry[] => svc().spool?.pendingIn(parentId) ?? []
  const keptVersion = (id: string): CrmSpoolEntry | null => svc().spool?.pendingVersion(id) ?? null
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

  type Look =
    | { kind: 'node'; node: CrmNode; name: string; parent: CrmNode | null }
    | { kind: 'kept'; entry: CrmSpoolEntry; name: string; parent: CrmNode }
    | { kind: 'session'; session: Session; name: string; parent: CrmNode }
    | { kind: 'none'; name: string; parent: CrmNode }

  /** What a path is: a CRM node, a save kept in the spool, a file made in this session, or nothing yet (with its folder); null when its folder is not there. */
  async function lookup(p: string): Promise<Look | null> {
    const parts = p.split('\\').filter(Boolean)
    let node = (await svc().children('root')).node
    let parent: CrmNode | null = null
    let name = ''
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1
      if (!node.isFolder) return null
      const want = parts[i]
      const hit = (await kidsOf(node.id)).find(([n]) => same(n, want))
      if (hit) {
        parent = node
        ;[name, node] = hit
        continue
      }
      if (!last) return null
      const made = sessionsIn(node.id).find(s => same(s.name, want))
      if (made) return { kind: 'session', session: made, name: made.name, parent: node }
      const kept = keptIn(node.id).find(e => same(e.name, want))
      if (kept) return { kind: 'kept', entry: kept, name: kept.name, parent: node }
      return { kind: 'none', name: want, parent: node }
    }
    return { kind: 'node', node, name, parent }
  }

  /** The drive's entry for what was found, with what is kept on this PC laid over the CRM's (the newer size and time of a save waiting to go up). */
  function entryFor(l: Look): FsEntry {
    if (l.kind === 'none') throw notFound()
    if (l.kind === 'session') return { name: l.name, dir: false, size: l.session.size, mtime: l.session.mtime, ctime: l.session.ctime }
    if (l.kind === 'kept') {
      const t = Date.parse(l.entry.since) || 0
      return { name: l.name, dir: false, size: l.entry.size, mtime: t, ctime: t }
    }
    const base = entryOf(l.name, l.node)
    if (l.node.isFolder) return base
    const s = sessionOfNode(l.node.id)
    if (s && s.dirty) return { ...base, size: s.size, mtime: s.mtime }
    const k = keptVersion(l.node.id)
    if (k) return { ...base, size: k.size, mtime: Date.parse(k.since) || base.mtime }
    return base
  }

  // ---- the read-ahead cache ----
  const blocks = new Map<string, Promise<Buffer>>() // insertion order = age
  const keyOf = (n: CrmNode, i: number) => `${n.id}|${n.modifiedAt ?? ''}|${n.size ?? ''}|${i}`
  function block(n: CrmNode, i: number): Promise<Buffer> {
    const k = keyOf(n, i)
    const had = blocks.get(k)
    if (had) {
      blocks.delete(k)
      blocks.set(k, had) // most recently used
      return had
    }
    const size = n.size ?? 0
    const start = i * BLOCK
    const len = Math.min(BLOCK, size - start)
    const p = svc().fileBytes(n.id, start, len)
    blocks.set(k, p)
    p.catch(() => blocks.delete(k)) // a failed fetch is not kept
    while (blocks.size > MAX) blocks.delete(blocks.keys().next().value as string)
    return p
  }

  /** Bytes [offset, offset+length) of a local file (a staging file or a kept copy). */
  async function readLocal(file: string, offset: number, length: number): Promise<Uint8Array> {
    const fh = await openFile(file, 'r')
    try {
      const out = Buffer.alloc(length)
      const { bytesRead } = await fh.read(out, 0, length, offset)
      return out.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  }

  // ---- staging ----
  const stagingDir = (): string => {
    const dir = opt.stagingDir ?? (svc().spool ? path.join(svc().spool!.dir, STAGING_DIR) : null)
    if (!dir) throw nt(NT.MEDIA_WRITE_PROTECTED)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const needSave = () => {
    const s = svc()
    if (!s.save || !s.spool) throw nt(NT.MEDIA_WRITE_PROTECTED)
    return s
  }

  // Leftovers of an earlier run (the agent was stopped while a file was open) are kept where they are and said once.
  let warned = false
  const warnLeftovers = () => {
    if (warned) return
    warned = true
    try {
      const dir = opt.stagingDir ?? (svc().spool ? path.join(svc().spool!.dir, STAGING_DIR) : '')
      if (dir && existsSync(dir) && readdirSync(dir).length > 0) opt.log?.warn(`crm drive: ${readdirSync(dir).length} half-written file(s) from an earlier run are kept in ${dir}`)
    } catch {
      // only a note
    }
  }

  async function newSession(init: Pick<Session, 'parent' | 'name' | 'node' | 'kept' | 'fresh'> & { size: number; loaded: boolean; dirty: boolean }): Promise<Session> {
    const staging = path.join(stagingDir(), `${randomUUID()}.part`)
    const fh = await openFile(staging, 'w+')
    const now = Date.now()
    const s: Session = { sid: nextSid++, ...init, staging, fh, mtime: now, ctime: now, loading: null, handles: 1 }
    sessions.set(s.sid, s)
    return s
  }

  async function dropSession(s: Session): Promise<void> {
    sessions.delete(s.sid)
    await s.fh?.close().catch(() => undefined)
    s.fh = null
    // Our own staging copy only (never a file a person saved: that one is in the spool).
    await rm(s.staging, { force: true }).catch(() => undefined)
  }

  /** Copies the file's current bytes into the staging file (once), so a change in the middle keeps the rest. */
  function ensureLoaded(s: Session): Promise<void> {
    if (s.loaded) return Promise.resolve()
    s.loading ??= guarded(async () => {
      if (s.kept) {
        const f = svc().spool?.fileOf(s.kept.id)
        if (!f) throw nt(NT.OBJECT_NAME_NOT_FOUND)
        await s.fh!.close()
        await copyFile(f.path, s.staging)
        s.fh = await openFile(s.staging, 'r+')
      } else if (s.node) {
        const f = await svc().file(s.node.id)
        await s.fh!.close()
        await pipeline(f.stream, createWriteStream(s.staging))
        s.fh = await openFile(s.staging, 'r+')
      }
      s.size = (await s.fh!.stat()).size
      s.loaded = true
    }).finally(() => (s.loading = null))
    return s.loading
  }

  const stat = (s: Session): FsEntry => ({ name: s.name, dir: false, size: s.size, mtime: s.mtime, ctime: s.ctime })
  const sessionOf = (sid: number): Session => {
    const s = sessions.get(sid)
    if (!s) throw nt(NT.INVALID_HANDLE)
    return s
  }

  /** The last handle closed with bytes written: the staging file is moved into the spool (and that is the acknowledgement). */
  async function commit(s: Session): Promise<void> {
    await s.fh?.sync().catch(() => undefined)
    await s.fh?.close().catch(() => undefined)
    s.fh = null
    const service = needSave()
    const base = { parent: s.parent.id, size: s.size, from: s.staging }
    const type = s.node ? s.node.type || driveType(s.node.name).type : driveType(s.name).type
    try {
      await service.save!({ ...base, name: s.node ? s.node.name : s.name, type, target: s.node?.id ?? null })
    } catch (e) {
      // The CRM would refuse it now (a right that went away while the file was open): the bytes are still kept, listed as refused with the CRM's words, until the person says otherwise.
      if (e instanceof CrmFilesError && ['forbidden', 'notfound', 'conflict', 'badname', 'toolarge'].includes(e.code)) {
        await service.spool!.add({ kind: s.node ? 'version' : 'new', parent: s.parent.id, target: s.node?.id ?? null, name: s.node ? s.node.name : s.name, type, project: null, from: s.staging, size: s.size, parked: e.message })
      } else {
        s.fh = await openFile(s.staging, 'r+').catch(() => null)
        throw e
      }
    }
    sessions.delete(s.sid)
  }

  const rawWrites: AsyncFsWrites = {
    create: (p, dir) =>
      guarded(async () => {
        const service = needSave()
        const l = await lookup(p)
        if (!l) throw nt(0xc000003a | 0) // OBJECT_PATH_NOT_FOUND
        if (l.kind !== 'none') throw nt(NT.OBJECT_NAME_COLLISION)
        if (l.parent.id === 'root' || l.parent.kind === 'root' || l.parent.kind === 'category') throw nt(NT.ACCESS_DENIED)
        const bad = badName(l.name)
        if (bad) throw nt(NT.OBJECT_NAME_INVALID, bad)
        if (dir) {
          if (!l.parent.rights.mkdir) throw nt(NT.ACCESS_DENIED)
          const made = await service.folder(l.parent.id, l.name)
          return { sid: 0, entry: entryOf(l.name, made) }
        }
        if (!l.parent.rights.upload) throw nt(NT.ACCESS_DENIED)
        warnLeftovers()
        const s = await newSession({ parent: l.parent, name: l.name, node: null, kept: null, fresh: true, size: 0, loaded: true, dirty: false })
        return { sid: s.sid, entry: stat(s) }
      }),

    open: (p, truncate) =>
      guarded(async () => {
        needSave()
        const l = await lookup(p)
        if (!l || l.kind === 'none') throw nt(NT.OBJECT_NAME_NOT_FOUND)
        if (l.kind === 'node' && l.node.isFolder) throw nt(NT.FILE_IS_A_DIRECTORY)
        warnLeftovers()
        if (l.kind === 'session') {
          const s = l.session
          s.handles++
          if (truncate) {
            await s.fh?.truncate(0)
            s.size = 0
            s.dirty = true
            s.mtime = Date.now()
          }
          return { sid: s.sid, entry: stat(s) }
        }
        if (l.kind === 'kept') {
          if (!l.parent.rights.upload) throw nt(NT.ACCESS_DENIED)
          // A save that is waiting to go up, opened again: a new save over it (the spool replaces the waiting one when this is saved).
          const s = await newSession({ parent: l.parent, name: l.name, node: null, kept: l.entry, fresh: false, size: l.entry.size, loaded: truncate, dirty: truncate })
          if (truncate) s.size = 0
          return { sid: s.sid, entry: stat(s) }
        }
        const n = l.node
        if (!n.rights.version) throw nt(NT.ACCESS_DENIED)
        const had = sessionOfNode(n.id)
        if (had) {
          had.handles++
          if (truncate) {
            await had.fh?.truncate(0)
            had.size = 0
            had.loaded = true
            had.dirty = true
            had.mtime = Date.now()
          }
          return { sid: had.sid, entry: stat(had) }
        }
        const k = keptVersion(n.id)
        const size = k ? k.size : (n.size ?? 0)
        if (!truncate && size > modifyMax) throw nt(NT.ACCESS_DENIED, 'That file is too large to change in place; save a whole new file over it.')
        const s = await newSession({ parent: l.parent ?? (await svc().children('root')).node, name: l.name, node: n, kept: k, fresh: false, size: truncate ? 0 : size, loaded: truncate, dirty: truncate })
        return { sid: s.sid, entry: { ...entryOf(l.name, n), size: s.size } }
      }),

    write: (sid, offset, data, toEnd) =>
      guarded(async () => {
        const s = sessionOf(sid)
        if (data.length > WRITE_PART) throw nt(NT.IO_DEVICE_ERROR)
        await ensureLoaded(s)
        const at = toEnd ? s.size : offset
        await s.fh!.write(data, 0, data.length, at)
        s.size = Math.max(s.size, at + data.length)
        s.mtime = Date.now()
        s.dirty = true
        return { written: data.length, entry: stat(s) }
      }),

    setSize: (sid, size) =>
      guarded(async () => {
        const s = sessionOf(sid)
        if (size === 0) s.loaded = true
        else await ensureLoaded(s)
        await s.fh!.truncate(size)
        s.size = size
        s.mtime = Date.now()
        s.dirty = true
        return stat(s)
      }),

    release: (sid, del) =>
      guarded(async () => {
        const s = sessions.get(sid)
        if (!s) return
        s.handles = Math.max(0, s.handles - 1)
        if (s.handles > 0) return
        if (del) {
          // Only a file made in this session that no one saved (it is our own staging copy).
          if (s.fresh) await dropSession(s)
          return
        }
        if (isSideName(s.name) && !s.node) return // a program's own little file: stays on this PC, listed, until the drive ends
        if (s.dirty) {
          await commit(s)
          return
        }
        // Nothing was written: a file just made stays (empty) where it is until something is saved into it; an opened one is let go.
        if (!s.fresh) await dropSession(s)
      }),

    canDelete: (sid, p) =>
      guarded(async () => {
        const s = sessions.get(sid)
        if (s) return s.fresh && !s.node
        // A delete on a handle with no save session: only a program's own little side file (kept on this PC only) may go.
        const l = await lookup(p)
        return l?.kind === 'session' && isSideName(l.name) && l.session.handles === 0
      }),

    remove: p =>
      guarded(async () => {
        const l = await lookup(p)
        if (l?.kind === 'session' && isSideName(l.name) && l.session.handles === 0) await dropSession(l.session)
      }),

    rename: (from, to, replace) =>
      guarded(async () => {
        const service = needSave()
        const a = await lookup(from)
        if (!a || a.kind === 'none') throw nt(NT.OBJECT_NAME_NOT_FOUND)
        const b = await lookup(to)
        if (!b) throw nt(0xc000003a | 0)
        const destParent = b.parent ?? (await svc().children('root')).node
        if (destParent.kind === 'root' || destParent.kind === 'category') throw nt(NT.ACCESS_DENIED)
        const destName = b.name
        const destIsDoc = b.kind === 'node' && !b.node.isFolder
        if (isSideName(destName) && a.kind !== 'session') throw nt(NT.ACCESS_DENIED)

        if (a.kind === 'session') {
          const s = a.session
          if (b.kind === 'none' || (b.kind === 'session' && b.session === s)) {
            if (!destParent.rights.upload) throw nt(NT.ACCESS_DENIED)
            s.parent = destParent
            s.name = destName
            // A temporary file given its real name: saved now if it has bytes and no one holds it open.
            if (s.dirty && s.handles === 0 && !isSideName(destName)) await commit(s)
            return
          }
          if (destIsDoc && replace) {
            if (!(b as { node: CrmNode }).node.rights.version) throw nt(NT.ACCESS_DENIED)
            // A program's safe save: its temporary file renamed over the document becomes the document's new version.
            s.node = (b as { node: CrmNode }).node
            s.fresh = false
            s.parent = destParent
            s.name = s.node.name
            if (s.handles === 0) await commit(s)
            return
          }
          throw nt(NT.OBJECT_NAME_COLLISION)
        }

        if (a.kind === 'kept') {
          const spool = service.spool!
          if (b.kind === 'none') {
            if (!spool.rename(a.entry.id, { parent: destParent.id, name: destName, project: destParent.name })) throw nt(NT.SHARING_VIOLATION)
            return
          }
          if (destIsDoc && replace) {
            const doc = (b as { node: CrmNode }).node
            if (!doc.rights.version) throw nt(NT.ACCESS_DENIED)
            if (!spool.retarget(a.entry.id, { target: doc.id, name: doc.name, parent: destParent.id, project: destParent.name })) throw nt(NT.SHARING_VIOLATION)
            return
          }
          throw nt(NT.OBJECT_NAME_COLLISION)
        }

        // A CRM file or folder: renamed or moved through the CRM's own routes; never replaces anything.
        if (b.kind !== 'none') {
          if (b.kind === 'node' && b.node.id === a.node.id) {
            // Only the case of the name changed (Windows keeps the case): the CRM's rename takes it.
            if (destName !== a.name) await service.rename(a.node.id, destName)
            return
          }
          throw nt(NT.OBJECT_NAME_COLLISION)
        }
        if (a.parent && a.parent.id !== destParent.id) await service.move(a.node.id, destParent.id)
        if (!same(destName, a.node.name) || destName !== a.node.name) await service.rename(a.node.id, destName)
      }),
  }

  // Every change goes through this: with the setting off nothing is written, opened to be written, made, renamed or deleted.
  const writes = Object.fromEntries(
    Object.entries(rawWrites).map(([name, fn]) => [name, (...args: unknown[]) => (opt.allowWrites?.() === false ? Promise.reject(nt(NT.MEDIA_WRITE_PROTECTED)) : (fn as (...a: unknown[]) => Promise<unknown>)(...args))]),
  ) as unknown as AsyncFsWrites

  return {
    heldBlocks: () => blocks.size,
    writes,
    sessions: () => [...sessions.values()].map(s => ({ name: s.name, size: s.size, handles: s.handles, dirty: s.dirty, fresh: s.fresh })),

    async close() {
      // The side files (a program's lock and temporary files) were only ever kept on this PC: they go with the drive. A save that was never moved into the spool is left where it is.
      for (const s of [...sessions.values()]) if (isSideName(s.name) && !s.node && s.handles === 0) await dropSession(s)
    },

    async stat(path) {
      const l = await lookup(path)
      return l && l.kind !== 'none' ? entryFor(l) : null
    },

    async list(path, marker) {
      const l = await lookup(path)
      if (!l || l.kind !== 'node' || !l.node.isFolder) throw notFound()
      const kids = await kidsOf(l.node.id)
      const have = new Set(kids.map(([n]) => n.toLowerCase()))
      const extra: FsEntry[] = []
      for (const e of keptIn(l.node.id)) if (!have.has(e.name.toLowerCase())) extra.push(entryFor({ kind: 'kept', entry: e, name: e.name, parent: l.node }))
      for (const s of sessionsIn(l.node.id)) if (!have.has(s.name.toLowerCase()) && !extra.some(x => same(x.name, s.name))) extra.push(entryFor({ kind: 'session', session: s, name: s.name, parent: l.node }))
      const all = [...kids.map(([n, node]) => entryFor({ kind: 'node', node, name: n, parent: l.node })), ...extra].sort((x, y) => byName(x.name, y.name))
      const after = marker === null ? all : all.filter(e => byName(e.name, marker) > 0)
      return { entries: after, more: false }
    },

    async read(path, offset, length) {
      const l = await lookup(path)
      if (!l || l.kind === 'none' || (l.kind === 'node' && l.node.isFolder)) throw notFound()
      if (l.kind === 'session') {
        const s = l.session
        if (offset >= s.size || length <= 0) return new Uint8Array(0)
        return readLocal(s.staging, offset, Math.min(length, s.size - offset))
      }
      if (l.kind === 'kept') {
        const f = svc().spool?.fileOf(l.entry.id)
        if (!f) throw notFound()
        if (offset >= f.size || length <= 0) return new Uint8Array(0)
        return readLocal(f.path, offset, Math.min(length, f.size - offset))
      }
      const node = l.node
      // A change being written (its bytes are in the staging file), or a save waiting to go up (its bytes are in the spool): those are the newer ones.
      const s = sessionOfNode(node.id)
      if (s && s.dirty && s.loaded) {
        if (offset >= s.size || length <= 0) return new Uint8Array(0)
        return readLocal(s.staging, offset, Math.min(length, s.size - offset))
      }
      const k = keptVersion(node.id)
      if (k) {
        const f = svc().spool?.fileOf(k.id)
        if (f) {
          if (offset >= f.size || length <= 0) return new Uint8Array(0)
          return readLocal(f.path, offset, Math.min(length, f.size - offset))
        }
      }
      const size = node.size ?? 0
      if (offset >= size || length <= 0) return new Uint8Array(0)
      const end = Math.min(size, offset + length)
      const out = Buffer.alloc(end - offset)
      let at = offset
      while (at < end) {
        const i = Math.floor(at / BLOCK)
        // in order: the next block is on its way before it is asked for
        if ((i + 1) * BLOCK < size && blocks.has(keyOf(node, i - 1))) void block(node, i + 1).catch(() => undefined)
        const b = await block(node, i)
        const from = at - i * BLOCK
        const take = Math.min(b.length - from, end - at)
        if (take <= 0) throw new Error('the CRM sent less than it said')
        b.copy(out, at - offset, from, from + take)
        at += take
      }
      return out
    },
  }
}
