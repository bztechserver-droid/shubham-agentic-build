import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { Logger } from '../log.ts'
import type { BridgeChat, ChatBridge } from './failover.ts'

// What Claude subscription failover (failover.ts) needs of the chat runtime (agent/agentic), in
// one place: the running chats with their names, restarting one on the token now in place, typing
// to one, and telling Lead. It is written against the SLICE of the runtime it uses, not the
// runtime, so the runtime can change around it and a test can stand in for it.
//
//   RESTARTING is the runtime's own (`restartChat`, agent/agentic/index.ts): it stops the chat the
//   way the app stops one and starts it again, resuming its conversation, so a long-running
//   conversation is kept. This file never kills anything itself.
//   TYPING to a chat is a paste plus Enter (chats.type). It is only done when the chat is really
//   up and idle (the screen heuristic says idle before the terminal has even painted, so a chat
//   gets a few seconds first), never while it shows a menu ('question': the text would land in the
//   menu), and then checked: the words must appear in the conversation's file within a while, else
//   they are typed once more. Messages say who they are from: "[message from the app]", which the
//   chat view shows as a message from a sender and a chat treats as information, not a command
//   from the person.

/** The part of the chat runtime this file uses. agent/agentic's `Agentic` has all of it. */
export interface AgenticSlice {
  chats: {
    live(): { sessionId: string; state: 'running' | 'question' | 'idle'; startedAt: string }[]
    info(sessionId: string): { sessionId: string; state: 'running' | 'question' | 'idle'; startedAt: string } | null
    type(sessionId: string, text: string): boolean
  }
  floors: {
    list(): { id: string; name: string; agents: { id: string; name: string; sessionId: string | null }[] }[]
    bySession(sessionId: string): { floor: { id: string; name: string }; agent: { id: string; name: string } } | null
  }
  /** Stops the chat and starts it again on the token in place now, same conversation. true: it is running again. Hub only. */
  restartChat?(sessionId: string): Promise<boolean>
}

export interface BridgeOptions {
  /** The runtime, once there is one (null: no chats on this PC). */
  agentic: () => AgenticSlice | null
  /** The transcript file of a conversation, or null. */
  find(sessionId: string): string | null
  log: Logger
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** The floor and agent that are told about every switch (the brief: Lead on Final). */
  leadFloor?: string
  leadAgent?: string
  /** How long to wait for a chat to be up and idle. Default 90 s. */
  readyMs?: number
  /** How long to wait for typed words to show in the conversation before typing them once more. Default 20 s. */
  deliveredMs?: number
  /** The terminal needs a moment to paint after a start. Default 5 s. */
  paintMs?: number
}

/** Who typed it, as the chat reads it. */
export const FROM_APP = '[message from the app] '

const norm = (s: string) => s.trim().toLowerCase()
const STATES = { running: 'working', question: 'asking', idle: 'idle' } as const
const TAIL_BYTES = 128 * 1024

/** The first line of the words, cut: what to look for in the conversation's file. */
export const markerOf = (text: string) => text.split('\n')[0].slice(0, 60)

export function createBridge(o: BridgeOptions): ChatBridge {
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms).unref()))
  const readyMs = o.readyMs ?? 90_000
  const deliveredMs = o.deliveredMs ?? 20_000
  const paintMs = o.paintMs ?? 5_000
  const leadFloor = norm(o.leadFloor ?? 'Final')
  const leadAgent = norm(o.leadAgent ?? 'Lead')

  async function waitUntil(cond: () => boolean, ms: number, step = 500): Promise<boolean> {
    const end = now() + ms
    for (;;) {
      if (cond()) return true
      if (now() >= end) return false
      await sleep(step)
    }
  }

  /** How long the conversation's file is now (0: none yet). */
  function sizeOf(sessionId: string): number {
    const file = o.find(sessionId)
    if (!file) return 0
    try {
      return statSync(file).size
    } catch {
      return 0
    }
  }

  /** Are these words in what was written to the conversation's file after byte `from`? An earlier copy of the same words does not count. */
  function inFile(sessionId: string, marker: string, from: number): boolean {
    const file = o.find(sessionId)
    if (!file) return false
    try {
      const size = statSync(file).size
      const start = Math.max(from, size - TAIL_BYTES)
      const len = size - start
      if (len <= 0) return false
      const buf = Buffer.alloc(len)
      const fd = openSync(file, 'r')
      try {
        readSync(fd, buf, 0, len, start)
      } finally {
        closeSync(fd)
      }
      return buf.toString('utf8').includes(marker)
    } catch {
      return false
    }
  }

  /** Types `body` into the chat once it can be typed into, and checks it arrived (once more if it did not). */
  async function typeSure(sessionId: string, body: string, opts: { needIdle: boolean }): Promise<boolean> {
    const a = o.agentic()
    if (!a) return false
    const ok = await waitUntil(() => {
      const i = a.chats.info(sessionId)
      if (!i) return false
      if (i.state === 'question') return false // a menu: the text would land in it
      if (!opts.needIdle) return true
      return i.state === 'idle' && now() - Date.parse(i.startedAt) >= paintMs
    }, readyMs)
    if (!ok) return false
    const marker = markerOf(body)
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = sizeOf(sessionId)
      if (!a.chats.info(sessionId) || !a.chats.type(sessionId, body)) return false
      if (await waitUntil(() => inFile(sessionId, marker, before), deliveredMs, 1000)) return true
    }
    return false
  }

  function lead(a: AgenticSlice): string | null {
    const floor = a.floors.list().find(f => norm(f.name) === leadFloor)
    return floor?.agents.find(x => norm(x.name) === leadAgent)?.sessionId ?? null
  }

  return {
    chats(): BridgeChat[] {
      const a = o.agentic()
      if (!a) return []
      return a.chats.live().map(c => {
        const at = a.floors.bySession(c.sessionId)
        return { id: c.sessionId, name: at?.agent.name ?? c.sessionId.slice(0, 8), floor: at?.floor.name ?? null, state: STATES[c.state], startedAt: c.startedAt }
      })
    },

    async restart(id) {
      const a = o.agentic()
      if (!a) return false
      if (!a.restartChat) {
        o.log.warn('this agent cannot restart a chat (no restartChat): it must be restarted by hand')
        return false
      }
      try {
        return await a.restartChat(id)
      } catch (e) {
        o.log.warn(`couldn't restart chat ${id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`)
        return false
      }
    },

    send: (id, text) => typeSure(id, FROM_APP + text, { needIdle: true }),

    async tellLead(text) {
      const a = o.agentic()
      if (!a) return false
      const sid = lead(a)
      if (!sid || !a.chats.info(sid)) return false
      // Lead may be in the middle of a turn: claude queues what is typed then. Only a menu stops it.
      return typeSure(sid, FROM_APP + text, { needIdle: false })
    },
  }
}
