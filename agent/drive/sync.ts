import { randomBytes } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type DriveChanges, type DriveCommit, type DriveEntry, type DriveList, nameKey, pathProblem } from '../../shared/drive.ts'
import type { Logger } from '../log.ts'
import { plan, type Action, type BaseEntry, type LocalEntry, type PlanOptions, type RemoteEntry } from './sync-plan.ts'

// F-097 part C: keeps a real folder in step with the Common Drive, both ways. Plain Node, no native parts, the same on Windows and Linux.
// It never talks to the pool directly: a SyncRemote does (the store itself on the hub, HTTP over the tailnet from another PC, the member link
// from the laptop). The decisions are in sync-plan.ts; this file finds out what changed on each side, carries the decisions out, and
// remembers what both sides agreed on (the "base") so the next round can tell a change from a copy.

export interface SyncRemote {
  /** The pool's change number now. */
  rev(): Promise<number>
  changes(since: number, waitMs: number, signal?: AbortSignal): Promise<DriveChanges>
  list(path: string, cursor?: string): Promise<DriveList>
  /** null when there is nothing at that path. */
  stat(path: string): Promise<DriveEntry | null>
  /** Writes the file's bytes to `dest` (a local temp file) and returns the entry that was read. */
  download(path: string, dest: string): Promise<DriveEntry>
  upload(path: string, src: string, opt: { mode: 'create' | 'ifmatch'; baseEtag?: string; modified: number; size: number }): Promise<DriveCommit>
  mkdir(path: string): Promise<void>
  /** To the pool's Bin. */
  remove(path: string): Promise<void>
}

export interface SyncReport {
  uploaded: number
  downloaded: number
  conflicts: number
  deletedLocal: number
  deletedRemote: number
  errors: { path: string; why: string }[]
  /** Deletes held back by the brake (nothing was deleted). */
  held: number
  blocked: 'local-empty' | 'remote-empty' | 'local-missing' | null
  rev: number
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'offline' | 'blocked' | 'stopped'
  lastOkAt: number | null
  lastReport: SyncReport | null
  /** Why the last round failed, when it did. */
  error: string | null
}

export interface SyncOptions {
  folder: string
  /** Where the base, the cursor and the trash are kept: outside the synced folder. */
  stateDir: string
  remote: SyncRemote
  /** This device's name, used in conflict copies. */
  device: string
  log?: Logger
  now?: () => number
  plan?: PlanOptions
  /** How long a quiet loop waits before it looks at the folder again anyway. */
  scanEveryMs?: number
  /** The long-poll wait on the pool's change feed. */
  pollMs?: number
  /** Tests: the rename that puts a fetched file in place (a busy one is simulated), and how long to wait between tries when Windows says the file is in use. */
  renameFile?: (from: string, to: string) => Promise<void>
  renameWaitsMs?: number[]
}

export interface Sync {
  runOnce(): Promise<SyncReport>
  start(): void
  stop(): Promise<void>
  status(): SyncStatus
  /** A person confirmed: the next round may carry out the deletes the brake held (once). */
  allowMassDelete(): void
}

interface State {
  version: 1
  rev: number | null
  base: Record<string, BaseEntry>
}

const IGNORED_NAME = /^(\.DS_Store|Thumbs\.db|desktop\.ini|~\$.*|\.~lock\..*#|.*\.tmp|.*\.part|\.sad-sync-.*)$/i
export const isIgnored = (name: string) => IGNORED_NAME.test(name)
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    t.unref?.()
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })

/** Windows answers EPERM/EBUSY/EACCES to a rename over a file that is open, being deleted or being scanned: it is usually over in a moment. */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
export const RENAME_WAITS_MS = [100, 200, 300]

/** Renames, trying again a few times (waits apart) while the file is busy; any other error, or the last busy one, is thrown as it is. */
export async function renameWhenFree(rename_: (from: string, to: string) => Promise<void>, from: string, to: string, waits: number[] = RENAME_WAITS_MS): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await rename_(from, to)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (!code || !BUSY_CODES.has(code) || i >= waits.length) throw e
      await sleep(waits[i])
    }
  }
}

