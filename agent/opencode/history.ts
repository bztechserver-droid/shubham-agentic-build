import { sanitizeConversationValue, fromClaude } from '../codex/from-claude.ts'
import { toClaude } from '../codex/to-claude.ts'

type Row = Record<string, unknown>
const row = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const safe = (v: unknown): string => typeof v === 'string' ? String(sanitizeConversationValue(v)) : ''
const list = (v: unknown): Row[] => Array.isArray(v) ? v.slice(0, 10000).filter(row) : []
const missing = '[No result preserved in imported transcript]'
export type Engine = 'claude' | 'codex' | 'opencode'
export type Part = { type: 'text'; text: string } | { type: 'tool'; id: string; name: string; input: unknown; output: string; error: boolean }
export interface HistoryMessage { role: 'user' | 'assistant'; time: string; parts: Part[] }
export interface HistoryOptions { id: string; cwd: string; timestamp: string; model?: string; provider?: string }
const body = (v: unknown): string => typeof v === 'string' ? safe(v) : list(v).filter(p => ['text', 'input_text', 'output_text'].includes(String(p.type))).map(p => safe(p.text)).join('\n')
const at = (v: unknown, fallback: string): string => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8640000000000000 ? new Date(v).toISOString() : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : fallback
const note = (what: string): Part => ({ type: 'text', text: `[${what} omitted from imported transcript]` })

/** Allowlisted conversation content only. No IO, credentials, reasoning, instructions or policy. */
export function readHistory(engine: Engine, input: unknown, fallback: string): HistoryMessage[] {
  const out: HistoryMessage[] = []
  const pending = new Map<string, Extract<Part, { type: 'tool' }>>()
  const add = (role: 'user' | 'assistant', time: string, parts: Part[]) => { if (parts.length) out.push({ role, time, parts }) }
  const tool = (id: string, name: string, input: unknown): Part => {
    const p: Extract<Part, { type: 'tool' }> = { type: 'tool', id: `call_import_${pending.size + 1}`, name: safe(name), input: sanitizeConversationValue(input), output: missing, error: true }
    pending.set(id, p)
    return p
  }
  const result = (id: unknown, content: unknown, error: boolean, time: string) => {
    const p = typeof id === 'string' ? pending.get(id) : undefined
    const text = body(content) || '[Non-text tool result omitted]'
    if (p) { p.output = text; p.error = error } else add('user', time, [{ type: 'text', text: `[Imported tool result]\n${text}` }])
  }
  if (engine === 'opencode') {
    if (!row(input) || !row(input.info) || !Array.isArray(input.messages)) throw new Error('Invalid OpenCode export')
    for (const m of list(input.messages)) {
      if (!row(m.info) || !['user', 'assistant'].includes(String(m.info.role))) continue
      const parts: Part[] = []
      for (const p of list(m.parts)) {
        if (p.type === 'text' && p.synthetic !== true && p.ignored !== true && safe(p.text)) parts.push({ type: 'text', text: safe(p.text) })
        else if (p.type === 'tool' && typeof p.callID === 'string' && typeof p.tool === 'string' && row(p.state)) {
          const t = tool(p.callID, p.tool, p.state.input) as Extract<Part, { type: 'tool' }>
          t.output = p.state.status === 'completed' ? body(p.state.output) || '[Non-text tool result omitted]' : p.state.status === 'error' ? body(p.state.error) || '[Tool error]' : missing
          t.error = p.state.status !== 'completed'
          parts.push(t)
        } else if (!['reasoning', 'step-start', 'step-finish', 'snapshot', 'patch'].includes(String(p.type))) parts.push(note(p.type === 'compaction' ? 'Compaction boundary' : 'Unsupported part'))
      }
      add(m.info.role as 'user' | 'assistant', at(row(m.info.time) ? m.info.time.created : undefined, fallback), parts)
    }
    return out
  }
  if (!Array.isArray(input)) throw new Error('Expected JSONL lines')
  for (const line of input.slice(0, 100000)) {
    if (typeof line !== 'string' || line.length > 8 * 1024 * 1024) continue
    let r: unknown
    try { r = JSON.parse(line.replace(/^\uFEFF/, '')) } catch { continue }
    if (!row(r) || r.isMeta === true || r.isSidechain === true) continue
    const time = at(r.timestamp, fallback)
    if (engine === 'claude') {
      if (r.type === 'system' && r.subtype === 'compact_boundary') { add('user', time, [note('Compaction boundary')]); continue }
      if (r.type === 'attachment' && row(r.attachment) && r.attachment.type === 'queued_command' && r.attachment.commandMode === 'prompt') { add('user', time, [{ type: 'text', text: body(r.attachment.prompt) }]); continue }
      if (!['user', 'assistant'].includes(String(r.type)) || !row(r.message)) continue
      const parts: Part[] = []
      for (const p of typeof r.message.content === 'string' ? [{ type: 'text', text: r.message.content }] : list(r.message.content)) {
        if (p.type === 'text' && safe(p.text)) parts.push({ type: 'text', text: safe(p.text) })
        else if (p.type === 'tool_use' && r.type === 'assistant' && typeof p.id === 'string' && typeof p.name === 'string') parts.push(tool(p.id, p.name, p.input))
        else if (p.type === 'tool_result') result(p.tool_use_id, p.content, p.is_error === true, time)
        else if (p.type !== 'thinking' && p.type !== 'redacted_thinking') parts.push(note('Unsupported part'))
      }
      add(r.type as 'user' | 'assistant', time, parts)
    } else {
      if (r.type === 'compacted') { add('user', time, [{ type: 'text', text: safe(r.message) || '[Compaction boundary omitted from imported transcript]' }]); continue }
      if (r.type !== 'response_item' || !row(r.payload)) continue
      const p = r.payload
      if (p.type === 'message' && ['user', 'assistant'].includes(String(p.role))) { const text = body(p.content); if (text) add(p.role as 'user' | 'assistant', time, [{ type: 'text', text }]) }
      else if (['function_call', 'custom_tool_call'].includes(String(p.type)) && typeof p.call_id === 'string' && typeof p.name === 'string') {
        let input: unknown = p.arguments ?? p.input ?? {}
        if (typeof input === 'string') { try { input = JSON.parse(input) } catch { input = { input: safe(input) } } }
        add('assistant', time, [tool(p.call_id, p.name, input)])
      } else if (['function_call_output', 'custom_tool_call_output'].includes(String(p.type))) result(p.call_id, row(p.output) ? p.output.output ?? p.output.content : p.output, (typeof p.output === 'string' && p.output.startsWith('[Tool error]\n')) || (row(p.output) && (p.output.success === false || p.output.is_error === true)), time)
    }
  }
  return out
}

