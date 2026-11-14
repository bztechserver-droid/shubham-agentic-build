// F-221 (ob98a, T4): the voice lock below the model. Live talk's direct line types his spoken words, untapped, into the Orchestrator's chat (the
// Assistant chat), and while that line holds the chat (talk-latch.ts) the hub refuses the APP's tools that act (index.ts toolFor). But the chat also
// has Claude Code's own tools (the shell, file edits, agents, workflows, schedules, background runs) and other MCP servers (desktop clicks and
// typing), which never reach the hub. So Claude Code asks THIS script before every tool call of that chat (a PreToolUse hook with matcher "*", in
// hooks-orchestrator.json, which only the Orchestrator's chat is started with) and refuses them itself:
//   - the chat is held while a file named for it is in the latch folder (argv[2]; talk-latch.ts keeps that folder equal to the latch). The name is
//     the session Claude Code reports (session_id), or the chat this hook was written for (argv[3]: after a /clear Claude goes on in a new session,
//     and the chat is still the one his line holds);
//   - while it is held, only reads (Read, Grep, Glob, LS), its to-do list, finding a tool (ToolSearch), the web (WebSearch, WebFetch) and the app's
//     own tools (mcp__shubham-agentic__<tool>, which the hub holds itself) run; every other tool is refused with one sentence to tell him;
//   - not held, no folder named, or nothing it can read while nothing holds the chat: it prints nothing (Claude Code goes on as without the hook).
// Tiny on purpose (it starts at every tool call of that chat): node:fs and node:path only. It never throws, always exits 0, and writes nothing
// anywhere but its answer (no log, never any words).
import { existsSync } from 'node:fs'
import path from 'node:path'

/** What runs while a spoken line holds the chat: reads, its to-do list, finding a tool, the web. (And the app's own tools: APP_TOOLS.) */
export const LOCK_ALLOWED: readonly string[] = ['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'ToolSearch', 'WebSearch', 'WebFetch']
/** The app's own MCP server's tools (briefs.ts MCP_SERVER_NAME): the hub decides those itself (talk-latch.ts latchVerdict). */
export const APP_TOOLS = 'mcp__shubham-agentic__'
/**
 * F-221 (T4 review): an app tool is known by its WHOLE name, never by how it begins. Claude Code names a tool mcp__<server>__<tool>, so another
 * server named "shubham-agentic__x" (or "shubham-agentic_") would begin the same way; the app's own tool names are lower-case words joined by
 * single underscores (tools.ts, talk-latch.ts LATCH_CLASSES), which no such look-alike's full name is (it has a second "__", or "___").
 */
export const APP_TOOL = /^mcp__shubham-agentic__[a-z0-9]+(?:_[a-z0-9]+)*$/
/** What a refused tool tells the chat, which tells him. */
export const LOCK_WORDS = 'That came from his voice: he has to type it or tap it himself. Tell him so in one sentence; do not try another way.'
/** A latch file's name: a session id as Claude Code makes them. Nothing else is looked up, so no other file can be named. */
export const LATCH_NAME = /^[A-Za-z0-9_-]{1,128}$/
/** The most of Claude Code's input it reads, and how long it waits for it (a call is never held up longer by this). */
export const INPUT_MAX = 4 * 1024 * 1024
export const INPUT_WAIT_MS = 3000

/** Claude Code's answer that refuses a tool call: a PreToolUse hook's output on stdout, with exit code 0. */
export const DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: LOCK_WORDS } })

/** May this tool run while a spoken line holds the chat? */
export const lockAllows = (tool: string): boolean => LOCK_ALLOWED.includes(tool) || APP_TOOL.test(tool)

/**
 * What the hook prints for one tool call: DENY, or '' (nothing: the call goes on as it would without the hook). `input` = what Claude Code gives on
 * stdin (session_id, tool_name, tool_input, hook_event_name, permission_mode); `args` = [the latch folder, the chat it was written for?]. When the
 * chat it was written for is held, input it cannot read is refused too (it cannot tell what would run).
 */
export function hookAnswer(input: string, args: readonly string[], exists: (file: string) => boolean = existsSync): string {
  try {
    const dir = args[0]
    if (!dir) return ''
    let ev: Record<string, unknown> | null = null
    try {
      const v: unknown = JSON.parse(input)
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) ev = v as Record<string, unknown>
    } catch {
      ev = null
    }
    // Only ever a PreToolUse answer: given for another event by mistake, it says nothing.
    if (ev && ev.hook_event_name !== undefined && ev.hook_event_name !== 'PreToolUse') return ''
    const held = [ev?.session_id, args[1]].some(id => typeof id === 'string' && LATCH_NAME.test(id) && exists(path.join(dir, id)))
    if (!held) return ''
    return lockAllows(typeof ev?.tool_name === 'string' ? ev.tool_name : '') ? '' : DENY
  } catch {
    return ''
  }
}

/** Claude Code's input, whole: up to INPUT_MAX characters and INPUT_WAIT_MS, then what came (unreadable input is handled above). */
function readInput(): Promise<string> {
  return new Promise(resolve => {
    const parts: string[] = []
    let size = 0
    const done = () => resolve(parts.join(''))
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d: string) => {
      size += d.length
      if (size > INPUT_MAX) return done()
      parts.push(d)
    })
    process.stdin.on('end', done)
    process.stdin.on('error', done)
    setTimeout(done, INPUT_WAIT_MS).unref()
  })
}

if (import.meta.main) {
  // Whatever happens: the answer (or nothing) on stdout, exit code 0, out within a second of having it.
  const quit = () => process.exit(0)
  setTimeout(quit, INPUT_WAIT_MS + 1000).unref()
  let out = ''
  try {
    out = hookAnswer(await readInput(), process.argv.slice(2))
  } catch {
    out = ''
  }
  if (out) process.stdout.write(out, quit)
  else quit()
}
