import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { writeAtomic } from '../config.ts'
import type { Logger } from '../log.ts'
import { IDENTITY_MS, killTree, listProcesses, type Proc } from '../proc-tree.ts'
import { clean, message } from './engine.ts'
import type { WorkerEvent, WorkerOp, WorkerReply, WorkerRequest } from './protocol.ts'

// F-079: the hub's side of the WhatsApp process (worker.ts): it starts it, asks it things, and ends it.
// Ending is gentle first: the worker closes Chrome itself (so the login is written out) and exits. Only if it
// doesn't, its exact PID is ended with the processes that really descend from it (proc-tree.ts: by start time,
// never `taskkill /t`, never by name). The PIDs and start times are noted in a small file while it runs, so a
// crash of the app can't leave Chrome holding the login: the next start ends exactly those, if they are still
// the same processes.

export interface HostOptions {
  /** worker.ts. */
  script: string
  /** Its settings (SAD_WA_*); it gets only these and the few Windows variables a program needs. */
  env: Record<string, string>
  /** Where the running worker and its Chrome are noted. */
  pidFile: string
  log: Logger
  on(e: WorkerEvent): void
  /** The worker ended: 0 when it was asked to, else its code (null: it was ended). */
  onExit?(code: number | null): void
  /** How long a question may take (default 60 s). */
  requestMs?: number
  /** How long the worker has to close Chrome and end before it is ended (default 25 s). */
  quitMs?: number
  /** Tests: the process table, and how one PID is ended. */
  list?: () => Promise<Proc[]>
  kill?: (pid: number) => void
  now?: () => number
}

export interface Host {
  running(): boolean
  /** Starts the worker if it isn't running; resolves once it listens. */
  spawn(): Promise<void>
  call<T>(op: WorkerOp, args?: Record<string, unknown>, ms?: number): Promise<T>
  /** Ends the worker: it closes Chrome (the login is kept) and exits; past quitMs its exact PIDs are ended. */
  quit(): Promise<void>
  pids(): { worker: number | null; chrome: number | null }
  /** Ends what an earlier run left (the pid file), by exact PID and start time. */
  sweep(): Promise<void>
}

interface Noted {
  pid: number
  created: number
}
interface PidFile {
  worker: Noted | null
  chrome: Noted | null
}

/** What a Windows program needs from the environment; nothing of the app's own (no tokens). */
const KEEP_ENV = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)',
  'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'PUBLIC',
]

export function workerEnv(extra: Record<string, string>, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(from)) if (v !== undefined && KEEP_ENV.some(x => x.toLowerCase() === k.toLowerCase())) out[k] = v
  return { ...out, ...extra }
}

const NAMES = { worker: /^node(\.exe)?$/i, chrome: /^(chrome|msedge)(\.exe)?$/i }

