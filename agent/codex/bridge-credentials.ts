import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { requireBridgeLeaseRequest, requireCodexBridgeLease, type BridgeActualRuntimeProof, type BridgeLeaseRequest,
  type BridgeRequestAuthorization, type CodexBridgeCredentialBroker, type CodexBridgeLease } from '../codex-claude/contract.ts'

export const BRIDGE_VALIDATION_MAX_AGE_MS = 60_000
export const BRIDGE_MIN_ACCESS_VALIDITY_MS = 120_000
export const BRIDGE_VALIDATION_CADENCE_MS = 30_000
export const BRIDGE_VALIDATION_TIMEOUT_MS = 10_000
export type BridgeCredentialCode = 'bridge-lease-invalid' | 'bridge-context-changed' | 'bridge-validation-stale' |
  'bridge-refresh-required' | 'bridge-credential-unavailable' | 'bridge-owner-ambiguous' | 'bridge-owner-busy' |
  'bridge-dispatch-unknown' | 'bridge-cancelled'
const messages: Record<BridgeCredentialCode, string> = {
  'bridge-lease-invalid': 'This provider-consumer lease is not current.',
  'bridge-context-changed': 'The server credential owner or context changed. Provider dispatch is paused.',
  'bridge-validation-stale': 'Current server credential validation is unavailable or stale. Check the CRM credential through its existing manager.',
  'bridge-refresh-required': 'A current, safely unexpired ChatGPT credential is required. This bridge does not refresh credentials.',
  'bridge-credential-unavailable': 'The current manager cannot safely authorize this ChatGPT provider request.',
  'bridge-owner-ambiguous': 'Provider ownership is not confirmed. Its lease is retained and dispatch is paused.',
  'bridge-owner-busy': 'The provider consumer is still running or draining. Its lease is retained.',
  'bridge-dispatch-unknown': 'The provider operation did not complete with a confirmed result. Do not retry automatically.',
  'bridge-cancelled': 'The provider operation was cancelled. Do not retry automatically.',
}
const knownErrors = new WeakSet<Error>()
export const bridgeCredentialError = (code: BridgeCredentialCode) => {
  const error = Object.assign(new Error(messages[code]), { code, status: code === 'bridge-dispatch-unknown' ? 502 : 409 })
  knownErrors.add(error)
  return error
}
const safeError = (error: unknown, fallback: BridgeCredentialCode) => error instanceof Error && knownErrors.has(error) ? error : bridgeCredentialError(fallback)

