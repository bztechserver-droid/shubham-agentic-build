import { execFile, spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { closeSync, openSync, readdirSync, statSync } from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { loadConfig, loadOrCreateApiToken, type Config } from './config.ts'
import { keeperAlive, readKeeperState } from './hub/keeper-state.ts'
import { createLogger, type Logger } from './log.ts'
import { killTree } from './proc-tree.ts'
import { findRustdesk, getRustdeskId } from './rustdesk.ts'
import { updateIntent } from './guard/intent.ts'
import { supervise, type Identity, type Running, type Spec, type Status, type Supervisor } from './guard/supervisor.ts'
import { startUiServer, type UiServer } from './ui-server.ts'

// F-058: the guard keeps the app up. It is the one thing that runs apart from the app, and it does
// four jobs (agent/SPEC.md › The guard):
//   the agent    starts it, and starts it again within a second of its dying and within seconds of its
//                hanging, whoever or whatever killed it; runs the update step after "Update now"
//   the page     serves the built page and forwards /agent-api itself, on 5173 (the agent no longer does),
//                so 5173 is never closed: while the agent restarts the page stays up and its link sign
//                says "Reconnecting", and /guard/status says what is happening and when it is back
//   RustDesk     keeps the hub's hbbs and hbbr in a process of their own (hub/keeper.ts), so Control works
//                while the agent is down
//   one only     a second guard finds the lock port taken and exits (code 3): started again by
//                the Scheduled Task every minute, by the Startup launcher, by hand from Christopher on 4740,
//                nothing stacks
// It adopts what already runs (an agent started the old way) and never kills by port, by name or
// with taskkill /t: only exact PIDs, found by start time (proc-tree.ts).
//   node agent/guard.ts [--role hub]        run (Guard.cmd does this and restarts it if it ever dies)
//   node agent/guard.ts status | stop | restart

export const EXIT_RUNNING = 3
export const EXIT_STOPPED = 4
export const EXIT_RESTART_ME = 5

export interface GuardOptions {
  config: Config
  /** The build folder: agent/, app/, Update.cmd. */
  root: string
  /** The page's port (5173); the guard's front takes it. */
  uiPort: number
  /** The guard's own port, on 127.0.0.1: the lock, /status and the commands. */
  guardPort: number
  log: Logger
  /** What to run as the agent. Default: node agent/main.ts --app app, with `agentArgs`. */
  agent?: { file: string; args: string[]; env?: Record<string, string> }
  agentArgs?: string[]
  /** What to run as the RustDesk keeper; false: none. Default: node agent/hub/keeper.ts, on the hub only. */
  keeper?: { file: string; args: string[] } | false
  /** The command that updates the build after exit code 75; false: none. Default: Update.cmd. */
  update?: { file: string; args: string[] } | false
  /** false: no page server (tests of the rest). */
  front?: boolean
  /** Where the agent's output goes. Default <state>/agent-console.log, as Start.cmd did. */
  consoleFile?: string
  agentGraceMs?: number
  agentHungAfter?: number
  /** The command line of an agent found already running must match this to be taken over by its PID. Default: node running main.ts. */
  agentPattern?: RegExp
  tickMs?: number
  /** The RustDesk ID for the Control link; looked up when left out. */
  rustdeskId?: string | null
  /** The guard's own code changed in an update: the entry restarts the guard so the new code runs. */
  onSelfUpdate?: () => void
  /** `stop` on the control port: the entry stops everything and exits; the default stops the guard. */
  onStopRequested?: () => void
}

export interface GuardStatus {
  guard: { pid: number; startedAt: number; port: number; uiPort: number | null }
  front: 'up' | 'waiting' | 'off'
  agent: Status
  keeper: Status | null
  now: number
  /** About how many seconds until the agent answers again; 0 when it does. */
  etaSeconds: number
  control: { rustdeskId: string | null; rustdeskUri: string | null; christopherPort: number }
}

export interface Guard {
  port: number
  uiPort: number | null
  status(): GuardStatus
  restartAgent(why: string): Promise<void>
  /** Ends the agent and the keeper, and the guard. `keepChildren`: leave them running (as a killed guard does). */
  stop(o?: { keepChildren?: boolean }): Promise<void>
}

const CHRISTOPHER_PORT = 4740
const DEFAULT_BOOT_MS = 12_000
const DEFAULT_UPDATE_MS = 20_000

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms).unref())

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

