// F-106: saved views of the Agents page: a named arrangement of the chat windows (how many, the layout, which agent sits in which window).
// Pure helpers, so they are tested; the page keeps the list in this browser (src/agentic/views-store.ts).

export const VIEW_COUNTS = [1, 2, 3, 4, 5, 6] as const
export type ViewCount = (typeof VIEW_COUNTS)[number]
export type ViewLayout = 'columns' | 'grid'

export interface SavedView {
  id: string
  name: string
  count: ViewCount
  layout: ViewLayout
  /** One entry per window: the agent's id, or null for an empty window. */
  slots: (string | null)[]
}

const NAME_MAX = 40

/** A name as it is kept: trimmed, one line, not too long. '' when there is nothing in it. */
export const cleanName = (name: string) => name.replace(/\s+/gu, ' ').trim().slice(0, NAME_MAX)

/** The views in a stored value, whatever else it holds: anything that is not a well-formed view is left out. */
export function parseViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: SavedView[] = []
  for (const v of raw as unknown[]) {
    if (v === null || typeof v !== 'object') continue
    const { id, name, count, layout, slots } = v as Record<string, unknown>
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    if (typeof name !== 'string' || cleanName(name) === '') continue
    if (!(VIEW_COUNTS as readonly unknown[]).includes(count)) continue
    if (!Array.isArray(slots)) continue
    seen.add(id)
    out.push({
      id,
      name: cleanName(name),
      count: count as ViewCount,
      layout: layout === 'grid' ? 'grid' : 'columns',
      slots: (slots as unknown[]).slice(0, 6).map(s => (typeof s === 'string' ? s : null)),
    })
  }
  return out
}

/** "View 1", "View 2": the first not taken. */
export function nextName(views: SavedView[]): string {
  const taken = new Set(views.map(v => v.name.toLowerCase()))
  for (let n = 1; ; n++) if (!taken.has(`view ${n}`)) return `View ${n}`
}

/** A view made from what is on screen now. The slots are cut or padded to the window count. */
export function makeView(id: string, name: string, now: { count: ViewCount; layout: ViewLayout; slots: (string | null)[] }, views: SavedView[]): SavedView {
  return {
    id,
    name: cleanName(name) || nextName(views),
    count: now.count,
    layout: now.layout,
    slots: Array.from({ length: now.count }, (_, i) => now.slots[i] ?? null),
  }
}

/** The list with one view renamed; the list as it was when the name is empty or the view is not there. */
export function renameView(views: SavedView[], id: string, name: string): SavedView[] {
  const n = cleanName(name)
  if (n === '' || !views.some(v => v.id === id)) return views
  return views.map(v => (v.id === id ? { ...v, name: n } : v))
}

export const removeView = (views: SavedView[], id: string): SavedView[] => (views.some(v => v.id === id) ? views.filter(v => v.id !== id) : views)

/** Whether a view is what is on screen now (the same count, layout and agents in the same windows). */
export function isShowing(v: SavedView, now: { count: number; layout: string; slots: (string | null)[] }): boolean {
  if (v.count !== now.count || v.layout !== now.layout) return false
  for (let i = 0; i < v.count; i++) if ((v.slots[i] ?? null) !== (now.slots[i] ?? null)) return false
  return true
}
