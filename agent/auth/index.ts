import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import {
  AUTH_COOKIE,
  AUTH_IDLE_HOURS,
  AUTH_REQUIRE,
  AUTH_SESSION_DAYS,
  AUTH_TRIAL_SECONDS,
  AUTH_VIA_HEADER,
  SBSKRRT_ID,
  type AuthEnded,
  type AuthErrorCode,
  type AuthPerson,
  type AuthRequire,
  type AuthSession,
  type AuthSettings,
  type AuthStatus,
  type AuthUser,
} from '../../shared/auth.ts'
import { apiError } from '../api.ts'
import { CrmError, listMembers, signIn as crmSignIn, type CrmMember, type CrmSession } from '../claude/crm.ts'
import { writeAtomic } from '../config.ts'
import type { Logger } from '../log.ts'
import { authError, type Caller } from './types.ts'

// F-118: who is using the app (agent/SPEC.md › Signing in). Each person signs in in the page with
// their own CRM account; the agent then issues its OWN session cookie. What is kept, in auth.json
// (mode 0600): the sha-256 of each session token (never the token), who it is (CRM id, username,
// name), when it began and was last used; the CRM's member list for the Share picker; and the
// settings. NEVER a password, a CRM cookie or a session token: the password goes to the CRM once,
// the CRM's own cookie is used for who-am-I and the member list, and both are dropped.

const DAY_MS = 24 * 60 * 60 * 1000
const SESSION_MS = AUTH_SESSION_DAYS * DAY_MS
const IDLE_MS = AUTH_IDLE_HOURS * 60 * 60 * 1000
const TRIAL_MS = AUTH_TRIAL_SECONDS * 1000
/** lastSeen is kept in memory; it is written out at most this often. */
const SAVE_EVERY_MS = 60_000
const FAILS_MAX = 5
const FAILS_ALL_MAX = 30
const FAILS_WINDOW_MS = 60_000
/** Where a break-glass file or SAD_AUTH=off is looked for again (cached, so a busy API does not stat on every request). */
const BREAK_GLASS_CHECK_MS = 1000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const iso = (v: unknown): v is string => str(v) && Number.isFinite(Date.parse(v))
const order = (r: AuthRequire) => AUTH_REQUIRE.indexOf(r)
const isRequire = (v: unknown): v is AuthRequire => typeof v === 'string' && (AUTH_REQUIRE as readonly string[]).includes(v)
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export { authError, type Caller }

interface SessionRow {
  h: string
  user: AuthUser
  createdAt: number
  lastSeen: number
}

interface Trial {
  previous: AuthRequire
  until: number
  /** The session that raised the level: only it can keep it. */
  sid: string
}

interface FileShape {
  version: 1
  admins: string[]
  require: AuthRequire
  phoneExempt: boolean
  /** F-124 (F-122's ownerCodes, generalised): "Sign-in is enough (no approval device)": sbskrrt, signed in, is accepted wherever a registered device's signature is asked for (default on). */
  signInEnough: boolean
  trial: Trial | null
  sessions: SessionRow[]
  directory: AuthUser[]
  directoryAt: string | null
  /** The one-time move of every existing chat to sbskrrt (agent/agentic): when it ran. */
  migrated: string | null
}

function emptyFile(): FileShape {
  return { version: 1, admins: [SBSKRRT_ID], require: 'off', phoneExempt: true, signInEnough: true, trial: null, sessions: [], directory: [], directoryAt: null, migrated: null }
}

const userOf = (v: unknown): AuthUser | null =>
  isObject(v) && str(v.id) && typeof v.username === 'string' && str(v.name) ? { id: v.id, username: v.username, name: v.name } : null

/** The file, tolerantly: whatever is wrong in it is left out, never thrown. */
export function parseFile(raw: unknown): FileShape {
  const f = emptyFile()
  if (!isObject(raw)) return f
  if (Array.isArray(raw.admins)) {
    const ids = raw.admins.filter(str)
    if (ids.length) f.admins = [...new Set(ids)]
  }
  if (isRequire(raw.require)) f.require = raw.require
  if (raw.phoneExempt === false) f.phoneExempt = false
  // F-122 wrote it as ownerCodes: an old file that said off still says off.
  if (raw.signInEnough === false || raw.ownerCodes === false) f.signInEnough = false
  const t = raw.trial
  if (isObject(t) && isRequire(t.previous) && typeof t.until === 'number' && str(t.sid)) f.trial = { previous: t.previous, until: t.until, sid: t.sid }
  if (Array.isArray(raw.sessions)) {
    for (const s of raw.sessions) {
      const user = isObject(s) ? userOf(s.user) : null
      if (!isObject(s) || !user || !str(s.h) || typeof s.createdAt !== 'number' || typeof s.lastSeen !== 'number') continue
      f.sessions.push({ h: s.h, user, createdAt: s.createdAt, lastSeen: s.lastSeen })
    }
  }
  if (Array.isArray(raw.directory)) f.directory = raw.directory.map(userOf).filter((u): u is AuthUser => u !== null)
  if (iso(raw.directoryAt)) f.directoryAt = raw.directoryAt
  if (iso(raw.migrated)) f.migrated = raw.migrated
  return f
}

