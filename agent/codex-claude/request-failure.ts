import { EXECUTION_ERROR_CODES } from '../../shared/chat-execution-http.ts'
import { bridgeCredentialFailureCode, type BridgeCredentialCode } from '../codex/bridge-credentials.ts'
import { providerFailureSummary, type ProviderFailureSummary } from './adapter.ts'

export type RequestPhase = 'request' | 'authorization' | 'provider' | 'response'
export interface RequestFailureSummary extends Omit<ProviderFailureSummary, 'stage'> {
  stage: ProviderFailureSummary['stage'] | 'authorization' | 'runtime' | 'request'
  providerDispatched?: boolean
  interruption?: BridgeCredentialCode
}

/** Who ended a bridge request. `client()` is wired to the request's own abort/close events (Claude Code: Esc, a stopped
 * background task, its connection closed). It counts as Claude Code's doing only when nothing else (timeout, host loss,
 * shutdown) had already ended the request; `abort` then ends the provider request as before. */
export function requestEnd(signal: AbortSignal, abort: () => void) {
  let byClient = false
  return {
    client() { if (!signal.aborted) byClient = true; abort() },
    get byClient() { return byClient },
  }
}

/** Whether a failed bridge request pauses its chat. Every failure does, except Claude Code ending the request itself outside
 * authorization: nothing about the run is uncertain then, the bridge never retries, and Claude Code decides what to send next.
 * While credentials may be refreshing (authorization), an ended request still pauses. 10 Nov: Lead's TaskStop of a background
 * review cancelled one request and left Lead answering every message with "API Error: 400 ... paused" for an hour. */
export function pausesRun(byClient: boolean, phase: RequestPhase): boolean {
  return !(byClient && phase !== 'authorization')
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
