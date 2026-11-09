import {
  SBSKRRT_ID,
  chatRights,
  scopeFloors,
  type AuthPerson,
  type AuthScope,
  type ChatAccess,
  type ChatCan,
  type ChatOwner,
} from '../../shared/auth.ts'
import type { Floor, FloorAgent } from '../../shared/agentic.ts'
import type { Auth } from '../auth/index.ts'
import { authError, OPEN, type Caller } from '../auth/types.ts'

// F-118: who may do what with a chat, a floor and the PC's own pages. ONE place: the routes, the
// sockets and the chats' tools all ask here. The rule: a person (or the open app, where nobody has
// to sign in) is `owner` of their own chats, `type` or `view` on those shared with them, everything
// for sbskrrt (the admins), nothing on the rest. A route that is not in POLICY is for the owner of
// the app only (fail closed); the test in access.test.ts keeps POLICY and the route table equal.

/** What sbskrrt is as an owner of chats: the migration's owner, and the owner of what the open app (nobody signed in) makes. */
export const SBSKRRT_OWNER: ChatOwner = { id: SBSKRRT_ID, username: 'sbskrrt', name: 'Shubham Bhole' }

export type Need = 'view' | 'type' | 'owner'

export type Rule =
  /** The PC's own pages and settings: the owner of the app only (and the open app). */
  | { kind: 'owner' }
  /** Anyone past the sign-in gate; the answer is filtered for them inside. */
  | { kind: 'signed' }
  /** Anyone past the gate; what is made is theirs. */
  | { kind: 'create' }
  /** The chat of agent #agent on floor #floor (the index of the path's capture) needs this much. */
  | { kind: 'chat'; need: Need; floor: number; agent: number }
  /** A floor (capture #floor): 'view' sees it; 'manage' changes it (its maker, or the owner of the app); 'delete' also owns every chat on it. */
  | { kind: 'floor'; need: 'view' | 'manage' | 'delete'; floor: number }
  /** Moving an agent: its chat, and both floors. */
  | { kind: 'move'; floor: number; agent: number }
  /** The route checks for itself (a chat's own key). */
  | { kind: 'self' }

const OWNER: Rule = { kind: 'owner' }
const SIGNED: Rule = { kind: 'signed' }
const chat = (need: Need): Rule => ({ kind: 'chat', need, floor: 0, agent: 1 })
const floor = (need: 'view' | 'manage' | 'delete'): Rule => ({ kind: 'floor', need, floor: 0 })

