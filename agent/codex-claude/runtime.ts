import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { execFile, spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { BRIDGE_MODEL, BRIDGE_EFFORT, CODEX_IN_CLAUDE_PROFILE, assertExecutionCAS, normalizeExecution, type ExecutionSnapshot } from '../../shared/chat-execution.ts'
import { executionHttpError } from '../../shared/chat-execution-http.ts'
import { createCodexBridgeCredentialBroker, type BridgeOwnerObservation } from '../codex/bridge-credentials.ts'
import type { CodexManager } from '../codex/index.ts'
import { findCodex, parseVersion } from '../codex/find.ts'
import { findClaude, type ChatPool, type StartChat } from '../agentic/chats.ts'
import type { ChatHostLink } from '../chathost/link.ts'
import type { ExecutionStartRequest } from '../agentic/execution-coordinator.ts'
import { requireBridgeCapability, requireBridgeRuntimeProof, type BridgeActualRuntimeProof, type BridgeLeaseRequest, type BridgeRuntimePins, type BridgeTargetCapability, type CodexBridgeLease } from './contract.ts'
import { fromResponses, providerFailureSummary, reasoningTag, responseUsage, sendResponses, toResponses, type ProviderProgress, type ProviderFailureSummary } from './adapter.ts'
import { assertPrivatePath, openExecutionStorage, writePrivateAtomic } from './storage.ts'
import { readChildConfig, type BridgeChildConfig } from './child.ts'
import { probeClaudeHarness } from './probe.ts'
import { BridgeOwnership, BridgeRetirementWork } from './ownership.ts'
import { pendingMessages, BRIDGE_REQUEST_TIMEOUT_MS } from './messages-stream.ts'
import { requestFailureSummary, type RequestPhase } from './request-failure.ts'
import { advanceRunState, proofProcessesGone, runArtifacts, stateNow, type RunState } from './run-state.ts'
import { CAPABILITY_RENEW_CHECK_MS, renewalDue } from './capability-renewal.ts'
import { BRIDGE_REQUIREMENTS as REQUIRED } from './requirements.ts'
import { claudeBinDir, installedClaudeSources, provedClaudeBinary } from './claude-binary.ts'
import { compatibleControllerUpgrade, PREVIOUS_CONTROLLERS, UNCHANGED_CHILD_FILES } from './controller-upgrade.ts'
import { ownsLoopbackListener, pinImmutableBinary, processIdentity } from './windows-observation.ts'
import { confirmedUnstartedEnd, validUnstartedEnd, UnstartedBridgeRetirements, settleUndispatchedLease, validUndispatchedRelease,
  type UndispatchedRelease, type UnstartedBridgeEnd, type UnstartedProcess } from './unstarted.ts'

const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const safeId = (id: string) => /^[A-Za-z0-9_-]{16,128}$/.test(id)
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
/** How long a full process proof is trusted for the quick kernel check of the same instances (see physical()). */
const FULL_PROOF_MS = 5 * 60_000
/** When the full proof is due but its process query cannot run at all, the kernel check of the same proven instances keeps
 * the run admitted for at most this long after its last full proof. A query that runs and disagrees still refuses. */
const FULL_PROOF_FALLBACK_MS = 60 * 60_000
/** A kernel identity (`pid:FILETIME`, 100 ns since 1601) and a process-query creation time (ms since 1970) name the same instant. */
const sameInstant = (identity: string, createdMs: number) => {
  const filetime = BigInt(identity.slice(identity.indexOf(':') + 1))
  return Math.abs(Number(filetime / 10_000n - 11_644_473_600_000n) - createdMs) <= 1
}
const PIN_FILES = ['adapter.ts', 'child.ts', 'runtime.ts', 'storage.ts', 'probe.ts', 'ownership.ts', 'messages-stream.ts', 'controller-upgrade.ts', 'windows-observation.ts', 'unstarted.ts', 'request-failure.ts', 'run-state.ts', 'capability-renewal.ts', 'requirements.ts', 'claude-binary.ts']
interface RunRecord {
  version: 1; runId: string; lease: CodexBridgeLease; pins: BridgeRuntimePins; configFile: string;
  state: RunState; proof?: BridgeActualRuntimeProof;
  dispatchPaused?: boolean;
  unstartedEnd?: UnstartedBridgeEnd;
}
export interface BridgeStatus {
  setUp: boolean
  started: 'ok' | 'starting' | 'failed' | 'idle' | 'closed'
  failure: string | null
  verifiedAt: string | null
  forThisBuild: boolean | null
}
export interface BridgeRuntimeOptions {
  directory: string; manager: CodexManager | null; host: ChatHostLink | null;
  self(): { id: string; name: string };
  current(request: BridgeLeaseRequest): boolean;
  launch(request: ExecutionStartRequest): Omit<StartChat, 'bridge'>;
  pool(): ChatPool;
  memorySettings?: string;
  /** Where the bridge keeps its copy of the proved Claude Code program (default: claudeBinDir(directory)). */
  claudeBinDir?: string;
}

/** One controller-side provider transport. Persistent children hold loopback keys only. */
export function createBridgeRuntime(o: BridgeRuntimeOptions) {
  const runs = new Map<string, RunRecord>(), dispatch = new Map<string, Extract<ExecutionStartRequest, { kind: 'bridge' }>['dispatchProvider']>()
  const lifetime = new AbortController(), knownBrokerLeases = new Set<string>(), retirementWork = new BridgeRetirementWork()
  let hostLifetime = new AbortController()
  const probes = new Map<string, { key: string; consumerId: string; ownerId: string; sawRead: boolean; paused: boolean }>()
  let closed = false, storage: Awaited<ReturnType<typeof openExecutionStorage>> | null = null
  let server: http.Server | null = null, port = 0, capability: BridgeTargetCapability | null = null
  let pins: BridgeRuntimePins | null = null, claude: string | null = null, claudeHash: string | null = null
  const previousCapabilities: unknown[] = []
  let binaryPin: ReturnType<typeof pinImmutableBinary> | null = null
  let initialization: Promise<void> | null = null
  const ownership = new BridgeOwnership(() => {
    if (closed || !o.host?.current) throw executionHttpError('execution-runtime-mismatch', 'runtime')
    return o.host.current()
  })
  const unstarted = new UnstartedBridgeRetirements(epoch=>ownership.fence(epoch))
  // Runs fully proven recently, for the quick per-request check (see physical()). Forgotten on any doubt.
  const provenRuns = new Map<string, { epoch: unknown; proxyPid: number; claudePid: number; proxyIdentity: string; claudeIdentity: string; port: number; at: number }>()
  o.host?.onLost(() => { provenRuns.clear(); ownership.invalidate(); unstarted.invalidate(); hostLifetime.abort() })
  o.host?.onBack(() => { if (!closed) hostLifetime = new AbortController() })
  const cleanupTimer = setInterval(() => { void retirementWork.reconcile() }, 1000)
  cleanupTimer.unref()
  const recordFile = (id: string) => { if (!safeId(id)) throw executionHttpError('execution-invalid', 'runtime'); return path.join(o.directory, `${id}.run.json`) }
  const save = (record: RunRecord) => writePrivateAtomic(recordFile(record.runId), JSON.stringify(record) + '\n')
  /** One prompt-cache key per conversation (a hash of its session id): the endpoint keeps its cached prefix warm. */
  const cacheKeyOf = (record: RunRecord) => createHash('sha256').update(`sad-bridge-cache:${record.lease.request.binding.sessionId}`).digest('hex').slice(0, 32)
  // The last 300 requests' timings (numbers only), so the speed of Codex in Claude Code can be measured, not guessed.
  let timings: unknown[] | null = null
  const recordTiming = (entry: Record<string, unknown>) => {
    try {
      const file = path.join(o.directory, 'request-timings.json')
      if (!timings) { try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); timings = Array.isArray(raw?.entries) ? raw.entries.slice(-300) : [] } catch { timings = [] } }
      const list = timings ?? []
      list.push(entry); if (list.length > 300) list.splice(0, list.length - 300)
      timings = list
      writePrivateAtomic(file, JSON.stringify({ version: 1, entries: list }) + '\n')
    } catch { /* Diagnostics never change a request. */ }
  }
  const pause = (record: RunRecord) => {
    record.dispatchPaused = true
    try { save(record) } catch { closed = true; lifetime.abort() }
  }
  const current = (request: BridgeLeaseRequest) => {
    try { ownership.capture(); return !closed && request.targetPcId === o.self().id && o.current(request) } catch { return false }
  }
  // Protect saved unique consumers BEFORE index's native sweep/adoption can run. No authorization is inferred.
  if (fs.existsSync(o.directory)) {
    assertPrivatePath(o.directory)
    for (const name of fs.readdirSync(o.directory).filter(name => name.endsWith('.run.json'))) {
      const file = path.join(o.directory, name); assertPrivatePath(file)
      const record = JSON.parse(fs.readFileSync(file, 'utf8')) as RunRecord
      if (record.version !== 1 || !safeId(record.runId) || name !== `${record.runId}.run.json` || !record.lease?.leaseId?.startsWith('bridge-')
        || !['starting', 'running', 'ended', 'released'].includes(record.state)
        || path.resolve(record.configFile) !== path.join(path.resolve(o.directory), `${record.runId}.child.json`)) throw executionHttpError('execution-intent-uncertain', 'runtime')
      if (record.state === 'released') {
        if (record.proof) ownership.released(record.lease, record.proof)
        else if (!record.unstartedEnd || !validUnstartedEnd(record.unstartedEnd,record.lease)) throw executionHttpError('execution-intent-uncertain', 'runtime')
      } else o.manager?.bridgeCredentials.protect(record.lease.leaseId)
      // Keep completed tombstones across restart, without re-protecting or adopting their consumers.
      runs.set(record.runId, record)
    }
  }
  const broker = o.manager ? createCodexBridgeCredentialBroker({ source: o.manager.bridgeCredentials, currentBinding: current,
    observeRuntime: observe,
    canRetire: (lease, observation) => {
      const record = runs.get(lease.request.runId)
      return !!record && (record.proof ? ownership.canRetire(lease, record.proof, observation) : unstarted.canRetire(lease,record.unstartedEnd,observation))
    },
  }) : null
  const previousFor = (record: RunRecord) => pins ? previousCapabilities.find(cap => compatibleControllerUpgrade(cap, record.pins,
    record.proof, record.lease, pins!, Object.fromEntries(Object.keys(UNCHANGED_CHILD_FILES).map(file => [file, hash(path.join(import.meta.dirname,file))])), Date.now())) : undefined
  const compatiblePrevious = (record: RunRecord) => previousFor(record) !== undefined

  function tombstone(record: RunRecord): BridgeOwnerObservation {
    return record.proof ? ownership.released(record.lease, record.proof)
      : record.unstartedEnd && validUnstartedEnd(record.unstartedEnd, record.lease) ? { state: 'ended' } : { state: 'unknown' }
  }
  async function physical(record: RunRecord): Promise<BridgeOwnerObservation> {
    if (!o.host?.inspect || !pins || !capability || closed) return { state: 'unknown' }
    cachedCapability()
    const epoch = ownership.capture()
    if (record.state === 'ended' && record.proof) {
      const retired = ownership.retirement(record.lease, record.proof)
      if (retired) return retired
    }
    const host = await o.host.inspect()
    ownership.fence(epoch)
    if (host.hostPid !== epoch.hostPid || host.hostStartedAt !== epoch.hostStartedAt) throw executionHttpError('execution-runtime-mismatch', 'runtime')
    // Retired by a concurrent observation while this one awaited: report the tombstone, never rewrite it.
    if (stateNow(record) === 'released') return tombstone(record)
    const ch = host.chats.find(chat => chat.id === record.lease.request.binding.sessionId)
    if (!record.proof && (ch?.exited || record.unstartedEnd)) {
      const rows=await unstartedProcesses([path.basename(process.execPath),path.basename(claude!)])
      ownership.fence(epoch)
      const end=confirmedUnstartedEnd(record.lease,epoch,ch,rows,record.configFile,record.unstartedEnd)
      if(!end)return {state:'unknown'}
      if(!record.unstartedEnd){record.unstartedEnd=end;advanceRunState(record,'ended');save(record)}
      const observed=unstarted.ended(end,epoch);queueRetirement(record);return observed
    }
    if (ch && (ch.meta.bridgeRunId !== record.runId || !isDeepStrictEqual(ch.meta.execution, record.lease.request.binding))) return { state: 'unknown' }
    // Exited, or no longer listed by the current authenticated host (it forgets chats that ended while
    // no agent was there): only the run's own recorded processes being gone proves the end.
    if (!ch || ch.exited) {
      if (!record.proof) return { state: 'unknown' }
      const table = await processes(record.proof.proxy.pid, record.proof.claude.pid, host.hostPid, record.proof.listener.port)
      ownership.fence(epoch)
      if (stateNow(record) === 'released') return tombstone(record)
      if (!proofProcessesGone(record.proof, table)) return { state: 'unknown' }
      const retired = ownership.ended(record.lease, record.proof, epoch)
      if (advanceRunState(record, 'ended')) save(record)
      queueRetirement(record)
      return retired
    }
    // Speed: the full proof below (a PowerShell process query, ~0.8 s) runs on a run's first observation and then at most
    // every 5 minutes. In between, the same proven instances (exact PID + kernel creation time of the proxy and of
    // Claude Code) and the proxy's own loopback listener are re-checked directly with the kernel, in microseconds.
    const proven = provenRuns.get(record.runId)
    provenRuns.delete(record.runId)
    // The same proven instances, still running, still listening: admitted again without a process query.
    const quick = (maxAgeMs: number): BridgeOwnerObservation | null => {
      try {
        if (proven && isDeepStrictEqual(proven.epoch, epoch) && proven.proxyPid === ch.pid && record.proof && stateNow(record) === 'running'
          && isDeepStrictEqual(record.pins, pins) && Date.now() - proven.at < maxAgeMs
          && processIdentity(proven.proxyPid) === proven.proxyIdentity && processIdentity(proven.claudePid) === proven.claudeIdentity
          && ownsLoopbackListener(proven.proxyPid, proven.port)) {
          requireBridgeRuntimeProof(record.proof, record.lease, record.lease.request, capability, pins, Date.now())
          ownership.fence(epoch)
          ownership.admit(record.lease, record.proof, epoch)
          provenRuns.set(record.runId, proven)
          return { state: 'running', runtime: record.proof }
        }
      } catch { /* Not proven by the quick check: the full proof decides. */ }
      return null
    }
    const fast = quick(FULL_PROOF_MS)
    if (fast) return fast
    const config = readChildConfig(record.configFile)
    assertPrivatePath(config.readyFile); assertPrivatePath(config.settingsFile)
    const ready = JSON.parse(fs.readFileSync(config.readyFile, 'utf8'))
    if (ready.version !== 1 || ready.runId !== record.runId || ready.leaseId !== record.lease.leaseId || ready.proxyPid !== ch.pid
      || !Number.isSafeInteger(ready.claudePid) || !Number.isSafeInteger(ready.port) || ready.port < 1 || ready.port > 65535) return { state: 'unknown' }
    let observed: Awaited<ReturnType<typeof processes>>
    try { observed = await processes(ch.pid, ready.claudePid, host.hostPid, ready.port) }
    catch (error) {
      // The process query itself could not run (it timed out under heavy load on 10 Nov 00:01 and paused Lead):
      // that is not evidence against the run. A run proven in full within the hour stays admitted on the kernel check of
      // the very same instances; a run never proven in full, or whose instances changed, stays unproven.
      const fallback = quick(FULL_PROOF_FALLBACK_MS)
      if (fallback) return fallback
      throw error
    }
    ownership.fence(epoch)
    // Ended or retired by a concurrent observation while this one awaited: never report or admit it as running.
    if (stateNow(record) === 'released') return tombstone(record)
    if (stateNow(record) === 'ended') return { state: 'unknown' }
    const proxy = observed.rows.find(p => p.pid === ch.pid), child = observed.rows.find(p => p.pid === ready.claudePid), hostProc = observed.rows.find(p => p.pid === host.hostPid)
    const upgrade = !isDeepStrictEqual(record.pins, pins)
    if (!proxy || !child || !hostProc || !observed.listener || child.ppid !== proxy.pid || child.created < proxy.created
      || Math.abs(proxy.created - Date.parse(String(ch.meta.startedAt))) > 10_000 || Math.abs(hostProc.created - host.hostStartedAt) > 10_000
      || path.resolve(proxy.file).toLowerCase() !== path.resolve(process.execPath).toLowerCase()
      || path.resolve(child.file).toLowerCase() !== path.resolve(config.claude).toLowerCase()
      || !proxy.command.includes(record.configFile) || !proxy.command.includes(path.join(import.meta.dirname, 'child.ts'))
      || path.resolve(config.claude).toLowerCase() !== path.resolve(claude!).toLowerCase()
      || config.claudeSha256 !== claudeHash || upgrade && !compatiblePrevious(record)) return { state: 'unknown' }
    const execution = normalizeExecution({ engine: 'claude', executionProfile: CODEX_IN_CLAUDE_PROFILE })
    const proof: BridgeActualRuntimeProof = { version: 1, runId: record.runId, ownerId: record.lease.request.ownerId,
      targetPcId: o.self().id, leaseId: record.lease.leaseId, binding: record.lease.request.binding, execution: execution as BridgeActualRuntimeProof['execution'], pins,
      policy: { model: BRIDGE_MODEL, effort: BRIDGE_EFFORT, allRequestPurposes: true },
      proxy: { pid: proxy.pid, createdAtMs: proxy.created }, claude: { pid: child.pid, createdAtMs: child.created },
      listener: { host: '127.0.0.1', port: ready.port, authentication: 'per-child-bearer-v1' },
      settings: { ownerId: record.lease.request.ownerId, access: 'owner-only', scope: 'child-only' } }
    if (record.proof && (!isDeepStrictEqual(record.proof.proxy, proof.proxy) || !isDeepStrictEqual(record.proof.claude, proof.claude))) return { state: 'unknown' }
    requireBridgeRuntimeProof(proof, record.lease, record.lease.request, capability, pins, Date.now())
    if (upgrade) {
      // Keep every earlier migration receipt; never rewrite the original child/process provenance.
      const file=path.join(o.directory,`${record.runId}.controller-upgrade-${record.pins.adapterSha256}.json`)
      const receipt={version:1,runId:record.runId,fromPins:record.pins,toPins:pins,previousProof:record.proof,proof}
      if (fs.existsSync(file)) { assertPrivatePath(file); if (!isDeepStrictEqual(JSON.parse(fs.readFileSync(file,'utf8')),receipt)) return {state:'unknown'} }
      else writePrivateAtomic(file,JSON.stringify(receipt)+'\n')
      record.pins=pins;record.proof=proof;save(record)
    }
    ownership.admit(record.lease, proof, epoch)
    if (!record.proof) { record.proof = proof; advanceRunState(record, 'running'); save(record) }
    // Remember the instances this full proof saw, for the quick check. The kernel's creation time must agree with the
    // one the process query reported (same instance), or nothing is remembered and the next request proves in full again.
    const proxyIdentity = processIdentity(proxy.pid), claudeIdentity = processIdentity(child.pid)
    if (proxyIdentity && claudeIdentity && sameInstant(proxyIdentity, proxy.created) && sameInstant(claudeIdentity, child.created))
      provenRuns.set(record.runId, { epoch, proxyPid: proxy.pid, claudePid: child.pid, proxyIdentity, claudeIdentity, port: ready.port, at: Date.now() })
    return { state: 'running', runtime: proof }
  }
  async function observe(request: BridgeLeaseRequest, undispatched?:{lease:CodexBridgeLease;fence():void}): Promise<BridgeOwnerObservation> {
    const record = runs.get(request.runId)
    if(!record){
      try{
        if(!safeId(request.runId)||!storage||closed)return{state:'unknown'}
        storage.assertExclusiveWriter()
        const file=path.join(o.directory,request.runId+'.not-started.json')
        const exists=(suffix:string)=>fs.existsSync(path.join(o.directory,request.runId+suffix))
        if(exists('.run.json')||exists('.child.json'))return{state:'unknown'}
        if(fs.existsSync(file)){
          assertPrivatePath(file)
          const saved=JSON.parse(fs.readFileSync(file,'utf8')) as UndispatchedRelease
          return validUndispatchedRelease(saved,saved.lease)&&isDeepStrictEqual(saved.lease.request,request)?{state:'ended'}:{state:'unknown'}
        }
        if(!undispatched||!isDeepStrictEqual(undispatched.lease.request,request))return{state:'unknown'}
        await settleUndispatchedLease(undispatched.lease,{
          fence:()=>{storage!.assertExclusiveWriter();undispatched.fence()},exists,
          release:(id,guard)=>o.manager!.bridgeCredentials.release(id,guard),
          save:(receipt,guard)=>writePrivateAtomic(file,JSON.stringify(receipt)+'\n',guard),
        })
        return{state:'ended'}
      }catch{return{state:'unknown'}}
    }
    if(!isDeepStrictEqual(record.lease.request,request))return{state:'unknown'}
    try {
      if (record.state === 'released') return tombstone(record)
      const observed = await physical(record)
      if (observed.state === 'unknown') {ownership.invalidate(record.runId);unstarted.invalidate(record.lease.leaseId);provenRuns.delete(record.runId)}
      return observed
    } catch { ownership.invalidate(record.runId);unstarted.invalidate(record.lease.leaseId);provenRuns.delete(record.runId); return { state: 'unknown' } }
  }
  async function initialize() {
    if (closed || !o.host?.inspect || !o.host.current || !o.manager || process.platform !== REQUIRED.platform || process.arch !== REQUIRED.arch) throw executionHttpError('execution-capability-required', 'runtime')
    // A retried start-up begins from the saved files again, never from a half-read earlier attempt.
    capability = null; previousCapabilities.length = 0
    storage = await openExecutionStorage(o.directory)
    // The bridge's own copy of the proved version, never the PATH program that Claude Code updates in place.
    claude = provedClaudeBinary({ binDir: o.claudeBinDir ?? claudeBinDir(o.directory), version: REQUIRED.claude,
      sources: installedClaudeSources(REQUIRED.claude, findClaude()) })
    const codex = findCodex()
    if (!claude || !/\.exe$/i.test(claude) || !codex || codex.version !== REQUIRED.codex || process.versions.node !== REQUIRED.node) throw executionHttpError('execution-capability-required', 'runtime')
    const version = spawnSync(claude, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    if (version.status !== 0 || parseVersion(version.stdout) !== REQUIRED.claude) throw executionHttpError('execution-capability-required', 'runtime')
    binaryPin = pinImmutableBinary(claude)
    claudeHash = binaryPin.sha256
    await o.host.inspect()
    o.host.current()
    pins = { platform: 'win32', arch: 'x64', nodeVersion: process.versions.node, claudeVersion: REQUIRED.claude, codexVersion: codex.version,
      adapterSha256: createHash('sha256').update(PIN_FILES.map(file => hash(path.join(import.meta.dirname, file))).join(':')).digest('hex') }
    const capFile = path.join(o.directory, 'capability.json')
    const priorFile=path.join(o.directory,'previous-controller-capability.json')
    for (const file of [priorFile,...PREVIOUS_CONTROLLERS.map(digest=>path.join(o.directory,`previous-controller-capability-${digest}.json`))]) {
      if (fs.existsSync(file)) { assertPrivatePath(file); previousCapabilities.push(JSON.parse(fs.readFileSync(file,'utf8'))) }
    }
    if (fs.existsSync(capFile)) {
      assertPrivatePath(capFile)
      const raw=JSON.parse(fs.readFileSync(capFile,'utf8'))
      try { capability = requireBridgeCapability(raw, o.self().id, pins, Date.now()) }
      catch { capability = null; previousCapabilities.push(raw) }
    }
    server = http.createServer((req, res) => { void handleProvider(req, res) })
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', () => resolve()) })
    const address = server.address(); if (!address || typeof address === 'string') throw executionHttpError('execution-capability-required', 'runtime'); port = address.port
    if (!capability && previousCapabilities.length) {
      const survivor=[...runs.values()].find(record=>record.state==='running'&&current(record.lease.request)&&compatiblePrevious(record))
      if (survivor) {
        // One fresh manager/harness proof before adopting identical surviving children.
        // Keep the old capability as migration provenance if startup is interrupted.
        const previous=previousFor(survivor),archive=path.join(o.directory,`previous-controller-capability-${survivor.pins.adapterSha256}.json`)
        if (!previous) throw executionHttpError('execution-capability-required','capability')
        if (fs.existsSync(archive)) { assertPrivatePath(archive); if (!isDeepStrictEqual(JSON.parse(fs.readFileSync(archive,'utf8')),previous)) throw executionHttpError('execution-capability-required','capability') }
        else writePrivateAtomic(archive,JSON.stringify(previous)+'\n')
        await verifyPinned(survivor.lease.request.ownerId)
      }
    }
    for (const record of runs.values()) {
      if (record.state === 'released') continue
      const observed = await observe(record.lease.request)
      if (observed.state === 'ended') { queueRetirement(record); continue }
      if (observed.state !== 'running') continue
      try {
        await broker!.adopt(record.lease, observed.runtime)
        knownBrokerLeases.add(record.lease.leaseId)
        const config = readChildConfig(record.configFile)
        writePrivateAtomic(record.configFile, JSON.stringify({ ...config, controllerPort: port, controllerKey: randomBytes(32).toString('hex') }) + '\n')
      } catch { /* Hold survives; dispatch remains paused until the owner context can be proved. */ }
    }
  }
  // For the Dependencies page (F-165): how the last start-up went, by app code only.
  let startedOk = false, lastStartFailure: string | null = null
  function ensure(): Promise<void> {
    const attempt: Promise<void> = initialization ??= initialize().then(() => { startedOk = true; lastStartFailure = null }, error => {
      startedOk = false
      const code = (error as { code?: unknown })?.code
      lastStartFailure = typeof code === 'string' && /^(execution|bridge)-[a-z-]{3,48}$/.test(code) ? code : 'unavailable'
      server?.closeAllConnections(); server?.close(); binaryPin?.close(); storage?.close()
      server = null; binaryPin = null; storage = null; capability = null
      // A failed start-up (chat host not back yet, a slow check) is retried by the next caller; kept, it
      // refused every Codex in Claude Code open with "has not proved this execution capability" until a restart.
      if (initialization === attempt) initialization = null
      throw error
    })
    return attempt
  }
  // The 24 h proof is renewed in the background at 20 h with the same verification (one Sol/max request plus the
  // harness probe), only for a PC that is already set up. Expired, it refused every open and paused running chats.
  let lastOwner: string | null = null, renewing: Promise<void> | null = null
  async function renewCapability() {
    // Only a PC that was set up (capability.json exists) and started: its check is renewed from 20 h, or redone
    // when it had expired at start-up. A PC never set up is never set up in the background.
    if (closed || renewing || !initialization || !startedOk || !fs.existsSync(path.join(o.directory, 'capability.json'))) return
    if (capability && !renewalDue(capability.endpointProof.verifiedAt, Date.now())) return
    // The person who used the bridge here; the manager still refuses unless that person is signed in to the CRM now.
    const owner = lastOwner ?? [...runs.values()].find(record => record.state !== 'released')?.lease.request.ownerId
      ?? [...runs.values()].at(-1)?.lease.request.ownerId
    if (!owner) return
    renewing = initialization.then(() => verifyPinned(owner)).then(() => {}, () => { /* The current proof stays until it expires; retried next check. */ })
      .finally(() => { renewing = null })
    await renewing
  }
  const renewTimer = setInterval(() => { void renewCapability() }, CAPABILITY_RENEW_CHECK_MS)
  renewTimer.unref()
  // Once soon after start-up too, so an expired check after a restart is redone in a minute, not 15.
  const firstRenew = setTimeout(() => { void renewCapability() }, 60_000)
  firstRenew.unref()
  async function verify(ownerId: string): Promise<BridgeTargetCapability> {
    await ensure()
    return verifyPinned(ownerId)
  }
  async function verifyPinned(ownerId: string): Promise<BridgeTargetCapability> {
    const id = `bridge-${randomUUID()}`, source = o.manager!.bridgeCredentials
    try {
      const context = await source.retain(id, ownerId)
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(120_000)])
      const response = await source.use(id, context, (authorization, abort) => sendResponses(toResponses({ model: BRIDGE_MODEL,
        messages: [{ role: 'user', content: `Verification ${randomUUID()}: reply with the single word READY.` }] }), authorization, abort).catch(error => {
          writePrivateAtomic(path.join(o.directory, 'last-provider-failure.json'), JSON.stringify({ at: new Date().toISOString(), ...providerFailureSummary(error) }) + '\n'); throw error
        }), signal)
      try { fromResponses(response) } catch (error) {
        writePrivateAtomic(path.join(o.directory, 'last-provider-failure.json'), JSON.stringify({ at: new Date().toISOString(), ...providerFailureSummary(error) }) + '\n'); throw error
      }
      let harnessRead = false
      const harness = await probeClaudeHarness({ directory: o.directory, claude: claude!, claudeSha256: claudeHash!, controllerPort: port,
        ownerId, consumerId: id, register: (runId, key) => {
          const probe = { key, consumerId: id, ownerId, sawRead: false, paused: false }; probes.set(runId, probe)
          return () => { harnessRead = probe.sawRead; probes.delete(runId) }
        }, sawRead: () => harnessRead || [...probes.values()].some(probe => probe.consumerId === id && probe.sawRead) })
      capability = requireBridgeCapability({ version: 1, targetPcId: o.self().id,
        execution: normalizeExecution({ engine: 'claude', executionProfile: CODEX_IN_CLAUDE_PROFILE }), pins,
        policy: { model: BRIDGE_MODEL, effort: BRIDGE_EFFORT, allRequestPurposes: true },
        endpointProof: { kind: 'endpoint-accepted-request', evidenceId: randomUUID(), verifiedAt: new Date().toISOString(), model: BRIDGE_MODEL,
          effort: BRIDGE_EFFORT, terminalEvent: 'response.completed', pins }, managerLease: true, managerRefreshOwnership: true,
        claudeJsonlResume: true, perChildIsolation: true }, o.self().id, pins, Date.now())
      writePrivateAtomic(path.join(o.directory, 'capability.json'), JSON.stringify(capability) + '\n')
      writePrivateAtomic(path.join(o.directory, 'setup-proof.json'), JSON.stringify({ ...harness, pins }) + '\n')
      lastOwner = ownerId
      return capability
    } finally { await source.release(id) }
  }
  async function start(request: ExecutionStartRequest) {
    if (request.kind !== 'bridge' || !broker) throw executionHttpError('execution-capability-required', 'open')
    await ensure(); cachedCapability()
    if (!current(request.lease.request) || runs.has(request.runId) || fs.existsSync(path.join(o.directory,request.runId+'.not-started.json'))) throw executionHttpError('execution-stale', 'open')
    for (const old of runs.values()) if (old.lease.request.binding.sessionId === request.binding.sessionId && old.state !== 'released') {
      const observed = await observe(old.lease.request)
      if (observed.state === 'unknown') throw executionHttpError('execution-intent-uncertain', 'open')
      if (observed.state === 'running') { o.pool().kill(request.binding.sessionId!, 'bridge-resume'); await o.pool().waitStopped?.(request.binding.sessionId!) }
      const ended = await observe(old.lease.request)
      if (ended.state !== 'ended') throw executionHttpError('execution-intent-uncertain', 'open')
      queueRetirement(old); await retirementWork.reconcile()
      if (runs.get(old.runId)?.state !== 'released') throw executionHttpError('execution-intent-uncertain', 'open')
    }
    const files = runArtifacts(o.directory, request.runId), configFile = files.child
    const config: BridgeChildConfig = { version: 1, runId: request.runId, ownerId: request.scope.ownerId, leaseId: request.lease.leaseId,
      binding: request.binding, claude: claude!, claudeSha256: claudeHash!, controllerPort: port, controllerKey: randomBytes(32).toString('hex'), loopbackKey: randomBytes(32).toString('hex'),
      settingsFile: files.settings, readyFile: files.ready, memorySettings: o.memorySettings }
    writePrivateAtomic(configFile, JSON.stringify(config) + '\n')
    const record: RunRecord = { version: 1, runId: request.runId, lease: request.lease, pins: pins!, configFile, state: 'starting' }
    save(record); runs.set(record.runId, record); dispatch.set(record.runId, request.dispatchProvider)
    knownBrokerLeases.add(record.lease.leaseId)
    o.pool().start({ ...o.launch(request), engine: 'claude', model: BRIDGE_MODEL, effort: BRIDGE_EFFORT,
      bridge: { descriptorFile: configFile, runId: record.runId, binding: request.binding, wrapperPath: path.join(import.meta.dirname, 'child.ts') } })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !request.signal.aborted) {
      if ((await observe(request.lease.request)).state === 'running') return
      await wait(250)
    }
    throw executionHttpError('execution-runtime-mismatch', 'runtime')
  }
  function cachedCapability() {
    if (!capability || !pins || !o.host?.inspect || !o.host.current || closed || Date.now() - Date.parse(capability.endpointProof.verifiedAt) > 86_400_000) throw executionHttpError('execution-capability-required', 'capability')
    const currentHash = createHash('sha256').update(PIN_FILES.map(file => hash(path.join(import.meta.dirname, file))).join(':')).digest('hex')
    if (currentHash !== pins.adapterSha256 || !claude || !binaryPin || binaryPin.sha256 !== claudeHash) throw executionHttpError('execution-capability-required', 'capability')
    binaryPin.assertCurrent()
    storage!.assertExclusiveWriter()
    o.host.current()
    return { capability, pins }
  }
  async function handleProvider(req: http.IncomingMessage, res: http.ServerResponse) {
    const fail = () => { if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json', 'x-should-retry': 'false' }); res.end(JSON.stringify({ error: 'The approved Codex execution is paused. No provider retry or fallback was made.' })) }
    const match = /^\/bridge\/([A-Za-z0-9_-]{16,128})\/v1\/messages(\/count_tokens)?$/.exec(req.url ?? '')
    if (req.method !== 'POST' || req.headers.origin !== undefined || !match || !broker) return fail()
    const probe = probes.get(match[1])
    if (probe) {
      const expected = `Bearer ${probe.key}`, provided = req.headers.authorization
      if (typeof provided !== 'string' || Buffer.byteLength(provided) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return fail()
      if (probe.paused) return fail()
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, lifetime.signal, hostLifetime.signal, AbortSignal.timeout(BRIDGE_REQUEST_TIMEOUT_MS)])
      req.on('aborted', () => controller.abort()); res.on('close', () => { if (!res.writableEnded) controller.abort() })
      let pending:ReturnType<typeof pendingMessages>|null=null, failure:ProviderFailureSummary|undefined
      try {
        const chunks: Buffer[] = []; let bytes = 0
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) return fail(); chunks.push(chunk) }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')), body = toResponses(input)
        if (match[2]) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: Buffer.byteLength(JSON.stringify(body)) })); return }
        pending=pendingMessages(res,input.stream===true)
        const source = o.manager!.bridgeCredentials, context = await source.retain(probe.consumerId, probe.ownerId)
        const response = await source.use(probe.consumerId, context, (authorization, abort) => {
          if (probe.paused) throw executionHttpError('execution-intent-uncertain', 'runtime')
          return sendResponses(body, authorization, abort).catch(error => {
          failure=signal.aborted?{stage:'transport',category:signal.reason?.name==='TimeoutError'?'timeout':'aborted'}:providerFailureSummary(error)
          probe.paused = true
          writePrivateAtomic(path.join(o.directory, 'last-provider-failure.json'), JSON.stringify({ at: new Date().toISOString(), ...failure }) + '\n'); throw error
        }) }, signal)
        let reply: ReturnType<typeof fromResponses>
        try { reply = fromResponses(response) } catch (error) {
          writePrivateAtomic(path.join(o.directory, 'last-provider-failure.json'), JSON.stringify({ at: new Date().toISOString(), ...providerFailureSummary(error) }) + '\n'); throw error
        }
        if (reply.content.some(block => block.type === 'tool_use' && block.name === 'Read')) probe.sawRead = true
        pending.complete(reply); return
      } catch { probe.paused = true; if(pending)pending.fail(failure);else fail();return }
    }
    const record = runs.get(match[1]); if (!record) return fail()
    let config: BridgeChildConfig
    try { config = readChildConfig(record.configFile) } catch { return fail() }
    const key = req.headers.authorization, expected = `Bearer ${config.controllerKey}`
    if (typeof key !== 'string' || Buffer.byteLength(key) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(key), Buffer.from(expected))) return fail()
    if (record.dispatchPaused) return fail()
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, lifetime.signal, hostLifetime.signal, AbortSignal.timeout(BRIDGE_REQUEST_TIMEOUT_MS)])
    req.on('aborted', () => abort.abort()); res.on('close', () => { if (!res.writableEnded) abort.abort() })
    let pending:ReturnType<typeof pendingMessages>|null=null
    let phase:RequestPhase='request',providerDispatched=false
    let providerFailure:ReturnType<typeof requestFailureSummary>|undefined
    const started=Date.now();let lastSaved=0,lastPhase=''
    // Speed diagnostics (numbers only): where the time of each request goes.
    const timing={dispatched:0,headers:0,firstByte:0,firstText:0}
    let progress:ProviderProgress={phase:'connecting',bytes:0,events:0}
    const noteProgress=(value:ProviderProgress)=>{
      if(value.phase==='headers'&&!timing.headers)timing.headers=Date.now()
      if(value.phase==='reading'&&!timing.firstByte)timing.firstByte=Date.now()
      progress=value
      if(value.phase!==lastPhase||Date.now()-lastSaved>=15_000){
        lastPhase=value.phase;lastSaved=Date.now()
        writePrivateAtomic(path.join(o.directory,`${record.runId}.request.json`),JSON.stringify({version:1,at:new Date().toISOString(),runId:record.runId,elapsedMs:Date.now()-started,...value})+'\n')
      }
    }
    try {
      const chunks: Buffer[] = []; let size = 0
      for await (const data of req) { size += data.length; if (size > 16 * 1024 * 1024) return fail(); chunks.push(data) }
      // Speed: one prompt-cache key per conversation, and Sol's reasoning carried between the steps of a turn (as Codex does).
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')), body = toResponses(input, { cacheKey: cacheKeyOf(record), carryReasoning: true })
      phase='authorization'
      if (!current(record.lease.request)) throw executionHttpError('execution-runtime-mismatch','runtime')
      if (match[2]) {
        // Conservative local byte bound, never a generation or a request to a smaller model.
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: Buffer.byteLength(JSON.stringify(body)) })); return
      }
      pending=pendingMessages(res,input.stream===true)
      const live=pending.live
      const sink=live&&{...live,text:(delta:string)=>{if(!timing.firstText)timing.firstText=Date.now();live.text(delta)}}
      let tag=''
      const sender = dispatch.get(record.runId) ?? (<T>(send: Parameters<NonNullable<typeof broker>['dispatch']>[1], abort?: AbortSignal) => broker.dispatch(record.lease, send, abort) as Promise<T>)
      const response = await sender((authorization, abort) => {
        if (record.dispatchPaused) throw executionHttpError('execution-intent-uncertain', 'runtime')
        if (!record.proof || !current(record.lease.request)) throw executionHttpError('execution-runtime-mismatch', 'runtime')
        ownership.assertRunning(record.lease, record.proof)
        phase='provider';providerDispatched=true;timing.dispatched=Date.now()
        tag=reasoningTag(authorization.accountId)
        // The manager and broker deliberately replace initiated failures with UNKNOWN.
        // Capture only the adapter's safe metadata at this boundary, never its raw error.
        return sendResponses(body, authorization, abort,noteProgress,sink).catch(error => {
          providerFailure=requestFailureSummary(error,'provider',abort);throw error
        })
      }, signal)
      phase='response'
      const reply = fromResponses(response, { reasoningTag: tag })
      // What went out live must equal the validated reply; if not, the request failed (and the run pauses as for any failure).
      if (!pending.complete(reply)) throw new Error('The live reply did not match the validated reply')
      const done=Date.now(),since=(at:number)=>at&&timing.dispatched?at-timing.dispatched:null
      recordTiming({at:new Date(done).toISOString(),runId:record.runId,live:pending.started,
        carried:Array.isArray(body.input)?body.input.filter(item=>(item as {type?:unknown})?.type==='reasoning').length:0,
        tools:reply.content.filter(block=>block.type==='tool_use').length,
        ms:{beforeProvider:timing.dispatched?timing.dispatched-started:null,headers:since(timing.headers),firstByte:since(timing.firstByte),
          firstText:since(timing.firstText),total:done-started},usage:responseUsage(response)})
    } catch (error) {
      pause(record)
      const failure={...(providerFailure??requestFailureSummary(error,phase,signal)),providerDispatched}
      const diagnostic={version:1,at:new Date().toISOString(),runId:record.runId,elapsedMs:Date.now()-started,
        phase,...(providerDispatched?{progress}:{}),...failure}
      try {
        const bytes=JSON.stringify(diagnostic)+'\n'
        writePrivateAtomic(path.join(o.directory,`${record.runId}.failure.json`),bytes)
        writePrivateAtomic(path.join(o.directory,'last-provider-failure.json'),bytes)
      } catch { /* Pause remains latched even when diagnostics cannot be saved. */ }
      if(pending)pending.fail(failure);else fail()
    }
  }
  function matches(binding: ExecutionSnapshot, runId?: string): boolean {
    for (const record of runs.values()) if ((!runId || record.runId === runId) && record.state === 'running' && record.proof) {
      try {
        assertExecutionCAS(binding, record.lease.request.binding)
        ownership.assertRunning(record.lease, record.proof)
        return current(record.lease.request)
      } catch { /* A different or unproved controller/process generation cannot admit native input. */ }
    }
    return false
  }
  function queueRetirement(record: RunRecord) {
    retirementWork.add(record.runId, async () => {
      if (closed) return false
      if (record.state === 'released') return true
      const observed = await observe(record.lease.request)
      const canRetire=()=>record.proof?ownership.canRetire(record.lease,record.proof,observed):unstarted.canRetire(record.lease,record.unstartedEnd,observed)
      if (observed.state !== 'ended' || !canRetire()) return false
      // Derived names, not the child config: a lost config must not make retirement impossible.
      const files = runArtifacts(o.directory, record.runId)
      if (knownBrokerLeases.has(record.lease.leaseId)) await broker!.release(record.lease)
      else {
        // Recovery of a saved, already-ended unique consumer: no acquire, refresh or provider adoption.
        // The manager still owns draining, settlement and any native auth writeback.
        await o.manager!.bridgeCredentials.release(record.lease.leaseId, () => {
          if (!canRetire()) throw executionHttpError('execution-runtime-mismatch', 'runtime')
        })
      }
      if (advanceRunState(record, 'released')) save(record)
      for (const file of [files.settings, files.ready, files.child]) { try { fs.unlinkSync(file) } catch { /* Only this run's exact private artifacts. */ } }
      ownership.invalidate(record.runId);unstarted.invalidate(record.lease.leaseId); dispatch.delete(record.runId); provenRuns.delete(record.runId)
      return true
    })
  }
  async function ended(sid: string) {
    for (const record of runs.values()) if (record.lease.request.binding.sessionId === sid && record.state !== 'released') {
      if (record.state !== 'ended') ownership.invalidate(record.runId)
      queueRetirement(record)
    }
    await retirementWork.reconcile()
  }
  async function adopt(binding: ExecutionSnapshot, runId: string) {
    await ensure()
    const record = runs.get(runId)
    if (!record) throw executionHttpError('execution-runtime-mismatch', 'runtime')
    assertExecutionCAS(binding, record.lease.request.binding)
    const observed = await observe(record.lease.request)
    if (observed.state !== 'running') throw executionHttpError('execution-runtime-mismatch', 'runtime')
    await broker!.adopt(record.lease, observed.runtime)
    knownBrokerLeases.add(record.lease.leaseId)
    const config = readChildConfig(record.configFile)
    writePrivateAtomic(record.configFile, JSON.stringify({ ...config, controllerPort: port, controllerKey: randomBytes(32).toString('hex') }) + '\n')
  }
  async function cancelUnstarted(binding:ExecutionSnapshot,authorize:()=>void) {
    authorize();await ensure();authorize();cachedCapability()
    const record=[...runs.values()].find(record=>!record.proof&&record.state==='starting'&&isDeepStrictEqual(record.lease.request.binding,binding))
    if(!record||!current(record.lease.request)||!o.host?.cancelManaged)throw executionHttpError('execution-runtime-mismatch','runtime')
    await o.host.cancelManaged(binding,record.runId,()=>{authorize();if(!current(record.lease.request))throw executionHttpError('execution-stale','runtime')})
    const deadline=Date.now()+15000
    while(Date.now()<deadline){
      const observed=await observe(record.lease.request)
      if(observed.state==='ended'){await retirementWork.reconcile();return}
      await wait(250)
    }
    throw executionHttpError('execution-intent-uncertain','runtime')
  }
  /** Read-only, for the Dependencies page (F-165): whether this PC was set up, whether its setup check is
   * current and for this build, and how the last start-up went. No provider, native or credential call. */
  function status(): BridgeStatus {
    let saved: { verifiedAt: string | null; adapter: string | null } | null = null
    const file = path.join(o.directory, 'capability.json')
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
        saved = { verifiedAt: typeof raw?.endpointProof?.verifiedAt === 'string' ? raw.endpointProof.verifiedAt : null,
          adapter: typeof raw?.pins?.adapterSha256 === 'string' ? raw.pins.adapterSha256 : null }
      }
    } catch { saved = { verifiedAt: null, adapter: null } }
    let digest: string | null = null
    try { digest = createHash('sha256').update(PIN_FILES.map(name => hash(path.join(import.meta.dirname, name))).join(':')).digest('hex') } catch { /* Unreadable: unknown. */ }
    return { setUp: saved !== null, started: closed ? 'closed' : startedOk ? 'ok' : initialization ? 'starting' : lastStartFailure ? 'failed' : 'idle',
      failure: startedOk ? null : lastStartFailure, verifiedAt: saved?.verifiedAt ?? null,
      forThisBuild: saved?.adapter && digest ? saved.adapter === digest : null }
  }
  return { ensure, verify, start, observe, broker, cachedCapability, matches, ended, adopt, cancelUnstarted, status,
    get storage() { return storage },
    close() { closed = true; clearInterval(cleanupTimer); clearInterval(renewTimer); clearTimeout(firstRenew); retirementWork.close(); ownership.close();unstarted.invalidate(); hostLifetime.abort(); lifetime.abort(); server?.closeAllConnections(); server?.close(); binaryPin?.close(); storage?.close() } }
}

