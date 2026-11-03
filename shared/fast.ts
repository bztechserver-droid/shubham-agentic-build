// F-086/F-087: the contract of the fast Assistant's stream, shared by the hub (agent/agentic/fast*.ts), the web page (src) and, in words,
// Chris (agent/agentic/FAST-PROTOCOL.md). One set of JSON frames, one frame per WebSocket text message, on two sockets:
//   the page:   /agent-api/agentic/fast   (the app token, like every page socket)
//   the phone:  /agent-api/voice/fast     (a device key, no Origin; like /voice/live)
// The fast Assistant is a kept-warm headless model process (Haiku by default, Sonnet when asked for a thorough answer); what it cannot
// do itself it hands to the Orchestrator (the overlay chat) as an order, and the answer comes back on the same stream.

export const FAST_MODELS = ['haiku', 'sonnet'] as const
export type FastModel = (typeof FAST_MODELS)[number]

/** An ask is at most this many characters; a frame at most MAX_FRAME_BYTES (4 bytes a character, plus the rest). */
export const MAX_TEXT = 2000
export const MAX_FRAME_BYTES = 12 * 1024
/** Ids the client makes (an ask, a tab, a device): short and plain, so they can be logged and compared. */
export const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/
/** The id of a turn the HUB starts (the Assistant telling the answer to a hand-off): `o:` and the order's id. */
export const orderTurn = (orderId: string) => `o:${orderId}`

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
  /** A question or an order. `via` says how it was given (voice answers are written for the ear). `thorough` asks for Sonnet for this turn. A new ask while one runs cuts the old one off (it ends with done {cancelled}). */
  | { t: 'ask'; id: string; text: string; via: 'voice' | 'typed'; thorough?: boolean }
  /** Barge-in: stop turn `id` now (what is already spoken stays said). */
  | { t: 'cancel'; id: string }
  /** The client is done: the Assistant is released (the hub keeps the process warm for a while). */
  | { t: 'stop' }
  | { t: 'ping' }

// --- hub -> client -------------------------------------------------------------------------------

export type FastState = 'off' | 'starting' | 'ready' | 'unavailable' | 'paused' | 'taken-over' | 'stopped'

/** Where a hand-off is: queued (waiting for the Orchestrator to be free), typed (it has the order), working, waiting-you (the Orchestrator is waiting for HIS answer on the PC), slow (still working after a long while), not-taken (it did not take the order in 2 minutes). */
export type HandoffPhase = 'queued' | 'typed' | 'working' | 'waiting-you' | 'slow' | 'not-taken'

export type FastServerFrame =
  /** The Assistant itself: `reason` is one plain sentence for anything but 'ready' / 'starting'. `paused` = memory is low; asks go to the Orchestrator directly. */
  | { t: 'state'; state: FastState; reason?: string; model?: FastModel }
  /** A piece of the answer text as it streams (speak it as it arrives). `id` is the ask's, or `o:<orderId>` for a turn the hub started. */
  | { t: 'delta'; id: string; text: string }
  /** A boundary where speech may start (the end of a text block): speak what is queued. */
  | { t: 'flush'; id: string }
  /** The Assistant is using a tool: a short label to show or say ("Opening that"). */
  | { t: 'tool'; id: string; name: string; label: string }
  /** The turn is over. `text` is everything it said. `cancelled` when an ask or a cancel cut it off. */
  | { t: 'done'; id: string; text: string; ms?: number; costUsd?: number; cancelled?: boolean }
  | { t: 'error'; id?: string; status: number; message: string }
  /** The Assistant handed the ask to the Orchestrator: `line` is a one-line description of the request for a card ("Asked the Orchestrator: publish the build"); what the Assistant SAYS about it arrives as ordinary delta frames. `orderId` tracks it (it is also an ask id for Chris: GET /voice/ask/<orderId>). */
  | { t: 'handoff'; id: string; orderId: string; line: string }
  | { t: 'handoff-progress'; orderId: string; phase: HandoffPhase; sec: number; words?: string }
  /** The Orchestrator's full reply (the screen shows it; the Assistant then says a short version in a turn `o:<orderId>`). `cancelled` when the order was stopped. */
  | { t: 'handoff-answer'; orderId: string; text: string; cancelled?: boolean }
  | { t: 'pong' }

// --- checking what a client sends ---------------------------------------------------------------

export type FastParse = { ok: true; frame: FastClientFrame } | { ok: false; status: number; message: string }

const bad = (message: string, status = 400): FastParse => ({ ok: false, status, message })
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
// A client's id never starts with 'o:': that prefix is the hub's own turns (orderTurn).
const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v) && !v.startsWith('o:')

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
      return { ok: true, frame: { t: 'ask', id: v.id, text, via: v.via, ...(v.thorough === true ? { thorough: true } : {}) } }
    }
    case 'cancel':
      return isId(v.id) ? { ok: true, frame: { t: 'cancel', id: v.id } } : bad('cancel needs the id of the ask.')
    case 'stop':
      return { ok: true, frame: { t: 'stop' } }
    case 'ping':
      return { ok: true, frame: { t: 'ping' } }
    default:
      return bad(`No such frame: ${v.t.slice(0, 20)}.`)
  }
}