export interface AuthOptions {
  /** auth.json */
  file: string
  /** Break-glass: while this file exists the sign-in level is 'off' (someone at the PC made it). */
  breakGlassFile: string
  crmUrl: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** Tests: a pretend CRM. */
  crm?: {
    signIn(url: string, login: string, password: string): Promise<CrmSession>
    listMembers(s: Pick<CrmSession, 'url' | 'cookie'>): Promise<CrmMember[]>
  }
  log?: Logger
}

export interface SignedIn {
  status: AuthStatus
  /** The Set-Cookie header value. */
  cookie: string
}

export interface Auth {
  /** The request's caller: its cookie's session (touched: it was used now), and where it came from. */
  caller(headers: Record<string, string | string[] | undefined>): Caller
  /** The sign-in level in force now: the break-glass 'off', or a trial's, or the saved one. */
  require(): AuthRequire
  /** Whether a request from `via` has to be signed in. */
  needsSignIn(via: Caller['via']): boolean
  /** Whether the person may see everything and use the PC's own pages. A caller with no person in an open app is. */
  isAdmin(c: Caller): boolean
  admins(): readonly string[]
  /** The paired phone app keeps its device key instead of a sign-in. */
  phoneExempt(): boolean
  /** F-124: whether a signed-in sbskrrt is accepted in place of an approval device's signature (the setting; the caller must also be the owner). */
  signInEnough(): boolean
  /** F-122's name for the same thing. */
  ownerCodes(): boolean
  status(c: Caller): AuthStatus
  signIn(c: Caller, body: unknown, secure: boolean): Promise<SignedIn>
  /** Ends this session; the cookie to clear it. */
  signOut(c: Caller): { status: AuthStatus; cookie: string }
  /** The sessions of one person (or every session, with null) ended, for any reason: their sockets are told. */
  revoke(userId: string | null, why: AuthEnded): number
  users(c: Caller, q: string): AuthUser[]
  /** The CRM member list as last read (to name the people a chat is shared with); no sign-in check: its callers are inside the agent. */
  directory(): AuthUser[]
  settings(c: Caller): AuthSettings
  putSettings(c: Caller, body: unknown): AuthSettings
  confirm(c: Caller): AuthSettings
  /** A socket or stream of this caller: it is ended (told why) when the session ends or the level is raised past it. */
  track(c: Caller, end: (why: AuthEnded) => void): () => void
  /** The one-time migration marker (agent/agentic): null until it ran. */
  migrated(): string | null
  markMigrated(): void
  /** Writes down what is only in memory (last use of the sessions). */
  flush(): void
  /** Logs a refused request: who, the route and the chat, never a secret. */
  deny(c: Caller, status: number, code: AuthErrorCode, route: string, chatId?: string | null): void
  close(): void
}

