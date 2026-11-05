import { readFileSync } from 'node:fs'
import { writeAtomic } from '../config.ts'

// F-127: new floors and chats on a member PC while the Server (the hub) can't be reached. This file is only the per-PC setting and the
// debounce; the rest is in index.ts (the local floor store, the routing and the adoption when the Server is back).

/** The Server has to be out of reach this long (ms) before new chats are made on this PC: a blip of the link is not an outage. */
export const OFFLINE_AFTER_MS = 20_000

export interface OfflineSettings {
  /** Allowed on this PC: default ON ("on for every PC"); turned off, the Server's way is the only one (the 503 as before). */
  on(): boolean
  set(on: boolean): boolean
}

/** <state>/agent/agentic/offline.json: { "on": false } when turned off; nothing there means on. */
export function createOfflineSettings(file: string): OfflineSettings {
  let on = true
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof raw === 'object' && raw !== null && (raw as { on?: unknown }).on === false) on = false
  } catch {
    // No file, or an unreadable one: the default.
  }
  return {
    on: () => on,
    set(next) {
      on = next
      writeAtomic(file, `${JSON.stringify({ on })}\n`)
      return on
    },
  }
}
