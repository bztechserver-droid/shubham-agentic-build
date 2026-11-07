import type { ChatImpact, SwitchCap, SwitchChoice, SwitchPreview, SwitchWarning, SwitchWeek } from '../../shared/claude-switch.ts'
import type { CrmReadings, CrmSetting, CrmSubscriptions } from './crm.ts'

// What the page shows about the office's Claude subscriptions, and what it warns about before a
// switch (Claude subscription failover). Pure: the CRM's answers in, the page's shapes out.
//
// The person's weekly CAP is the one thing the CRM will not read out for a subscription they are
// not on: GET /v1/org/model-settings/me answers it for the one they run on, and the subscriptions
// list gives each one's DEFAULT cap, but a cap set for them on the other one lives in a table
// nothing reads back (sam-crm-be lib/weeklyCap.js capFor; the usage overview only computes it for
// each person's current subscription). So the app shows, for the other one, what it last saw
// there, and failing that the default, and says which it is.

const DAY = 24 * 60 * 60 * 1000

/** What the app last saw of the person's cap on a subscription (kept in claude-switch.json). */
export interface SeenCap {
  percent: number
  source: 'person' | 'default'
  usedPercent: number | null
  over: boolean
  /** The week it was seen in ends then: an "over" is only true until it does. */
  weekResetsAt: string | null
  at: string
}
export type SeenCaps = Record<string, SeenCap>

/** Standing for "no subscription" as the place a switch starts from. */
const NONE: SwitchChoice = { id: '', name: 'no subscription', hint: null, active: false, disabled: false, week: null, cap: null }

const round1 = (n: number) => Math.round(n * 10) / 10
const pct = (n: number) => `${round1(n)}%`

export function weekOf(r: CrmReadings | undefined): SwitchWeek | null {
  if (!r) return null
  const w = r.week
  if (w.percent === null && w.resetsAt === null) return null
  return { percent: w.percent, resetsAt: w.resetsAt, observedAt: w.observedAt, stale: w.stale }
}

/** What to keep of the cap the CRM just told, for the day the person is on the other subscription. */
export function seenCapOf(mine: CrmSetting | null, now: number): { id: string; seen: SeenCap } | null {
  const sub = mine?.subscription
  const cap = mine?.weeklyCap
  if (!sub || !cap) return null
  return {
    id: sub.id,
    seen: {
      percent: cap.capPercent,
      source: cap.capSource === 'person' ? 'person' : 'default',
      usedPercent: cap.usedPercent,
      over: cap.over,
      weekResetsAt: cap.weekResetsAt,
      at: new Date(now).toISOString(),
    },
  }
}

/** The person's cap on subscription `id`: the CRM's answer now, what the app saw there, or the default. */
function capOn(id: string, defaultPercent: number | null, mine: CrmSetting | null, seen: SeenCaps, now: number): SwitchCap | null {
  const cap = mine?.weeklyCap
  if (mine?.subscription?.id === id && cap) {
    return {
      percent: cap.capPercent,
      source: cap.capSource === 'person' ? 'person' : 'default',
      known: 'now',
      usedPercent: cap.usedPercent,
      over: cap.over,
      at: new Date(now).toISOString(),
    }
  }
  const was = seen[id]
  if (was) {
    // An "over" belongs to the week it was seen in.
    const sameWeek = was.weekResetsAt !== null && Date.parse(was.weekResetsAt) > now
    return { percent: was.percent, source: was.source, known: 'seen', usedPercent: sameWeek ? was.usedPercent : null, over: was.over && sameWeek, at: was.at }
  }
  if (defaultPercent === null) return null
  return { percent: defaultPercent, source: 'default', known: 'default', usedPercent: null, over: false, at: null }
}

/** The picker's rows: every subscription of the office, the active one marked. */
export function buildChoices(i: {
  list: CrmSubscriptions
  readings: Record<string, CrmReadings> | null
  mine: CrmSetting | null
  seen: SeenCaps
  now: number
}): SwitchChoice[] {
  const activeId = i.mine?.subscription?.id ?? null
  // F-138: an API key has no weekly limit to run out of and costs money per use, so it is never offered as somewhere to switch to (the super admin puts a person on one in the CRM).
  return i.list.subscriptions
    .filter(s => s.kind !== 'api_key')
    .map(s => ({
    id: s.id,
    name: s.name,
    hint: s.hint,
    active: s.id === activeId,
    disabled: s.disabled,
    week: weekOf(i.readings?.[s.id]),
    cap: capOn(s.id, s.defaultCapPercent, i.mine, i.seen, i.now),
  }))
}

