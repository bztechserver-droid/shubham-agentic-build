import { isMine, normaliseStatus, rankGoals, assigneesOf, dueDay, type Goal, type Member } from '../../shared/goals.ts'
import { apiError } from '../api.ts'
import { CrmNotSignedIn, type CrmProxy } from './crmproxy.ts'

// The CRM's goals as tools for the chats of the app's owner (crm_whoami, crm_members, crm_goals, crm_goal_add, crm_goal_update). They
// replace the scyramp-ai-ship crm_ tools one for one where the CRM Goals page needs them, on the CRM's own routes (sam-crm-be orgRoutes:
// GET/POST /v1/org/goals, PATCH /v1/org/goals/:id, GET /v1/org/members, GET /v1/auth/me), through the CRM proxy that holds this PC's CRM
// sign-in (crmproxy.ts `request`: the session and the CSRF pair are attached there and never seen here). Who a goal is "by" is whoever is
// signed in to the CRM on this PC (the owner). The CRM's own rules stay the CRM's: its answer to a refused change is the answer given back.
//
// The goals' wire format is the CRM's (snake_case; status todo | done | abandoned; priority low | medium | high | urgent; due_date a calendar
// day). The retired statuses (in-progress, review) the old Ship tools offered are not offered; the CRM still folds them into todo if sent.

const STATUSES = ['todo', 'done', 'abandoned'] as const
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
const ID_RE = /^[0-9a-fA-F-]{8,64}$/
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MAX_TITLE = 500
const MAX_DESCRIPTION = 5000
/** The same goal added again within this long, by this server, is the one already added (a retry, a chat repeating itself). */
const DUPLICATE_MS = 10 * 60_000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const json = (v: unknown) => JSON.stringify(v, null, 2)

export interface CrmGoalsOptions {
  proxy: Pick<CrmProxy, 'request' | 'session'>
  now?: () => number
}

interface Person {
  id: string
  name: string
}

function words(v: unknown, what: string, max: number, required: boolean): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw apiError(400, `${what} is missing`)
    return undefined
  }
  if (typeof v !== 'string') throw apiError(400, `${what} must be text`)
  const t = v.trim()
  if (!t) {
    if (required) throw apiError(400, `${what} is empty`)
    return ''
  }
  if (t.length > max) throw apiError(400, `${what} is at most ${max} characters`)
  return t
}

function oneOf<T extends string>(v: unknown, list: readonly T[], what: string): T | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) throw apiError(400, `${what} must be one of: ${list.join(', ')}`)
  return v as T
}

/** A calendar day "2026-11-12" (a real one), or "today" / "tomorrow" in the time of this PC. */
export function dayOf(v: unknown, now: number): string {
  if (typeof v !== 'string') throw apiError(400, 'dueDate must be a day like 2026-11-12, "today" or "tomorrow"')
  const s = v.trim().toLowerCase()
  const p = (n: number) => String(n).padStart(2, '0')
  if (s === 'today' || s === 'tomorrow') {
    const d = new Date(now + (s === 'tomorrow' ? 86_400_000 : 0))
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const m = DAY_RE.exec(s)
  if (!m) throw apiError(400, 'dueDate must be a day like 2026-11-12, "today" or "tomorrow"')
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const real = new Date(Date.UTC(y, mo - 1, d))
  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== mo - 1 || real.getUTCDate() !== d) throw apiError(400, `${s} is not a real day`)
  return s
}

const first = (s: string) => s.trim().toLowerCase()

