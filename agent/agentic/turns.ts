import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { ChatState } from '../../shared/agentic.ts'
import type { ClaudeTurn } from '../../shared/chat.ts'
import { squashPrompt } from './chats.ts'

// Stage 1 of the simple chat-terminal layer (order o400b, Sync Research plan rules 1-4, 12 Nov 2026): what a Claude chat is doing, read from
// Claude's OWN TRANSCRIPT, never from its screen and with no new hooks. The rows Claude 2.1.322 writes (checked on 30 real transcripts of this
// PC, 578 MB, and Sync Research's lab runs r1-r4):
//   - a prompt it TOOK: a `user` row with `promptSource` (typed, queued, suggestion_accepted, system for task notifications, scheduled tasks
//     and inbox messages), 150-270 ms after Enter; while it is busy an `enqueue` row instead (~150 ms), then `dequeue` (it runs as the next
//     turn: a `user` row with promptSource "queued") or `remove` plus a `queued_command` attachment (it was taken in mid-turn);
//   - a question open: an assistant `tool_use` of AskUserQuestion or ExitPlanMode (~150 ms after the menu opens), until its `tool_result`;
//   - a turn's end: the `system` row `turn_duration` (every normal end and API error, 120-215 ms after Claude's Stop), or the
//     "[Request interrupted by user…" row after Esc (Esc writes no turn_duration while text was being written, and fires no hook).
// Compaction rows (compact_boundary, isCompactSummary), local commands (/model, /clear), `!` shell lines and the rows the app's own engine
// conversion wrote (no promptId, no promptSource) never change the state.

/** What one transcript row says about the conversation, in the order Claude wrote it. */
export type TurnSignal =
  | { k: 'prompt'; text: string; at: number }
  /** A user text row that is not one of Claude's own prompt rows (no promptSource, no promptId: an older Claude, or a row the app wrote). The state ignores it; an order's marker in it still counts. */
  | { k: 'text'; text: string; at: number }
  | { k: 'enqueue'; text: string; at: number }
  | { k: 'dequeue'; at: number }
  | { k: 'unqueue'; text: string; at: number }
  | { k: 'absorbed'; text: string; at: number }
  | { k: 'said'; id: string; text: string; error: boolean; at: number }
  | { k: 'ask'; ids: string[]; at: number }
  | { k: 'answered'; ids: string[]; at: number }
  | { k: 'end'; how: 'finished' | 'interrupted'; at: number }

type Row = Record<string, unknown>
const isObject = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v)
const ASK_TOOLS = /^(?:AskUserQuestion|ExitPlanMode)$/
const INTERRUPT_RE = /^\[Request interrupted by user/
/** A local slash command, its output, or a `!` shell line: typed at the prompt, but no turn of the model. */
const COMMAND_TAG_RE = /^<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/
/** The bookkeeping rows (api-request blobs can be megabytes) are never parsed; the five kinds that matter here are. */
const SKIP_ROW_RE = /^\{"type":"(?!user"|assistant"|system"|attachment"|queue-operation")/

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => isObject(b) && b.type === 'text' && typeof b.text === 'string').map(b => (b as { text: string }).text).join('\n') : ''
const timeOf = (row: Row): number => {
  const t = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
  return Number.isFinite(t) ? t : 0
}

/** One line of a transcript as a row, or null (not JSON, or a bookkeeping row that is skipped unread). */
export function parseTurnRow(line: string): Row | null {
  if (!line || SKIP_ROW_RE.test(line)) return null
  try {
    const v: unknown = JSON.parse(line)
    return isObject(v) ? v : null
  } catch {
    return null
  }
}

