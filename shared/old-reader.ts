import { parseFrame } from './assistant.ts'
import { FAST_MODELS, type FastModel, type FastServerFrame, type FastState } from './fast.ts'

// Order o5007 (Shubham, 11 Nov 2026): "a route ... which is very fast in replying, like Alt+K in it; I will only ask it basic questions". A
// question box about the OLD app (Agentic Claude Manager, Christopher OS), answered by a warm model process that can only READ the old app's
// folder. It is the Alt+K path again, not a new transport: the frames of shared/fast.ts, the session of agent/agentic/fast.ts and the warm
// process of agent/agentic/fast-host.ts, with its own brief and four read-only tools (agent/agentic/old-reader.ts). This file is what the page
// and the hub share: the names, the settings, the cited paths shown as chips, the questions kept in this browser and what the page shows.

// The page's address, its name, its socket and its shortcut live in old-route.ts (no imports there, so anything may read them).
export { OLD_BLURB, OLD_KEY, OLD_LABEL, OLD_LEGACY_ROUTE, OLD_ROUTE, OLD_SOCKET } from './old-route.ts'
/** Questions (and their answers) kept in this browser, newest first. */
export const OLD_HISTORY_MAX = 20
export const OLD_HISTORY_KEY = 'sad-old-reader-history'
/** A question is at most this long (the frame's own limit). */
export const OLD_QUESTION_MAX = 2000

// --- the hub's setting (Settings › Old app reader) ------------------------------------------------------------------------

export interface OldReaderSettings {
  /** Off: the page, its menu entry and Alt+O are gone, and the hub refuses the socket (no process is started). */
  enabled: boolean
  /** Fast (Haiku) or thorough (Sonnet). */
  model: FastModel
}
export const DEFAULT_OLD_READER: OldReaderSettings = { enabled: true, model: 'haiku' }

/** What a file or a page says, repaired: anything not understood is the default. */
export function parseOldReaderSettings(raw: unknown): OldReaderSettings {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_OLD_READER.enabled,
    model: (FAST_MODELS as readonly unknown[]).includes(r.model) ? (r.model as FastModel) : DEFAULT_OLD_READER.model,
  }
}

/** GET /agentic/old: the setting, and the old app's folder this PC reads (null and found false when it is not here). */
export interface OldReaderInfo {
  settings: OldReaderSettings
  root: string | null
  found: boolean
  /** How many files it can read there (null before the first look). */
  files: number | null
  /** The socket is served right now (switched on, the folder found, and this PC is the hub). */
  serving: boolean
}

// --- the paths an answer cites, as chips ----------------------------------------------------------------------------------

export interface CitedPath {
  /** Relative to the old app's folder, with forward slashes (an absolute path outside it is kept whole). */
  path: string
  line: number | null
}

const EXT = /\.(?:tsx?|jsx?|mjs|cjs|json|md|css|scss|html?|cs|csproj|ps1|psm1|bat|cmd|sh|ya?ml|toml|txt|sql|py|svg|ini|xml|lock)$/i
const MAX_CHIPS = 12

