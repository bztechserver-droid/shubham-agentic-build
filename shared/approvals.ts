import type { ChatMenu } from './chat.ts'
import type { ChatState } from './agentic.ts'

// F-076: answering a chat that waits at a prompt, and saying something as the person, from one place (the
// overlay). Both are HUMAN-ONLY: the page's handlers need a real tap (isTrusted) and the controls carry
// `data-human-only`, which the assistant's screen control refuses; the routes take only the page's own
// requests (never a chat's key) and no MCP tool answers a prompt or sends as the person. Every answer and
// every send is logged. Types only.

/** The attribute on every control that only a person's own tap may use. */
export const HUMAN_ONLY_ATTR = 'data-human-only'

/** A chat waiting at a prompt, as the person is shown it. */
export interface ApprovalItem {
  sessionId: string
  floorId: string
  floorName: string
  agentId: string
  agentName: string
  /** The PC it runs on. */
  pc: string
  state: ChatState
  /** The numbered question on its screen; null when the prompt is not one (a text question, a plain wait). */
  menu: ChatMenu | null
  /** What its screen said above the options: the command, the file, the tool, as claude drew it. */
  context: string
  /** What the prompt is, as a hash: an answer names it, and is refused when the prompt has since changed. */
  id: string
  /** Buttons can answer it (a numbered choice to pick one of); otherwise it is answered in the chat. */
  answerable: boolean
}

/** A card the assistant prepared: a target and the words proposed. Only the person's tap sends it. */
export interface PreparedCard {
  id: string
  floorId: string
  floorName: string
  agentId: string
  agentName: string
  text: string
  /** Why the assistant proposes it, in a line. */
  why: string
  at: string
}

/** GET /agentic/approvals */
export interface ApprovalsAnswer {
  items: ApprovalItem[]
  prepared: PreparedCard[]
}

/** POST /agentic/approvals/answer: the option `n` of the prompt `id` in that chat. */
export interface AnswerRequest {
  sessionId: string
  id: string
  n: number
}

/** POST /agentic/send-as-me: his words, typed into the chat as plain input. */
export interface SendAsMeRequest {
  floorId: string
  agentId: string
  text: string
  /** The prepared card this came from (it is dropped once sent). */
  card?: string
}

export interface ApprovalLogEntry {
  at: string
  kind: 'answer' | 'send'
  floor: string
  agent: string
  pc: string
  sessionId: string
  /** What was asked and chosen ("Do you want to proceed? → 1. Yes"), or the words sent. */
  detail: string
  /** Who asked: the app and the device it was opened on. */
  by: string
}
