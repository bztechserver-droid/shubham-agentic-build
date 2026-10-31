// F-056: the Tasks tab's contract: a list of things to add or do, jotted down as they come, kept
// on the hub so every device and every agent's chat sees the same one. Types only, so the agent
// (agent/agentic/tasks.ts) and the page (src/tasks/) both import it. Served under
// `${AGENT_API_PREFIX}${AGENTIC_PREFIX}`: GET/POST /tasks, PATCH/DELETE /tasks/:id, and the chats'
// tools task_add, task_list and task_update.

/** The longest a task's text may be. */
export const TASK_TEXT_MAX = 2000
/** How many tasks may be on the list at once (open and done; a deleted one doesn't count). */
export const TASKS_MAX = 5000

/** Who put it on the list: the person (from the page), or an agent's chat that was told it. */
export interface TaskBy {
  kind: 'you' | 'agent'
  /** The agent's name, for an agent. */
  name: string | null
  /** And its floor's. */
  floor: string | null
}

export interface Task {
  id: string
  text: string
  done: boolean
  createdAt: string
  updatedAt: string
  /** When it was ticked; null while open. */
  doneAt: string | null
  /** Deleted tasks are kept for a month, so Undo works; no list shows them. */
  deletedAt: string | null
  by: TaskBy
}

export type TaskStatus = 'open' | 'done' | 'all'

/** GET /tasks?status=open|done|all&q=&limit=: newest first, never the deleted ones. */
export interface TasksAnswer {
  tasks: Task[]
  /** How many there are of each (whatever `status` and `q` ask for). */
  counts: { open: number; done: number }
}

/** POST /tasks */
export interface TaskInput {
  text: string
  /**
   * An id the page made (letters, digits, - and _, 8 to 64 long). Sending the same one again
   * answers with the task already made, so a retry after a lost answer can't add it twice.
   */
  id?: string
}

/** PATCH /tasks/:id. `deleted: false` brings a deleted one back (Undo). */
export interface TaskPatch {
  text?: string
  done?: boolean
  deleted?: boolean
}