/** What a row says (pure). A sub-agent's rows (isSidechain) are its own conversation, not this one. */
export function signalsOf(row: Row): TurnSignal[] {
  if (row.isSidechain === true) return []
  const at = timeOf(row)
  if (row.type === 'system') return row.subtype === 'turn_duration' ? [{ k: 'end', how: 'finished', at }] : []
  if (row.type === 'queue-operation') {
    const text = typeof row.content === 'string' ? row.content : ''
    if (row.operation === 'enqueue') return [{ k: 'enqueue', text, at }]
    if (row.operation === 'dequeue') return [{ k: 'dequeue', at }]
    if (row.operation === 'remove') return [{ k: 'unqueue', text, at }]
    return []
  }
  if (row.type === 'attachment') {
    const a = row.attachment
    if (!isObject(a) || a.type !== 'queued_command') return []
    const text = typeof a.prompt === 'string' ? a.prompt : textOf(a.prompt)
    return [{ k: 'absorbed', text, at }]
  }
  const message = isObject(row.message) ? row.message : null
  if (row.type === 'assistant' && message) {
    const content = Array.isArray(message.content) ? message.content : []
    const out: TurnSignal[] = []
    const text = textOf(message.content)
    if (text.trim()) out.push({ k: 'said', id: typeof message.id === 'string' ? message.id : `${row.uuid ?? at}`, text, error: row.isApiErrorMessage === true, at })
    const asks = content.filter(b => isObject(b) && b.type === 'tool_use' && typeof b.name === 'string' && ASK_TOOLS.test(b.name) && typeof b.id === 'string').map(b => (b as { id: string }).id)
    if (asks.length) out.push({ k: 'ask', ids: asks, at })
    return out
  }
  if (row.type !== 'user' || !message) return []
  const content = message.content
  if (Array.isArray(content) && content.some(b => isObject(b) && b.type === 'tool_result')) {
    const ids = content.filter(b => isObject(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string').map(b => (b as { tool_use_id: string }).tool_use_id)
    const out: TurnSignal[] = [{ k: 'answered', ids, at }]
    if (INTERRUPT_RE.test(textOf(content).trim())) out.push({ k: 'end', how: 'interrupted', at })
    return out
  }
  const text = textOf(content)
  const trimmed = text.trim()
  if (INTERRUPT_RE.test(trimmed)) return [{ k: 'end', how: 'interrupted', at }]
  if (row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true || COMMAND_TAG_RE.test(trimmed)) return []
  // Claude's own prompt rows carry promptSource (a few older or meta ones only a promptId); the app's engine conversion writes neither.
  if (row.isMeta === true && typeof row.promptSource !== 'string') return []
  if (typeof row.promptSource !== 'string' && typeof row.promptId !== 'string') return trimmed ? [{ k: 'text', text, at }] : []
  return [{ k: 'prompt', text, at }]
}

/** The state machine of one chat, fed the signals of its transcript in order. */
export interface TurnModel {
  phase: 'busy' | 'asking' | 'idle'
  /** When the phase last changed (ms; the row's own time when it has one). */
  since: number
  stopped?: 'finished' | 'interrupted' | 'failed'
  /** The last assistant text of the turn running or just ended (one message's text blocks joined). */
  answer: string
  answerId: string
  /** The turn's last assistant row was an API error. */
  failed: boolean
  /** The open AskUserQuestion / ExitPlanMode calls. */
  asks: Set<string>
  /** What waits in Claude's queue (enqueue rows without their dequeue or remove), squashed. */
  queue: string[]
  /** A queued prompt was dequeued and its own prompt row is not written yet: it runs next (real rows: the dequeue comes BEFORE the turn's end). */
  next: boolean
  /** A turn ended while something was queued (or something was queued into an idle chat): Claude starts it at once; when (ms, this agent's clock), 0: not so. */
  queuedEndAt: number
  /** The prompts Claude took, recently (user rows, enqueue rows, queued_command): what the send confirmation compares with. The last 30. */
  heard: { norm: string; at: number }[]
}

export const newTurnModel = (now = 0): TurnModel => ({ phase: 'idle', since: now, answer: '', answerId: '', failed: false, asks: new Set(), queue: [], next: false, queuedEndAt: 0, heard: [] })

/** A turn that ended with something queued waits this long for the queued prompt to start; then the queue is taken as gone. */
export const QUEUED_START_MS = 10_000

const hear = (m: TurnModel, text: string, at: number) => {
  m.heard.push({ norm: squashPrompt(text), at })
  if (m.heard.length > 30) m.heard.shift()
}
const setPhase = (m: TurnModel, phase: TurnModel['phase'], at: number) => {
  if (m.phase === phase) return
  m.phase = phase
  m.since = at
}

/** One signal into the model (pure apart from `m`); `now` is this agent's clock. */
export function applyTurn(m: TurnModel, s: TurnSignal, now: number): void {
  const at = s.at || now
  switch (s.k) {
    case 'prompt': {
      // A new turn (Claude writes a prompt row only when it starts one: typed while idle, dequeued, a task or inbox message).
      hear(m, s.text, at)
      const norm = squashPrompt(s.text)
      const i = m.queue.indexOf(norm)
      if (i >= 0) m.queue.splice(i, 1)
      m.answer = ''
      m.answerId = ''
      m.failed = false
      m.stopped = undefined
      m.next = false
      m.queuedEndAt = 0
      setPhase(m, 'busy', at)
      return
    }
    case 'enqueue':
      hear(m, s.text, at)
      m.queue.push(squashPrompt(s.text))
      // Into an idle chat (an inbox message) it starts at once: enqueue, dequeue, its prompt row. Busy now; if it never starts, settleQueue.
      if (m.phase === 'idle') {
        m.queuedEndAt = now
        m.stopped = undefined
        setPhase(m, 'busy', at)
      }
      return
    case 'text':
      // Not Claude's own prompt row: no state from it (orders still read it, applyOrder).
      return
    case 'dequeue':
      // Taken off the queue to run as the next turn; its prompt row follows (after this turn's end, when one is running).
      m.queue.shift()
      m.next = true
      return
    case 'unqueue': {
      const i = m.queue.indexOf(squashPrompt(s.text))
      if (i >= 0) m.queue.splice(i, 1)
      else m.queue.shift()
      return
    }
    case 'absorbed': {
      hear(m, s.text, at)
      const i = m.queue.indexOf(squashPrompt(s.text))
      if (i >= 0) m.queue.splice(i, 1)
      return
    }
    case 'said':
      if (s.id === m.answerId) m.answer = `${m.answer}\n\n${s.text}`
      else {
        m.answer = s.text
        m.answerId = s.id
      }
      m.failed = s.error
      // Assistant rows are only ever written inside a turn: one seen while idle is a turn whose start this reading missed.
      if (m.phase === 'idle') {
        m.stopped = undefined
        setPhase(m, 'busy', at)
      }
      return
    case 'ask':
      for (const id of s.ids) m.asks.add(id)
      setPhase(m, 'asking', at)
      return
    case 'answered':
      for (const id of s.ids) m.asks.delete(id)
      if (m.phase === 'asking' && m.asks.size === 0) setPhase(m, 'busy', at)
      return
    case 'end':
      // The second end of a turn that already ended (Esc at a question menu writes its interrupt row, then turn_duration): the first one stands.
      if (m.phase === 'idle' && !m.queuedEndAt) return
      m.asks.clear()
      m.stopped = m.failed ? 'failed' : s.how
      if (m.queue.length || m.next) {
        // Claude starts what was queued at once (its prompt row follows within ~0.1 s): still busy.
        m.queuedEndAt = now
        setPhase(m, 'busy', at)
        return
      }
      m.queuedEndAt = 0
      setPhase(m, 'idle', at)
      return
  }
}

/** A queued prompt that never started (QUEUED_START_MS after the turn ended): the queue is taken as gone and the chat as idle. True when it changed. */
export function settleQueue(m: TurnModel, now: number): boolean {
  if (!m.queuedEndAt || now - m.queuedEndAt < QUEUED_START_MS) return false
  m.queue = []
  m.next = false
  m.queuedEndAt = 0
  setPhase(m, 'idle', now)
  return true
}

const PHASE_STATE: Record<TurnModel['phase'], ChatState> = { busy: 'running', asking: 'question', idle: 'idle' }
export const LAST_ANSWER_MAX = 4000

/** What the page is told (Web's contract, 12 Nov): state, since, how the last turn stopped, its last words (cut). */
export function turnOfModel(m: TurnModel): ClaudeTurn {
  const out: ClaudeTurn = { state: m.phase, since: new Date(m.since || 0).toISOString() }
  if (m.phase === 'idle' && m.stopped) out.stopped = m.stopped
  if (m.phase === 'idle' && m.answer) out.lastAnswer = m.answer.length > LAST_ANSWER_MAX ? `${m.answer.slice(0, LAST_ANSWER_MAX)}…` : m.answer
  return out
}

/** Did Claude take exactly `sent` (paste markers off, whitespace-insensitive, as the prompt report's rule) in a row stamped at or after `since`? */
export function heardIt(m: TurnModel, sent: string, since: number): boolean {
  const want = squashPrompt(sent.split('\u001b[201~').join(''))
  return want !== '' && m.heard.some(h => h.at >= since && h.norm === want)
}

// ---------------------------------------------------------------------------------------------
// Following the transcripts of the chats running here

export interface TurnReaderOptions {
  /** The Claude chats to follow now (running on this PC, in the simple layer), with when each started (ISO). */
  sessions(): { sessionId: string; startedAt: string }[]
  /** The session Claude is on now for a chat: its own, or the one /clear or /resume moved it to. */
  target?(sessionId: string): string
  /** The transcript file of a session, or null when there is none (yet). */
  find(sessionId: string): string | null
  pollMs?: number
  now?: () => number
  log?: { info(m: string): void; warn(m: string): void }
  /** A chat's state, how its turn stopped or its last words changed. */
  onChange?(sessionId: string): void
}

export interface TurnReader {
  /** running / question / idle as Claude's transcript says; null when this chat is not followed here, or Claude has not written its file yet. */
  state(sessionId: string): ChatState | null
  /** The same for the page's chat view (Web's `claude` object); null likewise. */
  turn(sessionId: string): ClaudeTurn | null
  /** A question (AskUserQuestion / ExitPlanMode) is open in the transcript now. */
  asking(sessionId: string): boolean
  /** Claude wrote a row taking exactly `text` (stamped at or after `since`); null likewise. */
  took(sessionId: string, text: string, since: number): boolean | null
  /** Tests: one look at every followed file now. */
  pollNow(): void
  close(): void
}

interface Follow {
  sessionId: string
  /** The session whose file is read (the chat's own, or its successor). */
  target: string
  file: string | null
  ident: string
  pos: number
  /** A line still being written (its bytes so far). */
  carry: Buffer | null
  model: TurnModel
  /**
   * Rows stamped before this (ms) are history: written by an earlier Claude process of the conversation (a resumed chat may have stopped mid-turn),
   * never this one's state. The chat's start, less a little.
   */
  notBefore: number
  lastPoll: number
  lastFind: number
  key: string
}
/** Rows a little older than the chat's recorded start still count (its start is stamped by the agent, its rows by Claude, on the same clock). */
const START_SLACK_MS = 2000

const identOf = (st: { ino: number | bigint; birthtimeMs: number }) => `${st.ino}:${Math.round(st.birthtimeMs)}`
const FIND_EVERY_MS = 1000
const LIST_EVERY_MS = 1000
const CATCH_UP_START = 256 * 1024
const CATCH_UP_MAX = 16 * 1024 * 1024
const READ_MAX = 8 * 1024 * 1024

function readRange(file: string, from: number, to: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const len = Math.max(0, to - from)
    const buf = Buffer.allocUnsafe(len)
    let got = 0
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, from + got)
      if (n <= 0) break
      got += n
    }
    return got === len ? buf : buf.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

/** The whole lines of a buffer as signals, in order; `first` false skips the first line (a window that starts mid-line). */
function signalsIn(buf: Buffer, first = true): TurnSignal[] {
  const out: TurnSignal[] = []
  let pos = 0
  if (!first) {
    const nl = buf.indexOf(0x0a)
    pos = nl === -1 ? buf.length : nl + 1
  }
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos)
    const end = nl === -1 ? buf.length : nl
    if (end > pos) {
      const row = parseTurnRow(buf.toString('utf8', pos, end))
      if (row) out.push(...signalsOf(row))
    }
    pos = end + 1
  }
  return out
}

