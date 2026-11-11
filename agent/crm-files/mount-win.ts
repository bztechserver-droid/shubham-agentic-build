import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access } from 'node:fs/promises'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, uptime } from 'node:os'
import path from 'node:path'
import { CRM_FILES_REASONS, type CrmDriverChoice, type CrmMountStatus, type CrmReveal, type CrmVia } from '../../shared/crm-files.ts'
import { startBridge, type Bridge, type BridgeOptions } from './bridge.ts'
import { createWinDav } from './mount-win-dav.ts'
import { createWinNative } from './mount-winfsp-native.ts'
import { CrmFilesError, type CrmFilesService, type MountDriver } from './service.ts'

// F-126: the CRM files as a Windows drive (default Y:). The host is crm-fs.exe, our own build of the CRM Files drive (crm-fs/ in the repo; WinFsp underneath). This starts it with a
// bridge address and a one-run secret in its environment, stops it by its own process id (never by name, never a tree, and never the old build's crm-fs.exe or its X:), and says in plain
// words why it can not run. Whether it should be running is remembered across restarts.
// o6e65 (the old app's way): the drive mounts BY ITSELF while the CRM is signed in (setting "auto", ON unless switched off; the old way, Start by hand, is OFF), and goes down when the CRM
// signs out. A drive stopped on purpose stays stopped. It only ever touches the host program it started itself, never a letter that something else holds. The status also says how many saves
// wait in the host's pending folder and where the pending and recovered folders are; reveal() opens File Explorer on the drive or on one of those two (three fixed places, no path from outside).

export const DEFAULT_LETTER = 'Y:'
/** S9a2: written while the in-app drive is up (mount-winfsp-native.ts); found at the agent's start = the agent was stopped while it was up. */
export const INAPP_MARKER = 'inapp-drive-running.json'
/** S9a3: a marker older than the PC's last start by more than this is from before it (clock and uptime are only roughly right): ignored. */
export const BOOT_SLACK_MS = 5000

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
  /** o6e65: the drive host's own state folder (%LOCALAPPDATA%\ChristopherOS\crm-fs), where it keeps the waiting and recovered saves. Tests point it at a made-up folder. */
  hostState?: string
  /** o6e65: opens File Explorer on a folder. Tests pass a fake: nothing real is opened. */
  openFolder?: (folder: string) => void
  /** o6e65: how often the agent checks whether the drive should be up or down (default 15 s). */
  watchMs?: number
  /** S9a3: when this PC started (ms since 1970); default: now minus the uptime. Tests give a fixed one. */
  bootTimeMs?: () => number
  /**
   * o6e65 (S4): the CRM files service, for the built-in WebDAV way (no host program, no WinFsp). Left out: only the WinFsp way exists. With it, the drive falls back to Windows' own WebDAV
   * client where the host program cannot run (Windows' code integrity / Smart App Control blocks it) or WinFsp is missing, and the person can choose either way.
   */
  service?: () => CrmFilesService | null
  /** Tests: the built-in WebDAV side, or its commands (net, sc). */
  dav?: ReturnType<typeof createWinDav>
  /** S9a: the in-process WinFsp drive (the default way): a fake in tests. Made from `service` when left out. */
  native?: ReturnType<typeof createWinNative> | null
  davRun?: Parameters<typeof createWinDav>[0]['run']
  /** A line per request the built-in WebDAV answers (the secret address is left out): to find out why a Windows client refuses something. */
  davTrace?: (line: string) => void
}

const defaultOpen = (folder: string) => {
  const c = nodeSpawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' })
  c.on('error', () => undefined)
  c.unref()
}

/** A drive letter the person may choose: D: to Z: (A:, B: and C: are the system's). */
const LETTER = /^[D-Z]:$/i

const WINFSP_DLL = 'C:\\Program Files (x86)\\WinFsp\\bin\\winfsp-x64.dll'

