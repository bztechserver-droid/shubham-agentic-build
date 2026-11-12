import type { TokenUse } from '../../shared/api-prices.ts'

// Order o7f34: the Anthropic Messages API, called from the Server with the saved key (model-key.ts). Streamed (the first word is timed), with
// tools when the model asks for them: the efficient route's read-only tools run HERE, in this process, through the function the hub already
// uses for them (old-reader.ts), so the API path reads the same files and no more. No SDK: one fetch, and a small parser for the stream.
// Failures become plain words; the key and the response body are never put in an error or a log.

export const API_BASE = 'https://api.anthropic.com'
export const API_VERSION = '2023-06-01'
/** Tool rounds one question may take (a model that keeps asking for tools is cut off, with what it has said). */
export const MAX_TOOL_ROUNDS = 8
/** The answer's length cap: the reader answers in a few lines. */
export const MAX_OUTPUT_TOKENS = 1024

export type ApiKind = 'refused' | 'limited' | 'rejected' | 'busy' | 'unreachable' | 'aborted'

export class ApiFailure extends Error {
  readonly kind: ApiKind
  readonly status: number
  constructor(kind: ApiKind, status: number) {
    super(apiWords(kind))
    this.name = 'ApiFailure'
    this.kind = kind
    this.status = status
  }
}

/** What the page says for each failure (plain, and never the raw error). */
export function apiWords(kind: ApiKind): string {
  switch (kind) {
    case 'refused':
      return 'The API key was refused. Check it in Settings › Old app reader.'
    case 'limited':
      return 'The API is limiting this key right now. Try again in a minute.'
    case 'rejected':
      return 'The API did not take that request.'
    case 'busy':
      return 'The API is having trouble right now. Try again shortly.'
    case 'unreachable':
      return 'Could not reach the API from the Server.'
    case 'aborted':
      return 'Stopped.'
  }
}

/** The status code's kind (a stream's error event uses its own type name). */
export function kindOfStatus(status: number): ApiKind {
  if (status === 401 || status === 403) return 'refused'
  if (status === 429) return 'limited'
  if (status >= 500 || status === 529) return 'busy'
  return 'rejected'
}

export function kindOfErrorType(type: unknown): ApiKind {
  switch (type) {
    case 'authentication_error':
    case 'permission_error':
      return 'refused'
    case 'rate_limit_error':
      return 'limited'
    case 'overloaded_error':
    case 'api_error':
      return 'busy'
    default:
      return 'rejected'
  }
}

// --- the stream ----------------------------------------------------------------------------------------------------------

/** Server-sent events: whole events only, the `data:` lines of one event joined. Lines may split anywhere between chunks. */
export function sseParser(onEvent: (name: string, data: unknown) => void): { push(chunk: string): void } {
  let buf = ''
  return {
    push(chunk) {
      buf = (buf + chunk).replace(/\r\n/g, '\n')
      let at = buf.indexOf('\n\n')
      while (at >= 0) {
        const block = buf.slice(0, at)
        buf = buf.slice(at + 2)
        let name = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        if (data.length) {
          try {
            onEvent(name, JSON.parse(data.join('\n')))
          } catch {
            // Not JSON: not an event of the API; skipped.
          }
        }
        at = buf.indexOf('\n\n')
      }
    },
  }
}

export interface TextBlock {
  type: 'text'
  text: string
}
export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}
export type Block = TextBlock | ToolUseBlock

export interface ToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface Round {
  blocks: Block[]
  stopReason: string | null
  usage: TokenUse
}

export const NO_USE: TokenUse = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

interface Common {
  key: string
  base?: string
  fetch?: FetchLike
  signal?: AbortSignal
}

function headers(key: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION }
}

async function post(o: Common, body: unknown): Promise<Response> {
  const f = o.fetch ?? fetch
  try {
    const res = await f(`${o.base ?? API_BASE}/v1/messages`, { method: 'POST', headers: headers(o.key), body: JSON.stringify(body), signal: o.signal })
    if (!res.ok) throw new ApiFailure(kindOfStatus(res.status), res.status)
    return res
  } catch (e) {
    if (e instanceof ApiFailure) throw e
    if (o.signal?.aborted || (e instanceof Error && e.name === 'AbortError')) throw new ApiFailure('aborted', 0)
    throw new ApiFailure('unreachable', 0)
  }
}

