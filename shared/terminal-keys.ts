// F-115: keys typed straight into an agent's chat (src/agentic/Terminal.tsx). A terminal sends the same \r for Enter and Shift+Enter, so Claude Code
// sent the message on both. Shift+Enter now sends its newline instead: Ctrl+J (a line feed, "\n"), which Claude Code takes as a new line in every
// terminal. (Esc then Enter, "\x1b\r", is the Option+Enter way; both work, the line feed needs no setting.) Enter alone still sends, and a backslash
// then Enter, or Ctrl+J, still start a new line.

/** What to send for a Shift+Enter with no Ctrl, Alt or Meta held: Claude Code's new line; null for any other key. */
export const SHIFT_ENTER_NEWLINE = '\n'

export interface KeyLike {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

export function shiftEnterNewline(e: KeyLike): string | null {
  return e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey ? SHIFT_ENTER_NEWLINE : null
}
