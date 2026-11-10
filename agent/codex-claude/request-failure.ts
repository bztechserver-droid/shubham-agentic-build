import { EXECUTION_ERROR_CODES } from '../../shared/chat-execution-http.ts'
import { bridgeCredentialFailureCode, type BridgeCredentialCode } from '../codex/bridge-credentials.ts'
import { providerFailureSummary, type ProviderFailureSummary } from './adapter.ts'

export type RequestPhase = 'request' | 'authorization' | 'provider' | 'response'
export interface RequestFailureSummary extends Omit<ProviderFailureSummary, 'stage'> {
  stage: ProviderFailureSummary['stage'] | 'authorization' | 'runtime' | 'request'
  providerDispatched?: boolean
  interruption?: BridgeCredentialCode
}

/** The abort reason the bridge gives a request that Claude Code itself ended (Esc, a stopped background task, its connection
 * closed). Only this exact object counts as Claude Code's end: a timeout, host loss, shutdown, or a credential, lease or
 * runtime interruption aborts with its own reason. */
export const CLAUDE_CODE_ENDED: Error = Object.freeze(new Error('Claude Code ended this request'))

/** Whether a failed bridge request was ended by Claude Code and by nothing else, so its chat is not paused (the cause, not
 * the order of events, decides). All of these must hold:
 * - the request's own first end was Claude Code's: `outer` (request + timeout + host + shutdown) aborted with CLAUDE_CODE_ENDED;
 * - and the failure is exactly that cancellation:
 *   - provider call started: the provider call's own signal (through the broker and the credential manager) ended with
 *     CLAUDE_CODE_ENDED, not with a manager or broker interruption, AND the provider call itself failed as a plain cancellation:
 *     the runtime's record (`cause`: transport/aborted, no interruption) and the adapter's own record (`provider`: transport/
 *     aborted) both say so. An HTTP status seen first (kept by the adapter even if its body read is cancelled), a stream or
 *     policy failure, a call that completed and failed afterwards (validation, live mismatch: no record), or a failure the
 *     adapter did not record, is never excused by a later end;
 *   - authorization (nothing sent): the broker only stopped waiting (`bridge-cancelled`), not a credential, lease, binding or
 *     runtime error;
 *   - request (nothing authorized): reading Claude Code's request was cut off by that end.
 * Everything else pauses, as before; nothing is retried either way. 10 Nov 2026: Lead's TaskStop of a background review
 * cancelled one request and left Lead answering every message with "API Error: 400 ... paused" until it was restarted. */
export function endedByClaudeCode(o: { outer: AbortSignal; phase: RequestPhase; dispatched: boolean; inner?: AbortSignal; cause?: RequestFailureSummary;
  provider?: ProviderFailureSummary | null; error: unknown }): boolean {
  if (!o.outer.aborted || o.outer.reason !== CLAUDE_CODE_ENDED) return false
  if (o.dispatched) return o.inner?.aborted === true && o.inner.reason === CLAUDE_CODE_ENDED
    && o.cause?.stage === 'transport' && o.cause.category === 'aborted' && o.cause.interruption === undefined
    && o.provider?.stage === 'transport' && o.provider.category === 'aborted'
  if (o.phase === 'authorization') return bridgeCredentialFailureCode(o.error) === 'bridge-cancelled'
  if (o.phase === 'request') return o.error === CLAUDE_CODE_ENDED || ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(String((o.error as { code?: unknown } | null)?.code))
  return false
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