/** One streamed round: the blocks it wrote, why it stopped, and what it cost. Text is handed on as it arrives. */
export async function streamRound(
  o: Common & { model: string; system: string; messages: unknown[]; tools?: ToolSpec[]; onText(t: string): void },
): Promise<Round> {
  const res = await post(o, {
    model: o.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral' } }],
    messages: o.messages,
    ...(o.tools && o.tools.length ? { tools: o.tools } : {}),
  })
  const blocks: (Block & { json?: string })[] = []
  const usage: TokenUse = { ...NO_USE }
  let stopReason: string | null = null
  if (!res.body) throw new ApiFailure('rejected', res.status)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let failed: ApiFailure | null = null
  const parser = sseParser((name, d) => {
    if (failed) return
    const ev = (d ?? {}) as Record<string, any>
    switch (name) {
      case 'message_start': {
        const u = ev.message?.usage ?? {}
        usage.input += Number(u.input_tokens) || 0
        usage.cacheWrite += Number(u.cache_creation_input_tokens) || 0
        usage.cacheRead += Number(u.cache_read_input_tokens) || 0
        usage.output += Number(u.output_tokens) || 0
        return
      }
      case 'content_block_start': {
        const cb = ev.content_block ?? {}
        if (cb.type === 'text') blocks[ev.index] = { type: 'text', text: String(cb.text ?? '') }
        else if (cb.type === 'tool_use') blocks[ev.index] = { type: 'tool_use', id: String(cb.id ?? ''), name: String(cb.name ?? ''), input: {}, json: '' }
        return
      }
      case 'content_block_delta': {
        const b = blocks[ev.index]
        if (!b) return
        if (ev.delta?.type === 'text_delta' && b.type === 'text') {
          const t = String(ev.delta.text ?? '')
          b.text += t
          if (t) o.onText(t)
        } else if (ev.delta?.type === 'input_json_delta' && b.type === 'tool_use') {
          b.json = (b.json ?? '') + String(ev.delta.partial_json ?? '')
        }
        return
      }
      case 'content_block_stop': {
        const b = blocks[ev.index]
        if (b?.type === 'tool_use') {
          try {
            const parsed = JSON.parse(b.json || '{}') as unknown
            b.input = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
          } catch {
            b.input = {}
          }
          delete b.json
        }
        return
      }
      case 'message_delta': {
        if (typeof ev.delta?.stop_reason === 'string') stopReason = ev.delta.stop_reason
        usage.output += Number(ev.usage?.output_tokens) || 0
        return
      }
      case 'error':
        failed = new ApiFailure(kindOfErrorType(ev.error?.type), 0)
        return
      default:
        return
    }
  })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.push(decoder.decode(value, { stream: true }))
      if (failed) break
    }
  } catch (e) {
    if (o.signal?.aborted || (e instanceof Error && e.name === 'AbortError')) throw new ApiFailure('aborted', 0)
    throw new ApiFailure('unreachable', 0)
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  if (failed) throw failed
  const clean = blocks.filter((b): b is Block => b !== undefined).map(b => (b.type === 'text' ? { type: 'text' as const, text: b.text } : { type: 'tool_use' as const, id: b.id, name: b.name, input: b.input }))
  return { blocks: clean, stopReason, usage }
}

/** A question, answered: streams the words, runs the tools it asks for (up to MAX_TOOL_ROUNDS), and says what it used. */
export async function runTurn(
  o: Common & {
    model: string
    system: string
    question: string
    tools: ToolSpec[]
    runTool(name: string, input: Record<string, unknown>): Promise<string>
    label(name: string): string
    onText(t: string): void
    onTool(name: string, label: string): void
    onFlush(): void
  },
): Promise<{ text: string; usage: TokenUse; rounds: number }> {
  const messages: unknown[] = [{ role: 'user', content: o.question }]
  const usage: TokenUse = { ...NO_USE }
  let text = ''
  let rounds = 0
  for (;;) {
    rounds++
    const r = await streamRound({ ...o, messages, tools: o.tools })
    text += r.blocks.filter(b => b.type === 'text').map(b => b.text).join('')
    usage.input += r.usage.input
    usage.output += r.usage.output
    usage.cacheWrite += r.usage.cacheWrite
    usage.cacheRead += r.usage.cacheRead
    const uses = r.blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')
    if (r.stopReason !== 'tool_use' || uses.length === 0 || rounds >= MAX_TOOL_ROUNDS) return { text, usage, rounds }
    messages.push({ role: 'assistant', content: r.blocks })
    const results: unknown[] = []
    for (const u of uses) {
      o.onFlush()
      o.onTool(u.name, o.label(u.name))
      let content: string
      let isError = false
      try {
        content = await o.runTool(u.name, u.input)
      } catch {
        // The tool's own words are not passed on (they could name a path the model should not see); the model is told it failed.
        content = 'That tool could not run.'
        isError = true
      }
      results.push({ type: 'tool_result', tool_use_id: u.id, content, ...(isError ? { is_error: true } : {}) })
    }
    messages.push({ role: 'user', content: results })
  }
}

/** Makes one tiny call, to see that the key works (the Test button). Never returns the key; the answer's words are not kept. */
export async function testKey(o: Common & { model: string }): Promise<{ ms: number }> {
  const t0 = Date.now()
  await post(o, { model: o.model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK.' }] })
  return { ms: Date.now() - t0 }
}
