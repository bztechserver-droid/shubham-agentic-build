// F-126: the CRM's files in this app. The agent shows exactly what the CRM's "Files" page shows to the CRM account signed in on THIS PC (crm-session.json,
// F-007), builds the same tree the old agentic-claude-manager drive built, and can mount it as a drive (Windows: Y: through WinFsp; Linux: GNOME gvfs over a loopback WebDAV listener).
//
// The CRM's own records decide what is a file and where it is (the `files`, `file_groups` and `file_versions` tables), NOT the Google Drive folders.
// Every write goes through the CRM's own routes (new file, new version, rename, move, new folder), never to Google directly. There is NO delete, anywhere:
// a DELETE is refused with code 'nodelete'. The Common Drive (F-097) and its Google backup (F-125) are a different thing and a different folder.
//
// Mount: Windows mounts Y: through WinFsp (a host program); Linux runs a loopback WebDAV listener inside the agent and lets GNOME's gvfs mount it (no root, nothing installed).
// The Linux agent calls the module's CrmFilesService in-process (agent/crm-files/service.ts) instead of going through these routes.
//
// Routes (all JSON unless said; prefix /agent-api/agentic/crm-files; for the owner like the other PC pages):
//   GET  /status                       -> CrmFilesStatus
//   GET  /children?id=<nodeId|root>    -> CrmChildren          (children of a folder node; the tree is cached ~5 s like the old drive)
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
// Errors are { error: <plain sentence>, code } with the status below. A CRM that is not signed in is 409 'crm-signin' (not 401: 401 is this app's own sign-in, F-118).

export const CRM_FILES_BASE = '/agentic/crm-files'
/** The most one upload may be (bytes). Larger files are refused with 413 'toolarge' before anything is sent to the CRM. */
export const CRM_FILES_MAX_UPLOAD = 500 * 1024 * 1024

export type CrmNodeKind =
  | 'root' //      id 'root': the list of categories
  | 'category' //  a `folder` tag of the CRM ("general", "projects", ...): id 'cat:<tag>'
  | 'project' //   one linked project under the "projects" tag (or "Uncategorised"): id 'proj:<projectId>'; 'proj:none' is "Uncategorised"
  | 'group' //     a file group of a project (nested through parent): id 'grp:<groupId>'
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
}

export interface CrmChildren {
  node: CrmNode
  children: CrmNode[]
  /** The breadcrumb from the root to this node. */
  path: { id: string; name: string }[]
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
  reasonCode: null | 'driver-missing' | 'crm-signin' | 'letter-taken' | 'host-missing' | 'no-desktop' | 'unsupported' | 'failed'
  /** The driver installer is known and could be offered (with the person's yes). False when none is pinned for this PC yet. */
  installable: boolean
  /** Writes are on (always true for the first build; Shubham asked for the old drive's rights). Delete is never on. */
  writable: boolean
  /** Saves that are still waiting to go up (the old drive kept a pending folder). */
  waiting: number
}

export interface CrmFilesStatus {
  /** The CRM is signed in on this PC. */
  signedIn: boolean
  /** Whose view this is (the CRM account). */
  account: { name: string; username: string | null } | null
  /** Shown instead of the tree when not signed in. */
  reason: string | null
  mount: CrmMountStatus
}

export type CrmFilesErrorCode = 'crm-signin' | 'forbidden' | 'notfound' | 'conflict' | 'nodelete' | 'toolarge' | 'badname' | 'crm-down' | 'driver-missing' | 'unsupported' | 'failed'

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
  { id: 'grp:33333333-3333-4333-8333-333333333333', kind: 'group', name: 'Designs', parentId: 'proj:22222222-2222-4222-8222-222222222222', isFolder: true, createdAt: '2026-09-21T10:30:00.000Z', childCount: 1, rights: ALL },
  { id: 'file:44444444-4444-4444-8444-444444444444', kind: 'file', name: 'Homepage v3.fig', parentId: 'grp:33333333-3333-4333-8333-333333333333', isFolder: false, size: 14_200_000, type: 'application/octet-stream', createdAt: '2026-10-11T15:02:00.000Z', modifiedAt: '2026-10-29T12:40:00.000Z', versions: 4, rights: ALL },
  { id: 'file:55555555-5555-4555-8555-555555555555', kind: 'file', name: 'Brief.docx', parentId: 'proj:22222222-2222-4222-8222-222222222222', isFolder: false, size: 48_211, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', createdAt: '2026-09-22T08:00:00.000Z', modifiedAt: '2026-09-22T08:00:00.000Z', versions: 1, rights: ALL },
  { id: 'file:66666666-6666-4666-8666-666666666666', kind: 'file', name: 'INV-2026-114.pdf', parentId: 'cat:invoices', isFolder: false, size: 91_377, type: 'application/pdf', createdAt: '2026-10-30T11:11:00.000Z', modifiedAt: '2026-10-30T11:11:00.000Z', versions: 1, rights: READ },
]

export const CRM_MOUNT_FIXTURE: Record<'ready' | 'running' | 'winfspMissing' | 'signedOut' | 'linuxNoGvfs' | 'linuxNoDesktop', CrmMountStatus> = {
  ready: { supported: true, driver: 'installed', driverName: 'WinFsp', running: false, mounted: false, where: 'Y:', reason: null, reasonCode: null, installable: true, writable: true, waiting: 0 },
  running: { supported: true, driver: 'installed', driverName: 'WinFsp', running: true, mounted: true, where: 'Y:', reason: null, reasonCode: null, installable: true, writable: true, waiting: 2 },
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
