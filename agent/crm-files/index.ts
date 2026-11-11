import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ApiMount } from '../api.ts'
import type { CrmProxy } from '../agentic/crmproxy.ts'
import { createWinMount } from './mount-win.ts'
import { crmFilesMount } from './routes.ts'
import { createCrmFiles, type CrmFilesService, type MountDriver } from './service.ts'
import { CRM_FILES_MAX_UPLOAD } from '../../shared/crm-files.ts'
import { UPLOAD_SETTINGS_FILE } from './upload-settings.ts'
import { createCrmUploads, type CrmUploads } from './uploads.ts'

// F-126: the CRM files module of the agent: the tree and its changes (service.ts), the page's routes (routes.ts), and the mount of this PC. On Windows the mount is crm-fs.exe through
// WinFsp (mount-win.ts); on Linux the Linux agent brings its own driver (a loopback WebDAV that GNOME's gvfs mounts) and passes it in as `mountDriver`; anywhere else it says it is not
// supported. The Linux part calls `service` directly, in the same process, so no token is handled at all.

export interface CrmFilesModule {
  service: CrmFilesService
  /** od0b1: uploads of any size in parts, held by the agent (their pending folder is <dir>/crm-uploads). */
  uploads: CrmUploads
  mount: ApiMount
  /** At the agent's start: brings the Windows drive back if it was on. */
  resume(): Promise<void>
  close(): Promise<void>
}

export interface CrmFilesModuleOptions {
  /** The agent's state folder (crm-drive.json goes here). */
  dir: string
  proxy: CrmProxy
  /** The folder this agent runs from (the repo in Dev, the build when published): crm-fs.exe is under crm-fs/. */
  root: string
  /**
   * Bring the Windows drive up by itself at the agent's start (and keep watching the CRM sign-in). Default: yes, EXCEPT inside a test run (node's test runner sets NODE_TEST_CONTEXT): a test
   * that signs a fake CRM in must never mount a REAL drive on this PC (the in-app drive would take the letter). A test of the drive itself passes true and a spare letter.
   */
  autoStart?: boolean
  /** Another PC's driver (Linux). Left out on Windows: the WinFsp one is used. */
  mountDriver?: MountDriver & { resume?(): Promise<void>; close?(): Promise<void> }
  log?: { info(m: string): void; warn(m: string): void }
}

/** crm-fs.exe: next to the build (crm-fs/crm-fs.exe), or where a Dev build puts it. */
export function hostExe(root: string): string {
  const inBuild = path.join(root, 'crm-fs', 'crm-fs.exe')
  return existsSync(inBuild) ? inBuild : path.join(root, 'crm-fs', 'bin', 'Release', 'net48', 'crm-fs.exe')
}

/** The checksum the build recorded for the host (RELEASE.json "crmFsSha256"), or undefined. */
export function hostSha256(root: string): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(path.join(root, 'RELEASE.json'), 'utf8')) as { crmFsSha256?: unknown }).crmFsSha256
    return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** S5: the PC's file manager on a folder (the spool's), where this PC has one. */
function openFolderHere(dir: string) {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'linux' ? 'xdg-open' : null
  if (!cmd) throw new Error('This PC cannot open a folder from here.')
  const c = spawn(cmd, [dir], { detached: true, stdio: 'ignore' })
  c.on('error', () => undefined)
  c.unref()
}

export function createCrmFilesModule(o: CrmFilesModuleOptions): CrmFilesModule {
  const client = {
    request: o.proxy.request.bind(o.proxy),
    session: () => {
      const s = o.proxy.session()
      return { signedIn: s.signedIn, name: s.name, username: s.username }
    },
  }
  // o6e65: the built-in WebDAV way serves the same service the page uses (made just below).
  let serviceRef: CrmFilesService | null = null
  const win =
    !o.mountDriver && process.platform === 'win32'
      ? createWinMount({
          exe: hostExe(o.root),
          exeSha256: hostSha256(o.root),
          dir: o.dir,
          signedIn: () => client.session().signedIn,
          service: () => serviceRef,
          bridge: { client, forward: (req, res, sub, search) => o.proxy.handle(req, res, sub, search) },
          log: o.log,
        })
      : null
  const driver = o.mountDriver ?? win ?? undefined
  // oa2f8: the size limit is the uploads' setting (the CRM's own where it said it); the one-request upload and the drive's saves follow it too.
  let uploadsRef: CrmUploads | null = null
  const service = createCrmFiles({ client, mountDriver: driver, spoolDir: path.join(o.dir, 'crm-spool'), openFolder: openFolderHere, log: o.log, maxUpload: () => uploadsRef?.maxSize() ?? CRM_FILES_MAX_UPLOAD })
  serviceRef = service
  // oa2f8: the waiting folder is a setting (crm-uploads.json beside the default one); it may not be inside the app's own folder (an update replaces it).
  const uploads = createCrmUploads({ dir: path.join(o.dir, 'crm-uploads'), settingsFile: path.join(o.dir, UPLOAD_SETTINGS_FILE), notInside: [o.root], backend: service.uploadBackend, log: o.log })
  uploadsRef = uploads
  return {
    service,
    uploads,
    mount: crmFilesMount(service, uploads),
    resume: async () => {
      // The uploads that were going on when the agent stopped carry on, side by side with the drive coming back (neither waits for, or stops, the other).
      // They start in a test run too (their folder is the test's own); only the drive keeps S9a's rule of never mounting by itself there.
      const going = uploads.start().catch(e => o.log?.warn(`uploads: the pending folder could not be read (${e instanceof Error ? e.message : String(e)})`))
      try {
        if (o.autoStart === false || (o.autoStart === undefined && process.env.NODE_TEST_CONTEXT)) return
        await (win ?? o.mountDriver)?.resume?.()
      } finally {
        await going
      }
    },
    close: async () => {
      // S9a4 (Lead): the drive's own close is STARTED first (synchronously) and waited for last. Its first act, on Windows, is to remove the in-app drive's marker; the uploads and the spool
      // below can wait for a part or a send still in flight, and the agent may exit before they are done, and a marker left behind is read at the next start as a crash that switches the drive off.
      const driveClosing = (async () => (win ?? o.mountDriver)?.close?.())()
      driveClosing.catch(() => undefined)
      await uploads.close().catch(() => undefined)
      await service.spool?.close().catch(() => undefined)
      await driveClosing
    },
  }
}
