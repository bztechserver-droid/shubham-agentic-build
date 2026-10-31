import { readFileSync } from 'node:fs'
import type { ChatState } from '../../shared/agentic.ts'
import { writeAtomic } from '../config.ts'
import type { Logger } from '../log.ts'

// F-058: the chats that were open when the app stopped come back by themselves. The agent writes
// down which chats are open (and what each was doing) whenever that changes; at the next start it
// reads the list the last run left, opens each of those chats again (its conversation resumed,
// agent/agentic/index.ts resumeChat), and tells the ones that were in the middle of something to
// carry on. A chat the person stopped on purpose is off the list (it left the pool before the app did);
// a chat that was open when the app was killed, crashed or updated is on it. Nothing here runs unless
// the guard asked for it (SAD_RESUME_CHATS=1): test agents and Dev's own never reopen anything.

export interface Remembered {
  sessionId: string
  floorId: string
  agentId: string
  /** What it was doing when last seen: only a chat that was working or asking is told to carry on. */
  state: ChatState
}

/** What a reopened chat that was in the middle of something is told. */
export const CONTINUE_TEXT = 'The app restarted and reopened this chat. Carry on from where you were.'

export interface Recovery {
  /** The chats the last run left open, read once, at start. */
  readonly pending: readonly Remembered[]
  /** Writes down the chats open now. Ignored until arm(): a fresh start's empty pool must not wipe the list before it is used. */
  note(open: Remembered[]): void
  /** The list has been used: from now on it follows the chats. */
  arm(): void
  /** The app is stopping: write what is pending, then nothing more, so closing the chats does not forget them. */
  freeze(): void
}

const STATES: readonly string[] = ['idle', 'running', 'question']
const isRemembered = (v: unknown): v is Remembered => {
  const o = v as Partial<Remembered> | null
  return !!o && typeof o.sessionId === 'string' && typeof o.floorId === 'string' && typeof o.agentId === 'string' && typeof o.state === 'string' && STATES.includes(o.state)
}

/** The list a run left, or [] (no file, or not ours). */
export function readRemembered(file: string): Remembered[] {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as { v?: number; chats?: unknown }
    return v.v === 1 && Array.isArray(v.chats) ? v.chats.filter(isRemembered).map(c => ({ sessionId: c.sessionId, floorId: c.floorId, agentId: c.agentId, state: c.state })) : []
  } catch {
    return []
  }
}

export interface RecoveryOptions {
  log?: Logger
  /** How long changes are gathered before they are written (400 ms). */
  settleMs?: number
}

export function createRecovery(file: string, o: RecoveryOptions = {}): Recovery {
  const pending = readRemembered(file)
  let armed = false
  let frozen = false
  let last = JSON.stringify(pending)
  let want: Remembered[] | null = null
  let timer: NodeJS.Timeout | null = null

  function write() {
    timer = null
    if (!want) return
    const text = JSON.stringify(want)
    want = null
    if (text === last) return
    last = text
    try {
      writeAtomic(file, JSON.stringify({ v: 1, savedAt: new Date().toISOString(), chats: JSON.parse(text) as Remembered[] }))
    } catch (e) {
      o.log?.warn(`recovery: could not write ${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    pending,
    note(open) {
      if (!armed || frozen) return
      // States flip several times a second while a chat paints: write what has settled.
      want = open
      timer ??= setTimeout(write, o.settleMs ?? 400)
      timer.unref()
    },
    arm() {
      armed = true
    },
    freeze() {
      if (timer) clearTimeout(timer)
      write()
      frozen = true
    },
  }
}
