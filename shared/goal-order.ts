// F-128: ordering goals by dragging. Pure helpers (the page's glue is src/goals/reorder.ts and Goals.tsx), tested in goal-order.test.ts.
//
// Two orders are the CRM's, saved there: the person's own order of ALL their goals (PUT /v1/org/goals/my-order, { goal_ids }) and the order of the Today list
// (POST /v1/org/bucket/today/reorder, { goal_ids }). Both are plain lists of goal ids. A list on screen can be a FILTERED view of the saved order (a search, Open or Done),
// so a move inside it must keep every hidden goal where it was: mergeOrder does that.

/** Items in the saved order: those it names first, in its order; the rest after them, as they came (the caller's own default order). */
export function rankByOrder<T extends { id: string }>(items: readonly T[], order: readonly string[]): T[] {
  const at = new Map<string, number>()
  order.forEach((id, i) => {
    if (!at.has(id)) at.set(id, i)
  })
  const named: { item: T; i: number }[] = []
  const rest: T[] = []
  for (const item of items) {
    const i = at.get(item.id)
    if (i === undefined) rest.push(item)
    else named.push({ item, i })
  }
  named.sort((a, b) => a.i - b.i)
  return [...named.map(n => n.item), ...rest]
}

/** Where a dragged row would land: the id of the row it goes BEFORE (null = the end), from the middles of the other rows and where the pointer is. */
export function dropBefore(rows: readonly { id: string; mid: number }[], draggedId: string, y: number): string | null {
  for (const r of rows) {
    if (r.id === draggedId) continue
    if (y < r.mid) return r.id
  }
  return null
}

/** The list with `id` moved to just before `beforeId` (null = to the end). Unknown ids leave the list as it was. */
export function moveBefore(ids: readonly string[], id: string, beforeId: string | null): string[] {
  if (!ids.includes(id) || id === beforeId || (beforeId !== null && !ids.includes(beforeId))) return [...ids]
  const rest = ids.filter(x => x !== id)
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId)
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/** The list with `id` moved up (-1) or down (+1) by one place (the keyboard's way); at an end it stays. */
export function moveBy(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const i = ids.indexOf(id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= ids.length) return [...ids]
  const next = [...ids]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

/**
 * A move made in a view that shows only some of the saved list: `full` is the whole order, `shown` the ids on screen (in their order), `nextShown` the same ids after the move.
 * The places the shown ones held are refilled in the new order; every goal that is not shown stays exactly where it was. Ids of `shown` that `full` lacks are added at its end.
 */
export function mergeOrder(full: readonly string[], shown: readonly string[], nextShown: readonly string[]): string[] {
  const shownSet = new Set(shown)
  const seen = new Set<string>()
  const base = full.filter(id => (seen.has(id) ? false : (seen.add(id), true)))
  for (const id of shown) if (!seen.has(id)) base.push(id)
  const queue = nextShown.filter(id => shownSet.has(id))
  let q = 0
  return base.map(id => (shownSet.has(id) && q < queue.length ? queue[q++] : id))
}

/** True when two lists name the same ids in the same order. */
export const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * o9ae7: like rankByOrder, but the items the saved order does not name (new goals) go FIRST, the newest first (`createdAt`: a time in ms, or null when unknown, which goes last among them;
 * a tie keeps the caller's own order), then the named ones in their order. Never changes its input.
 */
export function rankByOrderNewFirst<T extends { id: string }>(items: readonly T[], order: readonly string[], createdAt: (item: T) => number | null = () => null): T[] {
  const named = new Set(order)
  const fresh = items.filter(item => !named.has(item.id))
  const rest = items.filter(item => named.has(item.id))
  fresh.sort((a, b) => {
    const ta = createdAt(a)
    const tb = createdAt(b)
    return ta === tb ? 0 : ta === null ? 1 : tb === null ? -1 : tb - ta
  })
  return [...fresh, ...rankByOrder(rest, order)]
}
