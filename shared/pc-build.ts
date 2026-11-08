/** F154 v1 frozen UI/peer contract. No arbitrary URLs, credentials or general RPC. */
export const PC_BUILD_PROTOCOL = 1 as const
export const PC_BUILD_STREAM = 'pc-build-v1'
export const PC_BUILD_PREFIX = '/pc-control'
export type PcBuildErrorCode = 'admin-required' | 'hub-sign-in-required' | 'target-offline' | 'peer-unsupported' | 'invalid-request' | 'confirmation-required' | 'confirmation-expired' | 'confirmation-stale' | 'update-unavailable' | 'update-result-unknown' | 'target-error'
export interface PcBuildError { error: string; code: PcBuildErrorCode; hubOrigin?: string | null }
export interface PcBuildStatus {
  protocol: 1
  pcId: string
  connection: 'online' | 'offline' | 'unsupported'
  capability: 'pc-build-v1' | null
  runningVersion: string | null
  availableVersion: string | null
  updateState: 'unknown' | 'checking' | 'up-to-date' | 'available' | 'failed'
  canCheck: boolean
  canUpdate: boolean
  reason: string | null
  hostBusy: number
  waitingForIdle: boolean
  transition: 'idle' | 'waiting-for-idle' | 'restarting'
}
export interface PcBuildPrepare {
  protocol: 1
  pcId: string
  confirmationToken: string
  expiresAt: string
  expectedCurrent: string
  expectedAvailable: string
  status: PcBuildStatus
}
export interface PcBuildUpdateRequest {
  confirmed: true
  confirmationToken: string
  expectedCurrent: string
  expectedAvailable: string
}
export interface PcBuildUpdateResult {
  protocol: 1
  pcId: string
  outcome: 'restarting' | 'waiting-for-idle'
  status: PcBuildStatus
}
/** Only created by a HUB route after local cookie/session validation. Member payloads are not authority. */
export interface PcBuildActor { id: string; sid: string }
export type PcBuildAction = 'status' | 'check' | 'prepare-update' | 'update'
export interface PcBuildPeerRequest {
  protocol: 1
  targetId: string
  actor: PcBuildActor
  action: PcBuildAction
  update?: PcBuildUpdateRequest
}
export type PcBuildReply = PcBuildStatus | PcBuildPrepare | PcBuildUpdateResult
