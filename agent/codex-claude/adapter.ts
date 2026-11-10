// App-owned implementation from the published Messages/Responses schemas. No third-party proxy code.
import { createHash, randomUUID } from 'node:crypto'
import type { ReadableStreamReadResult } from 'node:stream/web'
import { BRIDGE_MODEL, BRIDGE_EFFORT, contractRecord, resolveBridgeModelAlias } from '../../shared/chat-execution.ts'
import type { BridgeRequestAuthorization } from './contract.ts'

export const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const refused = (): never => { throw Object.assign(new Error('This Claude Code request is unsupported by the Codex adapter.'), { status: 400, code: 'bridge-policy-refused' }) }
export interface ProviderFailureSummary { stage: 'http' | 'transport' | 'stream' | 'policy'; status?: number; category?: string; parameter?: string; model?: string; effort?: string; mediaType?: 'event-stream' | 'json' | 'html' | 'text' | 'other' | 'missing' }
export interface ProviderProgress { phase: 'connecting' | 'headers' | 'reading' | 'completed'; status?: number; bytes: number; events: number }
type ProgressObserver = (progress: ProviderProgress) => void
const note = (observer: ProgressObserver | undefined, value: ProviderProgress) => { try { observer?.(value) } catch { /* Diagnostics cannot alter a provider operation. */ } }
const cancellation = (signal: AbortSignal) => signal.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted'
const failures = new WeakMap<Error, ProviderFailureSummary>()
export const providerFailureSummary = (error: unknown): ProviderFailureSummary => error instanceof Error && failures.has(error) ? failures.get(error)! : { stage: 'stream' }
/** The adapter's own record of how a provider call failed, or null when the error did not come from the adapter. */
export const recordedProviderFailure = (error: unknown): ProviderFailureSummary | null => error instanceof Error ? failures.get(error) ?? null : null
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
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
}

// Speed (F-163, 9 Nov): Sol's own reasoning is carried from one step of a turn to the next, as Codex itself does
// (store:false + include reasoning.encrypted_content). It travels inside Claude Code's history as an opaque
// redacted_thinking block, tagged with a hash of the ChatGPT account it belongs to, so it is never sent to another.
const REASONING_PREFIX = 'sadbr1.', IDS_PREFIX = 'sadbi1.'
const REASONING_TAG = Symbol('sad-bridge-reasoning-account'), ID_TAG = Symbol('sad-bridge-item-ids-account')
const ITEM_ID = /^(rs|msg|fc)_[A-Za-z0-9_-]{1,200}$/
/** The ids of a reply's carried items in output order (reasoning, message, function call), as Codex sends them back:
 * a trailing opaque block, so live text can go out before the ids are known. */
function idsBlock(tag: string, ids: string[]): { type: 'redacted_thinking'; data: string } | null {
  return /^[a-f0-9]{16}$/.test(tag) && ids.length > 0 && ids.length <= 512 && ids.every(id => ITEM_ID.test(id)) ? { type: 'redacted_thinking', data: `${IDS_PREFIX}${tag}.${ids.join('.')}` } : null
}
function carriedIds(data: unknown): { tag: string; ids: string[] } | null {
  if (typeof data !== 'string' || !data.startsWith(IDS_PREFIX)) return null
  const [tag, ...ids] = data.slice(IDS_PREFIX.length).split('.')
  return idsBlock(tag, ids) ? { tag, ids } : null
}
export const reasoningTag = (accountId: string) => createHash('sha256').update(`sad-bridge-reasoning:${accountId}`).digest('hex').slice(0, 16)
const CONVERSATION_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** One key per chat session, shaped like the conversation id native Codex sends (a UUID): it goes out as `prompt_cache_key`
 * and as the `session_id` header, as Codex sends both. With the body field alone (10 Nov) the endpoint reused nothing (0% cached). */
