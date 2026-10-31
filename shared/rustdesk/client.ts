import { Deframer, frame } from './bytes-codec.ts'
import { decompress } from './fzstd.js'
import { CAPS_KEYS, LEGACY_CONTROL, MODIFIER_KEYS, NUM_KEYS, WIN_SCANCODE } from './keys.ts'
import {
  BoolOption,
  ClipboardFormat,
  ControlKey,
  KeyboardMode,
  Permission,
  PreferCodec,
  PrivacyModeState,
  TEXT_FOCUS_PLUGIN,
  type Clipboard,
  type CursorData,
  type DisplayInfo,
  type Incoming,
  type KeyEventOut,
  type Outgoing,
  type PeerInfo,
  type Schema,
} from './schema.ts'

// The controlling side of RustDesk's peer protocol, for the in-app viewer (F-005). Every
// rule here is in design/features/F-005-protocol.md, with where RustDesk 1.5.0 does it.
//
// It knows nothing of the transport, the screen or the DOM: bytes come in through receive(),
// go out through `send`, and everything worth showing comes out as events. So the browser
// wires it to a WebSocket and WebCodecs, and the tests to a stand-in controlled side.

export type Codec = 'vp9' | 'vp8' | 'av1' | 'h264' | 'h265'

/** What this browser can decode (VideoDecoder.isConfigSupported). VP9 is the one we ask for. */
export type Decodings = Record<'vp9' | 'vp8' | 'av1' | 'h264', boolean>

export type Phase =
  /** Waiting for the other PC's Hash. */
  | { name: 'opening' }
  /** Its password is needed; `error` says why it is asked again. */
  | { name: 'password'; error: string | null }
  | { name: 'logging-in' }
  /** Someone at that PC must accept (or the password was refused and they still may). */
  | { name: 'waiting-accept' }
  /** Its two-factor code is needed. */
  | { name: 'code'; error: string | null }
  | { name: 'connected' }
  | { name: 'closed'; reason: string; by: 'me' | 'peer' | 'error' }

export interface Display {
  index: number
  x: number
  y: number
  width: number
  height: number
  name: string
  /** The picture already shows the pointer, so the viewer draws none. */
  cursorEmbedded: boolean
}

export interface VideoChunk {
  codec: Codec
  data: Uint8Array
  key: boolean
  /** Milliseconds, the encoder's own clock. */
  pts: number
  display: number
}

export interface CursorShape {
  id: string
  hotx: number
  hoty: number
  width: number
  height: number
  rgba: Uint8Array
}

export interface ClientEvents {
  phase?(phase: Phase): void
  /** After login, and whenever the other PC's displays change. */
  peer?(peer: PeerInfo, displays: Display[]): void
  /** The display being shown, or its size, changed: start a new decoder. */
  display?(display: Display): void
  video?(chunk: VideoChunk): void
  /** A new shape (with pixels), or one sent before (id only). */
  cursor?(shape: CursorShape | { id: string }): void
  clipboard?(text: string): void
  permission?(name: 'keyboard' | 'clipboard', enabled: boolean): void
  /** A MessageBox from the other PC. */
  notice?(notice: { type: string; title: string; text: string }): void
  /**
   * Privacy mode's answer (F-012): that PC's own screen is dark (`on`) or not, and why a toggle
   * didn't happen. After NotSupported, privacySupported is false.
   */
  privacy?(state: { on: boolean; error: string | null }): void
  rtt?(ms: number): void
  /** F-017, once watchTextFocus(true) was sent: a text box on that PC has the keyboard focus now, or not. Only the app's own screen says. */
  textFocus?(editable: boolean): void
}

export interface ClientOptions {
  schema: Schema
  /** Writes bytes to the other PC. */
  send(bytes: Uint8Array): void
  /** Ends the transport (after close() or a fatal error). */
  end(): void
  /** Shown on the other PC: who is connecting. */
  me: { id: string; name: string }
  decodings: Decodings
  events: ClientEvents
}

export type Modifiers = { alt?: boolean; ctrl?: boolean; shift?: boolean; meta?: boolean }
export type Button = 'left' | 'right' | 'middle' | 'back' | 'forward'

