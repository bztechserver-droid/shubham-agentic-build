import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { assertExecutionCAS } from '../../shared/chat-execution.ts'
import { executionHttpError } from '../../shared/chat-execution-http.ts'
import { assertPrivatePath, writePrivateAtomic } from '../codex-claude/storage.ts'
import { profileName } from '../codex/home.ts'
import type { CodexManager } from '../codex/index.ts'
import type { ChatHostLink } from '../chathost/link.ts'
import type { ChatPool } from './chats.ts'
import type { ExecutionStartRequest, ExecutionRunObservation } from './execution-coordinator.ts'
import type { OpenIntent } from './execution-intents.ts'

interface NativeProcess { pid: number; ppid: number; created: number; file: string; command: string }
interface NativeRecord {
  version: 1; runId: string; binding: ExecutionStartRequest['binding']; scope: ExecutionStartRequest['scope'];
  startedAt?: string; process?: { pid: number; created: number }; binHash: string;
  host?: { hostPid: number; hostStartedAt: number };
  ended?: { at: number; hostPid: number; hostStartedAt: number };
}
export interface NativeCodexOptions {
  directory: string; manager: CodexManager; host: ChatHostLink; pool(): ChatPool;
  open(request: ExecutionStartRequest, assertCurrent: () => void, executable: string): Promise<void>;
  guard(request: Pick<ExecutionStartRequest, 'scope' | 'binding'>): void;
  /** Current owner/actor/home authorization for observing an older run's end.
   * Running proof and input still require guard's complete current binding. */
  authorizeObservation?(request: Pick<ExecutionStartRequest, 'scope' | 'binding'>): void;
  /** The exact durable run must still own its one permitted start at dispatch. */
  dispatchGuard?(request: ExecutionStartRequest): void;
  /** Only a completed uncertain start with no pending/replayable dispatch may use absence recovery. */
  canConfirmAbsent?(intent: OpenIntent): boolean;
  processes?(hostPid: number): Promise<NativeProcess[]>;
  allProcesses?(): Promise<NativeProcess[]>;
}
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** Accept only a direct executable or an exact, simple local forwarding wrapper.
 * Complex shell launchers remain unsupported; their code is never evaluated here. */
export function nativeCodexExecutable(launcher: string): { executable: string; fingerprint: string } {
  let executable = launcher
  if (/\.cmd$/i.test(launcher)) {
    if (fs.statSync(launcher).size > 16_384) throw executionHttpError('execution-capability-required', 'capability')
    const commands = fs.readFileSync(launcher, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim())
      .filter(s => s && !/^@?echo off$/i.test(s) && !/^rem(?:\s|$)/i.test(s))
    const match = commands.length === 1 && /^"([^"\r\n]+\.exe)" %\*$/i.exec(commands[0])
    if (!match) throw executionHttpError('execution-capability-required', 'capability')
    executable = match[1]
  }
  if (!path.isAbsolute(executable) || !/\.exe$/i.test(executable) || !fs.statSync(executable).isFile()) throw executionHttpError('execution-capability-required', 'capability')
  return { executable, fingerprint: createHash('sha256').update(`${launcher}:${hash(launcher)}:${executable}:${hash(executable)}`).digest('hex') }
}

/** Match the actual executable and complete native resume arguments, including the new thread.
 * A missing protocol-1 PTY PID can be recovered only from one matching OS child of this host. */
export function matchNativeCodexProcess(rows: NativeProcess[], expected: {
  hostPid: number; hostStartedAt: number; reportedPid: number | undefined; startedAt: string;
  executable: string; sessionId: string; thread: string;
}): NativeProcess | null {
  const args = ['-p', profileName(expected.sessionId), '--no-alt-screen', 'resume', expected.thread]
  const started = Date.parse(expected.startedAt)
  const matches = rows.filter(row => {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || row.ppid !== expected.hostPid
      || !Number.isSafeInteger(row.created) || row.created < expected.hostStartedAt || !Number.isFinite(started)
      || Math.abs(row.created - started) > 10_000 || typeof row.file !== 'string'
      || path.resolve(row.file).toLowerCase() !== path.resolve(expected.executable).toLowerCase()
      || typeof row.command !== 'string') return false
    const words = [...row.command.matchAll(/"([^"]*)"|([^\s"]+)/g)].map(part => part[1] ?? part[2])
    return words.length === args.length + 1 && args.every((word, i) => words[i + 1] === word)
  })
  if (matches.length !== 1) return null
  if (expected.reportedPid !== undefined && expected.reportedPid !== 0 && expected.reportedPid !== matches[0].pid) return null
  return matches[0]
}