/** Backend-only metadata. Neither this context nor the transient callback belongs in shared/UI state. */
export interface ManagerBridgeContext {
  readonly ownerId: string
  readonly sessionEpoch: string
  readonly subscriptionId: string
  readonly revision: number
  readonly contentHash: string
  readonly credentialEpoch: string
  readonly expiresAtMs: number
  readonly validatedAtMs: number
  readonly validationExpiresAtMs: number
}
export interface ManagerBridgeSource {
  /** A trusted surviving runtime may need a hold BEFORE current credentials can be established. Not authorization. */
  protect(consumerId: string): void
  retain(consumerId: string, ownerId: string): Promise<ManagerBridgeContext>
  current(consumerId: string, expected: ManagerBridgeContext): ManagerBridgeContext | null
  /** Capture/validate + invoke send synchronously under the queue; await its result OUTSIDE the global queue. */
  use<T>(consumerId: string, expected: ManagerBridgeContext, send: (authorization: BridgeRequestAuthorization, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>
  /** The ownership guard runs inside the manager queue immediately before deleting the hold. */
  release(consumerId: string, guard?: () => void): Promise<void>
}
export interface ManagedBridgeSource extends ManagerBridgeSource {
  /** Existing manager-owned CRM validation only; no provider/OAuth request. Single-flight and timeout bounded. */
  validate(): Promise<void>
}
export type BridgeOwnerObservation = { state: 'running'; runtime: BridgeActualRuntimeProof } | { state: 'not-started' | 'ended' | 'unknown' }
export interface BridgeCredentialBrokerOptions {
  source: ManagerBridgeSource
  /** Synchronous authoritative configured/native/run/link fence, not merely a saved profile comparison. */
  currentBinding(request: BridgeLeaseRequest): boolean
  /** Trusted runtime owner validates OS/process/profile evidence; never echoes an untrusted request body. */
  observeRuntime(request: BridgeLeaseRequest): Promise<BridgeOwnerObservation>
  /** Synchronous OLD-run ownership/retirement proof, independent of the slot's current input binding.
   * Must compare the exact unique lease/run/process incarnation with an owned stopped/not-started record,
   * and refuse a replaced observation, live/unknown controller or unconfirmed transfer. */
  canRetire(lease: CodexBridgeLease, observed: BridgeOwnerObservation): boolean
  now?: () => number
  minValidityMs?: number
}
export interface DispatchingCodexBridgeBroker extends CodexBridgeCredentialBroker {
  /** Trusted transport MUST start its HTTP operation in this callback, before yielding or retaining a token. */
  dispatch<T>(lease: CodexBridgeLease, send: (authorization: BridgeRequestAuthorization, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>
}

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
export function requireBridgeContext(c: ManagerBridgeContext, ownerId: string, now: number, margin = BRIDGE_MIN_ACCESS_VALIDITY_MS): void {
  if (!c || c.ownerId !== ownerId || !id(c.ownerId) || !id(c.subscriptionId) || !id(c.sessionEpoch) || !id(c.credentialEpoch) ||
      !integer(c.revision) || !/^[a-f0-9]{64}$/.test(c.contentHash)) throw bridgeCredentialError('bridge-context-changed')
  if (!integer(now) || !integer(c.validatedAtMs) || !integer(c.validationExpiresAtMs) || c.validatedAtMs > now ||
      c.validationExpiresAtMs <= now || c.validationExpiresAtMs <= c.validatedAtMs ||
      c.validationExpiresAtMs - c.validatedAtMs > BRIDGE_VALIDATION_MAX_AGE_MS) throw bridgeCredentialError('bridge-validation-stale')
  if (!integer(c.expiresAtMs) || c.expiresAtMs - now <= margin) throw bridgeCredentialError('bridge-refresh-required')
}
/** Validation may be renewed by existing manager operations, but never change the credential identity in-place. */
export function sameBridgeCredential(a: ManagerBridgeContext, b: ManagerBridgeContext): boolean {
  return a.ownerId === b.ownerId && a.sessionEpoch === b.sessionEpoch && a.subscriptionId === b.subscriptionId &&
    a.revision === b.revision && a.contentHash === b.contentHash && a.credentialEpoch === b.credentialEpoch && a.expiresAtMs === b.expiresAtMs
}
interface Entry {
  lease: CodexBridgeLease
  consumerId: string
  context: ManagerBridgeContext | null
  blocked: boolean
  closed: boolean
  flights: Set<AbortController>
}

export function createCodexBridgeCredentialBroker(o: BridgeCredentialBrokerOptions): DispatchingCodexBridgeBroker {
  const now = o.now ?? Date.now
  const margin = o.minValidityMs ?? BRIDGE_MIN_ACCESS_VALIDITY_MS
  if (!Number.isSafeInteger(margin) || margin < BRIDGE_MIN_ACCESS_VALIDITY_MS) throw bridgeCredentialError('bridge-refresh-required')
  const entries = new Map<string, Entry>(), runs = new Map<string, Entry>()
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run }
  const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw bridgeCredentialError('bridge-cancelled') }
  const binding = (request: BridgeLeaseRequest) => { if (!o.currentBinding(request)) throw bridgeCredentialError('bridge-context-changed') }
  const runKey = (r: BridgeLeaseRequest) => JSON.stringify([r.targetPcId, r.runId])
  const keyOf = (lease: CodexBridgeLease) => {
    const parsed = requireCodexBridgeLease(lease, lease?.request)
    const e = entries.get(parsed.leaseId)
    if (!e || !isDeepStrictEqual(e.lease, parsed)) throw bridgeCredentialError('bridge-lease-invalid')
    return e
  }
  function fence(e: Entry, signal?: AbortSignal) {
    cancelled(signal)
    if (e.closed || e.blocked || !e.context) throw bridgeCredentialError('bridge-lease-invalid')
    binding(e.lease.request)
    const fresh = o.source.current(e.consumerId, e.context)
    if (!fresh || !sameBridgeCredential(e.context, fresh)) throw bridgeCredentialError('bridge-context-changed')
    requireBridgeContext(fresh, e.lease.request.ownerId, now(), margin)
    e.context = Object.freeze({ ...fresh })
  }
  function pause(e: Entry) { e.blocked = true; for (const c of e.flights) c.abort() }
  const runtimeMatches = (e: Entry, runtime: BridgeActualRuntimeProof) => runtime.ownerId === e.lease.request.ownerId && runtime.runId === e.lease.request.runId &&
    runtime.targetPcId === e.lease.request.targetPcId && runtime.leaseId === e.lease.leaseId && isDeepStrictEqual(runtime.binding, e.lease.request.binding)
  async function refreshContext(e: Entry, signal?: AbortSignal) {
    cancelled(signal); binding(e.lease.request)
    const c = await o.source.retain(e.consumerId, e.lease.request.ownerId)
    cancelled(signal); binding(e.lease.request)
    requireBridgeContext(c, e.lease.request.ownerId, now(), margin)
    if (c.revision !== e.lease.credentialRevision || (e.context && !sameBridgeCredential(e.context, c))) throw bridgeCredentialError('bridge-context-changed')
    e.context = Object.freeze({ ...c })
  }
  const broker: DispatchingCodexBridgeBroker = {
    acquire: (raw, signal) => serial(async () => {
      cancelled(signal)
      const request = requireBridgeLeaseRequest(raw)
      binding(request)
      const existing = runs.get(runKey(request))
      if (existing) {
        if (existing.closed || existing.blocked || !isDeepStrictEqual(request, existing.lease.request)) throw bridgeCredentialError('bridge-lease-invalid')
        await refreshContext(existing, signal); fence(existing, signal)
        return existing.lease
      }
      if (entries.size >= 4096) throw bridgeCredentialError('bridge-lease-invalid')
      const consumerId = `bridge-${randomUUID()}`
      try {
        const context = await o.source.retain(consumerId, request.ownerId)
        cancelled(signal); binding(request)
        requireBridgeContext(context, request.ownerId, now(), margin)
        const lease = requireCodexBridgeLease({ manager: 'existing-codex-manager-v1', leaseId: consumerId, credentialKind: 'chatgpt', credentialRevision: context.revision, request }, request)
        const e: Entry = { lease, consumerId, context: Object.freeze({ ...context }), blocked: false, closed: false, flights: new Set() }
        fence(e, signal)
        entries.set(lease.leaseId, e); runs.set(runKey(request), e)
        return lease
      } catch (error) {
        // This handle was never exposed: no caller can have launched a child under it.
        await o.source.release(consumerId).catch(() => {})
        throw safeError(error, 'bridge-credential-unavailable')
      }
    }).catch(error => { throw safeError(error, 'bridge-credential-unavailable') }),
    async dispatch(lease, send, signal) {
      const e = keyOf(lease)
      if (e.closed || e.blocked) throw bridgeCredentialError('bridge-lease-invalid')
      const controller = new AbortController(), abort = () => controller.abort()
      let initiated = false, managerSignal: AbortSignal | undefined
      e.flights.add(controller); signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) controller.abort()
      try {
        await refreshContext(e, controller.signal); fence(e, controller.signal)
        const observed = await o.observeRuntime(e.lease.request)
        fence(e, controller.signal)
        if (observed.state !== 'running' || !runtimeMatches(e, observed.runtime)) { pause(e); throw bridgeCredentialError('bridge-owner-ambiguous') }
        const result = await o.source.use(e.consumerId, e.context!, (auth, sourceSignal) => {
          managerSignal = sourceSignal
          sourceSignal.addEventListener('abort', abort, { once: true })
          if (sourceSignal.aborted) controller.abort()
          fence(e, controller.signal)
          const guarded: BridgeRequestAuthorization = Object.freeze({
            get accessToken() { fence(e, controller.signal); return auth.accessToken },
            get accountId() { fence(e, controller.signal); return auth.accountId },
            get expiresAtMs() { fence(e, controller.signal); return auth.expiresAtMs },
            get credentialRevision() { fence(e, controller.signal); return auth.credentialRevision },
          })
          // Actual fixed-destination HTTP initiation belongs HERE, not after an await in send.
          initiated = true
          return send(guarded, controller.signal)
        }, controller.signal)
        fence(e, controller.signal)
        return result
      } catch (error) {
        if (initiated) throw bridgeCredentialError('bridge-dispatch-unknown')
        throw safeError(error, controller.signal.aborted ? 'bridge-cancelled' : 'bridge-credential-unavailable')
      } finally {
        e.flights.delete(controller); signal?.removeEventListener('abort', abort)
        managerSignal?.removeEventListener('abort', abort)
      }
    },
    withAuthorization(lease, use, signal) { return broker.dispatch(lease, auth => use(auth), signal) },
    adopt: (raw, suppliedRuntime) => serial(async () => {
      const request = requireBridgeLeaseRequest(raw?.request), lease = requireCodexBridgeLease(raw, request)
      const observed = await o.observeRuntime(request)
      const existing = entries.get(lease.leaseId), e: Entry = existing ?? { lease, consumerId: lease.leaseId, context: null, blocked: true, closed: false, flights: new Set() }
      if (e.closed || !isDeepStrictEqual(e.lease, lease) || observed.state !== 'running' || !runtimeMatches(e, suppliedRuntime) || !isDeepStrictEqual(suppliedRuntime, observed.runtime)) throw bridgeCredentialError('bridge-owner-ambiguous')
      const other = runs.get(runKey(request))
      if (other && other !== e) throw bridgeCredentialError('bridge-lease-invalid')
      if (!existing && entries.size >= 4096) throw bridgeCredentialError('bridge-lease-invalid')
      // Authenticated surviving runtime first: even an unknown current context must remain protected from sweep.
      o.source.protect(e.consumerId)
      entries.set(lease.leaseId, e); runs.set(runKey(request), e)
      try { binding(request); await refreshContext(e); e.blocked = false; fence(e); return e.lease }
      catch (error) { pause(e); throw safeError(error, 'bridge-credential-unavailable') }
    }).catch(error => { throw safeError(error, 'bridge-owner-ambiguous') }),
    release: lease => serial(async () => {
      const e = keyOf(lease)
      if (e.closed) return
      pause(e)
      const observed = await o.observeRuntime(e.lease.request)
      if (observed.state === 'unknown') throw bridgeCredentialError('bridge-owner-ambiguous')
      if (observed.state === 'running' || e.flights.size) throw bridgeCredentialError('bridge-owner-busy')
      if (!o.canRetire(e.lease, observed)) throw bridgeCredentialError('bridge-owner-ambiguous')
      await o.source.release(e.consumerId, () => {
        if (e.flights.size) throw bridgeCredentialError('bridge-owner-busy')
        if (!o.canRetire(e.lease, observed)) throw bridgeCredentialError('bridge-owner-ambiguous')
      })
      e.closed = true
    }).catch(error => { throw safeError(error, 'bridge-owner-ambiguous') }),
  }
  return broker
}
