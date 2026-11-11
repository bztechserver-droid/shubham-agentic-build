// Order ob8ca (Shubham, 11 Nov: "every time I am opening this app, there is a reconnecting that comes. Can something be done when I install the app: a permanent
// socket between the phone and the overlay chat?"): how this device shows and handles the live link coming back. Three choices, each with the way before kept
// (Settings › Chats › Live link). Pure, so it is tested without a page (link-prefs.test.ts); src/lib/live/prefs.ts keeps it in the browser.
//   sign      'dot'    a small ring by the chat's name while it reconnects; words only when it lasts (QUIET_WORDS_AFTER_MS); the sign at the top of the page waits
//                      longer right after the app comes back (WAKE_SIGN_AFTER_MS) - the new way
//             'words'  "Reconnecting…" in the chat the moment its socket drops, the sign at the top after 2 s - the way before
//   wake      'quick'  shared/live-socket.ts's quick way: a new socket at once after a freeze, the chat first, a quicker heartbeat - the new way
//             'check'  ask the old socket first and wait out the usual backoff - the way before
//   keepCopy  true     the last messages of the chats shown here and the overlay's own chat are kept on this device, so the app paints them at once when it
//                      opens and catches up behind them - the new way
//             false    nothing kept: the chat waits for the server before it shows anything - the way before

export type LinkSign = 'dot' | 'words'
export type LinkWake = 'quick' | 'check'

export interface LinkPrefs {
  sign: LinkSign
  wake: LinkWake
  keepCopy: boolean
}

export const DEFAULT_LINK_PREFS: LinkPrefs = { sign: 'dot', wake: 'quick', keepCopy: true }

/** What is stored, read back; anything missing or unknown is the default. */
export function parseLinkPrefs(raw: unknown): LinkPrefs {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    sign: o.sign === 'words' ? 'words' : 'dot',
    wake: o.wake === 'check' ? 'check' : 'quick',
    keepCopy: o.keepCopy === false ? false : true,
  }
}

/** The dot: a reconnect quicker than this shows nothing at all. */
export const QUIET_DOT_AFTER_MS = 600
/** The dot's words ("Reconnecting…", "Connecting…") come only when it has lasted this long: a wake-up's reconnect never shows them. */
export const QUIET_WORDS_AFTER_MS = 4000
/** The sign at the top of the page, for this long after the app came back: it waits WAKE_SIGN_AFTER_MS, not 2 s (the reconnects of a wake-up take a moment). */
export const WAKE_QUIET_MS = 15_000
export const WAKE_SIGN_AFTER_MS = 5000

export type ChatSign = { dot: false; words: null } | { dot: true; words: null } | { dot: boolean; words: string }

/**
 * What a chat shows about its own socket. `link`: the feed's; `downMs`: how long it has not been live (0 while it is). `hasChat`: the chat has a session (one that
 * has never run has no socket to show). The way before ('words') says "Reconnecting…" at once when a live link drops and nothing while it first connects.
 */
export function chatSign(sign: LinkSign, link: 'connecting' | 'live' | 'down', downMs: number, hasChat: boolean): ChatSign {
  if (!hasChat || link === 'live') return { dot: false, words: null }
  if (sign === 'words') return link === 'down' ? { dot: false, words: 'Reconnecting…' } : { dot: false, words: null }
  if (downMs >= QUIET_WORDS_AFTER_MS) return { dot: true, words: link === 'down' ? 'Reconnecting…' : 'Connecting…' }
  return downMs >= QUIET_DOT_AFTER_MS ? { dot: true, words: null } : { dot: false, words: null }
}
