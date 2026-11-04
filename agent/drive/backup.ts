import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DriveBackupState, DriveChange } from '../../shared/drive.ts'
import type { Logger } from '../log.ts'
import type { BackupItem, BackupTarget } from './backup-target.ts'
import type { DriveStore } from './store.ts'

// F-097 part D: a one-way copy of the pool into a backup (Google Drive, or a folder). The pool stays on the server and is the truth; the copy
// follows its change feed within a minute or so, and a nightly check walks both and fixes whatever differs. A delete in the pool takes the
// COPY away only into the target's trash (never for good), and a big batch of them is held until a person says so, like the sync folder.

export interface BackupOptions {
  store: () => Promise<DriveStore | null>
  /** Chooses the target for each pass (the keys may appear later, or go); null with `why` when there is none. */
  target: () => Promise<BackupTarget | null>
  /** Where the cursor and what is copied are remembered. */
  stateFile: string
  now?: () => number
  log?: Logger
  /** Quiet time after a change before copying (ms). */
  settleMs?: number
  /** Deletes over this count and this share of what is copied are held. */
  holdOver?: number
  holdShare?: number
  /** The hour of the night (local, 0-23) of the full check. */
  nightlyHour?: number
}

export interface Backup {
  /** One pass over the changes since last time. */
  runOnce(): Promise<BackupReport>
  /** The full check: walk the pool, compare with the target, copy what is missing or different. */
  verify(): Promise<BackupReport>
  start(): void
  stop(): Promise<void>
  status(): DriveBackupState & { target?: string; held?: number }
  /** A person confirmed: the next pass may take away the copies the brake held. */
  allowMassDelete(): void
}

export interface BackupReport {
  copied: number
  removed: number
  moved: number
  /** Copies in the target that are not in the pool (reported; the nightly check does not delete them). */
  extra: number
  held: number
  errors: { path: string; why: string }[]
  rev: number
}

interface State {
  version: 1
  rev: number | null
  items: Record<string, BackupItem>
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const MINUTE = 60_000

export function createBackup(o: BackupOptions): Backup {
  const now = o.now ?? Date.now
  let state: State | null = null
  let allowDeletes = false
  let current: DriveBackupState & { target?: string; held?: number } = { state: 'off' }
  let busy: Promise<unknown> = Promise.resolve()
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = busy.then(fn)
    busy = r.catch(() => undefined)
    return r
  }

