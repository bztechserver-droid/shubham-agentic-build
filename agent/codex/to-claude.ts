import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { transcriptPath } from '../agentic/transcripts.ts'
import { sanitizeConversationValue } from './from-claude.ts'

type Row = Record<string, unknown>
const object = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v)
const cap = (s: string) => s.length > 32_000 ? `${s.slice(0, 32_000)}\n[truncated]` : s
const safeText = (v: unknown): string => typeof v === 'string' ? String(sanitizeConversationValue(v)) : Array.isArray(v)
  ? cap(v.filter(object).filter(p => ['input_text', 'output_text', 'text'].includes(String(p.type))).map(p => safeText(p.text)).join('\n')) : ''

export interface ClaudeConversionOptions {
  sessionId: string
  cwd: string
  timestamp: string
  version?: string
}

/** Codex history only; never imports its developer instructions, reasoning or account metadata. */
export function toClaude(lines: Iterable<string>, options: ClaudeConversionOptions): string[] {
  const out: string[] = []
  let parentUuid: string | null = null
  let sequence = 0
  const pending = new Set<string>()
  const emit = (role: 'user' | 'assistant', content: Row[], timestamp: string, stop_reason: string | null = null) => {
    // Deterministic UUIDs make the pure conversion repeatable. The writer supplies a fresh session UUID.
    const uuid = `${options.sessionId.slice(0, 24)}${(++sequence).toString(16).padStart(12, '0')}`
    out.push(JSON.stringify({ type: role, uuid, parentUuid, sessionId: options.sessionId, cwd: options.cwd,
      version: options.version ?? '2.1.319', timestamp, isSidechain: false, userType: 'external',
      message: { role, content, ...(role === 'assistant' ? { id: `msg_import_${sequence}`, type: 'message', model: 'imported-codex', stop_reason } : {}) } }))
    parentUuid = uuid
  }
  const message = (role: 'user' | 'assistant', body: string, at: string) => {
    if (body) emit(role, [{ type: 'text', text: body }], at, role === 'assistant' ? 'end_turn' : null)
  }
  const finish = (at: string) => {
    for (const tool_use_id of pending) emit('user', [{ type: 'tool_result', tool_use_id, content: '[No result preserved in imported rollout]', is_error: true }], at)
    pending.clear()
  }
  for (const line of lines) {
    if (line.length > 8 * 1024 * 1024) continue
    let r: unknown
    try { r = JSON.parse(line.replace(/^\uFEFF/, '')) } catch { continue }
    if (!object(r) || r.type !== 'response_item' || !object(r.payload)) continue
    const p = r.payload
    const at = typeof r.timestamp === 'string' && Number.isFinite(Date.parse(r.timestamp)) ? r.timestamp : options.timestamp
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      if (p.role === 'user') finish(at)
      message(p.role, safeText(p.content), at)
    } else if ((p.type === 'custom_tool_call' || p.type === 'function_call') && typeof p.call_id === 'string' && typeof p.name === 'string') {
      if (pending.has(p.call_id)) continue
      let input: unknown = p.input ?? p.arguments ?? {}
      if (typeof input === 'string') {
        try { input = JSON.parse(input) } catch { input = { input: safeText(input) } }
      }
      pending.add(p.call_id)
      emit('assistant', [{ type: 'tool_use', id: p.call_id, name: p.name, input: sanitizeConversationValue(object(input) ? input : { input }) }], at, 'tool_use')
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const body = safeText(p.output) || (object(p.output) ? safeText(p.output.output ?? p.output.content) : '') || '[Non-text tool result omitted]'
      const failed = object(p.output) && (p.output.success === false || p.output.is_error === true)
      if (typeof p.call_id === 'string' && pending.delete(p.call_id)) emit('user', [{ type: 'tool_result', tool_use_id: p.call_id, content: body, is_error: failed }], at)
      else message('user', `[Imported tool result]\n${body}`, at)
    }
  }
  finish(options.timestamp)
  return out
}

/** Exclusive creation under the caller's Claude projects root. The source is never changed. */
export function writeCodexAsClaude(lines: Iterable<string>, projectsDir: string, cwd: string, now = new Date()): { id: string; file: string } {
  const id = randomUUID()
  const converted = toClaude(lines, { sessionId: id, cwd, timestamp: now.toISOString() })
  if (!converted.length) throw new Error('No convertible conversation messages')
  const file = transcriptPath(cwd, id, projectsDir)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${converted.join('\n')}\n`, { flag: 'wx', mode: 0o600 })
  return { id, file }
}