export function createWinMount(o: WinMountOptions): MountDriver & { resume(): Promise<void>; close(): Promise<void>; setAuto(on: boolean): Promise<CrmMountStatus>; setDriver(via: CrmDriverChoice): Promise<CrmMountStatus>; setSaves(on: boolean): Promise<CrmMountStatus>; setLetter(letter: string): Promise<CrmMountStatus>; letters(): Promise<{ current: string; free: string[] }>; reveal(what: CrmReveal): Promise<void> } {
  // S2: the drive letter: Y: unless the person chose another (remembered in crm-drive.json, applied when the drive starts); a letter given to this function (tests) wins.
  let letter = (o.letter ?? DEFAULT_LETTER).toUpperCase()
  const platform = o.platform ?? process.platform
  const spawn = o.spawn ?? nodeSpawn
  const driveExists = o.driveExists ?? ((l: string) => existsSync(`${l}\\`))
  const dll = o.winfspDll ?? WINFSP_DLL
  const stateFile = path.join(o.dir, 'crm-drive.json')
  if (!o.letter) {
    try {
      const j = JSON.parse(readFileSync(stateFile, 'utf8')) as { letter?: unknown }
      if (typeof j.letter === 'string' && LETTER.test(j.letter)) letter = j.letter.toUpperCase()
    } catch {
      // none remembered: Y:
    }
  }
  const waitMs = o.waitMs ?? 15_000
  const watchMs = o.watchMs ?? 15_000
  let tag = letter.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'Y'
  const hostState = o.hostState ?? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'ChristopherOS', 'crm-fs')
  let pendingDir = path.join(hostState, `pending-${tag}`)
  let recoveredDir = path.join(hostState, `recovered-${tag}`)
  const openFolder = o.openFolder ?? defaultOpen
  /** Does anything hold this letter? Asked the way that cannot hang (async, 800 ms: no answer counts as held). */
  const letterTaken = async (l: string): Promise<boolean> => {
    if (o.driveExists) return o.driveExists(l)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        access(`${l}\\`).then(() => true, () => false),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(true), 800)
          timer.unref?.()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  let timer: ReturnType<typeof setInterval> | null = null
  let autoTries = 0
  let child: ChildProcess | null = null
  let bridge: Bridge | null = null
  let starting: Promise<CrmMountStatus> | null = null
  let lastFailure: { reason: string; code: CrmMountStatus['reasonCode'] } | null = null
  /** The host program was refused by Windows (code integrity / Smart App Control, "spawn UNKNOWN", access denied): in automatic mode the built-in WebDAV is used from then on. */
  let hostBlocked = false
  let davFailure: { reason: string; code: CrmMountStatus['reasonCode'] } | null = null
  /** S9a: the in-app WinFsp drive could not start here (WinFsp missing, a letter taken, a failure): in automatic mode the other ways are used from then on. */
  let nativeBroken = false
  let nativeFailure: { reason: string; code: CrmMountStatus['reasonCode'] } | null = null
  // The two ways that live in this process are made for the current letter; choosing another letter makes them again (only the ones made here, not a stand-in given by a test).
  const makeNative = () => (o.service && platform === 'win32' ? createWinNative({ letter, service: o.service, log: o.log, writable: () => readState().saves === true, markerFile: path.join(o.dir, INAPP_MARKER), exists: o.driveExists ? async l => o.driveExists!(l) : undefined }) : null)
  const makeDav = () => (o.service && platform === 'win32' ? createWinDav({ letter, service: o.service, log: o.log, run: o.davRun, driveExists: o.driveExists, exists: o.driveExists ? async l => o.driveExists!(l) : undefined, trace: o.davTrace }) : null)
  const madeNative = o.native === undefined
  const madeDav = o.dav === undefined
  let native = (o.native !== undefined ? o.native : null) ?? (madeNative ? makeNative() : null)
  let dav = o.dav ?? (madeDav ? makeDav() : null)

  // What the person chose, kept across restarts: on (true: started by hand and left on; false: stopped on purpose; nothing: never touched) and auto (mount by itself; ON unless false).
  const readState = (): { on?: boolean; auto?: boolean; via?: CrmDriverChoice; crashed?: string; saves?: boolean; letter?: string } => {
    try {
      const j = JSON.parse(readFileSync(stateFile, 'utf8')) as { on?: unknown; auto?: unknown; via?: unknown; crashed?: unknown; saves?: unknown; letter?: unknown }
      return { letter: typeof j.letter === 'string' ? j.letter : undefined, saves: typeof j.saves === 'boolean' ? j.saves : undefined, crashed: typeof j.crashed === 'string' ? j.crashed : undefined, on: typeof j.on === 'boolean' ? j.on : undefined, auto: typeof j.auto === 'boolean' ? j.auto : undefined, via: j.via === 'native' || j.via === 'winfsp' || j.via === 'webdav' || j.via === 'auto' ? j.via : undefined }
    } catch {
      return {}
    }
  }
  const remember = (patch: { on?: boolean; auto?: boolean; via?: CrmDriverChoice; crashed?: string | undefined; saves?: boolean; letter?: string }) => {
    try {
      mkdirSync(o.dir, { recursive: true })
      const tmp = `${stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ ...readState(), ...patch }))
      renameSync(tmp, stateFile)
    } catch (e) {
      o.log?.warn(`crm drive: could not save its choices (${(e as Error).message})`)
    }
  }
  // S9a2, the crash breaker: the in-app drive runs inside this process, so a native fault would end the agent. Its marker file (written when it starts, removed when it ends cleanly) still being
  // here at the agent's start means the agent was stopped while the drive was up: the in-app way is then OFF (remembered), the other ways are used, and the card says so in plain words. It is never
  // tried again by itself: only the person choosing In-app or Automatic again (setDriver) turns it back on.
  // S9a3: a marker OLDER THAN THIS PC'S LAST START (an OS shutdown, a power cut, a hard kill of the whole PC) is not a fault of the drive: it is removed silently and changes nothing. A real native
  // fault ends the agent without a reboot, so its marker is newer than the boot and is still caught (and if the drive faults again, the new marker catches that). A marker with no readable time
  // is dated by the file's own time.
  const markerPath = path.join(o.dir, INAPP_MARKER)
  if (native && existsSync(markerPath)) {
    let when: string | null = null
    try {
      const j = JSON.parse(readFileSync(markerPath, 'utf8')) as { startedAt?: unknown }
      if (typeof j.startedAt === 'string' && !Number.isNaN(Date.parse(j.startedAt))) when = j.startedAt
    } catch {
      // an unreadable marker is still a marker
    }
    let at = when ? Date.parse(when) : Number.NaN
    if (Number.isNaN(at)) {
      try {
        at = statSync(markerPath).mtimeMs
      } catch {
        at = Date.now()
      }
      when = new Date(at).toISOString()
    }
    const boot = (o.bootTimeMs ?? (() => Date.now() - uptime() * 1000))()
    const beforeBoot = at < boot - BOOT_SLACK_MS
    if (!beforeBoot) remember({ crashed: when ?? new Date(at).toISOString() })
    try {
      rmSync(markerPath, { force: true })
    } catch {
      // the choice is remembered (or not needed); the marker would only be found again
    }
    if (beforeBoot) o.log?.info(`crm drive: an old in-app drive marker from before this PC started (${when}) was removed; nothing is off`)
    else o.log?.warn(`crm drive: the in-app drive was up when the agent stopped last time (${when}); it is off until it is chosen again`)
  }
  const autoOn = () => readState().auto !== false
  /** Should the drive be up now, by what the person chose? Started by hand and left on: yes. Stopped on purpose: no. Nothing chosen: yes while "mount by itself" is on. */
  const shouldRun = () => {
    const s = readState()
    return s.on === true || (s.on === undefined && s.auto !== false)
  }
  /** How many saves wait in the host's pending folder (each is a file with a .json note beside it: the notes are counted, as the old app did). */
  const waiting = (): number => {
    try {
      return readdirSync(pendingDir).filter(f => f.endsWith('.json')).length
    } catch {
      return 0
    }
  }

  const alive = () => child !== null && child.exitCode === null && !child.killed
  const davAlive = () => dav !== null && dav.alive()
  /** The drive is up by either way, and ours. */
  const nativeAlive = () => native !== null && native.alive()
  /** The way that lives inside this process (its letter must never be asked with a synchronous call). */
  const anyAlive = () => alive() || davAlive() || nativeAlive()
  /** Which way is (or would be) used now: by the choice, and in automatic mode by whether the host program can run here. */
  const via = (): CrmVia => {
    if (nativeAlive()) return 'native'
    if (davAlive()) return 'webdav'
    if (alive()) return 'winfsp'
    const choice = readState().via ?? 'auto'
    if (native && readState().crashed === undefined && (choice === 'native' || (choice === 'auto' && !nativeBroken))) return 'native'
    if (!dav) return 'winfsp'
    if (choice === 'webdav') return 'webdav'
    if (choice === 'winfsp') return 'winfsp'
    return hostBlocked || !existsSync(o.exe) || !existsSync(dll) ? 'webdav' : 'winfsp'
  }

  async function status(): Promise<CrmMountStatus> {
    const way = via()
    const base = {
      driverName: way === 'native' ? 'WinFsp (inside the app)' : way === 'webdav' ? 'Windows WebDAV (built in)' : 'WinFsp',
      where: letter,
      installable: way === 'winfsp' || way === 'native',
      // the in-app drive takes saves only when the person turned "Save into the drive" on (OFF by default) and the agent keeps a spool (S9b: a save is kept on this PC and goes up by itself); otherwise it is read-only, and the page says so
      writable: way !== 'native' || (readState().saves === true && !!o.service?.()?.save),
      saveInto: native ? readState().saves === true : undefined,
      driveLetter: platform === 'win32' && (native || dav) ? letter : undefined,
      waiting: platform === 'win32' && way === 'winfsp' ? waiting() : 0,
      autoMount: autoOn(),
      pendingDir: way === 'winfsp' ? pendingDir : undefined,
      recoveredDir: way === 'winfsp' ? recoveredDir : undefined,
      mountVia: dav || native ? way : undefined,
      inAppCrash: native ? readState().crashed : undefined,
      driverChoice: dav || native ? (readState().via ?? 'auto') : undefined,
    }
    if (platform !== 'win32') return { ...base, waiting: 0, autoMount: undefined, pendingDir: undefined, recoveredDir: undefined, mountVia: undefined, driverChoice: undefined, supported: false, driver: 'unsupported', running: false, mounted: false, reason: CRM_FILES_REASONS.unsupported, reasonCode: 'unsupported', installable: false }
    if (way === 'native') {
      // The in-app WinFsp way: what can stop it is WinFsp missing, the CRM sign-in, a letter held by something else; never a synchronous file call on the letter.
      const mountedNative = nativeAlive()
      let reasonN: string | null = null
      let codeN: CrmMountStatus['reasonCode'] = null
      if (!native!.available()) [reasonN, codeN] = [CRM_FILES_REASONS.winfspMissing, 'driver-missing']
      else if (!o.signedIn()) [reasonN, codeN] = [CRM_FILES_REASONS.signedOut, 'crm-signin']
      else if (!mountedNative && !nativeFailure && (await native!.answers())) [reasonN, codeN] = [CRM_FILES_REASONS.letterTaken.replace('Y:', letter), 'letter-taken']
      else if (nativeFailure && !mountedNative) [reasonN, codeN] = [nativeFailure.reason, nativeFailure.code]
      return { ...base, supported: true, driver: native!.available() ? 'installed' : 'missing', running: mountedNative, mounted: mountedNative, reason: mountedNative ? null : reasonN, reasonCode: mountedNative ? null : codeN }
    }
    if (way === 'webdav') {
      // The built-in WebDAV way: nothing to install; what can stop it is the CRM sign-in, a letter held by something else, or Windows' WebClient service being stopped.
      // The mapped letter is never asked synchronously (see mount-win-dav.ts `exists`): it is ours and mapped, and that is what davAlive says.
      const mountedDav = davAlive()
      let reasonDav: string | null = null
      let codeDav: CrmMountStatus['reasonCode'] = null
      if (!o.signedIn()) [reasonDav, codeDav] = [CRM_FILES_REASONS.signedOut, 'crm-signin']
      else if (!davAlive() && !davFailure && (await dav!.answers())) [reasonDav, codeDav] = [CRM_FILES_REASONS.letterTaken.replace('Y:', letter), 'letter-taken']
      else if (davFailure && !davAlive()) [reasonDav, codeDav] = [davFailure.reason, davFailure.code]
      return { ...base, supported: true, driver: 'installed', running: davAlive(), mounted: mountedDav, reason: mountedDav ? null : reasonDav, reasonCode: mountedDav ? null : codeDav }
    }
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

  /** The built-in WebDAV way: serve and map. Remembered as on only when started by hand. */
  async function startDav(how: { auto?: boolean }): Promise<CrmMountStatus> {
    davFailure = null
    if (!o.signedIn()) return status()
    const r = await dav!.start()
    if (!r.ok) davFailure = { reason: r.reason, code: r.code }
    else if (!how.auto) remember({ on: true })
    return status()
  }

  /** The in-app WinFsp way. Returns null when (in automatic mode) it could not start and the next way should be tried now. */
  async function startNative(how: { auto?: boolean }): Promise<CrmMountStatus | null> {
    nativeFailure = null
    if (!o.signedIn()) return status()
    const r = await native!.start()
    if (!r.ok) {
      if ((readState().via ?? 'auto') === 'auto') {
        o.log?.warn(`crm drive: the in-app drive could not start (${r.code}); trying the other ways`)
        nativeBroken = true
        return null
      }
      nativeFailure = { reason: r.reason, code: r.code }
    } else if (!how.auto) remember({ on: true })
    return status()
  }

  async function start(how: { auto?: boolean } = {}): Promise<CrmMountStatus> {
    if (anyAlive()) return status()
    starting ??= (async () => {
      lastFailure = null
      if (via() === 'native') {
        const r = await startNative(how)
        if (r) return r
      }
      if (via() === 'webdav') return startDav(how)
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
          // Windows refused to run it (code integrity / Smart App Control: UNKNOWN, or access denied): in automatic mode the built-in WebDAV takes over.
          if (['UNKNOWN', 'EACCES', 'EPERM'].includes(String((e as NodeJS.ErrnoException).code))) hostBlocked = true
          if (child === c) child = null
        })
        // Started by hand it is remembered as on; started by itself it is not (the person never asked).
        if (!how.auto) remember({ on: true })
        // The host loads the CRM before it mounts: wait for the letter, stop early if it died.
        const until = Date.now() + waitMs
        while (alive() && !driveExists(letter) && Date.now() < until) await new Promise(r => setTimeout(r, 100))
        if (!alive()) lastFailure ??= { reason: 'The CRM drive program stopped right after it started. Is WinFsp installed properly?', code: 'failed' }
      } catch (e) {
        lastFailure = { reason: `The CRM drive could not start (${(e as Error).message.slice(0, 80)}).`, code: 'failed' }
        // spawn itself refused (what Windows' code integrity answers for an unsigned program: "spawn UNKNOWN"): the host cannot run here.
        if (['UNKNOWN', 'EACCES', 'EPERM'].includes(String((e as NodeJS.ErrnoException).code))) hostBlocked = true
        await bridge?.close().catch(() => undefined)
        bridge = null
      }
      // The host program could not run here (Windows refused it): in automatic mode, use the built-in WebDAV instead, now.
      if (!alive() && hostBlocked && dav && (readState().via ?? 'auto') === 'auto') {
        o.log?.warn('crm drive: Windows refused the drive program; using the built-in WebDAV')
        lastFailure = null
        return startDav(how)
      }
      return status()
    })().finally(() => (starting = null))
    return starting
  }

  /** Ends the host this agent started (by its own process id) and closes its bridge. Nothing is remembered. */
  async function end(): Promise<void> {
    await native?.end().catch(() => undefined)
    await dav?.end().catch(() => undefined)
    davFailure = null
    nativeFailure = null
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
  }

  async function stop(): Promise<CrmMountStatus> {
    // Stopped on purpose: it stays stopped (also after a restart) until it is started by hand.
    remember({ on: false })
    await end()
    return status()
  }

  /**
   * The check that keeps the drive as the person's choices say: up while the CRM is signed in, down when it signs out. Never touches a letter it did not start (a drive that is there
   * and not ours is left alone), and gives up after three failed tries until the agent restarts or the person starts it.
   */
  async function tick(): Promise<void> {
    if (platform !== 'win32' || !shouldRun()) return
    const signed = o.signedIn()
    if (signed && !anyAlive() && !starting) {
      // The built-in way asks async and time-boxed (never a synchronous call on a letter that may be a dead mapping of ours); start() sorts out whose it is.
      if (autoTries >= 3 || (via() === 'winfsp' && driveExists(letter))) return
      autoTries++
      await start({ auto: true }).catch(() => undefined)
    } else if (!signed && anyAlive() && autoOn()) {
      await end()
      autoTries = 0
    }
    // Counted as a success only when the drive is really there (a host that is starting but has no letter yet is not).
    if (davAlive() || nativeAlive() || (alive() && driveExists(letter))) autoTries = 0
  }

  return {
    status,
    start,
    stop,
    /** o6e65: mount by itself, or not (the setting). Turning it on brings the drive up now if the CRM is signed in. */
    async setAuto(on: boolean) {
      remember({ auto: on })
      autoTries = 0
      if (on) await tick()
      return status()
    },
    /**
     * S9b: "Save into the drive": whether the in-app drive takes saves (a save goes into the CRM). OFF unless the person turns it on. It is applied when the drive starts, so changing it takes the
     * in-app drive down and, if it was up, brings it up again.
     */
    async setSaves(on: boolean) {
      if (!native) throw new CrmFilesError(400, 'unsupported', CRM_FILES_REASONS.unsupported)
      const was = nativeAlive()
      remember({ saves: on })
      if (was) {
        await end()
        await start({ auto: readState().on !== true }).catch(() => undefined)
      }
      return status()
    },
    /**
     * S2: the drive letter. Y: unless the person chose another one that is FREE: a letter something else holds (a disk, a network drive, another mapping) is never used. Applied now: a drive that is up is
     * taken down and brought up on the new letter.
     */
    async setLetter(next: string) {
      const l = next.trim().toUpperCase()
      if (!LETTER.test(l)) throw new CrmFilesError(400, 'failed', 'A drive letter is D: to Z:.')
      if (!(native || dav)) throw new CrmFilesError(400, 'unsupported', CRM_FILES_REASONS.unsupported)
      if (l === letter) return status()
      if (await letterTaken(l)) throw new CrmFilesError(409, 'failed', CRM_FILES_REASONS.letterTaken.replace('Y:', l))
      const was = anyAlive()
      if (was) await end()
      remember({ letter: l })
      letter = l
      tag = letter.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'Y'
      pendingDir = path.join(hostState, `pending-${tag}`)
      recoveredDir = path.join(hostState, `recovered-${tag}`)
      if (madeNative) native = makeNative()
      if (madeDav) dav = makeDav()
      hostBlocked = false
      nativeBroken = false
      autoTries = 0
      if (was || (shouldRun() && o.signedIn())) await start({ auto: readState().on !== true }).catch(() => undefined)
      return status()
    },
    /** S2: the letter in use and the ones that are free right now (D: to Z:, none of them held by anything). */
    async letters() {
      const free: string[] = []
      await Promise.all(
        'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async c => {
          const l = `${c}:`
          if (l !== letter && !(await letterTaken(l))) free.push(l)
        }),
      )
      return { current: letter, free: free.sort() }
    },
    /** o6e65 (S4): how the drive is made: WinFsp, Windows' built-in WebDAV, or automatic. Changing it takes the drive down and, if it should be up, brings it up the new way. Without the WebDAV side only WinFsp exists. */
    async setDriver(next: CrmDriverChoice) {
      if ((!dav && next === 'webdav') || (!native && next === 'native')) throw new CrmFilesError(400, 'unsupported', CRM_FILES_REASONS.unsupported)
      const was = anyAlive()
      // Choosing In-app or Automatic again is the person's word that the in-app way may be tried again.
      remember({ via: next, ...(next === 'native' || next === 'auto' ? { crashed: undefined } : {}) })
      hostBlocked = false
      nativeBroken = false
      autoTries = 0
      if (was) await end()
      if (was || (shouldRun() && o.signedIn())) await start({ auto: readState().on !== true }).catch(() => undefined)
      return status()
    },
    /** o6e65: File Explorer on the drive, or on the waiting or recovered saves. Three fixed places; nothing from outside decides the path. */
    async reveal(what: CrmReveal) {
      if (platform !== 'win32') throw new CrmFilesError(400, 'unsupported', CRM_FILES_REASONS.unsupported)
      if (what === 'drive') {
        if (!(davAlive() || nativeAlive() || (alive() && driveExists(letter)))) throw new CrmFilesError(409, 'failed', CRM_FILES_REASONS.notMounted)
        return openFolder(`${letter}\\`)
      }
      const dir = what === 'pending' ? pendingDir : recoveredDir
      if (!existsSync(dir)) throw new CrmFilesError(404, 'notfound', CRM_FILES_REASONS.noFolder)
      openFolder(dir)
    },
    /** At the agent's start: bring the drive back (it was on, or it mounts by itself), and keep watching the CRM's sign-in. */
    async resume() {
      if (platform !== 'win32') return
      if (shouldRun() && o.signedIn() && (via() !== 'winfsp' || !driveExists(letter))) await start({ auto: readState().on !== true }).catch(() => undefined)
      if (!timer) {
        timer = setInterval(() => void tick(), watchMs)
        timer.unref?.()
      }
    },
    /** At the agent's end: the host goes with it; the choices are kept for the next start. */
    async close() {
      // S9a4: the agent is shutting down cleanly (an Update, a restart): the in-app drive's marker is removed FIRST and synchronously. The rest of this waits (the bridge, the drive's thread, up to
      // seconds) and the process may exit before it is done; the marker must not outlive a clean shutdown, or the next start takes it for a crash and switches the drive off.
      if (native) {
        try {
          rmSync(path.join(o.dir, INAPP_MARKER), { force: true })
        } catch {
          // a marker that cannot be removed only keeps the in-app way off: the safe side
        }
      }
      if (timer) clearInterval(timer)
      timer = null
      const c = child
      child = null
      if (c && c.exitCode === null) c.kill()
      await bridge?.close().catch(() => undefined)
      bridge = null
      // The built-in WebDAV way: the letter this agent mapped is unmapped with it (nothing else is touched).
      await native?.end().catch(() => undefined)
      await dav?.end().catch(() => undefined)
    },
  }
}
