// Order o5dc4 (Shubham: "Now again a big feature to implement called Browser. So here we can start a specific url and you can see it and use the
// browser from within the app like you control the ui got it."): a browser on the Server, shown live in the app's Browser page, used with clicks,
// keys, scrolling and text from the page, and opened or read by the agents' browser_open / browser_read. The pure part: what the page and the
// agent say to each other on the socket, and which addresses may be opened.
//
// Safety: only http and https addresses are ever opened (never file:, chrome:, javascript: or data:); the browser has its own profile in the
// app's state folder (never his own Chrome profile), keeps no passwords, and downloads nothing; the agents can only open an address and read
// the page's text, never click or type.

import { cleanTailnetIp, cleanTailnetName } from './pc-ports.ts'

/** The agent's mount: /agent-api/browser/... (the owner's only, like every mount that is not person-scoped). */
export const BROWSER_PREFIX = '/browser'
export const BROWSER_SOCKET = '/socket'
export const BROWSER_PAGE = '/browser'

/** Where the page remembers the last address (this browser). Order o02a5: the PC side's (the key it always had); the phone side has its own. */
export const BROWSER_LAST_URL_KEY = 'sad-browser-url'
export const BROWSER_LAST_PHONE_URL_KEY = 'sad-browser-url-phone'

/** Order o9d97: which side he chose last ('pc' | 'phone'), kept in this browser. */
export const BROWSER_SIDE_KEY = 'sad-browser-side'
export type BrowserSide = 'pc' | 'phone'
export const readSide = (raw: string | null | undefined): BrowserSide => (raw === 'phone' ? 'phone' : 'pc')

/**
 * Order o9d97 (Shubham: "let the overlay control it like it does app control"): whether the Assistant may read and use the Browser's pages
 * (ui_screen / ui_control). On by default; 'off' is the old way (order o7e1e: the Browser's page was his alone, the Assistant never read or
 * touched it).
 */
export const BROWSER_ASSISTANT_KEY = 'sad-browser-assistant'
export const assistantMayUse = (raw: string | null | undefined) => raw !== 'off'

/** How often an open page in sight says 'here'. */
export const BROWSER_HERE_MS = 60_000

/** Order o02a5: at most this many tabs on a side (each is a page kept in memory). */
export const BROWSER_MAX_TABS = 8

/**
 * Order o7e1e (Shubham: "Includes ensure data privacy."): what the agents' browser tools answer carries this mark, so a chat transcript's rows
 * that hold a page's address or text are blanked in the copy that goes to the CRM drive (F-211, agent/agentic/conversations.ts). Built from
 * parts so that code naming it is not taken for such a row.
 */
export const BROWSER_PRIVATE_MARK = ['sad', 'private', 'page'].join('-')
/** Said with every answer of the browser tools (the mark included). */
export const BROWSER_PRIVATE_NOTE = `Private (${BROWSER_PRIVATE_MARK}): this page's address and text are for this chat only. Never save them or pass them on (memory, tasks, the CRM, files, other chats); quote only what Shubham asked for.`

/** Order o02a5 (Shubham: "Give it tabs separate for phone and PC."): one tab of a side's browser. */
export interface BrowserTab {
  /** The tab's id on its side (never shown: tabs are named by their place, "PC tab 2"). */
  id: string
  url: string
  title: string
  loading: boolean
  canBack: boolean
  canForward: boolean
}

export interface BrowserState {
  /** A browser is running on the Server. */
  running: boolean
  starting: boolean
  /** The open tab's address, title, loading and history (the same as tabs[active]: what an older page reads). */
  url: string
  title: string
  loading: boolean
  canBack: boolean
  canForward: boolean
  /** Which browser it is (Chrome, Edge), or null when none is installed. */
  engine: string | null
  /** Why it is not running, in words (no browser installed, it stopped). */
  error: string | null
  /** Order o02a5: its tabs, in order, and which one is open (null while none). An older agent sends none: one tab, the fields above. */
  tabs?: BrowserTab[]
  active?: string | null
}

