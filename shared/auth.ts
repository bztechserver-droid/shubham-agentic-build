// F-118: who is using the app. Each person signs in IN THE PAGE (per browser) with their own CRM
// account; every chat belongs to one person; the owner can share a chat with others as "can view"
// or "can type"; sbskrrt (Shubham) sees all. The agent enforces this on every route, WebSocket and MCP
// tool: the page only mirrors it. Contract between agent/auth/* and the pages. Pure data and one pure
// function (chatRights), so the agent and a page's mock decide the same way. No secrets: the
// password goes to the CRM once; the page only ever holds an httpOnly cookie it cannot read.
//
// ROUTES (all under AGENT_API_PREFIX = '/agent-api'; the cookie `sad_session` rides every one of
// them, and the WebSocket upgrades, by itself):
//
//   GET  /auth/status             always 200, needs no sign-in: AuthStatus (the page's first call)
//   POST /auth/sign-in            {username, password}: AuthStatus, with Set-Cookie. `username` is
//                                 the CRM username or email. 401 {code:'wrong-password'}, 429
//                                 {code:'slow-down'}, 502 {code:'crm-unreachable'}, 403 {code:'not-allowed'}
//                                 (a CRM client account: only staff and admins may use the app).
//   POST /auth/sign-out           ends this session now (the cookie is dead at once, its sockets
//                                 close): AuthStatus
//   GET  /auth/me                 the signed-in person: AuthPerson. 401 {code:'sign-in'} when not.
//   GET  /auth/users?q=           the CRM's members for the Share picker: {users: AuthUser[]}
//                                 (signed in only; q matches username or name, at most 50)
//   GET  /auth/settings           sbskrrt only: AuthSettings
//   PUT  /auth/settings           sbskrrt only: {require?, phoneExempt?}: AuthSettings. RAISING
//                                 `require` starts a trial (AuthSettings.trial): it is kept only
//                                 when the SAME session then calls POST /auth/settings/confirm
//                                 within AUTH_TRIAL_SECONDS, else it goes back by itself.
//   POST /auth/settings/confirm   sbskrrt only, from the session that raised it: AuthSettings
//
//   POST /agentic/floors/:floorId/agents/:agentId/share   {users: ShareRequestUser[]}: {agent: FloorAgent}
//                                 replaces the whole list (an empty list unshares); owner or sbskrrt.
//   GET  /agentic/floors?scope=mine|shared|all   optional server-side filter (AuthScope); the page
//                                 may also just filter what the events socket sends by `access`.
//                                 scope=all is 403 for anyone but sbskrrt.
//
// ERRORS (JSON {error: string, code: AuthErrorCode}):
//   401 {code:'sign-in'}    no session, or it ended; the page shows its sign-in.
//   403 {code:'not-yours'}  signed in, but not allowed: a chat they cannot see (deep link, saved
//                           window, terminal/chat socket, file), or a right they lack (stop/start
//                           or share without owning it; typing with only 'view').
//   403 {code:'admin-only'} the PC's own pages and settings are for sbskrrt only.
//
// EVENTS SOCKET (/agentic/events, cookie on the upgrade): the `floors` event is already filtered
// for THIS connection, and is sent again when a share changes. When the session ends (sign-out
// elsewhere, 7 days, 12 h unused, signed out everywhere) or the sign-in level is raised past it, the
// socket first gets {t:'auth', ended: AuthEnded} and is then closed with code 4401.

/** The cookie the agent sets on sign-in: httpOnly, SameSite=Strict, Path=/, Secure over https. */
export const AUTH_COOKIE = 'sad_session'
/** Set by the page servers (never by a client) on a request that came over the tailnet; absent for this PC's own browser. */
export const AUTH_VIA_HEADER = 'x-sad-via'
/** Set by the page server on EVERY request it forwards to the API (never by a client: its copy is overwritten): "this came from a page". */
export const AUTH_PAGE_HEADER = 'x-sad-page'
/** A sign-in ends this long after it began, whatever happens. */
export const AUTH_SESSION_DAYS = 7
/** ... or this long after it was last used. */
export const AUTH_IDLE_HOURS = 12
/** A raised sign-in level reverts unless confirmed within this. */
export const AUTH_TRIAL_SECONDS = 120

