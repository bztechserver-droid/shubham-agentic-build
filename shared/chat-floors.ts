// F-055: the Chats list grouped by floor. The rules live here, apart from the page, so they are
// tested without one (chat-floors.test.ts): which floor goes first, what a header counts, which
// floors start open, what is remembered and how a bad memory is read, and what a search shows.
// Nothing here imports from the app; the page keeps the state (src/chat/floors.ts) and draws.

export interface FloorRef {
  id: string
  name: string
}

/** What the grouping needs to know of one chat in the list. */
export interface FloorItem {
  /** The agent's id. */
  key: string
  floor: FloorRef
  /** A question of its chat waits for the person. */
  waiting: boolean
  /** Its chat is working. */
  running: boolean
  /** It has written since the person last looked. */
  unread: boolean
}

/** What a floor's header says about its chats. */
export interface FloorCounts {
  total: number
  waiting: number
  running: number
  /** Chats with something not yet read, not counting the ones waiting: a row shows the ring for those, not the dot, and the header its badge. */
  unread: number
}

export interface FloorGroup<T extends FloorItem = FloorItem> extends FloorCounts {
  floor: FloorRef
  /** Its chats, in the order they were handed in (the caller sorts them). */
  items: T[]
}

export function countItems(items: readonly FloorItem[]): FloorCounts {
  let waiting = 0
  let running = 0
  let unread = 0
  for (const i of items) {
    if (i.waiting) waiting++
    if (i.running) running++
    if (i.unread && !i.waiting) unread++
  }
  return { total: items.length, waiting, running, unread }
}

// --- the floors, in order ---------------------------------------------------------------------

/**
 * The order the floors' headers go in: floors with a chat waiting for the person first, then the
 * rest. Each half keeps the order in which the floors first show up in `items`, which is the
 * Agents section's own (contacts come floor by floor), so a refresh never shuffles the headers.
 * Hand it the chats in that original order, not sorted by last message.
 */
export function floorOrder(items: readonly FloorItem[]): FloorRef[] {
  const seen = new Map<string, FloorRef>()
  const asking = new Set<string>()
  for (const i of items) {
    if (!seen.has(i.floor.id)) seen.set(i.floor.id, i.floor)
    if (i.waiting) asking.add(i.floor.id)
  }
  const floors = [...seen.values()]
  return [...floors.filter(f => asking.has(f.id)), ...floors.filter(f => !asking.has(f.id))]
}

/**
 * One group per floor that has at least one chat, in `order`; a floor with none (no agents, or
 * all filtered away) has no group. The chats of a group keep the order they came in. A chat whose
 * floor is not in `order` is listed after the others rather than dropped.
 */
export function groupByFloor<T extends FloorItem>(items: readonly T[], order: readonly FloorRef[]): FloorGroup<T>[] {
  const byFloor = new Map<string, T[]>()
  for (const i of items) {
    const list = byFloor.get(i.floor.id)
    if (list) list.push(i)
    else byFloor.set(i.floor.id, [i])
  }
  const groups: FloorGroup<T>[] = []
  const placed = new Set<string>()
  for (const floor of order) {
    const list = byFloor.get(floor.id)
    if (!list || placed.has(floor.id)) continue
    placed.add(floor.id)
    groups.push({ floor, items: list, ...countItems(list) })
  }
  for (const [id, list] of byFloor) {
    if (!placed.has(id)) groups.push({ floor: list[0].floor, items: list, ...countItems(list) })
  }
  return groups
}

// --- search -----------------------------------------------------------------------------------

/** What is typed, as it is compared: trimmed and lower case. Empty means no search. */
export const needleOf = (query: string) => query.trim().toLowerCase()

/**
 * The groups a search shows: only the floors with a chat that matches, holding only the chats
 * that match, so the counts are the matches. `text` is a chat's searchable text, lower case.
 * With nothing typed it is every group.
 */
export function groupFloors<T extends FloorItem & { text: string }>(items: readonly T[], order: readonly FloorRef[], query: string): FloorGroup<T>[] {
  const needle = needleOf(query)
  return groupByFloor(needle ? items.filter(i => i.text.includes(needle)) : items, order)
}

// --- open and closed --------------------------------------------------------------------------

/** What is remembered: floor id to whether it is open. A floor not in it has never been seen. */
export type OpenMap = Readonly<Record<string, boolean>>

