import { readFileSync } from 'node:fs'
import type { AutoUpdateBlocker } from '../../shared/approvals.ts'
import { BUSY_LABEL, type BusyKind } from './procs.ts'

// F-173a: is it safe to restart the Server now? One pure function over what the app can see, FAIL-CLOSED: a signal that is missing,
// threw, or is older than it may be is a blocker, never "zero". The coordinator (coordinator.ts) gathers the inputs and re-reads them
// all in the same tick as the commit.
//
// What "quiet" means here, said plainly (the page repeats it): every chat is idle ON SCREEN (a screen reading, not a proof: a
// background task or a sub-agent can send while the prompt looks idle), nothing is waiting to be sent, no order is open, nothing is
// publishing or testing that this PC can see, and that stayed so for a while. It does NOT see a test started outside the app in that
// instant, or (until the bridge reports it) a bridge request in flight.

export interface ChatSeen {
  state: string
  /** The agent's name, for the words on the page. */
  name?: string
}

/** Fix other PCS's recovery receipt (its status.json): the watcher that reopens bridge chats after an Update. */
export interface RecoveryReceipt {
  phase: string
  lastPollAt: number
  expiresAt: number
  runningVersion: string
}

export interface QuietInputs {
  now: number
  /** The running build's version. */
  running: string | null
  /** The chat host has taken its chats over and recovery has reopened its list. */
  ready: boolean | null
  /** Every chat the hub knows of, on every PC it sees, by session. Null: unknown. */
  chats: Record<string, ChatSeen> | null
  /** Live chats with unsent text in their box. */
  drafts: number | null
  /** Open orders (an Assistant/agent order not yet answered). */
  orders: number | null
  /** Pending message deliveries (receipts not final). */
  deliveries: number | null
  /** A publish is running (state), or null when that is unknown. */
  publishing: boolean | null
  /** The kinds of work in the process table; null when the table could not be read in time. */
  busy: BusyKind[] | null
  /** When the process table was read (ms). */
  busyAt: number | null
  /** Bridge (Codex in Claude Code) chats that are live. Null: unknown. */
  bridge: string[] | null
  /** The recovery watcher's receipt, or null when it is not configured or not readable. */
  receipt: RecoveryReceipt | null
  /** Whether a receipt file is configured at all. */
  receiptConfigured: boolean
  /** The last CRM login check that failed or could not be answered (ms), when the bridge reports it; undefined: not wired; null: unknown. */
  crmFailureAt?: number | null
}

