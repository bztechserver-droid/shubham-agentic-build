export type RuntimeEngine = 'claude' | 'codex' | 'opencode'
import { CODEX_IN_CLAUDE_PROFILE, contractRecord, normalizeExecution, requireExecutionIdentity,
  assertExecutionCAS, sameExecution, type ExecutionIdentity, type ExecutionSnapshot } from '../../shared/chat-execution.ts'
import { executionHttpError } from '../../shared/chat-execution-http.ts'

/** Explicit unknown/malformed profiles never inherit a default or become native Claude. */
export function executionIdentityOf(record: unknown, defaults: unknown = {}): ExecutionIdentity {
  if (!contractRecord(record)) throw executionHttpError('execution-invalid', 'runtime')
  if (Object.hasOwn(record, 'executionProfile') && (typeof record.executionProfile !== 'string'
    || !['claude', 'codex', 'opencode'].includes(String(record.engine)))) throw executionHttpError('execution-invalid', 'runtime')
  if (Object.hasOwn(record, 'executionRevision') && (typeof record.executionRevision !== 'number'
    || !Number.isSafeInteger(record.executionRevision) || record.executionRevision < 0)) throw executionHttpError('execution-invalid', 'runtime')
  return normalizeExecution(record, defaults)
}

/** All existing engine-only runtime paths must cross this gate before any side effect or legacy-Claude exception. */
export function requireLegacyExecution(record: unknown, defaults: unknown = {}): RuntimeEngine {
  const execution = executionIdentityOf(record, defaults)
  if (execution.profile === CODEX_IN_CLAUDE_PROFILE) throw executionHttpError('execution-capability-required', 'runtime')
  return execution.engine
}

/** Full proof for later profile-aware host wiring; engine-only native replies cannot satisfy it. */
export function requireRunningExecution(expected: ExecutionSnapshot, actual: unknown): void {
  if (!contractRecord(actual) || actual.version !== 1 || !sameExecution(expected.execution, requireExecutionIdentity(actual.execution))) throw executionHttpError('execution-runtime-mismatch', 'runtime')
  assertExecutionCAS(expected, actual.binding)
}

export function engineMismatch(expected: RuntimeEngine, actual: string | undefined) {
  return Object.assign(new Error(`This conversation is saved as ${expected}, but its running process is ${actual ?? 'unverified'}. Nothing was restarted or rebound. Preserve its current native history and reconcile the engine before opening it.`),
    { status: 409, code: 'engine-runtime-mismatch', expectedEngine: expected, runningEngine: actual ?? null })
}

export function requireRunningEngine(expected: RuntimeEngine, actual: RuntimeEngine | undefined): void {
  if (actual !== expected) throw engineMismatch(expected, actual)
}

export function engineUpdateRequired(pc: string) {
  return Object.assign(new Error(`Update the Agentic app on ${pc}: its installed version has not proved support for the requested engine. Installing the CLI alone is insufficient. No fallback engine was requested.`),
    { status: 409, code: 'engine-start-update-required' })
}

