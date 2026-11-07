// F-018: the Agentic Workflow section, as agentic-claude-manager has it (its default mode).
// The contract between the agent (agent/agentic/) and the app (src/agentic/). Types only, so
// both sides can import it. Served under `${AGENT_API_PREFIX}${AGENTIC_PREFIX}` on the
// agent's local API: the app's routes with x-sad-token like the rest of the API, and the
// tools Claude chats call (`/agentic/mcp/...`) with the chat's own key instead.

import type { AuthEnded, ChatAccess, ChatCan, ChatOwner, ChatShare } from './auth.ts'
import type { OpenCodeProvider } from './opencode.ts'
import type { AgentEngine, CodexEffort } from './codex.ts'

export const AGENTIC_PREFIX = '/agentic'

/**
 * F-020: Dev's agent leaves this section off (the build runs the floors and their chats; Dev is
 * where the page is changed), and every /agentic route answers this status. `--agents` turns it on.
 */
export const AGENTS_OFF_STATUS = 503

/** The models an agent can be pinned to; '' lets the claude CLI choose. */
export const AGENT_MODELS = ['', 'opus', 'sonnet', 'haiku'] as const
export type AgentModel = (typeof AGENT_MODELS)[number]

/** F-049: how hard an agent's chat thinks (claude --effort); '' lets the claude CLI choose. */
export const AGENT_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type AgentEffort = (typeof AGENT_EFFORTS)[number]

/**
 * F-067: whether an agent's chat runs in ultracode (claude's dynamic workflows mode, `/effort ultracode`).
 * '' follows the default in Settings (off unless it is changed there); 'on' and 'off' are the agent's own.
 */
export const AGENT_ULTRACODES = ['', 'on', 'off'] as const
export type AgentUltracode = (typeof AGENT_ULTRACODES)[number]

/** F-067: what an agent set to "Default" gets (Settings › Chats): a model, an effort ('' the CLI's own), ultracode on or off. */
export interface ChatDefaults {
  model: AgentModel
  effort: AgentEffort
  ultracode: boolean
  /** F-134: which engine an agent set to "Default" runs ('' = Claude), and the model and effort a Codex chat gets ('' = Codex's own). Absent on an older copy. */
  engine?: AgentEngine
  opencodeProvider?: OpenCodeProvider | ''
  opencodeModel?: string
  codexModel?: string
  codexEffort?: CodexEffort
}
export const NO_DEFAULTS: ChatDefaults = { model: '', effort: '', ultracode: false, engine: '', codexModel: '', codexEffort: '' }

/** At most this many agents on one floor (agentic-claude-manager's limit). */
export const MAX_AGENTS_PER_FLOOR = 24
/** A floor's preamble, given to every chat on it before the agent's own brief. */
export const FLOOR_PREAMBLE_MAX = 8000
/** An agent's brief (its system prompt). */
export const AGENT_BRIEF_MAX = 20_000

/** F-086: a job the hub gives a chat (see FloorAgent.duty); null: none. */
export type AgentDuty = 'orchestrator' | null

/**
 * F-086: is this agent the Orchestrator (the chat the Assistant hands work to; the overlay chat until now)? By its duty. Only an agent
 * with no duty field at all (made by hand, never by the hub) falls back to the old name: the agent "Assistant" on the floor "Assistant".
 */
export const isOrchestratorAgent = (floorName: string, agent: { name: string; duty?: AgentDuty }): boolean =>
  agent.duty === undefined ? floorName.trim().toLowerCase() === 'assistant' && agent.name.trim().toLowerCase() === 'assistant' : agent.duty === 'orchestrator'

