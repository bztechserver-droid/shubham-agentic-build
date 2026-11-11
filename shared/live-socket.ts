// F-057: one reconnecting WebSocket for every live channel of the page. Pure (no DOM, no globals:
// the socket, the timers and the clock come in as `deps`), so the whole of it is tested with fake
// sockets and a fake clock (live-socket.test.ts). src/lib/live/ binds it to the browser.
//
// What a phone does to a WebSocket, and what this does about it:
//   closed under it     (server restarted, network changed): reconnect with a short backoff
//   dead, never closed  (screen locked, VPN off, a path that drops packets: the page still sees
//                       OPEN for minutes): a ping every `everyMs` of silence, and a check the
//                       moment the page is back; no answer within `replyMs` = dead, reconnect now
//   handshake that hangs (the same dead path, for a new socket): abandoned after `connectTimeoutMs`
//   page paused itself (frozen, or timers throttled): a timer that fires late says so, and the
//                       answer may be queued behind it, so it asks once more before giving up
// The ping is a text message {"t":"ping","n":N} that the agent (agent/ws-live.ts) answers with
// {"t":"pong","n":N} on every socket it serves. ANY message counts as life, so a busy socket is
// never pinged. An agent that doesn't answer (older) costs one needless reconnect per check.
//
// Order ob8ca (Shubham: "every time I am opening this app, there is a reconnecting"), the quick way
// (deps.quick(), Settings › Chats › Live link; the way before stays the other choice):
//   a page that was frozen  Chrome itself closes a frozen page's sockets as it comes back (measured,
//                           Chrome 157): a new socket at once, no question first
//   hidden a long time      (30 s and more) the old socket gets 1.2 s to answer the check, not 3.5 s
//   the drop of a wake-up   the first drop within 3 s of the page coming back reconnects at once,
//                           not after the 250 ms backoff (failures after it back off as before)
//   who goes first          a browser lets ONE WebSocket handshake to a server run at a time
//                           (RFC 6455 4.1, measured), so those reconnects are spaced by priority: the
//                           chat on screen (0), the floors (1), the rest (2), 40 ms apart
//   a quicker heartbeat     a ping after 10 s of silence, 5 s to answer (the way before: 20 s and 8 s)

/** WebSocket.OPEN. */
export const OPEN = 1

export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface LiveDeps {
  open(url: string): WebSocketLike
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
  now(): number
  random(): number
  /** False while the page is hidden: nothing is pinged then (timers are throttled and nobody looks). */
  visible(): boolean
  /** Order ob8ca: true = the quick way (the top of this file); false or missing = the way before. Read at every decision, so a change applies at once. */
  quick?(): boolean
}

/** connecting: a socket is opening. open. waiting: between two attempts. closed: stopped, for good or until reconnect(). */
export type LiveStatus = 'connecting' | 'open' | 'waiting' | 'closed'

/** How an attempt ended: the socket closed, or it never opened in time, or it stopped answering. */
export type DropWhy = 'closed' | 'connect-timeout' | 'no-answer' | 'stale'

export interface Drop {
  code: number
  reason: string
  /** The socket had opened. */
  opened: boolean
  /** It had delivered at least one message (so the server was really there, not just a gate that says 502). */
  heard: boolean
}

export interface LiveOptions {
  /** Read on every attempt. */
  url: () => string
  /** A message of the page's own (the answers to pings never get here). */
  onMessage: (data: string) => void
  /**
   * A socket opened (before its first message). `again` is true for every open after the first;
   * `awayMs` is how long the link was down. This is where a channel catches up on what it missed.
   */
  onOpen?: (info: { again: boolean; awayMs: number }) => void
  /** An attempt ended, and when the next one starts (null: never). */
  onDrop?: (info: Drop & { why: DropWhy; retryInMs: number | null }) => void
  onStatus?: (status: LiveStatus) => void
  /** False: this ending is final (a chat that ended), the channel stays closed. Default: always try again. */
  retry?: (drop: Drop) => boolean
  /** Pings. false: none at all, neither now and then nor when the page is back (a socket the agent doesn't answer on). */
  heartbeat?: false | { everyMs?: number; replyMs?: number; resumeReplyMs?: number }
  backoffMs?: readonly number[]
  connectTimeoutMs?: number
  /** Order ob8ca: who reconnects first when they all do at once (the quick way): 0 the chat on screen, 1 the floors, 2 the rest (the default). */
  priority?: number
}

