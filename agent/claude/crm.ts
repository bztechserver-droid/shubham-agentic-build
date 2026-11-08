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
/** F-138: an Anthropic API key (sk-ant-api03-…): the other kind of Claude credential the CRM can hand out. Billed per use, no weekly limit. */
export const API_KEY = /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}$/
/** What a Claude credential is: the token `claude setup-token` prints (a subscription), or an API key. */
export type ClaudeKind = 'subscription' | 'api_key'
/** Sent with the credential request: this build can use both. The CRM hands an API key only to a caller that says so (older Christopher builds can't, and are refused 409 KIND_UNSUPPORTED instead of being given a key they would misuse). */
export const CREDENTIAL_KINDS = 'subscription,api_key'

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
  | { kind: 'ok'; subscription: { id: string; name: string }; token: string; /** F-138: what `token` is. Absent (an older CRM, a test double): a subscription. */ credKind?: ClaudeKind }
  /** The CRM gives this person no subscription now: none assigned, Claude turned off for them, their weekly share used up, or theirs turned off. */
  | { kind: 'none'; code: string | null; message: string }
  /** The session is no longer good (401). */
  | { kind: 'expired' }

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export const trimUrl = (url: string) => url.replace(/\/+$/, '')

export async function call(url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  let res: Response
  try {
    const limit = AbortSignal.timeout(TIMEOUT_MS)
    res = await fetch(url, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, limit]) : limit })
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

export const refusal = (r: { status: number; body: Record<string, unknown> }, fallback: string) =>
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
    headers: { cookie: s.cookie, accept: 'application/json', 'x-christopher-build': build, 'x-credential-kinds': CREDENTIAL_KINDS },
  })
  if (r.status === 200) {
    const token = text(r.body.token)
    const sub = r.body.subscription
    const credKind: ClaudeKind = r.body.kind === 'api_key' ? 'api_key' : 'subscription'
    // Each kind is checked against its own shape: an API key is never taken for a setup token, nor the other way round.
    if (!token || !(credKind === 'api_key' ? API_KEY : SETUP_TOKEN).test(token) || !isObject(sub) || text(sub.id) === null) {
      throw new CrmError(credKind === 'api_key' ? "The CRM's answer had no Claude API key in the shape Anthropic's keys have" : "The CRM's answer had no Claude token in the shape `claude setup-token` prints", 200)
    }
    return { kind: 'ok', subscription: { id: String(sub.id), name: text(sub.name) ?? 'Claude' }, token, credKind }
  }
  if (r.status === 401) return { kind: 'expired' }
  // 404 none assigned; 403 Claude off for them, their weekly share used, or no organisation;
  // 409 theirs is turned off. Each comes with the CRM's own sentence.
  if (r.status === 404 || r.status === 403 || r.status === 409) {
    return { kind: 'none', code: text(r.body.code), message: text(r.body.error) ?? `The CRM has no Claude subscription for you (it answered ${r.status})` }
  }
  throw refusal(r, "The CRM couldn't give the Claude subscription")
}

// ── Claude subscription failover: which subscription the person is on, and moving them ──────────
// Three reads and ONE write. The write is the only thing the app ever changes in the CRM, and what
// it changes is the signed-in person's own subscription assignment, nothing else:
//   PUT /v1/org/model-settings/<their own user id>   {"subscription_id": "<uuid>"}
//        (sam-crm-be controller/userModelSettingsController.js setModelSetting, routes/orgRoutes.js:352)
// Only the field sent changes (the model and effort they run stay), the CRM refuses a disabled
// subscription or one that is not the office's (400), and it is for the CRM super admin only
// (lib/superAdmin.js: their user id is on the CRM server's CRM_SUPER_ADMIN_USER_IDS list). Every
// state-changing /v1/org request also needs the CRM's double-submit CSRF pair (middleware/csrf.js):
// GET /v1/auth/csrf-token hands out a token, which goes back as the crm_csrf cookie and the
// x-csrf-token header. The reads:
//   GET /v1/org/claude-subscriptions   the office's subscriptions (super admin only; never a token)
//   GET /v1/org/model-settings/me      which one the person runs on, and where they stand against their cap
//   GET /v1/org/christopher-usage      each subscription's own weekly reading (super admin only)

/** The CRM's ids are UUIDs; one that isn't is never sent. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A reading the CRM may refuse: not its super admin (403), or the session ended (401). */
export type Read<T> = { kind: 'ok'; value: T } | { kind: 'forbidden'; message: string } | { kind: 'expired' }

/** One of the office's Claude subscriptions, as the super admin's list shows it: its last four characters, never its token. */
export interface CrmSubscription {
  id: string
  name: string
  /** F-138: 'api_key' has no weekly limit and is never a switch target; a CRM that predates kinds says nothing: a subscription. */
  kind?: ClaudeKind
  /** Last four characters of its token. */
  hint: string | null
  disabled: boolean
  isDefault: boolean
  /** The weekly cap, in points of the subscription's week, everyone has there without one of their own. */
  defaultCapPercent: number | null
  /** How many people run on it. */
  assigned: number
}

