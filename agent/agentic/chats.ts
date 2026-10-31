import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import type { AgentModel, ChatState, TerminalServerMessage } from '../../shared/agentic.ts'
import type { Logger } from '../log.ts'
import { killTree as killProcessTree } from '../proc-tree.ts'
import { createScreen, type Screen } from './screen.ts'

// F-018: the agents' Claude Code chats. Each is the interactive claude TUI in a pseudo-terminal
// (node-pty, ConPTY on Windows), as agentic-claude-manager runs them (server/lib/terminal.js):
// no `claude -p`, no SDK. The page's terminals attach to it over a WebSocket and see the same
// screen; tools type into it as a paste. What it is doing (working, asking, idle) is read off
// what it prints, the way the original does.

/** The bit of node-pty this uses, so tests can hand in a fake. */
export interface PtyLike {
  readonly pid: number
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export type PtySpawn = (file: string, args: string[], opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }) => PtyLike

/** node-pty, loaded when the first chat starts; null with the reason when it can't be. */
export function loadNodePty(): { spawn: PtySpawn } | { error: string } {
  try {
    const pty = createRequire(import.meta.url)('node-pty') as {
      spawn(file: string, args: string[], o: Record<string, unknown>): PtyLike
    }
    return { spawn: (file, args, o) => pty.spawn(file, args, { name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env }) }
  } catch (e) {
    return { error: `node-pty isn't installed (npm install): ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ANSI and OSC sequences, as the original strips them. Control characters are what these match.
const ANSI_RE = new RegExp(
  // oxlint-disable-next-line no-control-regex
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z0-9]*(?:;[-a-zA-Z0-9/#&.:=?%@~_]*)*)?\\u0007)|(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><~])',
  'g',
)
// oxlint-disable-next-line no-control-regex
const OSC_RE = new RegExp('\\u001B\\][^\\u0007\\u001B]{0,512}(?:\\u0007|\\u001B\\\\)?', 'g')
const strip = (s: string) => s.replace(OSC_RE, '').replace(ANSI_RE, '')

// Read off whitespace-squashed text: the TUI paints with cursor moves, so the spaced words
// aren't there to match once the escapes are gone. Sampled from real sessions by the original:
//   working  "Philosophising… ❯ · esc to interrupt"
//   finished "Cooked for 3s · done 3:33 PM ❯"
//   asking   "Enter to confirm · Esc to cancel"
const TURN_RUNNING_RE = /esctointerrupt/i
const TURN_DONE_RE = /·done\d|·done$/i
// F-050: "Enter to select" is claude's own question menu (AskUserQuestion), as 2.1.316 draws it.
const TURN_QUESTION_RE = /entertoconfirm|entertoselect|doyouwant|doyoutrust|trustthisfolder|selectloginmethod/i
const TURN_IDLE_RE = /automodeon|\?forshortcuts/i
const PROMPT_READY_RE = /❯|│>|\?forshortcuts|automodeon/i
/** "Do you trust the files in this folder?": answered yes when it shows at start (see answerGates). */
const TRUST_GATE_RE = /trustthisfolder|doyoutrust|trustthefilesinthisfolder/i
/** "Resume from summary, or the full session?": 2, the full session (the original's choice: keep the detail). */
const RESUME_GATE_RE = /resumefromsummary|resumingthefullsession|resumefullsessionas-?is/i
/** Both gates are drawn while it starts, or not at all; one later is a person's to answer. */
const GATE_WINDOW_MS = 15_000

const MAX_BUFFER_BYTES = 256 * 1024
/** A chat nobody is looking at and that isn't working is stopped after this long. */
export const IDLE_REAP_MS = 4 * 60 * 60 * 1000
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

export interface StartChat {
  sessionId: string
  floorId: string
  agentId: string
  cwd: string
  briefPath: string
  model: AgentModel
  /** F-049: claude --effort (low ... max); none: the CLI's own. */
  effort?: string
  /** claude --resume <id> rather than --session-id <id>: the conversation exists. */
  resume: boolean
  cols?: number
  rows?: number
}

export interface Viewer {
  send(m: TerminalServerMessage): void
}

export interface ChatInfo {
  sessionId: string
  floorId: string
  agentId: string
  cwd: string
  state: ChatState
  startedAt: string
  viewers: number
}

export interface ChatPool {
  start(o: StartChat): ChatInfo
  info(sessionId: string): ChatInfo | null
  live(): ChatInfo[]
  states(): Record<string, ChatState>
  /** The chat a tool call's key belongs to: how a caller is known (never from what it says). */
  byKey(key: string): ChatInfo | null
  /** Replays the recent screen to the viewer, then streams; returns detach, or null when it isn't running. */
  attach(sessionId: string, viewer: Viewer): (() => void) | null
  /** Keystrokes from a page's terminal. */
  input(sessionId: string, data: string): boolean
  resize(sessionId: string, cols: number, rows: number): void
  /** The last `lines` of its screen as plain text (read_chat); null when it isn't running. */
  read(sessionId: string, lines?: number): string | null
  /** F-050: what its terminal shows now, line by line (a question waiting, the spinner: screen.ts reads them); null when it isn't running. */
  screen(sessionId: string): string[] | null
  /** Pastes `text` and presses Enter (send_to_chat); false when it isn't running. */
  type(sessionId: string, text: string): boolean
  /** Types it once the TUI is up and past its start gates; for a chat that is still starting. */
  typeWhenReady(sessionId: string, text: string): void
  kill(sessionId: string): boolean
  closeAll(): void
}

export interface ChatPoolOptions {
  /** Where the agent's API is, for the tools (the MCP shim calls it): http://127.0.0.1:<port>/agent-api/agentic/mcp */
  toolsUrl: () => string
  /** The --mcp-config file naming the shim. */
  mcpConfig: string
  log?: Logger
  /** node-pty; a fake in tests. */
  spawn?: PtySpawn
  /** The claude executable; found on PATH when left out. */
  claude?: string
  /** CLAUDE_CODE_OAUTH_TOKEN as this Windows account has it now (F-007 keeps it there); null: leave the inherited one. */
  token?: () => string | null
  /** Live set or a chat's state changed. */
  onChange?: () => void
  env?: NodeJS.ProcessEnv
  /** Ends a process and its children, given when it started. Tests with a fake pty, whose pid is some other process's, pass a no-op. */
  treeKill?: (pid: number, startedAt?: number) => void
  /** F-051: a --settings file (the memory's UserPromptSubmit hook); claude adds it to the user's own settings. */
  settings?: string
}

/**
 * pty.kill() ends the console; claude's own children (its MCP servers) are ended by exact PID,
 * found by when they started (agent/proc-tree.ts). Not by `taskkill /t`, which follows parent
 * numbers Windows reuses: on 31 Oct 2026 that took down the whole app (features.html F-058).
 */
function stopTree(pid: number, startedAt?: number) {
  if (process.platform !== 'win32') return
  void killProcessTree(pid, { since: startedAt }).catch(() => {
    // Nothing left to end.
  })
}

/** claude on PATH: claude.exe (the native install), else claude.cmd (npm's), else claude. */
export function findClaude(env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
  for (const name of names) for (const dir of dirs) if (existsSync(path.join(dir, name))) return path.join(dir, name)
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  return existsSync(local) ? local : null
}

// What the agent's own environment must not pass on: it may itself have been started from a
// Claude chat (or Christopher's), and a claude that inherits those thinks it is a child session.
const DROP_ENV = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_.*|CLAUDE_PID|CLAUDE_CONFIG_DIR|COS_.*|MDV2_PORT|SAD_AGENTIC_.*)$/i

interface Chat {
  info: Omit<ChatInfo, 'state' | 'viewers'>
  pty: PtyLike
  key: string
  state: ChatState
  carry: string
  buffer: string[]
  bytes: number
  viewers: Set<Viewer>
  exited: boolean
  lastSeen: number
  size: { cols: number; rows: number }
  /** F-050: its terminal as a screen of text, kept as it prints. */
  screen: Screen
  gates: { trust: boolean; trustTries: number; resume: boolean; scan: string; until: number }
}

export function createChatPool(o: ChatPoolOptions): ChatPool {
  const chats = new Map<string, Chat>()
  const keys = new Map<string, Chat>()
  const log = o.log
  let spawnPty = o.spawn ?? null
  const changed = () => o.onChange?.()

  const infoOf = (c: Chat): ChatInfo => ({ ...c.info, state: c.state, viewers: c.viewers.size })

  function noteState(c: Chat, chunk: string) {
    const clean = strip(chunk).replace(/\s+/g, '')
    if (!clean) return
    const carry = c.carry
    c.carry = clean.slice(-96)
    // This chunk decides when it says anything; the carry only catches a marker split in two.
    const decides = (t: string) => TURN_QUESTION_RE.test(t) || TURN_RUNNING_RE.test(t) || TURN_DONE_RE.test(t) || TURN_IDLE_RE.test(t)
    const t = decides(clean) ? clean : carry + clean
    const before = c.state
    // A question outranks working: a permission prompt comes mid-turn, and while it's up the agent waits on you.
    if (TURN_QUESTION_RE.test(t)) c.state = 'question'
    else if (TURN_RUNNING_RE.test(t)) c.state = 'running'
    else if (TURN_DONE_RE.test(t) || TURN_IDLE_RE.test(t)) c.state = 'idle'
    if (c.state !== before) changed()
  }

  function answerGates(c: Chat, chunk: string) {
    const g = c.gates
    if (!g.trust && !g.resume) return
    if (Date.now() > g.until) {
      g.trust = g.resume = false
      return
    }
    g.scan = (g.scan + strip(chunk)).slice(-4096)
    const squashed = g.scan.replace(/\s+/g, '')
    if (g.trust && TRUST_GATE_RE.test(squashed)) {
      // Normally answered already in ~/.claude.json (claude-config.ts); this is the fallback.
      // Never a blind Enter: claude 2.1's menu starts on "No, exit". Wait for the cursor, step
      // it onto Yes, then press Enter; a gate still up after that is tried again, twice at most.
      const cursor = /❯(?:\d\.)?(Yes|No)/i.exec(squashed)
      if (!cursor) return
      g.scan = ''
      if (/^yes/i.test(cursor[1])) {
        write(c, '\r')
        if (++g.trustTries >= 3) g.trust = false
        log?.info(`chat ${c.info.sessionId.slice(0, 8)}: answered "trust this folder" with yes (${c.info.cwd})`)
      } else {
        write(c, squashed.lastIndexOf('Yes') > squashed.lastIndexOf('No,') ? '\u001b[B' : '\u001b[A')
      }
    } else if (g.resume && RESUME_GATE_RE.test(squashed)) {
      g.resume = false
      g.scan = ''
      write(c, '2')
      // Some builds want the choice confirmed: Enter, if the menu is still up a beat later.
      setTimeout(() => {
        const tail = strip(c.buffer.slice(-8).join('')).replace(/\s+/g, '')
        if (!c.exited && RESUME_GATE_RE.test(tail)) write(c, '\r')
      }, 1500).unref()
    }
  }

  function write(c: Chat, data: string) {
    if (c.exited) return false
    try {
      c.pty.write(data)
      return true
    } catch {
      return false
    }
  }

  const treeKill = o.treeKill ?? stopTree

  function killTree(c: Chat) {
    const pid = c.pty.pid
    try {
      c.pty.kill()
    } catch {
      // Already gone; the tree below may still be there.
    }
    if (pid) treeKill(pid, Date.parse(c.info.startedAt))
  }

  function finish(c: Chat, code: number | null) {
    if (c.exited) return
    c.exited = true
    keys.delete(c.key)
    if (chats.get(c.info.sessionId) === c) chats.delete(c.info.sessionId)
    for (const v of c.viewers) {
      try {
        v.send({ t: 'exit', code })
      } catch {
        // That page is gone.
      }
    }
    c.viewers.clear()
    log?.info(`chat ${c.info.sessionId.slice(0, 8)}: ended${code === null ? '' : ` (${code})`}`)
    changed()
  }

  function bufferText(c: Chat) {
    return strip(c.buffer.join('')).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  }

  function paste(c: Chat, text: string) {
    // A paste, not keystrokes: the TUI takes it whole, newlines in it are text, and Enter
    // follows separately (in the same chunk it would be a newline in the paste).
    if (!write(c, PASTE_START + text.split(PASTE_END).join('') + PASTE_END)) return false
    setTimeout(() => write(c, '\r'), 300).unref()
    return true
  }

  // Stop chats nobody is watching that have sat idle for IDLE_REAP_MS.
  const reaper = setInterval(() => {
    const t = Date.now()
    for (const c of [...chats.values()]) {
      if (!c.viewers.size && c.state !== 'running' && t - c.lastSeen > IDLE_REAP_MS) {
        log?.info(`chat ${c.info.sessionId.slice(0, 8)}: stopped after ${IDLE_REAP_MS / 3_600_000} h unwatched and idle`)
        killTree(c)
        finish(c, null)
      }
    }
  }, 5 * 60 * 1000)
  reaper.unref()

  return {
    start(s) {
      const existing = chats.get(s.sessionId)
      if (existing && !existing.exited) return infoOf(existing)
      if (!spawnPty) {
        const loaded = loadNodePty()
        if ('error' in loaded) throw Object.assign(new Error(loaded.error), { status: 503 })
        spawnPty = loaded.spawn
      }
      const claude = o.claude ?? findClaude(o.env)
      if (!claude) throw Object.assign(new Error("Claude Code isn't installed on this PC (no claude on PATH)"), { status: 503 })

      const key = `sad_${randomBytes(24).toString('hex')}`
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(o.env ?? process.env)) if (v !== undefined && !DROP_ENV.test(k)) env[k] = v
      Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3', SAD_AGENTIC_KEY: key, SAD_AGENTIC_URL: o.toolsUrl() })
      // F-040: claude's plain screen, not its full-screen one. That one (the alternate screen,
      // with the mouse captured) keeps no scrollback in the page's terminal and scrolls only by
      // wheel events, which don't get through Windows' pseudo-terminal: the chat couldn't be
      // scrolled. SAD_CLAUDE_FULLSCREEN=1 keeps the full-screen one, as before.
      if ((o.env ?? process.env).SAD_CLAUDE_FULLSCREEN !== '1') Object.assign(env, { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1', CLAUDE_CODE_DISABLE_MOUSE: '1' })
      const token = o.token?.()
      if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token

      const args = [s.resume ? '--resume' : '--session-id', s.sessionId, '--append-system-prompt-file', s.briefPath, '--mcp-config', o.mcpConfig]
      if (s.model) args.push('--model', s.model)
      if (s.effort) args.push('--effort', s.effort)
      if (o.settings) args.push('--settings', o.settings)
      const file = /\.cmd$/i.test(claude) ? (env.ComSpec ?? 'cmd.exe') : claude
      const argv = /\.cmd$/i.test(claude) ? ['/d', '/c', claude, ...args] : args
      const size = { cols: s.cols ?? 120, rows: s.rows ?? 32 }
      const pty = spawnPty(file, argv, { cwd: s.cwd, env, cols: size.cols, rows: size.rows })

      const c: Chat = {
        info: { sessionId: s.sessionId, floorId: s.floorId, agentId: s.agentId, cwd: s.cwd, startedAt: new Date().toISOString() },
        pty,
        key,
        state: 'idle',
        carry: '',
        buffer: [],
        bytes: 0,
        viewers: new Set(),
        exited: false,
        lastSeen: Date.now(),
        size,
        screen: createScreen(size.cols, size.rows),
        gates: { trust: true, trustTries: 0, resume: s.resume, scan: '', until: Date.now() + GATE_WINDOW_MS },
      }
      chats.set(s.sessionId, c)
      keys.set(key, c)
      pty.onData(data => {
        c.buffer.push(data)
        c.bytes += data.length
        while (c.bytes > MAX_BUFFER_BYTES && c.buffer.length > 1) c.bytes -= c.buffer.shift()!.length
        c.screen.write(data)
        noteState(c, data)
        answerGates(c, data)
        for (const v of c.viewers) {
          try {
            v.send({ t: 'out', d: data })
          } catch {
            // That page is gone; its detach follows.
          }
        }
      })
      pty.onExit(e => finish(c, typeof e?.exitCode === 'number' ? e.exitCode : null))
      log?.info(`chat ${s.sessionId.slice(0, 8)}: ${s.resume ? 'resumed' : 'started'} in ${s.cwd}`)
      changed()
      return infoOf(c)
    },

    info(id) {
      const c = chats.get(id)
      return c && !c.exited ? infoOf(c) : null
    },

    live: () => [...chats.values()].filter(c => !c.exited).map(infoOf),

    states() {
      const out: Record<string, ChatState> = {}
      for (const c of chats.values()) if (!c.exited) out[c.info.sessionId] = c.state
      return out
    },

    byKey(key) {
      const c = keys.get(key)
      return c && !c.exited ? infoOf(c) : null
    },

    attach(id, viewer) {
      const c = chats.get(id)
      if (!c || c.exited) return null
      c.viewers.add(viewer)
      c.lastSeen = Date.now()
      if (c.buffer.length) viewer.send({ t: 'out', d: c.buffer.join('') })
      return () => {
        c.viewers.delete(viewer)
        c.lastSeen = Date.now()
      }
    },

    input(id, data) {
      const c = chats.get(id)
      if (!c) return false
      c.lastSeen = Date.now()
      return write(c, data)
    },

    resize(id, cols, rows) {
      const c = chats.get(id)
      if (!c || c.exited) return
      const w = Math.max(20, Math.min(Math.floor(cols), 500))
      const h = Math.max(5, Math.min(Math.floor(rows), 200))
      try {
        if (w === c.size.cols && h === c.size.rows) {
          // Same size: nudge it, so the TUI repaints the whole screen for a page that just joined.
          c.pty.resize(w - 1, h)
          c.screen.resize(w - 1, h)
          setTimeout(() => {
            if (c.exited) return
            c.pty.resize(w, h)
            c.screen.resize(w, h)
          }, 60).unref()
        } else {
          c.pty.resize(w, h)
          c.screen.resize(w, h)
        }
        c.size = { cols: w, rows: h }
      } catch {
        // Exited meanwhile.
      }
    },

    read(id, lines = 100) {
      const c = chats.get(id)
      if (!c || c.exited) return null
      const cap = Math.max(1, Math.min(Math.floor(lines) || 100, 500))
      const all = bufferText(c)
        .split('\n')
        .map(l => l.replace(/\s+$/, ''))
      while (all.length && all[all.length - 1] === '') all.pop()
      return all.slice(-cap).join('\n')
    },

    screen(id) {
      const c = chats.get(id)
      return c && !c.exited ? c.screen.lines() : null
    },

    type(id, text) {
      const c = chats.get(id)
      return !!c && !c.exited && paste(c, text)
    },

    typeWhenReady(id, text) {
      const started = Date.now()
      const poll = setInterval(() => {
        const c = chats.get(id)
        if (!c || c.exited || Date.now() - started > 90_000) {
          clearInterval(poll)
          if (c && !c.exited) log?.warn(`chat ${id.slice(0, 8)}: never reached its prompt; a message for it was dropped`)
          return
        }
        // What is on screen now: a gate answered a minute ago is still in the scrollback.
        const tail = bufferText(c).slice(-4000).replace(/\s+/g, '')
        if (TRUST_GATE_RE.test(tail) || !PROMPT_READY_RE.test(tail)) return
        clearInterval(poll)
        setTimeout(() => paste(c, text), 800).unref()
      }, 400)
      poll.unref()
    },

    kill(id) {
      const c = chats.get(id)
      if (!c || c.exited) return false
      killTree(c)
      finish(c, null)
      return true
    },

    closeAll() {
      clearInterval(reaper)
      for (const c of [...chats.values()]) {
        killTree(c)
        finish(c, null)
      }
    },
  }
}
