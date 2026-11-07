import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import path from 'node:path'

type Row = Record<string, unknown>
const object = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v)
const LIMIT = 32_000
const cap = (s: string, limit = LIMIT) => s.length > limit ? `${s.slice(0, limit)}\n[truncated]` : s
const secret = /(?:token|api.?key|secret|password|authorization|credential|private.?key|^keys?$)/i

/** Remove credential fields recursively, including JSON embedded in tool output text. */
export function sanitizeConversationValue(v: unknown, depth = 0, limit = LIMIT): unknown {
  if (depth > 30) return '[depth limit]'
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v)
      if (object(parsed) || Array.isArray(parsed)) return cap(JSON.stringify(sanitizeConversationValue(parsed, depth + 1, limit)), limit)
    } catch { /* Ordinary conversation text. */ }
    return cap(cap(v, limit).replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~-]+)/gi, '[redacted]')
      .replace(/((?:[\w-]{0,80}(?:token|api[_-]?key|password|secret)[\w-]{0,80})\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]'), limit)
  }
  if (Array.isArray(v)) return v.slice(0, 1000).map(x => sanitizeConversationValue(x, depth + 1, limit))
  if (object(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => !secret.test(k)).map(([k, x]) => [k, sanitizeConversationValue(x, depth + 1, limit)]))
  return v
}
const text = (v: unknown): string => typeof v === 'string' ? String(sanitizeConversationValue(v)) : Array.isArray(v)
  ? cap(v.filter(object).filter(p => p.type === 'text' && typeof p.text === 'string').map(p => String(sanitizeConversationValue(p.text))).join('\n')) : ''

export interface ConversionOptions {
  /** Supplied by the caller so conversion itself is deterministic and has no IO. */
  id: string
  cwd: string
  timestamp: string
  cliVersion?: string
  budgetBytes?: number
}

/** Bounded synchronous streaming keeps the engine-switch hook synchronous without loading a transcript. */
export function* conversationLines(file: string): Generator<string> {
  const fd = openSync(file, 'r')
  const chunk = Buffer.alloc(64 * 1024)
  let pieces: Buffer[] = [], size = 0, oversized = false
  try {
    let count: number
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      let start = 0
      for (let i = 0; i < count; i++) {
        if (chunk[i] !== 10) continue
        const part = chunk.subarray(start, i)
        size += part.length
        if (!oversized && size <= 8 * 1024 * 1024) yield Buffer.concat([...pieces, part]).toString('utf8').replace(/\r$/, '')
        pieces = []; size = 0; oversized = false; start = i + 1
      }
      const tail = chunk.subarray(start, count)
      size += tail.length
      if (size > 8 * 1024 * 1024) { oversized = true; pieces = [] }
      else if (!oversized && tail.length) pieces.push(Buffer.from(tail))
    }
    if (!oversized && size) yield Buffer.concat(pieces).toString('utf8').replace(/\r$/, '')
  } finally { closeSync(fd) }
}

export interface ConversionStats { inputLines: number; compactions: number; omittedTurns: number; outputBytes: number }

/** Scan for the final main-session boundary before sanitizing any obsolete history. Two bounded passes. */
export function claudeFileContext(file: string): { lines: Iterable<string>; inputLines: number; compactions: number } {
  let lastBoundary = 0, inputLines = 0, compactions = 0
  for (const line of conversationLines(file)) {
    inputLines++
    if (!line.includes('compact_boundary')) continue
    try {
      const row: unknown = JSON.parse(line)
      if (object(row) && row.type === 'system' && row.subtype === 'compact_boundary' && row.isSidechain !== true) {
        lastBoundary = inputLines; compactions++
      }
    } catch { /* Malformed rows never establish boundaries. */ }
  }
  function* selected() {
    let index = 0
    for (const line of conversationLines(file)) if (++index >= lastBoundary) yield line
  }
  return { lines: selected(), inputLines, compactions }
}

