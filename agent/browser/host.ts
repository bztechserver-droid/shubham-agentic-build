// Order o5dc4 (Shubham: "a big feature ... called Browser. So here we can start a specific url and you can see it and use the browser from within
// the app like you control the ui"): one browser on the Server (the Chrome or Edge already installed, headless), shown live in the app's Browser
// page and used from there: its picture comes as a screencast, clicks, keys, scrolling and text go back through the Input domain
// (shared/browser.ts says what each side sends). The agents open an address in it and read its text (browser_open / browser_read).
//
// It starts only when asked (his tap, or an agent's browser_open), on 127.0.0.1 with a debugging port from 52100 up (above the app's own ports and
// Tailscale's range), with a profile of its own in the app's state folder (never his own Chrome profile; no password is ever kept: the password
// manager is off in its preferences, and headless it never offers to save one). Downloads are refused (nothing is installed through it); a page's
// alert / confirm / prompt is dismissed with Cancel (and the page is told so), so it never pays, sends or deletes behind a dialog; only http(s)
// pages are ever shown (anything else goes back to a blank page). It stops when the last viewer has gone for a minute (a reload comes back in
// time), after ten minutes with nobody using it (a page left open out of sight counts as nobody: an open page in sight says so every minute), when
// the page says Close, and when the app stops.
//
// Order o02a5 (Shubham: "Give it tabs separate for phone and PC."): it has tabs, all in the one private context (so all wiped together), each
// with its own history; the view shows the open one. A popup opens as a new tab (at most BROWSER_MAX_TABS). Closing the last tab closes the browser.
// Order o9d97 ("let the overlay control it like it does app control"): the Browser page asks what is on the open tab's screen (look: the shared
// LOOK_SCRIPT, b-refs) and presses, types, keys and scrolls there for the Assistant (act), with what is his alone refused here too (approvals,
// sends, payments, deletes, installs, sign-ups, password fields; links to public sites). Order o34a3: the agents and the Assistant open tailnet
// addresses only; a public site opens only when he types it himself.
// Order o15b2 ("slow and the rendering quality is bad"): up to BROWSER_FRAMES_IN_FLIGHT frames on their way at once, and a sharp WebP frame at the
// screen's own density once the page is still.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { apiError, type WsSocket } from '../api.ts'
import {
  AGENT_PUBLIC_REFUSED,
  agentMayOpen,
  BROWSER_FRAMES_IN_FLIGHT,
  BROWSER_IDLE,
  BROWSER_MAX_TABS,
  BROWSER_SHARP_AFTER_MS,
  browserMayShow,
  browserUrl,
  parseBrowserIn,
  type BrowserIn,
  type BrowserOut,
  type BrowserState,
  type BrowserTab,
} from '../../shared/browser.ts'
import { keyRefusal, lookCall, pointRefusal, refuseWords, typeable, type LookItem, type LookPoint, type LookResult } from '../../shared/browser-look.ts'

export interface BrowserEngine {
  name: string
  path: string
}

export interface BrowserHostOptions {
  /** Its folder in the app's state (profile/ goes here). */
  dir: string
  /** The browsers to try, in this order (default: the installed Chrome, then Edge). */
  engines?: BrowserEngine[]
  /** No viewer and no agent for this long: it stops (default 10 minutes). */
  idleMs?: number
  /** The last viewer gone this long (and no agent since): it stops (default 60 s). */
  graceMs?: number
  /** Debugging ports to choose from (default 52100-52999). */
  ports?: { from: number; to: number }
  log?: (line: string) => void
  now?: () => number
  /** Order o34a3: which addresses an agent and the Assistant may open (default: tailnet ones only, shared/browser.ts agentMayOpen). Tests widen it. */
  agentMay?: (url: string) => boolean
}

export interface BrowserRead {
  url: string
  title: string
  text: string
  /** The text was cut at `max` characters. */
  cut: boolean
}

/** Order o9d97: the open tab's screen for the Assistant (which tab, of how many, and what is on it). */
export interface BrowserLook {
  tab: string
  index: number
  count: number
  look: LookResult
}

/** Order o9d97: what the Assistant does in the open tab (the Browser page asks on its behalf). */
export type BrowserAct =
  | { do: 'click'; ref: string }
  | { do: 'type'; ref: string; text: string; clear?: boolean; submit?: boolean }
  | { do: 'key'; key: string; ref?: string }
  | { do: 'scroll'; direction: 'up' | 'down' | 'top' | 'bottom'; amount?: number; ref?: string }
  | { do: 'go'; url: string; newTab?: boolean }

export interface BrowserActDone {
  /** What was done, in words. */
  said: string
  /** Where it pressed, in the page's CSS px (the view puts its marker there). */
  at?: { x: number; y: number; w: number; h: number }
}

export interface BrowserHost {
  state(): BrowserState
  /** Starts it if it is not running (and opens `url`, when given). */
  start(url?: string): Promise<BrowserState>
  /** An agent opens `url` (tailnet addresses only: order o34a3), started first if need be, waits for it to load (at most `waitMs`), then reads it. */
  open(url: string, o?: { waitMs?: number; max?: number }): Promise<BrowserRead>
  /** The page as it is now: its address, title and visible text (at most `max` characters). Null when no browser runs. */
  read(max?: number): Promise<BrowserRead | null>
  /** Order o9d97: the open tab's screen for the Assistant (null: no browser runs). */
  look(o?: { all?: boolean; tab?: string }): Promise<BrowserLook | null>
  /** Order o9d97: the Assistant's press, typing, key, scroll or address in the open tab (what is his alone is refused, 403). */
  act(a: BrowserAct, tab?: string): Promise<BrowserActDone>
  stop(): Promise<void>
  /** A viewer's socket (the Browser page). */
  attach(socket: WsSocket): void
  close(): Promise<void>
}

