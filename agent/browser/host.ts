// Order o5dc4 (Shubham: "a big feature ... called Browser. So here we can start a specific url and you can see it and use the browser from within
// the app like you control the ui"): one browser on the Server (the Chrome or Edge already installed, headless), shown live in the app's Browser
// page and used from there: its picture comes as a screencast, clicks, keys, scrolling and text go back through the Input domain
// (shared/browser.ts says what each side sends). The agents open an address in it and read its text (browser_open / browser_read), nothing more.
//
// It starts only when asked (his tap, or an agent's browser_open), on 127.0.0.1 with a debugging port from 52100 up (above the app's own ports and
// Tailscale's range), with a profile of its own in the app's state folder (never his own Chrome profile; no password is ever kept: the password
// manager is off in its preferences, and headless it never offers to save one). Downloads are refused (nothing is installed through it); a page's
// alert / confirm / prompt is dismissed with Cancel (and the page is told so), so it never pays, sends or deletes behind a dialog; only http(s)
// pages are ever shown (anything else goes back to a blank page). A popup opens in the one view. It stops when the last viewer has gone for a
// minute (a reload comes back in time), after ten minutes with nobody using it (a page left open out of sight counts as nobody: an open page in
// sight says so every minute), when the page says Close, and when the app stops.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { apiError, type WsSocket } from '../api.ts'
import { BROWSER_IDLE, browserMayShow, browserUrl, parseBrowserIn, type BrowserIn, type BrowserOut, type BrowserState } from '../../shared/browser.ts'

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
}

export interface BrowserRead {
  url: string
  title: string
  text: string
  /** The text was cut at `max` characters. */
  cut: boolean
}

