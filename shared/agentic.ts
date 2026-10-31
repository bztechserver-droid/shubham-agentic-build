// F-018: the Agentic Workflow section, as agentic-claude-manager has it (its default mode).
// The contract between the agent (agent/agentic/) and the app (src/agentic/). Types only, so
// both sides can import it. Served under `${AGENT_API_PREFIX}${AGENTIC_PREFIX}` on the
// agent's local API: the app's routes with x-sad-token like the rest of the API, and the
// tools Claude chats call (`/agentic/mcp/...`) with the chat's own key instead.

export const AGENTIC_PREFIX = '/agentic'

/**
 * F-020: Dev's agent leaves this section off (the build runs the floors and their chats; Dev is
 * where the page is changed), and every /agentic route answers this status. `--agents` turns it on.
 */
export const AGENTS_OFF_STATUS = 503

/** The models an agent can be pinned to; '' lets the claude CLI choose. */
export const AGENT_MODELS = ['', 'opus', 'sonnet', 'haiku'] as const
export type AgentModel = (typeof AGENT_MODELS)[number]

/** At most this many agents on one floor (agentic-claude-manager's limit). */
export const MAX_AGENTS_PER_FLOOR = 24
/** A floor's preamble, given to every chat on it before the agent's own brief. */
export const FLOOR_PREAMBLE_MAX = 8000
/** An agent's brief (its system prompt). */
export const AGENT_BRIEF_MAX = 20_000

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
  model: AgentModel
  /** Skills and MCP servers it was given; named in its brief (advisory, as in the original). */
  skills: string[]
  mcpServers: string[]
  /** Where its desk sits on the Design chart. */
  x: number
  y: number
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
  /** A member: whether its hub can be reached now. Without it, floors are read-only and no chat can start. */
  reachable: boolean
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
}

/** POST /agentic/floors/:id/agents (the sidebar's Add agent, and agent_hire). */
export interface NewAgent {
  name?: string
  role?: string
  md?: string
  /** Its manager, by id or name; the boss when left out. */
  reportsTo?: string
  model?: AgentModel
}

/** POST /agentic/floors/:id/agents/:agentId/chat: its chat is running (started or resumed if it wasn't). */
export interface ChatOpened {
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
}

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