export function createSync(o: SyncOptions): Sync {
  const moveFile = (from: string, to: string) => renameWhenFree(o.renameFile ?? rename, from, to, o.renameWaitsMs)
  const now = o.now ?? Date.now
  const folder = path.resolve(o.folder)
  const stateFile = path.join(o.stateDir, 'sync-state.json')
  const trashDir = path.join(o.stateDir, 'trash')
  const abs = (rel: string) => path.join(folder, ...rel.split('/'))
  let state: State | null = null
  let allowDeletes = false
  let status: SyncStatus = { state: 'idle', lastOkAt: null, lastReport: null, error: null }

  async function load(): Promise<State> {
    if (state) return state
    try {
      const v = JSON.parse(await readFile(stateFile, 'utf8')) as State
      if (v.version === 1 && v.base && typeof v.base === 'object') return (state = v)
    } catch {
      // First run, or damaged: start from nothing (nothing is deleted from a path nobody agreed on).
    }
    return (state = { version: 1, rev: null, base: {} })
  }
  async function save() {
    if (!state) return
    await mkdir(o.stateDir, { recursive: true })
    const tmp = `${stateFile}.${randomBytes(3).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(state))
    await rename(tmp, stateFile)
  }

  // ---- what the folder holds now ------------------------------------------------------------------------------------
  async function scanLocal(errors: { path: string; why: string }[]): Promise<Map<string, LocalEntry>> {
    const out = new Map<string, LocalEntry>()
    const walk = async (dirAbs: string, rel: string) => {
      const names = (await readdir(dirAbs)).sort()
      const seen = new Map<string, string>()
      for (const n of names) {
        if (isIgnored(n)) continue
        const r = rel ? `${rel}/${n}` : n
        const st = await lstat(path.join(dirAbs, n)).catch(() => null)
        if (!st || st.isSymbolicLink()) continue
        if (!st.isDirectory() && !st.isFile()) continue
        const why = pathProblem(r.normalize('NFC'))
        if (why) {
          errors.push({ path: r, why: `Not synced: ${why}` })
          continue
        }
        const key = nameKey(n)
        const clash = seen.get(key)
        if (clash) {
          errors.push({ path: r, why: `Not synced: ${clash} is already here; names that differ only in case are the same name in the Common Drive.` })
          continue
        }
        seen.set(key, n)
        const norm = r.normalize('NFC')
        if (st.isDirectory()) {
          out.set(norm, { kind: 'dir', size: 0, mtimeMs: 0 })
          await walk(path.join(dirAbs, n), r)
        } else out.set(norm, { kind: 'file', size: st.size, mtimeMs: st.mtimeMs })
      }
    }
    await walk(folder, '')
    return out
  }

  // ---- what the pool holds now ---------------------------------------------------------------------------------------
  async function walkRemote(into: Map<string, RemoteEntry>, rel: string) {
    let cursor: string | undefined
    do {
      const page = await o.remote.list(rel, cursor)
      for (const e of page.entries) {
        into.set(e.path, { kind: e.kind, size: e.size, etag: e.etag, mtime: e.mtime })
        if (e.kind === 'dir') await walkRemote(into, e.path)
      }
      cursor = page.next
    } while (cursor)
  }
  const fromBase = (base: Record<string, BaseEntry>) => {
    const m = new Map<string, RemoteEntry>()
    for (const [p, b] of Object.entries(base)) m.set(p, { kind: b.kind, size: b.size, etag: b.etag, mtime: b.lmtime })
    return m
  }
  async function remoteView(s: State): Promise<{ view: Map<string, RemoteEntry>; rev: number }> {
    if (s.rev === null) {
      const rev = await o.remote.rev()
      const view = new Map<string, RemoteEntry>()
      await walkRemote(view, '')
      return { view, rev }
    }
    const ch = await o.remote.changes(s.rev, 0)
    if (ch.reset) {
      const view = new Map<string, RemoteEntry>()
      await walkRemote(view, '')
      return { view, rev: ch.rev }
    }
    const view = fromBase(s.base)
    const touched = new Set<string>()
    const gone = (p: string) => {
      view.delete(p)
      for (const k of [...view.keys()]) if (k.startsWith(`${p}/`)) view.delete(k)
    }
    for (const c of ch.changes) {
      if (c.op === 'purge') continue
      if (c.op === 'delete') gone(c.path)
      if (c.op === 'move' && c.from) gone(c.from)
      if (c.op !== 'delete') touched.add(c.path)
    }
    for (const p of touched) {
      const e = await o.remote.stat(p)
      if (!e) {
        gone(p)
        continue
      }
      view.set(p, { kind: e.kind, size: e.size, etag: e.etag, mtime: e.mtime })
      if (e.kind === 'dir') {
        // A folder that came in whole (a move, a restore): everything in it is new to us.
        const sub = new Map<string, RemoteEntry>()
        await walkRemote(sub, p)
        for (const [k, v] of sub) view.set(k, v)
      }
    }
    return { view, rev: ch.rev }
  }

  // ---- carrying the plan out -----------------------------------------------------------------------------------------
  async function tempNear(target: string) {
    return path.join(path.dirname(target), `.sad-sync-${randomBytes(4).toString('hex')}.part`)
  }
  async function moveToTrash(rel: string) {
    const to = path.join(trashDir, new Date(now()).toISOString().replace(/[:.]/g, '-'), ...rel.split('/'))
    await mkdir(path.dirname(to), { recursive: true })
    try {
      await moveFile(abs(rel), to)
    } catch {
      await copyFile(abs(rel), to)
      await unlink(abs(rel))
    }
  }

  async function runOnce(): Promise<SyncReport> {
    const report: SyncReport = { uploaded: 0, downloaded: 0, conflicts: 0, deletedLocal: 0, deletedRemote: 0, errors: [], held: 0, blocked: null, rev: 0 }
    const s = await load()
    await mkdir(o.stateDir, { recursive: true })
    const rootOk = await stat(folder).then(x => x.isDirectory(), () => false)
    if (!rootOk) {
      if (Object.keys(s.base).length > 0) {
        report.blocked = 'local-missing'
        return report
      }
      await mkdir(folder, { recursive: true })
    }

    const { view: remote, rev } = await remoteView(s)
    report.rev = rev
    const local = await scanLocal(report.errors)
    const base = new Map(Object.entries(s.base))
    const p = plan(base, local, remote, { ...o.plan, allowMassDelete: allowDeletes || o.plan?.allowMassDelete })
    if (p.blocked) {
      report.blocked = p.blocked
      return report
    }
    report.held = p.held.length
    let failed = false
    const fail = (path_: string, e: unknown) => {
      failed = true
      report.errors.push({ path: path_, why: message(e) })
    }
    const setBase = (rel: string, e: BaseEntry) => void (s.base[rel] = e)

    const download = async (rel: string, before?: LocalEntry) => {
      const target = abs(rel)
      await mkdir(path.dirname(target), { recursive: true })
      const tmp = await tempNear(target)
      let entry: DriveEntry
      try {
        entry = await o.remote.download(rel, tmp)
        const now2 = await lstat(target).catch(() => null)
        if (now2 && before && (now2.size !== before.size || Math.abs(now2.mtimeMs - before.mtimeMs) >= 1)) {
          throw new Error('It changed here while it was being fetched; it will be looked at again.')
        }
        await utimes(tmp, entry.mtime / 1000, entry.mtime / 1000)
        await moveFile(tmp, target)
      } catch (e) {
        await rm(tmp, { force: true })
        throw e
      }
      const st = await stat(target)
      setBase(rel, { kind: 'file', etag: entry.etag, size: entry.size, lsize: st.size, lmtime: st.mtimeMs })
      report.downloaded++
    }

    const upload = async (rel: string, mode: 'create' | 'ifmatch', baseEtag?: string): Promise<DriveCommit> => {
      const pre = await stat(abs(rel))
      const done = await o.remote.upload(rel, abs(rel), { mode, baseEtag, modified: Math.floor(pre.mtimeMs), size: pre.size })
      report.uploaded++
      if (!done.conflict) setBase(rel, { kind: 'file', etag: done.entry.etag, size: done.entry.size, lsize: pre.size, lmtime: pre.mtimeMs })
      return done
    }

    for (const a of p.actions as Action[]) {
      try {
        switch (a.op) {
          case 'mkdir-remote':
            await o.remote.mkdir(a.path)
            setBase(a.path, { kind: 'dir', etag: '', size: 0, lsize: 0, lmtime: 0 })
            break
          case 'mkdir-local':
            await mkdir(abs(a.path), { recursive: true })
            setBase(a.path, { kind: 'dir', etag: '', size: 0, lsize: 0, lmtime: 0 })
            break
          case 'upload':
            await upload(a.path, a.mode, a.baseEtag)
            break
          case 'download':
            await download(a.path, local.get(a.path))
            break
          case 'conflict': {
            // The local version goes up first; only then is it replaced by the pool's. The pool names the copy (…(conflict - <device> …)).
            const done = await upload(a.path, 'ifmatch', a.baseEtag ?? 'none')
            report.conflicts++
            if (done.conflict) await download(a.path, undefined)
            break
          }
          case 'adopt': {
            const r = remote.get(a.path)
            const l = local.get(a.path)
            if (r && l) setBase(a.path, { kind: r.kind, etag: r.etag, size: r.size, lsize: l.size, lmtime: l.mtimeMs })
            break
          }
          case 'delete-remote': {
            const kind = s.base[a.path]?.kind
            if (kind === 'dir') {
              const page = await o.remote.list(a.path)
              if (page.entries.length) break // something is in it that we have not looked at: not ours to remove
            }
            await o.remote.remove(a.path)
            delete s.base[a.path]
            report.deletedRemote++
            break
          }
          case 'delete-local': {
            const kind = s.base[a.path]?.kind
            if (kind === 'dir') {
              if ((await readdir(abs(a.path)).catch(() => ['x'])).length) break
              await rmdir(abs(a.path))
            } else await moveToTrash(a.path)
            delete s.base[a.path]
            report.deletedLocal++
            break
          }
          case 'forget':
            delete s.base[a.path]
            break
          case 'error':
            fail(a.path, a.why)
            break
        }
      } catch (e) {
        fail(a.path, e)
      }
    }
    allowDeletes = false
    // The cursor moves on only when everything went across: a failed path, or a delete the brake held, must come round again
    // (its change would otherwise be forgotten: the pool's side of it is only known from the change feed).
    if (!failed && p.held.length === 0) s.rev = rev
    await save()
    return report
  }

  // ---- the loop -------------------------------------------------------------------------------------------------------
  let running = false
  let stopping: AbortController | null = null
  let loop: Promise<void> | null = null
  let watcher: FSWatcher | null = null

  function start() {
    if (running) return
    running = true
    const ac = (stopping = new AbortController())
    status = { ...status, state: 'syncing' }
    let wake: (() => void) | null = null
    let woken = false
    const poke = () => {
      woken = true
      wake?.()
    }
    let debounce: NodeJS.Timeout | undefined
    try {
      watcher = watch(folder, { recursive: true }, (_e, name) => {
        if (name && isIgnored(path.basename(String(name)))) return
        clearTimeout(debounce)
        debounce = setTimeout(poke, 1500)
        debounce.unref?.()
      })
      watcher.on('error', () => undefined)
    } catch {
      watcher = null // no recursive watching here: the scan interval finds changes
    }
    // The pool's change feed, in the background: a change there wakes the loop.
    void (async () => {
      let since: number | null = null
      let backoff = 1000
      while (!ac.signal.aborted) {
        try {
          since ??= await o.remote.rev()
          const c = await o.remote.changes(since, o.pollMs ?? 25_000, ac.signal)
          if (ac.signal.aborted) return
          if (c.reset || c.changes.length) poke()
          since = c.rev
          backoff = 1000
        } catch {
          await sleep(backoff, ac.signal)
          backoff = Math.min(60_000, backoff * 2)
        }
      }
    })()

    loop = (async () => {
      let backoff = 2000
      while (!ac.signal.aborted) {
        try {
          status = { ...status, state: 'syncing' }
          const r = await runOnce()
          status = { state: r.blocked || r.held ? 'blocked' : 'idle', lastOkAt: now(), lastReport: r, error: r.blocked ? `Sync paused: ${r.blocked}` : null }
          backoff = 2000
        } catch (e) {
          status = { ...status, state: 'offline', error: message(e) }
          o.log?.warn(`sync: ${message(e)}`)
          await sleep(backoff, ac.signal)
          backoff = Math.min(60_000, backoff * 2)
          continue
        }
        if (!woken && !ac.signal.aborted) await new Promise<void>(resolve => {
          wake = resolve
          const t = setTimeout(resolve, o.scanEveryMs ?? 60_000)
          t.unref?.()
          ac.signal.addEventListener('abort', () => resolve())
        })
        wake = null
        woken = false
      }
    })()
  }

  return {
    runOnce,
    start,
    async stop() {
      stopping?.abort()
      watcher?.close()
      watcher = null
      await loop
      running = false
      loop = null
      status = { ...status, state: 'stopped' }
    },
    status: () => ({ ...status }),
    allowMassDelete() {
      allowDeletes = true
    },
  }
}
