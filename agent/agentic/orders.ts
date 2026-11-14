import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isOrchestratorAgent, type AgentDuty } from '../../shared/agentic.ts'
import { writeAtomic } from '../config.ts'
import { neutralizeMarks } from './talk-cards.ts'

// F-072: every agent answers the overlay Assistant, and the app does it, not the agents' goodwill.
// An order is a message the Assistant sends to another agent's chat. The app records it, marks the
// message with the order's id (so the agent's transcript shows exactly where its work on it began),
// and when that agent's turn ends it takes the turn's final text and types it into the Assistant's
// chat as "[reply from <Agent> on <Floor> to order <id>] ...". The rules that keep it from looping:
//   - exactly one reply per order (an order is gone once its reply is delivered);
//   - a reply is never an order: it opens none, and is never relayed back to the agent;
//   - an Assistant message that is only an acknowledgement ("ok", "thanks") opens no order;
//   - only the Assistant's own messages open orders (an agent writing to the Assistant does not);
//   - replies go to the Assistant's chat only, never broadcast;
//   - a reply typed into the Assistant's chat is IN only when that chat's claude reports it took exactly that text (its own hook);
//     one that is not taken is typed again a few times after growing waits, never while a report may still come, never after one came.

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

/** F-221 (ob98a): how a hand-off is typed beyond the plain one from the fast Assistant. */
export interface HandOffOptions {
  /** The longest text (default: the hand-off limit, 4000). */
  max?: number
  /** Live talk's direct line: its answer is kept for the page to speak, never told by the fast Assistant (Order.direct). */
  direct?: boolean
  /**
   * Spoken and not tapped (live talk's direct line, the only one: fix round 2, decision 1). The line waits for an Orchestrator that rests and that
   * no other spoken line holds (one at a time, talk-latch.ts); its order is opened and saved (queued, spoken) BEFORE it is typed, so the spoken latch
   * holds the Orchestrator's tools from before the line can be submitted until the line can no longer run (Order.spoken, kept on disk).
   */
  spoken?: boolean
  /**
   * F-221 (fix round 3): his tap on a card: a member PC's answer lost after the request was sent is "not known" (the order is kept waiting to be
   * taken, the card used up, never typed twice), not "not typed". The spoken line is always so. Left out (the plain old way): a lost answer is
   * "could not take it" (409), as before T2.
   */
  unsure?: boolean
}

export interface OrderView {
  orderId: string
  /** False: no such order any more (it was answered, or never existed). */
  open: boolean
  phase?: OrderPhase
  sec?: number
  gist?: string
  words?: string
  /** F-221 (fix round 3): a spoken order still working past GIVE_UP_MS: the words he was told (Order.late), for the page that has no socket. */
  late?: string
}

