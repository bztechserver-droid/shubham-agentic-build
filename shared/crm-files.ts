// F-126: the CRM's files in this app. The agent shows exactly what the CRM's "Files" page shows to the CRM account signed in on THIS PC (crm-session.json,
// F-007), builds the same tree the old agentic-claude-manager drive built, and can mount it as a drive (Windows: Y: through WinFsp; Linux: GNOME gvfs over a loopback WebDAV listener).
//
// The CRM's own records decide what is a file and where it is (the `files`, `file_groups` and `file_versions` tables), NOT the Google Drive folders.
// Every write goes through the CRM's own routes (new file, new version, rename, move, new folder), never to Google directly. There is NO delete, anywhere:
// a DELETE is refused with code 'nodelete'. (The Common Drive, F-097, and its Google backup, F-125, were a different thing; they were removed on Shubham's order, 10 Nov 2026.)
//
// Mount: Windows mounts Y: through WinFsp (a host program); Linux runs a loopback WebDAV listener inside the agent and lets GNOME's gvfs mount it (no root, nothing installed).
// The Linux agent calls the module's CrmFilesService in-process (agent/crm-files/service.ts) instead of going through these routes.
//
// Routes (all JSON unless said; prefix /agent-api/agentic/crm-files; for the owner like the other PC pages):
//   GET  /status                       -> CrmFilesStatus
//   GET  /children?id=<nodeId|root>    -> CrmChildren          (children of a folder node; the tree is cached ~5 s like the old drive)
//   GET  /children?id=<nodeId|root>&limit=<n>   -> CrmChildren with `total`   (P1: only the first n children of a big folder; no limit = all of them, as before)
//   GET  /search?q=<text>&limit=<n>     -> CrmSearch   (P1: files and projects whose NAME holds the text, at least 2 characters; at most 200)
//   GET  /node?id=<nodeId>             -> CrmNode
//   GET  /file?id=<fileNodeId>         -> the bytes (Content-Type = the stored type, Content-Disposition: attachment; filename*, Content-Length)
//   GET  /versions?id=<fileNodeId>     -> { versions: CrmVersion[] }
//   POST /upload?parent=<id>&name=<n>&type=<mime>   body = the raw bytes (application/octet-stream), at most CRM_FILES_MAX_UPLOAD  -> { node }   a NEW file
//   POST /version?id=<fileNodeId>&name=<n>&type=<mime>  body = the raw bytes, same cap                                               -> { node }   a new VERSION of that file
//   POST /folder   { parent: <project or group id>, name }   -> { node }
//   POST /rename   { id, name }                                -> { node }
//   POST /move     { id, to: <project or group id> }          -> { node }   (a file into/out of a group of the same project)
//   DELETE anything                                             -> 405 { code: 'nodelete' }
//   GET  /mount                         -> CrmMountStatus
//   POST /mount    {}                   -> CrmMountStatus   (start the drive)
//   POST /unmount  {}                   -> CrmMountStatus
//   POST /mount/auto   { on: boolean }  -> CrmMountStatus   (o6e65: mount the drive by itself while the CRM is signed in; ON by default, OFF is the old press-Start way)
//   GET  /mount/letters                 -> { current: "Y:", free: ["D:", ...] }   (S2: the letter in use and the free ones, D: to Z:)
//   POST /mount/letter { letter: "Z:" } -> CrmMountStatus   (S2: choose another FREE letter; a letter something else holds is refused with 409; the drive restarts on the new one)
//   POST /mount/saves  { on: boolean }  -> CrmMountStatus   (S9b: "Save into the drive": whether the in-app drive takes saves into the CRM; OFF by default = read-only; applied by restarting the drive)
//   POST /mount/driver { via: 'auto' | 'native' | 'winfsp' | 'webdav' } -> CrmMountStatus   (o6e65: how the Windows drive is made; Automatic uses the in-app WinFsp drive (S9a, read-only for now) and falls back to the WinFsp program, then to the built-in WebDAV)
//   POST /mount/reveal { what: 'drive' | 'pending' | 'recovered' } -> { ok: true }   (o6e65: open File Explorer on one of THREE fixed places; no path is ever taken from the request)
//   GET  /spool                         -> { entries: CrmSpoolEntry[], dir }   (o6e65 S5: saves kept on this PC until the CRM has them: the waiting list)
//   GET  /removed                       -> { removed: CrmRemovedProject[] }   (S6: projects whose access was removed; the drive shows them in an "Access removed" folder with what is still on this PC for them)
//   POST /removed/dismiss { id }        -> the same   (forget one entry; nothing is deleted)
//   GET  /ignore                        -> { defaults: boolean, keptHere: number }   (S7: the built-in .driveignore defaults are on; how many saves are kept on this PC only by a rule)
//   POST /ignore { defaults: boolean }  -> the same   (switch the built-in defaults: ~$*, *.tmp, Thumbs.db, desktop.ini, .DS_Store, node_modules, *.crdownload)
//   POST /spool/retry  { id?: string }  -> { entries, retried }   (try one waiting save again now, or all of them when no id; a refused one is tried again too)
//
// od0b1 (U1): uploads of ANY size the CRM takes, in parts, held by the AGENT (no WebDAV in the way, no 5-minute single request). The page sends the file to this PC in parts; the agent
// keeps them in its pending folder (<agent state>/crm-uploads) and sends them on to Google Drive in CRM_UPLOAD_CHUNK pieces through ONE resumable session (the CRM's own way), with retries,
// a cap on how many go at once, pause/resume, and it carries on after a restart (Google says how far it got). At the end it checks Google's size and md5 against its own, then makes the
// CRM record (a new file, or a new version) exactly as the one-request upload above does. The page can close once the bytes are on this PC. No file is ever deleted: cancel ends the
// upload and drops only the agent's own copy. shared/crm-upload-client.ts is the page's helper for these routes.
//   GET  /uploads                      -> CrmUploadList         (every upload the agent holds, newest first; done/cancelled ones stay a day)
//   GET  /uploads?id=<id>              -> CrmUpload
//   POST /uploads/start  CrmUploadStart -> CrmUpload            (everything is checked FIRST: rights, name, kind of file, size, room on this PC's disk; nothing is sent yet)
//   PUT  /uploads/part?id=<id>&offset=<n>  body = the next bytes of the file (Content-Length, 1..CRM_UPLOAD_MAX_PART) -> CrmUpload
//                                         409 'offset' { upload } when offset is not where the agent is (go on from upload.received); 409 'paused' when paused; 409 'busy' while a part is still arriving
//   POST /uploads/pause  { id }        -> CrmUpload    POST /uploads/resume { id } -> CrmUpload
//   POST /uploads/retry  { id }        -> CrmUpload    (a failed one: from where Google has it; after a checksum mismatch, from the start)
//   POST /uploads/cancel { id }        -> CrmUpload    (stops it; the agent's copy is dropped; nothing in the CRM or Google Drive is touched)
//   POST /uploads/clear  { id }        -> { ok: true } (forgets a done or cancelled one)
//   GET  /uploads/settings             -> CrmUploadSettingsView   (oa2f8: the size limit and where it comes from, the waiting folder, its free space, the warning line)
//   POST /uploads/settings CrmUploadSettingsChange -> CrmUploadSettingsView   (409 'conflict' to move the folder while uploads wait in it; 400 'failed' for a folder that can not be used)
// Errors are { error: <plain sentence>, code } with the status below. A CRM that is not signed in is 409 'crm-signin' (not 401: 401 is this app's own sign-in, F-118).

