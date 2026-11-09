// Durable, bounded write-ahead journal. An app-owned exclusive writer/storage admission is required.
// No floor write, process launch, provider call or credential read occurs in this module.
import { createHash } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { assertExecutionCAS, assertPreparedExecution, contractRecord, requireExecutionSnapshot, sameExecution,
  type ExecutionSnapshot } from '../../shared/chat-execution.ts'
import { CAPABILITY_TTL_MS, executionHttpError, executionId, executionIntentId, executionRuntimeSummary, executionTime,
  requireExecutionSelectionRequest, type ExecutionHttpCode, type ExecutionRuntimeSummary,
  type ExecutionSelectionRequest } from '../../shared/chat-execution-http.ts'
import { requireCodexBridgeLease, type CodexBridgeLease } from '../codex-claude/contract.ts'

export interface ExecutionIntentScope {
  readonly actorId: string
  readonly ownerId: string
  readonly floorId: string
  readonly agentId: string
  readonly targetPcId: string
}
export function requireIntentScope(value: unknown): ExecutionIntentScope {
  const keys = ['actorId', 'ownerId', 'floorId', 'agentId', 'targetPcId'] as const
  if (!contractRecord(value) || Object.keys(value).length !== keys.length || keys.some(k => !executionId(value[k]))) throw executionHttpError('execution-forbidden', 'authorization')
  return Object.freeze({ actorId: value.actorId as string, ownerId: value.ownerId as string, floorId: value.floorId as string,
    agentId: value.agentId as string, targetPcId: value.targetPcId as string })
}
export const executionDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const scopeDigest = (scope: ExecutionIntentScope): string => executionDigest(requireIntentScope(scope))
export function selectionFingerprint(scope: ExecutionIntentScope, request: ExecutionSelectionRequest): string {
  return executionDigest({ scope: requireIntentScope(scope), request: requireExecutionSelectionRequest(request) })
}

/** Persist this stamp atomically INSIDE the authoritative floor document with binding and lineage. */
export interface ExecutionCommitStamp {
  readonly selectionIntentId: string
  readonly openIntentId: string
  readonly scopeDigest: string
  readonly fingerprint: string
}
interface CommonIntent {
  readonly id: string
  readonly scope: ExecutionIntentScope
  readonly fingerprint: string
  readonly revision: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly retainUntilMs: number
  readonly reason?: ExecutionHttpCode
}
export interface SelectionIntent extends CommonIntent {
  readonly kind: 'selection'
  readonly state: 'reserved' | 'prepared' | 'committed' | 'refused' | 'uncertain'
  readonly request: ExecutionSelectionRequest
  readonly plan?: Readonly<{ binding: ExecutionSnapshot; stamp: ExecutionCommitStamp; runId: string }>
}
export interface OpenIntent extends CommonIntent {
  readonly kind: 'open'
  readonly state: 'ready' | 'starting' | 'running' | 'stopped' | 'refused' | 'uncertain'
  readonly selectionIntentId: string
  readonly binding: ExecutionSnapshot
  readonly runId: string
  readonly dimensions?: Readonly<{ cols: number | null; rows: number | null }>
  readonly lease?: CodexBridgeLease
  readonly actual?: ExecutionRuntimeSummary
}
export type ExecutionIntent = SelectionIntent | OpenIntent
export interface ExecutionLedgerOptions {
  directory: string
  /** Must establish owner-only storage, including OS ACLs. chmod alone is insufficient on Windows. */
  assertPrivateStorage(directory: string): Promise<void>
  /** Existing app/leader fencing, not a PID-only or time-based lock. Checked around every I/O await. */
  assertExclusiveWriter(): void
  /** Platform durability hook; must flush directory metadata after create/atomic replacement. */
  syncDirectory(directory: string): Promise<void>
  now?: () => number
  maxEntries?: number
  maxBytes?: number
  retentionMs?: number
}
interface JournalFrame { version: 1; sequence: number; previous: string; checkpoint: boolean; entries: ExecutionIntent[]; checksum: string }
const GENESIS = '0'.repeat(64)
const terminal = (entry: ExecutionIntent) => entry.state === 'stopped' || entry.state === 'refused'
const uncertain = (): never => { throw executionHttpError('execution-intent-uncertain', 'status') }
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const journalKey = (scope: ExecutionIntentScope, id: string) => `${scopeDigest(scope)}:${id}`
const frameText = (sequence: number, previous: string, checkpoint: boolean, entries: readonly ExecutionIntent[]) => {
  const frame = { version: 1, sequence, previous, checkpoint, entries }
  return JSON.stringify({ ...frame, checksum: executionDigest(frame) }) + '\n'
}

