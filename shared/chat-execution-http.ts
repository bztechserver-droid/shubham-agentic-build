// Private HTTP contract candidate. This module intentionally imports no backend credential/runtime types.
import { BRIDGE_EFFORT, BRIDGE_MODEL, CODEX_IN_CLAUDE_PROFILE, contractRecord,
  requireExecutionIdentity, requireExecutionSnapshot, type ExecutionIdentity,
  type ExecutionProfile, type ExecutionSnapshot } from './chat-execution.ts'

export const EXECUTION_HTTP_VERSION = 1 as const
export const CAPABILITY_TTL_MS = 30_000
export const EXECUTION_ERROR_CODES = ['execution-invalid', 'execution-stale', 'execution-lineage-invalid',
  'execution-capability-required', 'execution-runtime-mismatch', 'execution-target-offline',
  'execution-intent-conflict', 'execution-intent-uncertain', 'execution-intent-expired',
  'execution-ledger-full', 'execution-forbidden', 'bridge-policy-refused', 'bridge-lease-invalid',
  'bridge-authorization-unavailable', 'bridge-refresh-required'] as const
export type ExecutionHttpCode = typeof EXECUTION_ERROR_CODES[number]
export type ExecutionPhase = 'capability' | 'selection' | 'open' | 'authorization' | 'runtime' | 'status'
export interface ExecutionHttpFailure {
  readonly version: 1
  readonly code: ExecutionHttpCode
  readonly phase: ExecutionPhase
  readonly canFallback: false
  readonly intentId?: string
  readonly message: string
}
const messages: Record<ExecutionHttpCode, string> = {
  'execution-invalid': 'The execution request is invalid.',
  'execution-stale': 'The confirmed execution changed. Review it again.',
  'execution-lineage-invalid': 'The prepared conversation does not match the requested execution.',
  'execution-capability-required': 'The target has not proved this execution capability.',
  'execution-runtime-mismatch': 'The running process has not proved the requested execution.',
  'execution-target-offline': 'The saved home PC is unavailable.',
  'execution-intent-conflict': 'This operation ID belongs to a different request.',
  'execution-intent-uncertain': 'The operation outcome is uncertain. Observe this same operation.',
  'execution-intent-expired': 'The operation or capability has expired. Review the current execution.',
  'execution-ledger-full': 'Execution operations are at their safe storage limit.',
  'execution-forbidden': 'This execution operation is unavailable to the current actor.',
  'bridge-policy-refused': 'Every bridge request requires Sol and explicit max effort.',
  'bridge-lease-invalid': 'The credential lease does not belong to this execution.',
  'bridge-authorization-unavailable': 'Current manager authorization is unavailable.',
  'bridge-refresh-required': 'The existing native credential owner must settle a valid login first.',
}
export const executionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
export const executionIntentId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
export const executionTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const only = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  contractRecord(value) && Object.keys(value).every(key => keys.includes(key))

export function executionHttpError(code: ExecutionHttpCode, phase: ExecutionPhase, intentId?: string): Error & {
  status: 409; code: ExecutionHttpCode; body: ExecutionHttpFailure
} {
  const body: ExecutionHttpFailure = Object.freeze({ version: 1, code, phase, canFallback: false,
    ...(executionIntentId(intentId) ? { intentId } : {}), message: messages[code] })
  return Object.assign(new Error(body.message), { status: 409 as const, code, body })
}

/** Whitelist failures; never return arbitrary upstream messages, fields or causes. */
export function publicExecutionFailure(error: unknown, phase: ExecutionPhase, intentId?: string): ExecutionHttpFailure {
  const code = contractRecord(error) || error instanceof Error ? (error as { code?: unknown }).code : undefined
  const known = typeof code === 'string' && (EXECUTION_ERROR_CODES as readonly string[]).includes(code)
  return executionHttpError(known ? code as ExecutionHttpCode : 'execution-intent-uncertain', phase, intentId).body
}
const invalid = (phase: ExecutionPhase): never => { throw executionHttpError('execution-invalid', phase) }

/** Reject extra wire fields, including accidental backend proof or fallback/credential arguments. */
export function requireHttpExecutionIdentity(value: unknown): ExecutionIdentity {
  if (!only(value, ['profile', 'engine', 'provider', 'harness', 'transcript'])) return invalid('selection')
  try { return requireExecutionIdentity(value) } catch { return invalid('selection') }
}
export function requireHttpExecutionSnapshot(value: unknown): ExecutionSnapshot {
  if (!only(value, ['agentId', 'sessionId', 'codexThread', 'opencodeSession', 'homePc', 'executionRevision', 'execution'])) return invalid('selection')
  requireHttpExecutionIdentity(value.execution)
  try { return requireExecutionSnapshot(value) } catch { return invalid('selection') }
}

