// F-050: the chat view's contract. A chat is claude's TUI in a pseudo-terminal; its conversation
// is claude's JSONL. agent/agentic/chatview.ts turns the tail of that file into the items below
// and follows it as it grows; src/chat/ draws them as a messaging app. Types only, so both sides
// can import it. Served under `${AGENT_API_PREFIX}${AGENTIC_PREFIX}` like the rest of the Agents
// section: the WebSocket `/chat?session=<id>`, `GET /floors/:f/agents/:a/chat`, `POST
// /floors/:f/agents/:a/say` and `GET /previews`.

/** How many messages (not tool calls) the first answer and a history page hold. */
export const CHAT_WINDOW_MESSAGES = 40

/** Who sent a message that is not the person: a sibling chat, as `[message from Lead on Final, chat e7d3dd12]` says. */
export interface ChatSender {
  name: string | null
  floor: string | null
  /** The first 8 characters of its chat id. */
  chat: string | null
}

interface ChatItemBase {
  /** Stable across reads: claude's own row id (and part), or the tool call's id. */
  id: string
  /** When claude wrote it (ISO), if the row says. */
  at: string | null
}

/** The person (or a sibling chat) said it. `command`: a slash command or a `!` shell line, not prose. */
export interface ChatUserItem extends ChatItemBase {
  kind: 'user'
  text: string
  from: ChatSender | null
  command: boolean
}

/** The agent said it (markdown). `error`: claude's own error line (a rate limit, say), not the model. */
export interface ChatAssistantItem extends ChatItemBase {
  kind: 'assistant'
  text: string
  error: boolean
}

/** One question of claude's AskUserQuestion tool. */
export interface ChatAsk {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string }[]
}

/** A tool call: its name, what it was asked, and (once it is back) what it answered. */
export interface ChatToolItem extends ChatItemBase {
  kind: 'tool'
  /** The raw tool name (`mcp__shubham-agentic__list_chats`). */
  name: string
  /** What the page shows: `list_chats`. */
  label: string
  /** One line: the command, the file, the pattern. */
  summary: string
  /** More of the input, for when it is opened. */
  detail: string
  status: 'running' | 'done' | 'error'
  /** Its answer, cut short (`more`: it was longer). */
  output: string
  more: boolean
  /** AskUserQuestion: the questions and their options. */
  ask: ChatAsk[] | null
}

/** A line that is neither side talking: an interrupt, a compaction, a command's output. */
export interface ChatNoticeItem extends ChatItemBase {
  kind: 'notice'
  text: string
  tone: 'info' | 'error' | 'stop' | 'compact'
}

export type ChatItem = ChatUserItem | ChatAssistantItem | ChatToolItem | ChatNoticeItem

/** What changes on an item already sent: a tool call's answer arriving. */
export type ChatPatch = Partial<Pick<ChatToolItem, 'status' | 'output' | 'more'>>

/** The chat WebSocket, server to page, as text frames. */
export type ChatFeedMessage =
  /**
   * First: the last messages, the file's size at that moment, and where older ones end (null:
   * this is the start of the conversation). It comes again when the file was replaced or cut (a
   * take-over swapped in another copy): what the page has is then all replaced by it.
   */
  | { t: 'hello'; sessionId: string; items: ChatItem[]; before: number | null; size: number }
  /** Then, as the file grows: new items, in order. */
  | { t: 'add'; items: ChatItem[] }
  /** A tool call answered. */
  | { t: 'patch'; id: string; patch: ChatPatch }

/** GET /floors/:f/agents/:a/chat?before=<offset>&limit=<n>: an older page. */
export interface ChatHistory {
  items: ChatItem[]
  before: number | null
}

/** GET /previews: the last thing said in each agent's conversation (the list's second line). */
export interface ChatPreview {
  sessionId: string
  at: string | null
  /** Who spoke last. */
  role: 'user' | 'assistant'
  /** One line, cut short. */
  text: string
  /** The sibling chat that said it, when one did. */
  from: string | null
  /** The conversation file's size and time: they change when it grows. */
  bytes: number
  mtime: string
}

export interface PreviewsAnswer {
  /** By agent id. */
  previews: Record<string, ChatPreview>
}

/** POST /floors/:f/agents/:a/say */
export interface SayRequest {
  text: string
}

export interface SayAnswer {
  ok: true
  /** The chat wasn't running: it was started (or resumed) and the message is typed once it is ready. */
  started: boolean
}
