import { existsSync, readFileSync } from 'node:fs'
import { writeAtomic } from '../config.ts'
import type { ChatNow } from './orders.ts'

// F-221 (ob98a, T4 phase 2): the residual hold, the fail-safe after a spoken line closes abnormally. A direct line's order holds the Orchestrator
// chat (talk-latch.ts) until its reply is seen (the turn that took the line ended) or he taps Let go. When it closes for ANY other reason (its chat
// stopped or was restarted, the line was not taken), or when the chat it holds is reopened or restarted and told to carry on (CONTINUE_TEXT after
// a lost chat host or at start-up recovery, the F-083 watchdog's --resume restart and nudge), the line's work may still run there. So a residual
// hold is left on that chat (made BEFORE the order lets go, so the hold has no gap). It holds exactly as the order did (the app's tools by toolFor,
// everything else by the voice lock's files) until a turn END is seen in that chat AFTER the hold was made, with the chat then at rest and its box
// empty, or until he taps Let go on one of the orders it carries. A turn end is seen as: the chat seen working after the hold was made (a turn
// running, or a prompt of it open: what its transcript says in the simple layer, its screen under the old order rule, its PC's report for a chat on
// another PC), then at rest with an empty box, read twice in a row. A chat seen nowhere in between has not ended that turn (a crash, a restart or a
// lost link is no turn end): it must be seen working again. T4 review: what a chat here reads back from its record as it starts again is no turn of
// its own (the turn the stop cut off still reads as running there until the resume writes its end): a turn whose start is before this run's start
// does not count as working (it still keeps the chat from being at rest); its own screen showing it working counts at once (a screen shows only
// what this run draws). No clock lets it go. It is kept in its own file (talk-residual.json), so a restart of the agent keeps holding (the chat
// outlives it), and the voice lock's files are written again from it at start. T4 review: a hold that could not be written there says so (make()
// is false: a spoken order then keeps holding itself, orders.ts closeSpoken), and the file is written again at every tick until it lands.

export interface ResidualHold {
  /** The Orchestrator chat it holds. */
  sessionId: string
  /** The spoken orders it carries on from: GET /talk/ask/<id> answers `held` for them, and his Let go on any of them lets it go. */
  orders: string[]
  /** When it was made, or made again (ms): only a turn end seen after this lets it go. */
  at: number
  /** Why (for the log): how its spoken line closed, or that its chat was told to carry on. */
  why: string
  /** The chat was seen working after `at` (and not seen gone since): the turn whose end lets the hold go. */
  ran?: boolean
}

export interface ResidualDeps {
  now(): number
  /** Where it is kept (atomic writes); left out in tests: memory only. */
  file?: string
  log?: { info(m: string): void; warn(m: string): void }
}

/** What a tick looks at: the chat's state now (undefined: not running anywhere) and its box (empty: nothing in it, no paste of ours on its way). */
export interface ResidualLook {
  stateOf(sessionId: string): ChatNow
  boxEmpty(sessionId: string): boolean | Promise<boolean>
  /** T4 review: what a chat here is seen doing now beyond its state (see Seen); left out: nothing beyond it (a chat on another PC, a test). */
  seen?(sessionId: string): Seen
}

/**
 * T4 review: what a chat here shows beyond its state. `live`: its own screen shows it working now (a turn of this very run). `readBack`: the turn
 * its record reads as running (or asking) began before this run of the chat started: read back as it started again, the turn a stop cut off.
 */
export interface Seen {
  live?: boolean
  readBack?: boolean
}

export interface ResidualHolds {
  /**
   * Holds this chat from now on, carrying these orders. A chat it holds already is held again from now (its `at` moves on and what was seen of it
   * is forgotten: a later turn end is needed), with the orders joined. T4 review: true when the hold is on disk (or there is no file); false when it
   * could not be written: it holds all the same, in memory, and the file is written again at the next tick, but a restart before that would lose it.
   */
  make(sessionId: string, orders: readonly string[], why: string): boolean
  /** The chat ended or is being restarted: if it is held, a turn end must be seen after this (what was seen working before does not count). */
  again(sessionId: string, why: string): void
  /** The order ids it carries on this chat ([] when it does not hold it). */
  on(sessionId: string): string[]
  /** Every chat it holds, with the orders it carries (the latch adds these to what holds a chat). */
  held(): Map<string, string[]>
  /** The hold that carries this order, or null. */
  carrying(orderId: string): ResidualHold | null
  /** His Let go on that order: the hold that carries it goes (the whole hold on that chat). False when none carries it. */
  letGo(orderId: string): boolean
  /**
   * What a chat is seen doing now (a state change here, a PC's report, a tick): working counts once the hold is made; nowhere undoes it. T4 review:
   * a turn read back from its record (`readBack`) is no turn of this run; its screen working (`live`) is.
   */
  saw(sessionId: string, state: ChatNow, seen?: Seen): void
  /**
   * Each hold whose chat was seen working after it was made and now rests with an empty box (read twice in a row) goes. The chats let go. T4 review:
   * holds that could not be written are written again first.
   */
  tick(look: ResidualLook): Promise<string[]>
  list(): ResidualHold[]
}

/** A chat at rest with an empty box this many looks in a row (one look is no proof: a screen read in the middle of a redraw). */
export const EMPTY_LOOKS = 2

const working = (st: ChatNow) => st === 'running' || st === 'question'

