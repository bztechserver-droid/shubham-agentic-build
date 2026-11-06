import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { CRM_FILES_REASONS, type CrmMountStatus } from '../../shared/crm-files.ts'
import { createCrmDav, CRM_DAV_BASE } from './dav-crm.ts'
import { readProcNet, sameUser } from './peer-linux.ts'
import type { CrmFilesService, MountDriver } from './service.ts'

// F-126 (Linux): the CRM files in GNOME Files. The agent serves them as WebDAV on 127.0.0.1 (dav-crm.ts), letting in only sockets of its own Linux user (peer-linux.ts),
// and GNOME's gvfs mounts that with `gio mount` as the person: no root, nothing installed, no password and no token anywhere. Ubuntu's desktop has gvfs-backends
// (gvfsd-dav) and gvfs-fuse already, so Files shows it in its side bar and programs also get a plain folder under /run/user/<uid>/gvfs/.
// The port is fixed (50126, above the 1024-49151 that Ports' "Share all" shares), so the address Files remembers stays the same.

export const CRM_DAV_PORT = 50126
const DRIVER = 'GNOME Files (gvfs)'
const WHERE = 'Files › CRM files'
const STATE_FILE = 'crm-drive-linux.json'

export interface RunResult {
  code: number
  out: string
  err: string
}

export interface LinuxMountOptions {
  /** The agent's state folder (crm-drive-linux.json: was the drive on). */
  dir: string
  /** The CRM files service (made after this driver, so asked for when needed). */
  service(): CrmFilesService | null
  port?: number
  log?: { info(m: string): void; warn(m: string): void }
  // Tests:
  env?: NodeJS.ProcessEnv
  uid?: number
  exists?: (p: string) => boolean
  run?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<RunResult>
  procNet?: () => string[]
  /** /run/user/<uid>/gvfs (listed to find the plain folder of the mount). */
  gvfsDir?: string
  readDir?: (p: string) => string[]
}

const runFile = (cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> =>
  new Promise(resolve => {
    execFile(cmd, args, { env, timeout: 20_000, windowsHide: true }, (e, out, err) => {
      const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? ((e as { code: number }).code) : 1) : 0
      resolve({ code, out: String(out ?? ''), err: String(err ?? (e ? e.message : '')) })
    })
  })

