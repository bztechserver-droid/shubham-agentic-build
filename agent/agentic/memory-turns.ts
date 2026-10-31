import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { writeAtomic } from '../config.ts'

// F-051: the floor chats' turns, the raw layer's conversations: each thing said to an agent's
// chat (by Shubham, or by another chat), with the answer it got. Read from the chats' JSONL,
// which the hub has for every floor session (F-021), as it grows; kept in turns.jsonl, one
// turn a line, never changed. No model is run for this: the turns are searched as they are,
// and the librarian compiles them into the wiki only when it runs.

export interface Turn {
  /** <sessionId>/<the said message's uuid> */
  id: string
  sessionId: string
  floorId: string
  floorName: string
  agentName: string
  /** When it was said. */
  at: string
  /** shubham: typed in the chat; chat: another chat's [message from ...] or [broadcast from ...]. */
  from: 'shubham' | 'chat'
  said: string
  /** The last thing the chat wrote before the next message (its answer), cut. */
  answer: string
}

export const SAID_MAX = 2000
export const ANSWER_MAX = 1600
/** A turn whose chat has written nothing for this long is taken as answered. */
const SETTLE_MS = 3 * 60 * 1000
const READ_CHUNK = 4 * 1024 * 1024

interface Open {
  uuid: string
  at: string
  from: 'shubham' | 'chat'
  said: string
  answer: string
}

interface Cursor {
  bytes: number
  open: Open | null
  /** When the file last grew (ms). */
  grewAt: number
}

export interface SessionRef {
  sessionId: string
  file: string
  floorId: string
  floorName: string
  agentName: string
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** What was typed, without the app's and claude's wrappers; null when it isn't something said. */
export function cleanSaid(raw: string): { text: string; from: 'shubham' | 'chat' } | null {
  let t = raw
  // Slash commands and their output, and claude's own notices: not something said.
  if (/^\s*<(command-name|command-message|local-command-stdout|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/.test(t)) return null
  if (/^\s*\[Request interrupted by user/.test(t)) return null
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  t = t.replace(/<\/?pasted_content[^>]*>/g, '')
  t = t.replace(/<\/?(user-prompt-submit-hook|command-args)[^>]*>/g, '')
  t = redact(t).trim()
  if (!t) return null
  const from = /^\[(message|broadcast) from /.test(t) ? 'chat' : 'shubham'
  return { text: t.length > SAID_MAX ? `${t.slice(0, SAID_MAX)}…` : t, from }
}

// What looks like a secret, kept out of the turns: they are recalled into other chats and given
// to the librarian. The kind of thing is kept ("[a key, removed]"), never its value.
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[a private key, removed]'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, '[a key, removed]'],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{32,}/g, '[a key, removed]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g, '[a GitHub token, removed]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[an AWS key, removed]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[a Google key, removed]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[a Slack token, removed]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[a token, removed]'],
  // user:password@ in a link.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{3,}@/gi, '$1[removed]@'],
  // NAME=value, "password": "value", token: value: the name kept, the value gone. A value is 8
  // characters or more with a digit or a sign in it (not "token: present", not "author: Shubham").
  [
    /\b([A-Za-z0-9_]*(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*)(["']?\s*[:=]\s*)(["']?)(?=[^\s"'`,;]{8,})(?=[^\s"'`,;]*[\d_\-/+=!@#$%^&*])[^\s"'`,;]+\4/gi,
    '$1$3$4[removed]$4',
  ],
]

/** The text with what looks like a secret taken out. */
export function redact(text: string): string {
  let t = text
  for (const [re, to] of SECRETS) t = t.replace(re, to)
  return t
}

/** The text parts of a message's content (a string, or blocks), tool results left out. */
function textOf(content: unknown): { text: string; toolResultOnly: boolean } {
  if (typeof content === 'string') return { text: content, toolResultOnly: false }
  if (!Array.isArray(content)) return { text: '', toolResultOnly: false }
  const parts: string[] = []
  let results = 0
  for (const p of content) {
    if (!isObject(p)) continue
    if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text)
    else if (p.type === 'tool_result') results++
  }
  return { text: parts.join('\n\n'), toolResultOnly: results > 0 && !parts.length }
}

const cutAnswer = (t: string) => {
  const s = redact(t).trim()
  return s.length > ANSWER_MAX ? `${s.slice(0, ANSWER_MAX)}…` : s
}

/**
 * Lines of a chat's JSONL, in order, into turns: a user message that is something said opens
 * one (closing the one before); the chat's text after it, the last of it, is its answer.
 */
export function turnsFromLines(lines: string[], cursor: Cursor, ref: SessionRef, done: (t: Turn) => void) {
  const close = () => {
    const o = cursor.open
    cursor.open = null
    if (!o) return
    done({ id: `${ref.sessionId}/${o.uuid}`, sessionId: ref.sessionId, floorId: ref.floorId, floorName: ref.floorName, agentName: ref.agentName, at: o.at, from: o.from, said: o.said, answer: o.answer })
  }
  for (const line of lines) {
    if (!line.trim()) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(row) || row.isMeta === true || row.isSidechain === true) continue
    const msg = isObject(row.message) ? row.message : null
    if (!msg) continue
    if (row.type === 'user') {
      const { text, toolResultOnly } = textOf(msg.content)
      if (toolResultOnly || !text.trim()) continue
      const said = cleanSaid(text)
      if (!said) continue
      close()
      cursor.open = {
        uuid: typeof row.uuid === 'string' ? row.uuid : `at-${String(row.timestamp)}`,
        at: typeof row.timestamp === 'string' ? row.timestamp : new Date().toISOString(),
        from: said.from,
        said: said.text,
        answer: '',
      }
    } else if (row.type === 'assistant' && cursor.open) {
      const { text } = textOf(msg.content)
      if (text.trim()) cursor.open.answer = cutAnswer(text)
    }
  }
}

export interface TurnLog {
  /** Every turn kept, oldest first. */
  all(): Turn[]
  get(id: string): Turn | null
  /** Reads what the sessions' files gained since last time; the turns it found. */
  collect(sessions: SessionRef[], now?: number): Turn[]
}

export function createTurnLog(dir: string): TurnLog {
  const file = path.join(dir, 'turns.jsonl')
  const cursorsFile = path.join(dir, 'turns-cursors.json')
  mkdirSync(dir, { recursive: true })
  const turns: Turn[] = []
  const byId = new Map<string, Turn>()
  /** The said messages' uuids: a conversation copied under another session id (F-022) is kept once. */
  const uuids = new Set<string>()
  const uuidOf = (id: string) => id.slice(id.indexOf('/') + 1)
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const t = JSON.parse(line) as Turn
        if (t && typeof t.id === 'string' && !byId.has(t.id) && !uuids.has(uuidOf(t.id))) {
          turns.push(t)
          byId.set(t.id, t)
          uuids.add(uuidOf(t.id))
        }
      } catch {
        // A torn last line is skipped.
      }
    }
  }
  let cursors: Record<string, Cursor> = {}
  try {
    const raw: unknown = JSON.parse(readFileSync(cursorsFile, 'utf8'))
    if (isObject(raw)) cursors = raw as Record<string, Cursor>
  } catch {
    // None yet: every session is read from its start.
  }

