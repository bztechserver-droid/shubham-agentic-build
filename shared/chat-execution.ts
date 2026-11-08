// Private contract candidate. Independent app code; no upstream proxy implementation.
// Existing engine values continue to identify the native CLI and transcript reader.
export const EXECUTION_CONTRACT_VERSION = 1 as const
export const CODEX_IN_CLAUDE_PROFILE = 'codex-in-claude-v1' as const
export const CODEX_IN_CLAUDE_MENU = 'Open Codex in Claude Code' as const
export const BRIDGE_MODEL = 'gpt-6.1-sol' as const
export const BRIDGE_EFFORT = 'max' as const

export type NativeEngine = 'claude' | 'codex' | 'opencode'
export type ExecutionProfile = 'claude-native-v1' | 'codex-native-v1' | 'opencode-native-v1' | typeof CODEX_IN_CLAUDE_PROFILE
export type ExecutionIdentity = Readonly<
  | { profile: 'claude-native-v1'; engine: 'claude'; provider: 'anthropic'; harness: 'claude-code'; transcript: 'claude-jsonl' }
  | { profile: 'codex-native-v1'; engine: 'codex'; provider: 'codex'; harness: 'codex-cli'; transcript: 'codex-rollout' }
  | { profile: 'opencode-native-v1'; engine: 'opencode'; provider: 'openai' | 'anthropic' | 'opencode'; harness: 'opencode'; transcript: 'opencode-native' }
  | { profile: typeof CODEX_IN_CLAUDE_PROFILE; engine: 'claude'; provider: 'codex'; harness: 'claude-code'; transcript: 'claude-jsonl' }
>
export type BridgeExecutionIdentity = Extract<ExecutionIdentity, { profile: typeof CODEX_IN_CLAUDE_PROFILE }>
export type ExecutionErrorCode = 'execution-invalid' | 'execution-stale' | 'execution-lineage-invalid'
  | 'execution-capability-required' | 'execution-runtime-mismatch' | 'bridge-policy-refused' | 'bridge-lease-invalid'

/** Never interpolate rejected values: callers may have supplied credentials or other private data. */
export function executionError(code: ExecutionErrorCode, message: string): Error & { code: ExecutionErrorCode; status: 409 } {
  return Object.assign(new Error(message), { code, status: 409 as const })
}

const invalid = (): never => { throw executionError('execution-invalid', 'The execution identity or native binding is invalid.') }
export const contractRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
const has = (r: Record<string, unknown>, key: string) => Object.hasOwn(r, key)
const engines: readonly string[] = ['claude', 'codex', 'opencode']
const profiles: readonly string[] = ['claude-native-v1', 'codex-native-v1', 'opencode-native-v1', CODEX_IN_CLAUDE_PROFILE]
const providers: readonly string[] = ['openai', 'anthropic', 'opencode']
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
const nullableId = (v: unknown): string | null => v === undefined || v === null ? null : id(v) ? v : invalid()
const revision = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : invalid()
const chosenEngine = (value: unknown): NativeEngine | undefined => {
  if (value === undefined || value === '') return undefined
  return typeof value === 'string' && engines.includes(value) ? value as NativeEngine : invalid()
}
const chosenOpenCodeProvider = (value: unknown): 'openai' | 'anthropic' | 'opencode' | undefined => {
  if (value === undefined || value === '') return undefined
  return typeof value === 'string' && providers.includes(value) ? value as 'openai' | 'anthropic' | 'opencode' : invalid()
}

