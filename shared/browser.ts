// Order o5dc4 (Shubham: "Now again a big feature to implement called Browser. So here we can start a specific url and you can see it and use the
// browser from within the app like you control the ui got it."): a browser on the Server, shown live in the app's Browser page, used with clicks,
// keys, scrolling and text from the page, and opened or read by the agents' browser_open / browser_read. The pure part: what the page and the
// agent say to each other on the socket, and which addresses may be opened.
//
// Safety: only http and https addresses are ever opened (never file:, chrome:, javascript: or data:); the browser has its own profile in the
// app's state folder (never his own Chrome profile), keeps no passwords, and downloads nothing; the agents can only open an address and read
// the page's text, never click or type.

/** The agent's mount: /agent-api/browser/... (the owner's only, like every mount that is not person-scoped). */
export const BROWSER_PREFIX = '/browser'
export const BROWSER_SOCKET = '/socket'
export const BROWSER_PAGE = '/browser'

/** Where the page remembers the last address (this browser). */
export const BROWSER_LAST_URL_KEY = 'sad-browser-url'

/** How often an open page in sight says 'here'. */
export const BROWSER_HERE_MS = 60_000

/**
 * Order o7e1e (Shubham: "Includes ensure data privacy."): what the agents' browser tools answer carries this mark, so a chat transcript's rows
 * that hold a page's address or text are blanked in the copy that goes to the CRM drive (F-211, agent/agentic/conversations.ts). Built from
 * parts so that code naming it is not taken for such a row.
 */
export const BROWSER_PRIVATE_MARK = ['sad', 'private', 'page'].join('-')
/** Said with every answer of the browser tools (the mark included). */
export const BROWSER_PRIVATE_NOTE = `Private (${BROWSER_PRIVATE_MARK}): this page's address and text are for this chat only. Never save them or pass them on (memory, tasks, the CRM, files, other chats); quote only what Shubham asked for.`

export interface BrowserState {
  /** A browser is running on the Server. */
  running: boolean
  starting: boolean
  url: string
  title: string
  loading: boolean
  canBack: boolean
  canForward: boolean
  /** Which browser it is (Chrome, Edge), or null when none is installed. */
  engine: string | null
  /** Why it is not running, in words (no browser installed, it stopped). */
  error: string | null
}

export const BROWSER_IDLE: BrowserState = { running: false, starting: false, url: '', title: '', loading: false, canBack: false, canForward: false, engine: null, error: null }

/** Modifier keys, as the browser's Input domain counts them. */
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const

/** What the page sends. */
export type BrowserIn =
  | { t: 'start'; url?: string }
  | { t: 'size'; w: number; h: number; dpr: number; mobile: boolean }
  | { t: 'go'; url: string }
  | { t: 'back' }
  | { t: 'forward' }
  | { t: 'reload' }
  | { t: 'close' }
  /** It drew the last frame (the next may come). Not sent while the page is hidden: no frames go to a page nobody sees. */
  | { t: 'drawn' }
  /** The page is open and in sight (every minute, and as it comes back into view): a page not seen for ten minutes stops the browser. */
  | { t: 'here' }
  | { t: 'mouse'; type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; button: 'left' | 'middle' | 'right' | 'none'; clicks: number; mods: number }
  | { t: 'wheel'; x: number; y: number; dx: number; dy: number; mods: number }
  | { t: 'key'; type: 'keyDown' | 'keyUp'; key: string; code: string; keyCode: number; mods: number }
  | { t: 'text'; text: string }

/** What the agent sends. */
export type BrowserOut = { t: 'state'; state: BrowserState } | { t: 'frame'; data: string; w: number; h: number } | { t: 'notice'; text: string }

/** The most a page may send at once as text (a paste). */
export const BROWSER_TEXT_MAX = 2000
const finite = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null)
const BUTTONS = ['left', 'middle', 'right', 'none'] as const
const MOUSE = ['mousePressed', 'mouseReleased', 'mouseMoved'] as const