/** Select the current compacted context and whole recent turns before mapping tool pairs. */
export function convertClaude(lines: Iterable<string>, options: ConversionOptions): { lines: string[]; stats: ConversionStats } {
  const budget = Math.max(8192, options.budgetBytes ?? 400 * 1024)
  const stats: ConversionStats = { inputLines: 0, compactions: 0, omittedTurns: 0, outputBytes: 0 }
  let summary: string[] = [], turns: string[][] = [], active: string[] = [], bytes = 0, dropped = false
  const length = (rows: string[]) => rows.reduce((n, row) => n + Buffer.byteLength(row) + 1, 0)
  const finish = () => { if (active.length) turns.push(active); active = []; dropped = false }
  for (const line of lines) {
    stats.inputLines++
    if (line.length > 8 * 1024 * 1024) continue
    let r: unknown
    try { r = JSON.parse(line.replace(/^\uFEFF/, '')) } catch { continue }
    if (!object(r) || r.isSidechain === true) continue
    if (r.type === 'system' && r.subtype === 'compact_boundary') {
      summary = []; turns = []; active = []; bytes = 0; dropped = false
      stats.compactions++; stats.omittedTurns = 0
      continue
    }
    const isSummary = r.type === 'user' && r.isCompactSummary === true
    if (r.isMeta === true && !isSummary) continue
    if (isSummary) {
      // A summary is context even when Claude marks it metadata. Keep it separately from evictable turns.
      const content = object(r.message) ? r.message.content : ''
      const body = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(object).filter(p => p.type === 'text').map(p => String(p.text ?? '')).join('\n') : ''
      const limit = Math.floor(budget / 3)
      // Split before sanitizing so the ordinary per-output cap does not silently cut a compact summary.
      let clipped = String(sanitizeConversationValue(Buffer.from(body).subarray(0, limit).toString('utf8'), 0, limit))
      while (Buffer.byteLength(JSON.stringify(clipped)) > limit) clipped = clipped.slice(0, Math.floor(clipped.length * 0.8))
      const blocks = []
      for (let i = 0; i < clipped.length; i += 16000) blocks.push({ type: 'text', text: clipped.slice(i, i + 16000) })
      if (clipped.length < body.length) blocks.push({ type: 'text', text: '[Compact summary truncated to fit import budget.]' })
      summary = [JSON.stringify({ type: 'user', message: { content: blocks }, timestamp: r.timestamp })]
      continue
    }
    const queued = r.type === 'attachment' && object(r.attachment) && r.attachment.type === 'queued_command'
    if (!queued && ((r.type !== 'user' && r.type !== 'assistant') || !object(r.message))) continue
    const content = object(r.message) ? r.message.content : undefined
    const newTurn = queued || (r.type === 'user' && (typeof content === 'string' || (Array.isArray(content) && content.some(p => object(p) && p.type !== 'tool_result'))))
    if (newTurn) finish()
    if (dropped) continue
    // Only mapped fields enter the bounded queue; private transcript metadata is never copied.
    const row = JSON.stringify(sanitizeConversationValue({ type: r.type, message: r.message, attachment: r.attachment, timestamp: r.timestamp }))
    active.push(row); bytes += Buffer.byteLength(row) + 1
    while (bytes > budget * 0.7 && turns.length) {
      bytes -= length(turns.shift()!); stats.omittedTurns++
    }
    if (bytes > budget * 0.7) {
      bytes -= length(active); active = []; dropped = true; stats.omittedTurns++
    }
  }
  finish()
  const build = () => mapClaude([...summary, ...(stats.omittedTurns ? [JSON.stringify({ type: 'user', message: { content: `[Import omitted ${stats.omittedTurns} older or oversized turns to fit the conversation budget.]` } })] : []), ...turns.flat()], options)
  let result = build()
  while (Buffer.byteLength(result.join('\n') + '\n') > budget && turns.length) { turns.shift(); stats.omittedTurns++; result = build() }
  stats.outputBytes = Buffer.byteLength(result.join('\n') + '\n')
  return { lines: result, stats }
}

export function fromClaude(lines: Iterable<string>, options: ConversionOptions): string[] {
  return convertClaude(lines, options).lines
}

