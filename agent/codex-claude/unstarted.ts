import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { HostChat } from '../chathost/protocol.ts'
import type { BridgeOwnerObservation } from '../codex/bridge-credentials.ts'
import type { CodexBridgeLease } from './contract.ts'
import type { HostEpoch } from './ownership.ts'

export interface UnstartedProcess { pid: number; command: string | null }
export interface UnstartedBridgeEnd {
  version: 1; lease: CodexBridgeLease; hostPid: number; hostStartedAt: number; startedAt: number; endedAt: number;
}
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0
export function validUnstartedEnd(end: UnstartedBridgeEnd, lease: CodexBridgeLease): boolean {
  return !!end && end.version === 1 && isDeepStrictEqual(end.lease, lease)
    && [end.hostPid,end.hostStartedAt,end.startedAt,end.endedAt].every(positive)
    && end.startedAt >= end.hostStartedAt && end.endedAt >= end.startedAt
}
/** Positive exit from the authenticated host AND a complete fresh process scan.
 * A missing PID, absent ready file, timeout, or a disconnected host never proves end. */
export function confirmedUnstartedEnd(lease: CodexBridgeLease, epoch: HostEpoch, chat: HostChat | undefined,
  rows: readonly UnstartedProcess[], configFile: string, previous?: UnstartedBridgeEnd): UnstartedBridgeEnd | null {
  let end = previous
  if (end && (!validUnstartedEnd(end,lease) || end.hostPid !== epoch.hostPid || end.hostStartedAt !== epoch.hostStartedAt)) return null
  if (!end) {
    if (!chat || chat.id !== lease.request.binding.sessionId || !chat.exited
      || chat.meta.bridgeRunId !== lease.request.runId || chat.meta.agentId !== lease.request.binding.agentId
      || chat.meta.engine !== 'claude' || !isDeepStrictEqual(chat.meta.execution,lease.request.binding)) return null
    const startedAt = Date.parse(String(chat.meta.startedAt))
    if (!positive(startedAt) || !positive(chat.startedAt) || Math.abs(startedAt-chat.startedAt)>10000) return null
    end = { version:1, lease:structuredClone(lease), hostPid:epoch.hostPid, hostStartedAt:epoch.hostStartedAt,
      startedAt, endedAt:chat.exited.at }
    if (!validUnstartedEnd(end,lease)) return null
  } else if (chat && (!chat.exited || chat.meta.bridgeRunId !== lease.request.runId
    || !isDeepStrictEqual(chat.meta.execution,lease.request.binding))) return null
  const markers = [lease.request.runId,lease.request.binding.sessionId!,path.basename(configFile)].map(value=>value.toLowerCase())
  if (rows.some(row=>!positive(row.pid) || typeof row.command !== 'string' || markers.some(marker=>row.command!.toLowerCase().includes(marker))
    || !!chat?.pid && row.pid===chat.pid)) return null
  return end
}

/** Retirement-only receipts; never an actual-runtime proof or permission to dispatch. */
export class UnstartedBridgeRetirements {
  private receipts = new Map<string,{end:UnstartedBridgeEnd;epoch:HostEpoch;observation:BridgeOwnerObservation}>()
  private readonly fence:(epoch:HostEpoch)=>void
  constructor(fence:(epoch:HostEpoch)=>void) {this.fence=fence}
  ended(end:UnstartedBridgeEnd, epoch:HostEpoch): BridgeOwnerObservation {
    this.fence(epoch)
    if (!validUnstartedEnd(end,end.lease) || end.hostPid!==epoch.hostPid || end.hostStartedAt!==epoch.hostStartedAt) throw Error('Unconfirmed managed start end')
    const previous=this.receipts.get(end.lease.leaseId)
    if(previous&&isDeepStrictEqual(previous.end,end)&&isDeepStrictEqual(previous.epoch,epoch))return previous.observation
    const observation=Object.freeze({state:'ended' as const})
    this.receipts.set(end.lease.leaseId,{end:structuredClone(end),epoch:structuredClone(epoch),observation})
    return observation
  }
  canRetire(lease:CodexBridgeLease,end:UnstartedBridgeEnd|undefined,observation:BridgeOwnerObservation):boolean {
    try {
      const receipt=this.receipts.get(lease.leaseId)
      if(!receipt||!end||!isDeepStrictEqual(receipt.end,end)||!validUnstartedEnd(end,lease)||receipt.observation!==observation)return false
      this.fence(receipt.epoch);return true
    }catch{return false}
  }
  invalidate(leaseId?:string):void {if(leaseId)this.receipts.delete(leaseId);else this.receipts.clear()}
}
