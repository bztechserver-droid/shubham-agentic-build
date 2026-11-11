// F-051: recall, as a Claude Code hook. Every floor chat is started with --settings naming
// this script for UserPromptSubmit (hooks.json, written by index.ts beside mcp.json); claude
// runs it with the prompt as JSON on stdin, before the model sees the prompt. It asks the
// agent what the memory holds for that prompt (POST <SAD_AGENTIC_URL>/recall, with this
// chat's key, as the tools do) and prints it as the hook's additionalContext, which claude
// adds to what the model reads. Whatever goes wrong, it prints nothing and exits 0: a prompt
// is never held up or refused by its memory.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RECALL_TIMEOUT_MS = 4000

export function hookOutput(text: string): string {
  return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }) : ''
}

/** The prompt from the hook's input; null when there is none. */
export function promptOf(input: string): { prompt: string; sessionId: string | null; promptId: string | null } | null {
  try {
    const ev = JSON.parse(input) as { prompt?: unknown; session_id?: unknown; prompt_id?: unknown; hook_event_name?: unknown }
    if (typeof ev.prompt !== 'string' || !ev.prompt.trim()) return null
    if (ev.hook_event_name !== undefined && ev.hook_event_name !== 'UserPromptSubmit') return null
    return { prompt: ev.prompt, sessionId: typeof ev.session_id === 'string' ? ev.session_id : null, promptId: typeof ev.prompt_id === 'string' ? ev.prompt_id.slice(0, 80) : null }
  } catch {
    return null
  }
}

export async function recallFor(input: string, env: NodeJS.ProcessEnv, f: typeof fetch = fetch): Promise<string> {
  const url = env.SAD_AGENTIC_URL ?? ''
  const key = env.SAD_AGENTIC_KEY ?? ''
  const p = promptOf(input)
  if (!url || !key || !p) return ''
  try {
    const res = await f(`${url}/recall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sad-chat-key': key },
      // o655f (Stage 1): the same call tells the agent that claude TOOK this prompt (the exact text and claude's own prompt id), which is how a send
      // is confirmed without reading the screen; the length says whether the text sent here was cut.
      body: JSON.stringify({ prompt: p.prompt.slice(0, 20_000), sessionId: p.sessionId, promptId: p.promptId, promptLength: p.prompt.length }),
      signal: AbortSignal.timeout(RECALL_TIMEOUT_MS),
    })
    if (!res.ok) return ''
    const data = (await res.json()) as { text?: unknown }
    return typeof data.text === 'string' ? data.text : ''
  } catch {
    return ''
  }
}

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let s = ''
    const done = () => resolve(s)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', d => {
      s += d
      if (s.length > 1_000_000) done()
    })
    process.stdin.on('end', done)
    process.stdin.on('error', done)
    setTimeout(done, 2000).unref()
  })
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isMain) {
  const out = hookOutput(await recallFor(await readStdin(), process.env))
  if (out) process.stdout.write(out)
  process.exit(0)
}
