import { randomUUID, createHash } from 'node:crypto'
import { sanitizeConversationValue } from './from-claude.ts'

type Row = Record<string, unknown>
const obj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const clean = (v: unknown) => sanitizeConversationValue(v, 0, Number.MAX_SAFE_INTEGER, true)
const text = (v: unknown): string => typeof v === 'string' ? String(clean(v)) : Array.isArray(v)
  ? v.filter(obj).filter(p => ['text','input_text','output_text'].includes(String(p.type))).map(p => text(p.text)).join('\n') : ''
export interface CompleteHistoryOptions { id: string; cwd: string; timestamp: string }

/** Stream every compatible turn. The bounded context exporters remain available separately. */
export function* completeCodexToClaude(lines: Iterable<string>, o: CompleteHistoryOptions): Generator<string> {
  let parent: string | null = null, count = 0
  const pending = new Set<string>(), seen = new Set<string>()
  const emit = (role: 'user' | 'assistant', content: Row[], at: string, stop: string | null = null) => {
    const uuid = `${o.id.slice(0,24)}${(++count).toString(16).padStart(12,'0')}`
    const row = { type: role, uuid, parentUuid: parent, sessionId: o.id, cwd: o.cwd, version: '2.1.319', timestamp: at,
      isSidechain: false, userType: 'external', message: { role, content, ...(role === 'assistant' ? { id: `msg_import_${count}`, type: 'message', model: 'imported-codex', stop_reason: stop } : {}) } }
    parent = uuid; return JSON.stringify(row)
  }
  const finish = function* (at: string) {
    for (const id of pending) yield emit('user', [{ type: 'tool_result', tool_use_id: id, content: '[No result recorded in the original session]', is_error: true }], at)
    pending.clear()
  }
  for (const line of lines) {
    const r: unknown = JSON.parse(line)
    if (!obj(r) || !obj(r.payload)) continue
    const at = typeof r.timestamp === 'string' ? r.timestamp : o.timestamp, p = r.payload
    if (r.type === 'compacted') {
      yield* finish(at)
      const uuid = randomUUID()
      yield JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid, parentUuid: parent, sessionId: o.id, timestamp: at,
        content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 0 } })
      parent = uuid; seen.clear()
      const replacement = Array.isArray(p.replacement_history) ? p.replacement_history : []
      const summary = typeof p.message === 'string' ? p.message : replacement.filter(obj).filter(v => v.type === 'message').map(v => text(v.content)).filter(Boolean).join('\n\n')
      if (summary) {
        const row = JSON.parse(emit('user', [{ type: 'text', text: text(summary) }], at))
        row.isCompactSummary = true; row.isMeta = true
        yield JSON.stringify(row)
      }
      continue
    }
    if (r.type !== 'response_item') continue
    const base = typeof p.id === 'string' ? `${p.type}:${p.id}` : typeof p.call_id === 'string' ? `${p.type}:${p.call_id}` : null
    const identity = base?base+':'+createHash('sha256').update(JSON.stringify(p)).digest('hex'):null
    if (identity) { if (seen.has(identity)) continue; if (seen.size >= 8192) seen.clear(); seen.add(identity) }
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      if (p.role === 'user') yield* finish(at)
      const parts: Row[] = []
      if (typeof p.content === 'string') parts.push({ type: 'text', text: text(p.content) })
      else if (Array.isArray(p.content)) for (const part of p.content) {
        if (!obj(part)) continue
        if (['input_text','output_text','text'].includes(String(part.type))) parts.push({ type: 'text', text: text(part.text) })
        else if (part.type === 'input_image' && typeof part.image_url === 'string') {
          const data = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url)
          parts.push({ type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url: part.image_url } })
        } else throw Error('A saved message contains content the target cannot carry safely')
      }
      if (parts.length) yield emit(p.role, parts, at, p.role === 'assistant' ? 'end_turn' : null)
    } else if (['custom_tool_call','function_call'].includes(String(p.type)) && typeof p.call_id === 'string' && typeof p.name === 'string') {
      let input: unknown = p.input ?? p.arguments ?? {}
      if (typeof input === 'string') { try { input = JSON.parse(input) } catch { input = { input } } }
      pending.add(p.call_id)
      yield emit('assistant', [{ type: 'tool_use', id: p.call_id, name: p.name, input: clean(input) }], at, 'tool_use')
    } else if (['custom_tool_call_output','function_call_output'].includes(String(p.type))) {
      const output = typeof p.output === 'string' ? text(p.output) : JSON.stringify(clean(p.output ?? ''))
      if (typeof p.call_id === 'string' && pending.delete(p.call_id)) yield emit('user', [{ type: 'tool_result', tool_use_id: p.call_id, content: output }], at)
      else yield emit('user', [{ type: 'text', text: `[Imported tool result]\n${output}` }], at)
    }
  }
  yield* finish(o.timestamp)
}