export const CRM_FILES_BASE = '/agentic/crm-files'
/** The most one upload may be (bytes). Larger files are refused with 413 'toolarge' before anything is sent to the CRM. */
export const CRM_FILES_MAX_UPLOAD = 500 * 1024 * 1024

export type CrmNodeKind =
  | 'root' //      id 'root': the list of categories
  | 'category' //  a `folder` tag of the CRM ("general", "projects", ...): id 'cat:<tag>'
  | 'project' //   one linked project under the "projects" tag (or "Uncategorised"): id 'proj:<projectId>'; 'proj:none' is "Uncategorised"
  | 'group' //     a file group of a project (nested through parent): id 'grp:<projectId>:<groupId>'
  | 'file' //      a CRM file: id 'file:<fileId>'

/** What this person may do with a node. The page shows a button only when it is true; the agent refuses the rest (403 'forbidden'). */
export interface CrmRights {
  /** Download / open (a file), or list (a folder). */
  open: boolean
  /** Put a NEW file into this folder. */
  upload: boolean
  /** Make a new folder (file group) in this project or group. */
  mkdir: boolean
  /** Rename this node (a file, or a group). Categories and projects are the CRM's own and are never renamed here. */
  rename: boolean
  /** Move this node (a file or group) to another group of the same project. */
  move: boolean
  /** Save over this file as a new version. */
  version: boolean
}

