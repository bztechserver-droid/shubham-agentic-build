import type { ChatImpact, SwitchPreview, SwitchRecord, SwitchRequest, SwitchSubscription, SwitchWatch } from '../../shared/claude-switch.ts'
import type { Logger } from '../log.ts'
import { restartByDefault } from './choices.ts'
import { USED_UP_CODES, type CheckHook, type ClaudeSubscription } from './index.ts'
import { inForce, isWeeklyLike, type LimitHit } from './limits.ts'

// Claude subscription failover: WHEN to move the person to the other subscription, and what to do
// for the chats when it happens. (HOW a move is made, and the rules that keep it from flipping back
// and forth, are claude/index.ts switchTo; what a limit row is, limits.ts.)
//
// The goal, as Shubham set it: stay on the subscription until its weekly limit runs out, then
// carry on on the other one automatically, and tell him. So:
//
//   WHAT COUNTS. Two kinds of news that the week is used up:
//     - a chat: claude's own refusal row in a chat's transcript (limits.ts), for a weekly window
//       (or one model's weekly window), newer than the token in use, still in force, on a chat that
//       holds the token in use. One chat saying so is a SUSPICION, not a reason: the sentence is
//       also what the account-wide limit looks like when other people used the week up, and a row
//       can be old or quoted. So it makes the app ask the CRM at once, and it switches when
//       - the CRM agrees (403 WEEKLY_CAP_REACHED or 409 SUBSCRIPTION_DISABLED), or
//       - a second chat says the same, or the same chat is refused again a minute later.
//     - the CRM alone (the hourly check): the same codes, twice, 40 seconds apart (the CRM caches a
//       person's cap for 30 s, and one odd answer must not move anyone).
//   The 5-hour "session" limit never switches by itself: it is back in hours and Office 2's week
//   would stay unused, against the goal. The page offers "Switch now" instead.
//   Anything else claude refuses for (credits, a spend cap) is not a week running out: ignored.
//
//   WHAT HAPPENS. One switch (index.ts switchTo, by 'auto'), then ONLY the chats that hit the
//   limit are restarted on the new token (their conversation is kept, bridge.restart) and told to
//   carry on (bridge.send), one after the other, then Lead is told. Chats that were still working
//   keep running; when one of them hits the limit later it is restarted the same way (it holds the
//   old token: that is not news about the new subscription, so it never causes a second switch).
//   If the other subscription is used up as well, or the account may not switch, the app stops and
//   says so plainly, in the page and to Lead (once, not every hour), and does nothing more until
//   the week it is waiting for is back. The CRM's own no then applies as it always did (the token
//   comes out).
//
//   SAFETY. Everything here runs from timers and events: an error in any of it is caught and
//   logged, never thrown (an uncaught error in the agent ends every chat). It does nothing at all
//   without a CRM session and a token the app itself put in. Texts hold names and the last four
//   characters of a token, nothing else.

/** A chat of this PC that has (or can have) a claude process. */
export interface BridgeChat {
  id: string
  /** The agent's name on its floor: "Web". */
  name: string
  floor: string | null
  state: 'idle' | 'working' | 'asking'
  /** When its claude process started (ISO): the token it holds is the one in place then. Null: not known. */
  startedAt: string | null
}

/** What failover needs of the chat runtime. */
export interface ChatBridge {
  /** The running chats on this PC. */
  chats(): BridgeChat[]
  /** Stops the chat's claude and starts it again on the token in place now, same conversation. Resolves true once it is up at its prompt. */
  restart(id: string): Promise<boolean>
  /** Types the text into the chat and submits it, once the chat is at its prompt. false: it couldn't. */
  send(id: string, text: string): Promise<boolean>
  /** Tells Lead (floor Final) in its chat. false: Lead's chat is not running. */
  tellLead(text: string): Promise<boolean>
}

/** claude wrote its limit refusal as a chat's latest row. */
export interface ChatLimit {
  chatId: string
  name: string
  hit: LimitHit
}

