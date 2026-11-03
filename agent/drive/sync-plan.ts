// F-097 part C: the sync folder's decisions, as a pure function (no files, no network), so every case is tested on its own.
//
// Three views of every path: BASE (what both sides agreed on the last time they were in step), LOCAL (the folder now) and REMOTE
// (the pool now). A side "changed" when it differs from base. The rules, in short:
//   - one side changed, the other did not: the change goes across;
//   - both changed: BOTH are kept (the local version is saved beside the pool's as a conflict copy, then the pool's comes down);
//   - a delete goes across only for a file that was in step (it is in base) and was not changed on the other side;
//   - a path nobody has agreed on is never deleted;
//   - when a round would delete a lot, or one side looks empty, nothing is deleted until a person says so (see `deletes` below).

export type Kind = 'file' | 'dir'

/** What both sides agreed on: the pool's etag, and the local size and modified time at that moment. */
export interface BaseEntry {
  kind: Kind
  etag: string
  size: number
  lsize: number
  lmtime: number
}
export interface LocalEntry {
  kind: Kind
  size: number
  mtimeMs: number
}
export interface RemoteEntry {
  kind: Kind
  size: number
  etag: string
  mtime: number
}

export type Action =
  | { op: 'upload'; path: string; mode: 'create' | 'ifmatch'; baseEtag?: string }
  | { op: 'download'; path: string }
  /** Both changed (or both were new and differ): the local version goes up as a conflict copy, then the pool's comes down. */
  | { op: 'conflict'; path: string; baseEtag?: string }
  /** Both sides already hold the same thing: just record it as in step. */
  | { op: 'adopt'; path: string }
  | { op: 'mkdir-remote'; path: string }
  | { op: 'mkdir-local'; path: string }
  | { op: 'delete-remote'; path: string }
  | { op: 'delete-local'; path: string }
  /** Gone on both sides: drop it from base. */
  | { op: 'forget'; path: string }
  | { op: 'error'; path: string; why: string }

/** The same time within this many ms is the same time (file systems round differently). */
export const SAME_TIME_MS = 2000

const depth = (p: string) => (p === '' ? 0 : p.split('/').length)

export interface PlanOptions {
  /** A delete count over this, and over `holdShare` of the files in base, is held (unless `allowMassDelete`). */
  holdOver?: number
  holdShare?: number
  allowMassDelete?: boolean
}

export interface Plan {
  actions: Action[]
  /** Deletes that were held back, when the brake held them: nothing was deleted this round. */
  held: Action[]
  /** Why the round was stopped altogether (one side looks empty while base has files), or null. */
  blocked: 'local-empty' | 'remote-empty' | null
}

