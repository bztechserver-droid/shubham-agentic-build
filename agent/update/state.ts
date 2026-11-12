import { existsSync, readFileSync } from 'node:fs'
import type { AutoUpdateResult } from '../../shared/approvals.ts'
import { writeAtomic } from '../config.ts'

// F-173a: the automatic update's own record, auto-update-state.json (written only by the coordinator, so there is no second writer).
// `current` is written BEFORE the restart is started; the new agent compares it with the build it runs and settles it into `last`:
//   running === to    -> 'took'          the update happened
//   running === from  -> 'did-not-take'  it restarted on the same build (the pull failed, or it was started again)
//   anything else     -> 'unknown'       never retried because of it
//   a refused commit  -> 'not-started'   nothing restarted
// A 2xx answer or exit code 75 is not an outcome. Only the running build is.

export interface UpdateOp {
  id: string
  from: string
  to: string
  committedAt: string
  consentRevision: number
  consentBy: string
}
export interface SettledOp extends UpdateOp {
  resolvedAt: string
  result: AutoUpdateResult
  /** The build that was running when it was settled. */
  actual: string | null
  note: string
}
export interface UpdateState {
  /** Read afresh each time. */
  read(): { current: UpdateOp | null; last: SettledOp | null }
  /** Writes the operation down. Throws when it can't be written: then nothing is started. */
  begin(op: UpdateOp): void
  /** A commit that was refused or stopped before any restart. */
  abort(note: string): SettledOp | null
  /** At start: settles what the last run left, by the build that runs now. Null when there was nothing. */
  settle(running: string | null): SettledOp | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const s = (v: unknown) => (typeof v === 'string' ? v : '')

function opOf(v: unknown): UpdateOp | null {
  if (!isObj(v) || !s(v.id) || !s(v.from) || !s(v.to) || !s(v.committedAt)) return null
  return { id: v.id as string, from: v.from as string, to: v.to as string, committedAt: v.committedAt as string, consentRevision: typeof v.consentRevision === 'number' ? v.consentRevision : 0, consentBy: s(v.consentBy) }
}
function settledOf(v: unknown): SettledOp | null {
  const op = opOf(v)
  if (!op || !isObj(v) || !s(v.resolvedAt)) return null
  const r = v.result
  if (r !== 'took' && r !== 'did-not-take' && r !== 'unknown' && r !== 'not-started') return null
  return { ...op, resolvedAt: v.resolvedAt as string, result: r, actual: typeof v.actual === 'string' ? v.actual : null, note: s(v.note) }
}

export function createUpdateState(file: string, now: () => Date = () => new Date()): UpdateState {
  const load = (): { current: UpdateOp | null; last: SettledOp | null } => {
    if (!existsSync(file)) return { current: null, last: null }
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return isObj(raw) ? { current: opOf(raw.current), last: settledOf(raw.last) } : { current: null, last: null }
    } catch {
      return { current: null, last: null }
    }
  }
  const save = (v: { current: UpdateOp | null; last: SettledOp | null }) => writeAtomic(file, `${JSON.stringify({ version: 1, ...v }, null, 2)}\n`)
  const settleWith = (current: UpdateOp, result: AutoUpdateResult, actual: string | null, note: string): SettledOp => {
    const done: SettledOp = { ...current, resolvedAt: now().toISOString(), result, actual, note }
    save({ current: null, last: done })
    return done
  }
  return {
    read: load,
    begin(op) {
      const v = load()
      // An unsettled operation is never overwritten silently: it is settled (as unknown) first by the coordinator's start.
      save({ current: op, last: v.last })
    },
    abort(note) {
      const v = load()
      return v.current ? settleWith(v.current, 'not-started', null, note.slice(0, 300)) : null
    },
    settle(running) {
      const v = load()
      if (!v.current) return null
      if (running === v.current.to) return settleWith(v.current, 'took', running, '')
      if (running === v.current.from) return settleWith(v.current, 'did-not-take', running, 'The app restarted on the same build.')
      return settleWith(v.current, 'unknown', running, 'The running build is neither the old one nor the new one.')
    },
  }
}