/** What a floor needs to be given its first open or closed. */
export interface FloorFacts {
  id: string
  /** How many of its chats wait for the person. */
  waiting: number
  /** The conversation open on screen is one of its chats. */
  holdsSelected: boolean
}

/** A floor never seen before starts open only if something waits for the person there, or it holds the open conversation. */
export const initialOpen = (f: Pick<FloorFacts, 'waiting' | 'holdsSelected'>) => f.waiting > 0 || f.holdsSelected

/** The facts of every floor that has a chat, in `order`. `items` are all the chats: a search never narrows them. */
export function floorFacts(items: readonly FloorItem[], order: readonly FloorRef[], selectedKey: string | null): FloorFacts[] {
  return groupByFloor(items, order).map(g => ({ id: g.floor.id, waiting: g.waiting, holdsSelected: selectedKey !== null && g.items.some(i => i.key === selectedKey) }))
}

/** The remembered state of a floor, or undefined when it has none (own keys only: a floor named "toString" is not a function). */
export const rememberedOpen = (map: OpenMap, id: string): boolean | undefined => (Object.hasOwn(map, id) ? map[id] : undefined)

/**
 * Reads what was stored. Anything but a JSON object of booleans is not a memory: nothing at all,
 * bad JSON, an array or a number give an empty map (every floor then follows the first-sight
 * rule), and a value that is not a boolean is dropped on its own.
 */
export function parseOpenMap(raw: string | null | undefined): OpenMap {
  if (!raw) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'))
}

/**
 * Whether a floor is open as drawn. While searching, every floor with a match is open whatever is
 * remembered (and nothing remembered changes); `closedInSearch` is what the person folded since
 * they started typing, which is forgotten when the search is cleared. Otherwise the memory says,
 * and a floor with none follows the first-sight rule.
 */
export function floorIsOpen(o: { searching: boolean; stored: OpenMap; closedInSearch: ReadonlySet<string>; id: string; initial: boolean }): boolean {
  if (o.searching) return !o.closedInSearch.has(o.id)
  return rememberedOpen(o.stored, o.id) ?? o.initial
}

/**
 * The memory with a first value for every floor that has none, by the first-sight rule. Floors
 * that are remembered are left alone. Returns `stored` itself when nothing was new, so a caller
 * can tell that there is nothing to write.
 */
export function seedOpen(stored: OpenMap, floors: readonly FloorFacts[]): OpenMap {
  // Built through a Map, so that no floor id (not even "__proto__") is taken for a property setter.
  let next: Map<string, boolean> | null = null
  for (const f of floors) {
    if (next ? next.has(f.id) : rememberedOpen(stored, f.id) !== undefined) continue
    next ??= new Map(Object.entries(stored))
    next.set(f.id, initialOpen(f))
  }
  return next ? Object.fromEntries(next) : stored
}

/** The memory with these floors open or closed. Returns `stored` itself when nothing changed. */
export function withOpen(stored: OpenMap, ids: readonly string[], open: boolean): OpenMap {
  let next: Map<string, boolean> | null = null
  for (const id of ids) {
    if ((next ? next.get(id) : rememberedOpen(stored, id)) === open) continue
    next ??= new Map(Object.entries(stored))
    next.set(id, open)
  }
  return next ? Object.fromEntries(next) : stored
}

// --- the setting ------------------------------------------------------------------------------

/** `floors`: grouped under a header per floor (the default). `list`: the one flat list with its floor chips. */
export type GroupMode = 'floors' | 'list'

export const parseGroupMode = (raw: string | null | undefined): GroupMode => (raw === 'list' ? 'list' : 'floors')

// --- words --------------------------------------------------------------------------------------

/**
 * What a screen reader says for a floor's header, in one sentence. Whether it is open is the
 * button's own aria-expanded, so it is not said twice. The unread count is only mentioned while
 * the floor is closed, which is when the header (not the rows) carries it.
 */
export function floorSentence(name: string, c: FloorCounts, open: boolean): string {
  const parts = [name, `${c.total} ${c.total === 1 ? 'chat' : 'chats'}`]
  if (c.waiting > 0) parts.push(`${c.waiting} waiting for you`)
  if (!open && c.unread > 0) parts.push(`${c.unread} unread`)
  return parts.join(', ')
}
