import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ApiMount } from '../api.ts'
import type { CrmProxy } from '../agentic/crmproxy.ts'
import { createWinMount } from './mount-win.ts'
import { crmFilesMount } from './routes.ts'
import { createCrmFiles, type CrmFilesService, type MountDriver } from './service.ts'

// F-126: the CRM files module of the agent: the tree and its changes (service.ts), the page's routes (routes.ts), and the mount of this PC. On Windows the mount is crm-fs.exe through
// WinFsp (mount-win.ts); on Linux the Linux agent brings its own driver (a loopback WebDAV that GNOME's gvfs mounts) and passes it in as `mountDriver`; anywhere else it says it is not
// supported. The Linux part calls `service` directly, in the same process, so no token is handled at all.

export interface CrmFilesModule {
  service: CrmFilesService
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

export function createCrmFilesModule(o: CrmFilesModuleOptions): CrmFilesModule {
  const client = {
    request: o.proxy.request.bind(o.proxy),
    session: () => {
      const s = o.proxy.session()
      return { signedIn: s.signedIn, name: s.name, username: s.username }
    },
  }
  const win =
    !o.mountDriver && process.platform === 'win32'
      ? createWinMount({
          exe: hostExe(o.root),
          exeSha256: hostSha256(o.root),
          dir: o.dir,
          signedIn: () => client.session().signedIn,
          bridge: { client, forward: (req, res, sub, search) => o.proxy.handle(req, res, sub, search) },
          log: o.log,
        })
      : null
  const driver = o.mountDriver ?? win ?? undefined
  const service = createCrmFiles({ client, mountDriver: driver })
  return {
    service,
    mount: crmFilesMount(service),
    resume: async () => void (await (win ?? o.mountDriver)?.resume?.()),
    close: async () => void (await (win ?? o.mountDriver)?.close?.()),
  }
}
