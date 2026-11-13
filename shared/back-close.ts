// F-100: the phone's Back button closes the overlay chat, the same as its cross.
//
// While the overlay is open on a phone, one extra history entry (a copy of the page's own, marked) sits on top of the page's. Back removes
// that entry and the overlay closes: the page is not left. When the overlay closes any other way (the cross, Esc, the button, the assistant),
// the entry is taken off again with history.back(), so a later Back goes where it always went. Nothing here knows about the router: the copy keeps
// the router's own state fields, so a popstate onto it is the same page.

export interface HistoryLike {
  readonly state: unknown
  pushState(state: unknown, unused: string): void
  back(): void
}

export interface BackCloseDeps {
  history: HistoryLike
  /** The page's address now (an entry's identity is its router key plus this). */
  href: () => string
  isOpen: () => boolean
  close: () => void
  now?: () => number
  /** Order o3963: the name of the history entry's mark: a second layer (the Control screen over the chat) keeps its own, so Back closes the top one first. */
  mark?: string
}

export interface BackClose {
  /** The overlay opened or closed (by any means), and whether Back should close it here (a phone-width window). */
  sync(open: boolean, enabled: boolean): void
  /** A popstate happened. */
  onPop(): void
}

const OVERLAY_MARK = '__sadOverlay'
/** A history.back() we made whose popstate has not come: ignored for at most this long, so one that never comes cannot jam it. */
const PENDING_MS = 1500

export function createBackClose(deps: BackCloseDeps): BackClose {
  const h = deps.history
  const MARK = deps.mark ?? OVERLAY_MARK
  const now = deps.now ?? Date.now
  let was = false
  let enabled = false
  let pending = 0
  let pendingAt = 0
  /** The identity of the page entry our copy sits on top of: Back landing on it is the user's Back from our entry. */
  let base: string | null = null

  const obj = (): Record<string, unknown> => (h.state && typeof h.state === 'object' ? (h.state as Record<string, unknown>) : {})
  const marked = () => obj()[MARK] === 1
  const sig = () => `${typeof obj().key === 'string' ? (obj().key as string) : ''}|${deps.href()}`
  const pendingActive = () => {
    if (pending > 0 && now() - pendingAt >= PENDING_MS) pending = 0
    return pending > 0
  }
  const push = () => {
    base = sig()
    h.pushState({ ...obj(), [MARK]: 1 }, '')
  }
  const goBack = () => {
    pending++
    pendingAt = now()
    h.back()
  }

  return {
    sync(open, on) {
      const before = was
      was = open
      enabled = on
      if (open) {
        if (!on || pendingActive()) return
        if (marked()) base = sig()
        else push()
        return
      }
      // Closed by some other way than Back: take our entry off, but only when it is the one on top (the page may have moved on since).
      if (before && marked() && !pendingActive()) goBack()
    },
    onPop() {
      if (pendingActive()) {
        pending--
        // Opened again while the old entry was being taken off: now there is room for the new one.
        if (deps.isOpen() && enabled && !marked()) push()
        return
      }
      if (!deps.isOpen()) {
        // Back (or Forward) landed on an entry of ours that is no longer wanted: step over it. Forward onto it steps back too; that is the price.
        if (marked()) goBack()
        return
      }
      if (marked()) {
        base = sig()
        return
      }
      if (base !== null && sig() === base) {
        base = null
        deps.close()
      }
    },
  }
}
