import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import type { AgentModel, ChatState, TerminalServerMessage } from '../../shared/agentic.ts'
import * as cxs from '../codex/screen.ts'
import { sendToCodex, type SendOptions, type SendResult } from '../codex/sender.ts'
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

/** `id` and `meta` are for a spawn that lives elsewhere (the chat host, F-075), which keeps them with the chat; node-pty ignores them. */
export type PtySpawn = (file: string, args: string[], opts: { cwd: string; env: Record<string, string>; cols: number; rows: number; id?: string; meta?: Record<string, unknown> }) => PtyLike

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

/** F-134: the words a Codex chat's state is read from (codex/screen.ts has the screens they come from). */
const CODEX_RES = { question: cxs.CODEX_QUESTION_RE, running: cxs.CODEX_RUNNING_RE, done: cxs.CODEX_DONE_RE, idle: cxs.CODEX_IDLE_RE }
const CLAUDE_RES = { question: TURN_QUESTION_RE, running: TURN_RUNNING_RE, done: TURN_DONE_RE, idle: TURN_IDLE_RE }

const MAX_BUFFER_BYTES = 256 * 1024
/** A chat nobody is looking at and that isn't working is stopped after this long. */
export const IDLE_REAP_MS = 4 * 60 * 60 * 1000
/** How often the reaper looks. */
export const REAP_EVERY_MS = 5 * 60 * 1000

// F-083: work that goes on while the chat sits at its prompt. Claude Code draws it under the input box:
// "1 shell" / "2 local agents" in the footer, a workflow's bar ("◯ name ▱▱▱▱ 0/5 · 3m45s"), or the line
// "Waiting for 1 dynamic workflow to finish". Read off the last lines of the screen. A chat with any of
// these is working, whatever its prompt looks like: it is never taken for idle (the night of 2 Nov: Mobile's chat
// sat idle at its prompt while its tests ran in a background shell, and the reaper ended both).
const FOOTER_RES: readonly [RegExp, string][] = [
  [/\b\d+\s+(?:local\s+|background\s+)?(?:shells?|bash(?:es)?|monitors?)\b/i, 'a background shell'],
  [/\b\d+\s+(?:local\s+|background\s+|remote\s+)?(?:agents?|tasks?|workflows?|subagents?)\b/i, 'a background task'],
  [/[▰▱]{6,}/, 'a workflow'],
]
const WAITING_RE = /waiting for \d+ (?:dynamic )?workflows? to finish/i
const BG_RULE_RE = /^\s*[─━]{8,}/
/**
 * What background work the screen shows, or null. Pure. The footer is what is drawn under the last rule (the input
 * box's bottom edge): shells, agents, a workflow's bar. "Waiting for 1 dynamic workflow" is a spinner line above the box.
 */
export function backgroundWork(lines: readonly string[]): string | null {
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim()) end-- // the screen is as tall as the terminal: the empty rows under the footer are not it
  const tail = lines.slice(Math.max(0, end - 16), end)
  let rule = -1
  for (let i = tail.length - 1; i >= 0; i--) {
    if (BG_RULE_RE.test(tail[i])) {
      rule = i
      break
    }
  }
  for (const l of tail) if (WAITING_RE.test(l)) return 'a workflow'
  for (const l of tail.slice(rule + 1)) for (const [re, what] of FOOTER_RES) if (re.test(l)) return what
  return null
}
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

export interface StartChat {
  sessionId: string
  floorId: string
  agentId: string
  cwd: string
  briefPath: string
  /** This chat's own --mcp-config (the app's tools plus the MCP servers its agent was given); the shared one when none. */
  mcpConfig?: string
  /** claude --strict-mcp-config: only the servers of mcpConfig, none from the user's own config (the F-078 scope fix). */
  strictMcp?: boolean
  model: AgentModel
  /** F-049: claude --effort (low ... max); none: the CLI's own. */
  effort?: string
  /** claude --resume <id> rather than --session-id <id>: the conversation exists. */
  resume: boolean
  cols?: number
  rows?: number
  /** F-134: which engine runs it (Claude when left out). */
  engine?: 'claude' | 'codex' | 'opencode'
  /**
   * F-134, for the Codex engine: the Codex home it runs in (CODEX_HOME), its profile (codex -p <profile>) and, to resume, the Codex conversation id.
   * model/effort/brief/MCP servers are in the profile file (codex/home.ts writeProfile), so none of the Claude flags above are used.
   */
  codex?: { home: string; profile: string; thread: string | null }
}

