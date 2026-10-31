// F-018: the Agentic Workflow section, as agentic-claude-manager has it (its default mode).
// The contract between the agent (agent/agentic/) and the app (src/agentic/). Types only, so
// both sides can import it. Served under `${AGENT_API_PREFIX}${AGENTIC_PREFIX}` on the
// agent's local API: the app's routes with x-sad-token like the rest of the API, and the
// tools Claude chats call (`/agentic/mcp/...`) with the chat's own key instead.

export const AGENTIC_PREFIX = '/agentic'

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
  /** The folder its chats work in. Null: the default (Documents\shubham-agentic). */
  codeDir: string | null
  createdAt: string
  updatedAt: string
  agents: FloorAgent[]
}

/** What a live chat is doing, read off its own terminal (the original's turn state). */
export type ChatState = 'running' | 'question' | 'idle'

/** GET /agentic/floors */
export interface FloorsAnswer {
  floors: Floor[]
  /** Live chats by session id; a session not here has no running claude. */
  live: Record<string, ChatState>
  /** The folder a floor without its own works in. */
  defaultCodeDir: string
}

/** PATCH /agentic/floors/:id. `agents` replaces the whole list; session bindings are kept by the agent. */
export interface FloorPatch {
  name?: string
  globalPrompt?: string
  /** '' or null: back to the default folder. */
  codeDir?: string | null
  agents?: FloorAgent[]
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

/** The terminal WebSocket at `${AGENT_API_PREFIX}/agentic/terminal?session=<id>`, as text frames. */
export type TerminalClientMessage =
  | { t: 'in'; d: string }
  | { t: 'size'; cols: number; rows: number }

export type TerminalServerMessage =
  /** What the terminal printed; the first one replays its recent screen. */
  | { t: 'out'; d: string }
  /** The claude process ended. */
  | { t: 'exit'; code: number | null }
