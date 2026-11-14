// F-087 (slice 1): the fast Assistant, page side. Pure: no DOM, no sockets. The frames are Overlay's contract
// (shared/fast.ts, FAST-PROTOCOL.md); the reducer is what the bar shows, and the sentence cutter is what the voice reads aloud,
// one sentence at a time.
import { CARD_GONE_REASONS, type FastClientFrame, type FastServerFrame, type FastState, type HandoffPhase, type TalkCard } from './fast.ts'

export type { FastServerFrame, FastState, HandoffPhase, TalkCard }
/** Fast = Haiku (the default); Thorough = Sonnet (Shubham's yes: "haiku plus sonnet"). */
export type Answers = 'fast' | 'thorough'

const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const STATES: readonly unknown[] = ['off', 'starting', 'ready', 'unavailable', 'paused', 'taken-over', 'stopped']
const PHASES: readonly unknown[] = ['queued', 'typed', 'working', 'waiting-you', 'slow', 'not-taken']

/** F-221 (ob98a): a tap-to-send card as the hub sends it, checked field by field; null when anything is off. */
function cardOf(raw: unknown): TalkCard | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  if (!str(c.id) || !num(c.version) || (c.kind !== 'handoff' && c.kind !== 'relay') || !str(c.to) || !str(c.text) || (c.via !== 'voice' && c.via !== 'typed') || !num(c.createdAt) || !num(c.expiresAt)) return null
  return { id: c.id, version: c.version, kind: c.kind, to: c.to, text: c.text, via: c.via, createdAt: c.createdAt, expiresAt: c.expiresAt }
}

