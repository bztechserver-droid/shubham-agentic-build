import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, readdir, readFile, rename, rm, statfs, utimes, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import {
  type DriveBinItem,
  type DriveChange,
  type DriveChangeOp,
  type DriveChanges,
  type DriveCommit,
  type DriveEntry,
  type DriveErrorCode,
  type DriveList,
  type DriveMode,
  type DriveSettings,
  type DriveStatus,
  type DriveUpload,
  type DriveUploadInfo,
  type DriveUploadStart,
  type DriveVersion,
  GOOGLE_SOURCES,
  conflictName,
  nameKey,
  numbered,
  pathProblem,
} from '../../shared/drive.ts'
import { driveType } from './mime.ts'
import type { Logger } from '../log.ts'

// F-097: the Common Drive's store: one folder on the hub that every device shares (agent/agentic/DRIVE-PROTOCOL.md).
//   <root>/files      the pool: what people see
//   <root>/.bin       deleted things, kept binDays
//   <root>/.versions  earlier contents of overwritten files, the last versionsKept of each
//   <root>/.stage     uploads in progress (resumable) and copies being made
//   <root>/.meta      the change journal
// Only node:fs, node:path and node:crypto: nothing here is specific to one operating system. Every path from outside is
// checked name by name (shared/drive.ts), found by walking the real folders (so a name that differs only in case is
// the same one, on Windows and Linux alike) and refused when any part of it is a link.

const GIB = 1024 * 1024 * 1024
const DAY = 24 * 60 * 60 * 1000
export const DEFAULT_LIMIT = 100 * GIB
export const DEFAULT_MIN_FREE = 20 * GIB
export const PIECE_BYTES = 4 * 1024 * 1024
/** The most a whole file in one call may be (PUT /file). */
export const SMALL_FILE_BYTES = 8 * 1024 * 1024
const STAGE_KEEP_MS = DAY
const JOURNAL_KEEP = 10_000
const JOURNAL_KEEP_MS = 7 * DAY

export const DEFAULT_SETTINGS: DriveSettings = { enabled: true, limitBytes: DEFAULT_LIMIT, binDays: 30, versionsKept: 5, webdavEnabled: false, backupEnabled: false }

/** The settings with `patch` applied, or an error naming what is wrong. `used` is what is stored now (the limit may not go under it). */
export function applySettings(cfg: DriveSettings, patch: Partial<DriveSettings>, used: number): DriveSettings {
  const next = { ...cfg }
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true
  if (patch.webdavEnabled !== undefined) next.webdavEnabled = patch.webdavEnabled === true
  if (patch.backupEnabled !== undefined) next.backupEnabled = patch.backupEnabled === true
  if (patch.googleSource !== undefined) {
    if (!GOOGLE_SOURCES.includes(patch.googleSource)) throw driveError(400, 'range', 'The Google account is "company" or "shubhambhole68".')
    next.googleSource = patch.googleSource
  }
  if (patch.limitBytes !== undefined) {
    if (!Number.isFinite(patch.limitBytes) || patch.limitBytes < GIB / 1024) throw driveError(400, 'range', 'The limit is too small.')
    if (patch.limitBytes < used) throw driveError(409, 'quota', 'The limit is lower than what is stored now; delete or purge first.')
    next.limitBytes = Math.floor(patch.limitBytes)
  }
  if (patch.binDays !== undefined) {
    if (!Number.isInteger(patch.binDays) || patch.binDays < 1 || patch.binDays > 3650) throw driveError(400, 'range', 'Bin days: 1 to 3650.')
    next.binDays = patch.binDays
  }
  if (patch.versionsKept !== undefined) {
    if (!Number.isInteger(patch.versionsKept) || patch.versionsKept < 0 || patch.versionsKept > 100) throw driveError(400, 'range', 'Versions kept: 0 to 100.')
    next.versionsKept = patch.versionsKept
  }
  return next
}

export interface DriveError extends Error {
  status: number
  code: DriveErrorCode
}
export function driveError(status: number, code: DriveErrorCode, message: string): DriveError {
  return Object.assign(new Error(message), { status, code })
}

export interface DriveStoreOptions {
  root: string
  limitBytes?: number
  /** The server's disk must keep this much free; a write that would break it is refused. */
  minFreeBytes?: number
  binDays?: number
  versionsKept?: number
  pieceBytes?: number
  /** Who a change is by when the caller doesn't say. */
  device?: string
  now?: () => number
  /** Free bytes on the disk `dir` is on; tests replace it. */
  diskFree?: (dir: string) => Promise<number>
  log?: Logger
}

export interface Ctx {
  by?: string
}

/** The bytes to write: a stream (a request), never a whole big file in memory. */
type Source = Readable | AsyncIterable<Buffer | Uint8Array>

interface UploadMeta {
  id: string
  path: string
  size: number
  mode: DriveMode
  baseEtag?: string
  modified?: number
  by: string
  received: number
  createdAt: number
}

interface BinMeta {
  id: string
  path: string
  name: string
  kind: 'file' | 'dir'
  size: number
  deletedAt: number
  deletedBy: string
}

interface VersionMeta {
  path: string
  size: number
  savedAt: number
  replacedBy: string
}

interface Resolved {
  /** The path as it is stored (the folders' real case; the last part as given when it is new). */
  rel: string
  abs: string
  parentRel: string
  parentAbs: string
  name: string
  exists: boolean
  st: Stats | null
  /** A different name in the same folder that differs only in case, when the last part isn't exactly that. */
  clash: string | null
  parentExists: boolean
}

