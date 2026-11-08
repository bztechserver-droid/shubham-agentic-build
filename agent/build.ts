import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Role } from '../shared/agent-api.ts'
import { UPDATE_EXIT_CODE, type BuildInfo, type BuildVersion, type PublishRequest } from '../shared/build.ts'
import { apiError, type ApiMount, type MountRequest } from './api.ts'
import { authError, mayPublish } from './auth/types.ts'
import type { Logger } from './log.ts'

// F-020: what this PC runs, and getting a newer one (shared/build.ts).
//   which     a build (RELEASE.json in the folder it runs from) or Dev (no RELEASE.json)
//   updates   a build that is a clone of the build repo looks on GitHub (git fetch) at start, every
//             15 minutes and on Check now; Update exits with UPDATE_EXIT_CODE, and Start.cmd, which
//             it must have been started by (SAD_SUPERVISED=1), pulls the new build and starts it
//   publish   on the hub, when Dev is there: runs Dev's own agent/scripts/publish.ts, which checks,
//             builds, tries and pushes a build, and keeps its lines for the page. Only one at a time.
// Mounted on the local API at /build (api.ts ApiMount), with the app token like the rest.

const CHECK_EVERY_MS = 15 * 60 * 1000
const FIRST_CHECK_MS = 30 * 1000
const LOG_LINES = 400
/** A line of a publish's output that stays however long the log gets: a step's heading ("== Checking: types", the checks' summary), the outcome. */
const KEY_LINE = /^(==|Done\b|Publish stopped)/
const GIT_TIMEOUT_MS = 60 * 1000
const PUBLISHED_MARK = 'PUBLISHED '
const DEV_EVERY_MS = 20_000

export type Git = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>