/** F-078: how a chat ended. cause: stopped (by him), idle-reaper, agent-stop (the app stopping: an Update, a restart), exited (it ended itself, code 0), crashed (a non-zero code), ended (no code). */
export interface ChatEnded {
  sessionId: string
  floorId: string
  agentId: string
  /** F-134 */
  engine: 'claude' | 'codex' | 'opencode'
  cause: string
  code: number | null
  startedAt: string
}

export interface Viewer {
  send(m: TerminalServerMessage): void
}

export interface ChatInfo {
  sessionId: string
  floorId: string
  agentId: string
  /** F-134: the engine it really runs. */
  engine: 'claude' | 'codex' | 'opencode'
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
  /** M1: is it at a question right now (a menu on its screen)? A guess from words with no menu behind it is put right and counts as no. False when it isn't running here. */
  asking(sessionId: string): boolean
  /** Is there unsent text in its idle input box (Shubham is typing there)? Anything pasted would join it. False when it isn't running here. */
  drafting(sessionId: string): boolean
  /**
   * Pastes `text` and presses Enter (send_to_chat); false when it isn't running. `refuseDraft`: types NOTHING and answers false
   * when the idle input box holds unsent text of Shubham's (the paste would join it and one Enter would send both); a grey
   * suggestion is not a draft.
   */
  type(sessionId: string, text: string, opt?: { refuseDraft?: boolean }): boolean
  /** Types it once the TUI is up and past its start gates; for a chat that is still starting. */
  typeWhenReady(sessionId: string, text: string, opt?: { holdForDraft?: boolean }): void
  kill(sessionId: string, why?: string): boolean
  /** Native PTY exit acknowledgement, rather than removal of its in-memory chat entry. */
  waitStopped?(sessionId: string): Promise<void>
  /**
   * F-075: takes hold of a chat that is already running in the chat host (an agent that started after the one that
   * began it): its terminal, what the host kept of its output (read to find what it is doing), and its key.
   */
  adopt(a: AdoptChat, pty: PtyLike, replay: string): ChatInfo
  /** F-083: what the watchdog reads: when it last printed, when it last did anything, and background work on its status line (a shell, a workflow). null when it isn't running here. */
  activity(sessionId: string): ChatActivity | null
  /** F-083: raw keys into the terminal for the app's own use (the watchdog dismissing a harmless menu); unlike input() it is not Shubham looking at the chat. */
  press(sessionId: string, data: string): boolean
  closeAll(): void
}

export interface ChatActivity {
  state: ChatState
  startedAt: string
  /** Epoch ms. */
  lastOutputAt: number
  lastActiveAt: number
  background: string | null
}

/** What the chat host keeps of a chat for the agent that finds it again. */
export interface AdoptChat {
  sessionId: string
  floorId: string
  agentId: string
  /** F-134: from the host's record of the chat (Claude when it has none). */
  engine?: 'claude' | 'codex' | 'opencode'
  cwd: string
  startedAt: string
  key: string
  cols: number
  rows: number
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
  /** F-134: the codex executable for Codex chats (null/absent: none installed; a Codex chat is refused). */
  codexBin?: () => string | null
  /** F-138: the API key the CRM gave this person for Codex chats, as the variable Codex reads (codex/index.ts credentialEnv), or null. A ChatGPT login is a file in the Codex home instead. */
  codexCredential?: () => { name: string; value: string } | null
  /** F-134, tests: shorter waits for a Codex chat's sender. */
  codexSend?: SendOptions
  /** CLAUDE_CODE_OAUTH_TOKEN as this Windows account has it now (F-007 keeps it there); null: leave the inherited one. */
  token?: () => string | null
  /**
   * F-138: the credential the CRM handed out for this account (claude/index.ts credentialEnv): the variable and its value, exactly ONE of CLAUDE_CODE_OAUTH_TOKEN (a subscription)
   * and ANTHROPIC_API_KEY (an API key). When it gives one, a Claude chat is started with that one and with the other two ways in (and an inherited ANTHROPIC_AUTH_TOKEN) taken
   * out of its environment, because an API key silently wins over a subscription. When it gives none, `token` applies exactly as before.
   */
  credential?: () => { name: string; value: string } | null
  /** Live set or a chat's state changed. */
  onChange?: () => void
  /** F-078: a chat ended, and why (chat-log.ts keeps the pattern). */
  onEnded?: (e: ChatEnded) => void
  env?: NodeJS.ProcessEnv
  /** Ends a process and its children, given when it started. Tests with a fake pty, whose pid is some other process's, pass a no-op. */
  treeKill?: (pid: number, startedAt?: number) => void
  /** F-051: a --settings file (the memory's UserPromptSubmit hook); claude adds it to the user's own settings. */
  settings?: string
  /** F-069: folders claude may read besides the chat's own (the uploads folder: --add-dir), so a file it is given a path to opens without a question. */
  addDirs?: string[]
  /**
   * F-075: the terminals live in the chat host, which outlives this agent: closeAll() lets go of them instead of
   * ending them (every other way of stopping a chat still ends it, in the host).
   */
  keepOnClose?: boolean
  /** F-083: true = this chat has work the reaper must not end (an open order, unfinished work). Asked before every reap. */
  keep?: (sessionId: string) => boolean
  /** F-083: how long a chat may sit idle and unwatched before it is stopped (IDLE_REAP_MS), and how often that is looked at (REAP_EVERY_MS); tests shorten both. */
  idleReapMs?: number
  reapEveryMs?: number
}

