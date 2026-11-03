import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { DriveLocalSync, DriveSyncReport } from '../../shared/drive.ts'
import type { Logger } from '../log.ts'
import { driveError } from './store.ts'
import { createSync, type Sync, type SyncRemote } from './sync.ts'

// F-097 part C, inside the app: the sync folder of THIS PC. The person chooses a folder; while it is switched on, the folder is kept in step with the
// Common Drive: on the hub straight from the store, on another PC (the laptop) over the member link. The state (what both sides agreed on, the sync
// trash) is kept per folder in the agent's state folder, so choosing another folder starts clean and never deletes anything on its account.

interface Saved {
  enabled: boolean
  folder: string | null
}

export interface LocalSyncOptions {
  /** The agent's drive state folder: local-sync.json and sync-state/ go here. */
  dir: string
  device: string
  /** The pool's own folder on the hub: a sync folder may not be inside it, or contain it. */
  poolRoot?: string
  /** The way to the pool right now, or null with `why` saying what is missing (e.g. the hub can't be reached). */
  remote: () => Promise<SyncRemote | null>
  why: () => string
  log?: Logger
  /** Tests. */
  scanEveryMs?: number
  pollMs?: number
}

export interface LocalSync {
  info(): DriveLocalSync
  /** Chooses the folder and/or switches it on or off. Throws an error with words for a person for a folder that won't do. */
  set(patch: { enabled?: boolean; folder?: string | null }): Promise<DriveLocalSync>
  /** One round now. */
  run(): Promise<DriveLocalSync>
  /** A person confirmed the deletes the brake held. */
  allowDeletes(): Promise<DriveLocalSync>
  /** Starts it again if it was on (called when the pool becomes reachable), and stops it on close. */
  resume(): Promise<void>
  close(): Promise<void>
}

const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Why a folder can't be the sync folder, in words for a person; null when it can. */
export function folderProblem(folder: string, poolRoot?: string): string | null {
  if (!path.isAbsolute(folder)) return 'Give the whole path of the folder (like C:\\Users\\you\\Common Drive).'
  const f = path.resolve(folder)
  if (path.parse(f).root === f) return 'A whole drive can not be the sync folder; make a folder for it.'
  if (same(f, homedir())) return 'Your whole home folder can not be the sync folder; make a folder inside it.'
  if (inside(homedir(), f) && !same(f, homedir())) return 'That folder holds your home folder; choose a smaller one.'
  if (poolRoot && (inside(f, poolRoot) || inside(poolRoot, f))) return 'That folder is where the Common Drive itself is kept on the server; choose another one.'
  try {
    if (existsSync(f) && !statSync(f).isDirectory()) return 'That is a file, not a folder.'
  } catch {
    return 'That folder can not be read.'
  }
  return null
}

export function createLocalSync(o: LocalSyncOptions): LocalSync {
  const file = path.join(o.dir, 'local-sync.json')
  let saved: Saved = { enabled: false, folder: null }
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>
    saved = { enabled: v.enabled === true, folder: typeof v.folder === 'string' ? v.folder : null }
  } catch {
    // None yet.
  }
  const save = () => {
    mkdirSync(o.dir, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(saved, null, 2))
    renameSync(tmp, file)
  }

  let sync: Sync | null = null
  let syncFolder: string | null = null
  let unavailable: string | null = null
  const stateDirOf = (folder: string) => path.join(o.dir, 'sync-state', createHash('sha1').update(path.resolve(folder).toLowerCase()).digest('hex').slice(0, 12))

  async function stop() {
    const s = sync
    sync = null
    syncFolder = null
    await s?.stop()
  }

  /** Starts or stops the loop to match what was chosen and whether the pool can be reached. */
  async function apply() {
    if (!saved.enabled || !saved.folder) return stop()
    if (sync && syncFolder === saved.folder) return
    await stop()
    const remote = await o.remote()
    if (!remote) {
      unavailable = o.why()
      return
    }
    unavailable = null
    mkdirSync(saved.folder, { recursive: true })
    sync = createSync({ folder: saved.folder, stateDir: stateDirOf(saved.folder), remote, device: o.device, log: o.log, scanEveryMs: o.scanEveryMs, pollMs: o.pollMs })
    syncFolder = saved.folder
    sync.start()
  }

  const report = (r: ReturnType<Sync['status']>['lastReport']): DriveSyncReport | null =>
    r && { uploaded: r.uploaded, downloaded: r.downloaded, conflicts: r.conflicts, deletedLocal: r.deletedLocal, deletedRemote: r.deletedRemote, held: r.held, blocked: r.blocked, errors: r.errors.slice(0, 20) }

  const info = (): DriveLocalSync => {
    const st = sync?.status()
    return {
      available: unavailable === null,
      ...(unavailable ? { reason: unavailable } : {}),
      enabled: saved.enabled,
      folder: saved.folder,
      suggestedFolder: path.join(homedir(), 'Common Drive'),
      state: !saved.enabled || !st ? 'off' : st.state,
      lastOkAt: st?.lastOkAt ?? null,
      error: st?.error ?? null,
      report: report(st?.lastReport ?? null),
    }
  }

  return {
    info,
    async set(patch) {
      if (patch.folder !== undefined) {
        if (patch.folder !== null) {
          const why = folderProblem(patch.folder, o.poolRoot)
          if (why) throw driveError(400, 'badname', why)
        }
        saved = { ...saved, folder: patch.folder === null ? null : path.resolve(patch.folder) }
      }
      if (patch.enabled !== undefined) {
        if (patch.enabled && !saved.folder) throw driveError(400, 'badname', 'Choose a folder first.')
        saved = { ...saved, enabled: patch.enabled === true }
      }
      save()
      await apply()
      return info()
    },
    async run() {
      if (!saved.enabled || !saved.folder) throw driveError(409, 'disabled', 'The sync folder is off. Choose a folder and switch it on.')
      await apply()
      if (!sync) throw driveError(409, 'disabled', unavailable ?? 'The Common Drive can not be reached.')
      await sync.runOnce().catch(() => undefined) // a failure is in its status
      return info()
    },
    async allowDeletes() {
      if (!sync) throw driveError(409, 'disabled', 'The sync folder is not running.')
      sync.allowMassDelete()
      await sync.runOnce().catch(() => undefined)
      return info()
    },
    async resume() {
      await apply().catch(e => o.log?.warn(`sync folder: ${e instanceof Error ? e.message : String(e)}`))
    },
    close: stop,
  }
}