/**
 * A chat's state from its file as it is now: read back from the end until the window holds a turn's end or reaches rows older than `notBefore` (the
 * chat's start: anything older is an earlier process's history), then the rows of this process replayed in order. Returns the model and where following
 * goes on (the end of the last whole line).
 */
function catchUp(file: string, size: number, now: number, notBefore: number): { model: TurnModel; pos: number } {
  let span = CATCH_UP_START
  for (;;) {
    const from = Math.max(0, size - span)
    const buf = readRange(file, from, size)
    const lastNl = buf.lastIndexOf(0x0a)
    const whole = lastNl === -1 ? Buffer.alloc(0) : buf.subarray(0, lastNl + 1)
    const all = signalsIn(whole, from === 0)
    const mine = all.filter(s => s.at >= notBefore)
    const reachesStart = all.some(s => s.at > 0 && s.at < notBefore)
    if (from === 0 || span >= CATCH_UP_MAX || reachesStart || mine.some(s => s.k === 'end')) {
      const model = newTurnModel(now)
      for (const s of mine) applyTurn(model, s, now)
      settleQueue(model, now)
      return { model, pos: from + whole.length }
    }
    span *= 4
  }
}

export function createTurnReader(o: TurnReaderOptions): TurnReader {
  const now = o.now ?? Date.now
  const follows = new Map<string, Follow>()
  const keyOf = (m: TurnModel) => `${m.phase}|${m.since}|${m.stopped ?? ''}|${m.phase === 'idle' ? m.answer.length : 0}`

  function begin(f: Follow) {
    f.lastFind = now()
    const file = o.find(f.target)
    f.file = file
    f.carry = null
    if (!file) {
      // No file yet (a new chat writes it with its first prompt): read it from its start once it is there.
      f.pos = 0
      f.ident = ''
      return
    }
    let st
    try {
      st = statSync(file)
    } catch {
      f.file = null
      return
    }
    f.ident = identOf(st)
    const c = catchUp(file, st.size, now(), f.notBefore)
    f.model = c.model
    f.pos = c.pos
    if (f.model.phase !== 'idle') o.log?.info(`chat ${f.sessionId.slice(0, 8)}: its transcript says it is ${f.model.phase} (read back from the end of its file)`)
  }

  function poll(f: Follow) {
    f.lastPoll = now()
    const before = f.key
    try {
      const target = o.target?.(f.sessionId) ?? f.sessionId
      if (target !== f.target) {
        // /clear or /resume: the same terminal goes on in another session and file (an older conversation's rows there are history, notBefore).
        f.target = target
        begin(f)
      } else if (!f.file) {
        if (now() - f.lastFind >= FIND_EVERY_MS) begin(f)
      }
      if (f.file) {
        let st
        try {
          st = statSync(f.file)
        } catch {
          f.file = null
          f.lastFind = 0
          return
        }
        if (identOf(st) !== f.ident || st.size < f.pos) {
          // Replaced or cut (a take-over's catch-up swapped another copy in): read back again.
          begin(f)
        } else if (st.size > f.pos) {
          const to = Math.min(st.size, f.pos + READ_MAX)
          const got = readRange(f.file, f.pos, to)
          f.pos += got.length
          const buf = f.carry ? Buffer.concat([f.carry, got]) : got
          const nl = buf.lastIndexOf(0x0a)
          f.carry = nl === buf.length - 1 ? null : buf.subarray(nl + 1)
          if (f.carry && f.carry.length > READ_MAX) f.carry = null // a line longer than anything read here: let it go
          if (nl !== -1) for (const s of signalsIn(buf.subarray(0, nl + 1))) applyTurn(f.model, s, now())
        }
      }
      settleQueue(f.model, now())
    } catch (e) {
      o.log?.warn(`chat ${f.sessionId.slice(0, 8)}: its transcript could not be read: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      f.key = keyOf(f.model)
      if (f.key !== before) {
        try {
          o.onChange?.(f.sessionId)
        } catch {
          // The listener's trouble.
        }
      }
    }
  }

  let listedAt = 0
  /** Which chats to follow, looked at once a second (a new chat is followed within a second); every followed file is looked at every tick. */
  function sync(force = false) {
    if (force || now() - listedAt >= LIST_EVERY_MS) {
      listedAt = now()
      const keep = new Set<string>()
      for (const s of o.sessions()) {
        keep.add(s.sessionId)
        if (follows.has(s.sessionId)) continue
        const started = Date.parse(s.startedAt)
        const f: Follow = { sessionId: s.sessionId, target: o.target?.(s.sessionId) ?? s.sessionId, file: null, ident: '', pos: 0, carry: null, model: newTurnModel(now()), notBefore: Number.isFinite(started) ? started - START_SLACK_MS : 0, lastPoll: 0, lastFind: 0, key: '' }
        follows.set(s.sessionId, f)
        // Its first reading is told too (the key starts empty): until now the page had the screen's guess.
        begin(f)
      }
      for (const sid of [...follows.keys()]) {
        if (keep.has(sid)) continue
        follows.delete(sid)
        try {
          o.onChange?.(sid)
        } catch {
          // The listener's trouble.
        }
      }
    }
    for (const f of follows.values()) poll(f)
  }

  const timer = setInterval(() => {
    try {
      sync()
    } catch (e) {
      o.log?.warn(`transcript reader: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, o.pollMs ?? 150)
  timer.unref?.()

  /** Fresh enough for a decision: read what was written since the last look (at most every 50 ms). */
  const fresh = (sid: string) => {
    const f = follows.get(sid)
    if (f && now() - f.lastPoll >= 50) poll(f)
    return f
  }

  // Until Claude has written the chat's file (a new chat writes it with its first prompt) there is nothing of its own to go by: null, and the pool
  // keeps the screen's reading for that while (as for a chat not followed here).
  const read = (f: Follow | undefined): Follow | null => (f && f.file ? f : null)
  return {
    state(sid) {
      const f = read(follows.get(sid))
      return f ? PHASE_STATE[f.model.phase] : null
    },
    turn(sid) {
      const f = read(follows.get(sid))
      return f ? turnOfModel(f.model) : null
    },
    asking(sid) {
      return read(fresh(sid))?.model.phase === 'asking'
    },
    took(sid, text, since) {
      const f = read(fresh(sid))
      return f ? heardIt(f.model, text, since) : null
    },
    pollNow: () => sync(true),
    close() {
      clearInterval(timer)
      follows.clear()
    },
  }
}

// ---------------------------------------------------------------------------------------------
// An order's turn (orders.ts, rule 4)

/** Where an order is in its target's transcript. */
export interface OrderTurn {
  /** Its message entered the conversation: its own user row, or a queued_command when Claude took it in mid-turn. */
  entered: boolean
  /** It waits in Claude's queue (an enqueue row carrying it), not taken in yet. */
  queued: boolean
  /** The first turn end after it entered is written. */
  ended: boolean
  /** The last assistant text before that end ('' when none). */
  answer: string
  how?: 'finished' | 'interrupted' | 'failed'
}

/** Follows one order through its target's transcript signals (pure). `mark` is ", order <id>]"; rows stamped before `since` are older orders' history. */
export interface OrderCursor extends OrderTurn {
  mark: string
  since: number
  answerId: string
  failed: boolean
}

export const newOrderCursor = (mark: string, since: number): OrderCursor => ({ mark, since, entered: false, queued: false, ended: false, answer: '', answerId: '', failed: false })

export function applyOrder(c: OrderCursor, s: TurnSignal): void {
  if (c.ended) return
  if (!c.entered) {
    if ((s.k === 'prompt' || s.k === 'text' || s.k === 'absorbed') && s.at >= c.since && s.text.includes(c.mark)) c.entered = true
    else if (s.k === 'enqueue' && s.at >= c.since && s.text.includes(c.mark)) c.queued = true
    return
  }
  if (s.k === 'said') {
    if (s.id === c.answerId) c.answer = `${c.answer}\n\n${s.text}`
    else {
      c.answer = s.text
      c.answerId = s.id
    }
    c.failed = s.error
  } else if (s.k === 'end') {
    c.ended = true
    c.how = c.failed ? 'failed' : s.how
  }
}

export interface OrderWatch {
  /** The order's turn in its target's transcript now; null when the target has no Claude transcript here. */
  turnOf(sessionId: string, orderId: string, since: number): OrderTurn | null
  /** An order that is closed: its cursor goes. */
  forget(orderId: string): void
}

/** Rows this long before an order was opened are read too (a clock between the app and Claude is the same PC's, but rows are stamped late). */
const ORDER_SLACK_MS = 60_000

/**
 * Each open order keeps a cursor in its target's transcript (the chat's own file, or its successor after /clear): read from a little before the order
 * was opened, then only what grew. Reads the target's file wherever it is found on this PC (a member's transcript copy on the hub too).
 */
export function createOrderWatch(o: { find(sessionId: string): string | null; target?(sessionId: string): string; now?: () => number }): OrderWatch {
  const cursors = new Map<string, { file: string; ident: string; pos: number; carry: Buffer | null; cursor: OrderCursor; target: string }>()

  /** The offset of a line start from which every row stamped at or after `since` is read: back from the end, a window at a time. */
  function startOf(file: string, size: number, since: number): number {
    let span = CATCH_UP_START
    for (;;) {
      const from = Math.max(0, size - span)
      if (from === 0) return 0
      const buf = readRange(file, from, Math.min(size, from + 64 * 1024))
      const nl = buf.indexOf(0x0a)
      if (nl !== -1) {
        // The first whole row's time in this window (bookkeeping rows have one too).
        let pos = nl + 1
        while (pos < buf.length) {
          const end = buf.indexOf(0x0a, pos)
          if (end === -1) break
          const m = /"timestamp":"([^"]+)"/.exec(buf.toString('utf8', pos, Math.min(end, pos + 4096)))
          if (m) {
            const t = Date.parse(m[1])
            if (Number.isFinite(t) && t < since) return from + nl + 1
            break
          }
          pos = end + 1
        }
      }
      if (span >= CATCH_UP_MAX * 4) return from + (nl === -1 ? 0 : nl + 1)
      span *= 4
    }
  }

  return {
    turnOf(sid, orderId, since) {
      const target = o.target?.(sid) ?? sid
      let c = cursors.get(orderId)
      const plain = (k: OrderCursor): OrderTurn => ({ entered: k.entered, queued: k.queued, ended: k.ended, answer: k.answer, ...(k.how ? { how: k.how } : {}) })
      if (!c || c.target !== target) {
        const file = o.find(target)
        if (!file) return c ? plain(c.cursor) : null
        let st
        try {
          st = statSync(file)
        } catch {
          return null
        }
        const cursor = c?.cursor ?? newOrderCursor(`, order ${orderId}]`, since - ORDER_SLACK_MS)
        c = { file, ident: identOf(st), pos: startOf(file, st.size, since - ORDER_SLACK_MS), carry: null, cursor, target }
        cursors.set(orderId, c)
      }
      try {
        const st = statSync(c.file)
        if (identOf(st) !== c.ident || st.size < c.pos) {
          c.ident = identOf(st)
          c.pos = startOf(c.file, st.size, c.cursor.since)
          c.carry = null
        }
        if (st.size > c.pos) {
          const got = readRange(c.file, c.pos, Math.min(st.size, c.pos + READ_MAX))
          c.pos += got.length
          const buf = c.carry ? Buffer.concat([c.carry, got]) : got
          const nl = buf.lastIndexOf(0x0a)
          c.carry = nl === buf.length - 1 ? null : buf.subarray(nl + 1)
          if (c.carry && c.carry.length > READ_MAX) c.carry = null
          if (nl !== -1) for (const s of signalsIn(buf.subarray(0, nl + 1))) applyOrder(c.cursor, s)
        }
      } catch {
        // Unreadable this time: what is known stands.
      }
      return plain(c.cursor)
    },
    forget(orderId) {
      cursors.delete(orderId)
    },
  }
}