export interface DriveStore {
  readonly root: string
  readonly pieceBytes: number
  status(): Promise<DriveStatus>
  settings(): DriveSettings
  setSettings(patch: Partial<DriveSettings>): DriveSettings
  list(rel: string, opt?: { cursor?: string; limit?: number }): Promise<DriveList>
  stat(rel: string): Promise<DriveEntry>
  search(q: string, limit?: number): Promise<DriveEntry[]>
  /** The real file behind a path (or one of its versions), for streaming. */
  fileOf(rel: string, version?: string): Promise<{ abs: string; entry: DriveEntry }>
  startUpload(req: DriveUploadStart, ctx?: Ctx): Promise<DriveUpload>
  putPiece(id: string, offset: number, body: Source): Promise<{ received: number }>
  commitUpload(id: string): Promise<DriveCommit>
  uploadInfo(id: string): DriveUploadInfo
  /** Every upload in progress (kept across a restart of the agent), as uploadInfo gives them. */
  listUploads(): DriveUploadInfo[]
  abortUpload(id: string): Promise<void>
  /** A whole small file in one call. */
  putFile(rel: string, body: Source, opt: { mode?: DriveMode; baseEtag?: string; modified?: number; size?: number }, ctx?: Ctx): Promise<DriveCommit>
  mkdir(rel: string, ctx?: Ctx): Promise<DriveEntry>
  move(from: string, to: string, mode: DriveMode | undefined, ctx?: Ctx): Promise<DriveEntry>
  copy(from: string, to: string, mode: DriveMode | undefined, ctx?: Ctx): Promise<DriveEntry>
  remove(rel: string, ctx?: Ctx): Promise<{ binId: string; bytes: number }>
  binList(): Promise<DriveBinItem[]>
  binRestore(id: string, to: string | undefined, ctx?: Ctx): Promise<DriveEntry>
  binPurge(target: { id: string } | { all: true }, ctx?: Ctx): Promise<{ freedBytes: number }>
  versions(rel: string): Promise<DriveVersion[]>
  restoreVersion(rel: string, id: string, ctx?: Ctx): Promise<DriveEntry>
  changes(since: number, opt?: { limit?: number; waitMs?: number; signal?: AbortSignal }): Promise<DriveChanges>
  rev(): number
  onRev(cb: (rev: number) => void): () => void
  /** Deletes what is old (the Bin, abandoned uploads, versions of files long gone) and trims the journal. */
  sweep(): Promise<void>
  /** Counts what is stored again from the folders (the running totals can drift after a crash). */
  recount(): Promise<void>
  close(): Promise<void>
}