/** Every route of the agentic mount and what it needs. Keyed by method and the route's own regular expression. */
export const POLICY: readonly [string, RegExp, Rule][] = [
  ['GET', /^\/pc-control$/, SIGNED],
  ['GET', /^\/pc-control\/pcs\/([^/]+)$/, SIGNED],
  ['POST', /^\/pc-control\/pcs\/([^/]+)\/slots\/([^/]+)\/open$/, SIGNED],
  ['POST', /^\/pc-control\/pcs\/([^/]+)\/slots\/([^/]+)\/stop$/, SIGNED],
  ['POST', /^\/pc-control\/pcs\/([^/]+)\/slots\/([^/]+)\/engine$/, SIGNED],
  ['GET', /^\/watchdog$/, OWNER],
  ['GET', /^\/fast\/names$/, OWNER],
  ['POST', /^\/fast\/names$/, OWNER],
  ['GET', /^\/heartbeat$/, OWNER],
  ['POST', /^\/heartbeat\/morning$/, OWNER],
  ['PATCH', /^\/heartbeat$/, OWNER],
  ['POST', /^\/heartbeat\/beat$/, OWNER],
  ['GET', /^\/floors$/, SIGNED],
  ['GET', /^\/offline-chats$/, SIGNED],
  // F-134: Codex on this PC: its status (names only), asking the CRM now, and the setting.
  ['GET', /^\/codex\/status$/, SIGNED],
  ['GET', /^\/opencode\/status$/, SIGNED],
  ['POST', /^\/codex\/refresh$/, OWNER],
  // F-165: what Codex in Claude Code needs on each PC (versions, sign-in, setup state): the owner of the app only.
  ['GET', /^\/dependencies$/, OWNER],
  ['GET', /^\/codex\/settings$/, SIGNED],
  ['PUT', /^\/codex\/settings$/, OWNER],
  ['PUT', /^\/offline-chats$/, OWNER],
  ['GET', /^\/sessions$/, OWNER],
  ['GET', /^\/sessions\/copy-all$/, OWNER],
  ['POST', /^\/sessions\/copy-all$/, OWNER],
  ['POST', /^\/floors$/, { kind: 'create' }],
  ['POST', /^\/floors\/reorder$/, OWNER],
  ['PATCH', /^\/floors\/([^/]+)$/, floor('manage')],
  ['DELETE', /^\/floors\/([^/]+)$/, floor('delete')],
  ['GET', /^\/defaults$/, SIGNED],
  ['GET', /^\/engine-switch-capabilities$/, SIGNED],
  ['PUT', /^\/defaults$/, OWNER],
  ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/tune$/, chat('owner')],
  ['GET', /^\/approvals$/, SIGNED],
  ['POST', /^\/approvals\/answer$/, SIGNED],
  ['POST', /^\/approvals\/cancel$/, SIGNED],
  ['POST', /^\/send-as-me$/, SIGNED],
  ['GET', /^\/auto-update$/, OWNER],
  ['POST', /^\/auto-update$/, OWNER],
  ['GET', /^\/approvals\/devices$/, OWNER],
  ['POST', /^\/approvals\/devices\/code$/, OWNER],
  ['POST', /^\/approvals\/devices\/register$/, OWNER],
  ['GET', /^\/approvals\/devices\/recover$/, OWNER],
  ['POST', /^\/approvals\/devices\/recover\/start$/, OWNER],
  ['POST', /^\/approvals\/devices\/recover\/finish$/, OWNER],
  ['POST', /^\/approvals\/devices\/remove$/, OWNER],
  ['POST', /^\/approvals\/devices\/unsigned$/, OWNER],
  ['GET', /^\/approvals\/log$/, OWNER],
  ['POST', /^\/floors\/([^/]+)\/agents$/, floor('manage')],
  ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/move$/, { kind: 'move', floor: 0, agent: 1 }],
  ['POST', /^\/floors\/([^/]+)\/import$/, floor('manage')],
  ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/chat$/, chat('owner')],
  ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/run-on$/, chat('owner')],
  ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/terminate$/, chat('owner')],
  ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/restart$/, chat('owner')],
  ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/session$/, chat('owner')],
  ['GET', /^\/floors\/([^/]+)\/agents\/([^/]+)\/messages$/, chat('view')],
  ['GET', /^\/floors\/([^/]+)\/transcripts$/, floor('view')],
  ['GET', /^\/tasks$/, OWNER],
  ['POST', /^\/tasks$/, OWNER],
  ['PATCH', /^\/tasks\/([^/]+)$/, OWNER],
  ['DELETE', /^\/tasks\/([^/]+)$/, OWNER],
  ['GET', /^\/crm$/, OWNER],
  ['PATCH', /^\/crm$/, OWNER],
  ['GET', /^\/crm\/session$/, OWNER],
  ['GET', /^\/floors\/([^/]+)\/agents\/([^/]+)\/chat$/, chat('view')],
  ['GET', /^\/previews$/, SIGNED],
  ['GET', /^\/runs$/, SIGNED],
  ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/say$/, chat('type')],
  ['GET', /^\/floors\/([^/]+)\/agents\/([^/]+)\/deliveries$/, chat('type')],
  ['GET', /^\/floors\/([^/]+)\/agents\/([^/]+)\/deliveries\/([^/]+)$/, chat('type')],
  ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/share$/, chat('owner')],
  ['GET', /^\/floors\/([^/]+)\/memory$/, floor('view')],
  ['POST', /^\/floors\/([^/]+)\/memory$/, floor('manage')],
  ['PATCH', /^\/floors\/([^/]+)\/memory\/([^/]+)$/, floor('manage')],
  ['DELETE', /^\/floors\/([^/]+)\/memory\/([^/]+)$/, floor('manage')],
  ['POST', /^\/mcp\/call$/, { kind: 'self' }],
  ['POST', /^\/mcp\/recall$/, { kind: 'self' }],
  ['GET', /^\/memory\/status$/, OWNER],
  ['GET', /^\/memory\/search$/, OWNER],
  ['GET', /^\/memory\/wiki$/, OWNER],
  ['GET', /^\/memory\/page$/, OWNER],
  ['GET', /^\/memory\/read$/, OWNER],
  ['GET', /^\/memory\/brief$/, OWNER],
  ['POST', /^\/memory\/compile$/, OWNER],
  ['PATCH', /^\/memory\/settings$/, OWNER],
]

const policyKey = (method: string, pattern: RegExp) => `${method} ${pattern.source}`
const RULES = new Map(POLICY.map(([m, p, r]) => [policyKey(m, p), r]))

/** The rule for a route of the agentic table (undefined: not listed, so for the owner only). */
export const ruleOf = (method: string, pattern: RegExp): Rule | undefined => RULES.get(policyKey(method, pattern))