export const runGit: Git = (args, cwd) =>
  new Promise(resolve => {
    execFile('git', args, { cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })

/**
 * The page's copy of a publish's output, held to `max` lines. A test run prints a line of dots for every
 * few tests, which used to push the step headings out of a 400-line window (build 2325 looked as if its
 * checks had been skipped), so what goes first is the oldest plain line, never a key line (KEY_LINE);
 * only when key lines alone are over the cap do the oldest of those go too.
 */
export function trimLog(log: string[], max = LOG_LINES): string[] {
  let extra = log.length - max
  if (extra <= 0) return log
  const kept = log.filter(line => {
    if (extra > 0 && !KEY_LINE.test(line)) {
      extra--
      return false
    }
    return true
  })
  return kept.length > max ? kept.slice(kept.length - max) : kept
}

/** "748 tests" from the test runner's spec summary ("ℹ pass 748"; it colours even a file), or null when there is none. */
export function testCountOf(summary: string): string | null {
  // oxlint-disable-next-line no-control-regex
  const plain = summary.replace(/\u001b\[[0-9;]*m/g, '')
  const pass = /^\S+ pass (\d+)\s*$/m.exec(plain)?.[1]
  return pass ? `${pass} tests` : null
}

/** F-075: what the update needs to know of the chat host that runs now. */
export interface ChatHostGate {
  protocol: number
  version: number
  /** Chats that are in the middle of something (running or asking). */
  busy(): number
  /** Lets go of the host's chats for good: they are written to the open-chats list, then ended, and come back resumed after the update. */
  retire(): Promise<void>
}

export interface BuildOptions {
  /** The folder this agent runs from (the repo or build root). */
  root: string
  /** Dev's folder on this PC, when it has one; Publish is offered only there, and only on the hub. */
  devDir: string | null
  role: () => Role
  log?: Logger
  /** Exit with this code (the entry's shutdown). */
  restart: (code: number) => void
  /** Started by Start.cmd, which updates and restarts it (SAD_SUPERVISED=1). */
  supervised: boolean
  /** Tests: a fake git, and the command publish runs. */
  git?: Git
  publishCommand?: (devDir: string, req: PublishRequest) => { file: string; args: string[] }
  /** F-075: set once the agent runs its chats in the chat host. */
  chatHostGate?: { current: ChatHostGate | null }
  /** Tests: how long an update waits for idle chats before it asks (10 min), and how often it looks (5 s). */
  hostWaitMs?: number
  hostPollMs?: number
}

export interface Build {
  mount: ApiMount
  info(): BuildInfo
  check(): Promise<BuildInfo>
  close(): void
  /** F154: typed target-local update; no force/body accepted. */
  requestUpdate(): BuildInfo & { restarting: boolean }
  busy(): number
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A RELEASE.json's contents, checked; null when it isn't one. */
export function parseVersion(text: string): BuildVersion | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(v) || typeof v.version !== 'string' || typeof v.builtAt !== 'string') return null
  return {
    version: v.version,
    commit: typeof v.commit === 'string' ? v.commit : null,
    dirty: v.dirty === true,
    builtAt: v.builtAt,
    devHash: typeof v.devHash === 'string' ? v.devHash : null,
    // F-075: only when the build says so (builds from before it have no such field).
    ...(isObject(v.chatHost) && typeof v.chatHost.protocol === 'number' && typeof v.chatHost.version === 'number' ? { chatHost: { protocol: v.chatHost.protocol, version: v.chatHost.version } } : {}),
  }
}

/**
 * F-026: Dev's files as a fingerprint: its commit, every change to tracked files and every new
 * file not ignored. Publish records it in the build; the same fingerprint now means nothing new.
 */
export async function devFingerprint(dir: string, git: Git = runGit, also: string[] = []): Promise<string | null> {
  const h = createHash('sha256')
  if (!(await addRepo(h, dir, git))) return null
  // F-054: the page is built from other folders too (the CRM's source); a change there is something
  // new as well. One that isn't a git folder (or isn't there) adds nothing.
  for (const other of also) {
    const part = createHash('sha256')
    if (await addRepo(part, other, git)) h.update(`\0also ${path.basename(other)}\0`).update(part.digest())
  }
  return h.digest('hex').slice(0, 20)
}

/** A git folder's commit, changes to tracked files and new files, added to a hash; false when git can't say. */
async function addRepo(h: ReturnType<typeof createHash>, dir: string, git: Git): Promise<boolean> {
  const [head, diff, others] = await Promise.all([git(['rev-parse', 'HEAD'], dir), git(['diff', 'HEAD', '--binary'], dir), git(['ls-files', '--others', '--exclude-standard', '-z'], dir)])
  if (head.code !== 0 || diff.code !== 0 || others.code !== 0) return false
  h.update(head.stdout.trim()).update('\0').update(diff.stdout)
  for (const f of others.stdout.split('\0').filter(Boolean).sort()) {
    h.update(`\0${f}\0`)
    try {
      h.update(readFileSync(path.join(dir, f)))
    } catch {
      // Gone since it was listed.
    }
  }
  return true
}

/**
 * F-054: the CRM's source, which the page is compiled with (crm-host/vite-plugin.ts): the sam-crm-fe
 * checkout beside Dev's folder, read in place and never copied or changed, or where SAD_CRM_SRC says.
 * Empty when it isn't there. The build repo never has it: it gets only what was compiled.
 */
export function crmSourceDirs(devDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = path.resolve(env.SAD_CRM_SRC || path.join(devDir, '..', '..', 'sam-crm-fe', 'src'))
  return existsSync(path.join(dir, 'app')) ? [dir] : []
}

/** Dev beside a build: the sibling shubham-agentic-dev folder, or the folder itself when it is Dev. */
export function findDevDir(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const given = env.SAD_DEV_DIR
  if (given) return existsSync(path.join(given, 'agent', 'scripts', 'publish.ts')) ? path.resolve(given) : null
  for (const dir of [root, path.join(path.dirname(root), 'shubham-agentic-dev')]) {
    if (existsSync(path.join(dir, 'agent', 'scripts', 'publish.ts'))) return path.resolve(dir)
  }
  return null
}

export function createBuild(o: BuildOptions): Build {
  const git = o.git ?? runGit
  const log = o.log
  const releaseFile = path.join(o.root, 'RELEASE.json')
  const current = existsSync(releaseFile) ? parseVersion(readFileSync(releaseFile, 'utf8')) : null
  const kind: BuildInfo['kind'] = current ? 'build' : 'dev'
  const isClone = existsSync(path.join(o.root, '.git'))
  const cannot =
    kind !== 'build'
      ? 'This is Dev, run from its source: it is updated with git, not here.'
      : !isClone
        ? 'This build is not a clone of the build repo, so it has nowhere to pull from.'
        : !o.supervised
          ? 'This build was not started by its Start.cmd, so it cannot start itself again: run Update.cmd, then Start.cmd.'
          : null

  const update: BuildInfo['update'] = { state: 'unknown', available: null, checkedAt: null, error: null, can: cannot === null, cannot, hostWait: null }
  const publish: NonNullable<BuildInfo['publish']> | null = o.devDir
    ? { devDir: o.devDir, devCommit: null, devChanges: 0, pending: null, newest: null, state: 'idle', startedAt: null, endedAt: null, log: [], published: null, error: null }
    : null
  let running: ChildProcess | null = null
  /** F-075: Update is waiting for the chats to be idle because the chat host changes with it. */
  let hostWait: { since: number; ask: boolean } | null = null
  let hostTimer: NodeJS.Timeout | null = null
  let checking: Promise<BuildInfo> | null = null

  const info = (): BuildInfo => ({
    kind,
    root: o.root,
    current,
    update: { ...update, hostWait: hostWait ? { since: new Date(hostWait.since).toISOString(), busy: o.chatHostGate?.current?.busy() ?? 0, ask: hostWait.ask } : null },
    publish: publish && o.role() === 'hub' ? { ...publish, ...pendingNow(), log: [...publish.log] } : null,
  })

  /** Dev against the newest build: published since (the last publish, or one on GitHub), or this one. */
  let devHash: string | null = null
  function pendingNow(): { pending: boolean | null; newest: string | null } {
    const newest = publish?.published ?? update.available ?? current
    if (!newest) return { pending: null, newest: null }
    return { pending: newest.devHash && devHash ? newest.devHash !== devHash : null, newest: newest.version }
  }

  async function devStatus() {
    if (!publish) return
    const [head, status] = await Promise.all([git(['rev-parse', '--short', 'HEAD'], publish.devDir), git(['status', '--porcelain'], publish.devDir)])
    publish.devCommit = head.code === 0 ? head.stdout.trim() : null
    publish.devChanges = status.code === 0 ? status.stdout.split('\n').filter(l => l.trim()).length : 0
    devHash = await devFingerprint(publish.devDir, git, crmSourceDirs(publish.devDir))
  }

  async function checkNow(): Promise<BuildInfo> {
    void devStatus().catch(() => {})
    if (kind !== 'build' || !isClone) return info()
    update.state = 'checking'
    const fetched = await git(['fetch', '--quiet', 'origin', 'main'], o.root)
    update.checkedAt = new Date().toISOString()
    if (fetched.code !== 0) {
      update.state = 'failed'
      update.error = `Couldn't reach the build repo: ${fetched.stderr.trim().split('\n').at(-1) || `git fetch exited ${fetched.code}`}`
      return info()
    }
    const [head, remote] = await Promise.all([git(['rev-parse', 'HEAD'], o.root), git(['rev-parse', 'origin/main'], o.root)])
    update.error = null
    if (head.stdout.trim() === remote.stdout.trim()) {
      update.state = 'up-to-date'
      update.available = null
      return info()
    }
    const shown = await git(['show', 'origin/main:RELEASE.json'], o.root)
    update.available = shown.code === 0 ? parseVersion(shown.stdout) : null
    update.state = 'available'
    log?.info(`a newer build is published: ${update.available?.version ?? remote.stdout.trim().slice(0, 7)}`)
    return info()
  }

  function check(): Promise<BuildInfo> {
    checking ??= checkNow().finally(() => {
      checking = null
    })
    return checking
  }

  function startPublish(req: PublishRequest) {
    if (!publish || o.role() !== 'hub') throw apiError(404, 'Publishing is done on the hub, from Dev')
    if (publish.state === 'running') throw apiError(409, 'A publish is already running')
    const cmd = o.publishCommand?.(publish.devDir, req) ?? {
      file: process.execPath,
      args: ['agent/scripts/publish.ts', ...(req.skipChecks ? ['--skip-checks'] : [])],
    }
    Object.assign(publish, { state: 'running', startedAt: new Date().toISOString(), endedAt: null, log: [], error: null })
    log?.info(`publishing a build from ${publish.devDir}`)
    const child = (running = spawn(cmd.file, cmd.args, { cwd: publish.devDir, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' } }))
    let published: BuildVersion | null = null
    const take = (chunk: Buffer) => {
      // Plain text for the page: tools colour their output even when asked not to.
      // oxlint-disable-next-line no-control-regex
      const text = chunk.toString('utf8').replace(/\u001b\[[0-9;]*m/g, '')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        if (line.startsWith(PUBLISHED_MARK)) {
          published = parseVersion(line.slice(PUBLISHED_MARK.length))
          continue
        }
        publish.log.push(line)
      }
      if (publish.log.length > LOG_LINES) publish.log.splice(0, publish.log.length, ...trimLog(publish.log))
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('error', e => {
      publish.log.push(e.message)
    })
    child.on('close', code => {
      running = null
      publish.endedAt = new Date().toISOString()
      if (code === 0) {
        publish.state = 'done'
        if (published) publish.published = published
        log?.info(`published ${published?.version ?? 'a build'}`)
        // This PC sees it too: Update brings the server onto it.
        void check()
      } else {
        publish.state = 'failed'
        publish.error = publish.log.at(-1) ?? `The publish exited ${code}`
        log?.warn(`publish failed: ${publish.error}`)
      }
    })
    return info()
  }

  /** Does the host that runs differ from the one the newer build ships? (A build without one is a change too: it could not take the chats over.) */
  const hostChanges = (g: ChatHostGate) => {
    // Nothing known of a newer build (Update pressed without one): nothing to compare, nothing changes.
    if (!update.available) return false
    const next = update.available.chatHost
    return !next || next.protocol !== g.protocol || next.version !== g.version
  }

  function go(retire: ChatHostGate | null) {
    if (hostTimer) clearInterval(hostTimer)
    hostTimer = null
    hostWait = null
    // Answer first; then go, and Start.cmd (or the guard) takes it from here.
    void (async () => {
      if (retire) {
        try {
          log?.info('updating: the chat host changes with this build; its chats are saved and ended, and come back resumed')
          await retire.retire()
        } catch (e) {
          log?.warn(`updating: could not retire the chat host: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      setTimeout(() => o.restart(UPDATE_EXIT_CODE), 300).unref()
    })()
  }

  function startUpdate(body?: unknown) {
    if (!update.can) throw apiError(409, update.cannot ?? "This PC can't update itself")
    const g = o.chatHostGate?.current ?? null
    const force = isObject(body) && body.force === true
    if (g && hostChanges(g)) {
      if (!force && g.busy() > 0) {
        // F-075: not while a chat is mid-answer: wait for them to be idle, then ask.
        if (!hostWait) {
          hostWait = { since: Date.now(), ask: false }
          log?.info(`updating: the chat host changes with this build and ${g.busy()} chat(s) are busy; waiting for them to be idle`)
          hostTimer = setInterval(() => {
            const gate = o.chatHostGate?.current
            if (!hostWait || !gate) return
            if (gate.busy() === 0) return go(gate)
            if (!hostWait.ask && Date.now() - hostWait.since >= (o.hostWaitMs ?? 10 * 60_000)) {
              hostWait.ask = true
              log?.info('updating: the chats are still busy after the wait; asking on the Build page')
            }
          }, o.hostPollMs ?? 5000)
          hostTimer.unref()
        }
        return { ...info(), restarting: false }
      }
      go(g)
      return { ...info(), restarting: true }
    }
    log?.info('updating: restarting so Start.cmd pulls the new build')
    go(null)
    return { ...info(), restarting: true }
  }

  function cancelUpdate() {
    if (hostTimer) clearInterval(hostTimer)
    hostTimer = null
    hostWait = null
    return info()
  }

  const first = setTimeout(() => void check(), FIRST_CHECK_MS)
  first.unref()
  const every = setInterval(() => void check(), CHECK_EVERY_MS)
  every.unref()
  void devStatus().catch(() => {})
  // F-026: Dev looked at again every 20 s, so Publish shows once something changes there.
  const devEvery = publish ? setInterval(() => void devStatus().catch(() => {}), DEV_EVERY_MS) : null
  devEvery?.unref()

  const routes: Record<string, (r: MountRequest) => unknown> = {
    // F-119: whether this browser may press Publish rides with the info, for the page that shows the button.
    'GET /info': r => ({ ...info(), mayPublish: mayPublish(r.headers, r.caller) }),
    'POST /check': () => check(),
    'POST /update': r => startUpdate(r.body),
    'POST /update-cancel': () => cancelUpdate(),
    'POST /publish': r => {
      // F-119: from a page, only a browser signed in as sbskrrt; a local tool with the machine token and no page headers is as before.
      if (!mayPublish(r.headers, r.caller)) throw authError(403, 'Only sbskrrt, signed in, publishes from a page.', 'admin-only')
      return startPublish(isObject(r.body) && r.body.skipChecks === true ? { skipChecks: true } : {})
    },
  }

  return {
    requestUpdate: () => startUpdate(),
    busy: () => o.chatHostGate?.current?.busy() ?? 0,
    mount: {
      prefix: '/build',
      async http(r) {
        const run = routes[`${r.method} ${r.rest}`]
        if (!run) throw apiError(404, `No such path: /build${r.rest}`)
        return await run(r)
      },
    },
    info,
    check,
    close() {
      clearTimeout(first)
      clearInterval(every)
      if (hostTimer) clearInterval(hostTimer)
      if (devEvery) clearInterval(devEvery)
      running?.kill()
    },
  }
}
