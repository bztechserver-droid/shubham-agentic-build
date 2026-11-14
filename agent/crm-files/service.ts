import { Readable } from 'node:stream'
import {
  blockedKind,
  CRM_FILES_MAX_UPLOAD,
  CRM_FILES_REASONS,
  type CrmUploadKind,
  type CrmChildren,
  type CrmFilesErrorCode,
  type CrmFilesStatus,
  type CrmDriverChoice,
  type CrmMountStatus,
  type CrmReveal,
  type CrmNode,
  type CrmRights,
  type CrmSearch,
  type CrmSpoolEntry,
  type CrmVersion,
} from '../../shared/crm-files.ts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { createIgnoreRules, type IgnoreRules } from './ignore-rules.ts'
import { createRemovedIndex, type RemovedProject } from './removed.ts'
import { createSpool, type Spool } from './spool.ts'
import { versionToken, type PinItem } from './offline-pins.ts'
import { findFiles, type FindAsk, type FindResult } from './find.ts'
import type { PinsHost } from './pins-host.ts'
import type { CrmPinMark } from '../../shared/crm-files.ts'

// F-126: the CRM's files as a tree, for the page, for the Linux mount (in process) and for the Windows host's bridge. The CRM's own RECORDS decide what is a file and where it is
// (files, file_groups, file_versions), not the Google Drive folders. The tree is the one the old agentic-claude-manager drive built:
//   root -> one folder per `folder` tag of the CRM -> under "projects": one folder per project the person may open (and "Uncategorised") -> its file groups, nested -> files.
//   oe692: and "Marketing Projects" beside them, always: the projects whose CRM type is "marketing" sit there instead of under "projects".
// Every change goes through the CRM's own routes (new file, new version, rename, move, new folder); the bytes of a new file go to Google Drive the way the CRM's own pages send them
// (the short-lived token the CRM hands out, then a resumable upload), never with keys of ours. There is NO delete.

export class CrmFilesError extends Error {
  status: number
  code: CrmFilesErrorCode
  /** od0b1: what Google Drive answered when it refused (its status, and its reason word when it gave one), so the uploads can tell a busy Google from a refusal. */
  upstream?: { status: number; reason?: string }
  constructor(status: number, code: CrmFilesErrorCode, message: string, upstream?: { status: number; reason?: string }) {
    super(message)
    this.name = 'CrmFilesError'
    this.status = status
    this.code = code
    if (upstream) this.upstream = upstream
  }
}