export interface CrmNode {
  id: string
  kind: CrmNodeKind
  /** The CRM's own name, as the CRM shows it. (The Windows/Linux mount makes a legal name of it; this field never changes.) */
  name: string
  parentId: string | null
  isFolder: boolean
  /** Files: bytes and the stored mime type. */
  size?: number
  type?: string
  /** ISO times from the CRM's records. A category and the root have none. */
  createdAt?: string
  modifiedAt?: string
  /** Files: how many versions the CRM keeps. */
  versions?: number
  /** Folders: how many children (files and folders). */
  childCount?: number
  rights: CrmRights
  /** ocbbf: kept on this PC. `via` is 'self' (pinned here) or 'folder' (its folder or project is pinned); `ready` is whether a finished copy is on this PC now (files). Left out: not kept. */
  pin?: CrmPinMark
}

/** ocbbf: "Keep on this PC" on one node (see CrmNode.pin). */
export interface CrmPinMark {
  via: 'self' | 'folder'
  ready: boolean
}

/** ocbbf: what the page shows about what is kept on this PC: the usage, the limit, what waits, and what was kept after an access was removed. */
export interface CrmPinStatus {
  pinnedFiles: number
  pinnedBytes: number
  cacheBytes: number
  quotaBytes: number
  pinnedOverQuota: boolean
  queued: number
  waitingRetry: boolean
  waitingForSpace: number
  sizeUnknown: number
  heldAfterRemoval: number
}

/** ocbbf: the pins view: the status, the limit in MB, the explicit pins (with names), and whether the cache folder is the default one. */
export interface CrmPins {
  status: CrmPinStatus
  quotaMb: number
  pins: { id: string; kind: 'file' | 'folder'; name: string; since: number }[]
}

export interface CrmChildren {
  node: CrmNode
  children: CrmNode[]
  /** The breadcrumb from the root to this node. */
  path: { id: string; name: string }[]
  /** P1: only with `limit` on the request: how many children the folder has in all (`children` holds the first `limit` of them). */
  total?: number
}

/** P1: one file or project that a name search found, with where it is ("projects / Website redesign / Designs"). */
export interface CrmSearchHit {
  node: CrmNode
  path: string
}

export interface CrmSearch {
  results: CrmSearchHit[]
  /** There are more than were returned (the search is cut at `limit`). */
  more: boolean
}

export interface CrmVersion {
  number: number
  name: string
  size: number | null
  createdAt: string
  /** The CRM account that saved it, when the CRM says. */
  by?: string
}

export type CrmWinfsp = 'installed' | 'missing' | 'unsupported'

export interface CrmMountStatus {
  /** This PC can mount at all: Windows with the drive program built in, or Linux with GNOME gvfs. */
  supported: boolean
  /** Windows: the WinFsp driver. Linux: GNOME's gvfs (gio mount). 'unsupported' for any other OS. */
  driver: CrmWinfsp
  /** The driver's name for the page ("WinFsp" / "GNOME Files (gvfs)"). */
  driverName: string
  /** The drive program is running. */
  running: boolean
  mounted: boolean
  /** Windows: "Y:". Linux: "Files › CRM files", or the /run/user/<uid>/gvfs/... folder once it is mounted. */
  where: string
  /** Plain sentence for the person when something stops it; null when all is well. */
  reason: string | null
  /** A machine word for the reason, so the page can show the right button: */
  reasonCode: null | 'driver-missing' | 'crm-signin' | 'letter-taken' | 'host-missing' | 'no-desktop' | 'unsupported' | 'webclient' | 'failed'
  /** The driver installer is known and could be offered (with the person's yes). False when none is pinned for this PC yet. */
  installable: boolean
  /** Writes are on (always true for the first build; Shubham asked for the old drive's rights). Delete is never on. */
  writable: boolean
  /** Saves that are still waiting to go up (the old drive kept a pending folder). */
  waiting: number
  /** o6e65: the drive mounts by itself while the CRM is signed in (the old app did). Left out where the PC has no such thing (Linux). */
  autoMount?: boolean
  /** o6e65: where the drive keeps a save until the CRM has it, and where one that could not be put back is kept (never deleted): shown to the person. Windows only. */
  pendingDir?: string
  recoveredDir?: string
  /** o6e65 (S5): the folder where saves are kept on this PC until the CRM has them (the spool). Present when this agent keeps them; `waiting` counts them (and the old host's, when that way is used). */
  spoolDir?: string
  /** S9a2: when (ISO time) the in-app drive was found to have stopped the agent (its marker was still there at the agent's start). While set, the in-app way is OFF (Automatic uses the other ways) until the person chooses In-app or Automatic again. */
  inAppCrash?: string
  /** o6e65 (S4, Windows): which way the drive is (or would be) made: the drive program through WinFsp, or Windows' own WebDAV client (nothing to install, no program of ours). */
  mountVia?: CrmVia
  /** o6e65: what the person chose: 'auto' (WinFsp, and the built-in WebDAV where the drive program cannot run or WinFsp is missing), or one of the two. */
  driverChoice?: CrmDriverChoice
  /** S9b: the "Save into the drive" setting of the in-app drive: false (the default) = read-only; true = a save, a copy or a drag into the drive is saved into the CRM. Left out where there is no in-app drive. */
  saveInto?: boolean
  /** S2: the drive letter in use ("Y:" unless the person chose another); left out where this PC has no drive of ours. */
  driveLetter?: string
}

