// F-099: the Goals page's types and rules. The goals are the CRM's own (its Goals page, sam-crm-fe, backend GET /v1/org/goals): the page reads them through
// the hub's CRM proxy, with the CRM session this PC holds, so nothing here talks to the network. Pure: how "mine" is told from "everyone's", what is open,
// how a list is ranked, filtered and dated, and what Today's tasks is.

export type GoalStatus = 'todo' | 'done' | 'abandoned'
export type GoalPriority = 'low' | 'medium' | 'high' | 'urgent'

/** A goal as the CRM sends it (the fields the page uses). */
export interface Goal {
  id: string
  parentGoalId: string | null
  title: string
  description: string | null
  status: string
  priority: string
  /** The FIRST assignee; `assigneeIds` has everyone, owner first (absent on an older backend). */
  ownerId: string | null
  assigneeIds?: string[]
  /** 'YYYY-MM-DD', or an ISO time, or null. */
  dueDate: string | null
  targetType?: string | null
  servicePillar?: string | null
  projectId?: string | null
  isDisabled: boolean
  /** When the goal was created (an ISO time; the CRM's goals table has created_at and its list sends every column). Absent: the sort "Date added" puts the goal last. */
  createdAt?: string
  updatedAt?: string
}

/** A task in the CRM's Today bucket (the bucket holds goal ids; its answer keeps the old "task" keys). */
export interface BucketTask {
  id: string
  title: string
  description: string | null
  status: string
  priority: string
  assignedTo: string | null
  assigneeName: string | null
  projectName: string | null
  dueDate: string | null
}

export interface Member {
  userId: string
  fullName: string
  username: string
}

export const STATUS_WORDS: Record<GoalStatus, string> = { todo: 'To do', done: 'Done', abandoned: 'Abandoned' }
export const PRIORITY_WORDS: Record<GoalPriority, string> = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' }

/** A stray old status (in-progress, review) reads as To do, as the CRM does. */
export function normaliseStatus(s: string | null | undefined): GoalStatus {
  return s === 'done' || s === 'abandoned' ? s : 'todo'
}
export function normalisePriority(p: string | null | undefined): GoalPriority {
  return p === 'low' || p === 'high' || p === 'urgent' ? p : 'medium'
}
const RANK: Record<GoalPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

/** Everyone a goal is assigned to, owner first. */
export const assigneesOf = (g: Pick<Goal, 'ownerId' | 'assigneeIds'>): string[] => (g.assigneeIds && g.assigneeIds.length ? g.assigneeIds : g.ownerId ? [g.ownerId] : [])

/** "Mine" is the CRM's own test (its All my goals list): I am among the assignees. `myId` comes from GET /v1/auth/me. */
export const isMine = (g: Pick<Goal, 'ownerId' | 'assigneeIds'>, myId: string | null) => myId !== null && assigneesOf(g).includes(myId)
export const isOpen = (g: Pick<Goal, 'status'>) => normaliseStatus(g.status) === 'todo'

/** The names a goal is assigned to ("Shubham Bhole, Asha"): a person the members list doesn't have is "Someone". */
export function namesOf(g: Pick<Goal, 'ownerId' | 'assigneeIds'>, members: readonly Member[], myId: string | null): string[] {
  return assigneesOf(g).map(id => (id === myId ? 'You' : (members.find(m => m.userId === id)?.fullName ?? 'Someone')))
}

// --- dates ----------------------------------------------------------------------------------------------------------------------

/** "2026-11-03" for this day where the person is (not UTC: a due date is a calendar day). */
export function todayKey(now: number): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The calendar day of a due date, or null. */
export function dueDay(due: string | null | undefined): string | null {
  if (!due) return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(due)
  return m ? m[1] : null
}

const dayNumber = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000)
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later' | 'none'
export function dueState(due: string | null | undefined, today: string): DueState {
  const day = dueDay(due)
  if (!day) return 'none'
  const diff = dayNumber(day) - dayNumber(today)
  return diff < 0 ? 'overdue' : diff === 0 ? 'today' : diff <= 7 ? 'soon' : 'later'
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Overdue · 3 days", "Due today", "Due tomorrow", "Due Fri 7 Nov", "Due 12 Dec 2027", or "No due date". */
export function dueText(due: string | null | undefined, today: string): string {
  const day = dueDay(due)
  if (!day) return 'No due date'
  const diff = dayNumber(day) - dayNumber(today)
  if (diff < 0) return `Overdue · ${-diff} ${diff === -1 ? 'day' : 'days'}`
  if (diff === 0) return 'Due today'
  if (diff === 1) return 'Due tomorrow'
  const [y, m, d] = day.split('-').map(Number)
  const wd = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return diff <= 7 ? `Due ${wd} ${d} ${MONTHS[m - 1]}` : `Due ${d} ${MONTHS[m - 1]}${y === Number(today.slice(0, 4)) ? '' : ` ${y}`}`
}

// --- lists ------------------------------------------------------------------------------------------------------------------------

/** Open goals first, then by priority, then the soonest due date (no date last), then by title. Never changes its input. */
export function rankGoals<T extends Pick<Goal, 'status' | 'priority' | 'dueDate' | 'title'>>(goals: readonly T[]): T[] {
  return [...goals].sort((a, b) => {
    const open = Number(!isOpen(a)) - Number(!isOpen(b))
    if (open) return open
    const p = RANK[normalisePriority(a.priority)] - RANK[normalisePriority(b.priority)]
    if (p) return p
    const da = dueDay(a.dueDate)
    const db = dueDay(b.dueDate)
    if (da !== db) return da === null ? 1 : db === null ? -1 : da < db ? -1 : 1
    return a.title.localeCompare(b.title)
  })
}

export type ShowStatus = 'open' | 'done' | 'all'
export interface Filter {
  search: string
  status: ShowStatus
  /** Only goals assigned to this person (a user id), or null for everyone. */
  owner: string | null
}

export function filterGoals(goals: readonly Goal[], f: Filter): Goal[] {
  const needle = f.search.trim().toLowerCase()
  return goals.filter(g => {
    if (g.isDisabled) return false
    const open = isOpen(g)
    if (f.status === 'open' && !open) return false
    if (f.status === 'done' && normaliseStatus(g.status) !== 'done') return false
    if (f.owner !== null && !assigneesOf(g).includes(f.owner)) return false
    if (needle && !`${g.title} ${g.description ?? ''}`.toLowerCase().includes(needle)) return false
    return true
  })
}

/** My open goals that are due today or earlier and are not already in today's plan (the bucket). */
export function dueTodayOrOverdue(goals: readonly Goal[], myId: string | null, planned: ReadonlySet<string>, today: string): Goal[] {
  return rankGoals(
    goals.filter(g => {
      if (g.isDisabled || !isOpen(g) || !isMine(g, myId) || planned.has(g.id)) return false
      const s = dueState(g.dueDate, today)
      return s === 'overdue' || s === 'today'
    }),
  )
}

/** The people who have goals, for the "everyone" tab's filter: those with at least one, by name. */
export function owners(goals: readonly Goal[], members: readonly Member[]): { id: string; name: string; open: number }[] {
  const count = new Map<string, number>()
  for (const g of goals) {
    if (g.isDisabled) continue
    for (const id of assigneesOf(g)) count.set(id, (count.get(id) ?? 0) + (isOpen(g) ? 1 : 0))
  }
  return [...count].map(([id, open]) => ({ id, name: members.find(m => m.userId === id)?.fullName ?? 'Someone', open })).sort((a, b) => b.open - a.open || a.name.localeCompare(b.name))
}
