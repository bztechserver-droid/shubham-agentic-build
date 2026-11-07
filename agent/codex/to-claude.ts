import { createHash, randomUUID } from 'node:crypto'
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
  budgetBytes?: number
}

/** Codex history only; never imports its developer instructions, reasoning or account metadata. */
export function toClaude(lines: Iterable<string>, options: ClaudeConversionOptions): string[] {
  const out: string[] = []
  const turns: number[] = []
  const budget = Math.max(8192, options.budgetBytes ?? 400 * 1024)
  let bytes = 0, turn = 0, omitted = 0, discarding = false
  const seen = new Set<string>()
  let parentUuid: string | null = null
  let sequence = 0
  const pending = new Set<string>()
  const emit = (role: 'user' | 'assistant', content: Row[], timestamp: string, stop_reason: string | null = null) => {
    if (discarding) return
    // Deterministic UUIDs make the pure conversion repeatable. The writer supplies a fresh session UUID.
    const uuid = `${options.sessionId.slice(0, 24)}${(++sequence).toString(16).padStart(12, '0')}`
    out.push(JSON.stringify({ type: role, uuid, parentUuid, sessionId: options.sessionId, cwd: options.cwd,
      version: options.version ?? '2.1.319', timestamp, isSidechain: false, userType: 'external',
      message: { role, content, ...(role === 'assistant' ? { id: `msg_import_${sequence}`, type: 'message', model: 'imported-codex', stop_reason } : {}) } }))
    parentUuid = uuid
    turns.push(turn)
    bytes += Buffer.byteLength(out[out.length - 1]) + 1
    while (bytes > budget * 0.9 && out.length) {
      const next = turns.findIndex(t => t !== turns[0])
      const count = next < 0 ? out.length : next
      for (const line of out.splice(0, count)) bytes -= Buffer.byteLength(line) + 1
      turns.splice(0, count)
      omitted++
      if (next < 0) { discarding = true; pending.clear() }
    }
  }
  const message = (role: 'user' | 'assistant', body: string, at: string) => {
    if (role === 'user') { turn++; discarding = false }
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
    if (!object(r) || !object(r.payload)) continue
    if (r.type === 'compacted') {
      const replacement = r.payload.replacement_history
      if (Array.isArray(replacement) && replacement.some(p => object(p) && p.type === 'message' && ['user', 'assistant'].includes(String(p.role)))) {
        const rows = toClaude(replacement.filter(object).map(payload => JSON.stringify({ type: 'response_item', timestamp: r.timestamp, payload })), options)
        out.splice(0, out.length, ...rows); turns.length = 0
        for (const line of rows) {
          const row = JSON.parse(line)
          if (row.type === 'user' && row.message.content.some((p: Row) => p.type !== 'tool_result')) turn++
          turns.push(turn)
        }
        bytes = rows.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0)
        sequence = rows.reduce((n, line) => { const suffix = String(JSON.parse(line).uuid).slice(-12); return suffix === 'ffffffffffff' ? n : Math.max(n, Number.parseInt(suffix, 16) || 0) }, 0)
        parentUuid = rows.length ? JSON.parse(rows[rows.length - 1]).uuid : null
        pending.clear(); seen.clear(); discarding = false; omitted = 0
      } else if (typeof r.payload.message === 'string' && r.payload.message) {
        out.length = 0; turns.length = 0; bytes = 0; pending.clear(); seen.clear(); discarding = false; omitted = 0
        message('user', '[Codex compaction summary]\n' + safeText(r.payload.message), options.timestamp)
      }
      continue
    }
    if (r.type !== 'response_item') continue
    const p = r.payload
    const identity = typeof p.id === 'string' ? p.id : typeof p.call_id === 'string' ? p.call_id : null
    if (identity) {
      const key = identity + ':' + createHash('sha256').update(JSON.stringify(p)).digest('hex')
      if (seen.has(key)) continue
      if (seen.size >= 4096) seen.delete(seen.values().next().value!)
      seen.add(key)
    }
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
  if (omitted) out.unshift(JSON.stringify({ type: 'user', uuid: `${options.sessionId.slice(0, 24)}ffffffffffff`, sessionId: options.sessionId, cwd: options.cwd,
    timestamp: options.timestamp, version: options.version ?? '2.1.319', isSidechain: false, userType: 'external',
    message: { role: 'user', content: [{ type: 'text', text: `[Import omitted ${omitted} older or oversized turns to fit the conversation budget. Original native sessions remain saved.]` }] } }))
  // Evicted context must never leave a dangling parent reference in the new Claude session.
  let parent: string | null = null
  return out.map(line => { const row = JSON.parse(line); row.parentUuid = parent; parent = row.uuid; return JSON.stringify(row) })
}

/** Exclusive creation under the caller's Claude projects root. The source is never changed. */
export function writeCodexAsClaude(lines: Iterable<string>, projectsDir: string, cwd: string, now = new Date()): { id: string; file: string } {
  const id = randomUUID()
  const converted = toClaude(lines, { sessionId: id, cwd, timestamp: now.toISOString() })
  if (!converted.length || converted.every(line => JSON.parse(line).message.content.every((p: Row) => typeof p.text === 'string' && p.text.startsWith('[Import omitted ')))) throw new Error('No convertible conversation messages fit the import budget')
  const file = transcriptPath(cwd, id, projectsDir)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${converted.join('\n')}\n`, { flag: 'wx', mode: 0o600 })
  return { id, file }
}