/** One agent on a floor: a desk on the chart, and one Claude Code chat once it is opened. */
export interface FloorAgent {
  id: string
  name: string
  role: string
  /** The floor's one boss (the Lead a floor starts with). */
  isBoss: boolean
  /** Its manager's id: the chart's lines. Null for the boss. */
  reportsTo: string | null
  /** Its brief in markdown: what its chat is told about itself when it starts. */
  md: string
  /** Its chat, once opened: the claude session id. The one live binding. */
  sessionId: string | null
  /**
   * F-064: the PC its chat lives on, by device id: the one that started it. Every resume (any button,
   * any device, the app starting again) brings the chat back there, until it is moved with Switch
   * computer. Null: not started on a PC of the hub's yet (its next start makes that PC its home).
   * Set by the hub only, never taken from a page.
   */
  homePc: string | null
  /** F-064: that PC's name, for when it is offline and its id says nothing. */
  homePcName: string | null
  /**
   * F-086: the job the hub knows this chat by, apart from its name: 'orchestrator' is the one chat Shubham's Assistant hands
   * work to (it was the "Assistant" chat on the "Assistant" floor). Who it is no longer depends on what anyone calls it, so it
   * can be renamed. Set by the hub only (first from the old name, once), never taken from a page. The hub always sends null or
   * 'orchestrator'; undefined is only an object made by hand (a mock, a test), which is then judged by its old name.
   */
  duty?: AgentDuty
  model: AgentModel
  /** F-049: its chat starts with claude --effort this. */
  effort: AgentEffort
  /** F-067: ultracode on or off for its chat; '' follows the default (Settings › Chats). */
  ultracode: AgentUltracode
  /**
   * F-134: which engine runs its chat: '' follows the default in Settings › Chats (Claude unless that is changed). Absent on a copy that predates it.
   * With the engine 'codex' its model and effort are these two (the Claude ones above are not used).
   */
  engine?: AgentEngine
  opencodeProvider?: OpenCodeProvider | ''
  opencodeModel?: string
  codexModel?: string
  codexEffort?: CodexEffort
  /**
   * F-134: Codex chooses the id of its own conversation, so it is learnt from the rollout file once the chat has started and kept here ({@link sessionId}
   * is still the app's id of the chat). Set by the agent only, never taken from a page.
   */
  codexThread?: string | null
  opencodeSession?: string | null
  /** Skills and MCP servers it was given; named in its brief (advisory, as in the original). */
  skills: string[]
  mcpServers: string[]
  /** Where its desk sits on the Design chart. */
  x: number
  y: number
  /**
   * F-118: whose chat this is (a CRM user), set by the hub only, never taken from a page. Absent on a copy that
   * predates F-118 (the hub's one-time move gives those to sbskrrt).
   */
  owner?: ChatOwner | null
  /** F-118: who it is shared with, and how. Sent to its owner and sbskrrt only; empty for everyone else. */
  sharedWith?: ChatShare[]
  /** F-118: computed per connection (shared/auth.ts chatRights): why this viewer sees it, and what they may do. Absent when stored. */
  access?: ChatAccess
  can?: ChatCan
}

/** A floor: a team of agents, each with its own chat, working in one folder. */
export interface Floor {
  id: string
  name: string
  /** The floor preamble: "the work this floor does", before every agent's brief. */
  globalPrompt: string
  /**
   * The folder its chats work in on this PC. Null: the default (Documents\shubham-agentic).
   * F-021: the hub's own; a member's page gets its own PC's folder here (from `folders`).
   */
  codeDir: string | null
  /** F-021: the folder on each of the hub's other PCs, by device id (kept by the hub). */
  folders: Record<string, string>
  createdAt: string
  updatedAt: string
  /**
   * F-127: kept on THIS PC only, not on the Server yet: made while the Server could not be reached. It joins the Server's list by itself when the Server is
   * back (then this flag is gone). Set by the agent on a member's list, never stored.
   */
  local?: boolean
  /** F-118: who made the floor (a floor with nothing visible to a person is hidden from them, unless they made it). */
  createdBy?: ChatOwner | null
  agents: FloorAgent[]
}

/** What a live chat is doing, read off its own terminal (the original's turn state). */
export type ChatState = 'running' | 'question' | 'idle'

/**
 * F-021: one session, used from the hub's PCs in turn. A session's JSONL is copied to every one
 * of them as it grows; only one runs it at a time (two writers would fork the conversation).
 */
export interface ChatElsewhere {
  /** The PC running it (its name). */
  pc: string
  state: ChatState
}

/** F-021: where a session that is running nowhere was run last. */
export interface ChatLast {
  pc: string
  at: string
}

/** F-021: this PC among the hub's: null when it is on its own (no hub). */
export interface AgenticTeam {
  /** This PC's name. */
  pc: string
  role: 'hub' | 'member'
  /** The hub's name (a member's). */
  hub: string | null
  /** A member: whether its hub can be reached now. Without it, the Server's floors are read-only here and no Server chat can start (F-127: new chats on this PC still can, see `offline`). */
  reachable: boolean
  /** F-127, a member's: new chats on this PC while the Server can't be reached. Null on the hub and on a PC alone. */
  offline?: OfflineChats | null
  /** F-025: the PCs a chat can be run on from here now (this one first): an agent's Run on. */
  pcs: { id: string; name: string; here: boolean }[]
}

/**
 * F-127: a member PC's own floors and chats while the Server can't be reached. `on` is the per-PC setting (default on; only a signed-in sbskrrt changes it,
 * PUT /agentic/offline-chats {on}); `active` says the Server has been out of reach for 20 s and the setting is on, so new floors and chats are made here;
 * `since` is when it went (ISO). They run on THIS PC's own Claude sign-in.
 */
export interface OfflineChats {
  on: boolean
  active: boolean
  since: string | null
  hubName: string | null
}

