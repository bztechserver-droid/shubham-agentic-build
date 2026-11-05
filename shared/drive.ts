// F-097: the Common Drive: the types of its API and the pure rules about names, shared by the agent (the store) and the web app
// (so a page can say "that name won't work" before it asks). The protocol is agent/agentic/DRIVE-PROTOCOL.md. Nothing here
// touches a file, a socket or the page, and nothing is specific to one operating system.

/** Where the page's calls go (the agent's API prefix is added by the app's client). */
export const DRIVE_BASE = '/agentic/drive'

export type DriveErrorCode = 'badname' | 'case' | 'exists' | 'notfound' | 'notempty' | 'etag' | 'offset' | 'quota' | 'range' | 'disabled' | 'busy'

export interface DriveEntry {
  name: string
  /** `/`-separated, relative to the pool's root, no leading slash. */
  path: string
  kind: 'file' | 'dir'
  size: number
  /** ms since the epoch. */
  mtime: number
  /** Opaque: only compare for equality. */
  etag: string
  mime?: string
}

export interface DriveList {
  path: string
  entries: DriveEntry[]
  next?: string
}

export interface DriveBackupState {
  state: 'off' | 'idle' | 'copying' | 'error'
  lastOkAt?: number
  pending?: number
  error?: string
}

/**
 * F-125: whose Google account the backup uses. "company" (the default) is bztech68, the account the CRM uses; "shubhambhole68" is Shubham's own, the old way, read from his Desktop file.
 * A key is never shown, only whether it is "set" or "missing".
 */
export type DriveGoogleSource = 'company' | 'shubhambhole68'

export const GOOGLE_SOURCES: readonly DriveGoogleSource[] = ['company', 'shubhambhole68']

/** The backup as the page shows it (GET /backup). */
export interface DriveBackupInfo extends DriveBackupState {
  /** Where copies go right now: "Google Drive (bztech68)", or the folder; null when there is nowhere. */
  target: string | null
  /** The keys of the CHOSEN account are there (the same as keysBySource[source] === 'set'). */
  keys: boolean
  /** F-125: the chosen account. */
  source?: DriveGoogleSource
  /** F-125: each account's keys, "set" or "missing". No value is ever sent. */
  keysBySource?: Record<DriveGoogleSource, 'set' | 'missing'>
  /** F-125: the company keys can be imported now (the CRM's file with its three Google keys is on this PC). */
  canImport?: boolean
  /** The folder used when there are no keys (the Google Drive for desktop folder). */
  fallbackFolder: string | null
  /** Removals of copies held back by the brake: nothing was taken away. */
  held?: number
}

export interface DriveStatus {
  enabled: boolean
  root: string
  limitBytes: number
  usedBytes: number
  binBytes: number
  versionsBytes: number
  diskFreeBytes: number
  /** The change counter; see DriveChanges. */
  rev: number
  /** The most one upload piece may be. */
  pieceBytes: number
  binDays: number
  versionsKept: number
  webdav: { enabled: boolean; url?: string }
  backup: DriveBackupState
  now: number
}

export interface DriveSettings {
  enabled: boolean
  limitBytes: number
  binDays: number
  versionsKept: number
  webdavEnabled: boolean
  /** Copy the pool into the backup (Google Drive, or a folder when there are no keys). Off by default (absent = off). */
  backupEnabled?: boolean
  /** F-125: whose Google account the backup uses (absent = "company"). */
  googleSource?: DriveGoogleSource
}

export type DriveMode = 'create' | 'overwrite' | 'keepboth' | 'ifmatch'

export interface DriveUploadStart {
  path: string
  size: number
  mode?: DriveMode
  baseEtag?: string
  /** The file's own modified time, kept on the stored file. */
  modified?: number
}

export interface DriveUpload {
  id: string
  pieceBytes: number
  received: number
}

export interface DriveUploadInfo {
  id: string
  path: string
  size: number
  received: number
}

export interface DriveCommit {
  entry: DriveEntry
  /** Set when the file was saved beside the original instead of over it. */
  conflict?: { copyOf: string }
}

export interface DriveBinItem {
  id: string
  name: string
  /** Where it was. */
  path: string
  kind: 'file' | 'dir'
  size: number
  deletedAt: number
  deletedBy: string
  expiresAt: number
}

export interface DriveVersion {
  id: string
  size: number
  savedAt: number
  replacedBy: string
}

export type DriveChangeOp = 'put' | 'mkdir' | 'move' | 'delete' | 'restore' | 'purge'

export interface DriveChange {
  rev: number
  op: DriveChangeOp
  path: string
  from?: string
  entry?: DriveEntry
  by: string
  at: number
}

export interface DriveChanges {
  rev: number
  changes: DriveChange[]
  /** `since` is older than the journal keeps: list again. */
  reset?: true
}

/** The text frames of GET /ws. */
export type DriveWsFrame = { t: 'rev'; rev: number } | { t: 'pong' }

