import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { execFile } from 'node:child_process'
import { assertExecutionCAS, CODEX_IN_CLAUDE_PROFILE, sameExecution, type ExecutionIdentity, type ExecutionSnapshot } from '../../shared/chat-execution.ts'
import { EXECUTION_ERROR_CODES, executionHttpError, executionIntentId, type ExecutionOpenReply, type ExecutionSelectionReply, type ExecutionSelectionRequest } from '../../shared/chat-execution-http.ts'
import { ExecutionCoordinator, type ExecutionSourceFence, type ExecutionTargetObservation, type PreparedExecutionSelection, type ExecutionStartRequest } from './execution-coordinator.ts'
import { ExecutionIntentLedger, scopeDigest, selectionFingerprint, type ExecutionIntentScope, type ExecutionIntent } from './execution-intents.ts'
import type { FloorExecutionAuthority, FloorExecutionCommit } from './floors.ts'
import { sourceHash } from './switch-fence.ts'
import { createBridgeRuntime, type BridgeRuntimeOptions } from '../codex-claude/runtime.ts'
import { assertPrivatePath, writePrivateAtomic } from '../codex-claude/storage.ts'
import { readChildConfig } from '../codex-claude/child.ts'
import { recoverUnreportedHostPids } from './execution-host-observation.ts'
import { createNativeCodexExecution } from './execution-native.ts'

export interface ExecutionServiceOptions extends BridgeRuntimeOptions {
  actor(scope: ExecutionIntentScope): void
  state(scope: ExecutionIntentScope): { binding: ExecutionSnapshot; selection: import('./execution-intents.ts').ExecutionCommitStamp | null }
  floorFile(scope: ExecutionIntentScope): string
  commit(request: FloorExecutionCommit): void
  target(scope: ExecutionIntentScope, profile: ExecutionIdentity['profile']): ExecutionIdentity
  /** Stop/ack and durably seal the actual native source; no floor/profile change here. */
  seal(scope: ExecutionIntentScope, expected: ExecutionSnapshot): Promise<{ assertCurrent(): void; finish(committed: boolean, changed: boolean): void }>
  prepare(scope: ExecutionIntentScope, expected: ExecutionSnapshot, target: ExecutionIdentity): Promise<PreparedExecutionSelection>
  /** Existing native launcher, with the same current-profile/owner guards around its awaits. */
  nativeOpen?(request: ExecutionStartRequest, assertCurrent: () => void, executable: string): Promise<void>
}
interface FenceState {
  scope: ExecutionIntentScope; expected: ExecutionSnapshot; next: ExecutionSnapshot | null;
  floorFile: string; floorHash: string; source: { assertCurrent(): void; finish(committed: boolean, changed: boolean): void };
}
export interface ExecutionToolIntent {
  version: 1; scope: ExecutionIntentScope; expected: ExecutionSnapshot; request?: ExecutionSelectionRequest;
  selected?: ExecutionSelectionReply; openIssued: boolean; reply?: ExecutionOpenReply; targetProfile?: 'codex-in-claude-v1' | 'codex-native-v1';
}
/** Recover only the FIRST unused open of an exact, authoritatively reconciled selection.
 * This is called by the explicit open POST, never by GET or an ambiguous started operation. */