export type CrmVia = 'native' | 'winfsp' | 'webdav'
export type CrmDriverChoice = 'auto' | CrmVia
export const CRM_DRIVER_CHOICES: readonly CrmDriverChoice[] = ['auto', 'native', 'winfsp', 'webdav']

/** o6e65 (S5): where a kept save is: 'waiting' (its turn has not come, or it was just kept), 'sending' (going up now), 'unreachable' (the CRM or the internet is not there; it is tried again by itself), 'refused' (the CRM said no for good: no right, the folder is gone, the name is taken; it is kept, never deleted). */
export type CrmSpoolState = 'waiting' | 'sending' | 'unreachable' | 'refused' | 'ignored'

/** One save kept on this PC until the CRM has it (the waiting list of the page; the number "waiting" everywhere is the length of this list, without the ignored ones). S7: 'ignored' = a .driveignore rule (or the built-in list of editor and system files) keeps it on this PC only: it is never sent to the CRM and never deleted. */
export interface CrmSpoolEntry {
  id: string
  /** 'new' = a new file in a folder; 'version' = a new version of a CRM file. */
  kind: 'new' | 'version'
  name: string
  /** The project (or folder) it goes to, when known. */
  project: string | null
  size: number
  /** When it was saved (ISO time). */
  since: string
  state: CrmSpoolState
  /** Plain words for why it is not in the CRM yet; null while all is well. */
  reason: string | null
  /** How many times sending it failed. */
  attempts: number
}

/** S6: a project whose access was removed (the CRM stopped listing it for this account): shown in the "Access removed" folder of the drive and on the page until dismissed. */
export interface CrmRemovedProject {
  id: string
  name: string
  /** When it was found removed (ms since 1970). */
  since: number
  /** How many saves for it are still kept on this PC. */
  saves: number
}

export interface CrmSpool {
  entries: CrmSpoolEntry[]
  /** The folder on this PC where the kept saves are (the "Open the folder" button opens it). */
  dir: string
}

/** o6e65: the places the agent will open in File Explorer (and nothing else): the drive itself, the old host's waiting saves, its recovered saves, and (S5) the folder of saves kept by this agent. */
export type CrmReveal = 'drive' | 'pending' | 'recovered' | 'spool'
export const CRM_REVEALS: readonly CrmReveal[] = ['drive', 'pending', 'recovered', 'spool']

export interface CrmFilesStatus {
  /** The CRM is signed in on this PC. */
  signedIn: boolean
  /** Whose view this is (the CRM account). */
  account: { name: string; username: string | null } | null
  /** Shown instead of the tree when not signed in. */
  reason: string | null
  mount: CrmMountStatus
}

export type CrmFilesErrorCode =
  | 'crm-signin'
  | 'forbidden'
  | 'notfound'
  | 'conflict'
  | 'nodelete'
  | 'toolarge'
  | 'badname'
  | 'crm-down'
  | 'driver-missing'
  | 'unsupported'
  | 'failed'
  // od0b1 (uploads in parts): the part is not where the upload is (409, the answer carries { upload }), it is paused (409), a part is still arriving (409), the CRM does not take this kind of file (400),
  // this PC's disk has no room for it (507), the agent holds too many uploads (429).
  | 'offset'
  | 'paused'
  | 'busy'
  | 'blocked'
  | 'nospace'
  | 'toomany'