// ---- names -----------------------------------------------------------------------------------------------------------

export const MAX_NAME_BYTES = 255
export const MAX_PATH_CHARS = 240

const BAD_CHARS = /[<>:"/\\|?*]/
/** A control character (0 to 31, 127): tested by its code, so no pattern has to hold one. */
const hasControl = (s: string) => [...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Why a single name can't be used, in words for a person; null when it can. The same on every operating system. */
export function nameProblem(name: string): string | null {
  if (!name) return 'The name is empty.'
  if (name === '.' || name === '..') return 'That name is not allowed.'
  if (BAD_CHARS.test(name) || hasControl(name)) return 'A name cannot contain < > : " / \\ | ? * or control characters.'
  if (/[. ]$/.test(name)) return 'A name cannot end with a dot or a space.'
  if (RESERVED.test(name)) return 'That name is reserved by Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9).'
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return 'That name is too long.'
  return null
}

/** Why a whole path can't be used (any piece of it, or its length); null when it can. `""` is the root. */
export function pathProblem(path: string): string | null {
  if (path === '') return null
  if (path.startsWith('/') || path.endsWith('/')) return 'A path has no slash at either end.'
  if (path.length > MAX_PATH_CHARS) return 'That path is too long.'
  for (const part of path.split('/')) {
    const why = nameProblem(part)
    if (why) return why
  }
  return null
}

/** The key two names are compared by: Unicode NFC, then lower case. Two names with one key are "the same name in a different case". */
export const nameKey = (name: string) => name.normalize('NFC').toLowerCase()

/** `plan.pdf` -> `plan (2).pdf`, `plan (2).pdf` -> `plan (3).pdf`. Folders and names with no dot work too. */
export function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return `${stem.replace(/ \(\d+\)$/, '')} (${n})${ext}`
}

/** `plan.pdf` -> `plan (conflict - Laptop 2026-11-03 14.05).pdf`. `when` is local time. */
export function conflictName(name: string, device: string, when: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}.${p(when.getMinutes())}`
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const who = [...device].filter(c => !BAD_CHARS.test(c) && !hasControl(c)).join('').trim().slice(0, 30) || 'device'
  return `${stem} (conflict - ${who} ${stamp})${ext}`
}

// ---- WebDAV and the devices that use the drive from outside the app --------------------------------------------------------

/** A device with its own drive password (the password itself is shown once, when it is made, and never again). */
export interface DriveDevice {
  name: string
  createdAt: number
  lastUsedAt?: number
}

export interface DriveWebdav {
  /** The setting: WebDAV is on (it listens only while on). */
  enabled: boolean
  /** The listener is up right now. */
  running: boolean
  port: number
  /** For a program on this PC. Windows' own client wants the https address below instead (it refuses a password over plain http). */
  localUrl: string
  tailnet: {
    /** Tailscale is running here and the owner is known. */
    available: boolean
    /** `tailscale serve` has an HTTPS address in front of the listener (tailnet only, never the public internet). */
    serving: boolean
    httpsPort: number
    /** Present while serving: what a device on the tailnet maps. */
    url?: string
  }
  devices: DriveDevice[]
  /** Why it is not running, when it should be. */
  error?: string
}

export interface DriveDeviceCreated {
  name: string
  /** Shown once. */
  password: string
}

/** A one-time code that pairs a sync device (shown on the Drive page; good once, until `expiresAt`). */
export interface DriveSyncPairing {
  name: string
  code: string
  expiresAt: number
}

/** What the sync program gets back when it hands in its code. */
export interface DriveSyncCredentials {
  name: string
  /** The device's own drive password. */
  password: string
}

// ---- the sync folder on THIS PC (inside the app) ---------------------------------------------------------------------------

/** What the last round of this PC's sync folder did. */
export interface DriveSyncReport {
  uploaded: number
  downloaded: number
  conflicts: number
  deletedLocal: number
  deletedRemote: number
  /** Deletes the brake is holding (nothing was deleted). */
  held: number
  /** Why the round stopped altogether, or null. */
  blocked: 'local-empty' | 'remote-empty' | 'local-missing' | null
  errors: { path: string; why: string }[]
}

/** GET /sync/local: the folder on this PC that is kept in step with the Common Drive (the hub's own, or a member PC's over the link). */
export interface DriveLocalSync {
  /** This PC can sync a folder right now. When not, `reason` says why (e.g. the hub can't be reached). */
  available: boolean
  reason?: string
  enabled: boolean
  /** The folder on this PC, or null until one is chosen. */
  folder: string | null
  /** A folder to suggest ("<home>/Common Drive"). */
  suggestedFolder: string
  state: 'off' | 'idle' | 'syncing' | 'offline' | 'blocked' | 'stopped'
  lastOkAt: number | null
  error: string | null
  report: DriveSyncReport | null
}