export function bridgeConversationKey(sessionId: string | null): string {
  const h = createHash('sha256').update(`sad-bridge-cache:${sessionId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 | (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
const ENCRYPTED = /^[A-Za-z0-9+/=_-]{1,1048576}$/
/** The Claude Code block for one encrypted reasoning item, or null when it is not something to carry. */
export function reasoningBlock(tag: string, encrypted: unknown): { type: 'redacted_thinking'; data: string } | null {
  return /^[a-f0-9]{16}$/.test(tag) && typeof encrypted === 'string' && ENCRYPTED.test(encrypted) ? { type: 'redacted_thinking', data: `${REASONING_PREFIX}${tag}.${encrypted}` } : null
}
function carriedReasoning(data: unknown): { tag: string; encrypted: string } | null {
  if (typeof data !== 'string' || !data.startsWith(REASONING_PREFIX)) return null
  const rest = data.slice(REASONING_PREFIX.length), tag = rest.slice(0, 16), encrypted = rest.slice(17)
  return rest[16] === '.' && reasoningBlock(tag, encrypted) ? { tag, encrypted } : null
}
/** Live delivery of a streamed reply to Claude Code. Only text and carried reasoning are ever sent live;
 * tool calls wait for the validated response.completed. */
export interface LiveSink {
  begin(id: string): void
  reasoning(data: string): void
  textStart(): void
  text(delta: string): void
  textEnd(): void
  stop(): void
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
/** A Claude Code tool result as Codex sends a tool output. Text only stays one string, exactly as before. A result holding
 * images (a screenshot, an image file that was Read) becomes the content-item list native Codex 0.163 sends to the same
 * endpoint: input_text and input_image (detail high), in order (10 Nov 2026: Web paused on screenshots in its history).
 * Anything else (a PDF document, unknown blocks) is still refused before dispatch, never turned into fabricated text. */
function toolOutput(value: unknown): string | Array<Record<string, unknown>> {
  if (typeof value === 'string') return value
  const parts = contentBlocks(value ?? []).map(part => {
    if (part.type === 'text') return { type: 'input_text', text: text(part.text) }
    if (part.type === 'tool_reference' && typeof part.tool_name === 'string') return { type: 'input_text', text: `Available tool: ${part.tool_name}` }
    if (part.type === 'image') return { ...image(part), detail: 'high' }
    return refused()
  })
  if (parts.every(part => part.type === 'input_text')) return parts.map(part => part.text).join('\n')
  return parts.filter(part => part.type !== 'input_text' || part.text !== '')
}

/** Every request, including small/secondary/compaction calls, is explicitly Sol/max.
 * `cacheKey`: one per conversation, so the endpoint keeps reusing its cached prefix (Codex sends its conversation id).
 * `carryReasoning`: ask for Sol's encrypted reasoning, and send back the reasoning of the current turn (the steps after
 * the last prompt typed by a person), so a tool loop continues its reasoning instead of starting over each step. */
export function toResponses(value: unknown, options: { cacheKey?: string; carryReasoning?: boolean } = {}): Record<string, unknown> {
  const request = record(value)
  resolveBridgeModelAlias(request.model)
  const system = request.system === undefined ? '' : contentBlocks(request.system).map(block => block.type === 'text' ? text(block.text) : refused()).join('\n')
  const input: Array<Record<string, unknown>> = []
  const messages = array(request.messages)
  let turnStart = -1
  messages.forEach((entry, i) => {
    const message = record(entry)
    if (message.role === 'user' && contentBlocks(message.content).every(block => block.type !== 'tool_result')) turnStart = i
  })
  // Carried reasoning is sent the way Codex sends it: each reasoning item with its id, and the message and function call
  // that followed it with theirs. The ids come from the trailing ids block of each reply; a reply whose items do not line
  // up exactly with its ids carries nothing (its reasoning is left out, as before this change), so nothing half-linked is sent.
  let pending: Array<Record<string, unknown>> = []
  const drop = new Set<Record<string, unknown>>()
  const kind = (item: Record<string, unknown>) => item.type === 'reasoning' ? 'rs' : item.type === 'function_call' ? 'fc' : item.role === 'assistant' ? 'msg' : '?'
  const settle = (marker: { tag: string; ids: string[] } | null) => {
    const reasoning = pending.filter(item => REASONING_TAG in item)
    const aligned = marker !== null && pending.length === marker.ids.length && pending.every((item, k) => marker.ids[k].startsWith(`${kind(item)}_`))
      && reasoning.every(item => (item as Record<symbol, unknown>)[REASONING_TAG] === marker.tag)
    if (aligned) pending.forEach((item, k) => Object.assign(item, { id: marker!.ids[k] }, { [ID_TAG]: marker!.tag }))
    else for (const item of reasoning) drop.add(item)
    pending = []
  }
  for (const [i, entry] of messages.entries()) {
    const message = record(entry)
    if (!['user', 'assistant', 'system', 'developer'].includes(String(message.role))) return refused()
    const scope = message.role === 'assistant' && options.carryReasoning === true && i > turnStart
    if (message.role !== 'assistant') settle(null)
    const emit = (item: Record<string, unknown>) => { input.push(item); if (scope) pending.push(item) }
    let content: Array<Record<string, unknown>> = []
    const flush = () => { if (content.length) { emit({ role: message.role, content }); content = [] } }
    for (const block of contentBlocks(message.content)) {
      if (block.type === 'text') content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: text(block.text) })
      else if (block.type === 'image' && message.role === 'user') content.push(image(block))
      else if (block.type === 'tool_use' && message.role === 'assistant') {
        flush(); emit({ type: 'function_call', call_id: text(block.id), name: text(block.name), arguments: JSON.stringify(record(block.input)) })
      } else if (block.type === 'tool_result' && message.role === 'user') {
        flush()
        input.push({ type: 'function_call_output', call_id: text(block.tool_use_id), output: toolOutput(block.content) })
      } else if (block.type === 'redacted_thinking' && scope && carriedReasoning(block.data)) {
        // Sent only if it belongs to the account that will be used (sendResponses compares the tag); never serialized itself.
        const carried = carriedReasoning(block.data)!
        flush(); emit(Object.assign({ type: 'reasoning', summary: [], encrypted_content: carried.encrypted }, { [REASONING_TAG]: carried.tag }))
      } else if (block.type === 'redacted_thinking' && scope && carriedIds(block.data)) {
        flush(); settle(carriedIds(block.data))
      } else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') return refused()
    }
    flush()
  }
  settle(null)
  if (drop.size) input.splice(0, input.length, ...input.filter(item => !drop.has(item)))
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
    tools, tool_choice: toolChoice, parallel_tool_calls: true, reasoning: { effort: BRIDGE_EFFORT }, stream: true, store: false,
    ...(options.carryReasoning ? { include: ['reasoning.encrypted_content'] } : {}),
    ...(options.cacheKey && /^[A-Za-z0-9_-]{8,64}$/.test(options.cacheKey) ? { prompt_cache_key: options.cacheKey } : {}) }
}

/** `reasoningTag`: carry Sol's encrypted reasoning back to Claude Code (the account's tag); without it reasoning is dropped, as before. */
export function fromResponses(value: unknown, options: { reasoningTag?: string } = {}): AdapterReply {
  const response = record(value)
  if (response.status !== 'completed' || response.model !== BRIDGE_MODEL || !contractRecord(response.reasoning) || response.reasoning.effort !== BRIDGE_EFFORT) return unavailable({ stage: 'policy',
    ...(typeof response.model === 'string' && /^gpt-[a-z0-9.-]{1,64}$/.test(response.model) ? { model: response.model } : {}),
    ...(contractRecord(response.reasoning) && ['low','medium','high','xhigh','max'].includes(String(response.reasoning.effort)) ? { effort: String(response.reasoning.effort) } : {}) })
  const content: Array<Record<string, unknown>> = [], ids: string[] = []
  let carriedAny = false
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
    } else if (item.type === 'reasoning') {
      const carried = options.reasoningTag ? reasoningBlock(options.reasoningTag, item.encrypted_content) : null
      if (carried) { content.push(carried); carriedAny = true }
    } else return refused()
    if (options.reasoningTag && (item.type !== 'reasoning' || reasoningBlock(options.reasoningTag, item.encrypted_content))) ids.push(typeof item.id === 'string' ? item.id : '')
  }
  // The ids of what this reply carries, last, so Claude Code sends them back with it (see toResponses).
  const marker = options.reasoningTag && carriedAny ? idsBlock(options.reasoningTag, ids) : null
  if (marker) content.push(marker)
  const usage = contractRecord(response.usage) ? response.usage : {}
  const tokens = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
  // The endpoint counts cached tokens inside input_tokens; Claude Code counts them apart, as cache reads.
  const cached = Math.min(tokens(contractRecord(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : 0), tokens(usage.input_tokens))
  return { id: typeof response.id === 'string' ? response.id : `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: BRIDGE_MODEL,
    content, stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: tokens(usage.input_tokens) - cached, output_tokens: tokens(usage.output_tokens), ...(cached ? { cache_read_input_tokens: cached } : {}) } }
}

