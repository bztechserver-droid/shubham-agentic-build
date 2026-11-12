import type { ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { BRIDGE_MODEL } from '../../shared/chat-execution.ts'
import { blockEvents, messageEndEvents, messagesEvents, sseEvent, type AdapterReply, type LiveSink } from './adapter.ts'
import type { OpenReason, RequestFailureSummary } from './request-failure.ts'
import { RUN_VERDICT_HEADER } from './child.ts'

export const BRIDGE_REQUEST_TIMEOUT_MS = 10 * 60_000
const PING_MS = 15_000
/** A failure that leaves the run open: what happened, and that the next message goes through. Nothing was retried. */
export const openMessage = (open: OpenReason) => open === 'validation-unanswered'
  ? 'Codex in Claude Code: the ChatGPT login could not be confirmed with the CRM in time (this PC is very busy), so nothing was sent. Send your message again in a moment; nothing was retried.'
  : open === 'provider-unconfirmed'
    ? 'Codex in Claude Code: the previous reply failed and was not retried (ChatGPT\'s stream stopped before the reply was complete). Send a new message to continue.'
    : 'Codex in Claude Code: the app restarted while this reply was being written. That request is not sent again (its result is unknown). Send a new message to continue; nothing was retried.'
const errorMessage = (summary?: RequestFailureSummary) => {
  const reason = summary?.stage === 'authorization' ? 'Authorization for this execution is no longer current.'
    : summary?.stage === 'runtime' ? 'This execution no longer has current runtime proof.'
    : summary?.stage === 'request' ? 'This request could not be translated.'
    : summary?.category === 'timeout' ? 'The request timed out waiting for a completed provider reply.' : 'Could not complete this request.'
  return `Codex in Claude Code: ${reason}${summary?.providerDispatched === false ? ' The provider was not called.' : ''} This run is paused. Close and reopen this chat before sending a new message; no automatic retry or fallback was used.`
}

/**
 * Until the provider's response.created shows Sol at max effort, only pings are sent. From then on (streaming requests)
 * text and Sol's carried reasoning go out live; at the first tool call live delivery stops, and every tool call is sent
 * only from the validated response.completed. What already went out must equal the validated reply, or the request fails.
 */
export function pendingMessages(res: ServerResponse, streaming: boolean) {
  let ended = false, started = false, liveOpen = true
  let open: { type: 'text'; text: string } | null = null
  const sent: Array<{ type: 'text'; text: string } | { type: 'redacted_thinking'; data: string }> = []
  const write = (s: string) => { if (!ended && !res.destroyed && !res.writableEnded) res.write(s) }
  const ping = () => write('event: ping\ndata: {"type":"ping"}\n\n')
  if (streaming) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-should-retry': 'false' })
    ping()
  }
  const timer = streaming ? setInterval(ping, PING_MS) : null
  timer?.unref()
  const cleanup = () => { ended = true; if (timer) clearInterval(timer); res.removeListener('close', cleanup) }
  res.once('close', cleanup)
  const live: LiveSink | undefined = streaming ? {
    begin(id) {
      if (started || !liveOpen) return
      started = true
      write(sseEvent('message_start', { type: 'message_start', message: { id: /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : `msg_${randomUUID()}`, type: 'message', role: 'assistant',
        model: BRIDGE_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }))
    },
    reasoning(data) {
      if (!started || !liveOpen) return
      if (open) return live!.stop()
      write(blockEvents({ type: 'redacted_thinking', data }, sent.length)); sent.push({ type: 'redacted_thinking', data })
    },
    textStart() {
      if (!started || !liveOpen) return
      if (open) return live!.stop()
      open = { type: 'text', text: '' }
      write(sseEvent('content_block_start', { type: 'content_block_start', index: sent.length, content_block: { type: 'text', text: '' } }))
    },
    text(delta) {
      if (!open || !liveOpen || !delta) return
      open.text += delta
      write(sseEvent('content_block_delta', { type: 'content_block_delta', index: sent.length, delta: { type: 'text_delta', text: delta } }))
    },
    textEnd() {
      if (!open) return
      write(sseEvent('content_block_stop', { type: 'content_block_stop', index: sent.length })); sent.push(open); open = null
    },
    stop() {
      if (open) live!.textEnd()
      liveOpen = false
    },
  } : undefined
  /** `open`: the run is NOT paused (the gateway is told so it does not pause either); the message says what to do. */
  const fail = (summary?: RequestFailureSummary, open?: OpenReason | null) => {
    cleanup()
    if (res.destroyed || res.writableEnded) return
    const error = { type: 'error', error: { type: 'api_error', message: open ? openMessage(open) : errorMessage(summary) } }
    if (!streaming) res.writeHead(summary?.category === 'timeout' ? 504 : 502, { 'content-type': 'application/json', 'x-should-retry': 'false', ...(open ? { [RUN_VERDICT_HEADER]: 'open' } : {}) })
    res.end(streaming ? `event: error\ndata: ${JSON.stringify(error)}\n\n` : JSON.stringify(error))
  }
  return {
    live,
    /** Whether anything of the reply already went out live (a later failure still ends it with an error event). */
    get started() { return started },
    /** False when what already went out live differs from the validated reply (it then ends with an error event). */
    complete(reply: AdapterReply): boolean {
      if (started) {
        if (open) live!.textEnd()
        const same = sent.every((block, i) => {
          const final = reply.content[i]
          return final?.type === block.type && (block.type === 'text' ? final.text === block.text : final.data === block.data)
        })
        if (!same) { fail({ stage: 'stream', category: 'live-mismatch' }); return false }
        let out = ''
        reply.content.slice(sent.length).forEach((block, k) => { out += blockEvents(block, sent.length + k) })
        cleanup()
        if (!res.destroyed && !res.writableEnded) res.end(out + messageEndEvents(reply))
        return true
      }
      cleanup()
      if (res.destroyed || res.writableEnded) return true
      if (!streaming) res.writeHead(200, { 'content-type': 'application/json', 'x-should-retry': 'false' })
      res.end(streaming ? messagesEvents(reply) : JSON.stringify(reply))
      return true
    },
    fail,
  }
}