/** `at` is more than a day old: a reading the CRM has had no news of since. */
const old = (w: SwitchWeek | null, now: number) => w !== null && w.observedAt !== null && now - Date.parse(w.observedAt) > DAY

/** Has the week of this subscription been used up completely, with its end still ahead? */
export function weekUsedUp(w: SwitchWeek | null, now: number): boolean {
  return w !== null && w.percent !== null && w.percent >= 100 && w.resetsAt !== null && Date.parse(w.resetsAt) > now
}

/**
 * What switching from `fromId` to `toId` would do, and what the person should hear first. Nothing
 * here changes anything. A warning that 'block's means it cannot be made; the others are told, and
 * the person decides.
 */
export function previewSwitch(i: {
  choices: SwitchChoice[]
  fromId: string
  toId: string
  chats: ChatImpact[]
  /** This account may change its own subscription in the CRM (null: not known). */
  allowed: boolean | null
  note: string | null
  now: number
}): SwitchPreview | { error: string } {
  // fromId '': on no subscription at all (the CRM gives none): a move from there is a plain "use this one".
  const from = i.fromId === '' ? NONE : i.choices.find(c => c.id === i.fromId)
  const to = i.choices.find(c => c.id === i.toId)
  if (!from) return { error: 'Not on any of the office’s Claude subscriptions right now: nothing to switch from.' }
  if (!to) return { error: 'That is not one of the office’s Claude subscriptions.' }
  const w: SwitchWarning[] = []
  const warn = (code: SwitchWarning['code'], severity: SwitchWarning['severity'], message: string) => void w.push({ code, severity, message })

  if (i.allowed === false) {
    warn('not-allowed', 'block', i.note ?? 'The CRM only lets its super admin change which Claude subscription a person is on.')
  }
  if (to.id === from.id) warn('same', 'block', `You are already on ${to.name}.`)
  if (to.disabled) warn('disabled', 'block', `${to.name} is turned off in the CRM, so it will not put anyone on it. The super admin can turn it back on.`)

  if (to.id !== from.id && !to.disabled) {
    if (weekUsedUp(to.week, i.now)) {
      warn('target-used-up', 'warn', `${to.name} has used all of its week (by the last reading). Claude there will stop you until the week resets.`)
    } else if (old(to.week, i.now) && to.week?.percent !== null) {
      warn('stale-reading', 'warn', `The last reading of ${to.name}’s week is more than a day old, so it may be fuller than ${pct(to.week!.percent!)} now.`)
    }
    const cap = to.cap
    if (cap?.over) {
      warn('cap-over', 'warn', `You have already used your share of ${to.name}’s week (${pct(cap.usedPercent ?? cap.percent)} of the ${pct(cap.percent)} the CRM allows you). The CRM would not hand you its token until the week resets or the cap is raised.`)
    } else if (cap && from.cap && cap.percent < from.cap.percent) {
      const where = cap.known === 'default' ? ' (that is its default; the CRM may have set one for you there, but the app can only read it while you are on it)' : ''
      warn(
        'low-cap',
        'warn',
        `Your weekly cap on ${to.name} is ${pct(cap.percent)}${where}, lower than the ${pct(from.cap.percent)} you have on ${from.name}. Once you have used that share the CRM stops handing you the token. The CRM’s super admin can raise it (Code → Usage).`,
      )
    } else if (!cap) {
      warn('cap-unknown', 'warn', `The app can’t tell what your weekly cap is on ${to.name}. If it is low, the CRM stops handing you its token once you have used that share.`)
    }
  }

  const blocked = w.some(x => x.severity === 'block')
  return {
    from: { id: from.id, name: from.name, hint: from.hint },
    to: { id: to.id, name: to.name, hint: to.hint },
    allowed: !blocked,
    warnings: w,
    chats: i.chats,
    week: { from: from.week, to: to.week },
    cap: { from: from.cap, to: to.cap },
  }
}

/** The page ticks a chat to restart when it hit the limit or is idle; a chat in the middle of a turn is left to the person. */
export const restartByDefault = (c: { state: ChatImpact['state']; hitLimit: boolean }) => c.hitLimit || c.state === 'idle'
