import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { CRM_FILES_REASONS, type CrmMountStatus } from '../../shared/crm-files.ts'
import { startBridge, type Bridge, type BridgeOptions } from './bridge.ts'
import type { MountDriver } from './service.ts'

// F-126: the CRM files as a Windows drive (default Y:). The host is crm-fs.exe, our own build of the CRM Files drive (crm-fs/ in the repo; WinFsp underneath). This starts it with a
// bridge address and a one-run secret in its environment, stops it by its own process id (never by name, never a tree, and never the old build's crm-fs.exe or its X:), and says in plain
// words why it can not run. Whether it should be running is remembered across restarts.

export const DEFAULT_LETTER = 'Y:'

export interface WinMountOptions {
  /** crm-fs.exe (the built host). Missing: "not part of this build". */
  exe: string
  /** Its SHA-256 as the build recorded it (RELEASE.json); when set, a different file is not started. */
  exeSha256?: string
  /** The agent's state folder for this (crm-drive.json). */
  dir: string
  letter?: string
  /** Where WinFsp's driver is. Tests point it at a made-up folder. */
  winfspDll?: string
  signedIn: () => boolean
  bridge: Pick<BridgeOptions, 'forward' | 'client'>
  log?: { info(m: string): void; warn(m: string): void }
  /** Tests. */
  platform?: NodeJS.Platform
  spawn?: typeof nodeSpawn
  driveExists?: (letter: string) => boolean
  waitMs?: number
}

const WINFSP_DLL = 'C:\\Program Files (x86)\\WinFsp\\bin\\winfsp-x64.dll'

export function createWinMount(o: WinMountOptions): MountDriver & { resume(): Promise<void>; close(): Promise<void> } {
  const letter = (o.letter ?? DEFAULT_LETTER).toUpperCase()
  const platform = o.platform ?? process.platform
  const spawn = o.spawn ?? nodeSpawn
  const driveExists = o.driveExists ?? ((l: string) => existsSync(`${l}\\`))
  const dll = o.winfspDll ?? WINFSP_DLL
  const stateFile = path.join(o.dir, 'crm-drive.json')
  const waitMs = o.waitMs ?? 15_000
  let child: ChildProcess | null = null
  let bridge: Bridge | null = null
  let starting: Promise<CrmMountStatus> | null = null
  let lastFailure: { reason: string; code: CrmMountStatus['reasonCode'] } | null = null

  const wanted = (): boolean => {
    try {
      return (JSON.parse(readFileSync(stateFile, 'utf8')) as { on?: unknown }).on === true
    } catch {
      return false
    }
  }
  const remember = (on: boolean) => {
    try {
      mkdirSync(o.dir, { recursive: true })
      const tmp = `${stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ on }))
      renameSync(tmp, stateFile)
    } catch (e) {
      o.log?.warn(`crm drive: could not save its on/off (${(e as Error).message})`)
    }
  }

  const alive = () => child !== null && child.exitCode === null && !child.killed

  async function status(): Promise<CrmMountStatus> {
    const base = { driverName: 'WinFsp', where: letter, installable: true, writable: true, waiting: 0 }
    if (platform !== 'win32') return { ...base, supported: false, driver: 'unsupported', running: false, mounted: false, reason: CRM_FILES_REASONS.unsupported, reasonCode: 'unsupported', installable: false }
    const hostThere = existsSync(o.exe)
    const driverThere = existsSync(dll)
    const mounted = alive() && driveExists(letter)
    let reason: string | null = null
    let code: CrmMountStatus['reasonCode'] = null
    if (!hostThere) [reason, code] = [CRM_FILES_REASONS.hostMissing, 'host-missing']
    else if (!driverThere) [reason, code] = [CRM_FILES_REASONS.winfspMissing, 'driver-missing']
    else if (!o.signedIn()) [reason, code] = [CRM_FILES_REASONS.signedOut, 'crm-signin']
    else if (!alive() && driveExists(letter)) [reason, code] = [CRM_FILES_REASONS.letterTaken.replace('Y:', letter), 'letter-taken']
    else if (lastFailure && !alive()) [reason, code] = [lastFailure.reason, lastFailure.code]
    return { ...base, supported: hostThere, driver: driverThere ? 'installed' : 'missing', running: alive(), mounted, reason: mounted ? null : reason, reasonCode: mounted ? null : code }
  }

  async function start(): Promise<CrmMountStatus> {
    if (alive()) return status()
    starting ??= (async () => {
      lastFailure = null
      const st = await status()
      if (st.reasonCode && st.reasonCode !== 'failed') return st
      if (o.exeSha256) {
        const have = createHash('sha256').update(await readFile(o.exe)).digest('hex')
        if (have !== o.exeSha256.toLowerCase()) {
          lastFailure = { reason: 'The CRM drive program does not match this build, so it was not started.', code: 'failed' }
          o.log?.warn('crm drive: crm-fs.exe does not match the checksum of the build; not started')
          return status()
        }
      }
      try {
        bridge = await startBridge(o.bridge)
        const c = spawn(o.exe, ['-m', letter], {
          env: { ...process.env, CRM_MGR_BASE: bridge.base, CRM_MGR_TOKEN: bridge.token },
          stdio: 'ignore',
          windowsHide: true,
        })
        child = c
        c.once('exit', code => {
          o.log?.info(`crm drive: the host stopped (${code ?? 'signal'})`)
          if (child === c) child = null
          void bridge?.close()
          bridge = null
        })
        c.once('error', e => {
          lastFailure = { reason: `The CRM drive program could not start (${(e as NodeJS.ErrnoException).code ?? 'error'}).`, code: 'failed' }
          if (child === c) child = null
        })
        remember(true)
        // The host loads the CRM before it mounts: wait for the letter, stop early if it died.
        const until = Date.now() + waitMs
        while (alive() && !driveExists(letter) && Date.now() < until) await new Promise(r => setTimeout(r, 100))
        if (!alive()) lastFailure ??= { reason: 'The CRM drive program stopped right after it started. Is WinFsp installed properly?', code: 'failed' }
      } catch (e) {
        lastFailure = { reason: `The CRM drive could not start (${(e as Error).message.slice(0, 80)}).`, code: 'failed' }
        await bridge?.close().catch(() => undefined)
        bridge = null
      }
      return status()
    })().finally(() => (starting = null))
    return starting
  }

  async function stop(): Promise<CrmMountStatus> {
    remember(false)
    const c = child
    if (c && c.exitCode === null) {
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, waitMs)
        t.unref?.()
        c.once('exit', () => (clearTimeout(t), resolve()))
        // This process only, by its own id: WinFsp unmounts when its host exits.
        c.kill()
      })
    }
    child = null
    await bridge?.close().catch(() => undefined)
    bridge = null
    lastFailure = null
    return status()
  }

  return {
    status,
    start,
    stop,
    /** At the agent's start: bring the drive back if it was on. */
    async resume() {
      if (wanted() && platform === 'win32') await start().catch(() => undefined)
    },
    /** At the agent's end: the host goes with it; the on/off is kept for the next start. */
    async close() {
      const c = child
      child = null
      if (c && c.exitCode === null) c.kill()
      await bridge?.close().catch(() => undefined)
      bridge = null
    },
  }
}
