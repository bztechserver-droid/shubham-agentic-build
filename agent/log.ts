import { createWriteStream, mkdirSync, readdirSync, rmSync, type WriteStream } from 'node:fs'
import path from 'node:path'
import { format } from 'node:util'

// The agent's logger: console plus <state>/agent/logs/agent-YYYYMMDD.log, a new file each
// day. dailyFile() also takes hbbs's and hbbr's output (rustdesk-server/logs/).
// Never pass it a secret: the api-token, a private key or a key file's contents.

export type Level = 'debug' | 'info' | 'warn' | 'error'

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  /** The same output, with "scope: " in front of each line. */
  child(scope: string): Logger
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** The PC's own date as in log file names: 20261029. */
export function ymd(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

// Local time, to the millisecond: 2026-10-29 20:15:03.123
function timestamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

export interface DailyFile {
  /** Appends text as is; the first write of a new day opens that day's file. */
  write(text: string): void
  /** The file written to last, or null before the first write. */
  current(): string | null
  /** Done once every line written so far is in its file, the day before's too (just after midnight). */
  close(): Promise<void>
}

/** Appends to <dir>/<prefix>-YYYYMMDD.log and deletes that prefix's files older than keepDays. */
export function dailyFile(dir: string, prefix: string, keepDays = 14): DailyFile {
  let day = ''
  let file: string | null = null
  let stream: WriteStream | null = null
  let failed = false
  // A day's stream is ended when the next day's opens; its last lines may still be on their way. close() waits for them.
  let past: Promise<unknown> = Promise.resolve()
  const finish = (s: WriteStream) => new Promise<void>(resolve => s.end(resolve))

  function open(today: string) {
    if (stream) past = Promise.all([past, finish(stream)])
    day = today
    file = path.join(dir, `${prefix}-${today}.log`)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // Reported by the stream's error below.
    }
    stream = createWriteStream(file, { flags: 'a' })
    // A full disk or a locked file must not take the agent down: say so once, keep the console.
    stream.on('error', e => {
      if (!failed) console.error(`log: cannot write ${file}: ${e.message}`)
      failed = true
    })
    prune(dir, prefix, keepDays)
  }

  return {
    write(text) {
      const today = ymd()
      if (today !== day || !stream) open(today)
      stream?.write(text)
    },
    current: () => file,
    async close() {
      const s = stream
      stream = null
      day = ''
      await Promise.all([past, s && finish(s)])
    },
  }
}

function prune(dir: string, prefix: string, keepDays: number) {
  const cutoff = ymd(new Date(Date.now() - keepDays * 86_400_000))
  const own = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{8})\\.log$`)
  try {
    for (const name of readdirSync(dir)) {
      const m = own.exec(name)
      if (m && m[1] < cutoff) rmSync(path.join(dir, name), { force: true })
    }
  } catch {
    // Pruning is housekeeping; never fail a log line over it.
  }
}

interface Sinks {
  level: Level
  console: boolean
  file: DailyFile | null
}

function make(sinks: Sinks, scope: string): Logger {
  const emit = (level: Level, args: unknown[]) => {
    if (RANK[level] < RANK[sinks.level]) return
    const line = `${timestamp()} ${level.toUpperCase().padEnd(5)} ${scope ? `${scope}: ` : ''}${format(...args)}`
    if (sinks.console) (RANK[level] >= RANK.warn ? console.error : console.log)(line)
    sinks.file?.write(line + '\n')
  }
  return {
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    child: name => make(sinks, scope ? `${scope}/${name}` : name),
  }
}

export interface LogOptions {
  /** Folder for the daily files; none means console only. */
  dir?: string | null
  /** File name prefix; default "agent". */
  prefix?: string
  level?: Level
  console?: boolean
  keepDays?: number
}

/** A logger of its own (tests, tools). The agent itself uses `log`. */
export function createLogger(opts: LogOptions = {}): Logger & { close(): Promise<void> } {
  const sinks: Sinks = {
    level: opts.level ?? 'info',
    console: opts.console ?? true,
    file: opts.dir ? dailyFile(opts.dir, opts.prefix ?? 'agent', opts.keepDays) : null,
  }
  return { ...make(sinks, ''), close: () => sinks.file?.close() ?? Promise.resolve() }
}

const root: Sinks = { level: 'info', console: true, file: null }

/** The agent's logger: console only until initLog() adds the daily file. Modules take `log.child('hbbs')`. */
export const log: Logger = make(root, '')

/** Starts the daily file in `dir` (<state>/agent/logs). Calling it again moves it. */
export function initLog(opts: { dir: string; level?: Level; console?: boolean; keepDays?: number }): void {
  void root.file?.close()
  root.file = dailyFile(opts.dir, 'agent', opts.keepDays)
  root.level = opts.level ?? root.level
  root.console = opts.console ?? root.console
}

/** Flushes and closes the daily file; the console keeps working. */
export function closeLog(): Promise<void> {
  const file = root.file
  root.file = null
  return file?.close() ?? Promise.resolve()
}
