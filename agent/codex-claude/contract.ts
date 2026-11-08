// Pure admission contracts only. No proxy, token reader, refresher, process runner or network code.
import { BRIDGE_EFFORT, BRIDGE_MODEL, CODEX_IN_CLAUDE_PROFILE, EXECUTION_CONTRACT_VERSION,
  assertExecutionCAS, contractRecord, executionError, requireExecutionIdentity, requireExecutionSnapshot,
  sameExecution, type BridgeExecutionIdentity, type ExecutionSnapshot } from '../../shared/chat-execution.ts'

const safeId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const hasOnly = (r: Record<string, unknown>, keys: readonly string[]) => Object.keys(r).every(k => keys.includes(k))
const failCapability = (): never => { throw executionError('execution-capability-required', 'This PC has not proved the pinned Codex in Claude Code execution and Sol/max policy.') }
const failLease = (): never => { throw executionError('bridge-lease-invalid', 'The credential-manager lease does not belong to this owner and execution instance.') }
const failRuntime = (): never => { throw executionError('execution-runtime-mismatch', 'The running child and proxy do not prove the approved execution identity and ownership.') }

function bridgeIdentity(value: unknown): BridgeExecutionIdentity {
  const execution = requireExecutionIdentity(value)
  if (execution.profile !== CODEX_IN_CLAUDE_PROFILE) return failCapability()
  return execution
}

export interface BridgeRuntimePins {
  readonly platform: 'win32' | 'linux' | 'darwin'
  readonly arch: 'x64' | 'arm64'
  readonly nodeVersion: string
  readonly claudeVersion: string
  readonly codexVersion: string
  readonly adapterSha256: string
}

export function requireBridgePins(value: unknown): BridgeRuntimePins {
  if (!contractRecord(value) || typeof value.platform !== 'string' || !['win32', 'linux', 'darwin'].includes(value.platform)
    || typeof value.arch !== 'string' || !['x64', 'arm64'].includes(value.arch) || typeof value.adapterSha256 !== 'string'
    || !/^[a-f0-9]{64}$/i.test(value.adapterSha256)
    || ['nodeVersion', 'claudeVersion', 'codexVersion'].some(k => typeof value[k] !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value[k] as string))) return failCapability()
  return Object.freeze({ platform: value.platform as BridgeRuntimePins['platform'], arch: value.arch as BridgeRuntimePins['arch'],
    nodeVersion: value.nodeVersion as string, claudeVersion: value.claudeVersion as string, codexVersion: value.codexVersion as string,
    adapterSha256: value.adapterSha256.toLowerCase() })
}

function samePins(a: BridgeRuntimePins, b: BridgeRuntimePins): boolean {
  return a.platform === b.platform && a.arch === b.arch && a.nodeVersion === b.nodeVersion && a.claudeVersion === b.claudeVersion
    && a.codexVersion === b.codexVersion && a.adapterSha256 === b.adapterSha256
}

export interface BridgePolicy {
  readonly model: typeof BRIDGE_MODEL
  readonly effort: typeof BRIDGE_EFFORT
  readonly allRequestPurposes: true
}

function requirePolicy(value: unknown): BridgePolicy {
  if (!contractRecord(value) || value.model !== BRIDGE_MODEL || value.effort !== BRIDGE_EFFORT || value.allRequestPurposes !== true) return failCapability()
  return Object.freeze({ model: BRIDGE_MODEL, effort: BRIDGE_EFFORT, allRequestPurposes: true })
}

/** Local trusted evidence metadata; this is not a user-supplied assertion or a cryptographic attestation. */
export interface BridgeEndpointPolicyProof {
  readonly kind: 'endpoint-accepted-request'
  readonly evidenceId: string
  readonly verifiedAt: string
  readonly model: typeof BRIDGE_MODEL
  readonly effort: typeof BRIDGE_EFFORT
  readonly terminalEvent: 'response.completed'
  readonly pins: BridgeRuntimePins
}

export interface BridgeTargetCapability {
  readonly version: typeof EXECUTION_CONTRACT_VERSION
  readonly targetPcId: string
  readonly execution: BridgeExecutionIdentity
  readonly pins: BridgeRuntimePins
  readonly policy: BridgePolicy
  readonly endpointProof: BridgeEndpointPolicyProof
  readonly managerLease: true
  readonly managerRefreshOwnership: true
  readonly claudeJsonlResume: true
  readonly perChildIsolation: true
}

