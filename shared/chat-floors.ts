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
 * The order the floors' headers go in: the Agents section's own, which is the order in which the
 * floors first show up in `items` (contacts come floor by floor). One order everywhere (F-059): a
 * floor moved here is moved there, and a floor that starts waiting does not jump ahead of the
 * rest, so a refresh never shuffles the headers. Hand it the chats in that original order, not
 * sorted by last message.
 */
export function floorOrder(items: readonly FloorItem[]): FloorRef[] {
  const seen = new Map<string, FloorRef>()
  for (const i of items) if (!seen.has(i.floor.id)) seen.set(i.floor.id, i.floor)
  return [...seen.values()]
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

// --- moving floors and chats (F-059) ------------------------------------------------------------

/**
 * The order of the floors' ids with `floorId` put before `beforeId`, or last when `beforeId` is
 * null. Null when that changes nothing (it is there already, or an id is not in the order), so
 * nothing is sent. `order` is every floor of the Agents section, the ones with no chat too.
 */
export function moveFloor(order: readonly string[], floorId: string, beforeId: string | null): string[] | null {
  if (!order.includes(floorId) || floorId === beforeId) return null
  if (beforeId !== null && !order.includes(beforeId)) return null
  const rest = order.filter(id => id !== floorId)
  rest.splice(beforeId === null ? rest.length : rest.indexOf(beforeId), 0, floorId)
  return rest.every((id, i) => id === order[i]) ? null : rest
}

/**
 * A floor one place up (-1) or down (1) among the floors that show, for the keyboard. `shown` is
 * the ids on screen, in order. Up it goes before the one above it, down before the one after the
 * next (or last); null at either end.
 */
export function stepFloor(order: readonly string[], shown: readonly string[], floorId: string, step: -1 | 1): string[] | null {
  const at = shown.indexOf(floorId)
  const next = shown[at + step]
  if (at < 0 || next === undefined) return null
  return moveFloor(order, floorId, step === -1 ? next : (shown[at + 2] ?? null))
}

// --- where a drag lands (F-059) -----------------------------------------------------------------
//
// The page measures the list (the rectangles of its floors and chat rows, in screen coordinates)
// and asks these where a dragged floor or chat would go for a pointer at `y`. Pure arithmetic on
// numbers, so every case is tested without a browser.

export interface DropRow {
  id: string
  top: number
  bottom: number
  mid: number
  /** The floor's boss: always first, so nothing is dropped before it. */
  boss: boolean
}

export interface DropSection {
  id: string
  /** The whole floor: its header and, while it is open, its chats. */
  top: number
  bottom: number
  left: number
  width: number
  headerTop: number
  headerBottom: number
  headerMid: number
  /** Its chats as drawn, top to bottom (none while it is closed). */
  rows: DropRow[]
}

/** A floor dragged to `y`: the floor it goes before (null: last). The floor itself is skipped. */
export function floorDropBefore(sections: readonly DropSection[], draggedId: string, y: number): string | null {
  for (const s of sections) {
    if (s.id !== draggedId && y < s.headerMid) return s.id
  }
  return null
}

export interface AgentDrop {
  floorId: string
  /** The chat it goes before (null: last on that floor). */
  beforeId: string | null
}

/**
 * A chat dragged to `y`: over a floor's header it goes into that floor (last; on its own floor,
 * first after the boss); over its chats, before the first one whose middle is below the pointer,
 * or last. The chat itself is skipped, and nothing goes before a floor's boss.
 */
export function agentDropAt(sections: readonly DropSection[], dragged: { id: string; floorId: string }, y: number): AgentDrop | null {
  if (sections.length === 0) return null
  // The floor under the pointer: the last one that has started; above the first, the first.
  let s = sections[0]
  for (const t of sections) if (t.top <= y) s = t
  const rows = s.rows.filter(r => r.id !== dragged.id)
  const afterBoss = rows.find(r => !r.boss)?.id ?? null
  if (y < s.headerBottom || rows.length === 0) return { floorId: s.id, beforeId: s.id === dragged.floorId ? afterBoss : null }
  let before: string | null = null
  for (const r of rows) {
    if (y < r.mid) {
      before = r.id
      break
    }
  }
  if (before !== null && rows.find(r => r.id === before)?.boss) before = afterBoss
  return { floorId: s.id, beforeId: before }
}

/** Whether dropping there changes nothing: the same floor, and it would stay where it is. `ids`: that floor's chats in the order drawn. */
export function agentDropIsNoop(ids: readonly string[], draggedId: string, from: string, drop: AgentDrop): boolean {
  if (drop.floorId !== from) return false
  const at = ids.indexOf(draggedId)
  if (at < 0) return false
  return drop.beforeId === draggedId || drop.beforeId === (ids[at + 1] ?? null)
}

/**
 * The keyboard: a chat one place up (-1) or down (1) on its floor, as the `before` the move takes
 * (null: last). Null where it cannot go: past the ends, or above the boss.
 */
export function stepAgentBefore(rows: readonly { id: string; boss: boolean }[], id: string, step: -1 | 1): { beforeId: string | null } | null {
  const at = rows.findIndex(r => r.id === id)
  if (at < 0) return null
  const to = at + step
  if (to < 0 || to >= rows.length || rows[to].boss) return null
  return { beforeId: step === -1 ? rows[to].id : (rows[to + 1]?.id ?? null) }
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

/**
 * How a floor never seen before starts (F-065). `closed`, the default: every floor starts collapsed, and
 * what the person opens or closes is remembered. `waiting`, the way it was (F-055): open only if something
 * waits for the person there, or it holds the open conversation.
 */
export type StartRule = 'closed' | 'waiting'

export const parseStartRule = (raw: string | null | undefined): StartRule => (raw === 'waiting' ? 'waiting' : 'closed')

export const initialOpen = (f: Pick<FloorFacts, 'waiting' | 'holdsSelected'>, rule: StartRule = 'closed') => rule === 'waiting' && (f.waiting > 0 || f.holdsSelected)

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
export function seedOpen(stored: OpenMap, floors: readonly FloorFacts[], rule: StartRule = 'closed'): OpenMap {
  // Built through a Map, so that no floor id (not even "__proto__") is taken for a property setter.
  let next: Map<string, boolean> | null = null
  for (const f of floors) {
    if (next ? next.has(f.id) : rememberedOpen(stored, f.id) !== undefined) continue
    next ??= new Map(Object.entries(stored))
    next.set(f.id, initialOpen(f, rule))
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