/** The route table's keys, so a test can hold POLICY and the table equal. */
export const policyKeys = (): string[] => [...RULES.keys()]
export { policyKey }

export interface Access {
  /** Whether this caller is the owner of the app (or the app is open). */
  isAdmin(c: Caller): boolean
  /** The person as an owner, to put on what they make: the open app's caller is sbskrrt. */
  ownerOf(c: Caller): ChatOwner
  rights(c: Caller, agent: FloorAgent): { access: ChatAccess; can: ChatCan } | null
  /** Throws 403 not-yours unless the caller has this much on that chat. `route` and `sid` are for the log. */
  needChat(c: Caller, agent: FloorAgent, need: Need, route: string): void
  floorSeen(c: Caller, f: Floor): boolean
  /** Throws 403 not-yours unless the caller sees / manages / may delete the floor. */
  needFloor(c: Caller, f: Floor, need: 'view' | 'manage' | 'delete', route: string): void
  /** The floors as this caller may see them (scoped, tagged). */
  scope(c: Caller, floors: Floor[], scope?: AuthScope): Floor[]
  /** The session ids this caller may view; null = all of them. */
  visible(c: Caller, floors: Floor[]): Set<string> | null
  /** A chat's own caller: its owner, so what a chat's tools may do is what its owner may. */
  asChat(agent: FloorAgent): Caller
  deny(c: Caller, route: string, chatId?: string | null): void
}

export function createAccess(auth: Auth | undefined, onDeny?: (c: Caller, route: string, chatId: string | null) => void): Access {
  const admins = () => auth?.admins() ?? [SBSKRRT_ID]
  const isAdmin = (c: Caller) => (auth ? auth.isAdmin(c) : true)
  const person = (c: Caller): Pick<AuthPerson, 'id'> | null => c.person

  function rights(c: Caller, agent: FloorAgent) {
    if (agent.pcControlSlot) {
      if (c.machine) return { access: 'mine' as const, can: 'owner' as const }
      if (!c.person) return null
    }
    return chatRights(person(c), agent.owner ?? null, agent.sharedWith ?? [], admins())
  }

  const deny = (c: Caller, route: string, chatId?: string | null) => {
    auth?.deny(c, 403, 'not-yours', route, chatId)
    onDeny?.(c, route, chatId ?? null)
  }

  function needChat(c: Caller, agent: FloorAgent, need: Need, route: string) {
    const r = rights(c, agent)
    const ok = r !== null && (need === 'view' || (need === 'type' && r.can !== 'view') || (need === 'owner' && r.can === 'owner'))
    if (ok) return
    deny(c, route, agent.sessionId)
    throw authError(403, r ? "You can only look at this chat; it isn't yours to change." : "That chat isn't yours.", 'not-yours')
  }

  const madeBy = (c: Caller, f: Floor) => !!c.person && f.createdBy?.id === c.person.id

  function floorSeen(c: Caller, f: Floor) {
    return isAdmin(c) || madeBy(c, f) || f.agents.some(a => rights(c, a) !== null)
  }

  function needFloor(c: Caller, f: Floor, need: 'view' | 'manage' | 'delete', route: string) {
    let ok: boolean
    if (isAdmin(c)) ok = true
    else if (need === 'view') ok = floorSeen(c, f)
    else if (need === 'manage') ok = madeBy(c, f)
    else ok = madeBy(c, f) && f.agents.every(a => rights(c, a)?.can === 'owner')
    if (ok) return
    deny(c, route)
    throw authError(403, floorSeen(c, f) ? "That floor isn't yours to change." : "That floor isn't yours.", 'not-yours')
  }

  return {
    isAdmin,
    ownerOf: c => (c.person ? { id: c.person.id, username: c.person.username, name: c.person.name } : SBSKRRT_OWNER),
    rights,
    needChat,
    floorSeen,
    needFloor,
    scope: (c, floors, scope) => {
      if (scope === 'all' && !isAdmin(c)) throw authError(403, 'Only the owner of this app sees all chats.', 'not-yours')
      return scopeFloors(floors, person(c), admins(), scope)
    },
    visible(c, floors) {
      if (isAdmin(c) && (c.machine || c.person || !floors.some(f => f.workspace === 'pc-control'))) return null
      const out = new Set<string>()
      for (const f of floors) for (const a of f.agents) if (a.sessionId && rights(c, a)) out.add(a.sessionId)
      return out
    },
    asChat(agent) {
      const o = agent.owner
      if (!o) return OPEN
      return { person: { id: o.id, username: o.username, name: o.name, canSeeAll: admins().includes(o.id) }, via: 'local', sid: null }
    },
    deny,
  }
}
