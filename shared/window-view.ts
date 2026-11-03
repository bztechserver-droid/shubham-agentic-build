// F-092: what an Agents window shows for its agent: the chat (the WhatsApp-style view of /chats) or the terminal. Pure, so the rules
// are tested. Shubham's answer: the chat view is the default, with a toggle to the terminal in each window; Settings brings the
// old way (the terminal) back as the default.

export type WindowView = 'chat' | 'terminal'
/** What an agent's window opens in until it is switched: Settings › Chats. */
export type OpenIn = WindowView
export const DEFAULT_OPEN_IN: OpenIn = 'chat'

export const parseOpenIn = (raw: unknown): OpenIn => (raw === 'terminal' ? 'terminal' : DEFAULT_OPEN_IN)

/** The remembered choices, by agent id: anything that is not 'chat' or 'terminal' is dropped. */
export function parseViews(raw: unknown): Record<string, WindowView> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, WindowView> = {}
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) if (v === 'chat' || v === 'terminal') out[id] = v
  return out
}

/** The view of an agent's window: its own remembered choice, else what windows open in. */
export const viewOf = (views: Record<string, WindowView>, agentId: string | null, openIn: OpenIn): WindowView => (agentId !== null && views[agentId]) || openIn

/** The other one. */
export const otherView = (v: WindowView): WindowView => (v === 'chat' ? 'terminal' : 'chat')

/** Forgets agents that are gone, so the memory does not grow for ever. */
export function pruneViews(views: Record<string, WindowView>, agentIds: ReadonlySet<string>): Record<string, WindowView> {
  const out: Record<string, WindowView> = {}
  for (const [id, v] of Object.entries(views)) if (agentIds.has(id)) out[id] = v
  return out
}
