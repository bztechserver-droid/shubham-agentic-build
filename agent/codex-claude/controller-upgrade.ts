import { isDeepStrictEqual } from 'node:util'
import { requireBridgeCapability, requireBridgeRuntimeProof, requireBridgePins,
  type BridgeRuntimePins, type CodexBridgeLease, type BridgeActualRuntimeProof } from './contract.ts'

// Build 1303: the child, its storage implementation and execution contract are unchanged.
// This permits a verified controller replacement, never an unproved child/profile change.
export const PREVIOUS_CONTROLLER_SHA256 = '65c0381cbb90319bbd8fecfa49b42fbbd73596feea1df8d49f4428b486a4017c'
export const PREVIOUS_CONTROLLERS = Object.freeze([PREVIOUS_CONTROLLER_SHA256,
  'abdbe052e541f14b7b73658fb182b99bf83ced17a4491dc2904296a165ddb63d',
  '7f45cdc5aba067dfe2350fdb690e4d2fb26c5db8adba940ea77b315a3697666d',
  '59774cb622bdf8a29aad1c59bc6b8cc33d47a1cef1efb22426e7d140a720f0d3',
  'a661c5bb658e7de2d7fccdc00780be21d3c37946674ec9780eebc3b95da8cee6',
  // Build 2026.11.09-2231 (F-163 v3): its running children are adopted by the next build, never cut off.
  '41d17cb634956382c16fff7fc8f4e9ecce8562b11cc6d608431fed0c23a5a3ba',
  // Builds 2026.11.09-2300 and -2325 (F-163 v4/v5, same controller).
  '77c978567756402ecb0838cd6cb88e7fd48dc2e0b80b39de82bf3d2e7771e674',
  // Build 2026.11.10-0413 (the bridge's private Claude copy): its running children are adopted by the next build.
  '6d17a80a386f030d1bb85e5331c5ecb3875d8167142b61ea8e4cc7ef2eb41ef2'])
export const UNCHANGED_CHILD_FILES = Object.freeze({
  'child.ts':'38bb4e5139f9c00c865bb371207744d5cde70a1fcba31554a343b69fb3a94484',
  'storage.ts':'b14908415eab7477a79bac9d6818bd2408686b83fc9f2f4e7ff46e3e0eae1835',
  '../../shared/chat-execution.ts':'b47a79cb321513dfad8482b98f242602bb92b886efee0b42b4b7b56fec6c51ef',
})
export function compatibleControllerUpgrade(previous: unknown, oldPins: BridgeRuntimePins, proof: BridgeActualRuntimeProof | undefined,
  lease: CodexBridgeLease, nextPins: BridgeRuntimePins, childHashes: Record<string,string>, now: number): boolean {
  try {
    if (!proof || !PREVIOUS_CONTROLLERS.includes(oldPins.adapterSha256)
      || Object.entries(UNCHANGED_CHILD_FILES).some(([file,hash])=>childHashes[file]!==hash)) return false
    const next=requireBridgePins(nextPins)
    if (!isDeepStrictEqual({...oldPins,adapterSha256:next.adapterSha256},next)) return false
    const cap=requireBridgeCapability(previous,lease.request.targetPcId,oldPins,now)
    if (now-Date.parse(cap.endpointProof.verifiedAt)>86_400_000) return false
    requireBridgeRuntimeProof(proof,lease,lease.request,cap,oldPins,now)
    return true
  } catch { return false }
}