/** Does the agent's own API answer? (Its /health needs no token.) */
async function agentAnswers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/agent-api/health`, { signal: AbortSignal.timeout(2500), cache: 'no-store' })
    await res.arrayBuffer().catch(() => {})
    return res.ok
  } catch {
    return false
  }
}

const alivePid = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Which process listens on 127.0.0.1:<port> and runs the agent: its PID and start (one PowerShell call), or
 * null. Asked once, when an agent is found already running (the old Start.cmd's, or one that outlived the
 * guard before this one), so that it can be seen to go and ended by its exact PID. A PID is only as good as
 * the process behind it: it must be node running main.ts, and its start time goes with it into the kill.
 */
export function findListener(port: number, pattern: RegExp = /main\.ts/): Promise<Identity | null> {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(null)
    const script =
      `$c = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
      `if ($c) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess); if ($p) { '{0}|{1}|{2}' -f $p.ProcessId, $(if ($p.CreationDate) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } else { 0 }), $p.CommandLine } }`
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 }, (err, stdout) => {
      if (err) return resolve(null)
      const m = /^(\d+)\|(\d+)\|(.*)$/m.exec(String(stdout).trim())
      if (!m || !/node/i.test(m[3]) || !pattern.test(m[3])) return resolve(null)
      resolve({ pid: Number(m[1]), startedAt: Number(m[2]) || undefined })
    })
  })
}

/** A fingerprint of the files the guard itself runs from, to see whether an update changed them. */
function guardCodeStamp(root: string): string {
  const parts: string[] = []
  const add = (file: string) => {
    try {
      const s = statSync(file)
      parts.push(`${path.relative(root, file)}:${s.size}:${Math.round(s.mtimeMs)}`)
    } catch {
      parts.push(`${path.relative(root, file)}:-`)
    }
  }
  for (const f of ['agent/guard.ts', 'agent/proc-tree.ts', 'agent/hub/keeper.ts', 'agent/hub/keeper-state.ts', 'agent/ui-server.ts']) add(path.join(root, f))
  try {
    for (const f of readdirSync(path.join(root, 'agent', 'guard'))) add(path.join(root, 'agent', 'guard', f))
  } catch {
    // No such folder.
  }
  return parts.join('|')
}

