import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { Logger } from '../log.ts'
import { readLimitRow, type LimitHit } from './limits.ts'

// Follows each running chat's transcript for claude's own "you've hit your limit" row (limits.ts),
// and tells failover.ts when one shows up, and when the chat works again after it. Claude subscription
// failover has no other way to hear of it: nothing in the chat runtime keeps an eye on rows when no
// page is open (agent/agentic only follows a file while a page is attached).
//
//   WHERE. ~/.claude/projects/<folder>/<sessionId>.jsonl, appended to by claude; `find` locates it
//   (transcripts.ts findTranscript). A chat that has not had its first exchange has no file yet:
//   it is looked for again a few seconds later.
//   WHAT. Only new bytes are read, every couple of seconds, from the end of the file when the
//   chat is first seen (a few hundred KB back, so a refusal written in the first moments is not
//   missed). A row older than the chat's own start belongs to an earlier run of the conversation
//   (the file is the conversation's, and a resumed one still ends with the old refusal): ignored,
//   so a restart can never read the refusal it was restarted for as a new one. Lines are cut at
//   byte level, so a row split across two reads, or inside a multi-byte character, is read whole.
//   SAFETY. Runs from a timer inside the agent: nothing here throws. A file that is unreadable,
//   shrinks, or grows by megabytes between looks is dealt with, never fatal.

/** A running chat. */
export interface WatchedChat {
  sessionId: string
  /** The agent's name on its floor. */
  name: string
  /** When its claude process started (ISO). */
  startedAt: string
}

export interface RowWatchOptions {
  chats(): WatchedChat[]
  /** The transcript file of a conversation, or null. */
  find(sessionId: string): string | null
  /** claude refused the chat for a limit (the newest thing it wrote, unless onMoved follows). */
  onLimit(e: { chatId: string; name: string; hit: LimitHit }): void
  /** The chat wrote real work after a refusal: it can run again. */
  onMoved(chatId: string): void
  log: Logger
  /** Default 2 seconds. */
  everyMs?: number
}

export interface RowWatch {
  /** One look at every chat (the timer calls it; tests call it). */
  tick(): void
  stop(): void
}

/** How far back from the end of the file a chat is first read. */
export const BACKFILL_BYTES = 256 * 1024
/** The most read from one chat in one look: more than this arrived, and only the newest of it is read. */
export const MAX_READ_BYTES = 4 * 1024 * 1024
/** A line longer than this is dropped rather than held. */
const MAX_LINE_BYTES = 16 * 1024 * 1024
const FIND_AGAIN_MS = 5_000

interface Follow {
  startedAt: string
  startedMs: number
  file: string | null
  /** Where the next read starts; null until the file is first seen. */
  offset: number | null
  /** The bytes of a line not finished yet. */
  partial: Buffer
  /** The first line of a read that starts mid-file is a piece. */
  skipFirst: boolean
  /** A refusal was the newest thing it wrote. */
  pending: boolean
  findAfter: number
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function startRowWatch(o: RowWatchOptions): RowWatch {
  const follows = new Map<string, Follow>()
  const warned = new Set<string>()

  function line(chat: WatchedChat, f: Follow, text: string) {
    // Rows that can be a refusal or real work are assistant rows: the rest is never parsed.
    if (!text.includes('"type":"assistant"')) return
    let row: unknown
    try {
      row = JSON.parse(text)
    } catch {
      return
    }
    if (!isObject(row) || row.isSidechain === true) return
    const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    if (Number.isFinite(ts) && ts < f.startedMs) return // an earlier run of this conversation
    const hit = readLimitRow(row)
    if (hit) {
      f.pending = true
      o.onLimit({ chatId: chat.sessionId, name: chat.name, hit })
    } else if (f.pending && row.type === 'assistant' && row.isApiErrorMessage !== true) {
      f.pending = false
      o.onMoved(chat.sessionId)
    }
  }

  function read(chat: WatchedChat, f: Follow) {
    if (!f.file) return
    const size = statSync(f.file).size
    if (f.offset === null || size < f.offset) {
      // First look, or the file shrank (it only ever grows): from a little before the end.
      f.offset = Math.max(0, size - BACKFILL_BYTES)
      f.skipFirst = f.offset > 0
      f.partial = Buffer.alloc(0)
    }
    if (size === f.offset) return
    let start = f.offset
    if (size - start > MAX_READ_BYTES) {
      start = size - MAX_READ_BYTES
      f.skipFirst = true
      f.partial = Buffer.alloc(0)
    }
    const length = size - start
    const buf = Buffer.alloc(length)
    const fd = openSync(f.file, 'r')
    let got = 0
    try {
      got = readSync(fd, buf, 0, length, start)
    } finally {
      closeSync(fd)
    }
    f.offset = start + got
    const data = Buffer.concat([f.partial, buf.subarray(0, got)])
    const cut = data.lastIndexOf(0x0a)
    if (cut === -1) {
      f.partial = data.length > MAX_LINE_BYTES ? Buffer.alloc(0) : data
      return
    }
    f.partial = data.subarray(cut + 1)
    const lines = data.subarray(0, cut).toString('utf8').split('\n')
    if (f.skipFirst) {
      lines.shift()
      f.skipFirst = false
    }
    for (const l of lines) line(chat, f, l)
  }

  /** One look; whatever goes wrong in it, it never reaches the agent (an uncaught error there ends every chat). */
  function tick() {
    try {
      look()
    } catch (e) {
      o.log.warn(`row watch: a look failed: ${message(e)}`)
    }
  }

  function look() {
    const now = Date.now()
    const chats = o.chats()
    const live = new Set(chats.map(c => c.sessionId))
    for (const sid of follows.keys()) if (!live.has(sid)) follows.delete(sid)
    for (const chat of chats) {
      try {
        let f = follows.get(chat.sessionId)
        // A chat started again (a restart) is a new run: from the end of its file again.
        if (!f || f.startedAt !== chat.startedAt) {
          const startedMs = Date.parse(chat.startedAt)
          f = { startedAt: chat.startedAt, startedMs: Number.isFinite(startedMs) ? startedMs : 0, file: null, offset: null, partial: Buffer.alloc(0), skipFirst: false, pending: false, findAfter: 0 }
          follows.set(chat.sessionId, f)
        }
        if (!f.file) {
          if (now < f.findAfter) continue
          f.file = o.find(chat.sessionId)
          if (!f.file) {
            f.findAfter = now + FIND_AGAIN_MS
            continue
          }
        }
        read(chat, f)
      } catch (e) {
        // A file that can't be read now is tried again at the next look; said once per chat.
        if (!warned.has(chat.sessionId)) {
          warned.add(chat.sessionId)
          o.log.warn(`row watch: couldn't read chat ${chat.sessionId.slice(0, 8)}'s transcript: ${message(e)}`)
        }
        const f = follows.get(chat.sessionId)
        if (f) f.file = null
      }
    }
  }

  const timer = setInterval(tick, o.everyMs ?? 2000)
  timer.unref()
  return {
    tick,
    stop: () => clearInterval(timer),
  }
}
