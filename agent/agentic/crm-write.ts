import { apiError } from '../api.ts'
import { createCrmCall, isObject } from './crm-call.ts'
import { crmPath, judge } from './crm-catalog.ts'
import type { CrmProxy } from './crmproxy.ts'

// crm_write: change something in the REAL CRM that has no tool of its own (a lead, a note, a comment, a project, a SOP, a wiki page...) by POST,
// PATCH or PUT on a route the CRM has (crm-routes.ts), as the person signed in to the CRM on this PC. It is a production write the whole company
// sees, so what it will not do is fixed in crm-catalog.ts and listed in crm_catalog: no delete, no money (ledger, transactions, bank, invoices,
// payments, quotes), no people's access or attendance, nothing that holds passwords or keys. A path the CRM does not have is refused before
// anything is sent; so is an id that is not an id (a name where the CRM wants an id), because a guess would change the wrong record. The same
// POST sent twice within ten minutes is sent once.

const ID_RE = /^[0-9a-fA-F-]{8,64}$/
/** Body keys that name another record: their value must be an id (or null), never a name. */
const ID_KEY = /(_id|Id|_ids|Ids)$/
/** Path parts that are a record's id (":id", ":goalId"...); other parts (":slug", ":entityType") are words. */
const ID_PART = /^:(id|[A-Za-z]*Id)$/
const BODY_MAX = 50_000
const DUPLICATE_MS = 10 * 60_000
const REPLY_MAX = 6_000

export interface CrmWriteOptions {
  proxy: Pick<CrmProxy, 'request'>
  now?: () => number
}

function checkIds(v: unknown, where: string, depth = 0): void {
  if (depth > 6) return
  if (Array.isArray(v)) {
    for (const x of v) checkIds(x, where, depth + 1)
    return
  }
  if (!isObject(v)) return
  for (const [k, x] of Object.entries(v)) {
    if (ID_KEY.test(k)) {
      const list = Array.isArray(x) ? x : [x]
      for (const one of list) {
        if (one === null) continue
        if (typeof one !== 'string' || !ID_RE.test(one)) {
          throw apiError(400, `"${where}${k}" must be an id (crm_members, crm_scopes or crm_query give them), not a name or a guess. Nothing was sent.`)
        }
      }
    }
    checkIds(x, `${where}${k}.`, depth + 1)
  }
}

export function createCrmWrite(o: CrmWriteOptions) {
  const now = o.now ?? Date.now
  const crm = createCrmCall({ proxy: o.proxy, afterServerError: 'Look in the CRM (crm_query) before trying again: it may have gone through.' })
  const recent = new Map<string, { at: number; reply: string }>()

  return {
    async write(args: Record<string, unknown>): Promise<string> {
      const method = typeof args.method === 'string' ? args.method.trim().toUpperCase() : ''
      if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw apiError(400, 'method must be POST (create), PATCH or PUT (change). Reading is crm_query.')
      const path = crmPath(args.path)
      const verdict = judge(method, path)
      if (!verdict.ok) throw apiError(verdict.why === 'unknown' ? 404 : 403, verdict.reason)
      const parts = path.split('/').filter(Boolean)
      verdict.route.segments.forEach((seg, i) => {
        if (ID_PART.test(seg) && !ID_RE.test(parts[i])) throw apiError(400, `"${parts[i].slice(0, 40)}" is not an id: crm_query gives the id of the thing to change. Nothing was sent.`)
      })
      let body: Record<string, unknown> | undefined
      if (args.body !== undefined) {
        if (!isObject(args.body)) throw apiError(400, 'body must be an object of the fields to set')
        if (JSON.stringify(args.body).length > BODY_MAX) throw apiError(400, `body is too big (at most ${BODY_MAX} characters)`)
        checkIds(args.body, '')
        body = args.body
      }
      const t = now()
      for (const [k, v] of recent) if (t - v.at > DUPLICATE_MS) recent.delete(k)
      // A repeated POST would be a second record; a repeated PATCH or PUT only says the same thing again.
      const key = method === 'POST' ? JSON.stringify([method, path, body ?? null]) : null
      const same = key ? recent.get(key) : undefined
      if (same) return JSON.stringify({ note: 'The same thing was sent a moment ago and was not sent again.', first: JSON.parse(same.reply) }, null, 2)
      const made = await crm<unknown>(method, `v1/org${path}`, body ?? {})
      const reply = JSON.stringify(
        {
          done: true,
          method,
          path,
          ...(isObject(made) && typeof made.id === 'string' ? { id: made.id } : {}),
          result: summarise(made),
        },
        null,
        2,
      )
      if (key) recent.set(key, { at: t, reply })
      return reply
    },
  }
}

/** What the CRM answered, shortened: the person wants to know it worked and what the new record is called, not its every column. */
function summarise(v: unknown): unknown {
  const s = JSON.stringify(v ?? null)
  if (s.length <= REPLY_MAX) return stripHidden(v)
  return { note: `The CRM's answer is ${s.length} characters: crm_query reads the record.` }
}

function stripHidden(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return depth > 3 ? `[${v.length} items]` : v.map(x => stripHidden(x, depth + 1))
  if (isObject(v)) {
    if (depth > 3) return '{…}'
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /pass(word|wd)|secret|token|api[-_]?key|cookie|credential|private[-_]?key/i.test(k) ? '[hidden]' : stripHidden(x, depth + 1)]))
  }
  return v
}

export type CrmWrite = ReturnType<typeof createCrmWrite>