/** The statuses: crm-signin 409, forbidden 403, notfound 404, conflict 409 (a name already used in that folder: nothing changed), nodelete 405, toolarge 413, badname 400, crm-down 502. */
export const CRM_FILES_REASONS = {
  signedOut: 'The CRM is not signed in on this PC. Sign in from Devices, then open the CRM files.',
  winfspMissing: 'WinFsp is not installed on this PC. It is the small driver that lets the CRM files appear as a drive. Install it (it asks for your OK) and start the drive again.',
  gvfsMissing: "GNOME's network-drive part (gvfs-backends) is not on this PC, so the CRM files cannot appear in Files. They can still be browsed here.",
  noDesktop: "The CRM drive shows in Files only when someone is signed in to this PC's desktop.",
  hostMissing: 'The CRM drive program is not part of this build yet, so the drive cannot start. The files can still be browsed here.',
  letterTaken: 'Y: is already used by another drive. Free it, or the CRM drive cannot start.',
  unsupported: 'The CRM drive is for Windows and Linux PCs.',
  noDelete: 'CRM files are never deleted from here. Delete them in the CRM itself.',
  crmDown: 'The CRM did not answer. Try again in a moment.',
  noFolder: 'That folder does not exist yet: nothing has been saved through the drive.',
  notMounted: 'The drive is not mounted.',
} as const

// ---- od0b1 (U1): uploads in parts, held by the agent ------------------------------------------------------------------

/** Google's unit: every piece of a resumable upload but the last is a whole number of these (256 KiB). */
export const CRM_UPLOAD_UNIT = 256 * 1024
/** What the agent sends to Google in one request (16 MiB: a multiple of CRM_UPLOAD_UNIT; Google asks for at least 8 MiB for speed). A broken line costs at most this much. */
export const CRM_UPLOAD_CHUNK = 16 * 1024 * 1024
/** What the page sends to the agent in one request by default (8 MiB); any size from 1 byte up to CRM_UPLOAD_MAX_PART is taken. */
export const CRM_UPLOAD_PART = 8 * 1024 * 1024
export const CRM_UPLOAD_MAX_PART = 64 * 1024 * 1024
/** How many uploads go to Google at the same time (the rest wait their turn). */
export const CRM_UPLOAD_PARALLEL = 3

/**
 * Where an upload is:
 *   receiving  the page is still sending the file to this PC (what is here already goes on to Google)
 *   waiting    waiting for its turn, or for its next try after a broken line (`note`, `retryAt`)
 *   sending    going to Google Drive now
 *   saving     all in Google Drive; the CRM is being told (its record, or the new version)
 *   paused     stopped by the person; resume carries on where it was
 *   failed     stopped for a reason in `note` (a retry may fix it); the bytes are kept on this PC
 *   done       in the CRM (`node`); the agent's copy is gone
 *   cancelled  stopped for good by the person; the agent's copy is gone; nothing was changed in the CRM
 */
export type CrmUploadState = 'receiving' | 'waiting' | 'sending' | 'saving' | 'paused' | 'failed' | 'done' | 'cancelled'

export type CrmUploadKind = 'new' | 'version'

export interface CrmUploadStart {
  /** 'new': a new file into `target` (a project or one of its groups); 'version': a new version of the file `target`. */
  kind: CrmUploadKind
  target: string
  /** The file's name (a new version keeps the CRM's own name for the record). */
  name: string
  type?: string
  size: number
  /** The page's file's lastModified (ms), kept so the same file can be matched after a reload. */
  lastModified?: number
  /** A key the page makes once per file: the same start sent twice (a retried request) gives the same upload. */
  clientKey?: string
}

export interface CrmUpload {
  id: string
  kind: CrmUploadKind
  target: string
  name: string
  type: string
  size: number
  lastModified?: number
  clientKey?: string
  /** Bytes this PC has of the file. */
  received: number
  /** Bytes Google Drive has. */
  sent: number
  state: CrmUploadState
  /** A plain sentence when it waits for a reason or failed; null when all is well. */
  note: string | null
  /** A machine word for the note (a CrmFilesErrorCode, or 'network' / 'google' / 'integrity' / 'copy-gone'). */
  code?: string
  /** While it waits after a broken line: when the next try is (ms since 1970). */
  retryAt?: number
  /** done: how the copy in Google Drive was checked: its md5 matched ('md5'), or Google gave none and its size matched ('size'). */
  checked?: 'md5' | 'size'
  /** done: the file in the CRM. */
  node?: CrmNode
  /** done, when the name was taken meanwhile: the name the CRM keeps it under ("Report (2).pdf"). */
  savedAs?: string
  createdAt: number
  updatedAt: number
}

export interface CrmUploadList {
  uploads: CrmUpload[]
  /** The most one file may be (the CRM's own rule), the part size the agent likes, how many go at once. */
  maxSize: number
  partSize: number
  parallel: number
  /** oa2f8: where `maxSize` comes from (see CrmUploadSettingsView). Left out by an older agent. */
  maxSizeFrom?: CrmUploadLimitFrom
  /** oa2f8: the waiting folder, its disk's free space and what the uploads hold there. Left out by an older agent. */
  space?: CrmUploadSpace
}

