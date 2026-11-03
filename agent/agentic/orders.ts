import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isOrchestratorAgent, type AgentDuty } from '../../shared/agentic.ts'
import { writeAtomic } from '../config.ts'

// F-072: every agent answers the overlay Assistant, and the app does it, not the agents' goodwill.
// An order is a message the Assistant sends to another agent's chat. The app records it, marks the
// message with the order's id (so the agent's transcript shows exactly where its work on it began),
// and when that agent's turn ends it takes the turn's final text and types it into the Assistant's
// chat as "[reply from <Agent> on <Floor> to order <id>] ...". The rules that keep it from looping:
//   - exactly one reply per order (an order is gone once its reply is delivered);
//   - a reply is never an order: it opens none, and is never relayed back to the agent;
//   - an Assistant message that is only an acknowledgement ("ok", "thanks") opens no order;
//   - only the Assistant's own messages open orders (an agent writing to the Assistant does not);
//   - replies go to the Assistant's chat only, never broadcast.

/**
 * The overlay chat, by its OLD NAME: the agent called Assistant on the floor called Assistant. F-086: the hub no longer decides by this (it
 * gives that chat a duty once, floors.ts ensureDuty, so it can be renamed); it is kept for what has no agent object to look at.
 */
export const isAssistantAgent = (floorName: string, agentName: string) => floorName.trim().toLowerCase() === 'assistant' && agentName.trim().toLowerCase() === 'assistant'

/**
 * F-084 H2: who may use Shubham's phone (phone_screen, phone_control, phone_update): the Assistant, and the Mobile agent's chat, the
 * agent called Mobile on the floor called Final, which builds and tries the phone app. Null for everyone else. The name goes with each
 * command (`by`) to the phone's action log and its notification.
 */
export const phoneUser = (floorName: string, who: string | { name: string; duty?: AgentDuty }): 'assistant' | 'mobile' | null => {
  const floor = floorName.trim().toLowerCase()
  const agentName = typeof who === 'string' ? who : who.name
  const agent = agentName.trim().toLowerCase()
  // F-086: given the agent itself, the overlay chat is the one with the Orchestrator duty, whatever it is called; given a bare name, the old name.
  if (typeof who === 'string' ? isAssistantAgent(floorName, who) : isOrchestratorAgent(floorName, who)) return 'assistant'
  return floor === 'final' && agent === 'mobile' ? 'mobile' : null
}

/** What is only a "thank you / got it": it asks for nothing, so it opens no order. A real instruction ("do it", "ok now fix X") is never all of these words. */
const ACK_ONLY = /^(?:(?:ok|okay|k|kk|thanks|thank you|thx|ty|got it|noted|understood|roger|great|perfect|cool|nice|good|fine|sure|done|ack|acknowledged|will do|sounds good|👍|🙏|✅)\s*)+$/u

export function isAcknowledgement(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.,!:;)-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return true
  return t.length <= 40 && ACK_ONLY.test(t)
}

/** What a reply starts with; also what an order never is. */
export const REPLY_PREFIX = '[reply from '
export const isReply = (text: string) => text.trimStart().startsWith(REPLY_PREFIX)

export interface OrderTarget {
  sessionId: string
  agent: string
  floor: string
}

/** F-087: the id the fast Assistant (a warm process, not a chat) has as the giver of an order. */
export const FAST_FROM = 'fast'

/** F-087: where a hand-off was asked, so its answer lands there even after the fast process restarted. */
export interface OrderOrigin {
  kind: 'web' | 'phone'
  /** The tab or the device that asked. */
  client?: string
  /** The ask (and its turn) that became the hand-off. */
  askId?: string
}

/** Where a hand-off is, as the clients show it (shared/fast.ts HandoffPhase). */
export type OrderPhase = 'queued' | 'typed' | 'working' | 'waiting-you' | 'slow' | 'not-taken'

/** F-087: a progress line for a hand-off: at 10 s, 60 s, and every 5 minutes after, while it is not answered. */
export interface OrderProgress {
  orderId: string
  phase: OrderPhase
  sec: number
  words?: string
  origin?: OrderOrigin
}

