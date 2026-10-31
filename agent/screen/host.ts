import type { Duplex } from 'node:stream'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { Deframer, frame } from '../../shared/rustdesk/bytes-codec.ts'
import { ControlKey, KeyboardMode, Permission, PrivacyModeState, TEXT_FOCUS_PLUGIN, type Schema } from '../../shared/rustdesk/schema.ts'
import type { Logger } from '../log.ts'
import type { CursorImage } from './cursor.ts'
import { GOP_SECONDS, type Codec } from './ffmpeg.ts'
import type { EncodedFrame } from './frames.ts'
import { passwordMatches, randomText, type Failures, type StoredPassword } from './password.ts'
import { VK, type Button, type Display } from './win32.ts'

// One connection to the app's own screen (F-006): the controlled side of RustDesk's peer
// protocol, so the in-app viewer (shared/rustdesk/client.ts) talks to it exactly as it talks to
// an installed RustDesk. Ported from RustDesk 1.5.0's server, for the parts the viewer uses
// (design/features/F-006-host.md has each rule with its source):
//   opening and login   src/server/connection.rs: Hash first (1497-1512), TestDelay every second
//                       (1174-1194), the password check (2454-2500), the failure counts
//                       (4346-4520), "No Password Access" while someone is asked (2994-3025),
//                       then LoginResponse with PeerInfo (1843-2160)
//   mouse               src/server/input_service.rs:1277-1469 (handle_mouse_simulation_)
//   keyboard            input_service.rs:2479-2531 (handle_key_), 1715-1727 (map mode), the
//                       lock-key handling (157-284)
//   video, displays     src/server/video_service.rs; switch_display, refresh (connection.rs:3832-3878)
//   clipboard, cursor   src/server/clipboard_service.rs, input_service.rs:395-563
//   privacy mode        connection.rs: TogglePrivacyMode (4752-4757), turn_on_privacy and
//                       turn_off_privacy (5099-5232), off when the connection ends (1216-1219),
//                       no second login meanwhile (1400-1404); src/privacy_mode.rs (F-012)
//   text focus          ours (F-017): a viewer that asks (a phone) hears when a text box here
//                       gains or loses the keyboard focus, through Misc.plugin_request
// The stream is already authenticated (a paired PC over the agent's pinned TLS link); the
// password or the person at this PC is the second key.

export type HostDisplay = Display & { index: number }

/** Starts sending a display's frames until stopped; `failed` when it stops by itself. */
export interface VideoSource {
  start(
    display: HostDisplay,
    codec: Codec,
    drawMouse: boolean,
    events: { frame(f: EncodedFrame): void; failed(reason: string, frames: number): void; started?(encoder: string): void },
  ): { stop(): void }
}

export interface InputPort {
  moveTo(x: number, y: number): boolean
  button(b: Button, down: boolean): boolean
  wheel(dx: number, dy: number): void
  scanKey(code: number, down: boolean): boolean
  vkKey(vk: number, down: boolean): boolean
  unicodeKey(unit: number, down: boolean): boolean
  keyState(vk: number): { down: boolean; toggled: boolean }
  lockWorkStation(): boolean
}

export interface ClipboardPort {
  clipboardSeq(): number
  readClipboard(): string | null
  writeClipboard(text: string): boolean
}

export interface CursorPort {
  cursorHandle(): number | null
  cursorShape(handle: number): CursorImage | null
}

export interface HostPlatform {
  displays(): Display[]
  /** Null: the picture only (no mouse or keyboard). */
  input: InputPort | null
  clipboard: ClipboardPort | null
  /** Null: the pointer is drawn into the picture instead. */
  cursor: CursorPort | null
  /** 'Default' normally; another name or null while the PC is locked or shows a UAC prompt. */
  inputDesktop(): string | null
  askYesNo(text: string, title: string, timeoutMs: number): Promise<'yes' | 'no' | 'timeout'>
  /** The display back on if Windows turned it off for being idle; called before each capture starts. */
  wake?(): void
  /** Privacy mode (F-012), where this PC can keep its own screen dark; one for all its sessions. */
  privacy?: PrivacyPort | null
  /** F-017: whether a text box here has the keyboard focus (text-focus.ts); null where it can't be told. */
  textFocus?: TextFocusPort | null
}

/** F-017: changes of "a text box here has the keyboard focus", for as long as watched. */
export interface TextFocusPort {
  watch(onChange: (editable: boolean) => void): { stop(): void; nudge(): void }
}

/** Privacy mode: the cover over this PC's own screen, for one session at a time (F-012). */
export interface PrivacyPort {
  /** On or off; false when Windows refused. */
  cover(on: boolean): boolean
  /** The session that has it on, as RustDesk keeps the connection's id (privacy_mode.rs:60-87). */
  owner: object | null
}

/** RustDesk's name for a black window that captures leave out (privacy_mode.rs:38-40). */
export const PRIVACY_IMPL = 'privacy_mode_impl_exclude_from_capture'