  async function load(): Promise<State> {
    if (state) return state
    try {
      const v = JSON.parse(await readFile(o.stateFile, 'utf8')) as State
      if (v.version === 1 && v.items) return (state = v)
    } catch {
      // First run.
    }
    return (state = { version: 1, rev: null, items: {} })
  }
  async function save() {
    if (!state) return
    await mkdir(path.dirname(o.stateFile), { recursive: true })
    const tmp = `${o.stateFile}.${randomBytes(3).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(state))
    await rename(tmp, o.stateFile)
  }
  const blank = (rev = 0): BackupReport => ({ copied: 0, removed: 0, moved: 0, extra: 0, held: 0, errors: [], rev })

  async function walkPool(store: DriveStore, rel: string, into: Map<string, BackupItem>) {
    let cursor: string | undefined
    do {
      const page = await store.list(rel, { cursor, limit: 1000 })
      for (const e of page.entries) {
        into.set(e.path, { etag: e.etag, size: e.size, kind: e.kind })
        if (e.kind === 'dir') await walkPool(store, e.path, into)
      }
      cursor = page.next
    } while (cursor)
  }

  async function copyOne(store: DriveStore, target: BackupTarget, s: State, rel: string, report: BackupReport) {
    let entry
    try {
      entry = await store.stat(rel)
    } catch (e) {
      if ((e as { code?: string }).code === 'notfound') return // gone again; the delete that follows handles it
      throw e
    }
    if (entry.kind === 'dir') {
      await target.ensureDir(rel)
      s.items[rel] = { etag: entry.etag, size: 0, kind: 'dir' }
      return
    }
    if (s.items[rel]?.etag === entry.etag && s.items[rel]?.kind === 'file') return
    const { abs } = await store.fileOf(rel)
    await target.put(rel, abs, { size: entry.size, etag: entry.etag, mtime: entry.mtime })
    s.items[rel] = { etag: entry.etag, size: entry.size, kind: 'file' }
    report.copied++
  }

  async function pass(full: boolean): Promise<BackupReport> {
    const store = await o.store()
    const target = await o.target()
    const report = blank()
    if (!store || !target) throw new Error(store ? 'There is no backup target: add the Google keys, or choose a folder.' : 'The Common Drive is off.')
    const s = await load()
    current = { ...current, state: 'copying', target: target.label }
    const fail = (p: string, e: unknown) => report.errors.push({ path: p, why: message(e) })
    const rev = store.rev()
    report.rev = rev

    if (full || s.rev === null) {
      const pool = new Map<string, BackupItem>()
      await walkPool(store, '', pool)
      const there = await target.list()
      // Folders first (shortest path first), then files.
      const paths = [...pool.keys()].sort((a, c) => a.split('/').length - c.split('/').length || (a < c ? -1 : 1))
      for (const p of paths) {
        const item = pool.get(p) as BackupItem
        try {
          const have = there.get(p)
          if (item.kind === 'file' && have && have.kind === 'file' && have.etag === item.etag && s.items[p]?.etag === item.etag) continue
          if (item.kind === 'dir' && have && s.items[p]) continue
          delete s.items[p]
          await copyOne(store, target, s, p, report)
        } catch (e) {
          fail(p, e)
        }
      }
      for (const p of there.keys()) if (!pool.has(p)) report.extra++
      // What was copied once but is no longer in the pool is removed by the delete rules below.
      const gone = Object.keys(s.items).filter(k => !pool.has(k))
      const result = await removals(target, s, gone, report)
      if (!report.errors.length && !result.held) s.rev = rev
    } else {
      const ch = await store.changes(s.rev, { limit: 2000 })
      if (ch.reset) {
        s.rev = null
        await save()
        return pass(true)
      }
      const touched = new Set<string>()
      const deleted: string[] = []
      const moves: DriveChange[] = []
      for (const c of ch.changes) {
        if (c.op === 'purge') continue
        if (c.op === 'delete') {
          deleted.push(c.path)
          touched.delete(c.path)
        } else if (c.op === 'move' && c.from) moves.push(c)
        else touched.add(c.path)
      }
      for (const m of moves) {
        const from = m.from as string
        try {
          if (s.items[from] && (await target.move(from, m.path))) {
            for (const k of Object.keys(s.items)) {
              if (k === from || k.startsWith(`${from}/`)) {
                s.items[m.path + k.slice(from.length)] = s.items[k]
                delete s.items[k]
              }
            }
            report.moved++
          } else {
            deleted.push(from)
            touched.add(m.path)
          }
        } catch (e) {
          fail(from, e)
        }
      }
      for (const p of [...touched].sort((a, c) => a.split('/').length - c.split('/').length || (a < c ? -1 : 1))) {
        try {
          await copyOne(store, target, s, p, report)
          // A folder that came in whole (restored, moved): everything in it too.
          if (s.items[p]?.kind === 'dir') {
            const sub = new Map<string, BackupItem>()
            await walkPool(store, p, sub)
            for (const sp of sub.keys()) await copyOne(store, target, s, sp, report)
          }
        } catch (e) {
          fail(p, e)
        }
      }
      const result = await removals(target, s, deleted.filter(p => s.items[p]), report)
      if (!report.errors.length && !result.held) s.rev = ch.rev
    }
    allowDeletes = false
    await save()
    current = {
      state: report.errors.length ? 'error' : 'idle',
      lastOkAt: report.errors.length ? current.lastOkAt : now(),
      pending: 0,
      target: target.label,
      ...(report.held ? { held: report.held } : {}),
      ...(report.errors.length ? { error: `${report.errors.length} file(s) could not be copied: ${report.errors[0].path}: ${report.errors[0].why}` } : {}),
    }
    return report
  }

  /** Takes copies away (to the target's trash) unless there are a lot of them. */
  async function removals(target: BackupTarget, s: State, paths: string[], report: BackupReport): Promise<{ held: boolean }> {
    if (!paths.length) return { held: false }
    const copied = Object.values(s.items).filter(i => i.kind === 'file').length
    const holdOver = o.holdOver ?? 20
    const holdShare = o.holdShare ?? 0.2
    if (!allowDeletes && paths.length > holdOver && paths.length > holdShare * Math.max(1, copied)) {
      report.held = paths.length
      return { held: true }
    }
    // Deepest first, and a folder only after what was in it; a folder removed takes its whole copy with it.
    for (const p of paths.sort((a, c) => c.split('/').length - a.split('/').length)) {
      if (!s.items[p]) continue
      try {
        await target.remove(p)
        delete s.items[p]
        report.removed++
      } catch (e) {
        report.errors.push({ path: p, why: message(e) })
      }
    }
    return { held: false }
  }

  // ---- the loop -------------------------------------------------------------------------------------------------------
  let running = false
  let stop: AbortController | null = null
  let loop: Promise<void> | null = null

  const nextNight = (): number => {
    const d = new Date(now())
    d.setHours(o.nightlyHour ?? 3, 0, 0, 0)
    if (d.getTime() <= now()) d.setDate(d.getDate() + 1)
    return d.getTime()
  }

  return {
    runOnce: () => locked(() => pass(false)),
    verify: () => locked(() => pass(true)),
    allowMassDelete() {
      allowDeletes = true
    },
    status: () => ({ ...current }),
    start() {
      if (running) return
      running = true
      const ac = (stop = new AbortController())
      current = { ...current, state: 'idle' }
      loop = (async () => {
        let night = nextNight()
        let backoff = 30_000
        let unsub: (() => void) | null = null
        let wake: (() => void) | null = null
        let dirty = true
        const store0 = await o.store().catch(() => null)
        if (store0) unsub = store0.onRev(() => { dirty = true; wake?.() })
        try {
          while (!ac.signal.aborted) {
            try {
              if (now() >= night) {
                await locked(() => pass(true))
                night = nextNight()
              } else if (dirty) {
                dirty = false
                await locked(() => pass(false))
              }
              backoff = 30_000
            } catch (e) {
              current = { ...current, state: 'error', error: message(e) }
              o.log?.warn(`backup: ${message(e)}`)
              dirty = true
              await new Promise<void>(r => {
                if (ac.signal.aborted) return r()
                const t = setTimeout(r, backoff)
                t.unref?.()
                ac.signal.addEventListener('abort', () => r())
              })
              backoff = Math.min(15 * MINUTE, backoff * 2)
              continue
            }
            // Wait for a change (then a quiet moment so a burst is one pass), or the night, or a minute.
            // Not when a change came while the pass was running: its wake-up found nobody waiting (wake was null), so waiting now would sit
            // out the whole minute with the change still uncopied (4 Nov 2026: the "remembers that it was on after a restart" test, 8 s).
            if (!dirty) {
              await new Promise<void>(r => {
                if (ac.signal.aborted) return r()
                wake = r
                const t = setTimeout(r, Math.max(1000, Math.min(MINUTE, night - now())))
                t.unref?.()
                ac.signal.addEventListener('abort', () => r())
              })
              wake = null
            }
            if (dirty && !ac.signal.aborted) {
              await new Promise<void>(r => {
                if (ac.signal.aborted) return r()
                const t = setTimeout(r, o.settleMs ?? 20_000)
                t.unref?.()
                ac.signal.addEventListener('abort', () => r())
              })
            }
          }
        } finally {
          unsub?.()
        }
      })()
    },
    async stop() {
      stop?.abort()
      await loop
      running = false
      loop = null
      current = { ...current, state: 'off' }
    },
  }
}
