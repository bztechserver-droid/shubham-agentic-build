import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import type { ClaudeInfo } from '../../shared/agent-api.ts'
import type { ChatImpact, ClaudeSwitchInfo, SwitchBy, SwitchChoice, SwitchPreview, SwitchRecord, SwitchSubscription, SwitchWatch } from '../../shared/claude-switch.ts'
import { writeAtomic, type StatePaths } from '../config.ts'
import type { Logger } from '../log.ts'
import { buildChoices, previewSwitch as previewOf, seenCapOf, weekUsedUp } from './choices.ts'
import * as crmApi from './crm.ts'
import {
  CRM_URL,
  CrmError,
  SESSION_MS,
  UUID,
  trimUrl,
  type CrmReadings,
  type CrmSession,
  type CrmSetting,
  type CrmSubscriptions,
  type Credential,
  type Moved,
  type Read,
} from './crm.ts'
import { AUTO_COOLDOWN_MS, openSwitchStore, type SwitchStore } from './state.ts'
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
//
// SWITCHING (Claude subscription failover). The person can be moved to the office's other
// subscription: by themselves on the page, or by the app when the weekly limit of the one they run
// on is used up (failover.ts decides when). A move is ONE write to the CRM, the person's own
// assignment (crm.ts moveMeTo), then the new token is fetched the normal way and put in. The
// rules that keep it from ever flipping back and forth live HERE, in switchTo, so no caller can
// get around them: after the app switched by itself it will not again for 24 hours, never back to
// the subscription it left before that one's week is back, and never onto one whose week is used
// up. What it remembers (the log, the caps it has seen) is in claude-switch.json (state.ts): no
// token, no cookie. status() answers from what is cached and never asks the CRM: the page calls
// it every few seconds.

export const TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN'
export const CHECK_EVERY_MS = 60 * 60 * 1000
/** The CRM's own codes for a person whose subscription's week is used up, or that was turned off. */
export const USED_UP_CODES: ReadonlySet<string> = new Set(['WEEKLY_CAP_REACHED', 'SUBSCRIPTION_DISABLED'])
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const STATUS_LOG = 20
/**
 * The subscriptions' weekly readings come from the CRM's usage overview, which is heavy for it
 * (everyone's usage) and old anyway (Christopher builds report them now and then): asked for again
 * only after this long, however often the page refreshes.
 */
const READINGS_FRESH_MS = 5 * 60 * 1000

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0
/** Whatever is said to the log, the page or Lead: a token-shaped string never goes in. */
const scrub = (s: string) => s.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[token]')
const hintText = (hint: string | null) => (hint ? ` (…${hint})` : '')

/** The CRM calls, injectable for tests. */
export interface CrmApi {
  signIn(url: string, login: string, password: string): Promise<CrmSession>
  credential(s: CrmSession, build: string): Promise<Credential>
  listSubscriptions(s: CrmSession): Promise<Read<CrmSubscriptions>>
  mySetting(s: CrmSession): Promise<Read<CrmSetting>>
  subscriptionReadings(s: CrmSession): Promise<Read<Record<string, CrmReadings>>>
  moveMeTo(s: CrmSession, subscriptionId: string): Promise<Moved>
}

/** What claude-subscription.json holds: which token the app put in, never the token itself. */
interface Placed {
  subscription: { id: string; name: string }
  sha256: string
  hint: string
  setAt: string
}

export interface SwitchOptions {
  by: SwitchBy
  /** In a sentence: why. It goes in the log, the page and Lead's message, so it holds nothing secret. */
  why: string
  /** What the person was warned of and went ahead with. */
  warnings?: string[]
  /** When the subscription being left has its week back (ISO), if known: the app won't switch back to it by itself before. */
  leftResetsAt?: string | null
}

