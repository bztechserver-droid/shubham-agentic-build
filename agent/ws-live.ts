// F-057: the agent's half of the page's live link (the page's half is shared/live-socket.ts).
//   answers   the page's {"t":"ping","n":N} on every JSON socket it serves with {"t":"pong","n":N}, so
//             a page that was asleep can tell a live link from one that died without a sound
//   sweeps    a WebSocket ping frame every WS_PING_MS; a client that has sent nothing at all (no
//             frame, no pong) for WS_DEAD_MS is gone: the phone locked, its VPN dropped, the path
//             between died with no FIN or RST. Without this its socket, and everything hung on
//             it (a chat's output buffer, a page (Settings › Devices) that keeps the agent polling), stayed for
//             as long as the operating system chose to keep it, which can be never. Browsers
//             answer a ping frame by themselves, also when the page is frozen, so a phone that is
//             only asleep is not dropped.
// Pure apart from its timer, so it is tested (ws-live.test.ts) with tiny intervals.

export const WS_PING_MS = 20_000
export const WS_DEAD_MS = 65_000

/** The answer to a ping from the page, or null when the text is anything else (it is not touched). */
export function pongFor(text: string): string | null {
  if (!text.startsWith('{"t":"ping"')) return null
  const n = /"n":(\d{1,9})\b/.exec(text)
  return `{"t":"pong","n":${n ? n[1] : 0}}`
}

export interface Peer {
  /** When anything last arrived from the client (ms): a frame of any kind, a pong, half a frame. */
  seen(): number
  /** False once the socket is closing or gone: the sweep stops by itself. */
  alive(): boolean
  /** Writes a WebSocket ping frame. */
  ping(): void
  /** The client went silent: tear the connection down. */
  drop(): void
}

export interface KeepaliveOptions {
  pingMs?: number
  deadMs?: number
  now?: () => number
}

/** Starts the sweep for one client; the returned function stops it. */
export function keepalive(peer: Peer, o: KeepaliveOptions = {}): () => void {
  const now = o.now ?? Date.now
  const timer = setInterval(() => {
    if (!peer.alive()) return stop()
    if (now() - peer.seen() > (o.deadMs ?? WS_DEAD_MS)) {
      stop()
      return peer.drop()
    }
    try {
      peer.ping()
    } catch {
      // A socket that can't be written to is on its way out; the next sweep, or its close, ends it.
    }
  }, o.pingMs ?? WS_PING_MS)
  // The sweep never keeps the agent alive.
  timer.unref()
  function stop() {
    clearInterval(timer)
  }
  return stop
}
