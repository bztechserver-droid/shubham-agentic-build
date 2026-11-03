import { freemem } from 'node:os'
import { readFreeCommitMB } from './watchdog.ts'

// F-087: the fast Assistant is one more claude process (about 0.7 GB of commit, about 100-360 MB resident). It must never
// starve the PC, so it is allowed to start, and told to stop, by what is AVAILABLE RAM, not by free commit: the page file is
// system-managed and grows by itself, so free commit sits low all day with RAM fine (Lead and Shubham, 2 Nov 2026).
//   start        at 2.5 GB available or more
//   end first    when available stays under 1.2 GB for 30 s (before any chat of Shubham's is touched)
//   backstop     free commit under 1.0 GB: no start, and an end (only a backstop; the page file grows before this is true)
// An unreadable number never ends a running process and never allows a start.

export const START_MIN_AVAIL_MB = 2500
export const END_BELOW_AVAIL_MB = 1200
export const END_AFTER_MS = 30_000
export const COMMIT_BACKSTOP_MB = 1000

export interface MemSample {
  /** Physical memory available to a new process (free + standby), MB; null when unreadable. */
  availMB: number | null
  /** Commit limit minus committed, MB; null when unreadable. */
  freeCommitMB: number | null
}

export interface GateView {
  startMinAvailMB: number
  endBelowAvailMB: number
  endAfterS: number
  commitBackstopMB: number
  availMB: number | null
  freeCommitMB: number | null
  /** Since when available RAM has been under the end line, as ms since the epoch; null while it is not. */
  lowSince: number | null
  /** Why it may not start right now, as a sentence; null when it may. */
  blocked: string | null
}

export interface MemoryGate {
  /** May the process start now? */
  canStart(s: MemSample): { ok: true } | { ok: false; why: string }
  /** Looks at a sample of a RUNNING process: must it end now (and why)? Keeps the time RAM has been low. */
  check(s: MemSample, now: number): { end: true; why: string } | { end: false }
  /** What watchdog_status shows. */
  view(): GateView
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`

export function createMemoryGate(): MemoryGate {
  let lowSince: number | null = null
  let last: MemSample = { availMB: null, freeCommitMB: null }
  let blocked: string | null = null

  const startVerdict = (s: MemSample): { ok: true } | { ok: false; why: string } => {
    if (s.availMB === null) return { ok: false, why: 'The PC\'s free memory could not be read.' }
    if (s.availMB < START_MIN_AVAIL_MB) return { ok: false, why: `Memory is low: ${gb(s.availMB)} available, ${gb(START_MIN_AVAIL_MB)} are needed to start.` }
    if (s.freeCommitMB !== null && s.freeCommitMB < COMMIT_BACKSTOP_MB) return { ok: false, why: `Memory is low: ${gb(s.freeCommitMB)} of commit is left.` }
    return { ok: true }
  }

  return {
    canStart(s) {
      last = s
      const v = startVerdict(s)
      blocked = v.ok ? null : v.why
      return v
    },
    check(s, now) {
      last = s
      blocked = null
      if (s.availMB !== null && s.availMB < END_BELOW_AVAIL_MB) {
        lowSince ??= now
        if (now - lowSince >= END_AFTER_MS) return { end: true, why: `available memory was under ${gb(END_BELOW_AVAIL_MB)} for ${Math.round((now - lowSince) / 1000)} s` }
      } else {
        lowSince = null
      }
      if (s.freeCommitMB !== null && s.freeCommitMB < COMMIT_BACKSTOP_MB) return { end: true, why: `free commit fell under ${gb(COMMIT_BACKSTOP_MB)}` }
      return { end: false }
    },
    view: () => ({
      startMinAvailMB: START_MIN_AVAIL_MB,
      endBelowAvailMB: END_BELOW_AVAIL_MB,
      endAfterS: END_AFTER_MS / 1000,
      commitBackstopMB: COMMIT_BACKSTOP_MB,
      availMB: last.availMB,
      freeCommitMB: last.freeCommitMB,
      lowSince,
      blocked,
    }),
  }
}

/** The real numbers: available RAM from the OS now (cheap), free commit from Windows (read at most once a minute). */
export async function readMemory(): Promise<MemSample> {
  const availMB = Math.round(freemem() / (1024 * 1024))
  return { availMB: Number.isFinite(availMB) && availMB > 0 ? availMB : null, freeCommitMB: await readFreeCommitMB().catch(() => null) }
}