/** F-087: what the fast Assistant's session (fast.ts) gets from the hub for hand-offs. */
export type HandOffResult = { ok: true; orderId: string; phase: 'typed' | 'queued' } | { ok: false; status: number; reason: string }

export interface OrderView {
  orderId: string
  /** False: no such order any more (it was answered, or never existed). */
  open: boolean
  phase?: OrderPhase
  sec?: number
  gist?: string
  words?: string
}

export interface HandoffApi {
  /** Hands `text` to the Orchestrator as an order from the fast Assistant. `sender` is how the message names its giver ("the Assistant"). Never types at a prompt or over a draft (409, at once). */
  handOff(text: string, origin: OrderOrigin, sender?: string): Promise<HandOffResult>
  status(orderId: string): OrderView
  /** Stop (Esc into the Orchestrator); its reply says cancelled. */
  cancel(orderId: string): Promise<boolean>
  /** The session registers where answers and progress go. `onReturn` returns true when it took the answer (shown, spoken or kept); false and the reply waits. */
  listen(l: { onReturn?: (order: Order, text: string) => Promise<boolean>; onProgress?: (p: OrderProgress) => void }): void
}

export interface Order {
  id: string
  /** The chat that gave it: the overlay chat's session id, or FAST_FROM for a hand-off from the fast Assistant. */
  from: string
  /** F-087: 'handoff' when the giver is the fast Assistant (its answer goes back to that process and to `origin`, not into a terminal). */
  kind?: 'order' | 'handoff'
  origin?: OrderOrigin
  /** F-087: the chat was not running when it was handed off; it was started and the message is typed when it is ready. */
  queued?: boolean
  /** F-087: stopped on purpose; its reply says so. */
  cancelled?: boolean
  /** F-087: how many progress lines were sent (the next one's time is derived from it). */
  progressSent?: number
  to: OrderTarget
  /** When it was given (ms). */
  at: number
  /** The first words of the order, for the reply's own reference. */
  gist: string
  /** Its reply is made and waits for the Assistant's chat to take it (the Assistant was not running). */
  pending?: string
  /** Delivery was tried this many times. */
  tries?: number
}

/** What the app can see of a target's transcript for one order. */
export interface Scan {
  /** The order's message is in the transcript: the agent has taken it up. */
  started: boolean
  /** The agent's last written text for that turn ('' when it wrote none). */
  answer: string
}

/**
 * Where an order began in a transcript and what the agent wrote after it: the order's message carries
 * ", order <id>]"; the answer is the last text the agent wrote before anything else was said to it.
 */
export function scanMessages(msgs: { role: string; text: string }[], id: string, word = 'order'): Scan {
  const mark = `, ${word} ${id}]`
  let at = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && msgs[i].text.includes(mark)) {
      at = i
      break
    }
  }
  if (at < 0) return { started: false, answer: '' }
  let answer = ''
  for (let i = at + 1; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role === 'user') {
      if (m.text.trim()) break
      continue
    }
    if (m.text.trim()) answer = m.text.trim()
  }
  return { started: true, answer }
}

export type ChatNow = 'running' | 'question' | 'idle' | undefined

export interface OrderDeps {
  now(): number
  /** What a chat is doing now: undefined when it isn't running anywhere. */
  stateOf(sessionId: string): ChatNow
  /** The target's transcript, for this order. */
  scan(sessionId: string, orderId: string): Scan
  /** Types `text` into the Assistant's chat; false when that chat isn't running. For a hand-off (`from` is FAST_FROM) it is the fast Assistant's return path instead: nothing is typed anywhere. */
  deliver(assistantSessionId: string, text: string, order: Order): Promise<boolean>
  /** F-087: told of a hand-off's progress (10 s, 60 s, then every 5 minutes). */
  progress?(p: OrderProgress): void
  /** F-087: the words the target chat's spinner shows now ("Cooking…"), when it shows any. */
  words?(sessionId: string): string | undefined
  /** F-087: Esc into the target's chat (Stop); false when it was not possible. */
  interrupt?(sessionId: string): boolean
  file?: string
  log?: { info(m: string): void; warn(m: string): void }
}

