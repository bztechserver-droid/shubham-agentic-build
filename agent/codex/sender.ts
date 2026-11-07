import { draftText, menuOnScreen, working } from './screen.ts'

// F-134: how a message reaches a Codex chat. Claude's chat takes a bracketed paste and an Enter 300 ms later. Codex's TUI treats an Enter that follows typed text quickly
// as a newline (it guesses the text was pasted), and on Codex 0.163.0 a paste followed by a quick Enter submitted in one trial out of four. Typing the text and
// waiting two seconds before Enter worked every time. So: paste (a bracketed paste keeps the newlines of a message as text), wait, press Enter, then LOOK at the
// screen: if the message is still in the input box it was not submitted, so Enter again (three times at most). Done when Codex shows "Working", or the box is empty.
// Never an Enter while a menu is up: that would pick the highlighted option, an answer nobody gave.

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

export interface SenderIO {
  /** Writes to the chat's terminal; false when it is gone. */
  write(data: string): boolean
  /** The chat's screen now, top to bottom. Throws when it can't be read. */
  lines(): string[]
  sleep(ms: number): Promise<void>
}

export type SendResult =
  /** Codex took it (it is working on it, or the input box is empty again). */
  | 'sent'
  /** A menu is up, or came up before Enter: nothing was submitted. */
  | 'blocked'
  /** Enter was pressed the most times and the message is still in the box. */
  | 'unconfirmed'
  /** The chat's terminal is gone. */
  | 'gone'

export interface SendOptions {
  /** Between the paste and the first Enter (2000). */
  settleMs?: number
  /** After each Enter, before looking at the screen (1500). */
  checkMs?: number
  /** Enters at most (3). */
  tries?: number
}

function readLines(io: SenderIO): string[] | null {
  try {
    return io.lines()
  } catch {
    return null
  }
}

export async function sendToCodex(io: SenderIO, text: string, o: SendOptions = {}): Promise<SendResult> {
  const settleMs = o.settleMs ?? 2000
  const checkMs = o.checkMs ?? 1500
  const tries = o.tries ?? 3
  // A screen that can't be read counts as a menu being up: the fail-safe the Claude path has too.
  const menu = () => {
    const l = readLines(io)
    return l === null ? true : menuOnScreen(l)
  }
  if (menu()) return 'blocked'
  if (!io.write(PASTE_START + text.split(PASTE_END).join('') + PASTE_END)) return 'gone'
  await io.sleep(settleMs)
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (menu()) return 'blocked'
    if (!io.write('\r')) return 'gone'
    await io.sleep(checkMs)
    const lines = readLines(io)
    if (lines === null) continue
    if (menuOnScreen(lines)) return 'blocked'
    if (working(lines) || draftText(lines) === '') return 'sent'
  }
  return 'unconfirmed'
}