/** F-127: what a PC's floors made while the Server was out of reach are doing now that it is back (AgenticEvent 'adopt'). */
export type AdoptState = 'idle' | 'running' | 'done' | 'failed'
export interface AdoptStatus {
  state: AdoptState
  /** Local floors still to join, floors joined, and conversations checked equal on both sides. */
  floors: number
  joined: number
  sessions: number
  /** Why it failed (the Server is older, the link dropped ...); it is tried again by itself. */
  why: string | null
}

/** GET /agentic/floors */
export interface FloorsAnswer {
  floors: Floor[]
  /** Live chats on this PC, by session id; a session not here has no running claude on this PC. */
  live: Record<string, ChatState>
  /** F-021: chats running on the hub's other PCs. */
  elsewhere: Record<string, ChatElsewhere>
  /** F-021: where sessions running nowhere were run last. */
  last: Record<string, ChatLast>
  team: AgenticTeam | null
  /** The folder a floor without its own works in. */
  defaultCodeDir: string
}

/** PATCH /agentic/floors/:id. `agents` replaces the whole list; session bindings are kept by the agent. */
export interface FloorPatch {
  name?: string
  globalPrompt?: string
  /** '' or null: back to the default folder. On a member, its own PC's folder (F-021). */
  codeDir?: string | null
  agents?: FloorAgent[]
  /** F-021, a member to its hub: that member's folder for the floor (null: the default). */
  folderFor?: { id: string; dir: string | null }
  /**
   * F-142: true when the page has shown ENGINE_CHANGE_MESSAGE and the person agreed: carry the conversation to the new engine, or start a new one if conversion fails.
   * Without it that change is refused with a 409 (code engine-change-new-conversation).
   */
  confirmNewConversation?: boolean
}

/** POST /agentic/floors/:id/agents (the sidebar's Add agent, and agent_hire). */
export interface NewAgent {
  name?: string
  role?: string
  md?: string
  /** Its manager, by id or name; the boss when left out. */
  reportsTo?: string
  model?: AgentModel
  effort?: AgentEffort
  /** F-134 */
  engine?: AgentEngine
  opencodeProvider?: OpenCodeProvider | ''
  opencodeModel?: string
  codexModel?: string
  codexEffort?: CodexEffort
}

/** POST /agentic/floors/:id/agents/:agentId/chat: its chat is running (started or resumed if it wasn't). */
export interface ChatOpened {
  /** F-064: the PC it is on, when it was started or found on another PC than this one (its home). */
  on?: string
  sessionId: string
  /** True when this call started the claude process. */
  started: boolean
  /** True when it picked up an earlier conversation (claude --resume). */
  resumed: boolean
  /** F-021: the PC it was taken over from (its chat there was stopped first). */
  tookOverFrom?: string
}

/** POST /agentic/floors/:id/agents/:agentId/chat */
export interface OpenChatRequest {
  cols?: number
  rows?: number
  /** F-021: it runs on another PC: stop it there and run it here. Without this, that is a 409. */
  takeOver?: boolean
  /**
   * F-064: start it on this PC even though its home is another (the home is offline, and Shubham
   * said to start it here instead; or the hub has already chosen this PC). Its home is not changed.
   */
  here?: boolean
  /** F-064, between PCs only: a message to type into the chat once it is up (a resume sent on to its home PC). */
  say?: string
}

/**
 * F-064: the status a resume is answered with when the chat's home PC can't be reached. The message
 * names the PC; the page offers to start the chat on this PC instead (OpenChatRequest.here).
 */
export const HOME_OFFLINE_STATUS = 424

/** GET /agentic/sessions: a Claude Code conversation on this PC, newest first (Bring in a Claude chat). */
export interface ClaudeSession {
  sessionId: string
  /** The folder it was held in; null when its file doesn't say. */
  cwd: string | null
  /** Its name as Claude Code titled it (or it was renamed), else its first prompt. */
  title: string | null
  bytes: number
  /** When it was last written to. */
  updatedAt: string
  /** It is already an agent's chat here. */
  agent: { floorId: string; floorName: string; agentId: string; name: string } | null
  /** F-022: the PC it belongs to: where it was held, or the one it was copied from. */
  pc?: string
  /** F-022, listing another PC's: this PC has a copy of it already. */
  here?: boolean
}

/** F-022: GET /agentic/sessions?pc=&q=&limit=&offset= */
export interface SessionsAnswer {
  sessions: ClaudeSession[]
  /** How many match, of which this is a page. */
  total: number
  /** The PCs whose conversations can be listed now: this one first. */
  pcs: { id: string; name: string; here: boolean }[]
}

/** F-022: copying every conversation of another PC here (GET/POST /agentic/sessions/copy-all). */
export interface CopyAllJob {
  pc: string
  state: 'running' | 'done' | 'failed'
  total: number
  done: number
  copied: number
  bytes: number
  error: string | null
  startedAt: string
}

