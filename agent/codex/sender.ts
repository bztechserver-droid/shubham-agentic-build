import { menuOnScreen, working } from './screen.ts'

// F-134: how a message reaches a Codex chat. Claude's chat takes a bracketed paste and an Enter 300 ms later. Codex's TUI treats an Enter that follows typed text quickly
// as a newline (it guesses the text was pasted), and on Codex 0.163.0 a paste followed by a quick Enter submitted in one trial out of four. Typing the text and
// waiting two seconds before Enter worked every time. So: paste (a bracketed paste keeps the newlines of a message as text), wait, press Enter, then LOOK at the
// screen: if the message is still in the input box it was not submitted, so Enter again (three times at most). Confirm Working or a completed reply and visible empty composer.
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
  /** Codex is working on it, or has already completed it with a visible empty composer. */
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
  /** Bound draining very slow native Windows input (default 90 s, up to 5 min for large pastes). */
  maxSettleMs?: number
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
  const maxSettleMs = o.maxSettleMs ?? (o.settleMs !== undefined ? 45 * Math.max(1, settleMs)
    : Math.min(300_000, Math.max(90_000, Buffer.byteLength(text) * 50)))
  // A screen that can't be read counts as a menu being up: the fail-safe the Claude path has too.
  const menu = () => {
    const l = readLines(io)
    return l === null ? true : menuOnScreen(l)
  }
  if (menu()) return 'blocked'
  const pasted = text.split(PASTE_END).join('')
  if (pasted.length <= 1024) {
    if (!io.write(PASTE_START + pasted + PASTE_END)) return 'gone'
  } else {
    // Do not overfill ConPTY's native input queue with one large write. Keep one paste transaction.
    if (!io.write(PASTE_START)) return 'gone'
    for (let offset = 0; offset < pasted.length;) {
      let end = Math.min(offset + 1024, pasted.length)
      if (end < pasted.length && /[\uD800-\uDBFF]/.test(pasted[end - 1])) end--
      if (!io.write(pasted.slice(offset, end))) return 'gone'
      offset = end
      await io.sleep(10)
    }
    if (!io.write(PASTE_END)) return 'gone'
  }
  // Large pastes can render in several batches. Require a quiet screen after the minimum wait.
  let previous = readLines(io)?.join('\n')
  await io.sleep(o.settleMs ?? Math.min(10_000, settleMs + Math.floor(Buffer.byteLength(text) / 16)))
  let settled = false
  for (let poll = 0; poll < Math.ceil(maxSettleMs / Math.max(1, settleMs)); poll++) {
    const current = readLines(io)?.join('\n')
    const tail = pasted.replace(/\s+/g, '').slice(-40)
    const tailVisible = pasted.length <= 1024 || current?.replace(/\s+/g, '').includes(tail)
      || /\[Pasted (?:Content|text)\b/i.test(current ?? '')
    if (current !== undefined && current === previous && tailVisible) { settled = true; break }
    previous = current
    await io.sleep(settleMs)
  }
  if (!settled) return menu() ? 'blocked' : 'unconfirmed'
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (menu()) return 'blocked'
    if (!io.write('\r')) return 'gone'
    await io.sleep(checkMs)
    const lines = readLines(io)
    if (lines === null) continue
    if (menuOnScreen(lines)) return 'blocked'
    // A long draft can scroll its prompt marker off-screen. Absence is not an empty composer.
    const emptyComposer = lines.filter(line => line.trim()).slice(-8).some(line => /^\s*›\s*Ask Codex to do anything\s*$/i.test(line))
    const completed = lines.some(line => /Worked for (?:<\s*)?\d/i.test(line))
    if (working(lines) || (emptyComposer && completed)) return 'sent'
  }
  return 'unconfirmed'
}