/** Compute identity without rewriting a legacy record or its native session identifiers. */
export function normalizeExecution(record: unknown, defaults: unknown = {}): ExecutionIdentity {
  if (!contractRecord(record) || !contractRecord(defaults)) return invalid()
  const engine = chosenEngine(record.engine) ?? chosenEngine(defaults.engine) ?? 'claude'
  // Validate explicit defaults even when an agent overrides them; an unknown value is never a fallback.
  chosenEngine(defaults.engine)
  const openCodeProvider = chosenOpenCodeProvider(record.opencodeProvider) ?? chosenOpenCodeProvider(defaults.opencodeProvider) ?? 'openai'
  chosenOpenCodeProvider(defaults.opencodeProvider)
  const rawProfile = record.executionProfile
  if (rawProfile !== undefined && rawProfile !== null && (typeof rawProfile !== 'string' || !profiles.includes(rawProfile))) return invalid()
  const profile = rawProfile ?? (engine === 'claude' ? 'claude-native-v1' : engine === 'codex' ? 'codex-native-v1' : 'opencode-native-v1')
  let execution: ExecutionIdentity
  if (profile === CODEX_IN_CLAUDE_PROFILE) {
    if (engine !== 'claude' || record.engine !== 'claude') return invalid()
    execution = { profile, engine: 'claude', provider: 'codex', harness: 'claude-code', transcript: 'claude-jsonl' }
  } else if (profile === 'claude-native-v1' && engine === 'claude') {
    execution = { profile, engine, provider: 'anthropic', harness: 'claude-code', transcript: 'claude-jsonl' }
  } else if (profile === 'codex-native-v1' && engine === 'codex') {
    execution = { profile, engine, provider: 'codex', harness: 'codex-cli', transcript: 'codex-rollout' }
  } else if (profile === 'opencode-native-v1' && engine === 'opencode') {
    execution = { profile, engine, provider: openCodeProvider, harness: 'opencode', transcript: 'opencode-native' }
  } else return invalid()
  for (const key of ['provider', 'harness', 'transcript'] as const) {
    if (has(record, key) && record[key] !== execution[key]) return invalid()
  }
  return Object.freeze(execution)
}

/** Capability, CAS and runtime messages need the complete identity; no legacy inference here. */
export function requireExecutionIdentity(value: unknown): ExecutionIdentity {
  if (!contractRecord(value) || ['profile', 'engine', 'provider', 'harness', 'transcript'].some(k => !has(value, k))
    || typeof value.profile !== 'string' || !profiles.includes(value.profile)
    || typeof value.engine !== 'string' || !engines.includes(value.engine)) return invalid()
  return normalizeExecution({ engine: value.engine, executionProfile: value.profile, provider: value.provider,
    harness: value.harness, transcript: value.transcript, opencodeProvider: value.engine === 'opencode' ? value.provider : undefined })
}

export function sameExecution(a: unknown, b: unknown): boolean {
  const left = requireExecutionIdentity(a), right = requireExecutionIdentity(b)
  return left.profile === right.profile && left.engine === right.engine && left.provider === right.provider
    && left.harness === right.harness && left.transcript === right.transcript
}

export interface ExecutionSnapshot {
  readonly agentId: string
  readonly sessionId: string | null
  readonly codexThread: string | null
  readonly opencodeSession: string | null
  readonly homePc: string | null
  readonly executionRevision: number
  readonly execution: ExecutionIdentity
}

function binding(record: Record<string, unknown>, execution: ExecutionIdentity): ExecutionSnapshot {
  const agentId = record.agentId ?? record.id
  if (!id(agentId) || (record.agentId !== undefined && record.id !== undefined && record.agentId !== record.id)) return invalid()
  const sessionId = nullableId(record.sessionId), codexThread = nullableId(record.codexThread)
  const opencodeSession = record.opencodeSession === undefined || record.opencodeSession === null ? null
    : typeof record.opencodeSession === 'string' && /^ses_[A-Za-z0-9_-]{8,128}$/.test(record.opencodeSession) ? record.opencodeSession : invalid()
  if (execution.engine !== 'codex' && codexThread !== null) return invalid()
  if (execution.engine !== 'opencode' && opencodeSession !== null) return invalid()
  if (sessionId === null && (codexThread !== null || opencodeSession !== null)) return invalid()
  return Object.freeze({ agentId, sessionId, codexThread, opencodeSession, homePc: nullableId(record.homePc),
    executionRevision: revision(record.executionRevision === undefined ? 0 : record.executionRevision), execution })
}

/** A legacy record gets a computed snapshot; nothing is persisted or rebound. */
export function snapshotAgentExecution(record: unknown, defaults: unknown = {}): ExecutionSnapshot {
  if (!contractRecord(record)) return invalid()
  return binding(record, normalizeExecution(record, defaults))
}

export function requireExecutionSnapshot(value: unknown): ExecutionSnapshot {
  const keys = ['agentId', 'sessionId', 'codexThread', 'opencodeSession', 'homePc', 'executionRevision', 'execution']
  if (!contractRecord(value) || keys.some(k => !has(value, k) || value[k] === undefined)) return invalid()
  return binding(value, requireExecutionIdentity(value.execution))
}