/** What the page knows as it comes back (src/lib/live). */
export interface WakeInfo {
  /** How long it was hidden (ms); 0 or missing: it was not. */
  hiddenMs?: number
  /** It was frozen (Page Lifecycle: 'freeze', then 'resume'). */
  frozen?: boolean
  /** Another channel to the same server has just found its link dead: this one is checked quickly too. */
  suspect?: boolean
}

export interface Live {
  readonly status: LiveStatus
  /** Sends if the socket is open; false otherwise. Nothing is queued: a message is the caller's to keep. */
  send(text: string): boolean
  /** The page is back, or the network is: reconnect now when down, check the link when up (the quick way: a new socket at once after a freeze). */
  wake(info?: WakeInfo): void
  /** "Try again": drop whatever there is and connect now, the backoff forgotten. */
  reconnect(): void
  /** Stops for good. */
  close(): void
}

// Never longer than 5 s between tries: the server of an update or a restart is back within seconds, and a refused
// connection costs nothing. (A page that knows better, the guard's /guard/status saying the app is up, asks to
// reconnect at once: src/lib/live/guard.ts.)
export const BACKOFF_MS: readonly number[] = [250, 500, 1000, 2000, 3000, 5000]
export const HEARTBEAT = { everyMs: 20_000, replyMs: 8000, resumeReplyMs: 3500 }
/** Order ob8ca, the quick way: a link that died without a sound is found within 15 s while the page is in front (the way before: up to 28 s). */
export const QUICK_HEARTBEAT = { everyMs: 10_000, replyMs: 5000, resumeReplyMs: 3500 }
/** The quick way: hidden this long, the old socket gets QUICK_CHECK_MS to answer (a phone's is as good as dead by then; a computer's answers at once). */
export const STALE_AFTER_MS = 30_000
export const QUICK_CHECK_MS = 1200
/** The quick way: the first drop this soon after the page came back reconnects at once. */
export const WAKE_WINDOW_MS = 3000
/** The quick way: between two priorities' reconnects, so the browser's one-at-a-time handshakes follow them. */
export const STAGGER_MS = 40
export const CONNECT_TIMEOUT_MS = 10_000
/** A handshake older than this when the page comes back is hung on a dead path: start again. */
const STUCK_MS = 2000
/** A timer this late means the page itself was paused. */
const LATE_MS = 1500

const isPong = (s: string) => s.charCodeAt(0) === 123 && s.startsWith('{"t":"pong"')

