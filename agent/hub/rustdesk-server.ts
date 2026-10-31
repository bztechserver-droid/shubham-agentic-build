import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ServerStatus } from '../../shared/agent-api.ts'
import { statePaths, type Ports, type StatePaths } from '../config.ts'
import { dailyFile, log as rootLog, type DailyFile, type Logger } from '../log.ts'
import { primaryLan } from '../net.ts'

// The hub's RustDesk servers: unmodified hbbs and hbbr 1.1.16, fetched sha256-pinned and
// supervised as child processes (agent/SPEC.md › hbbs/hbbr). Source references are to
// rustdesk-server 1.1.16 (design/features/F-004-research-round2.json).

export interface Release {
  version: string
  url: string
  size: number
  sha256: string
  /** The two exes we take from the zip, with their sizes. */
  exes: Record<'hbbs.exe' | 'hbbr.exe', number>
}

export const RELEASE: Release = {
  version: '1.1.16',
  url: 'https://github.com/rustdesk/rustdesk-server/releases/download/1.1.16/rustdesk-server-windows-x86_64-unsigned.zip',
  size: 11_909_626,
  sha256: 'b865a3a62fc8755b45480c508f1c4871c3338590408dda8c58c7e9c373b7adb0',
  exes: { 'hbbs.exe': 7_094_784, 'hbbr.exe': 2_905_088 },
}

const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
const run = promisify(execFile)

// ---------------------------------------------------------------------------------------
// Fetch

export interface EnsureOptions {
  /** Where hbbs.exe and hbbr.exe go. Default: the canonical %LOCALAPPDATA%\shubham-agentic\rustdesk-server. */
  dir?: string
  /** A local copy of the release zip, used instead of downloading. It is checked the same way. */
  zip?: string
  log?: Logger
  /** Tests: another pin (a small fake zip). */
  release?: Release
}

export interface Binaries {
  dir: string
  hbbs: string
  hbbr: string
  /** False when both were already there with the right sizes. */
  fetched: boolean
}

function hasExes(dir: string, release: Release) {
  return Object.entries(release.exes).every(([name, size]) => {
    try {
      return statSync(path.join(dir, name)).size === size
    } catch {
      return false
    }
  })
}

function checkZip(data: Buffer, release: Release, from: string) {
  if (data.length !== release.size) throw new Error(`Refusing ${from}: ${data.length} bytes, expected ${release.size}`)
  const sha256 = createHash('sha256').update(data).digest('hex')
  if (sha256 !== release.sha256) throw new Error(`Refusing ${from}: sha256 ${sha256}, expected ${release.sha256}`)
}

