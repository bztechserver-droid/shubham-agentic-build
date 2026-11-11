import { assigneesOf, dueDay, isMine, normaliseStatus, rankGoals, type Goal, type Member } from '../../shared/goals.ts'
import { apiError } from '../api.ts'
import { createCrmCall, isObject } from './crm-call.ts'
import { crmPath, describeCatalog, judge } from './crm-catalog.ts'
import { createCrmScopes, type ScopeKind } from './crm-scopes.ts'
import type { CrmProxy } from './crmproxy.ts'

// The read tools of the CRM for the chats of the app's owner: crm_scopes (the boards), crm_board (a board's cards), crm_catalog (what the CRM has)
// and crm_query (read any of it). Like the goal tools they go through the CRM proxy, as the person signed in to the CRM on this PC, and only read
// (GET). What may be read is crm-catalog.ts's rule: a path the CRM does not have, or one that holds passwords, keys or AI costs, is refused before
// anything is sent. Rows come back as the CRM sent them, but any field that looks like a password, token, key or cookie is hidden.

const json = (v: unknown) => JSON.stringify(v, null, 2)
/** Fields whose values are never handed to a chat, wherever they turn up in a row. */
const HIDDEN_KEY = /pass(word|wd)|secret|token|api[-_]?key|cookie|credential|private[-_]?key/i
const MAX_TEXT = 400
const MAX_REPLY = 60_000
const PARAM_KEY = /^[A-Za-z0-9_.-]{1,60}$/

export interface CrmReadsOptions {
  proxy: Pick<CrmProxy, 'request'>
}

function limitOf(v: unknown, def: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : def
}

/** A value for a chat: long text cut, hidden fields hidden, depth bounded. */
function clean(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v
  if (Array.isArray(v)) return depth > 3 ? `[${v.length} items]` : v.slice(0, 50).map(x => clean(x, depth + 1))
  if (isObject(v)) {
    if (depth > 3) return '{…}'
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = HIDDEN_KEY.test(k) ? '[hidden]' : clean(x, depth + 1)
    return out
  }
  return v
}