export async function startGuard(o: GuardOptions): Promise<Guard> {
  const { config, log, root } = o
  const startedAt = Date.now()
  const token = loadOrCreateApiToken(config.paths.root)
  const consoleFile = o.consoleFile ?? path.join(config.paths.root, 'agent-console.log')
  let rustdeskId: string | null = o.rustdeskId ?? null
  let stopped = false

  // ---- the lock: one guard at a time. The port goes with the process, however it dies.
  const control = http.createServer((req, res) => void onControl(req, res).catch(e => json(res, 500, { error: String(e) })))
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject)
    control.listen({ port: o.guardPort, host: '127.0.0.1', exclusive: true }, () => {
      control.off('error', reject)
      control.on('error', e => log.error(`control: ${e.message}`))
      resolve()
    })
  })

  // ---- what to run
  const agentCmd = o.agent ?? { file: process.execPath, args: ['agent/main.ts', '--app', 'app', ...(o.agentArgs ?? [])] }
  const keeperCmd = o.keeper === false ? null : (o.keeper ?? (config.role === 'hub' ? { file: process.execPath, args: ['agent/hub/keeper.ts', ...(o.agentArgs ?? [])] } : null))
  const updateCmd = o.update === false ? null : (o.update ?? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/c', 'Update.cmd'] })

  const agentEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    // Tells the agent: it is kept (so Update now works), the page is the guard's, the RustDesk
    // servers are the keeper's, and the chats that were open are to come back.
    SAD_SUPERVISED: '1',
    SAD_PAGE_SERVER: 'guard',
    ...(keeperCmd ? { SAD_RUSTDESK_EXTERNAL: '1' } : {}),
    SAD_RESUME_CHATS: process.env.SAD_RESUME_CHATS ?? '1',
    ...agentCmd.env,
  })

  function launch(name: string, file: string, args: string[], env: NodeJS.ProcessEnv): Running {
    const fd = openSync(consoleFile, 'a')
    let child: ReturnType<typeof spawn>
    try {
      // detached: Node ties every child it starts to a job that ends it when Node exits, however Node
      // exits. The agent and the keeper must outlive the guard (it is killed, crashes, or updates
      // itself): the next guard finds them answering and takes them over. (Measured 1 Nov 2026: a
      // plain child is gone with its parent, a detached one is not.)
      child = spawn(file, args, { cwd: root, env, windowsHide: true, detached: true, stdio: ['ignore', fd, fd] })
    } finally {
      closeSync(fd)
    }
    const pid = child.pid
    if (!pid) {
      child.once('error', () => {})
      throw new Error(`could not start ${name}: ${file}`)
    }
    child.unref()
    const since = Date.now()
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
      child.once('error', e => log.error(`${name}: ${e.message}`))
    })
    return {
      pid,
      exited,
      async stop() {
        await killTree(pid, { since, log: m => log.warn(`${name}: ${m}`) }).catch(e => {
          log.warn(`${name}: could not read the process table (${e instanceof Error ? e.message : String(e)}); ending pid ${pid} alone`)
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Gone.
          }
        })
        await Promise.race([exited, pause(5000)])
      },
    }
  }

  /** A process this guard did not start (an agent the old Start.cmd began, or one that outlived the guard before this one), watched by its PID and ended, when need be, by it. */
  const pollers = new Set<NodeJS.Timeout>()
  function adoptPid(name: string, id: Identity): Running | null {
    const pid = id.pid
    if (!pid || pid === process.pid) return null
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
      const timer = setInterval(() => {
        if (alivePid(pid)) return
        clearInterval(timer)
        pollers.delete(timer)
        // Its exit code is not ours to read (the update asks the agent's log instead).
        resolve({ code: null, signal: null })
      }, 500)
      timer.unref()
      pollers.add(timer)
    })
    return {
      pid,
      exited,
      async stop() {
        // Only by exact PID and start time, never on a guess: without the table the process is left alone.
        await killTree(pid, { since: id.startedAt, log: m => log.warn(`${name}: ${m}`) }).catch(e => log.warn(`${name}: could not read the process table (${e instanceof Error ? e.message : String(e)}); leaving pid ${pid} alone`))
        await Promise.race([exited, pause(5000)])
      },
    }
  }

  async function runUpdate(): Promise<void> {
    const before = guardCodeStamp(root)
    if (updateCmd) {
      log.info('the app asked to update: running Update.cmd')
      const fd = openSync(consoleFile, 'a')
      const began = Date.now()
      await new Promise<void>(resolve => {
        // git must never wait for somebody: no prompt for a password, no credential window nobody sees,
        // and a transfer that has stalled for half a minute is given up on (this build is then
        // unchanged, and is started again, rather than the app staying down while git waits).
        const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '30' }
        const c = spawn(updateCmd.file, updateCmd.args, { cwd: root, env, windowsHide: true, stdio: ['ignore', fd, fd] })
        const since = Date.now()
        const limit = setTimeout(() => {
          log.warn('Update.cmd ran for 10 minutes; ending it')
          if (c.pid) void killTree(c.pid, { since }).catch(() => {})
          resolve()
        }, 10 * 60_000)
        c.once('close', code => {
          clearTimeout(limit)
          log.info(`Update.cmd finished (exit ${code}) after ${((Date.now() - began) / 1000).toFixed(1)} s`)
          resolve()
        })
        c.once('error', e => {
          clearTimeout(limit)
          log.error(`Update.cmd: ${e.message}`)
          resolve()
        })
      })
      closeSync(fd)
    }
    if (guardCodeStamp(root) !== before && o.onSelfUpdate) {
      log.info('the guard itself was updated: restarting it so the new code runs')
      o.onSelfUpdate()
    }
  }

  // ---- the supervisors
  const clock = { now: () => Date.now() }
  const agent: Supervisor = supervise(
    {
      name: 'agent',
      start: why => {
        log.info(`starting the agent: ${why}`)
        return launch('agent', agentCmd.file, agentCmd.args, agentEnv())
      },
      probe: () => agentAnswers(config.ports.api),
      // An agent found already running: whose it is (for an exact-PID end, and to see it go).
      find: () => findListener(config.ports.api, o.agentPattern),
      adopt: id => adoptPid('agent', id),
      // An agent that said "stopping: updating to the newer build" and then went (or hangs) is updated.
      intent: since => updateIntent(config.paths.logs, since),
      graceMs: o.agentGraceMs ?? 90_000,
      hungAfter: o.agentHungAfter ?? 8,
      updateCodes: [75],
      onExit: runUpdate,
    } satisfies Spec,
    { ...clock, log: m => log.info(m) },
  )
  const keeper: Supervisor | null = keeperCmd
    ? supervise(
        {
          name: 'keeper',
          start: why => {
            log.info(`starting the RustDesk keeper: ${why}`)
            return launch('keeper', keeperCmd.file, keeperCmd.args, { ...process.env })
          },
          // The keeper is there when its state file is fresh and its process exists; the file says which process.
          probe: async () => {
            const state = readKeeperState(config.paths.rustdeskServer)
            return keeperAlive(state) ? { pid: state.pid, startedAt: Date.parse(state.startedAt) || undefined } : false
          },
          adopt: id => adoptPid('keeper', id),
          graceMs: 20_000,
          hungAfter: 6,
        } satisfies Spec,
        { ...clock, log: m => log.info(m) },
      )
    : null

  // ---- the page, on 5173, always
  let front: UiServer | null = null
  let frontTimer: NodeJS.Timeout | null = null
  let frontWarnedAt = 0
  const status = (): GuardStatus => {
    const a = agent.status()
    const now = Date.now()
    let eta = 0
    if (a.state !== 'up') {
      // How long it was away the last time (an update takes the pull and the start: about 7 s), else a guess.
      const boot = a.lastDowntimeMs ?? (a.state === 'updating' ? DEFAULT_UPDATE_MS : DEFAULT_BOOT_MS)
      const away = a.downSince === null ? 0 : now - a.downSince
      eta = a.state === 'stopped' ? 0 : Math.max(2, Math.min(90, Math.round((boot - away) / 1000) + (a.nextTryAt && a.nextTryAt > now ? Math.round((a.nextTryAt - now) / 1000) : 0)))
    }
    return {
      guard: { pid: process.pid, startedAt, port: o.guardPort, uiPort: front?.port ?? null },
      front: o.front === false ? 'off' : front ? 'up' : 'waiting',
      agent: a,
      keeper: keeper?.status() ?? null,
      now,
      etaSeconds: eta,
      control: { rustdeskId, rustdeskUri: rustdeskId ? `rustdesk://connection/new/${rustdeskId}` : null, christopherPort: CHRISTOPHER_PORT },
    }
  }

  async function openFront() {
    if (o.front === false || front || stopped) return
    try {
      front = await startUiServer({
        port: o.uiPort,
        appDir: path.join(root, 'app'),
        apiPort: () => config.ports.api,
        token,
        log: log.child('page'),
        handle: async (req, res, url) => {
          if (url.pathname !== '/guard/status') return false
          if (req.method !== 'GET' && req.method !== 'HEAD') return false
          json(res, 200, status())
          return true
        },
      })
      if (stopped) return void (await front.close())
      log.info(`the page is served on port ${front.port}`)
    } catch (e) {
      // Taken: an agent started the old way still serves it. Look again in a moment.
      if (Date.now() - frontWarnedAt > 60_000) {
        frontWarnedAt = Date.now()
        log.warn(`the page cannot be served on port ${o.uiPort} yet (${e instanceof Error ? e.message : String(e)}); trying every second`)
      }
      frontTimer = setTimeout(() => void openFront(), 1000)
      frontTimer.unref()
    }
  }

  // ---- the control port
  async function onControl(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://guard')
    if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, status())
    if (req.method === 'POST' && (url.pathname === '/stop' || url.pathname === '/restart-agent')) {
      const given = req.headers['x-sad-token']
      if (typeof given !== 'string' || !same(given, token)) return json(res, 401, { error: 'Missing or wrong x-sad-token' })
      if (url.pathname === '/restart-agent') {
        void agent.restart('restart asked for')
        return json(res, 200, { ok: true })
      }
      json(res, 200, { ok: true })
      setTimeout(() => (o.onStopRequested ? o.onStopRequested() : void guard.stop()), 50).unref()
      return
    }
    json(res, 404, { error: `No such path: ${url.pathname}` })
  }

  // ---- go
  const tick = () => {
    void agent.tick()
    // An agent this didn't start (the old Start.cmd's) runs its own hbbs and hbbr: a keeper would
    // fight it for the ports. It starts once the agent is the guard's own.
    if (!agent.status().adopted) void keeper?.tick()
  }
  const timer = setInterval(tick, o.tickMs ?? 1000)
  tick()
  void openFront()
  if (o.rustdeskId === undefined && !process.env.SAD_TEST_NO_RUSTDESK) {
    void (async () => {
      try {
        const exe = findRustdesk()
        if (exe) rustdeskId = await getRustdeskId(exe)
      } catch {
        // No Control link without it; the page still says the app is restarting.
      }
    })()
  }
  log.info(`the guard runs (pid ${process.pid}) in ${root}; control port ${o.guardPort}, page port ${o.front === false ? 'off' : o.uiPort}; ${keeperCmd ? 'with' : 'without'} the RustDesk keeper`)

  const guard: Guard = {
    port: o.guardPort,
    get uiPort() {
      return front?.port ?? null
    },
    status,
    restartAgent: why => agent.restart(why),
    async stop(opts = {}) {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      if (frontTimer) clearTimeout(frontTimer)
      // `keepChildren`: as if this process had been killed, they go on, and the next guard adopts them.
      if (opts.keepChildren) {
        agent.release()
        keeper?.release()
      } else {
        await Promise.all([agent.stop(), keeper?.stop()])
      }
      for (const t of pollers) clearInterval(t)
      pollers.clear()
      await front?.close()
      await new Promise<void>(r => {
        control.close(() => r())
        control.closeAllConnections()
      })
      log.info('the guard stopped')
    },
  }
  return guard
}