async function download(release: Release, log: Logger): Promise<Buffer> {
  log.info(`downloading rustdesk-server ${release.version} (${(release.size / 1e6).toFixed(1)} MB) from ${release.url}`)
  const res = await fetch(release.url, { redirect: 'follow', signal: AbortSignal.timeout(5 * 60_000) })
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${release.url}`)
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared && declared !== release.size) throw new Error(`Refusing the download: ${declared} bytes, expected ${release.size}`)
  // Collected with a cap, so a wrong or hostile answer can't fill memory.
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.byteLength
    if (size > release.size) throw new Error(`Refusing the download: more than ${release.size} bytes`)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function findFile(root: string, name: string): string | null {
  const hit = readdirSync(root, { recursive: true, encoding: 'utf8' }).find(rel => path.basename(rel).toLowerCase() === name)
  return hit ? path.join(root, hit) : null
}

/**
 * Makes sure hbbs.exe and hbbr.exe are in `dir` (npm run setup:hub). Skips when both are there
 * with the right sizes; otherwise downloads the pinned zip, refuses it on any size or sha256
 * mismatch, extracts it with Windows' tar.exe in a temp folder and copies the two exes over.
 */
export async function ensureBinaries(opts: EnsureOptions = {}): Promise<Binaries> {
  const release = opts.release ?? RELEASE
  const log = opts.log ?? rootLog.child('setup')
  const dir = opts.dir ?? statePaths().rustdeskServerBin
  const out = { dir, hbbs: path.join(dir, 'hbbs.exe'), hbbr: path.join(dir, 'hbbr.exe') }
  if (hasExes(dir, release)) return { ...out, fetched: false }

  const data = opts.zip ? readFileSync(opts.zip) : await download(release, log)
  checkZip(data, release, opts.zip ?? 'the download')
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sad-rustdesk-server-'))
  try {
    const zip = path.join(tmp, 'server.zip')
    const extracted = path.join(tmp, 'x')
    writeFileSync(zip, data)
    mkdirSync(extracted)
    await run(TAR, ['-xf', zip, '-C', extracted], { windowsHide: true })
    mkdirSync(dir, { recursive: true })
    for (const [name, size] of Object.entries(release.exes)) {
      const found = findFile(extracted, name)
      if (!found) throw new Error(`${name} is not in the rustdesk-server ${release.version} zip`)
      const actual = statSync(found).size
      if (actual !== size) throw new Error(`${name} in the zip is ${actual} bytes, expected ${size}`)
      // Copied beside, then renamed: a half-copied exe never has the real name.
      const dest = path.join(dir, name)
      copyFileSync(found, `${dest}.part`)
      renameSync(`${dest}.part`, dest)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  log.info(`hbbs.exe and hbbr.exe ${release.version} verified and copied to ${dir}`)
  return { ...out, fetched: true }
}

// ---------------------------------------------------------------------------------------
// The command lines, env and output, kept pure for the tests

type Name = 'hbbs' | 'hbbr'

/** `hbbs.exe -p <hbbs> -r <publicHost>:<hbbr> --mask <lanCidr> -k _ -c hbbs.ini` */
export function hbbsArgs(o: { hbbsPort: number; hbbrPort: number; publicHost: string; lanCidr: string }): string[] {
  return ['-p', String(o.hbbsPort), '-r', `${o.publicHost}:${o.hbbrPort}`, '--mask', o.lanCidr, '-k', '_', '-c', 'hbbs.ini']
}

/** `hbbr.exe -p <hbbr> -k _`: it loads the key hbbs wrote in the same folder. */
export function hbbrArgs(hbbrPort: number): string[] {
  return ['-p', String(hbbrPort), '-k', '_']
}

/**
 * hbbs reads local-ip only from .env or -c (rendezvous_server.rs:119-129). With --mask it is
 * the relay address handed to LAN peers, so it carries hbbr's port.
 */
export function hbbsIni(lanAddress: string, hbbrPort: number): string {
  return `local-ip=${lanAddress}:${hbbrPort}\n`
}

/**
 * Nothing inherited: a PORT or KEY in the agent's env would change hbbr's port or key
 * (hbbr.rs:25-41). DB_URL keeps the db in the working folder instead of RustDesk's own
 * config folder, and RUST_LOG must be in the real env (logging starts before .env is read).
 */
export function serverEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const systemRoot = env.SystemRoot || 'C:\\Windows'
  const temp = env.TEMP || env.TMP || os.tmpdir()
  return {
    SystemRoot: systemRoot,
    TEMP: temp,
    TMP: env.TMP || temp,
    PATH: `${systemRoot}\\System32;${systemRoot}`,
    DB_URL: 'db_v2.sqlite3',
    RUST_LOG: 'info',
  }
}

/** The ports each one takes: hbbs P-1 (NAT test), P, P+2 (WebSocket); hbbr R, R+2 (WebSocket). */
export function serverPorts(name: Name, port: number): number[] {
  return name === 'hbbs' ? [port - 1, port, port + 2] : [port, port + 2]
}

/** The public key from a "Key: <base64>" log line (rendezvous_server.rs:1243, relay_server.rs:583). */
export function parseKeyLine(line: string): string | null {
  const m = /(?:^|[\s\]])Key: ([A-Za-z0-9+/]{43}=)\s*$/.exec(line)
  return m ? m[1] : null
}

// hbbs logs this after binding all its listeners (rendezvous_server.rs:150-165).
const HBBS_BOUND = /\bALWAYS_USE_RELAY=[YN]\s*$/
// hbbr logs "Start" just before binding (relay_server.rs:91-96); a bind failure exits at once.
const HBBR_START = /\]\s*Start\s*$/

/** The trimmed id_ed25519.pub, or null unless both key files are there. */
function readPublicKey(dir: string): string | null {
  try {
    if (!existsSync(path.join(dir, 'id_ed25519'))) return null
    const pub = readFileSync(path.join(dir, 'id_ed25519.pub'), 'utf8').trim()
    return pub || null
  } catch {
    return null
  }
}

// Windows lets a second socket with SO_REUSEADDR share a port another holds (hbbs's IPv4
// fallback does that, tcp.rs:226-262), so a busy port could go unnoticed. Check first.
function tcpPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '::', ipv6Only: false, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

async function firstBusyPort(ports: number[]): Promise<number | null> {
  for (const port of ports) if (!(await tcpPortFree(port))) return port
  return null
}

// ---------------------------------------------------------------------------------------
// Supervise

export interface ServersConfig {
  ports: Pick<Ports, 'hbbs' | 'hbbr'>
  publicHost: string
  /** config.json's pin; detection otherwise. */
  lanAddress?: string | null
  paths: Pick<StatePaths, 'rustdeskServer' | 'rustdeskServerBin'>
}

export interface Lan {
  address: string
  cidr: string
}

interface Timing {
  /** For the key files, the "Key:" line and the listeners. */
  keyWaitMs: number
  backoffMs: number[]
  lanPollMs: number
  /** Running this long resets the backoff. */
  stableMs: number
  /** hbbr: alive this long after "Start" counts as bound. */
  settleMs: number
  /** How often a missing exe or a busy port is looked at again. */
  retryMs: number
}

const TIMING: Timing = {
  keyWaitMs: 10_000,
  backoffMs: [1000, 2000, 5000, 10_000, 30_000],
  lanPollMs: 10_000,
  stableMs: 60_000,
  settleMs: 1000,
  retryMs: 30_000,
}

export interface ServersOptions {
  /** Default cfg.paths.rustdeskServerBin. Tests keep it: every new exe path is a new firewall prompt. */
  exeDir?: string
  /** hbbs.ini, keys, db and logs/. Default cfg.paths.rustdeskServer; tests use a temp folder. */
  workDir?: string
  /** Tests: the LAN to use instead of detecting it. */
  lan?: () => Lan | null
  log?: Logger
  /** Called on every status change. */
  onChange?: (servers: ServerStatus[]) => void
  /** Tests: shorter waits. */
  timing?: Partial<Timing>
  /** Tests: run this instead of the exe, e.g. [process.execPath, 'fake.ts']; the real flags follow. */
  command?: Partial<Record<Name, string[]>>
}

export interface Servers {
  status(): ServerStatus[]
  /** The trimmed id_ed25519.pub once hbbs has proven it runs with it; null before. */
  licenceKey(): string | null
  /** Resolves once both run; rejects on timeout or stop(), with each one's last error. */
  ready(timeoutMs?: number): Promise<void>
  /** Re-reads the LAN now (also done every 10 s); a new address or subnet restarts hbbs. */
  checkLan(): void
  /** Kills both and waits for them to exit. */
  stop(): Promise<void>
}

interface Slot {
  name: Name
  port: number
  state: ServerStatus['state']
  child: ChildProcess | null
  pid: number | null
  since: string | null
  restarts: number
  lastError: string | null
  /** Index into the backoff. */
  attempt: number
  /** A pending restart or retry. */
  timer: NodeJS.Timeout | null
  /** Between launch() and spawn (the port check is async). */
  launching: boolean
  /** Killed on purpose (LAN or key change): start again at once. */
  respawn: boolean
  out: DailyFile
}

/**
 * Starts hbbs, waits until it has proven it runs with a key, then starts hbbr, and keeps both
 * running (restart backoff 1, 2, 5, 10, 30 s). The children are not detached: they die with
 * the agent.
 */
export function startServers(cfg: ServersConfig, opts: ServersOptions = {}): Servers {
  const timing: Timing = { ...TIMING, ...opts.timing }
  const log = opts.log ?? rootLog.child('rustdesk-server')
  const exeDir = opts.exeDir ?? cfg.paths.rustdeskServerBin
  const workDir = opts.workDir ?? cfg.paths.rustdeskServer
  const logDir = path.join(workDir, 'logs')
  const detectLan = opts.lan ?? (() => primaryLan({ lanAddress: cfg.lanAddress }))
  const waiters = new Set<() => void>()
  let lan: Lan | null = null
  let key: string | null = null
  let stopping = false
  let stopped: Promise<void> | null = null

  const slot = (name: Name, port: number): Slot => ({
    name, port, state: 'stopped', child: null, pid: null, since: null, restarts: 0, lastError: null,
    attempt: 0, timer: null, launching: false, respawn: false, out: dailyFile(logDir, name),
  })
  const hbbs = slot('hbbs', cfg.ports.hbbs)
  const hbbr = slot('hbbr', cfg.ports.hbbr)

  function status(): ServerStatus[] {
    return [hbbs, hbbr].map(s => ({
      name: s.name, state: s.state, pid: s.pid, ports: serverPorts(s.name, s.port), since: s.since, restarts: s.restarts, lastError: s.lastError,
    }))
  }

  function changed() {
    opts.onChange?.(status())
    for (const waiter of [...waiters]) waiter()
  }

  // `error` undefined keeps the last one: a server starting again still shows why it fell over.
  function setState(s: Slot, state: ServerStatus['state'], error?: string | null) {
    if (s.state !== state) s.since = new Date().toISOString()
    s.state = state
    if (error !== undefined) s.lastError = error
    changed()
  }

  function later(s: Slot, ms: number, fn: () => void) {
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => {
      s.timer = null
      if (!stopping) fn()
    }, ms)
  }

  function crashed(s: Slot, why: string) {
    const delay = timing.backoffMs[Math.min(s.attempt, timing.backoffMs.length - 1)]
    s.attempt++
    log.warn(`${s.name} ${why}; starting it again in ${delay / 1000} s`)
    setState(s, 'crashed', why)
    later(s, delay, () => {
      s.restarts++
      void launch(s)
    })
  }

  async function launch(s: Slot) {
    if (stopping || s.child || s.launching) return
    s.launching = true
    try {
      await spawnServer(s)
    } catch (e) {
      // An unwritable working folder, or spawn() refusing outright: a crash like any other.
      if (!stopping && !s.child) crashed(s, `could not start: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      s.launching = false
    }
  }

  async function spawnServer(s: Slot) {
    const [file, ...pre] = opts.command?.[s.name] ?? [path.join(exeDir, `${s.name}.exe`)]
    if (!existsSync(file)) {
      setState(s, 'missing', `${path.basename(file)} is not in ${path.dirname(file)}. Run npm run setup:hub.`)
      later(s, timing.retryMs, () => void launch(s))
      return
    }
    let args: string[]
    if (s.name === 'hbbs') {
      // The mask decides "same LAN" in hbbs; without a LAN there is nothing to serve yet.
      if (!lan) {
        setState(s, 'stopped', 'This PC has no LAN address yet; hbbs starts when it has one.')
        return
      }
      mkdirSync(workDir, { recursive: true })
      writeFileSync(path.join(workDir, 'hbbs.ini'), hbbsIni(lan.address, cfg.ports.hbbr))
      args = hbbsArgs({ hbbsPort: s.port, hbbrPort: cfg.ports.hbbr, publicHost: cfg.publicHost, lanCidr: lan.cidr })
    } else {
      args = hbbrArgs(s.port)
    }

    setState(s, 'starting')
    const busy = await firstBusyPort(serverPorts(s.name, s.port))
    if (stopping) return
    if (busy !== null) {
      crashed(s, `cannot start: port ${busy} is in use by another program`)
      return
    }

    mkdirSync(workDir, { recursive: true })
    const child = spawn(file, [...pre, ...args], {
      cwd: workDir,
      env: serverEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    s.child = child
    s.pid = child.pid ?? null
    if (child.pid) log.info(`${s.name} started (pid ${child.pid}): ${s.name}.exe ${args.join(' ')}`)
    supervise(s, child)
  }

  function supervise(s: Slot, child: ChildProcess) {
    let done = false
    let failure: string | null = null
    let sawKey: string | null = null
    let bound = false
    let settling = false
    let lastLine = ''
    const timers: NodeJS.Timeout[] = []

    // The gate: a hbbs that could not write its key runs keyless and accepts anyone
    // (common.rs:107-155), so no key in time means stop it.
    const fail = (why: string) => {
      if (done || failure) return
      failure = why
      child.kill()
    }
    const gate = setTimeout(() => {
      if (sawKey && !bound) fail(`did not open its ports within ${timing.keyWaitMs / 1000} s`)
      else if (s.name === 'hbbs') fail(`started without a key: no id_ed25519/id_ed25519.pub and "Key:" line within ${timing.keyWaitMs / 1000} s. Is ${workDir} writable? Stopped it, since a keyless hbbs lets anyone in.`)
      else fail(`printed no "Key:" line within ${timing.keyWaitMs / 1000} s`)
    }, timing.keyWaitMs)
    timers.push(gate)

    const running = () => {
      for (const t of timers.splice(0)) clearTimeout(t)
      setState(s, 'running', null)
      log.info(`${s.name} running (pid ${child.pid}, ports ${serverPorts(s.name, s.port).join(', ')})`)
      timers.push(setTimeout(() => (s.attempt = 0), timing.stableMs))
    }

    const check = () => {
      if (done || failure || settling || s.state !== 'starting' || !sawKey || !bound) return
      if (s.name === 'hbbs') {
        const pub = readPublicKey(workDir)
        if (!pub) return fail(`printed a key but id_ed25519/id_ed25519.pub are not in ${workDir}`)
        if (pub !== sawKey) return fail('printed a key that differs from id_ed25519.pub')
        const rekeyed = key !== null && key !== pub
        key = pub
        running()
        if (rekeyed && hbbr.child) {
          // hbbr checks licence_key against the key it loaded at start (relay_server.rs:425-433).
          log.warn('hbbs has a new key; restarting hbbr so both use it')
          hbbr.respawn = true
          hbbr.child.kill()
        } else if (!hbbr.child && !hbbr.timer && !hbbr.launching) {
          // hbbr loads id_ed25519 at start, or makes its own if it is missing: only after hbbs.
          void launch(hbbr)
        }
      } else {
        if (sawKey !== key) return fail("loaded a different key than hbbs's id_ed25519.pub")
        settling = true
        clearTimeout(gate)
        timers.push(setTimeout(() => !done && !failure && running(), timing.settleMs))
      }
    }

    const onLine = (line: string) => {
      lastLine = line.trim() || lastLine
      const found = parseKeyLine(line)
      if (found) sawKey = found
      if (s.name === 'hbbs' ? HBBS_BOUND.test(line) : HBBR_START.test(line)) bound = true
      check()
    }

    for (const stream of [child.stdout, child.stderr]) {
      let partial = ''
      stream?.setEncoding('utf8')
      stream?.on('data', (text: string) => {
        s.out.write(text)
        const lines = (partial + text).split(/\r?\n/)
        partial = lines.pop() ?? ''
        for (const line of lines) onLine(line)
      })
      stream?.on('end', () => partial && onLine(partial))
    }

    const exited = (why: string) => {
      if (done) return
      done = true
      for (const t of timers.splice(0)) clearTimeout(t)
      if (s.child === child) {
        s.child = null
        s.pid = null
      }
      if (stopping) return setState(s, 'stopped')
      if (s.respawn) {
        s.respawn = false
        setState(s, 'starting')
        void launch(s)
        return
      }
      crashed(s, failure ?? (lastLine ? `${why}. Last output: ${lastLine.slice(0, 300)}` : why))
    }
    child.on('exit', (code, signal) => exited(signal ? `was killed (${signal})` : `exited with code ${code}`))
    child.on('error', e => {
      // No pid: it never started. Otherwise (a failed kill) it is still running.
      if (child.pid === undefined) exited(`could not start: ${e.message}`)
      else log.error(`${s.name}: ${e.message}`)
    })
  }

  function readLan(): Lan | null {
    const found = detectLan()
    return found ? { address: found.address, cidr: found.cidr } : null
  }

  function checkLan() {
    if (stopping) return
    const next = readLan()
    // No LAN for now (Wi-Fi dropped): keep what runs; nobody can reach it anyway.
    if (!next || (lan && next.address === lan.address && next.cidr === lan.cidr)) return
    const first = lan === null
    lan = next
    if (first) {
      if (!hbbs.child && !hbbs.timer) void launch(hbbs)
      return
    }
    log.info(`the LAN is now ${next.address} (${next.cidr}); restarting hbbs with it`)
    if (hbbs.child) {
      hbbs.respawn = true
      hbbs.child.kill()
    }
    // Otherwise a pending restart reads the new LAN when it runs.
  }

  async function stop() {
    stopping = true
    clearInterval(lanTimer)
    for (const s of [hbbs, hbbr]) {
      if (s.timer) clearTimeout(s.timer)
      s.timer = null
    }
    // Wait for 'close' (the output is flushed), not just 'exit'; give up after 5 s.
    await Promise.all(
      [hbbs, hbbr].map(s => {
        const child = s.child
        if (!child) {
          setState(s, s.state === 'missing' ? 'missing' : 'stopped')
          return
        }
        return new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 5000)
          child.once('close', () => {
            clearTimeout(timer)
            resolve()
          })
          child.kill()
        })
      }),
    )
    await Promise.all([hbbs.out.close(), hbbr.out.close()])
    log.info('hbbs and hbbr stopped')
    changed()
  }

  function ready(timeoutMs = 20_000) {
    return new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer)
        waiters.delete(waiter)
        if (error) reject(error)
        else resolve()
      }
      const why = () => [hbbs, hbbr].map(s => `${s.name} ${s.state}${s.lastError ? ` (${s.lastError})` : ''}`).join('; ')
      const waiter = () => {
        if (hbbs.state === 'running' && hbbr.state === 'running') done()
        else if (stopping) done(new Error(`stopped before both ran: ${why()}`))
      }
      const timer = setTimeout(() => done(new Error(`hbbs/hbbr not running after ${timeoutMs / 1000} s: ${why()}`)), timeoutMs)
      waiters.add(waiter)
      waiter()
    })
  }

  // Start.
  if (existsSync(path.join(workDir, '.env'))) {
    log.warn(`${path.join(workDir, '.env')} exists: hbbs and hbbr read it, and it can change their settings`)
  }
  lan = readLan()
  const lanTimer = setInterval(checkLan, timing.lanPollMs)
  lanTimer.unref()
  void launch(hbbs)

  return {
    status,
    licenceKey: () => key,
    ready,
    checkLan,
    stop: () => (stopped ??= stop()),
  }
}
