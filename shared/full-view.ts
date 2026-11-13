// Order oa5ab (Shubham: "When we press the full screen button, the app shows 'full screen not supported'"): a Control screen goes full screen the
// browser's way when it can (the Fullscreen API: Chrome and Edge on a computer, Chrome on Android, Safari on an iPad, with Safari's webkit names),
// and otherwise the app's own way (src/pages/Remote.tsx): the viewer takes the whole window. "Otherwise" is: the API is not there (Safari on an
// iPhone offers it for videos only), the browser refuses (an Android WebView without onShowCustomView: the Agentic phone app before its fix), or it
// says yes and nothing happens. Never a "not supported" message. Pure: the page passes its document and the element.

export interface FullscreenDoc {
  fullscreenElement?: unknown
  webkitFullscreenElement?: unknown
  fullscreenEnabled?: boolean
  webkitFullscreenEnabled?: boolean
  exitFullscreen?: () => Promise<void>
  webkitExitFullscreen?: () => void
}
export interface FullscreenEl {
  requestFullscreen?: (options?: { navigationUI?: 'hide' | 'show' | 'auto' }) => Promise<void>
  webkitRequestFullscreen?: () => void
}

/** The element the browser shows full screen now, if any. */
export const browserFullElement = (doc: FullscreenDoc): unknown => doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null

/** Whether this browser may make an element full screen at all. */
export function browserFullscreenOffered(doc: FullscreenDoc, el: FullscreenEl | null): boolean {
  if (!el) return false
  if (typeof el.requestFullscreen !== 'function' && typeof el.webkitRequestFullscreen !== 'function') return false
  return doc.fullscreenEnabled !== false || doc.webkitFullscreenEnabled === true
}

/** How long a "yes" may take to show before it counts as nothing happening (a WebView that accepts and shows nothing). */
export const FULLSCREEN_SETTLE_MS = 600

/**
 * Asks the browser to show `el` full screen. Resolves true once the browser does; false when it is not offered, refuses, throws, or says yes and
 * nothing happens within FULLSCREEN_SETTLE_MS (then the app's own full view is used instead).
 */
export async function askBrowserFullscreen(doc: FullscreenDoc, el: FullscreenEl, o: { wait?: (ms: number) => Promise<void>; settleMs?: number } = {}): Promise<boolean> {
  if (!browserFullscreenOffered(doc, el)) return false
  const wait = o.wait ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  try {
    if (typeof el.requestFullscreen === 'function') await el.requestFullscreen({ navigationUI: 'hide' })
    else el.webkitRequestFullscreen?.()
  } catch {
    return false
  }
  if (browserFullElement(doc) === el) return true
  await wait(o.settleMs ?? FULLSCREEN_SETTLE_MS)
  return browserFullElement(doc) === el
}

/** Leaves the browser's full screen (nothing when it is not full screen). */
export function leaveBrowserFullscreen(doc: FullscreenDoc): void {
  if (!browserFullElement(doc)) return
  if (typeof doc.exitFullscreen === 'function') void doc.exitFullscreen().catch(() => undefined)
  else doc.webkitExitFullscreen?.()
}
