// order o7f0a (11 Nov): Alt+A (Option+A on a Mac) toggles the Assistant. The pure part: which key presses count, and what a press does for the state the Assistant is in. The browser side (the listener, the
// setting kept per device, the focus request) is src/overlay/assistant-key.ts.
//
// Rules, all from the order:
//  * Only Alt (Option) with A: Ctrl, Shift and Meta must be off, so Ctrl+Alt+A (AltGr+A on many keyboards, which types a letter) and Alt+Shift+A and Cmd+Option+A are never ours.
//  * The physical key (code KeyA), so a Dvorak or AZERTY layout keeps it where the key is printed.
//  * Not while an input method is composing (IME): then the key belongs to it.
//  * It works from any field on purpose: with Alt held, A is not a character on Windows. (On a Mac, Option+A types a letter on some layouts; the setting turns the shortcut off for that.)

export const ASSISTANT_SHORTCUT = 'Alt+A'
export const ASSISTANT_SHORTCUT_MAC = 'Option+A'

/** The shortcut as this keyboard calls it. */
export const shortcutLabel = (mac: boolean): string => (mac ? ASSISTANT_SHORTCUT_MAC : ASSISTANT_SHORTCUT)

export interface KeyLike {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  code: string
  repeat?: boolean
  isComposing?: boolean
  /** 229 is what a browser reports for a key an input method has taken. */
  keyCode?: number
}

export function isAssistantShortcut(e: KeyLike): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false
  if (e.code !== 'KeyA') return false
  if (e.isComposing || e.keyCode === 229) return false
  return true
}

/** What a press does: shut -> open (the composer is focused when it is up); open but the keyboard is elsewhere -> bring the keyboard into its composer; open with the keyboard inside it -> close. */
export type AssistantKeyAction = 'open' | 'focus' | 'close'

export function assistantKeyAction(open: boolean, focusInside: boolean): AssistantKeyAction {
  if (!open) return 'open'
  return focusInside ? 'close' : 'focus'
}

export interface KeyContext {
  /** Switched on in Settings. */
  on: boolean
  open: boolean
  /** The keyboard is inside the Assistant's own box or panel. */
  focusInside: boolean
  /** The key was pressed on a Control screen (the keys belong to the other PC there). */
  acrossScreen: boolean
}

/** One answer for one key press: null = not ours, leave it alone (the page, the terminal and the browser hear it as before); otherwise what to do. A held key (repeat) is eaten but does nothing, so it cannot flicker the Assistant. */
export function assistantKeyDecision(e: KeyLike, c: KeyContext): { act: AssistantKeyAction | null } | null {
  if (!c.on || c.acrossScreen || !isAssistantShortcut(e)) return null
  if (e.repeat) return { act: null }
  return { act: assistantKeyAction(c.open, c.focusInside) }
}

/** The tooltip of the round button: the shortcut is named only while it is switched on. */
export function assistantButtonTitle(name: string, on: boolean, mac: boolean): string {
  return on ? `${name} (${shortcutLabel(mac)})` : name
}

/** Parse what is kept in this browser: switched on unless it says "off". */
export const parseKeyOn = (raw: unknown): boolean => raw !== 'off'