/** Safe timing/usage facts of a completed response for the diagnostics (numbers only). */
export function responseUsage(value: unknown): { input: number; cached: number; output: number; reasoning: number } {
  const usage = contractRecord(value) && contractRecord(value.usage) ? value.usage : {}
  const n = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0
  return { input: n(usage.input_tokens), cached: n(contractRecord(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : 0),
    output: n(usage.output_tokens), reasoning: n(contractRecord(usage.output_tokens_details) ? usage.output_tokens_details.reasoning_tokens : 0) }
}

/** Streams text (and carried reasoning) of a reply live once response.created shows Sol at max effort. Live delivery stops
 * at the first function call; everything from there, and every tool call, waits for the validated response.completed. */
function liveReader(live: { sink: LiveSink; tag: string } | undefined) {
  let on = false, textOpen = false, soFar = ''
  const call = (fn: () => void) => { try { fn() } catch { on = false } }
  const stop = () => {
    if (!on) return
    if (textOpen) { textOpen = false; call(() => live!.sink.textEnd()) }
    on = false; call(() => live!.sink.stop())
  }
  return (event: Record<string, unknown>) => {
    if (!live) return
    if (event.type === 'response.created') {
      const r = event.response
      if (!on && contractRecord(r) && r.model === BRIDGE_MODEL && contractRecord(r.reasoning) && r.reasoning.effort === BRIDGE_EFFORT) {
        on = true; call(() => live.sink.begin(typeof r.id === 'string' ? r.id : ''))
      }
      return
    }
    if (!on) return
    const item = contractRecord(event.item) ? event.item : null, part = contractRecord(event.part) ? event.part : null
    if (event.type === 'response.output_item.added' && item?.type === 'function_call') stop()
    else if (event.type === 'response.output_item.done' && item?.type === 'reasoning') {
      const block = reasoningBlock(live.tag, item.encrypted_content)
      if (block) call(() => live.sink.reasoning(block.data))
    } else if (event.type === 'response.content_part.added') {
      if (part?.type === 'output_text' || part?.type === 'refusal') { textOpen = true; soFar = ''; call(() => live.sink.textStart()) } else stop()
    } else if ((event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') && textOpen && typeof event.delta === 'string' && event.delta) {
      soFar += event.delta; call(() => live.sink.text(event.delta as string))
    } else if (event.type === 'response.content_part.done' && textOpen) {
      // The part's final text: whatever the deltas missed is sent now, so the live block equals the validated one.
      const full = part?.type === 'refusal' ? part.refusal : part?.text
      if (typeof full === 'string' && full !== soFar) {
        if (!full.startsWith(soFar)) return stop()
        const rest = full.slice(soFar.length); soFar = full; call(() => live.sink.text(rest))
      }
      textOpen = false; call(() => live.sink.textEnd())
    }
  }
}

export async function readCompletedResponse(response: Response, signal: AbortSignal, observer?: ProgressObserver, live?: { sink: LiveSink; tag: string }): Promise<Record<string, unknown>> {
  note(observer, { phase: 'headers', status: response.status, bytes: 0, events: 0 })
  const onLive = liveReader(live)
  const read = (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> => new Promise((resolve, reject) => {
    const aborted = () => {
      void reader.cancel().catch(() => {})
      try { unavailable({ stage: 'transport', category: cancellation(signal) }) } catch (error) { reject(error) }
    }
    if (signal.aborted) return aborted()
    signal.addEventListener('abort', aborted, { once: true })
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const mediaType: ProviderFailureSummary['mediaType'] = !type ? 'missing' : type === 'text/event-stream' ? 'event-stream' : type === 'application/json' ? 'json' : type === 'text/html' ? 'html' : type === 'text/plain' ? 'text' : 'other'
  if (!response.ok) {
    let raw = ''
    // The failed status is known from the headers: a cancellation or broken body while reading its details does not erase it.
    if (response.body) { const reader = response.body.getReader(); try { while (raw.length < 8192) { const chunk = await read(reader); if (chunk.done) break; raw += new TextDecoder().decode(chunk.value) } } catch { /* The status stays the failure. */ } finally { void reader.cancel().catch(() => {}); reader.releaseLock() } }
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
  let pending = '', sample = '', bytes = 0, events = 0
  try {
    for (;;) {
      if (signal.aborted) return unavailable({ stage: 'transport', category: cancellation(signal) })
      const chunk = await read(reader)
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 64 * 1024 * 1024) return unavailable()
      const decoded = decoder.decode(chunk.value, { stream: true })
      note(observer, { phase: 'reading', status: response.status, bytes, events })
      sample = (sample + decoded).slice(0, 8192)
      pending = (pending + decoded).replaceAll('\r\n', '\n')
      let at: number
      while ((at = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, at); pending = pending.slice(at + 2)
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        if (data === '[DONE]') return unavailable({ stage: 'stream', category: 'missing-completed-event', mediaType })
        let event: Record<string, unknown>
        try { event = record(JSON.parse(data)) } catch { return unavailable() }
        events++
        if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') return unavailable({ stage: 'stream', category: event.type, mediaType })
        onLive(event)
        if (event.type === 'response.completed') {
          const completed = record(event.response)
          fromResponses(completed)
          note(observer, { phase: 'completed', status: response.status, bytes, events })
          return completed
        }
      }
    }
    {
      let category = signal.aborted ? cancellation(signal) : 'missing-completed-event'
      if (!signal.aborted && /^\s*(?:<!doctype html|<html)/i.test(sample)) category = /cf-chl|just a moment|cloudflare/i.test(sample) ? 'html-challenge' : 'html-response'
      else if (!signal.aborted && /^\s*[{[]/.test(sample)) category = 'json-response'
      return unavailable({ stage: 'stream', status: response.status, category, mediaType })
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Initiates the fixed-destination operation synchronously, before returning a Promise to the manager.
 * Carried reasoning goes only to the ChatGPT account it came from; anyone else's is left out, never sent. */
export function sendResponses(body: Record<string, unknown>, authorization: BridgeRequestAuthorization, signal: AbortSignal, observer?: ProgressObserver, live?: LiveSink): Promise<Record<string, unknown>> {
  if (signal.aborted) return unavailable({ stage: 'transport', category: cancellation(signal) })
  if (body.model !== BRIDGE_MODEL || record(body.reasoning).effort !== BRIDGE_EFFORT) return unavailable()
  note(observer, { phase: 'connecting', bytes: 0, events: 0 })
  const accountId = authorization.accountId, tag = reasoningTag(accountId)
  // Another account's carried reasoning is left out, and the items it led to go without their ids (as before this change).
  const input = Array.isArray(body.input)
    ? body.input.filter(item => !(typeof item === 'object' && item !== null && REASONING_TAG in item) || (item as Record<symbol, unknown>)[REASONING_TAG] === tag)
      .map(item => {
        if (typeof item !== 'object' || item === null || !(ID_TAG in item) || (item as Record<symbol, unknown>)[ID_TAG] === tag) return item
        const { id: _id, ...rest } = item as Record<string, unknown>
        return rest
      })
    : body.input
  const request = fetch(CODEX_RESPONSES_ENDPOINT, { method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${authorization.accessToken}`, 'chatgpt-account-id': accountId,
      'content-type': 'application/json', accept: 'text/event-stream', originator: 'codex_cli_rs', version: '0.163.0',
      'user-agent': 'shubham-agentic-codex-claude/1 (Codex protocol 0.163.0; Claude Code 2.1.319)',
      // The conversation key, as Codex sends its conversation id: the endpoint keeps the cached prefix of this conversation.
      ...(typeof body.prompt_cache_key === 'string' && CONVERSATION_KEY.test(body.prompt_cache_key) ? { session_id: body.prompt_cache_key } : {}) },
    body: JSON.stringify({ ...body, input }) })
  return request.then(response => readCompletedResponse(response, signal, observer, live ? { sink: live, tag } : undefined)).catch(error => {
    if (error instanceof Error && failures.has(error)) throw error
    const code = (error as { cause?: { code?: string } })?.cause?.code
    return unavailable({ stage: 'transport', category: signal.aborted ? cancellation(signal) : typeof code === 'string' && ['ECONNRESET','ENOTFOUND','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','ETIMEDOUT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','CERT_HAS_EXPIRED'].includes(code) ? code : 'unavailable' })
  })
}

export const sseEvent = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
/** One finished content block as Messages events at `index`. Carried reasoning is an opaque redacted_thinking block. */
export function blockEvents(block: Record<string, unknown>, index: number): string {
  if (block.type === 'redacted_thinking') return sseEvent('content_block_start', { type: 'content_block_start', index, content_block: { type: 'redacted_thinking', data: block.data } })
    + sseEvent('content_block_stop', { type: 'content_block_stop', index })
  const tool = block.type === 'tool_use'
  return sseEvent('content_block_start', { type: 'content_block_start', index, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } })
    + sseEvent('content_block_delta', { type: 'content_block_delta', index,
      delta: tool ? { type: 'input_json_delta', partial_json: jsonText(block.input) } : { type: 'text_delta', text: block.text } })
    + sseEvent('content_block_stop', { type: 'content_block_stop', index })
}
/** The end of a message; usage carries input and cache reads too, for a message whose start went out before they were known. */
export const messageEndEvents = (reply: AdapterReply) => sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: reply.stop_reason, stop_sequence: null },
  usage: { output_tokens: reply.usage.output_tokens, input_tokens: reply.usage.input_tokens, ...(reply.usage.cache_read_input_tokens ? { cache_read_input_tokens: reply.usage.cache_read_input_tokens } : {}) } })
  + sseEvent('message_stop', { type: 'message_stop' })

/** Completed output is translated to Messages events; provider errors cannot turn into partial tool execution. */
export function messagesEvents(reply: AdapterReply): string {
  let out = sseEvent('message_start', { type: 'message_start', message: { ...reply, content: [], stop_reason: null, usage: { ...reply.usage, output_tokens: 0 } } })
  reply.content.forEach((block, index) => { out += blockEvents(block, index) })
  return out + messageEndEvents(reply)
}
