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

/** Why a failed request that Claude Code did not end leaves its run open (not paused). Nothing is retried either way.
 * - 'validation-unanswered': nothing was sent, and the only reason is that the CRM login check went unanswered (timeout or CRM
 *   unreachable, retried a bounded number of times first): refused with that reason; the next message goes through once the
 *   check answers. A definite answer (revoked, changed, signed out) still pauses.
 * - 'controller-stopping': the controller itself is stopping (hub restart, Update). The request's result is unknown, so it is
 *   never sent again (the child gateway refuses exactly that request); a message with new content may continue the chat.
 * 10 Nov 2026: Special and Memory paused at 16:38 on an unanswered check (94% CPU), Special at the 15:16 and 16:56 Updates. */
export type OpenReason = 'validation-unanswered' | 'controller-stopping' | 'provider-unconfirmed'
/** Transport failures after which nothing is known of the reply, and that do not repeat by themselves on the next message
 * (a refused connection, DNS or certificate failure would: those still pause). */
const UNCONFIRMED_TRANSPORT = new Set(['unavailable', 'timeout', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT'])
/** - 'provider-unconfirmed': the request was sent and ChatGPT's stream then failed with nothing known of the reply (the
 *   connection dropped, it stalled until the request limit, or it ended without completing). Nothing of a partial reply runs
 *   (tool calls are released only from a completed reply). The run stays open ONLY because that exact request is never sent
 *   again (UnconfirmedRequests); the person sees "the previous reply failed and was not retried"; failure.json records it.
 *   An HTTP refusal, a policy mismatch, a credential interruption or an abort of unknown cause still pauses.
 *   10 Nov 2026, 15:56: Connection's stream stalled 7 minutes (16 events), then failed, and paused the chat. */
export function keepsRunOpen(o: { phase: RequestPhase; dispatched: boolean; error: unknown; stopping: boolean; failure?: RequestFailureSummary }): OpenReason | null {
  if (o.stopping) return 'controller-stopping'
  if (!o.dispatched && o.phase === 'authorization' && bridgeCredentialFailureCode(o.error) === 'bridge-validation-stale') return 'validation-unanswered'
  const f = o.failure
  if (o.dispatched && o.phase === 'provider' && f && f.interruption === undefined
    && ((f.stage === 'transport' && UNCONFIRMED_TRANSPORT.has(String(f.category))) || (f.stage === 'stream' && f.category === 'missing-completed-event'))) return 'provider-unconfirmed'
  return null
}

/** The never-resend guard for 'provider-unconfirmed': per run, the requests (by requestDigest: their messages) whose reply
 * failed unconfirmed. The same request again (Claude Code's own "retry without streaming") is refused before anything is
 * sent; a request with new content goes through. Bounded; for the controller's lifetime (a restart is the gateway's cut guard). */
export class UnconfirmedRequests {
  private readonly runs = new Map<string, Set<string>>()
  add(runId: string, digest: string) {
    const set = this.runs.get(runId) ?? new Set<string>()
    if (set.size >= 32) set.delete(set.values().next().value!)
    set.add(digest); this.runs.set(runId, set)
  }
  any(runId: string): boolean { return (this.runs.get(runId)?.size ?? 0) > 0 }
  has(runId: string, digest: string): boolean { return this.runs.get(runId)?.has(digest) === true }
  forget(runId: string) { this.runs.delete(runId) }
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
