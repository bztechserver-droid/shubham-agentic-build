// order ocd63 (Lead's F-172): on the phone, tapping a chat input must NOT open the on-screen keyboard, yet the input must still count as focused (the Wispr Flow
// widget on his device shows only while a text field is focused). The field is focused with inputmode="none" (no soft keyboard); a keyboard button next to it
// switches it to normal text input and opens the keyboard, and a second press hides it again while the field stays focused. This file is the pure part: the
// setting, what the field's inputmode is, and when the button shows. The browser part (storage, focus juggling, the React hook) is src/lib/keyboard-mode.ts.
//
// The old way stays: the setting has two values, and "normal" is exactly the behaviour before this (a tap opens the keyboard, no button, no inputmode).

/** 'hidden': a tap focuses the field without the keyboard; a button opens it. 'normal': a tap opens the keyboard, as it always did. */
export type KeyboardSetting = 'hidden' | 'normal'

/** A choice kept in this browser; null: never chosen. Anything else is treated as never chosen. */
export function parseKeyboardSetting(raw: unknown): KeyboardSetting | null {
  return raw === 'hidden' || raw === 'normal' ? raw : null
}

/**
 * What the setting is on this device: the chosen value, else his wish for a phone (hidden on a touch device) and the old behaviour everywhere else (nothing
 * changes on a desktop: there the setting has no effect at all, whatever it says).
 */
export function effectiveKeyboardSetting(stored: KeyboardSetting | null, coarse: boolean): KeyboardSetting {
  return stored ?? (coarse ? 'hidden' : 'normal')
}

export interface KeyboardState {
  setting: KeyboardSetting
  /** The main pointer is a finger (matchMedia "(pointer: coarse)"): the only place any of this applies. */
  coarse: boolean
  /** The keyboard button was pressed: the field is a normal text field until it is pressed again or the field is left. */
  keyboardOn: boolean
}

/** Is the on-screen keyboard being kept away from this field right now? Coarse pointer only; a desktop is never touched. */
export const keyboardSuppressed = (s: KeyboardState): boolean => s.coarse && s.setting === 'hidden' && !s.keyboardOn

/** The field's `inputMode` attribute: 'none' while the keyboard is kept away, otherwise left out (the browser's own, as before). */
export const inputModeFor = (s: KeyboardState): 'none' | undefined => (keyboardSuppressed(s) ? 'none' : undefined)

/** Does the keyboard button show? Only where the keyboard is being kept away by the setting (so only on a touch device with 'hidden'). */
export const showKeyboardButton = (s: Pick<KeyboardState, 'setting' | 'coarse'>): boolean => s.coarse && s.setting === 'hidden'

/** The button's words, for aria-label and the tooltip, by what pressing it does now. */
export const keyboardButtonLabel = (keyboardOn: boolean): string => (keyboardOn ? 'Hide the keyboard' : 'Show the keyboard')
