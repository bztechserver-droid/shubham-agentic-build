import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
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

/** The Assistant is the agent called Assistant on the floor called Assistant. */
export const isAssistantAgent = (floorName: string, agentName: string) => floorName.trim().toLowerCase() === 'assistant' && agentName.trim().toLowerCase() === 'assistant'

/**
 * F-084 H2: who may use Shubham's phone (phone_screen, phone_control, phone_update): the Assistant, and the Mobile agent's chat, the
 * agent called Mobile on the floor called Final, which builds and tries the phone app. Null for everyone else. The name goes with each
 * command (`by`) to the phone's action log and its notification.
 */
export const phoneUser = (floorName: string, agentName: string): 'assistant' | 'mobile' | null => {
  const floor = floorName.trim().toLowerCase()
  const agent = agentName.trim().toLowerCase()
  if (isAssistantAgent(floorName, agentName)) return 'assistant'
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

export interface Order {
  id: string
  /** The Assistant's chat that gave it. */
  from: string
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
  /** Types `text` into the Assistant's chat; false when that chat isn't running. */
  deliver(assistantSessionId: string, text: string): Promise<boolean>
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
  /** The message went: remember the order. */
  open(id: string, from: string, to: OrderTarget, text: string): void
  /** The marker the message carries so the transcript shows where the order began. */
  marker(id: string): string
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
    o.pending ??= reply(o, text)
    o.tries = (o.tries ?? 0) + 1
    let sent = false
    try {
      sent = await deps.deliver(o.from, o.pending)
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

  async function step(o: Order) {
    // A reply that is made and waiting for the Assistant's chat.
    if (o.pending) return finish(o, '')
    const st = deps.stateOf(o.to.sessionId)
    const age = deps.now() - o.at
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
    if (s.started) return finish(o, s.answer)
    if (st === undefined) return finish(o, `${o.to.agent}'s chat stopped before it took this order.`)
    if (age > NOT_TAKEN_MS) return finish(o, `${o.to.agent}'s chat did not take this order (it is waiting and has not started on it). It may need a nudge.`)
  }

  return {
    plan(fromSession, toSession, text) {
      if (fromSession === toSession) return null
      if (isReply(text) || isAcknowledgement(text)) return null
      return makeId()
    },
    open(id, from, to, text) {
      // A second order to the same agent in the same turn is its own order: each has its own marker.
      orders.push({ id, from, to, at: deps.now(), gist: text.replace(/\s+/g, ' ').trim().slice(0, 120) })
      save()
    },
    marker: id => `order ${id}`,
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