function unstartedProcesses(names:readonly string[]):Promise<UnstartedProcess[]> {
  if(names.some(name=>!/^[-A-Za-z0-9._]+\.exe$/i.test(name)))return Promise.reject(Error('Managed process identity is unavailable'))
  const filter=[...new Set(names)].map(name=>`Name='${name}'`).join(' OR ')
  const script=`@(Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction Stop | ForEach-Object {@{pid=[int]$_.ProcessId;command=$_.CommandLine}}) | ConvertTo-Json -Compress`
  return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {encoding:'utf8',timeout:8000,windowsHide:true,maxBuffer:1024*1024},(error,stdout)=>{
      if(error)return reject(Error('Managed start end is unconfirmed'))
      try{const value=JSON.parse(stdout||'[]');const rows=Array.isArray(value)?value:[value];if(rows.some(row=>!row||typeof row!=='object'))throw Error();resolve(rows)}catch{reject(Error('Managed start end is unconfirmed'))}
    }))
}

interface ObservedProcess { pid: number; ppid: number; created: number; file: string; command: string }
function processes(proxy: number, child: number, host: number, port: number): Promise<{ rows: ObservedProcess[]; listener: boolean }> {
  for (const value of [proxy, child, host, port]) if (!Number.isSafeInteger(value) || value <= 0) return Promise.reject(new Error('Invalid process observation'))
  const script = `$r=@(Get-CimInstance Win32_Process -Filter 'ProcessId=${proxy} OR ProcessId=${child} OR ProcessId=${host}' | ForEach-Object {@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds();file=$_.ExecutablePath;command=$_.CommandLine}});@{rows=$r} | ConvertTo-Json -Depth 4 -Compress`
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error('Physical runtime ownership is unavailable'))
      try { resolve({ ...JSON.parse(stdout), listener: ownsLoopbackListener(proxy,port) }) } catch { reject(new Error('Physical runtime ownership is invalid')) }
    }))
}