export interface CrmSubscriptions {
  subscriptions: CrmSubscription[]
  defaultId: string | null
}

/** Where the person stands against their weekly cap on the subscription they run on (lib/weeklyCap.js). */
export interface WeeklyCap {
  capPercent: number
  /** 'person': set for them; 'subscription': the subscription's default. */
  capSource: 'person' | 'subscription' | 'none'
  /** Their share of the subscription's week, or null without a reading. */
  usedPercent: number | null
  /** Used up: the CRM refuses them the token (403 WEEKLY_CAP_REACHED). */
  over: boolean
  weekResetsAt: string | null
  /** What everyone on the subscription has used of its week, by Claude's own reading. */
  totalPercent: number | null
}

/** GET /v1/org/model-settings/me, without the model settings: which subscription, and their cap on it. */
export interface CrmSetting {
  subscription: { id: string; name: string; source: 'user' | 'org'; disabled: boolean; kind?: ClaudeKind } | null
  /** An office that manages subscriptions and none for them: no Claude. */
  noClaude: boolean
  claudeBlocked: boolean
  weeklyCap: WeeklyCap | null
}

/** Claude's own reading of one window of a subscription, as Christopher builds report it. */
export interface CrmWindow {
  percent: number | null
  resetsAt: string | null
  observedAt: string | null
  /** The CRM's own word for a reading it hasn't had news of lately. */
  stale: boolean
}

export interface CrmReadings {
  fiveHour: CrmWindow
  week: CrmWindow
}

/** What the CRM said to the move. */
export type Moved =
  | { kind: 'ok' }
  /** Not the CRM super admin: it changes nobody's subscription (403). */
  | { kind: 'forbidden'; message: string }
  /** The CRM turned this subscription down (400): disabled, not the office's. */
  | { kind: 'refused'; status: number; message: string }
  | { kind: 'expired' }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const lower = (v: unknown) => text(v)?.toLowerCase() ?? null

function readStatus<T>(r: { status: number; body: Record<string, unknown> }, what: string, shape: (body: Record<string, unknown>) => T): Read<T> {
  if (r.status === 200) return { kind: 'ok', value: shape(r.body) }
  if (r.status === 401) return { kind: 'expired' }
  if (r.status === 403) return { kind: 'forbidden', message: text(r.body.error) ?? 'The CRM only lets its super admin do that' }
  throw refusal(r, `The CRM couldn't give ${what}`)
}

/** The office's Claude subscriptions. Super admin only: anyone else is 'forbidden'. */
export async function listSubscriptions(s: Pick<CrmSession, 'url' | 'cookie'>): Promise<Read<CrmSubscriptions>> {
  const r = await call(`${s.url}/v1/org/claude-subscriptions`, { headers: { cookie: s.cookie, accept: 'application/json' } })
  return readStatus(r, 'the Claude subscriptions', body => {
    const out: CrmSubscription[] = []
    for (const x of Array.isArray(body.subscriptions) ? body.subscriptions : []) {
      if (!isObject(x) || lower(x.id) === null || text(x.name) === null) continue
      out.push({
        id: lower(x.id)!,
        name: text(x.name)!,
        kind: x.kind === 'api_key' ? 'api_key' : 'subscription',
        hint: text(x.tokenHint),
        disabled: x.disabled === true,
        isDefault: x.isDefault === true,
        defaultCapPercent: num(x.defaultWeekCapPercent),
        assigned: num(x.assigned) ?? 0,
      })
    }
    return { subscriptions: out, defaultId: lower(body.defaultSubscriptionId) }
  })
}

/** Which subscription the CRM puts this person on now, and their cap on it. Any signed-in member may ask. */
export async function mySetting(s: Pick<CrmSession, 'url' | 'cookie'>): Promise<Read<CrmSetting>> {
  const r = await call(`${s.url}/v1/org/model-settings/me`, { headers: { cookie: s.cookie, accept: 'application/json' } })
  return readStatus(r, 'which Claude subscription is yours', body => {
    const sub = body.subscription
    const cap = body.weeklyCap
    return {
      subscription:
        isObject(sub) && lower(sub.id) !== null
          ? { id: lower(sub.id)!, name: text(sub.name) ?? 'Claude', source: sub.source === 'org' ? 'org' : 'user', disabled: sub.disabled === true, kind: sub.kind === 'api_key' ? 'api_key' : 'subscription' }
          : null,
      noClaude: body.noClaude === true,
      claudeBlocked: body.claudeBlocked === true,
      weeklyCap:
        isObject(cap) && num(cap.capPercent) !== null
          ? {
              capPercent: num(cap.capPercent)!,
              capSource: cap.capSource === 'person' ? 'person' : cap.capSource === 'subscription' ? 'subscription' : 'none',
              usedPercent: num(cap.usedPercent),
              over: cap.over === true,
              weekResetsAt: text(cap.weekResetsAt),
              totalPercent: num(cap.totalPercent),
            }
          : null,
    }
  })
}

