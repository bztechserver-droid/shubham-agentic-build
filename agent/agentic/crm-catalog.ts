import { apiError } from '../api.ts'
import { CRM_ROUTES, CRM_ROUTES_FROM } from './crm-routes.ts'

// What the CRM has and which of it the chats' crm_ tools may touch: the CRM's own /v1/org routes (crm-routes.ts, generated from its route file),
// each with a rule. A path the CRM does not have is refused before anything is sent. A path it has is read freely, except where it holds
// passwords, keys or what the AI costs; changed only by POST, PATCH or PUT and only where it is not money, people's access or deletion, which
// are Shubham's to decide (they are listed, not built). The rules live here, not in the generated list, so they can change without it.

export interface CrmRoute {
  method: string
  pattern: string
  segments: string[]
  collection: string
}

const SEGMENT_RE = /^[\p{L}\p{N}._~@-]{1,200}$/u

const ROUTES: readonly CrmRoute[] = CRM_ROUTES.map(r => {
  const [method, pattern] = r.split(' ')
  const segments = pattern.split('/').filter(Boolean)
  return { method, pattern, segments, collection: segments[0] ?? '' }
})

/** Money: ledger, transactions, bank, invoices, payments, quotes, wherever they sit in a path (also under a service, project or lead). Never changed from here. */
const MONEY = /^(ledger|transactions|recurring-transactions|bank-statements|bank-accounts|invoices|invoice-builders|invoice-templates|payments|pillar-pay|scopes-of-work)$/
/** Read nowhere: they hold plain-text passwords, a Drive token or what the AI costs (the old tools also kept the usage and model parts away). */
const NOT_READ = new Set(['email-accounts', 'vercel-accounts', 'ai', 'upload', 'christopher-usage', 'claude-subscriptions', 'model-settings', 'claude-access'])
/** Who may do what in the CRM, and attendance: not changed from here. */
const NOT_CHANGED = new Set(['members', 'users', 'hierarchy-access', 'user-hierarchy', 'join', 'claude-access', 'model-settings', 'attendance', 'claude-subscriptions', 'christopher-usage', 'christopher-builds'])

export type Why = 'delete' | 'money' | 'people' | 'secret' | 'unknown'
export type Verdict = { ok: true; route: CrmRoute; kind: 'read' | 'write' } | { ok: false; route: CrmRoute | null; why: Why; reason: string }

const REASON: Record<Why, string> = {
  delete: "Deleting is not offered here (it can't be undone): Shubham decides that. To take a goal off the board use crm_goal_update with status abandoned.",
  money: 'Money records (ledger, transactions, bank, invoices, quotes) are only read from here, never changed: Shubham has not decided that.',
  people: "People, their access and attendance are not changed from here: that is Shubham's to do in the CRM, or to decide.",
  secret: 'That part of the CRM holds passwords, keys or what the AI costs, so it is not read from here.',
  unknown: 'The CRM has no such route (crm_catalog lists them).',
}

const isMeRoute = (r: CrmRoute) => r.segments[1] === 'me'

/** "goals/<id>", "/goals/<id>" or "v1/org/goals/<id>": the path under /v1/org, each part checked, or a refusal. */
export function crmPath(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw apiError(400, 'path is missing (crm_catalog lists them)')
  const parts = input
    .trim()
    .replace(/^\/+/, '')
    .replace(/^v1\/org(\/|$)/, '')
    .split('/')
    .filter(p => p !== '')
  if (!parts.length || parts.length > 8) throw apiError(400, 'path is not a CRM path (crm_catalog lists them)')
  for (const p of parts) if (!SEGMENT_RE.test(p) || p === '.' || p === '..') throw apiError(400, `path has a part that is not allowed: "${p.slice(0, 40)}"`)
  return `/${parts.join('/')}`
}

/** The route of the CRM this method and path is, the most specific one (a fixed word before ":id"). */
export function findRoute(method: string, path: string): CrmRoute | null {
  const parts = path.split('/').filter(Boolean)
  let best: CrmRoute | null = null
  let bestParams = Infinity
  for (const r of ROUTES) {
    if (r.method !== method || r.segments.length !== parts.length) continue
    let params = 0
    let same = true
    for (let i = 0; i < parts.length; i++) {
      if (r.segments[i].startsWith(':')) params++
      else if (r.segments[i] !== parts[i]) {
        same = false
        break
      }
    }
    if (same && params < bestParams) {
      best = r
      bestParams = params
    }
  }
  return best
}

export function judge(methodIn: string, path: string): Verdict {
  const method = methodIn.toUpperCase()
  const route = findRoute(method, path)
  if (!route) return { ok: false, route: null, why: 'unknown', reason: REASON.unknown }
  const no = (why: Why): Verdict => ({ ok: false, route, why, reason: REASON[why] })
  if (method === 'GET') {
    if (NOT_READ.has(route.collection) && !isMeRoute(route)) return no('secret')
    return { ok: true, route, kind: 'read' }
  }
  if (method === 'DELETE') return no('delete')
  if (route.segments.some(s => MONEY.test(s))) return no('money')
  if (NOT_READ.has(route.collection) && !isMeRoute(route)) return no('secret')
  if (NOT_CHANGED.has(route.collection) || route.collection === '') return no('people')
  return { ok: true, route, kind: 'write' }
}

function groups() {
  const by = new Map<string, CrmRoute[]>()
  for (const r of ROUTES) {
    const name = r.collection || '(organisation)'
    const list = by.get(name) ?? []
    list.push(r)
    by.set(name, list)
  }
  return by
}

/** What the CRM has, narrowed by a word in the collection name; every route of each when `paths`. */
export function describeCatalog(q: unknown, paths: unknown) {
  const needle = typeof q === 'string' ? q.trim().toLowerCase() : ''
  const all = groups()
  const out: { collection: string; read: number; change: number; notOffered: number; routes?: string[] }[] = []
  for (const [collection, routes] of all) {
    if (needle && !collection.toLowerCase().includes(needle)) continue
    let read = 0
    let change = 0
    let notOffered = 0
    const lines: string[] = []
    for (const r of routes) {
      const v = judge(r.method, r.pattern)
      if (!v.ok) notOffered++
      else if (v.kind === 'read') read++
      else change++
      lines.push(`${r.method} ${r.pattern} - ${v.ok ? v.kind : `not offered (${v.why})`}`)
    }
    out.push({ collection, read, change, notOffered, ...(paths === true ? { routes: lines } : {}) })
  }
  return {
    from: { ...CRM_ROUTES_FROM, routes: ROUTES.length },
    collections: out,
    ...(out.length ? {} : { note: 'No collection has that in its name.' }),
    howTo:
      'crm_query takes a read path (GET); crm_write takes a change path (POST, PATCH or PUT). Paths are under /v1/org without that prefix, e.g. "leads" or "goals/<id>/comments"; ":id" is the thing\'s id (never a name). Most lists page with { page, limit } (limit up to 200; the reply says the total); projects pages with { limit, offset }.',
    notOffered: { delete: 'any delete', money: 'ledger, transactions, recurring transactions, bank statements and accounts, invoices, invoice builders, scopes of work: read only', people: 'members, users, access, attendance: read only', secret: 'email accounts, Vercel accounts, AI, upload, usage and subscription costs, model settings: not read at all' },
  }
}
