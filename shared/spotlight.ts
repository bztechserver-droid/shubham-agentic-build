// F-063: the search bar (Ctrl+B / Cmd+B). What it lists, how a typed word narrows and orders it, and
// what is remembered, as plain functions; the view (src/spotlight/) only draws and runs them.

export type SpotKind = 'page' | 'floor' | 'chat' | 'action'

/** What choosing a row does. Nothing here presses a button: Update now only goes to Build. */
export type SpotRun =
  | { type: 'go'; to: string }
  | { type: 'mode'; mode: 'system' | 'light' | 'dark' }
  | { type: 'theme'; id: string }
  | { type: 'crm-full' }

export interface SpotItem {
  /** Stable across sessions: recents are kept by it ("page:/chats", "chat:<agent id>"). */
  id: string
  kind: SpotKind
  label: string
  /** The line under the label. */
  hint: string
  /** More words that find it without showing (a floor's chats' names, "dark" for the dark mode). */
  words?: string
  run: SpotRun
}

export const KIND_LABEL: Record<SpotKind, string> = { page: 'Pages', floor: 'Floors', chat: 'Chats', action: 'Actions' }

/**
 * Ctrl+B, or Cmd+B on a Mac. Alt+B is the CRM's (F-054), Shift or Alt with it is another shortcut,
 * and Ctrl+Alt is AltGr on many keyboards. The physical key is used (a layout that moves B still has
 * it), with the typed letter as the fallback for a layout where the code differs.
 */
export function isSpotlightShortcut(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code: string; key: string }): boolean {
  if (e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return false
  return e.code === 'KeyB' || e.key === 'b' || e.key === 'B'
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

/** 0: no match. Higher is better: the start of the name, then a word's start, then inside it, then the other words. */
export function scoreItem(item: SpotItem, needle: string): number {
  const label = norm(item.label)
  const rest = norm(`${item.hint} ${item.words ?? ''}`)
  const tokens = norm(needle).split(/\s+/).filter(Boolean)
  if (!tokens.length) return 1
  let total = 0
  for (const t of tokens) {
    let s = 0
    if (label.startsWith(t)) s = 100
    else if (label.split(/[\s\-_/.:()]+/).some(w => w.startsWith(t))) s = 80
    else if (label.includes(t)) s = 60
    else if (rest.split(/[\s\-_/.:()]+/).some(w => w.startsWith(t))) s = 35
    else if (rest.includes(t)) s = 20
    if (!s) return 0
    total += s
  }
  return total / tokens.length
}

/**
 * The rows to show. With nothing typed: what was chosen lately comes first (newest first), then
 * everything else in the order given. Typed: only what matches, best first, ties in the order given
 * (a recent one a little ahead of an equal that is not).
 */
export function rankItems(items: readonly SpotItem[], query: string, recents: readonly string[]): SpotItem[] {
  const needle = query.trim()
  const recency = (id: string) => {
    const at = recents.indexOf(id)
    return at < 0 ? 0 : recents.length - at
  }
  if (!needle) {
    const byId = new Map(items.map(i => [i.id, i]))
    const first = recents.flatMap(id => (byId.has(id) ? [byId.get(id)!] : []))
    const seen = new Set(first.map(i => i.id))
    return [...first, ...items.filter(i => !seen.has(i.id))]
  }
  return items
    .map((item, order) => ({ item, order, score: scoreItem(item, needle) + (recency(item.id) ? 4 + recency(item.id) / 100 : 0) }))
    .filter(r => scoreItem(r.item, needle) > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(r => r.item)
}

/** The list of recents with `id` newest, no repeat, at most `max`. */
export function pushRecent(recents: readonly string[], id: string, max = 6): string[] {
  return [id, ...recents.filter(r => r !== id)].slice(0, max)
}

/** What was kept in storage, trusted for nothing: an array of short strings. */
export function readRecents(raw: string | null): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? '')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200).slice(0, 12) : []
  } catch {
    return []
  }
}