const windowOf = (w: unknown): CrmWindow =>
  isObject(w)
    ? { percent: num(w.percent), resetsAt: text(w.resetsAt), observedAt: text(w.observedAt), stale: w.stale !== false }
    : { percent: null, resetsAt: null, observedAt: null, stale: true }

/**
 * Each subscription's own weekly (and 5-hour) reading, by id: how much of its week everyone on it
 * has used, and when the week ends. Christopher builds report these; this app reports none, so a
 * reading can be old (`stale`). Super admin only. Only the subscriptions part of the CRM's usage
 * overview is read: none of the people.
 */
export async function subscriptionReadings(s: Pick<CrmSession, 'url' | 'cookie'>): Promise<Read<Record<string, CrmReadings>>> {
  const r = await call(`${s.url}/v1/org/christopher-usage?days=1`, { headers: { cookie: s.cookie, accept: 'application/json' } })
  return readStatus(r, "the subscriptions' weekly readings", body => {
    const out: Record<string, CrmReadings> = {}
    for (const x of Array.isArray(body.subscriptions) ? body.subscriptions : []) {
      if (!isObject(x) || lower(x.id) === null) continue
      out[lower(x.id)!] = { fiveHour: windowOf(x.fiveHour), week: windowOf(x.week) }
    }
    return out
  })
}

/** The CRM's CSRF token for this session (routes/authRoutes.js GET /csrf-token). */
export async function csrfToken(s: Pick<CrmSession, 'url' | 'cookie'>): Promise<string> {
  const r = await call(`${s.url}/v1/auth/csrf-token`, { headers: { cookie: s.cookie, accept: 'application/json' } })
  const token = text(r.body.csrfToken)
  if (r.status !== 200 || !token || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) throw refusal(r, 'The CRM gave no CSRF token')
  return token
}

/**
 * Moves THIS signed-in person to the subscription `subscriptionId` in the CRM: the app's only
 * write to the CRM. It takes no user id: the path is always the session's own, so it cannot move
 * anyone else, and the body is exactly {subscription_id}, so it changes nothing else (not their
 * model, effort, caps or the office default).
 */
export async function moveMeTo(s: Pick<CrmSession, 'url' | 'cookie' | 'user'>, subscriptionId: string): Promise<Moved> {
  if (!UUID.test(subscriptionId)) throw new CrmError('That is not a Claude subscription id', 400)
  if (!UUID.test(s.user.id)) throw new CrmError("The CRM's id for you is not an id", 400)
  const csrf = await csrfToken(s)
  const r = await call(`${s.url}/v1/org/model-settings/${s.user.id}`, {
    method: 'PUT',
    headers: {
      cookie: `${s.cookie}; crm_csrf=${csrf}`,
      'x-csrf-token': csrf,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ subscription_id: subscriptionId.toLowerCase() }),
  })
  if (r.status === 200 && r.body.ok === true) return { kind: 'ok' }
  if (r.status === 401) return { kind: 'expired' }
  const sentence = text(r.body.error)
  // 403 is two different things: the CSRF pair was wrong (the app's fault), or this is not the super admin.
  if (r.status === 403 && sentence !== null && !/csrf/i.test(sentence)) return { kind: 'forbidden', message: sentence }
  if (r.status === 400) return { kind: 'refused', status: 400, message: sentence ?? 'The CRM turned that Claude subscription down' }
  throw refusal(r, "The CRM wouldn't move you to that Claude subscription")
}

/** One of the CRM organisation's members, as the Share picker needs them (the CRM's email is left out on purpose). */
export interface CrmMember {
  id: string
  username: string
  name: string
  /** The CRM's role: 'admin', 'staff' or 'client'. */
  role: string
}

/** The organisation's members (GET /v1/org/members: any member may read it). */
export async function listMembers(s: Pick<CrmSession, 'url' | 'cookie'>): Promise<CrmMember[]> {
  const r = await call(`${s.url}/v1/org/members`, { headers: { cookie: s.cookie, accept: 'application/json' } })
  if (r.status !== 200) throw refusal(r, "The CRM wouldn't list its members")
  const out: CrmMember[] = []
  for (const m of Array.isArray(r.body.members) ? r.body.members : []) {
    if (!isObject(m) || text(m.userId) === null) continue
    const username = text(m.username)
    out.push({ id: String(m.userId), username: username ?? '', name: text(m.fullName) ?? username ?? 'Member', role: (text(m.role) ?? 'staff').toLowerCase() })
  }
  return out
}
