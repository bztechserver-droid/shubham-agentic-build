import { closeSync, fstatSync, openSync, readSync, statSync, type Stats } from 'node:fs'
import {
  CHAT_WINDOW_MESSAGES,
  type ChatAsk,
  type ChatFeedMessage,
  type ChatHistory,
  type ChatItem,
  type ChatNoticeItem,
  type ChatPatch,
  type ChatPreview,
  type ChatSender,
  type ChatToolItem,
} from '../../shared/chat.ts'
import type { Logger } from '../log.ts'
import { readMenu, readStatus } from './screen.ts'
import { claudeProjectsDir, findTranscript } from './transcripts.ts'

// F-050: the chat view's side of the agent. A chat's conversation is claude's JSONL, and it can
// be enormous (this PC holds ones of 289 MB), so nothing here reads a whole file: the last
// messages come from the end of it, older ones a page at a time from where the last page began,
// and a chat being watched is followed by what its file grew by. Rows become `ChatItem`s
// (shared/chat.ts): what the person said, what the agent said, tool calls and their answers.
//
// What claude writes (seen in 2.1.263 and 2.1.316): a row per content block of a message, a row
// per tool result, `queue-operation` rows for input typed while it works (the prompt itself
// later arrives as an `attachment` of type `queued_command`, with no `user` row of its own),
// and bookkeeping rows (`api-request`, `mode`, `ai-title`...) that start `{"type":"` and are
// never looked at, some of them megabytes long.

const TEXT_MAX = 20_000
const DETAIL_MAX = 1200
const OUTPUT_MAX = 1500
const NOTICE_MAX = 700
/** A line longer than this is skipped without being decoded. */
const MAX_LINE = 8 * 1024 * 1024
/** The first look at the end of a file, and the most a window may grow to looking for enough messages. */
const FIRST_SPAN = 512 * 1024
const MAX_SPAN = 48 * 1024 * 1024
/** The most one follow step reads. */
const READ_CAP = 16 * 1024 * 1024
/** Tool calls remembered, to match their answers to. */
const TOOLS_KEPT = 600

type Row = Record<string, unknown>
const isObject = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v)

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const oneLine = (s: string, n = 140) => cap(s.replace(/\s+/g, ' ').trim(), n)
// oxlint-disable-next-line no-control-regex
const ANSI_RE = new RegExp('\\u001B\\[[0-9;?]*[ -/]*[@-~]|\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)?', 'g')
const plain = (s: string) => s.replace(ANSI_RE, '')

const shortPath = (p: string) => {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : parts.join('/')
}

// ---------------------------------------------------------------------------------------------
// One row to items

const SIBLING_RE = /^\[(?:message|broadcast) from ([^\]]*)\]\s*/

/** "Lead on Final, chat e7d3dd12", "Lead, chat e7d3dd12" or "chat 4e0100d2". */
export function senderOf(inner: string): ChatSender {
  const chat = /(?:,\s*)?chat ([0-9a-f]{6,12})\s*$/i.exec(inner)
  const rest = (chat ? inner.slice(0, chat.index) : inner).trim()
  const on = / on (.+)$/.exec(rest)
  const name = (on ? rest.slice(0, on.index) : rest).trim()
  return { name: name || null, floor: on?.[1].trim() || null, chat: chat?.[1] ?? null }
}