export interface BrowserHost {
  state(): BrowserState
  /** Starts it if it is not running (and opens `url`, when given). */
  start(url?: string): Promise<BrowserState>
  /** Opens `url` (started first if need be) and waits for it to load (at most `waitMs`), then reads it. */
  open(url: string, o?: { waitMs?: number; max?: number }): Promise<BrowserRead>
  /** The page as it is now: its address, title and visible text (at most `max` characters). Null when no browser runs. */
  read(max?: number): Promise<BrowserRead | null>
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

interface Viewer {
  socket: WsSocket
  /** It drew the last frame it was sent (the next one may go). */
  ready: boolean
  /** The newest frame it has not been sent yet. */
  pending: { data: string; w: number; h: number } | null
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

export function createBrowserHost(o: BrowserHostOptions): BrowserHost {
  const now = o.now ?? Date.now
  const idleMs = o.idleMs ?? 10 * 60_000
  const graceMs = o.graceMs ?? 60_000
  const ports = o.ports ?? { from: 52100, to: 52999 }
  const log = o.log ?? (() => undefined)
  let state: BrowserState = { ...BROWSER_IDLE }
  let proc: ChildProcess | null = null
  let cdp: Cdp | null = null
  let page: string | null = null
  let pageTarget: string | null = null
  let starting: Promise<void> | null = null
  let stopping: Promise<void> | null = null
  /** This session's profile folder (wiped when it stops), and the wipe under way. */
  let profile: string | null = null
  let wiping: Promise<void> = Promise.resolve()
  let lastFrame: { data: string; w: number; h: number } | null = null
  let size = { w: 1280, h: 800, dpr: 1, mobile: false }
  let lastUse = now()
  let viewerLeft: number | null = null
  const viewers = new Set<Viewer>()
  const popups = new Set<string>()

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
  const notice = (text: string) => broadcast({ t: 'notice', text })
  const sendFrame = (v: Viewer) => {
    if (!v.ready || !v.pending) return
    const f = v.pending
    v.pending = null
    v.ready = false
    send(v, { t: 'frame', ...f })
  }

  function engine(): BrowserEngine | null {
    for (const e of o.engines ?? defaultEngines()) if (existsSync(e.path)) return e
    return null
  }

  async function history() {
    if (!cdp || !page) return
    try {
      const h = await cdp.send<{ currentIndex: number; entries: { url: string; title: string }[] }>('Page.getNavigationHistory', {}, page)
      setState({ canBack: h.currentIndex > 0, canForward: h.currentIndex < h.entries.length - 1 })
    } catch {
      // the page is changing
    }
  }

  async function screencast() {
    if (!cdp || !page) return
    const sf = Math.min(2, Math.max(1, size.dpr))
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: sf, mobile: size.mobile }, page)
    await cdp.send('Page.stopScreencast', {}, page).catch(() => undefined)
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 62, maxWidth: Math.round(size.w * sf), maxHeight: Math.round(size.h * sf), everyNthFrame: 1 }, page)
  }

  function onEvent(method: string, params: Record<string, unknown>, sessionId?: string) {
    const c = cdp
    if (!c) return
    if (method === 'Page.screencastFrame' && sessionId === page) {
      void c.send('Page.screencastFrameAck', { sessionId: params.sessionId }, page).catch(() => undefined)
      const meta = (params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number }
      lastFrame = { data: String(params.data ?? ''), w: Math.round(meta.deviceWidth ?? size.w), h: Math.round(meta.deviceHeight ?? size.h) }
      for (const v of viewers) {
        v.pending = lastFrame
        sendFrame(v)
      }
      return
    }
    if (method === 'Page.frameNavigated' && sessionId === page) {
      const frame = (params.frame ?? {}) as { parentId?: string; url?: string; urlFragment?: string }
      if (frame.parentId) return
      const url = `${frame.url ?? ''}${frame.urlFragment ?? ''}`
      // The browser's own "can't reach this page" (its address stays the one he asked for).
      if (url.startsWith('chrome-error://')) {
        setState({ loading: false })
        notice(`${state.url || 'That address'} could not be reached from the Server.`)
        return
      }
      if (!browserMayShow(url)) {
        // Never another kind of page (file:, chrome:, a data: page): back to a blank one.
        void c.send('Page.navigate', { url: 'about:blank' }, page).catch(() => undefined)
        notice('That kind of page is not opened here: only http and https addresses.')
        return
      }
      setState({ url: url === 'about:blank' ? '' : url })
      void history()
      return
    }
    if (method === 'Page.navigatedWithinDocument' && sessionId === page) {
      setState({ url: String(params.url ?? state.url) })
      void history()
      return
    }
    if (method === 'Page.frameStartedLoading' && sessionId === page) return setState({ loading: true })
    if ((method === 'Page.frameStoppedLoading' || method === 'Page.loadEventFired') && sessionId === page) {
      setState({ loading: false })
      void history()
      return
    }
    if (method === 'Page.javascriptDialogOpening' && sessionId === page) {
      // Cancel, always (Leave, for a "leave this page?"): a dialog never confirms anything here. The viewer is told what it said.
      const type = String(params.type ?? '')
      void c.send('Page.handleJavaScriptDialog', { accept: type === 'beforeunload' }, page).catch(() => undefined)
      if (type !== 'beforeunload') notice(`The page asked: "${String(params.message ?? '').slice(0, 200)}". Answered Cancel (nothing was confirmed).`)
      return
    }
    if (method === 'Page.downloadWillBegin' || method === 'Browser.downloadWillBegin') {
      notice('Downloads are off in this browser: nothing was saved or installed.')
      return
    }
    if (method === 'Target.targetInfoChanged') {
      const info = (params.targetInfo ?? {}) as { targetId?: string; type?: string; title?: string; url?: string }
      if (info.targetId === pageTarget) {
        if (typeof info.title === 'string') setState({ title: info.title })
        return
      }
      // A popup: its address opens in the one view, and the popup goes.
      if (info.targetId && popups.has(info.targetId) && info.url && info.url !== 'about:blank') {
        popups.delete(info.targetId)
        void c.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined)
        if (browserMayShow(info.url) && page) void c.send('Page.navigate', { url: info.url }, page).catch(() => undefined)
      }
      return
    }
    if (method === 'Target.targetCreated') {
      const info = (params.targetInfo ?? {}) as { targetId?: string; type?: string }
      if (info.type === 'page' && info.targetId && pageTarget && info.targetId !== pageTarget) {
        popups.add(info.targetId)
        const id = info.targetId
        // One that stays blank (a page writing into it) goes after a moment.
        setTimeout(() => {
          if (popups.delete(id)) void c.send('Target.closeTarget', { targetId: id }).catch(() => undefined)
        }, 3000)
      }
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
    setState({ ...BROWSER_IDLE, starting: true, engine: e.name })
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
      page = null
      pageTarget = null
      lastFrame = null
      setState({ ...BROWSER_IDLE, engine: e.name })
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
      // Order o7e1e: the view's tab lives in a private context of its own: its cookies, storage and cache are in memory only, and gone when it
      // closes (or the moment this connection drops, the app stopping without a word). The tab the browser started with is closed.
      const first = (await c.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets')).targetInfos.filter(t => t.type === 'page')
      const ctx = (await c.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId
      const target = (await c.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId: ctx })).targetId
      pageTarget = target
      page = (await c.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target, flatten: true })).sessionId
      for (const t of first) await c.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined)
      // Only now: a tab that shows up from here on is a popup (the view's own tab, known already, is never one).
      await c.send('Target.setDiscoverTargets', { discover: true })
      await c.send('Page.enable', {}, page)
      // Downloads refused in both contexts (each has its own setting); not running at all rather than running with them allowed.
      await c.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: ctx, eventsEnabled: true })
      await c.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }).catch(() => undefined)
      await screencast()
      setState({ running: true, starting: false, error: null })
    } catch (err) {
      await stopProcess()
      await wipe()
      setState({ ...BROWSER_IDLE, engine: e.name })
      throw err
    }
  }

  async function ensure(): Promise<void> {
    // Opened while it was being closed: a new one, after.
    if (stopping) await stopping
    if (cdp && page && proc) return
    starting ??= launch().finally(() => {
      starting = null
    })
    await starting
  }

  async function go(input: string): Promise<void> {
    const url = browserUrl(input)
    if (!url) throw apiError(400, 'Only http and https addresses are opened here (or words to search for).')
    await ensure()
    lastUse = now()
    setState({ url, loading: true })
    await cdp!.send('Page.navigate', { url }, page!)
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
    page = null
    pageTarget = null
    lastFrame = null
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
      setState({ ...BROWSER_IDLE, engine: state.engine })
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

  async function handle(m: BrowserIn, v: Viewer) {
    // Anything a page says means it is open and in sight (a hidden page sends nothing, not even 'drawn').
    lastUse = now()
    if (m.t === 'here') return
    if (m.t === 'drawn') {
      v.ready = true
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
    if (!proc || stopping) return
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
      await go(url)
      const until = now() + (opt.waitMs ?? 15_000)
      await sleep(300)
      while (now() < until && state.loading) await sleep(200)
      return (await read(opt.max)) ?? { url: state.url, title: state.title, text: '', cut: false }
    },
    read,
    stop,
    attach(socket) {
      const v: Viewer = { socket, ready: true, pending: lastFrame }
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