export function createHost(o: HostOptions): Host {
  const now = o.now ?? Date.now
  const list = o.list ?? listProcesses
  let child: ChildProcess | null = null
  let worker: Noted | null = null
  let chrome: Noted | null = null
  let seq = 0
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  let listening: { resolve(): void; reject(e: Error): void } | null = null
  /** The running worker's "it listens" (one per run, shared by every caller). */
  let up: Promise<void> | null = null
  let exited: Promise<void> | null = null

  const save = () => {
    try {
      if (worker || chrome) writeAtomic(o.pidFile, `${JSON.stringify({ worker, chrome } satisfies PidFile)}\n`)
      else rmSync(o.pidFile, { force: true })
    } catch (e) {
      o.log.warn(`could not note the WhatsApp process: ${message(e)}`)
    }
  }

  /** Ends `n` and what really descends from it, if that PID is still the process noted (its name and start time). */
  async function end(n: Noted, kind: keyof typeof NAMES): Promise<void> {
    try {
      const table = await list()
      const p = table.find(x => x.pid === n.pid)
      if (p && (!NAMES[kind].test(p.name) || Math.abs(p.created - n.created) > IDENTITY_MS)) return // another process has that number now
      const r = await killTree(n.pid, { since: n.created, list: async () => table, kill: o.kill })
      if (r.killed.length) o.log.info(`ended the WhatsApp ${kind === 'chrome' ? 'Chrome' : 'process'} by PID (${r.killed.length} process${r.killed.length === 1 ? '' : 'es'})`)
    } catch (e) {
      o.log.warn(`could not end the WhatsApp ${kind}: ${message(e)}`)
    }
  }

  async function noteChrome(pid: number | null) {
    if (pid === null) {
      chrome = null
      save()
      return
    }
    try {
      const p = (await list()).find(x => x.pid === pid)
      chrome = p && p.created ? { pid, created: p.created } : { pid, created: now() }
    } catch {
      chrome = { pid, created: now() }
    }
    save()
  }

  function onMessage(raw: unknown) {
    const m = raw as Partial<WorkerReply & WorkerEvent> & Record<string, unknown>
    if (typeof m.id === 'number' && typeof m.ok === 'boolean') {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      const r = m as WorkerReply
      if (r.ok) p.resolve(r.result)
      else p.reject(Object.assign(new Error(r.error), r.status ? { status: r.status } : {}))
      return
    }
    const e = m as WorkerEvent
    if (e.t === 'status' && listening) {
      listening.resolve()
      listening = null
    }
    if (e.t === 'chrome') void noteChrome(e.pid)
    o.on(e)
  }

  function spawn(): Promise<void> {
    if (child && up) return up
    const created = now()
    const c = fork(o.script, [], {
      env: workerEnv(o.env),
      // None of the agent's own switches (or a test runner's): the worker is plain Node running a .ts file.
      execArgv: [],
      // Not in the agent's kill-on-exit job (libuv puts every child that isn't detached in one): if the agent ends
      // first, the worker still closes Chrome properly (on 'disconnect') before it ends, so the login is never cut
      // off mid-write. Chrome itself stays in the worker's job, so it can't outlive the worker.
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
      windowsHide: true,
    })
    child = c
    worker = typeof c.pid === 'number' ? { pid: c.pid, created } : null
    save()
    let buf = ''
    c.stderr?.setEncoding('utf8')
    c.stderr?.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        // The worker cleans its own lines; this cleans again, so nothing it says can carry a number or an id.
        if (line) o.log.info(clean(line))
      }
      if (buf.length > 4000) buf = ''
    })
    // What it says counts only while it is the running worker. On a busy PC its last words (its "off" as it leaves, even
    // its answer to quit) can still be in the pipe when its end is seen; heard after that, they would undo what the hub
    // has said since (why it closed) or speak for the next worker.
    c.on('message', m => {
      if (child === c) onMessage(m)
    })
    exited = new Promise<void>(resolve => {
      c.once('exit', code => {
        child = null
        up = null
        const left = chrome
        worker = null
        chrome = null
        for (const p of pending.values()) p.reject(Object.assign(new Error('WhatsApp stopped.'), { status: 503 }))
        pending.clear()
        if (listening) {
          listening.reject(new Error(`the WhatsApp process ended at once (code ${code})`))
          listening = null
        }
        // A worker that didn't end the normal way may have left its Chrome: end exactly that one.
        void (code === 0 || !left ? Promise.resolve() : end(left, 'chrome')).then(() => {
          save()
          o.onExit?.(code)
          resolve()
        })
      })
    })
    c.on('error', e => o.log.warn(`the WhatsApp process: ${message(e)}`))
    const startMs = o.requestMs ?? 60_000
    up = new Promise<void>((resolve, reject) => {
      listening = { resolve, reject }
      setTimeout(() => {
        if (!listening) return
        listening = null
        reject(new Error('the WhatsApp process did not start'))
        // Alive but silent: end exactly it (and what it started).
        const w = worker
        if (w && child === c) void end(w, 'worker')
      }, startMs).unref()
    })
    // A caller that stops waiting must not leave an unhandled rejection behind.
    up.catch(() => undefined)
    return up
  }

  function call<T>(op: WorkerOp, args?: Record<string, unknown>, ms = o.requestMs ?? 60_000): Promise<T> {
    const c = child
    if (!c || !c.connected) return Promise.reject(Object.assign(new Error('WhatsApp is not open.'), { status: 409 }))
    const id = ++seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(Object.assign(new Error('WhatsApp did not answer in time.'), { status: 504 }))
      }, ms)
      timer.unref()
      pending.set(id, {
        resolve: v => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: e => {
          clearTimeout(timer)
          reject(e)
        },
      })
      c.send({ id, op, ...(args ? { args } : {}) } satisfies WorkerRequest)
    })
  }

  async function quit(): Promise<void> {
    const c = child
    if (!c) return
    const done = exited
    const quitMs = o.quitMs ?? 25_000
    // Its end can be seen before its answer: that is it quitting, not a failure.
    await call('quit', undefined, quitMs).catch(e => {
      if (child === c) o.log.warn(`closing WhatsApp: ${message(e)}`)
    })
    const ended = await Promise.race([done?.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 5000).unref())])
    if (ended) return
    // It didn't end by itself: its exact PID, and what descends from it (its Chrome).
    const w = worker
    if (w) await end(w, 'worker')
    await Promise.race([done, new Promise(r => setTimeout(r, 5000).unref())])
  }

  async function sweep(): Promise<void> {
    if (child || !existsSync(o.pidFile)) return
    let left: PidFile | null = null
    try {
      left = JSON.parse(readFileSync(o.pidFile, 'utf8')) as PidFile
    } catch {
      left = null
    }
    const ok = (n: unknown): n is Noted => typeof n === 'object' && n !== null && typeof (n as Noted).pid === 'number' && typeof (n as Noted).created === 'number'
    if (left && ok(left.chrome)) await end(left.chrome, 'chrome')
    if (left && ok(left.worker)) await end(left.worker, 'worker')
    rmSync(o.pidFile, { force: true })
  }

  return {
    running: () => child !== null,
    spawn,
    call,
    quit,
    pids: () => ({ worker: worker?.pid ?? null, chrome: chrome?.pid ?? null }),
    sweep,
  }
}
