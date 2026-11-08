// F-134: Codex as a second engine for agents' chats. The contract between the agent and the page (and its tests); the CRM side is
// sam-crm-be controller/codexSubscriptionsController.js. Names, numbers and plain sentences only: nothing in this file, and nothing the agent
// ever sends a page, is a token, a key or part of a login.
//
// Shubham's rule: it works exactly like Claude's. The PC is signed in with the person's CRM login (F-007); the agent gets THAT PERSON'S Codex
// login from the CRM with that session, so there is no Codex sign-in on any PC and no key typed into the app. The only one-time sign-in is the
// CRM super admin's ChatGPT login, when a subscription is added to the CRM. A login Codex refreshed goes back to the CRM with the same session.

/** What kind of credential a subscription holds: a ChatGPT login (a file the CRM keeps fresh) or an OpenAI API key (F-138: memory only, billed per use). */
export type CodexKind = 'chatgpt' | 'api_key'

/** Which engine runs an agent's chat. '' follows the default in Settings › Chats (Claude unless that is changed). */
export const AGENT_ENGINES = ['', 'claude', 'codex', 'opencode'] as const
export type AgentEngine = (typeof AGENT_ENGINES)[number]

/** How hard a Codex chat thinks (model_reasoning_effort); '' leaves it to Codex. The installed CLI has the last word. */
export const CODEX_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type CodexEffort = (typeof CODEX_EFFORTS)[number]

/** A Codex model name is free text ('' = Codex's own default); the page offers these as suggestions only. */
export const CODEX_MODEL_MAX = 80

/** Why Codex can't run (or 'ok'). Also the `code` of a chat that can't start for a Codex reason. */
export type CodexState =
  | 'ok'
  /** The Codex CLI isn't installed on this PC. */
  | 'not-installed'
  /** The CRM has no Codex subscription for this person (none assigned, or switched off for them). */
  | 'no-subscription'
  /** Reserved: the person's Codex is turned off in the CRM (NO_CODEX with a decision behind it). */
  | 'turned-off'
  /** Their subscription is disabled in the CRM. */
  | 'disabled'
  /** The CRM can't be reached (and no login is held that could be used meanwhile). */
  | 'crm-offline'
  /** The CRM session ended, or the login can't be used: sign in to the CRM again / the super admin seeds it again. */
  | 'sign-in-needed'
  | 'error'

export interface CodexStatus {
  /** @deprecated Always true. Availability is determined by installation and CRM access. */
  enabled: boolean
  installed: boolean
  version: string | null
  state: CodexState
  /** A plain sentence for the page: why it can't run, or null. */
  hint: string | null
  /** The subscription the CRM put this person on, by name; never a login. */
  assigned: { name: string; kind: CodexKind; revision: number } | null
  lastFetchedAt: string | null
  lastWrittenBackAt: string | null
  /** A refreshed login that has not reached the CRM yet (kept on this PC, retried); the page can say so. */
  waitingToWriteBack: boolean
}

/** The code of a 409 when an agent's engine changes while it has a conversation. */
export const ENGINE_CHANGE_CODE = 'engine-change-new-conversation'
export const ENGINE_CHANGE_MESSAGE = 'Changing the engine carries your current conversation over to the new engine. Original sessions stay saved. If history cannot be carried over, the switch is blocked and your current conversation stays selected.'
export const ENGINE_CHANGE_FAILED_CODE = 'engine-change-conversion-failed'
export const ENGINE_CHANGE_STALE_CODE = 'engine-change-stale'
export const ENGINE_CHANGE_HOME_OFFLINE_CODE = 'engine-change-home-offline'

/** The engine an agent actually runs, given its own setting and the default. */
export function engineOf(own: AgentEngine | undefined, dflt: AgentEngine | undefined): 'claude' | 'codex' | 'opencode' {
  const e = own || dflt || ''
  return e === 'opencode' ? 'opencode' : e === 'codex' ? 'codex' : 'claude'
}
