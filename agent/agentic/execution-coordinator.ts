// Private, dependency-injected coordinator. No route registration, credential reader or process runner.
import { randomUUID } from 'node:crypto'
import type { ConversionStage } from '../../shared/conversion-progress.ts'
import { assertExecutionCAS, assertPreparedExecution, CODEX_IN_CLAUDE_PROFILE, contractRecord,
  requireExecutionIdentity, requireExecutionSnapshot, sameExecution,
  type ExecutionIdentity, type ExecutionLineage, type ExecutionProfile, type ExecutionSnapshot } from '../../shared/chat-execution.ts'
import { CAPABILITY_TTL_MS, executionHttpError, executionId, executionIntentId, executionRuntimeSummary,
  executionTime, publicExecutionFailure, requireExecutionCapabilityQuery, requireExecutionOpenRequest,
  requireExecutionSelectionRequest, verifiedBridgePolicy, type ExecutionCapabilityReply,
  type ExecutionIntentStatusReply, type ExecutionOpenReply,
  type ExecutionRuntimeSummary, type ExecutionSelectionReply } from '../../shared/chat-execution-http.ts'
import { requireBridgeCapability, requireBridgeRuntimeProof, requireCodexBridgeLease,
  type BridgeRequestAuthorization, type BridgeRuntimePins, type BridgeTargetCapability,
  type CodexBridgeCredentialBroker, type CodexBridgeLease } from '../codex-claude/contract.ts'
import { executionDigest, requireIntentScope, scopeDigest, selectionFingerprint,
  type ExecutionCommitStamp, type ExecutionIntent, type ExecutionIntentLedger,
  type ExecutionIntentScope, type OpenIntent, type SelectionIntent } from './execution-intents.ts'

