// What a chat's input line holds, as the agent read it off the terminal screen (order o4743, 11 Nov 2026: a "Not submitted... the terminal
// has an unsent draft" that Shubham never typed). The page shows exactly this under "Inspect terminal", and can clear it (one tap, confirmed).
// Shared by the agent and the page: both read the answer through the strict readers below.

/**
 * none        the box is empty
 * typed       text in the box that is not Claude's own grey text (a draft, whoever typed or pasted it)
 * chip        a "[Pasted text #n +k lines]" chip (a draft: a long paste waiting for Enter)
 * suggestion  Claude's grey suggested next prompt or placeholder (not a draft; it is ignored)
 * hint        one of Claude's own hint lines drawn in the box ("Press up to edit queued messages"; not a draft)
 * mirror      text the live chat box typed into the line itself (not a draft of the terminal; the mirror owns it)
 * menu        a question or permission prompt is on the screen (the box is not what is being typed in)
 * no-box      no input box is drawn (busy, starting, redrawing)
 * unreadable  the screen could not be read
 */
export const DRAFT_KINDS = ['none', 'typed', 'chip', 'suggestion', 'hint', 'mirror', 'menu', 'no-box', 'unreadable'] as const
export type DraftKind = (typeof DRAFT_KINDS)[number]
const KIND_SET: readonly string[] = DRAFT_KINDS

/** The kinds that make a send be refused ("the terminal has an unsent draft"). */
export const isDraftKind = (k: DraftKind) => k === 'typed' || k === 'chip'

export const MAX_DRAFT_SHOWN = 400

/** What the page is told: what the agent saw in the input line (cut to MAX_DRAFT_SHOWN), and what may be done about it. */
export interface DraftView {
  kind: DraftKind
  /** True for the kinds that stop a send. */
  draft: boolean
  /** The text the agent counted as a draft (typed words or a chip), cut; '' for every other kind. */
  text: string
  /** Claude's own grey text in the box that was ignored (a suggestion or a hint), cut. */
  ignored: string
  chars: number
  rows: number
  /** A send or a paste of ours is in flight: the line is not his to clear now. */
  busy: boolean
  /** One tap may clear it: a draft, nothing in flight, no menu. */
  clearable: boolean
}

const text = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null)
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : null)
export function readDraftView(raw: unknown): DraftView | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const shown = text(r.text, MAX_DRAFT_SHOWN + 1), ignored = text(r.ignored, MAX_DRAFT_SHOWN + 1), chars = count(r.chars), rows = count(r.rows)
  if (typeof r.kind !== 'string' || !KIND_SET.includes(r.kind) || shown === null || ignored === null || chars === null || rows === null) return null
  if (typeof r.draft !== 'boolean' || typeof r.busy !== 'boolean' || typeof r.clearable !== 'boolean') return null
  return { kind: r.kind as DraftKind, draft: r.draft, text: shown, ignored, chars, rows, busy: r.busy, clearable: r.clearable }
}

export const CLEAR_RESULTS = ['cleared', 'partly', 'nothing', 'busy', 'menu', 'unsupported', 'gone'] as const
export type ClearResult = (typeof CLEAR_RESULTS)[number]
export interface DraftClearAnswer { result: ClearResult; draft: DraftView | null }
export function readDraftClear(raw: unknown): DraftClearAnswer | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.result !== 'string' || !(CLEAR_RESULTS as readonly string[]).includes(r.result)) return null
  const draft = r.draft === null ? null : readDraftView(r.draft)
  if (r.draft !== null && draft === null) return null
  return { result: r.result as ClearResult, draft }
}

/** The plain words under "Inspect terminal": what the agent saw. */
export function draftWords(v: DraftView): string {
  switch (v.kind) {
    case 'typed': return `The input line holds text that was typed or pasted there (${v.chars} characters).`
    case 'chip': return `The input line holds a pasted-text chip (a long paste that was never sent).`
    case 'suggestion': return "The input line holds only Claude's grey suggestion. That is not a draft, so it does not block a send."
    case 'hint': return "The input line shows only Claude's own hint. That is not a draft, so it does not block a send."
    case 'mirror': return 'The input line holds what your chat box typed there. That is not a separate draft.'
    case 'menu': return 'A question or permission prompt is up. Answer it in the terminal first.'
    case 'no-box': return 'No input box is drawn right now (the chat is busy or redrawing). Try again in a moment.'
    case 'unreadable': return 'The terminal screen could not be read just now.'
    default: return 'The input line is empty now. You can send.'
  }
}

export const clearWords = (r: ClearResult): string => {
  switch (r) {
    case 'cleared': return 'The input line is clear. Nothing was sent.'
    case 'partly': return 'Some text is still in the input line. Look at the terminal and clear it there.'
    case 'nothing': return 'There was nothing to clear.'
    case 'busy': return 'A message is being sent to this chat right now. Try again in a moment.'
    case 'menu': return 'A question is up in the terminal. Answer it there; nothing was cleared.'
    case 'unsupported': return 'This chat cannot be cleared from here. Clear its input line in the terminal.'
    case 'gone': return 'This chat is not running.'
  }
}
