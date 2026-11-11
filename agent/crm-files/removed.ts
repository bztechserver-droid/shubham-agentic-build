import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// o6e65 (S6, "Access removed"): which projects the CRM stopped listing for this account. A project the person could open that is no longer in a SUCCESSFUL project listing, twice, at least MIN_GAP_MS
// apart, is "removed": the drive then shows an "Access removed" folder with one folder for it, holding what is still on this PC for it (saves that never reached the CRM, and a README). The entry stays until
// the person dismisses it on the page (dismissing only forgets the entry: nothing is deleted, the saves stay in the spool). If the CRM lists the project again it goes back to its place and the entry goes.
// A failed or EMPTY listing never counts (a CRM that answers nothing for a moment must not make every project vanish).

export const MIN_GAP_MS = 30_000

export interface RemovedProject {
  id: string
  name: string
  /** When it was found removed (ms since 1970). */
  since: number
}

interface State {
  /** Every project the CRM has listed for this account: id -> name, and when last listed. */
  seen: Record<string, { name: string; at: number }>
  removed: Record<string, RemovedProject>
  /** Ids the person dismissed (cleared when the CRM lists the project again). */
  dismissed: string[]
}

export interface RemovedIndex {
  /** A successful, non-empty project listing. Returns the projects that came BACK (listed again after being removed). */
  observe(projects: readonly { id: string; name: string }[]): { returned: string[] }
  /** The projects whose access was removed and that the person has not dismissed. */
  list(): RemovedProject[]
  /** Forgets the entry (nothing else: files and saves stay where they are). */
  dismiss(id: string): boolean
  has(id: string): boolean
}

export interface RemovedOptions {
  /** Where the index is kept across restarts (null: in memory only, tests). */
  file: string | null
  now?: () => number
  minGapMs?: number
  log?: { warn(m: string): void }
}

export function createRemovedIndex(o: RemovedOptions): RemovedIndex {
  const now = o.now ?? Date.now
  const gap = o.minGapMs ?? MIN_GAP_MS
  let st: State = { seen: {}, removed: {}, dismissed: [] }
  /** Projects missing from the last listing(s): when the first miss was. Not kept across restarts (the rule is two listings in one run). */
  const missing = new Map<string, number>()
  try {
    if (o.file && existsSync(o.file)) {
      const j = JSON.parse(readFileSync(o.file, 'utf8')) as Partial<State>
      st = { seen: j.seen && typeof j.seen === 'object' ? j.seen : {}, removed: j.removed && typeof j.removed === 'object' ? j.removed : {}, dismissed: Array.isArray(j.dismissed) ? j.dismissed.filter((x): x is string => typeof x === 'string') : [] }
    }
  } catch (e) {
    o.log?.warn(`crm drive: the list of removed projects could not be read (${e instanceof Error ? e.message : String(e)}); it starts again`)
  }

  const save = () => {
    if (!o.file) return
    try {
      mkdirSync(path.dirname(o.file), { recursive: true })
      const tmp = `${o.file}.tmp`
      writeFileSync(tmp, JSON.stringify(st))
      renameSync(tmp, o.file)
    } catch (e) {
      o.log?.warn(`crm drive: the list of removed projects could not be saved (${e instanceof Error ? e.message : String(e)})`)
    }
  }

  return {
    observe(projects) {
      if (projects.length === 0) return { returned: [] } // an empty listing proves nothing
      const t = now()
      const listed = new Set(projects.map(p => p.id))
      const returned: string[] = []
      let changed = false
      for (const p of projects) {
        const was = st.seen[p.id]
        if (!was || was.name !== p.name || t - was.at > 60_000) {
          st.seen[p.id] = { name: p.name, at: t }
          changed = true
        }
        missing.delete(p.id)
        if (st.removed[p.id]) {
          delete st.removed[p.id]
          returned.push(p.id)
          changed = true
        }
        if (st.dismissed.includes(p.id)) {
          st.dismissed = st.dismissed.filter(x => x !== p.id)
          changed = true
        }
      }
      for (const [id, s] of Object.entries(st.seen)) {
        if (listed.has(id) || st.removed[id]) continue
        const first = missing.get(id)
        if (first === undefined) missing.set(id, t)
        else if (t - first >= gap) {
          st.removed[id] = { id, name: s.name, since: t }
          missing.delete(id)
          changed = true
        }
      }
      if (changed) save()
      return { returned }
    },
    list: () => Object.values(st.removed).filter(p => !st.dismissed.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name)),
    dismiss(id) {
      if (!st.removed[id] || st.dismissed.includes(id)) return false
      st.dismissed.push(id)
      save()
      return true
    },
    has: id => !!st.removed[id] && !st.dismissed.includes(id),
  }
}
