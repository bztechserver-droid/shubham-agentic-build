import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import type { ClaudeInfo } from '../../shared/agent-api.ts'
import { writeAtomic, type StatePaths } from '../config.ts'
import type { Logger } from '../log.ts'
import * as crmApi from './crm.ts'
import { CRM_URL, CrmError, SESSION_MS, trimUrl, type CrmSession, type Credential } from './crm.ts'
import { loadUserEnv, type UserEnv } from './userenv.ts'

// Claude on this PC runs on the Claude subscription the CRM gives the person signed in here
// (F-007). The CRM's super admin keeps the office's subscriptions in the CRM, each as the token
// `claude setup-token` printed, and puts each person on one (sam-crm-be
// controller/claudeSubscriptionsController.js). Christopher fetches that token at sign-in and
// starts each claude with it in CLAUDE_CODE_OAUTH_TOKEN; this app has no Claude sessions of its
// own, so it puts the token in this Windows account's CLAUDE_CODE_OAUTH_TOKEN instead, and every
// Claude Code started on this PC afterwards runs on it.
//
//   sign in    the person's own CRM login, sent once to the CRM (crm.ts); only the CRM's 7-day
//              session is kept, in crm-session.json
//   check      at start, every hour, and on the page's Check now: the CRM's answer decides.
//              A subscription: its token goes in (a new one replaces the old). None (none
//              assigned, Claude turned off for them, their weekly share used up, theirs turned
//              off): the token the app put there comes out
//   sign out   the token the app put there comes out, and the session is forgotten
// Only a token the app put there is ever replaced or removed: claude-subscription.json keeps
// its SHA-256 (and last four characters) to recognise it. One set by anything else is left
// alone until the person says Replace.
// A session ends after 7 days (or when the CRM ends it): the token stays, and the page asks to
// sign in again, when the CRM is asked again. The CRM's no takes it out; time alone does not.

export const TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN'
export const CHECK_EVERY_MS = 60 * 60 * 1000

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** The CRM calls, injectable for tests. */
export interface CrmApi {
  signIn(url: string, login: string, password: string): Promise<CrmSession>
  credential(s: CrmSession, build: string): Promise<Credential>
}

/** What claude-subscription.json holds: which token the app put in, never the token itself. */
interface Placed {
  subscription: { id: string; name: string }
  sha256: string
  hint: string
  setAt: string
}

export interface ClaudeSubscription {
  status(): ClaudeInfo
  /** Signs in to the CRM and asks it at once; throws CrmError when the CRM says no or can't be reached. */
  signIn(login: string, password: string): Promise<ClaudeInfo>
  /** Asks the CRM again (when signed in). `replace` takes over a CLAUDE_CODE_OAUTH_TOKEN something else set. */
  check(opts?: { replace?: boolean }): Promise<ClaudeInfo>
  /** Takes out the token the app put in and forgets the session. */
  signOut(): Promise<ClaudeInfo>
}

export interface ClaudeOptions {
  paths: Pick<StatePaths, 'crmSession' | 'claudeSubscription'>
  /** This PC's device ID: the CRM records "sad-<id>" as which copy fetched the token. */
  deviceId: string
  log: Logger
  env?: Record<string, string | undefined>
  /** Tests: an in-memory environment; null for a PC without one. */
  userEnv?: UserEnv | null
  /** Tests: a stand-in CRM. */
  crm?: CrmApi
  now?: () => number
  onChange(): void
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function loadSession(file: string): CrmSession | null {
  const raw = readJson(file)
  if (!isObject(raw) || !str(raw.url) || !str(raw.cookie) || !str(raw.signedInAt) || !isObject(raw.user)) return null
  const u = raw.user
  if (!str(u.id) || !str(u.name)) return null
  return {
    url: raw.url,
    cookie: raw.cookie,
    signedInAt: raw.signedInAt,
    user: { id: u.id, name: u.name, username: str(u.username) ? u.username : null, email: str(u.email) ? u.email : null },
  }
}

function loadPlaced(file: string): Placed | null {
  const raw = readJson(file)
  if (!isObject(raw) || !isObject(raw.subscription) || !str(raw.sha256) || !str(raw.hint) || !str(raw.setAt)) return null
  const s = raw.subscription
  if (!str(s.id) || !str(s.name)) return null
  return { subscription: { id: s.id, name: s.name }, sha256: raw.sha256, hint: raw.hint, setAt: raw.setAt }
}

export function createClaudeSubscription(o: ClaudeOptions): ClaudeSubscription {
  const log = o.log
  const env = o.env ?? process.env
  const now = o.now ?? Date.now
  const userEnv = o.userEnv !== undefined ? o.userEnv : loadUserEnv()
  const crm: CrmApi = o.crm ?? crmApi
  const url = trimUrl(env.SAD_CRM_URL || CRM_URL)
  const build = `sad-${o.deviceId}`

  let session = loadSession(o.paths.crmSession)
  let placed = loadPlaced(o.paths.claudeSubscription)
  let lastCheck: ClaudeInfo['check'] = null
  let busy = false
  // One thing at a time: a sign-in, a check and a sign-out never interleave.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    return run
  }

  const expiresAt = (s: CrmSession) => Date.parse(s.signedInAt) + SESSION_MS
  const iso = (ms: number) => new Date(ms).toISOString()

  /** The variable as it is now; an empty one counts as not set. Null when it can't be read. */
  function current(): string | null {
    if (!userEnv) return null
    try {
      return userEnv.get(TOKEN_VAR) || null
    } catch (e) {
      log.warn(`couldn't read ${TOKEN_VAR}: ${message(e)}`)
      return null
    }
  }
  const ours = (value: string | null) => value !== null && placed !== null && sha256(value) === placed.sha256