/**
 * pty.kill() ends the console; claude's own children (its MCP servers) are ended by exact PID,
 * found by when they started (agent/proc-tree.ts). Not by `taskkill /t`, which follows parent
 * numbers Windows reuses: on 31 Oct 2026 that took down the whole app (features.html F-058).
 */
function stopTree(pid: number, startedAt?: number) {
  if (process.platform !== 'win32' && process.platform !== 'linux') return
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
// F-134: nor a Codex login or key of the person's own: the Codex chats run on the CRM's login (CODEX_HOME is set for them below), and a stray OPENAI_API_KEY must not win over it.
const DROP_ENV = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_.*|CLAUDE_PID|CLAUDE_CONFIG_DIR|COS_.*|MDV2_PORT|SAD_AGENTIC_.*|CODEX_HOME|CODEX_API_KEY|CODEX_ACCESS_TOKEN|OPENAI_API_KEY)$/i

interface Chat {
  info: Omit<ChatInfo, 'state' | 'viewers'>
  engine: 'claude' | 'codex' | 'opencode'
  pty: PtyLike
  key: string
  state: ChatState
  carry: string
  buffer: string[]
  bytes: number
  viewers: Set<Viewer>
  exited: boolean
  /** F-078: why it is being ended, when the app is the one ending it. */
  why?: string
  lastSeen: number
  /** F-083: when it last did anything: a message typed in, a turn starting or ending, output while working, background work on its status line. */
  lastActive: number
  /** F-083: when it last printed anything. */
  lastOutputAt: number
  size: { cols: number; rows: number }
  /** F-050: its terminal as a screen of text, kept as it prints. */
  screen: Screen
  gates: { trust: boolean; trustTries: number; resume: boolean; scan: string; until: number }
  /** When the state last became 'question' (the grace before a phantom one is corrected). */
  questionAt?: number
  /** Keep pastes and their delayed Enters from separate messages together. */
  codexSending?: Promise<SendResult>
}