export const BROWSER_IDLE: BrowserState = { running: false, starting: false, url: '', title: '', loading: false, canBack: false, canForward: false, engine: null, error: null }

/** The tabs of a state (an older agent's single page as one tab). */
export function tabsOf(s: BrowserState): { tabs: BrowserTab[]; active: string | null } {
  if (!s.running) return { tabs: [], active: null }
  if (Array.isArray(s.tabs) && s.tabs.length > 0) {
    const active = s.tabs.some(t => t.id === s.active) ? (s.active as string) : s.tabs[0].id
    return { tabs: s.tabs, active }
  }
  return { tabs: [{ id: 'one', url: s.url, title: s.title, loading: s.loading, canBack: s.canBack, canForward: s.canForward }], active: 'one' }
}

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
  /**
   * It drew frame `n` (and every one before it): up to BROWSER_FRAMES_IN_FLIGHT more may come. Without `n` (a page from before order o15b2): every
   * frame sent so far. Not sent while the page is hidden: no frames go to a page nobody sees.
   */
  | { t: 'drawn'; n?: number }
  /** The page is open and in sight (every minute, and as it comes back into view): a page not seen for ten minutes stops the browser. */
  | { t: 'here' }
  /** Order o02a5: a new tab (opening `url` in it, when given), closing one (the last one closes the browser), or opening another. */
  | { t: 'tab'; do: 'new' | 'close' | 'select'; id?: string; url?: string }
  | { t: 'mouse'; type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; button: 'left' | 'middle' | 'right' | 'none'; clicks: number; mods: number }
  | { t: 'wheel'; x: number; y: number; dx: number; dy: number; mods: number }
  | { t: 'key'; type: 'keyDown' | 'keyUp'; key: string; code: string; keyCode: number; mods: number }
  | { t: 'text'; text: string }

/**
 * Order o15b2 (Shubham: "When using the browser on PC it's slow and the rendering quality is bad"): a frame went only after the page said it drew
 * the one before, so every frame waited a round trip to his phone (6 frames a second at 150 ms, 14 at 60 ms). Now up to this many are on their
 * way at once.
 */
export const BROWSER_FRAMES_IN_FLIGHT = 3

/** How long the page must be still before a sharp frame is sent (at the screen's full density, WebP), after the quick ones of a scroll. */
export const BROWSER_SHARP_AFTER_MS = 350

/**
 * What the agent sends. A frame: `n` counts the frames (the page answers 'drawn' with it); `fmt` is its picture's kind: jpeg (the quick frames, at
 * most twice the page's size) or webp (a sharp one, once the page is still, at the screen's own density up to 3x). Without them: an older agent.
 */
export type BrowserOut = { t: 'state'; state: BrowserState } | { t: 'frame'; data: string; w: number; h: number; n?: number; fmt?: 'jpeg' | 'webp' } | { t: 'notice'; text: string }

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
    case 'drawn': {
      const n = finite(x.n, 0, Number.MAX_SAFE_INTEGER)
      return n === null ? { t: 'drawn' } : { t: 'drawn', n: Math.floor(n) }
    }
    case 'back':
    case 'forward':
    case 'reload':
    case 'close':
    case 'here':
      return { t: x.t }
    case 'tab': {
      const what = x.do === 'new' || x.do === 'close' || x.do === 'select' ? x.do : null
      const id = typeof x.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x.id) ? x.id : undefined
      const url = typeof x.url === 'string' && x.url.length <= 2048 ? x.url : undefined
      if (!what || (what !== 'new' && !id)) return null
      return { t: 'tab', do: what, ...(id ? { id } : {}), ...(url && what === 'new' ? { url } : {}) }
    }
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
  if (x.t === 'frame' && typeof x.data === 'string' && typeof x.w === 'number' && typeof x.h === 'number') {
    return { t: 'frame', data: x.data, w: x.w, h: x.h, ...(typeof x.n === 'number' && Number.isFinite(x.n) ? { n: x.n } : {}), fmt: x.fmt === 'webp' ? 'webp' : 'jpeg' }
  }
  if (x.t === 'notice' && typeof x.text === 'string') return { t: 'notice', text: x.text.slice(0, 300) }
  if (x.t === 'state' && typeof x.state === 'object' && x.state !== null) return { t: 'state', state: { ...BROWSER_IDLE, ...(x.state as Partial<BrowserState>) } }
  return null
}