export function createCrmGoals(o: CrmGoalsOptions) {
  const now = o.now ?? Date.now
  const recent = new Map<string, { id: string; at: number }>()

  /** One call to the CRM; its own words come back when it refuses, and nothing of the session ever does. */
  async function crm<T>(method: string, sub: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await o.proxy.request(method, sub, body === undefined ? {} : { json: body })
    } catch (e) {
      if (e instanceof CrmNotSignedIn) throw apiError(409, 'The CRM is not signed in on this PC: sign in from the CRM page, or Devices. Nothing was changed.')
      if (isObject(e) && typeof e.status === 'number') throw e
      throw apiError(502, "The CRM can't be reached right now. Nothing was changed.")
    }
    const data: unknown = await res.json().catch(() => null)
    if (res.ok) return data as T
    const said = isObject(data) && typeof data.error === 'string' ? data.error : null
    if (res.status === 401) throw apiError(409, 'The CRM sign-in on this PC has ended: sign in again from the CRM page, or Devices. Nothing was changed.')
    if (res.status === 403) throw apiError(403, `The CRM refused: ${said ?? "this person may not do that there"}`)
    if (res.status === 404) throw apiError(404, said ?? 'The CRM does not have that')
    if (res.status === 400 || res.status === 422) throw apiError(400, `The CRM refused: ${said ?? 'it did not accept that'}`)
    throw apiError(502, `The CRM answered ${res.status}${said ? `: ${said}` : ''}. Check the goal on the Goals page before trying again.`)
  }

  async function me(): Promise<Person> {
    const r = await crm<{ user?: { id?: string; fullName?: string; username?: string } }>('GET', 'v1/auth/me')
    if (!r.user?.id) throw apiError(502, 'The CRM did not say who is signed in')
    return { id: r.user.id, name: r.user.fullName ?? r.user.username ?? 'You' }
  }

  async function members(): Promise<Member[]> {
    const r = await crm<{ members?: Member[] }>('GET', 'v1/org/members')
    return Array.isArray(r.members) ? r.members : []
  }

  /** "me", a userId, or a name (whole, or a part that is only one person's): never a guess. */
  function person(token: unknown, who: Person, all: readonly Member[]): string {
    if (typeof token !== 'string' || !token.trim()) throw apiError(400, 'A person must be "me", a name or a userId (crm_members lists them)')
    const t = first(token)
    if (t === 'me' || t === 'myself' || t === who.id.toLowerCase()) return who.id
    const byId = all.find(m => m.userId.toLowerCase() === t)
    if (byId) return byId.userId
    // Anyone whose name or username has these words; only one is that person. More than one is not guessed at, except a whole name that is exactly these words ("Ravi" when there is a "Ravi Kumar" too).
    const part = all.filter(m => first(m.fullName).includes(t) || first(m.username).includes(t))
    if (part.length === 1) return part[0].userId
    const whole = part.filter(m => first(m.fullName) === t)
    if (whole.length === 1) return whole[0].userId
    if (!part.length) throw apiError(400, `Nobody in the CRM is called "${token.trim()}": crm_members lists the people`)
    throw apiError(400, `"${token.trim()}" is more than one person (${part.slice(0, 6).map(m => m.fullName).join(', ')}): say the full name or the userId`)
  }

  async function people(list: unknown, who: Person): Promise<string[]> {
    if (!Array.isArray(list) || list.length > 20) throw apiError(400, 'assignees must be a list of at most 20 people ("me", a name or a userId)')
    if (!list.length) return []
    const all = await members()
    return [...new Set(list.map(x => person(x, who, all)))]
  }

  const named = (g: Pick<Goal, 'ownerId' | 'assigneeIds'>, all: readonly Member[]) =>
    assigneesOf(g).map(id => ({ userId: id, name: all.find(m => m.userId === id)?.fullName ?? 'Someone' }))

  const card = (g: Goal, all: readonly Member[]) => ({
    id: g.id,
    title: g.title,
    status: normaliseStatus(g.status),
    priority: g.priority,
    dueDate: dueDay(g.dueDate),
    assignees: named(g, all),
    ...(g.description ? { description: g.description.length > 300 ? `${g.description.slice(0, 300)}…` : g.description } : {}),
    page: `goals/${g.id}`,
  })

  return {
    /** Who the CRM is signed in as on this PC, from the saved sign-in and (when it is there) the CRM's own answer. */
    async whoami(): Promise<string> {
      const s = o.proxy.session()
      if (!s.signedIn) return json({ signedIn: false, note: 'The CRM is not signed in on this PC. Shubham signs in from the CRM page, or Devices; no tool can.' })
      const who = await me().catch(() => null)
      return json({ signedIn: true, name: s.name, username: s.username, userId: who?.id ?? null, signInEndsAt: s.expiresAt, note: 'Goals you add or change are by this person.' })
    },

    async members(args: Record<string, unknown>): Promise<string> {
      const q = words(args.query, 'query', 100, false)
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 200) : 50
      const all = (await members()).filter(m => !q || `${m.fullName} ${m.username}`.toLowerCase().includes(q.toLowerCase()))
      return json({ count: all.length, members: all.slice(0, limit).map(m => ({ userId: m.userId, name: m.fullName, username: m.username })) })
    },

    /** The organisation's goals the signed-in person may see, open ones by default, ranked as the Goals page ranks them. */
    async list(args: Record<string, unknown>): Promise<string> {
      const status = oneOf(args.status, ['open', 'todo', 'done', 'abandoned', 'all'] as const, 'status') ?? 'open'
      const q = words(args.query, 'query', 200, false)
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 100) : 30
      const [raw, all, who] = await Promise.all([crm<Goal[] | { goals?: Goal[] }>('GET', 'v1/org/goals'), members(), me()])
      let rows = (Array.isArray(raw) ? raw : (raw.goals ?? [])).filter(g => !g.isDisabled)
      let assignee: string | null = null
      if (args.assignee !== undefined) assignee = person(args.assignee, who, all)
      const total = rows.length
      rows = rows.filter(g => {
        const s = normaliseStatus(g.status)
        if (status === 'open' || status === 'todo' ? s !== 'todo' : status !== 'all' && s !== status) return false
        if (assignee && !assigneesOf(g).includes(assignee)) return false
        if (q && !`${g.title} ${g.description ?? ''}`.toLowerCase().includes(q.toLowerCase())) return false
        return true
      })
      const ranked = rankGoals(rows)
      return json({
        you: { userId: who.id, name: who.name },
        matching: ranked.length,
        ofGoals: total,
        mine: ranked.filter(g => isMine(g, who.id)).length,
        goals: ranked.slice(0, limit).map(g => card(g, all)),
        ...(ranked.length > limit ? { note: `Only the first ${limit} are shown; narrow it with query, status or assignee.` } : {}),
      })
    },

    /** A new goal, an organisation goal ("General" on the Goals page), assigned to the signed-in person unless told otherwise. */
    async add(args: Record<string, unknown>): Promise<string> {
      const title = words(args.title, 'title', MAX_TITLE, true)!
      const description = words(args.description, 'description', MAX_DESCRIPTION, false)
      const priority = oneOf(args.priority, PRIORITIES, 'priority') ?? 'medium'
      const status = oneOf(args.status, STATUSES, 'status') ?? 'todo'
      const due = args.dueDate === undefined || args.dueDate === null || (typeof args.dueDate === 'string' && !args.dueDate.trim()) ? null : dayOf(args.dueDate, now())
      let parent: string | undefined
      if (args.parentGoalId !== undefined) {
        if (typeof args.parentGoalId !== 'string' || !ID_RE.test(args.parentGoalId)) throw apiError(400, 'parentGoalId must be a goal id from crm_goals')
        parent = args.parentGoalId
      }
      const who = await me()
      const assignees = args.assignees === undefined ? [who.id] : await people(args.assignees, who)
      // The same goal sent twice in minutes is the one that is there: no second goal in the company's CRM for a retry.
      const key = JSON.stringify([who.id, title.toLowerCase(), assignees, due, parent ?? null])
      const t = now()
      for (const [k, v] of recent) if (t - v.at > DUPLICATE_MS) recent.delete(k)
      const same = recent.get(key)
      if (same) return json({ id: same.id, note: 'That goal was added a moment ago: it is the one on the Goals page.', page: `goals/${same.id}` })
      const body = {
        title,
        ...(description ? { description } : {}),
        status,
        priority,
        due_date: due,
        assignee_ids: assignees,
        target_type: 'organization',
        ...(parent ? { parent_goal_id: parent } : {}),
      }
      const made = await crm<Goal>('POST', 'v1/org/goals', body)
      if (!made || typeof made.id !== 'string') throw apiError(502, 'The CRM answered without the goal. Check the Goals page before adding it again.')
      recent.set(key, { id: made.id, at: t })
      const all = await members().catch(() => [] as Member[])
      return json({ added: made.id, goal: card({ ...made, assigneeIds: made.assigneeIds ?? assignees, dueDate: made.dueDate ?? due }, all), by: who.name })
    },

    /** Changes one goal: only what is sent changes. `abandoned` takes a goal off the board and keeps it; nothing here deletes a goal. */
    async update(args: Record<string, unknown>): Promise<string> {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!ID_RE.test(id)) throw apiError(400, 'id is missing or not a goal id: crm_goals gives it')
      const body: Record<string, unknown> = {}
      const title = words(args.title, 'title', MAX_TITLE, false)
      if (title !== undefined) {
        if (!title) throw apiError(400, 'title cannot be empty')
        body.title = title
      }
      if (args.description !== undefined) body.description = words(args.description, 'description', MAX_DESCRIPTION, false) || null
      const status = oneOf(args.status, STATUSES, 'status')
      if (status) body.status = status
      const priority = oneOf(args.priority, PRIORITIES, 'priority')
      if (priority) body.priority = priority
      if (args.dueDate !== undefined) body.due_date = args.dueDate === null || (typeof args.dueDate === 'string' && !args.dueDate.trim()) ? null : dayOf(args.dueDate, now())
      if (args.assignees !== undefined) body.assignee_ids = await people(args.assignees, await me())
      if (!Object.keys(body).length) throw apiError(400, 'Nothing to change: send at least one of title, description, status, priority, dueDate, assignees')
      const got = await crm<Goal>('PATCH', `v1/org/goals/${id}`, body)
      const all = await members().catch(() => [] as Member[])
      return json({ updated: id, goal: card(got, all) })
    },
  }
}

export type CrmGoals = ReturnType<typeof createCrmGoals>
