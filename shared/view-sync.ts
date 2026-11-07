import type { SavedView } from './views.ts'

export type ViewDeviceKind = 'pc' | 'phone'
export type SyncedView = SavedView & { deviceKind: ViewDeviceKind }
export interface ViewSnapshot {
  ownerId: string
  deviceKind: ViewDeviceKind
  schemaVersion: 1
  exists: boolean
  revision: number
  views: SyncedView[]
  updatedAt: string | null
}
export type ViewOperation = { opId: string; before: SyncedView | null; after: SyncedView | null }
export const sameView = (a: SyncedView | null | undefined, b: SyncedView | null | undefined) => {
  if (!a || !b) return !a && !b
  return a.id === b.id && a.deviceKind === b.deviceKind && a.name === b.name && a.count === b.count && a.layout === b.layout
    && a.slots.length === b.slots.length && a.slots.every((s, i) => s === b.slots[i])
}

/** Replay intentions against the latest acknowledged state, preserving remote order. */
export function rebaseViews(remote: SyncedView[], operations: ViewOperation[]) {
  let views = [...remote]
  const conflicts: ViewOperation[] = []
  const pending: ViewOperation[] = []
  const satisfied = new Set<string>()
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]
    const id = (op.after ?? op.before)?.id
    if (sameView(remote.find(v => v.id === id), op.after)) {
      for (const earlier of operations.slice(0, i + 1)) if ((earlier.after ?? earlier.before)?.id === id) satisfied.add(earlier.opId)
    }
  }
  for (const op of operations) {
    if (satisfied.has(op.opId)) continue
    const id = (op.after ?? op.before)?.id
    const current = views.find(v => v.id === id) ?? null
    if (sameView(current, op.after)) continue // A lost acknowledgement, or both removed.
    if (!sameView(current, op.before)) {
      conflicts.push(op)
      continue
    }
    pending.push(op)
    views = op.after ? (current ? views.map(v => v.id === id ? op.after! : v) : [...views, op.after]) : views.filter(v => v.id !== id)
  }
  return { views, pending, conflicts }
}

export function validSnapshot(raw: unknown, owner: string, kind: ViewDeviceKind): raw is ViewSnapshot {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as ViewSnapshot
  return r.ownerId === owner && r.deviceKind === kind && r.schemaVersion === 1 && typeof r.exists === 'boolean'
    && Number.isInteger(r.revision) && r.revision >= 0 && r.revision <= 2147483647 && r.exists === (r.revision > 0)
    && Array.isArray(r.views) && r.views.length <= 64 && new Set(r.views.map(v => v?.id)).size === r.views.length
    && r.views.every(v => v && v.deviceKind === kind && typeof v.id === 'string' && !!v.id && v.id.length <= 128
      && typeof v.name === 'string' && !!v.name.trim() && v.name.length <= 40 && !/[\r\n]/u.test(v.name)
      && Number.isInteger(v.count) && v.count >= 1 && v.count <= 6 && ['columns', 'grid'].includes(v.layout)
      && Array.isArray(v.slots) && v.slots.length === v.count && v.slots.every(s => s === null || (typeof s === 'string' && s.length <= 64)))
}
