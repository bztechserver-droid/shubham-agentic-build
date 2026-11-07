import { openCodeProvider, openCodeModel, validOpenCodeModel, OPENCODE_PROVIDERS, isOpenCodeFreeModel } from '../../shared/opencode.ts'
import { readFileSync } from 'node:fs'
import { AGENT_EFFORTS, AGENT_MODELS, NO_DEFAULTS, type AgentEffort, type AgentModel, type ChatDefaults } from '../../shared/agentic.ts'
import { AGENT_ENGINES, CODEX_EFFORTS, CODEX_MODEL_MAX, type AgentEngine, type CodexEffort } from '../../shared/codex.ts'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'

// F-067: what an agent set to "Default" gets: a model, an effort and ultracode (Settings › Chats).
// Kept on the hub in one small file, and copied to its members with the rest of the state, so a
// chat started on any PC gets the same. Nothing set: the claude CLI's own choice, ultracode off.

const isModel = (v: unknown): v is AgentModel => typeof v === 'string' && (AGENT_MODELS as readonly string[]).includes(v)
const isEffort = (v: unknown): v is AgentEffort => typeof v === 'string' && (AGENT_EFFORTS as readonly string[]).includes(v)
const isEngine = (v: unknown): v is AgentEngine => typeof v === 'string' && (AGENT_ENGINES as readonly string[]).includes(v)
const isCodexEffort = (v: unknown): v is CodexEffort => typeof v === 'string' && (CODEX_EFFORTS as readonly string[]).includes(v)
const codexModelOf = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, CODEX_MODEL_MAX) : '')

/** What a file or a hub's state says, repaired to something valid (a value it can't use is the CLI's own / off). */
export function parseDefaults(raw: unknown): ChatDefaults {
  if (typeof raw !== 'object' || raw === null) return { ...NO_DEFAULTS }
  const r = raw as Record<string, unknown>
  return {
    model: isModel(r.model) ? r.model : '',
    effort: isEffort(r.effort) ? r.effort : '',
    ultracode: r.ultracode === true,
    // F-134: the engine "Default" means, and the Codex model and effort (a file or state from before it has none: Claude, Codex's own).
    engine: isEngine(r.engine) ? r.engine : '',
    ...(r.opencodeProvider !== undefined || r.opencodeModel !== undefined ? { opencodeProvider: openCodeProvider(r.opencodeProvider), opencodeModel: openCodeModel(r.opencodeModel) } : {}),
    codexModel: codexModelOf(r.codexModel),
    codexEffort: isCodexEffort(r.codexEffort) ? r.codexEffort : '',
  }
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
      if (p.engine !== undefined && !isEngine(p.engine)) throw apiError(400, 'engine is claude, codex, or "" for Claude')
      if (p.codexEffort !== undefined && !isCodexEffort(p.codexEffort)) throw apiError(400, 'codexEffort is low, medium, high, xhigh, or "" for the one Codex chooses')
      if (p.codexModel !== undefined && typeof p.codexModel !== 'string') throw apiError(400, 'codexModel is a model name, or "" for the one Codex chooses')
      if (p.opencodeProvider !== undefined && !(OPENCODE_PROVIDERS as readonly unknown[]).includes(p.opencodeProvider)) throw apiError(400, 'OpenCode provider is openai, anthropic or opencode')
      if (p.opencodeModel !== undefined && !validOpenCodeModel(p.opencodeModel)) throw apiError(400, 'Invalid OpenCode model name')
      const next: ChatDefaults = {
        ...(p.opencodeProvider !== undefined || p.opencodeModel !== undefined || now.opencodeProvider !== undefined || now.opencodeModel !== undefined ? {
          opencodeProvider: p.opencodeProvider !== undefined ? openCodeProvider(p.opencodeProvider) : openCodeProvider(now.opencodeProvider),
          opencodeModel: p.opencodeModel !== undefined ? openCodeModel(p.opencodeModel) : openCodeModel(now.opencodeModel),
        } : {}),
        model: p.model !== undefined ? (p.model as AgentModel) : now.model,
        effort: p.effort !== undefined ? (p.effort as AgentEffort) : now.effort,
        ultracode: p.ultracode !== undefined ? p.ultracode === true : now.ultracode,
        engine: p.engine !== undefined ? (p.engine as AgentEngine) : (now.engine ?? ''),
        codexModel: p.codexModel !== undefined ? codexModelOf(p.codexModel) : (now.codexModel ?? ''),
        codexEffort: p.codexEffort !== undefined ? (p.codexEffort as CodexEffort) : (now.codexEffort ?? ''),
      }
      if (next.opencodeProvider === 'opencode' && next.opencodeModel && !isOpenCodeFreeModel(next.opencodeModel)) throw apiError(400, 'Choose a verified OpenCode free model')
      if (
        next.opencodeProvider === openCodeProvider(now.opencodeProvider) &&
        next.opencodeModel === openCodeModel(now.opencodeModel) &&
        next.model === now.model &&
        next.effort === now.effort &&
        next.ultracode === now.ultracode &&
        next.engine === (now.engine ?? '') &&
        next.codexModel === (now.codexModel ?? '') &&
        next.codexEffort === (now.codexEffort ?? '')
      ) {
        return { ...now }
      }
      now = next
      writeAtomic(file, `${JSON.stringify(now, null, 2)}\n`)
      onChange?.()
      return { ...now }
    },
  }
}