/** How the app asks for sign-in: 'off' = as before (nobody has to); 'remote' = devices arriving over the tailnet; 'all' = this PC's own pages too. */
export type AuthRequire = 'off' | 'remote' | 'all'
export const AUTH_REQUIRE: readonly AuthRequire[] = ['off', 'remote', 'all']

export type AuthErrorCode = 'sign-in' | 'not-yours' | 'admin-only' | 'wrong-password' | 'slow-down' | 'crm-unreachable' | 'not-allowed'
export type AuthEnded = 'signed-out' | 'expired' | 'idle' | 'revoked' | 'sign-in-required'

/** The person signed in. `canSeeAll`: sbskrrt, who sees every chat (the All chats tab) and the PC's own pages. */
export interface AuthPerson {
  /** The CRM user id (a UUID): what ownership and shares are kept by. */
  id: string
  username: string
  name: string
  canSeeAll: boolean
}

/** Someone in the CRM's member list: who a chat can be shared with. */
export interface AuthUser {
  id: string
  username: string
  name: string
}

/** This browser's session: absolute and idle ends (ISO). */
export interface AuthSession {
  expiresAt: string
  idleExpiresAt: string
}

export interface AuthStatus {
  require: AuthRequire
  /** Where this request came from: the PC's own browser, or another device of the tailnet. */
  via: 'local' | 'tailnet'
  /** The person, or null when this browser is not signed in. */
  person: AuthPerson | null
  session: AuthSession | null
  /** F-119: this browser is signed in as sbskrrt, so it may press Publish on the Build page (the agent refuses it to every other page). */
  canPublish: boolean
  /**
   * F-122: this browser may be GIVEN a code to add a device ("Show a code to add a device", "Show a pairing code") without a registered approval
   * device's signature: it is signed in as sbskrrt and Settings has not turned that off (AuthSettings.ownerCodes). An unsigned page never may.
   */
  mayShowCode?: boolean
  /** True when this browser must sign in before the app answers anything else (require says so for `via`). With person null and needsSignIn false the app is open as before: no tabs, no scoping. */
  needsSignIn: boolean
}

export interface AuthSettings {
  require: AuthRequire
  /** The paired phone app keeps the old way (its device key) until it can sign in. Default true. */
  phoneExempt: boolean
  /** F-122: a browser signed in as sbskrrt is given the codes to add a device / pair Chris, whether or not it is a registered approval device. Default true; false = "approval devices only". */
  ownerCodes: boolean
  /** A raised level waiting to be confirmed: it reverts to `previous` at `until` (ISO). */
  trial: { previous: AuthRequire; until: string } | null
}

export type ShareLevel = 'view' | 'type'
export const SHARE_LEVELS: readonly ShareLevel[] = ['view', 'type']

/** Who owns a chat. */
export interface ChatOwner {
  id: string
  username: string
  name: string
}

/** One person a chat is shared with. Kept by CRM user id (a rename breaks nothing). */
export interface ChatShare {
  id: string
  username: string
  name: string
  can: ShareLevel
}

export interface ShareRequestUser {
  id: string
  can: ShareLevel
}

export interface ShareRequest {
  users: ShareRequestUser[]
}

/**
 * Why this viewer sees a chat: 'mine' it is theirs; 'shared' someone shared it with them; 'all'
 * they see it only because they see everything (sbskrrt), or because the app is open as before
 * (require 'off' and not signed in: every chat 'all').
 */
export type ChatAccess = 'mine' | 'shared' | 'all'
/** What this viewer may do with it: 'owner' everything (also sbskrrt, and the open app); 'type' read + type; 'view' read only. */
export type ChatCan = 'owner' | 'type' | 'view'