/** A frame from the hub, or null: anything unknown is ignored, never trusted. */
export function parseFrame(raw: unknown): FastServerFrame | null {
  let o: unknown = raw
  if (str(raw)) {
    try {
      o = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof o !== 'object' || o === null) return null
  const f = o as Record<string, unknown>
  switch (f.t) {
    case 'state':
      return STATES.includes(f.state) ? { t: 'state', state: f.state as FastState, reason: str(f.reason) ? f.reason : undefined, model: f.model === 'haiku' || f.model === 'sonnet' ? f.model : undefined, ...(f.holds === true ? { holds: true } : {}) } : null
    case 'delta':
      return str(f.id) && str(f.text) ? { t: 'delta', id: f.id, text: f.text } : null
    case 'flush':
      return str(f.id) ? { t: 'flush', id: f.id } : null
    case 'tool':
      return str(f.id) && str(f.label) ? { t: 'tool', id: f.id, name: str(f.name) ? f.name : '', label: f.label.slice(0, 60) } : null
    case 'done':
      // Order o7f34: which answerer wrote it (the efficient route labels and times each answer by it); left out for the Assistant.
      return str(f.id) ? { t: 'done', id: f.id, text: str(f.text) ? f.text : '', cancelled: f.cancelled === true ? true : undefined, ...(f.source === 'api' || f.source === 'subscription' ? { source: f.source } : {}), ...(num(f.costUsd) ? { costUsd: f.costUsd } : {}), ...(num(f.ttftMs) ? { ttftMs: f.ttftMs } : {}) } : null
    case 'error':
      return str(f.message) ? { t: 'error', id: str(f.id) ? f.id : undefined, status: num(f.status) ? f.status : 500, message: f.message } : null
    case 'handoff':
      return str(f.id) && str(f.orderId) ? { t: 'handoff', id: f.id, orderId: f.orderId, line: str(f.line) ? f.line : '' } : null
    case 'handoff-progress':
      return str(f.orderId) && PHASES.includes(f.phase) ? { t: 'handoff-progress', orderId: f.orderId, phase: f.phase as HandoffPhase, sec: num(f.sec) ? f.sec : 0, words: str(f.words) ? f.words.slice(0, 80) : undefined } : null
    case 'handoff-answer':
      return str(f.orderId) && str(f.text) ? { t: 'handoff-answer', orderId: f.orderId, text: f.text, cancelled: f.cancelled === true ? true : undefined } : null
    case 'card': {
      // F-221 (ob98a): live talk's tap-to-send cards (the page draws them; the bar's view below leaves them to it).
      const card = cardOf(f.card)
      return card ? { t: 'card', card } : null
    }
    case 'card-gone':
      return str(f.id) && CARD_GONE_REASONS.includes(f.reason as never) ? { t: 'card-gone', id: f.id, reason: f.reason as (typeof CARD_GONE_REASONS)[number], ...(str(f.orderId) ? { orderId: f.orderId } : {}) } : null
    case 'pong':
      return { t: 'pong' }
    default:
      return null
  }
}

// --- what the bar shows ------------------------------------------------------------------------------------------

/** listening: the mic is open. thinking: asked, no word back yet (or the tool chip). speaking: the answer streams in and is read.
 *  asking: the order is with the Orchestrator. idle: ready for the next question. */
export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'asking'

export interface Handoff {
  orderId: string
  /** The Assistant's own line ("I've asked the Orchestrator"). */
  line: string
  phase: HandoffPhase
  /** Seconds since it was given. */
  sec: number
  /** The Orchestrator's spinner words, while it works. */
  words: string
  /** waiting: out with the Orchestrator. answered. failed: it did not take it. cancelled: the order was stopped. */
  status: 'waiting' | 'answered' | 'failed' | 'cancelled'
}

export interface AssistantView {
  /** The bar is open: it listens and answers. */
  armed: boolean
  phase: Phase
  server: FastState | 'unknown'
  serverNote: string
  /** The id of the turn being answered (the page's ask, or the hub's `o:<order>` turn); frames of another turn are old news. */
  turn: string | null
  asked: string
  reply: string
  tool: string | null
  handoff: Handoff | null
  /** The Orchestrator's answer, in full, once it is back (shown in the bar; the Assistant says a short version). */
  answer: string
  error: string | null
  /**
   * F-221 (ob98a, T4): the tap-to-send cards of this link ("Spoken hand-offs: Tap to send"), as the hub sends them (`card`, `card-gone`). T4 phase 2:
   * the bar draws them with live talk's TalkCard (AssistantBar.tsx).
   */
  cards: TalkCard[]
  /** F-221 (T4): the hub's o:<order> turns he stopped (newest last, a few): a later word of one is never taken up again. */
  cut: string[]
}

export const initialView = (): AssistantView => ({
  armed: false,
  phase: 'idle',
  server: 'unknown',
  serverNote: '',
  turn: null,
  asked: '',
  reply: '',
  tool: null,
  handoff: null,
  answer: '',
  error: null,
  cards: [],
  cut: [],
})

export type ViewEvent =
  | { type: 'arm' }
  /** The bar opens without listening (an answer came back while it was shut). */
  | { type: 'show' }
  | { type: 'disarm' }
  | { type: 'listen' }
  /** The question was sent. */
  | { type: 'ask'; turn: string; text: string }
  /**
   * Stop the answer (barge-in, Stop): the turn is over for the page. `cut` (F-221 T4 review): HE stopped it (the Stop button, Talk or Alt+K over an
   * answer): the hub's o: turn in hand is cut for good. Without it (the mic heard nothing, the bar opened quietly) an o: telling is taken up again
   * by its next words, as before T4.
   */
  | { type: 'stop'; cut?: boolean }
  | { type: 'frame'; frame: FastServerFrame }
  /** The page could not reach the hub, or the mic could not listen. */
  | { type: 'down'; error: string }
  /** F-221 (T4): the link to the hub opened (again): the cards of a link before it went with it (the hub drops a closed socket's cards). */
  | { type: 'relink' }
  /**
   * F-221 (T4 phase 2): his tap sent or dropped this card (TalkCard's onGone): it leaves the bar at once (the hub's card-gone comes too while the link
   * is open; once it is not, nothing else would take it away).
   */
  | { type: 'card-done'; id: string }

const waiting = (v: AssistantView) => v.handoff?.status === 'waiting'
/** A turn the hub started: the Assistant telling the answer to an order. */
export const isOrderTurn = (id: string) => id.startsWith('o:')
/** F-221 (T4): at most this many stopped o: turns are remembered (a turn tells one answer; a few cover any overlap). */
export const CUT_KEPT = 8
/** F-221 (T4): the turn in hand ends here; when it is the hub's o: turn (telling an answer), its later words are not taken up again. */
const cutOf = (v: AssistantView): string[] => (v.turn && isOrderTurn(v.turn) && !v.cut.includes(v.turn) ? [...v.cut, v.turn].slice(-CUT_KEPT) : v.cut)

export function reduce(v: AssistantView, e: ViewEvent): AssistantView {
  switch (e.type) {
    case 'arm':
      return v.armed ? v : { ...v, armed: true, phase: 'listening', error: null }
    case 'show':
      return v.armed ? v : { ...v, armed: true, phase: 'idle' }
    case 'disarm':
      // An order still out keeps its place (its answer may come back to a closed bar); anything settled is cleared. F-221 (T4): the link stays only
      // while an order is out (store.ts closeBar), and the cards with it; the stopped o: turns are remembered either way.
      return { ...initialView(), server: v.server, serverNote: v.serverNote, handoff: waiting(v) ? v.handoff : null, answer: waiting(v) ? v.answer : '', cards: waiting(v) ? v.cards : [], cut: cutOf(v) }
    case 'listen':
      return v.armed ? { ...v, phase: 'listening', error: null } : v
    case 'ask':
      return { ...v, armed: true, phase: 'thinking', turn: e.turn, asked: e.text, reply: '', tool: null, handoff: waiting(v) ? v.handoff : null, answer: '', error: null, cut: cutOf(v) }
    case 'stop':
      return { ...v, phase: waiting(v) ? 'asking' : 'idle', tool: null, turn: null, cut: e.cut ? cutOf(v) : v.cut }
    case 'down':
      // T4 review: a mic that fails is not his Stop: an o: telling it interrupts goes on (its next words take it up again).
      return { ...v, phase: waiting(v) ? 'asking' : 'idle', tool: null, turn: null, error: e.error }
    case 'relink':
      return v.cards.length ? { ...v, cards: [] } : v
    case 'card-done':
      return v.cards.some(c => c.id === e.id) ? { ...v, cards: v.cards.filter(c => c.id !== e.id) } : v
    case 'frame':
      return onFrame(v, e.frame)
  }
}

/**
 * F-221 (ob98a, T4): a link's cards after one of the hub's frames: a new card is added, a changed one (a higher version) replaces it, an older copy
 * changes nothing; a card that went is taken out; any other frame leaves them as they are (the same array, so nothing redraws). One rule for the
 * Alt+K bar (the reducer below) and Live talking classic (src/live/classic/prelude.ts).
 */
export function keepCards(cards: readonly TalkCard[], f: FastServerFrame): readonly TalkCard[] {
  if (f.t === 'card') {
    const i = cards.findIndex(c => c.id === f.card.id)
    if (i < 0) return [...cards, f.card]
    return f.card.version > cards[i].version ? cards.map((c, j) => (j === i ? f.card : c)) : cards
  }
  if (f.t === 'card-gone') return cards.some(c => c.id === f.id) ? cards.filter(c => c.id !== f.id) : cards
  return cards
}

const mine = (v: AssistantView, id: string | undefined): boolean => id !== undefined && id === v.turn
const ended = (v: AssistantView): AssistantView['phase'] => (waiting(v) ? 'asking' : 'idle')

/** What the progress of an order says, in a plain line. */
export function progressLine(h: Handoff): string {
  switch (h.phase) {
    case 'queued':
      return 'Waiting for it to be free'
    case 'typed':
      return 'It has the order'
    case 'working':
      return h.words ? h.words : 'Working on it'
    case 'waiting-you':
      return 'It is waiting for your answer on the PC'
    case 'slow':
      return h.words ? `Still working: ${h.words}` : 'Still working'
    case 'not-taken':
      return 'It did not take the order'
  }
}

function onFrame(v: AssistantView, f: FastServerFrame): AssistantView {
  switch (f.t) {
    case 'state':
      return { ...v, server: f.state, serverNote: f.reason ?? '' }
    case 'delta':
      // A turn the hub starts (the Assistant telling an order's answer) is taken up when nothing else is being answered. F-221 (T4): never one he
      // stopped (its words may still be on their way after the cancel).
      if (isOrderTurn(f.id) && v.turn === null && !v.cut.includes(f.id)) return { ...v, turn: f.id, phase: 'speaking', asked: '', reply: f.text }
      return mine(v, f.id) ? { ...v, phase: 'speaking', reply: v.reply + f.text } : v
    case 'flush':
      return v
    case 'tool':
      return mine(v, f.id) ? { ...v, tool: f.label } : v
    case 'done':
      return mine(v, f.id) ? { ...v, phase: ended(v), tool: null, turn: null } : v
    case 'error':
      if (f.id === undefined) return { ...v, error: f.message }
      return mine(v, f.id) ? { ...v, phase: ended(v), tool: null, turn: null, error: f.message } : v
    case 'handoff':
      // The turn may still be streaming its line; the phase becomes "asking" when it is done. F-221 (T4 review): the hand-off his tap on a card
      // made (followed since its card-gone, below) comes with the id of the ask that made the card, long over: it only gives its line.
      if (mine(v, f.id)) return { ...v, handoff: { orderId: f.orderId, line: f.line, phase: 'queued', sec: 0, words: '', status: 'waiting' } }
      return v.handoff?.orderId === f.orderId && v.handoff.status === 'waiting' && f.line !== v.handoff.line ? { ...v, handoff: { ...v.handoff, line: f.line } } : v
    case 'handoff-progress': {
      if (v.handoff?.orderId !== f.orderId) return v
      const h = { ...v.handoff, phase: f.phase, sec: f.sec, words: f.words ?? v.handoff.words }
      return { ...v, handoff: { ...h, status: f.phase === 'not-taken' ? 'failed' : 'waiting' }, phase: v.phase === 'asking' && f.phase === 'not-taken' ? 'idle' : v.phase }
    }
    case 'handoff-answer': {
      const same = v.handoff?.orderId === f.orderId
      return { ...v, handoff: same && v.handoff ? { ...v.handoff, status: f.cancelled ? 'cancelled' : 'answered' } : v.handoff, answer: f.cancelled ? '' : f.text, phase: v.phase === 'asking' ? 'idle' : v.phase }
    }
    // F-221 (ob98a, T4): the bar keeps its link's cards (Spoken hand-offs: Tap to send), by keepCards' rule; AssistantBar.tsx draws them.
    case 'card':
    case 'card-gone': {
      const cards = keepCards(v.cards, f)
      const next = cards === v.cards ? v : { ...v, cards: [...cards] }
      // F-221 (T4 review): his tap sent one of this link's cards and it became an order (the hub says which): the bar follows it from here as it
      // follows a hand-off made the old way ("Asking the ..." with its progress; closing the bar keeps the link while it is out, so the answer comes
      // back to it). Its turn is long over by now, so the hub's `handoff` frame (that turn's id) alone would never be taken up. Whether the card is
      // still in the view does not matter (his tap's own card-done may have taken it out first): the hub tells only the card's own link.
      if (f.t !== 'card-gone' || f.reason !== 'sent' || !f.orderId || next.handoff?.orderId === f.orderId) return next
      return { ...next, handoff: { orderId: f.orderId, line: '', phase: 'queued', sec: 0, words: '', status: 'waiting' }, phase: next.phase === 'idle' ? 'asking' : next.phase }
    }
    case 'pong':
      return v
  }
}

/**
 * F-221 (T4): the bar's buttons. Stop while it thinks or answers, and also while its voice still reads the end of an answer after `done` (the
 * phase is over but the sentences are not); Talk otherwise, when it is not listening already.
 */
export function barButtons(v: AssistantView, reading: boolean): { stop: boolean; talk: boolean } {
  const stop = v.phase === 'thinking' || v.phase === 'speaking' || reading
  return { stop, talk: !stop && v.phase !== 'listening' }
}

/** The word on the bar's state: the same words wherever the bar is. */
export function stateWord(v: AssistantView, micLive: boolean, big = 'Orchestrator'): string {
  if (v.server === 'off') return 'Off'
  if (v.server === 'unavailable') return 'Unavailable'
  if (v.server === 'taken-over') return 'Taken over'
  switch (v.phase) {
    case 'listening':
      return micLive ? 'Listening' : 'Opening mic…'
    case 'thinking':
      return v.tool ? 'Looking' : v.server === 'starting' ? 'Starting…' : 'Thinking'
    case 'speaking':
      return 'Answering'
    case 'asking':
      return `Asking the ${big}`
    default:
      return v.server === 'paused' ? 'Paused' : 'Ready'
  }
}

// --- reading the answer aloud ------------------------------------------------------------------------------------

/** Markdown and symbols out of a text, so a voice does not say "asterisk asterisk". */
export const spokenText = (t: string): string =>
  t
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[*_`#>|~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * A sentence ends at . ! ? or the Devanagari danda, followed by a space; a very short one of a single word waits for the next, so "e.g.", "No." (as
 * in "No. 5") and the like are not read alone. F-221 (T4): a short sentence of two words or more ("One moment.", "On it.") is a sentence: it is read
 * as soon as it is whole, not held back until the next one (or the end of the answer).
 */
const SENTENCE_END = /[.!?।॥]+["')\]]?(?=\s)/g
const MIN_SENTENCE = 12
/** A full stop that belongs to an abbreviation is not a sentence end. */
const ABBREVIATION = /\b(?:e\.g|i\.e|vs|etc|mr|mrs|dr|approx)\.$/i
/** Long enough to be read alone: 12 characters, or two words or more. */
const wholeSentence = (s: string) => s.length >= MIN_SENTENCE || /\S\s+\S/.test(s)

/**
 * The next sentences ready to be read out of the text that has arrived so far, and what is left over.
 * `done`: nothing more is coming, so the rest is read too.
 */
export function takeSentences(buffer: string, done = false): { sentences: string[]; rest: string } {
  const sentences: string[] = []
  let from = 0
  SENTENCE_END.lastIndex = 0
  for (let m = SENTENCE_END.exec(buffer); m; m = SENTENCE_END.exec(buffer)) {
    const end = m.index + m[0].length
    const s = buffer.slice(from, end).trim()
    if (wholeSentence(s) && !ABBREVIATION.test(s)) {
      sentences.push(s)
      from = end
    }
  }
  let rest = buffer.slice(from)
  if (done && rest.trim() !== '') {
    sentences.push(rest.trim())
    rest = ''
  }
  return { sentences: sentences.map(spokenText).filter(s => s !== ''), rest }
}

// --- the Settings the Assistant keeps (this browser) ---------------------------------------------------------------

/**
 * F-221 (ob98a, T4): what a hand-off of the Assistant's becomes. 'tap' (the default, his decision 4): a card on his screen that only his tap on Send
 * gives to the big chat (the link HOLDS: `hold {on:true}`). 'at-once': typed into the big chat straight away, the old way, kept as a setting.
 */
export type HandOffs = 'tap' | 'at-once'

export interface AssistantSettings {
  /** The fast Assistant is switched on for this browser: Alt+K and the dot open its bar. Off until the hub has one (slice 1). */
  enabled: boolean
  answers: Answers
  /** Read the answers aloud, sentence by sentence (Shubham's yes). */
  speak: boolean
  /** After each answer it listens again (Shubham's yes: on by default). */
  handsFree: boolean
  /** F-221 (T4): Spoken hand-offs: Tap to send (the default) or Send at once (the old way). The bar and Live talking classic both follow it. */
  handOffs: HandOffs
}
export const DEFAULT_ASSISTANT: AssistantSettings = { enabled: false, answers: 'fast', speak: true, handsFree: true, handOffs: 'tap' }

export function parseAssistantSettings(raw: unknown): AssistantSettings {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  return {
    enabled: b(o.enabled, DEFAULT_ASSISTANT.enabled),
    answers: o.answers === 'thorough' ? 'thorough' : 'fast',
    speak: b(o.speak, DEFAULT_ASSISTANT.speak),
    handsFree: b(o.handsFree, DEFAULT_ASSISTANT.handsFree),
    // Only the old way's own word turns it off: anything else is the safe default.
    handOffs: o.handOffs === 'at-once' ? 'at-once' : 'tap',
  }
}

/**
 * F-221 (ob98a, T4 review; T4 phase 2): the bar's and Live talking classic's cards are drawn, with live talk's TalkCard: in the bar
 * (AssistantBar.tsx) and in a panel over the classic page (LiveClassic.tsx). So "Tap to send" (the default) holds their hand-offs for his tap, and
 * the setting is shown. Before phase 2 no screen drew them and this was false: neither held a hand-off (it would have waited on a card nobody saw
 * while Quick said it was on his screen). src/assistant/store-hold.test.mjs and bar-cards.test.mjs pin it to the drawing in both places.
 */
export const TAP_CARDS_DRAWN = true

/** F-221 (T4): does a link of the bar or of Live talking classic hold the Assistant's hand-offs for his tap? "Tap to send", where cards are drawn. */
export const holdsHandOffs = (handOffs: HandOffs, drawn: boolean = TAP_CARDS_DRAWN): boolean => drawn && handOffs === 'tap'

/**
 * F-221 (ob98a, T4): what claims the Assistant for this tab: `start`, then the hold latch (`hold`: holdsHandOffs), after EVERY start (the first, a
 * reconnect's, and the one that takes it back from another screen). A plain start begins with hold off and a reconnect only ever raises it, so the
 * hold is always said, on or off.
 */
export function startFrames(id: string, resume: boolean, hold: boolean): FastClientFrame[] {
  return [{ t: 'start', client: 'web', id, ...(resume ? { resume: true } : {}) }, { t: 'hold', on: hold }]
}

// --- the voice ------------------------------------------------------------------------------------------------------

/** What the voice picker reads of a voice (the browser's SpeechSynthesisVoice has these). */
export interface VoiceInfo {
  lang: string
  localService: boolean
}

/**
 * The voice for a language: one on this computer first (its text stays here), then any. F-221 (T4): within each, the language itself (en-IN for
 * en-IN) before another of the same family (en-US): an exact match is never passed over for a cousin. Undefined: none speaks the language.
 */
export function pickVoice<V extends VoiceInfo>(voices: readonly V[], lang: string): V | undefined {
  const norm = (l: string) => l.replace(/_/g, '-').toLowerCase()
  const want = norm(lang)
  const base = want.slice(0, 2)
  const exact = voices.filter(v => norm(v.lang) === want)
  const family = voices.filter(v => norm(v.lang) !== want && norm(v.lang).slice(0, 2) === base)
  return exact.find(v => v.localService) ?? family.find(v => v.localService) ?? exact[0] ?? family[0]
}

// --- what the chats are called -----------------------------------------------------------------------------------

/**
 * F-086: today's overlay chat becomes the Orchestrator and the name Assistant moves to the fast agent. Shubham
 * decides when the new names show: "old" is the default until he says so; "new" is a Settings choice.
 */
export type NamesChoice = 'old' | 'new'
export const DEFAULT_NAMES: NamesChoice = 'old'
export const parseNames = (raw: unknown): NamesChoice => (raw === 'new' ? 'new' : 'old')

export interface Names {
  /** The big chat on its own floor (today's overlay chat): "Assistant" in the old way, "Orchestrator" in the new. */
  big: string
  /** The fast agent: "Quick" in the old way (the name Assistant is still the big one's), "Assistant" in the new. */
  fast: string
}
export const NAMES: Record<NamesChoice, Names> = {
  old: { big: 'Assistant', fast: 'Quick' },
  new: { big: 'Orchestrator', fast: 'Assistant' },
}
export const namesOf = (c: NamesChoice): Names => NAMES[c]
