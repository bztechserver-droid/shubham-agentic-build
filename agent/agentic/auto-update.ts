import { existsSync, readFileSync } from 'node:fs'
import type { AutoUpdateStatus } from '../../shared/approvals.ts'
import { writeAtomic } from '../config.ts'

// F-081: the switch "Apply new builds automatically when quiet", kept in one small JSON file on the hub's agent state folder
// (auto-update.json), which the guard's night-watch reads: this agent writes `autoApplyWhenQuiet` (only ever turned on after
// a registered approval device signed it); the guard writes `lastApplied` and `lastSkipped`. Each side reads the whole file,
// changes its own fields and writes it back whole and atomically, keeping every field it doesn't know. The page shows the
// last two in the overlay. Off to start with, and a file that can't be read is off (the safe state).

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

function status(raw: Record<string, unknown>): AutoUpdateStatus {
  const a = isObj(raw.lastApplied) ? raw.lastApplied : null
  const s = isObj(raw.lastSkipped) ? raw.lastSkipped : null
  return {
    on: raw.autoApplyWhenQuiet === true,
    changedAt: typeof raw.changedAt === 'string' ? raw.changedAt : null,
    changedBy: str(raw.changedBy),
    lastApplied: a && typeof a.at === 'string' ? { at: a.at, from: str(a.from), to: str(a.to), note: str(a.note) } : null,
    lastSkipped: s && typeof s.at === 'string' ? { at: s.at, why: str(s.why) } : null,
  }
}

export interface AutoUpdate {
  /** Read afresh each time: the guard changes the file too. */
  read(): AutoUpdateStatus
  /** Turns it on or off, noting who and when; every other field in the file stays. */
  set(on: boolean, by: string): AutoUpdateStatus
}

export function createAutoUpdate(file: string, now: () => Date = () => new Date()): AutoUpdate {
  const load = (): Record<string, unknown> => {
    if (!existsSync(file)) return {}
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return isObj(raw) ? raw : {}
    } catch {
      return {}
    }
  }
  return {
    read: () => status(load()),
    set(on, by) {
      const raw = load()
      raw.autoApplyWhenQuiet = on
      raw.changedAt = now().toISOString()
      raw.changedBy = by.slice(0, 300)
      writeAtomic(file, `${JSON.stringify(raw, null, 2)}\n`)
      return status(raw)
    },
  }
}