/** The scope values of GET /agentic/floors?scope= . */
export type AuthScope = 'mine' | 'shared' | 'all'

/** The fields a chat (FloorAgent) carries for ownership. `owner` and `sharedWith` are the hub's own; `access`, `can` are computed per connection, and `sharedWith` is sent to the owner and sbskrrt only. */
export interface AgentOwnership {
  /** Null: not owned yet (never after the one-time move to sbskrrt, except for a chat made by the open app). */
  owner: ChatOwner | null
  access: ChatAccess
  can: ChatCan
  sharedWith: ChatShare[]
}

/** The CRM user id of sbskrrt (Shubham Bhole): the default admin. The agent's config can list others; nobody else is one. */
export const SBSKRRT_ID = '019d2ff6-1b5c-7aed-a08c-474497789b8f'

/**
 * What `person` may do with a chat owned by `owner` and shared as `sharedWith`: null = may not even see it.
 * `person` null is the open app (nobody has to sign in): everything. `admins` are the CRM ids that see all.
 * The ONE place this is decided (the agent and a page's mock both call it).
 */
export function chatRights(
  person: Pick<AuthPerson, 'id'> | null,
  owner: Pick<ChatOwner, 'id'> | null,
  sharedWith: readonly Pick<ChatShare, 'id' | 'can'>[],
  admins: readonly string[] = [SBSKRRT_ID],
): { access: ChatAccess; can: ChatCan } | null {
  if (!person) return { access: 'all', can: 'owner' }
  if (owner && owner.id === person.id) return { access: 'mine', can: 'owner' }
  if (admins.includes(person.id)) return { access: 'all', can: 'owner' }
  const share = sharedWith.find(s => s.id === person.id)
  if (share) return { access: 'shared', can: share.can === 'type' ? 'type' : 'view' }
  return null
}

/** What the floors carry, so `scopeFloors` is typed without importing the whole of agentic.ts at runtime. */
interface OwnedAgent {
  id: string
  owner?: ChatOwner | null
  sharedWith?: ChatShare[]
  access?: ChatAccess
  can?: ChatCan
}
interface OwnedFloor<A extends OwnedAgent> {
  createdBy?: ChatOwner | null
  agents: A[]
}

/**
 * The floors as ONE connection may see them: invisible chats removed (their desks too), a floor with
 * nothing visible left removed (unless this person made it), every chat tagged with `access` and
 * `can`, and `sharedWith` kept only for the owner and the admins. Copies: the input is not changed.
 * `scope` narrows to one tab; 'all' is the admin's (the caller refuses it for anyone else).
 */
export function scopeFloors<A extends OwnedAgent, F extends OwnedFloor<A>>(
  floors: readonly F[],
  person: Pick<AuthPerson, 'id'> | null,
  admins: readonly string[] = [SBSKRRT_ID],
  scope?: AuthScope,
): (Omit<F, 'agents'> & { agents: (A & { access: ChatAccess; can: ChatCan })[] })[] {
  const out: (Omit<F, 'agents'> & { agents: (A & { access: ChatAccess; can: ChatCan })[] })[] = []
  for (const f of floors) {
    const agents: (A & { access: ChatAccess; can: ChatCan })[] = []
    for (const a of f.agents) {
      const r = chatRights(person, a.owner ?? null, a.sharedWith ?? [], admins)
      if (!r) continue
      if (scope && scope !== 'all' && r.access !== scope) continue
      const seesList = r.can === 'owner'
      agents.push({ ...a, access: r.access, can: r.can, sharedWith: seesList ? (a.sharedWith ?? []) : [] })
    }
    const madeByMe = !!person && f.createdBy?.id === person.id && (!scope || scope === 'mine')
    if (agents.length || madeByMe) out.push({ ...f, agents })
  }
  return out
}
