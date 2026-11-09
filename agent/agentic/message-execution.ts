import { assertExecutionCAS, requireExecutionSnapshot, snapshotAgentExecution, type ExecutionSnapshot } from '../../shared/chat-execution.ts'
import { executionHttpError } from '../../shared/chat-execution-http.ts'
import { executionIdentityOf, requireLegacyExecution } from './runtime-engine.ts'

/** Message delivery can use a proved LOCAL bridge, never an engine-only legacy exception.
 * ACL, draft/menu checks and the receipt/generation transaction remain with the caller. */
export function requireMessageExecution(record: unknown, defaults: unknown, target: {
  selfPcId: string; targetPcId: string; confirmed: boolean; runtimeBinding: unknown; runId: unknown;
  admitted(expected: ExecutionSnapshot, runId: string): boolean
}): void {
  const execution=executionIdentityOf(record,defaults)
  if(execution.profile!=='codex-in-claude-v1'){requireLegacyExecution(record,defaults);return}
  const expected=snapshotAgentExecution(record,defaults)
  if(!target.confirmed||!target.selfPcId||target.targetPcId!==target.selfPcId||expected.homePc!==target.selfPcId
    ||!expected.sessionId||typeof target.runId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(target.runId))throw executionHttpError('execution-capability-required','runtime')
  const actual=requireExecutionSnapshot(target.runtimeBinding)
  assertExecutionCAS(expected,actual)
  if(!target.admitted(expected,target.runId))throw executionHttpError('execution-runtime-mismatch','runtime')
}