export const LIMITS = {
  /** The process table may be at most this old. */
  busyMaxAgeMs: 45_000,
  /** A CRM login check that failed this recently blocks (it can leave an open "uncertain"). */
  crmFailureMs: 3 * 60_000,
  /** The recovery watcher's last poll may be at most this old. */
  receiptPollMs: 60_000,
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Why the recovery watcher is not ready, or null when it is (Fix's READY rule: armed, polled under 60 s ago, not expired, same build). */
export function recoveryProblem(r: RecoveryReceipt | null, now: number, running: string | null): string | null {
  if (!r) return 'it is not reporting'
  if (r.phase !== 'armed') return `it is "${r.phase}", not armed`
  if (now - r.lastPollAt > LIMITS.receiptPollMs) return 'it has not looked for over a minute'
  if (r.expiresAt <= now) return 'it has expired'
  if (!running || r.runningVersion !== running) return 'it is watching another build'
  return null
}

/** What blocks the restart now. Empty: nothing the app can see. */
export function blockersOf(i: QuietInputs): AutoUpdateBlocker[] {
  const out: AutoUpdateBlocker[] = []
  const add = (code: string, label: string, count?: number) => out.push({ code, label, ...(count === undefined ? {} : { count }) })

  if (i.ready !== true) add(i.ready === null ? 'unknown-ready' : 'starting', i.ready === null ? 'the chats are not reporting' : 'the chats are still starting up')

  if (i.chats === null) add('unknown-chats', 'the chats are not reporting')
  else {
    const notIdle = Object.values(i.chats).filter(c => c.state !== 'idle')
    if (notIdle.length) {
      const names = notIdle.map(c => c.name).filter((n): n is string => !!n)
      const who = names.length ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and others' : ''} ${names.length === 1 ? 'is' : 'are'} working` : plural(notIdle.length, 'chat is working', 'chats are working')
      add('chat-busy', who, notIdle.length)
    }
  }

  if (i.drafts === null) add('unknown-drafts', 'unsent text in the chats cannot be checked')
  else if (i.drafts > 0) add('draft', plural(i.drafts, 'chat has unsent text in its box', 'chats have unsent text in their box'), i.drafts)

  if (i.orders === null) add('unknown-orders', 'open orders cannot be checked')
  else if (i.orders > 0) add('order-open', plural(i.orders, 'order is waiting for its answer', 'orders are waiting for their answer'), i.orders)

  if (i.deliveries === null) add('unknown-deliveries', 'pending messages cannot be checked')
  else if (i.deliveries > 0) add('delivery-pending', plural(i.deliveries, 'message is still being delivered', 'messages are still being delivered'), i.deliveries)

  if (i.publishing === null) add('unknown-publish', 'whether a publish is running cannot be checked')
  else if (i.publishing) add('publishing', 'a publish is running')

  if (i.busy === null || i.busyAt === null) add('unknown-processes', 'the running programs cannot be read')
  else if (i.now - i.busyAt > LIMITS.busyMaxAgeMs) add('stale-processes', 'the running programs were not read in time')
  else for (const k of i.busy) add(`proc-${k}`, `${BUSY_LABEL[k]} is running on this PC`)

  if (i.crmFailureAt === null) add('unknown-crm', 'the ChatGPT login check cannot be read')
  else if (i.crmFailureAt !== undefined && i.now - i.crmFailureAt < LIMITS.crmFailureMs) add('crm-check-failed', 'the ChatGPT login check failed a moment ago')

  // The bridge chats are reopened after the restart by the recovery watcher (Fix other PCS), not by the app: wait for it to be ready.
  if (i.bridge === null) add('unknown-bridge', 'bridge chats cannot be listed')
  else if (i.bridge.length) {
    const problem = i.receiptConfigured ? recoveryProblem(i.receipt, i.now, i.running) : 'it is not set up for the app to see'
    if (problem) add('recovery-not-ready', `${i.bridge.slice(0, 3).join(', ')} ${i.bridge.length === 1 ? 'is a bridge chat' : 'are bridge chats'}, and the recovery watcher that reopens them is not ready (${problem})`, i.bridge.length)
  }
  return out
}

/** The recovery watcher's receipt from a file (JSON: phase, lastPollAt, expiresAt, runningVersion, as ISO strings), or null when it can't be read. */
export function readReceipt(file: string): RecoveryReceipt | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as Record<string, unknown>
    const poll = typeof r.lastPollAt === 'string' ? Date.parse(r.lastPollAt) : NaN
    const exp = typeof r.expiresAt === 'string' ? Date.parse(r.expiresAt) : NaN
    if (typeof r.phase !== 'string' || typeof r.runningVersion !== 'string' || !Number.isFinite(poll) || !Number.isFinite(exp)) return null
    return { phase: r.phase, lastPollAt: poll, expiresAt: exp, runningVersion: r.runningVersion }
  } catch {
    return null
  }
}

/** What this check cannot see (the page says it every time). */
export function cannotSee(i: Pick<QuietInputs, 'crmFailureAt'>): string[] {
  return [
    'A chat counts as idle when its screen says so; a background task or helper agent can still be sending.',
    'A test or build started outside the app in the last seconds before the restart.',
    ...(i.crmFailureAt === undefined ? ['A bridge request in flight (the bridge does not report it yet).'] : []),
  ]
}
