// order o831e (11 Nov): an agent's chat can be PINNED into the overlay's side pane. The pane then shows the Assistant or the pinned agent (a switcher at its top), and stays on that agent while
// he clicks about in the main area. This is the pure part: what is kept per device, which of the two the pane shows, and the one sentence for "the same chat is open in the main window".
// The browser side (storage, the hooks) is src/overlay/pane.ts; the pane is src/overlay/Panel.tsx.

/** What the pane shows: the Assistant (the overlay chat, with its Goals, Approvals and Send tabs) or the pinned agent's chat. */
export type PaneSubject = 'assistant' | 'pinned'

/** A pinned agent's id as kept in this browser: a plain non-empty string (ids are generated, never typed). Anything else is "nothing pinned". */
export function parsePinnedId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length === 0 || raw.length > 200 || [...raw].some(c => c.charCodeAt(0) < 32)) return null
  return raw
}

export const parseSubject = (raw: unknown): PaneSubject | null => (raw === 'assistant' || raw === 'pinned' ? raw : null)

/** What the pane shows now: nothing pinned always means the Assistant; with an agent pinned, what he last chose (the pinned agent is the first choice when he pins it). */
export const effectiveSubject = (pinned: string | null, chosen: PaneSubject | null): PaneSubject => (pinned === null ? 'assistant' : (chosen ?? 'pinned'))

/**
 * The same chat open in the main window AND in the pane: two boxes for one chat would fight over the draft and the send. The main window wins (he just opened it there): the pane keeps the
 * conversation to read, its box is off and this sentence says why. Null when the chat is only in the pane.
 */
export const MAIN_HAS_IT = 'This chat is open in the main window, so type there. Open another chat there and it is yours to type in here again.'
export const paneBlockedReason = (openInMain: boolean): string | null => (openInMain ? MAIN_HAS_IT : null)

/** The words on the pin button for one agent, by what the pane is showing: the button shows it when the agent is not in the pane's view, and takes it away when it is. */
export function pinWords(agentName: string, inView: boolean): { label: string; title: string } {
  return inView
    ? { label: `Unpin ${agentName} from the Assistant`, title: 'Unpin from the Assistant' }
    : { label: `Open ${agentName} in the Assistant`, title: 'Pin to the Assistant' }
}