export interface HandoffApi {
  /**
   * Hands `text` to the Orchestrator as an order from the fast Assistant. `sender` is how the message names its giver ("the Assistant"). Never types at a prompt or over a draft (409, at once).
   * F-221 (ob98a): one implementation for the three ways a request reaches it: Quick's hand_off, his tap on a card (sender "Quick (spoken, he tapped
   * Send)") and live talk's direct line (`opt.direct`, sender "Live voice (spoken, not tapped)"). The ", order <id>]" of the line always stays last.
   */
  handOff(text: string, origin: OrderOrigin, sender?: string, opt?: HandOffOptions): Promise<HandOffResult>
  status(orderId: string): OrderView
  /** Stop (Esc into the Orchestrator); its reply says cancelled. */
  cancel(orderId: string): Promise<boolean>
  /**
   * F-221 (ob98a, fix round 2): he lets a spoken order's hold go (his Let go: T4's human route POST /talk/ask/<orderId>/let-go calls this). The
   * Orchestrator's tools are its own again; the order goes on and its answer still comes back. False when no open spoken order holds by that id.
   * T4 phase 2: and the residual hold that carries that order (talk-residual.ts) goes too; true when either went.
   */
  releaseSpoken(orderId: string, why: 'let-go'): boolean
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
  /** F-221 (ob98a): 'waiting-you' was said for the prompt it waits at now (said at once, not at the next line; again for a later prompt). */
  waitingSent?: boolean
  /** F-221 (ob98a): live talk's direct line: its answer is kept for the page (GET /talk/ask/<id>) and never told by the fast Assistant. */
  direct?: boolean
  /**
   * F-221 (ob98a, review of T2): his spoken words, not tapped. While it is open and unanswered the Orchestrator's tools are held (talk-latch.ts).
   * Kept on disk, so a restart of the agent keeps holding them: the chat goes on through an Update, and so does the order. Fix round 2: such an order
   * is closed only when its line can no longer run (its turn ended, the chat stopped, or the line never entered and the box is empty), never by a clock.
   */
  spoken?: boolean
  /** F-221 (fix round 2): he let its hold go (Let go): the chat's tools are its own again; the order still answers. */
  letGo?: boolean
  /**
   * F-221 (fix round 2): a spoken order still working at GIVE_UP_MS was said to be (once, as a progress line); it holds on until its turn ends.
   * Fix round 3: the words said, kept on the order, so the page of a direct line (which has no socket for progress) reads them in its view.
   */
  late?: string
  /**
   * F-221 (T4 phase 2): under the old order rule (no transcript turn: "Old way", Codex, OpenCode), a spoken order's chat was seen working since its
   * line was typed, and not seen gone since: its reply is seen only as that, then the chat at rest with an empty box.
   */
  ran?: boolean
  to: OrderTarget
  /** When it was given (ms). */
  at: number
  /** The first words of the order, for the reply's own reference. */
  gist: string
  /** Its reply is made and waits for the Assistant's chat to take it (the Assistant was not running). */
  pending?: string
  /** Delivery was tried this many times. */
  tries?: number
  /** Order-reply carrier (11 Nov): when the reply was FIRST typed into the Assistant's chat; claude's hook reporting it at any time since means it is in. */
  typedAt?: number
  /** When it was typed last, and how many times in all (a reply that chat did not take is typed again after a growing wait, a few times). */
  lastTypedAt?: number
  typings?: number
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

/**
 * Stage 1 (order o400b, Sync Research plan rule 4): an order's turn as its target's own transcript tells it (turns.ts createOrderWatch). `entered`: its
 * message is in the conversation (its user row, or a queued_command when Claude took it in mid-turn); `queued`: it waits in Claude's queue; `ended`:
 * the first turn end after it entered is written (turn_duration, or the interrupt row after Esc), and `answer` is the last assistant text before it.
 */
export interface OrderTurn {
  entered: boolean
  queued: boolean
  ended: boolean
  answer: string
  how?: 'finished' | 'interrupted' | 'failed'
}

export interface OrderDeps {
  now(): number
  /** What a chat is doing now: undefined when it isn't running anywhere. */
  stateOf(sessionId: string): ChatNow
  /** The target's transcript, for this order. */
  scan(sessionId: string, orderId: string): Scan
  /**
   * Stage 1 (o400b): the order's turn in its target's Claude transcript (rule 4), or null when there is none here or "Old way" is on: then the old
   * rule (the state reads idle twice, the order's own user row, the text after it). `since`: when the order was opened (ms).
   */
  turnOf?(sessionId: string, orderId: string, since: number): OrderTurn | null
  /** Stage 1: an order is closed; whatever was kept to follow it goes. */
  forget?(orderId: string): void
  /**
   * Types `text` into the Assistant's chat; false when nothing was typed (that chat isn't running, or a question or unsent text in its box).
   * True only says it was typed: whether it was TAKEN is `taken` (below). For a hand-off (`from` is FAST_FROM) it is the fast Assistant's
   * return path instead: nothing is typed anywhere, and true means it was taken.
   */
  deliver(assistantSessionId: string, text: string, order: Order): Promise<boolean>
  /**
   * Order-reply carrier (11 Nov): did the Assistant's claude take exactly `text` as a prompt since `since` (its own UserPromptSubmit hook,
   * chats.ts promptTaken)? null: that chat cannot say (not on this PC, or its hook has not spoken since it started here): then a typed
   * reply counts as delivered, as before. Without this dep every typed reply counts as delivered (the old rule).
   */
  taken?(assistantSessionId: string, text: string, since: number): boolean | null
  /** Tests: shorter waits than CONFIRM_MS and RETYPE_AFTER_MS. */
  waits?: { confirmMs: number; retypeAfterMs: number[] }
  /** F-087: told of a hand-off's progress (10 s, 60 s, then every 5 minutes). */
  progress?(p: OrderProgress): void
  /** F-087: the words the target chat's spinner shows now ("Cooking…"), when it shows any. */
  words?(sessionId: string): string | undefined
  /** F-087: Esc into the target's chat (Stop); false when it was not possible. */
  interrupt?(sessionId: string): boolean
  /**
   * F-221 (ob98a, fix round 2): what decides that a spoken order's line can no longer run, so its hold is never let go while it still could.
   * known(): the hub knows where its chats are (start-up adoption and recovery are over); before that a chat not seen is not known to have stopped.
   * Left out, the hub counts as knowing.
   */
  known?(): boolean
  /** F-221 (fix round 2): the chat runs (or ran) on another PC that has not reported it since: out of reach, or not heard from yet. It may still run there. */
  away?(sessionId: string): boolean
  /**
   * F-221 (fix round 2): the chat rests with NOTHING in its input box (no line of ours whose Enter was lost, no draft of his, no paste on its way),
   * read where it runs. Only then can a line that never entered not be submitted later. Left out: never known, so such a line holds on.
   */
  boxEmpty?(sessionId: string): boolean | Promise<boolean>
  /**
   * F-221 (T4 phase 2): a spoken order that still holds its chat is closing for a reason other than its reply being seen (the turn that took the line
   * ended) or his Let go: its chat stopped or was restarted, or the line was not taken. The hub leaves a residual hold on that chat
   * (talk-residual.ts); this is called BEFORE the order lets go, so the hold has no gap. `why` is for the log. T4 review: false (or a throw) when
   * the residual hold could not be kept on disk: the order then holds on itself (it is on disk), and closes at a later tick once the hold is.
   */
  residual?(order: Order, why: string): boolean | void
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
/**
 * Order-reply carrier (11 Nov, Lead's order after the reply to o36cc was typed at 22:07:03, logged "delivered" and never reached the
 * Assistant): a typed reply is IN only when the Assistant's claude reports it took exactly that text (its hook: 0.1-1.0 s after Enter,
 * 3.9 s for a chat's first prompt, 0.4-0.5 s for one typed while it was busy; probe-real.log). This long after the last typing, with that
 * chat resting (not working, not asking), no report means it was not taken.
 */
export const CONFIRM_MS = 15_000
/** A reply that was not taken is typed again after these waits (from its last typing), then given up. Never while a report may still come. */
export const RETYPE_AFTER_MS = [30_000, 2 * 60_000, 5 * 60_000]

export interface Orders {
  /** The id for a message the Assistant is about to send, or null when it is no order (an acknowledgement, a reply, to itself). */
  plan(fromSession: string, toSession: string, text: string): string | null
  /**
   * The message went: remember the order. `extra` is a hand-off's kind, origin, whether it still has to be typed and (F-221) whether it is a direct
   * line and whether it is his spoken words, not tapped. F-221 (fix round 3): true when it is saved on disk (or there is no file to save it in);
   * false when the save did not land: a spoken line is then not typed at all (its hold would not survive a restart of the agent).
   */
  open(id: string, from: string, to: OrderTarget, text: string, extra?: Pick<Order, 'kind' | 'origin' | 'queued' | 'direct' | 'spoken'>): boolean
  /** The marker the message carries so the transcript shows where the order began. */
  marker(id: string): string
  /** F-087: one order by id (a copy), for order_status. */
  get(id: string): Order | null
  /**
   * F-087: stops an order on purpose: Esc into the target's chat, and its reply ("cancelled") goes back at once. False when there is no such order.
   * F-221 (fix round 2): a spoken order that holds is stopped with Esc, but it is closed (and its hold let go) only when its turn is over or its line
   * can no longer run, as any spoken order: Esc alone proves neither.
   */
  cancel(id: string): Promise<boolean>
  /** F-221 (fix round 2): an order opened before its line was typed: the line is typed now (it no longer waits to be typed). */
  typed(id: string): void
  /** F-221 (fix round 2): an order opened before its line was typed, and the line was certainly NOT typed: it goes, with no reply (nothing was asked). */
  discard(id: string): void
  /** F-221 (fix round 2): his Let go on a spoken order: its hold goes, the order stays open and still answers. False: no open spoken order holds by that id. */
  letGo(id: string): boolean
  /**
   * F-221 (fix round 2): a chat ended (it stopped, or it is being restarted). A spoken order it had not answered cannot run its line any more: it is
   * closed at the next tick, saying so (an order opened after that end is not touched).
   */
  chatEnded(sessionId: string): void
  /**
   * F-221 (T4 phase 2): a chat is being reopened (after a lost chat host, at start-up recovery): under the old rule, what its spoken orders were
   * seen doing in the run before is no sign that their turn ended in this one (they must be seen working again).
   */
  reopened(sessionId: string): void
  tick(): Promise<void>
  list(): Order[]
}

const makeId = () => `o${randomBytes(2).toString('hex')}`

export function createOrders(deps: OrderDeps): Orders {
  let orders: Order[] = load(deps.file)
  const idle = new Map<string, number>()
  const lastScan = new Map<string, number>()
  // F-221 (fix round 2): for spoken orders. The chats that ended (by session, when), closed at the next tick; per order, the ticks in a row its chat
  // was seen nowhere, and the ticks in a row its box read empty while its line had not entered.
  const ended = new Map<string, number>()
  const missing = new Map<string, number>()
  const emptied = new Map<string, number>()
  /** T4 review: spoken orders whose residual hold could not be saved yet (they hold on; said once in the log). */
  const unsavedHolds = new Set<string>()
  let busy = false
  // Order-reply carrier: claude's reports are kept in memory, so a reply typed before this agent started cannot be confirmed by them.
  const startedAt = deps.now()
  const confirmMs = deps.waits?.confirmMs ?? CONFIRM_MS
  const retypeAfterMs = deps.waits?.retypeAfterMs ?? RETYPE_AFTER_MS

  /** Writes the open orders down; false when that did not land (logged). F-221 (fix round 3): open() says so for a spoken line. */
  function save(): boolean {
    if (!deps.file) return true
    try {
      writeAtomic(deps.file, JSON.stringify({ orders }, null, 2))
      return true
    } catch (e) {
      deps.log?.warn(`orders: could not be saved: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  const reply = (o: Order, text: string) => {
    const body = text.length > REPLY_MAX ? `${text.slice(0, REPLY_MAX)}\n… (trimmed; the whole conversation: app_read_conversation ${o.to.sessionId})` : text
    return `${REPLY_PREFIX}${o.to.agent} on ${o.to.floor} to order ${o.id}] ${body || '(no written answer; see its conversation)'}`
  }

  /** One reply per order: it is gone the moment its reply is in (or given up). Log lines carry ids and counts, never the words. */
  function close(o: Order, line: string, warn = false) {
    orders = orders.filter(x => x.id !== o.id)
    idle.delete(o.id)
    lastScan.delete(o.id)
    missing.delete(o.id)
    emptied.delete(o.id)
    unsavedHolds.delete(o.id)
    deps.forget?.(o.id)
    if (warn) deps.log?.warn(line)
    else deps.log?.info(line)
    save()
  }

  /** Order-reply carrier: did the Assistant's claude take the typed reply? null: that cannot be said (a hand-off, no `taken` dep, or that chat cannot say). */
  const tookReply = (o: Order) => (o.from === FAST_FROM || !deps.taken || o.typedAt === undefined || !o.pending ? null : deps.taken(o.from, o.pending, o.typedAt))

  async function finish(o: Order, text: string) {
    // F-221 (ob98a): a reply is typed into the Assistant's chat: a lookalike of the tapped marker in it (its words or an agent's name) is made harmless.
    // Made once, so what is typed is what claude's report is compared with.
    o.pending ??= neutralizeMarks(o.cancelled ? `${REPLY_PREFIX}${o.to.agent} on ${o.to.floor} to order ${o.id}] (cancelled: Shubham stopped it)` : reply(o, text))
    const who = `order ${o.id}: ${o.to.agent} on ${o.to.floor} answered`
    if (o.typedAt !== undefined) {
      // Typed already: IN the moment claude's hook reports it, whenever that comes, and never typed again after that.
      const took = tookReply(o)
      if (took === true) return close(o, `${who}, reply delivered (the Assistant's claude reported it taken${(o.typings ?? 1) > 1 ? `; typing ${o.typings}` : ''})`)
      const last = o.lastTypedAt ?? o.typedAt
      if (deps.now() - o.at > GIVE_UP_MS + KEEP_REPLY_MS) return close(o, `${who}; its reply was never reported taken by the Assistant's chat: dropped`, true)
      // Working or asking: a reply typed meanwhile waits in claude's queue and is reported when it is taken. Nothing is typed again then.
      const st = deps.stateOf(o.from)
      if (st === 'running' || st === 'question') {
        idle.set(o.id, 0)
        return
      }
      const n = (idle.get(o.id) ?? 0) + 1
      idle.set(o.id, n)
      if (n < IDLE_TICKS || deps.now() - last < confirmMs) return
      // That chat cannot say (its hook is silent, it is not running here, or the typing was before this agent started): the old rule,
      // typed = delivered. Nothing is ever typed twice on a guess.
      if (took === null || last < startedAt) return close(o, `${who}, reply delivered (typed; that chat cannot confirm it)`)
      // Not taken (lost on the way: a line cleared, an Enter that did not land). Typed again after a growing wait, a few times, then given up.
      const k = o.typings ?? 1
      if (k > retypeAfterMs.length) return close(o, `${who}; its reply was typed ${k} times into the Assistant's chat and never taken: given up (the answer stays in ${o.to.agent}'s conversation)`, true)
      if (deps.now() - last < retypeAfterMs[k - 1]) return
    }
    o.tries = (o.tries ?? 0) + 1
    const at = deps.now()
    let sent = false
    try {
      sent = await deps.deliver(o.from, o.pending, o)
    } catch {
      sent = false
    }
    if (sent) {
      // A hand-off's return path, or no way to know: in as soon as it is handed over (the old rule).
      if (o.from === FAST_FROM || !deps.taken) return close(o, `${who}, reply delivered`)
      if (o.typedAt !== undefined) deps.log?.warn(`order ${o.id}: its reply was not taken by the Assistant's chat ${Math.round((at - (o.lastTypedAt ?? o.typedAt)) / 1000)} s after it was typed; typed again (typing ${(o.typings ?? 1) + 1} of ${retypeAfterMs.length + 1})`)
      else deps.log?.info(`order ${o.id}: its reply was typed into the Assistant's chat; it is in once that chat's claude reports it`)
      o.typedAt ??= at
      o.lastTypedAt = at
      o.typings = (o.typings ?? 0) + 1
      idle.set(o.id, 0)
      save()
      return
    }
    // Nothing typed (not running, a question, or text in its box, a false one included): it waits, and is never counted as delivered.
    if (o.tries === 1) deps.log?.info(`order ${o.id}: its reply waits: the Assistant's chat cannot be typed into now (not running, a question, or text in its box)`)
    if (deps.now() - o.at > GIVE_UP_MS + KEEP_REPLY_MS) {
      orders = orders.filter(x => x.id !== o.id)
      deps.forget?.(o.id)
      save()
    }
  }

  /** F-087: the progress line a hand-off is due (10 s, 60 s, then every 5 minutes), once. */
  function progressDue(o: Order, st: ChatNow, age: number, turn: OrderTurn | null = null) {
    if (o.kind !== 'handoff' || !deps.progress) return
    // F-221 (ob98a): the moment its chat stops at a prompt he is told (waiting-you), not at the next 10 s / 60 s line: he may be the only one who
    // can answer it. Once per prompt; a later prompt is told again.
    const waiting = st === 'question' && !o.queued
    if (!waiting && o.waitingSent) o.waitingSent = false
    const n = o.progressSent ?? 0
    const due = n === 0 ? 10_000 : n === 1 ? 60_000 : 60_000 + (n - 1) * 5 * 60_000
    if (waiting && !o.waitingSent) {
      o.waitingSent = true
      // A line due now would say the same: it is this one.
      if (age >= due) o.progressSent = n + 1
      deps.progress({ orderId: o.id, phase: 'waiting-you', sec: Math.round(age / 1000), ...(o.origin ? { origin: o.origin } : {}) })
      save()
      return
    }
    if (age < due) return
    o.progressSent = n + 1
    // Has the chat taken the message up? Looked at only when a line is due (Stage 1: its transcript has it, in the conversation or in Claude's queue).
    let started = false
    try {
      started = turn ? turn.entered || turn.queued : deps.scan(o.to.sessionId, o.id).started
    } catch {
      started = false
    }
    if (started) o.queued = false
    const phase: OrderPhase = o.queued ? 'queued' : st === 'question' ? 'waiting-you' : !started ? 'typed' : age > 15 * 60_000 ? 'slow' : 'working'
    deps.progress({ orderId: o.id, phase, sec: Math.round(age / 1000), ...(st === 'running' ? { words: deps.words?.(o.to.sessionId) } : {}), ...(o.origin ? { origin: o.origin } : {}) })
    save()
  }

  /** Stage 1: the reply's words from the order's turn: its last words, and how it stopped when that was not a plain end. */
  const turnAnswer = (t: OrderTurn) =>
    t.how === 'interrupted'
      ? t.answer ? `${t.answer}\n\n(Its turn was stopped with Esc here.)` : '(Its turn was stopped with Esc before it wrote an answer; see its conversation.)'
      : t.how === 'failed' ? `(Its turn ended with an error.) ${t.answer}`.trim() : t.answer

  /** The give-up reply's words (an order still unanswered after GIVE_UP_MS). */
  const stillWorking = (age: number) => `Still working on this after ${Math.round(age / 3_600_000)} h; no answer yet.`

  /**
   * F-221 (ob98a, fix round 2): a spoken order still working at GIVE_UP_MS is NOT given up: that would let its hold go while its turn still runs.
   * He is told once, with a progress line in the give-up's words; the order (and its hold) goes on until its turn ends.
   */
  function overdue(o: Order, age: number) {
    if (o.late) return
    // Kept on the order (fix round 3): a direct line's page reads them in its view (GET /talk/ask/<id>); a hand-off's socket gets the line too.
    o.late = stillWorking(age)
    deps.log?.info(`order ${o.id}: still working after ${Math.round(age / 3_600_000)} h; spoken, so it holds until its turn ends`)
    if (o.kind === 'handoff') deps.progress?.({ orderId: o.id, phase: 'slow', sec: Math.round(age / 1000), words: o.late, ...(o.origin ? { origin: o.origin } : {}) })
    save()
  }

  /**
   * F-221 (fix round 2): a spoken line that never entered can be let go only when its chat rests with an EMPTY box, read empty twice in a row (a
   * screen read in the middle of a redraw is no proof): then it cannot be submitted later. Text in the box (the line whose Enter was lost, or his own
   * draft), or a box that cannot be read, keeps it held.
   */
  async function boxReadEmpty(o: Order): Promise<boolean> {
    let empty = false
    try {
      empty = (await deps.boxEmpty?.(o.to.sessionId)) === true
    } catch {
      empty = false
    }
    const n = empty ? (emptied.get(o.id) ?? 0) + 1 : 0
    emptied.set(o.id, n)
    return n >= IDLE_TICKS
  }

  /**
   * F-221 (fix round 2): the reply of a spoken order whose chat stopped: what its turn said, if it ended, or that it stopped. T4 phase 2: `seen`: its
   * turn's end is in its transcript (its reply was seen); otherwise it closes abnormally (closeSpoken).
   */
  function stoppedReply(o: Order): { text: string; seen: boolean } {
    let t: OrderTurn | null = null
    try {
      t = deps.turnOf?.(o.to.sessionId, o.id, o.at) ?? null
    } catch {
      t = null
    }
    if (t?.ended) return { text: turnAnswer(t), seen: true }
    if (t?.entered || t?.queued) return { text: `${o.to.agent}'s chat stopped before it finished this order.${t.answer ? `\n\n${t.answer}` : ''}`, seen: false }
    return { text: `${o.to.agent}'s chat stopped before it took this order.`, seen: false }
  }

  /**
   * F-221 (T4 phase 2): an order closing for a reason other than its reply being seen (its chat stopped or was restarted, its line was not taken).
   * A spoken one that still holds its chat (not let go) leaves a residual hold there first (deps.residual), because the line's work may still run
   * (the chat restarted and told to carry on, a turn nobody saw end): the chat stays held, with no gap, until a turn end is seen there or he lets go.
   */
  function closeSpoken(o: Order, text: string, why: string) {
    if (holding(o)) {
      let kept: boolean | void
      try {
        kept = deps.residual?.(o, why)
      } catch (e) {
        // The order keeps holding then: it is closed at a later tick, once the residual hold is there.
        deps.log?.warn(`order ${o.id}: its residual hold could not be made (${e instanceof Error ? e.message : String(e)}); it holds on`)
        return
      }
      // T4 review: made, but not on disk (talk-residual.json could not be written): a restart of the agent before it lands would lose it, while this
      // order is on disk and holds the same chat. So the order holds on, and is closed at a later tick, once the hold is saved.
      if (kept === false) {
        if (!unsavedHolds.has(o.id)) deps.log?.warn(`order ${o.id}: its residual hold could not be saved yet; the order holds on`)
        unsavedHolds.add(o.id)
        return
      }
      unsavedHolds.delete(o.id)
    }
    return finish(o, text)
  }

  /**
   * Stage 1 (o400b, rule 4): the order is answered by Claude's own transcript: the last assistant text before the first turn end after the order
   * entered the conversation (its own row, or taken in mid-turn). Nothing is decided by the state reading idle: a turn that goes on for an hour is
   * waited for, and a reply is never "(no written answer)" while the agent is still working.
   */
  async function stepByTurn(o: Order, t: OrderTurn, st: ChatNow, age: number) {
    if (t.ended) {
      o.queued = false
      return finish(o, turnAnswer(t))
    }
    if (t.entered || t.queued) {
      // Taken (or waiting in Claude's own queue, which starts it next): answered when its turn ends.
      o.queued = false
      idle.set(o.id, 0)
      // F-221 (fix round 2): a spoken order's chat that stopped (step() found it is stopped, not out of reach) cannot run its line any more. T4 phase
      // 2: its turn was not seen to end: a residual hold stays on the chat (closeSpoken).
      if (o.spoken && st === undefined) return closeSpoken(o, stoppedReply(o).text, 'its chat stopped before its turn was seen to end')
      if (age > GIVE_UP_MS) return o.spoken ? overdue(o, age) : finish(o, stillWorking(age))
      return
    }
    // Not in its transcript at all yet (a paste is written there within about 0.3 s).
    if (st === undefined) return closeSpoken(o, `${o.to.agent}'s chat stopped before it took this order.`, 'its chat stopped before it took the line')
    if (st === 'running' || st === 'question') {
      idle.set(o.id, 0)
      emptied.delete(o.id)
      return
    }
    if (age > NOT_TAKEN_MS) {
      // F-221 (fix round 2): a spoken line is let go only when it can no longer be submitted (its box is empty).
      if (o.spoken && !(await boxReadEmpty(o))) return
      if (o.kind === 'handoff') deps.progress?.({ orderId: o.id, phase: 'not-taken', sec: Math.round(age / 1000), ...(o.origin ? { origin: o.origin } : {}) })
      return closeSpoken(o, `${o.to.agent}'s chat did not take this order (it is waiting and has not started on it). It may need a nudge.`, 'its line was not taken')
    }
  }

  async function step(o: Order) {
    // A reply that is made and waiting for the Assistant's chat.
    if (o.pending) return finish(o, '')
    const st = deps.stateOf(o.to.sessionId)
    const age = deps.now() - o.at
    // F-221 (ob98a, fix round 2): a spoken order's chat that is seen nowhere has stopped only when that is known: the hub knows where its chats are,
    // the chat is not on a PC that has not reported it since (out of reach: it may still be running there), and it was missing twice in a row. Till
    // then its line may still run: it holds, and nothing else is decided.
    if (o.spoken) {
      if (st === undefined) {
        const n = (missing.get(o.id) ?? 0) + 1
        missing.set(o.id, n)
        // T4 phase 2 (the old rule's reply): a chat seen nowhere twice in a row did not end its turn at rest (a crash, a restart, a lost link): what
        // was seen working before no longer counts.
        if (n >= IDLE_TICKS && o.ran) {
          delete o.ran
          save()
        }
        if (deps.known?.() === false || deps.away?.(o.to.sessionId) === true || n < IDLE_TICKS) return
      } else {
        missing.delete(o.id)
        // T4 phase 2 (the old rule's reply): its chat seen working since its line was typed.
        if ((st === 'running' || st === 'question') && !o.queued && !o.ran) {
          o.ran = true
          save()
        }
      }
    }
    let turn: OrderTurn | null = null
    try {
      turn = deps.turnOf?.(o.to.sessionId, o.id, o.at) ?? null
    } catch {
      turn = null
    }
    progressDue(o, st, age, turn)
    if (turn) return stepByTurn(o, turn, st, age)
    if (st === 'running' || st === 'question') {
      idle.set(o.id, 0)
      emptied.delete(o.id)
      if (age > GIVE_UP_MS) return o.spoken ? overdue(o, age) : finish(o, stillWorking(age))
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
      if (o.spoken) {
        // F-221 (T4 phase 2): the old rule has no turn end to read, so a spoken line's reply is seen only as its chat seen working since the line was
        // typed, then at rest with an empty box (read twice: a line or a carry-on still in the box would run). Gone instead: it closes abnormally,
        // leaving a residual hold. Anything else waits, holding: no clock decides it (as the transcript's rule).
        if (st === undefined) return closeSpoken(o, `${o.to.agent}'s chat stopped before it finished this order.${s.answer ? `\n\n${s.answer}` : ''}`, 'its chat stopped before its turn was seen to end')
        if (!o.ran || !(await boxReadEmpty(o))) return
      }
      return finish(o, s.answer)
    }
    // A hand-off whose chat was not running: it is typed when the chat is ready (the app does that); it waits here till then, not forever.
    if (st === undefined) return closeSpoken(o, `${o.to.agent}'s chat stopped before it took this order.`, 'its chat stopped before it took the line')
    if (age > NOT_TAKEN_MS) {
      // F-221 (fix round 2): a spoken line is let go only when it can no longer be submitted (its box is empty).
      if (o.spoken && !(await boxReadEmpty(o))) return
      if (o.kind === 'handoff') deps.progress?.({ orderId: o.id, phase: 'not-taken', sec: Math.round(age / 1000), ...(o.origin ? { origin: o.origin } : {}) })
      return closeSpoken(o, `${o.to.agent}'s chat did not take this order (it is waiting and has not started on it). It may need a nudge.`, 'its line was not taken')
    }
  }

  /** F-221 (fix round 2): a spoken order that holds its chat now (open, not answered, not let go): the latch's own rule (talk-latch.ts holdsChat). */
  const holding = (o: Order) => o.spoken === true && !o.pending && o.letGo !== true

  return {
    plan(fromSession, toSession, text) {
      if (fromSession === toSession) return null
      if (isReply(text) || isAcknowledgement(text)) return null
      return makeId()
    },
    open(id, from, to, text, extra) {
      // A second order to the same agent in the same turn is its own order: each has its own marker.
      orders.push({ id, from, to, at: deps.now(), gist: text.replace(/\s+/g, ' ').trim().slice(0, 120), ...(extra?.kind ? { kind: extra.kind } : {}), ...(extra?.origin ? { origin: extra.origin } : {}), ...(extra?.queued ? { queued: true } : {}), ...(extra?.direct ? { direct: true } : {}), ...(extra?.spoken ? { spoken: true } : {}) })
      return save()
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
      // F-221 (fix round 2): a spoken order that holds goes on until its turn is over or its line can no longer run (its reply then says cancelled):
      // Esc does not prove either (a line in the box or in Claude's queue may still be sent), so its hold stays till then.
      if (holding(o)) return true
      await finish(o, '')
      return true
    },
    typed(id) {
      const o = orders.find(x => x.id === id)
      if (!o?.queued) return
      o.queued = false
      save()
    },
    discard(id) {
      const o = orders.find(x => x.id === id)
      if (o) close(o, `order ${o.id}: its message was not typed; dropped (nothing was asked)`)
    },
    letGo(id) {
      const o = orders.find(x => x.id === id)
      if (!o || !holding(o)) return false
      o.letGo = true
      deps.log?.info(`order ${o.id}: its spoken hold on chat ${o.to.sessionId.slice(0, 8)} was let go by him; the order still answers`)
      save()
      return true
    },
    chatEnded(sessionId) {
      if (orders.some(o => o.to.sessionId === sessionId && o.spoken && !o.pending)) ended.set(sessionId, deps.now())
    },
    reopened(sessionId) {
      let changed = false
      for (const o of orders) {
        if (o.to.sessionId !== sessionId || !o.ran) continue
        delete o.ran
        changed = true
      }
      if (changed) save()
    },
    async tick() {
      if (busy) return
      if (orders.length === 0) {
        ended.clear()
        return
      }
      busy = true
      try {
        // F-221 (fix round 2): a chat that ended (stopped, or being restarted) cannot run a spoken line it had: such an order is closed, saying so.
        // T4 phase 2: unless its turn's end was seen, it leaves a residual hold on the chat (a restarted chat may be told to carry on).
        const gone = [...ended]
        ended.clear()
        for (const [sid, at] of gone)
          for (const o of [...orders]) {
            if (o.to.sessionId !== sid || !o.spoken || o.pending || o.at > at) continue
            const r = stoppedReply(o)
            await (r.seen ? finish(o, r.text) : closeSpoken(o, r.text, 'its chat ended or was restarted before its turn was seen to end'))
          }
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
