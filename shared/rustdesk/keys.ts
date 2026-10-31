import { ControlKey } from './schema.ts'

// Keys for the in-app viewer (F-005; design/features/F-005-protocol.md › 9). A Windows peer
// gets map mode: the physical key, as that PC's own scan code. The table is rdev's, the one
// RustDesk's web client uses (rustdesk-org/rdev a361d86, MIT): KeyboardEvent.code → rdev key
// (src/keycodes/chrome.rs) → Windows scan code, set 1, with 0xE0 in the high byte for extended
// keys (src/keycodes/windows.rs). Generated from those two files; 131 keys.

export const WIN_SCANCODE: Readonly<Record<string, number>> = {
  AltLeft: 0x38, AltRight: 0xe038, Backspace: 0x0e, CapsLock: 0x3a, ControlLeft: 0x1d, ControlRight: 0xe01d,
  Delete: 0xe053, ArrowUp: 0xe048, ArrowDown: 0xe050, ArrowLeft: 0xe04b, ArrowRight: 0xe04d, End: 0xe04f,
  Escape: 0x01, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43,
  F10: 0x44, F11: 0x57, F12: 0x58, F13: 0x64, F14: 0x65, F15: 0x66, F16: 0x67, F17: 0x68, F18: 0x69,
  F19: 0x6a, F20: 0x6b, F21: 0x6c, F22: 0x6d, F23: 0x6e, F24: 0x76, Home: 0xe047, MetaLeft: 0xe05b,
  PageDown: 0xe051, PageUp: 0xe049, Enter: 0x1c, ShiftLeft: 0x2a, ShiftRight: 0x36, Space: 0x39, Tab: 0x0f,
  PrintScreen: 0xe037, ScrollLock: 0x46, NumLock: 0x45, Backquote: 0x29,
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08,
  Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18,
  KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b, Backslash: 0x2b,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, IntlBackslash: 0x56, IntlRo: 0x73, IntlYen: 0x7d, KanaMode: 0x70,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33,
  Period: 0x34, Slash: 0x35, Insert: 0xe052,
  NumpadSubtract: 0x4a, NumpadAdd: 0x4e, NumpadMultiply: 0x37, NumpadDivide: 0xe035, NumpadDecimal: 0x53,
  NumpadEnter: 0xe01c, NumpadEqual: 0x59, NumpadComma: 0x7e, Numpad0: 0x52, Numpad1: 0x4f, Numpad2: 0x50,
  Numpad3: 0x51, Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49,
  MetaRight: 0xe05c, ContextMenu: 0xe05d, AudioVolumeUp: 0xe030, AudioVolumeDown: 0xe02e, AudioVolumeMute: 0xe020,
  NonConvert: 0x7b, Convert: 0x79, Lang1: 0xf2, Lang2: 0xf1, Lang3: 0x78, Lang4: 0x77, Lang5: 0x76,
}

/** Keys that carry Caps Lock with them (keyboard.rs:817-857: the letters, and `[ ] ; ' , .`). */
export const CAPS_KEYS: ReadonlySet<string> = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => `Key${c}`),
  'BracketLeft', 'BracketRight', 'Semicolon', 'Quote', 'Comma', 'Period',
])

/** Keys that carry Num Lock with them (keyboard.rs:795-814). */
export const NUM_KEYS: ReadonlySet<string> = new Set([
  ...'0123456789'.split('').map(d => `Numpad${d}`),
  'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadAdd', 'NumpadDecimal',
])

/** Modifier keys: never held back while the clipboard syncs, and released first. */
export const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
])

/**
 * Legacy mode, for a peer that is not Windows (phase 1 has no scan-code tables for macOS or
 * Linux): named keys as ControlKey, everything else as the text it types.
 */
export const LEGACY_CONTROL: Readonly<Record<string, number>> = {
  Enter: ControlKey.Return, Backspace: ControlKey.Backspace, Tab: ControlKey.Tab, Escape: ControlKey.Escape,
  Delete: ControlKey.Delete, Insert: ControlKey.Insert, Home: ControlKey.Home, End: ControlKey.End,
  PageUp: ControlKey.PageUp, PageDown: ControlKey.PageDown, ArrowUp: ControlKey.UpArrow,
  ArrowDown: ControlKey.DownArrow, ArrowLeft: ControlKey.LeftArrow, ArrowRight: ControlKey.RightArrow,
  F1: ControlKey.F1, F2: ControlKey.F2, F3: ControlKey.F3, F4: ControlKey.F4, F5: ControlKey.F5, F6: ControlKey.F6,
  F7: ControlKey.F7, F8: ControlKey.F8, F9: ControlKey.F9, F10: ControlKey.F10, F11: ControlKey.F11, F12: ControlKey.F12,
  ShiftLeft: ControlKey.Shift, ShiftRight: ControlKey.RShift, ControlLeft: ControlKey.Control,
  ControlRight: ControlKey.RControl, AltLeft: ControlKey.Alt, AltRight: ControlKey.RAlt, MetaLeft: ControlKey.Meta,
  MetaRight: ControlKey.RWin, CapsLock: ControlKey.CapsLock, NumLock: ControlKey.NumLock, ScrollLock: ControlKey.Scroll,
  Space: ControlKey.Space, ContextMenu: ControlKey.Apps, PrintScreen: ControlKey.Snapshot, Pause: ControlKey.Pause,
  Numpad0: ControlKey.Numpad0, Numpad1: ControlKey.Numpad1, Numpad2: ControlKey.Numpad2, Numpad3: ControlKey.Numpad3,
  Numpad4: ControlKey.Numpad4, Numpad5: ControlKey.Numpad5, Numpad6: ControlKey.Numpad6, Numpad7: ControlKey.Numpad7,
  Numpad8: ControlKey.Numpad8, Numpad9: ControlKey.Numpad9, NumpadMultiply: ControlKey.Multiply,
  NumpadAdd: ControlKey.Add, NumpadSubtract: ControlKey.Subtract, NumpadDecimal: ControlKey.Decimal,
  NumpadDivide: ControlKey.Divide, NumpadEnter: ControlKey.NumpadEnter,
}