export function plan(base: ReadonlyMap<string, BaseEntry>, local: ReadonlyMap<string, LocalEntry>, remote: ReadonlyMap<string, RemoteEntry>, opt: PlanOptions = {}): Plan {
  const baseFiles = [...base.values()].filter(b => b.kind === 'file').length
  // A side that shows nothing at all while the last sync had files is far more likely to be unreachable or unmounted than emptied.
  if (!opt.allowMassDelete && baseFiles > 0) {
    const localFiles = [...local.values()].filter(l => l.kind === 'file').length
    const remoteFiles = [...remote.values()].filter(r => r.kind === 'file').length
    if (localFiles === 0) return { actions: [], held: [], blocked: 'local-empty' }
    if (remoteFiles === 0) return { actions: [], held: [], blocked: 'remote-empty' }
  }

  const paths = new Set<string>([...base.keys(), ...local.keys(), ...remote.keys()])
  const mkdirs: Action[] = []
  const transfers: Action[] = []
  const deletes: Action[] = []
  const bookkeeping: Action[] = []

  for (const path of paths) {
    const b = base.get(path)
    const l = local.get(path)
    const r = remote.get(path)

    if (b && l && l.kind !== b.kind) {
      transfers.push({ op: 'error', path, why: 'It was a file and is now a folder here (or the other way round).' })
      continue
    }
    if (b && r && r.kind !== b.kind) {
      transfers.push({ op: 'error', path, why: 'It was a file and is now a folder in the Common Drive (or the other way round).' })
      continue
    }
    if (l && r && l.kind !== r.kind) {
      transfers.push({ op: 'error', path, why: 'It is a file on one side and a folder on the other.' })
      continue
    }
    const kind = (l ?? r ?? b)?.kind
    if (!kind) continue

    if (kind === 'dir') {
      if (!b && l && !r) mkdirs.push({ op: 'mkdir-remote', path })
      else if (!b && !l && r) mkdirs.push({ op: 'mkdir-local', path })
      else if (!b && l && r) bookkeeping.push({ op: 'adopt', path })
      else if (b && l && r) bookkeeping.push({ op: 'adopt', path })
      else if (b && !l && r) deletes.push({ op: 'delete-remote', path }) // gone here, still there: its files decide (the executor only removes an empty folder)
      else if (b && l && !r) deletes.push({ op: 'delete-local', path })
      else if (b && !l && !r) bookkeeping.push({ op: 'forget', path })
      continue
    }

    const localChanged = l ? !b || b.lsize !== l.size || Math.abs(b.lmtime - l.mtimeMs) >= 1 : false
    const remoteChanged = r ? !b || b.etag !== r.etag : false

    if (!b) {
      if (l && !r) transfers.push({ op: 'upload', path, mode: 'create' })
      else if (!l && r) transfers.push({ op: 'download', path })
      else if (l && r) {
        if (l.size === r.size && Math.abs(l.mtimeMs - r.mtime) < SAME_TIME_MS) bookkeeping.push({ op: 'adopt', path })
        else transfers.push({ op: 'conflict', path })
      }
      continue
    }

    if (l && r) {
      if (!localChanged && !remoteChanged) continue
      if (localChanged && !remoteChanged) transfers.push({ op: 'upload', path, mode: 'ifmatch', baseEtag: b.etag })
      else if (!localChanged && remoteChanged) transfers.push({ op: 'download', path })
      else if (l.size === r.size && Math.abs(l.mtimeMs - r.mtime) < SAME_TIME_MS) bookkeeping.push({ op: 'adopt', path })
      else transfers.push({ op: 'conflict', path, baseEtag: b.etag })
    } else if (!l && r) {
      // Deleted here. It goes in the pool's Bin only if the pool's copy is still the one we agreed on; otherwise somebody changed it: it comes back.
      if (!remoteChanged) deletes.push({ op: 'delete-remote', path })
      else transfers.push({ op: 'download', path })
    } else if (l && !r) {
      // Deleted in the pool. It goes here (to the sync trash) only if our copy is untouched; otherwise our edits make it again.
      if (!localChanged) deletes.push({ op: 'delete-local', path })
      else transfers.push({ op: 'upload', path, mode: 'create' })
    } else bookkeeping.push({ op: 'forget', path })
  }

  const holdOver = opt.holdOver ?? 20
  const holdShare = opt.holdShare ?? 0.2
  const fileDeletes = deletes.filter(d => d.op !== 'forget')
  const massive = !opt.allowMassDelete && fileDeletes.length > holdOver && fileDeletes.length > holdShare * Math.max(1, baseFiles)

  mkdirs.sort((a, c) => depth(a.path) - depth(c.path) || (a.path < c.path ? -1 : 1))
  transfers.sort((a, c) => (a.path < c.path ? -1 : a.path > c.path ? 1 : 0))
  // Deepest first: a folder is only removed after what was in it.
  deletes.sort((a, c) => depth(c.path) - depth(a.path) || (a.path < c.path ? -1 : 1))
  return massive ? { actions: [...mkdirs, ...transfers, ...bookkeeping], held: deletes, blocked: null } : { actions: [...mkdirs, ...transfers, ...deletes, ...bookkeeping], held: [], blocked: null }
}