// ---- oa2f8: the uploads' settings (Shubham, 11 Nov 2026: the CRM's limit as a setting, read from the CRM where possible; the waiting folder a setting, free space shown, a warning when low)

/** Where the size limit in force comes from: the CRM said it ('crm'), the person set a number ('setting'), or neither, so the CRM's known rule of 500 MB ('default'). */
export type CrmUploadLimitFrom = 'crm' | 'setting' | 'default'

/** What the person sets (POST /uploads/settings takes any of these; a field left out stays as it is). */
export interface CrmUploadSettings {
  /** The most one file may be, in MB. null = follow the CRM: its own limit when the CRM has said it, else CRM_FILES_MAX_UPLOAD. A number is used as it is, but never above what the CRM said it takes. */
  limitMb: number | null
  /** The waiting folder: a folder on this PC's own disks. null = the agent's own folder (`defaultDir`). It changes only while nothing is waiting there. */
  dir: string | null
  /** A warning shows when the waiting folder's disk would have less than this free (MB) once the uploads on their way are in. */
  lowFreeMb: number
}

/**
 * The CRM's own limit as the CRM last said it: in its refusal of a real record ('refused': "file_size must not exceed N bytes"), or in its upload token's answer ('token', should the CRM
 * ever add the number there). The agent never asks the CRM for it.
 */
export interface CrmUploadCrmLimit {
  bytes: number
  /** When it was said (ms since 1970). */
  at: number
  how: 'refused' | 'token'
}

export interface CrmUploadSpace {
  /** The waiting folder in use now. */
  dir: string
  /** Free bytes on its disk, or null when that can not be read. */
  free: number | null
  /** Bytes the uploads not yet done hold in it now (their copies). */
  held: number
  /** Bytes still to come from the pages for them. */
  coming: number
  /** The warning line (bytes): `low` is true when free - coming is under it. */
  lowFree: number
  low: boolean
  /** A plain sentence for the page when something is wrong (low space, a folder that can not be used now); null when all is well. */
  note: string | null
}

/** GET /uploads/settings (and the answer to POST): the person's settings, and what is in force now. */
export interface CrmUploadSettingsView extends CrmUploadSettings {
  /** The agent's own folder, used when `dir` is null. */
  defaultDir: string
  maxSize: number
  maxSizeFrom: CrmUploadLimitFrom
  /** null until the CRM has said its limit. */
  crmLimit: CrmUploadCrmLimit | null
  space: CrmUploadSpace
}

/** POST /uploads/settings: the fields to change (one left out stays as it is). */
export type CrmUploadSettingsChange = Partial<CrmUploadSettings>

/** The defaults: follow the CRM, the agent's own folder, warn below 5 GB free. */
export const CRM_UPLOAD_LOW_FREE_MB = 5 * 1024
/** A limit the person types is 1 MB to 5 TB (Google Drive's own most for one file). */
export const CRM_UPLOAD_LIMIT_MB_MAX = 5 * 1024 * 1024

/** The kinds of file the CRM's backend refuses to record (sam-crm-be middleware/fileValidation.js, 11 Nov 2026): refused BEFORE any byte goes up. */
export const CRM_BLOCKED_EXTENSIONS: readonly string[] = ['.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.pif', '.vbs', '.vbe', '.js', '.ws', '.wsf', '.wsc', '.wsh', '.ps1', '.ps2', '.psc1', '.psc2', '.reg', '.inf', '.lnk']
export const CRM_BLOCKED_TYPES: readonly string[] = ['application/x-msdownload', 'application/x-executable', 'application/x-dosexec', 'application/x-msdos-program', 'text/x-sh', 'text/x-shellscript']

/** Why the CRM would refuse this file's kind, or null. (Its own check, done here first so a 400 MB upload is not sent only to be refused.) */
export function blockedKind(name: string, type?: string): string | null {
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot).trim().toLowerCase()
  if (ext && CRM_BLOCKED_EXTENSIONS.includes(ext)) return `The CRM does not take ${ext} files.`
  if (type && CRM_BLOCKED_TYPES.includes(type.trim().toLowerCase())) return `The CRM does not take files of the type ${type.trim()}.`
  return null
}