/** A legacy engines:['claude'] response cannot satisfy this contract, even when the harness matches. */
export function requireBridgeCapability(value: unknown, targetPcId: string, pinned: unknown, nowMs: number): BridgeTargetCapability {
  const pins = requireBridgePins(pinned)
  if (!safeId(targetPcId) || !positive(nowMs) || !contractRecord(value) || value.version !== EXECUTION_CONTRACT_VERSION
    || value.targetPcId !== targetPcId || value.managerLease !== true || value.managerRefreshOwnership !== true
    || value.claudeJsonlResume !== true || value.perChildIsolation !== true) return failCapability()
  const execution = bridgeIdentity(value.execution), actualPins = requireBridgePins(value.pins), policy = requirePolicy(value.policy)
  if (!samePins(pins, actualPins)) return failCapability()
  const proof = value.endpointProof
  if (!contractRecord(proof) || proof.kind !== 'endpoint-accepted-request' || !safeId(proof.evidenceId)
    || typeof proof.verifiedAt !== 'string' || !Number.isFinite(Date.parse(proof.verifiedAt)) || Date.parse(proof.verifiedAt) > nowMs
    || proof.model !== BRIDGE_MODEL || proof.effort !== BRIDGE_EFFORT || proof.terminalEvent !== 'response.completed') return failCapability()
  const proofPins = requireBridgePins(proof.pins)
  if (!samePins(actualPins, proofPins)) return failCapability()
  const endpointProof: BridgeEndpointPolicyProof = Object.freeze({ kind: 'endpoint-accepted-request', evidenceId: proof.evidenceId,
    verifiedAt: proof.verifiedAt, model: BRIDGE_MODEL, effort: BRIDGE_EFFORT, terminalEvent: 'response.completed', pins: proofPins })
  return Object.freeze({ version: EXECUTION_CONTRACT_VERSION, targetPcId, execution, pins: actualPins, policy, endpointProof,
    managerLease: true, managerRefreshOwnership: true, claudeJsonlResume: true, perChildIsolation: true })
}

export interface BridgeLeaseRequest {
  readonly ownerId: string
  readonly runId: string
  readonly targetPcId: string
  readonly binding: ExecutionSnapshot
}

/** Metadata only. The existing manager remains the authority that actually authenticates this request. */
export function requireBridgeLeaseRequest(value: unknown): BridgeLeaseRequest {
  if (!contractRecord(value) || !hasOnly(value, ['ownerId', 'runId', 'targetPcId', 'binding'])
    || !safeId(value.ownerId) || !safeId(value.runId) || !safeId(value.targetPcId)) return failLease()
  const current = requireExecutionSnapshot(value.binding)
  if (current.execution.profile !== CODEX_IN_CLAUDE_PROFILE || !current.sessionId || current.homePc !== value.targetPcId) return failLease()
  return Object.freeze({ ownerId: value.ownerId, runId: value.runId, targetPcId: value.targetPcId, binding: current })
}

export interface CodexBridgeLease {
  readonly manager: 'existing-codex-manager-v1'
  readonly leaseId: string
  readonly credentialKind: 'chatgpt'
  readonly credentialRevision: number
  readonly request: BridgeLeaseRequest
}

export function requireCodexBridgeLease(value: unknown, expected: unknown): CodexBridgeLease {
  const request = requireBridgeLeaseRequest(expected)
  if (!contractRecord(value) || !hasOnly(value, ['manager', 'leaseId', 'credentialKind', 'credentialRevision', 'request'])
    || value.manager !== 'existing-codex-manager-v1' || !safeId(value.leaseId) || value.credentialKind !== 'chatgpt'
    || !positive(value.credentialRevision)) return failLease()
  const actual = requireBridgeLeaseRequest(value.request)
  if (actual.ownerId !== request.ownerId || actual.runId !== request.runId || actual.targetPcId !== request.targetPcId) return failLease()
  try { assertExecutionCAS(request.binding, actual.binding) } catch { return failLease() }
  return Object.freeze({ manager: 'existing-codex-manager-v1', leaseId: value.leaseId, credentialKind: 'chatgpt',
    credentialRevision: value.credentialRevision, request: actual })
}