export interface HostOptions {
  stream: Duplex
  schema: Schema
  /** The PC asking, as its link proved it (not what its LoginRequest claims). */
  from: { id: string; name: string }
  hostname: string
  username: string
  password(): StoredPassword | null
  failures: Failures
  video: VideoSource
  platform: HostPlatform
  log?: Logger
  onLogin?(): void
  onClose?(reason: string): void
  timing?: Partial<Timing>
}

interface Timing {
  loginGraceMs: number
  silenceMs: number
  testDelayMs: number
  cursorMs: number
  clipboardMs: number
  desktopMs: number
  askMs: number
  /** A capture that stopped starts again after this, times how many stopped in the last minute (at most 5). */
  restartMs: number
}

const TIMING: Timing = {
  loginGraceMs: 180_000, // LOGIN_GRACE, connection.rs:87
  // RustDesk waits 30 s (connection.rs:1175-1178). The viewer answers our TestDelay every
  // second, login or not, so 10 s of silence means it is gone (a page reloaded mid-session, its
  // socket left open by a proxy): stop the capture sooner.
  silenceMs: 10_000,
  testDelayMs: 1000,
  cursorMs: 33,
  clipboardMs: 500,
  desktopMs: 1000,
  askMs: 60_000,
  restartMs: 1000,
}

/** What the viewer is told this side speaks: the 1.5.0 messages (it gates refresh and multi-display on this). */
export const PROTOCOL_VERSION = '1.5.0'
/** MessageBox.msgtype of "the picture stopped: locked or a UAC prompt" (src/remote/session.ts reads it). */
export const LOCKED_NOTICE = 'locked'
/** Before login a frame may be at most this big (MAX_UNAUTHORIZED_MESSAGE, connection.rs:96-103). */
const MAX_UNAUTHORIZED = 128 * 1024
const MAX_CLIPBOARD = 32 * 1024 * 1024
/** Video waiting to go out beyond this: deltas are dropped until the next keyframe. */
const VIDEO_BACKLOG = 2 * 1024 * 1024
const MOUSE = { move: 0, down: 1, up: 2, wheel: 3, trackpad: 4 } as const
const BUTTON_OF: Record<number, Button> = { 1: 'left', 2: 'right', 4: 'middle', 8: 'back', 16: 'forward' }
const WHEEL_DELTA = 120

// enigo's keys for RustDesk's ControlKeys (input_service.rs KEY_MAP, win_impl.rs key_to_keycode).
const CONTROL_VK: Partial<Record<number, number>> = {
  [ControlKey.Alt]: VK.MENU,
  [ControlKey.Shift]: VK.SHIFT,
  [ControlKey.Control]: VK.CONTROL,
  [ControlKey.Meta]: VK.LWIN,
  [ControlKey.RAlt]: VK.RMENU,
  [ControlKey.RShift]: VK.RSHIFT,
  [ControlKey.RControl]: VK.RCONTROL,
  [ControlKey.RWin]: VK.RWIN,
  [ControlKey.Pause]: VK.PAUSE,
  [ControlKey.CapsLock]: VK.CAPITAL,
  [ControlKey.NumLock]: VK.NUMLOCK,
  [ControlKey.Backspace]: 0x08,
  [ControlKey.Tab]: 0x09,
  [ControlKey.Return]: 0x0d,
  [ControlKey.Escape]: 0x1b,
  [ControlKey.Space]: 0x20,
  [ControlKey.PageUp]: 0x21,
  [ControlKey.PageDown]: 0x22,
  [ControlKey.End]: 0x23,
  [ControlKey.Home]: 0x24,
  [ControlKey.LeftArrow]: 0x25,
  [ControlKey.UpArrow]: 0x26,
  [ControlKey.RightArrow]: 0x27,
  [ControlKey.DownArrow]: 0x28,
  [ControlKey.Snapshot]: 0x2c,
  [ControlKey.Insert]: 0x2d,
  [ControlKey.Delete]: 0x2e,
  [ControlKey.Apps]: 0x5d,
  [ControlKey.Numpad0]: 0x60,
  [ControlKey.Numpad1]: 0x61,
  [ControlKey.Numpad2]: 0x62,
  [ControlKey.Numpad3]: 0x63,
  [ControlKey.Numpad4]: 0x64,
  [ControlKey.Numpad5]: 0x65,
  [ControlKey.Numpad6]: 0x66,
  [ControlKey.Numpad7]: 0x67,
  [ControlKey.Numpad8]: 0x68,
  [ControlKey.Numpad9]: 0x69,
  [ControlKey.Multiply]: 0x6a,
  [ControlKey.Add]: 0x6b,
  [ControlKey.Subtract]: 0x6d,
  [ControlKey.Decimal]: 0x6e,
  [ControlKey.Divide]: 0x6f,
  [ControlKey.F1]: 0x70,
  [ControlKey.F2]: 0x71,
  [ControlKey.F3]: 0x72,
  [ControlKey.F4]: 0x73,
  [ControlKey.F5]: 0x74,
  [ControlKey.F6]: 0x75,
  [ControlKey.F7]: 0x76,
  [ControlKey.F8]: 0x77,
  [ControlKey.F9]: 0x78,
  [ControlKey.F10]: 0x79,
  [ControlKey.F11]: 0x7a,
  [ControlKey.F12]: 0x7b,
  [ControlKey.Scroll]: 0x91,
}

