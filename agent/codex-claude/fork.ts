import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { assertPreparedExecution, type ExecutionIdentity, type ExecutionSnapshot } from '../../shared/chat-execution.ts'
import { executionHttpError } from '../../shared/chat-execution-http.ts'
import { sourceHash } from '../agentic/switch-fence.ts'
import { transcriptPath } from '../agentic/transcripts.ts'
import { switchConversationComplete, type CompleteConversionOptions } from '../codex/complete-conversion.ts'
import { commitPreparedTranscript, protectPath } from './storage.ts'

/** A hybrid Claude JSONL is converted as Claude history, never resumed as a Codex rollout. */
export async function forkNativeCodexExecution(options: { expected: ExecutionSnapshot; target: ExecutionIdentity; file: string; cwd: string; codexHome: string; onProgress?: CompleteConversionOptions['onProgress']; recovery?: CompleteConversionOptions['recovery'] }) {
  const { expected, target } = options
  if (!expected.sessionId || (expected.execution.profile !== 'codex-in-claude-v1' && !(options.recovery && expected.execution.profile === 'codex-native-v1')) || target.profile !== 'codex-native-v1') throw executionHttpError('execution-lineage-invalid', 'selection')
  const before = sourceHash(options.file)
  const converted = await switchConversationComplete({ to: 'codex', file: options.file, cwd: options.cwd, codexHome: options.codexHome, onProgress: options.onProgress, recovery: options.recovery })
  protectPath(converted.file)
  const handle = fs.openSync(converted.file, 'r+')
  try { fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
  if (sourceHash(options.file) !== before) throw executionHttpError('execution-stale', 'selection')
  const binding = { ...expected, execution: target, sessionId: randomUUID(), codexThread: converted.id, opencodeSession: null, executionRevision: expected.executionRevision + 1 }
  const lineage = assertPreparedExecution(expected, { binding, sourceSessionId: expected.sessionId, recordedAt: new Date().toISOString() }, expected.homePc!, target)
  return { lineage, sourceSealId: before, file: converted.file }
}

export async function forkClaudeExecution(options: { expected: ExecutionSnapshot; target: ExecutionIdentity; file: string; cwd: string; projectsDir: string; onProgress?: CompleteConversionOptions['onProgress'] }) {
  const { expected, target } = options
  if (!expected.sessionId || target.engine !== 'claude' || expected.execution.engine === 'opencode') throw executionHttpError('execution-lineage-invalid', 'selection')
  const before = sourceHash(options.file)
  let id: string, file: string
  if (expected.execution.engine === 'codex') {
    const converted = await switchConversationComplete({ to: 'claude', file: options.file, cwd: options.cwd, projectsDir: options.projectsDir, onProgress: options.onProgress })
    id = converted.id; file = converted.file; protectPath(file)
    const handle = fs.openSync(file, 'r+'); try { fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
  } else {
    id = randomUUID(); file = transcriptPath(options.cwd, id, options.projectsDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.next`, handle = fs.openSync(temporary, 'wx', 0o600)
    protectPath(temporary)
    let rows = 0
    try {
      for await (const line of createInterface({ input: fs.createReadStream(options.file), crlfDelay: Infinity })) {
        if (!line.trim()) continue
        if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw executionHttpError('execution-lineage-invalid', 'selection')
        const row = JSON.parse(line)
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw executionHttpError('execution-lineage-invalid', 'selection')
        if (Object.hasOwn(row, 'sessionId')) row.sessionId = id
        fs.writeSync(handle, JSON.stringify(row) + '\n'); rows++
      }
      if (!rows || sourceHash(options.file) !== before) throw executionHttpError('execution-stale', 'selection')
      fs.fsyncSync(handle)
    } finally { fs.closeSync(handle) }
    commitPreparedTranscript(temporary, file)
  }
  if (sourceHash(options.file) !== before) throw executionHttpError('execution-stale', 'selection')
  const binding = { ...expected, execution: target, sessionId: id, codexThread: null, opencodeSession: null, executionRevision: expected.executionRevision + 1 }
  const lineage = assertPreparedExecution(expected, { binding, sourceSessionId: expected.sessionId, recordedAt: new Date().toISOString() }, expected.homePc!, target)
  return { lineage, sourceSealId: before, file }
}
