// order ocd63 (Lead's F-172), second version after his phone test of build 2126: on the phone a chat input can stay without the on-screen keyboard until a keyboard button is
// pressed, and the field still counts as focused. This file is the pure part: the setting, how the keyboard is kept away, what the field's attributes are, and when the button
// shows. The browser part (storage, focus juggling, the React hook) is src/lib/keyboard-mode.ts.
//
// What the phone test showed: the first way (inputmode="none") also took away the dictation widget, which (by its maker's own help pages) shows only "as the keyboard opens".
// So the OLD behaviour (a tap opens the keyboard) is the default again on every device, and "hidden" is something he chooses. When he chooses it there are two ways to keep the
// keyboard away and the browser decides which: the VirtualKeyboard API where it exists (the field says virtualkeyboardpolicy="manual", and the button calls show()/hide())
// and, where it does not, the first way (inputmode="none", the button switches it). Neither is known to keep the widget up: that is for his phone to say.

/** 'normal': a tap opens the keyboard, as it always did (the default everywhere). 'hidden': a tap focuses the field without the keyboard; a button opens it. */
export type KeyboardSetting = 'hidden' | 'normal'

/** How the keyboard is kept away while the setting is 'hidden'. */
export type KeyboardMethod = 'virtual-keyboard' | 'inputmode'

/** A choice kept in this browser; null: never chosen. Anything else is treated as never chosen. */
export function parseKeyboardSetting(raw: unknown): KeyboardSetting | null {
  return raw === 'hidden' || raw === 'normal' ? raw : null
}

/** What the setting is on this device: the chosen value, else the old behaviour (on a phone, a tablet and a computer alike). */
export function effectiveKeyboardSetting(stored: KeyboardSetting | null): KeyboardSetting {
  return stored ?? 'normal'
}

/** The VirtualKeyboard API where the browser has it (Chromium, in a secure page), else the inputmode way. */
export const keyboardMethodFor = (hasVirtualKeyboard: boolean): KeyboardMethod => (hasVirtualKeyboard ? 'virtual-keyboard' : 'inputmode')

export interface KeyboardState {
  setting: KeyboardSetting
  /** The main pointer is a finger (matchMedia "(pointer: coarse)"): the only place any of this applies. */
  coarse: boolean
  method: KeyboardMethod
  /** The keyboard button was pressed: the keyboard is meant to be open until it is pressed again or the field is left. */
  keyboardOn: boolean
}

/** Is any of this in force? Only a touch device with the setting 'hidden'; a desktop is never touched, whatever the setting says. */
export const keyboardManaged = (s: Pick<KeyboardState, 'setting' | 'coarse'>): boolean => s.coarse && s.setting === 'hidden'

/** The field's `inputMode` attribute ('inputmode' way only): 'none' while the keyboard is kept away, otherwise left out (the browser's own, as before). */
export const inputModeFor = (s: KeyboardState): 'none' | undefined => (keyboardManaged(s) && s.method === 'inputmode' && !s.keyboardOn ? 'none' : undefined)

/**
 * The field's `virtualkeyboardpolicy` attribute ('virtual-keyboard' way only): 'manual' for as long as the setting is in force (a focus then does not raise the keyboard;
 * the button's show()/hide() does), otherwise left out.
 */
export const virtualKeyboardPolicyFor = (s: KeyboardState): 'manual' | undefined => (keyboardManaged(s) && s.method === 'virtual-keyboard' ? 'manual' : undefined)

/** Does the keyboard button show? Only where the keyboard is being kept away by the setting. */
export const showKeyboardButton = (s: Pick<KeyboardState, 'setting' | 'coarse'>): boolean => keyboardManaged(s)

/** The button's words, for aria-label and the tooltip, by what pressing it does now. */
export const keyboardButtonLabel = (keyboardOn: boolean): string => (keyboardOn ? 'Hide the keyboard' : 'Show the keyboard')
