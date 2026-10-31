// F-057: has the server started to serve a newer build than the page in hand? After Update now
// the agent comes back with the new build's files, but a page that was open keeps running the old
// ones (and its lazy chunks are gone), so it must reload by itself: at a calm moment, and never in
// a loop. Pure (the page's glue is src/lib/live/version.ts), tested in version-watch.test.ts.
//
// How it tells: a built page names its entry script with a hash ("/assets/index-Ab12Cd34.js").
// A fresh no-store GET of "/" names the one the server serves now; a different name = a new build.
// The dev server's page ("/src/main.tsx") and any error page name none: 'unknown', nothing happens.

/** A script's src, if it is a built entry ("/assets/index-Ab12.js"): without its query. */
export function entrySrc(src: string | null | undefined): string | null {
  return src && /\/assets\/[^/?#]+\.js(?:[?#]|$)/.test(src) ? src.split(/[?#]/)[0] : null
}

/** The entry script of a built page, or null (the dev server's page, an error page, anything else). */
export function entryOf(html: string): string | null {
  for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
    if (!/\btype\s*=\s*["']?module\b/i.test(tag[0])) continue
    const entry = entrySrc(/\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1])
    if (entry) return entry
  }
  return null
}

export type Version = 'same' | 'newer' | 'unknown'

/** The entry the page was loaded with, against the page the server gives now. */
export function compareEntry(loaded: string | null, freshHtml: string): Version {
  const fresh = entryOf(freshHtml)
  if (!loaded || !fresh) return 'unknown'
  return loaded === fresh ? 'same' : 'newer'
}

export type ReloadDecision = 'reload' | 'wait' | 'none'

/** A reload this soon after the last is a loop (two servers answering by turns, say): leave it. */
export const RELOAD_GAP_MS = 30_000

export interface ReloadInput {
  version: Version
  /** Half-typed text is in a field the person is in. */
  typing: boolean
  /** The page is in the background: it asks again when it is back. */
  hidden: boolean
  now: number
  lastReloadAt: number | null
}

export function reloadDecision(i: ReloadInput): ReloadDecision {
  if (i.version !== 'newer') return 'none'
  if (i.lastReloadAt !== null && i.now - i.lastReloadAt < RELOAD_GAP_MS) return 'none'
  if (i.typing || i.hidden) return 'wait'
  return 'reload'
}
