// F-176: the pure parts of the dictation button (src/chat/dictation*.ts): where the text lands, the clock, the limits, how long to wait for the PC. The button's behaviour is in
// src/chat/dictation-core.ts; the hub's side is agent/speech/dictation.ts.

/** The longest recording: the hub's own limit (agent/speech/routes.ts MAX_RECORDING_MS). At this length the recording finishes by itself. */
export const DICTATION_MAX_MS = 15 * 60_000
/** From here the strip says when it will stop. */
export const DICTATION_WARN_MS = 14 * 60_000
/** Cancelling a recording longer than this asks first (a short one is thrown away at once). */
export const DICTATION_CONFIRM_DISCARD_MS = 10_000

/** 7 -> "0:07", 723 -> "12:03". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * How long to wait for the PC to write a recording after Finish (or a retry that sends it all again): Whisper writes about 10 s of speech in 2 s, so this is generous
 * (30 s + 0.8 s per second of speech; a 15 minute recording gets 12.5 minutes) and only there so a PC that has hung does not leave the button waiting for ever.
 */
export const writeWaitMs = (audioSeconds: number): number => 30_000 + Math.round(800 * Math.max(0, audioSeconds))

const NO_SPACE_BEFORE = /^[.,;:!?%)\]}]/
const NO_SPACE_AFTER = /[([{]$/

/**
 * The text of the box with the spoken words put in at the caret (or in place of the selection): a space is added on a side only where there are words next to it, none before
 * punctuation. `caret` is where the caret goes: right after the new words. Positions outside the text are brought back inside it.
 */
export function insertAtCaret(value: string, start: number, end: number, spoken: string): { text: string; caret: number } {
  const words = spoken.replace(/\s+/g, ' ').trim()
  if (!words) return { text: value, caret: Math.min(Math.max(start, 0), value.length) }
  const clamp = (n: number) => Math.min(Math.max(Number.isFinite(n) ? n : value.length, 0), value.length)
  let a = clamp(start)
  let b = clamp(end)
  if (a > b) [a, b] = [b, a]
  const before = value.slice(0, a)
  const after = value.slice(b)
  const lead = before !== '' && !/\s$/.test(before) && !NO_SPACE_AFTER.test(before) && !NO_SPACE_BEFORE.test(words) ? ' ' : ''
  const trail = after !== '' && !/^\s/.test(after) && !NO_SPACE_BEFORE.test(after) ? ' ' : ''
  const text = `${before}${lead}${words}${trail}${after}`
  return { text, caret: before.length + lead.length + words.length }
}

/**
 * Where the words go: the caret or selection of the box. A box that has never been touched reports 0 and 0 (a fresh textarea) even when it holds a draft: then the words go at the END (a
 * caret really put at the very start is only believed while the box has the focus). No selection to read (null): the end.
 */
export function caretFor(selection: { start: number | null; end: number | null } | null, focused: boolean, value: string): { start: number; end: number } {
  const end = { start: value.length, end: value.length }
  if (!selection || typeof selection.start !== 'number' || typeof selection.end !== 'number') return end
  if (!focused && selection.start === 0 && selection.end === 0 && value.length > 0) return end
  return { start: selection.start, end: selection.end }
}