/** POST /agentic/floors/:id/import: a copy of a conversation becomes an agent's chat. */
export interface ImportChat {
  sessionId: string
  /** F-022: the PC it is on, when not this one: it is brought here first. */
  pc?: string
  /** The agent whose chat it becomes (the chat it had stops and is let go); a new agent when left out. */
  agentId?: string
  /** A new agent's name and role. */
  name?: string
  role?: string
}

export interface ChatImported {
  floor: Floor
  agent: FloorAgent
  /** The copy's id, the agent's chat now. The original is left as it was. */
  sessionId: string
  /** Where the conversation was held: its chat opens there. */
  cwd: string
}

/** One message of a chat's transcript (the Agents tab's reader). */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: string | null
  tools: string[]
}

/** A note in a floor's shared memory (memory_save, and the Memory tab). */
export interface MemoryEntry {
  id: string
  ts: string
  text: string
  tags: string[]
  /** The chat that wrote it, when an agent did. */
  sessionId: string | null
  author: 'human' | 'agent'
  /** The agent's name, when an agent wrote it. */
  authorName: string | null
  editedAt: string | null
}

/** The page's events WebSocket at `${AGENT_API_PREFIX}/agentic/events`. */
export type AgenticEvent =
  | { t: 'floors'; floors: Floor[] }
  | { t: 'live'; live: Record<string, ChatState> }
  | { t: 'memory'; floorId: string }
  /** F-056: the task list changed (something was added, ticked, edited or deleted, by anyone): ask for it again. */
  | { t: 'tasks' }
  /** F-118: this connection's sign-in ended (or the level was raised past it); the socket closes with code 4401 right after. */
  | { t: 'auth'; ended: AuthEnded }
  /** F-127: this PC's own floors joining the Server's list. */
  | { t: 'adopt'; adopt: AdoptStatus }
  /** F-021: chats on the other PCs, where idle ones ran last, and this PC among the hub's. */
  | { t: 'where'; elsewhere: Record<string, ChatElsewhere>; last: Record<string, ChatLast>; team: AgenticTeam | null }

/** The terminal WebSocket at `${AGENT_API_PREFIX}/agentic/terminal?session=<id>`, as text frames. */
export type TerminalClientMessage =
  | { t: 'in'; d: string }
  | { t: 'size'; cols: number; rows: number }

export type TerminalServerMessage =
  /** What the terminal printed; the first one replays its recent screen. */
  | { t: 'out'; d: string }
  /** The claude process ended. */
  | { t: 'exit'; code: number | null }

// F-062: what a chat really runs on, for the three chips every chat shows (model, effort, PC).

/** What its conversation file says a chat runs on (agent/agentic/runinfo.ts), by agent id in {@link RunsAnswer}. */
export interface ChatRun {
  /** The model of its newest answer ("claude-sonnet-5-5"); null before it has answered. */
  model: string | null
  /** Its newest `/effort` in the conversation (low ... max), and when it was set. */
  effort: string | null
  effortAt: string | null
  /** The effort this PC started its running chat with ('' is the CLI's own), and when; null when it doesn't run here. */
  launchedEffort: string | null
  startedAt: string | null
  /** F-067: whether its newest `/effort ultracode` in the conversation turned ultracode on (or a `/effort <level>` or `ultracode off` turned it off), and when; null when it never said. */
  ultracode?: boolean | null
  ultracodeAt?: string | null
  /** F-067: whether this PC started its running chat in ultracode; null when it doesn't run here. */
  launchedUltracode?: boolean | null
}

/** The model a chat without a pinned one runs on, and how the agent came to know it. */
export interface DefaultModel {
  model: string
  from: 'environment' | 'settings' | 'a chat that inherited it'
}

/** GET /agentic/runs */
export interface RunsAnswer {
  runs: Record<string, ChatRun>
  defaultModel: DefaultModel | null
  /** F-067: what "Default" means for model, effort and ultracode (Settings › Chats). */
  defaults?: ChatDefaults
}

/** F-067: POST /agentic/floors/:id/agents/:agentId/tune: what to change (what is left out stays). */
export interface TuneRequest {
  model?: AgentModel
  effort?: AgentEffort
  ultracode?: AgentUltracode
  /** Codex tuning applies on the next start. */
  opencodeProvider?: OpenCodeProvider | ''
  opencodeModel?: string
  codexModel?: string
  codexEffort?: CodexEffort
}

/** F-067: what a tune did to a running chat: `now` (typed into it), or `next` (at its next start). */
export interface TuneAnswer {
  floor: Floor
  /** now: it was waiting, and the new setting was typed into it; next: it applies when the chat next starts. */
  applied: 'now' | 'next'
  /** One plain sentence saying which, and why. */
  detail: string
}