export function createAuth(o: AuthOptions): Auth {
  const env = o.env ?? process.env
  const now = o.now ?? Date.now
  const log = o.log
  const crm = o.crm ?? { signIn: crmSignIn, listMembers }

  let f = load()
  let dirty = false
  let savedAt = 0
  const fails = new Map<string, number[]>()
  const watchers = new Set<{ c: Caller; end: (why: AuthEnded) => void }>()
  let glass = { at: 0, on: false }

  function load(): FileShape {
    try {
      return parseFile(JSON.parse(readFileSync(o.file, 'utf8')))
    } catch {
      return emptyFile()
    }
  }

  function save() {
    dirty = false
    savedAt = now()
    writeAtomic(o.file, `${JSON.stringify(f, null, 2)}\n`, 0o600)
  }

  /** Break-glass: SAD_AUTH=off, or the file. Read again at most once a second. */
  function broken(): boolean {
    if (env.SAD_AUTH === 'off') return true
    const t = now()
    if (t - glass.at < BREAK_GLASS_CHECK_MS) return glass.on
    glass = { at: t, on: fileExists(o.breakGlassFile) }
    return glass.on
  }

  /** A trial that has run out has gone back: done on every read, so no timer decides it. */
  function settleTrial() {
    if (f.trial && now() >= f.trial.until) {
      log?.warn(`sign-in level back to ${f.trial.previous}: the new one was not confirmed in time`)
      f.require = f.trial.previous
      f.trial = null
      save()
    }
  }

  function require(): AuthRequire {
    if (broken()) return 'off'
    settleTrial()
    return f.require
  }

  const needsSignIn = (via: Caller['via']) => {
    const r = require()
    return r === 'all' || (r === 'remote' && via === 'tailnet')
  }

  function cookieOf(headers: Record<string, string | string[] | undefined>): string | null {
    const raw = headers.cookie
    const line = Array.isArray(raw) ? raw.join('; ') : raw
    if (!line) return null
    for (const part of line.split(';')) {
      const i = part.indexOf('=')
      if (i > 0 && part.slice(0, i).trim() === AUTH_COOKIE) return part.slice(i + 1).trim() || null
    }
    return null
  }

  const isAdminId = (id: string) => f.admins.includes(id)
  const personOf = (u: AuthUser): AuthPerson => ({ id: u.id, username: u.username, name: u.name, canSeeAll: isAdminId(u.id) })

  /** Ends the rows that have passed their time, telling their sockets. */
  function sweep() {
    const t = now()
    for (const s of [...f.sessions]) {
      const why: AuthEnded | null = t - s.createdAt >= SESSION_MS ? 'expired' : t - s.lastSeen >= IDLE_MS ? 'idle' : null
      if (why) drop(s.h, why)
    }
  }

  function drop(h: string, why: AuthEnded) {
    const i = f.sessions.findIndex(s => s.h === h)
    if (i === -1) return
    f.sessions.splice(i, 1)
    save()
    endWatchers(w => w.c.sid === h.slice(0, 12), why)
  }

  function endWatchers(pick: (w: { c: Caller }) => boolean, why: AuthEnded) {
    for (const w of [...watchers]) {
      if (!pick(w)) continue
      watchers.delete(w)
      try {
        w.end(why)
      } catch {
        // A socket already gone.
      }
    }
  }

  function caller(headers: Record<string, string | string[] | undefined>): Caller {
    const via = headers[AUTH_VIA_HEADER] === 'tailnet' ? 'tailnet' : 'local'
    const token = cookieOf(headers)
    if (!token) return { person: null, via, sid: null }
    const h = hash(token)
    const row = f.sessions.find(s => s.h === h)
    if (!row) return { person: null, via, sid: null }
    const t = now()
    const over: AuthEnded | null = t - row.createdAt >= SESSION_MS ? 'expired' : t - row.lastSeen >= IDLE_MS ? 'idle' : null
    if (over) {
      drop(h, over)
      return { person: null, via, sid: null }
    }
    row.lastSeen = t
    if (t - savedAt >= SAVE_EVERY_MS) save()
    else dirty = true
    return { person: personOf(row.user), via, sid: h.slice(0, 12) }
  }

  function sessionInfo(sid: string | null): AuthSession | null {
    const row = sid ? f.sessions.find(s => s.h.startsWith(sid)) : undefined
    if (!row) return null
    return { expiresAt: new Date(row.createdAt + SESSION_MS).toISOString(), idleExpiresAt: new Date(Math.min(row.createdAt + SESSION_MS, row.lastSeen + IDLE_MS)).toISOString() }
  }

  function status(c: Caller): AuthStatus {
    return {
      require: require(),
      via: c.via,
      person: c.person,
      session: c.person ? sessionInfo(c.sid) : null,
      canPublish: c.person?.canSeeAll === true,
      mayShowCode: c.person?.canSeeAll === true && f.signInEnough,
      mayApprove: c.person?.canSeeAll === true && f.signInEnough,
      needsSignIn: !c.person && !c.machine && needsSignIn(c.via),
    }
  }

  const admin = (c: Caller) => (c.person ? isAdminId(c.person.id) : c.machine === true || !needsSignIn(c.via))

  /** Five wrong tries a minute for one username, and thirty for the whole app (a spray over many usernames). */
  function throttled(login: string): boolean {
    const t = now()
    for (const key of [login.toLowerCase(), '*']) {
      const list = (fails.get(key) ?? []).filter(x => t - x < FAILS_WINDOW_MS)
      fails.set(key, list)
      if (list.length >= (key === '*' ? FAILS_ALL_MAX : FAILS_MAX)) return true
    }
    return false
  }

  async function signIn(c: Caller, body: unknown, secure: boolean): Promise<SignedIn> {
    const b = isObject(body) ? body : {}
    const login = typeof b.username === 'string' ? b.username.trim() : ''
    const password = typeof b.password === 'string' ? b.password : ''
    if (!login || !password || login.length > 200 || password.length > 1000) throw apiError(400, 'Expected {username, password}')
    if (throttled(login)) throw authError(429, 'Too many wrong tries: wait a minute and try again.', 'slow-down')
    let session: CrmSession
    try {
      session = await crm.signIn(o.crmUrl, login, password)
    } catch (e) {
      if (e instanceof CrmError && e.status !== null && e.status >= 400 && e.status < 500) {
        for (const key of [login.toLowerCase(), '*']) fails.set(key, [...(fails.get(key) ?? []), now()])
        log?.warn(`sign-in refused for ${login.slice(0, 40)}: the CRM answered ${e.status}`)
        throw authError(401, 'The CRM did not accept that username and password.', 'wrong-password')
      }
      log?.warn(`sign-in for ${login.slice(0, 40)}: the CRM could not be reached`)
      throw authError(502, e instanceof Error ? e.message : "Couldn't reach the CRM", 'crm-unreachable')
    }
    const user: AuthUser = { id: session.user.id.toLowerCase(), username: session.user.username ?? login, name: session.user.name }
    // Who they are in the organisation: a CRM client account (an outside customer) is not for this app.
    let members: CrmMember[] | null = null
    try {
      members = await crm.listMembers(session)
    } catch (e) {
      log?.warn(`the CRM's member list could not be read for ${user.username}: ${e instanceof Error ? e.message : String(e)}`)
    }
    const self = members?.find(m => m.id.toLowerCase() === user.id)
    if (!isAdminId(user.id)) {
      if (!members) throw authError(502, "Couldn't check your place in the organisation: the CRM did not answer.", 'crm-unreachable')
      if (!self || self.role === 'client') throw authError(403, 'This app is for the office’s staff.', 'not-allowed')
    }
    if (members) {
      f.directory = members.filter(m => m.role !== 'client' && m.username).map(m => ({ id: m.id.toLowerCase(), username: m.username, name: m.name }))
      f.directoryAt = new Date(now()).toISOString()
    }
    if (!f.directory.some(u => u.id === user.id)) f.directory.push(user)
    fails.delete(login.toLowerCase())
    const token = randomBytes(32).toString('base64url')
    const t = now()
    f.sessions.push({ h: hash(token), user, createdAt: t, lastSeen: t })
    sweep()
    save()
    log?.info(`${user.username} (${user.id.slice(0, 8)}) signed in${c.via === 'tailnet' ? ' over the tailnet' : ''}`)
    const next: Caller = { person: personOf(user), via: c.via, sid: hash(token).slice(0, 12) }
    return { status: status(next), cookie: cookieHeader(token, SESSION_MS / 1000, secure) }
  }

  function cookieHeader(value: string, maxAgeSeconds: number, secure: boolean) {
    return `${AUTH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(maxAgeSeconds)}${secure ? '; Secure' : ''}`
  }

  function signOut(c: Caller) {
    const row = c.sid ? f.sessions.find(s => s.h.startsWith(c.sid ?? '')) : undefined
    if (row) {
      log?.info(`${row.user.username} (${row.user.id.slice(0, 8)}) signed out`)
      drop(row.h, 'signed-out')
    }
    return { status: status({ person: null, via: c.via, sid: null }), cookie: cookieHeader('', 0, false) }
  }

  function revoke(userId: string | null, why: AuthEnded): number {
    let n = 0
    for (const s of [...f.sessions]) {
      if (userId !== null && s.user.id !== userId) continue
      drop(s.h, why)
      n++
    }
    return n
  }

  function users(c: Caller, q: string): AuthUser[] {
    if (!c.person && !c.machine && needsSignIn(c.via)) throw authError(401, 'Sign in first.', 'sign-in')
    const needle = q.trim().toLowerCase()
    const list = needle ? f.directory.filter(u => u.username.toLowerCase().includes(needle) || u.name.toLowerCase().includes(needle)) : f.directory
    return list.slice(0, 50).map(u => ({ ...u }))
  }

  function settingsOf(): AuthSettings {
    settleTrial()
    return { require: require(), phoneExempt: f.phoneExempt, signInEnough: f.signInEnough, ownerCodes: f.signInEnough, trial: f.trial ? { previous: f.trial.previous, until: new Date(f.trial.until).toISOString() } : null }
  }

  /** Only a signed-in admin: nobody at an open app, no one else, may change how people sign in. */
  function needAdmin(c: Caller): AuthPerson {
    if (!c.person) throw authError(401, 'Sign in first.', 'sign-in')
    if (!isAdminId(c.person.id)) throw authError(403, 'Only the owner of this app can change how people sign in.', 'admin-only')
    return c.person
  }

  function settings(c: Caller): AuthSettings {
    needAdmin(c)
    return settingsOf()
  }

  function putSettings(c: Caller, body: unknown): AuthSettings {
    const who = needAdmin(c)
    const b = isObject(body) ? body : {}
    if (b.require !== undefined && !isRequire(b.require)) throw apiError(400, "require is off, remote or all")
    if (b.phoneExempt !== undefined && typeof b.phoneExempt !== 'boolean') throw apiError(400, 'phoneExempt is true or false')
    settleTrial()
    if (b.ownerCodes !== undefined && typeof b.ownerCodes !== 'boolean') throw apiError(400, 'ownerCodes is true or false')
    if (b.signInEnough !== undefined && typeof b.signInEnough !== 'boolean') throw apiError(400, 'signInEnough is true or false')
    if (typeof b.ownerCodes === 'boolean' && typeof b.signInEnough === 'boolean' && b.ownerCodes !== b.signInEnough) throw apiError(400, 'ownerCodes is the old name of signInEnough: send one, or both the same')
    const enough = typeof b.signInEnough === 'boolean' ? b.signInEnough : typeof b.ownerCodes === 'boolean' ? b.ownerCodes : undefined
    if (typeof b.phoneExempt === 'boolean') f.phoneExempt = b.phoneExempt
    if (enough !== undefined && enough !== f.signInEnough) {
      f.signInEnough = enough
      log?.warn(`${who.username} turned "Sign-in is enough (no approval device)" ${enough ? 'ON' : 'off (approval devices only)'}`)
    }
    if (isRequire(b.require) && b.require !== f.require) {
      const raising = order(b.require) > order(f.require)
      if (raising) {
        // On trial: kept only when this same session confirms it.
        if (!c.sid) throw authError(401, 'Sign in first.', 'sign-in')
        f.trial = { previous: f.trial?.previous ?? f.require, until: now() + TRIAL_MS, sid: c.sid }
        log?.warn(`${who.username} raised sign-in to ${b.require} on trial (until confirmed within ${AUTH_TRIAL_SECONDS} s)`)
      } else {
        f.trial = null
        log?.warn(`${who.username} lowered sign-in to ${b.require}`)
      }
      f.require = b.require
    }
    save()
    enforce()
    return settingsOf()
  }

  function confirm(c: Caller): AuthSettings {
    needAdmin(c)
    settleTrial()
    if (f.trial) {
      if (f.trial.sid !== c.sid) throw authError(403, 'Only the browser that raised the level can keep it.', 'not-yours')
      log?.info(`sign-in level ${f.require} kept: confirmed`)
      f.trial = null
      save()
    }
    return settingsOf()
  }

  /** After the level was raised: the open connections that now have to be signed in are ended. */
  function enforce() {
    endWatchers(w => !w.c.person && !w.c.machine && needsSignIn(w.c.via), 'sign-in-required')
  }

  function track(c: Caller, end: (why: AuthEnded) => void) {
    const w = { c, end }
    watchers.add(w)
    return () => void watchers.delete(w)
  }

  return {
    caller,
    require,
    needsSignIn,
    isAdmin: admin,
    admins: () => f.admins,
    phoneExempt: () => f.phoneExempt,
    signInEnough: () => f.signInEnough,
    ownerCodes: () => f.signInEnough,
    status,
    signIn,
    signOut,
    revoke,
    users,
    directory: () => f.directory.map(u => ({ ...u })),
    settings,
    putSettings,
    confirm,
    track,
    migrated: () => f.migrated,
    markMigrated() {
      f.migrated = new Date(now()).toISOString()
      save()
    },
    flush() {
      if (dirty) save()
    },
    deny(c, status, code, route, chatId) {
      const who = c.person ? `${c.person.username} (${c.person.id.slice(0, 8)})` : `nobody signed in (${c.via})`
      log?.warn(`auth ${status} ${code}: ${who} ${route.slice(0, 120)}${chatId ? ` chat ${chatId.slice(0, 8)}` : ''}`)
    },
    close() {
      if (dirty) save()
      watchers.clear()
    },
  }
}

function fileExists(file: string): boolean {
  try {
    statSync(file)
    return true
  } catch {
    return false
  }
}
