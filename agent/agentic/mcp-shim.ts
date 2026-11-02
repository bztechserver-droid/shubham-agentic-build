import { createInterface } from 'node:readline'
import { retryWhileRefused } from './mcp-retry.ts'
import { TOOLS } from './tools.ts'

// F-018: the MCP server each agent's chat runs (claude starts it from the --mcp-config file
// chats.ts hands it): newline-delimited JSON-RPC 2.0 on stdio. It knows no tools of its own:
// tools/list is TOOLS, and every tools/call goes to the agent's API with this chat's key,
// which claude passed down from the terminal it runs in (SAD_AGENTIC_KEY). The key is how the
// agent knows which chat is calling; nothing a model writes can say otherwise.
//   SAD_AGENTIC_URL  http://127.0.0.1:<port>/agent-api/agentic/mcp
//   SAD_AGENTIC_KEY  this chat's key

const url = process.env.SAD_AGENTIC_URL ?? ''
const key = process.env.SAD_AGENTIC_KEY ?? ''
const CALL_TIMEOUT_MS = 120_000
/** F-075: how long a call waits for an agent that is restarting (an update) before it says it can't reach it. */
const AGENT_AWAY_WAIT_MS = 90_000

type Id = string | number | null

function reply(id: Id, result: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function fail(id: Id, code: number, message: string) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

async function call(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  if (!url || !key) return { text: "This chat wasn't started by Shubham Agentic, so its tools can't reach the floor.", isError: true }
  try {
    const res = await retryWhileRefused(
      () =>
        fetch(`${url}/call`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sad-chat-key': key },
          body: JSON.stringify({ name, arguments: args ?? {} }),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        }),
      { maxWaitMs: AGENT_AWAY_WAIT_MS },
    )
    const data = (await res.json().catch(() => ({}))) as { text?: unknown; error?: unknown }
    if (!res.ok) return { text: typeof data.error === 'string' ? data.error : `The agent answered ${res.status}`, isError: true }
    return { text: typeof data.text === 'string' ? data.text : JSON.stringify(data), isError: false }
  } catch (e) {
    return { text: `Couldn't reach Shubham Agentic's agent: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
}

async function handle(msg: { id?: Id; method?: unknown; params?: Record<string, unknown> }) {
  const id = msg.id ?? null
  const isRequest = msg.id !== undefined
  switch (msg.method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'shubham-agentic', version: '1.0.0' },
      })
    case 'tools/list':
      return reply(id, { tools: TOOLS })
    case 'tools/call': {
      const name = typeof msg.params?.name === 'string' ? msg.params.name : ''
      if (!TOOLS.some(t => t.name === name)) return reply(id, { content: [{ type: 'text', text: `No tool called ${name}` }], isError: true })
      const r = await call(name, msg.params?.arguments)
      return reply(id, { content: [{ type: 'text', text: r.text }], isError: r.isError })
    }
    case 'ping':
      return reply(id, {})
    default:
      // Notifications (no id) need no answer; an unknown request does.
      if (isRequest) fail(id, -32601, `Method not found: ${String(msg.method)}`)
  }
}

const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  if (!line.trim()) return
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return fail(null, -32700, 'Parse error')
  }
  if (typeof msg !== 'object' || msg === null) return fail(null, -32600, 'Invalid request')
  void handle(msg as { id?: Id; method?: unknown; params?: Record<string, unknown> })
})
lines.on('close', () => process.exit(0))
