import { existsSync, readFileSync } from 'node:fs'
import type { AutoUpdateStatus } from '../../shared/approvals.ts'
import { writeAtomic } from '../config.ts'

// F-081 / F-173a: the switch "Apply new builds automatically when quiet", kept in one small JSON file in the hub's agent state
// folder (auto-update.json). The AGENT writes it (and only through the admin route): `autoApplyWhenQuiet` and, since F-173a, the
// `consent` record (who, their person id, when, a revision that grows with every change). The update itself is decided by the app's
// own coordinator (agent/update/), which keeps its own state in auto-update-state.json; night-watch no longer writes here.
// Each side reads the whole file, changes its own fields and writes it back whole and atomically, keeping every field it doesn't know.
// Off to start with, a file that can't be read is off (the safe state), and an old `true` WITHOUT a consent record is off: it
// was never a recorded choice of a signed-in administrator (F-173a).

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

type Consent = NonNullable<AutoUpdateStatus['consent']>

function consentOf(raw: Record<string, unknown>): Consent | null {
  const c = raw.consent
  if (!isObj(c) || typeof c.at !== 'string' || typeof c.revision !== 'number' || !Number.isInteger(c.revision) || c.revision < 1) return null
  return { by: str(c.by), personId: typeof c.personId === 'string' ? c.personId : null, at: c.at, revision: c.revision }
}

function status(raw: Record<string, unknown>): AutoUpdateStatus {
  const a = isObj(raw.lastApplied) ? raw.lastApplied : null
  const s = isObj(raw.lastSkipped) ? raw.lastSkipped : null
  const consent = consentOf(raw)
  return {
    // Only a recorded choice counts: the flag AND a consent with a revision.
    on: raw.autoApplyWhenQuiet === true && consent !== null,
    changedAt: typeof raw.changedAt === 'string' ? raw.changedAt : null,
    changedBy: str(raw.changedBy),
    consent,
    lastApplied: a && typeof a.at === 'string' ? { at: a.at, from: str(a.from), to: str(a.to), note: str(a.note) } : null,
    lastSkipped: s && typeof s.at === 'string' ? { at: s.at, why: str(s.why) } : null,
  }
}

export interface AutoUpdate {
  /** Read afresh each time. */
  read(): AutoUpdateStatus
  /** Turns it on or off, recording who (their name, and their person id) and when; every other field in the file stays. */
  set(on: boolean, by: string, personId?: string | null): AutoUpdateStatus
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
    set(on, by, personId = null) {
      const raw = load()
      const at = now().toISOString()
      const revision = (consentOf(raw)?.revision ?? 0) + 1
      raw.autoApplyWhenQuiet = on
      raw.changedAt = at
      raw.changedBy = by.slice(0, 300)
      raw.consent = { by: by.slice(0, 300), personId, at, revision }
      writeAtomic(file, `${JSON.stringify(raw, null, 2)}\n`)
      return status(raw)
    },
  }
}