/** A mouse event's modifiers, as fix_modifiers checks them (input_service.rs:1029-1077): the key, and the VK held for it. */
const MODIFIER_PAIRS: [number, number][] = [
  [ControlKey.Shift, VK.SHIFT],
  [ControlKey.Shift, VK.RSHIFT],
  [ControlKey.Alt, VK.MENU],
  [ControlKey.Alt, VK.RMENU],
  [ControlKey.Control, VK.CONTROL],
  [ControlKey.Control, VK.RCONTROL],
  [ControlKey.Meta, VK.LWIN],
  [ControlKey.Meta, VK.RWIN],
]

// Windows scan codes (rdev/src/keycodes/windows.rs) the lock-key sync leaves alone
// (skip_led_sync_rdev_key, input_service.rs:2457-2471), and the numpad ones it syncs Num Lock for
// (keyboard.rs:795-813).
const SKIP_LED_SYNC = new Set([0x1d, 0xe01d, 0xe05b, 0xe05c, 0x2a, 0x36, 0x38, 0xe038, 0x0f, 0x1c])
const NUMPAD = new Set([0x52, 0x4f, 0x50, 0x51, 0x4b, 0x4c, 0x4d, 0x47, 0x48, 0x49, 0x4a, 0x37, 0xe035, 0x4e, 0x53, 0xe01c])
const SKIP_LED_SYNC_CONTROL = new Set<number>([
  ControlKey.Control,
  ControlKey.RControl,
  ControlKey.Meta,
  ControlKey.Shift,
  ControlKey.RShift,
  ControlKey.Alt,
  ControlKey.RAlt,
  ControlKey.Tab,
  ControlKey.Return,
])
const NUMPAD_CONTROL = new Set<number>([
  ControlKey.Numpad0,
  ControlKey.Numpad1,
  ControlKey.Numpad2,
  ControlKey.Numpad3,
  ControlKey.Numpad4,
  ControlKey.Numpad5,
  ControlKey.Numpad6,
  ControlKey.Numpad7,
  ControlKey.Numpad8,
  ControlKey.Numpad9,
  ControlKey.Multiply,
  ControlKey.Add,
  ControlKey.Subtract,
  ControlKey.Decimal,
  ControlKey.Divide,
  ControlKey.NumpadEnter,
])
/** Modifier scan codes: let go of last, so nothing turns into a shortcut on the way up. */
const MODIFIER_SCAN = new Set([0x1d, 0xe01d, 0x2a, 0x36, 0x38, 0xe038, 0xe05b, 0xe05c])

// What arrives, as the schema decodes it (snake_case, proto3 defaults, `union` naming the member).
interface In {
  union?: string
  login_request?: { password: Uint8Array; my_name: string; option?: { supported_decoding?: { ability_vp9: number; ability_h264: number } } }
  test_delay?: { time: string; from_client: boolean }
  mouse_event?: { mask: number; x: number; y: number; modifiers: number[] }
  key_event?: { union?: string; down: boolean; press: boolean; control_key?: number; chr?: number; unicode?: number; seq?: string; modifiers: number[]; mode: number }
  clipboard?: { compress: boolean; content: Uint8Array; format: number }
  multi_clipboards?: { clipboards: { compress: boolean; content: Uint8Array; format: number }[] }
  misc?: {
    union?: string
    close_reason?: string
    switch_display?: { display: number }
    refresh_video_display?: number
    toggle_privacy_mode?: { impl_key: string; on: boolean }
    plugin_request?: { id: string; content: Uint8Array }
  }
}

export interface HostSession {
  /** Ends it: lets go of every key and button, stops the video, and tells the viewer why. */
  close(reason: string): void
  readonly loggedIn: boolean
}

/** Asked right now, by PC: one Yes/No box at a time per PC. */
const asking = new Set<string>()