/** What the service needs of the CRM: one call with the session attached (agentic/crmproxy.ts `request`), and who is signed in. */
export interface CrmClient {
  request(method: string, sub: string, init?: { json?: unknown; body?: string | Buffer; headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response>
  session(): { signedIn: boolean; name: string | null; username: string | null }
}

/** The mount side of a PC (Windows: the WinFsp host; Linux: the WebDAV + gvfs part). */
export interface MountDriver {
  status(): Promise<CrmMountStatus>
  start(): Promise<CrmMountStatus>
  stop(): Promise<CrmMountStatus>
  /** o6e65 (Windows): mount by itself while the CRM is signed in, or not. */
  setAuto?(on: boolean): Promise<CrmMountStatus>
  /** o6e65 (Windows): how the drive is made (WinFsp, Windows' built-in WebDAV, or automatic). */
  setDriver?(via: CrmDriverChoice): Promise<CrmMountStatus>
  /** S9b (Windows): "Save into the drive": the in-app drive takes saves (a save goes into the CRM), or not (the default). */
  setSaves?(on: boolean): Promise<CrmMountStatus>
  /** S2 (Windows): the drive letter: choose another free one (Y: by default). */
  setLetter?(letter: string): Promise<CrmMountStatus>
  /** S2 (Windows): the letter in use and the free ones. */
  letters?(): Promise<{ current: string; free: string[] }>
  /** o6e65 (Windows): open File Explorer on the drive, or on the waiting or recovered saves folder. Takes no path. */
  reveal?(what: CrmReveal): Promise<void>
}

export interface CrmFilesOptions {
  client: CrmClient
  mountDriver?: MountDriver
  /** Tests: the clock, and the fetch used for Google Drive (the CRM's own calls go through `client`). */
  now?: () => number
  fetch?: typeof fetch
  /** Tests: Google's addresses. */
  driveApi?: string
  driveUpload?: string
  /** How long a listing of the CRM is reused (ms). */
  ttlMs?: number
  /**
   * o6e65 (S5): where saves made through a drive are kept (spooled) until the CRM has them. Left out = no spool: a save through a drive goes to the CRM directly, as before. Tests give a made-up folder.
   */
  spoolDir?: string
  /** S5: the spool's own timings and cap (tests). */
  spool?: { retryMs?: number[]; maxBytes?: number; autoStart?: boolean; reconsiderMs?: number }
  /** S5: opens a folder in the PC's file manager (the "Open the folder" button). Left out = the button says it is not supported here. */
  openFolder?: (dir: string) => void
  log?: { info(m: string): void; warn(m: string): void }
  /** oa2f8: the most one file may be now (the uploads' settings: the CRM's own limit, or the person's number). Left out: CRM_FILES_MAX_UPLOAD. The one-request upload and the drive's saves follow it. */
  maxUpload?: () => number
  /**
   * o813f: how the bytes of a file are read. 'drive' (left out = this): a file over 100 MB (DRIVE_API_OVER) that the CRM keeps in Google Drive is read through Google's Drive API
   * (files.get alt=media with the CRM's own Drive token, in ranges), not through the public download link, which answers Google's virus-scan notice instead of such a file; every
   * other file through the CRM's own download, as before. 'crm': every file through the CRM's own download (GET /org/files/:id/raw), the way before o813f, kept as a setting
   * (index.ts: `downloadViaFile`, the file DOWNLOAD_VIA_CRM_FILE in the agent's state folder).
   */
  downloadVia?: () => 'drive' | 'crm'
  /** ocbbf: "Keep on this PC" (pins-host.ts). A getter: the host is made after the service. Left out: nothing is kept, and no node has a mark. */
  pins?: () => PinsHost | null
  /**
   * oe692: whether the drive has its "Marketing Projects" folder (left out = yes). At the top, beside "projects", it holds the CRM projects whose type is "marketing" (the CRM's
   * own project_type), and those are then not under "projects" as well. False = the way before oe692: every project under "projects" (index.ts: `marketingFolderFile`, the file
   * MARKETING_FOLDER_OFF_FILE in the agent's state folder).
   */
  marketingFolder?: () => boolean
}

/**
 * oe692 (Shubham, 14 Nov 2026: "one more folder in the mounted drive called Marketing Projects"): the drive's top folder for the CRM's marketing projects. It is always there
 * (empty when the CRM has none) and only shows what the CRM has: nothing is made, changed or removed in the CRM for it. New projects are made in the CRM; inside a project,
 * folders and files work as in any other project.
 */
export const MARKETING_FOLDER = 'Marketing Projects'
export const MARKETING_ID = `cat:${MARKETING_FOLDER}`

/** oe692: this file in the agent's state folder turns the Marketing Projects folder off (every project back under "projects", the way before). */
export const MARKETING_FOLDER_OFF_FILE = 'crm-marketing-folder.off'

/** oe692: the Marketing Projects setting as the agent reads it: off while MARKETING_FOLDER_OFF_FILE is in `dir` (looked at on every listing, so it takes effect at once). */
export function marketingFolderFile(dir: string): () => boolean {
  const file = path.join(dir, MARKETING_FOLDER_OFF_FILE)
  return () => !existsSync(file)
}

/** o813f: this file in the agent's state folder sends every download through the CRM's own (the way before o813f; a file over 100 MB fails there). */
export const DOWNLOAD_VIA_CRM_FILE = 'crm-download-via-crm.on'

/**
 * o813f (Lead, 12 Nov 2026): ONLY a record over this size (its fileSize in the CRM) is read through Google's Drive API; every other file goes through the CRM's own download, as before.
 * 100 MB in Google's own counting (100 × 1000 × 1000), so Google's virus-scan cut-off is covered.
 */
export const DRIVE_API_OVER = 100 * 1000 * 1000

/** o813f: the CRM's Drive token goes only to Google's API, over https (the pretend Google of the tests listens on 127.0.0.1). */
export function tokenMayGoTo(url: string): boolean {
  return /^https:\/\/www\.googleapis\.com\//.test(url) || /^http:\/\/127\.0\.0\.1:\d{1,5}\//.test(url)
}

/** o813f: the download setting as the agent reads it: 'crm' while DOWNLOAD_VIA_CRM_FILE is in `dir`, else 'drive' (looked at on every read, so it takes effect at once). */
export function downloadViaFile(dir: string): () => 'drive' | 'crm' {
  const file = path.join(dir, DOWNLOAD_VIA_CRM_FILE)
  return () => (existsSync(file) ? 'crm' : 'drive')
}

/**
 * o813f: the Google Drive id in a link the CRM keeps for a file, read the way the CRM's own download reads it (sam-crm-be fileController driveDirectUrl: drive.google.com/file/d/<id>,
 * drive.google.com/open|uc|thumbnail?id=<id>, lh<n>.googleusercontent.com/d/<id>; an id of 20 characters at least). Null for anything else, which is read through the CRM as before.
 */
export function driveIdOf(url: string): string | null {
  const m =
    /^https?:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{20,})/i.exec(url) ??
    /^https?:\/\/drive\.google\.com\/(?:open|uc|thumbnail)\?(?:[^#]*&)?id=([A-Za-z0-9_-]{20,})/i.exec(url) ??
    /^https?:\/\/lh\d\.googleusercontent\.com\/d\/([A-Za-z0-9_-]{20,})/i.exec(url)
  return m ? m[1] : null
}

/** o813f: what a download says when Google keeps a file back, or sends its notice instead of it, or stops. */
export const DOWNLOAD_WORDS = {
  harmful: 'Google Drive has marked this file as harmful (malware or spam), so it is not downloaded. That is Google’s decision; only the file’s owner can look at it, in Google Drive itself.',
  scanPage:
    'Google Drive sent its virus-scan notice instead of this file: a file over 100 MB does not come through the CRM’s own download, and the direct Google Drive way was not open for it here (for example, this account has no upload permission in the CRM).',
  broke: 'Google Drive stopped sending this file and did not go on from where it stopped. Try again.',
  notShown: 'The CRM does not show this file to this account (it may have been removed), so it is not read.',
} as const

/** o813f: Google's "can't scan this file for viruses" page, as the public link sends it in place of a file over 100 MB. */
const SCAN_NOTICE = /<title>[^<]*virus scan warning[^<]*<\/title>|can(?:'|&#39;|’)t scan this file for viruses/i

/**
 * od0b1: what the uploads in parts (uploads.ts) need of the CRM and of Google Drive: the same checks, the same key and folders, and the same record the one-request upload makes.
 * The session address `open` gives is a credential for that one upload: it is kept in the agent's own state folder, never logged and never shown to a page.
 */
export interface CrmUploadBackend {
  /** Checks a planned upload against the CRM now (throws CrmFilesError): rights, name, kind of file, a name already used. Gives the name and type the upload carries. */
  check(p: { kind: CrmUploadKind; target: string; name: string; type: string }): Promise<{ name: string; type: string }>
  /** Opens a resumable session in Google Drive for `size` bytes, in the CRM's folder for today, with the CRM's own key. */
  open(name: string, type: string, size: number): Promise<{ session: string; key: string; mime: string }>
  /**
   * All the bytes are in Google Drive (`driveId`, `url`): the CRM's sharing policy, then the CRM record (a new file into `target`, or a new version of the file `target`).
   * `lookFirst`: an earlier try may have landed without its answer reaching us, so the CRM is read first and a record with this key is taken as done (never a second one).
   * A new file whose name was taken meanwhile is recorded as "name (2).ext" and `savedAs` says so.
   * `share: false` (F-211's conversation copies): the CRM's "anyone with the link" policy is not applied to this file; left out, it is, as before.
   */
  finish(p: { kind: CrmUploadKind; target: string; name: string; type: string; size: number; key: string; driveId: string; url: string; lookFirst: boolean; share?: boolean }): Promise<{ node: CrmNode; savedAs?: string }>
  /** The fetch used for Google (the session's parts and questions go through it). */
  fetch: typeof fetch
  /**
   * oa2f8: the limit for one file that the CRM's own upload token answer said (`maxFileSize`), should the CRM ever add it there; null while it does not. NO request is made for it: it
   * is noted when the token is fetched anyway (an upload, a rights check). The agent puts no question of its own to the CRM (Lead, 11 Nov 2026: he approved real writes only).
   */
  crmLimit?(): number | null
}

/**
 * oa2f8: the CRM organisation of the account signed in on this PC (the first part of the CRM's file key, server-sided-s3/<org>/...), or null when the CRM does not say. GET org/me answers
 * { organization: { id } } (sam-crm-be orgController.getMyOrg; the CRM's own pages read it there); an older answer of v1/auth/me with { organization: { organizationId | id } } is read too.
 * The CRM's v1/auth/me of today answers { user } only: reading only that broke every upload against the real CRM (found by the first real upload, 11 Nov 2026).
 * Throws what the client throws (not signed in, no answer).
 */
export async function readOrgId(client: Pick<CrmClient, 'request'>): Promise<string | null> {
  const idOf = (j: unknown): string | null => {
    const o = typeof j === 'object' && j !== null ? (j as { organization?: unknown }).organization : null
    if (typeof o !== 'object' || o === null) return null
    const { id, organizationId } = o as { id?: unknown; organizationId?: unknown }
    const v = typeof organizationId === 'string' && organizationId ? organizationId : typeof id === 'string' && id ? id : null
    // It becomes a folder name and a part of the key: nothing but a plain id.
    return v && /^[A-Za-z0-9_-]{1,80}$/.test(v) ? v : null
  }
  for (const sub of ['org/me', 'v1/auth/me']) {
    const r = await client.request('GET', sub)
    if (!r.ok) {
      await r.body?.cancel().catch(() => undefined)
      continue
    }
    const id = idOf(await r.json().catch(() => null))
    if (id) return id
  }
  return null
}

/** oa2f8: the CRM's limit in its own words ("file_size must not exceed 524288000 bytes (500 MB)"), or null. */
export function crmLimitFrom(text: string): number | null {
  const m = /must not exceed (\d{1,16}) bytes/i.exec(text)
  const n = m ? Number(m[1]) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

export interface CrmFilesService {
  status(): Promise<CrmFilesStatus>
  children(id: string): Promise<CrmChildren>
  node(id: string): Promise<CrmNode>
  /**
   * The bytes of a file, streamed; the caller pipes `stream` and must destroy it if the reader goes away. o813f: a file over 100 MB in Google Drive comes through Google's Drive API once
   * the CRM has said yes for it (a break in the line goes on from where it stopped); anything else, or what the API does not give, through the CRM's own download (/org/files/:id/raw).
   */
  file(id: string): Promise<{ stream: Readable; size: number | null; type: string; name: string }>
  /**
   * S9a: bytes [start, start + length) of a file by ONE ranged request (fewer only at the end of the file, none past it). For the in-app WinFsp drive. o813f: a file over 100 MB in Google
   * Drive is asked of Google's Drive API once the CRM has said yes for it; anything else of the CRM (a CRM that ignores the range is read and cut).
   */
  fileBytes(id: string, start: number, length: number): Promise<Buffer>
  versions(id: string): Promise<CrmVersion[]>
  /** P1: files and projects whose name holds `q` (2 characters at least), at most `limit` (200). */
  search(q: string, limit: number): Promise<CrmSearch>
  /** o528e: the chat's crm_files tool (find.ts): files by the words of their name, project and folder, and by their kind. Read only. */
  find(ask: FindAsk): Promise<FindResult>
  /**
   * S5: a save made through a drive: the bytes are kept on this PC (the spool) and this returns at once; they go up in the background. It checks the rights first (a save the CRM would refuse is
   * refused now, not accepted and then parked). `target` = a CRM file to save over as a NEW VERSION; without it, a new file in the folder `parent`. Null when this agent keeps no spool.
   */
  save: ((a: { parent: string; name: string; type: string; target?: string | null; body?: Readable; /** S9b: a finished file moved into the spool instead of a stream. */ from?: string; size: number }) => Promise<{ how: 'new' | 'version'; entry: CrmSpoolEntry }>) | null
  /** S5: the saves kept on this PC until the CRM has them (null when there is no spool). */
  spool: Spool | null
  /** S6: the projects whose access was removed (null when there is no spool). */
  lostAccess: { list(): RemovedProject[]; dismiss(id: string): boolean } | null
  /** ocbbf: "Keep on this PC" (null when this agent keeps none). */
  readonly keep: PinsHost | null
  /** ocbbf: the whole accessible tree for the copies: every folder (projects, groups, Uncategorised) and every file, with its version and size. */
  pinTree(): Promise<PinItem[]>
  /** S7: the .driveignore rules (null when there is no spool). `defaults`: the built-in list of editor and system files (~$*, *.tmp, Thumbs.db, desktop.ini, .DS_Store, node_modules, *.crdownload) is on (the default). */
  ignore: { defaults(): boolean; setDefaults(on: boolean): void; rules: IgnoreRules } | null
  upload(parent: string, name: string, type: string, stream: Readable, size: number): Promise<CrmNode>
  version(id: string, name: string, type: string, stream: Readable, size: number): Promise<CrmNode>
  folder(parent: string, name: string): Promise<CrmNode>
  rename(id: string, name: string): Promise<CrmNode>
  move(id: string, to: string): Promise<CrmNode>
  mount: MountDriver
  /** od0b1: for the uploads in parts (uploads.ts); not a route. */
  uploadBackend: CrmUploadBackend
}

// ---- what the CRM sends -------------------------------------------------------------------------------------------------

interface RawFile {
  id: string
  fileName: string
  fileKey: string
  fileUrl: string
  fileType: string | null
  fileSize: number | null
  folder: string
  groupId: string | null
  source: string
  createdAt: string | null
  updatedAt: string | null
  versions: number | null
}

interface RawProject {
  id: string
  name: string
  /** oe692: the CRM's project_type is "marketing" (its Projects page labels it so). */
  marketing: boolean
  writable: boolean
  createdAt: string | null
}

interface RawGroup {
  id: string
  name: string
  parentId: string | null
  createdAt: string | null
}

interface Snapshot {
  at: number
  files: RawFile[]
  projects: Map<string, RawProject>
  org: string | null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const iso = (v: unknown): string | null => {
  const s = text(v)
  return s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null
}

const NO: CrmRights = { open: true, upload: false, mkdir: false, rename: false, move: false, version: false }
const UNCATEGORISED = 'proj:none'

/** A name a person gives: no path parts, no control characters, not empty, not too long. */
export function badName(name: string): string | null {
  const n = name.trim()
  if (!n) return 'A name can not be empty.'
  if (n.length > 255) return 'A name is at most 255 characters.'
  if (n === '.' || n === '..') return 'That is not a name.'
  // eslint-disable-next-line no-control-regex
  if (/[\\/\u0000-\u001f\u007f]/.test(n)) return 'A name can not hold / or \\ or control characters.'
  return null
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Drive's file id in a link the CRM stored, or null (a link to some other website, a .url file). */
function isDriveLink(url: string): boolean {
  return /^https:\/\/(drive|docs)\.google\.com\//i.test(url)
}

export function createCrmFiles(o: CrmFilesOptions): CrmFilesService {
  const now = o.now ?? Date.now
  const ttl = o.ttlMs ?? 10_000
  const gfetch = o.fetch ?? fetch
  // S6: the projects whose access was removed, kept next to the spool.
  const removedIndex = o.spoolDir ? createRemovedIndex({ file: path.join(path.dirname(o.spoolDir), 'crm-removed-projects.json'), now, log: o.log }) : null
  const driveApi = o.driveApi ?? 'https://www.googleapis.com/drive/v3'
  const driveUpload = o.driveUpload ?? 'https://www.googleapis.com/upload/drive/v3'
  const client = o.client

  const noMount: MountDriver = {
    status: async () => ({ supported: false, driver: 'unsupported', driverName: '', running: false, mounted: false, where: '', reason: CRM_FILES_REASONS.unsupported, reasonCode: 'unsupported', installable: false, writable: true, waiting: 0 }),
    start: async () => noMount.status(),
    stop: async () => noMount.status(),
  }
  const baseMount = o.mountDriver ?? noMount
  let spool: Spool | null = null

  // ---- talking to the CRM ----------------------------------------------------------------------------------------------

  /** A CRM answer that is not good, as the error the caller sees. The CRM's own words are kept short and carry no credential. */
  async function refusal(r: Response, what: string): Promise<CrmFilesError> {
    let why = ''
    try {
      const b: unknown = await r.json()
      if (isObject(b)) why = text(b.error) || text(b.message)
    } catch {
      // no body
    }
    why = why.replace(/\s+/g, ' ').slice(0, 160)
    if (r.status === 401) return new CrmFilesError(409, 'crm-signin', CRM_FILES_REASONS.signedOut)
    if (r.status === 403) return new CrmFilesError(403, 'forbidden', `The CRM does not allow ${what}${why ? `: ${why}` : '.'}`)
    if (r.status === 404) return new CrmFilesError(404, 'notfound', `The CRM has no such ${what}.`)
    if (r.status === 409 || r.status === 422) return new CrmFilesError(409, 'conflict', `The CRM did not accept ${what}${why ? `: ${why}` : '.'}`)
    if (r.status >= 500) return new CrmFilesError(502, 'crm-down', CRM_FILES_REASONS.crmDown)
    return new CrmFilesError(400, 'failed', `The CRM refused ${what} (${r.status})${why ? `: ${why}` : ''}.`)
  }

  async function call(method: string, sub: string, what: string, init?: { json?: unknown; signal?: AbortSignal }): Promise<Response> {
    let r: Response
    try {
      r = await client.request(method, sub, init)
    } catch (e) {
      if ((e as Error)?.name === 'CrmNotSignedIn') throw new CrmFilesError(409, 'crm-signin', CRM_FILES_REASONS.signedOut)
      throw new CrmFilesError(502, 'crm-down', CRM_FILES_REASONS.crmDown)
    }
    if (!r.ok) throw await refusal(r, what)
    return r
  }

  const getJson = async (sub: string, what: string): Promise<unknown> => (await call('GET', sub, what)).json().catch(() => null) as Promise<unknown>

  // ---- the listing, reused for a few seconds ---------------------------------------------------------------------------

  let snap: Snapshot | null = null
  let loading: Promise<Snapshot> | null = null
  let lastWrite: boolean | null = null
  let upload: { ok: boolean | null; at: number } = { ok: null, at: 0 }
  const groupCache = new Map<string, { at: number; groups: RawGroup[] }>()

  function invalidate(project?: string) {
    snap = null
    if (project) groupCache.delete(project)
    else groupCache.clear()
  }

  async function load(): Promise<Snapshot> {
    if (snap && now() - snap.at < ttl) return snap
    loading ??= (async () => {
      // Who may write at all (the CRM's hierarchy grant); a failed call keeps the last answer rather than turning everything read-only for one slow reply.
      let writeCapable = lastWrite ?? false
      try {
        const a = await getJson('org/hierarchy-access/me', 'your access')
        if (isObject(a)) {
          writeCapable = a.isFullAccess === true || (a.canCreate === true && a.canUpdate === true)
          lastWrite = writeCapable
        }
      } catch (e) {
        if (e instanceof CrmFilesError && (e.code === 'crm-signin')) throw e
      }
      const pj = await getJson('org/projects', 'the projects')
      const arr = Array.isArray(pj) ? pj : isObject(pj) && Array.isArray(pj.projects) ? pj.projects : null
      if (!arr) throw new CrmFilesError(502, 'crm-down', CRM_FILES_REASONS.crmDown)
      const projects = new Map<string, RawProject>()
      for (const e of arr) {
        if (!isObject(e) || e.canOpen === false) continue
        const id = text(e.id)
        const name = text(e.name)
        if (!id || !name) continue
        const at = text(e.accessType)
        const marketing = text(e.projectType ?? e.project_type).trim().toLowerCase() === 'marketing'
        projects.set(id, { id, name, marketing, writable: writeCapable && (at === 'manager' || at === 'hierarchy'), createdAt: iso(e.createdAt) })
      }
      const fl = await getJson('org/files?all=true', 'the files')
      const list = isObject(fl) && Array.isArray(fl.files) ? fl.files : null
      if (!list) throw new CrmFilesError(502, 'crm-down', CRM_FILES_REASONS.crmDown)
      const files: RawFile[] = []
      for (const f of list) {
        if (!isObject(f) || f.isDisabled === true) continue
        const id = text(f.id)
        if (!id) continue
        const source = text(f.source)
        const pid = source.startsWith('project:') ? source.slice('project:'.length) : ''
        // A file tied to a project the person can not open is not shown, whatever its category.
        if (pid && !projects.has(pid)) continue
        files.push({
          id,
          fileName: text(f.fileName) || text(f.fileKey).split('/').pop() || id,
          fileKey: text(f.fileKey),
          fileUrl: text(f.fileUrl),
          fileType: text(f.fileType) || null,
          fileSize: num(f.fileSize),
          folder: text(f.folder).trim() || 'Files',
          groupId: text(f.groupId) || null,
          source,
          createdAt: iso(f.createdAt),
          updatedAt: iso(f.updatedAt) ?? iso(f.modifiedAt),
          versions: num(f.versionCount) ?? num(f.currentVersion),
        })
      }
      const s: Snapshot = { at: now(), files, projects, org: snap?.org ?? null }
      // S6: a project the CRM used to list and no longer does (twice, 30 s apart) has its access removed; one that is listed again is back, and its refused saves say so.
      for (const pid of removedIndex?.observe([...projects.values()].map(p => ({ id: p.id, name: p.name }))).returned ?? []) spool?.noteProject(pid, 'Access to this project came back. It is kept here and was not sent by itself: press Try again to send it.')
      snap = s
      return s
    })().finally(() => (loading = null))
    return loading
  }

  async function groupsOf(pid: string): Promise<RawGroup[]> {
    const hit = groupCache.get(pid)
    if (hit && now() - hit.at < 60_000) return hit.groups
    const g = await getJson(`org/file-groups?projectId=${encodeURIComponent(pid)}`, 'the folders of this project')
    const arr = Array.isArray(g) ? g : isObject(g) && Array.isArray(g.groups) ? g.groups : null
    if (!arr) throw new CrmFilesError(502, 'crm-down', CRM_FILES_REASONS.crmDown)
    const groups: RawGroup[] = []
    for (const e of arr) {
      if (!isObject(e) || e.isDisabled === true) continue
      const id = text(e.id)
      const name = text(e.name)
      if (id && name) groups.push({ id, name, parentId: text(e.parentId) || null, createdAt: iso(e.createdAt) })
    }
    groupCache.set(pid, { at: now(), groups })
    return groups
  }

  /** Whether this person may upload at all: the CRM answers 403 to the token request of someone who may not. A failed call keeps the last answer. */
  async function mayUpload(): Promise<boolean> {
    if (upload.ok !== null && now() - upload.at < 60_000) return upload.ok
    try {
      await driveToken()
      upload = { ok: true, at: now() }
    } catch (e) {
      if (e instanceof CrmFilesError && e.code === 'forbidden') upload = { ok: false, at: now() }
      else if (upload.ok === null) upload = { ok: false, at: now() - 50_000 }
    }
    return upload.ok === true
  }

  // ---- the tree --------------------------------------------------------------------------------------------------------

  const catId = (tag: string) => `cat:${tag}`
  const projId = (pid: string) => `proj:${pid}`
  const grpId = (pid: string, gid: string) => `grp:${pid}:${gid}`
  const fileId = (id: string) => `file:${id}`

  const ROOT: CrmNode = { id: 'root', kind: 'root', name: 'CRM files', parentId: null, isFolder: true, rights: NO }

  // ocbbf (Web, 12 Nov, v2): about half the CRM's files have no size on record (an old bulk import: fileSize null). Their size is read as Google Drive's METADATA
  // (files.get fields=size, with the CRM's own Drive token, as the >100 MB download already does), never as bytes: the CRM's /raw ignores a Range and fetches the
  // whole file first (sam-crm-be fileController serveFileRaw). Lazy: only for the folder being listed, at most 3 asks at once, cached per file id and fileKey,
  // a failed ask is not repeated for 10 minutes. No Drive link, no token, or no answer: the size stays unknown (no size is shown, never 0 bytes from us).
  const driveSizes = new Map<string, { key: string; size: number }>()
  const driveSizeMiss = new Map<string, { key: string; at: number }>()
  const SIZE_AT_ONCE = 3
  const SIZE_MISS_MS = 10 * 60 * 1000
  let sizeSlots = 0
  const sizeWaiting: (() => void)[] = []
  const sizing = new Map<string, Promise<void>>()
  const sizeOf = (f: RawFile): number | null => {
    if (f.fileSize !== null) return f.fileSize
    const hit = driveSizes.get(f.id)
    return hit && hit.key === f.fileKey ? hit.size : null
  }
  /** Google's metadata for one Drive file: its size, or null. Only fields=size is asked (never alt=media: no bytes are read). */
  async function driveSizeOf(driveId: string): Promise<number | null> {
    if (!tokenMayGoTo(`${driveApi}/`)) return null
    const t = await driveToken()
    const res = await gfetch(`${driveApi}/files/${encodeURIComponent(driveId)}?fields=size&supportsAllDrives=true`, { headers: { authorization: `Bearer ${t.accessToken}` } })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return null
    }
    const j = (await res.json().catch(() => null)) as { size?: unknown } | null
    const size = Number(j?.size)
    return j !== null && j.size !== undefined && Number.isSafeInteger(size) && size >= 0 ? size : null
  }
  function sizeAsk(f: RawFile): Promise<void> {
    const running = sizing.get(f.id)
    if (running) return running
    const miss = driveSizeMiss.get(f.id)
    if (miss && miss.key === f.fileKey && now() - miss.at < SIZE_MISS_MS) return Promise.resolve()
    const driveId = driveIdOf(f.fileUrl)
    if (!driveId) return Promise.resolve()
    const run = (async () => {
      while (sizeSlots >= SIZE_AT_ONCE) await new Promise<void>(r => sizeWaiting.push(r))
      sizeSlots++
      try {
        const size = await driveSizeOf(driveId)
        if (size === null) driveSizeMiss.set(f.id, { key: f.fileKey, at: now() })
        else driveSizes.set(f.id, { key: f.fileKey, size })
      } catch {
        driveSizeMiss.set(f.id, { key: f.fileKey, at: now() })
      } finally {
        sizeSlots--
        sizeWaiting.shift()?.()
      }
    })().finally(() => sizing.delete(f.id))
    sizing.set(f.id, run)
    return run
  }
  /** Asks for the sizes of the files of one folder that have none on record: waits for them at most `budgetMs`; the rest go on in the background (the next listing has them). */
  async function learnSizes(files: RawFile[], budgetMs = 1500): Promise<void> {
    const todo = files.filter(f => sizeOf(f) === null)
    if (todo.length === 0) return
    const all = Promise.all(todo.map(f => sizeAsk(f)))
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([all, new Promise<void>(r => { timer = setTimeout(r, budgetMs) })])
    clearTimeout(timer)
  }

  function fileNode(f: RawFile, parentId: string, writable: boolean, mayUp: boolean): CrmNode {
    const size = sizeOf(f)
    return {
      id: fileId(f.id),
      kind: 'file',
      name: f.fileName,
      parentId,
      isFolder: false,
      ...(size !== null ? { size } : {}),
      ...(f.fileType ? { type: f.fileType } : {}),
      ...(f.createdAt ? { createdAt: f.createdAt } : {}),
      ...((f.updatedAt ?? f.createdAt) ? { modifiedAt: (f.updatedAt ?? f.createdAt) as string } : {}),
      ...(f.versions !== null ? { versions: f.versions } : {}),
      rights: { open: true, upload: false, mkdir: false, rename: writable, move: writable, version: writable && mayUp && isDriveLink(f.fileUrl) },
    }
  }

  // ---- oe692: the Marketing Projects folder ---------------------------------------------------------------------------------
  const marketingOn = (): boolean => o.marketingFolder?.() ?? true
  /** The top folder a project sits in on the drive: "Marketing Projects" for a marketing project (while that folder is on), else "projects". */
  const homeOf = (p: RawProject): { id: string; name: string } => (p.marketing && marketingOn() ? { id: MARKETING_ID, name: MARKETING_FOLDER } : { id: catId('projects'), name: 'projects' })
  /** A CRM category (a file's `folder` tag) with the folder's own name, in any case, is shown inside it rather than as a second top folder of the same name. */
  const isMarketingTag = (tag: string): boolean => marketingOn() && tag.toLowerCase() === MARKETING_FOLDER.toLowerCase()
  /** The node a category's files sit in. */
  const catOf = (tag: string): string => (isMarketingTag(tag) ? MARKETING_ID : catId(tag))

  function projectNode(p: RawProject, count: number, mayUp: boolean): CrmNode {
    return {
      id: projId(p.id),
      kind: 'project',
      name: p.name,
      parentId: homeOf(p).id,
      isFolder: true,
      ...(p.createdAt ? { createdAt: p.createdAt } : {}),
      childCount: count,
      rights: { ...NO, upload: p.writable && mayUp, mkdir: p.writable },
    }
  }

  function groupNode(p: RawProject, g: RawGroup, parent: string, count: number, mayUp: boolean): CrmNode {
    return {
      id: grpId(p.id, g.id),
      kind: 'group',
      name: g.name,
      parentId: parent,
      isFolder: true,
      ...(g.createdAt ? { createdAt: g.createdAt } : {}),
      childCount: count,
      rights: { ...NO, upload: p.writable && mayUp, mkdir: p.writable, rename: p.writable },
    }
  }

  const byName = (a: CrmNode, b: CrmNode) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id)

  const pidOf = (f: RawFile) => (f.source.startsWith('project:') ? f.source.slice('project:'.length) : '')

  /** Where a file sits inside the projects category: its group (when that group is one of the project's), else the project, else Uncategorised. */
  function placeOf(f: RawFile, groups: Map<string, RawGroup[]>): { parent: string; pid: string | null } {
    const pid = pidOf(f)
    if (f.folder !== 'projects') return { parent: catOf(f.folder), pid: null }
    if (!pid) return { parent: UNCATEGORISED, pid: null }
    const g = f.groupId ? groups.get(pid)?.find(x => x.id === f.groupId) : undefined
    return { parent: g ? grpId(pid, g.id) : projId(pid), pid }
  }

  // ---- S6: the "Access removed" folder: one folder per project the CRM stopped listing, holding what is still on this PC for it (saves that never reached the CRM) and a README. Read only.
  const GONE_ROOT = 'gone:root'
  const GONE_NAME = 'Access removed'
  const readmeText = (name: string) =>
    `Access to the project "${name}" was removed in the CRM (the CRM no longer lists it for your account).\r\n\r\nThis folder holds what is still on this PC for it: saves made through the drive that never reached the CRM. Nothing here is deleted.\r\n\r\nOn the CRM files page, Dismiss forgets this folder (the saves stay kept on this PC). If access comes back, the project returns to its place and these saves are offered again: you press Try again to send them.\r\n`
  const keptFor = (pid: string): CrmSpoolEntry[] => spool?.forProject(pid) ?? []
  const goneRootNode = (n: number): CrmNode => ({ id: GONE_ROOT, kind: 'category', name: GONE_NAME, parentId: 'root', isFolder: true, childCount: n, rights: NO })
  const goneIso = (ms: number) => new Date(ms).toISOString()
  const readmeNode = (p: RemovedProject): CrmNode => ({ id: `gone:readme:${p.id}`, kind: 'file', name: 'README.txt', parentId: `gone:${p.id}`, isFolder: false, size: Buffer.byteLength(readmeText(p.name)), type: 'text/plain', createdAt: goneIso(p.since), modifiedAt: goneIso(p.since), versions: 1, rights: NO })
  const keptNode = (e: CrmSpoolEntry, pid: string): CrmNode => ({ id: `kept:${e.id}`, kind: 'file', name: e.name, parentId: `gone:${pid}`, isFolder: false, size: e.size, type: 'application/octet-stream', createdAt: e.since, modifiedAt: e.since, versions: 1, rights: NO })

  // ocbbf: the copies kept on this PC for a project whose access was removed (pins-host.ts), listed beside its saves; read in place from the copy.
  const keptPinsFor = (pid: string): { id: string; name: string; cachePath: string; size: number }[] => o.pins?.()?.keptFor(pid) ?? []
  const keptPinNode = (k: { id: string; name: string; size: number }, pid: string, since: number): CrmNode => ({ id: `kept:pin:${k.id}`, kind: 'file', name: k.name, parentId: `gone:${pid}`, isFolder: false, size: k.size, type: 'application/octet-stream', createdAt: goneIso(since), modifiedAt: goneIso(since), versions: 1, rights: NO })

  async function goneChildren(id: string): Promise<{ node: CrmNode; children: CrmNode[]; path: { id: string; name: string }[] }> {
    const gone = removedIndex?.list() ?? []
    const crumbs = [{ id: 'root', name: ROOT.name }, { id: GONE_ROOT, name: GONE_NAME }]
    if (id === GONE_ROOT) {
      if (gone.length === 0) throw new CrmFilesError(404, 'notfound', 'There is no such folder.')
      const kids = gone.map((p): CrmNode => ({ id: `gone:${p.id}`, kind: 'project', name: p.name, parentId: GONE_ROOT, isFolder: true, childCount: 1 + keptFor(p.id).length + keptPinsFor(p.id).length, createdAt: goneIso(p.since), rights: NO }))
      return { node: goneRootNode(kids.length), children: kids.sort(byName), path: crumbs.slice(0, 2) }
    }
    if (id.startsWith('gone:readme:') || id.startsWith('kept:')) throw new CrmFilesError(400, 'failed', 'That is a file, not a folder.')
    const pid = id.slice('gone:'.length)
    const p = gone.find(x => x.id === pid)
    if (!p) throw new CrmFilesError(404, 'notfound', 'That project is not in the Access removed folder.')
    const kids = [readmeNode(p), ...keptFor(pid).map(e => keptNode(e, pid)), ...keptPinsFor(pid).map(k => keptPinNode(k, pid, p.since))]
    const node: CrmNode = { id, kind: 'project', name: p.name, parentId: GONE_ROOT, isFolder: true, childCount: kids.length, createdAt: goneIso(p.since), rights: NO }
    return { node, children: kids.sort(byName), path: [...crumbs, { id, name: p.name }] }
  }

  /** A file of the Access removed folder: its node and where its bytes are. */
  function goneFile(id: string): { node: CrmNode; bytes?: Buffer; path?: string } | null {
    if (id.startsWith('gone:readme:')) {
      const p = (removedIndex?.list() ?? []).find(x => x.id === id.slice('gone:readme:'.length))
      return p ? { node: readmeNode(p), bytes: Buffer.from(readmeText(p.name), 'utf8') } : null
    }
    if (id.startsWith('kept:pin:')) {
      for (const p of removedIndex?.list() ?? []) {
        const k = keptPinsFor(p.id).find(x => `kept:pin:${x.id}` === id)
        if (k) return { node: keptPinNode(k, p.id, p.since), path: k.cachePath }
      }
      return null
    }
    if (id.startsWith('kept:')) {
      for (const p of removedIndex?.list() ?? []) {
        const e = keptFor(p.id).find(x => `kept:${x.id}` === id)
        const f = e ? spool?.fileOf(e.id) : null
        if (e && f) return { node: keptNode(e, p.id), path: f.path }
      }
    }
    return null
  }

  // ocbbf: the folders a node sits in, from its parent up (a group, then its groups, then the project); what "Keep on this PC" inherits from.
  async function chainOf(parentId: string | null): Promise<string[]> {
    const out: string[] = []
    let cur: string | null = parentId
    while (cur && cur.startsWith('grp:')) {
      const [, pid, gid] = cur.split(':')
      out.push(cur)
      const g = (await groupsOf(pid)).find(x => x.id === gid)
      cur = g ? (g.parentId ? grpId(pid, g.parentId) : projId(pid)) : null
    }
    if (cur && cur.startsWith('proj:')) out.push(cur)
    return out
  }

  /** ocbbf: the "Keep on this PC" mark of each project, group and file in a listing (none for categories, the Access removed folder and the drive's own rows). */
  async function withPins(r: { node: CrmNode; children: CrmNode[]; path: { id: string; name: string }[] }) {
    const keep = o.pins?.() ?? null
    if (!keep) return r
    const chains = new Map<string, string[]>()
    for (const n of [r.node, ...r.children]) {
      if (!n.parentId || !/^(file|proj|grp):/.test(n.id)) continue
      if (!chains.has(n.parentId)) chains.set(n.parentId, await chainOf(n.parentId))
      const mark: CrmPinMark | null = keep.markOf(n.id, chains.get(n.parentId)!)
      if (mark) n.pin = mark
    }
    return r
  }

  /** ocbbf: the whole accessible tree for the copies (every project, group and Uncategorised as a folder; every file with its version and size). */
  async function pinTree(): Promise<PinItem[]> {
    const s = await load()
    const items: PinItem[] = [{ id: UNCATEGORISED, kind: 'folder', parentId: null, name: 'Uncategorised' }]
    const gmap = new Map<string, RawGroup[]>()
    for (const p of s.projects.values()) {
      items.push({ id: projId(p.id), kind: 'folder', parentId: null, name: p.name })
      const groups = await groupsOf(p.id)
      gmap.set(p.id, groups)
      for (const g of groups) items.push({ id: grpId(p.id, g.id), kind: 'folder', parentId: g.parentId ? grpId(p.id, g.parentId) : projId(p.id), name: g.name })
    }
    for (const f of s.files) {
      const size = sizeOf(f)
      const modifiedAt = f.updatedAt ?? f.createdAt
      items.push({ id: fileId(f.id), kind: 'file', parentId: placeOf(f, gmap).parent, name: f.fileName, size, version: versionToken({ fileKey: f.fileKey, modifiedAt, size, versions: f.versions }) })
    }
    return items
  }

  async function childrenOf(id: string): Promise<{ node: CrmNode; children: CrmNode[]; path: { id: string; name: string }[] }> {
    if (id.startsWith('gone:') || id.startsWith('kept:')) return goneChildren(id)
    const s = await load()
    const mayUp = s.projects.size > 0 && [...s.projects.values()].some(p => p.writable) ? await mayUpload() : false
    const crumbs: { id: string; name: string }[] = [{ id: 'root', name: ROOT.name }]

    // oe692: the projects of each top folder ("projects", "Marketing Projects"), and the files of a category shown inside Marketing Projects.
    const homed = (home: string) => [...s.projects.values()].filter(p => homeOf(p).id === home)
    const marketingFiles = () => s.files.filter(f => isMarketingTag(f.folder))

    if (id === 'root') {
      const tags = new Set<string>(['projects'])
      for (const f of s.files) if (!isMarketingTag(f.folder)) tags.add(f.folder)
      const kids = [...tags].map((t): CrmNode => ({
        id: catId(t),
        kind: 'category',
        name: t,
        parentId: 'root',
        isFolder: true,
        childCount: t === 'projects' ? homed(catId('projects')).length + (s.files.some(f => f.folder === 'projects' && !pidOf(f)) ? 1 : 0) : s.files.filter(f => f.folder === t).length,
        rights: NO,
      }))
      // oe692: always there while it is on, even with nothing in it yet.
      if (marketingOn()) kids.push({ id: MARKETING_ID, kind: 'category', name: MARKETING_FOLDER, parentId: 'root', isFolder: true, childCount: homed(MARKETING_ID).length + marketingFiles().length, rights: NO })
      const gone = removedIndex?.list() ?? []
      if (gone.length > 0) kids.push(goneRootNode(gone.length))
      return { node: { ...ROOT, childCount: kids.length }, children: kids.sort(byName), path: crumbs }
    }

    const [kind, ...rest] = id.split(':')
    if (kind === 'cat') {
      const tag = rest.join(':')
      const counts = () => {
        const n = new Map<string, number>()
        for (const f of s.files) {
          const pid = f.folder === 'projects' ? pidOf(f) : ''
          if (pid) n.set(pid, (n.get(pid) ?? 0) + 1)
        }
        return n
      }
      if (tag === 'projects') {
        const n = counts()
        const loose = s.files.filter(f => f.folder === 'projects' && !pidOf(f)).length
        const kids = homed(catId('projects')).map(p => projectNode(p, n.get(p.id) ?? 0, mayUp))
        if (loose > 0) kids.push({ id: UNCATEGORISED, kind: 'project', name: 'Uncategorised', parentId: catId('projects'), isFolder: true, childCount: loose, rights: NO })
        const node: CrmNode = { id, kind: 'category', name: 'projects', parentId: 'root', isFolder: true, childCount: kids.length, rights: NO }
        return { node, children: kids.sort(byName), path: [...crumbs, { id, name: 'projects' }] }
      }
      if (isMarketingTag(tag)) {
        // oe692: the CRM's marketing projects, and the files of a CRM category of the same name. Read only at this level (no upload, no new folder, no rename, no move):
        // new projects are made in the CRM; inside a project everything works as in any other project.
        const n = counts()
        const loose = marketingFiles()
        await learnSizes(loose)
        const kids = [...homed(MARKETING_ID).map(p => projectNode(p, n.get(p.id) ?? 0, mayUp)), ...loose.map(f => fileNode(f, MARKETING_ID, false, false))]
        const node: CrmNode = { id: MARKETING_ID, kind: 'category', name: MARKETING_FOLDER, parentId: 'root', isFolder: true, childCount: kids.length, rights: NO }
        return { node, children: kids.sort(byName), path: [...crumbs, { id: MARKETING_ID, name: MARKETING_FOLDER }] }
      }
      const mine = s.files.filter(f => f.folder === tag)
      if (mine.length === 0 && !s.files.some(f => f.folder === tag)) throw new CrmFilesError(404, 'notfound', 'There is no such folder.')
      const node: CrmNode = { id, kind: 'category', name: tag, parentId: 'root', isFolder: true, childCount: mine.length, rights: NO }
      await learnSizes(mine)
      return { node, children: mine.map(f => fileNode(f, id, false, false)).sort(byName), path: [...crumbs, { id, name: tag }] }
    }

    if (kind === 'proj' && rest.join(':') === 'none') {
      const mine = s.files.filter(f => f.folder === 'projects' && !pidOf(f))
      const node: CrmNode = { id: UNCATEGORISED, kind: 'project', name: 'Uncategorised', parentId: catId('projects'), isFolder: true, childCount: mine.length, rights: NO }
      await learnSizes(mine)
      return { node, children: mine.map(f => fileNode(f, UNCATEGORISED, false, false)).sort(byName), path: [...crumbs, { id: catId('projects'), name: 'projects' }, { id, name: 'Uncategorised' }] }
    }

    if (kind === 'proj' || kind === 'grp') {
      const pid = rest[0]
      const gid = kind === 'grp' ? rest[1] : null
      const p = s.projects.get(pid)
      if (!p) throw new CrmFilesError(404, 'notfound', 'That project is not there, or you may not open it.')
      const groups = await groupsOf(pid)
      const gmap = new Map([[pid, groups]])
      const here = gid ? groups.find(g => g.id === gid) : undefined
      if (gid && !here) throw new CrmFilesError(404, 'notfound', 'That folder is not there.')
      const kidsGroups = groups.filter(g => (gid ? g.parentId === gid : !g.parentId || !groups.some(x => x.id === g.parentId)))
      const filesHere = s.files.filter(f => f.folder === 'projects' && pidOf(f) === pid && placeOf(f, gmap).parent === id)
      const countIn = (g: RawGroup) => s.files.filter(f => pidOf(f) === pid && f.groupId === g.id).length + groups.filter(x => x.parentId === g.id).length
      await learnSizes(filesHere)
      const kids = [
        ...kidsGroups.map(g => groupNode(p, g, id, countIn(g), mayUp)),
        ...filesHere.map(f => fileNode(f, id, p.writable, mayUp)),
      ].sort(byName)
      const path: { id: string; name: string }[] = [...crumbs, homeOf(p), { id: projId(pid), name: p.name }]
      const chain: RawGroup[] = []
      for (let g = here; g; g = g.parentId ? groups.find(x => x.id === g!.parentId) : undefined) chain.unshift(g)
      for (const g of chain) path.push({ id: grpId(pid, g.id), name: g.name })
      const node = here
        ? groupNode(p, here, here.parentId ? grpId(pid, here.parentId) : projId(pid), kids.length, mayUp)
        : projectNode(p, kids.length, mayUp)
      return { node, children: kids, path }
    }

    if (kind === 'file') throw new CrmFilesError(400, 'failed', 'That is a file, not a folder.')
    throw new CrmFilesError(404, 'notfound', 'There is no such node.')
  }

  async function findFile(id: string): Promise<{ f: RawFile; node: CrmNode; project: RawProject | null }> {
    if (!id.startsWith('file:')) throw new CrmFilesError(404, 'notfound', 'That is not a file.')
    const fid = id.slice(5)
    const s = await load()
    const f = s.files.find(x => x.id === fid)
    if (!f) throw new CrmFilesError(404, 'notfound', 'That file is not there (it may have been removed in the CRM).')
    const pid = pidOf(f)
    const p = f.folder === 'projects' && pid ? (s.projects.get(pid) ?? null) : null
    const groups = p ? await groupsOf(pid) : []
    const place = placeOf(f, new Map([[pid, groups]]))
    const mayUp = p?.writable ? await mayUpload() : false
    return { f, node: fileNode(f, place.parent, p?.writable === true, mayUp), project: p }
  }

  async function nodeOf(id: string): Promise<CrmNode> {
    if (id.startsWith('gone:readme:') || id.startsWith('kept:')) {
      const g = goneFile(id)
      if (!g) throw new CrmFilesError(404, 'notfound', 'That file is not there any more.')
      return g.node
    }
    if (id.startsWith('file:')) return (await findFile(id)).node
    return (await childrenOf(id)).node
  }

  // ---- the bytes of a new file or version, to Google Drive the way the CRM's own pages do -------------------------------

  interface DriveToken {
    accessToken: string
    folderId: string | null
    makePublic: boolean
    expiresAt: number
  }
  let token: DriveToken | null = null
  const driveFolders = new Map<string, string>()

  async function driveToken(): Promise<DriveToken> {
    if (token && token.expiresAt > now() + 60_000) return token
    const r = await call('GET', 'org/upload/gdrive-token', 'uploads')
    const j: unknown = await r.json().catch(() => null)
    if (!isObject(j) || !text(j.accessToken)) throw new CrmFilesError(502, 'crm-down', 'The CRM gave no Google Drive upload token.')
    token = { accessToken: text(j.accessToken), folderId: text(j.folderId) || null, makePublic: j.makePublic === true, expiresAt: num(j.expiresAt) ?? now() + 10 * 60_000 }
    // oa2f8: should the CRM ever say its limit here, it is kept (the uploads follow it).
    const said = num(j.maxFileSize) ?? num(j.max_file_size) ?? num(j.maxUploadBytes)
    if (said !== null && Number.isSafeInteger(said) && said > 0) tokenLimit = said
    return token
  }

  /** oa2f8: the limit the CRM's upload token answer said, when it says one. */
  let tokenLimit: number | null = null

  async function orgId(): Promise<string> {
    if (snap?.org) return snap.org
    // oa2f8: GET org/me says it (organization.id), as the CRM's own pages read it; the CRM's v1/auth/me answers { user } only (found by the first real upload, 11 Nov 2026).
    const id = await readOrgId(client).catch((e: unknown) => {
      if ((e as Error)?.name === 'CrmNotSignedIn') throw new CrmFilesError(409, 'crm-signin', CRM_FILES_REASONS.signedOut)
      throw new CrmFilesError(502, 'crm-down', CRM_FILES_REASONS.crmDown)
    })
    if (!id) throw new CrmFilesError(502, 'failed', 'The CRM did not say which organisation this account is in.')
    if (snap) snap.org = id
    return id
  }

  const EXT_MIME: Record<string, string> = {}
  const extOf = (name: string) => {
    const i = name.lastIndexOf('.')
    return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : ''
  }

  /** The key the CRM files a new upload under: server-sided-s3/<org>/<yyyy>/<MM>/<dd>/<stem><ms>.<ext>, like its own pages. */
  function crmKey(org: string, name: string): string {
    const d = new Date(now())
    const p2 = (n: number) => String(n).padStart(2, '0')
    const ext = extOf(name)
    const stem = (ext ? name.slice(0, name.lastIndexOf('.')) : name).replace(/[\\/]/g, '_')
    return `server-sided-s3/${org}/${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}/${stem}${d.getTime()}${ext ? `.${ext}` : ''}`
  }

  /** Google's reason word for a refusal ("rateLimitExceeded", "storageQuotaExceeded", ...), when its answer has one. Only that word is kept. */
  async function googleReason(res: Response): Promise<string | undefined> {
    const j: unknown = await res.json().catch(() => null)
    const err = isObject(j) && isObject(j.error) ? j.error : null
    const first = err && Array.isArray(err.errors) && isObject(err.errors[0]) ? text(err.errors[0].reason) : ''
    const word = first || (err ? text(err.status) : '')
    return /^[A-Za-z_]{1,64}$/.test(word) ? word : undefined
  }

  async function gjson(res: Response, what: string): Promise<Record<string, unknown>> {
    if (!res.ok) throw new CrmFilesError(502, 'failed', `Google Drive refused ${what} (${res.status}).`, { status: res.status, reason: await googleReason(res) })
    const j: unknown = await res.json().catch(() => null)
    return isObject(j) ? j : {}
  }

  async function driveFolder(t: DriveToken, parent: string | null, name: string): Promise<string> {
    const ck = `${parent ?? 'root'}/${name}`
    const hit = driveFolders.get(ck)
    if (hit) return hit
    const auth = { authorization: `Bearer ${t.accessToken}` }
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const q = `mimeType='application/vnd.google-apps.folder' and name='${esc(name)}' and trashed=false${parent ? ` and '${parent}' in parents` : ''}`
    const found = await gjson(await gfetch(`${driveApi}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`, { headers: auth }), 'a folder lookup')
    const first = Array.isArray(found.files) && isObject(found.files[0]) ? text(found.files[0].id) : ''
    let id = first
    if (!id) {
      const made = await gjson(
        await gfetch(`${driveApi}/files?fields=id`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) }) }),
        'a new folder',
      )
      id = text(made.id)
    }
    if (!id) throw new CrmFilesError(502, 'failed', 'Google Drive made no folder.')
    driveFolders.set(ck, id)
    return id
  }

  /**
   * Opens a resumable upload session in Drive for `size` bytes, as the CRM's own pages do: the CRM's token, its folder for today, its key in appProperties.path. The session address
   * that comes back is a credential for this one upload (od0b1 keeps it in the agent's state folder, never in a log or a page). The answer at the end carries md5Checksum and size so the
   * upload can be checked.
   */
  async function openDriveSession(name: string, type: string, size: number): Promise<{ key: string; mime: string; session: string }> {
    const t = await driveToken()
    const key = crmKey(await orgId(), name)
    const segs = key.split('/')
    let parent = t.folderId
    for (const seg of segs.slice(0, -1)) parent = await driveFolder(t, parent, seg)
    const mime = type || EXT_MIME[extOf(name)] || 'application/octet-stream'
    const auth = { authorization: `Bearer ${t.accessToken}` }
    const start = await gfetch(`${driveUpload}/files?uploadType=resumable&fields=id,webViewLink,webContentLink,md5Checksum,size`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': mime, 'x-upload-content-length': String(size) },
      body: JSON.stringify({ name, mimeType: mime, appProperties: { path: key }, ...(parent ? { parents: [parent] } : {}) }),
    })
    if (!start.ok) {
      token = null
      throw new CrmFilesError(502, 'failed', `Google Drive refused the upload (${start.status}).`, { status: start.status, reason: await googleReason(start) })
    }
    const session = start.headers.get('location')
    if (!session) throw new CrmFilesError(502, 'failed', 'Google Drive gave no upload session.')
    return { key, mime, session }
  }

