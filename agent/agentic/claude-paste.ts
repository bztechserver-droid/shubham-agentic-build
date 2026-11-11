// Claude Code collapses a long paste in its input box into a chip, so the box never shows the pasted words:
//   "[Pasted text #N]" (no line breaks) or "[Pasted text #N +M lines]" (M line breaks).
// Read from claude.exe 2.1.319 (the paste handler): a paste is collapsed when its length is over 800 characters OR it has more than 2
// line breaks (/\r\n|\r|\n/, counted on the paste with CR normalised). Candidate A made the Claude sender compare the box text with
// the owned paste only, so a collapsed paste never settled, no Enter was pressed, and the chip stayed in the box (10 Nov, build 1831).
//
// An owned chip is accepted ONLY when all of these hold: the whole box is exactly one chip of that shape, the paste is one Claude
// collapses, and M equals the line breaks of OUR paste. The caller has already refused a non-empty box before pasting, so a chip that
// appears afterwards is ours. Nothing else (other words in the box, another chip shape, a second chip, a wrong M) is ever owned.

export const CLAUDE_COLLAPSE_LENGTH = 800
export const CLAUDE_CHIP_RE = /^\[Pasted text #(\d+)(?: \+(\d+) lines)?\]$/
/** Any text-paste chip anywhere in a box (never a grey suggestion): a draft, whoever pasted it. */
export const ANY_CLAUDE_CHIP_RE = /\[Pasted text #\d+(?: \+\d+ lines)?\]/

const normalize = (pasted: string) => pasted.replace(/\r\n|\r/g, '\n')
const breaks = (pasted: string) => (normalize(pasted).match(/\n/g) ?? []).length

/** Whether Claude Code turns this paste into a chip instead of showing it. */
export const claudeCollapses = (pasted: string) => normalize(pasted).length > CLAUDE_COLLAPSE_LENGTH || breaks(pasted) > 2

/** Is `box` (the whole input box, whitespace squashed) exactly the chip our own paste produces? */
export function isOwnedClaudeChip(box: string, pasted: string): boolean {
  const m = CLAUDE_CHIP_RE.exec(box.trim())
  if (!m) return false
  const lines = breaks(pasted)
  // o4743 (11 Nov 2026): the "more than 2 line breaks" limit is the tall-terminal rule: a terminal of 11 rows or fewer collapses a paste with FEWER breaks
  // (Agent 4's probe of 2.1.322), and then "[Pasted text #27 +2 lines]" held his two-break message and the sender never owned it (it waited 26 s, the
  // message stayed unsent). A chip that carries a line count is owned when that count is exactly the breaks of OUR paste, whatever limit made it. A chip
  // without a count (no breaks) still needs a paste Claude would collapse by length.
  if (lines > 0) return m[2] !== undefined && Number(m[2]) === lines
  return claudeCollapses(pasted) && m[2] === undefined
}
