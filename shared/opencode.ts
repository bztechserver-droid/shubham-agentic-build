/** API-key engines only. Zen and subscription authorization are later phases. */
export const OPENCODE_PROVIDERS = ['openai', 'anthropic'] as const
export type OpenCodeProvider = (typeof OPENCODE_PROVIDERS)[number]
export const OPENCODE_MODEL_MAX = 120
export const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9_-]{8,128}$/
export const openCodeProvider = (v: unknown): OpenCodeProvider => v === 'anthropic' ? 'anthropic' : 'openai'
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
