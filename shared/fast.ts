// F-086/F-087: the contract of the fast Assistant's stream, shared by the hub (agent/agentic/fast*.ts), the web page (src) and, in words,
// Chris (agent/agentic/FAST-PROTOCOL.md). One set of JSON frames, one frame per WebSocket text message, on two sockets:
//   the page:   /agent-api/agentic/fast   (the app token, like every page socket)
//   the phone:  /agent-api/voice/fast     (a device key, no Origin; like /voice/live)
// The fast Assistant is a kept-warm headless model process (Haiku by default, Sonnet when asked for a thorough answer); what it cannot
// do itself it hands to the Orchestrator (the overlay chat) as an order, and the answer comes back on the same stream.

export const FAST_MODELS = ['haiku', 'sonnet'] as const
export type FastModel = (typeof FAST_MODELS)[number]
/** Order o7f34: who answers a question of the efficient route: the Claude login (the Server's subscription) or the saved API key. */
export type AnswerSource = 'subscription' | 'api'

/** An ask is at most this many characters; a frame at most MAX_FRAME_BYTES (4 bytes a character, plus the rest). */
export const MAX_TEXT = 2000
export const MAX_FRAME_BYTES = 12 * 1024
/** F-221 (ob98a): what he heard of an answer he cut off, sent with his next ask: at most this many characters. */
export const MAX_HEARD = 600
/** Ids the client makes (an ask, a tab, a device): short and plain, so they can be logged and compared. */
export const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/
/** The id of a turn the HUB starts (the Assistant telling the answer to a hand-off): `o:` and the order's id. */
export const orderTurn = (orderId: string) => `o:${orderId}`
/** F-221 (ob98a): an `o:` turn id as a client may name it in a cancel (barge-in on the turn that tells a hand-off's answer). */
const ORDER_TURN_RE = /^o:[A-Za-z0-9_.-]{1,62}$/

/**
 * F-221 (ob98a): a tap-to-send card. Spoken words never approve, pay, delete or publish: a hand-off made while the connection HOLDS (its `hold`
 * latch), and a message the Orchestrator wants to send to another chat while a spoken order holds it, are not typed anywhere. They wait on his
 * screen as a card with the exact words, and only his tap on Send (an HTTP route with his signed-in CRM session, never a socket frame) sends them.
 * `to` is a display name: the big chat ("the Assistant") for a hand-off, "<agent> on <floor>" for a relay. `version` changes when the card does;
 * Send names the version it showed. Times are ms since the epoch.
 */
export interface TalkCard {
  id: string
  version: number
  kind: 'handoff' | 'relay'
  to: string
  text: string
  via: 'voice' | 'typed'
  createdAt: number
  expiresAt: number
}

/** Why a card went: sent by his tap, dropped (his drop, a stop word, End, stop), expired (10 minutes, or the oldest of too many), its socket closed, another screen took the Assistant. */
export type CardGoneReason = 'sent' | 'dropped' | 'expired' | 'closed' | 'taken-over'
export const CARD_GONE_REASONS: readonly CardGoneReason[] = ['sent', 'dropped', 'expired', 'closed', 'taken-over']

/**
 * What GET /voice/hello says about the fast Assistant, as the top-level field `fast`.
 * `ready: true` only while the Assistant is switched on and /voice/fast serves (a cold, idle process counts: the first `start` wakes it);
 * false when it is off, or its process failed to start. `model` is the model it will use now. A hub without the Assistant has no `fast` field at all.
 * Chris uses B/fast only while the last hello had `fast.ready === true` (JSON true, nothing else).
 */
export interface FastHello {
  ready: boolean
  model?: FastModel
}

/** The `fast` field of hello: `on` = the Assistant is switched on (a host exists); `state` = the host's state. */
export function fastHello(on: boolean, state: string | null | undefined, model: string | null | undefined): FastHello {
  const m = (FAST_MODELS as readonly string[]).includes(model ?? '') ? (model as FastModel) : undefined
  return { ready: on && state !== 'unavailable', ...(m ? { model: m } : {}) }
}
/** At most this many asks a minute from one client; more is a 429 error frame (the stream stays). */
export const MAX_ASKS_PER_MIN = 30

// --- client -> hub -------------------------------------------------------------------------------

