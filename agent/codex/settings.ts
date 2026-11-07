import { readFileSync } from 'node:fs'
import { writeAtomic } from '../config.ts'

// F-134: Settings › Chats › "Codex chats". Ships OFF: with it off an agent set to Codex is refused with a plain sentence, the CRM is never asked for a Codex login, and
// nothing about Claude's chats changes. One small file on this PC.

export interface CodexSettings {
  on(): boolean
  set(on: boolean): boolean
}

/** <dir>/codex-settings.json: { "on": true } when turned on; nothing there means off. */
export function createCodexSettings(file: string): CodexSettings {
  let on = false
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof raw === 'object' && raw !== null && (raw as { on?: unknown }).on === true) on = true
  } catch {
    // No file, or an unreadable one: off.
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