/** The browsers already on the PC (nothing is installed). */
export function defaultEngines(): BrowserEngine[] {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const local = process.env.LOCALAPPDATA ?? ''
    return [
      { name: 'Chrome', path: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Chrome', path: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      ...(local ? [{ name: 'Chrome', path: path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') }] : []),
      { name: 'Edge', path: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Edge', path: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    ]
  }
  if (process.platform === 'darwin') return [{ name: 'Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }]
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'].map(p => ({ name: /edge/.test(p) ? 'Edge' : /chromium/.test(p) ? 'Chromium' : 'Chrome', path: p }))
}

/** A free port on 127.0.0.1 in the range, or null. */
async function freePort(from: number, to: number): Promise<number | null> {
  const start = from + Math.floor(Math.random() * Math.max(1, to - from))
  for (let i = 0; i <= to - from; i++) {
    const port = from + ((start - from + i) % (to - from + 1))
    const ok = await new Promise<boolean>(resolve => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (ok) return port
  }
  return null
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** One debugging connection: commands with answers, and events. */
class Cdp {
  private next = 0
  private waits = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private listeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>()
  closed = false
  private ws: WebSocket
  constructor(ws: WebSocket) {
    this.ws = ws
    ws.onmessage = ev => {
      let m: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string }
      try {
        m = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (typeof m.id === 'number') {
        const w = this.waits.get(m.id)
        if (!w) return
        this.waits.delete(m.id)
        clearTimeout(w.timer)
        if (m.error) w.reject(new Error(m.error.message ?? 'CDP error'))
        else w.resolve(m.result)
        return
      }
      if (m.method) for (const l of this.listeners) l(m.method, m.params ?? {}, m.sessionId)
    }
    ws.onclose = () => {
      this.closed = true
      for (const w of this.waits.values()) {
        clearTimeout(w.timer)
        w.reject(new Error('The browser went away'))
      }
      this.waits.clear()
    }
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The browser went away'))
    const id = ++this.next
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waits.delete(id)
        reject(new Error(`The browser did not answer ${method}`))
      }, timeoutMs)
      this.waits.set(id, { resolve: v => resolve(v as T), reject, timer })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  on(l: (method: string, params: Record<string, unknown>, sessionId?: string) => void) {
    this.listeners.add(l)
  }
  close() {
    try {
      this.ws.close()
    } catch {
      // gone already
    }
  }
}

/** A picture of the page: base64, its size in the page's CSS px, and its kind (order o15b2: quick JPEG frames, a sharp WebP one when still). */
interface Frame {
  data: string
  w: number
  h: number
  fmt: 'jpeg' | 'webp'
}

interface Viewer {
  socket: WsSocket
  /** Frames sent to it (numbered from 1), and the newest it said it drew: up to BROWSER_FRAMES_IN_FLIGHT may be on their way at once. */
  sent: number
  drawn: number
  /** The newest frame it has not been sent yet. */
  pending: Frame | null
}

/** Order o02a5: one tab (a page target in the private context, attached by its own session). */
interface Tab extends BrowserTab {
  target: string
  session: string
}

const PREFERENCES = {
  credentials_enable_service: false,
  credentials_enable_autosignin: false,
  profile: { password_manager_enabled: false, default_content_setting_values: { notifications: 2, geolocation: 2, media_stream_camera: 2, media_stream_mic: 2 } },
  autofill: { profile_enabled: false, credit_card_enabled: false },
  download: { prompt_for_download: false },
  browser: { has_seen_welcome_page: true },
  // Order o7e1e ("Includes ensure data privacy"): nothing goes to Google's services from it, not even Safe Browsing's address checks; no search
  // suggestions, translation or spelling service.
  safebrowsing: { enabled: false, enhanced: false },
  search: { suggest_enabled: false },
  translate: { enabled: false },
  spellcheck: { use_spelling_service: false },
}

/**
 * Order o7e1e: Chrome's own traffic to its services, off (crash reports, metrics, component and safe-browsing updates, domain reliability,
 * hyperlink pings, translation, optimisation hints, autofill and media-router lookups). The pages he opens are the only places it talks to.
 */
const QUIET = [
  '--disable-background-networking',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--disable-sync',
  '--metrics-recording-only',
  '--no-pings',
  '--no-service-autorun',
  '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater',
]

/** A session's profile folder (one per session, wiped when it stops), and any left by an earlier one (a crash). */
const PROFILE_PREFIX = 'profile'
const profileName = () => `${PROFILE_PREFIX}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
const isProfile = (name: string) => name === PROFILE_PREFIX || name.startsWith(`${PROFILE_PREFIX}-`)

/** The keys the Assistant may press in a tab, as the Input domain wants them (key, code, Windows key code). */
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
}

export function createBrowserHost(o: BrowserHostOptions): BrowserHost {
  const now = o.now ?? Date.now
  const idleMs = o.idleMs ?? 10 * 60_000
  const graceMs = o.graceMs ?? 60_000
  const ports = o.ports ?? { from: 52100, to: 52999 }
  const log = o.log ?? (() => undefined)
  const agentMay = o.agentMay ?? agentMayOpen
  let state: BrowserState = { ...BROWSER_IDLE }
  let proc: ChildProcess | null = null
  let cdp: Cdp | null = null
  /** The private context every tab lives in (gone with the connection: disposeOnDetach). */
  let ctx: string | null = null
  const tabs: Tab[] = []
  /** The open tab (the one the view shows), and its session (null: none). */
  let current: Tab | null = null
  let page: string | null = null
  /** Targets this host made itself (a new tab): never taken for a popup; and how many it is making now (their ids not known yet). */
  const ours = new Set<string>()
  let making = 0
  let starting: Promise<void> | null = null
  let stopping: Promise<void> | null = null
  /** This session's profile folder (wiped when it stops), and the wipe under way. */
  let profile: string | null = null
  let wiping: Promise<void> = Promise.resolve()
  let lastFrame: Frame | null = null
  let size = { w: 1280, h: 800, dpr: 1, mobile: false }
  // Order o15b2: the sharp frame once the page is still (a timer re-armed by each quick frame), and what keeps it from chasing itself.
  let sharpTimer: ReturnType<typeof setTimeout> | null = null
  let sharpSeq = 0
  let sharpSentAt = 0
  let lastQuick = ''
  let lastUse = now()
  let viewerLeft: number | null = null
  const viewers = new Set<Viewer>()
  // Order o7e1e (14 Nov): what an agent has under way (an open with the launch it may need, a read, a look, an act) is never closed by the
  // idle check. A launch can take longer than the grace time on a busy PC, and the check used to close the new browser under the open
  // ("The browser went away"): the last viewer long gone and no use since counted, while the open itself had not marked any use yet.
  let using = 0
  const underWay = async <T>(f: () => Promise<T>): Promise<T> => {
    using++
    lastUse = now()
    try {
      return await f()
    } finally {
      using--
      lastUse = now()
    }
  }

  const send = (v: Viewer, m: BrowserOut) => {
    try {
      v.socket.sendText(JSON.stringify(m))
    } catch {
      // the viewer went
    }
  }
  const broadcast = (m: BrowserOut) => {
    for (const v of viewers) send(v, m)
  }
  const setState = (s: Partial<BrowserState>) => {
    state = { ...state, ...s }
    broadcast({ t: 'state', state })
  }
  /** The tabs as the page sees them, and the open one's fields at the top (what an older page reads). */
  const publish = (extra: Partial<BrowserState> = {}) => {
    const c = current
    setState({
      tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, loading: t.loading, canBack: t.canBack, canForward: t.canForward })),
      active: c?.id ?? null,
      url: c?.url ?? '',
      title: c?.title ?? '',
      loading: c?.loading ?? false,
      canBack: c?.canBack ?? false,
      canForward: c?.canForward ?? false,
      ...extra,
    })
  }
  const notice = (text: string) => broadcast({ t: 'notice', text })
  const sendFrame = (v: Viewer) => {
    if (!v.pending || v.sent - v.drawn >= BROWSER_FRAMES_IN_FLIGHT) return
    const f = v.pending
    v.pending = null
    v.sent += 1
    send(v, { t: 'frame', ...f, n: v.sent })
  }
  /** A new picture for every viewer (each gets the newest one as soon as it has room for it). */
  const deliver = (f: Frame) => {
    lastFrame = f
    for (const v of viewers) {
      v.pending = f
      sendFrame(v)
    }
  }
  const stopSharp = () => {
    if (sharpTimer) clearTimeout(sharpTimer)
    sharpTimer = null
    sharpSeq++
  }
  /**
   * Order o15b2: once the page has been still a moment, one sharp picture of it: WebP at the screen's own density (up to 3x), where the quick frames
   * of a scroll are JPEG at most 2x. Out of date (a newer frame came meanwhile, another tab was opened): dropped.
   */
  const armSharp = (afterMs: number) => {
    stopSharp()
    const seq = sharpSeq
    const timer = setTimeout(() => {
      sharpTimer = null
      const c = cdp
      const p = page
      if (!c || !p || viewers.size === 0 || seq !== sharpSeq) return
      void c
        .send<{ data?: string }>('Page.captureScreenshot', { format: 'webp', quality: 82 }, p, 5000)
        .then(r => {
          if (seq !== sharpSeq || cdp !== c || page !== p || !r.data) return
          sharpSentAt = now()
          deliver({ data: r.data, w: size.w, h: size.h, fmt: 'webp' })
        })
        .catch(() => undefined)
    }, afterMs)
    timer.unref?.()
    sharpTimer = timer
  }

  function engine(): BrowserEngine | null {
    for (const e of o.engines ?? defaultEngines()) if (existsSync(e.path)) return e
    return null
  }

  const tabOf = (session?: string) => (session ? tabs.find(t => t.session === session) : undefined)
  const tabId = () => randomBytes(4).toString('hex')

  async function history(t: Tab) {
    if (!cdp) return
    try {
      const h = await cdp.send<{ currentIndex: number; entries: { url: string; title: string }[] }>('Page.getNavigationHistory', {}, t.session)
      t.canBack = h.currentIndex > 0
      t.canForward = h.currentIndex < h.entries.length - 1
      // The page's own title (the target's info gives only its address until it changes again).
      const title = h.entries[h.currentIndex]?.title
      if (title) t.title = title
      publish()
    } catch {
      // the page is changing
    }
  }

  async function screencast() {
    if (!cdp || !page) return
    // Order o15b2: the page is drawn at the screen's own density (up to 3x: a phone's text was blurred 1.5x at the old 2x cap) for the sharp frame;
    // the quick frames of a scroll stay at most 2x.
    const dpr = Math.min(3, Math.max(1, size.dpr))
    const quick = Math.min(2, dpr)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: dpr, mobile: size.mobile }, page)
    await cdp.send('Page.stopScreencast', {}, page).catch(() => undefined)
    lastQuick = ''
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 62, maxWidth: Math.round(size.w * quick), maxHeight: Math.round(size.h * quick), everyNthFrame: 1 }, page)
  }

  /** Order o02a5: the view shows tab `t` from now on (its picture, his input, the Assistant's look and act). */
  async function select(t: Tab) {
    const c = cdp
    if (!c) return
    if (current === t && page === t.session) return
    const old = current
    current = t
    page = t.session
    stopSharp()
    lastQuick = ''
    if (old && old !== t) await c.send('Page.stopScreencast', {}, old.session).catch(() => undefined)
    // In front: a tab behind another is not painted (its picture would stop at its last frame).
    await c.send('Page.bringToFront', {}, t.session).catch(() => undefined)
    publish()
    await screencast().catch(() => undefined)
    void history(t)
  }

  /** A page target of the private context, attached and listened to, as a tab at the end (the view moves to it when `show`). */
  async function adopt(target: string, show: boolean, url = ''): Promise<Tab> {
    const c = cdp
    if (!c) throw apiError(409, 'The browser is not running.')
    const session = (await c.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target, flatten: true })).sessionId
    const t: Tab = { id: tabId(), target, session, url, title: '', loading: false, canBack: false, canForward: false }
    tabs.push(t)
    await c.send('Page.enable', {}, session)
    if (show || !current) await select(t)
    else publish()
    return t
  }

  /** A new tab (opening `url`), shown. */
  async function newTab(url?: string): Promise<Tab> {
    await ensure()
    const c = cdp
    if (!c || !ctx) throw apiError(409, 'The browser is not running.')
    if (tabs.length >= BROWSER_MAX_TABS) throw apiError(409, `At most ${BROWSER_MAX_TABS} tabs: close one first.`)
    making++
    let target: string
    try {
      // Made at its address (a blank first page would be one more step back in its history).
      target = (await c.send<{ targetId: string }>('Target.createTarget', { url: url ?? 'about:blank', browserContextId: ctx })).targetId
    } finally {
      making--
    }
    ours.add(target)
    const t = await adopt(target, true, url ?? '')
    if (url) {
      lastUse = now()
      t.loading = true
      publish()
    }
    return t
  }

  /** Tab `t` goes (its page closed); the one beside it is shown; the last one closes the browser (and wipes it). */
  async function closeTab(t: Tab) {
    const c = cdp
    forget(t)
    if (c) await c.send('Target.closeTarget', { targetId: t.target }).catch(() => undefined)
  }

  /** A tab that is gone (closed here, or by its own page): out of the list; the view moves on, or the browser stops with the last one. */
  function forget(t: Tab) {
    const i = tabs.indexOf(t)
    if (i < 0) return
    tabs.splice(i, 1)
    ours.delete(t.target)
    if (tabs.length === 0) {
      current = null
      page = null
      void stop()
      return
    }
    if (current === t) {
      current = null
      page = null
      void select(tabs[Math.min(i, tabs.length - 1)])
    } else publish()
  }

  async function navigate(t: Tab, url: string) {
    const c = cdp
    if (!c) return
    lastUse = now()
    t.url = url
    t.loading = true
    publish()
    await c.send('Page.navigate', { url }, t.session)
  }

  function onEvent(method: string, params: Record<string, unknown>, sessionId?: string) {
    const c = cdp
    if (!c) return
    if (method === 'Page.screencastFrame') {
      void c.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => undefined)
      if (sessionId !== page) return
      const meta = (params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number }
      const data = String(params.data ?? '')
      // The same picture again (nothing changed on the page): the sharp one already showing stays.
      if (data === lastQuick) return
      lastQuick = data
      deliver({ data, w: Math.round(meta.deviceWidth ?? size.w), h: Math.round(meta.deviceHeight ?? size.h), fmt: 'jpeg' })
      // A sharp picture once it is still; a frame right behind a sharp one waits longer (so pictures can never chase each other).
      armSharp(now() - sharpSentAt > 250 ? BROWSER_SHARP_AFTER_MS : 4 * BROWSER_SHARP_AFTER_MS)
      return
    }
    const t = tabOf(sessionId)
    if (method === 'Page.frameNavigated' && t) {
      const frame = (params.frame ?? {}) as { parentId?: string; url?: string; urlFragment?: string }
      if (frame.parentId) return
      const url = `${frame.url ?? ''}${frame.urlFragment ?? ''}`
      // The browser's own "can't reach this page" (its address stays the one he asked for).
      if (url.startsWith('chrome-error://')) {
        t.loading = false
        publish()
        notice(`${t.url || 'That address'} could not be reached from the Server.`)
        return
      }
      if (!browserMayShow(url)) {
        // Never another kind of page (file:, chrome:, a data: page): back to a blank one.
        void c.send('Page.navigate', { url: 'about:blank' }, t.session).catch(() => undefined)
        notice('That kind of page is not opened here: only http and https addresses.')
        return
      }
      t.url = url === 'about:blank' ? '' : url
      publish()
      void history(t)
      return
    }
    if (method === 'Page.navigatedWithinDocument' && t) {
      t.url = String(params.url ?? t.url)
      publish()
      void history(t)
      return
    }
    if (method === 'Page.frameStartedLoading' && t) {
      t.loading = true
      return publish()
    }
    if ((method === 'Page.frameStoppedLoading' || method === 'Page.loadEventFired') && t) {
      t.loading = false
      publish()
      void history(t)
      return
    }
    if (method === 'Page.javascriptDialogOpening' && t) {
      // Cancel, always (Leave, for a "leave this page?"): a dialog never confirms anything here. The viewer is told what it said.
      const type = String(params.type ?? '')
      void c.send('Page.handleJavaScriptDialog', { accept: type === 'beforeunload' }, t.session).catch(() => undefined)
      if (type !== 'beforeunload') notice(`The page asked: "${String(params.message ?? '').slice(0, 200)}". Answered Cancel (nothing was confirmed).`)
      return
    }
    if (method === 'Page.downloadWillBegin' || method === 'Browser.downloadWillBegin') {
      notice('Downloads are off in this browser: nothing was saved or installed.')
      return
    }
    if (method === 'Target.targetInfoChanged') {
      const info = (params.targetInfo ?? {}) as { targetId?: string; title?: string }
      const tab = tabs.find(x => x.target === info.targetId)
      if (tab && typeof info.title === 'string' && info.title !== tab.title) {
        tab.title = info.title
        publish()
      }
      return
    }
    if (method === 'Target.targetCreated') {
      // Order o02a5: a page of the private context that this host did not make is a popup (a link to a new window): a tab of its own, shown.
      // A popup names the tab that opened it; one with no opener while this host is making a tab is that tab (its answer comes after this event).
      const info = (params.targetInfo ?? {}) as { targetId?: string; type?: string; browserContextId?: string; url?: string; openerId?: string }
      const id = info.targetId
      if (info.type !== 'page' || !id || info.browserContextId !== ctx || ours.has(id) || tabs.some(x => x.target === id)) return
      if (!info.openerId && making > 0) return
      // A moment later: a tab this host is making itself is known by then (its answer comes after this event).
      setTimeout(() => {
        if (ours.has(id) || tabs.some(x => x.target === id) || cdp !== c) return
        if (tabs.length >= BROWSER_MAX_TABS) {
          void c.send('Target.closeTarget', { targetId: id }).catch(() => undefined)
          notice(`A page tried to open a new tab, but there are ${BROWSER_MAX_TABS} already: close one first.`)
          return
        }
        ours.add(id)
        void adopt(id, true, info.url && info.url !== 'about:blank' ? info.url : '').catch(() => undefined)
      }, 50)
      return
    }
    if (method === 'Target.targetDestroyed' || method === 'Target.detachedFromTarget') {
      const gone = method === 'Target.targetDestroyed' ? tabs.find(x => x.target === params.targetId) : tabOf(String(params.sessionId ?? ''))
      if (gone) forget(gone)
    }
  }

  async function launch(): Promise<void> {
    const e = engine()
    if (!e) {
      setState({ ...BROWSER_IDLE, error: 'There is no Chrome or Edge on the Server to run the browser with (nothing is installed by the app).' })
      throw apiError(503, state.error ?? 'No browser')
    }
    // Order o7e1e: a new, empty profile for every session (wiped when it stops), and anything an earlier one left (a crash) wiped first.
    wipeLeftovers()
    const dir = path.join(o.dir, profileName())
    mkdirSync(path.join(dir, 'Default'), { recursive: true })
    writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify(PREFERENCES))
    profile = dir
    const port = await freePort(ports.from, ports.to)
    if (!port) throw apiError(503, 'No free port for the browser on the Server.')
    setState({ ...BROWSER_IDLE, starting: true, engine: e.name, tabs: [], active: null })
    const args = [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      ...QUIET,
      '--password-store=basic',
      '--mute-audio',
      `--window-size=${size.w},${size.h}`,
      'about:blank',
    ]
    const child = spawn(e.path, args, { stdio: 'ignore', windowsHide: true })
    proc = child
    child.on('exit', () => {
      if (proc !== child) return
      // It went by itself (a crash): what it was showing is gone, and so is its profile.
      proc = null
      cdp?.close()
      cdp = null
      dropTabs()
      setState({ ...BROWSER_IDLE, engine: e.name, tabs: [], active: null })
      void wipe()
    })
    log(`browser: ${e.name} started (pid ${child.pid}) on 127.0.0.1:${port}`)
    try {
      let wsUrl: string | null = null
      for (let i = 0; i < 75 && !wsUrl; i++) {
        await sleep(200)
        if (proc !== child) throw apiError(502, `${e.name} stopped as it started.`)
        try {
          const r = await fetch(`http://127.0.0.1:${port}/json/version`)
          const j = (await r.json()) as { webSocketDebuggerUrl?: string }
          wsUrl = j.webSocketDebuggerUrl ?? null
        } catch {
          // not up yet
        }
      }
      if (!wsUrl) throw apiError(502, `${e.name} did not come up on the Server.`)
      const ws = new WebSocket(wsUrl)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(apiError(502, `Could not reach ${e.name} on the Server.`))
      })
      const c = new Cdp(ws)
      cdp = c
      c.on(onEvent)
      // Order o7e1e: the tabs live in a private context of their own: their cookies, storage and cache are in memory only, and gone when it closes
      // (or the moment this connection drops, the app stopping without a word). The tab the browser started with is closed.
      const first = (await c.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets')).targetInfos.filter(t => t.type === 'page')
      ctx = (await c.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId
      const target = (await c.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId: ctx })).targetId
      ours.add(target)
      for (const t of first) await c.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined)
      // Only now: a page of the private context that shows up from here on, not made here, is a popup (order o02a5: a new tab).
      await c.send('Target.setDiscoverTargets', { discover: true })
      // Downloads refused in both contexts (each has its own setting); not running at all rather than running with them allowed.
      await c.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: ctx, eventsEnabled: true })
      await c.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }).catch(() => undefined)
      await adopt(target, true)
      setState({ running: true, starting: false, error: null })
    } catch (err) {
      await stopProcess()
      await wipe()
      setState({ ...BROWSER_IDLE, engine: e.name, tabs: [], active: null })
      throw err
    }
  }

  async function ensure(): Promise<void> {
    // Opened while it was being closed: a new one, after.
    if (stopping) await stopping
    if (cdp && proc && tabs.length > 0) return
    starting ??= launch().finally(() => {
      starting = null
    })
    await starting
  }

  /** Opens what he typed (any http(s) address, or words to search for) in the open tab (a new one if none). */
  async function go(input: string): Promise<void> {
    const url = browserUrl(input)
    if (!url) throw apiError(400, 'Only http and https addresses are opened here (or words to search for).')
    await ensure()
    const t = current ?? (await newTab())
    await navigate(t, url)
  }

  async function stopProcess(): Promise<void> {
    const child = proc
    const c = cdp
    if (c) await c.send('Browser.close', {}, undefined, 3000).catch(() => undefined)
    c?.close()
    if (child && child.exitCode === null) {
      const gone = await new Promise<boolean>(resolve => {
        const t = setTimeout(() => resolve(false), 4000)
        child.once('exit', () => {
          clearTimeout(t)
          resolve(true)
        })
      })
      // Its own process only, by its own pid (the one this started).
      if (!gone) child.kill()
    }
    proc = null
    cdp = null
    dropTabs()
  }

  /** Every tab forgotten (the browser is gone). */
  function dropTabs() {
    tabs.length = 0
    ours.clear()
    current = null
    page = null
    ctx = null
    lastFrame = null
    lastQuick = ''
    stopSharp()
  }

  /**
   * Order o7e1e: the session's profile folder, gone (cookies, storage, history, cache, everything it wrote). Its last processes may hold a file
   * a moment longer, so it is tried again for a while; what still cannot go is wiped at the next start (wipeLeftovers).
   */
  function wipe(): Promise<void> {
    const dir = profile
    profile = null
    // Already under way (the browser's exit started it): the same one is waited for.
    if (!dir) return wiping
    wiping = (async () => {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
        log('browser: its profile was wiped')
      } catch {
        log('browser: its profile could not be wiped yet (a file still in use); it is wiped at the next start')
      }
    })()
    return wiping
  }

  /** Profile folders an earlier session left (the app stopped hard): wiped, but never the one in use. */
  function wipeLeftovers() {
    let names: string[] = []
    try {
      names = readdirSync(o.dir)
    } catch {
      return
    }
    for (const name of names) {
      const dir = path.join(o.dir, name)
      if (!isProfile(name) || dir === profile) continue
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      } catch {
        // still held by a browser that outlived the app: tried again next time
      }
    }
  }

  /** One stop at a time (the idle check, Close and the app stopping may all ask while one is under way). */
  function stop(): Promise<void> {
    stopping ??= (async () => {
      if (starting) await starting.catch(() => undefined)
      if (!proc && !cdp) return
      await stopProcess()
      await wipe()
      log('browser: stopped')
      setState({ ...BROWSER_IDLE, engine: state.engine, tabs: [], active: null })
    })().finally(() => {
      stopping = null
    })
    return stopping
  }

  async function read(max = 8000): Promise<BrowserRead | null> {
    if (!cdp || !page) return null
    lastUse = now()
    const cap = Math.max(500, Math.min(Math.floor(max) || 8000, 30_000))
    // A fixed expression: what the page shows, as text (never a field's value, never anything an agent wrote).
    const r = await cdp.send<{ result?: { value?: { url?: string; title?: string; text?: string } } }>(
      'Runtime.evaluate',
      { expression: '({ url: location.href, title: document.title, text: document.body ? document.body.innerText : "" })', returnByValue: true },
      page,
    )
    const v = r.result?.value ?? {}
    const text = String(v.text ?? '')
    return { url: String(v.url ?? state.url), title: String(v.title ?? state.title), text: text.slice(0, cap), cut: text.length > cap }
  }

  /** The tab the Assistant acts on: the one asked for (it must be the open one), or the open one. */
  function actTab(id?: string): Tab {
    if (!cdp || !current) throw apiError(409, 'No browser runs on the Server: open an address on the Browser page first.')
    if (id && id !== current.id) throw apiError(409, 'That tab is not the open one any more: read the screen again (ui_screen).')
    return current
  }

  /** LOOK_SCRIPT in tab `t`, with its answer. */
  async function inTab<T>(t: Tab, args: Record<string, unknown>): Promise<T> {
    const r = await cdp!.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string } }>('Runtime.evaluate', { expression: lookCall(args), returnByValue: true }, t.session, 10_000)
    if (r.exceptionDetails) throw apiError(502, `The page did not answer (${String(r.exceptionDetails.text ?? 'an error').slice(0, 120)}).`)
    return r.result?.value as T
  }

  async function look(lo: { all?: boolean; tab?: string } = {}): Promise<BrowserLook | null> {
    if (!cdp || !current) return null
    const t = actTab(lo.tab)
    lastUse = now()
    const result = await inTab<LookResult>(t, { op: 'look', all: lo.all === true, cap: lo.all ? 250 : 70, textCap: 1400 })
    return { tab: t.id, index: tabs.indexOf(t), count: tabs.length, look: result }
  }

  /** Where `ref` is now (scrolled into view), refused when it is gone, covered, or his alone. */
  async function aim(t: Tab, ref: string, what: 'press' | 'type'): Promise<LookPoint & { item: LookItem }> {
    const p = await inTab<LookPoint>(t, { op: 'point', ref })
    const no = pointRefusal(p, ref, what)
    if (no) throw apiError(no.status, no.message)
    return { ...p, item: p.item! }
  }

  async function key(t: Tab, k: string) {
    const spec = KEYS[k]
    if (!spec) throw apiError(400, `The ${k} key is not one the Assistant presses in the Browser.`)
    const c = cdp!
    await c.send('Input.dispatchKeyEvent', { type: spec.text ? 'keyDown' : 'rawKeyDown', key: k, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}) }, t.session)
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode }, t.session)
  }

  async function act(a: BrowserAct, id?: string): Promise<BrowserActDone> {
    if (a.do === 'go') {
      // Order o34a3: the Assistant opens tailnet addresses only.
      const url = browserUrl(a.url)
      if (!url || !agentMay(url)) throw apiError(403, AGENT_PUBLIC_REFUSED)
      await ensure()
      if (a.newTab) {
        await newTab(url)
        return { said: `Opening ${url} in a new tab (PC tab ${tabs.length}).` }
      }
      const t = id ? actTab(id) : (current ?? (await newTab()))
      await navigate(t, url)
      return { said: `Opening ${url} in the tab.` }
    }
    const t = actTab(id)
    lastUse = now()
    const c = cdp!
    if (a.do === 'click') {
      const p = await aim(t, a.ref, 'press')
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 }, t.session)
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 }, t.session)
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 }, t.session)
      return { said: `Pressed ${a.ref}.`, at: { x: p.x, y: p.y, w: size.w, h: size.h } }
    }
    if (a.do === 'type') {
      const p = await aim(t, a.ref, 'type')
      if (a.submit && !p.item.search) throw apiError(403, refuseWords(a.ref, 'Enter there would send its form (only a search field takes Enter from you); type without submit and tell him to send it'))
      if (p.item.role === 'select') {
        const r = await inTab<{ ok: boolean; options?: string[] }>(t, { op: 'choose', ref: a.ref, text: a.text })
        if (!r?.ok) throw apiError(409, `${a.ref} has no option "${a.text}"${r?.options ? `: it has ${r.options.join(', ')}` : ''}.`)
        return { said: `Chose "${a.text}" in ${a.ref}.`, at: { x: p.x, y: p.y, w: size.w, h: size.h } }
      }
      if (!typeable(p.item)) throw apiError(409, `${a.ref} is not a place to type: it is a ${p.item.role}.`)
      await inTab(t, { op: 'focus', ref: a.ref, clear: a.clear !== false })
      if (a.text) await c.send('Input.insertText', { text: a.text.slice(0, 4000) }, t.session)
      if (a.submit) await key(t, 'Enter')
      return { said: `Typed into ${a.ref}${a.submit ? ' and pressed Enter' : ''}.`, at: { x: p.x, y: p.y, w: size.w, h: size.h } }
    }
    if (a.do === 'key') {
      // With a ref: that element first (focused, never a password or code field).
      if (a.ref) {
        await aim(t, a.ref, 'type')
        await inTab(t, { op: 'focus', ref: a.ref, clear: false })
      }
      const focused = await inTab<LookItem | null>(t, { op: 'focused' })
      const no = keyRefusal(a.key, focused)
      if (no) throw apiError(403, refuseWords('That key', no))
      await key(t, a.key === 'Space' ? ' ' : a.key)
      return { said: `Pressed the ${a.key} key in the tab.` }
    }
    const r = await inTab<{ top?: number; max?: number; gone?: boolean }>(t, { op: 'scroll', direction: a.direction, amount: a.amount, ref: a.ref })
    if (r?.gone) throw apiError(409, `${a.ref} is not on the page any more: read the screen again (ui_screen).`)
    return { said: `Scrolled ${a.direction}: now at ${r?.top ?? 0} of ${r?.max ?? 0}px.` }
  }

  async function handle(m: BrowserIn, v: Viewer) {
    // Anything a page says means it is open and in sight (a hidden page sends nothing, not even 'drawn').
    lastUse = now()
    if (m.t === 'here') return
    if (m.t === 'drawn') {
      // Order o15b2: it drew frame n and those before it (an older page says no n: everything sent so far).
      v.drawn = m.n === undefined ? v.sent : Math.max(v.drawn, Math.min(v.sent, m.n))
      sendFrame(v)
      return
    }
    if (m.t === 'start') return m.url ? go(m.url) : ensure()
    if (m.t === 'go') return go(m.url)
    if (m.t === 'close') return stop()
    if (m.t === 'size') {
      size = { w: m.w, h: m.h, dpr: m.dpr, mobile: m.mobile }
      return screencast()
    }
    if (m.t === 'tab') {
      // Order o02a5: his tabs (a new one may start the browser; the others need it running).
      if (m.do === 'new') {
        // Not running yet: starting it makes its first tab.
        if (!cdp) return m.url ? go(m.url) : ensure()
        const url = m.url ? browserUrl(m.url) : null
        if (m.url && !url) throw apiError(400, 'Only http and https addresses are opened here (or words to search for).')
        await newTab(url ?? undefined)
        return
      }
      const t = tabs.find(x => x.id === m.id)
      if (!t) return
      if (m.do === 'select') return select(t)
      return closeTab(t)
    }
    const c = cdp
    const p = page
    if (!c || !p) return
    if (m.t === 'back' || m.t === 'forward') {
      const h = await c.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory', {}, p)
      const e = h.entries[h.currentIndex + (m.t === 'back' ? -1 : 1)]
      if (e) await c.send('Page.navigateToHistoryEntry', { entryId: e.id }, p)
      return
    }
    if (m.t === 'reload') return void (await c.send('Page.reload', {}, p))
    if (m.t === 'mouse') {
      await c.send('Input.dispatchMouseEvent', { type: m.type, x: m.x, y: m.y, button: m.button, buttons: m.type === 'mouseReleased' || m.button === 'none' ? 0 : m.button === 'right' ? 2 : m.button === 'middle' ? 4 : 1, clickCount: m.clicks, modifiers: m.mods }, p)
      return
    }
    if (m.t === 'wheel') return void (await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: m.x, y: m.y, deltaX: m.dx, deltaY: m.dy, modifiers: m.mods }, p))
    if (m.t === 'key') {
      // A printable key carries its text (as a real keyboard's does); Ctrl/Cmd shortcuts and the named keys do not. Enter types a new line.
      const printable = m.key.length === 1 && !(m.mods & 2) && !(m.mods & 4)
      const text = printable ? m.key : m.key === 'Enter' ? '\r' : undefined
      await c.send('Input.dispatchKeyEvent', { type: m.type === 'keyDown' ? (text ? 'keyDown' : 'rawKeyDown') : 'keyUp', key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, nativeVirtualKeyCode: m.keyCode, modifiers: m.mods, ...(text && m.type === 'keyDown' ? { text, unmodifiedText: text } : {}) }, p)
      return
    }
    if (m.t === 'text') return void (await c.send('Input.insertText', { text: m.text }, p))
  }

  // Stops it when nobody uses it: the last viewer gone a minute (and no agent since), or ten minutes with no one at all. A page still connected
  // but out of sight that long counts as no one (hidden, a phone locked, a tab frozen or kept in the back/forward cache with its socket open).
  const idle = setInterval(() => {
    // Not while it is still starting, or while an agent's call is under way (order o7e1e, 14 Nov).
    if (!proc || stopping || starting || using > 0) return
    const t = now()
    if (viewers.size > 0) {
      if (t - lastUse > idleMs) {
        notice(`The browser was closed: nobody had used it for ${Math.round(idleMs / 60_000)} minutes.`)
        void stop()
      }
      return
    }
    if ((viewerLeft !== null && t - viewerLeft > graceMs && t - lastUse > graceMs) || t - lastUse > idleMs) void stop()
  }, Math.min(15_000, Math.max(250, Math.floor(Math.min(graceMs, idleMs) / 4))))
  idle.unref?.()
  // Order o7e1e: what a session left behind when the app stopped hard (a crash, a kill), wiped as the app starts.
  wipeLeftovers()

  return {
    state: () => state,
    async start(url) {
      lastUse = now()
      if (url) await go(url)
      else await ensure()
      return state
    },
    async open(url, opt = {}) {
      // Order o34a3: an agent opens tailnet addresses only (a public site opens only when he types it himself).
      const target = browserUrl(url)
      if (!target) throw apiError(400, 'Only http and https addresses are opened here (an address on his tailnet).')
      if (!agentMay(target)) throw apiError(403, AGENT_PUBLIC_REFUSED)
      return underWay(async () => {
        await go(target)
        const until = now() + (opt.waitMs ?? 15_000)
        await sleep(300)
        while (now() < until && state.loading) await sleep(200)
        return (await read(opt.max)) ?? { url: state.url, title: state.title, text: '', cut: false }
      })
    },
    read: max => underWay(() => read(max)),
    look: lo => underWay(() => look(lo)),
    act: (a, tab) => underWay(() => act(a, tab)),
    stop,
    attach(socket) {
      const v: Viewer = { socket, sent: 0, drawn: 0, pending: lastFrame }
      viewers.add(v)
      viewerLeft = null
      lastUse = now()
      send(v, { t: 'state', state })
      sendFrame(v)
      socket.onText(text => {
        const m = parseBrowserIn(text)
        if (!m) return
        void handle(m, v).catch((e: unknown) => send(v, { t: 'notice', text: e instanceof Error ? e.message : String(e) }))
      })
      socket.onClose(() => {
        viewers.delete(v)
        if (viewers.size === 0) viewerLeft = now()
      })
    },
    async close() {
      clearInterval(idle)
      await stop()
    },
  }
}