export interface KeyInput extends Modifiers {
  /** KeyboardEvent.code: the physical key. */
  code: string
  /** KeyboardEvent.key: what it types, for the legacy fallback. */
  key: string
  down: boolean
  capsLock?: boolean
  numLock?: boolean
}

// RustDesk's own strings (client.rs:114-119; connection.rs).
const WRONG_PASSWORD = 'Wrong Password'
const EMPTY_PASSWORD = 'Empty Password'
const NO_PASSWORD_ACCESS = 'No Password Access'
const REQUIRE_2FA = '2FA Required'
const WRONG_2FA = 'Wrong 2FA Code'

// Privacy mode on by another connection (connection.rs:1400-1404, io_loop.rs:2490-2497).
const PRIVACY_ON_BY_OTHER = 'Someone turns on privacy mode, exit'
/** The end of a connection when someone else has that PC's screen dark. */
export const PRIVACY_BUSY_TEXT = 'Someone else is using that PC with its screen off, so it can’t be shared right now.'

/** The password phase's error when that PC said "Wrong Password", and only then. */
export const WRONG_PASSWORD_TEXT = "That password isn't right."

/** What the viewer claims to be (see the protocol notes, § 3, for what it turns on). */
export const VERSION = '1.5.0'
export const PLATFORM = 'WebDesktop'
/** Any IP string passes the controlled side's check; this is where the hub agent dials. */
export const USERNAME = '127.0.0.1:21118'

const OPEN_TIMEOUT_MS = 10_000
const SILENCE_MS = 20_000
const PING_MS = 3000
const REFRESH_GAP_MS = 1000
/** Shapes are at most 512×512 (io_loop.rs:2794). */
const MAX_CURSOR = 512
const MAX_CLIPBOARD = 32 * 1024 * 1024

