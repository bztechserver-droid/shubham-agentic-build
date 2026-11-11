import { readFileSync } from 'node:fs'
import { DEFAULT_ASSISTANT_SETTINGS, GOALS_ON_PHONE_WHY, isGoalsRoute, type AssistantSettings } from '../../shared/goals-on-phone.ts'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'

// The overlay Assistant's own settings (Settings › Assistant). One small file on the hub; nothing set: the defaults.

/** What a file says, repaired to something valid (anything but a boolean is the default). */
export function parseAssistantSettings(raw: unknown): AssistantSettings {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return { goalsOnMobile: typeof r.goalsOnMobile === 'boolean' ? r.goalsOnMobile : DEFAULT_ASSISTANT_SETTINGS.goalsOnMobile }
}

export interface AssistantSettingsStore {
  get(): AssistantSettings
  /** Changes what is given; a value that isn't a boolean is refused. Returns what is now. */
  set(patch: unknown): AssistantSettings
}

export function createAssistantSettings(file: string): AssistantSettingsStore {
  let now: AssistantSettings = { ...DEFAULT_ASSISTANT_SETTINGS }
  try {
    now = parseAssistantSettings(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // No file yet, or not JSON: the defaults.
  }
  return {
    get: () => ({ ...now }),
    set(patch) {
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw apiError(400, 'Expected {goalsOnMobile?}')
      const p = patch as Record<string, unknown>
      if (p.goalsOnMobile !== undefined && typeof p.goalsOnMobile !== 'boolean') throw apiError(400, 'goalsOnMobile is true or false')
      const next: AssistantSettings = { goalsOnMobile: p.goalsOnMobile !== undefined ? p.goalsOnMobile : now.goalsOnMobile }
      if (next.goalsOnMobile !== now.goalsOnMobile) {
        now = next
        writeAtomic(file, `${JSON.stringify(now, null, 2)}\n`)
      }
      return { ...now }
    },
  }
}

/**
 * Is this tool call one that opens or fills the CRM Goals page (so, on a phone, it is refused)? What only the page can tell (a
 * press or typing while the Goals page is up) is refused by the page, which is told to by `goalsApi` (see index.ts).
 */
export function goalsPageCall(name: string, args: Record<string, unknown>): string | null {
  if (name === 'ui_control' && args.action === 'crm_goto' && typeof args.path === 'string' && isGoalsRoute(args.path)) return GOALS_ON_PHONE_WHY
  if (name === 'ui_invoke' && ((typeof args.module === 'string' && /goal/i.test(args.module)) || (typeof args.method === 'string' && /goal/i.test(args.method)))) return GOALS_ON_PHONE_WHY
  return null
}
