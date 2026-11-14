import { engineMismatch } from './runtime-engine.ts'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import type { AgentModel, ChatState, TerminalServerMessage } from '../../shared/agentic.ts'
import type { DeliveryBlockReason, DeliveryCause, DeliveryMark } from '../../shared/delivery-reason.ts'
import * as cxs from '../codex/screen.ts'
import { sendToCodex, type DeliveryReport, type SendOptions, type SendResult } from '../codex/sender.ts'
import { ANY_CLAUDE_CHIP_RE, isOwnedClaudeChip } from './claude-paste.ts'
import { classifyBox } from './draft-reading.ts'
import { isDraftKind, MAX_DRAFT_SHOWN, type ClearResult, type DraftKind, type DraftView } from '../../shared/chat-draft.ts'
import { unwrapPaste } from './chatview.ts'
import type { Logger } from '../log.ts'
import { killTree as killProcessTree } from '../proc-tree.ts'
import { createScreen, readTurnState, type Screen } from './screen.ts'
import { createInputMirror, type InputMirror, type MirrorBox, type MirrorClient, type TakeOut } from './input-mirror.ts'

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

/**
 * A prompt as words only, for comparing what was sent with what claude's UserPromptSubmit hook said it took (o655f Stage 1). PROVEN on
 * 2.1.322 with his account's settings (11 Nov, C:\saw\carrier-20261111\logs\probe-real.log): a long paste (3+ lines or over 800 characters)
 * reaches the hook WRAPPED, `\n\n<pasted_content id="530a">\n the words \n</pasted_content id="530a">\n`, so claude's own pair is taken off
 * first (chatview.ts unwrapPaste); a prompt the hook cut at 20,000 characters has lost its closing tag, so then the opening one goes too.
 * Then no whitespace at all.
 */