  function savePlaced(next: Placed | null) {
    placed = next
    if (next) writeAtomic(o.paths.claudeSubscription, JSON.stringify(next, null, 2) + '\n', 0o600)
    else rmSync(o.paths.claudeSubscription, { force: true })
  }
  function saveSession(next: CrmSession | null) {
    session = next
    // The cookie is a bearer credential for the person's CRM account: owner-only.
    if (next) writeAtomic(o.paths.crmSession, JSON.stringify(next, null, 2) + '\n', 0o600)
    else rmSync(o.paths.crmSession, { force: true })
  }

  function status(): ClaudeInfo {
    const value = current()
    const token: ClaudeInfo['token'] = !userEnv ? 'unsupported' : value === null ? 'empty' : ours(value) ? 'set' : 'taken'
    return {
      token,
      subscription: token === 'set' && placed ? { ...placed.subscription, hint: placed.hint, setAt: placed.setAt } : null,
      url,
      crm: session
        ? { name: session.user.name, username: session.user.username, url: session.url, signedInAt: session.signedInAt, expiresAt: iso(expiresAt(session)) }
        : null,
      check: lastCheck,
      busy,
    }
  }

  async function announce() {
    try {
      await userEnv?.announce()
    } catch (e) {
      log.warn(`couldn't announce the change to running programs: ${message(e)}`)
    }
  }

  /** Puts the subscription's token in, unless something else's is there and `replace` is false. */
  async function place(cred: Extract<Credential, { kind: 'ok' }>, replace: boolean) {
    if (!userEnv) return
    const value = current()
    const hint = cred.token.slice(-4)
    const record: Placed = { subscription: cred.subscription, sha256: sha256(cred.token), hint, setAt: iso(now()) }
    if (value === cred.token) {
      // Already there (put in by this app before, or by hand): from now on it's the app's.
      if (!placed || placed.sha256 !== record.sha256 || placed.subscription.id !== cred.subscription.id || placed.subscription.name !== cred.subscription.name) {
        savePlaced(placed?.sha256 === record.sha256 ? { ...record, setAt: placed.setAt } : record)
      }
      return
    }
    if (value !== null && !ours(value) && !replace) {
      log.info(`${TOKEN_VAR} is already set by something else: left alone`)
      return
    }
    userEnv.set(TOKEN_VAR, cred.token)
    savePlaced(record)
    log.info(`Claude on this PC now runs on the CRM's subscription "${cred.subscription.name}" (…${hint})`)
    await announce()
  }

  /** Takes out the token the app put in; anything else's stays. */
  async function unplace(why: string) {
    const value = current()
    if (userEnv && ours(value)) {
      try {
        userEnv.remove(TOKEN_VAR)
        log.info(`took the CRM's Claude subscription off this PC: ${why}`)
        await announce()
      } catch (e) {
        log.error(`couldn't take ${TOKEN_VAR} out: ${message(e)}`)
        throw e
      }
    }
    savePlaced(null)
  }

  async function ask(replace: boolean) {
    if (!session) return
    if (now() >= expiresAt(session)) {
      log.info(`the CRM session for ${session.user.name} ended (they last 7 days); sign in again`)
      saveSession(null)
      return
    }
    busy = true
    o.onChange()
    try {
      const cred = await crm.credential(session, build)
      const at = iso(now())
      if (cred.kind === 'ok') {
        await place(cred, replace)
        lastCheck = { at, result: 'ok', message: null }
      } else if (cred.kind === 'expired') {
        log.info(`the CRM ended the session for ${session.user.name}; sign in again`)
        saveSession(null)
        lastCheck = { at, result: 'error', message: 'The CRM ended this session. Sign in again.' }
      } else {
        log.info(`the CRM gives ${session.user.name} no Claude subscription: ${cred.message}`)
        await unplace(cred.message)
        lastCheck = { at, result: 'none', message: cred.message }
      }
    } catch (e) {
      log.warn(`couldn't ask the CRM: ${message(e)}`)
      lastCheck = { at: iso(now()), result: 'error', message: message(e) }
    } finally {
      busy = false
      o.onChange()
    }
  }

  return {
    status,

    signIn: (login, password) =>
      serial(async () => {
        const id = login.trim()
        if (!id || !password) throw new CrmError('Type your CRM username (or email) and password', 400)
        busy = true
        o.onChange()
        let next: CrmSession
        try {
          // Its 7 days count on this PC's clock, the one that later decides they're over.
          next = { ...(await crm.signIn(url, id, password)), signedInAt: iso(now()) }
        } finally {
          busy = false
          o.onChange()
        }
        // Someone else signing in here: what the last person's subscription put in comes out
        // first, so nobody keeps running on another's account.
        if (session && session.user.id !== next.user.id && placed) await unplace(`${next.user.name} signed in instead of ${session.user.name}`)
        saveSession(next)
        log.info(`signed in to the CRM at ${url} as ${next.user.name}`)
        await ask(false)
        return status()
      }),

    check: (opts = {}) =>
      serial(async () => {
        await ask(opts.replace === true)
        return status()
      }),

    signOut: () =>
      serial(async () => {
        await unplace('signed out here')
        if (session) log.info(`signed out of the CRM (${session.user.name})`)
        saveSession(null)
        lastCheck = null
        o.onChange()
        return status()
      }),
  }
}
