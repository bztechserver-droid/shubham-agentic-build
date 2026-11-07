import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ChatNoticeItem, ChatPatch, ChatToolItem } from '../../shared/chat.ts'
import { add, Converter, notice, type ChatOp, type Row, type RowFormat } from '../agentic/chatview.ts'
import { chatMarker } from './home.ts'

// F-134: a Codex chat's conversation, as Codex itself writes it: <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<local time>-<uuid>.jsonl, one JSON object a line,
// {timestamp, type, payload}. What was learnt from a real one (Codex 0.163.0, a ChatGPT login, 6 Nov 2026): the first line is session_meta (id, cwd, cli_version,
// source cli|exec, base_instructions, …), then response_item rows (message with role user|assistant|developer and content[{type: input_text|output_text, text}];
// custom_tool_call / custom_tool_call_output matched by call_id; reasoning), event_msg rows (task_started, task_complete, item_completed, token_count, turn_aborted…),
// turn_context, world_state, token_usage_record and compacted. A resumed conversation appends to the same file.
//
// Codex chooses the conversation's id, not this app, so a chat's file is found by the marker the app puts at the top of the chat's developer instructions
// (home.ts chatMarker), which shows up among the first lines of its rollout; the id in session_meta is then kept (FloorAgent.codexThread) and the file is found by it.
//
// The reading is TOLERANT on purpose: an unknown row type or an unexpected shape is skipped, never an error, because the format belongs to a CLI that changes quickly.

const TEXT_MAX = 20_000
const OUTPUT_MAX = 1500
const DETAIL_MAX = 1200
const NOTICE_MAX = 700

const isObject = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v)
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const oneLine = (s: string, n = 140) => cap(s.replace(/\s+/g, ' ').trim(), n)

/** Rows that carry no conversation and can be large: skipped without being decoded. */
const SKIPPED = /^\{"timestamp":"[^"]*","type":"(?:session_meta|turn_context|world_state|token_usage_record)"/
const COMPACTED = /^\{"timestamp":"([^"]*)","type":"compacted"/

/** A line of a rollout as a row, or null for one that isn't a conversation row. */
export function parseRolloutLine(line: string): Row | null {
  if (!line.startsWith('{') || SKIPPED.test(line)) return null
  const c = COMPACTED.exec(line)
  if (c) return { timestamp: c[1], type: 'compacted' }
  try {
    const v: unknown = JSON.parse(line)
    return isObject(v) ? v : null
  } catch {
    return null
  }
}

/** A stable id for a row that has none: the same row read again (another window of the file) gets the same id. */
function idOf(...parts: unknown[]): string {
  return `cx-${createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 20)}`
}