export const CRM_UPLOAD_REASONS = {
  tooLarge: (max: number) => `A file is at most ${Math.round(max / 1024 / 1024)} MB in the CRM (its own rule).`,
  noSpace: 'This PC does not have room for that file in its waiting folder. Free some disk space and start again.',
  tooMany: 'This PC is holding too many uploads. Let some finish (or cancel some) first.',
  paused: 'That upload is paused. Resume it first.',
  busy: 'A part of that upload is still arriving. Wait for it.',
  ended: 'That upload has ended.',
  gone: 'That upload is not known (it may have ended a while ago).',
  network: 'The line to Google Drive broke. Trying again.',
  google: 'Google Drive did not take it. Trying again.',
  googleRefused: 'Google Drive refused the upload.',
  crmDown: 'The CRM did not answer. Trying again.',
  signIn: 'The CRM is not signed in on this PC. It carries on once it is.',
  integrity: 'The copy in Google Drive does not match this file (its checksum differs), so the CRM was not told. Retry sends it again.',
  copyGone: "This PC's copy of the file is gone. Upload it again.",
  needFile: 'The page was closed before the whole file reached this PC. Pick the same file again to go on.',
  // oa2f8: the settings
  tooLargeHere: (max: number) => `A file is at most ${Math.round(max / 1024 / 1024)} MB here (the upload settings).`,
  tooLargeForCrm: (max: number) => `The CRM takes files up to ${Math.round(max / 1024 / 1024)} MB (it said so itself). This one is bigger, so the CRM did not record it; the copy in Google Drive has no CRM record.`,
  // (GB as the page writes sizes: 1 GB = 1,000,000,000 bytes, shared/file-names.ts sizeText.)
  lowSpace: (free: number) => `Low disk space for the waiting uploads: ${(free / 1e9).toFixed(1)} GB free. Free some space, or choose another waiting folder in the upload settings.`,
  dirBusy: (n: number) => `${n} upload${n === 1 ? ' is' : 's are'} still waiting in the waiting folder. Let ${n === 1 ? 'it' : 'them'} finish (or cancel ${n === 1 ? 'it' : 'them'}), then change the folder.`,
  dirBad: (why: string) => `That folder can not be used for the waiting uploads: ${why}`,
  dirMissing: (dir: string) => `The waiting folder (${dir}) can not be used now. Check that its disk is there, or choose another folder in the upload settings.`,
} as const

// ---- fixtures, for the page's tests and for a mock (fake names only) -------------------------------------------------

const ALL: CrmRights = { open: true, upload: true, mkdir: true, rename: true, move: true, version: true }
const READ: CrmRights = { open: true, upload: false, mkdir: false, rename: false, move: false, version: false }
const FOLDER_READ: CrmRights = READ