export type SwitchResult =
  | {
      ok: true
      record: SwitchRecord
      /** placed: the new token is in. left-alone: something else's is there (Replace on the page takes it over). unsupported: this PC can't set it. none: the CRM moved them but gives no token for it. */
      token: 'placed' | 'left-alone' | 'unsupported' | 'none'
      message: string
      /** While `token` is 'none': the CRM's own reason it gave no token (empty otherwise). */
      detail: string
    }
  | {
      ok: false
      reason: 'no-session' | 'expired' | 'not-allowed' | 'blocked' | 'refused' | 'same' | 'unknown' | 'error'
      message: string
    }

/** What the CRM answered at a check. */
export type CheckOutcome = { result: 'ok' } | { result: 'none'; code: string | null; message: string } | { result: 'error' }

/**
 * failover.ts watches every check. When the CRM says the person's week is used up (or their
 * subscription was turned off) it answers 'hold': the token stays while it confirms or switches.
 * 'proceed' (or no answer) carries on as before: the CRM's no takes the token out. Only those two
 * codes can be held; the answer to any other outcome is ignored.
 */
export type CheckHook = (outcome: CheckOutcome) => 'hold' | 'proceed' | void

export interface ClaudeSubscription {
  status(): ClaudeInfo
  /** Signs in to the CRM and asks it at once; throws CrmError when the CRM says no or can't be reached. */
  signIn(login: string, password: string): Promise<ClaudeInfo>
  /** Asks the CRM again (when signed in). `replace` takes over a CLAUDE_CODE_OAUTH_TOKEN something else set. */
  check(opts?: { replace?: boolean }): Promise<ClaudeInfo>
  /** Takes out the token the app put in and forgets the session. */
  signOut(): Promise<ClaudeInfo>
  /** Reads the office's subscriptions, the person's own and (with `readings`) each one's week again. Reads only. */
  refreshSwitch(opts?: { readings?: boolean }): Promise<ClaudeInfo>
  /** What a switch to `to` would do and what the person is warned of. `chats` are the running chats that would restart. Reads only. */
  previewSwitch(to: string, chats: ChatImpact[]): Promise<SwitchPreview | { error: string }>
  /** Moves the signed-in person to `to` in the CRM and puts its token in. The only write to the CRM; only their own assignment. */
  switchTo(to: string, opts: SwitchOptions): Promise<SwitchResult>
  /** Turns switching by itself on or off. */
  setAuto(on: boolean): Promise<ClaudeInfo>
  /** After a switch, the chats restarted on the new subscription are added to its log entry (the restart happens outside the queue). */
  noteRestarted(at: string, names: string[]): void
  /** What the app says it is doing about limits (failover.ts sets it). */
  setWatch(w: SwitchWatch | null): void
  /** failover.ts watches every check, and decides what happens to the token when the CRM says the week is used up. */
  setCheckHook(hook: CheckHook | null): void
  /** Stops anything still pending. */
  close(): void
}

export interface ClaudeOptions {
  paths: Pick<StatePaths, 'crmSession' | 'claudeSubscription'> & Partial<Pick<StatePaths, 'claudeSwitch'>>
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
  const store: SwitchStore = openSwitchStore(o.paths.claudeSwitch ?? null)

