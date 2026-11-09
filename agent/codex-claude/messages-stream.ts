import type { ServerResponse } from 'node:http'
import { messagesEvents, type AdapterReply, type ProviderFailureSummary } from './adapter.ts'

export const BRIDGE_REQUEST_TIMEOUT_MS = 10 * 60_000
const PING_MS = 15_000
const errorMessage = (summary?: ProviderFailureSummary) => summary?.category === 'timeout'
  ? 'Codex in Claude Code timed out waiting for a completed reply. This run is paused. Close and reopen this chat before sending a new message; no automatic retry or fallback was used.'
  : 'Codex in Claude Code could not complete this request. This run is paused. Close and reopen this chat before sending a new message; no automatic retry or fallback was used.'

/** Only pings are sent before the full provider result is validated. No partial tool execution. */
export function pendingMessages(res: ServerResponse, streaming: boolean) {
  let ended = false
  const ping = () => { if (!ended && !res.destroyed && !res.writableEnded) res.write('event: ping\ndata: {"type":"ping"}\n\n') }
  if (streaming) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-should-retry': 'false' })
    ping()
  }
  const timer = streaming ? setInterval(ping, PING_MS) : null
  timer?.unref()
  const cleanup = () => { ended = true; if (timer) clearInterval(timer); res.removeListener('close', cleanup) }
  res.once('close', cleanup)
  return {
    complete(reply: AdapterReply) {
      cleanup()
      if (res.destroyed || res.writableEnded) return
      if (!streaming) res.writeHead(200, { 'content-type': 'application/json', 'x-should-retry': 'false' })
      res.end(streaming ? messagesEvents(reply) : JSON.stringify(reply))
    },
    fail(summary?: ProviderFailureSummary) {
      cleanup()
      if (res.destroyed || res.writableEnded) return
      const error = { type: 'error', error: { type: 'api_error', message: errorMessage(summary) } }
      if (!streaming) res.writeHead(summary?.category === 'timeout' ? 504 : 502, { 'content-type': 'application/json', 'x-should-retry': 'false' })
      res.end(streaming ? `event: error\ndata: ${JSON.stringify(error)}\n\n` : JSON.stringify(error))
    },
  }
}
