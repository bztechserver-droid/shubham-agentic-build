import * as codex from '../codex/crm.ts'
import * as claude from '../claude/crm.ts'
import { apiError } from '../api.ts'
import type { OpenCodeProvider } from '../../shared/opencode.ts'
import type { CrmSession } from '../claude/crm.ts'

export interface ApiCredential { kind: 'api_key'; provider: Exclude<OpenCodeProvider, 'opencode'>; key: string; name: string }
export interface FreeCredential { kind: 'free'; provider: 'opencode' }
export type OpenCodeCredential = ApiCredential | FreeCredential
export const FREE_CREDENTIAL: FreeCredential = Object.freeze({ kind: 'free', provider: 'opencode' })
/** Existing LIVE routes only. Fetch afresh at every backend start; no disk cache/write-back. */
export async function openCodeCredential(session: CrmSession | null, provider: OpenCodeProvider, build: string): Promise<OpenCodeCredential> {
  if (provider === 'opencode') return FREE_CREDENTIAL
  if (!session) throw Object.assign(apiError(401, 'Sign in to the CRM on this PC to use OpenCode.'), { code: 'opencode-sign-in' })
  if (provider === 'openai') {
    const r = await codex.credential(session, build)
    if (r.kind === 'expired') throw apiError(401, 'Sign in to the CRM again.')
    if (r.kind !== 'ok') throw apiError(409, 'Assign a Codex API key in the CRM for OpenCode OpenAI.')
    if (r.login.kind !== 'api_key') throw apiError(409, 'OpenCode OpenAI needs the CRM Codex API key type. A ChatGPT login is not supported in this phase.')
    return { kind: 'api_key', provider, key: r.login.apiKey, name: r.login.subscription.name }
  }
  const r = await claude.credential(session, build)
  if (r.kind === 'expired') throw apiError(401, 'Sign in to the CRM again.')
  if (r.kind !== 'ok' || r.credKind !== 'api_key') throw apiError(409, 'Assign a Claude API key in the CRM for OpenCode Anthropic. Claude subscription tokens cannot be used.')
  return { kind: 'api_key', provider, key: r.token, name: r.subscription.name }
}