export const CRM_FILES_FIXTURE: CrmNode[] = [
  { id: 'root', kind: 'root', name: 'CRM files', parentId: null, isFolder: true, childCount: 3, rights: FOLDER_READ },
  { id: 'cat:general', kind: 'category', name: 'general', parentId: 'root', isFolder: true, childCount: 1, rights: FOLDER_READ },
  { id: 'cat:projects', kind: 'category', name: 'projects', parentId: 'root', isFolder: true, childCount: 2, rights: FOLDER_READ },
  { id: 'cat:invoices', kind: 'category', name: 'invoices', parentId: 'root', isFolder: true, childCount: 1, rights: FOLDER_READ },
  { id: 'file:11111111-1111-4111-8111-111111111111', kind: 'file', name: 'Company profile.pdf', parentId: 'cat:general', isFolder: false, size: 2_480_113, type: 'application/pdf', createdAt: '2026-10-02T09:14:00.000Z', modifiedAt: '2026-10-02T09:14:00.000Z', versions: 1, rights: { ...READ, version: true, rename: true, move: false } },
  { id: 'proj:22222222-2222-4222-8222-222222222222', kind: 'project', name: 'Website redesign', parentId: 'cat:projects', isFolder: true, createdAt: '2026-09-20T07:00:00.000Z', childCount: 2, rights: { ...READ, upload: true, mkdir: true } },
  { id: 'proj:none', kind: 'project', name: 'Uncategorised', parentId: 'cat:projects', isFolder: true, childCount: 0, rights: READ },
  { id: 'grp:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333', kind: 'group', name: 'Designs', parentId: 'proj:22222222-2222-4222-8222-222222222222', isFolder: true, createdAt: '2026-09-21T10:30:00.000Z', childCount: 1, rights: ALL },
  { id: 'file:44444444-4444-4444-8444-444444444444', kind: 'file', name: 'Homepage v3.fig', parentId: 'grp:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333', isFolder: false, size: 14_200_000, type: 'application/octet-stream', createdAt: '2026-10-11T15:02:00.000Z', modifiedAt: '2026-10-29T12:40:00.000Z', versions: 4, rights: ALL },
  { id: 'file:55555555-5555-4555-8555-555555555555', kind: 'file', name: 'Brief.docx', parentId: 'proj:22222222-2222-4222-8222-222222222222', isFolder: false, size: 48_211, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', createdAt: '2026-09-22T08:00:00.000Z', modifiedAt: '2026-09-22T08:00:00.000Z', versions: 1, rights: ALL },
  { id: 'file:66666666-6666-4666-8666-666666666666', kind: 'file', name: 'INV-2026-114.pdf', parentId: 'cat:invoices', isFolder: false, size: 91_377, type: 'application/pdf', createdAt: '2026-10-30T11:11:00.000Z', modifiedAt: '2026-10-30T11:11:00.000Z', versions: 1, rights: READ },
]

const CRM_SPOOL_FIXTURE_DIR = 'C:\\Users\\you\\AppData\\Local\\shubham-agentic\\agent\\agentic\\crm-spool'

export const CRM_MOUNT_FIXTURE: Record<'ready' | 'running' | 'native' | 'webdav' | 'winfspMissing' | 'signedOut' | 'linuxNoGvfs' | 'linuxNoDesktop', CrmMountStatus> = {
  ready: { supported: true, driver: 'installed', driverName: 'WinFsp', running: false, mounted: false, where: 'Y:', reason: null, reasonCode: null, installable: true, writable: true, waiting: 0, autoMount: true, mountVia: 'winfsp', driverChoice: 'auto', pendingDir: 'C:\\Users\\you\\AppData\\Local\\ChristopherOS\\crm-fs\\pending-Y', recoveredDir: 'C:\\Users\\you\\AppData\\Local\\ChristopherOS\\crm-fs\\recovered-Y', spoolDir: CRM_SPOOL_FIXTURE_DIR },
  running: { supported: true, driver: 'installed', driverName: 'WinFsp', running: true, mounted: true, where: 'Y:', reason: null, reasonCode: null, installable: true, writable: true, waiting: 2, autoMount: true, pendingDir: 'C:\\Users\\you\\AppData\\Local\\ChristopherOS\\crm-fs\\pending-Y', recoveredDir: 'C:\\Users\\you\\AppData\\Local\\ChristopherOS\\crm-fs\\recovered-Y' },
  native: { supported: true, driver: 'installed', driverName: 'WinFsp (inside the app)', running: true, mounted: true, where: 'Y:', driveLetter: 'Y:', reason: null, reasonCode: null, installable: true, writable: false, waiting: 0, autoMount: true, mountVia: 'native', driverChoice: 'auto', saveInto: false, spoolDir: CRM_SPOOL_FIXTURE_DIR },
  webdav: { supported: true, driver: 'installed', driverName: 'Windows WebDAV (built in)', running: true, mounted: true, where: 'Y:', reason: null, reasonCode: null, installable: false, writable: true, waiting: 0, autoMount: true, mountVia: 'webdav', driverChoice: 'auto', spoolDir: CRM_SPOOL_FIXTURE_DIR },
  winfspMissing: { supported: true, driver: 'missing', driverName: 'WinFsp', running: false, mounted: false, where: 'Y:', reason: CRM_FILES_REASONS.winfspMissing, reasonCode: 'driver-missing', installable: true, writable: true, waiting: 0 },
  signedOut: { supported: true, driver: 'installed', driverName: 'WinFsp', running: false, mounted: false, where: 'Y:', reason: CRM_FILES_REASONS.signedOut, reasonCode: 'crm-signin', installable: true, writable: true, waiting: 0 },
  linuxNoGvfs: { supported: true, driver: 'missing', driverName: 'GNOME Files (gvfs)', running: false, mounted: false, where: 'Files › CRM files', reason: CRM_FILES_REASONS.gvfsMissing, reasonCode: 'driver-missing', installable: false, writable: true, waiting: 0 },
  linuxNoDesktop: { supported: true, driver: 'installed', driverName: 'GNOME Files (gvfs)', running: false, mounted: false, where: 'Files › CRM files', reason: CRM_FILES_REASONS.noDesktop, reasonCode: 'no-desktop', installable: false, writable: true, waiting: 0 },
}

export const CRM_FILES_STATUS_FIXTURE: CrmFilesStatus = {
  signedIn: true,
  account: { name: 'Shubham', username: 'sbskrrt' },
  reason: null,
  mount: CRM_MOUNT_FIXTURE.ready,
}
