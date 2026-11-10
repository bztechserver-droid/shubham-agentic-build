// F-050: the chat view's contract. A chat is claude's TUI in a pseudo-terminal; its conversation
// is claude's JSONL. agent/agentic/chatview.ts turns the tail of that file into the items below
// and follows it as it grows; src/chat/ draws them as a messaging app. Types only, so both sides
// can import it. Served under `${AGENT_API_PREFIX}${AGENTIC_PREFIX}` like the rest of the Agents
// section: the WebSocket `/chat?session=<id>`, `GET /floors/:f/agents/:a/chat`, `POST
// /floors/:f/agents/:a/say` and `GET /previews`.

/** How many messages (not tool calls) the first answer and a history page hold. */
import type { ChatAttachment } from './attachments.ts'
import type { DeliveryBlockReason } from './delivery-reason.ts'

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
  /** F-069: the files sent with it (a photo, a pasted picture, any file), named as the agent keeps them. */
  attachments?: ChatAttachment[]
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

/**
 * A question claude is waiting on, read off its screen (agent/agentic/screen.ts): its numbered
 * options. The conversation file doesn't have it while it waits (claude writes a tool call and
 * its answer together, once it has one). A number typed into the chat answers it.
 */
export interface ChatMenu {
  /** The chip above the question ("Color"), when there is one. */
  header: string
  question: string
  options: { n: number; label: string; description: string; selected: boolean }[]
  /** Its footer line ("Enter to select · ↑/↓ to navigate · Esc to cancel"). */
  hint: string
  /** Boxes to tick, not one to pick: answered in the terminal. */
  multi: boolean
}

/** What claude says it is doing while it works ("Pollinating… (5s · ↓ 167 tokens)"). */
export interface ChatStatus {
  text: string
  secs: number | null
  tokens: string | null
}

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
  /** A question is up on claude's screen (or none is any more). Only for a chat running on the PC that serves the socket. */
  | { t: 'menu'; menu: ChatMenu | null }
  /** What claude is doing now, from its spinner line (null: nothing to say). */
  | { t: 'status'; status: ChatStatus | null }

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
  /** Stable across double taps, observation retries and reconnects. Never replace after uncertainty. */
  messageId?: string
  /** The binding shown when composing; null means the agent did not yet have a conversation. */
  expectedSessionId?: string | null
}

export type DeliveryState = 'pending' | 'sent' | 'blocked' | 'unconfirmed' | 'gone'
/** Sent means native submission/queue acknowledgement, not a completed model response. */
export interface DeliveryReceipt {
  id: string
  state: DeliveryState
  sessionId: string | null
  /** Opaque runtime incarnation, never a native session pointer or credential. */
  generation: string | null
  started: boolean
  updatedAt: string
  /** Stable pre-input refusal code; never message text or private proof details. */
  reason?: DeliveryBlockReason
  targetPcName?: string
}
/** GET /floors/:f/agents/:a/deliveries/:messageId, with the same typing ACL and original actor. */
export interface DeliveryAnswer { receipt: DeliveryReceipt }
/** GET /floors/:f/agents/:a/deliveries before sending to a possibly older hub. */
export interface DeliveryCapabilities { version: 1; idempotent: true; expectedSessionId: true; receipts: true }

/**
 * POST /floors/:f/agents/:a/say-direct (Settings > Chats > "Send without a delivery check", default off): the OLD way, one
 * paste and one Enter into a running native Claude chat, no receipt, no fence, no confirmation. `sent: true` only means the
 * terminal took the keystrokes. A refusal is a 409 with a `code`; nothing is retried by either side.
 */
export interface SayDirectAnswer { ok: true; sent: true }

export interface SayAnswer {
  ok: true
  /** The chat wasn't running: it was started (or resumed) before accepting the message. */
  started: boolean
  receipt?: DeliveryReceipt
}
