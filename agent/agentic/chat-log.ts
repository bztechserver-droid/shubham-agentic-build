import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import { writeAtomic } from '../config.ts'

// F-078: a small log of every chat that started or stopped, and why, so the pattern can be seen (and told
// to Shubham in the morning): chat-events.jsonl in the agentic folder, one JSON line each, newest last.
// It keeps itself small: past MAX_BYTES it is cut to its last KEEP_LINES lines.

export interface ChatEvent {
  /** ISO time. */
  at: string
  event: 'start' | 'stop' | 'watch'
  sessionId: string
  agent: string
  floor: string
  /** stop: stopped, idle-reaper, agent-stop, exited, crashed, ended. start: new, resumed, heartbeat, watchdog. watch (F-083): watchdog-restart, memory, limit, home-offline, restart-failed, menu, silent. */
  cause: string
  /** watch (F-083): what the watchdog found, in plain words. */
  what?: string
  /** watch (F-083): what the watchdog did about it. */
  did?: string
  code?: number | null
  /** stop: how long it had run, in minutes. */
  ranMin?: number
  /** Free RAM on the PC at that moment, in MB: a pattern of low memory shows here. */
  freeMemMB: number
}

export const MAX_BYTES = 400_000
export const KEEP_LINES = 1500
/** Below this much free RAM a stop is said to have happened under memory pressure. */
export const LOW_MEM_MB = 600

export interface ChatLog {
  append(e: Omit<ChatEvent, 'at' | 'freeMemMB'>): void
  /** Everything since `sinceMs` (an epoch time), oldest first. */
  since(sinceMs: number): ChatEvent[]
}

export function createChatLog(file: string, deps: { now?: () => number; freeMemMB?: () => number } = {}): ChatLog {
  const now = deps.now ?? Date.now
  const freeMemMB = deps.freeMemMB ?? (() => Math.round(os.freemem() / 1_048_576))

  function trim() {
    try {
      if (statSync(file).size <= MAX_BYTES) return
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      writeAtomic(file, `${lines.slice(-KEEP_LINES).join('\n')}\n`)
    } catch {
      // Nothing to trim.
    }
  }

  return {
    append(e) {
      try {
        const line: ChatEvent = { at: new Date(now()).toISOString(), ...e, freeMemMB: freeMemMB() }
        appendFileSync(file, `${JSON.stringify(line)}\n`)
        trim()
      } catch {
        // A log that cannot be written must never stop a chat.
      }
    },
    since(sinceMs) {
      if (!existsSync(file)) return []
      const out: ChatEvent[] = []
      for (const l of readFileSync(file, 'utf8').split('\n')) {
        if (!l.trim()) continue
        try {
          const e = JSON.parse(l) as ChatEvent
          if (e && typeof e.at === 'string' && Date.parse(e.at) >= sinceMs) out.push(e)
        } catch {
          // A torn line.
        }
      }
      return out
    },
  }
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

const CAUSE: Record<string, string> = {
  stopped: 'stopped by Shubham',
  'idle-reaper': 'stopped after sitting idle for 4 h',
  'agent-stop': 'ended when the app stopped (an Update or a restart)',
  exited: 'ended by itself',
  ended: 'ended',
}

/** What stopped, in plain lines, grouped by cause. Starts are told only when the app started the chat again (heartbeat). */
export function describeEvents(events: readonly ChatEvent[]): string[] {
  const out: string[] = []
  const stops = events.filter(e => e.event === 'stop')
  const watch = events.filter(e => e.event === 'watch')
  const byCause = new Map<string, ChatEvent[]>()
  for (const e of stops) byCause.set(e.cause, [...(byCause.get(e.cause) ?? []), e])
  for (const [cause, list] of byCause) {
    const names = [...new Set(list.map(e => e.agent))]
    const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} more` : '')
    const low = list.filter(e => e.freeMemMB < LOW_MEM_MB)
    const mem = low.length ? `; memory was low (${Math.min(...low.map(e => e.freeMemMB))} MB free) for ${low.length}` : ''
    if (cause === 'crashed') {
      const codes = [...new Set(list.map(e => e.code))].join(', ')
      out.push(`${list.length} chat${list.length === 1 ? '' : 's'} crashed (exit code ${codes}): ${shown}, around ${hhmm(list[0].at)}${mem}.`)
    } else {
      out.push(`${list.length} chat${list.length === 1 ? '' : 's'} ${CAUSE[cause] ?? cause}: ${shown}${list.length === 1 ? ` at ${hhmm(list[0].at)}` : `, from ${hhmm(list[0].at)}`}${mem}.`)
    }
  }
  // F-083: what the watchdog did, one line per event (a chat started again, a menu dismissed, a restart held for memory).
  for (const e of watch) out.push(`${hhmm(e.at)} ${e.agent} on ${e.floor}: ${e.what ?? e.cause}; ${e.did ?? 'noted'}.`)
  const again = events.filter(e => e.event === 'start' && e.cause === 'heartbeat')
  if (again.length) out.push(`The heartbeat started ${[...new Set(again.map(e => e.agent))].join(', ')} again after it had stopped with work unfinished.`)
  return out
}
