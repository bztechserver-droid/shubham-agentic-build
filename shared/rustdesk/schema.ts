import protobuf from 'protobufjs'

// hbb.Message, the one message two RustDesk peers exchange (message.proto beside this file,
// RustDesk 1.5.0), for the in-app viewer (F-005). The schema text comes in from outside:
// src/remote/schema.ts imports the file through Vite (`?raw`), the tests read it from disk, so
// this module needs neither the browser nor Node.
//
// Field names stay snake_case, as in the schema. Decoded messages follow proto3: every field
// is there, absent ones at their default; a oneof member only when it was sent, with `union`
// naming it. Enums are numbers. 64-bit integers are decimal strings, whether or not protobufjs
// found the `long` package (it does under Node, not in the browser). Bytes are views into the
// frame they came in, never copies.

const TO_OBJECT: protobuf.IConversionOptions = { longs: String, defaults: true, arrays: true, oneofs: true }

// --- enums the viewer uses (message.proto) -------------------------------------------------

export const KeyboardMode = { Legacy: 0, Map: 1, Translate: 2, Auto: 3 } as const
export const PreferCodec = { Auto: 0, VP9: 1, H264: 2, H265: 3, VP8: 4, AV1: 5 } as const
export const BoolOption = { NotSet: 0, No: 1, Yes: 2 } as const
export const ClipboardFormat = { Text: 0, Rtf: 1, Html: 2, ImageRgba: 21, ImagePng: 22, ImageSvg: 23, Special: 31 } as const
export const Permission = { Keyboard: 0, Clipboard: 2, Audio: 3, File: 4, Restart: 5, Recording: 6, BlockInput: 7, PrivacyMode: 8 } as const
/**
 * F-017, ours and not RustDesk's: Misc.plugin_request (RustDesk's own way to carry a plugin's
 * messages, which a RustDesk without that plugin leaves alone) with this id. The viewer sends
 * JSON {"watch": true|false}; the app's own screen answers {"editable": true|false} whenever a
 * text box there gains or loses the keyboard focus.
 */
export const TEXT_FOCUS_PLUGIN = 'sad.text-focus'
/** BackNotification.PrivacyModeState: privacy mode's answers (F-012). */
export const PrivacyModeState = {
  Unknown: 0, OnByOther: 2, NotSupported: 3, OnSucceeded: 4, OnFailedDenied: 5, OnFailedPlugin: 6, OnFailed: 7,
  OffSucceeded: 8, OffByPeer: 9, OffFailed: 10, OffUnknown: 11,
} as const

/** ControlKey, by name. */
export const ControlKey = {
  Unknown: 0, Alt: 1, Backspace: 2, CapsLock: 3, Control: 4, Delete: 5, DownArrow: 6, End: 7, Escape: 8,
  F1: 9, F10: 10, F11: 11, F12: 12, F2: 13, F3: 14, F4: 15, F5: 16, F6: 17, F7: 18, F8: 19, F9: 20,
  Home: 21, LeftArrow: 22, Meta: 23, PageDown: 25, PageUp: 26, Return: 27, RightArrow: 28, Shift: 29,
  Space: 30, Tab: 31, UpArrow: 32, Numpad0: 33, Numpad1: 34, Numpad2: 35, Numpad3: 36, Numpad4: 37,
  Numpad5: 38, Numpad6: 39, Numpad7: 40, Numpad8: 41, Numpad9: 42, Pause: 46, Snapshot: 57, Insert: 58,
  Scroll: 62, NumLock: 63, RWin: 64, Apps: 65, Multiply: 66, Add: 67, Subtract: 68, Decimal: 69, Divide: 70,
  NumpadEnter: 72, RShift: 73, RControl: 74, RAlt: 75, CtrlAltDel: 100, LockScreen: 101,
} as const

// --- what the controlled side sends (the parts the viewer reads) ----------------------------

export interface DisplayInfo {
  x: number
  y: number
  width: number
  height: number
  name: string
  online: boolean
  cursor_embedded: boolean
  scale: number
}

export interface PeerInfo {
  username: string
  hostname: string
  platform: string
  displays: DisplayInfo[]
  current_display: number
  sas_enabled: boolean
  version: string
  /** What it can do beyond the picture; privacy_mode: it can keep its own screen dark (F-012). */
  features: { privacy_mode: boolean } | null
  platform_additions: string
  windows_sessions: { sessions: { sid: number; name: string }[]; current_sid: number } | null
}

export interface EncodedVideoFrame {
  data: Uint8Array
  key: boolean
  /** int64, as a decimal string. */
  pts: string
}

export type VideoUnion = 'vp9s' | 'vp8s' | 'av1s' | 'h264s' | 'h265s' | 'rgb' | 'yuv'

export type VideoFrame = { union?: VideoUnion; display: number } & { [K in VideoUnion]?: { frames: EncodedVideoFrame[] } }

