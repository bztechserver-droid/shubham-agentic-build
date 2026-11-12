// F-087 (slice 1): the fast Assistant, page side. Pure: no DOM, no sockets. The frames are Overlay's contract
// (shared/fast.ts, FAST-PROTOCOL.md); the reducer is what the bar shows, and the sentence cutter is what the voice reads aloud,
// one sentence at a time.
import type { FastServerFrame, FastState, HandoffPhase } from './fast.ts'

export type { FastServerFrame, FastState, HandoffPhase }
/** Fast = Haiku (the default); Thorough = Sonnet (Shubham's yes: "haiku plus sonnet"). */
export type Answers = 'fast' | 'thorough'

const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const STATES: readonly unknown[] = ['off', 'starting', 'ready', 'unavailable', 'paused', 'taken-over', 'stopped']
const PHASES: readonly unknown[] = ['queued', 'typed', 'working', 'waiting-you', 'slow', 'not-taken']

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
      return STATES.includes(f.state) ? { t: 'state', state: f.state as FastState, reason: str(f.reason) ? f.reason : undefined, model: f.model === 'haiku' || f.model === 'sonnet' ? f.model : undefined } : null
    case 'delta':
      return str(f.id) && str(f.text) ? { t: 'delta', id: f.id, text: f.text } : null
    case 'flush':
      return str(f.id) ? { t: 'flush', id: f.id } : null
    case 'tool':
      return str(f.id) && str(f.label) ? { t: 'tool', id: f.id, name: str(f.name) ? f.name : '', label: f.label.slice(0, 60) } : null
    case 'done':
      // Order o7f34: which answerer wrote it (the efficient route labels and times each answer by it); left out for the Assistant.
      return str(f.id) ? { t: 'done', id: f.id, text: str(f.text) ? f.text : '', cancelled: f.cancelled === true ? true : undefined, ...(f.source === 'api' || f.source === 'subscription' ? { source: f.source } : {}), ...(num(f.costUsd) ? { costUsd: f.costUsd } : {}) } : null
    case 'error':
      return str(f.message) ? { t: 'error', id: str(f.id) ? f.id : undefined, status: num(f.status) ? f.status : 500, message: f.message } : null
    case 'handoff':
      return str(f.id) && str(f.orderId) ? { t: 'handoff', id: f.id, orderId: f.orderId, line: str(f.line) ? f.line : '' } : null
    case 'handoff-progress':
      return str(f.orderId) && PHASES.includes(f.phase) ? { t: 'handoff-progress', orderId: f.orderId, phase: f.phase as HandoffPhase, sec: num(f.sec) ? f.sec : 0, words: str(f.words) ? f.words.slice(0, 80) : undefined } : null
    case 'handoff-answer':
      return str(f.orderId) && str(f.text) ? { t: 'handoff-answer', orderId: f.orderId, text: f.text, cancelled: f.cancelled === true ? true : undefined } : null
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
})

export type ViewEvent =
  | { type: 'arm' }
  /** The bar opens without listening (an answer came back while it was shut). */
  | { type: 'show' }
  | { type: 'disarm' }
  | { type: 'listen' }
  /** The question was sent. */
  | { type: 'ask'; turn: string; text: string }
  /** Stop the answer (barge-in, Stop): the turn is over for the page. */
  | { type: 'stop' }
  | { type: 'frame'; frame: FastServerFrame }
  /** The page could not reach the hub, or the mic could not listen. */
  | { type: 'down'; error: string }

const waiting = (v: AssistantView) => v.handoff?.status === 'waiting'
/** A turn the hub started: the Assistant telling the answer to an order. */
export const isOrderTurn = (id: string) => id.startsWith('o:')

export function reduce(v: AssistantView, e: ViewEvent): AssistantView {
  switch (e.type) {
    case 'arm':
      return v.armed ? v : { ...v, armed: true, phase: 'listening', error: null }
    case 'show':
      return v.armed ? v : { ...v, armed: true, phase: 'idle' }
    case 'disarm':
      // An order still out keeps its place (its answer may come back to a closed bar); anything settled is cleared.
      return { ...initialView(), server: v.server, serverNote: v.serverNote, handoff: waiting(v) ? v.handoff : null, answer: waiting(v) ? v.answer : '' }
    case 'listen':
      return v.armed ? { ...v, phase: 'listening', error: null } : v
    case 'ask':
      return { ...v, armed: true, phase: 'thinking', turn: e.turn, asked: e.text, reply: '', tool: null, handoff: waiting(v) ? v.handoff : null, answer: '', error: null }
    case 'stop':
      return { ...v, phase: waiting(v) ? 'asking' : 'idle', tool: null, turn: null }
    case 'down':
      return { ...v, phase: waiting(v) ? 'asking' : 'idle', tool: null, turn: null, error: e.error }
    case 'frame':
      return onFrame(v, e.frame)
  }
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
      // A turn the hub starts (the Assistant telling an order's answer) is taken up when nothing else is being answered.
      if (isOrderTurn(f.id) && v.turn === null) return { ...v, turn: f.id, phase: 'speaking', asked: '', reply: f.text }
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
      // The turn may still be streaming its line; the phase becomes "asking" when it is done.
      return mine(v, f.id) ? { ...v, handoff: { orderId: f.orderId, line: f.line, phase: 'queued', sec: 0, words: '', status: 'waiting' } } : v
    case 'handoff-progress': {
      if (v.handoff?.orderId !== f.orderId) return v
      const h = { ...v.handoff, phase: f.phase, sec: f.sec, words: f.words ?? v.handoff.words }
      return { ...v, handoff: { ...h, status: f.phase === 'not-taken' ? 'failed' : 'waiting' }, phase: v.phase === 'asking' && f.phase === 'not-taken' ? 'idle' : v.phase }
    }
    case 'handoff-answer': {
      const same = v.handoff?.orderId === f.orderId
      return { ...v, handoff: same && v.handoff ? { ...v.handoff, status: f.cancelled ? 'cancelled' : 'answered' } : v.handoff, answer: f.cancelled ? '' : f.text, phase: v.phase === 'asking' ? 'idle' : v.phase }
    }
    case 'pong':
      return v
  }
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

/** A sentence ends at . ! ? or the Devanagari danda, followed by a space; a very short one waits for the next so "e.g." and "No." are not read alone. */
const SENTENCE_END = /[.!?।॥]+["')\]]?(?=\s)/g
const MIN_SENTENCE = 12
/** A full stop that belongs to an abbreviation is not a sentence end. */
const ABBREVIATION = /\b(?:e\.g|i\.e|vs|etc|mr|mrs|dr|approx)\.$/i

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
    if (s.length >= MIN_SENTENCE && !ABBREVIATION.test(s)) {
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

export interface AssistantSettings {
  /** The fast Assistant is switched on for this browser: Alt+K and the dot open its bar. Off until the hub has one (slice 1). */
  enabled: boolean
  answers: Answers
  /** Read the answers aloud, sentence by sentence (Shubham's yes). */
  speak: boolean
  /** After each answer it listens again (Shubham's yes: on by default). */
  handsFree: boolean
}
export const DEFAULT_ASSISTANT: AssistantSettings = { enabled: false, answers: 'fast', speak: true, handsFree: true }

export function parseAssistantSettings(raw: unknown): AssistantSettings {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  return {
    enabled: b(o.enabled, DEFAULT_ASSISTANT.enabled),
    answers: o.answers === 'thorough' ? 'thorough' : 'fast',
    speak: b(o.speak, DEFAULT_ASSISTANT.speak),
    handsFree: b(o.handsFree, DEFAULT_ASSISTANT.handsFree),
  }
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