/** An agent that has gone quiet this long without ever taking the order is told to be unreachable. */
export const NOT_TAKEN_MS = 120_000
/** An order still unanswered after this long gets a reply saying so. */
export const GIVE_UP_MS = 3 * 60 * 60_000
/** A reply the Assistant's chat could not take is kept this long. */
export const KEEP_REPLY_MS = 60 * 60_000
export const REPLY_MAX = 3500
const IDLE_TICKS = 2
const SCAN_EVERY_MS = 3000

export interface Orders {
  /** The id for a message the Assistant is about to send, or null when it is no order (an acknowledgement, a reply, to itself). */
  plan(fromSession: string, toSession: string, text: string): string | null
  /** The message went: remember the order. `extra` is a hand-off's kind, origin and whether it still has to be typed. */
  open(id: string, from: string, to: OrderTarget, text: string, extra?: Pick<Order, 'kind' | 'origin' | 'queued'>): void
  /** The marker the message carries so the transcript shows where the order began. */
  marker(id: string): string
  /** F-087: one order by id (a copy), for order_status. */
  get(id: string): Order | null
  /** F-087: stops an order on purpose: Esc into the target's chat, and its reply ("cancelled") goes back at once. False when there is no such order. */
  cancel(id: string): Promise<boolean>
  tick(): Promise<void>
  list(): Order[]
}

const makeId = () => `o${randomBytes(2).toString('hex')}`

