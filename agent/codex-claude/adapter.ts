// App-owned implementation from the published Messages/Responses schemas. No third-party proxy code.
import { randomUUID } from 'node:crypto'
import { BRIDGE_MODEL, BRIDGE_EFFORT, contractRecord, resolveBridgeModelAlias } from '../../shared/chat-execution.ts'
import type { BridgeRequestAuthorization } from './contract.ts'

export const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const refused = (): never => { throw Object.assign(new Error('This Claude Code request is unsupported by the Codex adapter.'), { status: 400, code: 'bridge-policy-refused' }) }
export interface ProviderFailureSummary { stage: 'http' | 'transport' | 'stream' | 'policy'; status?: number; category?: string; parameter?: string; model?: string; effort?: string; mediaType?: 'event-stream' | 'json' | 'html' | 'text' | 'other' | 'missing' }
const failures = new WeakMap<Error, ProviderFailureSummary>()
export const providerFailureSummary = (error: unknown): ProviderFailureSummary => error instanceof Error && failures.has(error) ? failures.get(error)! : { stage: 'stream' }
const unavailable = (summary: ProviderFailureSummary = { stage: 'stream' }): never => {
  const error = Object.assign(new Error('The Codex endpoint did not complete the requested Sol/max operation. No retry was made.'), { status: 502, code: 'bridge-policy-refused' })
  failures.set(error, Object.freeze(summary)); throw error
}
const record = (value: unknown): Record<string, unknown> => contractRecord(value) ? value : refused()
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : refused()
const text = (value: unknown): string => typeof value === 'string' ? value : refused()
const jsonText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value)
export interface AdapterReply {
  id: string; type: 'message'; role: 'assistant'; model: typeof BRIDGE_MODEL;
  content: Array<Record<string, unknown>>; stop_reason: 'end_turn' | 'tool_use'; stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
}

function image(block: Record<string, unknown>): Record<string, unknown> {
  const source = record(block.source)
  if (source.type !== 'base64' || typeof source.media_type !== 'string' || !/^image\/(png|jpeg|webp|gif)$/.test(source.media_type)
    || typeof source.data !== 'string' || source.data.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/=\r\n]+$/.test(source.data)) return refused()
  return { type: 'input_image', image_url: `data:${source.media_type};base64,${source.data}` }
}
function contentBlocks(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  return array(value).map(record)
}

/** Every request, including small/secondary/compaction calls, is explicitly Sol/max. */
export function toResponses(value: unknown): Record<string, unknown> {
  const request = record(value)
  resolveBridgeModelAlias(request.model)
  const system = request.system === undefined ? '' : contentBlocks(request.system).map(block => block.type === 'text' ? text(block.text) : refused()).join('\n')
  const input: Array<Record<string, unknown>> = []
  for (const entry of array(request.messages)) {
    const message = record(entry)
    if (!['user', 'assistant', 'system', 'developer'].includes(String(message.role))) return refused()
    let content: Array<Record<string, unknown>> = []
    const flush = () => { if (content.length) { input.push({ role: message.role, content }); content = [] } }
    for (const block of contentBlocks(message.content)) {
      if (block.type === 'text') content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: text(block.text) })
      else if (block.type === 'image' && message.role === 'user') content.push(image(block))
      else if (block.type === 'tool_use' && message.role === 'assistant') {
        flush(); input.push({ type: 'function_call', call_id: text(block.id), name: text(block.name), arguments: JSON.stringify(record(block.input)) })
      } else if (block.type === 'tool_result' && message.role === 'user') {
        flush()
        const result = typeof block.content === 'string' ? block.content : contentBlocks(block.content ?? []).map(part => {
          if (part.type === 'text') return text(part.text)
          if (part.type === 'tool_reference' && typeof part.tool_name === 'string') return `Available tool: ${part.tool_name}`
          // File/image tool results remain explicit, and are not turned into fabricated text.
          return refused()
        }).join('\n')
        input.push({ type: 'function_call_output', call_id: text(block.tool_use_id), output: result })
      } else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') return refused()
    }
    flush()
  }
  const tools = request.tools === undefined ? [] : array(request.tools).map(value => {
    const tool = record(value)
    if (tool.type !== undefined && tool.type !== 'custom') return refused()
    return { type: 'function', name: text(tool.name), description: typeof tool.description === 'string' ? tool.description : '',
      parameters: record(tool.input_schema), strict: false }
  })
  let toolChoice: unknown = 'auto'
  if (request.tool_choice !== undefined) {
    const choice = record(request.tool_choice)
    if (choice.type === 'auto' || choice.type === 'none') toolChoice = choice.type
    else if (choice.type === 'any') toolChoice = 'required'
    else if (choice.type === 'tool') toolChoice = { type: 'function', name: text(choice.name) }
    else return refused()
  }
  if (request.stop_sequences !== undefined && array(request.stop_sequences).length) return refused()
  const output = contractRecord(request.output_config) && contractRecord(request.output_config.format) ? request.output_config.format : null
  if (output && output.type !== 'json_schema') return refused()
  return { model: BRIDGE_MODEL, instructions: system || 'You are a coding assistant running through Claude Code.', input,
    ...(output ? { text: { format: { type: 'json_schema', name: 'claude_code_output', strict: true, schema: record(output.schema) } } } : {}),
    tools, tool_choice: toolChoice, parallel_tool_calls: true, reasoning: { effort: BRIDGE_EFFORT }, stream: true, store: false }
}

