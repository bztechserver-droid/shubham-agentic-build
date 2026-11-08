import { isDeepStrictEqual } from 'node:util'
import { executionHttpError } from '../../shared/chat-execution-http.ts'
import type { BridgeActualRuntimeProof, CodexBridgeLease } from './contract.ts'
import type { BridgeOwnerObservation } from '../codex/bridge-credentials.ts'

export interface HostEpoch { readonly generation: number; readonly hostPid: number; readonly hostStartedAt: number }
interface Admission { lease: CodexBridgeLease; proof: BridgeActualRuntimeProof; epoch: HostEpoch }
interface Retirement extends Admission { observation: BridgeOwnerObservation }
const mismatch = (): never => { throw executionHttpError('execution-runtime-mismatch', 'runtime') }
const copy = <T>(value: T): T => structuredClone(value)

/** Backend ownership receipts minted only after the caller's exact physical observation.
 * A bare PID, SID, configured slot or sticky lease-id flag never authorizes input/deletion. */
export class BridgeOwnership {
  private readonly admissions = new Map<string, Admission>()
  private readonly retirements = new Map<string, Retirement>()
  private closed = false
  private readonly current: () => HostEpoch
  constructor(current: () => HostEpoch) { this.current = current }
  capture(): HostEpoch {
    try {
      if (this.closed) return mismatch()
      const epoch = this.current()
      if (![epoch.generation, epoch.hostPid, epoch.hostStartedAt].every(value => Number.isSafeInteger(value) && value > 0)) return mismatch()
      return Object.freeze(copy(epoch))
    } catch { this.invalidate(); return mismatch() }
  }
  fence(epoch: HostEpoch): void {
    if (!isDeepStrictEqual(epoch, this.capture())) { this.invalidate(); return mismatch() }
  }
  private validate(lease: CodexBridgeLease, proof: BridgeActualRuntimeProof): void {
    if (lease.leaseId !== proof.leaseId || lease.request.runId !== proof.runId || lease.request.ownerId !== proof.ownerId
      || lease.request.targetPcId !== proof.targetPcId || !isDeepStrictEqual(lease.request.binding, proof.binding)
      || !isDeepStrictEqual(lease.request.binding.execution, proof.execution)) return mismatch()
  }
  admit(lease: CodexBridgeLease, proof: BridgeActualRuntimeProof, epoch: HostEpoch): void {
    this.fence(epoch); this.validate(lease, proof)
    const previous = this.admissions.get(lease.request.runId)
    if (previous && (!isDeepStrictEqual(previous.lease, lease) || !isDeepStrictEqual(previous.proof, proof))) {
      this.invalidate(lease.request.runId); return mismatch()
    }
    this.admissions.set(lease.request.runId, { lease: copy(lease), proof: copy(proof), epoch: copy(epoch) })
    this.retirements.delete(lease.leaseId)
  }
  assertRunning(lease: CodexBridgeLease, proof: BridgeActualRuntimeProof): void {
    const admitted = this.admissions.get(lease.request.runId)
    if (!admitted || !isDeepStrictEqual(admitted.lease, lease) || !isDeepStrictEqual(admitted.proof, proof)) return mismatch()
    this.fence(admitted.epoch)
  }
  ended(lease: CodexBridgeLease, proof: BridgeActualRuntimeProof, epoch: HostEpoch): BridgeOwnerObservation {
    this.fence(epoch); this.validate(lease, proof)
    const previous = this.retirements.get(lease.leaseId)
    if (previous && isDeepStrictEqual(previous.lease, lease) && isDeepStrictEqual(previous.proof, proof) && isDeepStrictEqual(previous.epoch, epoch)) return previous.observation
    const observation = Object.freeze({ state: 'ended' as const })
    this.admissions.delete(lease.request.runId)
    this.retirements.set(lease.leaseId, { lease: copy(lease), proof: copy(proof), epoch: copy(epoch), observation })
    return observation
  }
  retirement(lease: CodexBridgeLease, proof: BridgeActualRuntimeProof): BridgeOwnerObservation | null {
    const receipt = this.retirements.get(lease.leaseId)
    return receipt && this.canRetire(lease, proof, receipt.observation) ? receipt.observation : null
  }
  /** Called only for an owner-only durable record saved AFTER confirmed process end
   * and manager release. This is a stopped-status tombstone, never a new retirement
   * token or permission to run, dispatch, acquire, adopt or release anything. */
  released(lease: CodexBridgeLease, proof: BridgeActualRuntimeProof): BridgeOwnerObservation {
    this.validate(lease, proof)
    if (proof.version !== 1 || proof.policy?.model !== 'gpt-6.1-sol' || proof.policy.effort !== 'max' || proof.policy.allRequestPurposes !== true
      || ![proof.proxy?.pid, proof.proxy?.createdAtMs, proof.claude?.pid, proof.claude?.createdAtMs].every(value => Number.isSafeInteger(value) && value > 0)
      || proof.proxy.pid === proof.claude.pid) return mismatch()
    this.invalidate(lease.request.runId)
    return Object.freeze({ state: 'ended' as const })
  }
  canRetire(lease: CodexBridgeLease, proof: BridgeActualRuntimeProof, observed: BridgeOwnerObservation): boolean {
    try {
      const receipt = this.retirements.get(lease.leaseId)
      if (!receipt || observed !== receipt.observation || !isDeepStrictEqual(lease, receipt.lease) || !isDeepStrictEqual(proof, receipt.proof)) return false
      this.fence(receipt.epoch)
      return true
    } catch { return false }
  }
  invalidate(runId?: string): void {
    if (runId) {
      this.admissions.delete(runId)
      for (const [id, receipt] of this.retirements) if (receipt.lease.request.runId === runId) this.retirements.delete(id)
    } else { this.admissions.clear(); this.retirements.clear() }
  }
  close(): void { this.closed = true; this.invalidate() }
}

/** Retry retirement observation after drain; never retry native/provider work or discard a busy hold. */
export class BridgeRetirementWork {
  private readonly jobs = new Map<string, () => Promise<boolean>>()
  private readonly active = new Map<string, Promise<void>>()
  private closed = false
  add(runId: string, job: () => Promise<boolean>): void { if (!this.closed && !this.jobs.has(runId)) this.jobs.set(runId, job) }
  async reconcile(): Promise<void> {
    if (this.closed) return
    await Promise.all([...this.jobs].map(([id, job]) => {
      const pending = this.active.get(id)
      if (pending) return pending
      const operation = (async () => {
        try { if (await job()) this.jobs.delete(id) } catch { /* Keep the unique hold pending, including after a long provider drain. */ }
      })().finally(() => this.active.delete(id))
      this.active.set(id, operation)
      return operation
    }))
  }
  pending(runId: string): boolean { return this.jobs.has(runId) }
  close(): void { this.closed = true }
}
