import { closeSync, openSync, readSync, statSync } from 'node:fs'
import path from 'node:path'

// F-058: did the agent say it was stopping to update? Update now makes it log
// `stopping: updating to the newer build` and leave with exit code 75, which the guard that started
// it sees. Two cases leave no code to read: an agent this guard did not start (the old Start.cmd's,
// which a new guard adopts, or one that outlived the guard before it), and one that hangs on its way
// out and has to be ended. For both, the agent's own log says what it meant to do.

/** The exit code that means "update, then start again". */
export const UPDATE_CODE = 75

const LINE = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3}) +INFO +stopping: updating to the newer build\s*$/gm
const TAIL_BYTES = 64 * 1024
const SLACK_MS = 2000

/** The time (ms) of the last such line in `text`, the log's local time, or null. */
export function lastUpdateLine(text: string): number | null {
  let at: number | null = null
  for (const m of text.matchAll(LINE)) at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])).getTime()
  return at
}

function tailOf(file: string): string {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const size = statSync(file).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
const dayStamp = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/**
 * 75 when the agent's log says it began to stop for an update at or after `since` (when the process
 * being asked about started, ms; null: in the last ten minutes), else null. The log is
 * <logsDir>/<prefix>-YYYYMMDD.log, today's and, across midnight, yesterday's.
 */
export function updateIntent(logsDir: string, since: number | null, now: number = Date.now(), prefix = 'agent'): number | null {
  const from = (since ?? now - 10 * 60_000) - SLACK_MS
  for (const day of new Set([dayStamp(now), dayStamp(from)])) {
    const at = lastUpdateLine(tailOf(path.join(logsDir, `${prefix}-${day}.log`)))
    if (at !== null && at >= from && at <= now + SLACK_MS) return UPDATE_CODE
  }
  return null
}
