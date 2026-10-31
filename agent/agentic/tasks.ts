import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync } from 'node:fs'
import { TASKS_MAX, TASK_TEXT_MAX, type Task, type TaskBy, type TaskPatch, type TaskStatus } from '../../shared/tasks.ts'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'

// F-056: the task list (the Tasks tab, and the chats' task_add / task_list / task_update).
//
// Everything that reads or writes tasks goes through `TaskStore`, and nothing outside this file
// knows where they are kept. Today it is a JSON file on the hub (<state>/agent/agentic/tasks.json,
// written atomically, a corrupt one set aside, as floors.json is), the hub being the one place all
// of the app's PCs and phones already agree on. A hosted database (a Supabase project: a `tasks`
// table with id uuid, text, done, created_at, updated_at, done_at, deleted_at, by_kind, by_name,
// by_floor) can replace it by implementing this same interface and being chosen where the store
// is made (index.ts); the page and the tools don't change. `onChange` is there for that: a hosted
// store tells its listeners about changes other devices made too.

export interface ListOptions {
  status?: TaskStatus
  /** Only tasks whose text has this (ignoring case). */
  query?: string
  /** At most this many, newest first (default 200, at most 1000). */
  limit?: number
}

export interface TaskStore {
  /** Newest first, never the deleted ones. */
  list(o?: ListOptions): Promise<Task[]>
  /** How many are open and how many are done (not counting the deleted). */
  counts(): Promise<{ open: number; done: number }>
  /** A task by id, a deleted one too (so Undo can find it); null when there is none. */
  get(id: string): Promise<Task | null>
  /** With an `id` already used (by a task, deleted or not), that task comes back as it is and nothing is added. */
  add(input: { text: string; by: TaskBy; id?: string }): Promise<Task>
  /** Changes a task; 404 when there is none. `deleted: true` deletes it, `false` brings it back. */
  update(id: string, patch: TaskPatch): Promise<Task>
  /** Called after every change (made here, or, for a hosted store, anywhere). Returns the way to stop. */
  onChange(listener: () => void): () => void
}

/** How long a deleted task is kept, so that Undo works after a while. */
const KEEP_DELETED_MS = 30 * 24 * 60 * 60 * 1000

const YOU: TaskBy = { kind: 'you', name: null, floor: null }
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const iso = (v: unknown, fallback: string) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fallback)
const isoOrNull = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)

function hydrateBy(v: unknown): TaskBy {
  if (!isObject(v) || v.kind !== 'agent') return YOU
  return { kind: 'agent', name: typeof v.name === 'string' ? v.name.slice(0, 80) : null, floor: typeof v.floor === 'string' ? v.floor.slice(0, 80) : null }
}

function hydrate(raw: unknown): Task | null {
  if (!isObject(raw) || typeof raw.text !== 'string' || !raw.text.trim()) return null
  const now = new Date().toISOString()
  const createdAt = iso(raw.createdAt, now)
  const done = raw.done === true
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : randomUUID(),
    text: raw.text.slice(0, TASK_TEXT_MAX),
    done,
    createdAt,
    updatedAt: iso(raw.updatedAt, createdAt),
    doneAt: done ? (isoOrNull(raw.doneAt) ?? iso(raw.updatedAt, createdAt)) : null,
    deletedAt: isoOrNull(raw.deletedAt),
    by: hydrateBy(raw.by),
  }
}

/** The text of a task as it is stored: trimmed, and not empty or too long. */
export function taskText(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw apiError(400, 'The task has no text')
  const t = v.trim()
  if (t.length > TASK_TEXT_MAX) throw apiError(400, `A task is at most ${TASK_TEXT_MAX} characters`)
  return t
}

/** An id the page made for a new task, checked; undefined when it sent none. */
export function taskId(v: unknown): string | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) throw apiError(400, 'id is 8 to 64 letters, digits, - or _')
  return v
}

/** The change a PATCH asks for, checked. */
export function taskPatch(body: unknown): TaskPatch {
  if (!isObject(body)) throw apiError(400, 'Expected {text?, done?, deleted?}')
  const patch: TaskPatch = {}
  if (body.text !== undefined) patch.text = taskText(body.text)
  for (const k of ['done', 'deleted'] as const) {
    if (body[k] === undefined) continue
    if (typeof body[k] !== 'boolean') throw apiError(400, `${k} is true or false`)
    patch[k] = body[k]
  }
  if (!Object.keys(patch).length) throw apiError(400, 'Nothing to change: give text, done or deleted')
  return patch
}

/** The tasks in a JSON file, kept written. A corrupt file is set aside as .corrupt-<time>, never overwritten. */
export function createFileTaskStore(file: string): TaskStore {
  const listeners = new Set<() => void>()
  /** Newest first; deleted ones included until they are a month old. */
  let tasks: Task[] = load()

  function load(): Task[] {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    try {
      const data: unknown = JSON.parse(text)
      const list = isObject(data) && Array.isArray(data.tasks) ? data.tasks : []
      return sorted(list.map(hydrate).filter((t): t is Task => t !== null))
    } catch {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
      return []
    }
  }

  function sorted(list: Task[]) {
    return list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1))
  }

  function save() {
    const cutoff = Date.now() - KEEP_DELETED_MS
    tasks = tasks.filter(t => !t.deletedAt || Date.parse(t.deletedAt) > cutoff)
    writeAtomic(file, `${JSON.stringify({ tasks }, null, 2)}\n`)
    for (const l of listeners) l()
  }

  const alive = () => tasks.filter(t => !t.deletedAt)

  return {
    async list(o = {}) {
      const q = o.query?.trim().toLowerCase()
      const status = o.status ?? 'all'
      const limit = Math.max(1, Math.min(Math.floor(o.limit ?? 200), 1000))
      return alive()
        .filter(t => (status === 'all' || (status === 'done') === t.done) && (!q || t.text.toLowerCase().includes(q)))
        .slice(0, limit)
        .map(t => ({ ...t }))
    },

    async counts() {
      const live = alive()
      const done = live.filter(t => t.done).length
      return { open: live.length - done, done }
    },

    async get(id) {
      const t = tasks.find(x => x.id === id)
      return t ? { ...t } : null
    },

    async add({ text, by, id }) {
      const t = taskText(text)
      const again = id ? tasks.find(x => x.id === id) : undefined
      if (again) return { ...again }
      if (alive().length >= TASKS_MAX) throw apiError(409, `There are ${TASKS_MAX} tasks already: delete some first`)
      // Never at or before the newest one: two added in one millisecond keep the order they came in.
      const at = Math.max(Date.now(), tasks.length ? Date.parse(tasks[0].createdAt) + 1 : 0)
      const now = new Date(at).toISOString()
      const task: Task = { id: id ?? randomUUID(), text: t, done: false, createdAt: now, updatedAt: now, doneAt: null, deletedAt: null, by }
      tasks.unshift(task)
      save()
      return { ...task }
    },

    async update(id, patch) {
      const task = tasks.find(t => t.id === id)
      if (!task) throw apiError(404, 'No such task')
      const now = new Date().toISOString()
      if (patch.text !== undefined) task.text = taskText(patch.text)
      if (patch.done !== undefined && patch.done !== task.done) {
        task.done = patch.done
        task.doneAt = patch.done ? now : null
      }
      if (patch.deleted !== undefined) task.deletedAt = patch.deleted ? now : null
      task.updatedAt = now
      save()
      return { ...task }
    },

    onChange(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
