import { EXECUTION_ERROR_CODES } from '../../shared/chat-execution-http.ts'
import { bridgeCredentialFailureCode, type BridgeCredentialCode } from '../codex/bridge-credentials.ts'
import { providerFailureSummary, type ProviderFailureSummary } from './adapter.ts'

export type RequestPhase = 'request' | 'authorization' | 'provider' | 'response'
export interface RequestFailureSummary extends Omit<ProviderFailureSummary, 'stage'> {
  stage: ProviderFailureSummary['stage'] | 'authorization' | 'runtime' | 'request'
  providerDispatched?: boolean
  interruption?: BridgeCredentialCode
}

/** Classify only app-owned codes and adapter-whitelisted metadata. Never copy an error's
 * message, cause, body, headers, request, credentials, or arbitrary fields to diagnostics.
 */
export function requestFailureSummary(error: unknown, phase: RequestPhase, signal: AbortSignal): RequestFailureSummary {
  if (signal.aborted) {
    const interruption = bridgeCredentialFailureCode(signal.reason)
    return { stage: 'transport', category: signal.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted', ...(interruption ? { interruption } : {}) }
  }
  const credential = bridgeCredentialFailureCode(error)
  if (credential) {
    if (credential === 'bridge-dispatch-unknown') return { stage: 'stream', category: 'unconfirmed' }
    const runtime = credential === 'bridge-owner-ambiguous' || credential === 'bridge-owner-busy'
    return { stage: runtime ? 'runtime' : 'authorization', category: credential }
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'not-yours' || code === 'sign-in') return { stage: 'authorization', category: code }
  if (typeof code === 'string' && (EXECUTION_ERROR_CODES as readonly string[]).includes(code) && code !== 'bridge-policy-refused') {
    const authorization = ['execution-forbidden', 'bridge-lease-invalid', 'bridge-authorization-unavailable', 'bridge-refresh-required'].includes(code)
    return { stage: authorization ? 'authorization' : 'runtime', category: code }
  }
  if (phase === 'request') return { stage: 'request', category: error instanceof SyntaxError ? 'invalid-json' : code === 'bridge-policy-refused' ? 'unsupported-request' : 'invalid-request' }
  if (phase === 'authorization') return { stage: 'authorization', category: 'unavailable' }
  return providerFailureSummary(error)
}