export function squashPrompt(text: string, cut = false): string {
  const bare = unwrapPaste(text)
  return (cut ? bare.replace(/<pasted_content id="[^"]*">/g, '') : bare).replace(/\s+/g, '')
}

/** Did claude take exactly `sent` (paste markers off) as a prompt since `since`, by its hook's reports? One rule for a send's confirmation and an order's reply. */
/**
 * 12 Nov (Stage 1): the simple send is used only for a native Claude chat that is not Codex-in-Claude (info.execution), and only while Old way is off.
 * Everything else keeps the checked path. Exported so the routing is tested without starting a bridge chat.
 */
export function simpleLayerFor(info: { engine: string; execution?: unknown }, oldWay: boolean): boolean {
  return info.engine === 'claude' && !info.execution && !oldWay
}

export function promptTook(seen: readonly { norm: string; cut: boolean; at: number }[] | undefined, sent: string, since: number): boolean {
  if (!seen?.length) return false
  const want = squashPrompt(sent.split(PASTE_END).join(''))
  return seen.some(p => p.at >= since && (p.norm === want || (p.cut && p.norm !== '' && want.startsWith(p.norm))))
}

export interface StartChat {
  /** Backend-owned managed launch; never accepted directly from an HTTP body. */
  bridge?: { descriptorFile: string; runId: string; binding: import('../../shared/chat-execution.ts').ExecutionSnapshot; wrapperPath: string }
  sessionId: string
  floorId: string
  agentId: string
  cwd: string
  briefPath: string
  /** This chat's own --mcp-config (the app's tools plus the MCP servers its agent was given); the shared one when none. */
  mcpConfig?: string
  /** claude --strict-mcp-config: only the servers of mcpConfig, none from the user's own config (the F-078 scope fix). */
  strictMcp?: boolean
  model: AgentModel | 'gpt-6.1-sol'
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
  codex?: { home: string; profile: string; thread: string | null; bin?: string }
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
  execution?: import('../../shared/chat-execution.ts').ExecutionSnapshot
  bridgeRunId?: string
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
  /** Managed profiles validate physical host ownership and adopt provider leases before PTY adoption. */
  beforeAdopt?(info: AdoptChat): Promise<void>
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
  /** o4743: exactly what the input line holds, as the draft check reads it (what "Inspect terminal" shows); null when it isn't running here. */
  draftView?(sessionId: string): DraftView | null
  /** o4743: clears an unsent draft from its input line with Ctrl+U / Ctrl+K (never Esc or Ctrl+C); nothing is sent. */
  clearDraft?(sessionId: string): Promise<{ result: ClearResult; draft: DraftView | null }>
  /**
   * Pastes `text` and presses Enter (send_to_chat); false when it isn't running. `refuseDraft`: types NOTHING and answers false
   * when the idle input box holds unsent text of Shubham's (the paste would join it and one Enter would send both); a grey
   * suggestion is not a draft.
   */
  type(sessionId: string, text: string, opt?: { refuseDraft?: boolean }): boolean
  /** o655f (Stage 1): claude's UserPromptSubmit hook reported that this chat took `text` (length: its full length, when the text here was cut) as prompt promptId; a send waiting for exactly that text is confirmed. */
  promptSeen?(sessionId: string, text: string, length: number, promptId: string | null, claudeSessionId?: string | null): void
  /**
   * Order-reply carrier (11 Nov): did claude take exactly `text` as a prompt since `since` (ms), by its own hook (promptSeen)? The same rule as a
   * send's confirmation (promptTook). null: it cannot say (not running here, or its hook has not spoken since the chat started here).
   */
  promptTaken?(sessionId: string, text: string, since: number): boolean | null
  /** o655f (Stage 1): the session id claude is on now for this chat when it differs from the chat's own (/clear, /resume), else null. */
  claudeSession?(sessionId: string): string | null
  /** Await actual input acceptance; legacy type() only reports scheduling. */
  deliver?(sessionId: string, text: string, opt?: DeliveryOptions): Promise<SendResult>
  /** Opaque incarnation: a restarted process must not inherit a pending send. */
  generation?(sessionId: string): string | null
  /** Types it once the TUI is up and past its start gates; for a chat that is still starting. */
  typeWhenReady(sessionId: string, text: string, opt?: { holdForDraft?: boolean }): void
  /**
   * F-221 (T4 review): how many of the app's own texts wait in typeWhenReady for this chat's prompt (a carry-on, a nudge, a hand-off's line): on their
   * way, not typed yet. With `text`, only those that are exactly it. 0 when none (or it is not running here).
   */
  waiting?(sessionId: string, text?: string): number
  /**
   * F-221 (T4 review): what its SCREEN shows it doing now (the old way's reading), whatever its transcript says. A chat started again at once reads
   * its record back, where the turn the stop cut off still runs; its screen shows only what this run draws. null when it isn't running here.
   */
  screenState?(sessionId: string): ChatState | null
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
  /** F-193: a chat box's live mirror of a Claude chat's input line (a terminal socket with mode=draft); null when it isn't running here. */
  draftMirror?(sessionId: string, client: MirrorClient): { set(seq: number, text: string, base: number, seal?: boolean): void; detach(): void } | null
  /** F-193: before another message goes in, the live mirror's own text is taken out of the line and typed back after it (input-mirror.ts). */
  mirrorTakeOut?(sessionId: string): Promise<TakeOut>
  closeAll(): void
}

export interface DeliveryOptions {
  refuseDraft?: boolean
  onBlocked?: (reason: DeliveryBlockReason) => void
  /** The HTTP/RPC caller still bounds its observation wait independently. */
  waitForOutcome?: boolean
  waitUntilReady?: boolean
  /** Rechecked before every owned input action; false cancels without retrying on a new binding. */
  guard?: () => boolean
  /** Optional current coordinator authorization immediately before new native input. */
  authorize?: (phase: 'paste' | 'submit') => Promise<boolean>
  /** Diagnostics only: once, when the send ends, which branch ended it and when each step happened. Never any text. */
  onReport?: (report: DeliveryReport) => void
  /** F-193: his own send from a chat box (not an agent's message): words already in the line are submitted with Enter only. */
  human?: boolean
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
  execution?: import('../../shared/chat-execution.ts').ExecutionSnapshot
  bridgeRunId?: string
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
  /**
   * 12 Nov (oad50, Sync Stage 1): the "Old way" switch. Off (the default), a Claude chat's send is the simple layer: one paste, one Enter, never refused
   * for what the screen shows (draft, menu, unresolved, mirror) and confirmed by claude's own prompt report. On, the checked path as it was.
   */
  oldWay?: () => boolean
  /**
   * 12 Nov (sync design change, plan rules 2-3): the chat's state from Claude's TRANSCRIPT (Agent 12's reader; no new hooks). `asking(sessionId)`: a question
   * is open, so a send is REFUSED as "asking" (nothing typed, never shown as sent) and must be sent again after the answer. `transcriptTook(sessionId,
   * text, since)`: a user or enqueue row carrying the text since `since`. Absent: the send is confirmed by Claude's prompt report alone.
   */
  chatSignals?: {
    asking?: (sessionId: string) => boolean
    transcriptTook?: (sessionId: string, text: string, since: number) => boolean
    /**
     * Stage 1 (o400b, Agent 12's reader, turns.ts): what the chat is doing as Claude's own transcript says (running / question / idle); null when its
     * transcript is not read here. Unless "Old way" is on, the pool shows and decides by it (states, info, activity, asking, the reaper); the screen's
     * reading stays for Old way, Codex and Codex in Claude Code.
     */
    state?: (sessionId: string) => ChatState | null
  }
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
  /** o4743, tests: how long the second look at an "unsent draft" waits (default 150 ms). */
  draftRecheckMs?: number
  /** o4743, tests: how long one paste waits for its line to read clear before the next one goes in (default 4000 ms). */
  pasteSettleMs?: number
  /** Lost-Enter watch, tests: how long a paste may go without any terminal output before it is logged (default 1000 ms). */
  echoWaitMs?: number
  /**
   * F-051: a --settings file (the memory's UserPromptSubmit hook); claude adds it to the user's own settings. F-221 (ob98a, T4): or a function of the
   * chat being started, asked ONCE per start of a Claude chat that takes settings (never a Codex chat, never Codex in Claude Code): index.ts gives
   * the Orchestrator's chat its own file with the voice lock (latch-hook.ts) and every other chat what it had. Undefined: no --settings at all.
   */
  settings?: string | ((s: StartChat) => string | undefined)
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
  /** F-193: the agent-side switch for the live mirror (input-mirror.off, SAD_INPUT_MIRROR=0): true = off, every page keeps the old way. */
  mirrorOff?: () => boolean
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
  /** o178e: the size the terminal had while each piece of uffer was printed (null: not known, a replay given by the chat host). Same length as uffer. */
  sizes: ({ cols: number; rows: number } | null)[]
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
  delivering?: Promise<SendResult>
  /** 12 Nov (Stage 1): the simple sends of this chat, one after another, so two pastes never interleave. */
  simpleTail?: Promise<unknown>
  generation?: string
  inputEpoch?: number
  /** F-193: the live mirror of its input line (made when a chat box first asks), until when the old direct paste is in flight, and when a person last typed in it. */
  mirror?: InputMirror
  pastingUntil?: number
  /** o4743: the paste in flight (one at a time per chat) and how many wait behind it. */
  pasteChain?: Promise<void>
  pasteQueued?: number
  /** o655f (Stage 1): the prompts claude said it TOOK (its UserPromptSubmit hook): the text with its whitespace squashed, whether that text was cut, its prompt id, when. The last 30. */
  seen?: { norm: string; cut: boolean; id: string | null; at: number }[]
  /** o655f (Stage 1): the session id claude says it is on NOW when it is not the chat's own (after /clear or /resume claude starts a new session and a new file). */
  claudeSid?: string
  typedAt?: number
  /** Lost-Enter watch (see watchEcho): the timer, when the last silence was logged, and when the paste was whose echo did not come. */
  echoWatch?: ReturnType<typeof setTimeout>
  lastEchoLogAt?: number
  silentSince?: number
  /** o4743: the last input that reached the terminal: when, what kind (never the words) and from where; for the log only. */
  lastInput?: { at: number; kind: string; via: 'page' | 'app' }
}

export function createChatPool(o: ChatPoolOptions): ChatPool {
  const oldWay = o.oldWay ?? (() => process.env.SAD_SYNC === 'old')
  const chats = new Map<string, Chat>()
  const actualExits = new Map<string, Promise<void>>()
  const keys = new Map<string, Chat>()
  const log = o.log
  let spawnPty = o.spawn ?? null
  const changed = () => o.onChange?.()

  const infoOf = (c: Chat): ChatInfo => ({ ...c.info, state: stateNow(c), viewers: c.viewers.size })

  /**
   * Stage 1 (o400b, Sync Research plan rule 3): a Claude chat's state as its own transcript says (chatSignals.state), in the simple layer; null: the
   * screen's reading as before (Old way, a Codex chat, Codex in Claude Code, a chat whose transcript is not read here yet).
   */
  function claudeState(c: Chat): ChatState | null {
    if (c.engine !== 'claude' || c.info.execution || oldWay()) return null
    try {
      return o.chatSignals?.state?.(c.info.sessionId) ?? null
    } catch {
      return null
    }
  }
  /** What the chat is doing: Claude's own word when it has one, else the screen's reading put right (settle). */
  function stateNow(c: Chat): ChatState {
    const s = claudeState(c)
    if (s) return s
    settle(c)
    return c.state
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
  const RULE_LINE_RE = /^\s*[─━]{8,}\s*$/
  const INPUT_LINE_RE = /^\s*❯(?!\s*\d{1,2}\.\s)/
  // One bound for both menu exclusion and ownership reconstruction. Narrow
  // terminals routinely wrap past eight rows; an incomplete/oversized newest
  // box must never fall back to an older empty composer.
  const MAX_COMPOSER_ROWS = 64
  function inputBox(lines: string[]): { start: number; end: number } | null {
    for (let j = lines.length - 1; j >= 1; j--) {
      if (!RULE_LINE_RE.test(lines[j - 1]) || !INPUT_LINE_RE.test(lines[j])) continue
      for (let k = j + 1; k < Math.min(lines.length, j + MAX_COMPOSER_ROWS + 1); k++)
        if (RULE_LINE_RE.test(lines[k])) return { start: j, end: k }
      return null
    }
    return null
  }
  /**
   * What is typed in the idle input box (the lowest one drawn) and not sent yet: a draft. '' when no box is drawn or it is empty.
   * claude's own grey suggestions are not a draft: the placeholder of a fresh chat ('Try "write a test"') and the SUGGESTED NEXT PROMPT
   * it draws there after most turns ("Merge the guard fix and run the gate"), both printed dim or grey. `typed` is the same screen with
   * those cells blanked (Screen.typedLines); what is left is what a person typed. Anything pasted now would join a draft,
   * and the Enter would send both as one message.
   */
  /** o4743: the lowest input box classified (draft-reading.ts: typed text, a chip, Claude's grey suggestion, one of its hint lines); null when none is drawn. */
  function readBox(lines: string[], typed: string[] = lines) {
    const box = inputBox(lines)
    if (!box) return null
    const join = (rows: string[]) => [rows[box.start].replace(/^\s*❯/, ''), ...rows.slice(box.start + 1, box.end)].join(' ').replace(/\s+/g, ' ').trim()
    return { ...classifyBox(join(lines), join(typed)), rows: box.end - box.start }
  }
  function boxComposer(lines: string[], typed: string[] = lines): string | null {
    const r = readBox(lines, typed)
    return r === null ? null : r.text
  }
  /** o4743: what the input line holds right now (the draft check, the "Inspect terminal" panel and the clear all read this one thing). */
  interface DraftReading { kind: DraftKind; text: string; ignored: string; rows: number }
  const reading = (kind: DraftKind, text = '', ignored = '', rows = 0): DraftReading => ({ kind, text, ignored, rows })
  function draftReading(c: Chat): DraftReading {
    try {
      if (c.engine === 'codex') {
        if (menuOnScreen(c)) return reading('menu')
        const t = cxs.draftText(c.screen.lines())
        return t === '' ? reading('none') : reading('typed', t, '', 1)
      }
      if (menuOnScreen(c)) return reading('menu')
      const r = readBox(c.screen.lines(), c.screen.typedLines())
      if (r === null) return reading('no-box')
      // F-193: the live mirror's own text counts as his draft only while he types in a chat box (20 s); otherwise another message takes
      // it out of the line and the mirror types it back after (paste, deliver).
      if ((r.kind === 'typed' || r.kind === 'chip') && c.mirror?.owned() && !c.mirror.typing()) return reading('mirror', r.text, '', r.rows)
      return reading(r.kind, r.text, r.ignored, r.rows)
    } catch {
      return reading('unreadable')
    }
  }
  const draftOnScreen = (c: Chat) => isDraftKind(draftReading(c).kind)
  /** o4743: a terminal input told apart for the log (never its content): Enter, a focus report, another escape sequence, a control key, text. */
  const inputKind = (d: string) => (d.includes('\r') ? 'enter' : d === '\u001b[I' || d === '\u001b[O' ? 'focus report' : d.startsWith('\u001b') ? 'escape sequence' : d.length === 1 && d < ' ' ? 'control key' : 'text')
  const DRAFT_RECHECK_MS = o.draftRecheckMs ?? 150
  /**
   * o4743: a refusal for "an unsent draft" needs the same answer twice, 150 ms apart: a screen read in the middle of a redraw (the box
   * half drawn, a line just printed) is not a draft. Null when the second look does not agree.
   */
  async function draftHolds(c: Chat): Promise<DraftReading | null> {
    await new Promise<void>(resolve => setTimeout(resolve, DRAFT_RECHECK_MS))
    if (c.exited) return null
    const second = draftReading(c)
    return isDraftKind(second.kind) ? second : null
  }
  const draftViewOf = (c: Chat, r: DraftReading): DraftView => {
    const busy = !!c.delivering || !!c.pasteChain || (c.pastingUntil ?? 0) > Date.now()
    const draft = isDraftKind(r.kind)
    return {
      kind: r.kind,
      draft,
      text: draft ? r.text.slice(0, MAX_DRAFT_SHOWN) : '',
      ignored: r.ignored.slice(0, MAX_DRAFT_SHOWN),
      chars: r.text.length,
      rows: r.rows,
      busy,
      clearable: draft && !busy && c.engine === 'claude' && !c.info.execution,
    }
  }

  /**
   * F-193: inputBox for the live mirror only (the sender keeps inputBox): Claude's "/" or "@" list draws its chosen item indented
   * ("  ❯ src/a.ts") right under the box's bottom rule; then the box is the complete one whose bottom rule is right above that item. A newest
   * candidate that is not such an item gives null, exactly as inputBox: nothing older is ever taken.
   */
  function mirrorInputBox(lines: string[]): { start: number; end: number } | null {
    const box = inputBox(lines)
    if (box) return box
    for (let j = lines.length - 1; j >= 2; j--) {
      if (!RULE_LINE_RE.test(lines[j - 1]) || !INPUT_LINE_RE.test(lines[j])) continue
      if (!/^\s+❯/.test(lines[j])) return null
      for (let i = j - 2; i >= 1 && j - 1 - i <= MAX_COMPOSER_ROWS; i--) {
        if (RULE_LINE_RE.test(lines[i])) return null
        if (RULE_LINE_RE.test(lines[i - 1]) && INPUT_LINE_RE.test(lines[i]) && !/^\s+❯/.test(lines[i])) return { start: i, end: j - 1 }
      }
      return null
    }
    return null
  }
  /** F-193: the input box as the live mirror reads it: typed text, a chip in it, its rows, and whether the parked cursor is after the text. */
  function mirrorBox(c: Chat): MirrorBox | null {
    try {
      const lines = c.screen.lines()
      const typed = c.screen.typedLines()
      const box = mirrorInputBox(lines)
      if (!box) return null
      // As boxComposer: a chip is real input in whatever colour; Claude's grey placeholder is not.
      const join = (rows: string[]) => [rows[box.start].replace(/^\s*❯/, ''), ...rows.slice(box.start + 1, box.end)].join(' ').replace(/\s+/g, ' ').trim()
      const raw = join(lines)
      const typedText = join(typed)
      const text = ANY_CLAUDE_CHIP_RE.test(raw) ? raw : /^Try "/.test(typedText) ? '' : typedText
      let last = box.start
      for (let r = box.end - 1; r >= box.start; r--) {
        if ((r === box.start ? typed[r].replace(/^\s*❯/, '') : typed[r]).trim()) {
          last = r
          break
        }
      }
      const at = c.screen.cursor()
      const width = typed[last].replace(/\s+$/, '').length
      return { text, chip: ANY_CLAUDE_CHIP_RE.test(text), rows: box.end - box.start, atEnd: at.y >= box.start && at.y < box.end ? at.y > last || (at.y === last && at.x >= width) : null }
    } catch {
      return null
    }
  }
  /**
   * F-193: a dialog Claude 2.1.322 draws ABOVE its still visible input box (the /model picker: options with "❯ 1.", a footer "... Esc to
   * cancel"), which menuSeen takes for quoted text. Seen here as: a menu footer in the last two lines above the box and an option under the
   * cursor in the twelve above it. Unreadable counts as a dialog.
   */
  function dialogAbove(c: Chat): boolean {
    try {
      const lines = c.screen.lines()
      const box = mirrorInputBox(lines)
      if (!box) return false
      const above: string[] = []
      for (let i = box.start - 2; i >= 0 && above.length < 12; i--) if (lines[i].trim()) above.push(lines[i])
      return above.slice(0, 2).some(l => MENU_FOOTER_RE.test(l)) && above.some(l => OPTION_UNDER_CURSOR_RE.test(l))
    } catch {
      return true
    }
  }
  /** F-193: the chat's live mirror, made when a chat box first asks for it (input-mirror.ts). */
  function mirrorOf(c: Chat): InputMirror {
    c.mirror ??= createInputMirror(
      {
        write: data => write(c, data),
        read: () => mirrorBox(c),
        hold: () => (c.exited ? 'gone' : c.delivering || (c.pastingUntil ?? 0) > Date.now() ? 'delivering' : menuSeen(c) !== false || dialogAbove(c) ? 'menu' : null),
        epoch: () => c.inputEpoch ?? 0,
        quietMs: () => Date.now() - Math.max(c.lastOutputAt, c.typedAt ?? 0),
        log: line => log?.info(`chat ${c.info.sessionId.slice(0, 8)}: ${line}`),
      },
      // o0122 (14 Nov 2026, Shubham: "the live typing sending thrice"): a chat that sends the simple way (Stage 1, this PC's Old way off) is
      // never live-typed into. The simple send pastes the message whatever the line holds, so text the mirror had typed went in with it: his
      // words twice in one prompt (the page's own Sent bubble, unmatched, made three). It happened when the page's PC is in the Old way (its
      // pages offer live sync) and the chat runs on a PC that is not (the Server's page, the Assistant on the laptop). The chat box is told
      // "unsupported" when it joins, so it keeps his words until Send, as with live sync off.
      { off: () => o.mirrorOff?.() === true, unsupported: () => (c.engine !== 'claude' ? c.engine : c.info.execution ? 'codex-in-claude' : simpleLayerFor(c.info, oldWay()) ? 'simple-send' : null) },
    )
    return c.mirror
  }
  /** Whether a menu is on the live screen; null when the screen cannot be read. */
  function menuSeen(c: Chat): boolean | null {
    try {
      const lines = c.screen.lines()
      if (c.engine === 'codex') return cxs.menuOnScreen(lines)
      const box = inputBox(lines)
      for (let i = lines.length - 1; i >= 0; i--) {
        // Quoted menu instructions inside a complete composer are typed input.
        // A real menu below it still wins, and unreadable boxes exclude nothing.
        if (box && i >= box.start && i < box.end) continue
        if (OPTION_UNDER_CURSOR_RE.test(lines[i]) || MENU_FOOTER_RE.test(lines[i])) return !box || i > box.end
      }
      return false
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
        const lines = c.screen.lines()
        return c.engine === 'claude' ? readTurnState(lines) === 'running' : lines.some(l => /esc to interrupt/i.test(l))
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
    // o007f: words alone only GUESS a question. A chat that stands at its idle input box with no menu under it is not asking, however its
    // last reply is worded ("Which do you want?"): claude repaints that reply with every status update, so each repaint used to make it a
    // question again for the 3 s grace before settle() put it right, over and over (Lead's chat did it every ~4 s, 184 times in one evening:
    // a card that came and went in Approvals). A real prompt REPLACES the idle box, so while the box is drawn the words are only text; a
    // prompt that is still being drawn is caught the moment its menu is on the screen (settle()).
    const plainWords = c.engine === 'claude' && menuSeen(c) === false && inputBox(c.screen.lines()) !== null
    // A question outranks working: a permission prompt comes mid-turn, and while it's up the agent waits on you.
    if (re.question.test(t) && !plainWords) c.state = 'question'
    else if (re.running.test(t)) c.state = 'running'
    else if (re.done.test(t) || re.idle.test(t)) c.state = 'idle'
    // The PTY/host can coalesce an old running paint with the later completed
    // one (including on adoption). Trust their final rendered order, not the
    // presence of any historical interrupt marker in the whole stream chunk.
    // Question/menu handling keeps its existing fail-closed/grace behaviour.
    if (c.engine === 'claude' && c.state !== 'question') c.state = readTurnState(c.screen.lines()) ?? c.state
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

  /**
   * 12 Nov (oad50, Sync Stage 1, Special's part): the simple send for a Claude chat, the default. One paste, one Enter, in order behind any earlier
   * simple send of this chat. Nothing is refused for what the screen shows (draft, menu, unresolved, mirror): his words go in. Claude's own prompt
   * report is the only confirmation; if it does not come within 5 s the send is "unconfirmed" (grey, quiet) and is NEVER sent again.
   */
  function simpleSend(c: Chat, text: string, opt?: DeliveryOptions): Promise<SendResult> {
    const run = (c.simpleTail ?? Promise.resolve()).then(() => simpleOne(c, text, opt), () => simpleOne(c, text, opt))
    c.simpleTail = run.catch(() => undefined)
    return run
  }
  async function simpleOne(c: Chat, text: string, opt?: DeliveryOptions): Promise<SendResult> {
    if (c.exited) return 'gone'
    if (opt?.guard?.() === false) { opt.onBlocked?.('input-changed'); return 'blocked' }
    if (opt?.authorize && !(await opt.authorize('paste').catch(() => false))) { opt.onBlocked?.('authorization-revoked'); return 'blocked' }
    const pasted = text.split(PASTE_END).join('')
    if (!pasted.trim()) { opt?.onBlocked?.('empty-message'); return 'blocked' }
    const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
    const sid = c.info.sessionId, signals = o.chatSignals
    const began = Date.now(), marks: [DeliveryMark, number][] = []
    const mark = (name: DeliveryMark) => { if (marks.length < 16) marks.push([name, Date.now() - began]) }
    // Every end is reported (counts-only delivery log): which branch ended the send, and when.
    const done = (result: SendResult, cause: DeliveryCause): SendResult => { mark('end'); try { opt?.onReport?.({ result, cause, marks }) } catch { /* diagnostics never change a send */ } return result }
    // Claude has a question open (the transcript says so, exact): nothing is typed; the send is refused as "asking", never shown as sent.
    if (signals?.asking?.(sid)) { opt?.onBlocked?.('asking'); return done('blocked', 'menu-appeared') }
    if (!write(c, PASTE_START)) return done('gone', 'write-refused')
    mark('paste')
    for (let offset = 0; offset < pasted.length;) {
      let end = Math.min(offset + 1024, pasted.length)
      if (end < pasted.length && /[\uD800-\uDBFF]/.test(pasted[end - 1])) end--
      if (!write(c, pasted.slice(offset, end))) return done('gone', 'write-refused')
      offset = end
      if (offset < pasted.length) await sleep(10)
    }
    if (!write(c, PASTE_END)) return done('gone', 'write-refused')
    mark('pasted')
    await sleep(300)
    if (c.exited) return done('gone', 'terminal-gone')
    if (opt?.authorize && !(await opt.authorize('submit').catch(() => false))) { opt.onBlocked?.('authorization-revoked'); return done('blocked', 'authorization-denied') }
    if (!write(c, '\r')) return done('gone', 'write-refused')
    mark('enter-1')
    // Slash commands get no prompt report and usually no user row: they show as sent when typed; their effect shows by itself (/clear).
    if (/^\s*\//.test(pasted)) return done('sent', 'slash-command')
    const took = () => promptTook(c.seen, pasted, began) || signals?.transcriptTook?.(sid, pasted, began) === true
    for (let waited = 0; waited < 5000; waited += 100) {
      if (took()) return done('sent', 'confirmed')
      if (c.exited) return done('gone', 'terminal-gone')
      await sleep(100)
    }
    // Claude's own word did not come in 5 s: a quiet, grey "not confirmed"; the message is never pasted or pressed again.
    return done(took() ? 'sent' : 'unconfirmed', took() ? 'confirmed' : 'no-report')
  }

  function write(c: Chat, data: string) {
    if (c.exited) return false
    try {
      c.pty.write(data)
      if (data.endsWith(PASTE_END)) watchEcho(c, data.length)
      return true
    } catch {
      return false
    }
  }

  /**
   * o4743 / lost Enter (11 Nov 2026): a Claude chat that is reading its input echoes a paste in its box within about 100 ms. On 11 Nov two order replies
   * pasted at 20:03:35 sat unsent for seven minutes in an IDLE Claude chat and were then taken together (the transcript), which fits a terminal UI that
   * was not reading its keyboard. This only WATCHES: when no terminal output comes within 1 s after a paste it logs one line (counts and ages, never any
   * words; at most one per 30 s per chat) and one more when output comes again. It types nothing and changes nothing.
   */
  const ECHO_WAIT_MS = o.echoWaitMs ?? 1000
  function watchEcho(c: Chat, chars: number) {
    if (c.echoWatch) return
    const armedAt = Date.now(), lastBefore = c.lastOutputAt
    c.echoWatch = setTimeout(() => {
      c.echoWatch = undefined
      if (c.exited || c.lastOutputAt > armedAt) return
      if (Date.now() - (c.lastEchoLogAt ?? 0) < 30_000) return
      c.lastEchoLogAt = Date.now()
      c.silentSince = armedAt
      log?.info(`chat ${c.info.sessionId.slice(0, 8)}: no terminal output within ${ECHO_WAIT_MS} ms after a paste (${chars} characters in the last write; the last output was ${Math.max(0, Math.round((armedAt - lastBefore) / 1000))} s before it; ${c.viewers.size} viewers; state ${c.state}): the chat may not be reading its input`)
    }, ECHO_WAIT_MS)
    c.echoWatch.unref?.()
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
    if (c.echoWatch) clearTimeout(c.echoWatch)
    c.mirror?.dispose()
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
      if (c.silentSince !== undefined) {
        log?.info(`chat ${c.info.sessionId.slice(0, 8)}: terminal output again ${Math.round((Date.now() - c.silentSince) / 1000)} s after a paste that got no echo (it had not been reading its input)`)
        c.silentSince = undefined
      }
      c.buffer.push(data)
      c.sizes.push({ cols: c.size.cols, rows: c.size.rows })
      c.bytes += data.length
      while (c.bytes > MAX_BUFFER_BYTES && c.buffer.length > 1) {
        c.bytes -= c.buffer.shift()!.length
        c.sizes.shift()
      }
      c.screen.write(data)
      noteState(c, data)
      c.lastOutputAt = Date.now()
      if ((claudeState(c) ?? c.state) === 'running') c.lastActive = c.lastOutputAt
      answerGates(c, data)
      c.mirror?.poke()
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

  /** Diagnostics only: pass the sender's report on with its steps shifted by the time spent waiting for the composer first. */
  function offsetReport(opt: DeliveryOptions | undefined, r: DeliveryReport, waited: number) {
    try { opt?.onReport?.(waited > 0 ? { ...r, marks: [['wait-ready', waited], ...r.marks.map(([n, ms]) => [n, ms + waited] as [DeliveryMark, number])].slice(0, 16) as [DeliveryMark, number][] } : r) } catch { /* never changes a delivery */ }
  }
  /** A send refused while waiting for the composer (before any input): the one step and the cause. */
  function reportBefore(opt: DeliveryOptions | undefined, began: number, cause: DeliveryCause) {
    const ms = Date.now() - began
    try { opt?.onReport?.({ result: 'blocked', cause, marks: [['wait-ready', ms], ['end', ms]] }) } catch { /* never changes a delivery */ }
  }

  function sendCodex(c: Chat, text: string, opt?: DeliveryOptions): Promise<SendResult> {
    const epoch = c.inputEpoch ?? 0
    const deadline = Date.now() + Math.min(300_000, o.codexSend?.timeoutMs ?? Math.max(96_000, Buffer.byteLength(text) * 50 + 6000))
    const send = async (): Promise<SendResult> => {
      const began = Date.now()
      const interruptCause = () => (c.inputEpoch ?? 0) !== epoch ? 'terminal-input' as const : 'guard-revoked' as const
      while (opt?.waitUntilReady && !c.exited && !cxs.composer(c.screen.lines()) && !menuOnScreen(c) && Date.now() < deadline) {
        // Nothing of the message is typed yet: this is a refusal, safe to send again, not an unconfirmed send.
        if ((c.inputEpoch ?? 0) !== epoch || opt.guard?.() === false) { opt.onBlocked?.('input-changed'); reportBefore(opt, began, interruptCause()); return 'blocked' }
        await new Promise<void>(resolve => setTimeout(resolve, 100))
      }
      if (c.exited) return 'gone'
      if (opt?.guard?.() === false) { opt.onBlocked?.('input-changed'); return 'blocked' }
      const sendStart = Date.now()
      return sendToCodex({
      write: d => d !== PASTE_END && ((c.inputEpoch ?? 0) !== epoch || opt?.guard?.() === false) ? false : write(c, d), lines: () => { if (c.exited) throw Error('gone'); return c.screen.lines() },
      sleep: ms => new Promise<void>(r => setTimeout(r, ms)),
      interrupted: () => (c.inputEpoch ?? 0) !== epoch || opt?.guard?.() === false,
      interruptCause,
      gone: () => c.exited,
      beforeInput: opt?.authorize,
      onBlocked: opt?.onBlocked,
      report: r => offsetReport(opt, r, sendStart - began),
    }, text, { ...o.codexSend, timeoutMs: Math.max(0, deadline - Date.now()) })
    }
    const sending = (c.codexSending ? c.codexSending.then(r => r === 'sent' ? send() : 'blocked' as const) : send())
      .catch(() => 'unconfirmed' as const)
    c.codexSending = sending
    void sending.then(r => { if (r !== 'sent') log?.warn(`chat ${c.info.sessionId.slice(0, 8)}: message delivery ${r}`) })
      .finally(() => { if (c.codexSending === sending) c.codexSending = undefined })
    return sending
  }

  function paste(c: Chat, text: string) {
    // A paste, not keystrokes: the TUI takes it whole, newlines in it are text, and Enter
    // follows separately (in the same chunk it would be a newline in the paste).
    // M1: Enter at a permission prompt or a menu picks the highlighted option, an approval nobody tapped.
    // So nothing is pasted while the chat asks, and the Enter is skipped if it began to ask in the 300 ms between.
    // This one guard covers every way in (the tools, the chat view, the heartbeat, a member PC's 'type', the chat host).
    // Approvals answer a question on purpose with input(), not with this.
    if (blocked(c)) return false
    if (c.delivering) return false
    if (c.engine === 'codex') {
      // F-134: Codex takes a message its own way (codex/sender.ts: paste, wait, Enter, look, Enter again). The caller is told it is on its way; a message that
      // could not be taken is said in the log (and a question that appeared in the meantime stops it before any Enter).
      c.lastActive = Date.now()
      void sendCodex(c, text)
      return true
    }
    // F-193: never pasted after the live mirror's own text (one Enter would send both): it is taken out first, this message goes in, and the
    // mirror types it back after. While he types in a chat box (20 s) the message is refused; one that cannot be typed now waits for its turn.
    const m = c.mirror
    if (m && (m.busy() || m.owned())) {
      // Mid-edit the line is between two states (real Claude, 11 Nov: a paste then joined his words): refused like a draft he is typing.
      if (m.busy() || m.typing()) return false
      void m.takeOut().then(r => {
        if ((r === 'taken' || r === 'none') && !blocked(c) && !c.delivering && pasteNow(c, text)) return
        log?.warn(`chat ${c.info.sessionId.slice(0, 8)}: a message waits: the live mirror's text could not be taken out of the input line (${r})`)
        if (r === 'taken') m.delivered(null, false)
        typeWhenReady(c.info.sessionId, text, { holdForDraft: true })
      })
      return true
    }
    return pasteNow(c, text)
  }
  /**
   * o4743 (11 Nov, from Agent 4's data): two messages pasted 20 ms apart into one line sat there unsent for seven minutes (the Enter of the
   * first one was lost, and a draft nobody typed then blocked his own sends). So ONE paste and its Enter at a time per chat: the next waits
   * for its turn, which is when the line reads clear after the Enter (bounded: PASTE_SETTLE_MS, so nothing waits for ever; a stuck line is then
   * joined exactly as before). Order is kept. Still one Enter per message, no retry.
   */
  const PASTE_SETTLE_MS = o.pasteSettleMs ?? 4000
  const PASTE_QUEUE_MAX = 20
  function pasteOne(c: Chat, text: string): Promise<void> | null {
    if (!write(c, PASTE_START + text.split(PASTE_END).join('') + PASTE_END)) return null
    c.lastActive = Date.now()
    // F-193: the live mirror types nothing while this paste and its Enter are on their way, then looks again (and types its text back).
    c.pastingUntil = Date.now() + 1500
    return new Promise<void>(resolve => {
      setTimeout(() => {
        setTimeout(() => c.mirror?.delivered(null, false), 1300).unref()
        if (blocked(c)) {
          log?.warn(`chat ${c.info.sessionId.slice(0, 8)}: it began to ask a question just after a message was pasted; Enter was not pressed`)
          resolve()
          return
        }
        write(c, '\r')
        // The next message goes in when the line reads clear again (or the bound ends).
        const until = Date.now() + PASTE_SETTLE_MS
        const look = () => {
          if (c.exited || Date.now() >= until || !draftOnScreen(c)) return resolve()
          setTimeout(look, 100).unref()
        }
        setTimeout(look, 100).unref()
      }, 300).unref()
    })
  }
  function trackPaste(c: Chat, p: Promise<void>) {
    const chain: Promise<void> = p.catch(() => {}).finally(() => { if (c.pasteChain === chain) c.pasteChain = undefined })
    c.pasteChain = chain
  }
  function pasteNow(c: Chat, text: string) {
    if (c.pasteChain) {
      if ((c.pasteQueued ?? 0) >= PASTE_QUEUE_MAX) return false
      c.pasteQueued = (c.pasteQueued ?? 0) + 1
      const turn = c.pasteChain.then((): Promise<void> | void => {
        c.pasteQueued = Math.max(0, (c.pasteQueued ?? 1) - 1)
        if (c.exited) return
        // A question or a send of the checked kind came up while it waited: it goes in when the chat is at its prompt, never into either.
        if (blocked(c) || c.delivering) { typeWhenReady(c.info.sessionId, text); return }
        return pasteOne(c, text) ?? undefined
      })
      trackPaste(c, turn)
      return true
    }
    const first = pasteOne(c, text)
    if (!first) return false
    trackPaste(c, first)
    return true
  }

  /**
   * F-221 (T4 review): the texts typeWhenReady holds for each chat, until each is pasted, handed on to another wait, or dropped. The hub reads them
   * (waiting): a chat with a carry-on still to come is not at rest for a spoken line, and a carry-on not typed yet when the chat host link goes again
   * is told again when it is reopened.
   */
  const waitingTexts = new Map<string, string[]>()
  function waitFor(id: string, text: string): () => void {
    waitingTexts.set(id, [...(waitingTexts.get(id) ?? []), text])
    let done = false
    return () => {
      if (done) return
      done = true
      const list = waitingTexts.get(id) ?? []
      const i = list.indexOf(text)
      const rest = i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)]
      if (rest.length) waitingTexts.set(id, rest)
      else waitingTexts.delete(id)
    }
  }

  /** Types `text` once the chat is at its prompt: waits past start-up questions and past any later question (never drops it for that). */
  function typeWhenReady(id: string, text: string, opt?: { holdForDraft?: boolean }) {
    const born = Date.now()
    let since = born
    const over = waitFor(id, text)
    const poll = setInterval(() => {
      const c = chats.get(id)
      if (!c || c.exited || Date.now() - since > 90_000 || Date.now() - born > 6 * 3_600_000) {
        clearInterval(poll)
        over()
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
        // Waited for again (a new wait counts it first), pasted (a paste on its way is the box's own busy), or dropped: it no longer waits here.
        try {
          if (c.exited) return
          if (opt?.holdForDraft && draftOnScreen(c)) return typeWhenReady(id, text, opt)
          if (!paste(c, text) && menuOnScreen(c)) typeWhenReady(id, text, opt)
        } finally {
          over()
        }
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
      if (c.exited || c.viewers.size) continue
      const st = stateNow(c)
      if (st === 'running' || st === 'question') continue
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
      if (s.bridge && (s.engine !== 'claude' || s.bridge.binding.execution.profile !== 'codex-in-claude-v1'
        || s.bridge.binding.sessionId !== s.sessionId || s.bridge.binding.agentId !== s.agentId
        || s.model !== 'gpt-6.1-sol' || s.effort !== 'max')) throw Object.assign(new Error('Invalid managed execution launch.'), { status: 409, code: 'execution-runtime-mismatch' })
      if (s.engine && s.engine !== 'claude' && s.engine !== 'codex') throw Object.assign(new Error('This native terminal pool does not support the requested engine.'), { status: 503, code: 'engine-not-supported' })
      const existing = chats.get(s.sessionId)
      if (existing && !existing.exited) {
        if (existing.engine !== (s.engine ?? 'claude')) throw engineMismatch(s.engine ?? 'claude', existing.engine)
        if (JSON.stringify(existing.info.execution ?? null) !== JSON.stringify(s.bridge?.binding ?? null) || (existing.info.bridgeRunId ?? null) !== (s.bridge?.runId ?? null)) throw Object.assign(new Error('The existing runtime belongs to another execution.'), { status: 409, code: 'execution-runtime-mismatch' })
        return infoOf(existing)
      }
      if (!spawnPty) {
        const loaded = loadNodePty()
        if ('error' in loaded) throw Object.assign(new Error(loaded.error), { status: 503 })
        spawnPty = loaded.spawn
      }
      const engine = s.engine === 'codex' ? 'codex' : 'claude'
      if (s.codex?.bin && (!path.isAbsolute(s.codex.bin) || !/\.exe$/i.test(s.codex.bin))) throw Object.assign(new Error('Invalid pinned native executable.'), { status: 409, code: 'execution-runtime-mismatch' })
      const codexBin = engine === 'codex' ? (s.codex?.bin ?? o.codexBin?.() ?? null) : null
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
        const cred = s.bridge ? null : o.credential?.() ?? null
        if (s.bridge) {
          for (const k of Object.keys(env)) if (/^(?:ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_)/.test(k)) delete env[k]
          // Codex in Claude Code runs the bridge's own copy of the one proved Claude Code version: it never updates itself.
          env.DISABLE_AUTOUPDATER = '1'
        } else if (cred) {
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
        // Shubham chose bypass for all existing/new chats: resumes get the same launch default.
        // The native startup consent is recorded by prepareClaudeConfig, not answered with keys.
        args.push('--permission-mode', 'bypassPermissions')
        // F-221 (ob98a, T4): read once per start (a function is asked for this chat only; Codex in Claude Code never gets settings).
        const pick = s.bridge ? undefined : o.settings
        const settings = typeof pick === 'function' ? pick(s) : pick
        if (settings) args.push('--settings', settings)
      }
      const file = s.bridge ? process.execPath : /\.cmd$/i.test(claude) ? (env.ComSpec ?? 'cmd.exe') : claude
      const argv = s.bridge ? [s.bridge.wrapperPath, s.bridge.descriptorFile, ...args] : /\.cmd$/i.test(claude) ? ['/d', '/c', claude, ...args] : args
      const size = { cols: s.cols ?? 120, rows: s.rows ?? 32 }
      const startedAt = new Date().toISOString()
      const pty = spawnPty(file, argv, { cwd: s.cwd, env, cols: size.cols, rows: size.rows, id: s.sessionId, meta: { key, floorId: s.floorId, agentId: s.agentId, cwd: s.cwd, startedAt, engine, ...(s.bridge ? { execution: s.bridge.binding, bridgeRunId: s.bridge.runId } : {}) } satisfies Record<string, unknown> })

      const c: Chat = {
        info: { sessionId: s.sessionId, floorId: s.floorId, agentId: s.agentId, engine, cwd: s.cwd, startedAt, ...(s.bridge ? { execution: s.bridge.binding, bridgeRunId: s.bridge.runId } : {}) },
        engine,
        pty,
        key,
        state: 'idle',
        carry: '',
        buffer: [],
        sizes: [],
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
        out[c.info.sessionId] = stateNow(c)
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
      // The size the replay was drawn for comes first, so the page can lay its screen out before it paints it.
      viewer.send({ t: 'size', cols: c.size.cols, rows: c.size.rows })
      // o178e: the replay goes as one message per run of equal size, oldest first (the last run is at the size the terminal has now), each saying the
      // size the terminal had while it printed it, so the page can lay each stretch out as it was. A replay with no sizes (the chat host's) goes as it is.
      const sameSize = (a: { cols: number; rows: number } | null, b: { cols: number; rows: number } | null) => a === b || (!!a && !!b && a.cols === b.cols && a.rows === b.rows)
      let run: { d: string; size: { cols: number; rows: number } | null } | null = null
      const sendRun = (r: NonNullable<typeof run>) => viewer.send(r.size ? { t: 'out', d: r.d, size: { cols: r.size.cols, rows: r.size.rows } } : { t: 'out', d: r.d })
      for (let i = 0; i < c.buffer.length; i++) {
        const size = c.sizes[i] ?? null
        if (run && sameSize(run.size, size)) run.d += c.buffer[i]
        else {
          if (run) sendRun(run)
          run = { d: c.buffer[i], size }
        }
      }
      if (run) sendRun(run)
      return () => {
        c.viewers.delete(viewer)
        c.lastSeen = Date.now()
      }
    },

    input(id, data) {
      const c = chats.get(id)
      if (!c) return false
      c.lastSeen = Date.now()
      c.inputEpoch = (c.inputEpoch ?? 0) + 1
      c.typedAt = Date.now()
      c.lastInput = { at: c.typedAt, kind: inputKind(data), via: 'page' }
      const ok = write(c, data)
      c.mirror?.poke()
      return ok
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
        return
      }
      // Every viewer is told what the terminal really is now, so one that did not ask for this size does not draw a 178-column screen in
      // 51 columns. Sent before the redraw the new size makes. A size message is no keystroke: it never touches `inputEpoch`, so a send
      // in flight is not aborted by it (the sender reads `c.screen`, which was resized together with the pty just above).
      for (const v of c.viewers) {
        try {
          v.send({ t: 'size', cols: w, rows: h })
        } catch {
          // That page is gone; its detach follows.
        }
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

    draftView(id) {
      const c = chats.get(id)
      return c && !c.exited ? draftViewOf(c, draftReading(c)) : null
    },

    async clearDraft(id) {
      const c = chats.get(id)
      const view = (): DraftView | null => (c && !c.exited ? draftViewOf(c, draftReading(c)) : null)
      if (!c || c.exited) return { result: 'gone', draft: null }
      if (c.engine !== 'claude' || c.info.execution) return { result: 'unsupported', draft: view() }
      // Never while a send or a paste of ours is in flight, and never at a question: Ctrl+U there would edit or answer something else.
      if (c.delivering || c.pasteChain || (c.pastingUntil ?? 0) > Date.now()) return { result: 'busy', draft: view() }
      if (menuOnScreen(c) || dialogAbove(c)) return { result: 'menu', draft: view() }
      if (!draftOnScreen(c)) return { result: 'nothing', draft: view() }
      // Ctrl+U (kills to the line start) and Ctrl+K (to its end), one after the other, until the line reads clear: Claude Code 2.1.322 takes a
      // line break with each, so a run of them empties a long or multi-line draft. Never Esc and never Ctrl+C. A chip takes Backspace.
      const keys = ['\x15', '\x0b', '\x15', '\x0b', '\x15', '\x0b', '\x7f', '\x15', '\x0b', '\x7f']
      let cleared = false
      for (const key of keys) {
        if (c.exited) return { result: 'gone', draft: null }
        if (c.delivering) return { result: 'busy', draft: view() }
        c.inputEpoch = (c.inputEpoch ?? 0) + 1
        c.typedAt = Date.now()
        write(c, key)
        c.mirror?.poke()
        await new Promise<void>(resolve => setTimeout(resolve, DRAFT_RECHECK_MS))
        if (!draftOnScreen(c)) { cleared = true; break }
      }
      log?.info(`chat ${c.info.sessionId.slice(0, 8)}: the input line was cleared from the page (${cleared ? 'now empty' : 'some text is left'})`)
      return { result: cleared ? 'cleared' : 'partly', draft: view() }
    },

    asking(id) {
      const c = chats.get(id)
      if (!c || c.exited) return false
      // Stage 1 (o400b): in the simple layer a Claude chat is asking when its transcript has a question open, never by its screen.
      const s = claudeState(c)
      return s ? s === 'question' : blocked(c)
    },

    type(id, text, opt) {
      const c = chats.get(id)
      if (!c || c.exited) return false
      if (opt?.refuseDraft && draftOnScreen(c)) return false
      return paste(c, text)
    },

    async deliver(id, text, opt) {
      const c = chats.get(id)
      if (!c || c.exited) return 'gone'
      // Stage 1 (oad50): the simple send for a Claude chat, unless "Old way" is on. Nothing before it refuses on what the screen shows.
      // Only where Agent 12's transcript reader runs: a Claude chat that is not Codex-in-Claude (c.info.execution). Everything else keeps the checked path.
      if (simpleLayerFor(c.info, oldWay())) {
        // o0122: the live mirror types nothing into a chat that sends the simple way (mirrorOf), but text it typed before (this PC was in the
        // Old way until a moment ago) is taken out first: one Enter must never send it with the message. Only the mirror's own text, as the
        // Old way does, after any edit of its own still on its way (takeOut waits for it: a Send right after the last key found the mirror
        // still reading its text back); text that is not the mirror's stays ('foreign'); nothing is typed back (the chat box still holds his
        // words). Not taken out: refused, and nothing of the message is typed.
        const m = c.mirror
        if (m) {
          const out = await m.takeOut(opt?.human === true)
          if (out === 'typing' || out === 'failed') { opt?.onBlocked?.('draft'); return 'blocked' }
          if (c.exited) return 'gone'
        }
        return simpleSend(c, text, opt)
      }
      const refuse = (reason: DeliveryBlockReason): SendResult => { opt?.onBlocked?.(reason); return 'blocked' }
      if (blocked(c)) return refuse('menu')
      if (c.engine === 'codex') {
        // Never repaste after an uncertain receipt. The one owned transaction may still drain.
        if (c.codexSending) return refuse('unresolved-send')
        const sending = sendCodex(c, text, opt)
        if (opt?.waitForOutcome) return sending
        let timer: ReturnType<typeof setTimeout> | undefined
        try { return await Promise.race([sending, new Promise<SendResult>(resolve => { timer = setTimeout(() => resolve('unconfirmed'), 18_000) })]) }
        finally { clearTimeout(timer) }
      }
      if (c.delivering) return refuse('unresolved-send')
      // F-193: his own Send never presses Enter into a dialog drawn above the box (Enter there would choose in it).
      if (opt?.human === true && dialogAbove(c)) return refuse('menu')
      // F-193: his own Send when the line already holds exactly his words (the live mirror typed them, or he did there): Enter only. The
      // mirror's own older text is taken out first (for another agent's message only when he has not typed for 20 s). Else as before.
      const m = c.mirror
      const preTyped = opt?.human === true && !!m && m.holds(text)
      const takeOut = !preTyped && !!m && m.owned()
      if (takeOut && opt?.human !== true && m!.typing()) return refuse('draft')
      if (!preTyped && !takeOut) {
        const first = draftReading(c)
        if (isDraftKind(first.kind)) {
          // o4743: a refusal needs the same answer twice (a read in the middle of a redraw is not a draft), and it says in the log what the line held
          // (a kind and counts, never the words).
          const held = await draftHolds(c)
          if (c.exited) return 'gone'
          if (held) {
            log?.info(`chat ${c.info.sessionId.slice(0, 8)}: send refused, the input line holds ${held.kind} (${held.text.length} characters, ${held.rows} rows)`)
            return refuse('draft')
          }
          // The second look found the line clear: nothing else may have started a send meanwhile.
          if (c.delivering) return refuse('unresolved-send')
          if (blocked(c)) return refuse('menu')
        }
      }
      const epoch = c.inputEpoch ?? 0
      const pasted = text.split(PASTE_END).join('')
      const sending = (async (): Promise<SendResult> => {
        const began = Date.now(), deadline = began + (o.codexSend?.timeoutMs ?? 96_000)
        const interruptCause = () => (c.inputEpoch ?? 0) !== epoch ? 'terminal-input' as const : 'guard-revoked' as const
        if (takeOut) {
          const out = await m!.takeOut(opt?.human === true)
          // Nothing of the message is typed yet: a refusal, safe to send again.
          if (out !== 'taken' && out !== 'none') { opt?.onBlocked?.('draft'); return 'blocked' }
        }
        while (opt?.waitUntilReady && boxComposer(c.screen.lines(), c.screen.typedLines()) === null && !blocked(c) && Date.now() < deadline) {
          if (c.exited) return 'gone'
          // Nothing of the message is typed yet: a refusal, safe to send again, not an unconfirmed send.
          if ((c.inputEpoch ?? 0) !== epoch || opt.guard?.() === false) { opt.onBlocked?.('input-changed'); reportBefore(opt, began, interruptCause()); return 'blocked' }
          await new Promise<void>(resolve => setTimeout(resolve, 100))
        }
        if (opt?.guard?.() === false) { opt.onBlocked?.('input-changed'); return 'blocked' }
        // 12 Nov (o1bfb): the wait for a readable box has its own budget. When it ran out, nothing was typed and the box was never readable:
        // that is "composer-unavailable", not a preflight failure (the send itself used to start with no budget left and say so).
        if (opt?.waitUntilReady && !blocked(c) && boxComposer(c.screen.lines(), c.screen.typedLines()) === null) {
          opt.onBlocked?.('composer-unavailable'); reportBefore(opt, began, 'screen-unreadable'); return 'blocked'
        }
        const sendStart = Date.now()
        // The send after a ready box gets at least half its budget, so a long wait can never leave it with none.
        const sendBudget = Math.max(deadline - Date.now(), (o.codexSend?.timeoutMs ?? 96_000) / 2)
        // o655f (Stage 1): claude's own word that it took exactly this text (its UserPromptSubmit hook, noted by promptSeen) since this send began.
        const tookIt = () => promptTook(c.seen, pasted, began)
        const result = await sendToCodex({
          confirmed: tookIt,
          write: data => data !== PASTE_END && ((c.inputEpoch ?? 0) !== epoch || opt?.guard?.() === false) ? false : write(c, data),
          lines: () => {
            if (c.exited) throw Error('gone')
            if (blocked(c)) return ['\u203a 1. Permission', 'Enter to confirm']
            const box = boxComposer(c.screen.lines(), c.screen.typedLines())
            return box === null ? [] : ['\u203a ' + box, ' GPT-CLAUDE']
          },
          // This is a parsed Claude frame, not native Codex output. Re-reading
          // its message text as Codex menu prose would reject quoted footers.
          // A long paste is shown as a chip: owned only when it is exactly OUR chip (claude-paste.ts); anything else stays foreign.
          frame: lines => {
            const box = lines.length === 2 && lines[1] === ' GPT-CLAUDE' ? lines[0].slice(2) : null
            return {
              menu: lines.length > 0 && lines[1] !== ' GPT-CLAUDE',
              composer: box === null ? null : { text: box, collapsed: isOwnedClaudeChip(box, pasted) },
            }
          },
          sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
          interrupted: () => (c.inputEpoch ?? 0) !== epoch || opt?.guard?.() === false,
          interruptCause,
          gone: () => c.exited,
          beforeInput: opt?.authorize,
          onBlocked: opt?.onBlocked,
          report: r => offsetReport(opt, r, sendStart - began),
        }, text, { settleMs: 300, checkMs: 150, ...o.codexSend, timeoutMs: sendBudget, preTyped })
        // An unconfirmed end may only be a hook still on its way (it lands within about 110 ms of the Enter): a short grace before giving up.
        // (Only for a chat whose hook has already spoken once: for one that never reports, waiting would only slow the old answer down.)
        if (result !== 'unconfirmed' || !c.seen) return result
        for (let waited = 0; waited < 700; waited += 100) {
          if (tookIt()) return 'sent'
          await new Promise<void>(resolve => setTimeout(resolve, 100))
        }
        return tookIt() ? 'sent' : result
      })().catch(() => 'unconfirmed' as const)
      c.delivering = sending
      void sending.finally(() => { if (c.delivering === sending) c.delivering = undefined })
      // o4743: when a send does not end as sent, the log says what the input line held and what the last terminal input was (kinds and counts only,
      // never any words): it is how a false unconfirmed is explained afterwards (20:13 and 21:36 on 11 Nov: both messages had reached Claude).
      void sending.then(r => {
        if (r === 'sent' || c.exited) return
        const line = draftReading(c), last = c.lastInput
        log?.info(`chat ${c.info.sessionId.slice(0, 8)}: send ended ${r}: the input line holds ${line.kind} (${line.text.length || line.ignored.length} characters, ${line.rows} rows); last terminal input ${last ? `${Date.now() - last.at} ms ago: ${last.kind} from ${last.via === 'page' ? 'a page terminal' : 'the app'}` : 'none'}`)
      })
      // F-193: the live mirror learns what was submitted (his own send: never typed back; another message: the mirror's text goes back in).
      if (m) void sending.then(r => m.delivered(r === 'sent' ? text : null, opt?.human === true))
      if (opt?.waitForOutcome) return sending
      let timer: ReturnType<typeof setTimeout> | undefined
      try { return await Promise.race([sending, new Promise<SendResult>(resolve => { timer = setTimeout(() => resolve('unconfirmed'), 18_000) })]) }
      finally { clearTimeout(timer) }
    },

    generation(id) {
      const c = chats.get(id)
      if (!c || c.exited) return null
      return c.generation ??= randomBytes(16).toString('hex')
    },

    typeWhenReady,

    waiting(id, text) {
      const list = waitingTexts.get(id) ?? []
      return text === undefined ? list.length : list.filter(t => t === text).length
    },

    screenState(id) {
      const c = chats.get(id)
      if (!c || c.exited) return null
      settle(c)
      return c.state
    },

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
        info: { sessionId: a.sessionId, floorId: a.floorId, agentId: a.agentId, engine: a.engine === 'codex' ? 'codex' : 'claude', cwd: a.cwd, startedAt: a.startedAt, ...(a.execution ? { execution: a.execution, bridgeRunId: a.bridgeRunId } : {}) },
        engine: a.engine === 'codex' ? 'codex' : 'claude',
        pty,
        key: a.key,
        state: 'idle',
        carry: '',
        buffer: replay ? [replay] : [],
        sizes: replay ? [null] : [],
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
      return { state: stateNow(c), startedAt: c.info.startedAt, lastOutputAt: c.lastOutputAt, lastActiveAt: Math.max(c.lastActive, c.lastSeen), background: backgroundOf(c) }
    },

    press(id, data) {
      const c = chats.get(id)
      if (!c || c.exited) return false
      c.inputEpoch = (c.inputEpoch ?? 0) + 1
      c.typedAt = Date.now()
      c.lastInput = { at: c.typedAt, kind: inputKind(data), via: 'app' }
      const ok = write(c, data)
      c.mirror?.poke()
      return ok
    },

    promptSeen(id, text, length, promptId, claudeSessionId) {
      const c = chats.get(id)
      if (!c || c.exited) return
      // claude's own session id comes with every prompt: when it is not the chat's, a /clear or /resume moved the conversation to a new file.
      if (typeof claudeSessionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claudeSessionId)) {
        const next = claudeSessionId === c.info.sessionId ? undefined : claudeSessionId
        if (next !== c.claudeSid) {
          c.claudeSid = next
          log?.info(`chat ${id.slice(0, 8)}: claude is on ${next ? `a new session (${next.slice(0, 8)})` : "the chat's own session"} now`)
          changed()
        }
      }
      ;(c.seen ??= []).push({ norm: squashPrompt(text, length > text.length), cut: length > text.length, id: promptId, at: Date.now() })
      if (c.seen.length > 30) c.seen.shift()
    },

    promptTaken(id, text, since) {
      const c = chats.get(id)
      if (!c || c.exited || !c.seen) return null
      return promptTook(c.seen, text, since)
    },

    claudeSession(id) {
      const c = chats.get(id)
      return c && !c.exited ? c.claudeSid ?? null : null
    },

    draftMirror(id, client) {
      const c = chats.get(id)
      if (!c || c.exited) return null
      const m = mirrorOf(c)
      const detach = m.attach(client)
      return { set: (seq, text, base, seal) => m.set(client, seq, text, base, seal), detach }
    },

    mirrorTakeOut(id) {
      const c = chats.get(id)
      return c && !c.exited && c.mirror ? c.mirror.takeOut() : Promise.resolve('none' as const)
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
