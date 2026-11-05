import type { Auth } from './index.ts'
import { authError, type Caller } from './types.ts'

// F-118: the /agent-api/auth/* routes (shared/auth.ts lists them). api.ts has read the body and
// checked the token and the Origin; this only maps a route to the Auth object and says what to
// answer, and the cookie to set.

export interface AuthRouteRequest {
  method: string
  /** The path after /agent-api/auth */
  rest: string
  query: URLSearchParams
  body: unknown
  caller: Caller
  /** The page came over https: the cookie then carries Secure. */
  secure: boolean
}

export interface AuthAnswer {
  status: number
  data: unknown
  setCookie?: string
}

/** The answer, or null when this is not an auth route. */
export async function authRoute(auth: Auth, r: AuthRouteRequest): Promise<AuthAnswer | null> {
  const { method, rest, caller } = r
  if (method === 'GET' && rest === '/status') return { status: 200, data: auth.status(caller) }
  if (method === 'POST' && rest === '/sign-in') {
    const done = await auth.signIn(caller, r.body, r.secure)
    return { status: 200, data: done.status, setCookie: done.cookie }
  }
  if (method === 'POST' && rest === '/sign-out') {
    const out = auth.signOut(caller)
    return { status: 200, data: out.status, setCookie: out.cookie }
  }
  if (method === 'GET' && rest === '/me') {
    if (!caller.person) throw authError(401, 'Not signed in.', 'sign-in')
    return { status: 200, data: caller.person }
  }
  if (method === 'GET' && rest === '/users') return { status: 200, data: { users: auth.users(caller, r.query.get('q') ?? '') } }
  if (method === 'GET' && rest === '/settings') return { status: 200, data: auth.settings(caller) }
  if (method === 'PUT' && rest === '/settings') return { status: 200, data: auth.putSettings(caller, r.body) }
  if (method === 'POST' && rest === '/settings/confirm') return { status: 200, data: auth.confirm(caller) }
  return null
}