/** Backend-only transient callback data. Never put this in settings, shared state, logs or child environment. */
export interface BridgeRequestAuthorization {
  readonly accessToken: string
  readonly accountId: string
  readonly expiresAtMs: number
  readonly credentialRevision: number
}

/** No refresh/login/auth-file methods: refresh and CRM CAS/writeback stay inside the existing owner. */
export interface CodexBridgeCredentialBroker {
  acquire(request: BridgeLeaseRequest, signal?: AbortSignal): Promise<CodexBridgeLease>
  withAuthorization<T>(lease: CodexBridgeLease, use: (authorization: BridgeRequestAuthorization) => Promise<T>, signal?: AbortSignal): Promise<T>
  adopt(lease: CodexBridgeLease, runtime: BridgeActualRuntimeProof): Promise<CodexBridgeLease>
  release(lease: CodexBridgeLease): Promise<void>
}

export interface BridgeProcessIdentity {
  readonly pid: number
  readonly createdAtMs: number
}
export interface BridgeActualRuntimeProof {
  readonly version: typeof EXECUTION_CONTRACT_VERSION
  readonly runId: string
  readonly ownerId: string
  readonly targetPcId: string
  readonly leaseId: string
  readonly binding: ExecutionSnapshot
  readonly execution: BridgeExecutionIdentity
  readonly pins: BridgeRuntimePins
  readonly policy: BridgePolicy
  readonly claude: BridgeProcessIdentity
  readonly proxy: BridgeProcessIdentity
  readonly listener: Readonly<{ host: '127.0.0.1'; port: number; authentication: 'per-child-bearer-v1' }>
  readonly settings: Readonly<{ ownerId: string; access: 'owner-only'; scope: 'child-only' }>
}

const processIdentity = (value: unknown): BridgeProcessIdentity => {
  if (!contractRecord(value) || !positive(value.pid) || !positive(value.createdAtMs)) return failRuntime()
  return Object.freeze({ pid: value.pid, createdAtMs: value.createdAtMs })
}

/** Validate trusted host observations; OS process/ACL observation and peer authentication are future integration work. */
export function requireBridgeRuntimeProof(value: unknown, leaseValue: unknown, requestValue: unknown,
  capabilityValue: unknown, pinned: unknown, nowMs: number): BridgeActualRuntimeProof {
  const request = requireBridgeLeaseRequest(requestValue), lease = requireCodexBridgeLease(leaseValue, request)
  const capability = requireBridgeCapability(capabilityValue, request.targetPcId, pinned, nowMs)
  if (!contractRecord(value) || value.version !== EXECUTION_CONTRACT_VERSION || value.runId !== request.runId
    || value.ownerId !== request.ownerId || value.targetPcId !== request.targetPcId || value.leaseId !== lease.leaseId) return failRuntime()
  const execution = requireExecutionIdentity(value.execution), actualPins = requireBridgePins(value.pins), policy = requirePolicy(value.policy)
  if (!sameExecution(execution, capability.execution) || !samePins(actualPins, capability.pins)) return failRuntime()
  const current = requireExecutionSnapshot(value.binding)
  try { assertExecutionCAS(request.binding, current) } catch { return failRuntime() }
  const claude = processIdentity(value.claude), proxy = processIdentity(value.proxy), listener = value.listener, settings = value.settings
  if (claude.pid === proxy.pid || claude.createdAtMs > nowMs || proxy.createdAtMs > nowMs
    || !contractRecord(listener) || listener.host !== '127.0.0.1' || !positive(listener.port) || listener.port > 65535
    || listener.authentication !== 'per-child-bearer-v1' || !contractRecord(settings) || settings.ownerId !== request.ownerId
    || settings.access !== 'owner-only' || settings.scope !== 'child-only') return failRuntime()
  // Full equality above has already proved the bridge variant; no engine-only legacy exception is allowed.
  return Object.freeze({ version: EXECUTION_CONTRACT_VERSION, runId: request.runId, ownerId: request.ownerId,
    targetPcId: request.targetPcId, leaseId: lease.leaseId, binding: current, execution: execution as BridgeExecutionIdentity,
    pins: actualPins, policy, claude, proxy, listener: Object.freeze({ host: '127.0.0.1', port: listener.port, authentication: 'per-child-bearer-v1' }),
    settings: Object.freeze({ ownerId: request.ownerId, access: 'owner-only', scope: 'child-only' }) })
}