/** Backend-only extension agreed with Connection. The transport sends synchronously in this callback. */
export interface GuardedCodexBridgeBroker extends CodexBridgeCredentialBroker {
  dispatch<T>(lease: CodexBridgeLease, send: (authorization: BridgeRequestAuthorization, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>
}
export interface ExecutionFloorState {
  readonly binding: ExecutionSnapshot
  readonly selection: ExecutionCommitStamp | null
}
export interface ExecutionTargetObservation {
  readonly targetPcId: string
  readonly execution: ExecutionIdentity
  readonly linkGeneration: string
  readonly observedAtMs: number
  readonly validUntilMs: number
  readonly nativeVerified: boolean
  readonly pins?: BridgeRuntimePins
  readonly bridgeCapability?: BridgeTargetCapability
}
export interface ExecutionSourceFence { assertCurrent(): void }
export interface PreparedExecutionSelection {
  readonly lineage: ExecutionLineage
  readonly sourceSealId: string
}
export type ExecutionRunObservation = { readonly state: 'running'; readonly proof: unknown }
  | { readonly state: 'not-started' | 'ended'; readonly dispatchFenced: true }
  | { readonly state: 'unknown' }
interface StartBase {
  readonly scope: ExecutionIntentScope
  readonly openIntentId: string
  readonly binding: ExecutionSnapshot
  readonly runId: string
  readonly cols?: number
  readonly rows?: number
  readonly signal: AbortSignal
}
export type ExecutionStartRequest = StartBase & (
  | { readonly kind: 'bridge'; readonly lease: CodexBridgeLease; readonly dispatchProvider: <T>(send: (authorization: BridgeRequestAuthorization, signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => Promise<T> }
  | { readonly kind: 'native' })
export interface ExecutionCoordinatorPorts {
  progress?(scope: ExecutionIntentScope, stage: ConversionStage, operationId?: string): void
  ledger: ExecutionIntentLedger
  /** Synchronous current server actor/owner/target ACL fence. Never trust these IDs from HTTP bodies. */
  assertAuthorized(scope: ExecutionIntentScope): void
  /** Synchronous authoritative snapshot fence for immediate start/dispatch, independent of credential owner. */
  assertExecutionCurrent(scope: ExecutionIntentScope, expected: ExecutionSnapshot): void
  readFloor(scope: ExecutionIntentScope): Promise<ExecutionFloorState>
  resolveTarget(scope: ExecutionIntentScope, profile: ExecutionProfile, current: ExecutionSnapshot): ExecutionIdentity
  /** Read cached authenticated target evidence only. No native/provider probe, lease or install. */
  readTarget(scope: ExecutionIntentScope, execution: ExecutionIdentity): Promise<ExecutionTargetObservation>
  /** Synchronous cached authority at the actual floor CAS; no await or native/provider call. */
  currentTarget(scope: ExecutionIntentScope, execution: ExecutionIdentity): ExecutionTargetObservation
  withSourceFence<T>(scope: ExecutionIntentScope, expected: ExecutionSnapshot, use: (fence: ExecutionSourceFence) => Promise<T>): Promise<T>
  prepare(scope: ExecutionIntentScope, expected: ExecutionSnapshot, target: ExecutionIdentity, fence: ExecutionSourceFence): Promise<PreparedExecutionSelection>
  /** One authoritative floor-document CAS includes profile, binding, lineage AND stamp. Must recheck seal/fence/source bytes.
   * This is not an atomic transaction with the separate journal: the prepared WAL is synced first. */
  commitFloor(scope: ExecutionIntentScope, expected: ExecutionSnapshot, next: ExecutionSnapshot,
    prepared: PreparedExecutionSelection | null, stamp: ExecutionCommitStamp, fence: ExecutionSourceFence): Promise<void>
  start(request: ExecutionStartRequest): Promise<void>
  /** Trusted host registry/OS observation. Controller loss returns unknown, never ended.
   * not-started/ended require a fence proving no delayed start can still dispatch; momentary PID absence is insufficient. */
  observeRun(scope: ExecutionIntentScope, intent: OpenIntent): Promise<ExecutionRunObservation>
  broker: GuardedCodexBridgeBroker
  now?: () => number
  newId?: () => string
  maxReceipts?: number
  maxEndpointProofAgeMs?: number
}
interface Receipt {
  id: string; selectionIntentId: string; scope: ExecutionIntentScope; current: ExecutionSnapshot;
  target: ExecutionIdentity; evidenceDigest: string; expiresAtMs: number
}
const codeOf = (error: unknown, phase: 'capability' | 'selection' | 'open' | 'runtime') => publicExecutionFailure(error, phase).code
const stampEqual = (left: ExecutionCommitStamp | null, right: ExecutionCommitStamp) => left !== null
  && left.selectionIntentId === right.selectionIntentId && left.openIntentId === right.openIntentId
  && left.scopeDigest === right.scopeDigest && left.fingerprint === right.fingerprint

export class ExecutionCoordinator {
  private readonly ports: ExecutionCoordinatorPorts
  private readonly now: () => number
  private readonly newId: () => string
  private readonly receipts = new Map<string, Receipt>()
  private readonly active = new Set<string>()
  private readonly reconciliations = new Map<string, Promise<ExecutionIntentStatusReply>>()
  constructor(ports: ExecutionCoordinatorPorts) {
    this.ports = ports; this.now = ports.now ?? Date.now; this.newId = ports.newId ?? randomUUID
    if (!Number.isSafeInteger(ports.maxReceipts ?? 256) || (ports.maxReceipts ?? 256) < 1
      || !Number.isSafeInteger(ports.maxEndpointProofAgeMs ?? 86_400_000) || (ports.maxEndpointProofAgeMs ?? 86_400_000) < 1) throw executionHttpError('execution-invalid', 'capability')
  }
  private guard(scope: ExecutionIntentScope, signal?: AbortSignal, fence?: ExecutionSourceFence): void {
    requireIntentScope(scope)
    this.ports.assertAuthorized(scope)
    fence?.assertCurrent()
    if (!executionTime(this.now()) || signal?.aborted) throw executionHttpError('execution-intent-uncertain', 'authorization')
  }
  private async awaited<T>(scope: ExecutionIntentScope, action: () => Promise<T>, signal?: AbortSignal, fence?: ExecutionSourceFence): Promise<T> {
    this.guard(scope, signal, fence)
    const result = await action()
    this.guard(scope, signal, fence)
    return result
  }
  private executionGuard(scope: ExecutionIntentScope, binding: ExecutionSnapshot, signal?: AbortSignal): void {
    this.guard(scope, signal)
    this.ports.assertExecutionCurrent(scope, binding)
  }
  private async openAwaited<T>(record: OpenIntent, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.executionGuard(record.scope, record.binding, signal)
    const result = await action()
    this.executionGuard(record.scope, record.binding, signal)
    return result
  }
  private async reply<T>(phase: 'capability' | 'selection' | 'open' | 'status', intentId: string | undefined, action: () => Promise<T>): Promise<T> {
    try { return await action() } catch (error) {
      // No legacy 424 or arbitrary transport message may cross the profile-aware HTTP boundary.
      throw executionHttpError(publicExecutionFailure(error, phase).code, phase, intentId)
    }
  }
  private requestId(value: unknown, key: string): string | undefined {
    return contractRecord(value) && executionIntentId(value[key]) ? value[key] as string : undefined
  }
  capability(scope: ExecutionIntentScope, query: unknown): Promise<ExecutionCapabilityReply> {
    return this.reply('capability', undefined, () => this.capabilityOnce(scope, query))
  }
  select(scope: ExecutionIntentScope, request: unknown, signal?: AbortSignal): Promise<ExecutionSelectionReply> {
    return this.reply('selection', this.requestId(request, 'selectionIntentId'), () => this.selectOnce(scope, request, signal))
  }
  open(scope: ExecutionIntentScope, request: unknown, signal?: AbortSignal): Promise<ExecutionOpenReply> {
    return this.reply('open', this.requestId(request, 'openIntentId'), () => this.openOnce(scope, request, signal))
  }
  status(scope: ExecutionIntentScope, id: string): Promise<ExecutionIntentStatusReply> {
    return this.reply('status', id, () => {
      this.guard(scope)
      if (!executionIntentId(id)) throw executionHttpError('execution-invalid', 'status')
      const key = this.operationKey(scope, id), pending = this.reconciliations.get(key)
      if (pending) return pending
      const operation = this.statusOnce(scope, id).finally(() => this.reconciliations.delete(key))
      this.reconciliations.set(key, operation)
      return operation
    })
  }
  private async floor(scope: ExecutionIntentScope, signal?: AbortSignal, fence?: ExecutionSourceFence): Promise<ExecutionFloorState> {
    const state = await this.awaited(scope, () => this.ports.readFloor(scope), signal, fence)
    const binding = requireExecutionSnapshot(state.binding)
    if (binding.agentId !== scope.agentId || binding.homePc !== scope.targetPcId) throw executionHttpError('execution-stale', 'selection')
    return { binding, selection: state.selection }
  }
  private async target(scope: ExecutionIntentScope, execution: ExecutionIdentity, signal?: AbortSignal, fence?: ExecutionSourceFence): Promise<ExecutionTargetObservation> {
    const observation = await this.awaited(scope, () => this.ports.readTarget(scope, execution), signal, fence)
    return this.validateTarget(scope, execution, observation)
  }
  private validateTarget(scope: ExecutionIntentScope, execution: ExecutionIdentity, observation: ExecutionTargetObservation): ExecutionTargetObservation {
    const now = this.now()
    if (observation.targetPcId !== scope.targetPcId || !executionId(observation.linkGeneration)
      || !sameExecution(observation.execution, execution) || !executionTime(observation.observedAtMs)
      || !executionTime(observation.validUntilMs) || observation.observedAtMs > now || observation.validUntilMs <= now
      || observation.validUntilMs > observation.observedAtMs + CAPABILITY_TTL_MS || now - observation.observedAtMs > CAPABILITY_TTL_MS) throw executionHttpError('execution-capability-required', 'capability')
    if (execution.profile === CODEX_IN_CLAUDE_PROFILE) {
      const capability = requireBridgeCapability(observation.bridgeCapability, scope.targetPcId, observation.pins, now)
      if (now - Date.parse(capability.endpointProof.verifiedAt) > (this.ports.maxEndpointProofAgeMs ?? 86_400_000)) throw executionHttpError('execution-capability-required', 'capability')
    } else if (observation.nativeVerified !== true) throw executionHttpError('execution-capability-required', 'capability')
    return observation
  }
  private evidenceDigest(observation: ExecutionTargetObservation): string {
    return executionDigest({ targetPcId: observation.targetPcId, execution: observation.execution,
      linkGeneration: observation.linkGeneration, pins: observation.pins ?? null, capability: observation.bridgeCapability ?? null,
      nativeVerified: observation.nativeVerified })
  }
  private async capabilityOnce(scopeValue: ExecutionIntentScope, queryValue: unknown): Promise<ExecutionCapabilityReply> {
    const scope = requireIntentScope(scopeValue), query = requireExecutionCapabilityQuery(queryValue)
    this.guard(scope)
    const current = (await this.floor(scope)).binding
    const target = requireExecutionIdentity(this.ports.resolveTarget(scope, query.profile, current))
    if (target.profile !== query.profile) throw executionHttpError('execution-invalid', 'capability')
    try {
      const observation = await this.target(scope, target)
      this.guard(scope)
      const now = this.now()
      for (const [id, receipt] of this.receipts) if (receipt.expiresAtMs <= now) this.receipts.delete(id)
      if (this.receipts.size >= (this.ports.maxReceipts ?? 256)) throw executionHttpError('execution-ledger-full', 'capability')
      const id = this.newId(), selectionIntentId = this.newId()
      if (!executionIntentId(id) || !executionIntentId(selectionIntentId) || id === selectionIntentId || this.receipts.has(id)) throw executionHttpError('execution-intent-conflict', 'capability')
      const expiresAtMs = Math.min(now + CAPABILITY_TTL_MS, observation.validUntilMs)
      this.receipts.set(id, { id, selectionIntentId, scope, current, target, evidenceDigest: this.evidenceDigest(observation), expiresAtMs })
      return Object.freeze({ version: 1, current, target, targetPcId: scope.targetPcId, available: true,
        selectionIntentId, capabilityReceiptId: id, expiresAtMs,
        effectivePolicy: target.profile === CODEX_IN_CLAUDE_PROFILE ? verifiedBridgePolicy() : null })
    } catch (error) {
      this.guard(scope)
      return Object.freeze({ version: 1, current, target, targetPcId: scope.targetPcId, available: false, unavailableCode: codeOf(error, 'capability') })
    }
  }
  private selectionReply(record: SelectionIntent): ExecutionSelectionReply {
    if (record.state !== 'committed' || !record.plan) throw executionHttpError('execution-intent-uncertain', 'selection', record.id)
    return Object.freeze({ version: 1, selectionIntentId: record.id,
      state: record.request.expected.sessionId === record.plan.binding.sessionId && sameExecution(record.request.expected.execution, record.plan.binding.execution) ? 'unchanged' : 'committed',
      committed: record.plan.binding, openIntentId: record.plan.stamp.openIntentId })
  }
  private operationKey(scope: ExecutionIntentScope, id: string): string { return `${scopeDigest(scope)}:${id}` }
  private async selectOnce(scopeValue: ExecutionIntentScope, requestValue: unknown, signal?: AbortSignal): Promise<ExecutionSelectionReply> {
    const scope = requireIntentScope(scopeValue), request = requireExecutionSelectionRequest(requestValue)
    this.guard(scope, signal)
    if (request.expected.agentId !== scope.agentId || request.expected.homePc !== scope.targetPcId) throw executionHttpError('execution-stale', 'selection', request.selectionIntentId)
    const existing = this.ports.ledger.get(scope, request.selectionIntentId)
    if (existing) {
      if (existing.kind !== 'selection' || existing.fingerprint !== selectionFingerprint(scope, request)) throw executionHttpError('execution-intent-conflict', 'selection', request.selectionIntentId)
      // Recovery may observe a stamped commit; it never prepares or repeats a floor write.
      await this.status(scope, existing.id)
      return this.selectionReply(this.ports.ledger.get(scope, existing.id) as SelectionIntent)
    }
    const receipt = this.receipts.get(request.capabilityReceiptId)
    if (!receipt || receipt.expiresAtMs <= this.now() || scopeDigest(scope) !== scopeDigest(receipt.scope)
      || receipt.selectionIntentId !== request.selectionIntentId || !sameExecution(receipt.target, request.target)) throw executionHttpError('execution-intent-expired', 'selection', request.selectionIntentId)
    assertExecutionCAS(receipt.current, request.expected)
    assertExecutionCAS(request.expected, (await this.floor(scope, signal)).binding)
    if (this.evidenceDigest(await this.target(scope, request.target, signal)) !== receipt.evidenceDigest) throw executionHttpError('execution-capability-required', 'selection', request.selectionIntentId)
    // A superseded run can have a durable confirmed-end tombstone even though
    // its old floor binding no longer matches. Observe it before admission;
    // unknown/disconnected runs remain uncertain and still block reservation.
    for (const id of this.ports.ledger.uncertainOpenIds(scope)) await this.status(scope, id)
    const reservation = await this.awaited(scope, () => this.ports.ledger.reserveSelection(scope, request, receipt.expiresAtMs), signal)
    if (!reservation.created) return this.selectionReply(reservation.record)
    this.ports.progress?.(scope, 'checking', request.selectionIntentId)
    let record = reservation.record
    const operation = this.operationKey(scope, record.id)
    this.active.add(operation)
    try {
      return await this.awaited(scope, () => this.ports.withSourceFence(scope, request.expected, async fence => {
        this.guard(scope, signal, fence)
        assertExecutionCAS(request.expected, (await this.floor(scope, signal, fence)).binding)
        let next = request.expected, prepared: PreparedExecutionSelection | null = null
        if (!sameExecution(request.expected.execution, request.target) || request.rebuildHistory) {
          prepared = await this.awaited(scope, () => this.ports.prepare(scope, request.expected, request.target, fence), signal, fence)
          if (!executionId(prepared.sourceSealId)) throw executionHttpError('execution-lineage-invalid', 'selection')
          next = assertPreparedExecution(request.expected, prepared.lineage, scope.targetPcId, request.target).binding
        }
        if (this.evidenceDigest(await this.target(scope, request.target, signal, fence)) !== receipt.evidenceDigest || receipt.expiresAtMs <= this.now()) throw executionHttpError('execution-capability-required', 'selection')
        assertExecutionCAS(request.expected, (await this.floor(scope, signal, fence)).binding)
        // WAL includes the exact next binding/stamp and one planned open BEFORE authoritative floor CAS.
        record = await this.awaited(scope, () => this.ports.ledger.stageSelection(record, next, this.newId(), this.newId()), signal, fence)
        const plan = record.plan!
        const commitFence: ExecutionSourceFence = { assertCurrent: () => {
          this.guard(scope, signal, fence)
          if (receipt.expiresAtMs <= this.now()) throw executionHttpError('execution-capability-required', 'selection')
          const current = this.validateTarget(scope, request.target, this.ports.currentTarget(scope, request.target))
          if (this.evidenceDigest(current) !== receipt.evidenceDigest) throw executionHttpError('execution-capability-required', 'selection')
          if (receipt.expiresAtMs <= this.now()) throw executionHttpError('execution-capability-required', 'selection')
        } }
        this.ports.progress?.(scope, 'saving')
        await this.awaited(scope, () => this.ports.commitFloor(scope, request.expected, next, prepared, plan.stamp, commitFence), signal, commitFence)
        const authoritative = await this.floor(scope, signal, fence)
        assertExecutionCAS(next, authoritative.binding)
        if (!stampEqual(authoritative.selection, plan.stamp)) throw executionHttpError('execution-intent-uncertain', 'selection')
        record = await this.awaited(scope, () => this.ports.ledger.commitSelection(record), signal, fence)
        this.ports.progress?.(scope, 'complete')
        return this.selectionReply(record)
      }), signal)
    } catch (error) {
      this.ports.progress?.(scope, 'failed')
      const current = this.ports.ledger.get(scope, record.id)
      if (current?.kind === 'selection' && current.state !== 'committed' && current.state !== 'refused') {
        await this.ports.ledger.markUnavailable(current, 'uncertain', codeOf(error, 'selection'))
      }
      // Never invent a rollback after a possible floor commit or repeat a prepare/start.
      throw executionHttpError(codeOf(error, 'selection'), 'selection', request.selectionIntentId)
    } finally { this.active.delete(operation) }
  }
  private async assertOpenFloor(scope: ExecutionIntentScope, record: OpenIntent, signal?: AbortSignal): Promise<void> {
    const parent = this.ports.ledger.get(scope, record.selectionIntentId)
    if (parent?.kind !== 'selection' || parent.state !== 'committed' || !parent.plan || parent.plan.stamp.openIntentId !== record.id) throw executionHttpError('execution-intent-uncertain', 'open', record.id)
    const current = await this.floor(scope, signal)
    assertExecutionCAS(record.binding, current.binding)
    if (!stampEqual(current.selection, parent.plan.stamp)) throw executionHttpError('execution-stale', 'open', record.id)
  }
  private runtimeSummary(record: OpenIntent, observation: ExecutionRunObservation, target: ExecutionTargetObservation): ExecutionRuntimeSummary {
    if (observation.state !== 'running') throw executionHttpError('execution-runtime-mismatch', 'runtime', record.id)
    if (record.binding.execution.profile === CODEX_IN_CLAUDE_PROFILE) {
      if (!record.lease) throw executionHttpError('bridge-lease-invalid', 'runtime', record.id)
      requireBridgeRuntimeProof(observation.proof, record.lease, record.lease.request, target.bridgeCapability, target.pins, this.now())
    } else {
      const proof = observation.proof
      if (!contractRecord(proof) || proof.version !== 1 || proof.runId !== record.runId || proof.targetPcId !== record.scope.targetPcId
        || proof.verified !== true || !sameExecution(proof.execution, record.binding.execution)) throw executionHttpError('execution-runtime-mismatch', 'runtime', record.id)
      assertExecutionCAS(record.binding, proof.binding)
    }
    return executionRuntimeSummary(record.binding, record.runId, record.scope.targetPcId, this.now())
  }
  private async openOnce(scopeValue: ExecutionIntentScope, requestValue: unknown, signal?: AbortSignal): Promise<ExecutionOpenReply> {
    const scope = requireIntentScope(scopeValue), request = requireExecutionOpenRequest(requestValue)
    this.guard(scope, signal)
    let record = this.ports.ledger.get(scope, request.openIntentId)
    if (!record || record.kind !== 'open') throw executionHttpError('execution-intent-expired', 'open', request.openIntentId)
    assertExecutionCAS(request.expectedExecution, record.binding)
    if (record.dimensions && (record.dimensions.cols !== (request.cols ?? null) || record.dimensions.rows !== (request.rows ?? null))) throw executionHttpError('execution-intent-conflict', 'open', record.id)
    await this.assertOpenFloor(scope, record, signal)
    if (record.state !== 'ready') {
      const status = await this.status(scope, record.id)
      if (status.state !== 'running' || !status.actual) throw executionHttpError('execution-intent-uncertain', 'open', record.id)
      this.guard(scope, signal)
      await this.assertOpenFloor(scope, record, signal)
      return Object.freeze({ executionVersion: 1, openIntentId: record.id, state: 'already-running', committed: record.binding, actual: status.actual })
    }
    await this.target(scope, record.binding.execution, signal)
    const operation = this.operationKey(scope, record.id)
    if (this.active.has(operation)) throw executionHttpError('execution-intent-uncertain', 'open', record.id)
    this.active.add(operation)
    let claimed = false
    try {
      record = await this.awaited(scope, async () => {
        const result = await this.ports.ledger.claimOpen(record as OpenIntent, request.cols, request.rows)
        claimed = true; record = result
        return result
      }, signal)
      const owned = record as OpenIntent
      let startRequest: ExecutionStartRequest
      const startSignal = signal ?? new AbortController().signal
      const base: StartBase = { scope, openIntentId: owned.id, binding: owned.binding, runId: owned.runId, signal: startSignal,
        ...(request.cols === undefined ? {} : { cols: request.cols }), ...(request.rows === undefined ? {} : { rows: request.rows }) }
      if (owned.binding.execution.profile === CODEX_IN_CLAUDE_PROFILE) {
        const leaseRequest = { ownerId: scope.ownerId, runId: owned.runId, targetPcId: scope.targetPcId, binding: owned.binding }
        const lease = requireCodexBridgeLease(await this.openAwaited(owned, () => this.ports.broker.acquire(leaseRequest, signal), signal), leaseRequest)
        record = await this.openAwaited(owned, () => this.ports.ledger.recordLease(owned, lease), signal)
        startRequest = { ...base, kind: 'bridge', lease, dispatchProvider: (send, abort) => {
          this.executionGuard(scope, owned.binding, startSignal)
          const current = this.ports.ledger.get(scope, owned.id)
          if (!current || current.kind !== 'open' || !['starting', 'running'].includes(current.state)) throw executionHttpError('execution-intent-uncertain', 'authorization', owned.id)
          // Broker capture may itself wait: recheck this execution/actor at the final synchronous send boundary too.
          return this.ports.broker.dispatch(lease, (authorization, brokerSignal) => {
            this.executionGuard(scope, owned.binding, brokerSignal)
            const latest = this.ports.ledger.get(scope, owned.id)
            if (latest?.kind !== 'open' || !['starting', 'running'].includes(latest.state)) throw executionHttpError('execution-intent-uncertain', 'authorization', owned.id)
            // The independently authored adapter initiates HTTP synchronously inside send, with brokerSignal.
            return send(authorization, brokerSignal)
          }, abort ? AbortSignal.any([startSignal, abort]) : startSignal)
        } }
      } else startRequest = { ...base, kind: 'native' }
      await this.assertOpenFloor(scope, record as OpenIntent, signal)
      await this.target(scope, (record as OpenIntent).binding.execution, signal)
      this.ports.progress?.(scope, 'opening')
      await this.openAwaited(record as OpenIntent, () => this.ports.start(startRequest), signal)
      const observation = await this.openAwaited(record as OpenIntent, () => this.ports.observeRun(scope, record as OpenIntent), signal)
      await this.assertOpenFloor(scope, record as OpenIntent, signal)
      const target = await this.target(scope, (record as OpenIntent).binding.execution, signal)
      const actual = this.runtimeSummary(record as OpenIntent, observation, target)
      record = await this.openAwaited(record as OpenIntent, () => this.ports.ledger.markRunning(record as OpenIntent, actual), signal)
      this.ports.progress?.(scope, 'complete')
      this.executionGuard(scope, record.binding, signal)
      return Object.freeze({ executionVersion: 1, openIntentId: record.id, state: 'running', committed: (record as OpenIntent).binding, actual })
    } catch (error) {
      const current = this.ports.ledger.get(scope, request.openIntentId)
      if (claimed && current?.kind === 'open' && !['stopped', 'refused'].includes(current.state)) await this.ports.ledger.markUnavailable(current, 'uncertain', codeOf(error, 'open'))
      // Retain the run/lease on ambiguous failure. Lifecycle owner confirms end/adopts before sweep; no fallback/restart.
      throw executionHttpError(codeOf(error, 'open'), 'open', request.openIntentId)
    } finally { this.active.delete(operation) }
  }
  private statusReply(record: ExecutionIntent): ExecutionIntentStatusReply {
    if (record.kind === 'selection') return Object.freeze({ version: 1, intentId: record.id, kind: 'selection',
      state: record.state === 'committed' ? 'committed' : record.state === 'refused' ? 'refused' : record.state === 'uncertain' ? 'uncertain' : 'pending',
      ...(record.state === 'committed' && record.plan ? { committed: record.plan.binding, openIntentId: record.plan.stamp.openIntentId } : {}),
      ...(record.reason ? { reason: record.reason } : {}), canFallback: false })
    return Object.freeze({ version: 1, intentId: record.id, kind: 'open',
      state: record.state === 'ready' || record.state === 'starting' ? 'pending' : record.state,
      committed: record.binding, ...(record.state === 'running' && record.actual ? { actual: record.actual } : {}),
      ...(record.reason ? { reason: record.reason } : {}), canFallback: false })
  }
  /** GET recovery observes authoritative stamps/runtime only. It never calls prepare, floor commit, acquire or start. */
  private async statusOnce(scopeValue: ExecutionIntentScope, id: string): Promise<ExecutionIntentStatusReply> {
    const scope = requireIntentScope(scopeValue)
    this.guard(scope)
    if (!executionIntentId(id)) throw executionHttpError('execution-invalid', 'status')
    let record = this.ports.ledger.get(scope, id)
    if (!record) return Object.freeze({ version: 1, intentId: id, kind: 'unknown', state: 'unknown', canFallback: false })
    if (this.active.has(this.operationKey(scope, id))) return this.statusReply(record)
    if (record.kind === 'selection' && !record.plan && record.state === 'uncertain') {
      const current = await this.floor(scope)
      assertExecutionCAS(record.request.expected, current.binding)
      // Floor CAS is always preceded by a durable plan. A finished failed operation
      // with no such plan cannot have dispatched that CAS or an open. Do not prepare
      // again or clear any source fence; a fresh explicit selection must pass those guards.
      if (current.selection?.selectionIntentId === record.id) throw executionHttpError('execution-intent-uncertain', 'status', id)
      record = await this.awaited(scope, () => this.ports.ledger.markUnavailable(record!, 'refused', record!.reason ?? 'execution-intent-uncertain'))
    } else if (record.kind === 'selection' && record.plan && ['prepared', 'uncertain'].includes(record.state)) {
      const current = await this.floor(scope)
      if (stampEqual(current.selection, record.plan.stamp)) {
        assertExecutionCAS(record.plan.binding, current.binding)
        record = await this.awaited(scope, () => this.ports.ledger.commitSelection(record as SelectionIntent))
      } else if (record.state !== 'uncertain') record = await this.awaited(scope, () => this.ports.ledger.markUnavailable(record!, 'uncertain', 'execution-intent-uncertain'))
    } else if (record.kind === 'open' && ['starting', 'running', 'uncertain'].includes(record.state)) {
      try {
        const owned = record
        const observation = await this.awaited(scope, () => this.ports.observeRun(scope, owned))
        if ((observation.state === 'not-started' || observation.state === 'ended') && observation.dispatchFenced === true) {
          // End proof belongs to this exact run, independently of the later
          // selected conversation. It authorizes status only, never dispatch.
          record = await this.awaited(scope, () => this.ports.ledger.markUnavailable(owned, 'stopped', 'execution-intent-uncertain'))
        } else if (observation.state === 'running') {
          await this.assertOpenFloor(scope, owned)
          this.executionGuard(scope, owned.binding)
          const target = await this.target(scope, owned.binding.execution)
          const actual = this.runtimeSummary(owned, observation, target)
          record = await this.openAwaited(owned, () => this.ports.ledger.markRunning(owned, actual))
        } else {
          record = await this.awaited(scope, () => this.ports.ledger.markUnavailable(owned, 'uncertain', 'execution-intent-uncertain'))
        }
      } catch (error) {
        this.guard(scope)
        const current = this.ports.ledger.get(scope, id)
        if (current && current.revision !== record.revision) record = current
        else if (current?.kind === 'open' && !['stopped', 'refused'].includes(current.state)) record = await this.awaited(scope, () => this.ports.ledger.markUnavailable(current, 'uncertain', codeOf(error, 'runtime')))
      }
    }
    this.guard(scope)
    return this.statusReply(record)
  }
}