export function fromResponses(value: unknown): AdapterReply {
  const response = record(value)
  if (response.status !== 'completed' || response.model !== BRIDGE_MODEL || !contractRecord(response.reasoning) || response.reasoning.effort !== BRIDGE_EFFORT) return unavailable({ stage: 'policy',
    ...(typeof response.model === 'string' && /^gpt-[a-z0-9.-]{1,64}$/.test(response.model) ? { model: response.model } : {}),
    ...(contractRecord(response.reasoning) && ['low','medium','high','xhigh','max'].includes(String(response.reasoning.effort)) ? { effort: String(response.reasoning.effort) } : {}) })
  const content: Array<Record<string, unknown>> = []
  for (const value of array(response.output)) {
    const item = record(value)
    if (item.type === 'message') for (const part of array(item.content).map(record)) {
      if (part.type === 'output_text') content.push({ type: 'text', text: text(part.text) })
      else if (part.type === 'refusal') content.push({ type: 'text', text: text(part.refusal) })
      else return refused()
    }
    else if (item.type === 'function_call') {
      let input: unknown
      try { input = JSON.parse(text(item.arguments)) } catch { return unavailable() }
      content.push({ type: 'tool_use', id: text(item.call_id), name: text(item.name), input: record(input) })
    } else if (item.type !== 'reasoning') return refused()
  }
  const usage = contractRecord(response.usage) ? response.usage : {}
  const tokens = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
  return { id: typeof response.id === 'string' ? response.id : `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: BRIDGE_MODEL,
    content, stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: tokens(usage.input_tokens), output_tokens: tokens(usage.output_tokens) } }
}

export async function readCompletedResponse(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const mediaType: ProviderFailureSummary['mediaType'] = !type ? 'missing' : type === 'text/event-stream' ? 'event-stream' : type === 'application/json' ? 'json' : type === 'text/html' ? 'html' : type === 'text/plain' ? 'text' : 'other'
  if (!response.ok) {
    let raw = ''
    if (response.body) { const reader = response.body.getReader(); try { while (raw.length < 8192) { const chunk = await reader.read(); if (chunk.done) break; raw += new TextDecoder().decode(chunk.value) } } finally { await reader.cancel().catch(() => {}); reader.releaseLock() } }
    let parameter: string | undefined, category = response.status === 401 || response.status === 403 ? 'authorization' : response.status === 429 ? 'rate-limit' : 'refused'
    try {
      const data = JSON.parse(raw), detail = typeof data.detail === 'string' ? data.detail : ''
      const param = data.error?.param ?? /Unsupported parameter: ([a-zA-Z0-9_.[\]]+)/.exec(detail)?.[1]
      if (typeof param === 'string' && ['model','instructions','input','tools','tool_choice','stream','store','reasoning','reasoning.effort','include','parallel_tool_calls'].includes(param)) parameter = param
      if (detail.includes('requires a newer version of Codex') || String(data.error?.message ?? '').includes('requires a newer version of Codex')) category = 'client-version-required'
    } catch { /* Never retain arbitrary upstream body or message. */ }
    return unavailable({ stage: 'http', status: response.status, category, ...(parameter ? { parameter } : {}) })
  }
  if (!response.body) return unavailable({ stage: 'http', status: response.status, category: 'empty-response', mediaType })
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let pending = '', sample = '', bytes = 0, completed: Record<string, unknown> | null = null
  try {
    for (;;) {
      if (signal.aborted) return unavailable()
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 64 * 1024 * 1024) return unavailable()
      const decoded = decoder.decode(chunk.value, { stream: true })
      sample = (sample + decoded).slice(0, 8192)
      pending = (pending + decoded).replaceAll('\r\n', '\n')
      let at: number
      while ((at = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, at); pending = pending.slice(at + 2)
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data || data === '[DONE]') continue
        let event: Record<string, unknown>
        try { event = record(JSON.parse(data)) } catch { return unavailable() }
        if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') return unavailable({ stage: 'stream', category: event.type, mediaType })
        if (event.type === 'response.completed') completed = record(event.response)
      }
    }
    if (!completed || signal.aborted) {
      let category = signal.aborted ? 'aborted' : 'missing-completed-event'
      if (!signal.aborted && /^\s*(?:<!doctype html|<html)/i.test(sample)) category = /cf-chl|just a moment|cloudflare/i.test(sample) ? 'html-challenge' : 'html-response'
      else if (!signal.aborted && /^\s*[{[]/.test(sample)) category = 'json-response'
      return unavailable({ stage: 'stream', status: response.status, category, mediaType })
    }
    return completed
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Initiates the fixed-destination operation synchronously, before returning a Promise to the manager. */
export function sendResponses(body: Record<string, unknown>, authorization: BridgeRequestAuthorization, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (body.model !== BRIDGE_MODEL || record(body.reasoning).effort !== BRIDGE_EFFORT || signal.aborted) return unavailable()
  const request = fetch(CODEX_RESPONSES_ENDPOINT, { method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${authorization.accessToken}`, 'chatgpt-account-id': authorization.accountId,
      'content-type': 'application/json', accept: 'text/event-stream', originator: 'codex_cli_rs', version: '0.163.0',
      'user-agent': 'shubham-agentic-codex-claude/1 (Codex protocol 0.163.0; Claude Code 2.1.319)' },
    body: JSON.stringify(body) })
  return request.then(response => readCompletedResponse(response, signal)).catch(error => {
    if (error instanceof Error && failures.has(error)) throw error
    const code = (error as { cause?: { code?: string } })?.cause?.code
    return unavailable({ stage: 'transport', category: typeof code === 'string' && ['ECONNRESET','ENOTFOUND','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','CERT_HAS_EXPIRED'].includes(code) ? code : 'unavailable' })
  })
}

/** Completed output is translated to Messages events; provider errors cannot turn into partial tool execution. */
export function messagesEvents(reply: AdapterReply): string {
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  let out = event('message_start', { type: 'message_start', message: { ...reply, content: [], stop_reason: null, usage: { ...reply.usage, output_tokens: 0 } } })
  reply.content.forEach((block, index) => {
    const tool = block.type === 'tool_use'
    out += event('content_block_start', { type: 'content_block_start', index, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } })
    out += event('content_block_delta', { type: 'content_block_delta', index,
      delta: tool ? { type: 'input_json_delta', partial_json: jsonText(block.input) } : { type: 'text_delta', text: block.text } })
    out += event('content_block_stop', { type: 'content_block_stop', index })
  })
  return out + event('message_delta', { type: 'message_delta', delta: { stop_reason: reply.stop_reason, stop_sequence: null }, usage: { output_tokens: reply.usage.output_tokens } })
    + event('message_stop', { type: 'message_stop' })
}