export function openLive(o: LiveOptions, d: LiveDeps): Live {
  const backoff = o.backoffMs?.length ? o.backoffMs : BACKOFF_MS
  const quick = () => d.quick?.() === true
  /** Read each time: the quick way's numbers or the way before's, under whatever the channel set itself. */
  const beatNow = () => (o.heartbeat === false ? null : { ...(quick() ? QUICK_HEARTBEAT : HEARTBEAT), ...o.heartbeat })
  const connectTimeout = o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  /** The quick way: when the page came back, until its first drop has been reconnected at once. */
  let wokeAt: number | null = null

  interface Attempt {
    socket: WebSocketLike
    opened: boolean
    heard: boolean
  }
  let cur: Attempt | null = null
  let status: LiveStatus = 'closed'
  let stopped = false
  let ended = false
  let attempt = 0
  let seq = 0
  let openedBefore = false
  let downSince: number | null = null
  let lastRx = 0
  let startedAt = 0
  let probeDeadline: number | null = null
  let retryTimer: unknown = null
  let connectTimer: unknown = null
  let beatTimer: unknown = null
  let probeTimer: unknown = null

  const stopTimer = (t: unknown) => {
    if (t !== null) d.clearTimeout(t)
  }
  const stopWatch = () => {
    stopTimer(connectTimer)
    stopTimer(beatTimer)
    stopTimer(probeTimer)
    connectTimer = beatTimer = probeTimer = null
    probeDeadline = null
  }
  const setStatus = (next: LiveStatus) => {
    if (status === next) return
    status = next
    o.onStatus?.(next)
  }
  const detach = (socket: WebSocketLike) => {
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
  }
  const hangUp = (socket: WebSocketLike, code?: number, reason?: string) => {
    detach(socket)
    try {
      socket.close(code, reason)
    } catch {
      // Already gone.
    }
  }
  const jitter = (ms: number) => Math.round(ms * (0.8 + 0.4 * d.random()))
  /** The quick way's "at once": the channel's place in the queue, and a little jitter. */
  const stagger = () => Math.max(0, o.priority ?? 2) * STAGGER_MS + Math.floor(d.random() * 20)

  /** The attempt is over; the next one is planned (or none, when `retry` says this was final). */
  const over = (drop: Drop, why: DropWhy) => {
    stopWatch()
    if (downSince === null) downSince = d.now()
    const again = o.retry ? o.retry(drop) : true
    if (stopped) return
    if (!again) {
      ended = true
      setStatus('closed')
      o.onDrop?.({ ...drop, why, retryInMs: null })
      return
    }
    // A link found dead was fine a moment ago: try at once, not after a backoff.
    if (why === 'no-answer' || why === 'stale') attempt = 0
    // The quick way: the first drop that comes with the page coming back (Chrome closing a frozen page's sockets, a check that failed) is reconnected at once.
    const ofWake = quick() && wokeAt !== null && d.now() - wokeAt <= WAKE_WINDOW_MS
    if (ofWake) {
      wokeAt = null
      attempt = 0
    }
    const step = Math.min(attempt++, backoff.length - 1)
    const now = ofWake || (quick() && (why === 'no-answer' || why === 'stale'))
    const delay = now ? stagger() : why === 'no-answer' ? Math.floor(d.random() * 250) : jitter(backoff[step])
    setStatus('waiting')
    o.onDrop?.({ ...drop, why, retryInMs: delay })
    if (stopped) return
    retryTimer = d.setTimeout(connect, delay)
  }

  const abandon = (a: Attempt, code: number, reason: string, why: DropWhy) => {
    if (cur !== a) return
    cur = null
    hangUp(a.socket, code, reason)
    over({ code, reason, opened: a.opened, heard: a.heard }, why)
  }

  const sendPing = (a: Attempt) => {
    try {
      a.socket.send(`{"t":"ping","n":${++seq}}`)
    } catch {
      // A socket that can't send is dead: the deadline below finds out.
    }
  }

  /** Waits at most `within` ms for any message; none, and the link is dead. */
  const ping = (within: number) => {
    const a = cur
    if (!a?.opened) return
    const deadline = d.now() + within
    if (probeDeadline !== null && probeDeadline <= deadline) return
    probeDeadline = deadline
    sendPing(a)
    stopTimer(probeTimer)
    probeTimer = d.setTimeout(() => check(a, within), within)
  }
  const check = (a: Attempt, within: number) => {
    probeTimer = null
    if (cur !== a || probeDeadline === null) return
    if (d.now() - probeDeadline > LATE_MS) {
      // This timer ran late: the page was frozen or throttled, and the answer may be queued
      // right behind us. Ask again and give it its time.
      probeDeadline = d.now() + within
      sendPing(a)
      probeTimer = d.setTimeout(() => check(a, within), within)
      return
    }
    abandon(a, 4001, 'no answer', 'no-answer')
  }

  const scheduleBeat = () => {
    stopTimer(beatTimer)
    beatTimer = null
    const beat = beatNow()
    if (!beat || !cur?.opened) return
    const idle = d.now() - lastRx
    const wait = probeDeadline !== null || idle >= beat.everyMs ? beat.everyMs : beat.everyMs - idle
    beatTimer = d.setTimeout(onBeat, Math.max(500, wait))
  }
  const onBeat = () => {
    beatTimer = null
    const beat = beatNow()
    if (!beat || !cur?.opened) return
    if (d.visible() && probeDeadline === null && d.now() - lastRx >= beat.everyMs) ping(beat.replyMs)
    scheduleBeat()
  }

  function connect() {
    retryTimer = null
    if (stopped) return
    ended = false
    let socket: WebSocketLike
    try {
      socket = d.open(o.url())
    } catch (e) {
      // A bad address or a refused constructor: a failed attempt like any other.
      cur = null
      setStatus('connecting')
      over({ code: 4002, reason: e instanceof Error ? e.message : String(e), opened: false, heard: false }, 'closed')
      return
    }
    const a: Attempt = { socket, opened: false, heard: false }
    cur = a
    startedAt = d.now()
    setStatus('connecting')
    connectTimer = d.setTimeout(() => {
      connectTimer = null
      if (cur === a && !a.opened) abandon(a, 4000, 'connect timeout', 'connect-timeout')
    }, connectTimeout)
    socket.onopen = () => {
      if (cur !== a) return
      a.opened = true
      stopTimer(connectTimer)
      connectTimer = null
      lastRx = d.now()
      const again = openedBefore
      const awayMs = again && downSince !== null ? d.now() - downSince : 0
      openedBefore = true
      downSince = null
      setStatus('open')
      scheduleBeat()
      o.onOpen?.({ again, awayMs })
    }
    socket.onmessage = e => {
      if (cur !== a) return
      lastRx = d.now()
      a.heard = true
      attempt = 0
      if (probeDeadline !== null) {
        probeDeadline = null
        stopTimer(probeTimer)
        probeTimer = null
      }
      const data = typeof e.data === 'string' ? e.data : String(e.data)
      if (!isPong(data)) o.onMessage(data)
    }
    // The close that follows an error says it all.
    socket.onerror = () => {}
    socket.onclose = e => {
      if (cur !== a) return
      cur = null
      detach(socket)
      over({ code: e.code, reason: e.reason, opened: a.opened, heard: a.heard }, 'closed')
    }
  }

  function wake(info: WakeInfo = {}) {
    if (stopped || ended) return
    if (quick()) wokeAt = d.now()
    if (retryTimer !== null) {
      stopTimer(retryTimer)
      retryTimer = null
      attempt = 0
      connect()
      return
    }
    const a = cur
    if (!a) return
    if (!a.opened) {
      if (d.now() - startedAt > STUCK_MS) {
        abandon(a, 4000, 'stuck', 'connect-timeout')
        wake()
      }
      return
    }
    // The quick way: the browser closes a frozen page's sockets as it comes back, so a new one now rather than a question first.
    if (quick() && info.frozen) return abandon(a, 4004, 'stale', 'stale')
    const beat = beatNow()
    if (!beat) return
    ping(quick() && (info.suspect || (info.hiddenMs ?? 0) >= STALE_AFTER_MS) ? Math.min(QUICK_CHECK_MS, beat.resumeReplyMs) : beat.resumeReplyMs)
  }

  function reconnect() {
    if (stopped) return
    stopTimer(retryTimer)
    retryTimer = null
    const a = cur
    if (a) {
      cur = null
      stopWatch()
      if (downSince === null && a.opened) downSince = d.now()
      hangUp(a.socket, 1000)
    }
    attempt = 0
    connect()
  }

  function close() {
    if (stopped) return
    stopped = true
    stopTimer(retryTimer)
    retryTimer = null
    stopWatch()
    const a = cur
    cur = null
    if (a) hangUp(a.socket, 1000)
    setStatus('closed')
  }

  connect()

  return {
    get status() {
      return status
    },
    send(text) {
      const a = cur
      if (!a?.opened || a.socket.readyState !== OPEN) return false
      try {
        a.socket.send(text)
        return true
      } catch {
        return false
      }
    },
    wake,
    reconnect,
    close,
  }
}