export interface ExecutionCapabilityQuery { readonly profile: ExecutionProfile }
export function requireExecutionCapabilityQuery(value: unknown): ExecutionCapabilityQuery {
  if (!only(value, ['profile']) || !['claude-native-v1', 'codex-native-v1', 'opencode-native-v1', CODEX_IN_CLAUDE_PROFILE].includes(value.profile as string)) return invalid('capability')
  return Object.freeze({ profile: value.profile as ExecutionProfile })
}
export interface ExecutionSelectionRequest {
  readonly version: 1
  readonly selectionIntentId: string
  readonly expected: ExecutionSnapshot
  readonly target: ExecutionIdentity
  readonly capabilityReceiptId: string
  readonly confirmCarryOver: true
  readonly rebuildHistory?: true
}
export function requireExecutionSelectionRequest(value: unknown): ExecutionSelectionRequest {
  if (!only(value, ['version', 'selectionIntentId', 'expected', 'target', 'capabilityReceiptId', 'confirmCarryOver', 'rebuildHistory'])
    || value.version !== 1 || !executionIntentId(value.selectionIntentId) || !executionIntentId(value.capabilityReceiptId)
    || value.confirmCarryOver !== true || value.rebuildHistory !== undefined && value.rebuildHistory !== true) return invalid('selection')
  return Object.freeze({ version: 1, selectionIntentId: value.selectionIntentId, expected: requireHttpExecutionSnapshot(value.expected),
    target: requireHttpExecutionIdentity(value.target), capabilityReceiptId: value.capabilityReceiptId, confirmCarryOver: true,
    ...(value.rebuildHistory===true?{rebuildHistory:true as const}:{}) })
}
export interface ExecutionOpenRequest {
  readonly executionVersion: 1
  readonly openIntentId: string
  readonly expectedExecution: ExecutionSnapshot
  readonly cols?: number
  readonly rows?: number
}
export function requireExecutionOpenRequest(value: unknown): ExecutionOpenRequest {
  if (!only(value, ['executionVersion', 'openIntentId', 'expectedExecution', 'cols', 'rows'])
    || value.executionVersion !== 1 || !executionIntentId(value.openIntentId)) return invalid('open')
  for (const key of ['cols', 'rows']) {
    if (Object.hasOwn(value, key) && (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || (value[key] as number) < 1 || (value[key] as number) > 1000)) return invalid('open')
  }
  return Object.freeze({ executionVersion: 1, openIntentId: value.openIntentId, expectedExecution: requireHttpExecutionSnapshot(value.expectedExecution),
    ...(typeof value.cols === 'number' ? { cols: value.cols } : {}), ...(typeof value.rows === 'number' ? { rows: value.rows } : {}) })
}

export interface VerifiedBridgePolicy {
  readonly model: typeof BRIDGE_MODEL
  readonly effort: typeof BRIDGE_EFFORT
  readonly allRequestPurposes: true
}
export function verifiedBridgePolicy(): VerifiedBridgePolicy {
  return Object.freeze({ model: BRIDGE_MODEL, effort: BRIDGE_EFFORT, allRequestPurposes: true })
}
export type ExecutionCapabilityReply = Readonly<{
  version: 1; current: ExecutionSnapshot; target: ExecutionIdentity; targetPcId: string;
} & ({ available: true; selectionIntentId: string; capabilityReceiptId: string; expiresAtMs: number; effectivePolicy: VerifiedBridgePolicy | null }
  | { available: false; unavailableCode: ExecutionHttpCode })>
export interface ExecutionSelectionReply {
  readonly version: 1
  readonly selectionIntentId: string
  readonly state: 'committed' | 'unchanged'
  readonly committed: ExecutionSnapshot
  readonly openIntentId: string
}

/** The only runtime shape permitted on HTTP. No lease, PID, listener, settings, owner or pin details. */
export interface ExecutionRuntimeSummary {
  readonly version: 1
  readonly runId: string
  readonly binding: ExecutionSnapshot
  readonly targetPcId: string
  readonly verifiedAtMs: number
  readonly verifiedPolicy: VerifiedBridgePolicy | null
}
export function executionRuntimeSummary(binding: unknown, runId: string, targetPcId: string, verifiedAtMs: number): ExecutionRuntimeSummary {
  const snapshot = requireHttpExecutionSnapshot(binding)
  if (!executionIntentId(runId) || !executionId(targetPcId) || snapshot.homePc !== targetPcId || !snapshot.sessionId || !executionTime(verifiedAtMs)) return invalid('runtime')
  return Object.freeze({ version: 1, runId, binding: snapshot, targetPcId, verifiedAtMs,
    verifiedPolicy: snapshot.execution.profile === CODEX_IN_CLAUDE_PROFILE ? verifiedBridgePolicy() : null })
}
export interface ExecutionOpenReply {
  readonly executionVersion: 1
  readonly openIntentId: string
  readonly state: 'running' | 'already-running'
  readonly committed: ExecutionSnapshot
  readonly actual: ExecutionRuntimeSummary
}
export type ExecutionIntentState = 'pending' | 'committed' | 'running' | 'stopped' | 'refused' | 'uncertain' | 'unknown'
export interface ExecutionIntentStatusReply {
  readonly version: 1
  readonly intentId: string
  readonly kind: 'selection' | 'open' | 'unknown'
  readonly state: ExecutionIntentState
  readonly committed?: ExecutionSnapshot
  readonly openIntentId?: string
  readonly actual?: ExecutionRuntimeSummary
  readonly reason?: ExecutionHttpCode
  readonly canFallback: false
}