export function* completeClaudeToCodex(lines: Iterable<string>, o: CompleteHistoryOptions, includeHeader = true): Generator<string> {
  const wrap = (type: string, payload: unknown, timestamp = o.timestamp) => JSON.stringify({ timestamp, type, payload })
  if (includeHeader) yield wrap('session_meta', { id: o.id, session_id: o.id, timestamp: o.timestamp, cwd: o.cwd, runtime_workspace_roots: [o.cwd],
    originator: 'codex_cli_rs', cli_version: '0.163.0', source: 'cli', thread_source: 'user', model_provider: 'openai', base_instructions: { text: '' } })
  const pending = new Set<string>(), seen = new Set<string>()
  let sequence = 0, turn = 0, active = false
  const start = function* (at: string) {
    if (active) return
    active = true; turn++
    yield wrap('event_msg', { type: 'task_started', turn_id: `${o.id}-${turn}`, model_context_window: null, collaboration_mode_kind: 'default' }, at)
    yield wrap('turn_context', { turn_id: `${o.id}-${turn}`, cwd: o.cwd, approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' }, model: 'gpt-6.1-sol', summary: 'none' }, at)
  }
  const message = function* (role: string, content: Row[], at: string) {
    yield* start(at)
    const id = `import-${o.id}-${++sequence}`
    yield wrap('response_item', { type: 'message', id, role, ...(role === 'assistant' ? { phase: 'final_answer' } : {}), content }, at)
    yield wrap('event_msg', { type: 'item_completed', thread_id: o.id, turn_id: `${o.id}-${turn}`, item: role === 'assistant'
      ? { type: 'AgentMessage', id, content: content.map(p => ({ type: 'Text', text: p.text ?? '[Image]' })), phase: 'final_answer' }
      : { type: 'UserMessage', id, client_id: null, content: content.map(p => ({ type: 'text', text: p.text ?? '[Image]', text_elements: [] })) } }, at)
  }
  const finish = function* (at: string) {
    for (const call_id of pending) yield wrap('response_item', { type: 'custom_tool_call_output', call_id, output: '[No result recorded in the original session]' }, at)
    pending.clear()
    if (active) yield wrap('event_msg', { type: 'task_complete', turn_id: `${o.id}-${turn}`, last_agent_message: null }, at)
    active = false
  }
  for (const line of lines) {
    const r: unknown = JSON.parse(line)
    if (!obj(r) || r.isSidechain === true) continue
    const at = typeof r.timestamp === 'string' ? r.timestamp : o.timestamp
    if (r.type === 'system' && r.subtype === 'compact_boundary') { yield* finish(at); seen.clear(); continue }
    if (r.type === 'user' && r.isCompactSummary === true && obj(r.message)) {
      yield* finish(at); yield wrap('compacted', { message: text(r.message.content) }, at); continue
    }
    if (r.isMeta === true) continue
    if (r.type === 'attachment' && obj(r.attachment) && r.attachment.type === 'queued_command' && r.attachment.commandMode === 'prompt') {
      yield* finish(at); yield* message('user', [{ type: 'input_text', text: text(r.attachment.prompt) }], at); continue
    }
    if ((r.type !== 'user' && r.type !== 'assistant') || !obj(r.message)) continue
    if (typeof r.uuid === 'string') { const key=r.uuid+':'+createHash('sha256').update(JSON.stringify(r.message)).digest('hex');if (seen.has(key)) continue; if (seen.size >= 8192) seen.clear(); seen.add(key) }
    const parts = typeof r.message.content === 'string' ? [{ type: 'text', text: r.message.content }] : Array.isArray(r.message.content) ? r.message.content : []
    if (r.type === 'user' && parts.some(p => obj(p) && p.type !== 'tool_result')) yield* finish(at)
    for (const p of parts) {
      if (!obj(p)) continue
      if (p.type === 'text') yield* message(r.type, [{ type: r.type === 'user' ? 'input_text' : 'output_text', text: text(p.text) }], at)
      else if (p.type === 'image' && obj(p.source)) {
        const source = p.source
        const url = source.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : source.type === 'url' ? source.url : null
        if (typeof url !== 'string') throw Error('A saved image cannot be carried safely')
        yield* message('user', [{ type: 'input_image', image_url: url }], at)
      } else if (p.type === 'tool_use' && r.type === 'assistant' && typeof p.id === 'string' && typeof p.name === 'string') {
        pending.add(p.id)
        yield* start(at)
        yield wrap('response_item', { type: 'custom_tool_call', call_id: p.id, name: p.name, input: JSON.stringify(clean(p.input ?? {})), status: 'completed' }, at)
      } else if (p.type === 'tool_result') {
        const output = typeof p.content === 'string' ? text(p.content) : JSON.stringify(clean(p.content ?? ''))
        if (typeof p.tool_use_id === 'string' && pending.delete(p.tool_use_id)) yield wrap('response_item', { type: 'custom_tool_call_output', call_id: p.tool_use_id, output }, at)
        else yield* message('user', [{ type: 'input_text', text: `[Imported tool result]\n${output}` }], at)
      } else if (!['thinking','redacted_thinking'].includes(String(p.type))) throw Error('A saved message contains content the target cannot carry safely')
    }
  }
  yield* finish(o.timestamp)
}
