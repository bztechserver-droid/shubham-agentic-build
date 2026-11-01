import { readFileSync } from 'node:fs'
import { AGENT_EFFORTS, AGENT_MODELS, NO_DEFAULTS, type AgentEffort, type AgentModel, type ChatDefaults } from '../../shared/agentic.ts'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'

// F-067: what an agent set to "Default" gets: a model, an effort and ultracode (Settings › Chats).
// Kept on the hub in one small file, and copied to its members with the rest of the state, so a
// chat started on any PC gets the same. Nothing set: the claude CLI's own choice, ultracode off.

const isModel = (v: unknown): v is AgentModel => typeof v === 'string' && (AGENT_MODELS as readonly string[]).includes(v)
const isEffort = (v: unknown): v is AgentEffort => typeof v === 'string' && (AGENT_EFFORTS as readonly string[]).includes(v)

/** What a file or a hub's state says, repaired to something valid (a value it can't use is the CLI's own / off). */
export function parseDefaults(raw: unknown): ChatDefaults {
  if (typeof raw !== 'object' || raw === null) return { ...NO_DEFAULTS }
  const r = raw as Record<string, unknown>
  return { model: isModel(r.model) ? r.model : '', effort: isEffort(r.effort) ? r.effort : '', ultracode: r.ultracode === true }
}

export interface DefaultsStore {
  get(): ChatDefaults
  /** Changes what is given (the rest stays); a value that isn't one is refused. Returns what is now. */
  set(patch: unknown): ChatDefaults
}

export function createDefaultsStore(file: string, onChange?: () => void): DefaultsStore {
  let now: ChatDefaults = { ...NO_DEFAULTS }
  try {
    now = parseDefaults(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // No file yet, or not JSON: nothing set.
  }
  return {
    get: () => ({ ...now }),
    set(patch) {
      if (typeof patch !== 'object' || patch === null) throw apiError(400, 'Expected {model?, effort?, ultracode?}')
      const p = patch as Record<string, unknown>
      if (p.model !== undefined && !isModel(p.model)) throw apiError(400, 'model is opus, sonnet, haiku, or "" for the one claude chooses')
      if (p.effort !== undefined && !isEffort(p.effort)) throw apiError(400, 'effort is low, medium, high, xhigh, max, or "" for the one claude chooses')
      if (p.ultracode !== undefined && typeof p.ultracode !== 'boolean') throw apiError(400, 'ultracode is true or false')
      const next: ChatDefaults = {
        model: p.model !== undefined ? (p.model as AgentModel) : now.model,
        effort: p.effort !== undefined ? (p.effort as AgentEffort) : now.effort,
        ultracode: p.ultracode !== undefined ? p.ultracode === true : now.ultracode,
      }
      if (next.model === now.model && next.effort === now.effort && next.ultracode === now.ultracode) return { ...now }
      now = next
      writeAtomic(file, `${JSON.stringify(now, null, 2)}\n`)
      onChange?.()
      return { ...now }
    },
  }
}