  /** The bytes are all in Drive (`done` is Drive's answer to the last of them): its link, and the CRM's own sharing policy applied, as its pages do. */
  async function driveDone(done: Record<string, unknown>): Promise<{ driveId: string; url: string }> {
    const driveId = text(done.id)
    if (!driveId) throw new CrmFilesError(502, 'failed', 'Google Drive returned no file id.')
    const url = text(done.webViewLink) || text(done.webContentLink) || `https://drive.google.com/uc?id=${driveId}`
    await sharePolicy(driveId)
    return { driveId, url }
  }

  async function sharePolicy(driveId: string) {
    const t = await driveToken().catch(() => null)
    if (t?.makePublic) {
      // Best effort, as the CRM's own pages do it: the file is already up. (This is the CRM's own policy for ITS files; the Common Drive backup never shares anything.)
      const auth = { authorization: `Bearer ${t.accessToken}` }
      await gfetch(`${driveApi}/files/${driveId}/permissions`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'anyone' }) }).catch(() => undefined)
    }
  }

  // ---- o813f: the bytes of a file over 100 MB, through Google's Drive API (Shubham, relayed 12 Nov; Lead's conditions) -------------------------------------------
  // The public download link (what the CRM's own download, /org/files/:id/raw, fetches) answers Google's "can't scan this file for viruses" page in place of a file over 100 MB. For such
  // a file ONLY (the record's fileSize over DRIVE_API_OVER), Google's Drive API is used, Google's own way for a program to download: files.get alt=media with the CRM's own Drive token,
  // by Range requests; download only. Nothing is clicked through: what Google refuses there (a file it marked as harmful: 403 cannotDownloadAbusiveFile) stays refused, acknowledgeAbuse
  // is never sent, and the CRM's download is not tried instead. The CRM still decides what may be read: the file must be in the CRM's own list for this account (findFile, which also
  // hides projects it may not open), the Drive id is the one in the link the CRM keeps for THAT record (driveIdOf), and the CRM must say yes for that very file just before (crmLetsOpen).
  // The token: from the CRM (org/upload/gdrive-token), in this process's memory only, sent only to Google's API over https (tokenMayGoTo); never logged, stored, answered or shown.

  /** The Drive id to read this record by, through the API: only a record over DRIVE_API_OVER whose link is Drive's own, and only while the setting says so. Null = the CRM's own download. */
  const apiDriveId = (f: RawFile): string | null => ((o.downloadVia?.() ?? 'drive') === 'drive' && f.fileSize !== null && f.fileSize > DRIVE_API_OVER ? driveIdOf(f.fileUrl) : null)
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

  /**
   * Before the bytes of a file are read from Drive, the CRM is asked about THAT file (Lead, 12 Nov): GET org/files/:id/versions must answer 200 (the CRM has no GET org/files/:id; its
   * own download and versions check a file the same way). Anything else stops the read, nothing is read from Drive, and the page gets the CRM's plain reason: 404 (the CRM does not
   * show it to this account), 403 (with the CRM's own words), signed out, or the CRM not answering. A yes is kept a minute per file (the in-app drive reads 4 MiB blocks).
   */
  const crmSaidYes = new Map<string, number>()
  async function crmLetsOpen(f: RawFile): Promise<void> {
    const at = crmSaidYes.get(f.id)
    if (at !== undefined && now() - at < 60_000) return
    let r: Response
    try {
      r = await client.request('GET', `org/files/${encodeURIComponent(f.id)}/versions`)
    } catch (e) {
      if ((e as Error)?.name === 'CrmNotSignedIn') throw new CrmFilesError(409, 'crm-signin', CRM_FILES_REASONS.signedOut)
      throw new CrmFilesError(502, 'crm-down', CRM_FILES_REASONS.crmDown)
    }
    if (r.status === 404) {
      await r.body?.cancel().catch(() => undefined)
      throw new CrmFilesError(404, 'notfound', DOWNLOAD_WORDS.notShown)
    }
    if (!r.ok) throw await refusal(r, 'opening this file')
    await r.body?.cancel().catch(() => undefined)
    crmSaidYes.set(f.id, now())
  }
  const typeOf = (f: RawFile, r: Response) => (f.fileType && f.fileType !== 'application/octet-stream' ? f.fileType : (r.headers.get('content-type') ?? 'application/octet-stream'))

  /** The first byte of a 206 answer (Content-Range: bytes a-b/size), or null. */
  const rangeStart = (r: Response): number | null => {
    const m = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(r.headers.get('content-range') ?? '')
    return m ? Number(m[1]) : null
  }

  /** The chunks of an answer's body, as Buffers; reading stops (the body is cancelled) when the reader stops. */
  async function* chunksOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        yield Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  /**
   * The chunks of an answer of the CRM's own download. Google's virus-scan notice (an HTML page of a few KB that the public link sends in place of a file over 100 MB, and that the CRM's
   * download hands on as if it were the file) is refused in words, never passed on as the file. Only an answer that starts like an HTML page, for a file that is not one, is looked at.
   */
  async function* crmChunks(body: ReadableStream<Uint8Array>, f: RawFile): AsyncGenerator<Buffer> {
    const chunks = chunksOf(body)
    const head: Buffer[] = []
    let headLen = 0
    let ended = false
    const more = async (upTo: number) => {
      while (!ended && headLen < upTo) {
        const n = await chunks.next()
        if (n.done) ended = true
        else {
          head.push(Buffer.from(n.value))
          headLen += n.value.length
        }
      }
    }
    try {
      await more(2048)
      if (!/html/i.test(f.fileType ?? '') && /^\s*(?:<!doctype html|<html)/i.test(Buffer.concat(head).subarray(0, 512).toString('latin1'))) {
        await more(256 * 1024)
        if (SCAN_NOTICE.test(Buffer.concat(head).toString('utf8'))) throw new CrmFilesError(502, 'failed', DOWNLOAD_WORDS.scanPage)
      }
      if (headLen) yield Buffer.concat(head)
      if (!ended) yield* chunks
    } finally {
      await chunks.return(undefined)
    }
  }

  /** Bytes [start, start + length) of a whole-file answer: what is before `start` is read and dropped, and reading stops once `length` bytes are kept. */
  async function sliceOf(chunks: AsyncGenerator<Buffer>, start: number, length: number): Promise<Buffer> {
    const out: Buffer[] = []
    let seen = 0
    let kept = 0
    for await (const chunk of chunks) {
      const from = Math.max(0, start - seen)
      seen += chunk.length
      if (from < chunk.length) {
        const part = chunk.subarray(from, from + (length - kept))
        out.push(part)
        kept += part.length
      }
      if (kept >= length) break
    }
    return Buffer.concat(out)
  }

  /**
   * One request to Google's Drive API for the bytes of `driveId`: `range` from..to (inclusive), from.. to the end, or null for the whole file. 'crm' = read it through the CRM's download
   * instead: this account has no Drive token (no upload permission: the CRM refuses it), the token does not see the file (404), a Google Docs file has no bytes (403 fileNotDownloadable),
   * or Google still fails after the tries. A token that ended early (401) is fetched again once; a busy Google (5xx, 429, a rate limit) or a broken line is asked again.
   */
  async function driveMedia(driveId: string, range: { from: number; to?: number } | null, signal?: AbortSignal): Promise<Response | 'crm'> {
    // The token goes nowhere but Google's API, over https.
    if (!tokenMayGoTo(`${driveApi}/`)) return 'crm'
    let renewed = false
    for (let attempt = 0; attempt < 3; attempt++) {
      // The CRM refused this account a Drive token a moment ago: not asked again for a minute (mayUpload keeps the same answer).
      if (upload.ok === false && now() - upload.at < 60_000) return 'crm'
      let t: DriveToken
      try {
        t = await driveToken()
      } catch (e) {
        if (e instanceof CrmFilesError && e.code === 'crm-signin') throw e
        if (e instanceof CrmFilesError && e.code === 'forbidden') upload = { ok: false, at: now() }
        return 'crm'
      }
      let res: Response
      try {
        res = await gfetch(`${driveApi}/files/${encodeURIComponent(driveId)}?alt=media&supportsAllDrives=true`, {
          // Accept-Encoding identity: the ranges and the length are those of the file itself, never of a compressed form of it (fetch adds it to a Range request by itself).
          headers: { authorization: `Bearer ${t.accessToken}`, ...(range ? { range: `bytes=${range.from}-${range.to ?? ''}` } : { 'accept-encoding': 'identity' }) },
          signal,
        })
      } catch (e) {
        if (signal?.aborted) throw e
        await pause(300 * (attempt + 1))
        continue
      }
      if (res.ok || res.status === 416) return res
      const reason = await googleReason(res)
      if (res.status === 403 && reason === 'cannotDownloadAbusiveFile') throw new CrmFilesError(403, 'forbidden', DOWNLOAD_WORDS.harmful, { status: 403, reason })
      if (res.status === 401 && !renewed) {
        renewed = true
        token = null
        continue
      }
      if (res.status >= 500 || res.status === 429 || (res.status === 403 && /rate|limit/i.test(reason ?? ''))) {
        await pause(300 * (attempt + 1))
        continue
      }
      return 'crm'
    }
    return 'crm'
  }

  /** The whole file through the API, by Range requests: bytes=0- and, when the line breaks, bytes=N- from where it stopped (3 tries in a row at most). Null = read it through the CRM. */
  async function driveWhole(driveId: string, f: RawFile): Promise<{ stream: Readable; size: number | null; type: string; name: string } | null> {
    const ctl = new AbortController()
    const first = await driveMedia(driveId, { from: 0 }, ctl.signal)
    if (first === 'crm') return null
    if (!first.body || !(first.status === 206 ? rangeStart(first) === 0 : first.status === 200)) {
      await first.body?.cancel().catch(() => undefined)
      return null
    }
    const len = Number(first.headers.get('content-length'))
    const total = first.headers.has('content-length') && Number.isSafeInteger(len) && len >= 0 ? len : null
    const firstBody = first.body
    async function* bytes(): AsyncGenerator<Buffer> {
      let body = firstBody
      let got = 0
      let fails = 0
      for (;;) {
        try {
          for await (const chunk of chunksOf(body)) {
            got += chunk.length
            fails = 0
            yield chunk
          }
          if (total === null || got >= total) return
          throw new Error('the answer ended early')
        } catch (e) {
          if (ctl.signal.aborted) return
          if (e instanceof CrmFilesError) throw e
          if (++fails > 3) throw new CrmFilesError(502, 'failed', DOWNLOAD_WORDS.broke)
        }
        // Go on from byte `got`.
        const next = await driveMedia(driveId, { from: got }, ctl.signal)
        if (next === 'crm' || !next.body || !(next.status === 206 ? rangeStart(next) === got : next.status === 200 && got === 0)) {
          if (next !== 'crm') await next.body?.cancel().catch(() => undefined)
          throw new CrmFilesError(502, 'failed', DOWNLOAD_WORDS.broke)
        }
        body = next.body
      }
    }
    const stream = Readable.from(bytes(), { objectMode: false })
    stream.once('close', () => ctl.abort())
    return { stream, size: total ?? f.fileSize, type: typeOf(f, first), name: f.fileName }
  }

  /** Bytes [start, start + length) by one ranged request to the API (a second try if the line breaks); fewer only at the end of the file, none past it. Null = read them through the CRM. */
  async function drivePart(driveId: string, start: number, length: number): Promise<Buffer | null> {
    for (let attempt = 0; ; attempt++) {
      const res = await driveMedia(driveId, { from: start, to: start + length - 1 })
      if (res === 'crm') return null
      try {
        if (res.status === 416 || !res.body) {
          await res.body?.cancel().catch(() => undefined)
          return Buffer.alloc(0)
        }
        if (res.status === 206) {
          if (rangeStart(res) !== start) {
            await res.body.cancel().catch(() => undefined)
            throw new CrmFilesError(502, 'failed', DOWNLOAD_WORDS.broke)
          }
          const b = Buffer.from(await res.arrayBuffer())
          return b.length > length ? b.subarray(0, length) : b
        }
        // 200: the whole file came (the range was not taken): only the slice is kept.
        return await sliceOf(chunksOf(res.body), start, length)
      } catch (e) {
        if (attempt >= 1) throw e instanceof CrmFilesError ? e : new CrmFilesError(502, 'failed', DOWNLOAD_WORDS.broke)
      }
    }
  }

  /** Sends `stream` (exactly `size` bytes) to Drive in ONE request; returns the key and the link the CRM record will keep. (The first way, kept: the page's single-request upload and the drive's saves.) */
  async function pushToDrive(name: string, type: string, stream: Readable, size: number): Promise<{ key: string; url: string }> {
    let opened: { key: string; mime: string; session: string }
    try {
      opened = await openDriveSession(name, type, size)
    } catch (e) {
      stream.destroy()
      throw e
    }
    const put = await gfetch(opened.session, {
      method: 'PUT',
      headers: { 'content-type': opened.mime, 'content-length': String(size) },
      body: Readable.toWeb(stream) as unknown as ReadableStream,
      duplex: 'half',
    } as RequestInit)
    const done = await gjson(put, 'the upload')
    const { url } = await driveDone(done)
    return { key: opened.key, url }
  }

  /** A refused upload's body: a small one is read and dropped so the answer reaches the sender; a big one is cut off. */
  function discard(stream: Readable, size: number) {
    if (size >= 0 && size <= 1024 * 1024) stream.resume()
    else stream.destroy()
  }

  function checkSize(size: number) {
    if (!Number.isFinite(size) || size < 0) throw new CrmFilesError(400, 'failed', 'The upload needs its size.')
    const max = o.maxUpload?.() ?? CRM_FILES_MAX_UPLOAD
    if (size > max) throw new CrmFilesError(413, 'toolarge', `A file is at most ${Math.round(max / 1024 / 1024)} MB here.`)
  }

  function needName(name: string) {
    const bad = badName(name)
    if (bad) throw new CrmFilesError(400, 'badname', bad)
  }

  async function needRight(n: CrmNode, right: keyof CrmRights, what: string) {
    if (!n.rights[right]) throw new CrmFilesError(403, 'forbidden', `You may not ${what} here.`)
  }

  const asFolderParts = (id: string): { pid: string; gid: string | null } => {
    const [kind, a, b] = id.split(':')
    if (kind === 'proj' && a && a !== 'none') return { pid: a, gid: null }
    if (kind === 'grp' && a && b) return { pid: a, gid: b }
    throw new CrmFilesError(403, 'forbidden', 'New things go into a project or one of its folders.')
  }

  async function needFree(parent: string, name: string, exceptFile?: string) {
    const { children } = await childrenOf(parent)
    if (children.some(c => sameName(c.name, name) && c.id !== exceptFile)) throw new CrmFilesError(409, 'conflict', `"${name}" is already there.`)
  }

  async function refreshed(id: string): Promise<CrmNode> {
    snap = null
    return nodeOf(id)
  }

  // ---- the CRM record of a file whose bytes are in Drive (the one-request upload and the uploads in parts) ---------------

  async function recordNew(parent: string, name: string, type: string, size: number, sent: { key: string; url: string }): Promise<CrmNode> {
    const { pid, gid } = asFolderParts(parent)
    const body: Record<string, unknown> = { file_name: name, file_key: sent.key, file_url: sent.url, file_type: type || 'application/octet-stream', folder: 'projects', source: `project:${pid}`, group_id: gid }
    // The CRM refuses a size of 0; an empty file goes up without one (as the old drive did).
    if (size > 0) body.file_size = size
    const r = await call('POST', 'org/files', 'this file', { json: body })
    const rec: unknown = await r.json().catch(() => null)
    invalidate(pid)
    const newId = isObject(rec) ? text(rec.id) || (isObject(rec.file) ? text(rec.file.id) : '') : ''
    if (!newId) return (await childrenOf(parent)).children.find(c => sameName(c.name, name)) ?? (await nodeOf(parent))
    return await refreshed(fileId(newId))
  }

  async function recordVersion(id: string, type: string, size: number, sent: { key: string; url: string }): Promise<CrmNode> {
    const { f, project } = await findFile(id)
    const body: Record<string, unknown> = { file_name: f.fileName, file_key: sent.key, file_url: sent.url, file_type: type || f.fileType || 'application/octet-stream' }
    if (size > 0) body.file_size = size
    await call('POST', `org/files/${encodeURIComponent(f.id)}/version`, 'a new version of this file', { json: body })
    invalidate(project?.id)
    return await refreshed(id)
  }

  /** "name (2).ext", "name (3).ext", ...: the first that is free in `parent`. */
  async function freeName(parent: string, name: string): Promise<string> {
    const { children } = await childrenOf(parent)
    const taken = (n: string) => children.some(c => sameName(c.name, n))
    if (!taken(name)) return name
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    for (let i = 2; i < 1000; i++) {
      const n = `${stem} (${i})${ext}`
      if (n.length <= 255 && !taken(n)) return n
    }
    throw new CrmFilesError(409, 'conflict', `"${name}" is already there.`)
  }

  // ---- od0b1: what the uploads in parts use (uploads.ts) ----------------------------------------------------------------

  const uploadBackend: CrmUploadBackend = {
    fetch: gfetch,

    // What the token answer said, when it was fetched for the agent's own work; nothing is asked for it.
    crmLimit: () => tokenLimit,

    async check(p) {
      if (p.kind === 'new') {
        needName(p.name)
        const blocked = blockedKind(p.name, p.type)
        if (blocked) throw new CrmFilesError(400, 'blocked', blocked)
        asFolderParts(p.target)
        await needRight(await nodeOf(p.target), 'upload', 'add files')
        await needFree(p.target, p.name)
        return { name: p.name.trim(), type: p.type }
      }
      if (p.name) needName(p.name)
      const { f, node } = await findFile(p.target)
      await needRight(node, 'version', 'save a new version of this file')
      const name = p.name.trim() || f.fileName
      const blocked = blockedKind(f.fileName, p.type || f.fileType || '')
      if (blocked) throw new CrmFilesError(400, 'blocked', blocked)
      return { name, type: p.type || f.fileType || '' }
    },

    open: (name, type, size) => openDriveSession(name, type, size),

    async finish(p) {
      if (p.share !== false) await sharePolicy(p.driveId)
      const sent = { key: p.key, url: p.url }
      if (p.kind === 'version') {
        if (p.lookFirst) {
          // An earlier try may have landed: the CRM's file then already holds this key (a new version replaces the file's key).
          invalidate()
          const { f } = await findFile(p.target)
          if (f.fileKey === p.key) return { node: await refreshed(p.target) }
        }
        return { node: await recordVersion(p.target, p.type, p.size, sent) }
      }
      if (p.lookFirst) {
        invalidate()
        const s = await load()
        const landed = s.files.find(f => f.fileKey === p.key)
        if (landed) return { node: await nodeOf(fileId(landed.id)) }
      }
      // Still allowed to add files here (the CRM is asked again: hours may have passed)?
      await needRight(await nodeOf(p.target), 'upload', 'add files')
      const name = await freeName(p.target, p.name)
      const node = await recordNew(p.target, name, p.type, p.size, sent)
      return name === p.name ? { node } : { node, savedAs: name }
    },
  }

  // ---- S5: the spool and what it adds to the mount's words ---------------------------------------------------------------

  /** The mount's status with the waiting saves counted in and the spool's folder named; reveal also knows the spool's folder. */
  const mount: MountDriver = spool_decorate()
  function spool_decorate(): MountDriver {
    const withSpool = async (m: Promise<CrmMountStatus>): Promise<CrmMountStatus> => {
      const st = await m
      return spool ? { ...st, waiting: (st.waiting ?? 0) + spool.count(), spoolDir: spool.dir } : st
    }
    return {
      status: () => withSpool(baseMount.status()),
      start: () => withSpool(baseMount.start()),
      stop: () => withSpool(baseMount.stop()),
      setAuto: baseMount.setAuto ? on => withSpool(baseMount.setAuto!(on)) : undefined,
      setDriver: baseMount.setDriver ? via => withSpool(baseMount.setDriver!(via)) : undefined,
      setSaves: baseMount.setSaves ? on => withSpool(baseMount.setSaves!(on)) : undefined,
      setLetter: baseMount.setLetter ? l => withSpool(baseMount.setLetter!(l)) : undefined,
      letters: baseMount.letters ? () => baseMount.letters!() : undefined,
      reveal: async what => {
        if (what === 'spool') {
          if (!spool || !o.openFolder) throw new CrmFilesError(400, 'unsupported', CRM_FILES_REASONS.unsupported)
          return o.openFolder(spool.dir)
        }
        if (!baseMount.reveal) throw new CrmFilesError(400, 'unsupported', CRM_FILES_REASONS.unsupported)
        return baseMount.reveal(what)
      },
    }
  }

  // S7: the .driveignore rules; the built-in defaults are a setting (on unless switched off), kept next to the spool.
  const ignoreFile = o.spoolDir ? path.join(o.spoolDir, 'ignore-settings.json') : null
  let ignoreDefaults = true
  try {
    if (ignoreFile && existsSync(ignoreFile)) ignoreDefaults = (JSON.parse(readFileSync(ignoreFile, 'utf8')) as { defaults?: unknown }).defaults !== false
  } catch {
    // unreadable: the default (on)
  }
  const rules = createIgnoreRules({ source: () => service, defaults: () => ignoreDefaults, log: o.log })

  if (o.spoolDir) {
    spool = createSpool({
      dir: o.spoolDir,
      retryMs: o.spool?.retryMs,
      maxBytes: o.spool?.maxBytes,
      reconsiderMs: o.spool?.reconsiderMs ?? 60_000,
      log: o.log,
      onChange: () => {
        invalidate()
        // A file reached the CRM: it may be a .driveignore. Read the rules again, and ask them again about what waits.
        rules.invalidate()
        void spool?.reconsider().catch(() => undefined)
      },
      send: {
        ignored: job => rules.reason(job.parent, job.name, false),
        upload: (parent, name, type, stream, size) => service.upload(parent, name, type, stream, size),
        version: (id, name, type, stream, size) => service.version(id, name, type, stream, size),
        find: async (parent, name) => (await childrenOf(parent)).children.find(c => sameName(c.name, name)) ?? null,
      },
    })
    if (o.spool?.autoStart !== false) spool.start()
  }

  // ---- the service -----------------------------------------------------------------------------------------------------

  const service: CrmFilesService = {
    mount,
    spool,
    lostAccess: removedIndex ? { list: () => removedIndex.list(), dismiss: id => removedIndex.dismiss(id) } : null,
    get keep() {
      return o.pins?.() ?? null
    },
    pinTree,
    ignore: spool
      ? {
          rules,
          defaults: () => ignoreDefaults,
          setDefaults(on) {
            ignoreDefaults = on
            try {
              if (ignoreFile) writeFileSync(ignoreFile, JSON.stringify({ defaults: on }))
            } catch (e) {
              o.log?.warn(`crm drive: could not save the ignore setting (${e instanceof Error ? e.message : String(e)})`)
            }
            rules.invalidate()
            void spool?.reconsider().catch(() => undefined)
          },
        }
      : null,
    save: spool
      ? async a => {
          checkSize(a.size)
          needName(a.name)
          if (a.target) {
            const { node, project } = await findFile(a.target)
            await needRight(node, 'version', 'save a new version of this file')
            // S7: a file a .driveignore rule matches is kept on this PC only (a file already in the CRM stays there; its new saves stay here).
            const why = await rules.reason(node.parentId ?? a.parent, node.name, false)
            const entry = await spool!.add({ kind: 'version', parent: node.parentId ?? a.parent, target: a.target, name: a.name, type: a.type, project: project?.name ?? null, body: a.body, from: a.from, size: a.size, ignored: why ?? undefined })
            return { how: 'version' as const, entry }
          }
          asFolderParts(a.parent)
          const pn = await nodeOf(a.parent)
          await needRight(pn, 'upload', 'add files')
          const why = await rules.reason(a.parent, a.name, false)
          const entry = await spool!.add({ kind: 'new', parent: a.parent, name: a.name, type: a.type, project: pn.name, body: a.body, from: a.from, size: a.size, ignored: why ?? undefined })
          return { how: 'new' as const, entry }
        }
      : null,
    uploadBackend,

    async status() {
      const sess = client.session()
      const m = await mount.status().catch(() => noMount.status())
      return {
        signedIn: sess.signedIn,
        account: sess.signedIn ? { name: sess.name ?? sess.username ?? 'Signed in', username: sess.username } : null,
        reason: sess.signedIn ? null : CRM_FILES_REASONS.signedOut,
        mount: sess.signedIn || !m.reason ? m : { ...m, reason: m.reason ?? CRM_FILES_REASONS.signedOut },
      }
    },

    async children(id) {
      return withPins(await childrenOf(id))
    },

    node: nodeOf,

    async file(id) {
      const g = id.startsWith('gone:readme:') || id.startsWith('kept:') ? goneFile(id) : null
      if (g) return { stream: g.path ? createReadStream(g.path) : Readable.from([g.bytes ?? Buffer.alloc(0)]), size: g.node.size ?? 0, type: g.node.type ?? 'application/octet-stream', name: g.node.name }
      // The CRM's own list for this account says which file this is (findFile); o813f: one over 100 MB that it keeps in Google Drive comes through Google's Drive API, once the CRM
      // has said yes for this very file.
      const { f } = await findFile(id)
      const driveId = apiDriveId(f)
      if (driveId) {
        await crmLetsOpen(f)
        const viaApi = await driveWhole(driveId, f)
        if (viaApi) return viaApi
      }
      let r: Response
      try {
        r = await client.request('GET', `org/files/${encodeURIComponent(f.id)}/raw`)
      } catch (e) {
        if ((e as Error)?.name === 'CrmNotSignedIn') throw new CrmFilesError(409, 'crm-signin', CRM_FILES_REASONS.signedOut)
        throw new CrmFilesError(502, 'crm-down', CRM_FILES_REASONS.crmDown)
      }
      if (!r.ok || !r.body) throw await refusal(r, 'this file')
      const len = Number(r.headers.get('content-length'))
      // o813f: looked at BEFORE anything is answered, so Google's virus-scan notice in place of the file is an error, never a download.
      const chunks = crmChunks(r.body, f)
      const head = await chunks.next()
      return {
        stream: Readable.from(
          (async function* () {
            if (!head.done) yield head.value
            yield* chunks
          })(),
          { objectMode: false },
        ),
        size: Number.isFinite(len) && len >= 0 && r.headers.has('content-length') ? len : f.fileSize,
        type: typeOf(f, r),
        name: f.fileName,
      }
    },

    async fileBytes(id, start, length) {
      const g = id.startsWith('gone:readme:') || id.startsWith('kept:') ? goneFile(id) : null
      if (g) {
        if (g.bytes) return g.bytes.subarray(start, start + length)
        const fh = await openFile(g.path as string, 'r')
        try {
          const out = Buffer.alloc(length)
          const { bytesRead } = await fh.read(out, 0, length, start)
          return out.subarray(0, bytesRead)
        } finally {
          await fh.close()
        }
      }
      // ocbbf: when the CRM cannot be asked, a copy kept on this PC (finished, whatever its version) is read instead; a refusal of the CRM is still a refusal.
      const fromKeptCopy = async (): Promise<Buffer | null> => (await o.pins?.()?.readOffline(id, start, length)) ?? null
      let f: RawFile
      try {
        ;({ f } = await findFile(id))
      } catch (e) {
        const kept = await fromKeptCopy()
        if (kept) return kept
        throw e
      }
      // o813f: a file over 100 MB that the CRM keeps in Google Drive: one ranged request to Google's Drive API, once the CRM has said yes for this very file.
      const driveId = length > 0 ? apiDriveId(f) : null
      if (driveId) {
        await crmLetsOpen(f)
        const viaApi = await drivePart(driveId, start, length)
        if (viaApi) return viaApi
      }
      let r: Response
      try {
        r = await client.request('GET', `org/files/${encodeURIComponent(f.id)}/raw`, { headers: { range: `bytes=${start}-${start + length - 1}` } })
      } catch (e) {
        const kept = await fromKeptCopy()
        if (kept) return kept
        if ((e as Error)?.name === 'CrmNotSignedIn') throw new CrmFilesError(409, 'crm-signin', CRM_FILES_REASONS.signedOut)
        throw new CrmFilesError(502, 'crm-down', CRM_FILES_REASONS.crmDown)
      }
      if (r.status === 206) {
        const b = Buffer.from(await r.arrayBuffer())
        return b.length > length ? b.subarray(0, length) : b
      }
      if (!r.ok || !r.body) throw await refusal(r, 'this file')
      // The CRM answered the whole file (it ignored the range): read and drop what is before `start`, keep `length`, and stop reading. o813f: Google's virus-scan notice is refused.
      return await sliceOf(crmChunks(r.body, f), start, length)
    },

    async search(q, limit) {
      const needle = q.trim().toLowerCase()
      if (needle.length < 2) return { results: [], more: false }
      const cap = Math.max(1, Math.min(Math.floor(limit) || 50, 200))
      const s = await load()
      const mayUp = [...s.projects.values()].some(p => p.writable) ? await mayUpload() : false
      const has = (name: string) => name.toLowerCase().includes(needle)
      const results: { node: CrmNode; path: string }[] = []
      for (const p of s.projects.values()) if (has(p.name)) results.push({ node: projectNode(p, 0, false), path: homeOf(p).name })
      const groupsSeen = new Map<string, RawGroup[]>()
      for (const f of s.files) {
        if (results.length > cap * 2) break
        if (!has(f.fileName)) continue
        const pid = pidOf(f)
        if (f.folder !== 'projects' || !pid) {
          results.push({ node: fileNode(f, f.folder === 'projects' ? UNCATEGORISED : catOf(f.folder), false, false), path: f.folder === 'projects' ? 'projects / Uncategorised' : isMarketingTag(f.folder) ? MARKETING_FOLDER : f.folder })
          continue
        }
        const p = s.projects.get(pid)
        if (!p) continue
        let groups = groupsSeen.get(pid)
        if (!groups) {
          groups = await groupsOf(pid).catch(() => [])
          groupsSeen.set(pid, groups)
        }
        const place = placeOf(f, new Map([[pid, groups]]))
        const chain: string[] = []
        for (let g = place.parent.startsWith('grp:') ? groups.find(x => x.id === place.parent.split(':')[2]) : undefined; g; g = g.parentId ? groups.find(x => x.id === g!.parentId) : undefined) chain.unshift(g.name)
        results.push({ node: fileNode(f, place.parent, p.writable, mayUp), path: [homeOf(p).name, p.name, ...chain].join(' / ') })
      }
      results.sort((a, b) => a.node.name.localeCompare(b.node.name, undefined, { sensitivity: 'base', numeric: true }) || a.node.id.localeCompare(b.node.id))
      return { results: results.slice(0, cap), more: results.length > cap }
    },

    async find(ask) {
      const s = await load()
      const raw = new Map(s.files.map(f => [fileId(f.id), f]))
      const r = await findFiles(
        {
          files: s.files.map(f => ({ id: fileId(f.id), name: f.fileName, type: f.fileType, size: sizeOf(f), modifiedAt: f.updatedAt ?? f.createdAt, category: f.folder, projectId: f.folder === 'projects' ? pidOf(f) || null : null, groupId: f.groupId })),
          // oe692: each project with the top folder it sits in ("projects" or "Marketing Projects"), for the answer's "where".
          projects: new Map([...s.projects].map(([k, p]) => [k, { id: p.id, name: p.name, home: homeOf(p).name }])),
          groupsOf,
        },
        ask,
      )
      // The sizes the CRM has no record of, for the files answered: Google's metadata (never their bytes), as a folder listing does.
      const unsized = r.files.filter(x => x.size === null).map(x => raw.get(x.id)).filter((f): f is RawFile => !!f)
      if (unsized.length > 0) {
        await learnSizes(unsized)
        for (const x of r.files) if (x.size === null) x.size = sizeOf(raw.get(x.id)!)
      }
      return r
    },

    async versions(id) {
      if (id.startsWith('gone:readme:') || id.startsWith('kept:')) return []
      const { f } = await findFile(id)
      const j = await getJson(`org/files/${encodeURIComponent(f.id)}/versions`, 'the versions')
      const arr = Array.isArray(j) ? j : isObject(j) && Array.isArray(j.versions) ? j.versions : []
      const out: CrmVersion[] = []
      for (const v of arr) {
        if (!isObject(v)) continue
        out.push({ number: num(v.versionNumber) ?? out.length + 1, name: text(v.fileName) || f.fileName, size: num(v.fileSize), createdAt: iso(v.createdAt) ?? new Date(0).toISOString(), ...(text(v.createdByName) ? { by: text(v.createdByName) } : {}) })
      }
      return out.sort((a, b) => b.number - a.number)
    },

    async upload(parent, name, type, stream, size) {
      try {
        checkSize(size)
        needName(name)
        asFolderParts(parent)
        const pn = await nodeOf(parent)
        await needRight(pn, 'upload', 'add files')
        await needFree(parent, name)
        const sent = await pushToDrive(name, type, stream, size)
        return await recordNew(parent, name, type, size, sent)
      } catch (e) {
        discard(stream, size)
        throw e
      }
    },

    async version(id, name, type, stream, size) {
      try {
        checkSize(size)
        if (name) needName(name)
        const { f, node } = await findFile(id)
        await needRight(node, 'version', 'save a new version of this file')
        const sent = await pushToDrive(name || f.fileName, type || f.fileType || '', stream, size)
        return await recordVersion(id, type, size, sent)
      } catch (e) {
        discard(stream, size)
        throw e
      }
    },

    async folder(parent, name) {
      needName(name)
      const { pid, gid } = asFolderParts(parent)
      const pn = await nodeOf(parent)
      await needRight(pn, 'mkdir', 'make a folder')
      await needFree(parent, name)
      const r = await call('POST', 'org/file-groups', 'this folder', { json: { project_id: pid, name: name.trim(), ...(gid ? { parent_id: gid } : {}) } })
      const rec: unknown = await r.json().catch(() => null)
      invalidate(pid)
      const g = isObject(rec) ? (isObject(rec.group) ? rec.group : rec) : {}
      const newId = text(g.id)
      if (newId) return await refreshed(grpId(pid, newId))
      const kids = (await childrenOf(parent)).children
      const hit = kids.find(c => sameName(c.name, name))
      if (!hit) throw new CrmFilesError(502, 'failed', 'The CRM made the folder but did not show it.')
      return hit
    },

    async rename(id, name) {
      needName(name)
      const n = await nodeOf(id)
      await needRight(n, 'rename', 'rename this')
      if (n.parentId) await needFree(n.parentId, name, id)
      if (n.kind === 'file') {
        await call('PATCH', `org/files/${encodeURIComponent(id.slice(5))}/rename`, 'the new name', { json: { file_name: name.trim() } })
        invalidate()
      } else if (n.kind === 'group') {
        const [, pid, gid] = id.split(':')
        await call('PATCH', `org/file-groups/${encodeURIComponent(gid)}`, 'the new name', { json: { name: name.trim() } })
        invalidate(pid)
      } else throw new CrmFilesError(403, 'forbidden', 'This is the CRM’s own and is not renamed here.')
      return refreshed(id)
    },

    async move(id, to) {
      const { f, node, project } = await findFile(id)
      await needRight(node, 'move', 'move this')
      if (!project) throw new CrmFilesError(403, 'forbidden', 'Only files in a project can be moved.')
      const dest = asFolderParts(to)
      if (dest.pid !== project.id) throw new CrmFilesError(403, 'forbidden', 'A file is moved inside its own project.')
      if (node.parentId === to) return node
      await needFree(to, f.fileName, id)
      await call('PATCH', `org/files/${encodeURIComponent(f.id)}/group`, 'the move', { json: { group_id: dest.gid } })
      invalidate(project.id)
      return refreshed(id)
    },
  }
  return service
}