export function createCrmReads(o: CrmReadsOptions) {
  const crm = createCrmCall({ proxy: o.proxy, afterServerError: 'Look in the CRM before trying again.' })
  const scopes = createCrmScopes({ crm })

  async function me(): Promise<{ id: string; name: string }> {
    const r = await crm<{ user?: { id?: string; fullName?: string; username?: string } }>('GET', 'v1/auth/me')
    if (!r.user?.id) throw apiError(502, 'The CRM did not say who is signed in')
    return { id: r.user.id, name: r.user.fullName ?? r.user.username ?? 'You' }
  }

  return {
    /** The boards a goal can be on: mine, General, the services and the projects (hundreds: `query` narrows them). */
    async scopes(args: Record<string, unknown>): Promise<string> {
      const q = typeof args.query === 'string' ? args.query.trim().slice(0, 100) : ''
      const kind = args.type === undefined ? undefined : (['mine', 'organization', 'service', 'project'] as const).find(k => k === args.type)
      if (args.type !== undefined && !kind) throw apiError(400, 'type must be one of: mine, organization, service, project')
      const limit = limitOf(args.limit, 40, 200)
      const all = await scopes.list(q, kind as ScopeKind | undefined)
      return json({
        count: all.length,
        scopes: all.slice(0, limit),
        ...(all.length > limit ? { note: `Only the first ${limit} are shown; narrow it with query or type.` } : {}),
        howToUse: 'crm_board takes targetType + targetId (or a name); crm_goal_add can put a goal on a service or project board.',
      })
    },

    /** One board's cards in its columns: to do and done (abandoned ones are only counted), as the Goals page sorts them. */
    async board(args: Record<string, unknown>): Promise<string> {
      const type = args.targetType === undefined ? 'mine' : (['mine', 'organization', 'service', 'project'] as const).find(k => k === args.targetType)
      if (!type) throw apiError(400, 'targetType must be one of: mine, organization, service, project')
      const limit = limitOf(args.limit, 30, 100)
      let board: { type: string; id?: string; name: string } = { type, name: type === 'mine' ? 'Mine' : 'General' }
      if (type === 'service' || type === 'project') {
        const hit = await scopes.resolve(type, { id: args.targetId, name: args.name })
        board = { type, id: hit.targetId, name: hit.name }
      } else if (args.targetId !== undefined) {
        throw apiError(400, `${type} has no targetId`)
      }
      const [raw, who, mem] = await Promise.all([
        crm<Goal[] | { goals?: Goal[] }>('GET', 'v1/org/goals'),
        me(),
        crm<{ members?: Member[] }>('GET', 'v1/org/members'),
      ])
      const members = Array.isArray(mem.members) ? mem.members : []
      const goals = (Array.isArray(raw) ? raw : (raw.goals ?? [])).filter(g => !g.isDisabled)
      const here = goals.filter(g => {
        const x = g as Goal & { targetId?: string | null }
        if (type === 'mine') return isMine(g, who.id)
        if (type === 'organization') return g.targetType === 'organization' && !g.projectId
        if (type === 'service') return g.targetType === 'service' && x.targetId === board.id
        return g.projectId === board.id || (g.targetType === 'project' && x.targetId === board.id)
      })
      const card = (g: Goal) => ({
        id: g.id,
        title: g.title,
        priority: g.priority,
        dueDate: dueDay(g.dueDate),
        assignees: assigneesOf(g).map(id => ({ userId: id, name: members.find(m => m.userId === id)?.fullName ?? 'Someone' })),
        page: `goals/${g.id}`,
      })
      const todo = rankGoals(here.filter(g => normaliseStatus(g.status) === 'todo'))
      const done = rankGoals(here.filter(g => normaliseStatus(g.status) === 'done'))
      return json({
        board,
        you: { userId: who.id, name: who.name },
        columns: { todo: todo.slice(0, limit).map(card), done: done.slice(0, limit).map(card) },
        counts: { todo: todo.length, done: done.length, abandoned: here.filter(g => normaliseStatus(g.status) === 'abandoned').length },
        ...(todo.length > limit || done.length > limit ? { note: `Only the first ${limit} of a column are shown; crm_goals can search them.` } : {}),
      })
    },

    /** What the CRM has: its collections, and with `paths` every route of them with whether it may be read or changed from here. */
    async catalog(args: Record<string, unknown>): Promise<string> {
      return json(describeCatalog(args.query ?? args.q, args.paths))
    },

    /** Reads anything the CRM has that may be read: a path from crm_catalog, optional query parameters, the fields to keep and how many rows. */
    async query(args: Record<string, unknown>): Promise<string> {
      const path = crmPath(args.path)
      const verdict = judge('GET', path)
      if (!verdict.ok) throw apiError(verdict.why === 'unknown' ? 404 : 403, verdict.reason)
      const qs = new URLSearchParams()
      if (args.params !== undefined) {
        if (!isObject(args.params)) throw apiError(400, 'params must be an object of query parameters')
        for (const [k, v] of Object.entries(args.params)) {
          if (!PARAM_KEY.test(k)) throw apiError(400, `Query parameter "${k.slice(0, 40)}" is not allowed`)
          if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw apiError(400, `Query parameter "${k}" must be text, a number or true/false`)
          qs.set(k, String(v))
        }
      }
      let fields: string[] | undefined
      if (args.fields !== undefined) {
        if (!Array.isArray(args.fields) || args.fields.length > 40 || args.fields.some(f => typeof f !== 'string' || !f || f.length > 80)) throw apiError(400, 'fields must be a list of field names')
        fields = args.fields as string[]
      }
      const limit = limitOf(args.limit, 25, 200)
      const data = await crm<unknown>('GET', `v1/org${path}${qs.size ? `?${qs}` : ''}`)
      let rows: unknown[]
      let record = false
      let total: number | undefined
      if (Array.isArray(data)) rows = data
      else if (isObject(data)) {
        const listKey = Object.keys(data).find(k => Array.isArray(data[k]))
        if (listKey) {
          rows = data[listKey] as unknown[]
          const pag = isObject(data.pagination) ? data.pagination.total : undefined
          total = typeof data.total === 'number' ? data.total : typeof pag === 'number' ? pag : undefined
        } else {
          rows = [data]
          record = true
        }
      } else rows = data === null || data === undefined ? [] : [data]
      const found = [...new Set(rows.slice(0, 25).flatMap(r => (isObject(r) ? Object.keys(r) : [])))]
      const pick = (r: unknown) => (fields && isObject(r) ? Object.fromEntries(fields.filter(f => f in r).map(f => [f, r[f]])) : r)
      let shown = rows.slice(0, limit).map(r => clean(pick(r)))
      let reply = ''
      const build = () => {
        reply = json({
          path,
          ...(record ? { record: shown[0] } : { rows: shown }),
          ...(record ? {} : { shown: shown.length, total: total ?? rows.length }),
          fields: found,
          ...(fields && fields.some(f => !found.includes(f)) ? { unknownFields: fields.filter(f => !found.includes(f)) } : {}),
          ...(!record && rows.length > shown.length ? { note: `Only ${shown.length} of ${total ?? rows.length} rows are shown: use limit (up to 200), fields, or the CRM's own paging parameters.` } : {}),
        })
      }
      build()
      while (reply.length > MAX_REPLY && shown.length > 1) {
        shown = shown.slice(0, Math.max(1, Math.floor(shown.length / 2)))
        build()
      }
      return reply
    },
  }
}

export type CrmReads = ReturnType<typeof createCrmReads>