export function createOrders(deps: OrderDeps): Orders {
  let orders: Order[] = load(deps.file)
  const idle = new Map<string, number>()
  const lastScan = new Map<string, number>()
  let busy = false

  function save() {
    if (!deps.file) return
    try {
      writeAtomic(deps.file, JSON.stringify({ orders }, null, 2))
    } catch (e) {
      deps.log?.warn(`orders: could not be saved: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const reply = (o: Order, text: string) => {
    const body = text.length > REPLY_MAX ? `${text.slice(0, REPLY_MAX)}\n… (trimmed; the whole conversation: app_read_conversation ${o.to.sessionId})` : text
    return `${REPLY_PREFIX}${o.to.agent} on ${o.to.floor} to order ${o.id}] ${body || '(no written answer; see its conversation)'}`
  }

  async function finish(o: Order, text: string) {
    o.pending ??= o.cancelled ? `${REPLY_PREFIX}${o.to.agent} on ${o.to.floor} to order ${o.id}] (cancelled: Shubham stopped it)` : reply(o, text)
    o.tries = (o.tries ?? 0) + 1
    let sent = false
    try {
      sent = await deps.deliver(o.from, o.pending, o)
    } catch {
      sent = false
    }
    if (sent) {
      // One reply per order: it is gone the moment its reply is in.
      orders = orders.filter(x => x.id !== o.id)
      idle.delete(o.id)
      lastScan.delete(o.id)
      deps.log?.info(`order ${o.id}: ${o.to.agent} on ${o.to.floor} answered, reply delivered`)
      save()
    } else if (deps.now() - o.at > GIVE_UP_MS + KEEP_REPLY_MS) {
      orders = orders.filter(x => x.id !== o.id)
      save()
    }
  }

  /** F-087: the progress line a hand-off is due (10 s, 60 s, then every 5 minutes), once. */
  function progressDue(o: Order, st: ChatNow, age: number) {
    if (o.kind !== 'handoff' || !deps.progress) return
    const n = o.progressSent ?? 0
    const due = n === 0 ? 10_000 : n === 1 ? 60_000 : 60_000 + (n - 1) * 5 * 60_000
    if (age < due) return
    o.progressSent = n + 1
    // Has the chat taken the message up? Looked at only when a line is due.
    let started = false
    try {
      started = deps.scan(o.to.sessionId, o.id).started
    } catch {
      started = false
    }
    if (started) o.queued = false
    const phase: OrderPhase = o.queued ? 'queued' : st === 'question' ? 'waiting-you' : !started ? 'typed' : age > 15 * 60_000 ? 'slow' : 'working'
    deps.progress({ orderId: o.id, phase, sec: Math.round(age / 1000), ...(st === 'running' ? { words: deps.words?.(o.to.sessionId) } : {}), ...(o.origin ? { origin: o.origin } : {}) })
    save()
  }

  async function step(o: Order) {
    // A reply that is made and waiting for the Assistant's chat.
    if (o.pending) return finish(o, '')
    const st = deps.stateOf(o.to.sessionId)
    const age = deps.now() - o.at
    progressDue(o, st, age)
    if (st === 'running' || st === 'question') {
      idle.set(o.id, 0)
      if (age > GIVE_UP_MS) return finish(o, `Still working on this after ${Math.round(age / 3_600_000)} h; no answer yet.`)
      return
    }
    // Resting (idle) or gone: the turn may be over. Twice in a row, so a blink between two steps is not an end.
    const n = (idle.get(o.id) ?? 0) + 1
    idle.set(o.id, n)
    if (st === 'idle' && n < IDLE_TICKS) return
    if (deps.now() - (lastScan.get(o.id) ?? 0) < SCAN_EVERY_MS && st === 'idle') return
    lastScan.set(o.id, deps.now())
    const s = deps.scan(o.to.sessionId, o.id)
    if (s.started) {
      o.queued = false
      return finish(o, s.answer)
    }
    // A hand-off whose chat was not running: it is typed when the chat is ready (the app does that); it waits here till then, not forever.
    if (st === undefined) return finish(o, `${o.to.agent}'s chat stopped before it took this order.`)
    if (age > NOT_TAKEN_MS) {
      if (o.kind === 'handoff') deps.progress?.({ orderId: o.id, phase: 'not-taken', sec: Math.round(age / 1000), ...(o.origin ? { origin: o.origin } : {}) })
      return finish(o, `${o.to.agent}'s chat did not take this order (it is waiting and has not started on it). It may need a nudge.`)
    }
  }

  return {
    plan(fromSession, toSession, text) {
      if (fromSession === toSession) return null
      if (isReply(text) || isAcknowledgement(text)) return null
      return makeId()
    },
    open(id, from, to, text, extra) {
      // A second order to the same agent in the same turn is its own order: each has its own marker.
      orders.push({ id, from, to, at: deps.now(), gist: text.replace(/\s+/g, ' ').trim().slice(0, 120), ...(extra?.kind ? { kind: extra.kind } : {}), ...(extra?.origin ? { origin: extra.origin } : {}), ...(extra?.queued ? { queued: true } : {}) })
      save()
    },
    marker: id => `order ${id}`,
    get: id => {
      const o = orders.find(x => x.id === id)
      return o ? { ...o } : null
    },
    async cancel(id) {
      const o = orders.find(x => x.id === id)
      if (!o) return false
      if (o.cancelled) return true
      o.cancelled = true
      // Esc into the chat that is working on it (it stops where it is); then the reply goes back at once.
      try {
        deps.interrupt?.(o.to.sessionId)
      } catch {
        // The reply still goes.
      }
      save()
      await finish(o, '')
      return true
    },
    async tick() {
      if (busy || orders.length === 0) return
      busy = true
      try {
        for (const o of [...orders]) await step(o)
      } finally {
        busy = false
      }
    },
    list: () => orders.map(o => ({ ...o })),
  }
}

function load(file: string | undefined): Order[] {
  if (!file || !existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { orders?: unknown }
    if (!Array.isArray(raw.orders)) return []
    return raw.orders.filter(
      (o): o is Order => !!o && typeof o === 'object' && typeof (o as Order).id === 'string' && typeof (o as Order).from === 'string' && typeof (o as Order).at === 'number' && typeof (o as Order).to?.sessionId === 'string',
    )
  } catch {
    return []
  }
}