export type FastClientFrame =
  /** Claim the Assistant. One owner at a time: a second client taking it makes the first get state 'taken-over'. `resume` (a reconnect) does not take it from another. */
  | { t: 'start'; client: 'web' | 'phone'; id: string; model?: FastModel; resume?: boolean }
  /**
   * A question or an order. `via` says how it was given (voice answers are written for the ear). `thorough` asks for Sonnet for this turn. A new ask while one runs cuts the old one off (it ends with done {cancelled}).
   * F-221 (ob98a): `heard` = the part of the previous answer he actually heard before he cut in (at most MAX_HEARD characters): the Assistant goes on from there.
   */
  | { t: 'ask'; id: string; text: string; via: 'voice' | 'typed'; thorough?: boolean; source?: AnswerSource; heard?: string }
  /** Barge-in: stop turn `id` now (what is already spoken stays said). F-221: also `o:<orderId>`, the hub's turn that tells a hand-off's answer, when it was told on this connection. */
  | { t: 'cancel'; id: string }
  /** The client is done: the Assistant is released (the hub keeps the process warm for a while). F-221: this connection's cards are dropped too. */
  | { t: 'stop' }
  | { t: 'ping' }
  /**
   * F-221 (ob98a): this connection's HOLD latch. While it is on and this connection owns the Assistant, EVERY hand-off made during its asks becomes a
   * card he taps to send (never typed). Live talk sends `hold {on:true}` right after `start`; the Alt+K bar when its "tap to send" setting is on.
   */
  | { t: 'hold'; on: boolean }
  /** F-221: drop one card of this connection (`card`: its id), or all of them (a stop word, a change of mind, End). */
  | { t: 'drop'; card?: string }

// --- hub -> client -------------------------------------------------------------------------------

export type FastState = 'off' | 'starting' | 'ready' | 'unavailable' | 'paused' | 'taken-over' | 'stopped'

/** Where a hand-off is: queued (waiting for the Orchestrator to be free), typed (it has the order), working, waiting-you (the Orchestrator is waiting for HIS answer on the PC), slow (still working after a long while), not-taken (it did not take the order in 2 minutes). */
export type HandoffPhase = 'queued' | 'typed' | 'working' | 'waiting-you' | 'slow' | 'not-taken'

export type FastServerFrame =
  /**
   * The Assistant itself: `reason` is one plain sentence for anything but 'ready' / 'starting'. `paused` = memory is low; asks go to the Orchestrator directly.
   * F-221 (ob98a): `holds: true` = this hub can hold hand-offs as cards (the `hold` latch, `card` frames); a page offers live talk only then.
   */
  | { t: 'state'; state: FastState; reason?: string; model?: FastModel; holds?: boolean }
  /** A piece of the answer text as it streams (speak it as it arrives). `id` is the ask's, or `o:<orderId>` for a turn the hub started. */
  | { t: 'delta'; id: string; text: string }
  /** A boundary where speech may start (the end of a text block): speak what is queued. */
  | { t: 'flush'; id: string }
  /** The Assistant is using a tool: a short label to show or say ("Opening that"). */
  | { t: 'tool'; id: string; name: string; label: string }
  /** The turn is over. `text` is everything it said. `cancelled` when an ask or a cancel cut it off. `ttftMs`: from the turn being written to its first word. */
  | { t: 'done'; id: string; text: string; ms?: number; costUsd?: number; cancelled?: boolean; source?: AnswerSource; ttftMs?: number }
  // (costUsd: what the API charged for the answer; the Claude login's figure is not what Shubham pays, so the page shows it for the API only.)
  | { t: 'error'; id?: string; status: number; message: string }
  /** The Assistant handed the ask to the Orchestrator: `line` is a one-line description of the request for a card ("Asked the Orchestrator: publish the build"); what the Assistant SAYS about it arrives as ordinary delta frames. `orderId` tracks it (it is also an ask id for Chris: GET /voice/ask/<orderId>). */
  | { t: 'handoff'; id: string; orderId: string; line: string }
  | { t: 'handoff-progress'; orderId: string; phase: HandoffPhase; sec: number; words?: string }
  /** The Orchestrator's full reply (the screen shows it; the Assistant then says a short version in a turn `o:<orderId>`). `cancelled` when the order was stopped. */
  | { t: 'handoff-answer'; orderId: string; text: string; cancelled?: boolean }
  /** F-221 (ob98a): a card to show (new, or changed: a higher `version`). Only his tap on Send sends it (an HTTP route, never a frame). */
  | { t: 'card'; card: TalkCard }
  /** F-221: a card went. `orderId` when his tap sent it as that order (its handoff, progress and answer follow as usual). */
  | { t: 'card-gone'; id: string; reason: CardGoneReason; orderId?: string }
  | { t: 'pong' }