export class ExecutionIntentLedger {
  private entries = new Map<string, ExecutionIntent>()
  private sequence = 0
  private checksum = GENESIS
  private bytes = 0
  private poisoned = false
  private closed = false
  private queue: Promise<unknown> = Promise.resolve()
  private readonly options: Required<ExecutionLedgerOptions>
  readonly journalPath: string

  private constructor(options: ExecutionLedgerOptions) {
    this.options = { ...options, now: options.now ?? Date.now, maxEntries: options.maxEntries ?? 2048,
      maxBytes: options.maxBytes ?? 8 * 1024 * 1024, retentionMs: options.retentionMs ?? 24 * 60 * 60 * 1000 }
    this.journalPath = path.join(options.directory, 'execution-intents.wal')
  }
  static async open(options: ExecutionLedgerOptions): Promise<ExecutionIntentLedger> {
    const ledger = new ExecutionIntentLedger(options)
    if (!path.isAbsolute(options.directory) || ledger.options.maxEntries < 2 || !Number.isSafeInteger(ledger.options.maxEntries)
      || !Number.isSafeInteger(ledger.options.maxBytes) || ledger.options.maxBytes < 4096
      || !Number.isSafeInteger(ledger.options.retentionMs) || ledger.options.retentionMs < CAPABILITY_TTL_MS * 2) return uncertain()
    ledger.check()
    const dir = await lstat(options.directory)
    ledger.check()
    if (!dir.isDirectory() || dir.isSymbolicLink()) return uncertain()
    await options.assertPrivateStorage(options.directory)
    ledger.check()
    let exists = true
    try {
      const stat = await lstat(ledger.journalPath)
      ledger.check()
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ledger.options.maxBytes) return uncertain()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      exists = false
    }
    if (!exists) {
      const handle = await open(ledger.journalPath, 'wx', 0o600)
      try { ledger.check(); await handle.sync(); ledger.check() } finally { await handle.close() }
      await options.syncDirectory(options.directory)
      ledger.check()
    }
    await options.assertPrivateStorage(options.directory)
    ledger.check()
    const bytes = await readFile(ledger.journalPath)
    ledger.check()
    ledger.replay(bytes)
    await ledger.recoverStaging(bytes)
    ledger.check()
    return ledger
  }
  /** Only a complete, checksummed checkpoint of this exact authoritative state is known staging.
   * Unknown, partial, oversized or linked evidence is retained and refused under the exclusive writer. */
  private async recoverStaging(authoritative: Buffer): Promise<void> {
    const temporary = this.journalPath + '.next'
    let before
    try { before = await lstat(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.check(); return }
      throw error
    }
    this.check()
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size === 0 || before.size > this.options.maxBytes) return uncertain()
    await this.options.assertPrivateStorage(this.options.directory); this.check()
    const bytes = await readFile(temporary); this.check()
    const staged = new ExecutionIntentLedger(this.options)
    staged.replay(bytes)
    if (staged.sequence !== 1) return uncertain()
    let frame: JournalFrame
    try { frame = JSON.parse(bytes.toString('utf8')) } catch { return uncertain() }
    if (!frame.checkpoint) return uncertain()
    for (const [key, entry] of staged.entries) {
      const current = this.entries.get(key)
      if (!current || executionDigest(current) !== executionDigest(entry)) return uncertain()
    }
    const now = this.options.now()
    for (const [key, entry] of this.entries) {
      const child = entry.kind === 'selection' && entry.plan ? this.entries.get(journalKey(entry.scope, entry.plan.stamp.openIntentId)) : null
      const discardable = entry.retainUntilMs <= now && (terminal(entry)
        || (entry.kind === 'selection' && entry.state === 'committed' && child && terminal(child) && child.retainUntilMs <= now))
      if (!staged.entries.has(key) && !discardable) return uncertain()
    }
    const main = await readFile(this.journalPath); this.check()
    if (!main.equals(authoritative)) return uncertain()
    const after = await lstat(temporary); this.check()
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return uncertain()
    await this.options.assertPrivateStorage(this.options.directory); this.check()
    await unlink(temporary); this.check()
    await this.options.syncDirectory(this.options.directory); this.check()
  }
  private check(): void {
    if (this.closed || this.poisoned) return uncertain()
    this.options.assertExclusiveWriter()
    if (!executionTime(this.options.now())) return uncertain()
  }
  private serial<T>(use: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(() => { this.check(); return use() })
    this.queue = operation.catch(() => {})
    return operation
  }
  private replay(bytes: Buffer): void {
    if (bytes.length > this.options.maxBytes || (bytes.length > 0 && bytes[bytes.length - 1] !== 10)) return uncertain()
    const text = bytes.toString('utf8')
    if (Buffer.from(text, 'utf8').compare(bytes) !== 0) return uncertain()
    for (const line of text.split('\n').filter(Boolean)) {
      let value: unknown
      try { value = JSON.parse(line) } catch { return uncertain() }
      if (!contractRecord(value) || Object.keys(value).sort().join(',') !== 'checkpoint,checksum,entries,previous,sequence,version'
        || value.version !== 1 || value.sequence !== this.sequence + 1 || value.previous !== this.checksum
        || !Array.isArray(value.entries) || typeof value.checkpoint !== 'boolean' || (value.checkpoint && this.sequence !== 0)) return uncertain()
      const frame = value as unknown as JournalFrame
      if (frame.checksum !== executionDigest({ version: frame.version, sequence: frame.sequence, previous: frame.previous, checkpoint: frame.checkpoint, entries: frame.entries })) return uncertain()
      for (const entry of frame.entries) {
        this.validate(entry)
        const key = journalKey(entry.scope, entry.id), prior = this.entries.get(key)
        if (prior && (entry.revision !== prior.revision + 1 || entry.fingerprint !== prior.fingerprint || entry.kind !== prior.kind)) return uncertain()
        if (!prior && !frame.checkpoint && entry.revision !== 1) return uncertain()
        this.entries.set(key, freeze(entry))
      }
      if (this.entries.size > this.options.maxEntries) return uncertain()
      this.sequence = frame.sequence; this.checksum = frame.checksum
    }
    this.bytes = bytes.length
  }
  private validate(entry: ExecutionIntent): void {
    if (!contractRecord(entry) || !executionIntentId(entry.id) || !executionTime(entry.createdAtMs) || !executionTime(entry.updatedAtMs)
      || !executionTime(entry.retainUntilMs) || !Number.isSafeInteger(entry.revision) || entry.revision < 1
      || entry.updatedAtMs < entry.createdAtMs || entry.retainUntilMs <= entry.createdAtMs || !/^[a-f0-9]{64}$/.test(entry.fingerprint)) return uncertain()
    const scope = requireIntentScope(entry.scope)
    if (entry.kind === 'selection') {
      const request = requireExecutionSelectionRequest(entry.request)
      if (request.selectionIntentId !== entry.id || request.expected.agentId !== scope.agentId
        || request.expected.homePc !== scope.targetPcId || selectionFingerprint(scope, request) !== entry.fingerprint
        || !['reserved', 'prepared', 'committed', 'refused', 'uncertain'].includes(entry.state)) return uncertain()
      if (entry.plan) {
        const plan = entry.plan
        const binding = requireExecutionSnapshot(plan.binding)
        if (binding.agentId !== scope.agentId || binding.homePc !== scope.targetPcId || !binding.sessionId || !sameExecution(binding.execution, request.target)
          || !executionIntentId(plan.runId) || !executionIntentId(plan.stamp.openIntentId) || plan.stamp.selectionIntentId !== entry.id
          || plan.stamp.scopeDigest !== scopeDigest(scope) || plan.stamp.fingerprint !== entry.fingerprint) return uncertain()
      } else if (entry.state === 'prepared' || entry.state === 'committed') return uncertain()
    } else if (entry.kind === 'open') {
      const binding = requireExecutionSnapshot(entry.binding)
      if (!executionIntentId(entry.selectionIntentId) || !executionIntentId(entry.runId) || binding.homePc !== scope.targetPcId
        || binding.agentId !== scope.agentId || !binding.sessionId || !['ready', 'starting', 'running', 'stopped', 'refused', 'uncertain'].includes(entry.state)) return uncertain()
      if (entry.lease) requireCodexBridgeLease(entry.lease, { ownerId: scope.ownerId, runId: entry.runId, targetPcId: scope.targetPcId, binding })
      if (entry.dimensions && ['cols', 'rows'].some(k => {
        const size = entry.dimensions![k as 'cols' | 'rows']
        return size !== null && (!Number.isInteger(size) || size < 1 || size > 1000)
      })) return uncertain()
      if (entry.actual) {
        assertExecutionCAS(binding, entry.actual.binding)
        const safe = executionRuntimeSummary(binding, entry.runId, scope.targetPcId, entry.actual.verifiedAtMs)
        if (executionDigest(safe) !== executionDigest(entry.actual)) return uncertain()
      }
      if (entry.state === 'running' && !entry.actual) return uncertain()
    } else return uncertain()
  }
  private async persist(entries: ExecutionIntent[]): Promise<void> {
    this.check()
    for (const entry of entries) this.validate(entry)
    let text = frameText(this.sequence + 1, this.checksum, false, entries)
    if (this.bytes + Buffer.byteLength(text) > this.options.maxBytes) {
      await this.compactInternal()
      text = frameText(this.sequence + 1, this.checksum, false, entries)
    }
    const newKeys = entries.filter(e => !this.entries.has(journalKey(e.scope, e.id))).length
    if (this.entries.size + newKeys > this.options.maxEntries || this.bytes + Buffer.byteLength(text) > this.options.maxBytes) throw executionHttpError('execution-ledger-full', 'selection')
    try {
      this.check()
      const handle = await open(this.journalPath, 'a')
      try { this.check(); await handle.writeFile(text, 'utf8'); this.check(); await handle.sync(); this.check() } finally { await handle.close() }
      this.check()
      const frame = JSON.parse(text) as JournalFrame
      this.sequence = frame.sequence; this.checksum = frame.checksum; this.bytes += Buffer.byteLength(text)
      for (const entry of entries) this.entries.set(journalKey(entry.scope, entry.id), freeze(clone(entry)))
    } catch { this.poisoned = true; return uncertain() }
  }
  private async compactInternal(): Promise<void> {
    this.check()
    const now = this.options.now()
    const kept = [...this.entries.values()].filter(entry => {
      if (entry.retainUntilMs > now) return true
      if (terminal(entry)) return false
      if (entry.kind === 'selection' && entry.state === 'committed' && entry.plan) {
        const child = this.entries.get(journalKey(entry.scope, entry.plan.stamp.openIntentId))
        return !child || !terminal(child) || child.retainUntilMs > now
      }
      return true // No eviction of pending, ready, running or uncertain operations.
    })
    const text = frameText(1, GENESIS, true, kept)
    if (Buffer.byteLength(text) > this.options.maxBytes) throw executionHttpError('execution-ledger-full', 'selection')
    const temporary = this.journalPath + '.next'
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { this.check(); await handle.writeFile(text, 'utf8'); this.check(); await handle.sync(); this.check() } finally { await handle.close() }
      await this.options.assertPrivateStorage(this.options.directory); this.check()
      await rename(temporary, this.journalPath); this.check()
      await this.options.syncDirectory(this.options.directory); this.check()
      const frame = JSON.parse(text) as JournalFrame
      this.entries = new Map(kept.map(entry => [journalKey(entry.scope, entry.id), entry]))
      this.sequence = 1; this.checksum = frame.checksum; this.bytes = Buffer.byteLength(text)
    } catch { this.poisoned = true; return uncertain() }
  }
  get(scope: ExecutionIntentScope, id: string): ExecutionIntent | null {
    this.check()
    if (!executionIntentId(id)) throw executionHttpError('execution-invalid', 'status')
    return this.entries.get(journalKey(requireIntentScope(scope), id)) ?? null
  }
  /** Backend-only observation candidates. Other actors, owners, PCs and agents stay fenced. */
  uncertainOpenIds(scope: ExecutionIntentScope): readonly string[] {
    this.check()
    const digest = scopeDigest(requireIntentScope(scope))
    return [...this.entries.values()].filter(entry => entry.kind === 'open' && entry.state === 'uncertain'
      && scopeDigest(entry.scope) === digest).map(entry => entry.id)
  }
  reserveSelection(scopeValue: ExecutionIntentScope, value: ExecutionSelectionRequest, admitUntilMs: number): Promise<{ created: boolean; record: SelectionIntent }> {
    return this.serial(async () => {
      const scope = requireIntentScope(scopeValue), request = requireExecutionSelectionRequest(value)
      const prior = this.get(scope, request.selectionIntentId), fingerprint = selectionFingerprint(scope, request)
      if (prior) {
        if (prior.kind !== 'selection' || prior.fingerprint !== fingerprint) throw executionHttpError('execution-intent-conflict', 'selection', request.selectionIntentId)
        return { created: false, record: prior }
      }
      const now = this.options.now()
      if (!executionTime(admitUntilMs) || admitUntilMs <= now || admitUntilMs > now + CAPABILITY_TTL_MS) throw executionHttpError('execution-intent-expired', 'selection', request.selectionIntentId)
      // An uncertain prior run/selection fences new IDs as well as retries of the original ID.
      for (const active of this.entries.values()) {
        if (active.scope.floorId === scope.floorId && active.scope.agentId === scope.agentId
          && ((active.kind === 'selection' && ['reserved', 'prepared', 'uncertain'].includes(active.state))
            || (active.kind === 'open' && ['starting', 'uncertain'].includes(active.state)))) throw executionHttpError('execution-intent-uncertain', 'selection', request.selectionIntentId)
      }
      await this.compactIfNeeded()
      if (this.entries.size + 2 > this.options.maxEntries) throw executionHttpError('execution-ledger-full', 'selection')
      const record: SelectionIntent = { kind: 'selection', id: request.selectionIntentId, scope, fingerprint, request,
        state: 'reserved', revision: 1, createdAtMs: now, updatedAtMs: now, retainUntilMs: now + this.options.retentionMs }
      await this.persist([record])
      return { created: true, record: this.get(scope, record.id) as SelectionIntent }
    })
  }
  private async compactIfNeeded(): Promise<void> {
    if (this.entries.size + 2 > this.options.maxEntries || this.bytes > this.options.maxBytes / 2) await this.compactInternal()
  }
  private current<T extends ExecutionIntent>(expected: T): T {
    const current = this.get(expected.scope, expected.id)
    if (!current || current.revision !== expected.revision || current.kind !== expected.kind || current.fingerprint !== expected.fingerprint) throw executionHttpError('execution-intent-conflict', 'status', expected.id)
    return current as T
  }
  stageSelection(expected: SelectionIntent, bindingValue: ExecutionSnapshot, openIntentId: string, runId: string): Promise<SelectionIntent> {
    return this.serial(async () => {
      const current = this.current(expected), binding = requireExecutionSnapshot(bindingValue)
      if (current.state !== 'reserved' || !executionIntentId(openIntentId) || !executionIntentId(runId) || this.get(current.scope, openIntentId)
        || [...this.entries.values()].some(entry => entry.kind === 'open' && entry.runId === runId)) throw executionHttpError('execution-intent-conflict', 'selection', current.id)
      if (sameExecution(current.request.expected.execution, current.request.target) && !current.request.rebuildHistory) assertExecutionCAS(current.request.expected, binding)
      else assertPreparedExecution(current.request.expected, { binding, sourceSessionId: current.request.expected.sessionId,
        recordedAt: new Date(this.options.now()).toISOString() }, current.scope.targetPcId, current.request.target)
      const stamp: ExecutionCommitStamp = { selectionIntentId: current.id, openIntentId, scopeDigest: scopeDigest(current.scope), fingerprint: current.fingerprint }
      const updated: SelectionIntent = { ...current, revision: current.revision + 1, updatedAtMs: this.options.now(), state: 'prepared', plan: { binding, stamp, runId } }
      const child: OpenIntent = { kind: 'open', id: openIntentId, scope: current.scope, fingerprint: executionDigest({ stamp, binding, runId }),
        selectionIntentId: current.id, binding, runId, revision: 1, createdAtMs: updated.updatedAtMs, updatedAtMs: updated.updatedAtMs,
        retainUntilMs: current.retainUntilMs, state: 'ready' }
      await this.persist([updated, child])
      return this.get(current.scope, current.id) as SelectionIntent
    })
  }
  commitSelection(expected: SelectionIntent): Promise<SelectionIntent> {
    return this.serial(async () => {
      const current = this.current(expected)
      if (!current.plan || !['prepared', 'uncertain'].includes(current.state)) throw executionHttpError('execution-intent-conflict', 'selection', current.id)
      const updated: SelectionIntent = { ...current, state: 'committed', revision: current.revision + 1, updatedAtMs: this.options.now() }
      delete (updated as { reason?: ExecutionHttpCode }).reason
      await this.persist([updated]); return this.get(current.scope, current.id) as SelectionIntent
    })
  }
  claimOpen(expected: OpenIntent, cols?: number, rows?: number): Promise<OpenIntent> {
    return this.serial(async () => {
      const current = this.current(expected)
      if (current.state !== 'ready') throw executionHttpError('execution-intent-uncertain', 'open', current.id)
      const parent = this.get(current.scope, current.selectionIntentId)
      if (parent?.kind !== 'selection' || parent.state !== 'committed' || parent.plan?.stamp.openIntentId !== current.id) throw executionHttpError('execution-intent-uncertain', 'open', current.id)
      const updated: OpenIntent = { ...current, state: 'starting', dimensions: { cols: cols ?? null, rows: rows ?? null },
        revision: current.revision + 1, updatedAtMs: this.options.now() }
      await this.persist([updated]); return this.get(current.scope, current.id) as OpenIntent
    })
  }
  recordLease(expected: OpenIntent, lease: CodexBridgeLease): Promise<OpenIntent> {
    return this.serial(async () => {
      const current = this.current(expected)
      if (current.state !== 'starting' || current.lease) throw executionHttpError('execution-intent-conflict', 'open', current.id)
      const validated = requireCodexBridgeLease(lease, { ownerId: current.scope.ownerId, runId: current.runId, targetPcId: current.scope.targetPcId, binding: current.binding })
      await this.persist([{ ...current, lease: validated, revision: current.revision + 1, updatedAtMs: this.options.now() }])
      return this.get(current.scope, current.id) as OpenIntent
    })
  }
  markRunning(expected: OpenIntent, actual: ExecutionRuntimeSummary): Promise<OpenIntent> {
    return this.serial(async () => {
      const current = this.current(expected)
      if (!['starting', 'uncertain', 'running'].includes(current.state)) throw executionHttpError('execution-intent-conflict', 'runtime', current.id)
      const updated: OpenIntent = { ...current, state: 'running', actual, revision: current.revision + 1, updatedAtMs: this.options.now() }
      delete (updated as { reason?: ExecutionHttpCode }).reason
      await this.persist([updated]); return this.get(current.scope, current.id) as OpenIntent
    })
  }
  markUnavailable<T extends ExecutionIntent>(expected: T, state: 'uncertain' | 'refused' | 'stopped', reason: ExecutionHttpCode): Promise<T> {
    return this.serial(async () => {
      const current = this.current(expected)
      if ((current.kind === 'selection' && (state === 'stopped' || current.state === 'committed'))
        || terminal(current) || (state === 'refused' && !['reserved', 'ready'].includes(current.state)
          && !(current.kind === 'selection' && current.state === 'uncertain' && !current.plan))) throw executionHttpError('execution-intent-conflict', 'status', current.id)
      const updated = { ...current, state, reason, revision: current.revision + 1, updatedAtMs: this.options.now() } as T
      delete (updated as { actual?: ExecutionRuntimeSummary }).actual
      await this.persist([updated]); return this.get(current.scope, current.id) as T
    })
  }
  compact(): Promise<void> { return this.serial(() => this.compactInternal()) }
  close(): Promise<void> { return this.serial(async () => { this.closed = true }) }
}