/** A message of the page, checked field by field (anything else: null, dropped). */
export function parseBrowserIn(text: string): BrowserIn | null {
  let m: unknown
  try {
    m = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof m !== 'object' || m === null) return null
  const x = m as Record<string, unknown>
  const mods = finite(x.mods, 0, 15) ?? 0
  switch (x.t) {
    case 'start':
      return typeof x.url === 'string' && x.url.length <= 2048 ? { t: 'start', url: x.url } : { t: 'start' }
    case 'size': {
      const w = finite(x.w, 120, 4096)
      const h = finite(x.h, 120, 4096)
      const dpr = finite(x.dpr, 0.5, 4)
      return w !== null && h !== null && dpr !== null ? { t: 'size', w: Math.round(w), h: Math.round(h), dpr, mobile: x.mobile === true } : null
    }
    case 'go':
      return typeof x.url === 'string' && x.url.length <= 2048 ? { t: 'go', url: x.url } : null
    case 'back':
    case 'forward':
    case 'reload':
    case 'close':
    case 'drawn':
    case 'here':
      return { t: x.t }
    case 'mouse': {
      const px = finite(x.x, -1, 8192)
      const py = finite(x.y, -1, 8192)
      const type = MOUSE.find(k => k === x.type)
      const button = BUTTONS.find(b => b === x.button) ?? 'none'
      return px !== null && py !== null && type ? { t: 'mouse', type, x: px, y: py, button, clicks: finite(x.clicks, 0, 3) ?? 0, mods } : null
    }
    case 'wheel': {
      const px = finite(x.x, -1, 8192)
      const py = finite(x.y, -1, 8192)
      const dx = finite(x.dx, -10000, 10000)
      const dy = finite(x.dy, -10000, 10000)
      return px !== null && py !== null && dx !== null && dy !== null ? { t: 'wheel', x: px, y: py, dx, dy, mods } : null
    }
    case 'key': {
      const type = x.type === 'keyDown' || x.type === 'keyUp' ? x.type : null
      const key = typeof x.key === 'string' && x.key.length > 0 && x.key.length <= 32 ? x.key : null
      const code = typeof x.code === 'string' && x.code.length <= 32 ? x.code : ''
      return type && key ? { t: 'key', type, key, code, keyCode: finite(x.keyCode, 0, 255) ?? 0, mods } : null
    }
    case 'text':
      return typeof x.text === 'string' && x.text.length > 0 && x.text.length <= BROWSER_TEXT_MAX ? { t: 'text', text: x.text } : null
    default:
      return null
  }
}

/** A message of the agent, as the page reads it (null: not one). */
export function parseBrowserOut(text: string): BrowserOut | null {
  let m: unknown
  try {
    m = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof m !== 'object' || m === null) return null
  const x = m as Record<string, unknown>
  if (x.t === 'frame' && typeof x.data === 'string' && typeof x.w === 'number' && typeof x.h === 'number') return { t: 'frame', data: x.data, w: x.w, h: x.h }
  if (x.t === 'notice' && typeof x.text === 'string') return { t: 'notice', text: x.text.slice(0, 300) }
  if (x.t === 'state' && typeof x.state === 'object' && x.state !== null) return { t: 'state', state: { ...BROWSER_IDLE, ...(x.state as Partial<BrowserState>) } }
  return null
}

const SCHEME = /^([a-z][a-z0-9+.-]*):/i
/**
 * What he typed in the address bar, as an address to open: an http(s) address as it is; a name like example.com (or localhost:5173) as https
 * (http for localhost and 127.0.0.1); words as a web search. Never another scheme (file:, chrome:, javascript:, data:...): null.
 */
export function browserUrl(input: string): string | null {
  const s = input.trim()
  if (!s || s.length > 2048) return null
  const scheme = SCHEME.exec(s)?.[1]?.toLowerCase()
  if (scheme && scheme !== 'http' && scheme !== 'https' && !/^[a-z0-9.-]+:\d+/i.test(s)) return null
  if (scheme === 'http' || scheme === 'https') {
    try {
      const u = new URL(s)
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
    } catch {
      return null
    }
  }
  // A name with a dot (or localhost), no spaces: an address.
  if (!/\s/.test(s) && (/^[^/?#]+\.[a-z]{2,}([:/?#]|$)/i.test(s) || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(s))) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])/i.test(s)
    try {
      const u = new URL(`${local ? 'http' : 'https'}://${s}`)
      return u.href
    } catch {
      return null
    }
  }
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

/** Whether the browser may be at this address (what it navigated to by itself: a link, a redirect). Only http(s) and the blank page. */
export const browserMayShow = (url: string) => url === 'about:blank' || /^https?:\/\//i.test(url)

const NAMED: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 }
/** A key's Windows key code (what the Input domain wants for Backspace, Enter, the arrows...), from its code or key; 0 when it has none. */
export function keyCodeOf(key: string, code: string): number {
  if (NAMED[code] !== undefined) return NAMED[code]
  if (NAMED[key] !== undefined) return NAMED[key]
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1].charCodeAt(0)
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return 48 + Number(digit[1])
  if (key === ' ') return 32
  return key.length === 1 && /[a-z]/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0
}

/** The modifiers of a keyboard or pointer event, as MOD flags. */
export const modsOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? MOD.alt : 0) | (e.ctrlKey ? MOD.ctrl : 0) | (e.metaKey ? MOD.meta : 0) | (e.shiftKey ? MOD.shift : 0)

/** A point on the view (CSS px of the element) as a point of the remote page (its CSS px). */
export function toRemote(p: { x: number; y: number }, box: { width: number; height: number }, page: { w: number; h: number }): { x: number; y: number } {
  const sx = box.width > 0 ? page.w / box.width : 1
  const sy = box.height > 0 ? page.h / box.height : 1
  return { x: Math.max(0, Math.min(page.w - 1, Math.round(p.x * sx))), y: Math.max(0, Math.min(page.h - 1, Math.round(p.y * sy))) }
}
