import type { Task, TaskPatch } from './tasks.ts'

// F-056: what the Tasks tab shows is the hub's list with what the page has asked for but the hub
// hasn't confirmed yet laid over it (an "outbox"). Nothing is rolled back by hand: when a request
// is confirmed it leaves the outbox, when the hub refuses it it leaves too, and the view, worked
// out again from the two, is right either way. Pure, so it is tested without a page
// (tasks-model.test.ts); src/tasks/store.ts keeps the state and does the talking.

/** Something the page did that the hub hasn't confirmed. Kept in the browser until it is. */
export type TaskOp =
  /** A new task, with the id the page made for it (so sending it twice is harmless). */
  | { k: 'add'; id: string; text: string; at: string }
  | { k: 'patch'; id: string; patch: TaskPatch; at: string }

export const YOU = { kind: 'you', name: null, floor: null } as const

export interface TasksView {
  /** Newest first; a task added here and not yet confirmed is on top. */
  rows: Task[]
  /** The ids whose latest change hasn't been confirmed by the hub yet. */
  pending: Set<string>
}

/** Newest first, as the hub keeps them (the id breaks a tie the way the hub does). */
export const newer = (a: Task, b: Task) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1)

/**
 * The hub's list with the outbox laid over it, in order. `ghosts` are tasks deleted in this
 * session, kept so that Undo can bring one back before the hub has been asked again.
 * Rows nothing touched are the hub's own objects, so a memoised row skips its render.
 */
export function deriveTasks(server: readonly Task[], ops: readonly TaskOp[], ghosts: ReadonlyMap<string, Task> = new Map()): TasksView {
  const rows = [...server]
  const pending = new Set<string>()
  const at = (id: string) => rows.findIndex(r => r.id === id)

  for (const op of ops) {
    if (op.k === 'add') {
      pending.add(op.id)
      if (at(op.id) >= 0) continue
      rows.unshift({ id: op.id, text: op.text, done: false, createdAt: op.at, updatedAt: op.at, doneAt: null, deletedAt: null, by: { ...YOU } })
      continue
    }

    let i = at(op.id)
    if (i < 0 && op.patch.deleted === false) {
      // Undo of a delete the hub already confirmed: the task goes back where its age puts it.
      const ghost = ghosts.get(op.id)
      if (ghost) {
        const back = { ...ghost, deletedAt: null }
        const before = rows.findIndex(r => newer(back, r) < 0)
        i = before < 0 ? rows.length : before
        rows.splice(i, 0, back)
      }
    }
    if (i < 0) continue
    pending.add(op.id)
    if (op.patch.deleted === true) {
      rows.splice(i, 1)
      continue
    }
    const row = rows[i]
    const next: Task = { ...row, updatedAt: op.at }
    if (op.patch.text !== undefined) next.text = op.patch.text
    if (op.patch.done !== undefined && op.patch.done !== row.done) {
      next.done = op.patch.done
      next.doneAt = op.patch.done ? op.at : null
    }
    rows[i] = next
  }
  return { rows, pending }
}

export function countTasks(rows: readonly Task[]): { open: number; done: number } {
  let done = 0
  for (const r of rows) if (r.done) done++
  return { open: rows.length - done, done }
}

const same = (a: Task, b: Task) => a.updatedAt === b.updatedAt && a.done === b.done && a.text === b.text && a.deletedAt === b.deletedAt

/** A fresh list from the hub, keeping the objects that haven't changed since the last one. */
export function reuseTasks(prev: readonly Task[] | null, next: readonly Task[]): Task[] {
  if (!prev?.length) return [...next]
  const byId = new Map(prev.map(t => [t.id, t]))
  return next.map(t => {
    const p = byId.get(t.id)
    return p && same(p, t) ? p : t
  })
}

/** One task the hub answered with, put into its list: replaced, added where its age puts it, or (deleted) dropped. */
export function upsertTask(list: readonly Task[], task: Task): Task[] {
  const rest = list.filter(t => t.id !== task.id)
  if (task.deletedAt) return rest
  const i = rest.findIndex(r => newer(task, r) < 0)
  return i < 0 ? [...rest, task] : [...rest.slice(0, i), task, ...rest.slice(i)]
}

/** How a request that failed should be treated: kept and tried again, or given up on. */
export function retryable(status: number): boolean {
  // 0: no answer at all (offline, or the app's server is down). 5xx: the hub or the proxy is down.
  // 401 and 403: not something this task did; the next try may find the way open.
  return status === 0 || status >= 500 || status === 408 || status === 425 || status === 429 || status === 401 || status === 403
}