export interface SwitchOutcome {
  ok: boolean
  /** Plain words for the page. */
  message: string
  record?: SwitchRecord
  /** Names of the chats restarted and told to carry on. */
  restarted: string[]
  /** Names of the chats that could not be restarted. */
  failed: string[]
}

export type Schedule = (fn: () => void, ms: number) => () => void

export interface FailoverOptions {
  claude: ClaudeSubscription
  /** The chat runtime, once there is one (null: switch anyway, restart nothing). */
  bridge: () => ChatBridge | null
  log: Logger
  now?: () => number
  schedule?: Schedule
  /** Pause between one chat's restart and the next's (each resume reads the whole conversation, and spends the new subscription's limit). */
  restartGapMs?: number
}

export interface Failover {
  /** claude's own refusal showed up as the latest row of a chat. */
  limitHit(e: ChatLimit): void
  /** The chat wrote something that is not a limit refusal after one: it is working again. */
  chatMoved(chatId: string): void
  /** What a switch to `to` would do, with the running chats that would restart. Reads only. */
  preview(to: string): Promise<SwitchPreview | { error: string }>
  /** The person's own choice on the page. */
  switchNow(req: SwitchRequest): Promise<SwitchOutcome>
  /** Resolves when nothing is in flight (tests, shutdown). */
  idle(): Promise<void>
  stop(): void
}

/** After the CRM first says a week is used up, it is asked again this long after. */
export const RECHECK_MS = 40_000
/** Two sightings of the CRM's "used up" count only this far apart. */
export const CONFIRM_GAP_MS = 35_000
/** The same chat refused again this long after, is a second sign. */
export const RETRY_GAP_MS = 60_000
/** The CRM could not be asked when the app wanted to switch: it tries again this long after (at most 3 times). */
export const RETRY_AFTER_ERROR_MS = 5 * 60_000
const CRM_WINDOW_MS = 10 * 60_000
const EVIDENCE_KEEP_MS = 6 * 60 * 60_000
/** When it stops because everything is used up, it stays stopped until the week is back, or at most this long. */
const HALT_MS = 6 * 60 * 60_000

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return () => clearTimeout(t)
}
const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none')
const scopeOf = (hit: LimitHit) => hit.scope ?? (hit.kind === 'weekly' ? 'weekly limit' : 'limit')

/** What a chat is told after it is restarted on the new subscription. Names only. */
export function continueText(from: SwitchSubscription, to: SwitchSubscription, by: SwitchRecord['by'], why: string): string {
  return by === 'auto'
    ? `Your Claude subscription was switched from ${from.name} to ${to.name} because ${why}. Your conversation is kept. Please carry on where you left off.`
    : `Your Claude subscription was switched from ${from.name} to ${to.name}. Your conversation is kept; you were restarted. Please check where you were and carry on.`
}

/** What a chat that held an older token is told when it is restarted on the one in place. */
export function refreshedText(to: SwitchSubscription): string {
  return `You were restarted on the Claude subscription now in place (${to.name}), because the one you were running on hit its limit. Your conversation is kept. Please carry on where you left off.`
}

interface Evidence {
  chatId: string
  name: string
  at: number
  uuid: string | null
  scope: string
  resetsAt: string | null
}

interface Trigger {
  /** In words, for the log and the chats: "Office 2(Jagtap)’s weekly limit was reached (Web reported it)". */
  reason: string
  resetsAt: string | null
  /** How many times it has been tried again because the CRM could not be asked. */
  tries?: number
}

