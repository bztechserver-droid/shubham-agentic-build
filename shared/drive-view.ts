import { nameKey, type DriveBinItem, type DriveEntry, type DriveStatus } from './drive.ts'

// F-097: the Drive page's own pure rules, on top of Connection's shared/drive.ts (the types, and the name rules the store
// enforces): paths, ordering, sizes, days left in the Bin, how a conflict copy is told, icons by file kind. No page, no socket.

// --- paths ----------------------------------------------------------------------------------------------------------

export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
/** "a/b/c" is under "a/b" and under "a", and under "" (every path is under the root); "a/bc" is not under "a/b". */
export const isUnder = (path: string, dir: string) => dir === '' || path === dir || path.startsWith(`${dir}/`)

/** The folders to get to a path, root first: "a/b" -> [{name:'a',path:'a'},{name:'b',path:'a/b'}]. */
export function crumbs(path: string): { name: string; path: string }[] {
  if (!path) return []
  const parts = path.split('/')
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))
}

/** The same name, case and Unicode form aside: the store refuses two names that differ only so, so Windows and Linux agree. */
export const sameName = (a: string, b: string) => nameKey(a) === nameKey(b)

/** `name` if nothing in `taken` has it (case aside), else "name (2).ext", "name (3).ext"... (what the store's keepboth makes too). */
export function freeName(name: string, taken: readonly string[]): string {
  const has = (n: string) => taken.some(t => sameName(t, n))
  if (!has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; ; i++) {
    const next = `${stem} (${i})${ext}`
    if (!has(next)) return next
  }
}

/** Whether a name is a conflict copy the store made ("plan (conflict - Laptop 2026-11-03 14.05).pdf"). */
export const isConflictName = (name: string) => /\(conflict - [^)]*\)/i.test(name)

/** The device in a conflict copy's name ("Laptop"), or null. */
export function conflictDevice(name: string): string | null {
  const m = /\(conflict - (.+?) \d{4}-\d{2}-\d{2}[^)]*\)/i.exec(name)
  return m ? m[1] : null
}

/** The file a conflict copy is a copy of ("plan.pdf" for "plan (conflict - Laptop 2026-11-03 14.05).pdf"), or null. */
export function conflictOriginal(name: string): string | null {
  if (!isConflictName(name)) return null
  return name.replace(/ \(conflict - [^)]*\)/i, '')
}

/** The kind of a file for its icon, from its extension. */
export type FileGroup = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'sheet' | 'archive' | 'code' | 'other'
const GROUPS: Record<FileGroup, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'svg', 'bmp', 'avif'],
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'opus'],
  pdf: ['pdf'],
  text: ['txt', 'md', 'doc', 'docx', 'rtf', 'odt'],
  sheet: ['xls', 'xlsx', 'csv', 'ods'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz'],
  code: ['js', 'ts', 'tsx', 'jsx', 'json', 'html', 'css', 'py', 'sh', 'ps1', 'cs', 'java', 'kt', 'yml', 'yaml', 'xml', 'sql'],
  other: [],
}
export function fileGroup(name: string): FileGroup {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'other'
  const ext = name.slice(dot + 1).toLowerCase()
  for (const g of Object.keys(GROUPS) as FileGroup[]) if (GROUPS[g].includes(ext)) return g
  return 'other'
}

// --- order, sizes and times --------------------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export type SortBy = 'name' | 'modified' | 'size'

/** Folders first, then by the chosen order (names as a person sorts them: "file 2" before "file 10"). Never changes its input. */
export function sortEntries(entries: readonly DriveEntry[], by: SortBy = 'name', desc = false): DriveEntry[] {
  const dir = desc ? -1 : 1
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    const c = by === 'modified' ? a.mtime - b.mtime : by === 'size' ? a.size - b.size : collator.compare(a.name, b.name)
    return c !== 0 ? c * dir : collator.compare(a.name, b.name)
  })
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
/** "4.2 MB": one decimal under 10, none above; a byte is "512 B". */
export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  let v = bytes
  let i = 0
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000
    i++
  }
  const text = i === 0 ? String(Math.round(v)) : v < 10 ? v.toFixed(1) : String(Math.round(v))
  return `${text} ${UNITS[i]}`
}

/** 0 to 1: how full the drive is. A drive with no limit is never full. */
export const usedShare = (s: Pick<DriveStatus, 'usedBytes' | 'limitBytes'>) => (s.limitBytes > 0 ? Math.min(1, Math.max(0, s.usedBytes / s.limitBytes)) : 0)

/** Whole days left in the Bin, rounded up so the last day still says "1 day"; 0 means it goes today. */
export function daysLeft(item: Pick<DriveBinItem, 'expiresAt'>, now: number): number {
  return Math.max(0, Math.ceil((item.expiresAt - now) / 86_400_000))
}

/** "3 days left", "1 day left", "goes today". */
export function daysLeftText(item: Pick<DriveBinItem, 'expiresAt'>, now: number): string {
  const d = daysLeft(item, now)
  return d === 0 ? 'goes today' : d === 1 ? '1 day left' : `${d} days left`
}

/** "today", "yesterday", "3 days ago", else a date: short, for a row. */
export function whenText(ms: number, now: number): string {
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0)
  const days = Math.round((day(now) - day(ms)) / 86_400_000)
  if (days <= 0) {
    const mins = Math.max(0, Math.round((now - ms) / 60_000))
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins} min ago`
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' })
}

/** Where a drag, a move or a rename may not go: a folder into itself or into what is inside it, or to where it already is. */
export const canMoveInto = (from: string, kind: DriveEntry['kind'], destDir: string) => !(kind === 'dir' && isUnder(destDir, from)) && parentOf(from) !== destDir

/** How much of an upload has gone, 0 to 1. */
export const shareOf = (sent: number, total: number) => (total > 0 ? Math.min(1, Math.max(0, sent / total)) : 1)

/** "1 min left", "40 s left": a rough time to go at the speed so far; null until there is a speed to go on. */
export function timeLeftText(sent: number, total: number, ms: number): string | null {
  if (sent <= 0 || ms < 1500 || sent >= total) return null
  const left = ((total - sent) / sent) * ms
  if (left < 1000) return null
  const s = Math.round(left / 1000)
  if (s < 60) return `${s} s left`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h ${m % 60} min left`
}

// --- the shell's status button -----------------------------------------------------------------------------------

export type DriveLook = { status: 'running' | 'waiting' | 'done' | 'idle' | 'error'; text: string }

/** What the status button says: from the store's status (null before the first answer), whether the last ask failed, and the uploads here. */
export function driveLook(s: DriveStatus | null, failed: boolean, uploading: number, waiting: number): DriveLook {
  if (failed && !s) return { status: 'error', text: "Can't be reached" }
  if (!s) return { status: 'idle', text: 'Checking' }
  if (!s.enabled) return { status: 'idle', text: 'Switched off' }
  const share = usedShare(s)
  if (share >= 0.95) return { status: 'error', text: 'Almost full' }
  if (uploading > 0) return { status: 'running', text: `Uploading ${uploading} ${uploading === 1 ? 'file' : 'files'}` }
  if (waiting > 0) return { status: 'waiting', text: `${waiting} ${waiting === 1 ? 'upload' : 'uploads'} waiting` }
  if (s.backup.state === 'error') return { status: 'waiting', text: 'The Google backup needs a look' }
  if (share >= 0.85) return { status: 'waiting', text: 'Getting full' }
  return { status: 'done', text: 'All well' }
}
