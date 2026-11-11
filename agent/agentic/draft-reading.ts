// The input box of a Claude chat, classified (order o4743). The screen model gives two views of the box: `raw` (everything printed there) and
// `typed` (the same screen with Claude's own dim/grey cells blanked: screen.ts typedLines). What is in `typed` is a person's text; what is only in `raw` is
// Claude's grey placeholder or its suggested next prompt. A few hint lines Claude draws in the box itself are named here, so one that arrives in a
// colour the screen model does not take for grey ("Press up to edit queued messages" while messages wait) still never counts as a draft.
import { ANY_CLAUDE_CHIP_RE } from './claude-paste.ts'

/** Claude Code's own words in the input line. Anchored: a draft that merely starts with them is still a draft. */
// The queued-message and selected-message hints are the strings in claude 2.1.322's own binary (found with order/bin-strings.mjs).
const HINT_LINES: RegExp[] = [
  /^Try "/,
  /^Press up to edit queued messages(?:, Enter to send them immediately)?$/i,
  /^Press up to select a queued message(?: to edit, or Enter to send them now|, then Enter to edit it)$/i,
  /^Press Enter to edit the selected message, or up again for (?:history|an older one)$/i,
  /^\? for shortcuts$/,
]
export const isKnownHint = (s: string) => HINT_LINES.some(re => re.test(s.trim()))

export type BoxKind = 'none' | 'typed' | 'chip' | 'suggestion' | 'hint'
export interface BoxClass { kind: BoxKind; text: string; ignored: string }

/** `raw` and `typed`: the box's rows joined, whitespace squashed (the same two views at every call). */
export function classifyBox(raw: string, typed: string): BoxClass {
  // A pasted-text chip is real input in whatever colour the TUI draws it, never a grey suggestion.
  if (ANY_CLAUDE_CHIP_RE.test(raw)) return { kind: 'chip', text: raw, ignored: '' }
  if (typed === '') return raw === '' ? { kind: 'none', text: '', ignored: '' } : { kind: 'suggestion', text: '', ignored: raw }
  if (isKnownHint(typed)) return { kind: 'hint', text: '', ignored: typed }
  return { kind: 'typed', text: typed, ignored: '' }
}
