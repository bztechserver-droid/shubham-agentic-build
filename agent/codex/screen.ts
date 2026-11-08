// F-134: what a Codex chat's terminal shows, as text. The chat pool (agentic/chats.ts) reads Claude's screen for its state (working, idle, asking), for a draft in the
// input box and for background work; this is the same for the Codex TUI, as seen in a pseudo-terminal on Codex 0.163.0 (6 Nov 2026) and read through agentic/screen.ts:
//
//   idle      › Ask Codex to do anything
//             GPT-6.1-Sol default · C:\work · <the thread title>
//             ? for shortcuts                                             ⚠ 1 warning · f2 to view
//   working   • Working (7s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close
//             › Ask Codex to do anything
//             GPT-6.1-Sol default · C:\work · <the thread title> ⠹
//   finished  Worked for 16s • 16:22
//   typed     › Say hi in three words
//   a menu    "› 1. Yes, …" under the cursor, and a footer such as "Press enter to confirm or Esc to go back" (approvals are off in these chats, so a menu is rare: a sign-in
//             screen, a model-migration notice)
//
// Codex draws no rule lines around its input (Claude's box is rule, line, rule), so the "menu replaced the input box" test Claude's screen uses does not apply: a menu
// is a numbered option under the cursor, or one of the menu footers, near the bottom of the screen.

/** Squashed text (all whitespace removed), like the pool's: the TUI paints with cursor moves, so spaced words aren't there to match. */
export const CODEX_RUNNING_RE = /esctointerrupt/i
export const CODEX_IDLE_RE = /\?forshortcuts/i
export const CODEX_DONE_RE = /Workedfor<?\d/i
/** A question is up: a menu footer, a numbered option, or a sign-in screen (Codex without a login asks how to sign in). */
export const CODEX_QUESTION_RE = /pressentertoconfirm|pressentertoselect|pressentertocontinue|entertoconfirm|entertoselect|escapetogoback|esctogoback|signinwithchatgpt|provideyourownapikey|doyouwant/i
/** The prompt line is drawn (the chat can be typed into). */
export const CODEX_PROMPT_READY_RE = /[›❯»]|\?forshortcuts/

// The cursor of a menu is "›" in some of Codex's menus and ">" in the sign-in one (seen on 0.163.0 when the login on disk was not accepted).
const OPTION_UNDER_CURSOR = /^\s*[›❯»>]\s*\d{1,2}\.\s+\S/
const MENU_FOOTER = /(?:press\s+)?enter\s+to\s+(?:confirm|select|continue)|esc(?:ape)?\s+to\s+(?:cancel|go\s+back)/i
const INPUT_LINE = /^\s*[›❯»](?!\s*\d{1,2}\.\s)\s?(.*)$/
const PLACEHOLDER = /^Ask Codex to do anything$/i
const COMPOSER_FOOTER = /^\s*(?:GPT-[\w.-]+|\?\s*for shortcuts|tab\s+to\s+queue\s+message\b)/i
const WORKING_LINE = /Working\s*\(\d+s?[^)]*esc to interrupt/i
const BACKGROUND = /(\d+)\s+background\s+terminals?\s+running/i

/** The last few non-empty lines, bottom last. */
function bottom(lines: readonly string[], n: number): string[] {
  const out: string[] = []
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) if (lines[i].trim()) out.unshift(lines[i])
  return out
}

/** Whether a menu is on the screen. */
export function menuOnScreen(lines: readonly string[]): boolean {
  return bottom(lines, 14).some(l => OPTION_UNDER_CURSOR.test(l) || MENU_FOOTER.test(l))
}

/** What is typed in the input box and not sent yet ('' when it is empty or shows the placeholder, or when a menu is up). */
export function draftText(lines: readonly string[]): string {
  return composer(lines)?.text ?? ''
}

/** Current composer only: a historical prompt above a reply is never an empty input. */
export function composer(lines: readonly string[]): { text: string; collapsed: boolean } | null {
  if (menuOnScreen(lines)) return null
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = INPUT_LINE.exec(lines[i])
    if (!m) continue
    // Find the footer AFTER this prompt, never a stale footer above the current draft.
    const footer = lines.findIndex((l, n) => n > i && COMPOSER_FOOTER.test(l))
    const end = footer < 0 ? lines.length : footer
    if (footer >= 0 && lines.slice(footer + 1).some(l => l.trim() && !COMPOSER_FOOTER.test(l) && !/^\s*.*\b(?:context left|tokens left|f2 to view)\b/i.test(l))) return null
    const after = lines.slice(i + 1, end)
    // A blank paragraph is fine; native response/activity rows are not composer continuations.
    if (after.some(l => /^\s*(?:[•■]|Working\b|Worked for\b)/.test(l))) return null
    const text = [m[1], ...after].join('\n').trim()
    return { text: PLACEHOLDER.test(text) ? '' : text, collapsed: /\[Pasted (?:Content|text)\b/i.test(text) }
  }
  return null
}

/** Only for a transaction that already observed an empty composer and owns all input.
 * A narrow viewport can scroll the prompt glyph away while the end of a long paste remains.
 * Never use this to decide that an unknown initial screen is empty or safe to paste into.
 */
export function ownedComposerTail(lines: readonly string[], pasted: string): { text: string; collapsed: false } | null {
  if (menuOnScreen(lines)) return null
  let footer = -1
  for (let i = lines.length - 1; i >= 0; i--) if (COMPOSER_FOOTER.test(lines[i])) { footer = i; break }
  if (footer < 3 || lines.slice(footer + 1).some(l => l.trim() && !COMPOSER_FOOTER.test(l) && !/\b(?:context left|tokens left|f2 to view)\b/i.test(l))) return null
  const body = lines.slice(0, footer)
  if (body.some(l => /^\s*(?:[\u2022\u25a0]|Working\b|Worked for\b)/.test(l))) return null
  const first = body.findIndex(l => l.trim())
  const prompt = INPUT_LINE.exec(body[first] ?? '')
  // Native Codex repeats its prompt at the first visible row when scrolling a draft.
  // Remove that ONE decoration, retaining literal glyphs in every continuation row.
  const candidates = prompt ? [[prompt[1], ...body.slice(first + 1)].join('\n').trim()] : [body.join('\n').trim()]
  // The clipped first row can retain a cell during a wide-character redraw. Only
  // an intact multi-row continuation suffix may prove drain; never delete a
  // character in the middle or search arbitrary output for a matching fragment.
  const rest = body.slice(first + 1)
  if (prompt && rest.filter(l => l.trim()).length >= 2) candidates.push(rest.join('\n').trim())
  const expected = pasted.replace(/\s+/g, '')
  for (const text of candidates) {
    const visible = text.replace(/\s+/g, '')
    // A repeated prefix must not masquerade as the fully drained end of a paste.
    if (visible.length >= 32 && expected.length > visible.length && expected.indexOf(visible) === expected.length - visible.length) return { text, collapsed: false }
  }
  return null
}

/** Whether Codex is working on a turn: its "Working (12s • esc to interrupt)" line. */
export function working(lines: readonly string[]): boolean {
  return bottom(lines, 14).some(l => WORKING_LINE.test(l))
}

/** Work going on in the background (a shell the model started), or null. */
export function backgroundWork(lines: readonly string[]): string | null {
  for (const l of bottom(lines, 14)) if (BACKGROUND.test(l)) return 'a background terminal'
  return null
}