function describeTool(name: string, input: Row): { label: string; summary: string; detail: string } {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const label = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name
  let summary = ''
  let detail = ''
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      summary = oneLine(str('description') || str('command'))
      detail = str('command')
      break
    case 'Read':
      summary = shortPath(str('file_path'))
      detail = [str('file_path'), typeof input.offset === 'number' ? `from line ${input.offset}` : '', typeof input.limit === 'number' ? `${input.limit} lines` : ''].filter(Boolean).join('  ')
      break
    case 'Write':
      summary = shortPath(str('file_path'))
      detail = `${str('file_path')}\n${cap(str('content'), 600)}`
      break
    case 'Edit':
    case 'NotebookEdit':
      summary = shortPath(str('file_path') || str('notebook_path'))
      detail = `${str('file_path') || str('notebook_path')}\n${cap(str('old_string'), 450)}\n⇒\n${cap(str('new_string'), 450)}`
      break
    case 'Grep':
      summary = oneLine(str('pattern'))
      detail = [str('pattern'), str('path') && `in ${str('path')}`, str('glob') && `(${str('glob')})`].filter(Boolean).join(' ')
      break
    case 'Glob':
      summary = oneLine(str('pattern'))
      detail = [str('pattern'), str('path') && `in ${str('path')}`].filter(Boolean).join(' ')
      break
    case 'WebFetch':
      summary = oneLine(str('url'))
      detail = `${str('url')}\n${str('prompt')}`
      break
    case 'WebSearch':
      summary = oneLine(str('query'))
      detail = str('query')
      break
    case 'Task':
    case 'Agent':
      summary = oneLine(str('description') || str('prompt'))
      detail = str('prompt')
      break
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos.filter(isObject) : []
      summary = `${todos.length} to-do${todos.length === 1 ? '' : 's'}`
      detail = todos.map(t => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '…' : '·'} ${typeof t.content === 'string' ? t.content : ''}`).join('\n')
      break
    }
    default: {
      // Another tool (an MCP one): its first text argument says most.
      const first = Object.values(input).find(v => typeof v === 'string' && v.trim()) as string | undefined
      summary = first ? oneLine(first) : ''
      detail = Object.keys(input).length ? JSON.stringify(input, null, 1) : ''
    }
  }
  return { label, summary, detail: cap(detail, DETAIL_MAX) }
}

function parseAsk(input: Row): ChatAsk[] | null {
  if (!Array.isArray(input.questions)) return null
  const out: ChatAsk[] = []
  for (const q of input.questions) {
    if (!isObject(q) || typeof q.question !== 'string') continue
    const options = (Array.isArray(q.options) ? q.options : [])
      .filter(isObject)
      .filter(o => typeof o.label === 'string')
      .slice(0, 12)
      .map(o => ({ label: cap(o.label as string, 200), description: typeof o.description === 'string' ? cap(o.description, 400) : '' }))
    out.push({ question: cap(q.question, 600), header: typeof q.header === 'string' ? cap(q.header, 60) : '', multiSelect: q.multiSelect === true, options })
  }
  return out.length ? out.slice(0, 4) : null
}

function resultText(c: unknown): string {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c
    .map(p => (isObject(p) ? (p.type === 'text' && typeof p.text === 'string' ? p.text : p.type === 'image' ? '[image]' : '') : ''))
    .filter(Boolean)
    .join('\n')
}

export type ChatOp = { op: 'add'; item: ChatItem } | { op: 'patch'; id: string; patch: ChatPatch }

/**
 * Rows in file order to items and patches. It keeps the tool calls it has made items of, so a
 * later row carrying their answer patches them; one whose call is out of reach is dropped.
 */
export class Converter {
  readonly tools = new Map<string, ChatToolItem>()

  feed(row: Row): ChatOp[] {
    if (row.isSidechain === true) return []
    const at = typeof row.timestamp === 'string' ? row.timestamp : null
    const uuid = typeof row.uuid === 'string' ? row.uuid : null
    switch (row.type) {
      case 'assistant':
        return this.assistant(row, at, uuid)
      case 'user':
        return this.user(row, at, uuid)
      case 'attachment': {
        // Typed while claude was working: the prompt comes in as an attachment, not as a user row.
        const a = isObject(row.attachment) ? row.attachment : null
        if (a?.type === 'queued_command' && a.commandMode === 'prompt' && typeof a.prompt === 'string') return this.userText(a.prompt, at, uuid)
        return []
      }
      case 'system': {
        if (!uuid) return []
        if (row.subtype === 'compact_boundary') return [add(notice(uuid, at, 'Conversation compacted', 'compact'))]
        if (row.subtype === 'away_summary' && typeof row.content === 'string' && row.content.trim()) return [add(notice(uuid, at, cap(row.content.trim(), NOTICE_MAX), 'info'))]
        return []
      }
    }
    return []
  }

  private assistant(row: Row, at: string | null, uuid: string | null): Op[] {
    const msg = isObject(row.message) ? row.message : null
    if (!msg) return []
    const parts: unknown[] = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg.content) ? msg.content : []
    const apiError = row.isApiErrorMessage === true
    const synthetic = msg.model === '<synthetic>'
    const ops: Op[] = []
    parts.forEach((p, i) => {
      if (!isObject(p)) return
      const id = uuid ? (i === 0 ? uuid : `${uuid}:${i}`) : null
      if (p.type === 'text' && typeof p.text === 'string' && id) {
        const text = p.text.trim()
        if (!text || (synthetic && !apiError && /^No response requested\.?$/i.test(text))) return
        ops.push(add(apiError ? notice(id, at, cap(text, NOTICE_MAX), 'error') : { kind: 'assistant', id, at, text: cap(text, TEXT_MAX), error: false }))
      } else if (p.type === 'tool_use' && typeof p.id === 'string' && typeof p.name === 'string') {
        const input = isObject(p.input) ? p.input : {}
        const d = describeTool(p.name, input)
        const item: ChatToolItem = {
          kind: 'tool',
          id: p.id,
          at,
          name: p.name,
          label: d.label,
          summary: d.summary,
          detail: d.detail,
          status: 'running',
          output: '',
          more: false,
          ask: p.name === 'AskUserQuestion' ? parseAsk(input) : null,
        }
        this.tools.set(p.id, item)
        if (this.tools.size > TOOLS_KEPT) this.tools.delete(this.tools.keys().next().value as string)
        ops.push(add(item))
      }
    })
    return ops
  }

  private user(row: Row, at: string | null, uuid: string | null): Op[] {
    // Claude's own scaffolding: reminders, the summary it writes after compacting.
    if (row.isMeta === true || row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true) return []
    const msg = isObject(row.message) ? row.message : null
    if (!msg) return []
    if (typeof msg.content === 'string') return this.userText(msg.content, at, uuid)
    if (!Array.isArray(msg.content)) return []
    const ops: Op[] = []
    const texts: string[] = []
    for (const p of msg.content) {
      if (!isObject(p)) continue
      if (p.type === 'tool_result' && typeof p.tool_use_id === 'string') {
        const item = this.tools.get(p.tool_use_id)
        if (!item) continue
        const out = plain(resultText(p.content)).trim()
        const patch: ChatPatch = { status: p.is_error === true ? 'error' : 'done', output: cap(out, OUTPUT_MAX), more: out.length > OUTPUT_MAX }
        Object.assign(item, patch)
        ops.push({ op: 'patch', id: item.id, patch })
      } else if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text)
      else if (p.type === 'image') texts.push('[image]')
    }
    if (texts.length) ops.push(...this.userText(texts.join('\n\n'), at, uuid))
    return ops
  }

  /** What was typed to the agent, as it is stored: some of it is claude's wrapping, not the person's words. */
  private userText(raw: string, at: string | null, uuid: string | null): Op[] {
    const t = raw.trim()
    if (!t || !uuid) return []
    if (t.startsWith('<task-notification') || t.startsWith('<local-command-caveat') || t.startsWith('<system-reminder')) return []
    if (t.startsWith('<agent-message')) return [add(notice(uuid, at, 'A sub-agent reported back', 'info'))]
    if (t.startsWith('[Request interrupted by user')) return [add(notice(uuid, at, 'Stopped', 'stop'))]
    // Claude's wrappers start the message; the same words inside a sentence are only words.
    if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) {
      const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(t)?.[1]
      if (!name) return []
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim()
      return [add({ kind: 'user', id: uuid, at, text: args ? `${name} ${args}` : name, from: null, command: true })]
    }
    if (t.startsWith('<local-command-stdout>')) {
      const out = plain(/<local-command-stdout>([\s\S]*?)(?:<\/local-command-stdout>|$)/.exec(t)?.[1] ?? '').trim()
      return out ? [add(notice(uuid, at, cap(out, NOTICE_MAX), 'info'))] : []
    }
    if (t.startsWith('<bash-input>')) {
      const cmd = /<bash-input>([\s\S]*?)(?:<\/bash-input>|$)/.exec(t)?.[1] ?? ''
      return cmd.trim() ? [add({ kind: 'user', id: uuid, at, text: `! ${cmd.trim()}`, from: null, command: true })] : []
    }
    if (t.startsWith('<bash-stdout') || t.startsWith('<bash-stderr')) {
      const out = plain(t.replace(/<\/?bash-(?:stdout|stderr)>/g, '')).trim()
      return out ? [add(notice(uuid, at, cap(out, NOTICE_MAX), 'info'))] : []
    }
    const sibling = SIBLING_RE.exec(t)
    const body = sibling ? t.slice(sibling[0].length) : t
    return [add({ kind: 'user', id: uuid, at, text: cap(body, TEXT_MAX), from: sibling ? senderOf(sibling[1]) : null, command: false })]
  }
}

type Op = ChatOp
const add = (item: ChatItem): Op => ({ op: 'add', item })
const notice = (id: string, at: string | null, text: string, tone: ChatNoticeItem['tone']): ChatNoticeItem => ({ kind: 'notice', id, at, text, tone })

// The bookkeeping rows, by their prefix, so a megabyte `api-request-blob` is never parsed.
const BOOKKEEPING = /^\{"type":"(?!user"|assistant"|system"|attachment")/

/** A line of the file as a row, or null for one that isn't a conversation row (or isn't JSON). */
export function parseRow(line: string): Row | null {
  if (BOOKKEEPING.test(line)) return null
  try {
    const v: unknown = JSON.parse(line)
    return isObject(v) ? v : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the end of a file

interface Line {
  text: string
  off: number
}

function splitLines(buf: Buffer, base: number): Line[] {
  const out: Line[] = []
  let pos = 0
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos)
    const end = nl === -1 ? buf.length : nl
    if (end > pos && end - pos <= MAX_LINE) out.push({ text: buf.toString('utf8', pos, end), off: base + pos })
    pos = end + 1
  }
  return out
}

function readBytes(fd: number, from: number, to: number): Buffer {
  const len = Math.max(0, to - from)
  const buf = Buffer.allocUnsafe(len)
  let got = 0
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, from + got)
    if (n <= 0) break
    got += n
  }
  return got === len ? buf : buf.subarray(0, got)
}

/** The offset just past the last newline at or before `size` (0 when there is none): the end of the last whole line. */
function wholeEnd(fd: number, size: number): number {
  let to = size
  while (to > 0) {
    const from = Math.max(0, to - 64 * 1024)
    const nl = readBytes(fd, from, to).lastIndexOf(0x0a)
    if (nl !== -1) return from + nl + 1
    to = from
  }
  return 0
}

export interface Tail {
  items: ChatItem[]
  /** Where older items end (a byte offset to ask for the page before this one with); null: nothing is older. */
  before: number | null
  /** The end of the last whole line read: where following goes on from. */
  end: number
  /** Its tool calls, for matching the answers that come later. */
  conv: Converter
  /** How many bytes were looked at (tests: it is not the file). */
  scanned: number
}

export interface TailOptions {
  /** Read up to here (a line start) instead of the end of the file: a page of older items. */
  end?: number
  /** Stop at this many messages (not tool calls). */
  messages?: number
  /** Give up widening at this many bytes. */
  maxSpan?: number
  /** The read ends where the file does now and goes on being followed: tool calls without an answer are still running. */
  live?: boolean
}

/** The last `messages` of the conversation in `file` (before `end`, when given), reading only as far back as that takes. */
export function readTail(file: string, o: TailOptions = {}): Tail {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const atEnd = o.end === undefined || o.end >= size
    const end = atEnd ? wholeEnd(fd, size) : Math.max(0, o.end ?? 0)
    const want = o.messages ?? CHAT_WINDOW_MESSAGES
    const maxSpan = o.maxSpan ?? MAX_SPAN
    let span = FIRST_SPAN
    let scanned = 0
    for (;;) {
      const from = Math.max(0, end - span)
      let buf = readBytes(fd, from, end)
      scanned += buf.length
      let base = from
      if (from > 0) {
        // Start on a line: drop the piece of the line the cut went through.
        const nl = buf.indexOf(0x0a)
        if (nl === -1) {
          if (span >= maxSpan) return { items: [], before: from, end, conv: new Converter(), scanned }
          span *= 2
          continue
        }
        buf = buf.subarray(nl + 1)
        base = from + nl + 1
      }
      const conv = new Converter()
      const items: ChatItem[] = []
      const offs: number[] = []
      for (const line of splitLines(buf, base)) {
        const row = parseRow(line.text)
        if (!row) continue
        for (const op of conv.feed(row)) {
          if (op.op !== 'add') continue
          items.push(op.item)
          offs.push(line.off)
        }
      }
      const messages = items.reduce((n, i) => n + (i.kind === 'tool' ? 0 : 1), 0)
      if (messages < want && base > 0 && span < maxSpan) {
        span *= 4
        continue
      }
      // The last `want` messages, with the tool calls between them; whole rows.
      let start = 0
      if (messages > want) {
        let seen = 0
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].kind !== 'tool' && ++seen === want) {
            start = i
            break
          }
        }
        while (start > 0 && offs[start - 1] === offs[start]) start--
      }
      const kept = items.slice(start)
      // An older page: a call with no answer in reach was answered later, past this page. At the
      // end of the file (or following it) a call with no answer yet is still running.
      if (!atEnd && !o.live) for (const i of kept) if (i.kind === 'tool' && i.status === 'running') i.status = 'done'
      return { items: kept, before: start > 0 ? offs[start] : base > 0 ? base : null, end, conv, scanned }
    }
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------------------------
// Following a chat's file

interface Follow {
  sessionId: string
  file: string | null
  /** The file's identity, so a swapped-in copy (take-over catch-up) is told from the same file grown. */
  ident: string
  /** Bytes consumed: the end of the last whole line handled. */
  pos: number
  conv: Converter
  subs: Set<(m: ChatFeedMessage) => void>
  timer: ReturnType<typeof setInterval> | null
  /** What was last said of the screen (JSON), so a change is said once. */
  menu: string
  status: string
}

export interface ChatFeedsOptions {
  projectsDir?: string
  /** How often a watched file is looked at (350 ms). */
  pollMs?: number
  log?: Logger
  /**
   * The lines of a chat's terminal screen, when this PC runs it (the pool's): a question that is
   * waiting and the spinner line are read off it and sent as `menu` and `status`. The conversation
   * file has neither (claude writes a tool call and its answer together, once it has one).
   */
  screen?: (sessionId: string) => string[] | null
}

export interface ChatFeeds {
  /** A page's socket for one session: `hello` now, then `add` and `patch` as the file grows. Returns detach. */
  attach(sessionId: string, send: (m: ChatFeedMessage) => void): () => void
  /** An older page: the `limit` messages before byte offset `before`. */
  history(sessionId: string, before: number, limit?: number): ChatHistory
  /** The last thing said in a conversation, for the list. */
  preview(sessionId: string): ChatPreview | null
  close(): void
}

const identOf = (st: { ino: number | bigint; birthtimeMs: number }) => `${st.ino}:${Math.round(st.birthtimeMs)}`

export function createChatFeeds(o: ChatFeedsOptions = {}): ChatFeeds {
  const projectsDir = o.projectsDir ?? claudeProjectsDir()
  const pollMs = o.pollMs ?? 350
  const follows = new Map<string, Follow>()
  const previews = new Map<string, { key: string; value: ChatPreview | null }>()

  const send = (f: Follow, m: ChatFeedMessage) => {
    for (const s of f.subs) {
      try {
        s(m)
      } catch {
        // That page is gone; its detach follows.
      }
    }
  }

  function emit(f: Follow, ops: ChatOp[]) {
    let items: ChatItem[] = []
    const flush = () => {
      if (items.length) send(f, { t: 'add', items })
      items = []
    }
    for (const op of ops) {
      if (op.op === 'add') items.push(op.item)
      else {
        flush()
        send(f, { t: 'patch', id: op.id, patch: op.patch })
      }
    }
    flush()
  }

  /** The file, found (it may not exist yet: a chat's file appears with its first message). */
  function locate(f: Follow): boolean {
    f.file ??= findTranscript(f.sessionId, projectsDir)
    return f.file !== null
  }

  /** A fresh look at the end of the file: what `hello` says, and where following goes on from. */
  function hello(f: Follow): ChatFeedMessage {
    if (!f.file) return { t: 'hello', sessionId: f.sessionId, items: [], before: null, size: 0 }
    const st = statSync(f.file)
    const tail = readTail(f.file, { live: true })
    f.ident = identOf(st)
    f.pos = tail.end
    f.conv = tail.conv
    return { t: 'hello', sessionId: f.sessionId, items: tail.items, before: tail.before, size: tail.end }
  }

  /** What the chat's screen says now: a waiting question, and what claude is doing. */
  function onScreen(sessionId: string) {
    const lines = o.screen?.(sessionId) ?? null
    return { menu: lines ? readMenu(lines) : null, status: lines ? readStatus(lines) : null }
  }

  /** The screen looked at: a change in the waiting question or in the spinner line is sent, once. */
  function pollScreen(f: Follow) {
    if (!o.screen) return
    try {
      const { menu, status } = onScreen(f.sessionId)
      const m = JSON.stringify(menu)
      const s = JSON.stringify(status)
      if (m !== f.menu) {
        f.menu = m
        send(f, { t: 'menu', menu })
      }
      if (s !== f.status) {
        f.status = s
        send(f, { t: 'status', status })
      }
    } catch (e) {
      o.log?.warn(`chat feed ${f.sessionId.slice(0, 8)}: screen: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function tick(f: Follow) {
    follow(f)
    pollScreen(f)
  }

  /** One look at the file: what it grew by, as items, or a new hello when it is not the file it was. */
  function follow(f: Follow) {
    try {
      if (!locate(f)) return
      let st: Stats
      try {
        st = statSync(f.file as string)
      } catch {
        f.file = null
        return
      }
      if (f.ident && (identOf(st) !== f.ident || st.size < f.pos)) {
        send(f, hello(f))
        return
      }
      if (!f.ident) f.ident = identOf(st)
      if (st.size <= f.pos) return
      const fd = openSync(f.file as string, 'r')
      let buf: Buffer
      try {
        buf = readBytes(fd, f.pos, Math.min(st.size, f.pos + READ_CAP))
      } finally {
        closeSync(fd)
      }
      const nl = buf.lastIndexOf(0x0a)
      if (nl === -1) {
        // A line still being written; unless it is longer than anything is read, wait for the rest.
        if (buf.length >= READ_CAP) f.pos += buf.length
        return
      }
      const whole = buf.subarray(0, nl + 1)
      const base = f.pos
      f.pos += whole.length
      const ops: ChatOp[] = []
      for (const line of splitLines(whole, base)) {
        const row = parseRow(line.text)
        if (row) ops.push(...f.conv.feed(row))
      }
      emit(f, ops)
    } catch (e) {
      o.log?.warn(`chat feed ${f.sessionId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    attach(sessionId, sendTo) {
      let f = follows.get(sessionId)
      if (f) {
        // Join up with the others exactly: catch the follow up first, then read the end up to where it is.
        tick(f)
        const t = f.file ? readTail(f.file, { end: f.pos, live: true }) : null
        sendTo({ t: 'hello', sessionId, items: t?.items ?? [], before: t?.before ?? null, size: f.pos })
      } else {
        f = { sessionId, file: null, ident: '', pos: 0, conv: new Converter(), subs: new Set(), timer: null, menu: 'null', status: 'null' }
        locate(f)
        try {
          sendTo(hello(f))
        } catch (e) {
          o.log?.warn(`chat feed ${sessionId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`)
          sendTo({ t: 'hello', sessionId, items: [], before: null, size: 0 })
        }
        follows.set(sessionId, f)
      }
      // What is on the chat's screen now, for the page that has just joined (the others have been told).
      if (o.screen) {
        const { menu, status } = onScreen(sessionId)
        f.menu = JSON.stringify(menu)
        f.status = JSON.stringify(status)
        if (menu) sendTo({ t: 'menu', menu })
        if (status) sendTo({ t: 'status', status })
      }
      const watch = f
      watch.subs.add(sendTo)
      watch.timer ??= setInterval(() => tick(watch), pollMs)
      watch.timer.unref()
      return () => {
        watch.subs.delete(sendTo)
        if (watch.subs.size) return
        if (watch.timer) clearInterval(watch.timer)
        watch.timer = null
        if (follows.get(sessionId) === watch) follows.delete(sessionId)
      }
    },

    history(sessionId, before, limit = CHAT_WINDOW_MESSAGES) {
      const file = findTranscript(sessionId, projectsDir)
      if (!file || !(before > 0)) return { items: [], before: null }
      const t = readTail(file, { end: before, messages: Math.max(1, Math.min(limit, 200)) })
      return { items: t.items, before: t.before }
    },

    preview(sessionId) {
      const file = findTranscript(sessionId, projectsDir)
      if (!file) return null
      let st: Stats
      try {
        st = statSync(file)
      } catch {
        return null
      }
      const key = `${file}:${st.size}:${st.mtimeMs}`
      const hit = previews.get(sessionId)
      if (hit?.key === key) return hit.value
      let value: ChatPreview | null = null
      try {
        const tail = readTail(file, { messages: 6, maxSpan: 4 * 1024 * 1024 })
        for (let i = tail.items.length - 1; i >= 0 && !value; i--) {
          const item = tail.items[i]
          if (item.kind === 'assistant' || (item.kind === 'user' && !item.command)) {
            value = {
              sessionId,
              at: item.at,
              role: item.kind,
              text: oneLine(item.text),
              from: item.kind === 'user' ? (item.from?.name ?? (item.from?.chat ? `chat ${item.from.chat}` : null)) : null,
              bytes: st.size,
              mtime: st.mtime.toISOString(),
            }
          }
        }
      } catch {
        // Unreadable now: no preview this time.
      }
      previews.set(sessionId, { key, value })
      return value
    },

    close() {
      for (const f of follows.values()) if (f.timer) clearInterval(f.timer)
      follows.clear()
    },
  }
}