export interface Clipboard {
  compress: boolean
  content: Uint8Array
  width: number
  height: number
  format: number
  special_name: string
}

export interface CursorData {
  /** uint64, as a decimal string. */
  id: string
  hotx: number
  hoty: number
  width: number
  height: number
  colors: Uint8Array
}

export interface SwitchDisplay {
  display: number
  x: number
  y: number
  width: number
  height: number
  cursor_embedded: boolean
}

export interface TestDelay {
  time: string
  from_client: boolean
  last_delay: number
  target_bitrate: number
}

export interface Misc {
  union?: string
  switch_display?: SwitchDisplay
  permission_info?: { permission: number; enabled: boolean }
  close_reason?: string
  back_notification?: { union?: string; privacy_mode_state?: number; block_input_state?: number; details: string; impl_key: string }
  plugin_request?: { id: string; content: Uint8Array }
}

/** A decoded hbb.Message; `union` names the member that is set, if the schema knows it. */
export interface Incoming {
  union?: string
  hash?: { salt: string; challenge: string }
  test_delay?: TestDelay
  video_frame?: VideoFrame
  login_response?: { union?: 'error' | 'peer_info'; error?: string; peer_info?: PeerInfo; enable_trusted_devices: boolean }
  cursor_data?: CursorData
  cursor_position?: { x: number; y: number }
  /** uint64, as a decimal string. */
  cursor_id?: string
  clipboard?: Clipboard
  multi_clipboards?: { clipboards: Clipboard[] }
  misc?: Misc
  message_box?: { msgtype: string; title: string; text: string; link: string }
  peer_info?: PeerInfo
}

// --- what the viewer sends -------------------------------------------------------------------

type Mods = number[]

export interface LoginRequestOut {
  username: string
  password: Uint8Array
  my_id: string
  my_name: string
  my_platform: string
  version: string
  session_id: number
  option: {
    supported_decoding: {
      ability_vp9: number
      ability_vp8: number
      ability_av1: number
      ability_h264: number
      ability_h265: number
      prefer: number
    }
    disable_audio?: number
  }
}

export interface KeyEventOut {
  down?: boolean
  press?: boolean
  control_key?: number
  chr?: number
  unicode?: number
  /** Text typed as it is (a phone's keyboard, F-014). */
  seq?: string
  modifiers?: Mods
  mode: number
}

/** One hbb.Message the viewer sends: exactly one member set. */
export type Outgoing =
  | { login_request: LoginRequestOut }
  | { auth_2fa: { code: string } }
  | { test_delay: { time: number; from_client: boolean } }
  | { mouse_event: { mask: number; x: number; y: number; modifiers?: Mods } }
  | { key_event: KeyEventOut }
  | { clipboard: { compress: boolean; content: Uint8Array; format: number } }
  | {
      misc:
        | { close_reason: string }
        | { refresh_video: boolean }
        | { refresh_video_display: number }
        | { switch_display: { display: number; width: number; height: number } }
        | { capture_displays: { set: number[] } }
        | { selected_sid: number }
        | { toggle_privacy_mode: { impl_key: string; on: boolean } }
        | { plugin_request: { id: string; content: Uint8Array } }
    }

export interface Schema {
  encode(msg: Outgoing): Uint8Array
  /**
   * Any hbb.Message, built field by field: what the controlled side sends (the agent's own
   * screen, F-006, and the viewer's pretend RustDesk). Field names are checked all the same.
   */
  encodeAny(msg: Record<string, unknown>): Uint8Array
  /** Never throws: bytes that are not a Message decode to null. */
  decode(bytes: Uint8Array): Incoming | null
}

/** Parses message.proto's text once; returns the codec for hbb.Message. */
export function loadSchema(protoText: string): Schema {
  const Message = protobuf.parse(protoText, { keepCase: true }).root.lookupType('hbb.Message')
  const encodeAny = (msg: Record<string, unknown>) => {
    known(Message, msg, 'Message')
    return Message.encode(Message.fromObject(msg)).finish()
  }
  return {
    encode: msg => encodeAny(msg),
    encodeAny,
    decode(bytes) {
      try {
        return Message.toObject(Message.decode(bytes), TO_OBJECT) as Incoming
      } catch {
        return null
      }
    },
  }
}

// fromObject drops a field the schema lacks without a word; a misspelt one should fail loudly.
function known(type: protobuf.Type, obj: object, path: string) {
  for (const [name, value] of Object.entries(obj)) {
    const field = type.fields[name]
    if (!field) throw new Error(`${path} has no field "${name}"`)
    field.resolve()
    if (field.resolvedType instanceof protobuf.Type && value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
      for (const v of field.repeated ? (value as object[]) : [value]) known(field.resolvedType, v, `${path}.${name}`)
    }
  }
}
