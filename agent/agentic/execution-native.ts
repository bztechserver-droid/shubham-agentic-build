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
}
export interface NativeCodexOptions {
  directory: string; manager: CodexManager; host: ChatHostLink; pool(): ChatPool;
  open(request: ExecutionStartRequest, assertCurrent: () => void): Promise<void>;
  guard(request: Pick<ExecutionStartRequest, 'scope' | 'binding'>): void;
  processes?(hostPid: number): Promise<NativeProcess[]>;
}
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

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
      || !/\.exe$/i.test(bin) || !status.installed || status.version !== '0.163.0' || status.state !== 'ok') throw executionHttpError('execution-capability-required', 'capability')
    return { bin, binHash: hash(bin), host: { ...o.host.current() } }
  }
  async function observe(intent: OpenIntent): Promise<ExecutionRunObservation> {
    const binding = intent.binding, scope = intent.scope
    o.guard({ binding, scope })
    if (binding.execution.profile !== 'codex-native-v1' || !binding.sessionId || !binding.codexThread) return { state: 'unknown' }
    const file = recordFile(intent.runId)
    if (!fs.existsSync(file)) return { state: 'unknown' }
    assertPrivatePath(file)
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as NativeRecord
    assertExecutionCAS(binding, record.binding)
    if (record.version !== 1 || record.runId !== intent.runId || !isDeepStrictEqual(record.scope, scope) || !record.startedAt) return { state: 'unknown' }
    const target = capability(), observation = await o.host.inspect!()
    const fence = () => {
      o.guard({ binding, scope })
      const current = capability()
      if (!isDeepStrictEqual(current.host, target.host) || current.binHash !== target.binHash || record.binHash !== target.binHash
        || observation.hostPid !== target.host.hostPid || observation.hostStartedAt !== target.host.hostStartedAt) throw executionHttpError('execution-runtime-mismatch', 'runtime')
    }
    fence()
    const chat = observation.chats.find(chat => chat.id === binding.sessionId)
    if (!chat || chat.meta.engine !== 'codex' || chat.meta.floorId !== scope.floorId || chat.meta.agentId !== scope.agentId
      || chat.meta.startedAt !== record.startedAt || Object.hasOwn(chat.meta, 'bridgeRunId') || Object.hasOwn(chat.meta, 'execution')) return { state: 'unknown' }
    const rows = await (o.processes ?? nativeProcesses)(target.host.hostPid)
    fence()
    if (chat.exited) {
      if (!record.process || rows.some(row => row.pid === record.process!.pid && row.created === record.process!.created)) return { state: 'unknown' }
      return { state: 'ended', dispatchFenced: true }
    }
    const actual = matchNativeCodexProcess(rows, { hostPid: target.host.hostPid, hostStartedAt: target.host.hostStartedAt,
      reportedPid: chat.pid, startedAt: record.startedAt, executable: target.bin, sessionId: binding.sessionId, thread: binding.codexThread })
    const info = o.pool().info(binding.sessionId)
    if (!actual || info?.engine !== 'codex' || info.startedAt !== record.startedAt) return { state: 'unknown' }
    if (record.process && (record.process.pid !== actual.pid || record.process.created !== actual.created)) return { state: 'unknown' }
    if (!record.process) {
      record.process = { pid: actual.pid, created: actual.created }
      writePrivateAtomic(file, JSON.stringify(record) + '\n', fence)
    }
    return { state: 'running', proof: { version: 1, runId: intent.runId, targetPcId: scope.targetPcId, verified: true, binding, execution: binding.execution } }
  }
  return { capability, observe,
    async start(request: ExecutionStartRequest) {
      o.guard(request)
      if (request.kind !== 'native' || request.binding.execution.profile !== 'codex-native-v1' || !request.binding.codexThread || request.signal.aborted) throw executionHttpError('execution-invalid', 'open')
      const file = recordFile(request.runId), target = capability()
      if (fs.existsSync(file) || o.pool().info(request.binding.sessionId!)) throw executionHttpError('execution-intent-uncertain', 'open')
      const record: NativeRecord = { version: 1, runId: request.runId, scope: request.scope, binding: request.binding, binHash: target.binHash }
      writePrivateAtomic(file, JSON.stringify(record) + '\n')
      const assertCurrent = () => {
        o.guard(request)
        const current = capability()
        if (request.signal.aborted || current.binHash !== target.binHash || !isDeepStrictEqual(current.host, target.host)) throw executionHttpError('execution-runtime-mismatch', 'runtime')
      }
      assertCurrent()
      await o.open(request, assertCurrent)
      assertCurrent()
      const info = o.pool().info(request.binding.sessionId!)
      if (request.signal.aborted || info?.engine !== 'codex' || !isDeepStrictEqual(capability().host, target.host)) throw executionHttpError('execution-runtime-mismatch', 'runtime')
      record.startedAt = info.startedAt
      writePrivateAtomic(file, JSON.stringify(record) + '\n')
    },
  }
}

function nativeProcesses(hostPid: number): Promise<NativeProcess[]> {
  if (!Number.isSafeInteger(hostPid) || hostPid <= 0) return Promise.resolve([])
  const script = `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${hostPid}' -ErrorAction Stop | ForEach-Object {@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds();file=$_.ExecutablePath;command=$_.CommandLine}}) | ConvertTo-Json -Depth 3 -Compress`
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve([])
      try { const rows = JSON.parse(stdout); resolve(Array.isArray(rows) ? rows : rows && typeof rows === 'object' ? [rows] : []) } catch { resolve([]) }
    }))
}