// ---------------------------------------------------------------------------------------------
// The command line

async function ask(guardPort: number, method: 'GET' | 'POST', route: string, token?: string) {
  const res = await fetch(`http://127.0.0.1:${guardPort}${route}`, { method, headers: token ? { 'x-sad-token': token } : {}, signal: AbortSignal.timeout(5000) })
  return { status: res.status, body: (await res.json().catch(() => null)) as unknown }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const verb = ['status', 'stop', 'restart'].includes(argv[0] ?? '') ? argv.shift()! : 'run'
  const guardPort = Number(process.env.SAD_GUARD_PORT) || 21228
  const root = path.resolve(import.meta.dirname, '..')

  if (verb !== 'run') {
    const config = loadConfig({ argv })
    try {
      if (verb === 'status') {
        const r = await ask(guardPort, 'GET', '/status')
        console.log(JSON.stringify(r.body, null, 2))
      } else {
        const token = loadOrCreateApiToken(config.paths.root)
        const r = await ask(guardPort, 'POST', verb === 'stop' ? '/stop' : '/restart-agent', token)
        console.log(r.status === 200 ? (verb === 'stop' ? 'The guard is stopping the app and itself.' : 'The agent is restarting.') : `The guard answered ${r.status}`)
      }
    } catch {
      console.log('No guard is running.')
      process.exitCode = 1
    }
  } else {
    const config = loadConfig({ argv })
    const log = createLogger({ dir: config.paths.logs, prefix: 'guard' })
    let guard: Guard
    const stop = (why: string) => {
      log.info(`stopping: ${why}`)
      void guard.stop().then(async () => {
        await log.close()
        process.exit(EXIT_STOPPED)
      })
    }
    try {
      guard = await startGuard({
        config,
        root,
        uiPort: Number(process.env.SAD_UI_PORT) || 5173,
        guardPort,
        log,
        agentArgs: argv,
        onSelfUpdate: () => {
          // Guard.cmd starts it again at once; the new one adopts what runs and takes the page back.
          void guard.stop({ keepChildren: true }).then(() => process.exit(EXIT_RESTART_ME))
        },
        onStopRequested: () => stop('asked on the control port'),
      })
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE') {
        log.info(`a guard runs already (port ${guardPort} is taken)`)
        await log.close()
        process.exit(EXIT_RUNNING)
      }
      log.error(`the guard could not start: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
      await log.close()
      process.exit(1)
    }
    process.on('SIGINT', () => stop('Ctrl+C'))
    process.on('SIGTERM', () => stop('SIGTERM'))
    process.on('SIGBREAK', () => stop('Ctrl+Break'))
    // A guard that stops on a stray error is no guard: say so and go on.
    process.on('uncaughtException', e => log.error(`internal error: ${e.stack ?? e.message}`))
    process.on('unhandledRejection', e => log.error(`internal error (unhandled rejection): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`))
  }
}
