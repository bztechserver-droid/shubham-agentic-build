// F-018: the tools every agent's chat gets (agentic-claude-manager server/lib/toolCatalog.js,
// the orchestration part), served to claude by mcp-shim.ts and carried out by tool-calls.ts.
// Who is calling is never an argument: it is the chat whose key came with the call.

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const none = { type: 'object', properties: {}, additionalProperties: false }

export const TOOLS: ToolDef[] = [
  {
    name: 'list_chats',
    description:
      'List the OTHER live Claude chats on your floor right now — one per agent whose chat is running. Use this first whenever the user refers to "the other chat", "the other agent", or you need to coordinate work across chats. Returns each one\'s sessionId, agent name, role and what it is doing (working, asking, idle). Agents whose chat is not running are not here: use floor_roster for everyone.',
    inputSchema: none,
  },
  {
    name: 'floor_roster',
    description:
      'The roster of YOUR floor: every agent on it, and whether each one is online (its chat is running), offline (opened before, not running now), or never opened. Use this — not list_chats — to answer "how many agents do I have" or "who is on my floor": list_chats only sees chats that are live right now. Returns totals plus a row per agent.',
    inputSchema: none,
  },
  {
    name: 'read_chat',
    description:
      "Read the recent terminal output of another chat on your floor (what it is doing or saying right now). Use after list_chats to check on another agent's progress. Returns the last N lines, ANSI-stripped.",
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The session id from list_chats.' },
        lines: { type: 'number', description: 'How many trailing lines to read (default 100, max 500).' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_to_chat',
    description:
      'Type a message into another chat on your floor and submit it — that chat receives it as input and responds. Use to hand work to or ask a question of another agent. Never target your own session, and do not tell the receiving chat to broadcast (that creates loops).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The session id from list_chats.' },
        text: { type: 'string', description: 'The message to send to that chat.' },
      },
      required: ['sessionId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'broadcast_to_chats',
    description:
      'Send one message to EVERY other live chat on your floor at once (each receives it as input). Use sparingly — e.g. "stop current work", or a decision every agent must know. Never instruct recipients to broadcast back (loop risk).',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The message to send to all the other chats.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_save',
    description:
      "Save a note to your floor's SHARED MEMORY — knowledge every chat on the floor, now and later, can search, and the human reads on the floor's Memory tab. Save decisions, conventions, gotchas, hand-offs, and anything the user says to remember. Keep each note self-contained.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact, decision or note to keep (self-contained, 1-4 sentences).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase topic tags (e.g. ["auth","decision"]).' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    description:
      "Search your floor's SHARED MEMORY — notes saved by any chat on the floor, or by the human. Use before starting work on a topic, and whenever the user asks \"did we decide X\" or another chat may know.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for.' },
        limit: { type: 'number', description: 'Max results (default 10).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_recent',
    description: "The most recent notes in your floor's SHARED MEMORY — what the other chats learned or decided lately. Useful at the start of a task to pick up where they left off.",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max entries (default 10).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'agent_hire',
    description:
      "Create a NEW AGENT on your floor, reporting to you. BOSS ONLY. Use it when the work in front of you needs an owner that does not exist yet — a reviewer, a migration specialist, somebody to own one subsystem. The `md` you write IS that agent's brief: it is what the agent is told about itself when its chat starts, so write what it owns, what it must not touch, and how it should report back. Hire deliberately, one at a time, for work you are about to give it. Names must be unique on the floor. No chat is started: the human opens it from the floor.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique on this floor. A person\'s name or a role name, e.g. "Priya" or "Migration".' },
        role: { type: 'string', description: 'Short title shown under the name on the floor, e.g. "Reviewer".' },
        md: { type: 'string', description: "The agent's brief in markdown — what it owns, its boundaries, how to report back. This becomes its system prompt." },
        reportsTo: { type: 'string', description: 'Name of the agent it reports to. Defaults to you.' },
        model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'], description: 'Optional model to pin it to. Omit to inherit.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
]