export function emitHistory(engine: Engine, history: HistoryMessage[], options: HistoryOptions): unknown {
  if (!Number.isFinite(Date.parse(options.timestamp))) throw new Error('Invalid timestamp')
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(options.id)) throw new Error('Invalid destination ID seed')
  let seq = 0
  const native = (prefix: string) => `${prefix}_${Date.parse(options.timestamp).toString(16).padStart(12, '0')}${options.id.replace(/-/g, '').slice(0, 16)}${(++seq).toString(16).padStart(8, '0')}`
  if (engine === 'opencode') {
    const sessionID = native('ses')
    let parentID = ''
    const messages: Row[] = []
    for (const m of history) {
      if (!parentID && m.role === 'assistant') {
        parentID = native('msg')
        messages.push({ info: { id: parentID, sessionID, role: 'user', time: { created: Date.parse(options.timestamp) }, agent: 'build', model: { providerID: options.provider ?? 'mock', modelID: options.model ?? 'mock' } }, parts: [{ id: native('prt'), sessionID, messageID: parentID, type: 'text', text: '[Imported assistant history]' }] })
      }
      const id = native('msg'), created = Date.parse(m.time)
      const info: Row = { id, sessionID, role: m.role, time: { created, ...(m.role === 'assistant' ? { completed: created } : {}) } }
      if (m.role === 'user') { parentID = id; Object.assign(info, { agent: 'build', model: { providerID: options.provider ?? 'mock', modelID: options.model ?? 'mock' } }) }
      else Object.assign(info, { parentID, providerID: options.provider ?? 'mock', modelID: options.model ?? 'mock', mode: 'build', agent: 'build', path: { cwd: options.cwd, root: options.cwd }, cost: 0, tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop' })
      messages.push({ info, parts: m.parts.map(p => ({ id: native('prt'), sessionID, messageID: id, ...(p.type === 'text' ? { type: 'text', text: safe(p.text) } : { type: 'tool', callID: native('call'), tool: safe(p.name), state: p.error ? { status: 'error', input: sanitizeConversationValue(p.input), error: safe(p.output), time: { start: created, end: created } } : { status: 'completed', input: sanitizeConversationValue(p.input), output: safe(p.output), title: safe(p.name), metadata: {}, time: { start: created, end: created } } }) })) })
    }
    return { info: { id: sessionID, slug: 'imported-conversation', title: 'Imported conversation', version: '1.19.4', directory: options.cwd, projectID: 'global', time: { created: Date.parse(options.timestamp), updated: Date.parse(options.timestamp) } }, messages }
  }
  const out: string[] = []
  let parentUuid: string | null = null
  const push = (role: string, content: Row[], time: string) => {
    const uuid = `${options.id.slice(0, 24)}${(++seq).toString(16).padStart(12, '0')}`
    out.push(JSON.stringify({ type: role, uuid, parentUuid, sessionId: options.id, cwd: options.cwd, timestamp: time, version: '2.1.319', isSidechain: false, userType: 'external', message: { role, content, ...(role === 'assistant' ? { id: `msg_import_${seq}`, type: 'message', model: 'imported-opencode', stop_reason: content.some(p => p.type === 'tool_use') ? 'tool_use' : 'end_turn' } : {}) } }))
    parentUuid = uuid
  }
  if (engine === 'codex') out.push(JSON.stringify({ type: 'session_meta', timestamp: options.timestamp, payload: { id: options.id, cwd: options.cwd, timestamp: options.timestamp, originator: 'codex_cli_rs', cli_version: '0.163.0', source: 'cli', model_provider: 'openai', base_instructions: { text: '' } } }))
  const response = (payload: Row, time: string) => out.push(JSON.stringify({ type: 'response_item', timestamp: time, payload }))
  let turn = 0
  let active = false
  const event = (type: string, time: string) => out.push(JSON.stringify({ type: 'event_msg', timestamp: time, payload: { type, turn_id: `${options.id}-${turn}`, ...(type === 'task_started' ? { model_context_window: null, collaboration_mode_kind: 'default' } : { last_agent_message: null }) } }))
  for (const m of history) {
    if (engine === 'codex') {
      if (active && m.role === 'user') { event('task_complete', m.time); active = false }
      if (!active) { turn++; event('task_started', m.time); active = true }
    }
    for (const p of m.parts) {
    if (engine === 'claude') {
      if (p.type === 'text') push(m.role, [{ type: 'text', text: safe(p.text) }], m.time)
      else { const id = `call_import_${++seq}`; push('assistant', [{ type: 'tool_use', id, name: safe(p.name), input: sanitizeConversationValue(p.input) }], m.time); push('user', [{ type: 'tool_result', tool_use_id: id, content: safe(p.output), is_error: p.error }], m.time) }
    } else if (p.type === 'text') response({ type: 'message', role: m.role, content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: safe(p.text) }] }, m.time)
    else { const call_id = `call_import_${++seq}`; response({ type: 'custom_tool_call', call_id, name: safe(p.name), input: JSON.stringify(sanitizeConversationValue(p.input)), status: 'completed' }, m.time); response({ type: 'custom_tool_call_output', call_id, output: `${p.error ? '[Tool error]\n' : ''}${safe(p.output)}` }, m.time) }
    }
  }
  if (active) event('task_complete', options.timestamp)
  return out
}

/** All six directed pairs. Existing Claude/Codex behavior stays in its established converters. */
export function convertHistory(from: Engine, to: Engine, input: unknown, options: HistoryOptions): unknown {
  if (from === to) throw new Error('Source and target must differ')
  if (from === 'claude' && to === 'codex') return fromClaude(input as string[], options)
  if (from === 'codex' && to === 'claude') return toClaude(input as string[], { sessionId: options.id, cwd: options.cwd, timestamp: options.timestamp })
  const history = readHistory(from, input, options.timestamp)
  if (!history.length) throw new Error('No convertible conversation messages')
  return emitHistory(to, history, options)
}