const SCHEME = /^([a-z][a-z0-9+.-]*):/i

/** Order o34a3: a Tailscale address: a tailnet name (*.ts.net), a Tailscale IPv4 (100.64.0.0/10) or a Tailscale IPv6 (fd7a:115c:a1e0::/48). */
export function tailnetHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return cleanTailnetName(h) !== null || cleanTailnetIp(h) !== null || /^fd7a:115c:a1e0:[0-9a-f:]*$/.test(h)
}

/**
 * Order o34a3 (Shubham: "The whole idea is people will open their Tailscale ports, I should be able to use and navigate using my assistant here."):
 * what the Assistant (ui_control browse, a link it presses) and the agents (browser_open) may open: http or https to a tailnet address, nothing else.
 * A public site opens only when he types it himself.
 */
export function agentMayOpen(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && tailnetHost(u.hostname)
  } catch {
    return false
  }
}

/** What the Assistant and the agents are told when an address is not a tailnet one. */
export const AGENT_PUBLIC_REFUSED =
  "Only tailnet addresses are opened by the Assistant and the agents (a name ending in .ts.net, or a Tailscale address 100.64-127.x.x): the ports on PC control › Ports and the shared ports he gives. A public site opens only when Shubham types it himself in the Browser's address bar."

/**
 * What he typed in the address bar, as an address to open: an http(s) address as it is; a name like example.com (or localhost:5173) as https
 * (http for localhost and 127.0.0.1); words as a web search. Never another scheme (file:, chrome:, javascript:, data:...): null.
 * Order o34a3: a Tailscale IPv4 (100.x, no certificate can name it) as http; a machine's short name with a port ("laptop:8080") as that machine
 * on his tailnet, https://laptop.<tailnet>:8080, when `tailnet` ("tail36192f.ts.net") is known (else http://laptop:8080, MagicDNS's short name).
 */
export function browserUrl(input: string, o: { tailnet?: string | null } = {}): string | null {
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
  if (/\s/.test(s)) return `https://www.google.com/search?q=${encodeURIComponent(s)}`
  // A Tailscale IPv4 (with a port or a path, or bare): plain http.
  if (/^100\.\d{1,3}\.\d{1,3}\.\d{1,3}([:/?#]|$)/.test(s) && cleanTailnetIp(s.split(/[:/?#]/)[0])) {
    try {
      return new URL(`http://${s}`).href
    } catch {
      return null
    }
  }
  // A machine's short name with a port: that machine on his tailnet.
  const short = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?):(\d{1,5})([/?#].*)?$/i.exec(s)
  if (short && !/^localhost$/i.test(short[1])) {
    const tailnet = o.tailnet ? cleanTailnetName(`x.${o.tailnet}`)?.slice(2) : null
    try {
      return new URL(tailnet ? `https://${short[1].toLowerCase()}.${tailnet}:${short[2]}${short[3] ?? ''}` : `http://${s}`).href
    } catch {
      return null
    }
  }
  // A name with a dot (or localhost), no spaces: an address.
  if (/^[^/?#]+\.[a-z]{2,}([:/?#]|$)/i.test(s) || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(s)) {
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

/** His tailnet's name ("tail36192f.ts.net") from a host of it ("server.tail36192f.ts.net"), or null. */
export function tailnetOfHost(host: string): string | null {
  const name = cleanTailnetName(host)
  if (!name) return null
  const parts = name.split('.')
  return parts.length >= 4 ? parts.slice(1).join('.') : null
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