export function confirmedPreparedToolSelection(intent: ExecutionToolIntent, parent: ExecutionIntent | null, child: ExecutionIntent | null): ExecutionSelectionReply {
  const refuse = (): never => { throw executionHttpError('execution-intent-uncertain', 'open') }
  if (intent.openIssued || intent.reply || !intent.request || parent?.kind !== 'selection' || child?.kind !== 'open'
    || parent.state !== 'committed' || !parent.plan || child.state !== 'ready' || child.lease || child.actual || child.dimensions
    || scopeDigest(parent.scope) !== scopeDigest(intent.scope) || scopeDigest(child.scope) !== scopeDigest(intent.scope)
    || parent.id !== intent.request.selectionIntentId || parent.fingerprint !== selectionFingerprint(intent.scope, intent.request)
    || parent.plan.stamp.selectionIntentId !== parent.id || parent.plan.stamp.openIntentId !== child.id
    || child.selectionIntentId !== parent.id || child.runId !== parent.plan.runId) return refuse()
  assertExecutionCAS(intent.expected, intent.request.expected)
  assertExecutionCAS(parent.plan.binding, child.binding)
  if (!sameExecution(intent.request.target, child.binding.execution)) return refuse()
  if (intent.selected && (intent.selected.openIntentId !== child.id || intent.selected.selectionIntentId !== parent.id)) return refuse()
  if (intent.selected) assertExecutionCAS(intent.selected.committed, child.binding)
  return { version: 1, selectionIntentId: parent.id,
    state: sameExecution(intent.expected.execution, child.binding.execution) ? 'unchanged' : 'committed',
    committed: child.binding, openIntentId: child.id }
}
export function createExecutionService(o: ExecutionServiceOptions) {
  // Observe through the existing authenticated controller. Diagnostics contain only predicates;
  // a failed observation still refuses admission and never creates a runtime proof.
  const host = o.host
  const observedHost = host?.inspect ? { ...host, inspect: async () => {
    const before = host.current?.()
    let observation = await host.inspect!()
    if (host.current) observation = await recoverUnreportedHostPids(observation, { current: host.current, node: process.execPath,
      ready(chat) {
        const runId = String(chat.meta.bridgeRunId), recordFile = path.join(o.directory, `${runId}.run.json`)
        assertPrivatePath(recordFile)
        const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
        if (record.runId !== runId || record.configFile !== path.join(o.directory, `${runId}.child.json`)
          || !isDeepStrictEqual(record.lease?.request?.binding, chat.meta.execution) || record.lease?.request?.binding?.sessionId !== chat.id) throw executionHttpError('execution-runtime-mismatch', 'runtime')
        const config = readChildConfig(record.configFile)
        if (config.readyFile !== path.join(o.directory, `${runId}.ready.json`)) throw executionHttpError('execution-runtime-mismatch', 'runtime')
        assertPrivatePath(config.readyFile)
        const ready = JSON.parse(fs.readFileSync(config.readyFile, 'utf8'))
        if (ready.version !== 1 || ready.runId !== runId || ready.leaseId !== record.lease.leaseId) throw executionHttpError('execution-runtime-mismatch', 'runtime')
        return ready.proxyPid
      },
      process(pid) {
        const script = `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop | ForEach-Object {@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds();file=$_.ExecutablePath}} | ConvertTo-Json -Compress`
        return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
          { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 65536 }, (error, stdout) => {
            if (error) return resolve(null)
            try { resolve(JSON.parse(stdout)) } catch { resolve(null) }
          }))
      },
    })
    try {
      const after = host.current?.()
      const managed = observation.chats.filter(chat => typeof chat.meta.bridgeRunId === 'string'
        && /^[A-Za-z0-9_-]{16,128}$/.test(chat.meta.bridgeRunId)).map(chat => {
        try {
          const record = JSON.parse(fs.readFileSync(path.join(o.directory, `${chat.meta.bridgeRunId}.run.json`), 'utf8'))
          const config = JSON.parse(fs.readFileSync(record.configFile, 'utf8'))
          const ready = JSON.parse(fs.readFileSync(config.readyFile, 'utf8'))
          return { runId: chat.meta.bridgeRunId, bindingMatches: isDeepStrictEqual(chat.meta.execution, record.lease.request.binding),
            pidMatches: chat.pid === ready.proxyPid, readyMatches: ready.runId === record.runId && ready.leaseId === record.lease.leaseId,
            hasStartedAt: Number.isFinite(Date.parse(String(chat.meta.startedAt))), exited: !!chat.exited }
        } catch { return { runId: chat.meta.bridgeRunId, privateRecordReadable: false } }
      })
      writePrivateAtomic(path.join(o.directory, 'host-observation-diagnostic.json'), JSON.stringify({ version: 1, at: new Date().toISOString(),
        controllerUnchanged: isDeepStrictEqual(before, after), hostMatches: observation.hostPid === before?.hostPid && observation.hostStartedAt === before?.hostStartedAt,
        managed }) + '\n')
    } catch { /* Diagnostics never replace the physical admission checks. */ }
    return observation
  } } : host
  const runtime = createBridgeRuntime({ ...o, host: observedHost }), actors = new Map<string, () => void>(), active = new Map<string, FenceState>()
  const noteSelectionFailure = (error: unknown, stage: 'seal' | 'selection' | 'finish') => {
    try {
      const value = error as { code?: unknown; name?: unknown; stack?: unknown }, code = value?.code
      const frames = typeof value?.stack === 'string' ? value.stack.split('\n').slice(1, 10).flatMap(line => {
        const match = /\b([A-Za-z0-9_-]+\.ts):(\d+):(\d+)/.exec(line)
        return match ? [`${match[1]}:${match[2]}:${match[3]}`] : []
      }) : []
      writePrivateAtomic(path.join(o.directory, 'last-selection-failure.json'), JSON.stringify({ version: 1, at: new Date().toISOString(), stage,
        kind: ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError'].includes(String(value?.name)) ? value.name : 'Error',
        code: typeof code === 'string' && ((EXECUTION_ERROR_CODES as readonly string[]).includes(code) || ['EACCES', 'EPERM', 'EBUSY', 'EIO', 'ENOENT', 'ENOSPC'].includes(code)) ? code : null, frames }) + '\n')
    } catch { /* Never expose a cause or let diagnostics alter the selection outcome. */ }
  }
  const committing = new Map<string, ExecutionSourceFence>()
  let coordinator: ExecutionCoordinator | null = null, ledger: ExecutionIntentLedger | null = null
  let initialization: Promise<void> | null = null
  const key = (scope: ExecutionIntentScope) => `${scope.floorId}:${scope.agentId}`
  const actor = (scope: ExecutionIntentScope) => { o.actor(scope); const check = actors.get(scopeDigest(scope)); if (!check) throw executionHttpError('execution-forbidden', 'authorization'); check() }
  const native = o.nativeOpen && o.manager && o.host ? createNativeCodexExecution({ directory: o.directory, manager: o.manager, host: o.host, pool: o.pool,
    open: (request, fence, executable) => o.nativeOpen!(request, () => { fence(); actor(request.scope); assertExecutionCAS(request.binding, o.state(request.scope).binding) }, executable),
    guard: request => { actor(request.scope); assertExecutionCAS(request.binding, o.state(request.scope).binding) } }) : null
  const assertCurrent = (context: FenceState) => {
    actor(context.scope); runtime.storage!.assertExclusiveWriter(); context.source.assertCurrent()
    if (sourceHash(context.floorFile) !== context.floorHash) throw executionHttpError('execution-stale', 'selection')
    const binding = o.state(context.scope).binding
    try { assertExecutionCAS(context.expected, binding) }
    catch (error) { if (!context.next) throw error; assertExecutionCAS(context.next, binding) }
  }
  const authority: FloorExecutionAuthority = {
    assertCurrent(request) {
      const context = active.get(`${request.floorId}:${request.agentId}`)
      if (!context || !context.next) throw executionHttpError('execution-capability-required', 'selection')
      const fence = committing.get(key(context.scope))
      if (!fence) throw executionHttpError('execution-capability-required', 'selection')
      fence.assertCurrent()
      assertExecutionCAS(request.expected, context.expected); assertExecutionCAS(request.next, context.next)
      assertCurrent(context)
      if (request.target.profile === CODEX_IN_CLAUDE_PROFILE) runtime.cachedCapability()
      else if (request.target.profile === 'codex-native-v1' && native) native.capability()
      else throw executionHttpError('execution-capability-required', 'selection')
    },
    persist(file, text) {
      const contexts = [...active.values()].filter(context => context.floorFile === file && context.next !== null)
      if (contexts.length !== 1) throw executionHttpError('execution-intent-uncertain', 'selection')
      const context = contexts[0], fence = committing.get(key(context.scope))
      if (!fence) throw executionHttpError('execution-capability-required', 'selection')
      assertCurrent(context); fence.assertCurrent()
      writePrivateAtomic(file, text, () => { assertCurrent(context); fence.assertCurrent() }); context.floorHash = sourceHash(file)
    },
  }
  const currentTarget = (scope: ExecutionIntentScope, execution: ExecutionIdentity): ExecutionTargetObservation => {
    actor(scope)
    if (scope.targetPcId !== o.self().id || !o.host?.current) throw executionHttpError('execution-capability-required', 'capability')
    if (execution.profile === 'codex-native-v1' && native) {
      const source = o.state(scope).binding.execution.profile
      if (source !== CODEX_IN_CLAUDE_PROFILE && source !== 'codex-native-v1') throw executionHttpError('execution-capability-required', 'capability')
      const target = native.capability(), now = Date.now()
      return { targetPcId: o.self().id, execution, linkGeneration: `native_${runtimeEpoch}_${target.host.generation}_${target.binHash}`,
        observedAtMs: now, validUntilMs: now + 30_000, nativeVerified: true }
    }
    if (execution.profile !== CODEX_IN_CLAUDE_PROFILE) throw executionHttpError('execution-capability-required', 'capability')
    const { capability, pins } = runtime.cachedCapability(), host = o.host.current(), now = Date.now()
    return { targetPcId: o.self().id, execution, linkGeneration: `local_${runtimeEpoch}_${host.generation}`, observedAtMs: now, validUntilMs: now + 30_000,
      nativeVerified: false, pins, bridgeCapability: capability }
  }
  async function ensure() {
    return initialization ??= (async () => {
      await runtime.ensure()
      const storage = runtime.storage!
      ledger = await ExecutionIntentLedger.open({ directory: storage.directory, assertPrivateStorage: storage.assertPrivateStorage,
        assertExclusiveWriter: storage.assertExclusiveWriter, syncDirectory: storage.syncDirectory })
      coordinator = new ExecutionCoordinator({ ledger, broker: runtime.broker!, assertAuthorized: actor,
        assertExecutionCurrent: (scope, expected) => { actor(scope); assertExecutionCAS(expected, o.state(scope).binding) },
        readFloor: async scope => o.state(scope), resolveTarget: (scope, profile) => o.target(scope, profile),
        readTarget: async (scope, execution) => currentTarget(scope, execution), currentTarget,
        withSourceFence: async (scope, expected, action) => {
          actor(scope)
          if (active.size) throw executionHttpError('execution-intent-conflict', 'selection')
          let source: Awaited<ReturnType<typeof o.seal>>
          try { source = await o.seal(scope, expected) } catch (error) { noteSelectionFailure(error, 'seal'); throw error }
          const file = o.floorFile(scope), context: FenceState = { scope, expected, next: null, source, floorFile: file, floorHash: sourceHash(file) }
          active.set(key(scope), context)
          const finishSource = (committed: boolean, changed: boolean) => {
            try { source.finish(committed, changed) } catch (error) { noteSelectionFailure(error, 'finish'); throw error }
          }
          let committed = false
          try {
            const fence: ExecutionSourceFence = { assertCurrent: () => assertCurrent(context) }
            const result = await action(fence)
            committed = true
            return result
          } catch (error) { noteSelectionFailure(error, 'selection'); throw error } finally {
            // A lost acknowledgment after a stamped file CAS still counts as a committed source retirement.
            if (context.next) { try { assertExecutionCAS(context.next, o.state(scope).binding); committed = true } catch { /* Retain source fence on uncertainty. */ } }
            try { if (committed || !context.next) finishSource(committed, context.next?.sessionId !== expected.sessionId) }
            finally { active.delete(key(scope)) }
          }
        },
        prepare: (scope, expected, target) => o.prepare(scope, expected, target),
        commitFloor: async (scope, expected, next, prepared, stamp, fence) => {
          const context = active.get(key(scope)); if (!context) throw executionHttpError('execution-intent-uncertain', 'selection')
          assertCurrent(context); context.next = next
          committing.set(key(scope), fence)
          try {
            o.commit({ floorId: scope.floorId, agentId: scope.agentId, expected, next, target: next.execution,
              lineage: prepared?.lineage ?? null, homePcName: o.self().name, stamp })
          } finally { committing.delete(key(scope)) }
        },
        start: (request: ExecutionStartRequest) => {
          if (request.kind === 'native' && native) return native.start(request)
          return runtime.start(request)
        },
        observeRun: async (_scope, intent) => {
          if (intent.binding.execution.profile === 'codex-native-v1' && native) return native.observe(intent)
          if (!intent.lease) return { state: 'unknown' }
          const observed = await runtime.observe(intent.lease.request)
          return observed.state === 'running' ? { state: 'running', proof: observed.runtime }
            : observed.state === 'ended' ? { state: 'ended', dispatchFenced: true } : { state: 'unknown' }
        },
      })
    })()
  }
  const runtimeEpoch = randomUUID()
  if (fs.existsSync(path.join(o.directory, 'capability.json'))) void ensure().catch(() => {})
  return { authority, runtime,
    bindActor(scope: ExecutionIntentScope, check: () => void) { actors.set(scopeDigest(scope), check) },
    async verify(scope: ExecutionIntentScope) { actor(scope); await runtime.verify(scope.ownerId); actor(scope); await ensure(); return { version: 1, verified: true } },
    async capability(scope: ExecutionIntentScope, query: unknown) {
      // A GET never runs native/provider setup. Existing cached storage may be admitted without a provider call.
      if (!fs.existsSync(path.join(o.directory, 'capability.json'))) throw executionHttpError('execution-capability-required', 'capability')
      if (!initialization) throw executionHttpError('execution-capability-required', 'capability')
      await initialization; return coordinator!.capability(scope, query)
    },
    async select(scope: ExecutionIntentScope, request: unknown) { await ensure(); return coordinator!.select(scope, request) },
    async open(scope: ExecutionIntentScope, request: unknown) { await ensure(); return coordinator!.open(scope, request) },
    async status(scope: ExecutionIntentScope, id: string) {
      if (!initialization) throw executionHttpError('execution-capability-required', 'status', id)
      await initialization; return coordinator!.status(scope, id)
    },
    async openTool(scope: ExecutionIntentScope, operationId: string, verify: boolean, profile: 'codex-in-claude-v1' | 'codex-native-v1' = CODEX_IN_CLAUDE_PROFILE): Promise<ExecutionOpenReply> {
      actor(scope)
      if (!executionIntentId(operationId)) throw executionHttpError('execution-invalid', 'open')
      await ensure()
      const file = path.join(o.directory, `${operationId}.tool.json`)
      let intent: ExecutionToolIntent
      if (fs.existsSync(file)) {
        intent = JSON.parse(fs.readFileSync(file, 'utf8')) as ExecutionToolIntent
        if (intent.version !== 1 || scopeDigest(intent.scope) !== scopeDigest(scope) || (intent.targetProfile ?? CODEX_IN_CLAUDE_PROFILE) !== profile) throw executionHttpError('execution-intent-conflict', 'open', operationId)
        const id = intent.selected?.openIntentId ?? intent.reply?.openIntentId ?? intent.request?.selectionIntentId
        if (!id) throw executionHttpError('execution-intent-uncertain', 'open', operationId)
        const status = await coordinator!.status(scope, id)
        if (status.kind === 'open' && status.state === 'running' && status.actual && status.committed) return {
          executionVersion: 1, openIntentId: id, state: 'already-running', committed: status.committed, actual: status.actual }
        const selectionStatus = !intent.openIssued && intent.request
          ? status.kind === 'selection' ? status : await coordinator!.status(scope, intent.request.selectionIntentId) : null
        if (selectionStatus?.kind === 'selection' && selectionStatus.state === 'committed' && selectionStatus.openIntentId) {
          const parent = ledger!.get(scope, selectionStatus.intentId), child = ledger!.get(scope, selectionStatus.openIntentId)
          intent.selected = confirmedPreparedToolSelection(intent, parent, child)
          assertExecutionCAS(intent.selected.committed, o.state(scope).binding)
          actor(scope)
          // Persist the no-replay fence BEFORE dispatching the one existing versioned open.
          intent.openIssued = true; writePrivateAtomic(file, JSON.stringify(intent) + '\n')
          return coordinator!.open(scope, { executionVersion: 1, openIntentId: intent.selected.openIntentId, expectedExecution: intent.selected.committed })
        }
        throw executionHttpError('execution-intent-uncertain', 'open', id)
      }
      const state = o.state(scope)
      if (fs.readdirSync(o.directory).filter(name => name.endsWith('.tool.json')).length >= 512) throw executionHttpError('execution-ledger-full', 'open')
      // Consume the original tool ID BEFORE native/provider verification; a lost setup response is not permission to repeat it.
      intent = { version: 1, scope, expected: state.binding, openIssued: false, targetProfile: profile }
      writePrivateAtomic(file, JSON.stringify(intent) + '\n')
      if (verify) { try { runtime.cachedCapability() } catch { await runtime.verify(scope.ownerId) } }
      actor(scope); assertExecutionCAS(intent.expected, o.state(scope).binding)
      if (state.binding.execution.profile === profile && state.selection) {
        const status = await coordinator!.status(scope, state.selection.openIntentId)
        if (status.state === 'running' && status.actual && status.committed) {
          intent.reply = { executionVersion: 1, openIntentId: status.intentId, state: 'already-running', committed: status.committed, actual: status.actual }
          writePrivateAtomic(file, JSON.stringify(intent) + '\n'); return intent.reply
        }
        if (status.state !== 'stopped' && status.state !== 'refused') throw executionHttpError('execution-intent-uncertain', 'open', status.intentId)
      }
      const capability = await coordinator!.capability(scope, { profile })
      if (!capability.available) throw executionHttpError(capability.unavailableCode, 'capability')
      intent.request = { version: 1, selectionIntentId: capability.selectionIntentId,
        expected: capability.current, target: capability.target, capabilityReceiptId: capability.capabilityReceiptId, confirmCarryOver: true }
      writePrivateAtomic(file, JSON.stringify(intent) + '\n')
      intent.selected = await coordinator!.select(scope, intent.request)
      writePrivateAtomic(file, JSON.stringify(intent) + '\n')
      intent.openIssued = true; writePrivateAtomic(file, JSON.stringify(intent) + '\n')
      return coordinator!.open(scope, { executionVersion: 1, openIntentId: intent.selected.openIntentId, expectedExecution: intent.selected.committed })
    },
    close() { runtime.close() },
  }
}