  function readNew(ref: SessionRef, c: Cursor): string[] {
    let size: number
    try {
      size = statSync(ref.file).size
    } catch {
      return []
    }
    // A file that shrank was replaced: read it again (turns already kept are known by id).
    if (size < c.bytes) {
      c.bytes = 0
      c.open = null
    }
    if (size === c.bytes) return []
    const fd = openSync(ref.file, 'r')
    const lines: string[] = []
    try {
      let pos = c.bytes
      let carry = ''
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(READ_CHUNK, size - pos))
        const n = readSync(fd, buf, 0, buf.length, pos)
        if (n <= 0) break
        pos += n
        const text = carry + buf.subarray(0, n).toString('utf8')
        const cut = text.lastIndexOf('\n')
        if (cut < 0) {
          carry = text
          continue
        }
        lines.push(...text.slice(0, cut).split('\n'))
        carry = text.slice(cut + 1)
      }
      // Only whole lines count; a half-written last one is read next time.
      c.bytes = pos - Buffer.byteLength(carry)
    } finally {
      closeSync(fd)
    }
    return lines
  }

  return {
    all: () => turns,
    get: id => byId.get(id) ?? null,
    collect(sessions, now = Date.now()) {
      const found: Turn[] = []
      const keep = (t: Turn) => {
        if (byId.has(t.id) || uuids.has(uuidOf(t.id))) return
        turns.push(t)
        byId.set(t.id, t)
        uuids.add(uuidOf(t.id))
        found.push(t)
      }
      let moved = false
      for (const ref of sessions) {
        if (!existsSync(ref.file)) continue
        const c = (cursors[ref.sessionId] ??= { bytes: 0, open: null, grewAt: now })
        const before = c.bytes
        const lines = readNew(ref, c)
        if (c.bytes !== before) {
          c.grewAt = now
          moved = true
        }
        turnsFromLines(lines, c, ref, keep)
        // The chat has been quiet a while: its last turn is answered.
        if (c.open && c.open.answer && now - c.grewAt > SETTLE_MS) {
          const o = c.open
          c.open = null
          keep({ id: `${ref.sessionId}/${o.uuid}`, sessionId: ref.sessionId, floorId: ref.floorId, floorName: ref.floorName, agentName: ref.agentName, at: o.at, from: o.from, said: o.said, answer: o.answer })
          moved = true
        }
      }
      if (found.length) appendFileSync(file, found.map(t => `${JSON.stringify(t)}\n`).join(''))
      if (moved || found.length) writeAtomic(cursorsFile, JSON.stringify(cursors))
      return found
    },
  }
}