/** Claude JSONL -> Codex 0.163.0 rollout JSONL. Unknown/malformed rows and private metadata are skipped. */
function mapClaude(lines: Iterable<string>, options: ConversionOptions): string[] {
  const out: string[] = []
  const emit = (type: string, payload: Row, timestamp = options.timestamp) => out.push(JSON.stringify({ timestamp, type, payload }))
  emit('session_meta', { id: options.id, timestamp: options.timestamp, cwd: options.cwd, originator: 'codex_cli_rs', cli_version: options.cliVersion ?? '0.163.0', source: 'cli', model_provider: 'openai', base_instructions: { text: '' } })
  let turn = 0
  let active = false
  const pending = new Set<string>()
  const finish = (at: string) => {
    for (const call_id of pending) emit('response_item', { type: 'custom_tool_call_output', call_id, output: '[No result preserved in imported transcript]' }, at)
    pending.clear()
    if (active) emit('event_msg', { type: 'task_complete', turn_id: `${options.id}-${turn}`, last_agent_message: null }, at)
    active = false
  }
  const start = (at: string) => {
    if (!active) {
      active = true
      turn++
      emit('event_msg', { type: 'task_started', turn_id: `${options.id}-${turn}`, model_context_window: null, collaboration_mode_kind: 'default' }, at)
    }
  }
  const message = (role: string, body: string, at: string) => {
    if (body) emit('response_item', { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: body }] }, at)
  }
  for (const line of lines) {
    if (line.length > 8 * 1024 * 1024) continue
    let r: unknown
    try { r = JSON.parse(line.replace(/^\uFEFF/, '')) } catch { continue }
    if (!object(r) || r.isMeta === true || r.isSidechain === true) continue
    const at = typeof r.timestamp === 'string' && Number.isFinite(Date.parse(r.timestamp)) ? r.timestamp : options.timestamp
    if (r.type === 'attachment' && object(r.attachment) && r.attachment.type === 'queued_command' && r.attachment.commandMode === 'prompt') {
      const body = text(r.attachment.prompt)
      if (body) { finish(at); start(at); message('user', body, at) }
      continue
    }
    if ((r.type !== 'user' && r.type !== 'assistant') || !object(r.message)) continue
    const role = r.type
    const content = r.message.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.filter(object) : []
    if (!blocks.some(p => ['text', 'tool_use', 'tool_result', 'image'].includes(String(p.type)))) continue
    if (role === 'user' && blocks.some(p => p.type !== 'tool_result')) finish(at)
    start(at)
    for (const p of blocks) {
      if (p.type === 'text') message(role, text(p.text), at)
      else if (p.type === 'image') message(role, '[Image omitted from Claude import]', at)
      else if (p.type === 'tool_use' && role === 'assistant' && typeof p.id === 'string' && typeof p.name === 'string') {
        if (pending.has(p.id)) continue
        pending.add(p.id)
        emit('response_item', { type: 'custom_tool_call', call_id: p.id, name: p.name, input: cap(JSON.stringify(sanitizeConversationValue(p.input ?? {}))), status: 'completed' }, at)
      } else if (p.type === 'tool_result') {
        const body = text(p.content) || '[Non-text tool result omitted]'
        if (typeof p.tool_use_id === 'string' && pending.delete(p.tool_use_id)) emit('response_item', { type: 'custom_tool_call_output', call_id: p.tool_use_id, output: cap(`${p.is_error === true ? '[Tool error]\n' : ''}${body}`) }, at)
        else message('user', `[Imported tool result]\n${body}`, at)
      }
    }
    if (role === 'assistant' && ['end_turn', 'stop_sequence'].includes(String(r.message.stop_reason))) finish(at)
  }
  finish(options.timestamp)
  return out
}

/** New session only: exclusive create prevents overwriting any existing rollout. No auth/config IO. */
export function writeClaudeRollout(lines: Iterable<string>, home: string, cwd: string, now = new Date(), requireMessages = false): { id: string; file: string; stats: ConversionStats } {
  const id = randomUUID()
  const pad = (v: number) => String(v).padStart(2, '0')
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const stamp = `${day}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  const dir = path.join(home, 'sessions', ...day.split('-'))
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`)
  const converted = convertClaude(lines, { id, cwd, timestamp: now.toISOString() })
  if (requireMessages && !converted.lines.some(line => JSON.parse(line).type === 'response_item')) throw new Error('No convertible conversation messages')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, `${converted.lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 })
  return { id, file, stats: converted.stats }
}