/** One candidate, cleaned: `server\lib\chats.js:120` -> {path: 'server/lib/chats.js', line: 120}; null when it is not a path. */
function cleanPath(raw: string, root: string | null, quoted: boolean): CitedPath | null {
  let s = raw.trim().replace(/^["'(<[]+/, '').replace(/[)"'>\],;.!?]+$/, '')
  if (!s || s.length > 260 || s.includes('://') || /\s{2,}/.test(s)) return null
  let line: number | null = null
  const at = /(?::|#L)(\d{1,6})(?:[-–:]\d{1,6})?$/.exec(s)
  if (at) {
    line = Number(at[1]) || null
    s = s.slice(0, at.index)
  }
  s = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (root) {
    const r = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`
    if (s.toLowerCase().startsWith(r.toLowerCase())) s = s.slice(r.length)
  }
  s = s.replace(/^\.\//, '')
  if (!s || s.endsWith('/') || /(^|\/)\.\.(\/|$)/.test(s)) return null
  const slash = s.includes('/')
  const file = EXT.test(s)
  // Prose is not a path: "Node.js" or "and/or" outside backticks is not a chip. Outside them a path needs a folder AND a file's extension;
  // inside them (the brief asks for backticks), a file's extension or a folder path.
  if (quoted ? !(file || (slash && /^[\w.@+-]+(?:\/[\w.@+-]+)+$/.test(s.replace(/^[A-Za-z]:/, '')))) : !(slash && file)) return null
  if (!/[A-Za-z]/.test(s)) return null
  return { path: s, line }
}

/** The files an answer names (in backticks as the brief asks, or a plain path with a folder), in order, at most 12, each once. */
export function citedPaths(text: string, root: string | null = null): CitedPath[] {
  const out: CitedPath[] = []
  const seen = new Map<string, CitedPath>()
  const add = (c: CitedPath | null) => {
    if (!c) return
    const k = c.path.toLowerCase()
    const had = seen.get(k)
    if (had) {
      if (had.line === null && c.line !== null) had.line = c.line
      return
    }
    if (out.length >= MAX_CHIPS) return
    seen.set(k, c)
    out.push(c)
  }
  const quotedSpans: [number, number][] = []
  for (const m of text.matchAll(/`([^`\n]{1,300})`/g)) {
    quotedSpans.push([m.index, m.index + m[0].length])
    // A span may hold one path, or a path with a line range after it ("server/index.js:120-140").
    add(cleanPath(m[1], root, true))
  }
  const inQuote = (i: number) => quotedSpans.some(([a, b]) => i >= a && i < b)
  // A web address is not a file of the old app: blanked out (same length, so the positions above still hold) before plain paths are looked for.
  const plain = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s`]+/gi, m => ' '.repeat(m.length))
  for (const m of plain.matchAll(/(?:[A-Za-z]:[\\/])?[\w.@+-]+(?:[\\/][\w.@+-]+)+(?:(?::|#L)\d{1,6}(?:[-–]\d{1,6})?)?/g)) {
    if (inQuote(m.index)) continue
    add(cleanPath(m[0], root, false))
  }
  return out
}

/** The chip's words: the file's name, and its line. The whole path is the chip's title. */
export function chipLabel(c: CitedPath): string {
  const name = c.path.split('/').filter(Boolean).pop() ?? c.path
  return c.line ? `${name}:${c.line}` : name
}

// --- the questions kept in this browser -----------------------------------------------------------------------------------

export interface OldTurn {
  id: string
  /** The question. */
  q: string
  /** All it answered (what was said before a Stop, for a stopped one). */
  a: string
  /** When it was asked (ms since the epoch). */
  at: number
  /** From the question to the end of the answer, ms. */
  ms: number | null
  /** From the question to its first word, ms. */
  firstMs: number | null
  model: FastModel | null
  paths: CitedPath[]
  status: 'done' | 'stopped' | 'error'
  error?: string
}

const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The new turn first; one with the same id is replaced; at most `max`. */
export function pushHistory(list: readonly OldTurn[], t: OldTurn, max = OLD_HISTORY_MAX): OldTurn[] {
  return [t, ...list.filter(x => x.id !== t.id)].slice(0, max)
}

/** What localStorage holds, checked (a damaged entry is dropped, never shown half). */
export function parseHistory(raw: unknown): OldTurn[] {
  if (!Array.isArray(raw)) return []
  const out: OldTurn[] = []
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue
    const o = r as Record<string, unknown>
    if (!str(o.id) || !str(o.q) || !str(o.a) || !num(o.at)) continue
    const status = o.status === 'stopped' || o.status === 'error' ? o.status : 'done'
    const paths = Array.isArray(o.paths)
      ? o.paths.flatMap(p => (typeof p === 'object' && p !== null && str((p as CitedPath).path) ? [{ path: (p as CitedPath).path.slice(0, 260), line: num((p as CitedPath).line) ? (p as CitedPath).line : null }] : [])).slice(0, MAX_CHIPS)
      : []
    out.push({
      id: o.id.slice(0, 64),
      q: o.q.slice(0, OLD_QUESTION_MAX),
      a: o.a.slice(0, 20_000),
      at: o.at,
      ms: num(o.ms) ? o.ms : null,
      firstMs: num(o.firstMs) ? o.firstMs : null,
      model: o.model === 'haiku' || o.model === 'sonnet' ? o.model : null,
      paths,
      status,
      ...(status === 'error' && str(o.error) ? { error: o.error.slice(0, 300) } : {}),
    })
    if (out.length >= OLD_HISTORY_MAX) break
  }
  return out
}

// --- what the page shows --------------------------------------------------------------------------------------------------

/** connecting: the socket is being opened; the rest are the hub's states (shared/fast.ts). */
export type OldServer = 'connecting' | FastState

export interface OldView {
  server: OldServer
  /** Why it is off, paused or unavailable: one sentence. */
  reason: string | null
  model: FastModel | null
  /** The question being answered; null between questions. */
  turn: string | null
  question: string
  answer: string
  /** What it is doing right now ("Searching the old app"), while it uses a tool. */
  tool: string | null
  /** waiting: asked, no word yet. answering: the words are coming. */
  phase: 'idle' | 'waiting' | 'answering'
  error: string | null
  startedAt: number | null
  firstAt: number | null
  /** The last finished question, shown until the next one. */
  last: OldTurn | null
}

export const initialOldView = (): OldView => ({ server: 'connecting', reason: null, model: null, turn: null, question: '', answer: '', tool: null, phase: 'idle', error: null, startedAt: null, firstAt: null, last: null })

export type OldEvent =
  | { type: 'connecting' }
  | { type: 'ask'; id: string; text: string; at: number; model: FastModel | null }
  | { type: 'frame'; frame: FastServerFrame; at: number }
  /** The Stop button: the turn is over for the page (what was said stays). */
  | { type: 'stop'; at: number }
  /** The hub could not be reached for this question. */
  | { type: 'down'; error: string; at: number }

/** The hub's words for a refusal, said for this page (the session's own words name the fast Assistant). */
export function oldErrorWords(status: number, message: string): string {
  if (status === 409) return 'Another screen has the old-app reader open. Ask again here to take it back.'
  if (status === 401) return "Claude isn't signed in on the Server. Check the Claude login in Settings."
  return message.replace(/\bthe Assistant\b/g, 'the old-app reader').replace(/\bThe Assistant\b/g, 'The old-app reader').replace(/\bthe fast assistant\b/gi, 'the old-app reader')
}

function finish(v: OldView, at: number, status: OldTurn['status'], text: string, error?: string): OldView {
  if (!v.turn) return v
  const a = text || v.answer
  const turn: OldTurn = {
    id: v.turn,
    q: v.question,
    a,
    at: v.startedAt ?? at,
    ms: v.startedAt !== null ? Math.max(0, at - v.startedAt) : null,
    firstMs: v.firstAt !== null && v.startedAt !== null ? Math.max(0, v.firstAt - v.startedAt) : null,
    model: v.model,
    paths: citedPaths(a),
    status,
    ...(error ? { error } : {}),
  }
  return { ...v, turn: null, phase: 'idle', tool: null, answer: a, error: error ?? null, last: turn }
}

/** One step of what the page shows. A finished question becomes `last` (the store keeps it in this browser). */
export function reduceOld(v: OldView, e: OldEvent): OldView {
  switch (e.type) {
    case 'connecting':
      return v.server === 'connecting' ? v : { ...v, server: 'connecting', reason: null }
    case 'ask':
      return { ...v, turn: e.id, question: e.text, answer: '', tool: null, phase: 'waiting', error: null, startedAt: e.at, firstAt: null, model: e.model ?? v.model }
    case 'stop':
      return v.turn ? finish(v, e.at, 'stopped', v.answer) : v
    case 'down':
      return v.turn ? finish(v, e.at, 'error', v.answer, e.error) : { ...v, error: e.error }
    case 'frame': {
      const f = e.frame
      switch (f.t) {
        case 'state': {
          const next: OldView = { ...v, server: f.state, reason: f.reason ?? null, ...(f.model ? { model: f.model } : {}) }
          // It went away under a question (switched off, memory low, another screen took it): the question ends with why.
          if (v.turn && (f.state === 'off' || f.state === 'unavailable' || f.state === 'paused' || f.state === 'taken-over')) {
            const why = f.state === 'taken-over' ? oldErrorWords(409, '') : (f.reason ?? 'The old-app reader stopped. Please ask again.')
            return finish(next, e.at, 'error', v.answer, why)
          }
          return next
        }
        case 'delta':
          if (f.id !== v.turn) return v
          return { ...v, answer: v.answer + f.text, phase: 'answering', tool: null, firstAt: v.firstAt ?? e.at }
        case 'tool':
          return f.id === v.turn ? { ...v, tool: f.label } : v
        case 'done':
          return f.id === v.turn ? finish(v, e.at, f.cancelled ? 'stopped' : 'done', f.text) : v
        case 'error':
          if (f.id !== undefined && f.id !== v.turn) return v
          return v.turn ? finish(v, e.at, 'error', v.answer, oldErrorWords(f.status, f.message)) : { ...v, error: oldErrorWords(f.status, f.message) }
        default:
          return v
      }
    }
  }
}

/** A frame from the hub, checked (the Assistant's own checker: the frames are the same). */
export const parseOldFrame = (raw: unknown): FastServerFrame | null => parseFrame(raw)

/** The one line under the box: where it is. */
export function oldStatusLine(v: OldView): string {
  if (v.phase === 'waiting') return v.tool ? `${v.tool}…` : 'Thinking…'
  if (v.phase === 'answering') return v.tool ? `${v.tool}…` : 'Answering…'
  switch (v.server) {
    case 'connecting':
      return 'Connecting…'
    case 'starting':
      return 'Waking up…'
    case 'ready':
      return 'Ready'
    case 'taken-over':
      return 'Open on another screen'
    case 'stopped':
      return 'Ready'
    case 'paused':
    case 'unavailable':
    case 'off':
      return v.reason ?? 'Not available right now'
  }
}
