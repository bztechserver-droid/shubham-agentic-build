import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { convertHistory, readHistory, emitHistory, type Engine } from './history.ts'
import { interchange } from './backend.ts'
import type { OpenCodeInstall } from './install.ts'
import { transcriptPath } from '../agentic/transcripts.ts'
import { writeClaudeRollout } from '../codex/from-claude.ts'

export interface PreparedConversation { sessionId: string; codexThread: string | null; opencodeSession: string | null; file: string }
export async function prepareConversation(o: { from: Engine; to: Engine; source: unknown; cwd: string; projectsDir: string; codexHome?: string; openCodeRoot: (sid: string) => string; install: OpenCodeInstall | null }): Promise<PreparedConversation> {
  const id = randomUUID(), timestamp = new Date().toISOString()
  if (o.to === 'opencode') {
    if (!o.install) throw new Error('Pinned OpenCode is not installed')
    const doc = convertHistory(o.from, 'opencode', o.source, { id, cwd: o.cwd, timestamp }) as { info: { id: string }; messages: unknown[] }
    const root = o.openCodeRoot(id), file = path.join(root, 'import.json')
    mkdirSync(root, { recursive: true }); writeFileSync(file, JSON.stringify(doc), { flag: 'wx', mode: 0o600 })
    try {
      await interchange(o.install, root, o.cwd, ['import', file])
      const readback = JSON.parse(await interchange(o.install, root, o.cwd, ['export', doc.info.id]))
      if (!isDeepStrictEqual(readback.messages, doc.messages)) throw new Error('OpenCode imported history verification failed')
      const rows = emitHistory('claude', readHistory('opencode', readback, timestamp), { id, cwd: o.cwd, timestamp }) as string[]
      const mirror = path.join(root, 'history.jsonl')
      writeFileSync(mirror, rows.join('\n') + '\n', { flag: 'wx', mode: 0o600 })
      return { sessionId: id, codexThread: null, opencodeSession: doc.info.id, file: mirror }
    } finally { rmSync(file, { force: true }) }
  }
  if (o.to === 'codex') {
    if (!o.codexHome) throw new Error('Codex is not configured')
    // Use the F-142 native rollout writer, including its latest shape/compaction fixes.
    const normalized = readHistory(o.from, o.source, timestamp)
    if (!normalized.length) throw new Error('No convertible conversation')
    const rows = emitHistory('claude', normalized, { id, cwd: o.cwd, timestamp }) as string[]
    const result = writeClaudeRollout(rows, o.codexHome, o.cwd, new Date(), true)
    return { sessionId: id, codexThread: result.id, opencodeSession: null, file: result.file }
  }
  const rows = convertHistory(o.from, 'claude', o.source, { id, cwd: o.cwd, timestamp }) as string[]
  const file = transcriptPath(o.cwd, id, o.projectsDir)
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, rows.join('\n') + '\n', { flag: 'wx', mode: 0o600 })
  return { sessionId: id, codexThread: null, opencodeSession: null, file }
}
export const jsonLines = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/)
