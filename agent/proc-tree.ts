import { execFile } from 'node:child_process'

// F-058: ending a process and what it started, by exact PID, without `taskkill /t`.
//
// Why not /t: Windows keeps a process's parent PID after the parent has gone, and hands the
// number out again. taskkill /t walks those numbers without asking when each process started, so
// when a new process takes a number that an old, unrelated process still names as its parent,
// "kill this tree" also ends that old process and everything under it. On 31 Oct 2026 22:06:28 a
// test's cleanup of its own Chrome did that to the app's whole process tree (its Start.cmd restart
// loop, the agent, the RustDesk servers and every chat): see features.html F-058.
//
// What this does instead: one process table with the start time of each process, and a process
// counts as a child only if it started after the parent it names (a real child cannot be older
// than its parent; a process that names a reused number always is). Each is ended by its PID,
// leaves first. When the root has already gone (pty.kill() ended it just before), its children are
// the ones that name its number, started after the root did and before this was asked.

export interface Proc {
  pid: number
  ppid: number
  /** When it started, in ms since the epoch. 0 when Windows doesn't say. */
  created: number
  name: string
}

/** How far a process's start may differ from the start time the caller remembers and still be the same process. */
export const IDENTITY_MS = 10_000
/** After this was asked for, a process that names the root can't be one of its children. */
const GRACE_MS = 1000

export interface Root {
  pid: number
  /** When the root started (or the earliest it can have). */
  created: number
}

/**
 * The processes that really descend from `root`, nearest first. `until` caps when a DIRECT child
 * may have started (the root is gone: anything newer belongs to whatever took its number).
 */
export function descendantsOf(table: readonly Proc[], root: Root, o: { until?: number } = {}): Proc[] {
  const out: Proc[] = []
  const seen = new Set<number>([root.pid])
  let level: { pid: number; created: number }[] = [root]
  let first = true
  while (level.length) {
    const next: { pid: number; created: number }[] = []
    for (const parent of level) {
      for (const p of table) {
        if (p.ppid !== parent.pid || seen.has(p.pid)) continue
        // A child started after its parent. Not older: that one names a number it no longer owns.
        if (p.created === 0 || p.created < parent.created) continue
        if (first && o.until !== undefined && p.created > o.until) continue
        seen.add(p.pid)
        out.push(p)
        next.push({ pid: p.pid, created: p.created })
      }
    }
    level = next
    first = false
  }
  return out
}

export interface KillOptions {
  /** When the root started, as the caller knows it (ms). Tells the root from a process that took its number, and bounds the search when it has already gone. */
  since?: number
  /** The process table; Windows: one PowerShell call. Tests give their own. */
  list?: () => Promise<Proc[]>
  /** Ends one process by PID. */
  kill?: (pid: number) => void
  now?: () => number
  log?: (message: string) => void
}

export interface Killed {
  /** The PIDs ended, leaves first. */
  killed: number[]
  /** Why nothing, or less, was ended. */
  note: string | null
}

const endProcess = (pid: number) => {
  try {
    // On Windows this is TerminateProcess for exactly this PID.
    process.kill(pid, 'SIGKILL')
  } catch {
    // Gone already, or not ours to end.
  }
}

/** Ends `rootPid` and what descends from it (see the top of this file). Never rejects for a process that is already gone. */
export async function killTree(rootPid: number, o: KillOptions = {}): Promise<Killed> {
  const asked = (o.now ?? Date.now)()
  const kill = o.kill ?? endProcess
  const table = await (o.list ?? listProcesses)()
  const root = table.find(p => p.pid === rootPid)
  let victims: Proc[]
  let rootIsOurs = false
  let note: string | null = null
  if (root && (o.since === undefined || Math.abs(root.created - o.since) <= IDENTITY_MS)) {
    // The root, as it was: its whole tree, nearest first.
    rootIsOurs = true
    victims = descendantsOf(table, { pid: rootPid, created: root.created })
  } else if (root) {
    // Something else has this number now. We can't tell its children from ours: end nothing.
    victims = []
    note = `pid ${rootPid} now belongs to another process (${root.name}, started ${new Date(root.created).toISOString()}), not the one started at ${new Date(o.since ?? 0).toISOString()}`
  } else if (o.since !== undefined) {
    // The root has gone (pty.kill() just ended it). Its children name its number, started after it did, before now.
    victims = descendantsOf(table, { pid: rootPid, created: o.since - IDENTITY_MS }, { until: asked + GRACE_MS })
  } else {
    victims = []
    note = `pid ${rootPid} is gone and its start time isn't known, so its children can't be told from other processes`
  }
  const order = [...victims].reverse().map(p => p.pid)
  if (rootIsOurs) order.push(rootPid)
  for (const pid of order) kill(pid)
  if (note) o.log?.(note)
  return { killed: order, note }
}

// ---------------------------------------------------------------------------------------------
// The process table

/** One line per process: pid,ppid,created (ms since the epoch, 0 when unknown),name. */
export function parseTable(text: string): Proc[] {
  const out: Proc[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d+),(\d+),(\d+),(.*)$/.exec(line.trim())
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), created: Number(m[3]), name: m[4] })
  }
  return out
}

const SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2},{3}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }), $_.Name }"

/** Every process with when it started (Windows). */
export function listProcesses(): Promise<Proc[]> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('the process table is read on Windows only'))
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      const table = parseTable(String(stdout))
      if (!table.length) return reject(new Error('the process table came back empty'))
      resolve(table)
    })
  })
}
