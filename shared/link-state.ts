import type { LiveStatus } from './live-socket.ts'

// F-057: what the one small sign at the top of the page says about the link. Pure, so it is tested
// without a page (link-state.test.ts); src/lib/live/ keeps the channels and the clock.
//   ok            nothing shown
//   connecting    the page just opened and no channel has been up yet (the server is slow or down)
//   reconnecting  a channel that was up is down again (the phone woke, the server restarted)
//   offline       the browser itself says there is no network
// A sign only shows once the trouble has lasted a moment: a socket replaced within two seconds, or
// a network that flickers while the phone changes from Wi-Fi to mobile data, never flashes it.

export type LinkState = 'ok' | 'connecting' | 'reconnecting' | 'offline'

export interface ChannelReport {
  status: LiveStatus
  /** When it came to that status, on the same clock as `now` (ms). */
  since: number
  /** It has been open at least once: if it is down now, the page is "reconnecting", not "connecting". */
  everOpen: boolean
}

export const SIGN_AFTER_MS = 2000
export const OFFLINE_AFTER_MS = 1200

export interface LinkAnswer {
  state: LinkState
  /** When to ask again if nothing else happens first: a sign that is due soon (null: nothing is waiting). */
  recheckInMs: number | null
}

/**
 * `offlineSince`: when the browser last said it went offline (null: it is online). `signAfterMs`: how long a channel is down before it counts (order ob8ca:
 * the quiet sign waits longer just after the app came back, src/lib/live; everywhere else it is SIGN_AFTER_MS, as before).
 */
export function linkState(channels: Iterable<ChannelReport>, offlineSince: number | null, now: number, signAfterMs = SIGN_AFTER_MS): LinkAnswer {
  let wait: number | null = null
  const due = (since: number, after: number) => {
    const left = since + after - now
    if (left <= 0) return true
    wait = wait === null ? left : Math.min(wait, left)
    return false
  }
  if (offlineSince !== null && due(offlineSince, OFFLINE_AFTER_MS)) return { state: 'offline', recheckInMs: null }
  let down: LinkState | null = null
  for (const c of channels) {
    // 'closed' is a channel that ended on purpose (a chat that finished): not a broken link.
    if (c.status !== 'connecting' && c.status !== 'waiting') continue
    if (!due(c.since, signAfterMs)) continue
    if (c.everOpen) return { state: 'reconnecting', recheckInMs: null }
    down = 'connecting'
  }
  return { state: down ?? 'ok', recheckInMs: wait }
}

export const LINK_TEXT: Record<Exclude<LinkState, 'ok'>, string> = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
}
