import { isDeepStrictEqual } from 'node:util'
import { requireBridgeCapability, requireBridgeRuntimeProof, requireBridgePins,
  type BridgeRuntimePins, type CodexBridgeLease, type BridgeActualRuntimeProof } from './contract.ts'

// Build 1303: the child, its storage implementation and execution contract are unchanged.
// This permits a verified controller replacement, never an unproved child/profile change.
export const PREVIOUS_CONTROLLER_SHA256 = '65c0381cbb90319bbd8fecfa49b42fbbd73596feea1df8d49f4428b486a4017c'
/** History only: the controllers of earlier builds (child.ts 38bb4e51… up to build 2026.11.10-1102, 4bf487c8… in -1140).
 * None of them is adopted any more, since the child changed after them. */
export const RETIRED_CONTROLLERS = Object.freeze([PREVIOUS_CONTROLLER_SHA256,
  'abdbe052e541f14b7b73658fb182b99bf83ced17a4491dc2904296a165ddb63d',
  '7f45cdc5aba067dfe2350fdb690e4d2fb26c5db8adba940ea77b315a3697666d',
  '59774cb622bdf8a29aad1c59bc6b8cc33d47a1cef1efb22426e7d140a720f0d3',
  'a661c5bb658e7de2d7fccdc00780be21d3c37946674ec9780eebc3b95da8cee6',
  // Build 2026.11.09-2231 (F-163 v3).
  '41d17cb634956382c16fff7fc8f4e9ecce8562b11cc6d608431fed0c23a5a3ba',
  // Builds 2026.11.09-2300 and -2325 (F-163 v4/v5, same controller).
  '77c978567756402ecb0838cd6cb88e7fd48dc2e0b80b39de82bf3d2e7771e674',
  // Build 2026.11.10-0413 (the bridge's private Claude copy).
  '6d17a80a386f030d1bb85e5331c5ecb3875d8167142b61ea8e4cc7ef2eb41ef2',
  // Build 2026.11.10-1024 (F-166 v8, speed).
  '00e8c52fe82fbfa15e809d9bb0affcffbbea088f9dd1e74f58f4b2a2226b181c',
  // Build 2026.11.10-1102 (F-166 v9, cache).
  '518ef63f8d5c2882b94739c4bea9c417922023e0e084998586a7a8e0f24df697',
  // Build 2026.11.10-1140 (cancel-pause v10, child 4bf487c8…): superseded before its children were carried on.
  'ed6cc93b55462f22352a7789b4812a2739a390c0d3b61c32d1723cf3bf721c19',
  // Builds 2026.11.10-1210 / -1514 / -1653 (cancel-pause v13, child 63fe0f33…).
  '18f0332157312396c623951b125284bfd60af8143b87e00ea5a6b705c67d143d',
  // The tool-result image fix (child 63fe0f33…, adopted 1210's children).
  'ee5eb0e41c8ecda0011be7ca867b8c1e2cd0695d10ac44495ffad8aa9496b86f'])
/** The controllers whose running children the next build adopts: only builds whose children run exactly UNCHANGED_CHILD_FILES.
 * The pause-fix build (gateway cut self-recovers, child 40342aa5…): the unconfirmed-reply fix changes only the controller,
 * so its running bridge chats are carried on at the next Update instead of being stopped. */
export const PREVIOUS_CONTROLLERS: readonly string[] = Object.freeze([
  'c4cf384d9802ed654e8425e7c1f8e9c3ecfdbffb26a981fc3538d753311106e3'])
/** The exact child sources the adopted children run (checked against these files on disk at every start). */
export const UNCHANGED_CHILD_FILES = Object.freeze({
  'child.ts':'40342aa55e547065cf92e1e4c1acab060549d8388eab77c4aa9e7565152ec50e',
  'storage.ts':'b14908415eab7477a79bac9d6818bd2408686b83fc9f2f4e7ff46e3e0eae1835',
  '../../shared/chat-execution.ts':'b47a79cb321513dfad8482b98f242602bb92b886efee0b42b4b7b56fec6c51ef',
})
export function compatibleControllerUpgrade(previous: unknown, oldPins: BridgeRuntimePins, proof: BridgeActualRuntimeProof | undefined,
  lease: CodexBridgeLease, nextPins: BridgeRuntimePins, childHashes: Record<string,string>, now: number,
  controllers: readonly string[] = PREVIOUS_CONTROLLERS): boolean {
  try {
    if (!proof || !controllers.includes(oldPins.adapterSha256)
      || Object.entries(UNCHANGED_CHILD_FILES).some(([file,hash])=>childHashes[file]!==hash)) return false
    const next=requireBridgePins(nextPins)
    if (!isDeepStrictEqual({...oldPins,adapterSha256:next.adapterSha256},next)) return false
    const cap=requireBridgeCapability(previous,lease.request.targetPcId,oldPins,now)
    if (now-Date.parse(cap.endpointProof.verifiedAt)>86_400_000) return false
    requireBridgeRuntimeProof(proof,lease,lease.request,cap,oldPins,now)
    return true
  } catch { return false }
}
