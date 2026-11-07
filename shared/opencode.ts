/** OpenCode's public free models need no account; paid providers use CRM API keys. */
export const OPENCODE_PROVIDERS = ['openai', 'anthropic', 'opencode'] as const
export type OpenCodeProvider = (typeof OPENCODE_PROVIDERS)[number]
export const OPENCODE_MODEL_MAX = 120
export const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9_-]{8,128}$/
export const openCodeProvider = (v: unknown): OpenCodeProvider => v === 'opencode' ? 'opencode' : v === 'anthropic' ? 'anthropic' : 'openai'
/** Zero input/output/cache prices verified in the pinned 1.19.4 catalog. Runtime rechecks costs. */
export const OPENCODE_FREE_MODELS = ['big-pickle', 'beam-free', 'deepseek-v4.1-flash-free', 'flint-40b-free', 'glm-5.3-flash-free', 'mimo-v2.6-flash-free', 'minimax-m3.1-flash-free', 'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'nemotron-3.5-super-vl-free'] as const
export const OPENCODE_FREE_DEFAULT = 'big-pickle'
export const isOpenCodeFreeModel = (v: unknown): v is string => typeof v === 'string' && (OPENCODE_FREE_MODELS as readonly string[]).includes(v)
type Selection = { opencodeProvider?: OpenCodeProvider | ''; opencodeModel?: string }
/** A model default belongs to its provider; never carry it to a different explicit provider. */
export function openCodeSelection(value: Selection, defaults: Selection = {}) {
  const provider = openCodeProvider(value.opencodeProvider || defaults.opencodeProvider)
  const inherited = provider === openCodeProvider(defaults.opencodeProvider) ? defaults.opencodeModel : ''
  return { provider, model: value.opencodeModel || inherited || (provider === 'opencode' ? OPENCODE_FREE_DEFAULT : '') }
}
export const openCodeModel = (v: unknown): string => typeof v === 'string' ? v.trim().slice(0, OPENCODE_MODEL_MAX) : ''
// oxlint-disable-next-line no-control-regex
export function validOpenCodeModel(v: unknown): v is string { return typeof v === 'string' && v.length <= OPENCODE_MODEL_MAX && !/[\s\x00-\x1f/\\]/.test(v) }
export interface OpenCodeStatus {
  installed: boolean
  version: string | null
  live: number
  limit: number
  state: 'ready' | 'not-installed' | 'capacity' | 'error'
  hint: string | null
}