export function hostSession(o: HostOptions): HostSession {
  const t = { ...TIMING, ...o.timing }
  const log = o.log
  const p = o.platform
  const deframer = new Deframer(MAX_CLIPBOARD + 1024)
  const salt = o.password()?.salt ?? randomText(32)
  const challenge = randomText(6)
  let phase: 'hello' | 'asking' | 'live' | 'closed' = 'hello'
  let lastHeard = Date.now()
  let lastDelay = 0
  let codec: Codec = 'h264'
  let displays: HostDisplay[] = []
  let current = 0
  let cursorShapes = false
  let capture: { stop(): void } | null = null
  let captureStarted = 0
  let lastKeyframe = 0
  let dropping = false
  let restarts: number[] = []
  // The capture failed and no frame has come since (the viewer was told why).
  let dark = false
  let secure = false
  const heldScan = new Set<number>()
  const heldVk = new Set<number>()
  const heldButtons = new Set<Button>()
  const sentShapes = new Set<string>()
  const shapeOfHandle = new Map<number, CursorImage | null>()
  let lastHandle: number | null | undefined
  let clipSeq = 0
  let lastClip: string | null = null
  const timers: NodeJS.Timeout[] = []
  const told = new Set<string>()
  // This connection, as privacy mode's owner (F-012).
  const me = {}
  // F-017: watching for text boxes, while the viewer asks.
  let focusWatch: { stop(): void; nudge(): void } | null = null

  const send = (msg: Record<string, unknown>) => {
    if (phase === 'closed' || o.stream.destroyed) return
    o.stream.write(frame(o.schema.encodeAny(msg)))
  }
  /**
   * A MessageBox the viewer shows; with `once`, only the first time for that key. msgtype
   * 'locked' tells the viewer the picture has stopped until frames come again (LOCKED_NOTICE).
   */
  const notice = (title: string, text: string, once?: string, msgtype = 'info') => {
    if (once && told.has(once)) return
    if (once) told.add(once)
    send({ message_box: { msgtype, title, text, link: '' } })
  }
  const every = (ms: number, fn: () => void) => {
    const timer = setInterval(() => {
      try {
        fn()
      } catch (e) {
        log?.warn(e instanceof Error ? e.message : String(e))
      }
    }, ms)
    timers.push(timer)
  }

  // --- opening: the controlled side speaks first ----------------------------------------------

  send({ hash: { salt, challenge } })
  every(t.testDelayMs, () => {
    if (Date.now() - lastHeard > t.silenceMs) return close('Timeout')
    send({ test_delay: { time: Date.now(), from_client: false, last_delay: lastDelay, target_bitrate: 0 } })
  })
  const grace = setTimeout(() => {
    if (phase === 'hello' || phase === 'asking') close('No login within 3 minutes')
  }, t.loginGraceMs)
  timers.push(grace)

  async function onLogin(lr: NonNullable<In['login_request']>) {
    if (phase !== 'hello' && phase !== 'asking') return
    const refused = o.failures.check(o.from.id)
    if (refused) return send({ login_response: { error: refused } })
    // Someone has this PC's screen dark: nobody else may watch meanwhile (connection.rs:1400-1404).
    if (p.privacy?.owner && p.privacy.owner !== me) return send({ login_response: { error: 'Someone turns on privacy mode, exit' } })
    const dec = lr.option?.supported_decoding
    // The graphics chip's H.264 when the viewer decodes it (Chrome and Edge always do), else VP9.
    if (dec?.ability_h264) codec = 'h264'
    else if (dec?.ability_vp9) codec = 'vp9'
    else return send({ login_response: { error: 'This browser can decode neither H.264 nor VP9' } })

    if (!lr.password.length) return ask()
    const stored = o.password()
    if (!stored) {
      return send({
        login_response: {
          error: `No control password is set on ${o.hostname}. Set one in the app there (Devices › This PC), or ask someone at ${o.hostname} to accept instead.`,
        },
      })
    }
    if (stored.salt === salt && passwordMatches(stored, challenge, lr.password)) {
      o.failures.clear(o.from.id)
      return logon()
    }
    o.failures.fail(o.from.id)
    log?.info(`wrong control password from ${o.from.name}`)
    send({ login_response: { error: 'Wrong Password' } })
  }

  async function ask() {
    if (phase === 'asking') return
    if (asking.has(o.from.id)) return send({ login_response: { error: `${o.hostname} is already asking about ${o.from.name}` } })
    phase = 'asking'
    asking.add(o.from.id)
    send({ login_response: { error: 'No Password Access' } })
    log?.info(`asking the person at this PC about ${o.from.name}`)
    let answer: 'yes' | 'no' | 'timeout'
    try {
      answer = await p.askYesNo(
        `${o.from.name} wants to see and control this PC through the app.\n\nAllow it?`,
        'Remote control request',
        t.askMs,
      )
    } finally {
      asking.delete(o.from.id)
    }
    if (phase !== 'asking') return
    if (answer === 'yes') return logon()
    phase = 'hello'
    send({ login_response: { error: answer === 'no' ? `The person at ${o.hostname} said no.` : `Nobody at ${o.hostname} answered in time.` } })
  }

  function logon() {
    displays = p.displays().map((d, index) => ({ ...d, index }))
    if (!displays.length) return close(`${o.hostname} has no display to show`)
    current = Math.max(0, displays.findIndex(d => d.primary))
    cursorShapes = p.cursor !== null
    phase = 'live'
    clearTimeout(grace)
    clipSeq = p.clipboard?.clipboardSeq() ?? 0
    send({
      login_response: {
        peer_info: {
          username: o.username,
          hostname: o.hostname,
          platform: 'Windows',
          displays: displays.map(displayInfo),
          current_display: current,
          sas_enabled: false,
          version: PROTOCOL_VERSION,
          encoding: { h264: codec === 'h264' },
          features: { privacy_mode: Boolean(p.privacy) },
          // RustDesk lists its ways with a text key for each (connection.rs:1975-1983).
          platform_additions: JSON.stringify(p.privacy ? { app_screen: 1, supported_privacy_mode_impl: [[PRIVACY_IMPL, 'privacy_mode_impl_mag_tip']] } : { app_screen: 1 }),
        },
      },
    })
    if (!p.input) send({ misc: { permission_info: { permission: Permission.Keyboard, enabled: false } } })
    if (!p.clipboard) send({ misc: { permission_info: { permission: Permission.Clipboard, enabled: false } } })
    secure = isSecure()
    if (secure) lockedNotice()
    else startVideo()
    if (p.cursor) every(t.cursorMs, watchCursor)
    if (p.clipboard) every(t.clipboardMs, watchClipboard)
    every(t.desktopMs, watchDesktop)
    log?.info(`${o.from.name} is controlling this PC (${codec}, display ${current + 1} of ${displays.length})`)
    o.onLogin?.()
  }

  const displayInfo = (d: HostDisplay) => ({
    x: d.x,
    y: d.y,
    width: d.width,
    height: d.height,
    name: d.name,
    online: true,
    cursor_embedded: !cursorShapes,
    scale: d.scale,
  })

  // --- video ---------------------------------------------------------------------------------

  /**
   * The displays as they are now. When they changed (a new resolution, a monitor plugged in),
   * the viewer gets the new list, as RustDesk sends it (io_loop.rs:2335-2338 reads it), so its
   * pointer maths stays right; the display shown stays the same one by name, else the primary.
   */
  function refreshDisplays() {
    const now = p.displays().map((d, index) => ({ ...d, index }))
    const key = (ds: HostDisplay[]) => JSON.stringify(ds.map(d => [d.adapter, d.output, d.name, d.x, d.y, d.width, d.height]))
    if (!now.length || key(now) === key(displays)) return
    const name = displays[current]?.name
    displays = now
    const same = displays.findIndex(d => d.name === name)
    current = same >= 0 ? same : Math.max(0, displays.findIndex(d => d.primary))
    log?.info(`the displays changed: ${displays.map(d => `${d.width}×${d.height}`).join(', ')}`)
    send({ peer_info: { displays: displays.map(displayInfo), current_display: current } })
  }

  function startVideo() {
    capture?.stop()
    // A display Windows turned off for being idle shows Desktop Duplication nothing: on first.
    p.wake?.()
    refreshDisplays()
    const d = displays[current]
    const shown = current
    captureStarted = Date.now()
    dropping = false
    capture = o.video.start(d, codec, !cursorShapes, {
      frame: f => {
        if (phase !== 'live' || shown !== current) return
        // A picture again: the viewer drops its notice by itself with this frame.
        dark = false
        if (f.key) dropping = false
        else if (dropping) return
        // The link is slower than the picture: skip to the next keyframe rather than queue up.
        if (!f.key && o.stream.writableLength > VIDEO_BACKLOG) {
          dropping = true
          return
        }
        if (f.key) lastKeyframe = Date.now()
        send({ video_frame: { display: shown, [codec === 'h264' ? 'h264s' : 'vp9s']: { frames: [{ data: f.data, key: f.key, pts: f.pts }] } } })
      },
      failed: (why, frames) => {
        if (phase !== 'live' || shown !== current) return
        capture = null
        if (isSecure()) {
          // Locked meanwhile: watchDesktop starts it again on the way back.
          secure = true
          return lockedNotice()
        }
        restarts = [...restarts.filter(at => Date.now() - at < 60_000), Date.now()]
        log?.warn(`the capture stopped after ${frames} frames: ${why}`)
        // As RustDesk does, the connection stays and the capture keeps being tried: a display
        // Windows put to sleep comes back (woken before each try), and the picture with it. The
        // viewer is told why it has none meanwhile.
        if (!dark) {
          dark = true
          darkNotice()
        }
        // 1, 2, 3, 4, then every 5 s.
        setTimeout(() => phase === 'live' && !capture && !secure && startVideo(), t.restartMs * Math.min(restarts.length, 5)).unref()
      },
    })
  }

  /**
   * A keyframe on request (refresh). One comes every GOP_SECONDS anyway, so the viewer waits at
   * most that long; only when none has come for a second longer (an encoder that ignores its GOP)
   * does a fresh capture start, which opens with one.
   */
  function refresh() {
    if (!capture || secure) return
    const now = Date.now()
    if (now - captureStarted < 3000 || now - lastKeyframe < (GOP_SECONDS + 1) * 1000) return
    startVideo()
  }

  function switchDisplay(index: number) {
    const d = displays[index]
    if (!d) return
    if (index !== current) {
      current = index
      if (!secure) startVideo()
    }
    send({ misc: { switch_display: { display: index, x: d.x, y: d.y, width: d.width, height: d.height, cursor_embedded: !cursorShapes } } })
  }

  // --- lock screen and UAC: Desktop Duplication can't see them from here --------------------

  const isSecure = () => (p.inputDesktop() ?? '').toLowerCase() !== 'default'

  /** No picture, and not locked: most often a display Windows turned off for being idle. */
  function darkNotice() {
    notice(
      `No picture from ${o.hostname} right now`,
      `${o.hostname}'s display may be asleep or off. It is being woken and tried again, and the picture comes back by itself.`,
      undefined,
      LOCKED_NOTICE,
    )
  }

  function lockedNotice() {
    notice(
      `${o.hostname} is locked`,
      `${o.hostname} is locked, or showing an administrator (UAC) prompt. The app's own screen can't see those yet: sign in at the PC, or use RustDesk (⋯ › Open in RustDesk). The picture comes back by itself when it is unlocked.`,
      undefined,
      LOCKED_NOTICE,
    )
  }

  function watchDesktop() {
    if (phase !== 'live') return
    const now = isSecure()
    if (now === secure) return
    secure = now
    if (secure) {
      capture?.stop()
      capture = null
      lockedNotice()
    } else {
      log?.info('the desktop is back')
      startVideo()
    }
  }

  // --- pointer shape -----------------------------------------------------------------------------

  function watchCursor() {
    if (phase !== 'live' || !p.cursor) return
    const handle = p.cursor.cursorHandle()
    if (handle === lastHandle) return
    lastHandle = handle
    if (handle === null) return // hidden: the viewer keeps the last shape, as RustDesk's does
    let shape = shapeOfHandle.get(handle)
    if (shape === undefined) {
      if (shapeOfHandle.size > 64) shapeOfHandle.clear()
      shape = p.cursor.cursorShape(handle)
      shapeOfHandle.set(handle, shape)
    }
    if (!shape) return
    if (sentShapes.has(shape.id)) return send({ cursor_id: shape.id })
    sentShapes.add(shape.id)
    send({ cursor_data: { id: shape.id, hotx: shape.hotx, hoty: shape.hoty, width: shape.width, height: shape.height, colors: zstdCompressSync(shape.rgba) } })
  }

  // --- clipboard ---------------------------------------------------------------------------------

  function watchClipboard() {
    if (phase !== 'live' || !p.clipboard) return
    const seq = p.clipboard.clipboardSeq()
    if (seq === clipSeq) return
    clipSeq = seq
    const text = p.clipboard.readClipboard()
    if (text === null || text === lastClip || text.length > MAX_CLIPBOARD) return
    lastClip = text
    const raw = Buffer.from(text, 'utf8')
    const packed = zstdCompressSync(raw)
    // Compressed only when that is smaller (clipboard.rs:640-654).
    const compress = packed.length < raw.length
    send({ clipboard: { compress, content: compress ? packed : raw, format: 0 } })
  }

  function onClipboard(items: { compress: boolean; content: Uint8Array; format: number }[]) {
    if (!p.clipboard) return
    const item = items.find(c => c.format === 0)
    if (!item || item.content.length > MAX_CLIPBOARD) return
    let text: string
    try {
      text = Buffer.from(item.compress ? zstdDecompressSync(item.content, { maxOutputLength: MAX_CLIPBOARD }) : item.content).toString('utf8')
    } catch {
      return
    }
    if (text === lastClip) return
    lastClip = text
    if (p.clipboard.writeClipboard(text)) clipSeq = p.clipboard.clipboardSeq()
  }

  // --- mouse (handle_mouse_simulation_, input_service.rs:1277-1469) -----------------------------

  const vkDown = (vk: number) => p.input!.keyState(vk).down

  /** A modifier held here that the viewer doesn't hold: let go of it (fix_modifiers). */
  function fixModifiers(modifiers: number[]) {
    for (const [ck, vk] of MODIFIER_PAIRS) {
      if (!vkDown(vk) || modifiers.includes(ck)) continue
      if (ck === ControlKey.Control && (vkDown(VK.MENU) || vkDown(VK.RMENU))) continue // AltGr
      p.input!.vkKey(vk, false)
      heldVk.delete(vk)
    }
  }

  function onMouse(e: NonNullable<In['mouse_event']>) {
    const input = p.input
    if (!input || secure) return
    const type = e.mask & 0x7
    const button = BUTTON_OF[e.mask >> 3]
    const pressed: number[] = []
    if (type === MOUSE.down) {
      fixModifiers(e.modifiers)
      // A modifier the viewer holds but this PC doesn't: down for this click only.
      for (const ck of e.modifiers) {
        const vk = CONTROL_VK[ck]
        if (vk === undefined || vk === VK.CAPITAL || vk === VK.NUMLOCK || vkDown(vk)) continue
        input.vkKey(vk, true)
        pressed.push(vk)
      }
    }
    switch (type) {
      case MOUSE.move:
        input.moveTo(e.x, e.y)
        break
      case MOUSE.down:
        if (button) {
          input.button(button, true)
          heldButtons.add(button)
        }
        break
      case MOUSE.up:
        if (button) {
          input.button(button, false)
          heldButtons.delete(button)
        }
        // A click may have put the focus in a text box (F-017): look now.
        focusWatch?.nudge()
        break
      case MOUSE.wheel:
      case MOUSE.trackpad: {
        // Notches from the wheel; Windows wants WHEEL_DELTA each, and x the other way round.
        const k = type === MOUSE.wheel ? WHEEL_DELTA : 1
        input.wheel(e.x ? -e.x * k : 0, e.y * k)
        break
      }
    }
    for (const vk of pressed) input.vkKey(vk, false)
  }

  // --- keyboard (handle_key_, input_service.rs:2479-2531) ---------------------------------------

  /** The viewer's Caps and Num Lock for this one key, put back afterwards (LockModesHandler). */
  function syncLocks(modifiers: number[], numpad: boolean): () => void {
    const input = p.input!
    const click = (vk: number) => {
      input.vkKey(vk, true)
      input.vkKey(vk, false)
    }
    const caps = modifiers.includes(ControlKey.CapsLock) !== input.keyState(VK.CAPITAL).toggled
    if (caps) click(VK.CAPITAL)
    const num = numpad && modifiers.includes(ControlKey.NumLock) !== input.keyState(VK.NUMLOCK).toggled
    if (num) click(VK.NUMLOCK)
    return () => {
      if (caps) click(VK.CAPITAL)
      if (num) click(VK.NUMLOCK)
    }
  }

  function onKey(k: NonNullable<In['key_event']>) {
    const input = p.input
    if (!input || secure) return
    let restore = () => {}
    if (k.union === 'chr' && k.mode === KeyboardMode.Map) {
      if (!SKIP_LED_SYNC.has(k.chr!)) restore = syncLocks(k.modifiers, NUMPAD.has(k.chr!))
    } else if (k.union === 'control_key') {
      if (!SKIP_LED_SYNC_CONTROL.has(k.control_key!)) restore = syncLocks(k.modifiers, NUMPAD_CONTROL.has(k.control_key!))
    } else if (k.union === 'unicode' || k.union === 'seq') restore = syncLocks(k.modifiers, false)

    try {
      if (k.union === 'chr' && k.mode === KeyboardMode.Map) {
        // Map mode: the viewer sends this PC's own scan code (map_keyboard_mode, 1715-1727).
        const code = k.chr!
        input.scanKey(code, k.down)
        if (k.down) heldScan.add(code)
        else heldScan.delete(code)
      } else if (k.union === 'control_key') {
        controlKey(k.control_key!, k.down, k.press)
      } else if (k.union === 'unicode' && k.press) {
        for (const unit of String.fromCodePoint(k.unicode!)) {
          input.unicodeKey(unit.charCodeAt(0), true)
          input.unicodeKey(unit.charCodeAt(0), false)
        }
      } else if (k.union === 'seq' && k.seq) {
        for (let i = 0; i < k.seq.length; i++) {
          input.unicodeKey(k.seq.charCodeAt(i), true)
          input.unicodeKey(k.seq.charCodeAt(i), false)
        }
      }
    } finally {
      restore()
    }
  }

  function controlKey(ck: number, down: boolean, press: boolean) {
    const input = p.input!
    if (ck === ControlKey.CtrlAltDel) {
      // RustDesk sends it through its Windows service (SendSAS); a program the user runs can't.
      return notice(
        'Ctrl+Alt+Del needs RustDesk',
        `The app's own screen can't send Ctrl+Alt+Del. To use it, open ${o.hostname} in RustDesk (⋯ › Open in RustDesk), where it is installed.`,
        'cad',
      )
    }
    if (ck === ControlKey.LockScreen) {
      if (down || press) input.lockWorkStation()
      return
    }
    const vk = CONTROL_VK[ck]
    if (vk === undefined) return
    if (press) {
      input.vkKey(vk, true)
      input.vkKey(vk, false)
      return
    }
    input.vkKey(vk, down)
    if (down) heldVk.add(vk)
    else heldVk.delete(vk)
  }

  // --- privacy mode (F-012) ----------------------------------------------------------------------

  function togglePrivacy(t: { impl_key: string; on: boolean }) {
    const answer = (state: number, details = '') =>
      send({ misc: { back_notification: { privacy_mode_state: state, details, impl_key: t.impl_key || PRIVACY_IMPL } } })
    const pr = p.privacy
    if (!pr) return answer(PrivacyModeState.NotSupported, `${o.hostname} can't keep its screen dark (it needs Windows 10 2004 or later).`)
    if (!t.on) {
      if (pr.owner && pr.owner !== me) return answer(PrivacyModeState.OffFailed, 'Failed to turn off privacy mode that belongs to someone else.')
      privacyOff()
      return answer(PrivacyModeState.OffSucceeded)
    }
    if (pr.owner === me) return answer(PrivacyModeState.OnSucceeded)
    if (pr.owner) return answer(PrivacyModeState.OnFailed, 'Privacy occupied by another one.')
    if (!pr.cover(true)) return answer(PrivacyModeState.OnFailed, `Windows didn't let the app keep ${o.hostname}'s screen dark.`)
    pr.owner = me
    log?.info(`${o.from.name} turned this PC's own screen off (privacy mode)`)
    answer(PrivacyModeState.OnSucceeded)
  }

  /** Its own screen back, if this connection had it dark. */
  function privacyOff() {
    const pr = p.privacy
    if (!pr || pr.owner !== me) return
    pr.cover(false)
    pr.owner = null
    log?.info(`this PC's own screen is back on (privacy mode off for ${o.from.name})`)
  }

  /** Every key and button this connection holds down, let go: ordinary keys first, then modifiers. */
  function releaseAll() {
    const input = p.input
    if (!input) return
    const keys = [...heldScan].sort((a, b) => Number(MODIFIER_SCAN.has(a)) - Number(MODIFIER_SCAN.has(b)))
    for (const code of keys) input.scanKey(code, false)
    for (const vk of heldVk) input.vkKey(vk, false)
    for (const b of heldButtons) input.button(b, false)
    heldScan.clear()
    heldVk.clear()
    heldButtons.clear()
  }

  // --- text focus (F-017) ------------------------------------------------------------------------

  /** The viewer's {"watch": true|false}: from then on, each change goes back as {"editable": …}. */
  function onPlugin(r: NonNullable<NonNullable<In['misc']>['plugin_request']>) {
    if (r.id !== TEXT_FOCUS_PLUGIN || !p.textFocus) return
    let watch: unknown
    try {
      watch = (JSON.parse(Buffer.from(r.content).toString('utf8')) as { watch?: unknown } | null)?.watch
    } catch {
      return
    }
    if (watch === true && !focusWatch) {
      focusWatch = p.textFocus.watch(editable =>
        send({ misc: { plugin_request: { id: TEXT_FOCUS_PLUGIN, content: Buffer.from(JSON.stringify({ editable })) } } }),
      )
    } else if (watch === false) {
      focusWatch?.stop()
      focusWatch = null
    }
  }

  // --- the stream ------------------------------------------------------------------------------

  function onMessage(payload: Uint8Array) {
    const m = o.schema.decode(payload) as In | null
    if (!m) return
    switch (m.union) {
      case 'login_request':
        return void onLogin(m.login_request!)
      case 'test_delay': {
        const d = m.test_delay!
        // The viewer's own goes straight back (connection.rs:3086-3091); ours tells the delay.
        if (d.from_client) return send({ test_delay: { time: d.time, from_client: true } })
        lastDelay = Math.max(0, Math.min(2 ** 31, Date.now() - Number(d.time)))
        return
      }
    }
    if (phase !== 'live') return
    switch (m.union) {
      case 'mouse_event':
        return onMouse(m.mouse_event!)
      case 'key_event':
        return onKey(m.key_event!)
      case 'clipboard':
        return onClipboard([m.clipboard!])
      case 'multi_clipboards':
        return onClipboard(m.multi_clipboards!.clipboards)
      case 'misc': {
        const misc = m.misc!
        if (misc.union === 'close_reason') return close('The viewer disconnected', false)
        if (misc.union === 'refresh_video' || misc.union === 'refresh_video_display') return refresh()
        if (misc.union === 'switch_display' && misc.switch_display) return switchDisplay(misc.switch_display.display)
        if (misc.union === 'toggle_privacy_mode' && misc.toggle_privacy_mode) return togglePrivacy(misc.toggle_privacy_mode)
        if (misc.union === 'plugin_request' && misc.plugin_request) return onPlugin(misc.plugin_request)
        return
      }
    }
  }

  function onData(chunk: Buffer) {
    lastHeard = Date.now()
    let payloads: Uint8Array[]
    try {
      payloads = deframer.push(chunk)
    } catch {
      return close('The viewer sent something unreadable')
    }
    for (const payload of payloads) {
      if (phase !== 'live' && payload.length > MAX_UNAUTHORIZED) return close('Too large a message before login')
      onMessage(payload)
      if (phase === 'closed') return
    }
    if (phase !== 'live' && deframer.pending > MAX_UNAUTHORIZED) close('Too large a message before login')
  }

  function close(reason: string, tell = true) {
    if (phase === 'closed') return
    const wasLive = phase === 'live'
    try {
      releaseAll()
    } catch (e) {
      log?.warn(`letting go of keys: ${e instanceof Error ? e.message : String(e)}`)
    }
    capture?.stop()
    capture = null
    // The connection that turned it on is gone: so is the dark screen (connection.rs:1216-1219).
    privacyOff()
    focusWatch?.stop()
    focusWatch = null
    for (const timer of timers) clearInterval(timer)
    if (tell) send({ misc: { close_reason: reason } })
    phase = 'closed'
    o.stream.end()
    setTimeout(() => o.stream.destroy(), 2000).unref()
    if (wasLive) log?.info(`${o.from.name} stopped controlling this PC (${reason})`)
    o.onClose?.(reason)
  }

  o.stream.on('data', onData)
  o.stream.on('end', () => close('The viewer went away', false))
  o.stream.on('error', e => close(e.message, false))
  o.stream.on('close', () => close('The link closed', false))

  return {
    close,
    get loggedIn() {
      return phase === 'live'
    },
  }
}