const BUTTON: Record<Button, number> = { left: 1, right: 2, middle: 4, back: 8, forward: 16 }
const MOUSE = { move: 0, down: 1, up: 2, wheel: 3 } as const
const CODEC: Partial<Record<string, Codec>> = { vp9s: 'vp9', vp8s: 'vp8', av1s: 'av1', h264s: 'h264', h265s: 'h265' }

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder()

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}
const sha256 = async (data: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-256', data))

/**
 * SHA256(password ‖ salt): what RustDesk's own client keeps for "Remember password"
 * (client.rs:4818-4848, saved at login in handle_peer_info, 3681-3715). It logs in again with
 * any later challenge, so it is as good as the password for that PC.
 */
export const passwordH1 = (password: string, salt: string) => sha256(concat(utf8.encode(password), utf8.encode(salt)))

/** SHA256(H1 ‖ challenge): LoginRequest.password for one connection (client.rs:4740-4750). */
export const loginDigest = (h1: Uint8Array, challenge: string) => sha256(concat(h1, utf8.encode(challenge)))

/** SHA256(SHA256(password ‖ salt) ‖ challenge): LoginRequest.password (client.rs:4684-4752). */
export async function passwordHash(password: string, salt: string, challenge: string) {
  return loginDigest(await passwordH1(password, salt), challenge)
}

/** "1.2.4" → 1002004, as hbb_common's get_version_number compares them. */
export function versionNumber(v: string) {
  let n = 0
  for (const part of v.split('.').slice(0, 3)) n = n * 1000 + (parseInt(part, 10) || 0)
  return n * 1000 ** Math.max(0, 3 - v.split('.').length)
}

export type RemoteClient = ReturnType<typeof createClient>

export function createClient(o: ClientOptions) {
  const deframer = new Deframer()
  let phase: Phase = { name: 'opening' }
  let hash: { salt: string; challenge: string } | null = null
  let peer: PeerInfo | null = null
  let displays: Display[] = []
  let current = 0
  let keyboard = true
  let clipboard = true
  // It answered a privacy toggle with NotSupported (F-012).
  let privacyRefused = false
  let lastHeard = Date.now()
  let lastRefresh = 0
  // Kept for the connection: a second login must name the same session (connection.rs:2771-2791).
  const sessionId = Math.floor(Math.random() * 2 ** 52)
  // Keys and buttons the other PC holds down because of us, so they can all be let go.
  const keysDown = new Map<string, KeyEventOut>()
  const buttonsDown = new Set<Button>()
  let lastPoint = { x: 0, y: 0 }

  // Read through functions: `phase` changes under an await or a nested call, which narrowing can't see.
  const closed = () => phase.name === 'closed'
  const settled = () => phase.name === 'closed' || phase.name === 'connected'
  const setPhase = (next: Phase) => {
    phase = next
    o.events.phase?.(next)
  }
  const out = (msg: Outgoing) => {
    if (phase.name !== 'closed') o.send(frame(o.schema.encode(msg)))
  }
  const misc = (m: Extract<Outgoing, { misc: unknown }>['misc']) => out({ misc: m })

  const finish = (reason: string, by: 'me' | 'peer' | 'error') => {
    if (phase.name === 'closed') return
    clearInterval(timer)
    setPhase({ name: 'closed', reason, by })
    o.end()
  }

  // Once a second: give up on a peer that never opens or goes quiet, and measure the round trip.
  let ticks = 0
  const timer = setInterval(() => {
    const quiet = Date.now() - lastHeard
    if (phase.name === 'opening' && quiet > OPEN_TIMEOUT_MS) return finish("That PC's RustDesk didn't answer", 'error')
    if (quiet > SILENCE_MS) return finish('That PC stopped answering', 'error')
    if (phase.name === 'connected' && ++ticks % (PING_MS / 1000) === 0) out({ test_delay: { time: Date.now(), from_client: true } })
  }, 1000)

  // --- incoming ----------------------------------------------------------------------------

  function onMessage(payload: Uint8Array) {
    const m = o.schema.decode(payload)
    if (!m) return
    switch (m.union) {
      case 'hash':
        return onHash(m.hash!)
      case 'test_delay':
        // Theirs goes straight back as it came (client.rs:4278-4284); ours carries our clock.
        if (!m.test_delay!.from_client) return o.send(frame(payload))
        if (phase.name === 'connected') o.events.rtt?.(Math.max(0, Date.now() - Number(m.test_delay!.time)))
        return
      case 'login_response':
        return onLoginResponse(m.login_response!)
      case 'video_frame':
        return onVideo(m.video_frame!)
      case 'cursor_data':
        return onCursor(m.cursor_data!)
      case 'cursor_id':
        return o.events.cursor?.({ id: m.cursor_id! })
      case 'clipboard':
        return onClipboard([m.clipboard!])
      case 'multi_clipboards':
        return onClipboard(m.multi_clipboards!.clipboards)
      case 'misc':
        return onMisc(m.misc!)
      case 'peer_info':
        if (peer) return setPeer({ ...peer, displays: m.peer_info!.displays })
        return
      case 'message_box': {
        const b = m.message_box!
        return o.events.notice?.({ type: b.msgtype, title: b.title, text: b.text })
      }
    }
  }

  function onHash(h: { salt: string; challenge: string }) {
    hash = h
    if (phase.name === 'opening') setPhase({ name: 'password', error: null })
  }

  function onLoginResponse(r: NonNullable<Incoming['login_response']>) {
    if (phase.name === 'connected' || phase.name === 'closed') return
    if (r.union === 'peer_info' && r.peer_info) {
      setPeer(r.peer_info)
      current = Math.min(Math.max(0, r.peer_info.current_display), Math.max(0, displays.length - 1))
      setPhase({ name: 'connected' })
      // An RDP-shared PC with several sessions waits for us to pick one (connection.rs:2264-2287).
      const ws = r.peer_info.windows_sessions
      if (ws && ws.sessions.length > 1) misc({ selected_sid: ws.current_sid })
      if (displays[current]) o.events.display?.(displays[current])
      return
    }
    const error = r.error ?? ''
    if (error === WRONG_PASSWORD) setPhase({ name: 'password', error: WRONG_PASSWORD_TEXT })
    else if (error === EMPTY_PASSWORD) setPhase({ name: 'password', error: null })
    else if (error === NO_PASSWORD_ACCESS) setPhase({ name: 'waiting-accept' })
    else if (error === REQUIRE_2FA) setPhase({ name: 'code', error: null })
    else if (error === WRONG_2FA) setPhase({ name: 'code', error: "That code isn't right." })
    else if (error === PRIVACY_ON_BY_OTHER) finish(PRIVACY_BUSY_TEXT, 'peer')
    else if (/^Too many wrong attempts|^Please try 1 minute later/.test(error)) {
      // The connection stays open; the other PC counts tries per address (connection.rs:4432-4520).
      setPhase({ name: 'password', error: `${error}. That PC is refusing passwords for now.` })
    } else finish(error || 'That PC refused the login', 'peer')
  }

  function setPeer(p: PeerInfo) {
    peer = p
    displays = p.displays.map((d: DisplayInfo, index) => ({
      index,
      x: d.x,
      y: d.y,
      width: d.width,
      height: d.height,
      name: d.name,
      cursorEmbedded: d.cursor_embedded,
    }))
    o.events.peer?.(p, displays)
  }

  function onVideo(v: NonNullable<Incoming['video_frame']>) {
    if (phase.name !== 'connected' || v.display !== current) return
    const codec = v.union && CODEC[v.union]
    const frames = v.union && v[v.union]?.frames
    if (!codec || !frames) return
    for (const f of frames) o.events.video?.({ codec, data: f.data, key: f.key, pts: Number(f.pts), display: v.display })
  }

  function onCursor(c: CursorData) {
    const { width: w, height: h, hotx, hoty } = c
    // The same checks as RustDesk's own decode_cursor_data (io_loop.rs:2790-2828).
    if (!(w >= 1 && w <= MAX_CURSOR && h >= 1 && h <= MAX_CURSOR && hotx >= 0 && hotx < w && hoty >= 0 && hoty < h)) return
    let rgba: Uint8Array
    try {
      rgba = decompress(c.colors, new Uint8Array(w * h * 4))
    } catch {
      return
    }
    if (rgba.length !== w * h * 4) return
    o.events.cursor?.({ id: c.id, hotx, hoty, width: w, height: h, rgba })
  }

  function onClipboard(items: Clipboard[]) {
    if (!clipboard) return
    const text = items.find(c => c.format === ClipboardFormat.Text)
    if (!text || text.content.length > MAX_CLIPBOARD) return
    try {
      const bytes = text.compress ? decompress(text.content) : text.content
      if (bytes.length <= MAX_CLIPBOARD) o.events.clipboard?.(fromUtf8.decode(bytes))
    } catch {
      // A broken item is dropped, as RustDesk's own decompress gives up (hbb_common compress.rs).
    }
  }

  function onMisc(m: NonNullable<Incoming['misc']>) {
    if (m.union === 'close_reason') return finish(m.close_reason || 'The other PC closed the connection', 'peer')
    if (m.union === 'back_notification' && m.back_notification) return onBackNotification(m.back_notification)
    if (m.union === 'permission_info' && m.permission_info) {
      const { permission, enabled } = m.permission_info
      if (permission === Permission.Keyboard) {
        keyboard = enabled
        o.events.permission?.('keyboard', enabled)
      } else if (permission === Permission.Clipboard) {
        clipboard = enabled
        o.events.permission?.('clipboard', enabled)
      }
      return
    }
    if (m.union === 'plugin_request' && m.plugin_request?.id === TEXT_FOCUS_PLUGIN) {
      try {
        const { editable } = JSON.parse(fromUtf8.decode(m.plugin_request.content)) as { editable?: unknown }
        if (typeof editable === 'boolean') o.events.textFocus?.(editable)
      } catch {
        // Not ours after all: left alone, as any plugin message we don't know.
      }
      return
    }
    if (m.union === 'switch_display' && m.switch_display) {
      const s = m.switch_display
      const known = displays[s.display]
      const d: Display = {
        index: s.display,
        x: s.x,
        y: s.y,
        width: s.width > 0 ? s.width : (known?.width ?? 0),
        height: s.height > 0 ? s.height : (known?.height ?? 0),
        name: known?.name ?? '',
        cursorEmbedded: s.cursor_embedded,
      }
      displays[s.display] = d
      current = s.display
      o.events.display?.(d)
    }
  }

  /** Privacy mode's answers, as RustDesk's handle_back_msg_privacy_mode reads them (io_loop.rs:2483-2560). */
  function onBackNotification(b: NonNullable<NonNullable<Incoming['misc']>['back_notification']>) {
    if (b.union !== 'privacy_mode_state') return
    const tell = (on: boolean, error: string | null = null) => o.events.privacy?.({ on, error })
    switch (b.privacy_mode_state) {
      case PrivacyModeState.OnByOther:
        return finish(PRIVACY_BUSY_TEXT, 'peer')
      case PrivacyModeState.OnSucceeded:
        return tell(true)
      case PrivacyModeState.OffSucceeded:
      case PrivacyModeState.OffByPeer:
      case PrivacyModeState.OffUnknown:
        return tell(false)
      case PrivacyModeState.NotSupported:
        privacyRefused = true
        return tell(false, "That PC can't keep its screen dark.")
      case PrivacyModeState.OnFailedDenied:
        return tell(false, 'That PC said no.')
      case PrivacyModeState.OnFailed:
      case PrivacyModeState.OnFailedPlugin:
        return tell(false, b.details || "That PC couldn't turn its screen off.")
      case PrivacyModeState.OffFailed:
        return tell(true, b.details || "That PC couldn't turn its screen back on.")
    }
  }

  const privacySupported = () => Boolean(peer?.features?.privacy_mode) && !privacyRefused

  /** The first way that PC offers (PeerInfo.platform_additions, connection.rs:1975-1983); '' lets it pick. */
  function privacyImpl(): string {
    try {
      const list = (JSON.parse(peer?.platform_additions || '{}') as { supported_privacy_mode_impl?: unknown }).supported_privacy_mode_impl
      const first: unknown = Array.isArray(list) ? list[0] : null
      return Array.isArray(first) && typeof first[0] === 'string' ? first[0] : ''
    } catch {
      return ''
    }
  }

  // --- outgoing ----------------------------------------------------------------------------

  async function login(password: string) {
    if (!hash || settled()) return
    const h = hash
    // An empty password asks the person at that PC to accept instead (client.rs:4745-4748).
    sendLogin(password ? await passwordHash(password, h.salt, h.challenge) : new Uint8Array(0))
  }

  function sendLogin(digest: Uint8Array) {
    if (!hash || settled()) return
    setPhase(digest.length ? { name: 'logging-in' } : { name: 'waiting-accept' })
    const d = o.decodings
    out({
      login_request: {
        username: USERNAME,
        password: digest,
        my_id: o.me.id,
        my_name: o.me.name,
        my_platform: PLATFORM,
        version: VERSION,
        session_id: sessionId,
        option: {
          supported_decoding: {
            ability_vp9: d.vp9 ? 1 : 0,
            ability_vp8: d.vp8 ? 1 : 0,
            ability_av1: d.av1 ? 1 : 0,
            ability_h264: d.h264 ? 1 : 0,
            ability_h265: 0,
            prefer: d.vp9 ? PreferCodec.VP9 : PreferCodec.Auto,
          },
          // Phase 1 plays no sound, so none is sent.
          disable_audio: BoolOption.Yes,
        },
      },
    })
  }

  const legacyMods = (m: Modifiers) => {
    const mods: number[] = []
    if (m.alt) mods.push(ControlKey.Alt)
    if (m.shift) mods.push(ControlKey.Shift)
    if (m.ctrl) mods.push(ControlKey.Control)
    if (m.meta) mods.push(ControlKey.Meta)
    return mods
  }

  const windowsPeer = () => peer?.platform === 'Windows'
  const canInput = () => phase.name === 'connected' && keyboard

  /** A key going down or up. Returns false when it isn't sent (unknown, or input is off). */
  function key(k: KeyInput): boolean {
    if (!canInput()) return false
    let ev: KeyEventOut | null = null
    if (k.code === 'Pause') {
      // No usable scan code on Windows; RustDesk sends it as a control key (keyboard.rs:1256-1290).
      ev = { mode: KeyboardMode.Legacy, control_key: ControlKey.Pause, down: k.down, modifiers: legacyMods(k) }
    } else if (windowsPeer()) {
      const chr = WIN_SCANCODE[k.code]
      if (chr === undefined) return false
      const modifiers: number[] = []
      if (k.capsLock && CAPS_KEYS.has(k.code)) modifiers.push(ControlKey.CapsLock)
      if (k.numLock && NUM_KEYS.has(k.code)) modifiers.push(ControlKey.NumLock)
      ev = { mode: KeyboardMode.Map, chr, down: k.down, modifiers }
    } else {
      ev = legacyKey(k)
      if (!ev) return false
    }
    out({ key_event: ev })
    if (ev.press) return true
    if (k.down) keysDown.set(k.code, ev)
    else keysDown.delete(k.code)
    return true
  }

  // Legacy mode for a peer without scan-code tables here: named keys go down and up, text is
  // typed as it is, and a shortcut sends its letter with the modifiers held.
  function legacyKey(k: KeyInput): KeyEventOut | null {
    const control = LEGACY_CONTROL[k.code]
    if (control !== undefined) return { mode: KeyboardMode.Legacy, control_key: control, down: k.down, modifiers: legacyMods(k) }
    if ([...k.key].length !== 1) return null
    const ch = k.key.codePointAt(0)!
    if (k.ctrl || k.alt || k.meta) return { mode: KeyboardMode.Legacy, chr: k.key.toLowerCase().codePointAt(0)!, down: k.down, modifiers: legacyMods(k) }
    return k.down ? { mode: KeyboardMode.Legacy, unicode: ch, press: true } : null
  }

  /** Lets go of every key and button we hold on the other PC: focus left the screen, or we close. */
  function releaseAll() {
    if (phase.name !== 'connected') {
      keysDown.clear()
      buttonsDown.clear()
      return
    }
    // Ordinary keys first, then the modifiers, so nothing turns into a shortcut on the way up.
    const order = [...keysDown.keys()].sort((a, b) => Number(MODIFIER_KEYS.has(a)) - Number(MODIFIER_KEYS.has(b)))
    for (const code of order) out({ key_event: { ...keysDown.get(code)!, down: false } })
    keysDown.clear()
    for (const b of buttonsDown) out({ mouse_event: { mask: (BUTTON[b] << 3) | MOUSE.up, x: lastPoint.x, y: lastPoint.y } })
    buttonsDown.clear()
  }

  /**
   * A point on the shown display, as a fraction of its width and height (0..1), in the other
   * PC's virtual-desktop pixels: the display's origin plus the point, clamped to it; on Windows
   * the right and bottom edges are inclusive (input_model.dart:2058-2105).
   */
  function toRemote(fx: number, fy: number) {
    const d = displays[current]
    if (!d) return null
    const edge = windowsPeer() ? 0 : 1
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
    return {
      x: clamp(d.x + Math.round(fx * d.width), d.x, d.x + d.width - edge),
      y: clamp(d.y + Math.round(fy * d.height), d.y, d.y + d.height - edge),
    }
  }

  function mouse(kind: 'move' | 'down' | 'up', fx: number, fy: number, button: Button = 'left', mods: Modifiers = {}) {
    if (!canInput()) return
    const p = toRemote(fx, fy)
    if (!p) return
    lastPoint = p
    const buttons = kind === 'move' ? 0 : BUTTON[button]
    if (kind === 'down') buttonsDown.add(button)
    if (kind === 'up') {
      if (!buttonsDown.has(button)) return
      buttonsDown.delete(button)
    }
    out({ mouse_event: { mask: (buttons << 3) | MOUSE[kind], x: p.x, y: p.y, modifiers: legacyMods(mods) } })
  }

  /** One wheel notch per call: dy 1 scrolls up, -1 down; dx 1 left, -1 right (input_model.dart:1660-1700). */
  function wheel(dx: -1 | 0 | 1, dy: -1 | 0 | 1, mods: Modifiers = {}) {
    if (!canInput() || (dx === 0 && dy === 0)) return
    out({ mouse_event: { mask: MOUSE.wheel, x: dx, y: dy, modifiers: legacyMods(mods) } })
  }

  return {
    get phase() {
      return phase
    },
    get peer() {
      return peer
    },
    get displays() {
      return displays
    },
    get current() {
      return current
    },
    get keyboard() {
      return keyboard
    },
    /** This connection's Hash, once the other PC has sent it: what a saved password answers. */
    get hash() {
      return hash
    },

    /** Bytes from the other PC, in any slices. */
    receive(chunk: Uint8Array) {
      if (phase.name === 'closed') return
      lastHeard = Date.now()
      let frames: Uint8Array[]
      try {
        frames = deframer.push(chunk)
      } catch (e) {
        return finish(`The other PC sent something unreadable (${e instanceof Error ? e.message : String(e)})`, 'error')
      }
      for (const f of frames) {
        onMessage(f)
        if (closed()) return
      }
    },

    /** The transport went away underneath us. */
    transportClosed(reason: string) {
      finish(reason, phase.name === 'connected' || phase.name === 'opening' ? 'error' : 'peer')
    },

    /** Logs in with that PC's RustDesk password. Not kept: only its hash for this connection is sent. */
    login,
    /** Logs in with this connection's digest, SHA256(H1 ‖ challenge), worked out from a saved H1 (F-008). */
    loginDigest(digest: Uint8Array) {
      if (digest.length === 32) sendLogin(digest)
    },
    /** Logs in without a password: the person at that PC is asked to accept. */
    askToAccept: () => login(''),
    /** The two-factor code that PC asked for. */
    sendCode(code: string) {
      if (phase.name !== 'code') return
      setPhase({ name: 'logging-in' })
      out({ auth_2fa: { code } })
    },

    key,
    mouse,
    wheel,
    releaseAll,

    /**
     * Text as it is, typed on the other PC: a phone's keyboard gives text rather than keys
     * (F-014). RustDesk's own soft keyboard sends it the same way, one KeyEvent with the text in
     * `seq` (ui_session_interface.rs input_string); the other PC types it (input_service.rs
     * legacy_keyboard_mode, key_sequence).
     */
    text(s: string) {
      if (!canInput() || !s) return
      out({ key_event: { mode: KeyboardMode.Legacy, seq: s, press: true } })
    },

    /** Ctrl+Alt+Del: the secure attention sequence on Windows (keyboard.rs:433-446). */
    ctrlAltDel() {
      if (!canInput()) return
      if (windowsPeer()) out({ key_event: { mode: KeyboardMode.Legacy, control_key: ControlKey.CtrlAltDel, down: true } })
      else out({ key_event: { mode: KeyboardMode.Legacy, control_key: ControlKey.Delete, press: true, modifiers: [ControlKey.Alt, ControlKey.Control] } })
    },

    /** Shows another display: switch, then capture only that one (ui_session_interface.rs:844-877). */
    switchDisplay(index: number) {
      if (phase.name !== 'connected' || !displays[index] || index === current) return
      releaseAll()
      current = index
      misc({ switch_display: { display: index, width: 0, height: 0 } })
      misc({ capture_displays: { set: [index] } })
      o.events.display?.(displays[index])
    },

    /**
     * F-017: ask that PC to say whenever a text box there gains or loses the keyboard focus (the
     * textFocus event), or to stop. Only the app's own screen answers; RustDesk leaves a plugin
     * message it doesn't know alone.
     */
    watchTextFocus(on: boolean) {
      if (phase.name !== 'connected') return
      misc({ plugin_request: { id: TEXT_FOCUS_PLUGIN, content: new TextEncoder().encode(JSON.stringify({ watch: on })) } })
    },

    /** Asks for a keyframe, at most once a second (client.rs:3536-3550). */
    refresh() {
      if (phase.name !== 'connected' || Date.now() - lastRefresh < REFRESH_GAP_MS) return false
      lastRefresh = Date.now()
      if (peer && versionNumber(peer.version) >= versionNumber('1.2.4')) misc({ refresh_video_display: current })
      else misc({ refresh_video: true })
      return true
    },

    /** That PC can keep its own screen dark while we use it (privacy mode, F-012: PeerInfo.features). */
    get privacySupported() {
      return privacySupported()
    },

    /**
     * That PC's own screen dark, or back on (TogglePrivacyMode, io_loop.rs:1340-1364); the answer
     * comes as a `privacy` event. False when it can't be asked.
     */
    setPrivacy(on: boolean) {
      if (phase.name !== 'connected' || !privacySupported()) return false
      misc({ toggle_privacy_mode: { impl_key: privacyImpl(), on } })
      return true
    },

    /** Puts this text on the other PC's clipboard, uncompressed (clipboard.rs:742-750). */
    sendClipboard(text: string) {
      if (phase.name !== 'connected' || !clipboard) return
      out({ clipboard: { compress: false, content: utf8.encode(text), format: ClipboardFormat.Text } })
    },

    /** Disconnect: let go of everything, say so, then end the transport (io_loop.rs:636-646). */
    close() {
      if (phase.name === 'closed') return
      releaseAll()
      misc({ close_reason: '' })
      finish('You disconnected', 'me')
    },
  }
}