  let session = loadSession(o.paths.crmSession)
  let placed = loadPlaced(o.paths.claudeSubscription)
  let lastCheck: ClaudeInfo['check'] = null
  let busy = false
  let closed = false
  // One thing at a time: a sign-in, a check, a switch and a sign-out never interleave.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    return run
  }

  // What the page shows of the switch, cached: status() never asks the CRM.
  let choices: SwitchChoice[] = []
  let mine: CrmSetting | null = null
  let readings: Record<string, CrmReadings> | null = null
  let readingsAt = 0
  let allowed: boolean | null = null
  let note: string | null = null
  let readAt: string | null = null
  let watch: SwitchWatch | null = null
  let checkHook: CheckHook | null = null

  /** Tells failover.ts what the CRM answered. Its answer only matters for a week used up; an error in it never reaches the check. */
  function tellHook(outcome: CheckOutcome): 'hold' | 'proceed' | void {
    try {
      return checkHook?.(outcome)
    } catch (e) {
      log.warn(`the failover hook failed: ${message(e)}`)
    }
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

  /** What the switch remembers and shows is the signed-in person's: another person, or nobody, starts clean. */
  function forgetSwitch() {
    store.clear()
    choices = []
    mine = null
    readings = null
    readingsAt = 0
    allowed = null
    note = null
    readAt = null
    watch = null
  }

  function switchInfo(): ClaudeSwitchInfo {
    const st = store.state()
    const active = choices.find(c => c.active)
    const cur: SwitchSubscription | null = active
      ? { id: active.id, name: active.name, hint: active.hint }
      : mine?.subscription
        ? { id: mine.subscription.id, name: mine.subscription.name, hint: placed?.subscription.id === mine.subscription.id ? placed.hint : null }
        : placed
          ? { id: placed.subscription.id, name: placed.subscription.name, hint: placed.hint }
          : null
    const since = cur && st.since && st.since.subscriptionId === cur.id ? st.since : null
    return {
      allowed,
      note,
      choices,
      current: cur ? { ...cur, since: since?.at ?? null, by: since && since.by !== 'crm' ? since.by : null } : null,
      log: st.log.slice(0, STATUS_LOG),
      auto: st.auto,
      watch: watch ?? (st.auto ? { state: 'watching', message: '' } : { state: 'off', message: 'Switching by itself is turned off.' }),
      readAt,
    }
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
      switch: switchInfo(),
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

  function endSession(s: CrmSession) {
    log.info(`the CRM ended the session for ${s.user.name}; sign in again`)
    saveSession(null)
    lastCheck = { at: iso(now()), result: 'error', message: 'The CRM ended this session. Sign in again.' }
    choices = []
    allowed = null
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
        tellHook({ result: 'ok' })
      } else if (cred.kind === 'expired') {
        endSession(session)
        tellHook({ result: 'error' })
      } else {
        log.info(`the CRM gives ${session.user.name} no Claude subscription: ${cred.message}`)
        // A week used up (or a subscription turned off) is what the failover answers: its hook says wait while it confirms or switches.
        const answer = tellHook({ result: 'none', code: cred.code, message: cred.message })
        const hold = answer === 'hold' && cred.code !== null && USED_UP_CODES.has(cred.code)
        if (!hold) await unplace(cred.message)
        lastCheck = { at, result: 'none', message: cred.message, code: cred.code }
      }
    } catch (e) {
      log.warn(`couldn't ask the CRM: ${message(e)}`)
      lastCheck = { at: iso(now()), result: 'error', message: message(e) }
      tellHook({ result: 'error' })
    } finally {
      busy = false
      o.onChange()
    }
  }

  // ── the switch ──────────────────────────────────────────────────────────────────────────────

  /** What the app keeps of the cap the CRM just told (for the day the person is on the other subscription). */
  function rememberCap() {
    const k = seenCapOf(mine, now())
    if (!k || !session) return
    const was = store.state().seen[k.id]
    const same = was && was.percent === k.seen.percent && was.source === k.seen.source && was.over === k.seen.over && was.usedPercent === k.seen.usedPercent
    if (same && now() - Date.parse(was.at) < 60 * 60 * 1000) return
    const userId = session.user.id
    store.update(s => {
      s.userId = userId
      s.seen[k.id] = k.seen
    })
  }

  /** Reads the office's subscriptions and the person's own from the CRM (inside the queue). false: the session had ended. */
  async function readChoices(withReadings: boolean): Promise<boolean> {
    const s = session
    if (!s) {
      forgetSwitch()
      return false
    }
    try {
      const [list, setting] = await Promise.all([crm.listSubscriptions(s), crm.mySetting(s)])
      if (list.kind === 'expired' || setting.kind === 'expired') {
        endSession(s)
        return false
      }
      mine = setting.kind === 'ok' ? setting.value : null
      allowed = list.kind === 'ok'
      note = list.kind === 'forbidden' ? list.message : null
      if (list.kind === 'ok') {
        if (readings === null || (withReadings && now() - readingsAt >= READINGS_FRESH_MS)) {
          const r = await crm.subscriptionReadings(s)
          if (r.kind === 'expired') {
            endSession(s)
            return false
          }
          if (r.kind === 'ok') {
            readings = r.value
            readingsAt = now()
          }
        }
        choices = buildChoices({ list: list.value, readings, mine, seen: store.state().seen, now: now() })
      } else {
        choices = []
      }
      rememberCap()
      readAt = iso(now())
    } catch (e) {
      // A CRM that doesn't answer (or an older one without these routes) leaves what was known.
      log.warn(`couldn't read the Claude subscriptions from the CRM: ${message(e)}`)
    }
    return true
  }

  const refOf = (c: { id: string; name: string; hint: string | null }): SwitchSubscription => ({ id: c.id, name: c.name, hint: c.hint })

  /** Why the app may not switch by itself to `to` now, or null. The rules that keep it from flipping back and forth. */
  function autoRefusal(to: SwitchChoice): string | null {
    const st = store.state()
    if (!st.auto) return 'Switching by itself is turned off.'
    const ep = st.episode
    if (ep && now() - Date.parse(ep.at) < AUTO_COOLDOWN_MS) {
      return `The app already switched you by itself at ${ep.at}, and does not do it again within 24 hours.`
    }
    if (ep && ep.from.id === to.id && now() < Date.parse(ep.blockedUntil)) {
      return `${to.name} is the subscription the app left because its week was used up, and its week is not back yet.`
    }
    if (weekUsedUp(to.week, now())) return `${to.name} has used all of its week as well.`
    if (to.cap?.over) return `Your share of ${to.name}’s week is used up as well.`
    return null
  }

  async function doSwitch(toId: string, opts: SwitchOptions): Promise<SwitchResult> {
    const s = session
    if (!s) return { ok: false, reason: 'no-session', message: 'Sign in to the CRM first.' }
    if (!UUID.test(toId)) return { ok: false, reason: 'unknown', message: 'That is not one of the office’s Claude subscriptions.' }
    toId = toId.toLowerCase()
    if (!(await readChoices(true))) return { ok: false, reason: 'expired', message: 'The CRM ended this session. Sign in again.' }
    if (allowed === null) return { ok: false, reason: 'error', message: 'The CRM could not be asked which Claude subscriptions there are. Try again in a moment.' }
    const to = choices.find(c => c.id === toId)
    if (!to) {
      return allowed === false
        ? { ok: false, reason: 'not-allowed', message: note ?? 'The CRM only lets its super admin change which Claude subscription a person is on.' }
        : { ok: false, reason: 'unknown', message: 'That is not one of the office’s Claude subscriptions.' }
    }
    const from = choices.find(c => c.active) ?? null
    const fromId = from?.id ?? mine?.subscription?.id ?? null

    // Already there in the CRM (another PC of the same person moved them): no write, only the token.
    const alreadyThere = fromId === to.id
    if (alreadyThere && placed?.subscription.id === to.id) return { ok: false, reason: 'same', message: `You are already on ${to.name}.` }

    const preview = previewOf({ choices, fromId: fromId ?? '', toId, chats: [], allowed, note, now: now() })
    if ('error' in preview) return { ok: false, reason: 'unknown', message: preview.error }
    if (!alreadyThere && !preview.allowed) {
      const block = preview.warnings.find(w => w.severity === 'block')
      return { ok: false, reason: block?.code === 'not-allowed' ? 'not-allowed' : 'blocked', message: block?.message ?? 'That switch cannot be made.' }
    }
    // The rules against flipping back and forth guard the WRITE; fetching the token of where the CRM already has them is no write.
    if (opts.by === 'auto' && !alreadyThere) {
      const why = autoRefusal(to)
      if (why !== null) return { ok: false, reason: 'blocked', message: why }
    }

    // THE ONE WRITE: the person's own assignment, and nothing else.
    if (!alreadyThere) {
      let moved: Moved
      try {
        moved = await crm.moveMeTo(s, toId)
      } catch (e) {
        log.warn(`couldn't move ${s.user.name} to "${to.name}": ${message(e)}`)
        return { ok: false, reason: 'error', message: `The CRM didn't move you: ${message(e)}` }
      }
      if (moved.kind === 'expired') {
        endSession(s)
        return { ok: false, reason: 'expired', message: 'The CRM ended this session. Sign in again.' }
      }
      if (moved.kind === 'forbidden') {
        allowed = false
        note = moved.message
        return { ok: false, reason: 'not-allowed', message: moved.message }
      }
      if (moved.kind === 'refused') return { ok: false, reason: 'refused', message: moved.message }
    }

    // What the CRM now says, and the new subscription's token.
    const fromRef: SwitchSubscription = from ? refOf(from) : { id: '', name: 'no subscription', hint: null }
    const after = await crm.mySetting(s).catch(() => null)
    if (after && after.kind === 'ok') mine = after.value
    if (mine?.subscription && mine.subscription.id !== toId) {
      log.warn(`the CRM took the move to "${to.name}" but still shows ${s.user.name} on "${mine.subscription.name}"`)
      return { ok: false, reason: 'error', message: `The CRM accepted the move but still shows you on ${mine.subscription.name}. Check the CRM, then try again.` }
    }
    rememberCap()

    let token: Extract<SwitchResult, { ok: true }>['token'] = 'none'
    let detail = ''
    let cred: Credential
    try {
      cred = await crm.credential(s, build)
    } catch (e) {
      cred = { kind: 'none', code: null, message: `The CRM could not be asked for the token: ${message(e)}` }
      log.warn(`moved ${s.user.name} to "${to.name}", but couldn't fetch its token: ${message(e)}`)
    }
    const at = iso(now())
    if (cred.kind === 'ok' && cred.subscription.id.toLowerCase() === toId) {
      await place(cred, false)
      const value = current()
      token = !userEnv ? 'unsupported' : value === cred.token ? 'placed' : 'left-alone'
      lastCheck = { at, result: 'ok', message: null }
    } else if (cred.kind === 'expired') {
      endSession(s)
      detail = 'The CRM ended this session before it gave the token. Sign in again.'
    } else {
      // Moved, but no token for it (its share used up, it is turned off, ...): the CRM's word stands, as at every check.
      const why = cred.kind === 'none' ? cred.message : 'The CRM gave a different subscription than the one you were moved to.'
      await unplace(why)
      lastCheck = { at, result: 'none', message: why, code: cred.kind === 'none' ? cred.code : null }
      detail = why
    }

    const record: SwitchRecord = {
      at,
      by: opts.by,
      from: fromRef,
      to: refOf(to),
      why: scrub(alreadyThere ? `${opts.why} (the CRM already had you on it)` : opts.why),
      restarted: [],
      warnings: (opts.warnings ?? []).map(scrub),
    }
    const leftEnds = opts.leftResetsAt && Number.isFinite(Date.parse(opts.leftResetsAt)) ? opts.leftResetsAt : (from?.week?.resetsAt ?? null)
    store.update(st => {
      st.userId = s.user.id
      st.log.unshift(record)
      st.since = { subscriptionId: toId, at, by: opts.by }
      st.episode =
        opts.by === 'auto' && from
          ? { from: refOf(from), to: refOf(to), at, blockedUntil: leftEnds && Date.parse(leftEnds) > now() ? leftEnds : iso(now() + WEEK_MS) }
          : null
    })
    // The choices now: the new subscription is the active one.
    await readChoices(false)
    log.info(
      `switched Claude (${opts.by}) from "${fromRef.name}"${hintText(fromRef.hint)} to "${to.name}"${hintText(to.hint)}: ${record.why}` +
        (token === 'placed' ? '' : ` (token: ${token}${detail ? `; ${scrub(detail)}` : ''})`),
    )
    const message_ =
      token === 'placed'
        ? `Switched to ${to.name}.`
        : token === 'left-alone'
          ? `Moved to ${to.name} in the CRM. A CLAUDE_CODE_OAUTH_TOKEN something else set is still in place: replace it to run on ${to.name}.`
          : token === 'unsupported'
            ? `Moved to ${to.name} in the CRM. This PC can’t set CLAUDE_CODE_OAUTH_TOKEN.`
            : `Moved to ${to.name} in the CRM, but it gave no token: ${scrub(detail)}`
    return { ok: true, record, token, message: message_, detail: token === 'none' ? scrub(detail) : '' }
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
        if ((session && session.user.id !== next.user.id) || (store.state().userId !== null && store.state().userId !== next.user.id)) forgetSwitch()
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
        forgetSwitch()
        o.onChange()
        return status()
      }),

    refreshSwitch: (opts = {}) =>
      serial(async () => {
        busy = true
        o.onChange()
        try {
          await readChoices(opts.readings === true)
        } finally {
          busy = false
          o.onChange()
        }
        return status()
      }),

    previewSwitch: (to, chats) =>
      serial(async () => {
        if (!UUID.test(to)) return { error: 'That is not one of the office’s Claude subscriptions.' }
        if (!(await readChoices(true))) return { error: 'The CRM ended this session. Sign in again.' }
        o.onChange()
        const fromId = choices.find(c => c.active)?.id ?? mine?.subscription?.id ?? ''
        const toId = to.toLowerCase()
        // An account the CRM does not let change subscriptions cannot even list them: say why, in the CRM's words, as a blocked preview.
        if (allowed === false && !choices.some(c => c.id === toId)) {
          const from = mine?.subscription ? { id: mine.subscription.id, name: mine.subscription.name, hint: null } : { id: '', name: 'no subscription', hint: null }
          const why = note ?? 'The CRM only lets its super admin change which Claude subscription a person is on.'
          return {
            from,
            to: { id: toId, name: 'that subscription', hint: null },
            allowed: false,
            warnings: [{ code: 'not-allowed', severity: 'block', message: why }],
            chats,
            week: { from: null, to: null },
            cap: { from: null, to: null },
          }
        }
        return previewOf({ choices, fromId, toId, chats, allowed, note, now: now() })
      }),

    switchTo: (to, opts) =>
      serial(async () => {
        if (closed) return { ok: false, reason: 'error', message: 'The app is closing.' } satisfies SwitchResult
        busy = true
        o.onChange()
        try {
          return await doSwitch(to, opts)
        } catch (e) {
          log.warn(`a switch failed: ${message(e)}`)
          return { ok: false, reason: 'error', message: message(e) } satisfies SwitchResult
        } finally {
          busy = false
          o.onChange()
        }
      }),

    setAuto: on =>
      serial(async () => {
        store.update(s => {
          s.auto = on
        })
        log.info(`switching Claude subscriptions by itself is ${on ? 'on' : 'off'}`)
        o.onChange()
        return status()
      }),

    noteRestarted(at, names) {
      if (names.length === 0) return
      store.update(s => {
        const r = s.log.find(x => x.at === at)
        if (r) r.restarted = [...new Set([...r.restarted, ...names])]
      })
      o.onChange()
    },

    setWatch(w) {
      watch = w
      o.onChange()
    },

    setCheckHook(hook) {
      checkHook = hook
    },

    close() {
      closed = true
      checkHook = null
    },
  }
}