/** Scaffolding Codex puts in the conversation as user-role messages (the environment, its instructions): not the person's words. */
const SCAFFOLD = /^\s*(?:<(?:environment_context|user_instructions|permissions instructions|collaboration_mode|user_shell_command|turn_aborted|skill|apps_instructions)\b|# AGENTS\.md instructions for )/i

function contentText(c: unknown): string {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c
    .map(p => (isObject(p) && (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') && typeof p.text === 'string' ? p.text : isObject(p) && p.type === 'input_image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
}

/** A tool call's arguments as an object: Codex stores them as a JSON string (function_call.arguments) or as text/an object (custom_tool_call.input). */
function argsOf(p: Row): Row {
  const raw = p.arguments ?? p.input
  if (isObject(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const v: unknown = JSON.parse(raw)
      if (isObject(v)) return v
    } catch {
      // Not JSON: the text itself is the input (a command, a patch).
    }
    return { input: raw }
  }
  return {}
}

/** The command of a shell-like call, as one line of text. */
function commandOf(args: Row): string {
  const c = args.command ?? args.cmd
  if (Array.isArray(c)) {
    const parts = c.filter((x): x is string => typeof x === 'string')
    // ["powershell.exe", "-Command", "…"] or ["bash", "-lc", "…"]: the script is what was run.
    return parts.length >= 3 && /^(?:-c|-lc|-command|\/c)$/i.test(parts[parts.length - 2]) ? parts[parts.length - 1] : parts.join(' ')
  }
  if (typeof c === 'string') return c
  return typeof args.input === 'string' ? args.input : ''
}

function describe(name: string, args: Row): { label: string; summary: string; detail: string } {
  // An MCP tool: mcp__server__tool (Codex), or server__tool; the page shows the tool.
  const label = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name
  const cmd = commandOf(args)
  if (cmd && /(?:shell|exec|bash|powershell|command)/i.test(name)) return { label, summary: oneLine(cmd), detail: cap(cmd, DETAIL_MAX) }
  if (/apply_patch/i.test(name)) {
    const patch = typeof args.input === 'string' ? args.input : cmd
    const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1].trim())
    return { label, summary: oneLine(files.join(', ') || 'a patch'), detail: cap(patch, DETAIL_MAX) }
  }
  const first = Object.values(args).find(v => typeof v === 'string' && v.trim()) as string | undefined
  return { label, summary: first ? oneLine(first) : '', detail: Object.keys(args).length ? cap(JSON.stringify(args, null, 1), DETAIL_MAX) : '' }
}

/** A tool call's answer: its text, and whether it failed. Codex stores a string, or {output|content, success|metadata.exit_code}, sometimes as JSON text. */
function answerOf(output: unknown): { text: string; error: boolean } {
  let v: unknown = output
  if (typeof v === 'string') {
    const t = v.trim()
    if (t.startsWith('{')) {
      try {
        v = JSON.parse(t)
      } catch {
        return { text: t, error: false }
      }
    } else return { text: t, error: false }
  }
  if (!isObject(v)) return { text: '', error: false }
  const body = typeof v.output === 'string' ? v.output : typeof v.content === 'string' ? v.content : contentText(v.content)
  const meta = isObject(v.metadata) ? v.metadata : null
  const code = meta && typeof meta.exit_code === 'number' ? meta.exit_code : null
  return { text: body.trim(), error: v.success === false || (code !== null && code !== 0) || v.is_error === true }
}

export class CodexConverter extends Converter {
  override feed(row: Row): ChatOp[] {
    const at = typeof row.timestamp === 'string' ? row.timestamp : null
    const p = isObject(row.payload) ? row.payload : null
    switch (row.type) {
      case 'response_item':
        return p ? this.item(p, at) : []
      case 'event_msg':
        return p ? this.event(p, at) : []
      case 'compacted':
        return [add(notice(idOf('compacted', at), at, 'Conversation compacted', 'compact'))]
    }
    return []
  }

  private item(p: Row, at: string | null): ChatOp[] {
    switch (p.type) {
      case 'message': {
        const text = contentText(p.content).trim()
        if (!text) return []
        if (p.role === 'assistant') return [add({ kind: 'assistant', id: idOf(at, 'a', text.slice(0, 200)), at, text: cap(text, TEXT_MAX), error: false })]
        if (p.role === 'user' && !SCAFFOLD.test(text)) return this.userText(text, at, idOf(at, 'u', text.slice(0, 200)))
        return []
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const callId = typeof p.call_id === 'string' ? p.call_id : typeof p.id === 'string' ? p.id : null
        if (!callId) return []
        const name = typeof p.name === 'string' ? p.name : p.type === 'local_shell_call' ? 'shell' : 'tool'
        const args = p.type === 'local_shell_call' && isObject(p.action) ? p.action : argsOf(p)
        const d = describe(name, args)
        const item: ChatToolItem = { kind: 'tool', id: callId, at, name, label: d.label, summary: d.summary, detail: d.detail, status: 'running', output: '', more: false, ask: null }
        this.tools.set(callId, item)
        if (this.tools.size > 600) this.tools.delete(this.tools.keys().next().value as string)
        return [add(item)]
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = typeof p.call_id === 'string' ? p.call_id : null
        const item = callId ? this.tools.get(callId) : undefined
        if (!item) return []
        const a = answerOf(p.output)
        const patch: ChatPatch = { status: a.error ? 'error' : 'done', output: cap(a.text, OUTPUT_MAX), more: a.text.length > OUTPUT_MAX }
        Object.assign(item, patch)
        return [{ op: 'patch', id: item.id, patch }]
      }
    }
    return []
  }

  private event(p: Row, at: string | null): ChatOp[] {
    const note = (text: string, tone: ChatNoticeItem['tone'], key: string): ChatOp[] => (text ? [add(notice(idOf(at, key, text.slice(0, 120)), at, cap(text, NOTICE_MAX), tone))] : [])
    switch (p.type) {
      case 'turn_aborted':
        return note('Stopped', 'stop', 'abort')
      case 'error':
      case 'stream_error':
        return note(typeof p.message === 'string' ? p.message : 'Codex reported an error', 'error', 'err')
      case 'context_compacted':
        return note('Conversation compacted', 'compact', 'compact')
    }
    return []
  }
}

export const CODEX_FORMAT: RowFormat = { parse: parseRolloutLine, make: () => new CodexConverter() }

// ── finding a chat's file ──────────────────────────────────────────────────────────────────────

const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export const sessionsDir = (home: string) => path.join(home, 'sessions')

function list(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Every rollout under <home>/sessions (YYYY/MM/DD/…), newest day first. */
export function rolloutFiles(home: string): { file: string; thread: string; mtimeMs: number }[] {
  const root = sessionsDir(home)
  const out: { file: string; thread: string; mtimeMs: number }[] = []
  const desc = (a: string, b: string) => b.localeCompare(a)
  for (const y of list(root).sort(desc)) {
    for (const m of list(path.join(root, y)).sort(desc)) {
      for (const d of list(path.join(root, y, m)).sort(desc)) {
        const dir = path.join(root, y, m, d)
        for (const f of list(dir)) {
          const hit = ROLLOUT_RE.exec(f)
          if (!hit) continue
          const file = path.join(dir, f)
          try {
            out.push({ file, thread: hit[1].toLowerCase(), mtimeMs: statSync(file).mtimeMs })
          } catch {
            // Gone while we looked.
          }
        }
      }
    }
  }
  return out
}

/** The rollout of a Codex conversation, by its id. */
export function findRollout(home: string, thread: string): string | null {
  const want = thread.toLowerCase()
  return rolloutFiles(home).find(r => r.thread === want)?.file ?? null
}

function readHead(file: string, bytes: number): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.toString('utf8', 0, n)
  } finally {
    closeSync(fd)
  }
}

/**
 * The conversation a freshly started chat opened: among the rollouts written since `sinceMs`, the one whose first lines hold this chat's marker (home.ts chatMarker).
 * Null while Codex hasn't written it yet. The marker is looked for in the first 512 KB, which holds the session_meta row and the developer messages.
 */
export function discoverThread(home: string, sessionId: string, sinceMs: number): { thread: string; file: string } | null {
  const marker = chatMarker(sessionId)
  for (const r of rolloutFiles(home)) {
    if (r.mtimeMs < sinceMs - 5000) continue
    try {
      if (readHead(r.file, 512 * 1024).includes(marker)) return { thread: r.thread, file: r.file }
    } catch {
      // Being written; the next look will see it.
    }
  }
  return null
}
