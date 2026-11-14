import { readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { writeAtomic } from '../config.ts'
import type { Logger } from '../log.ts'
import { FAST_UI_ACTIONS } from './fast-tools.ts'
import { LATCH_NAME } from './latch-hook.ts'

// F-221 (ob98a): the spoken latch on the Orchestrator's chat, in code and not only in its brief. Live talk's direct line ("[message from Live voice
// (spoken, not tapped), order oX]") types his spoken words into that chat untapped; it is the only thing that arms the latch (fix round 2,
// decision 1: an untapped hand-off of Quick's, from the Alt+K bar, Live talking classic or Chris, is typed the old way and holds nothing: the
// Orchestrator must still be able to message agents for those, and Chris has no card screen). While a direct line's order holds that chat, what
// the chat may do with the APP's tools is decided by the TOOL it calls (index.ts toolFor, the one dispatcher of the app's tools), never by what the
// model says or read:
//   - reads, notes and prepared cards run as usual ('read', 'note', 'prepare'); the screen only opens pages and scrolls ('look', Quick's own limit);
//   - a message to another chat is not sent ('relay'): it waits as a 'relay' card with the exact words and target, which only his tap sends (his
//     page shows the cards of its order);
//   - everything else is refused with one sentence ('refuse'), and so is any tool this table does not name.
// What it holds, said plainly (fix round 2, decision 9): only the app's own tools, for a direct line. The chat's shell (which can call the hub as
// the app itself, with the app's token), its desktop clicks (windows-mcp) and any other MCP server it has are held by the PreToolUse voice lock
// (T4, below: this latch mirrored into files that latch-hook.ts reads); until the Assistant chat runs with that lock (GET /talk/caps says
// 'full'), the page does not offer the direct line, and (review of T4) the hub refuses it itself (index.ts handOffSpoken, noLockWords below). Hey
// Chris's /voice/ask stays as it is (its own safety tags): it is outside this feature.
// When it holds (decisions 2-4): one spoken line at a time, typed only into an Orchestrator that rests (the line queue below); its order is opened
// and saved before the typing, so the latch holds from before the line can be submitted, across a restart of the agent too (orders.json keeps
// `spoken`). It lets go when he taps Let go, or when the line can no longer run: its reply is made (the turn that took it ended), the chat stopped
// (or restarted), or the line never entered and the chat rests with an EMPTY box. No clock lets it go while its line can still run (orders.ts).
// Fix round 3: a lost link to the chat host is not the chat stopping (the host may still run it, or it is reopened and told to carry on): until
// the link is back and its reopen loop is over nothing is decided, and the turn that carries on keeps the hold until it is seen over (index.ts).
// T4 phase 2: a spoken line that closes for any reason but its reply being seen or his Let go (its chat stopped or restarted, the line not taken),
// and (review of T4) any start of a held chat (a reopen told to carry on, start-up recovery, the watchdog, a hand-off, his own open), leave a
// residual hold on that chat (talk-residual.ts): it holds the same way until a turn end is seen there after it was made, the chat then at rest
// with an empty box, or until he lets go.

export type LatchClass = 'read' | 'note' | 'prepare' | 'look' | 'relay' | 'refuse'

/** Every tool a chat may call (tools.ts TOOLS, and memory_recall, the memory hook's call), by what it may do while the latch is on. */
export const LATCH_CLASSES: Readonly<Record<string, LatchClass>> = {
  // Reads: the app, the chats, the CRM, the memory, his tasks, WhatsApp (read only), the screens and the Browser's page; showing things in the chat.
  app_chats: 'read',
  list_chats: 'read',
  floor_roster: 'read',
  read_chat: 'read',
  app_read_chat: 'read',
  app_read_conversation: 'read',
  crm_query: 'read',
  crm_board: 'read',
  crm_catalog: 'read',
  crm_scopes: 'read',
  crm_whoami: 'read',
  crm_members: 'read',
  crm_goals: 'read',
  crm_files: 'read',
  memory_search: 'read',
  memory_recent: 'read',
  memory_read: 'read',
  memory_recall: 'read',
  task_list: 'read',
  wa_chats: 'read',
  wa_read: 'read',
  wa_status: 'read',
  watchdog_status: 'read',
  ui_modules: 'read',
  ui_screen: 'read',
  phone_screen: 'read',
  browser_read: 'read',
  show_media: 'read',
  show_screen: 'read',
  show_crm_file: 'read',
  // Harmless writes: his notes and the app's memory (a task is never deleted on spoken words: see latchVerdict).
  task_add: 'note',
  task_update: 'note',
  memory_save: 'note',
  // They only prepare: his own tap sends.
  prepare_send: 'prepare',
  wa_prepare_send: 'prepare',
  // Opens pages and scrolls, nothing that presses, types or sends keys.
  ui_control: 'look',
  // Not sent: held as a card for his tap.
  send_to_chat: 'relay',
  app_send_to_chat: 'relay',
  // Everything that acts: refused.
  broadcast_to_chats: 'refuse',
  crm_write: 'refuse',
  crm_goal_add: 'refuse',
  crm_goal_update: 'refuse',
  ui_invoke: 'refuse',
  phone_control: 'refuse',
  phone_update: 'refuse',
  app_open_chat: 'refuse',
  app_stop_chat: 'refuse',
  app_set_effort: 'refuse',
  agent_hire: 'refuse',
  browser_open: 'refuse',
}

/** What a held message tells the Orchestrator (his page shows the card with its order). */
export const HELD_WORDS = 'Held: this came from his voice, so he must tap Send on the card in the Assistant panel. Tell him it is waiting for his tap. Do not try another way.'
/** What a refused tool tells it (a 403). */
export const REFUSED_WORDS = 'That came from his voice. He has to type it or tap it himself; tell him so in one sentence.'

export type LatchVerdict = { go: true } | { go: false; hold: true } | { go: false; hold: false }

/** What a tool call may do while the latch is on. Unknown tools are refused. */
export function latchVerdict(name: string, args: Record<string, unknown>): LatchVerdict {
  const cls = Object.hasOwn(LATCH_CLASSES, name) ? LATCH_CLASSES[name] : 'refuse'
  switch (cls) {
    case 'read':
    case 'prepare':
      return { go: true }
    case 'note':
      // Spoken words never delete: a task may be added or ticked, not deleted.
      return name === 'task_update' && args.delete === true ? { go: false, hold: false } : { go: true }
    case 'look':
      return typeof args.action === 'string' && FAST_UI_ACTIONS.includes(args.action) ? { go: true } : { go: false, hold: false }
    case 'relay':
      return { go: false, hold: true }
    case 'refuse':
      return { go: false, hold: false }
  }
}

/** What the latch reads of an open order (orders.ts Order has these fields). */
export interface LatchOrder {
  id: string
  to: { sessionId: string }
  /** His spoken words, not tapped: live talk's direct line (the only one that holds). */
  spoken?: boolean
  /** Its reply is made (it waits to be delivered): the turn that took the line is over, or the line can no longer run. */
  pending?: string
  /** He let its hold go (Let go): the order still answers, the chat's tools are its own again. */
  letGo?: boolean
}

/** An open order holds its chat while it is spoken (not tapped), not answered yet, and he has not let it go. */
export const holdsChat = (o: LatchOrder): boolean => o.spoken === true && !o.pending && o.letGo !== true

export interface SpokenLatch {
  /** The ids of the spoken orders holding this chat now (T4 phase 2: a residual hold's orders too); [] when its latch is off. */
  open(sessionId: string): string[]
  /** F-221 (T4): every chat it holds now, with the ids of the orders holding it (what the voice lock's files mirror). */
  held(): Map<string, string[]>
}

/**
 * The latch, read from the open orders (orders.ts list(), saved on disk): nothing of it lives anywhere else, so it holds across a restart of the
 * agent, and there is no clock of its own (fix round 2: the order is opened and saved before its line is typed, so nothing needs to bridge the gap).
 * T4 phase 2: and from the residual holds (talk-residual.ts, kept in their own file): a chat a spoken line held when it closed abnormally, or that
 * was told to carry on while held, holds the same way until a turn end is seen there (or he lets go). `residual` gives the chats with the orders
 * each carries.
 */
export function createSpokenLatch(deps: { orders(): readonly LatchOrder[]; residual?(): Map<string, string[]> }): SpokenLatch {
  const held = (): Map<string, string[]> => {
    const out = new Map<string, string[]>()
    for (const o of deps.orders()) if (holdsChat(o)) out.set(o.to.sessionId, [...(out.get(o.to.sessionId) ?? []), o.id])
    for (const [sid, ids] of deps.residual?.() ?? []) out.set(sid, [...new Set([...(out.get(sid) ?? []), ...ids])])
    return out
  }
  return {
    open: sessionId => held().get(sessionId) ?? [],
    held,
  }
}

// --- the voice lock below the model (T4) -------------------------------------------------------------------------------------------------------
// The latch above holds only the app's own tools. The Orchestrator's chat (and only it: index.ts) is started with a PreToolUse hook (latch-hook.ts)
// that refuses everything but reads while a file named for the chat is in the latch folder, so its shell, file edits, agents and other MCP servers
// are held by Claude Code itself. The folder says exactly what the latch holds: a file is written when a spoken line arms the latch, BEFORE the line
// can be submitted (index.ts handOffSpoken: the line is not typed when it cannot be written), removed when the hold goes (its reply, his Let go;
// T4 phase 2: a chat stopped keeps its file under its residual hold until a turn end is seen there), and the folder is rebuilt from the saved
// orders and residual holds when the agent starts (a chat the chat host kept running stays held).

export interface LatchFiles {
  /**
   * Makes the folder say exactly what the latch holds now: a file for each chat it holds, nothing else (stale files go). False when a file it needs
   * could not be written (or the chat's id cannot be a file name): then that chat is NOT held below the model, and a spoken line must not be typed.
   */
  sync(): boolean
  /** The chats with a file now (the names in the folder). */
  list(): string[]
}

export function createLatchFiles(deps: { dir: string; held(): Map<string, string[]>; log?: Logger }): LatchFiles {
  const names = (): string[] => {
    try {
      return readdirSync(deps.dir)
    } catch {
      return [] // no folder yet: nothing is held
    }
  }
  return {
    sync() {
      const want = deps.held()
      const have = names()
      let ok = true
      for (const name of have) {
        if (want.has(name)) continue
        try {
          rmSync(path.join(deps.dir, name), { force: true, recursive: true })
        } catch {
          // Taken again at the next sync (every orders tick).
        }
      }
      for (const [sid, orders] of want) {
        if (!LATCH_NAME.test(sid)) {
          ok = false
          deps.log?.warn(`voice lock: chat ${sid.slice(0, 8)} cannot be held below the model (its id is not a plain name)`)
          continue
        }
        if (have.includes(sid)) continue
        try {
          // Only the name counts (latch-hook.ts); the orders are for whoever looks in the folder.
          writeAtomic(path.join(deps.dir, sid), `${JSON.stringify({ orders })}\n`)
        } catch (e) {
          ok = false
          deps.log?.warn(`voice lock: could not hold chat ${sid.slice(0, 8)} below the model: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      return ok
    },
    list: names,
  }
}

/**
 * The voice lock's entry in hooks-orchestrator.json: every tool (matcher "*"), node running latch-hook.ts on the latch folder, for this chat. As the
 * prompt hook's: paths quoted, with forward slashes (a folder like "Shubham's Agent" has a space and an apostrophe), Claude's own limit 10 s.
 */
export function lockHook(node: string, script: string, dir: string, sessionId: string) {
  const fwd = (p: string) => p.replace(/\\/g, '/')
  return { matcher: '*', hooks: [{ type: 'command', command: `"${fwd(node)}" "${fwd(script)}" "${fwd(dir)}" "${sessionId}"`, timeout: 10 }] }
}

/** At most this many chats are remembered as started with the voice lock (only Orchestrator chats ever are). */
export const LOCK_STARTS_KEPT = 16

/**
 * T4 review: what a direct line is answered (a 409, nothing typed) when the chat it would go into runs without the voice lock: here, started before
 * the lock existed or without its file, or as Codex (a restart gives it the lock); or on another PC, whose chats never have it (a restart there
 * would not). The hub checks this itself (index.ts handOffSpoken), not only the page (GET /talk/caps), so a page that read the caps earlier, or no
 * page at all, cannot type past it.
 */
export const noLockWords = (who: string, onAnotherPc = false) =>
  onAnotherPc ? `${who} runs on another PC, where the voice lock cannot reach; nothing was typed.` : `${who} runs without the voice lock (it needs a restart); nothing was typed.`

export interface LockRecord {
  /** This chat was started with the voice lock at `startedAt` (its ChatInfo.startedAt). */
  started(sessionId: string, startedAt: string): void
  /** Was the run of this chat that started at `startedAt` started with the voice lock? */
  has(sessionId: string, startedAt: string): boolean
}

/**
 * Which chats run with the voice lock, by their start time, kept in a file: a chat that the chat host keeps running across an Update keeps its start
 * time, so it still counts; any other start of that chat (the old way, before the lock existed) does not.
 */
export function createLockRecord(file: string, log?: Logger): LockRecord {
  let runs: [string, string][] = []
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) runs = Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string')
  } catch {
    runs = [] // none yet
  }
  return {
    started(sessionId, startedAt) {
      runs = [...runs.filter(([sid]) => sid !== sessionId), [sessionId, startedAt] as [string, string]].slice(-LOCK_STARTS_KEPT)
      try {
        writeAtomic(file, `${JSON.stringify(Object.fromEntries(runs))}\n`)
      } catch (e) {
        log?.warn(`voice lock: could not note chat ${sessionId.slice(0, 8)}'s start: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    has: (sessionId, startedAt) => runs.some(([sid, at]) => sid === sessionId && at === startedAt),
  }
}

// --- one spoken line at a time (fix round 2, decision 2) --------------------------------------------------------------------------------------
// A direct line is typed only into an Orchestrator that rests (no turn running, no prompt, nothing in its box) and that no other spoken line holds,
// so the latch covers that line's own turn and never his typed work. Until then it waits on the hub, in order: at most LINES_WAITING_MAX wait (the
// one being typed counts), each at most LINE_WAIT_MS; then that line is answered BUSY_WORDS (a 409) and nothing of it is typed.

/** At most this many spoken lines wait for the Orchestrator at once; one more is told at once that it is busy. */
export const LINES_WAITING_MAX = 3
/** A spoken line waits at most this long for its turn, then it is told that the Orchestrator is busy. */
export const LINE_WAIT_MS = 2 * 60_000
/** How often a waiting line looks again. */
export const LINE_POLL_MS = 250
/** What a spoken line that could not get its turn is answered (with status 409). */
export const BUSY_WORDS = 'The Assistant is busy; say it again in a moment.'

export interface LineTicket {
  /** Its turn: it is the first of the lines waiting (the one before it was typed, or gave up). */
  first(): boolean
  /** It has waited longer than LINE_WAIT_MS. */
  late(): boolean
  /** It leaves the line (typed, refused or given up); idempotent. */
  leave(): void
}

export interface LineQueue {
  /** A new spoken line at the end of the queue; null when LINES_WAITING_MAX are waiting already. */
  join(): LineTicket | null
  /** How many lines wait now (the one being typed included). */
  size(): number
}

export function createLineQueue(deps: { now(): number; max?: number; waitMs?: number }): LineQueue {
  const max = deps.max ?? LINES_WAITING_MAX
  const waitMs = deps.waitMs ?? LINE_WAIT_MS
  const waiting: { at: number }[] = []
  return {
    join() {
      if (waiting.length >= max) return null
      const me = { at: deps.now() }
      waiting.push(me)
      return {
        first: () => waiting[0] === me,
        late: () => deps.now() - me.at > waitMs,
        leave: () => {
          const i = waiting.indexOf(me)
          if (i >= 0) waiting.splice(i, 1)
        },
      }
    },
    size: () => waiting.length,
  }
}