const hex = (n: number) => Math.floor(n).toString(16)
const etagOf = (st: Stats) => (st.isDirectory() ? `d-${hex(st.mtimeMs)}` : `${hex(st.size)}-${hex(st.mtimeMs)}`)
const idOf = (now: number) => `${now.toString(36)}-${randomBytes(4).toString('hex')}`
const isId = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9]{6,12}-[a-f0-9]{8}$/.test(s)
const vkey = (rel: string) => createHash('sha1').update(nameKey(rel)).digest('hex').slice(0, 20)
/** `plan.pdf` -> `plan (restored).pdf`, then `plan (restored 2).pdf`. */
const restoredName = (name: string, n: number) => {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  return `${stem} (restored${n > 2 ? ` ${n - 1}` : ''})${dot > 0 ? name.slice(dot) : ''}`
}
const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const cleanBy = (s: string) => [...s].filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join('').trim().slice(0, 40)

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Writes beside the file and renames over it, so a reader never sees half of it. */
async function writeJson(file: string, value: unknown) {
  const tmp = `${file}.${randomBytes(3).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, file)
}

export async function createDriveStore(o: DriveStoreOptions): Promise<DriveStore> {
  const now = o.now ?? Date.now
  const root = path.resolve(o.root)
  const filesDir = path.join(root, 'files')
  const binDir = path.join(root, '.bin')
  const versionsDir = path.join(root, '.versions')
  const stageDir = path.join(root, '.stage')
  const metaDir = path.join(root, '.meta')
  const diskFree =
    o.diskFree ??
    (async (dir: string) => {
      const s = await statfs(dir)
      return Number(s.bavail) * Number(s.bsize)
    })
  const device = o.device ?? 'this PC'
  const pieceBytes = o.pieceBytes ?? PIECE_BYTES
  let cfg: DriveSettings = { ...DEFAULT_SETTINGS, limitBytes: o.limitBytes ?? DEFAULT_LIMIT, binDays: o.binDays ?? 30, versionsKept: o.versionsKept ?? 5 }
  const minFree = o.minFreeBytes ?? DEFAULT_MIN_FREE
  for (const d of [filesDir, binDir, versionsDir, stageDir, metaDir]) await mkdir(d, { recursive: true })

  // ---- one writer at a time -----------------------------------------------------------------------------------------
  let chain: Promise<unknown> = Promise.resolve()
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = chain.then(fn)
    chain = r.catch(() => undefined)
    return r
  }

  // ---- what is stored, counted ---------------------------------------------------------------------------------------
  const usage = { files: 0, bin: 0, versions: 0 }
  const usageFile = path.join(metaDir, 'usage.json')
  let usageTimer: NodeJS.Timeout | undefined
  const saveUsage = () => {
    usageTimer ??= setTimeout(() => {
      usageTimer = undefined
      void writeJson(usageFile, usage).catch(() => undefined)
    }, 500)
    usageTimer.unref()
  }
  async function sizeOf(abs: string): Promise<number> {
    let st: Stats
    try {
      st = await lstat(abs)
    } catch {
      return 0
    }
    if (st.isSymbolicLink()) return 0
    if (!st.isDirectory()) return st.size
    let n = 0
    for (const e of await readdir(abs).catch(() => [] as string[])) n += await sizeOf(path.join(abs, e))
    return n
  }
  async function recount() {
    usage.files = await sizeOf(filesDir)
    usage.bin = 0
    for (const id of await readdir(binDir).catch(() => [] as string[])) usage.bin += await sizeOf(path.join(binDir, id, 'item'))
    usage.versions = 0
    for (const d of await readdir(versionsDir).catch(() => [] as string[])) {
      for (const f of await readdir(path.join(versionsDir, d)).catch(() => [] as string[])) {
        if (!f.endsWith('.json')) usage.versions += await sizeOf(path.join(versionsDir, d, f))
      }
    }
    saveUsage()
  }
  const saved = await readJson<typeof usage>(usageFile)
  if (saved && [saved.files, saved.bin, saved.versions].every(n => Number.isFinite(n) && n >= 0)) Object.assign(usage, saved)
  else await recount()
  const used = () => usage.files + usage.bin + usage.versions

  // ---- uploads in progress -------------------------------------------------------------------------------------------
  const uploads = new Map<string, UploadMeta>()
  const metaOfUpload = (id: string) => path.join(stageDir, `${id}.json`)
  const dataOfUpload = (id: string) => path.join(stageDir, id)
  for (const f of await readdir(stageDir).catch(() => [] as string[])) {
    if (!f.endsWith('.json')) continue
    const m = await readJson<UploadMeta>(path.join(stageDir, f))
    if (m && isId(m.id)) uploads.set(m.id, m)
  }
  const reserved = (except?: string) => {
    let n = 0
    for (const u of uploads.values()) if (u.id !== except) n += u.size
    return n
  }

  // ---- the journal of changes ----------------------------------------------------------------------------------------
  const journalFile = path.join(metaDir, 'changes.jsonl')
  let journal: DriveChange[] = []
  try {
    for (const line of (await readFile(journalFile, 'utf8')).split('\n')) {
      if (!line.trim()) continue
      try {
        journal.push(JSON.parse(line) as DriveChange)
      } catch {
        // A line torn by a crash: skipped.
      }
    }
  } catch {
    // None yet.
  }
  let revNow = Math.max(0, ...journal.map(c => c.rev), (await readJson<{ rev: number }>(path.join(metaDir, 'rev')))?.rev ?? 0)
  const watchers = new Set<(rev: number) => void>()
  async function record(op: DriveChangeOp, p: string, by: string, extra: { from?: string; entry?: DriveEntry } = {}) {
    const c: DriveChange = { rev: ++revNow, op, path: p, ...extra, by, at: now() }
    journal.push(c)
    await appendFile(journalFile, `${JSON.stringify(c)}\n`).catch(() => undefined)
    for (const w of [...watchers]) w(revNow)
  }
  async function trimJournal() {
    const t = now()
    const keep = journal.filter(c => c.rev > revNow - JOURNAL_KEEP && (t - c.at <= JOURNAL_KEEP_MS || c.rev > revNow - 100))
    if (keep.length === journal.length) return
    await writeJson(path.join(metaDir, 'rev'), { rev: revNow })
    journal = keep
    await writeFile(journalFile, keep.map(c => `${JSON.stringify(c)}\n`).join(''))
  }

  // ---- finding a path ------------------------------------------------------------------------------------------------
  /** Walks the real folders: names are matched without regard to case, and a link anywhere on the way is refused. */
  async function resolve(input: string): Promise<Resolved> {
    const rel0 = input.normalize('NFC')
    const why = pathProblem(rel0)
    if (why) throw driveError(400, 'badname', why)
    const parts = rel0 === '' ? [] : rel0.split('/')
    let abs = filesDir
    const canon: string[] = []
    let alive = true
    let exists = parts.length === 0
    let st: Stats | null = parts.length === 0 ? await lstat(filesDir) : null
    let clash: string | null = null
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1
      const part = parts[i]
      if (!alive) {
        canon.push(part)
        abs = path.join(abs, part)
        continue
      }
      let names: string[]
      try {
        names = await readdir(abs)
      } catch {
        throw driveError(404, 'notfound', `There is no folder ${canon.join('/') || '(the top)'}.`)
      }
      const found = names.find(n => nameKey(n) === nameKey(part))
      if (found === undefined) {
        alive = false
        exists = false
        canon.push(part)
        abs = path.join(abs, part)
        continue
      }
      const f = path.join(abs, found)
      const s = await lstat(f)
      if (s.isSymbolicLink()) throw driveError(400, 'badname', 'Links are not allowed in the Common Drive.')
      if (!last && !s.isDirectory()) throw driveError(404, 'notfound', `${[...canon, found].join('/')} is a file, not a folder.`)
      if (last) {
        exists = true
        st = s
        if (found !== part) clash = found
      }
      canon.push(found)
      abs = f
    }
    const name = canon[canon.length - 1] ?? ''
    const parentRel = canon.slice(0, -1).join('/')
    return {
      rel: canon.join('/'),
      abs,
      parentRel,
      parentAbs: path.join(filesDir, ...canon.slice(0, -1)),
      name,
      exists,
      st,
      clash,
      parentExists: parts.length <= 1 || alive || exists,
    }
  }

  const entryOf = (rel: string, st: Stats): DriveEntry => {
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    const dir = st.isDirectory()
    return { name, path: rel, kind: dir ? 'dir' : 'file', size: dir ? 0 : st.size, mtime: Math.floor(st.mtimeMs), etag: etagOf(st), ...(dir ? {} : { mime: driveType(name).type.split(';')[0] }) }
  }
  const existing = async (rel: string): Promise<{ r: Resolved; st: Stats }> => {
    const r = await resolve(rel)
    if (!r.exists || !r.st) throw driveError(404, 'notfound', `There is nothing at ${rel || 'that path'}.`)
    return { r, st: r.st }
  }
  /** The folders on the way to a new item, made. A name that is only a different case of an existing one is refused. */
  async function ensureParent(r: Resolved) {
    if (r.clash) throw driveError(409, 'case', `${r.clash} is already here; names that differ only in case are the same name.`)
    if (!r.parentExists) await mkdir(r.parentAbs, { recursive: true })
  }
  const need = async (bytes: number, except?: string) => {
    if (used() + reserved(except) + bytes > cfg.limitBytes) {
      throw driveError(507, 'quota', `The Common Drive is full (${Math.round(cfg.limitBytes / GIB)} GB).`)
    }
    if ((await diskFree(root)) - bytes < minFree) throw driveError(507, 'quota', "The server's disk is nearly full, so nothing more is stored.")
  }

  // ---- versions ------------------------------------------------------------------------------------------------------
  async function addVersion(oldAbs: string, rel: string, size: number, by: string) {
    const dir = path.join(versionsDir, vkey(rel))
    await mkdir(dir, { recursive: true })
    const id = idOf(now())
    const target = path.join(dir, id)
    // A hard link keeps the old content alive while the new file is renamed over it: one atomic step. Where links aren't possible, a copy.
    try {
      await link(oldAbs, target)
    } catch {
      await copyFile(oldAbs, target)
    }
    await writeJson(path.join(dir, `${id}.json`), { path: rel, size, savedAt: now(), replacedBy: by } satisfies VersionMeta)
    usage.versions += size
    return dir
  }
  async function listVersions(rel: string): Promise<(VersionMeta & { id: string })[]> {
    const dir = path.join(versionsDir, vkey(rel))
    const out: (VersionMeta & { id: string })[] = []
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!f.endsWith('.json')) continue
      const m = await readJson<VersionMeta>(path.join(dir, f))
      const id = f.slice(0, -5)
      if (m && isId(id)) out.push({ ...m, id })
    }
    return out.sort((a, b) => b.savedAt - a.savedAt)
  }
  async function pruneVersions(rel: string) {
    const all = await listVersions(rel)
    const dir = path.join(versionsDir, vkey(rel))
    for (const v of all.slice(Math.max(0, cfg.versionsKept))) {
      await rm(path.join(dir, v.id), { force: true })
      await rm(path.join(dir, `${v.id}.json`), { force: true })
      usage.versions = Math.max(0, usage.versions - v.size)
    }
  }
  /** A moved file takes its versions with it. */
  async function moveVersions(fromRel: string, toRel: string) {
    const from = path.join(versionsDir, vkey(fromRel))
    const to = path.join(versionsDir, vkey(toRel))
    if (from === to) return
    try {
      await lstat(from)
    } catch {
      return
    }
    try {
      await lstat(to)
    } catch {
      await rename(from, to).catch(() => undefined)
      return
    }
    for (const f of await readdir(from).catch(() => [] as string[])) await rename(path.join(from, f), path.join(to, f)).catch(() => undefined)
    await rm(from, { recursive: true, force: true })
  }

  // ---- putting a staged file in place --------------------------------------------------------------------------------
  interface Place {
    stage: string
    size: number
    rel: string
    mode: DriveMode
    baseEtag?: string
    modified?: number
    by: string
    except?: string
    /** Journal op; 'put' normally. */
    op?: DriveChangeOp
  }
  async function free(r: Resolved, make: (n: number) => string): Promise<Resolved> {
    for (let n = 2; n < 1000; n++) {
      const rel = joinRel(r.parentRel, make(n))
      const c = await resolve(rel)
      if (!c.exists && !c.clash) return c
    }
    throw driveError(409, 'exists', 'Too many files with that name.')
  }
  async function place(p: Place): Promise<DriveCommit> {
    let r = await resolve(p.rel)
    if (r.clash) throw driveError(409, 'case', `${r.clash} is already here; names that differ only in case are the same name.`)
    if (r.exists && r.st?.isDirectory()) throw driveError(409, 'exists', `${r.rel} is a folder.`)
    let conflict: { copyOf: string } | undefined
    let replace = false
    if (r.exists && r.st) {
      if (p.mode === 'create') throw driveError(409, 'exists', `${r.rel} already exists.`)
      if (p.mode === 'overwrite') replace = true
      else if (p.mode === 'keepboth') r = await free(r, n => numbered(r.name, n))
      else if (p.baseEtag !== undefined && p.baseEtag === etagOf(r.st)) replace = true
      else {
        conflict = { copyOf: r.rel }
        const base = r
        const made = conflictName(base.name, p.by, new Date(now()))
        // The same minute twice: a numbered one, never the first copy over.
        r = await free(base, n => (n === 2 ? made : numbered(made, n)))
      }
    }
    await need(p.size, p.except)
    await ensureParent(r)
    const when = p.modified !== undefined && Number.isFinite(p.modified) ? p.modified : now()
    let oldEtag: string | undefined
    let oldSize = 0
    if (replace && r.st) {
      oldEtag = etagOf(r.st)
      oldSize = r.st.size
      // An empty file holds nothing to keep (Windows makes every new file empty first, then fills it): no version of it, or each copy-in would waste one of the few kept.
      if (oldSize > 0) await addVersion(r.abs, r.rel, oldSize, p.by)
    }
    await utimes(p.stage, when / 1000, when / 1000)
    if (oldEtag !== undefined && oldEtag === etagOf(await lstat(p.stage))) await utimes(p.stage, (when + 1) / 1000, (when + 1) / 1000)
    try {
      await rename(p.stage, r.abs)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (replace) await pruneVersions(r.rel)
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw driveError(409, 'busy', `${r.rel} is in use by a program; try again in a moment.`)
      throw e
    }
    usage.files += p.size - oldSize
    if (replace) await pruneVersions(r.rel)
    saveUsage()
    const entry = entryOf(r.rel, await lstat(r.abs))
    await record(p.op ?? 'put', r.rel, p.by, { entry })
    return conflict ? { entry, conflict } : { entry }
  }

  // ---- the store ------------------------------------------------------------------------------------------------------
  const store: DriveStore = {
    root,
    pieceBytes,
    settings: () => ({ ...cfg }),
    setSettings(patch) {
      cfg = applySettings(cfg, patch, used())
      return { ...cfg }
    },

    async status() {
      return {
        enabled: cfg.enabled,
        root,
        limitBytes: cfg.limitBytes,
        usedBytes: used(),
        binBytes: usage.bin,
        versionsBytes: usage.versions,
        diskFreeBytes: await diskFree(root).catch(() => 0),
        rev: revNow,
        pieceBytes,
        binDays: cfg.binDays,
        versionsKept: cfg.versionsKept,
        webdav: { enabled: cfg.webdavEnabled },
        backup: { state: 'off' },
        now: now(),
      }
    },

    async list(rel, opt = {}) {
      const { r, st } = await existing(rel)
      if (!st.isDirectory()) throw driveError(404, 'notfound', `${r.rel} is a file, not a folder.`)
      const limit = Math.min(2000, Math.max(1, Math.floor(opt.limit ?? 500)))
      const items: { key: string; entry: DriveEntry }[] = []
      for (const n of await readdir(r.abs)) {
        let s: Stats
        try {
          s = await lstat(path.join(r.abs, n))
        } catch {
          continue
        }
        if (s.isSymbolicLink()) continue
        items.push({ key: `${s.isDirectory() ? '0' : '1'}${nameKey(n)}`, entry: entryOf(joinRel(r.rel, n), s) })
      }
      items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      const after = opt.cursor ? Buffer.from(opt.cursor, 'base64url').toString('utf8') : null
      const rest = after === null ? items : items.filter(i => i.key > after)
      const page = rest.slice(0, limit)
      const next = rest.length > limit ? Buffer.from(page[page.length - 1].key).toString('base64url') : undefined
      return { path: r.rel, entries: page.map(i => i.entry), ...(next ? { next } : {}) }
    },

    async stat(rel) {
      const { r, st } = await existing(rel)
      return entryOf(r.rel, st)
    },

    async search(q, limit = 200) {
      const key = nameKey(q.trim())
      const out: DriveEntry[] = []
      if (!key) return out
      const walk = async (dirAbs: string, dirRel: string) => {
        for (const n of await readdir(dirAbs).catch(() => [] as string[])) {
          if (out.length >= limit) return
          const abs = path.join(dirAbs, n)
          const s = await lstat(abs).catch(() => null)
          if (!s || s.isSymbolicLink()) continue
          const rel = joinRel(dirRel, n)
          if (nameKey(n).includes(key)) out.push(entryOf(rel, s))
          if (s.isDirectory()) await walk(abs, rel)
        }
      }
      await walk(filesDir, '')
      return out
    },

    async fileOf(rel, version) {
      const { r, st } = await existing(rel)
      if (st.isDirectory()) throw driveError(404, 'notfound', `${r.rel} is a folder.`)
      if (version === undefined) return { abs: r.abs, entry: entryOf(r.rel, st) }
      if (!isId(version)) throw driveError(404, 'notfound', 'There is no such version.')
      const abs = path.join(versionsDir, vkey(r.rel), version)
      const meta = await readJson<VersionMeta>(`${abs}.json`)
      const s = await lstat(abs).catch(() => null)
      if (!meta || !s) throw driveError(404, 'notfound', 'There is no such version.')
      return { abs, entry: { ...entryOf(r.rel, s), mtime: meta.savedAt } }
    },

    async startUpload(req, ctx = {}) {
      return locked(async () => {
        const size = req.size
        if (!Number.isSafeInteger(size) || size < 0) throw driveError(400, 'range', 'The size is not a number.')
        const mode: DriveMode = req.mode ?? 'create'
        if (!['create', 'overwrite', 'keepboth', 'ifmatch'].includes(mode)) throw driveError(400, 'range', 'Unknown mode.')
        if (mode === 'ifmatch' && typeof req.baseEtag !== 'string') throw driveError(400, 'range', 'ifmatch needs baseEtag.')
        const r = await resolve(req.path)
        if (!r.name) throw driveError(400, 'badname', 'A file needs a name.')
        if (r.clash) throw driveError(409, 'case', `${r.clash} is already here; names that differ only in case are the same name.`)
        if (r.exists && r.st?.isDirectory()) throw driveError(409, 'exists', `${r.rel} is a folder.`)
        if (r.exists && mode === 'create') throw driveError(409, 'exists', `${r.rel} already exists.`)
        await need(size)
        const id = idOf(now())
        const m: UploadMeta = { id, path: r.rel, size, mode, baseEtag: req.baseEtag, modified: req.modified, by: cleanBy(ctx.by ?? '') || device, received: 0, createdAt: now() }
        await writeFile(dataOfUpload(id), '')
        await writeJson(metaOfUpload(id), m)
        uploads.set(id, m)
        return { id, pieceBytes, received: 0 }
      })
    },

    async putPiece(id, offset, body) {
      const m = uploads.get(id)
      if (!m) throw driveError(404, 'notfound', 'There is no such upload (it may have been finished or dropped).')
      if (offset !== m.received) throw Object.assign(driveError(409, 'offset', `Expected the next piece at ${m.received}.`), { received: m.received })
      const fh = await open(dataOfUpload(id), 'r+')
      let pos = offset
      try {
        for await (const chunk of body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          if (pos - offset + buf.length > pieceBytes) throw driveError(413, 'range', `A piece is at most ${pieceBytes} bytes.`)
          if (pos + buf.length > m.size) throw driveError(400, 'range', 'More bytes than the size announced.')
          await fh.write(buf, 0, buf.length, pos)
          pos += buf.length
        }
        await fh.sync()
      } finally {
        await fh.close()
      }
      m.received = pos
      await writeJson(metaOfUpload(id), m)
      return { received: pos }
    },

    listUploads: () => [...uploads.values()].map(m => ({ id: m.id, path: m.path, size: m.size, received: m.received })),

    uploadInfo(id) {
      const m = uploads.get(id)
      if (!m) throw driveError(404, 'notfound', 'There is no such upload (it may have been finished or dropped).')
      return { id, path: m.path, size: m.size, received: m.received }
    },

    async abortUpload(id) {
      const m = uploads.get(id)
      if (!m) return
      uploads.delete(id)
      await rm(dataOfUpload(id), { force: true })
      await rm(metaOfUpload(id), { force: true })
    },

    async commitUpload(id) {
      const m = uploads.get(id)
      if (!m) throw driveError(404, 'notfound', 'There is no such upload (it may have been finished or dropped).')
      if (m.received !== m.size) throw Object.assign(driveError(409, 'offset', `Only ${m.received} of ${m.size} bytes have arrived.`), { received: m.received })
      return locked(async () => {
        const res = await place({ stage: dataOfUpload(id), size: m.size, rel: m.path, mode: m.mode, baseEtag: m.baseEtag, modified: m.modified, by: m.by, except: id })
        uploads.delete(id)
        await rm(metaOfUpload(id), { force: true })
        return res
      })
    },

    async putFile(rel, body, opt, ctx = {}) {
      const mode = opt.mode ?? 'create'
      const probe = await resolve(rel)
      if (!probe.name) throw driveError(400, 'badname', 'A file needs a name.')
      if (opt.size !== undefined && opt.size > SMALL_FILE_BYTES) throw driveError(413, 'range', `Use the upload calls for files over ${SMALL_FILE_BYTES} bytes.`)
      // Read the body into a staging file with a size cap, then start/commit the same way a piece upload does.
      const tmp = idOf(now())
      const fh = await open(dataOfUpload(tmp), 'w')
      let size = 0
      try {
        for await (const chunk of body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buf.length
          if (size > SMALL_FILE_BYTES) throw driveError(413, 'range', `Use the upload calls for files over ${SMALL_FILE_BYTES} bytes.`)
          await fh.write(buf)
        }
        await fh.sync()
      } catch (e) {
        await fh.close()
        await rm(dataOfUpload(tmp), { force: true })
        throw e
      }
      await fh.close()
      try {
        return await locked(() => place({ stage: dataOfUpload(tmp), size, rel, mode, baseEtag: opt.baseEtag, modified: opt.modified, by: cleanBy(ctx.by ?? '') || device }))
      } catch (e) {
        await rm(dataOfUpload(tmp), { force: true })
        throw e
      }
    },

    mkdir(rel, ctx = {}) {
      return locked(async () => {
        const r = await resolve(rel)
        if (!r.name) throw driveError(400, 'badname', 'A folder needs a name.')
        if (r.exists && r.st) {
          if (r.clash) throw driveError(409, 'case', `${r.clash} is already here; names that differ only in case are the same name.`)
          if (!r.st.isDirectory()) throw driveError(409, 'exists', `${r.rel} is a file.`)
          return entryOf(r.rel, r.st)
        }
        await ensureParent(r)
        await mkdir(r.abs)
        const entry = entryOf(r.rel, await lstat(r.abs))
        await record('mkdir', r.rel, cleanBy(ctx.by ?? '') || device, { entry })
        return entry
      })
    },

    move(from, to, mode, ctx = {}) {
      return locked(async () => {
        const by = cleanBy(ctx.by ?? '') || device
        const { r: src, st } = await existing(from)
        if (!src.name) throw driveError(400, 'badname', 'The top folder cannot be moved.')
        let dst = await resolve(to)
        if (!dst.name) throw driveError(400, 'badname', 'Move it to a name.')
        if (st.isDirectory() && (dst.rel === src.rel || nameKey(dst.rel).startsWith(`${nameKey(src.rel)}/`))) throw driveError(400, 'badname', 'A folder cannot go inside itself.')
        const same = dst.exists && dst.abs.toLowerCase() === src.abs.toLowerCase() && nameKey(dst.rel) === nameKey(src.rel)
        let replace = false
        if (same) {
          // Only the case of the name changes: the new name is the one asked for, not the one already stored.
          const asked = to.normalize('NFC').split('/').pop() ?? dst.name
          dst = { ...dst, name: asked, rel: joinRel(dst.parentRel, asked), abs: path.join(dst.parentAbs, asked) }
        } else {
          if (dst.clash) throw driveError(409, 'case', `${dst.clash} is already here; names that differ only in case are the same name.`)
          if (dst.exists) {
            const m = mode ?? 'create'
            if (m === 'keepboth') dst = await free(dst, n => numbered(dst.name, n))
            else if (m === 'overwrite' && !st.isDirectory() && !dst.st?.isDirectory()) replace = true
            else throw driveError(409, 'exists', `${dst.rel} already exists.`)
          }
          await ensureParent(dst)
        }
        let overwritten = 0
        if (replace && dst.st) {
          overwritten = dst.st.size
          await addVersion(dst.abs, dst.rel, overwritten, by)
        }
        try {
          await rename(src.abs, dst.abs)
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code
          if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw driveError(409, 'busy', `${src.rel} is in use by a program; try again in a moment.`)
          throw e
        }
        usage.files -= overwritten
        if (!st.isDirectory()) await moveVersions(src.rel, dst.rel)
        if (replace) await pruneVersions(dst.rel)
        saveUsage()
        const entry = entryOf(dst.rel, await lstat(dst.abs))
        await record('move', dst.rel, by, { from: src.rel, entry })
        return entry
      })
    },

    copy(from, to, mode, ctx = {}) {
      return locked(async () => {
        const by = cleanBy(ctx.by ?? '') || device
        const { r: src, st } = await existing(from)
        if (!src.name) throw driveError(400, 'badname', 'The top folder cannot be copied.')
        let dst = await resolve(to)
        if (!dst.name) throw driveError(400, 'badname', 'Copy it to a name.')
        if (st.isDirectory() && nameKey(dst.rel).startsWith(`${nameKey(src.rel)}/`)) throw driveError(400, 'badname', 'A folder cannot be copied into itself.')
        if (!st.isDirectory()) {
          // A file: copy to the staging area, then place it like any upload (so Bin-less overwrite keeps a version, quota and names are checked once).
          const tmp = idOf(now())
          await need(st.size)
          await copyFile(src.abs, dataOfUpload(tmp), constants.COPYFILE_EXCL)
          try {
            const res = await place({ stage: dataOfUpload(tmp), size: st.size, rel: dst.rel, mode: mode ?? 'create', modified: st.mtimeMs, by })
            return res.entry
          } catch (e) {
            await rm(dataOfUpload(tmp), { force: true })
            throw e
          }
        }
        if (dst.clash) throw driveError(409, 'case', `${dst.clash} is already here; names that differ only in case are the same name.`)
        if (dst.exists) {
          if ((mode ?? 'create') === 'keepboth') dst = await free(dst, n => numbered(dst.name, n))
          else throw driveError(409, 'exists', `${dst.rel} already exists.`)
        }
        const total = await sizeOf(src.abs)
        await need(total)
        await ensureParent(dst)
        const copyTree = async (fromAbs: string, toAbs: string) => {
          await mkdir(toAbs)
          for (const n of await readdir(fromAbs)) {
            const a = path.join(fromAbs, n)
            const s = await lstat(a)
            if (s.isSymbolicLink()) continue
            const b = path.join(toAbs, n)
            if (s.isDirectory()) await copyTree(a, b)
            else {
              await copyFile(a, b, constants.COPYFILE_EXCL)
              await utimes(b, s.atimeMs / 1000, s.mtimeMs / 1000)
            }
          }
        }
        await copyTree(src.abs, dst.abs)
        usage.files += total
        saveUsage()
        const entry = entryOf(dst.rel, await lstat(dst.abs))
        await record('mkdir', dst.rel, by, { entry })
        return entry
      })
    },

    remove(rel, ctx = {}) {
      return locked(async () => {
        const by = cleanBy(ctx.by ?? '') || device
        const { r, st } = await existing(rel)
        if (!r.name) throw driveError(400, 'badname', 'The top folder cannot be deleted.')
        const size = st.isDirectory() ? await sizeOf(r.abs) : st.size
        const id = idOf(now())
        const dir = path.join(binDir, id)
        await mkdir(dir)
        try {
          await rename(r.abs, path.join(dir, 'item'))
        } catch (e) {
          await rm(dir, { recursive: true, force: true })
          const code = (e as NodeJS.ErrnoException).code
          if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw driveError(409, 'busy', `${r.rel} is in use by a program; try again in a moment.`)
          throw e
        }
        const meta: BinMeta = { id, path: r.rel, name: r.name, kind: st.isDirectory() ? 'dir' : 'file', size, deletedAt: now(), deletedBy: by }
        await writeJson(path.join(dir, 'meta.json'), meta)
        usage.files -= size
        usage.bin += size
        saveUsage()
        await record('delete', r.rel, by)
        return { binId: id, bytes: size }
      })
    },

    async binList() {
      const out: DriveBinItem[] = []
      for (const id of await readdir(binDir).catch(() => [] as string[])) {
        const m = await readJson<BinMeta>(path.join(binDir, id, 'meta.json'))
        if (m && m.id === id) out.push({ id, name: m.name, path: m.path, kind: m.kind, size: m.size, deletedAt: m.deletedAt, deletedBy: m.deletedBy, expiresAt: m.deletedAt + cfg.binDays * DAY })
      }
      return out.sort((a, b) => b.deletedAt - a.deletedAt)
    },

    binRestore(id, to, ctx = {}) {
      return locked(async () => {
        const by = cleanBy(ctx.by ?? '') || device
        if (!isId(id)) throw driveError(404, 'notfound', 'There is nothing in the Bin with that id.')
        const dir = path.join(binDir, id)
        const m = await readJson<BinMeta>(path.join(dir, 'meta.json'))
        if (!m) throw driveError(404, 'notfound', 'There is nothing in the Bin with that id.')
        let dst = await resolve(to ?? m.path)
        if (!dst.name) throw driveError(400, 'badname', 'Restore it to a name.')
        if (dst.exists || dst.clash) {
          const base = dst
          dst = await free(base, n => restoredName(base.name, n))
        }
        await ensureParent(dst)
        await rename(path.join(dir, 'item'), dst.abs)
        await rm(dir, { recursive: true, force: true })
        usage.bin -= m.size
        usage.files += m.size
        saveUsage()
        const entry = entryOf(dst.rel, await lstat(dst.abs))
        await record('restore', dst.rel, by, { entry })
        return entry
      })
    },

    binPurge(target, ctx = {}) {
      return locked(async () => {
        const by = cleanBy(ctx.by ?? '') || device
        const ids = 'all' in target ? await readdir(binDir).catch(() => [] as string[]) : [target.id]
        let freed = 0
        for (const id of ids) {
          if (!isId(id)) continue
          const dir = path.join(binDir, id)
          const m = await readJson<BinMeta>(path.join(dir, 'meta.json'))
          if (!m) {
            if ('id' in target) throw driveError(404, 'notfound', 'There is nothing in the Bin with that id.')
            continue
          }
          await rm(dir, { recursive: true, force: true })
          freed += m.size
          usage.bin = Math.max(0, usage.bin - m.size)
          await record('purge', m.path, by)
        }
        saveUsage()
        return { freedBytes: freed }
      })
    },

    async versions(rel) {
      const { r, st } = await existing(rel)
      if (st.isDirectory()) return []
      return (await listVersions(r.rel)).map(v => ({ id: v.id, size: v.size, savedAt: v.savedAt, replacedBy: v.replacedBy }))
    },

    restoreVersion(rel, id, ctx = {}) {
      return locked(async () => {
        const by = cleanBy(ctx.by ?? '') || device
        const { r, st } = await existing(rel)
        if (st.isDirectory() || !isId(id)) throw driveError(404, 'notfound', 'There is no such version.')
        const abs = path.join(versionsDir, vkey(r.rel), id)
        const meta = await readJson<VersionMeta>(`${abs}.json`)
        const vs = await lstat(abs).catch(() => null)
        if (!meta || !vs) throw driveError(404, 'notfound', 'There is no such version.')
        const tmp = idOf(now())
        await need(vs.size)
        await copyFile(abs, dataOfUpload(tmp), constants.COPYFILE_EXCL)
        try {
          const res = await place({ stage: dataOfUpload(tmp), size: vs.size, rel: r.rel, mode: 'overwrite', modified: meta.savedAt, by })
          return res.entry
        } catch (e) {
          await rm(dataOfUpload(tmp), { force: true })
          throw e
        }
      })
    },

    rev: () => revNow,

    onRev(cb) {
      watchers.add(cb)
      return () => void watchers.delete(cb)
    },

    async changes(since, opt = {}) {
      const limit = Math.min(2000, Math.max(1, Math.floor(opt.limit ?? 500)))
      const read = (): DriveChanges => {
        if (since >= revNow) return { rev: revNow, changes: [] }
        const first = journal[0]?.rev ?? revNow + 1
        if (since + 1 < first) return { rev: revNow, changes: [], reset: true }
        return { rev: revNow, changes: journal.filter(c => c.rev > since).slice(0, limit) }
      }
      const now0 = read()
      const wait = Math.min(60_000, Math.max(0, opt.waitMs ?? 0))
      if (now0.changes.length || now0.reset || !wait) return now0
      return new Promise<DriveChanges>(resolveWait => {
        const done = () => {
          clearTimeout(timer)
          off()
          opt.signal?.removeEventListener('abort', done)
          resolveWait(read())
        }
        const off = store.onRev(done)
        const timer = setTimeout(done, wait)
        timer.unref()
        opt.signal?.addEventListener('abort', done)
      })
    },

    sweep() {
      return locked(async () => {
        const t = now()
        for (const id of await readdir(binDir).catch(() => [] as string[])) {
          const m = await readJson<BinMeta>(path.join(binDir, id, 'meta.json'))
          if (!m) {
            // Half-made (a crash between the move and its note): older than a day, it goes back to the files' side as it is.
            continue
          }
          if (t - m.deletedAt > cfg.binDays * DAY) {
            await rm(path.join(binDir, id), { recursive: true, force: true })
            usage.bin = Math.max(0, usage.bin - m.size)
            await record('purge', m.path, 'sweep')
          }
        }
        const expired = new Set<string>()
        for (const u of uploads.values()) if (t - u.createdAt > STAGE_KEEP_MS) expired.add(u.id)
        for (const id of expired) uploads.delete(id)
        for (const f of await readdir(stageDir).catch(() => [] as string[])) {
          const id = f.endsWith('.json') ? f.slice(0, -5) : f
          // An expired upload's files, and files no upload owns (a copy a crash left) once they are a day old.
          const orphan = !uploads.has(id) && !expired.has(id) && t - ((await lstat(path.join(stageDir, f)).catch(() => null))?.mtimeMs ?? t) > STAGE_KEEP_MS
          if (expired.has(id) || orphan) await rm(path.join(stageDir, f), { force: true })
        }
        for (const d of await readdir(versionsDir).catch(() => [] as string[])) {
          const metas = (await readdir(path.join(versionsDir, d)).catch(() => [] as string[])).filter(f => f.endsWith('.json'))
          let newest = 0
          let rel: string | null = null
          for (const f of metas) {
            const m = await readJson<VersionMeta>(path.join(versionsDir, d, f))
            if (m) {
              newest = Math.max(newest, m.savedAt)
              rel = m.path
            }
          }
          const alive = rel === null ? false : (await resolve(rel).catch(() => null))?.exists === true
          if (!alive && t - newest > cfg.binDays * DAY) {
            usage.versions = Math.max(0, usage.versions - (await sizeOf(path.join(versionsDir, d))))
            await rm(path.join(versionsDir, d), { recursive: true, force: true })
          }
        }
        await trimJournal()
        saveUsage()
      })
    },

    recount,

    async close() {
      if (usageTimer) clearTimeout(usageTimer)
      await writeJson(usageFile, usage).catch(() => undefined)
      await writeJson(path.join(metaDir, 'rev'), { rev: revNow }).catch(() => undefined)
    },
  }
  return store
}
