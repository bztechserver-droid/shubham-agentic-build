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
  /** Its footer, drawn now, says "Esc to cancel": a Cancel (Esc) button can press Esc for him. On a permission prompt Esc means No. */
  cancellable?: boolean
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

/** POST /agentic/approvals/cancel: Esc into the prompt `id` of that chat (only when its footer says "Esc to cancel"). Authorized by the current CRM session and target rights. */
export interface CancelRequest {
  sessionId: string
  id: string
}

/** POST /agentic/send-as-me: his words, typed into the chat as plain input. */
export interface SendAsMeRequest {
  floorId: string
  agentId: string
  text: string
  /** The prepared card this came from (it is dropped once sent). */
  card?: string
  /** F157: stable delivery correlation ID; never mint another after an uncertain result. */
  messageId?: string
  /** The conversation binding captured when composing. Null means no existing conversation. */
  expectedSessionId?: string | null
}

/** F-081: "Apply new builds automatically when quiet" (auto-update.json on the hub; the guard applies, this agent keeps the switch). */
export interface AutoUpdateStatus {
  /** F-173a: on only with a recorded consent (`consent`); a legacy `true` without one reads as off. */
  on: boolean
  changedAt: string | null
  changedBy: string
  /** F-173a: who switched it on or off, and when: a signed-in administrator's own choice. `revision` grows with every change. */
  consent?: { by: string; personId: string | null; at: string; revision: number } | null
  /** The last automatic update (F-173a: the app's own, with its result). */
  lastApplied: { at: string; from: string; to: string; note: string } | null
  /** The last look that found it not quiet (or otherwise held off), and why. */
  lastSkipped: { at: string; why: string } | null
  /** F-173a: what the automatic update is doing now. Only the agent adds it (GET /auto-update). */
  run?: AutoUpdateRun | null
}

export interface AutoUpdateBlocker {
  /** A fixed word, for logs and tests ("chat-busy", "order-open"). */
  code: string
  /** In plain words, for the page ("Memory is working"). Never a command line, a message or a path. */
  label: string
  count?: number
}

export type AutoUpdateRunState = 'off' | 'idle' | 'waiting' | 'countdown' | 'deferred' | 'committing' | 'restarting'
export type AutoUpdateResult = 'took' | 'did-not-take' | 'unknown' | 'not-started'

export interface AutoUpdateRun {
  state: AutoUpdateRunState
  /** When this state began. */
  since: string
  /** The build it would apply. */
  to: string | null
  /** When it began waiting for a quiet moment, while it does. */
  waitingSince: string | null
  /** The cancelable countdown's end. */
  countdownEndsAt: string | null
  blockers: AutoUpdateBlocker[]
  /** What this check cannot see, said plainly. */
  cannotSee: string[]
  /** The last operation this app made and how it ended (known after the restart, by the new agent). */
  last: { id: string; from: string; to: string; committedAt: string; resolvedAt: string | null; result: AutoUpdateResult | null; actual: string | null; note: string } | null
}

export interface ApprovalLogEntry {
  at: string
  /** answer: a prompt answered; send: his words sent; device: an approval device registered or removed, or the old way switched. */
  kind: 'answer' | 'send' | 'device'
  floor: string
  agent: string
  pc: string
  sessionId: string
  /** What was asked and chosen ("Do you want to proceed? → 1. Yes"), or the words sent. */
  detail: string
  /** Who asked: the app and the device it was opened on. */
  by: string
}
