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
import { fromResponses, messagesEvents, providerFailureSummary, sendResponses, toResponses } from './adapter.ts'
import { assertPrivatePath, openExecutionStorage, writePrivateAtomic } from './storage.ts'
import { readChildConfig, type BridgeChildConfig } from './child.ts'
import { probeClaudeHarness } from './probe.ts'
import { BridgeOwnership, BridgeRetirementWork } from './ownership.ts'

const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const safeId = (id: string) => /^[A-Za-z0-9_-]{16,128}$/.test(id)
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
interface RunRecord {
  version: 1; runId: string; lease: CodexBridgeLease; pins: BridgeRuntimePins; configFile: string;
  state: 'starting' | 'running' | 'ended' | 'released'; proof?: BridgeActualRuntimeProof;
  dispatchPaused?: boolean;
}
export interface BridgeRuntimeOptions {
  directory: string; manager: CodexManager | null; host: ChatHostLink | null;
  self(): { id: string; name: string };
  current(request: BridgeLeaseRequest): boolean;
  launch(request: ExecutionStartRequest): Omit<StartChat, 'bridge'>;
  pool(): ChatPool;
  memorySettings?: string;
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
  let initialization: Promise<void> | null = null
  const ownership = new BridgeOwnership(() => {
    if (closed || !o.host?.current) throw executionHttpError('execution-runtime-mismatch', 'runtime')
    return o.host.current()
  })
  o.host?.onLost(() => { ownership.invalidate(); hostLifetime.abort() })
  o.host?.onBack(() => { if (!closed) hostLifetime = new AbortController() })
  const cleanupTimer = setInterval(() => { void retirementWork.reconcile() }, 1000)
  cleanupTimer.unref()
  const recordFile = (id: string) => { if (!safeId(id)) throw executionHttpError('execution-invalid', 'runtime'); return path.join(o.directory, `${id}.run.json`) }
  const save = (record: RunRecord) => writePrivateAtomic(recordFile(record.runId), JSON.stringify(record) + '\n')
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
        if (!record.proof) throw executionHttpError('execution-intent-uncertain', 'runtime')
        ownership.released(record.lease, record.proof)
      } else o.manager?.bridgeCredentials.protect(record.lease.leaseId)
      // Keep completed tombstones across restart, without re-protecting or adopting their consumers.
      runs.set(record.runId, record)
    }
  }
  const broker = o.manager ? createCodexBridgeCredentialBroker({ source: o.manager.bridgeCredentials, currentBinding: current,
    observeRuntime: observe,
    canRetire: (lease, observation) => {
      const record = runs.get(lease.request.runId)
      return !!record?.proof && ownership.canRetire(lease, record.proof, observation)
    },
  }) : null

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
    const ch = host.chats.find(chat => chat.id === record.lease.request.binding.sessionId)
    if (!ch || ch.meta.bridgeRunId !== record.runId || !isDeepStrictEqual(ch.meta.execution, record.lease.request.binding)) return { state: 'unknown' }
    if (ch.exited) {
      if (!record.proof) return { state: 'unknown' }
      const table = await processes(record.proof.proxy.pid, record.proof.claude.pid, host.hostPid, record.proof.listener.port)
      ownership.fence(epoch)
      if (table.rows.some(p => (p.pid === record.proof!.proxy.pid && p.created === record.proof!.proxy.createdAtMs)
        || (p.pid === record.proof!.claude.pid && p.created === record.proof!.claude.createdAtMs)) || table.listener) return { state: 'unknown' }
      const retired = ownership.ended(record.lease, record.proof, epoch)
      record.state = 'ended'; save(record); queueRetirement(record)
      return retired
    }
    const config = readChildConfig(record.configFile)
    assertPrivatePath(config.readyFile); assertPrivatePath(config.settingsFile)
    const ready = JSON.parse(fs.readFileSync(config.readyFile, 'utf8'))
    if (ready.version !== 1 || ready.runId !== record.runId || ready.leaseId !== record.lease.leaseId || ready.proxyPid !== ch.pid
      || !Number.isSafeInteger(ready.claudePid) || !Number.isSafeInteger(ready.port) || ready.port < 1 || ready.port > 65535) return { state: 'unknown' }
    const observed = await processes(ch.pid, ready.claudePid, host.hostPid, ready.port)
    ownership.fence(epoch)
    const proxy = observed.rows.find(p => p.pid === ch.pid), child = observed.rows.find(p => p.pid === ready.claudePid), hostProc = observed.rows.find(p => p.pid === host.hostPid)
    if (!proxy || !child || !hostProc || !observed.listener || child.ppid !== proxy.pid || child.created < proxy.created
      || Math.abs(proxy.created - Date.parse(String(ch.meta.startedAt))) > 10_000 || Math.abs(hostProc.created - host.hostStartedAt) > 10_000
      || path.resolve(proxy.file).toLowerCase() !== path.resolve(process.execPath).toLowerCase()
      || path.resolve(child.file).toLowerCase() !== path.resolve(config.claude).toLowerCase()
      || !proxy.command.includes(record.configFile) || !proxy.command.includes(path.join(import.meta.dirname, 'child.ts'))
      || config.claudeSha256 !== hash(config.claude) || !isDeepStrictEqual(record.pins, pins)) return { state: 'unknown' }
    const execution = normalizeExecution({ engine: 'claude', executionProfile: CODEX_IN_CLAUDE_PROFILE })
    const proof: BridgeActualRuntimeProof = { version: 1, runId: record.runId, ownerId: record.lease.request.ownerId,
      targetPcId: o.self().id, leaseId: record.lease.leaseId, binding: record.lease.request.binding, execution: execution as BridgeActualRuntimeProof['execution'], pins,
      policy: { model: BRIDGE_MODEL, effort: BRIDGE_EFFORT, allRequestPurposes: true },
      proxy: { pid: proxy.pid, createdAtMs: proxy.created }, claude: { pid: child.pid, createdAtMs: child.created },
      listener: { host: '127.0.0.1', port: ready.port, authentication: 'per-child-bearer-v1' },
      settings: { ownerId: record.lease.request.ownerId, access: 'owner-only', scope: 'child-only' } }
    if (record.proof && (!isDeepStrictEqual(record.proof.proxy, proof.proxy) || !isDeepStrictEqual(record.proof.claude, proof.claude))) return { state: 'unknown' }
    requireBridgeRuntimeProof(proof, record.lease, record.lease.request, capability, pins, Date.now())
    ownership.admit(record.lease, proof, epoch)
    if (!record.proof) { record.proof = proof; record.state = 'running'; save(record) }
    return { state: 'running', runtime: proof }
  }
  async function observe(request: BridgeLeaseRequest): Promise<BridgeOwnerObservation> {
    const record = runs.get(request.runId)
    if (!record || !isDeepStrictEqual(record.lease.request, request)) return { state: 'unknown' }
    try {
      if (record.state === 'released') return record.proof ? ownership.released(record.lease, record.proof) : { state: 'unknown' }
      const observed = await physical(record)
      if (observed.state === 'unknown') ownership.invalidate(record.runId)
      return observed
    } catch { ownership.invalidate(record.runId); return { state: 'unknown' } }
  }
  async function initialize() {
    if (closed || !o.host?.inspect || !o.host.current || !o.manager || process.platform !== 'win32' || process.arch !== 'x64') throw executionHttpError('execution-capability-required', 'runtime')
    storage = await openExecutionStorage(o.directory)
    claude = findClaude()
    const codex = findCodex()
    if (!claude || !/\.exe$/i.test(claude) || !codex || codex.version !== '0.163.0' || process.versions.node !== '24.22.1') throw executionHttpError('execution-capability-required', 'runtime')
    const version = spawnSync(claude, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    if (version.status !== 0 || parseVersion(version.stdout) !== '2.1.319') throw executionHttpError('execution-capability-required', 'runtime')
    claudeHash = hash(claude)
    await o.host.inspect()
    o.host.current()
    pins = { platform: 'win32', arch: 'x64', nodeVersion: process.versions.node, claudeVersion: '2.1.319', codexVersion: codex.version,
      adapterSha256: createHash('sha256').update(['adapter.ts', 'child.ts', 'runtime.ts', 'storage.ts', 'probe.ts', 'ownership.ts'].map(file => hash(path.join(import.meta.dirname, file))).join(':')).digest('hex') }
    const capFile = path.join(o.directory, 'capability.json')
    if (fs.existsSync(capFile)) { try { assertPrivatePath(capFile); capability = requireBridgeCapability(JSON.parse(fs.readFileSync(capFile, 'utf8')), o.self().id, pins, Date.now()) } catch { capability = null } }
    server = http.createServer((req, res) => { void handleProvider(req, res) })
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', () => resolve()) })
    const address = server.address(); if (!address || typeof address === 'string') throw executionHttpError('execution-capability-required', 'runtime'); port = address.port
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
  function ensure(): Promise<void> { return initialization ??= initialize().catch(error => { server?.close(); storage?.close(); throw error }) }
  async function verify(ownerId: string): Promise<BridgeTargetCapability> {
    await ensure()
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
      return capability
    } finally { await source.release(id) }
  }
  async function start(request: ExecutionStartRequest) {
    if (request.kind !== 'bridge' || !broker) throw executionHttpError('execution-capability-required', 'open')
    await ensure(); cachedCapability()
    if (!current(request.lease.request) || runs.has(request.runId)) throw executionHttpError('execution-stale', 'open')
    for (const old of runs.values()) if (old.lease.request.binding.sessionId === request.binding.sessionId && old.state !== 'released') {
      const observed = await observe(old.lease.request)
      if (observed.state === 'unknown') throw executionHttpError('execution-intent-uncertain', 'open')
      if (observed.state === 'running') { o.pool().kill(request.binding.sessionId!, 'bridge-resume'); await o.pool().waitStopped?.(request.binding.sessionId!) }
      const ended = await observe(old.lease.request)
      if (ended.state !== 'ended') throw executionHttpError('execution-intent-uncertain', 'open')
      queueRetirement(old); await retirementWork.reconcile()
      if (runs.get(old.runId)?.state !== 'released') throw executionHttpError('execution-intent-uncertain', 'open')
    }
    const configFile = path.join(o.directory, `${request.runId}.child.json`)
    const config: BridgeChildConfig = { version: 1, runId: request.runId, ownerId: request.scope.ownerId, leaseId: request.lease.leaseId,
      binding: request.binding, claude: claude!, claudeSha256: claudeHash!, controllerPort: port, controllerKey: randomBytes(32).toString('hex'), loopbackKey: randomBytes(32).toString('hex'),
      settingsFile: path.join(o.directory, `${request.runId}.settings.json`), readyFile: path.join(o.directory, `${request.runId}.ready.json`), memorySettings: o.memorySettings }
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
    const currentHash = createHash('sha256').update(['adapter.ts', 'child.ts', 'runtime.ts', 'storage.ts', 'probe.ts', 'ownership.ts'].map(file => hash(path.join(import.meta.dirname, file))).join(':')).digest('hex')
    if (currentHash !== pins.adapterSha256 || !claude || hash(claude) !== claudeHash) throw executionHttpError('execution-capability-required', 'capability')
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
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, lifetime.signal, hostLifetime.signal, AbortSignal.timeout(180_000)])
      req.on('aborted', () => controller.abort()); res.on('close', () => { if (!res.writableEnded) controller.abort() })
      try {
        const chunks: Buffer[] = []; let bytes = 0
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) return fail(); chunks.push(chunk) }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')), body = toResponses(input)
        if (match[2]) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: Buffer.byteLength(JSON.stringify(body)) })); return }
        const source = o.manager!.bridgeCredentials, context = await source.retain(probe.consumerId, probe.ownerId)
        const response = await source.use(probe.consumerId, context, (authorization, abort) => {
          if (probe.paused) throw executionHttpError('execution-intent-uncertain', 'runtime')
          return sendResponses(body, authorization, abort).catch(error => {
          probe.paused = true
          writePrivateAtomic(path.join(o.directory, 'last-provider-failure.json'), JSON.stringify({ at: new Date().toISOString(), ...providerFailureSummary(error) }) + '\n'); throw error
        }) }, signal)
        let reply: ReturnType<typeof fromResponses>
        try { reply = fromResponses(response) } catch (error) {
          writePrivateAtomic(path.join(o.directory, 'last-provider-failure.json'), JSON.stringify({ at: new Date().toISOString(), ...providerFailureSummary(error) }) + '\n'); throw error
        }
        if (reply.content.some(block => block.type === 'tool_use' && block.name === 'Read')) probe.sawRead = true
        res.writeHead(200, { 'content-type': input.stream ? 'text/event-stream' : 'application/json', 'x-should-retry': 'false' })
        res.end(input.stream ? messagesEvents(reply) : JSON.stringify(reply)); return
      } catch { probe.paused = true; return fail() }
    }
    const record = runs.get(match[1]); if (!record) return fail()
    let config: BridgeChildConfig
    try { config = readChildConfig(record.configFile) } catch { return fail() }
    const key = req.headers.authorization, expected = `Bearer ${config.controllerKey}`
    if (typeof key !== 'string' || Buffer.byteLength(key) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(key), Buffer.from(expected))) return fail()
    if (record.dispatchPaused) return fail()
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, lifetime.signal, hostLifetime.signal, AbortSignal.timeout(180_000)])
    req.on('aborted', () => abort.abort()); res.on('close', () => { if (!res.writableEnded) abort.abort() })
    try {
      const chunks: Buffer[] = []; let size = 0
      for await (const data of req) { size += data.length; if (size > 16 * 1024 * 1024) return fail(); chunks.push(data) }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')), body = toResponses(input)
      if (!current(record.lease.request)) return fail()
      if (match[2]) {
        // Conservative local byte bound, never a generation or a request to a smaller model.
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: Buffer.byteLength(JSON.stringify(body)) })); return
      }
      const sender = dispatch.get(record.runId) ?? (<T>(send: Parameters<NonNullable<typeof broker>['dispatch']>[1], abort?: AbortSignal) => broker.dispatch(record.lease, send, abort) as Promise<T>)
      const response = await sender((authorization, abort) => {
        if (record.dispatchPaused) throw executionHttpError('execution-intent-uncertain', 'runtime')
        if (!record.proof || !current(record.lease.request)) throw executionHttpError('execution-runtime-mismatch', 'runtime')
        ownership.assertRunning(record.lease, record.proof)
        return sendResponses(body, authorization, abort).catch(error => {
          pause(record)
          writePrivateAtomic(path.join(o.directory, 'last-provider-failure.json'), JSON.stringify({ at: new Date().toISOString(), ...providerFailureSummary(error) }) + '\n'); throw error
        })
      }, signal)
      const reply = fromResponses(response)
      if (input.stream === true) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.end(messagesEvents(reply)) }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply)) }
    } catch { pause(record); fail() }
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
      if (observed.state !== 'ended' || !record.proof || !ownership.canRetire(record.lease, record.proof, observed)) return false
      const config = readChildConfig(record.configFile)
      if (knownBrokerLeases.has(record.lease.leaseId)) await broker!.release(record.lease)
      else {
        // Recovery of a saved, already-ended unique consumer: no acquire, refresh or provider adoption.
        // The manager still owns draining, settlement and any native auth writeback.
        await o.manager!.bridgeCredentials.release(record.lease.leaseId, () => {
          if (!record.proof || !ownership.canRetire(record.lease, record.proof, observed)) throw executionHttpError('execution-runtime-mismatch', 'runtime')
        })
      }
      record.state = 'released'; save(record)
      for (const file of [config.settingsFile, config.readyFile, record.configFile]) { try { fs.unlinkSync(file) } catch { /* Only this run's exact private artifacts. */ } }
      ownership.invalidate(record.runId); dispatch.delete(record.runId)
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
  return { ensure, verify, start, observe, broker, cachedCapability, matches, ended, adopt,
    get storage() { return storage },
    close() { closed = true; clearInterval(cleanupTimer); retirementWork.close(); ownership.close(); hostLifetime.abort(); lifetime.abort(); server?.closeAllConnections(); server?.close(); storage?.close() } }
}

interface ObservedProcess { pid: number; ppid: number; created: number; file: string; command: string }
function processes(proxy: number, child: number, host: number, port: number): Promise<{ rows: ObservedProcess[]; listener: boolean }> {
  for (const value of [proxy, child, host, port]) if (!Number.isSafeInteger(value) || value <= 0) return Promise.reject(new Error('Invalid process observation'))
  const script = `$p=@(${proxy},${child},${host});$r=@(Get-CimInstance Win32_Process | Where-Object {$p -contains $_.ProcessId} | ForEach-Object {@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds();file=$_.ExecutablePath;command=$_.CommandLine}});$l=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object {$_.LocalAddress -eq '127.0.0.1' -and $_.OwningProcess -eq ${proxy}});@{rows=$r;listener=($l.Count -eq 1)} | ConvertTo-Json -Depth 4 -Compress`
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error('Physical runtime ownership is unavailable'))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error('Physical runtime ownership is invalid')) }
    }))
}