/** Uses the existing native launcher and manager. No credential reads, copies or refreshers. */
export function createNativeCodexExecution(o: NativeCodexOptions) {
  const recordFile = (runId: string) => {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(runId)) throw executionHttpError('execution-invalid', 'runtime')
    return path.join(o.directory, `${runId}.native.json`)
  }
  const capability = () => {
    const status = o.manager.status(), bin = o.manager.bin()
    if (process.platform !== 'win32' || process.arch !== 'x64' || !o.host.inspect || !o.host.current || !bin
      || !status.installed || status.version !== '0.163.0' || status.state !== 'ok') throw executionHttpError('execution-capability-required', 'capability')
    const resolved = nativeCodexExecutable(bin)
    return { bin: resolved.executable, binHash: resolved.fingerprint, host: { ...o.host.current() } }
  }
  async function observe(intent: OpenIntent): Promise<ExecutionRunObservation> {
    const binding = intent.binding, scope = intent.scope
    const authorize = () => (o.authorizeObservation ?? o.guard)({ binding, scope })
    authorize()
    if (binding.execution.profile !== 'codex-native-v1' || !binding.sessionId || !binding.codexThread) return { state: 'unknown' }
    const file = recordFile(intent.runId)
    if (!fs.existsSync(file)) return { state: 'unknown' }
    assertPrivatePath(file)
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as NativeRecord
    assertExecutionCAS(binding, record.binding)
    if (record.version !== 1 || record.runId !== intent.runId || !isDeepStrictEqual(record.scope, scope)
      || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))) return { state: 'unknown' }
    if (record.ended && Number.isSafeInteger(record.ended.at) && record.ended.at >= Date.parse(record.startedAt)
      && Number.isSafeInteger(record.ended.hostPid) && record.ended.hostPid > 0 && Number.isSafeInteger(record.ended.hostStartedAt)
      && record.ended.hostStartedAt <= Date.parse(record.startedAt)) return { state: 'ended', dispatchFenced: true }
    if (record.ended) return { state: 'unknown' }
    const target = capability(), observation = await o.host.inspect!()
    const fence = () => {
      authorize()
      const current = capability()
      if (!isDeepStrictEqual(current.host, target.host) || current.binHash !== target.binHash || record.binHash !== target.binHash
        || record.host && (record.host.hostPid !== target.host.hostPid || record.host.hostStartedAt !== target.host.hostStartedAt)
        || observation.hostPid !== target.host.hostPid || observation.hostStartedAt !== target.host.hostStartedAt) throw executionHttpError('execution-runtime-mismatch', 'runtime')
    }
    fence()
    const chat = observation.chats.find(chat => chat.id === binding.sessionId)
    const possible = (rows: NativeProcess[]) => rows.some(row => {
      if (record.process && row.pid === record.process.pid && row.created === record.process.created) return true
      if (typeof row.command !== 'string') return true
      const words = [...row.command.matchAll(/"([^"]*)"|([^\s"]+)/g)].map(part => part[1] ?? part[2])
      return words.includes(profileName(binding.sessionId!)) || words.includes(binding.codexThread!)
    })
    const saveEnd = (extra?: () => void): ExecutionRunObservation => {
      record.ended = { at: Date.now(), hostPid: target.host.hostPid, hostStartedAt: target.host.hostStartedAt }
      writePrivateAtomic(file, JSON.stringify(record) + '\n', () => { fence(); extra?.() })
      return { state: 'ended', dispatchFenced: true }
    }
    if (!chat) {
      // The authenticated host removes entries only after exit. Unlike a bare
      // missing PID, recovery additionally requires a completed managed start,
      // an exact durable no-dispatch fence and a machine-wide process scan.
      if (!o.canConfirmAbsent?.(intent) || Date.parse(record.startedAt) < target.host.hostStartedAt
        || record.host && (record.host.hostPid !== target.host.hostPid || record.host.hostStartedAt !== target.host.hostStartedAt)) return { state: 'unknown' }
      const rows = await (o.allProcesses ?? (() => nativeProcesses()))()
      fence()
      if (possible(rows) || !o.canConfirmAbsent(intent)) return { state: 'unknown' }
      return saveEnd(() => { if (!o.canConfirmAbsent?.(intent)) throw executionHttpError('execution-intent-uncertain', 'runtime') })
    }
    if (chat.meta.engine !== 'codex' || chat.meta.floorId !== scope.floorId || chat.meta.agentId !== scope.agentId
      || chat.meta.startedAt !== record.startedAt || Object.hasOwn(chat.meta, 'bridgeRunId') || Object.hasOwn(chat.meta, 'execution')) return { state: 'unknown' }
    const rows = await (o.processes ?? nativeProcesses)(target.host.hostPid)
    fence()
    if (chat.exited) {
      const started = Date.parse(record.startedAt)
      if (!Number.isFinite(started) || started < target.host.hostStartedAt || !Number.isFinite(chat.exited.at) || chat.exited.at < started) return { state: 'unknown' }
      const stillPossible = rows.some(row => {
        if (record.process && row.pid === record.process.pid && row.created === record.process.created) return true
        if (chat.pid && row.pid === chat.pid) return true
        if (row.ppid !== target.host.hostPid || typeof row.command !== 'string') return false
        const words = [...row.command.matchAll(/"([^"]*)"|([^\s"]+)/g)].map(part => part[1] ?? part[2])
        return words.includes(profileName(binding.sessionId!)) || words.includes(binding.codexThread!)
      })
      // A positive exit from the same authenticated host incarnation and exact
      // owned start fences delayed dispatch, even when the process exited before
      // the first OS-proof poll. Any possible survivor keeps it uncertain.
      if (stillPossible) return { state: 'unknown' }
      return saveEnd()
    }
    const actual = matchNativeCodexProcess(rows, { hostPid: target.host.hostPid, hostStartedAt: target.host.hostStartedAt,
      reportedPid: chat.pid, startedAt: record.startedAt, executable: target.bin, sessionId: binding.sessionId, thread: binding.codexThread })
    const info = o.pool().info(binding.sessionId)
    o.guard({ binding, scope })
    if (!actual || info?.engine !== 'codex' || info.startedAt !== record.startedAt) return { state: 'unknown' }
    if (record.process && (record.process.pid !== actual.pid || record.process.created !== actual.created)) return { state: 'unknown' }
    if (!record.process) {
      record.process = { pid: actual.pid, created: actual.created }
      writePrivateAtomic(file, JSON.stringify(record) + '\n', () => { fence(); o.guard({ binding, scope }) })
    }
    return { state: 'running', proof: { version: 1, runId: intent.runId, targetPcId: scope.targetPcId, verified: true, binding, execution: binding.execution } }
  }
  return { capability, observe,
    async start(request: ExecutionStartRequest) {
      o.guard(request)
      o.dispatchGuard?.(request)
      if (request.kind !== 'native' || request.binding.execution.profile !== 'codex-native-v1' || !request.binding.codexThread || request.signal.aborted) throw executionHttpError('execution-invalid', 'open')
      const file = recordFile(request.runId), target = capability()
      if (fs.existsSync(file) || o.pool().info(request.binding.sessionId!)) throw executionHttpError('execution-intent-uncertain', 'open')
      const record: NativeRecord = { version: 1, runId: request.runId, scope: request.scope, binding: request.binding, binHash: target.binHash,
        host: { hostPid: target.host.hostPid, hostStartedAt: target.host.hostStartedAt } }
      writePrivateAtomic(file, JSON.stringify(record) + '\n')
      const assertCurrent = () => {
        o.guard(request)
        o.dispatchGuard?.(request)
        const current = capability()
        if (request.signal.aborted || current.binHash !== target.binHash || !isDeepStrictEqual(current.host, target.host)) throw executionHttpError('execution-runtime-mismatch', 'runtime')
      }
      assertCurrent()
      await o.open(request, assertCurrent, target.bin)
      assertCurrent()
      const info = o.pool().info(request.binding.sessionId!)
      if (request.signal.aborted || info?.engine !== 'codex' || !isDeepStrictEqual(capability().host, target.host)) throw executionHttpError('execution-runtime-mismatch', 'runtime')
      record.startedAt = info.startedAt
      writePrivateAtomic(file, JSON.stringify(record) + '\n')
    },
  }
}

function nativeProcesses(hostPid?: number): Promise<NativeProcess[]> {
  if (hostPid !== undefined && (!Number.isSafeInteger(hostPid) || hostPid <= 0)) return Promise.reject(Error('Invalid host identity'))
  const filter = hostPid === undefined ? '"Name=\'codex.exe\'"' : `'ParentProcessId=${hostPid}'`
  const script = `@(Get-CimInstance Win32_Process -Filter ${filter} -ErrorAction Stop | ForEach-Object {@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds();file=$_.ExecutablePath;command=$_.CommandLine}}) | ConvertTo-Json -Depth 3 -Compress`
  return new Promise((resolve,reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(Error('Native process ownership could not be observed'))
      try { const rows = JSON.parse(stdout || '[]'); if (!Array.isArray(rows) && (!rows || typeof rows !== 'object')) throw Error('Invalid process observation'); resolve(Array.isArray(rows) ? rows : [rows]) } catch { reject(Error('Native process ownership could not be observed')) }
    }))
}
