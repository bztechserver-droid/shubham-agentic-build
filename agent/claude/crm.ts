// The CRM's sign-in, and the Claude subscription it hands its signed-in person (F-007). The
// same three requests Christopher makes (agentic-claude-manager-dev server/lib/crmClient.js and
// crmSession.js sign in; its sealed build, agentic-claude-manager-build, fetches the token):
//   POST /v1/auth/login     {username or email, password, portal: "crm"}: the CRM answers with
//                           its session as the crm_token cookie, a JWT good for 7 days
//                           (sam-crm-be controller/authController.js:60-233)
//   GET  /v1/auth/me        who that session is (authController.js:490-520)
//   GET  /v1/org/claude-subscriptions/mine/credential
//                           the token of the subscription the CRM puts this person on, with an
//                           x-christopher-build header saying which copy asked (sam-crm-be
//                           controller/claudeSubscriptionsController.js:510-600)
// No x-christopher-release header: the CRM only checks Christopher's own builds for being the
// latest (lib/christopherRelease.js), and this app is not one. The password is sent once, in
// the sign-in, and kept nowhere; the cookie and the token are never logged.

/** The CRM Christopher uses (its sealed build's prod backend). SAD_CRM_URL points elsewhere. */
export const CRM_URL = 'https://crmbe.bhole.co'
/** The CRM signs its session for 7 days (authController.js JWT_EXPIRY). */
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000
const TIMEOUT_MS = 20_000
/** What `claude setup-token` prints, as the CRM and Christopher check it. */
export const SETUP_TOKEN = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/

export interface CrmUser {
  id: string
  /** Their full name in the CRM, else their username. */
  name: string
  username: string | null
  email: string | null
}

export interface CrmSession {
  /** The CRM it belongs to, without a trailing slash. */
  url: string
  /** "crm_token=<JWT>": a bearer credential for the person's CRM account. */
  cookie: string
  user: CrmUser
  signedInAt: string
}

/** The CRM said no (`status` its HTTP status, `code` its own code), or no answer came (`status` null). */
export class CrmError extends Error {
  status: number | null
  code: string | null
  constructor(message: string, status: number | null, code: string | null = null) {
    super(message)
    this.name = 'CrmError'
    this.status = status
    this.code = code
  }
}

export type Credential =
  | { kind: 'ok'; subscription: { id: string; name: string }; token: string }
  /** The CRM gives this person no subscription now: none assigned, Claude turned off for them, their weekly share used up, or theirs turned off. */
  | { kind: 'none'; code: string | null; message: string }
  /** The session is no longer good (401). */
  | { kind: 'expired' }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export const trimUrl = (url: string) => url.replace(/\/+$/, '')

async function call(url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  let res: Response
  try {
    res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } }
    const why = err.name === 'TimeoutError' ? `no answer in ${TIMEOUT_MS / 1000} s` : (err.cause?.code ?? err.cause?.message ?? err.message ?? String(e))
    throw new CrmError(`Couldn't reach the CRM at ${new URL(url).origin}: ${why}`, null)
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // Not JSON: the status says enough.
  }
  return { status: res.status, body: isObject(body) ? body : {}, headers: res.headers }
}

const refusal = (r: { status: number; body: Record<string, unknown> }, fallback: string) =>
  new CrmError(text(r.body.error) ?? `${fallback} (the CRM answered ${r.status})`, r.status, text(r.body.code))

function userOf(raw: unknown): CrmUser {
  if (!isObject(raw) || text(raw.id) === null) throw new CrmError('The CRM answered without saying who is signed in', null)
  const username = text(raw.username)
  const email = text(raw.email)
  return { id: String(raw.id), name: text(raw.fullName) ?? username ?? email ?? 'Signed in', username, email }
}

/** Signs in with the person's own login (a username, or an email when it has an @). */
export async function signIn(url: string, login: string, password: string): Promise<CrmSession> {
  const base = trimUrl(url)
  const id = login.trim()
  const r = await call(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ...(id.includes('@') ? { email: id } : { username: id }), password, portal: 'crm' }),
  })
  if (r.status !== 200) throw refusal(r, 'The CRM turned the sign-in down')
  const cookie = r.headers
    .getSetCookie()
    .map(c => c.split(';')[0].trim())
    .find(c => /^crm_token=./.test(c))
  if (!cookie) throw new CrmError('The CRM took the password but gave no session', r.status)
  const user = await me({ url: base, cookie })
  return { url: base, cookie, user, signedInAt: new Date().toISOString() }
}

/** Who the session is; a CrmError with status 401 when it is no longer good. */
export async function me(s: Pick<CrmSession, 'url' | 'cookie'>): Promise<CrmUser> {
  const r = await call(`${s.url}/v1/auth/me`, { headers: { cookie: s.cookie, accept: 'application/json' } })
  if (r.status !== 200) throw refusal(r, "The CRM wouldn't say who is signed in")
  return userOf(r.body.user)
}

/**
 * The token of the subscription the CRM puts this person on. `build` goes in the
 * x-christopher-build header (8-64 of A-Z a-z 0-9 _ -): the CRM keeps it, beside when and to
 * whom, as "last handed out" for its super admin to see.
 */
export async function credential(s: Pick<CrmSession, 'url' | 'cookie'>, build: string): Promise<Credential> {
  const r = await call(`${s.url}/v1/org/claude-subscriptions/mine/credential`, {
    headers: { cookie: s.cookie, accept: 'application/json', 'x-christopher-build': build },
  })
  if (r.status === 200) {
    const token = text(r.body.token)
    const sub = r.body.subscription
    if (!token || !SETUP_TOKEN.test(token) || !isObject(sub) || text(sub.id) === null) {
      throw new CrmError("The CRM's answer had no Claude token in the shape `claude setup-token` prints", 200)
    }
    return { kind: 'ok', subscription: { id: String(sub.id), name: text(sub.name) ?? 'Claude' }, token }
  }
  if (r.status === 401) return { kind: 'expired' }
  // 404 none assigned; 403 Claude off for them, their weekly share used, or no organisation;
  // 409 theirs is turned off. Each comes with the CRM's own sentence.
  if (r.status === 404 || r.status === 403 || r.status === 409) {
    return { kind: 'none', code: text(r.body.code), message: text(r.body.error) ?? `The CRM has no Claude subscription for you (it answered ${r.status})` }
  }
  throw refusal(r, "The CRM couldn't give the Claude subscription")
}
