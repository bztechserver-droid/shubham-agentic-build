import path from 'node:path'
import type { BridgeActualRuntimeProof } from './contract.ts'

export type RunState = 'starting' | 'running' | 'ended' | 'released'
const ORDER: Readonly<Record<RunState, number>> = Object.freeze({ starting: 0, running: 1, ended: 2, released: 3 })

/** A run record only moves forward. An observation that started before the run was retired and
 * resumes afterwards must not write it back to "ended": the run's private files are gone by then,
 * retirement can never finish, and every reopen of that chat is refused as "uncertain" (F-163, Lead 9 Nov). */
export function advanceRunState(record: { state: RunState }, next: RunState): boolean {
  if (!(next in ORDER) || !(record.state in ORDER) || ORDER[next] <= ORDER[record.state]) return false
  record.state = next
  return true
}

/** Re-read a shared record's state after an await. Another observation or the retirement job may have
 * moved it meanwhile; a plain comparison would let TypeScript assume the earlier narrowed value. */
export const stateNow = (record: { readonly state: RunState }): RunState => record.state

/** One run's exact private files, by construction: start() writes these names and retirement removes
 * the same names, so retirement never depends on a file it is itself about to delete. */
export function runArtifacts(directory: string, runId: string): { child: string; settings: string; ready: string } {
  return Object.freeze({ child: path.join(directory, `${runId}.child.json`), settings: path.join(directory, `${runId}.settings.json`),
    ready: path.join(directory, `${runId}.ready.json`) })
}

/** The run's own recorded processes (exact PID and creation time) and its loopback listener are all gone.
 * A reused PID with another creation time is a different process and does not keep the run alive. */
export function proofProcessesGone(proof: Pick<BridgeActualRuntimeProof, 'proxy' | 'claude'>,
  table: { rows: ReadonlyArray<{ pid: number; created: number }>; listener: boolean }): boolean {
  if (table.listener) return false
  return !table.rows.some(p => (p.pid === proof.proxy.pid && p.created === proof.proxy.createdAtMs)
    || (p.pid === proof.claude.pid && p.created === proof.claude.createdAtMs))
}