export function createChatPool(o: ChatPoolOptions): ChatPool {
  const chats = new Map<string, Chat>()
  const actualExits = new Map<string, Promise<void>>()
  const keys = new Map<string, Chat>()
  const log = o.log
  let spawnPty = o.spawn ?? null
  const changed = () => o.onChange?.()

  const infoOf = (c: Chat): ChatInfo => {
    settle(c)
    return { ...c.info, state: c.state, viewers: c.viewers.size }
  }

  // M1: is a question menu up? Read off the screen as it is drawn now, not off the state, which is guessed from words
  // ("Do you want me to publish?" in plain prose also looks like a prompt). A real prompt shows a highlighted
  // numbered option ("❯ 1. Yes", what readMenu reads) and/or its footer ("Enter to confirm · Esc to cancel"); prose has neither.
  // Those words quoted in a reply (this very sentence) are not a menu: a live menu is the bottom of the screen, where the idle
  // input box is, so the box drawn BELOW the last such line (rule, "❯" line, rule) means it is only text. Real screens
  // (screen.test.ts, live chats): idle and working chats always draw that box; a menu replaces it.
  // Fail-safe: a screen that cannot be read counts as a menu being up.
  const OPTION_UNDER_CURSOR_RE = /^\s*❯\s*\d{1,2}\.\s+\S/
  const MENU_FOOTER_RE = /Enter to (?:select|confirm)|Esc to cancel/i
  const RULE_LINE_RE = /^\s*[─━]{8,}/
  const INPUT_LINE_RE = /^\s*❯(?!\s*\d{1,2}\.\s)/
  /** Whether an idle input box is drawn from line `from` on: a rule, the "❯" line (typed text may run on a few lines), a rule. */
  function inputBoxBelow(lines: string[], from: number): boolean {
    for (let j = from + 1; j < lines.length; j++) {
      if (!RULE_LINE_RE.test(lines[j - 1]) || !INPUT_LINE_RE.test(lines[j])) continue
      for (let k = j + 1; k < Math.min(lines.length, j + 9); k++) if (RULE_LINE_RE.test(lines[k])) return true
    }
    return false
  }
  /**
   * What is typed in the idle input box (the lowest one drawn) and not sent yet: a draft. '' when no box is drawn or it is empty.
   * claude's own grey suggestions are not a draft: the placeholder of a fresh chat ('Try "write a test"') and the SUGGESTED NEXT PROMPT
   * it draws there after most turns ("Merge the guard fix and run the gate"), both printed dim or grey. `typed` is the same screen with
   * those cells blanked (Screen.typedLines); what is left is what a person typed. Anything pasted now would join a draft,
   * and the Enter would send both as one message.
   */
  function boxText(lines: string[], typed: string[] = lines): string {
    for (let j = lines.length - 1; j >= 1; j--) {
      if (!RULE_LINE_RE.test(lines[j - 1]) || !INPUT_LINE_RE.test(lines[j])) continue
      let end = -1
      for (let k = j + 1; k < Math.min(lines.length, j + 9); k++) {
        if (RULE_LINE_RE.test(lines[k])) {
          end = k
          break
        }
      }
      if (end < 0) continue
      const text = [typed[j].replace(/^\s*❯/, ''), ...typed.slice(j + 1, end)].join(' ').replace(/\s+/g, ' ').trim()
      return /^Try "/.test(text) ? '' : text
    }
    return ''
  }
  function draftOnScreen(c: Chat): boolean {
    try {
      if (c.engine === 'codex') return !menuOnScreen(c) && cxs.draftText(c.screen.lines()) !== ''
      return !menuOnScreen(c) && boxText(c.screen.lines(), c.screen.typedLines()) !== ''
    } catch {
      return false
    }
  }
  /** Whether a menu is on the live screen; null when the screen cannot be read. */
  function menuSeen(c: Chat): boolean | null {
    try {
      const lines = c.screen.lines()
      if (c.engine === 'codex') return cxs.menuOnScreen(lines)
      let last = -1
      for (let i = lines.length - 1; i >= 0 && last < 0; i--) if (OPTION_UNDER_CURSOR_RE.test(lines[i]) || MENU_FOOTER_RE.test(lines[i])) last = i
      if (last < 0) return false
      return !inputBoxBelow(lines, last)
    } catch {
      return null
    }
  }
  function menuOnScreen(c: Chat): boolean {
    return menuSeen(c) ?? true
  }

  /** A state of 'question' that no menu backs is a phantom: put right (working if it can be interrupted, else idle). */
  function correct(c: Chat) {
    const running = (() => {
      try {
        return c.screen.lines().some(l => /esc to interrupt/i.test(l))
      } catch {
        return false
      }
    })()
    c.state = running ? 'running' : 'idle'
    log?.info(`chat ${c.info.sessionId.slice(0, 8)}: it was taken for a question but no menu is on its screen (plain words); now ${c.state}`)
    changed()
  }

  /** What is shown to others (Approvals, the roster, the phone): a phantom question is corrected once it has stood a few seconds (a prompt still being drawn is not). */
  function settle(c: Chat) {
    if (c.state !== 'question') {
      // The other way round: a menu stands on the screen but the words never said "question" (a dialog with no such words, like the
      // setup screen of "Teach auto mode about your environment?"). The screen decides: it is a question, so Approvals lists it.
      if (!c.exited && menuSeen(c) === true) {
        c.state = 'question'
        c.questionAt = Date.now()
        log?.info(`chat ${c.info.sessionId.slice(0, 8)}: a menu is on its screen; now a question`)
        changed()
      }
      return
    }
    if (Date.now() - (c.questionAt ?? 0) < 3_000 || menuOnScreen(c)) return
    correct(c)
  }

  /** Whether typing into it is refused right now: a menu is up, whatever the state says. A phantom 'question' with no menu is corrected and allowed. */
  function blocked(c: Chat): boolean {
    if (menuOnScreen(c)) return true
    if (c.state === 'question') correct(c)
    return false
  }

  function noteState(c: Chat, chunk: string) {
    const clean = strip(chunk).replace(/\s+/g, '')
    if (!clean) return
    const carry = c.carry
    c.carry = clean.slice(-96)
    // This chunk decides when it says anything; the carry only catches a marker split in two.
    const re = c.engine === 'codex' ? CODEX_RES : CLAUDE_RES
    const decides = (t: string) => re.question.test(t) || re.running.test(t) || re.done.test(t) || re.idle.test(t)
    const t = decides(clean) ? clean : carry + clean
    const before = c.state
    // A question outranks working: a permission prompt comes mid-turn, and while it's up the agent waits on you.
    if (re.question.test(t)) c.state = 'question'
    else if (re.running.test(t)) c.state = 'running'
    else if (re.done.test(t) || re.idle.test(t)) c.state = 'idle'
    if (c.state === 'question' && before !== 'question') c.questionAt = Date.now()
    if (c.state !== before) {
      c.lastActive = Date.now() // a turn started or ended
      changed()
    }
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
    try {
      o.onEnded?.({ sessionId: c.info.sessionId, floorId: c.info.floorId, agentId: c.info.agentId, engine: c.engine, cause: c.why ?? (code === 0 ? 'exited' : code === null ? 'ended' : 'crashed'), code, startedAt: c.info.startedAt })
    } catch {
      // The log is the log's trouble.
    }
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

  /** The chat's terminal feeds its buffer, its screen, its state and its viewers. */
  function register(c: Chat) {
    const pty = c.pty
    let exited!: () => void
    const exit = new Promise<void>(resolve => { exited = resolve })
    actualExits.set(c.info.sessionId, exit)
    chats.set(c.info.sessionId, c)
    keys.set(c.key, c)
    pty.onData(data => {
      c.buffer.push(data)
      c.bytes += data.length
      while (c.bytes > MAX_BUFFER_BYTES && c.buffer.length > 1) c.bytes -= c.buffer.shift()!.length
      c.screen.write(data)
      noteState(c, data)
      c.lastOutputAt = Date.now()
      if (c.state === 'running') c.lastActive = c.lastOutputAt
      answerGates(c, data)
      for (const v of c.viewers) {
        try {
          v.send({ t: 'out', d: data })
        } catch {
          // That page is gone; its detach follows.
        }
      }
    })
    pty.onExit(e => {
      exited()
      if (actualExits.get(c.info.sessionId) === exit) actualExits.delete(c.info.sessionId)
      finish(c, typeof e?.exitCode === 'number' ? e.exitCode : null)
    })
  }

  function bufferText(c: Chat) {
    return strip(c.buffer.join('')).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  }

  function paste(c: Chat, text: string) {
    // A paste, not keystrokes: the TUI takes it whole, newlines in it are text, and Enter
    // follows separately (in the same chunk it would be a newline in the paste).
    // M1: Enter at a permission prompt or a menu picks the highlighted option, an approval nobody tapped.
    // So nothing is pasted while the chat asks, and the Enter is skipped if it began to ask in the 300 ms between.
    // This one guard covers every way in (the tools, the chat view, the heartbeat, a member PC's 'type', the chat host).
    // Approvals answer a question on purpose with input(), not with this.
    if (blocked(c)) return false
    if (c.engine === 'codex') {
      // F-134: Codex takes a message its own way (codex/sender.ts: paste, wait, Enter, look, Enter again). The caller is told it is on its way; a message that
      // could not be taken is said in the log (and a question that appeared in the meantime stops it before any Enter).
      c.lastActive = Date.now()
      const send = () => sendToCodex({ write: d => write(c, d), lines: () => c.screen.lines(), sleep: ms => new Promise<void>(r => setTimeout(r, ms).unref()) }, text, o.codexSend)
      const sending = (c.codexSending ? c.codexSending.then(result => result === 'sent' ? send() : result) : send())
        .catch(() => 'unconfirmed' as const)
      c.codexSending = sending
      void sending.then(
        r => {
          if (r !== 'sent') log?.warn(`chat ${c.info.sessionId.slice(0, 8)}: a message for this Codex chat was not taken (${r})`)
        },
      ).finally(() => { if (c.codexSending === sending) c.codexSending = undefined })
      return true
    }
    if (!write(c, PASTE_START + text.split(PASTE_END).join('') + PASTE_END)) return false
    c.lastActive = Date.now()
    setTimeout(() => {
      if (blocked(c)) {
        log?.warn(`chat ${c.info.sessionId.slice(0, 8)}: it began to ask a question just after a message was pasted; Enter was not pressed`)
        return
      }
      write(c, '\r')
    }, 300).unref()
    return true
  }

  /** Types `text` once the chat is at its prompt: waits past start-up questions and past any later question (never drops it for that). */
  function typeWhenReady(id: string, text: string, opt?: { holdForDraft?: boolean }) {
    const born = Date.now()
    let since = born
    const poll = setInterval(() => {
      const c = chats.get(id)
      if (!c || c.exited || Date.now() - since > 90_000 || Date.now() - born > 6 * 3_600_000) {
        clearInterval(poll)
        if (c && !c.exited) log?.warn(`chat ${id.slice(0, 8)}: never reached its prompt; a message for it was dropped`)
        return
      }
      // At a question the clock stands still: the message waits for the answer.
      if (blocked(c)) {
        since = Date.now()
        return
      }
      // For a message from the app (a nudge): never into a draft he is typing; the clock stands still for that too.
      if (opt?.holdForDraft && draftOnScreen(c)) {
        since = Date.now()
        return
      }
      // What is on screen now: a gate answered a minute ago is still in the scrollback.
      const tail = bufferText(c).slice(-4000).replace(/\s+/g, '')
      if (c.engine === 'codex') {
        // Codex draws its prompt while it works too: it is ready when the prompt is there and no turn is running.
        if (!cxs.CODEX_PROMPT_READY_RE.test(tail) || c.state === 'running') return
      } else if (TRUST_GATE_RE.test(tail) || !PROMPT_READY_RE.test(tail)) return
      clearInterval(poll)
      setTimeout(() => {
        if (c.exited) return
        if (opt?.holdForDraft && draftOnScreen(c)) return typeWhenReady(id, text, opt)
        if (!paste(c, text) && menuOnScreen(c)) typeWhenReady(id, text, opt)
      }, 800).unref()
    }, 400)
    poll.unref()
  }

  function backgroundOf(c: Chat): string | null {
    try {
      return c.engine === 'codex' ? cxs.backgroundWork(c.screen.lines()) : backgroundWork(c.screen.lines())
    } catch {
      return null
    }
  }

  // Stop chats nobody is watching that have really sat idle for IDLE_REAP_MS. F-083: "idle" is no message typed or
  // pasted, no turn, no output while working, for that long, and no background work on its status line, no question
  // up, no open order or unfinished work (o.keep). The night of 2 Nov the old rule (nobody had the chat open and it
  // was not "running" this second) ended chats that were working through messages, and Mobile's during its tests.
  const idleMs = o.idleReapMs ?? IDLE_REAP_MS
  function reapOnce(t = Date.now()) {
    for (const c of [...chats.values()]) {
      if (c.exited || c.viewers.size || c.state === 'running' || c.state === 'question') continue
      if (backgroundOf(c)) {
        c.lastActive = t
        continue
      }
      if (t - Math.max(c.lastSeen, c.lastActive) <= idleMs) continue
      let keep = false
      try {
        keep = o.keep?.(c.info.sessionId) === true
      } catch {
        keep = true // when in doubt, do not end a chat
      }
      if (keep) continue
      log?.info(`chat ${c.info.sessionId.slice(0, 8)}: stopped after ${Math.round(idleMs / 360_000) / 10} h unwatched and idle`)
      c.why = 'idle-reaper'
      killTree(c)
      finish(c, null)
    }
  }
  const reaper = setInterval(reapOnce, o.reapEveryMs ?? REAP_EVERY_MS)
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
      const engine = s.engine === 'codex' ? 'codex' : 'claude'
      const codexBin = engine === 'codex' ? (o.codexBin?.() ?? null) : null
      if (engine === 'codex' && (!codexBin || !s.codex)) throw Object.assign(new Error("The Codex CLI isn't installed on this PC"), { status: 503, code: 'not-installed' })
      const claude = engine === 'codex' ? codexBin! : (o.claude ?? findClaude(o.env))
      if (!claude) throw Object.assign(new Error("Claude Code isn't installed on this PC (no claude on PATH)"), { status: 503 })

      const key = `sad_${randomBytes(24).toString('hex')}`
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(o.env ?? process.env)) if (v !== undefined && !DROP_ENV.test(k)) env[k] = v
      Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3', SAD_AGENTIC_KEY: key, SAD_AGENTIC_URL: o.toolsUrl() })
      // F-040: claude's plain screen, not its full-screen one. That one (the alternate screen,
      // with the mouse captured) keeps no scrollback in the page's terminal and scrolls only by
      // wheel events, which don't get through Windows' pseudo-terminal: the chat couldn't be
      // scrolled. SAD_CLAUDE_FULLSCREEN=1 keeps the full-screen one, as before.
      let args: string[]
      if (engine === 'codex') {
        // F-134: the Codex home is the one shared by this PC's Codex chats; this chat's own settings are its profile (-p). The login in it was put there by
        // codex/index.ts from the CRM's copy. The chat's key comes through the terminal's environment (the profile names SAD_AGENTIC_KEY in env_vars).
        env.CODEX_HOME = s.codex!.home
        // The person's own OPENAI_API_KEY / CODEX_API_KEY were dropped above (DROP_ENV); the CRM's key, if that is the kind, is the one credential this chat has.
        const key = o.codexCredential?.() ?? null
        if (key) env[key.name] = key.value
        // Claude's credentials have no place in a Codex chat's environment (nor does Codex need them).
        for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete env[k]
        // Codex's plain screen, with scrollback, as Claude's F-040: not the full-screen one.
        args = ['-p', s.codex!.profile, '--no-alt-screen']
        if (s.resume && s.codex!.thread) args.push('resume', s.codex!.thread)
      } else {
        if ((o.env ?? process.env).SAD_CLAUDE_FULLSCREEN !== '1') Object.assign(env, { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1', CLAUDE_CODE_DISABLE_MOUSE: '1' })
        const cred = o.credential?.() ?? null
        if (cred) {
          for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete env[k]
          env[cred.name] = cred.value
        } else {
          const token = o.token?.()
          if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token
        }

        args = [s.resume ? '--resume' : '--session-id', s.sessionId, '--append-system-prompt-file', s.briefPath, '--mcp-config', s.mcpConfig ?? o.mcpConfig]
        if (s.strictMcp) args.push('--strict-mcp-config')
        // One folder each, before the options that follow (--add-dir takes more than one value, up to the next option).
        for (const dir of o.addDirs ?? []) args.push('--add-dir', dir)
        if (s.model) args.push('--model', s.model)
        if (s.effort) args.push('--effort', s.effort)
        if (o.settings) args.push('--settings', o.settings)
      }
      const file = /\.cmd$/i.test(claude) ? (env.ComSpec ?? 'cmd.exe') : claude
      const argv = /\.cmd$/i.test(claude) ? ['/d', '/c', claude, ...args] : args
      const size = { cols: s.cols ?? 120, rows: s.rows ?? 32 }
      const startedAt = new Date().toISOString()
      const pty = spawnPty(file, argv, { cwd: s.cwd, env, cols: size.cols, rows: size.rows, id: s.sessionId, meta: { key, floorId: s.floorId, agentId: s.agentId, cwd: s.cwd, startedAt, engine } satisfies Record<string, unknown> })

      const c: Chat = {
        info: { sessionId: s.sessionId, floorId: s.floorId, agentId: s.agentId, engine, cwd: s.cwd, startedAt },
        engine,
        pty,
        key,
        state: 'idle',
        carry: '',
        buffer: [],
        bytes: 0,
        viewers: new Set(),
        exited: false,
        lastSeen: Date.now(),
        lastActive: Date.now(),
        lastOutputAt: Date.now(),
        size,
        screen: createScreen(size.cols, size.rows),
        // F-134: Codex has no start-up questions to answer here (its folder is trusted in the profile's world and approvals are off).
        gates: engine === 'codex' ? { trust: false, trustTries: 0, resume: false, scan: '', until: 0 } : { trust: true, trustTries: 0, resume: s.resume, scan: '', until: Date.now() + GATE_WINDOW_MS },
      }
      register(c)
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
      for (const c of chats.values()) {
        if (c.exited) continue
        settle(c)
        out[c.info.sessionId] = c.state
      }
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
      // A viewer joins with a replay and sends its size on every ChatUI -> TUI mount.
      // Do not shrink/restore an unchanged PTY: Codex reflows its entire history, and
      // a delayed restore could also overwrite a newer, genuine layout change.
      if (w === c.size.cols && h === c.size.rows) return
      try {
        c.pty.resize(w, h)
        c.screen.resize(w, h)
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

    drafting(id) {
      const c = chats.get(id)
      return !!c && !c.exited && draftOnScreen(c)
    },

    asking(id) {
      const c = chats.get(id)
      return !!c && !c.exited && blocked(c)
    },

    type(id, text, opt) {
      const c = chats.get(id)
      if (!c || c.exited) return false
      if (opt?.refuseDraft && draftOnScreen(c)) return false
      return paste(c, text)
    },

    typeWhenReady,

    kill(id, why = 'stopped') {
      const c = chats.get(id)
      if (!c || c.exited) return false
      c.why = why
      killTree(c)
      finish(c, null)
      return true
    },

    async waitStopped(id) {
      const exit = actualExits.get(id)
      if (!exit) return
      let timer: NodeJS.Timeout | undefined
      try { await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The original process has not acknowledged exit; engine switch blocked')), 5000) })]) }
      finally { clearTimeout(timer) }
    },

    adopt(a, pty, replay) {
      const existing = chats.get(a.sessionId)
      if (existing && !existing.exited) return infoOf(existing)
      const size = { cols: a.cols, rows: a.rows }
      const c: Chat = {
        info: { sessionId: a.sessionId, floorId: a.floorId, agentId: a.agentId, engine: a.engine === 'codex' ? 'codex' : 'claude', cwd: a.cwd, startedAt: a.startedAt },
        engine: a.engine === 'codex' ? 'codex' : 'claude',
        pty,
        key: a.key,
        state: 'idle',
        carry: '',
        buffer: replay ? [replay] : [],
        bytes: replay.length,
        viewers: new Set(),
        exited: false,
        lastSeen: Date.now(),
        lastActive: Date.now(),
        lastOutputAt: Date.now(),
        size,
        screen: createScreen(size.cols, size.rows),
        // Long past its start gates (and nobody but a person answers a question that comes later).
        gates: { trust: false, trustTries: 0, resume: false, scan: '', until: 0 },
      }
      // What it was doing, read off what it printed (a menu waiting, the spinner): in slices, as it came.
      for (let i = 0; i < replay.length; i += 16 * 1024) {
        const part = replay.slice(i, i + 16 * 1024)
        c.screen.write(part)
        noteState(c, part)
      }
      register(c)
      log?.info(`chat ${a.sessionId.slice(0, 8)}: taken over from the chat host (${c.state})`)
      changed()
      return infoOf(c)
    },

    activity(id) {
      const c = chats.get(id)
      if (!c || c.exited) return null
      settle(c)
      return { state: c.state, startedAt: c.info.startedAt, lastOutputAt: c.lastOutputAt, lastActiveAt: Math.max(c.lastActive, c.lastSeen), background: backgroundOf(c) }
    },

    press(id, data) {
      const c = chats.get(id)
      return !!c && !c.exited && write(c, data)
    },

    closeAll() {
      clearInterval(reaper)
      if (o.keepOnClose) {
        // The terminals are the host's and go on; only this agent's hold on them ends.
        chats.clear()
        keys.clear()
        return
      }
      for (const c of [...chats.values()]) {
        c.why = 'agent-stop'
        killTree(c)
        finish(c, null)
      }
    },
  }
}