export function createLinuxMount(o: LinuxMountOptions): MountDriver & { resume(): Promise<void>; close(): Promise<void>; port(): number } {
  let port = o.port ?? CRM_DAV_PORT
  const env = o.env ?? process.env
  const uid = o.uid ?? process.getuid?.() ?? -1
  const exists = o.exists ?? existsSync
  const run = o.run ?? runFile
  const procNet = o.procNet ?? (() => readProcNet())
  const gvfsDir = o.gvfsDir ?? `/run/user/${uid}/gvfs`
  const readDir = o.readDir ?? ((p: string) => readdirSync(p))
  const uri = () => `dav://127.0.0.1:${port}${CRM_DAV_BASE}/`
  const stateFile = path.join(o.dir, STATE_FILE)
  const dav = createCrmDav({
    service: () => {
      try {
        return o.service()
      } catch {
        return null
      }
    },
    log: o.log,
  })

  let server: http.Server | null = null
  let lastError: string | null = null
  let refused = 0

  /** gio, from PATH. */
  const gio = (): string | null => {
    for (const d of (env.PATH ?? '').split(':')) if (d && exists(path.posix.join(d, 'gio'))) return path.posix.join(d, 'gio')
    return null
  }
  const hasDav = () => ['/usr/libexec/gvfsd-dav', '/usr/lib/gvfs/gvfsd-dav', '/usr/lib/x86_64-linux-gnu/gvfs/gvfsd-dav', '/usr/lib/aarch64-linux-gnu/gvfs/gvfsd-dav'].some(p => exists(p))
  /** The session bus gio talks to gvfs on: from the environment, or the user's own at /run/user/<uid>/bus (the agent may start without it in its environment). */
  const busEnv = (): NodeJS.ProcessEnv | null => {
    if (env.DBUS_SESSION_BUS_ADDRESS) return env
    const bus = `/run/user/${uid}/bus`
    return exists(bus) ? { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}`, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR ?? `/run/user/${uid}` } : null
  }

  const save = (on: boolean) => {
    try {
      writeFileSync(stateFile, JSON.stringify({ on }) + '\n')
    } catch (e) {
      o.log?.warn(`crm drive: could not keep its on/off: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const wasOn = (): boolean => {
    try {
      return (JSON.parse(readFileSync(stateFile, 'utf8')) as { on?: unknown }).on === true
    } catch {
      return false
    }
  }

  async function mounted(e: NodeJS.ProcessEnv, g: string): Promise<boolean> {
    const r = await run(g, ['mount', '-l'], e)
    return r.code === 0 && r.out.includes(uri().slice(0, -1))
  }

  /** The plain folder gvfs-fuse gives the mount, when there is one. */
  function fuseFolder(): string | null {
    try {
      const name = readDir(gvfsDir).find(n => n.startsWith(`dav:host=127.0.0.1,port=${port}`))
      return name ? path.posix.join(gvfsDir, name) : null
    } catch {
      return null
    }
  }

  const base = (over: Partial<CrmMountStatus>): CrmMountStatus => ({
    supported: true,
    driver: 'installed',
    driverName: DRIVER,
    running: server !== null,
    mounted: false,
    where: WHERE,
    reason: null,
    reasonCode: null,
    installable: false,
    writable: true,
    waiting: 0,
    ...over,
  })

  /** What stops the drive before anything is tried, or null. */
  function blocker(): { status: CrmMountStatus } | { g: string; e: NodeJS.ProcessEnv } {
    const g = gio()
    if (!g || !hasDav()) return { status: base({ driver: 'missing', reason: CRM_FILES_REASONS.gvfsMissing, reasonCode: 'driver-missing' }) }
    const e = busEnv()
    if (!e) return { status: base({ reason: CRM_FILES_REASONS.noDesktop, reasonCode: 'no-desktop' }) }
    return { g, e }
  }

  async function listen(): Promise<void> {
    if (server) return
    const s = http.createServer((req, res) => void dav(req, res))
    s.requestTimeout = 0
    s.headersTimeout = 30_000
    // Only the agent's own Linux user: anyone else (another user, tailscaled, a proxy) is cut off before a byte is read.
    s.on('connection', sock => {
      if (sameUser(sock, uid, procNet)) return
      refused++
      if (refused <= 3 || refused % 100 === 0) o.log?.warn(`crm drive: a connection from another user was refused (${refused} so far)`)
      sock.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject)
      s.listen(port, '127.0.0.1', () => {
        s.off('error', reject)
        resolve()
      })
    })
    // Tests ask for port 0 (any free one): the address gvfs mounts is the one really listened on.
    const a = s.address()
    if (port === 0 && typeof a === 'object' && a) port = a.port
    server = s
  }

  async function unlisten(): Promise<void> {
    const s = server
    server = null
    if (!s) return
    await new Promise<void>(resolve => {
      s.closeAllConnections?.()
      s.close(() => resolve())
    })
  }

  async function status(): Promise<CrmMountStatus> {
    const b = blocker()
    if ('status' in b) return b.status
    const m = await mounted(b.e, b.g).catch(() => false)
    const live = m && server !== null
    return base({ mounted: live, where: live ? (fuseFolder() ?? WHERE) : WHERE, ...(lastError ? { reason: lastError, reasonCode: 'failed' } : {}) })
  }

  async function start(): Promise<CrmMountStatus> {
    const b = blocker()
    if ('status' in b) return b.status
    lastError = null
    try {
      await listen()
    } catch (e) {
      const code = (e as { code?: string }).code
      lastError = code === 'EADDRINUSE' ? `Port ${port} on this PC is taken by another program, so the CRM drive cannot start.` : 'The CRM drive could not start.'
      o.log?.warn(`crm drive: the listener did not start: ${e instanceof Error ? e.message : String(e)}`)
      return status()
    }
    if (!(await mounted(b.e, b.g).catch(() => false))) {
      const r = await run(b.g, ['mount', uri()], b.e)
      if (r.code !== 0 && !/already mounted/i.test(r.err)) {
        const why = r.err.split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 200) ?? `gio stopped with ${r.code}`
        lastError = `GNOME could not open the CRM drive: ${why}`
        o.log?.warn(`crm drive: gio mount: ${why}`)
        await unlisten()
        return status()
      }
    }
    save(true)
    o.log?.info(`crm drive: on, at ${uri()} (Files shows it)`)
    return status()
  }

  async function stop(): Promise<CrmMountStatus> {
    lastError = null
    const b = blocker()
    if (!('status' in b) && (await mounted(b.e, b.g).catch(() => false))) {
      const r = await run(b.g, ['mount', '-u', uri()], b.e)
      if (r.code !== 0) o.log?.warn(`crm drive: gio mount -u: ${r.err.split('\n')[0]?.slice(0, 200) ?? r.code}`)
    }
    await unlisten()
    save(false)
    o.log?.info('crm drive: off')
    return status()
  }

  return {
    status,
    start,
    stop,
    port: () => port,
    async resume() {
      // The service is made after this driver: wait a turn before asking for it.
      await new Promise(r => setImmediate(r))
      if (!wasOn()) return
      const s = await start().catch(() => null)
      if (s?.reason) o.log?.warn(`crm drive: not back on: ${s.reason}`)
    },
    async close() {
      // The agent stops: take the mount away so Files does not hang on it; it comes back at the next start (still on).
      const b = blocker()
      if (!('status' in b) && server && (await mounted(b.e, b.g).catch(() => false))) await run(b.g, ['mount', '-u', uri()], b.e).catch(() => undefined)
      await unlisten()
    },
  }
}