/** A provider-only change inside the Claude harness must fail the same CAS as an engine change. */
export function assertExecutionCAS(expected: unknown, current: unknown): void {
  const a = requireExecutionSnapshot(expected), b = requireExecutionSnapshot(current)
  if (a.agentId !== b.agentId || a.sessionId !== b.sessionId || a.codexThread !== b.codexThread
    || a.opencodeSession !== b.opencodeSession || a.homePc !== b.homePc || a.executionRevision !== b.executionRevision
    || !sameExecution(a.execution, b.execution)) {
    throw executionError('execution-stale', 'The confirmed execution or native conversation changed. Review it again.')
  }
}

export interface ExecutionLineage {
  readonly binding: ExecutionSnapshot
  readonly sourceSessionId: string | null
  readonly recordedAt: string
}

export function requireExecutionLineage(value: unknown): ExecutionLineage {
  if (!contractRecord(value) || !has(value, 'sourceSessionId') || value.sourceSessionId === undefined || typeof value.recordedAt !== 'string'
    || !Number.isFinite(Date.parse(value.recordedAt))) return invalid()
  const current = requireExecutionSnapshot(value.binding), source = nullableId(value.sourceSessionId)
  if (current.sessionId === null || (source !== null && source === current.sessionId)) return invalid()
  return Object.freeze({ binding: current, sourceSessionId: source, recordedAt: value.recordedAt })
}

/** Prepared forks carry a fresh native SID, the exact source, and the next execution generation. */
export function assertPreparedExecution(source: unknown, prepared: unknown, targetPcId: string, requestedTarget: unknown): ExecutionLineage {
  const previous = requireExecutionSnapshot(source), next = requireExecutionLineage(prepared)
  const target = requireExecutionIdentity(requestedTarget)
  if (!id(targetPcId) || !previous.sessionId || next.sourceSessionId !== previous.sessionId
    || next.binding.agentId !== previous.agentId || next.binding.sessionId === previous.sessionId
    || next.binding.homePc !== targetPcId || next.binding.executionRevision !== previous.executionRevision + 1
    || !sameExecution(next.binding.execution, target)) {
    throw executionError('execution-lineage-invalid', 'The prepared conversation does not match the source and execution generation.')
  }
  return next
}

export const BRIDGE_REQUEST_PURPOSES = ['main', 'small-fast', 'secondary', 'compaction', 'classifier'] as const
export type BridgeRequestPurpose = typeof BRIDGE_REQUEST_PURPOSES[number]
export interface BridgeRequestPolicy {
  readonly model: typeof BRIDGE_MODEL
  readonly reasoning: Readonly<{ effort: typeof BRIDGE_EFFORT }>
  readonly purpose: BridgeRequestPurpose
}

/** Known Claude slot aliases resolve to the stated Sol policy; a different explicit GPT model is refused. */
export function resolveBridgeModelAlias(value: unknown): typeof BRIDGE_MODEL {
  if (typeof value !== 'string') throw executionError('bridge-policy-refused', 'This bridge requires an explicit supported model or slot alias.')
  if ([BRIDGE_MODEL, 'default', 'opus', 'sonnet', 'haiku', 'small-fast', 'secondary', 'compaction', 'classifier'].includes(value)
    || /^claude-(?:opus|sonnet|haiku)-[0-9][a-z0-9.-]*$/.test(value)) return BRIDGE_MODEL
  throw executionError('bridge-policy-refused', 'This bridge is pinned to Sol. Other explicit models are refused.')
}

/** Validate the final outgoing policy after translation; this function never supplies a missing effort. */
export function requireBridgeRequestPolicy(value: unknown): BridgeRequestPolicy {
  if (!contractRecord(value) || value.model !== BRIDGE_MODEL || !contractRecord(value.reasoning)
    || value.reasoning.effort !== BRIDGE_EFFORT || typeof value.purpose !== 'string'
    || !(BRIDGE_REQUEST_PURPOSES as readonly string[]).includes(value.purpose)) {
    throw executionError('bridge-policy-refused', 'Every bridge inference request requires Sol and explicit max effort.')
  }
  return Object.freeze({ model: BRIDGE_MODEL, reasoning: Object.freeze({ effort: BRIDGE_EFFORT }), purpose: value.purpose as BridgeRequestPurpose })
}
