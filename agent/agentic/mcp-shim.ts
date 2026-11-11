import { createInterface } from 'node:readline'
import { retryWhileRefused } from './mcp-retry.ts'
import { FAST_TOOLS } from './fast-tools-list.ts'
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
// F-087: the fast Assistant's process runs this same shim with SAD_TOOLSET=fast: it is told about its own few tools only (the hub still
// decides every call by its key).
const FAST = process.env.SAD_TOOLSET === 'fast'
// What this process was built with. Not the last word for a full toolset: the agent's current list is (below), because this process
// can outlive an Update (the chat host keeps the chat), and a tool added by then must still reach the chat.
let LISTED: readonly { name: string }[] = FAST ? FAST_TOOLS : TOOLS
/** The stamp of the list last given to claude (agent: GET /mcp/tools), null before the first. */
let given: string | null = null
/** claude has said hello (initialize): only then is a notification sent. */
let started = false
/** The stamp claude was last told about with a list_changed: it is told once per change, not every half minute. */
let told: string | null = null
const CALL_TIMEOUT_MS = 120_000
/** How often the agent is asked whether its list changed, and how long such a question waits. */
const WATCH_EVERY_MS = Number(process.env.SAD_TOOLS_WATCH_MS) > 0 ? Number(process.env.SAD_TOOLS_WATCH_MS) : 30_000
const ASK_TIMEOUT_MS = 5000
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

/** The agent's current tool list (and its stamp), or null when it can't be asked (an older agent, away): then the list this process was built with stands. */
async function currentTools(stampOnly: boolean): Promise<{ version: string; tools?: { name: string }[] } | null> {
  if (FAST || !url || !key) return null
  try {
    const res = await fetch(`${url}/tools?${stampOnly ? 'stamp=1' : 'given=1'}`, { headers: { 'x-sad-chat-key': key }, signal: AbortSignal.timeout(ASK_TIMEOUT_MS) })
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as { version?: unknown; tools?: unknown } | null
    if (!data || typeof data.version !== 'string') return null
    if (stampOnly) return { version: data.version }
    return Array.isArray(data.tools) ? { version: data.version, tools: data.tools as { name: string }[] } : null
  } catch {
    return null
  }
}

/** Tells claude the list changed (it asks for it again); only after it has been given one, and only when the agent's stamp is another. */
async function watch() {
  if (!started) return
  const now = await currentTools(true)
  if (now && now.version !== given && now.version !== told) {
    told = now.version
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`)
  }
}
if (!FAST) setInterval(() => void watch(), WATCH_EVERY_MS).unref()

async function handle(msg: { id?: Id; method?: unknown; params?: Record<string, unknown> }) {
  const id = msg.id ?? null
  const isRequest = msg.id !== undefined
  switch (msg.method) {
    case 'initialize':
      started = true
      return reply(id, {
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05',
        capabilities: { tools: FAST ? {} : { listChanged: true } },
        serverInfo: { name: 'shubham-agentic', version: '1.0.0' },
      })
    case 'tools/list': {
      const now = await currentTools(false)
      if (now?.tools) {
        LISTED = now.tools
        given = now.version
        return reply(id, { tools: now.tools })
      }
      return reply(id, { tools: LISTED })
    }
    case 'tools/call': {
      const name = typeof msg.params?.name === 'string' ? msg.params.name : ''
      if (!LISTED.some(t => t.name === name)) return reply(id, { content: [{ type: 'text', text: `No tool called ${name}` }], isError: true })
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
