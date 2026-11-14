// Order o9d97 (Shubham: "the browser should have the option of PC and of this phone. Let this app have a native browser like Chrome, and let the
// overlay control it like it does app control") with o02a5 (its own tabs) and o15b2 ("rather I hit the URL from the phone and have you control
// it"): the phone side of the Browser page is a browser of the Agentic phone app itself (mobile/agentic: PhoneBrowser.kt), WebViews of its own
// under the page. What the page and the app say to each other over the app's private channel (window.SadApp.browser: the MessagePort the app
// hands the page's main frame, for the server's origin only). The app's side checks every message again (core/BrowserMessages.kt).
//
// How it shows: the page keeps a hole where the tab goes (its view box: nothing painted there, the page's own background painted around it), the
// app lays the tab's WebView exactly under that hole and lets the touches that land in it (and on nothing of the page above it) go to the tab. So
// the page's own layers (the Assistant's panel and button, menus, toasts, the Assistant's marker) stay on top of the tab, as on any app page.
//
// Privacy (order o7e1e, the same rules as the PC side): the tabs live in a WebView profile of their own (one per session: cookies, storage, cache
// and history apart from the app's own sign-in), never asked to save a password or a form, and the whole profile is deleted when he closes the
// phone browser (✕), when its last tab closes, after ten minutes unused, and when the app's screen closes; one left behind by a crash is deleted
// the next time. A phone whose WebView cannot keep such a profile gets no phone browser (never one in the app's own profile).

import type { BrowserTab } from './browser.ts'

/** What the app lists in SadApp.info.can when it has the phone browser (an older app does not: it needs the new version). */
export const PHONE_BROWSER_CAN = 'browser'

/** Ten minutes unused (the page out of sight, the app in the background): the phone browser closes and its profile is deleted. */
export const PHONE_BROWSER_IDLE_MS = 10 * 60_000

/** A rectangle in physical pixels of the app's page view (left, top, width, height). */
export type PhoneRect = [x: number, y: number, w: number, h: number]

/** What the page asks of the app (sent as { t: 'browser', ...op }). */
export type PhoneBrowserOp =
  /** The hole: where the open tab goes, and what of the page lies over it (touches there stay the page's). Sent again whenever either changes. */
  | { op: 'show'; rect: PhoneRect; covers: PhoneRect[] }
  /** The page left the phone side (another side, another page, out of sight): the tabs stay, unseen. */
  | { op: 'hide' }
  /** Opens `url` in tab `tab` (the open one when absent; 'new' for a new tab). */
  | { op: 'open'; url: string; tab?: string }
  | { op: 'tab'; do: 'new' | 'close' | 'select'; id?: string; url?: string }
  | { op: 'back' | 'forward' | 'reload'; tab?: string }
  /** Every tab closed and the private profile deleted. */
  | { op: 'close' }
  /** Say the state now. */
  | { op: 'state' }
  /** Runs `script` (shared/browser-look.ts) in the open tab and answers with its value (a reply with the same id). */
  | { op: 'eval'; id: string; tab: string; script: string }
  /** A real tap at (x, y), physical pixels of the tab's view. */
  | { op: 'tap'; id: string; tab: string; x: number; y: number }
  /** A real key press: Enter, Tab, Escape, Backspace, Delete, the arrows, PageUp, PageDown, Home, End or Space. */
  | { op: 'key'; id: string; tab: string; key: string }

/** What the app tells the page (sent as { t: 'browser', ...event }). */
export type PhoneBrowserEvent =
  /** Its tabs, the open one, and whether it can keep them private (false: no phone browser on this phone, `error` says why). */
  | { ev: 'state'; tabs: BrowserTab[]; active: string | null; private: boolean; error?: string | null }
  | { ev: 'reply'; id: string; ok: boolean; value?: string; error?: string }
  | { ev: 'notice'; text: string }

/** The keys a 'key' op may carry. */
export const PHONE_KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'] as const

const isTab = (v: unknown): v is BrowserTab => {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  return typeof t.id === 'string' && typeof t.url === 'string' && typeof t.title === 'string' && typeof t.loading === 'boolean' && typeof t.canBack === 'boolean' && typeof t.canForward === 'boolean'
}

/** An event of the app, as the page reads it (null: not one). */
export function parsePhoneEvent(raw: unknown): PhoneBrowserEvent | null {
  let m: unknown = raw
  if (typeof raw === 'string') {
    try {
      m = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof m !== 'object' || m === null) return null
  const x = m as Record<string, unknown>
  if (x.t !== 'browser') return null
  if (x.ev === 'state' && Array.isArray(x.tabs)) {
    const tabs = x.tabs.filter(isTab).slice(0, 16).map(t => ({ ...t, url: t.url.slice(0, 2048), title: t.title.slice(0, 300) }))
    const active = typeof x.active === 'string' && tabs.some(t => t.id === x.active) ? x.active : (tabs[0]?.id ?? null)
    return { ev: 'state', tabs, active, private: x.private === true, error: typeof x.error === 'string' ? x.error.slice(0, 300) : null }
  }
  if (x.ev === 'reply' && typeof x.id === 'string') {
    return { ev: 'reply', id: x.id, ok: x.ok === true, ...(typeof x.value === 'string' ? { value: x.value } : {}), ...(typeof x.error === 'string' ? { error: x.error.slice(0, 300) } : {}) }
  }
  if (x.ev === 'notice' && typeof x.text === 'string') return { ev: 'notice', text: x.text.slice(0, 300) }
  return null
}

/** Two lists of rectangles the same (the page sends 'show' again only when something moved). */
export const sameRects = (a: PhoneRect[], b: PhoneRect[]) => a.length === b.length && a.every((r, i) => r.every((v, j) => v === b[i][j]))

/**
 * What of the page lies over the hole, from what is on top at a grid of points in it (elementFromPoint): for each point where something other
 * than the hole is on top, the outermost element around it that still sits inside one layer (it stops below anything that holds the hole itself, or
 * that covers the whole hole: a full-screen layer is a frame, not the thing on top). Pure: `at` and `rectOf` are the page's.
 */
export function coversOf<E>(
  hole: { left: number; top: number; right: number; bottom: number },
  isHole: (e: E) => boolean,
  at: (x: number, y: number) => E | null,
  parentOf: (e: E) => E | null,
  holds: (outer: E, inner: E) => boolean,
  rectOf: (e: E) => { left: number; top: number; right: number; bottom: number },
  box: E,
  step = 20,
): { left: number; top: number; right: number; bottom: number }[] {
  const out: { left: number; top: number; right: number; bottom: number }[] = []
  const seen = new Set<E>()
  const wholeHole = (r: { left: number; top: number; right: number; bottom: number }) => r.left <= hole.left && r.top <= hole.top && r.right >= hole.right && r.bottom >= hole.bottom
  for (let y = hole.top + step / 2; y < hole.bottom; y += step) {
    for (let x = hole.left + step / 2; x < hole.right; x += step) {
      const hit = at(x, y)
      if (hit === null || isHole(hit)) continue
      let top = hit
      for (let p = parentOf(top); p !== null && !holds(p, box) && !wholeHole(rectOf(p)); p = parentOf(top)) top = p
      if (seen.has(top)) continue
      seen.add(top)
      const r = rectOf(top)
      const c = { left: Math.max(hole.left, r.left), top: Math.max(hole.top, r.top), right: Math.min(hole.right, r.right), bottom: Math.min(hole.bottom, r.bottom) }
      if (c.right > c.left && c.bottom > c.top) out.push(c)
    }
  }
  return out
}
