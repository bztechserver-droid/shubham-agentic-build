// F-118: people and ownership for a page's mock and for tests. Fake names and ids, nothing real
// but sbskrrt's CRM id (a public identifier the contract names). A mock does:
//   scopeFloors(fixtureAssign(floors), fixtureViewer(me))      me: 'sbskrrt' | 'ravi' | 'priya' | 'jupta' | 'none'
// and answers /auth/status with fixtureStatus(me, require, via), so every tab, filter and Share
// state can be seen without the agent.

import {
  AUTH_IDLE_HOURS,
  AUTH_SESSION_DAYS,
  SBSKRRT_ID,
  type AuthPerson,
  type AuthRequire,
  type AuthStatus,
  type AuthUser,
  type ChatOwner,
  type ChatShare,
} from './auth.ts'

export const FIXTURE_PEOPLE: readonly (AuthUser & { canSeeAll: boolean })[] = [
  { id: SBSKRRT_ID, username: 'sbskrrt', name: 'Shubham Bhole', canSeeAll: true },
  { id: '0199aaaa-0000-7000-8000-00000000a001', username: 'ravi', name: 'Ravi Patil', canSeeAll: false },
  { id: '0199aaaa-0000-7000-8000-00000000a002', username: 'priya', name: 'Priya Nair', canSeeAll: false },
  { id: '0199aaaa-0000-7000-8000-00000000a003', username: 'jupta', name: 'Jupta Shah', canSeeAll: false },
]

/** The CRM's member list as the Share picker gets it. */
export const FIXTURE_USERS: readonly AuthUser[] = FIXTURE_PEOPLE.map(({ id, username, name }) => ({ id, username, name }))

/** The person for `?me=`; 'none' (or anything unknown) is nobody signed in. */
export function fixtureViewer(me: string | null | undefined): AuthPerson | null {
  const p = FIXTURE_PEOPLE.find(x => x.username === me)
  return p ? { id: p.id, username: p.username, name: p.name, canSeeAll: p.canSeeAll } : null
}

/** /auth/status for the mock. `require` is what the PC is set to; `via` where the request came from. */
export function fixtureStatus(me: string | null | undefined, require: AuthRequire = 'off', via: 'local' | 'tailnet' = 'local'): AuthStatus {
  const person = fixtureViewer(me)
  const needs = !person && (require === 'all' || (require === 'remote' && via === 'tailnet'))
  const now = Date.now()
  return {
    require,
    via,
    person,
    session: person ? { expiresAt: new Date(now + AUTH_SESSION_DAYS * 864e5).toISOString(), idleExpiresAt: new Date(now + AUTH_IDLE_HOURS * 36e5).toISOString() } : null,
    canPublish: person?.canSeeAll === true,
    mayShowCode: person?.canSeeAll === true,
    mayApprove: person?.canSeeAll === true,
    needsSignIn: needs,
  }
}

const ownerOf = (u: AuthUser): ChatOwner => ({ id: u.id, username: u.username, name: u.name })
const shareOf = (u: AuthUser, can: 'view' | 'type'): ChatShare => ({ ...ownerOf(u), can })
const [SB, RAVI, PRIYA, JUPTA] = FIXTURE_USERS

/**
 * Gives a mock's floors owners and shares, the same way every time: agents go round sbskrrt, sbskrrt,
 * ravi, priya, sbskrrt, jupta ...; the 1st (sbskrrt's) is shared with ravi (type) and priya (view),
 * and the 4th (priya's) with jupta (view). A floor is made by the owner of its first agent.
 */
export function fixtureAssign<A extends { id: string; owner?: ChatOwner | null; sharedWith?: ChatShare[] }, F extends { createdBy?: ChatOwner | null; agents: A[] }>(
  floors: readonly F[],
): F[] {
  const order = [SB, SB, RAVI, PRIYA, SB, JUPTA]
  let n = 0
  return floors.map(f => {
    const agents = f.agents.map(a => {
      const u = order[n % order.length]
      const mine = n
      n++
      return { ...a, owner: ownerOf(u), sharedWith: mine === 0 ? [shareOf(RAVI, 'type'), shareOf(PRIYA, 'view')] : mine === 3 ? [shareOf(JUPTA, 'view')] : [] }
    })
    return { ...f, createdBy: agents[0]?.owner ?? null, agents }
  })
}
