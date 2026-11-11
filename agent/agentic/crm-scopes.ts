import { apiError } from '../api.ts'
import { isObject, type createCrmCall } from './crm-call.ts'

// The CRM's boards a goal can be aimed at, read from the CRM itself: "mine" (the signed-in person's own work), the organisation ("General"), each
// service (GET /v1/org/services) and each project (GET /v1/org/projects). A name the person said ("the Feasibility board") becomes the id the CRM
// wants, or is refused when it is not there or is more than one thing: never a guess. The CRM's own scope rule for a goal (sam-crm-be goalsController):
// a service goal is target_type "service" + target_id; a project goal is project_id; General is target_type "organization" with no id.

export type ScopeKind = 'mine' | 'organization' | 'service' | 'project'
export interface Scope {
  targetType: ScopeKind
  targetId?: string
  name: string
  detail?: string
}

export const SCOPE_ID_RE = /^[0-9a-fA-F-]{8,64}$/
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function createCrmScopes(o: { crm: ReturnType<typeof createCrmCall> }) {
  const { crm } = o

  async function services(): Promise<Scope[]> {
    const out: Scope[] = []
    // limit 200 is the CRM's own most; a few pages is every service there will ever be.
    for (let page = 1; page <= 10; page++) {
      const r = await crm<{ services?: unknown[]; pagination?: { totalPages?: number } }>('GET', `v1/org/services?page=${page}&limit=200`)
      for (const s of Array.isArray(r.services) ? r.services : []) {
        if (!isObject(s) || s.isDisabled === true) continue
        const id = text(s.id)
        const name = text(s.name)
        if (id && name) out.push({ targetType: 'service', targetId: id, name })
      }
      if (page >= (r.pagination?.totalPages ?? 1)) break
    }
    return out
  }

  async function projects(search?: string): Promise<Scope[]> {
    const r = await crm<{ projects?: unknown[] }>('GET', `v1/org/projects?limit=1000${search ? `&search=${encodeURIComponent(search)}` : ''}`)
    const out: Scope[] = []
    for (const p of Array.isArray(r.projects) ? r.projects : []) {
      if (!isObject(p) || p.isDisabled === true) continue
      const id = text(p.id)
      const name = text(p.name)
      if (id && name) out.push({ targetType: 'project', targetId: id, name, ...(text(p.code) ? { detail: `code ${text(p.code)}` } : {}) })
    }
    return out
  }

  const fixed = (q: string): Scope[] =>
    [
      { targetType: 'mine', name: 'Mine: the signed-in person\'s own work' },
      { targetType: 'organization', name: 'General: the whole organisation' },
    ].filter(s => !q || s.name.toLowerCase().includes(q) || s.targetType.includes(q)) as Scope[]

  return {
    /** "mine", General, the services and the projects whose name has `q`. */
    async list(qIn: string | undefined, kind?: ScopeKind): Promise<Scope[]> {
      const q = (qIn ?? '').trim().toLowerCase()
      const has = (s: Scope) => !q || s.name.toLowerCase().includes(q) || (s.detail ?? '').toLowerCase().includes(q)
      const out: Scope[] = []
      if (!kind || kind === 'mine' || kind === 'organization') out.push(...fixed(q).filter(s => !kind || s.targetType === kind))
      if (!kind || kind === 'service') out.push(...(await services()).filter(has))
      if (!kind || kind === 'project') out.push(...(await projects(q || undefined)).filter(has))
      return out
    },

    /** One board from an id or a name. The id must be one the CRM lists; the name must be one board's (or exactly one board's whole name). */
    async resolve(kind: 'service' | 'project', ref: { id?: unknown; name?: unknown }): Promise<Scope & { targetId: string }> {
      const id = typeof ref.id === 'string' ? ref.id.trim() : ''
      const name = typeof ref.name === 'string' ? ref.name.trim() : ''
      if (!id && !name) throw apiError(400, `Say which ${kind}: its id from crm_scopes, or its name`)
      if (id && !SCOPE_ID_RE.test(id)) throw apiError(400, `"${id.slice(0, 40)}" is not a ${kind} id: crm_scopes gives it`)
      const all = kind === 'service' ? await services() : await projects(id ? undefined : name)
      if (id) {
        const hit = all.find(s => s.targetId?.toLowerCase() === id.toLowerCase())
        if (!hit) throw apiError(400, `The CRM has no ${kind} with that id: crm_scopes lists them`)
        return hit as Scope & { targetId: string }
      }
      const n = name.toLowerCase()
      const part = all.filter(s => s.name.toLowerCase().includes(n) || (s.detail ?? '').toLowerCase().includes(n))
      if (part.length === 1) return part[0] as Scope & { targetId: string }
      const whole = part.filter(s => s.name.toLowerCase() === n)
      if (whole.length === 1) return whole[0] as Scope & { targetId: string }
      if (!part.length) throw apiError(400, `The CRM has no ${kind} called "${name.slice(0, 60)}": crm_scopes lists them`)
      throw apiError(400, `"${name.slice(0, 60)}" is more than one ${kind} (${part.slice(0, 6).map(s => s.name).join(', ')}): give the id from crm_scopes`)
    },
  }
}