export function createFailover(o: FailoverOptions): Failover {
  const { claude, log } = o
  const now = o.now ?? Date.now
  const schedule = o.schedule ?? defaultSchedule
  const gap = o.restartGapMs ?? 2000

  /** Chats whose latest row is a limit refusal. */
  const hits = new Map<string, ChatLimit>()
  /** Weekly refusals seen on the token in use. */
  let evidence: Evidence[] = []
  let crmSightings: number[] = []
  let cancelRecheck: (() => void) | null = null
  let cancelRetry: (() => void) | null = null
  let switching = false
  /** A switch is scheduled but has not begun: a second reason for it, arriving now, is the same switch. */
  let pendingSwitch = false
  /** Counts the switches made, so a path that began before one and ends after it knows. */
  let switchGen = 0
  let stopped = false
  let haltedUntil = 0
  let lastStop: { message: string; at: number } | null = null
  let shown: SwitchWatch['state'] = 'watching'
  const running = new Set<Promise<unknown>>()

  /** Runs `fn` from an event or a timer: never throws, and is waited for by idle(). */
  function safe(what: string, fn: () => Promise<void> | void) {
    let p: Promise<void>
    try {
      p = Promise.resolve(fn())
    } catch (e) {
      p = Promise.reject(e)
    }
    const tracked: Promise<unknown> = p.catch(e => log.warn(`failover (${what}): ${message(e)}`)).finally(() => running.delete(tracked))
    running.add(tracked)
  }

  const sleep = (ms: number) => (ms <= 0 ? Promise.resolve() : new Promise<void>(r => void schedule(r, ms)))

  // ── what the page says ──────────────────────────────────────────────────────────────────────

  function setWatch(w: SwitchWatch) {
    shown = w.state
    claude.setWatch(w)
  }
  function watching() {
    shown = 'watching'
    claude.setWatch(null)
  }
  /** The page's offer ("Switch now") needs the subscriptions: read them when no page has. */
  async function ensureChoices() {
    const sw = claude.status().switch
    if (sw && sw.choices.length > 0 && sw.readAt !== null && now() - Date.parse(sw.readAt) < 10 * 60_000) return
    await claude.refreshSwitch()
  }
  /** The only other subscription the person could switch to now, if there is exactly one. */
  function otherChoice(): SwitchSubscription | undefined {
    const sw = claude.status().switch
    if (!sw || sw.allowed === false) return undefined
    const others = sw.choices.filter(c => !c.active && !c.disabled)
    return others.length === 1 ? { id: others[0].id, name: others[0].name, hint: others[0].hint } : undefined
  }
  const currentName = () => claude.status().switch?.current?.name ?? 'your subscription'

  /** A suspicion on the page, with the offer to switch by hand: published now, and again with the offer once the subscriptions are read (no page may have). */
  let lastSuspect: object | null = null
  function suspect(w: { message: string; chat?: string; resetsAt?: string | null }) {
    lastSuspect = w
    const publish = () => setWatch({ state: 'suspected', ...w, offer: otherChoice() })
    publish()
    const sw = claude.status().switch
    if (!sw || sw.choices.length === 0) {
      safe('read the subscriptions', async () => {
        await ensureChoices()
        if (shown === 'suspected' && lastSuspect === w) publish()
      })
    }
  }

  function purge() {
    const t = now()
    evidence = evidence.filter(e => t - e.at < EVIDENCE_KEEP_MS)
    crmSightings = crmSightings.filter(x => t - x < CRM_WINDOW_MS)
    for (const [id, h] of hits) if (!inForce(h.hit, t)) hits.delete(id)
  }

  function chatCorroborated(): boolean {
    const byChat = new Map<string, number[]>()
    for (const e of evidence) byChat.set(e.chatId, [...(byChat.get(e.chatId) ?? []), e.at])
    if (byChat.size >= 2) return true
    for (const times of byChat.values()) {
      times.sort((a, b) => a - b)
      if (times[times.length - 1] - times[0] >= RETRY_GAP_MS) return true
    }
    return false
  }

  /** Why, in words: what told the app. `crm` is the CRM's code when it said so. */
  function triggerOf(crm: { code: string | null } | null): Trigger {
    const cur = currentName()
    const who = [...new Set(evidence.map(e => e.name))].join(' and ')
    const last = evidence.length ? evidence[evidence.length - 1] : null
    const ends = evidence.map(e => e.resetsAt).filter((x): x is string => x !== null).sort().pop() ?? null
    if (crm?.code === 'SUBSCRIPTION_DISABLED') return { reason: `${cur} was turned off in the CRM${who ? ` (${who} was refused too)` : ''}`, resetsAt: null }
    if (crm && last) return { reason: `${cur}’s ${last.scope} was reached (${who} reported it and the CRM agreed)`, resetsAt: ends }
    if (crm) return { reason: `your weekly share of ${cur} was used up (the CRM said so twice)`, resetsAt: null }
    return { reason: `${cur}’s ${last?.scope ?? 'weekly limit'} was reached (${who} reported it)`, resetsAt: ends }
  }

  // ── telling people ──────────────────────────────────────────────────────────────────────────

  async function tellLead(text: string) {
    const b = o.bridge()
    if (!b) return
    try {
      if (!(await b.tellLead(text))) log.info('Lead’s chat is not running: it was not told about the Claude switch')
    } catch (e) {
      log.warn(`couldn't tell Lead: ${message(e)}`)
    }
  }

  function leadText(r: SwitchRecord, restarted: string[], failed: string[], left: string[], extra: string[]): string {
    const tail = (s: SwitchSubscription) => `${s.name}${s.hint ? ` (…${s.hint})` : ''}`
    return [
      `[Claude subscriptions] Switched ${r.by === 'auto' ? 'by itself' : 'by hand'}: ${tail(r.from)} → ${tail(r.to)}.`,
      `Why: ${r.why}.`,
      `Restarted and told to carry on: ${list(restarted)}.${failed.length ? ` Could not restart or tell to carry on:${failed.join(', ')}.` : ''}`,
      `Still running on the old token (each picks up the new one when it is restarted): ${list(left)}.`,
      ...extra,
      'No reply needed.',
    ].join('\n')
  }

  /**
   * The app stops switching, and says why: on the page, and once to Lead (not again every hour for
   * the same thing). `tell` false: the caller tells Lead itself, in one message with the rest.
   */
  async function stopWith(msg: string, resetsAt: string | null = null, tell = true) {
    const t = now()
    haltedUntil = resetsAt !== null && Date.parse(resetsAt) > t ? Date.parse(resetsAt) : t + HALT_MS
    setWatch({ state: 'stopped', message: msg, resetsAt })
    log.info(`failover stopped: ${msg}`)
    const same = lastStop !== null && lastStop.message === msg && t - lastStop.at < HALT_MS
    lastStop = { message: msg, at: t }
    // The CRM's own no still applies as it always did: if it is the CRM that says the week is used up, the token comes out now.
    safe('apply the CRM’s answer', async () => void (await claude.check()))
    if (tell && !same) await tellLead(`[Claude subscriptions] Not switching: ${msg}\nNo reply needed.`)
  }

  // ── restarting the chats ────────────────────────────────────────────────────────────────────

  /** Restarts each chat on the token now in place and tells it to carry on, one after the other. */
  async function recover(ids: string[], text: string): Promise<{ ok: string[]; failed: string[] }> {
    const b = o.bridge()
    const ok: string[] = []
    const failed: string[] = []
    if (!b) return { ok, failed }
    const byId = new Map(b.chats().map(c => [c.id, c]))
    let first = true
    for (const id of ids) {
      const chat = byId.get(id)
      if (!chat) continue // not running any more: nothing to restart
      if (!first) await sleep(gap)
      first = false
      try {
        if (!(await b.restart(id))) throw new Error('it did not come back up')
        if (!(await b.send(id, text))) throw new Error('it could not be told to carry on')
        hits.delete(id)
        ok.push(chat.name)
      } catch (e) {
        log.warn(`couldn't restart chat ${chat.name} on the new subscription: ${message(e)}`)
        failed.push(chat.name)
      }
    }
    return { ok, failed }
  }

  /** The chats that are stuck on a limit refusal right now and still running. */
  function stuckIds(): string[] {
    purge()
    const up = new Set((o.bridge()?.chats() ?? []).map(c => c.id))
    return [...hits.keys()].filter(id => up.has(id))
  }

  // ── switching by itself ─────────────────────────────────────────────────────────────────────

  async function autoSwitch(t: Trigger) {
    if (switching || stopped) return
    switching = true
    try {
      setWatch({ state: 'switching', message: 'Switching to the other Claude subscription…' })
      await claude.refreshSwitch({ readings: true })
      const sw = claude.status().switch!
      if (sw.allowed === null) return retryLater(t, 'the CRM could not be asked just now')
      if (sw.allowed === false) {
        return await stopWith(`${sw.note ?? 'The CRM only lets its super admin change which Claude subscription a person is on.'} Chats stay on ${currentName()}.`)
      }
      const cur = sw.choices.find(c => c.active)
      const others = sw.choices.filter(c => !c.active && !c.disabled)
      if (!cur) return await stopWith('The CRM does not say which Claude subscription you are on, so there is nothing to switch from.')
      if (others.length === 0) return await stopWith(`There is no other Claude subscription to switch to: ${cur.name} is used up.`, cur.week?.resetsAt ?? null)
      if (others.length > 1) {
        return await stopWith(`${cur.name} is used up, and there is more than one other Claude subscription (${others.map(x => x.name).join(', ')}). Choose one yourself on the page.`)
      }
      const target = others[0]
      const stuck = stuckIds()
      const r = await claude.switchTo(target.id, { by: 'auto', why: t.reason, leftResetsAt: t.resetsAt ?? cur.week?.resetsAt ?? null })
      if (!r.ok) {
        if (r.reason === 'blocked') return await stopWith(`Both Claude subscriptions are used up: ${cur.name} is, and for ${target.name}: ${r.message} Nothing was switched.`, cur.week?.resetsAt ?? null)
        // The CRM did not answer: not a reason to stop for hours; try again in a few minutes.
        if (r.reason === 'error') return retryLater(t, r.message)
        return await stopWith(`Could not switch from ${cur.name} to ${target.name}: ${r.message}`)
      }
      switchGen++
      evidence = []
      crmSightings = []
      const { ok, failed } = r.token === 'placed' ? await recover(stuck, continueText(r.record.from, r.record.to, 'auto', t.reason)) : { ok: [] as string[], failed: [] as string[] }
      claude.noteRestarted(r.record.at, ok)
      const left = (o.bridge()?.chats() ?? []).filter(c => !ok.includes(c.name)).map(c => c.name)
      const extra: string[] = []
      const cap = claude.status().switch?.choices.find(c => c.id === target.id)?.cap
      if (cap && cap.known !== 'seen') {
        extra.push(`Heads-up: Shubham’s weekly cap on ${target.name} is ${Math.round(cap.percent * 10) / 10}%${cap.source === 'default' ? ' (the subscription’s default)' : ''}; once it is used the CRM stops handing out the token.`)
      }
      if (r.token !== 'placed' && r.token !== 'none') extra.push(`The new token is NOT in place: ${r.message}`)
      if (r.token === 'none') {
        // Moved, and the CRM gives no token there either: one message to Lead, with everything in it.
        const both = `Both Claude subscriptions are used up: ${cur.name} is, and the CRM gives no token for ${target.name}: ${r.detail}`
        extra.push(`${both} Claude stays off until one of them has its week back.`)
        await stopWith(both, cur.week?.resetsAt ?? null, false)
      } else {
        setWatch({ state: 'watching', message: `Switched to ${target.name} by itself.` })
        log.info(`failover: ${r.record.why}; restarted ${list(ok)}`)
      }
      await tellLead(leadText(r.record, ok, failed, left, extra))
    } finally {
      switching = false
    }
  }

  /** The CRM could not be asked: say so on the page (nothing is announced), and try again soon, a few times. */
  function retryLater(t: Trigger, why: string) {
    const tries = t.tries ?? 0
    suspect({ message: `${currentName()} looks used up, but ${why.replace(/\.$/, '')}, so the app cannot switch yet.${tries < 3 ? ' It will try again in a few minutes.' : ''}` })
    log.info(`failover: could not switch yet (${why}); try ${tries + 1}`)
    if (tries >= 3) return
    cancelRetry?.()
    cancelRetry = schedule(() => {
      cancelRetry = null
      startSwitch({ ...t, tries: tries + 1 })
    }, RETRY_AFTER_ERROR_MS)
  }

  /** The CRM and/or the chats say the week is used up: switch, unless one of the safeguards in switchTo says no. Two reasons at once are one switch. */
  function startSwitch(t: Trigger) {
    if (pendingSwitch || switching) return
    pendingSwitch = true
    cancelRecheck?.()
    cancelRecheck = null
    schedule(() => {
      pendingSwitch = false
      safe('switch', () => autoSwitch(t))
    }, 0)
  }

  // ── the CRM answered ────────────────────────────────────────────────────────────────────────

  const onCheck: CheckHook = outcome => {
    if (stopped) return
    if (outcome.result === 'ok') {
      crmSightings = []
      return
    }
    if (outcome.result !== 'none' || !outcome.code || !USED_UP_CODES.has(outcome.code)) return
    const t = now()
    // Stopped because everything is used up, or the account may not switch: the CRM's no applies as it always did.
    if (t < haltedUntil) return 'proceed'
    const sw = claude.status().switch
    if (!sw || !sw.auto || sw.allowed === false) return 'proceed'
    if (switching) return 'hold'
    purge()
    crmSightings.push(t)
    const confirmed = evidence.length > 0 || (crmSightings.length >= 2 && t - crmSightings[0] >= CONFIRM_GAP_MS)
    if (confirmed) {
      startSwitch(triggerOf({ code: outcome.code }))
      return 'hold'
    }
    // One answer is not enough: ask again in 40 seconds.
    suspect({ message: `The CRM says ${currentName()}’s week is used up. Asking again in a moment before switching.` })
    cancelRecheck?.()
    cancelRecheck = schedule(() => {
      cancelRecheck = null
      safe('ask the CRM again', async () => {
        await claude.check()
        const c = claude.status().check
        if (!(c?.result === 'none' && c.code && USED_UP_CODES.has(c.code)) && shown === 'suspected' && hits.size === 0) watching()
      })
    }, RECHECK_MS)
    return 'hold'
  }
  claude.setCheckHook(onCheck)

  // ── a chat said so ──────────────────────────────────────────────────────────────────────────

  async function onLimit(e: ChatLimit) {
    if (stopped) return
    const gen = switchGen
    const st = claude.status()
    if (!st.crm) return // nobody signed in: nothing here is ours
    if (st.token !== 'set' || !st.subscription) return // not a token this app put in
    const t = now()
    const hitAt = e.hit.at ? Date.parse(e.hit.at) : NaN
    const placedAt = Date.parse(st.subscription.setAt)
    if (!(hitAt >= placedAt)) return // older than the token in use, or undated
    if (!inForce(e.hit, t)) return
    purge()
    hits.set(e.chatId, e)

    // A chat started before the token in use holds an older one: that says nothing about this subscription. Restart it, nothing more.
    const chat = o.bridge()?.chats().find(c => c.id === e.chatId)
    if (chat?.startedAt && Date.parse(chat.startedAt) < placedAt) {
      log.info(`chat ${e.name} hit a limit on an older token: restarting it on ${st.subscription.name}`)
      const r = await recover([e.chatId], refreshedText({ id: st.subscription.id, name: st.subscription.name, hint: st.subscription.hint }))
      if (r.ok.length) await tellLead(`[Claude subscriptions] Chat ${r.ok.join(', ')} hit a limit on the old token and was restarted on ${st.subscription.name}.\nNo reply needed.`)
      return
    }
    if (t < haltedUntil) return // stopped: everything is used up, or the account may not switch

    if (e.hit.kind === 'session') {
      suspect({
        chat: e.name,
        resetsAt: e.hit.resetsAt,
        message: `Chat ${e.name} hit the 5-hour limit on ${currentName()}. It is back in a few hours, so the app does not switch by itself for it.`,
      })
      return
    }
    if (!isWeeklyLike(e.hit)) {
      log.info(`chat ${e.name} was refused for a limit that is not a week running out (${e.hit.scope ?? 'unknown'}): ignored`)
      return
    }
    if (!e.hit.uuid || !evidence.some(x => x.uuid === e.hit.uuid)) {
      evidence.push({ chatId: e.chatId, name: e.name, at: hitAt, uuid: e.hit.uuid, scope: scopeOf(e.hit), resetsAt: e.hit.resetsAt })
    }
    if (st.switch && !st.switch.auto) {
      suspect({ chat: e.name, resetsAt: e.hit.resetsAt, message: `Chat ${e.name} hit ${currentName()}’s ${scopeOf(e.hit)}. Switching by itself is turned off.` })
      return
    }

    // Ask the CRM now; if it agrees, onCheck has started the switch.
    await claude.check()
    // A switch begun (or made) while the CRM was being asked has dealt with this refusal.
    if (switching || pendingSwitch || stopped || t < haltedUntil || switchGen !== gen) return
    if (chatCorroborated()) {
      startSwitch(triggerOf(null))
      return
    }
    suspect({
      chat: e.name,
      resetsAt: e.hit.resetsAt,
      message: `Chat ${e.name} says ${currentName()}’s ${scopeOf(e.hit)} is reached, but the CRM does not say so and no second chat does. Waiting for a second sign before switching.`,
    })
  }

  // ── by hand ─────────────────────────────────────────────────────────────────────────────────

  function impacts(): ChatImpact[] {
    purge()
    return (o.bridge()?.chats() ?? []).map(c => {
      const hitLimit = hits.has(c.id)
      return { id: c.id, name: c.name, floor: c.floor, state: c.state, hitLimit, restartByDefault: restartByDefault({ state: c.state, hitLimit }) }
    })
  }

  return {
    limitHit(e) {
      safe('limit', () => onLimit(e))
    },

    chatMoved(chatId) {
      if (!hits.delete(chatId)) return
      evidence = evidence.filter(e => e.chatId !== chatId)
      if (hits.size === 0 && !switching && shown === 'suspected') watching()
    },

    preview: to => claude.previewSwitch(to, impacts()),

    async switchNow(req) {
      const fail = (m: string): SwitchOutcome => ({ ok: false, message: m, restarted: [], failed: [] })
      if (stopped) return fail('The app is closing.')
      if (switching) return fail('A switch is already in progress.')
      switching = true
      try {
        const p = await claude.previewSwitch(req.to, impacts())
        if ('error' in p) return fail(p.error)
        if (!p.allowed) return fail(p.warnings.find(w => w.severity === 'block')?.message ?? 'That switch cannot be made.')
        const who = claude.status().crm?.name ?? 'The person signed in'
        const r = await claude.switchTo(req.to, { by: 'manual', why: `${who} chose it on the page`, warnings: p.warnings.filter(w => w.severity === 'warn').map(w => w.message) })
        if (!r.ok) return fail(r.message)
        switchGen++
        evidence = []
        crmSightings = []
        haltedUntil = 0
        lastStop = null
        cancelRecheck?.()
        cancelRecheck = null
        cancelRetry?.()
        cancelRetry = null
        const ids = r.token === 'placed' ? req.restart.filter(id => p.chats.some(c => c.id === id)) : []
        const { ok, failed } = await recover(ids, continueText(r.record.from, r.record.to, 'manual', ''))
        claude.noteRestarted(r.record.at, ok)
        watching()
        const left = (o.bridge()?.chats() ?? []).filter(c => !ok.includes(c.name)).map(c => c.name)
        await tellLead(leadText(r.record, ok, failed, left, r.token === 'placed' ? [] : [`The new token is NOT in place: ${r.message}`]))
        const tail = ok.length ? ` Restarted and told to carry on: ${list(ok)}.` : ''
        const bad = failed.length ? ` Could not restart or tell to carry on:${failed.join(', ')}.` : ''
        return { ok: true, message: `${r.message}${tail}${bad}`, record: r.record, restarted: ok, failed }
      } finally {
        switching = false
      }
    },

    async idle() {
      while (running.size > 0) await Promise.allSettled([...running])
    },

    stop() {
      stopped = true
      cancelRecheck?.()
      cancelRecheck = null
      cancelRetry?.()
      cancelRetry = null
      claude.setCheckHook(null)
    },
  }
}
