import { createHash } from 'node:crypto'
import { type FileHandle, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

// o6e65 S8: OFFLINE PINS ("Keep on this PC") for the CRM drive — a NEW-FILES-ONLY candidate, built in parallel with Web (Agent 5, who owns the hook,
// the S9b write-back and the S6 "Access removed" folder). This is the PURE engine: a pin store, a cache directory with a quota, a resumable background
// download queue, reads from disk when offline, eviction (never a pinned file, LRU for the rest), pin inheritance (pin a folder -> its files are pinned),
// a refresh when a pinned file changes in the CRM (the OLD copy is still on disk until the new one lands), and a hand-over to Web's "Access removed"
// folder when a pinned item loses its CRM access.
//
// Everything the engine needs from the outside is INJECTED (PinDeps), so it runs with a fake CRM and a fake clock and never imports the Dev tree: the hook
// wires `fetchBytes` to service.fileBytes, `freeBytes` to statfs, and (optionally) `accessRemoved` to the S6 folder. The drive's read path asks `readCached`
// first for a pinned file (and offline, it is the only source).
//
// On disk under the cache dir: `crm-pins.json` (the store: settings + pins + what is cached/downloading), and `blobs/<fileId>__<version>` for each copy
// (plus `...__<version>.part` for a download in progress). A copy is keyed by file id AND version, so a NEW version downloads beside the old one and the old
// one stays until the new lands. Download progress counts only once its bytes are flushed to the disk (fsync, then the store), so a crash never claims bytes
// that are not there, and a copy that finished just before a crash is found again at start.
//
// Safety rules:
// - The quota (and, with `freeBytes`, a free-space reserve on the disk) bounds EVERY download, pinned ones included: a pinned file that does not fit waits
//   (status `waitingForSpace`); it never fills the disk. Unpinned leftovers are evicted (least recently used first) to make room; nothing pinned ever is.
// - A held file counts as "access removed" only once two listings at least `removalGraceMs` apart have missed it, and a listing with no files at all proves
//   nothing (the same two rules as Web's removed.ts), so one CRM hiccup never empties anyone's offline copies. If the file comes back, it is simply resumed.
// - A file whose CRM record has no size (old records) is not downloaded (status `sizeUnknown`): the engine never claims a copy it cannot check.
// Nothing is ever deleted from the CRM; the only files removed are the engine's OWN cached copies, by the eviction / unpin / refresh / access rules.

// ---- the shapes the hook passes in ---------------------------------------------------------------------------------

/** A pin target: a file or a folder (category/project/group). A folder pin makes every file under it pinned (inheritance). */
export type PinKind = 'file' | 'folder'

/** One node of the CRM tree as the hook sees it now; `reconcile` is given the whole set the person can access. */
export interface PinItem {
  id: string
  kind: PinKind
  parentId: string | null
  name: string
  /** Files only: an opaque token that CHANGES when the file changes in the CRM (the hook builds it with `versionToken`). A new token => re-download. */
  version?: string
  /** Files only: the byte size, for the quota and the download. Left out (or null) when the CRM's record has none: such a file is not downloaded. */
  size?: number | null
}

/** What the engine needs of the world; all injected so it is testable and never touches the Dev tree. */
export interface PinDeps {
  /** Bytes [start, start+length) of a file's CURRENT content (the hook wires this to service.fileBytes). Fewer only at the end of the file. Throws on a CRM/network error; it is retried. */
  fetchBytes(fileId: string, start: number, length: number): Promise<Uint8Array>
  /** Free bytes on the disk that holds the cache dir (the hook wires this to statfs). A download starts only if it leaves `freeReserveBytes` free. Left out: the quota alone bounds the cache. */
  freeBytes?: (dir: string) => Promise<number>
  /** The current time (ms). Tests inject a clock. */
  now?: () => number
  /** S6 hand-over (Web). When a pinned item the engine holds loses its CRM access, the engine offers it here; Web's "Access removed" folder decides keep/evict. */
  accessRemoved?: AccessRemovedSink
  /** Before writing a FRESH `.part`, prepare the file (e.g. mark it sparse on Windows for a huge pinned file). Default: nothing. Tests use it for the 1 GB case. */
  prepareFile?: (file: string, size: number) => Promise<void>
  log?: { info(m: string): void; warn(m: string): void }
}

/** Web's "Access removed" sink (S6). The interface is written up in REPORT.md and agreed with Web through the Assistant (order o50c6). */
export interface AccessRemovedSink {
  /**
   * A pinned file the engine holds on this PC is no longer accessible in the CRM (its project access was removed, or it is gone). keep:true keeps a FINISHED
   * copy IN PLACE (served from `cachePath`, never evicted, listed by `pinnedUnder`); keep:false lets the engine delete it. A half-finished download
   * (`cachePath` null) is always dropped (there is nothing to serve) and starts again if access returns. If this throws, the copy is kept.
   */
  handOver(item: AccessRemovedItem): Promise<{ keep: boolean }>
}

export interface AccessRemovedItem {
  id: string
  kind: PinKind
  name: string
  /** The finished cached copy on disk, or null when nothing complete is held. */
  cachePath: string | null
  size: number
  version: string | null
  reason: 'access-removed'
}

// ---- settings ------------------------------------------------------------------------------------------------------

export interface PinSettings {
  /** The cache's size limit in MB. 20 GB by default. It bounds every download, pinned ones included. */
  quotaMb: number
  /** The cache folder. null = the engine's own folder (`dir`). Changes only while the cache is empty. */
  dir: string | null
}

export const PIN_STORE_FILE = 'crm-pins.json'
const MB = 1024 * 1024
export const PIN_QUOTA_MB_DEFAULT = 20 * 1024 // 20 GB
export const PIN_QUOTA_MB_MAX = 50 * 1024 * 1024 // 50 TB ceiling for the setting
/** A download never leaves less than this free on the cache's disk (when `freeBytes` is wired). */
export const PIN_FREE_RESERVE_BYTES = 2 * 1024 * MB // 2 GB
/** A held file must be missed by two listings at least this far apart before it is "access removed" (= Web's removed.ts MIN_GAP_MS). */
export const PIN_REMOVAL_GRACE_MS = 30_000
const CHUNK_DEFAULT = 8 * MB
/** How often a running download records its (flushed) progress. */
const CHECKPOINT_MS = 1000
/** How long close() waits for a download in flight to reach a chunk boundary. */
const CLOSE_WAIT_MS = 2000
/** Growing waits before a failed download is tried again (per file): 2 s, 5 s, 15 s, 1 min, then 5 min for ever. */
const DELAY_DEFAULT = (tries: number) => [2000, 5000, 15000, 60000, 300000][Math.min(tries, 4)] ?? 300000

// ---- the stored state ----------------------------------------------------------------------------------------------

interface PinRecordStored {
  id: string
  kind: PinKind
  since: number
}

/** A copy the engine holds (complete) or is getting for the FIRST time (complete=false, nothing served yet). */
interface CacheEntryStored {
  version: string
  size: number
  /** Bytes on disk so far, counted only once flushed (== size when complete). */
  bytes: number
  complete: boolean
  /** ms of the last read (LRU). */
  lastAccess: number
  /** true while the file (or an ancestor) is pinned: never evicted. Recomputed by every reconcile for the files it lists; kept across a restart. */
  pinned: boolean
  /** S6: kept after its CRM access was removed (hand-over keep:true). Never evicted, not re-downloaded, listed by pinnedUnder until access returns or it is dropped. */
  orphan: boolean
  /** The owning project node id ("proj:<id>") last seen, or null (a category file). For pinnedUnder / Web's "Access removed" folder. */
  project: string | null
  name: string
}

/** A NEWER version downloading while the (older) complete `cache[id]` stays on disk. On completion it replaces `cache[id]`. */
interface PendingStored {
  version: string
  size: number
  bytes: number
}

interface StoreShape {
  v: 1
  settings: PinSettings
  pins: Record<string, PinRecordStored>
  cache: Record<string, CacheEntryStored>
  pending: Record<string, PendingStored>
}

/** A file of the last listing: its version and size (-1 = the CRM's record has no size). */
interface Known {
  version: string
  size: number
  name: string
}

/** What a download is getting: a newer pending version, or a first copy. */
interface Target {
  version: string
  size: number
  bytes: number
  pending: boolean
}

function defaultStore(): StoreShape {
  return { v: 1, settings: { quotaMb: PIN_QUOTA_MB_DEFAULT, dir: null }, pins: {}, cache: {}, pending: {} }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const whole = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const sizeOf = (v: unknown): number => (whole(v, 0, Number.MAX_SAFE_INTEGER) ? v : -1)

/** Read the store; anything missing or broken falls back to a default (a bad file never stops pinning and is written over at the next change). */
export async function readStore(file: string): Promise<StoreShape> {
  const s = defaultStore()
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return s
  }
  if (!isObject(raw)) return s
  if (isObject(raw.settings)) {
    if (whole(raw.settings.quotaMb, 0, PIN_QUOTA_MB_MAX)) s.settings.quotaMb = raw.settings.quotaMb
    if (raw.settings.dir === null || (typeof raw.settings.dir === 'string' && path.isAbsolute(raw.settings.dir) && raw.settings.dir.length <= 240)) s.settings.dir = raw.settings.dir
  }
  if (isObject(raw.pins)) {
    for (const [id, p] of Object.entries(raw.pins)) {
      if (isObject(p) && (p.kind === 'file' || p.kind === 'folder')) s.pins[id] = { id, kind: p.kind, since: whole(p.since, 0, Number.MAX_SAFE_INTEGER) ? p.since : 0 }
    }
  }
  if (isObject(raw.cache)) {
    for (const [id, c] of Object.entries(raw.cache)) {
      if (!isObject(c) || !str(c.version) || !whole(c.size, 0, Number.MAX_SAFE_INTEGER)) continue
      const bytes = whole(c.bytes, 0, c.size) ? c.bytes : 0
      s.cache[id] = {
        version: c.version as string,
        size: c.size,
        bytes,
        complete: c.complete === true && bytes === c.size,
        lastAccess: whole(c.lastAccess, 0, Number.MAX_SAFE_INTEGER) ? c.lastAccess : 0,
        // the last computed state, so nothing pinned is evictable between a restart and the first listing
        pinned: c.pinned === true,
        orphan: c.orphan === true,
        project: typeof c.project === 'string' ? c.project : null,
        name: str(c.name),
      }
    }
  }
  if (isObject(raw.pending)) {
    for (const [id, p] of Object.entries(raw.pending)) {
      if (isObject(p) && str(p.version) && whole(p.size, 0, Number.MAX_SAFE_INTEGER)) s.pending[id] = { version: p.version as string, size: p.size, bytes: whole(p.bytes, 0, p.size) ? p.bytes : 0 }
    }
  }
  return s
}

// ---- views the page / status use -----------------------------------------------------------------------------------

export interface PinSettingsView extends PinSettings {
  defaultDir: string
  /** The cache dir in use now. */
  dir2: string
}

export interface PinStatus {
  pinnedFiles: number
  pinnedBytes: number
  cacheBytes: number
  quotaBytes: number
  /** Pinned data alone is over the quota (it is still kept; nothing else can be cached, and no more pinned files download). */
  pinnedOverQuota: boolean
  /** Files still to download (pinned, missing or a newer version). */
  queued: number
  /** A download is waiting out a back-off (likely offline). */
  waitingRetry: boolean
  /** Pinned files waiting for room: they do not fit the quota (or the disk's free-space reserve). Raise the limit or free some space. */
  waitingForSpace: number
  /** Pinned files that cannot be kept on this PC because the CRM's record has no size (old records). */
  sizeUnknown: number
  /** Copies kept after their CRM access was removed (shown under "Access removed"). */
  heldAfterRemoval: number
}

export interface PinRecord {
  id: string
  kind: PinKind
  since: number
}

/** A finished copy on disk. */
export interface CachedCopy {
  path: string
  size: number
  version: string
}

// ---- the engine ----------------------------------------------------------------------------------------------------

export interface OfflinePinsOptions {
  /** The engine's own cache folder (used when settings.dir is null). */
  dir: string
  deps: PinDeps
  /** Download chunk (bytes). Default 8 MiB. */
  chunkBytes?: number
  /** How many files download at once. Default 2. */
  parallel?: number
  /** Back-off before a file's retry number `tries`. */
  delay?: (tries: number) => number
  /** Run `sync()` by itself on this interval (ms). Left out (tests): the caller drives sync(). */
  syncEveryMs?: number
  /** A held file is "access removed" only when missed by two listings at least this far apart (ms). Default 30 s; 0 = at the first listing that misses it. */
  removalGraceMs?: number
  /** Bytes a download must leave free on the cache's disk (needs `deps.freeBytes`). Default 2 GB. */
  freeReserveBytes?: number
  /** Frequent small changes (progress, reads, finished downloads) are written to the store at most once per this many ms. Default 1 s. */
  persistEveryMs?: number
}

export interface OfflinePins {
  start(): Promise<void>
  pin(target: { id: string; kind: PinKind }): Promise<void>
  unpin(id: string): Promise<void>
  /** Pinned explicitly, or by inheritance when `ancestorIds` holds a pinned folder. */
  isPinned(id: string, ancestorIds?: readonly string[]): boolean
  listPins(): PinRecord[]
  /**
   * The hook feeds the whole accessible tree (after a pin/unpin too). The engine queues downloads for pinned/stale files, hands over pinned files that lost
   * access, and starts the downloads in the background: it returns once its state is updated (await `sync()` to wait for the downloads). Calls run one at a time.
   */
  reconcile(items: readonly PinItem[]): Promise<void>
  /** Run every due download that fits (the caller drives this on an interval, or `syncEveryMs` does). Resolves when this round, and any asked for meanwhile, is done. */
  sync(): Promise<void>
  /** The finished copy of this file at this version, or (version left out/null) at whatever version is held — e.g. the old copy offline during a refresh. */
  cached(fileId: string, version?: string | null): CachedCopy | null
  /** Read [offset, offset+length) from the finished copy (version null = whatever is held), or null when it is not here (fall back to the network). */
  readCached(fileId: string, version: string | null, offset: number, length: number): Promise<Buffer | null>
  settings(): PinSettingsView
  setSettings(c: Partial<PinSettings>): Promise<PinSettingsView>
  status(): PinStatus
  /** S6: the files the engine still holds for a project (after its access was removed, these are the kept copies). `projectId` may be the "proj:<id>" node id or the bare id. */
  pinnedUnder(projectId: string): PinnedUnder[]
  /** S6: Web calls this when a project's access returns, so the engine stops treating its kept files as removed (a following reconcile refreshes them). Returns how many were cleared. */
  accessReturned(projectId: string): Promise<number>
  /** S6 (optional): the person no longer wants the copies kept for a project whose access was removed: delete them (only the engine's own copies; pins stay). Returns how many. */
  dropKept(projectId: string): Promise<number>
  close(): Promise<void>
}

/** One kept file for Web's "Access removed" folder: served in place from `cachePath` (no copy, never evicted while listed here). */
export interface PinnedUnder {
  id: string
  name: string
  cachePath: string
  size: number
  version: string
}

export function createOfflinePins(o: OfflinePinsOptions): OfflinePins {
  const deps = o.deps
  const now = deps.now ?? Date.now
  const chunk = Math.max(1, o.chunkBytes ?? CHUNK_DEFAULT)
  const parallel = Math.max(1, o.parallel ?? 2)
  const delay = o.delay ?? DELAY_DEFAULT
  const grace = Math.max(0, o.removalGraceMs ?? PIN_REMOVAL_GRACE_MS)
  const freeReserve = Math.max(0, o.freeReserveBytes ?? PIN_FREE_RESERVE_BYTES)
  const persistEvery = Math.max(0, o.persistEveryMs ?? 1000)
  const log = deps.log

  let store = defaultStore()
  let loaded = false
  const retryAt = new Map<string, number>()
  const tries = new Map<string, number>()
  /** The files of the last listing that had any: the accessible set, with versions and sizes. */
  let known = new Map<string, Known>()
  /** When a held file was first missed by a listing. In memory only: the two-listing rule starts again with the app (as in removed.ts). */
  const absentSince = new Map<string, number>()
  /** Pinned files that did not fit at their last try (quota or free-space reserve). */
  const spaceWait = new Set<string>()
  let sizeUnknown = 0
  /** Bytes still to come for the downloads admitted in the current round (room is kept for them). */
  let reserved = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let soonTimer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> = Promise.resolve()
  let reconciling: Promise<void> = Promise.resolve()
  let syncing: Promise<void> | null = null
  let again = false
  let closing = false
  let closed = false

  const cacheDir = () => store.settings.dir ?? o.dir
  const blobsDir = () => path.join(cacheDir(), 'blobs')
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_')
  const blobPath = (fileId: string, version: string) => path.join(blobsDir(), `${safe(fileId)}__${safe(version)}`)
  const partPath = (fileId: string, version: string) => `${blobPath(fileId, version)}.part`
  const storeFile = () => path.join(o.dir, PIN_STORE_FILE)

  /** Write the store whole, through a temp file (a crash leaves the old or the new, never half). Serialised. */
  function persist(): Promise<void> {
    if (soonTimer) {
      clearTimeout(soonTimer)
      soonTimer = null
    }
    writing = writing
      .then(async () => {
        if (closed) return
        const file = storeFile()
        await mkdir(path.dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        await writeFile(tmp, JSON.stringify(store))
        for (let i = 0; ; i++) {
          try {
            await rename(tmp, file)
            return
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code ?? ''
            if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw e
            await sleep(25 * (i + 1))
          }
        }
      })
      .catch(e => log?.warn(`crm pins: could not save the pin store (${(e as Error).message})`))
    return writing
  }

  /** Many small changes (progress, reads, finished downloads) become one write per `persistEveryMs`. */
  function persistSoon(): void {
    if (soonTimer || closed) return
    soonTimer = setTimeout(() => {
      soonTimer = null
      void persist()
    }, persistEvery)
    soonTimer.unref?.()
  }

  async function start(): Promise<void> {
    store = await readStore(storeFile())
    loaded = true
    // Match the store to what is really on disk: never claim bytes we do not have, and pick up a copy that finished just before a crash.
    for (const [id, c] of Object.entries(store.cache)) {
      const blob = await sizeOnDisk(blobPath(id, c.version))
      if (c.complete) {
        if (blob !== c.size) Object.assign(c, { complete: false, bytes: 0 })
      } else if (blob === c.size) Object.assign(c, { complete: true, bytes: c.size })
      else c.bytes = Math.min(c.bytes, Math.max(0, await sizeOnDisk(partPath(id, c.version))))
    }
    for (const [id, p] of Object.entries(store.pending)) {
      if ((await sizeOnDisk(blobPath(id, p.version))) === p.size) {
        // the newer version finished before a crash: install it now, as the download would have
        const old = store.cache[id]
        if (old && old.version !== p.version) await rm(blobPath(id, old.version), { force: true }).catch(() => undefined)
        store.cache[id] = { version: p.version, size: p.size, bytes: p.size, complete: true, lastAccess: old?.lastAccess ?? now(), pinned: old?.pinned ?? true, orphan: false, project: old?.project ?? null, name: old?.name ?? '' }
        delete store.pending[id]
      } else p.bytes = Math.min(p.bytes, Math.max(0, await sizeOnDisk(partPath(id, p.version))))
    }
    await persist()
    if (o.syncEveryMs && !timer) {
      timer = setInterval(() => void sync().catch(() => undefined), o.syncEveryMs)
      timer.unref?.()
    }
  }

  function requireLoaded() {
    if (!loaded) throw new Error('offline pins: call start() first')
  }

  async function pin(target: { id: string; kind: PinKind }): Promise<void> {
    requireLoaded()
    store.pins[target.id] = { id: target.id, kind: target.kind, since: now() }
    await persist()
  }

  async function unpin(id: string): Promise<void> {
    requireLoaded()
    if (store.pins[id]) {
      delete store.pins[id]
      // A finished copy is kept (a re-pin is instant and an offline read still works) but becomes evictable; the next reconcile recomputes `pinned`.
      await persist()
    }
  }

  function isPinned(id: string, ancestorIds: readonly string[] = []): boolean {
    if (store.pins[id]) return true
    for (const a of ancestorIds) if (store.pins[a]) return true
    return false
  }

  const listPins = (): PinRecord[] => Object.values(store.pins).map(p => ({ id: p.id, kind: p.kind, since: p.since })).sort((a, b) => a.since - b.since)

  // ---- reconcile ----

  function reconcile(items: readonly PinItem[]): Promise<void> {
    if (!loaded) return Promise.reject(new Error('offline pins: call start() first'))
    // One at a time: two overlapping listings must never hand the same file over twice.
    const run = reconciling.then(() => reconcileNow(items))
    reconciling = run.catch(() => undefined)
    return run
  }

  async function reconcileNow(items: readonly PinItem[]): Promise<void> {
    if (closing) return
    const byId = new Map(items.map(i => [i.id, i]))
    const ancestorsOf = (id: string): string[] => {
      const out: string[] = []
      let cur = byId.get(id)?.parentId ?? null
      const seen = new Set<string>()
      while (cur && !seen.has(cur)) {
        seen.add(cur)
        out.push(cur)
        cur = byId.get(cur)?.parentId ?? null
      }
      return out
    }
    const projectOf = (id: string): string | null => ancestorsOf(id).find(a => a.startsWith('proj:')) ?? null

    const next = new Map<string, Known>()
    const pinnedFileIds = new Set<string>()
    for (const it of items) {
      if (it.kind !== 'file') continue
      next.set(it.id, { version: it.version ?? '', size: sizeOf(it.size), name: it.name })
      if (isPinned(it.id, ancestorsOf(it.id))) pinnedFileIds.add(it.id)
    }
    // A listing with no files at all proves nothing: a CRM that answers nothing for a moment must not make every pinned file "removed" (removed.ts's rule).
    if (next.size === 0) {
      log?.info('crm pins: the listing has no files; nothing changes')
      return
    }
    known = next
    const t = now()

    // 1) The files we hold that this listing does not have. This runs BEFORE step 3 recomputes `pinned`, so it sees the PRIOR pinned state (a folder-pinned file
    //    reads c.pinned=true here). Pin records are KEPT, so a returning project resumes its pins; `orphan` stops a second hand-over and protects the copy.
    for (const id of Object.keys(store.cache)) {
      const c = store.cache[id]
      if (!c) continue
      if (known.has(id)) {
        absentSince.delete(id)
        if (c.orphan) {
          // Its access came back (whether or not Web called accessReturned): an ordinary copy again; step 2 refreshes it if it changed meanwhile.
          c.orphan = false
          log?.info(`crm pins: ${c.name || id} can be opened again`)
        }
        continue
      }
      if (c.orphan) continue // already handed over: kept in place for Web's "Access removed" folder
      const first = absentSince.get(id)
      if (first === undefined) absentSince.set(id, t)
      if (grace > 0 && (first === undefined || t - first < grace)) continue // not yet: two listings, `grace` apart, must miss it
      absentSince.delete(id)
      if (!c.pinned && !store.pins[id]) {
        await dropCopy(id) // an unpinned leftover of a file this person can no longer open: remove the cached copy
        continue
      }
      let keep = true // no S6 wired, or it failed: keep the person's copy rather than silently drop it
      if (deps.accessRemoved) {
        try {
          keep = (await deps.accessRemoved.handOver({ id, kind: 'file', name: c.name, cachePath: c.complete ? blobPath(id, c.version) : null, size: c.size, version: c.version, reason: 'access-removed' })).keep
        } catch (e) {
          keep = true
          log?.warn(`crm pins: access-removed hand-over failed for ${id}, keeping the copy (${(e as Error).message})`)
        }
      }
      if (keep && c.complete) {
        c.orphan = true
        await dropPending(id) // a newer version can no longer be fetched; the finished copy stays where it is
      } else await dropCopy(id) // dropped by S6, or only half-downloaded (nothing to serve; it starts again if access returns)
    }

    // 2) Queue downloads / refreshes for the pinned, accessible files.
    let unknownSize = 0
    for (const id of pinnedFileIds) {
      const want = known.get(id) as Known
      if (want.size < 0) {
        unknownSize++ // the CRM's record has no size: a copy that cannot be checked is never claimed
        continue
      }
      const project = projectOf(id)
      const cur = store.cache[id]
      if (!cur) {
        // never had it: first download
        store.cache[id] = { version: want.version, size: want.size, bytes: 0, complete: false, lastAccess: now(), pinned: true, orphan: false, project, name: want.name }
        resetRetry(id)
      } else if (!cur.complete) {
        // a first download in progress: if the version moved on, restart it at the new version
        if (cur.version !== want.version) {
          await rm(partPath(id, cur.version), { force: true }).catch(() => undefined)
          store.cache[id] = { version: want.version, size: want.size, bytes: 0, complete: false, lastAccess: cur.lastAccess, pinned: true, orphan: false, project, name: want.name }
          resetRetry(id)
        } else Object.assign(cur, { name: want.name, project })
      } else if (cur.version !== want.version) {
        // the copy on disk is out of date: fetch the new version beside it (the old one stays until the new lands) via `pending`
        const p = store.pending[id]
        if (!p || p.version !== want.version) {
          if (p) await rm(partPath(id, p.version), { force: true }).catch(() => undefined)
          store.pending[id] = { version: want.version, size: want.size, bytes: 0 }
          resetRetry(id)
        }
        Object.assign(cur, { name: want.name, project })
      } else Object.assign(cur, { name: want.name, project })
    }
    sizeUnknown = unknownSize

    // 3) Recompute `pinned` for the files this listing has (a missing one keeps its state until step 1 decides; an orphan keeps its protection), and drop
    //    what nobody wants any more: an unpinned half-download, an out-of-date unpinned leftover, a refresh of a file that is no longer pinned.
    for (const [id, c] of Object.entries(store.cache)) {
      const want = known.get(id)
      if (c.orphan || !want) continue
      c.pinned = pinnedFileIds.has(id)
      if (c.pinned) continue
      if (!c.complete || c.version !== want.version) await dropCopy(id)
      else if (store.pending[id]) await dropPending(id)
    }

    persistSoon()
    await enforceQuota()
    void sync().catch(() => undefined)
  }

  const resetRetry = (id: string) => {
    tries.delete(id)
    retryAt.delete(id)
  }

  /** Remove the engine's own copy of a file (finished and in progress, every version) and forget it. Never touches the CRM. */
  async function dropCopy(id: string): Promise<void> {
    await removeAll(id)
    delete store.cache[id]
    delete store.pending[id]
    resetRetry(id)
    spaceWait.delete(id)
    absentSince.delete(id) // a later copy of the same file starts the two-listing rule afresh
  }

  /** Stop a refresh: remove the newer version's partial (and any finished blob of it) and keep the copy that is served. */
  async function dropPending(id: string): Promise<void> {
    const p = store.pending[id]
    if (!p) return
    if (p.version !== store.cache[id]?.version) {
      await rm(partPath(id, p.version), { force: true }).catch(() => undefined)
      await rm(blobPath(id, p.version), { force: true }).catch(() => undefined)
    }
    delete store.pending[id]
    resetRetry(id)
    spaceWait.delete(id)
  }

  // ---- the download queue ----

  /** The target to download for a file: a newer pending version, or a first (incomplete) copy of a pinned file. */
  function target(id: string): Target | null {
    const p = store.pending[id]
    if (p) return { version: p.version, size: p.size, bytes: p.bytes, pending: true }
    const c = store.cache[id]
    if (c && !c.complete && c.pinned && !c.orphan) return { version: c.version, size: c.size, bytes: c.bytes, pending: false }
    return null
  }

  /** A target that the current listing still wants (same version). */
  const live = (id: string): Target | null => {
    const tgt = target(id)
    return tgt && known.get(id)?.version === tgt.version ? tgt : null
  }

  /** Due downloads, the smallest left first (more files fit, and quick ones finish first). */
  function due(): string[] {
    const t = now()
    const out: { id: string; left: number }[] = []
    for (const id of new Set([...Object.keys(store.pending), ...Object.keys(store.cache)])) {
      if ((retryAt.get(id) ?? 0) > t) continue
      const tgt = live(id)
      if (tgt) out.push({ id, left: tgt.size - tgt.bytes })
    }
    return out.sort((a, b) => a.left - b.left || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(x => x.id)
  }

  function sync(): Promise<void> {
    if (closing) return Promise.resolve()
    if (syncing) {
      again = true // someone asked while a round runs: run one more round after it
      return syncing
    }
    syncing = (async () => {
      do {
        again = false
        await runOnce()
      } while (again && !closing)
    })().finally(() => {
      syncing = null
    })
    return syncing
  }

  async function runOnce(): Promise<void> {
    const ids = due()
    let i = 0
    while (i < ids.length && !closing) {
      // Admit one batch (one at a time, so the room kept for each is counted before the next asks), then download it.
      const batch: { id: string; need: number }[] = []
      while (batch.length < parallel && i < ids.length) {
        const id = ids[i++] as string
        const need = await admit(id)
        if (need !== null) batch.push({ id, need })
      }
      await Promise.all(
        batch.map(async b => {
          try {
            await downloadOne(b.id)
          } finally {
            reserved -= b.need
          }
        }),
      )
    }
  }

  /**
   * Room for a download: what is left of it must fit the quota (unpinned leftovers are evicted, least recently used first, only if that is enough) and, with
   * `freeBytes`, leave the free-space reserve on the disk. Returns the bytes kept for it, or null: it waits (status.waitingForSpace) and is tried at the next round.
   */
  async function admit(id: string): Promise<number | null> {
    const tgt = live(id)
    if (!tgt) return null
    const need = Math.max(0, tgt.size - tgt.bytes)
    const quota = store.settings.quotaMb * MB
    let ok = usedBytes() + reserved + need <= quota
    if (!ok && usedBytes() - leftoverBytes() + reserved + need <= quota) {
      await evictLeftovers(quota - reserved - need)
      ok = usedBytes() + reserved + need <= quota
    }
    if (ok && need > 0 && deps.freeBytes) {
      try {
        ok = (await deps.freeBytes(cacheDir())) - reserved - need >= freeReserve
      } catch {
        // the free space is unknown: the quota alone decides
      }
    }
    if (!ok) {
      if (!spaceWait.has(id)) log?.warn(`crm pins: ${store.cache[id]?.name || id} waits for room (${need} bytes to go; the limit is ${store.settings.quotaMb} MB)`)
      spaceWait.add(id)
      return null
    }
    spaceWait.delete(id)
    reserved += need
    return need
  }

  async function downloadOne(id: string): Promise<void> {
    const tgt = live(id)
    if (!tgt) return
    const name = known.get(id)?.name ?? id
    /** Still the same job? (not unpinned, no newer version, not closing) */
    const same = () => {
      const cur = live(id)
      return !closing && !!cur && cur.version === tgt.version && cur.pending === tgt.pending
    }
    const part = partPath(id, tgt.version)
    let fh: FileHandle | null = null
    let offset = tgt.bytes
    let durable = tgt.bytes
    try {
      await mkdir(blobsDir(), { recursive: true })
      // The .part must still hold what the store counts (it may have been removed or cut behind our back); if not, this file starts again.
      if (offset > 0 && (await sizeOnDisk(part)) < offset) {
        offset = durable = 0
        setBytes(id, tgt, 0)
      }
      const fresh = offset === 0
      fh = await open(part, fresh ? 'w' : 'r+')
      if (fresh && deps.prepareFile) await deps.prepareFile(part, tgt.size)
      let mark = now()
      while (offset < tgt.size) {
        if (!same()) return // unpinned, a newer version, or closing: stop (what is written stays, for a resume)
        const len = Math.min(chunk, tgt.size - offset)
        const got = await deps.fetchBytes(id, offset, len)
        if (got.length === 0) throw new Error('the CRM sent no bytes')
        if (got.length > len) throw new Error(`the CRM sent ${got.length} bytes for ${len} asked`)
        await fh.write(Buffer.from(got.buffer, got.byteOffset, got.byteLength), 0, got.length, offset)
        offset += got.length
        if (now() - mark >= CHECKPOINT_MS) {
          await fh.datasync() // progress counts only once it is on the disk
          durable = offset
          setBytes(id, tgt, durable)
          persistSoon()
          mark = now()
        }
      }
      await fh.sync()
      durable = offset
      await fh.close()
      fh = null
      if (!same()) return
      await rename(part, blobPath(id, tgt.version))
      // Install the finished copy. A pending (newer) version replaces the old one (and its blob is removed).
      const old = store.cache[id]
      if (tgt.pending && old && old.complete && old.version !== tgt.version) await rm(blobPath(id, old.version), { force: true }).catch(() => undefined)
      store.cache[id] = { version: tgt.version, size: tgt.size, bytes: tgt.size, complete: true, lastAccess: now(), pinned: old?.pinned ?? true, orphan: false, project: old?.project ?? null, name: old?.name || name }
      delete store.pending[id]
      resetRetry(id)
      persistSoon()
      log?.info(`crm pins: kept ${name} on this PC (${tgt.size} bytes)`)
      await enforceQuota()
    } catch (e) {
      // A network/CRM wobble (also the "offline" case): keep what we have and wait out a growing back-off.
      const n = (tries.get(id) ?? 0) + 1
      tries.set(id, n)
      retryAt.set(id, now() + delay(n - 1))
      log?.warn(`crm pins: ${name} will retry (${(e as Error).message})`)
    } finally {
      if (fh) {
        if (offset > durable) {
          try {
            await fh.datasync()
            durable = offset
          } catch {
            // keep the last count that is surely on the disk
          }
        }
        await fh.close().catch(() => undefined)
      }
      setBytes(id, tgt, durable)
      persistSoon()
    }
  }

  /** Record a download's flushed progress, only while the store still holds that very job. */
  function setBytes(id: string, tgt: Target, bytes: number): void {
    if (tgt.pending) {
      const p = store.pending[id]
      if (p && p.version === tgt.version) p.bytes = bytes
    } else {
      const c = store.cache[id]
      if (c && !c.complete && c.version === tgt.version) c.bytes = bytes
    }
  }

  // ---- quota / eviction ----

  function usedBytes(): number {
    let n = 0
    for (const c of Object.values(store.cache)) n += c.bytes
    for (const p of Object.values(store.pending)) n += p.bytes
    return n
  }

  /** A finished copy nobody pinned (and not kept for "Access removed", not being refreshed): the only thing the quota may evict. */
  const isLeftover = (id: string, c: CacheEntryStored) => !c.pinned && !c.orphan && c.complete && !store.pending[id]

  function leftoverBytes(): number {
    let n = 0
    for (const [id, c] of Object.entries(store.cache)) if (isLeftover(id, c)) n += c.bytes
    return n
  }

  /** Evict unpinned leftovers, least recently used first, until the cache uses at most `limit` bytes (or no leftover is left). */
  async function evictLeftovers(limit: number): Promise<void> {
    let used = usedBytes()
    if (used <= limit) return
    const lru = Object.entries(store.cache)
      .filter(([id, c]) => isLeftover(id, c))
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess)
    for (const [id, c] of lru) {
      if (used <= limit) break
      used -= c.bytes
      await dropCopy(id)
    }
    persistSoon()
  }

  const enforceQuota = () => evictLeftovers(store.settings.quotaMb * MB)

  // ---- reads from disk (offline source for the drive) ----

  function cached(fileId: string, version?: string | null): CachedCopy | null {
    const c = store.cache[fileId]
    if (!c || !c.complete) return null
    if (version != null && c.version !== version) return null
    return { path: blobPath(fileId, c.version), size: c.size, version: c.version }
  }

  async function readCached(fileId: string, version: string | null, offset: number, length: number): Promise<Buffer | null> {
    const hit = cached(fileId, version)
    if (!hit) return null
    const from = Math.max(0, Math.floor(offset))
    if (from >= hit.size || length <= 0) return Buffer.alloc(0)
    const end = Math.min(hit.size, from + length)
    const fh = await open(hit.path, 'r').catch(() => null)
    if (!fh) return null
    try {
      const buf = Buffer.alloc(end - from)
      const { bytesRead } = await fh.read(buf, 0, buf.length, from)
      const c = store.cache[fileId]
      if (c) {
        c.lastAccess = now()
        persistSoon()
      }
      return bytesRead === buf.length ? buf : buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  }

  // ---- settings / status ----

  const settingsView = (): PinSettingsView => ({ quotaMb: store.settings.quotaMb, dir: store.settings.dir, defaultDir: o.dir, dir2: cacheDir() })

  async function setSettings(c: Partial<PinSettings>): Promise<PinSettingsView> {
    requireLoaded()
    if (c.quotaMb !== undefined) {
      if (!whole(c.quotaMb, 0, PIN_QUOTA_MB_MAX)) throw new Error(`The cache limit is a whole number of MB from 0 to ${PIN_QUOTA_MB_MAX}.`)
      store.settings.quotaMb = c.quotaMb
    }
    if (c.dir !== undefined) {
      if (Object.keys(store.cache).length > 0 || Object.keys(store.pending).length > 0) throw new Error('The cache folder can be changed only while nothing is kept on this PC. Unpin everything first.')
      if (c.dir !== null && (!path.isAbsolute(c.dir) || c.dir.length > 240)) throw new Error('The cache folder is a whole path on this PC.')
      store.settings.dir = c.dir
    }
    await persist()
    await enforceQuota()
    void sync().catch(() => undefined) // a higher limit lets waiting files go
    return settingsView()
  }

  function status(): PinStatus {
    const quota = store.settings.quotaMb * MB
    let pinnedFiles = 0
    let pinnedBytes = 0
    let cacheBytes = 0
    let queued = 0
    let waitingRetry = false
    let waitingForSpace = 0
    let heldAfterRemoval = 0
    const t = now()
    for (const c of Object.values(store.cache)) {
      cacheBytes += c.bytes
      if (c.orphan) heldAfterRemoval++
      if (c.pinned) {
        pinnedFiles++
        if (c.complete) pinnedBytes += c.size
      }
    }
    for (const p of Object.values(store.pending)) cacheBytes += p.bytes
    for (const id of new Set([...Object.keys(store.pending), ...Object.keys(store.cache)])) {
      if (!live(id)) continue
      queued++
      if ((retryAt.get(id) ?? 0) > t) waitingRetry = true
      if (spaceWait.has(id)) waitingForSpace++
    }
    return { pinnedFiles, pinnedBytes, cacheBytes, quotaBytes: quota, pinnedOverQuota: pinnedBytes > quota, queued, waitingRetry, waitingForSpace, sizeUnknown, heldAfterRemoval }
  }

  // ---- S6: the "Access removed" lookups Web calls ----

  function pinnedUnder(projectId: string): PinnedUnder[] {
    const want = projectId.replace(/^proj:/, '')
    const out: PinnedUnder[] = []
    for (const [id, c] of Object.entries(store.cache)) {
      if (!c.complete || !(c.orphan || c.pinned)) continue
      if ((c.project ?? '').replace(/^proj:/, '') !== want) continue
      out.push({ id, name: c.name, cachePath: blobPath(id, c.version), size: c.size, version: c.version })
    }
    return out
  }

  async function accessReturned(projectId: string): Promise<number> {
    const want = projectId.replace(/^proj:/, '')
    let n = 0
    for (const c of Object.values(store.cache)) {
      if (c.orphan && (c.project ?? '').replace(/^proj:/, '') === want) {
        c.orphan = false
        n++
      }
    }
    if (n) await persist()
    return n
  }

  async function dropKept(projectId: string): Promise<number> {
    const want = projectId.replace(/^proj:/, '')
    let n = 0
    for (const [id, c] of Object.entries(store.cache)) {
      if (c.orphan && (c.project ?? '').replace(/^proj:/, '') === want) {
        await dropCopy(id)
        n++
      }
    }
    if (n) await persist()
    return n
  }

  async function close(): Promise<void> {
    if (closed) return
    closing = true
    if (timer) clearInterval(timer)
    timer = null
    // Let a download in flight reach a chunk boundary (and record its progress), and a listing finish, but never hang on a stuck network.
    await settle(syncing, CLOSE_WAIT_MS)
    await settle(reconciling, CLOSE_WAIT_MS)
    await persist() // the last word on disk
    closed = true
    await writing.catch(() => undefined)
  }

  async function removeAll(fileId: string): Promise<void> {
    const seen = new Set<string>()
    for (const v of [store.cache[fileId]?.version, store.pending[fileId]?.version]) {
      if (!v || seen.has(v)) continue
      seen.add(v)
      await rm(blobPath(fileId, v), { force: true }).catch(() => undefined)
      await rm(partPath(fileId, v), { force: true }).catch(() => undefined)
    }
  }

  return { start, pin, unpin, isPinned, listPins, reconcile, sync, cached, readCached, settings: settingsView, setSettings, status, pinnedUnder, accessReturned, dropKept, close }
}

async function sizeOnDisk(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch {
    return -1
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Wait for `p` (errors ignored), but at most `ms`; the timer never keeps the process alive. */
async function settle(p: Promise<unknown> | null, ms: number): Promise<void> {
  if (!p) return
  let t: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    p.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>(r => {
      t = setTimeout(r, ms)
      t.unref?.()
    }),
  ])
  if (t) clearTimeout(t)
}

/** A stable version token the hook builds from a CRM file node (its key, modified time, size and version count): it CHANGES when the file changes. */
export function versionToken(parts: { fileKey?: string | null; modifiedAt?: string | null; size?: number | null; versions?: number | null }): string {
  const h = createHash('sha1')
  h.update(`${parts.fileKey ?? ''}|${parts.modifiedAt ?? ''}|${parts.size ?? ''}|${parts.versions ?? ''}`)
  return h.digest('hex').slice(0, 16)
}