export function createResidualHolds(deps: ResidualDeps): ResidualHolds {
  let holds: ResidualHold[] = load(deps.file, deps.log)
  /** Per chat: the looks in a row it rested with an empty box since its turn was seen working (memory only: a restart looks again). */
  const empty = new Map<string, number>()
  let busy = false
  /** T4 review: the last write did not land: written again at every tick until it does. */
  let unsaved = false

  /** Writes the holds down; false when that did not land (logged once per failing run). */
  function save(): boolean {
    if (!deps.file) return true
    try {
      writeAtomic(deps.file, `${JSON.stringify({ holds }, null, 2)}\n`)
      if (unsaved) deps.log?.info('residual holds: saved again')
      unsaved = false
      return true
    } catch (e) {
      // It still holds in memory (and in the voice lock's files); a restart of the agent before the next write lands would lose it.
      if (!unsaved) deps.log?.warn(`residual holds: could not be saved: ${e instanceof Error ? e.message : String(e)}`)
      unsaved = true
      return false
    }
  }
  const find = (sid: string) => holds.find(h => h.sessionId === sid)
  function drop(h: ResidualHold, why: string) {
    holds = holds.filter(x => x !== h)
    empty.delete(h.sessionId)
    save()
    deps.log?.info(`residual hold on chat ${h.sessionId.slice(0, 8)} (orders ${h.orders.join(', ')}) let go: ${why}`)
  }
  function saw(sessionId: string, state: ChatNow, seen: Seen = {}) {
    const h = find(sessionId)
    if (!h) return
    if (state === undefined) {
      // Seen nowhere: whatever ran before did not end at rest here (a crash, a restart, a lost link); it must be seen working again.
      empty.delete(sessionId)
      if (h.ran) {
        delete h.ran
        save()
      }
      return
    }
    if (!working(state) && !seen.live) return
    empty.delete(sessionId)
    // T4 review: the turn its record reads back as it started again is the one the stop cut off, no turn of this run; its screen working is one.
    if (!seen.live && seen.readBack) return
    if (!h.ran) {
      h.ran = true
      save()
    }
  }

  return {
    make(sessionId, orders, why) {
      const h = find(sessionId)
      const all = [...new Set([...(h?.orders ?? []), ...orders])]
      if (h) {
        h.orders = all
        h.at = deps.now()
        h.why = why
        delete h.ran
      } else holds.push({ sessionId, orders: all, at: deps.now(), why })
      empty.delete(sessionId)
      const saved = save()
      deps.log?.info(`residual hold on chat ${sessionId.slice(0, 8)} (orders ${all.join(', ')}): ${why}; it holds until a turn end is seen there`)
      return saved
    },
    again(sessionId, why) {
      const h = find(sessionId)
      if (!h) return
      h.at = deps.now()
      h.why = why
      delete h.ran
      empty.delete(sessionId)
      save()
      deps.log?.info(`residual hold on chat ${sessionId.slice(0, 8)} held again: ${why}`)
    },
    on: sessionId => [...(find(sessionId)?.orders ?? [])],
    held() {
      const out = new Map<string, string[]>()
      for (const h of holds) out.set(h.sessionId, [...h.orders])
      return out
    },
    carrying(orderId) {
      const h = holds.find(x => x.orders.includes(orderId))
      return h ? { ...h, orders: [...h.orders] } : null
    },
    letGo(orderId) {
      const h = holds.find(x => x.orders.includes(orderId))
      if (!h) return false
      drop(h, `his Let go on order ${orderId}`)
      return true
    },
    saw,
    async tick(look) {
      if (unsaved) save()
      if (busy || holds.length === 0) return []
      busy = true
      const gone: string[] = []
      try {
        for (const h of [...holds]) {
          const st = look.stateOf(h.sessionId)
          const seen = look.seen?.(h.sessionId) ?? {}
          saw(h.sessionId, st, seen)
          if (!h.ran || st !== 'idle' || seen.live) continue
          let clear = false
          try {
            clear = (await look.boxEmpty(h.sessionId)) === true
          } catch {
            clear = false
          }
          // Looked at again after the read (another PC answers it over the link): a turn that started meanwhile, or a new make, is no end.
          const st2 = look.stateOf(h.sessionId)
          const seen2 = look.seen?.(h.sessionId) ?? {}
          saw(h.sessionId, st2, seen2)
          if (!holds.includes(h) || !h.ran || st2 !== 'idle' || seen2.live) continue
          const n = clear ? (empty.get(h.sessionId) ?? 0) + 1 : 0
          empty.set(h.sessionId, n)
          if (n < EMPTY_LOOKS) continue
          drop(h, 'a turn end was seen there after it was made (the chat at rest, its box empty)')
          gone.push(h.sessionId)
        }
      } finally {
        busy = false
      }
      return gone
    },
    list: () => holds.map(h => ({ ...h, orders: [...h.orders] })),
  }
}

function load(file: string | undefined, log: ResidualDeps['log']): ResidualHold[] {
  if (!file || !existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { holds?: unknown }
    if (!Array.isArray(raw.holds)) return []
    return raw.holds.flatMap((x): ResidualHold[] => {
      if (!x || typeof x !== 'object') return []
      const h = x as Partial<ResidualHold>
      if (typeof h.sessionId !== 'string' || !h.sessionId || !Array.isArray(h.orders) || typeof h.at !== 'number') return []
      const orders = h.orders.filter((o): o is string => typeof o === 'string')
      return [{ sessionId: h.sessionId, orders, at: h.at, why: typeof h.why === 'string' ? h.why : '', ...(h.ran === true ? { ran: true } : {}) }]
    })
  } catch (e) {
    log?.warn(`residual holds: ${file} could not be read (${e instanceof Error ? e.message : String(e)}); none kept`)
    return []
  }
}