// --- checking what a client sends ---------------------------------------------------------------

export type FastParse = { ok: true; frame: FastClientFrame } | { ok: false; status: number; message: string }

const bad = (message: string, status = 400): FastParse => ({ ok: false, status, message })
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
// A client's id never starts with 'o:': that prefix is the hub's own turns (orderTurn).
const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v) && !v.startsWith('o:')
/** F-221: control characters become spaces, then the text is one tidy line (what he heard is quoted to the model, so it cannot start a line of its own). */
const oneLine = (s: string) =>
  Array.from(s, c => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()

/** One text message from a client, checked. Anything not known is refused (with a plain sentence), never guessed at. */
export function parseClientFrame(raw: string): FastParse {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_FRAME_BYTES) return bad('That message is too big.', 413)
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return bad('That was not JSON.')
  }
  if (!isObject(v) || typeof v.t !== 'string') return bad('A frame is a JSON object with a t.')
  switch (v.t) {
    case 'start': {
      if (v.client !== 'web' && v.client !== 'phone') return bad("start needs client 'web' or 'phone'.")
      if (!isId(v.id)) return bad('start needs an id (a tab or a device), 1 to 64 plain characters.')
      if (v.model !== undefined && !(FAST_MODELS as readonly unknown[]).includes(v.model)) return bad('model is haiku or sonnet.')
      return { ok: true, frame: { t: 'start', client: v.client, id: v.id, ...(v.model ? { model: v.model as FastModel } : {}), ...(v.resume === true ? { resume: true } : {}) } }
    }
    case 'ask': {
      if (!isId(v.id)) return bad('ask needs an id, 1 to 64 plain characters.')
      if (v.via !== 'voice' && v.via !== 'typed') return bad("ask needs via 'voice' or 'typed'.")
      if (typeof v.text !== 'string') return bad('ask needs text.')
      const text = v.text.replace(/\s+/g, ' ').trim()
      if (!text) return bad('There is nothing to ask.')
      if (text.length > MAX_TEXT) return bad(`That is longer than ${MAX_TEXT} characters.`, 413)
      // Order o7f34: which answerer (the efficient route's compare button and its setting); left out, the server decides.
      if (v.source !== undefined && v.source !== 'subscription' && v.source !== 'api') return bad("source is 'subscription' or 'api'.")
      // F-221 (ob98a): what he heard of the answer he cut off. Empty is the same as left out.
      let heard = ''
      if (v.heard !== undefined) {
        if (typeof v.heard !== 'string') return bad('heard is the part of the last answer he heard, as text.')
        heard = oneLine(v.heard)
        if (heard.length > MAX_HEARD) return bad(`heard is longer than ${MAX_HEARD} characters.`, 413)
      }
      return { ok: true, frame: { t: 'ask', id: v.id, text, via: v.via, ...(v.thorough === true ? { thorough: true } : {}), ...(v.source ? { source: v.source } : {}), ...(heard ? { heard } : {}) } }
    }
    case 'cancel':
      // F-221: an o: id is the hub's turn telling a hand-off's answer (the session lets a connection cancel only one told to it).
      return isId(v.id) || (typeof v.id === 'string' && ORDER_TURN_RE.test(v.id)) ? { ok: true, frame: { t: 'cancel', id: v.id } } : bad('cancel needs the id of the ask.')
    case 'stop':
      return { ok: true, frame: { t: 'stop' } }
    case 'ping':
      return { ok: true, frame: { t: 'ping' } }
    case 'hold':
      return typeof v.on === 'boolean' ? { ok: true, frame: { t: 'hold', on: v.on } } : bad('hold needs on: true or false.')
    case 'drop':
      if (v.card === undefined) return { ok: true, frame: { t: 'drop' } }
      return isId(v.card) ? { ok: true, frame: { t: 'drop', card: v.card } } : bad('drop takes the id of one card, or nothing for all of them.')
    default:
      return bad(`No such frame: ${v.t.slice(0, 20)}.`)
  }
}
