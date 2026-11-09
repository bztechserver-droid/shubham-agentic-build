import { isDeepStrictEqual } from 'node:util'
import { requireBridgeCapability, requireBridgeRuntimeProof, requireBridgePins,
  type BridgeRuntimePins, type CodexBridgeLease, type BridgeActualRuntimeProof } from './contract.ts'

// Build 1303: the child, its storage implementation and execution contract are unchanged.
// This permits a verified controller replacement, never an unproved child/profile change.
export const PREVIOUS_CONTROLLER_SHA256 = '65c0381cbb90319bbd8fecfa49b42fbbd73596feea1df8d49f4428b486a4017c'
export const UNCHANGED_CHILD_FILES = Object.freeze({
  'child.ts':'38bb4e5139f9c00c865bb371207744d5cde70a1fcba31554a343b69fb3a94484',
  'storage.ts':'b14908415eab7477a79bac9d6818bd2408686b83fc9f2f4e7ff46e3e0eae1835',
  '../../shared/chat-execution.ts':'b47a79cb321513dfad8482b98f242602bb92b886efee0b42b4b7b56fec6c51ef',
})
export function compatibleControllerUpgrade(previous: unknown, oldPins: BridgeRuntimePins, proof: BridgeActualRuntimeProof | undefined,
  lease: CodexBridgeLease, nextPins: BridgeRuntimePins, childHashes: Record<string,string>, now: number): boolean {
  try {
    if (!proof || oldPins.adapterSha256 !== PREVIOUS_CONTROLLER_SHA256
      || Object.entries(UNCHANGED_CHILD_FILES).some(([file,hash])=>childHashes[file]!==hash)) return false
    const next=requireBridgePins(nextPins)
    if (!isDeepStrictEqual({...oldPins,adapterSha256:next.adapterSha256},next)) return false
    const cap=requireBridgeCapability(previous,lease.request.targetPcId,oldPins,now)
    if (now-Date.parse(cap.endpointProof.verifiedAt)>86_400_000) return false
    requireBridgeRuntimeProof(proof,lease,lease.request,cap,oldPins,now)
    return true
  } catch { return false }
}
