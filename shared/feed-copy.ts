import type { ChatState, Floor, FloorAgent } from './agentic.ts'
import type { ChatItem } from './chat.ts'

// Order ob8ca: the copy of a chat that this device keeps, so the app paints the chat at once when it opens (Android often drops the page while the app is in the
// background, and a phone's sockets take a moment to come back), then catches up behind it: the server's own `hello` replaces the copy as soon as it comes
// (src/chat/feed-state.ts). Only while Settings › Chats › Live link › "Keep the last messages on this device" is on (the default; off is the way before:
// nothing kept). Pure, so it is tested without a page (feed-copy.test.ts); src/chat/feed-copy.ts keeps it in the browser's storage, per person.

export const COPY_VERSION = 1
/** The end of the conversation the copy holds (the server's own window is 40 messages and their tool calls). */
export const COPY_MAX_ITEMS = 80
/** The most one copy may take (characters): a long tool output makes it shorter, never bigger. */
export const COPY_MAX_CHARS = 200_000
/** An older copy is not shown: it would be more misleading than useful. */
export const COPY_KEEP_MS = 7 * 24 * 3600 * 1000
/** How many chats keep a copy on this device (the most recently shown). */
export const COPY_MAX_CHATS = 6

/** What is stored for a chat's items; null when there is nothing worth keeping. Oldest items go first when it is too big. */
export function encodeCopy(items: readonly ChatItem[], now: number): string | null {
  let take = items.slice(-COPY_MAX_ITEMS)
  while (take.length) {
    const text = JSON.stringify({ v: COPY_VERSION, at: now, items: take })
    if (text.length <= COPY_MAX_CHARS) return text
    take = take.slice(Math.max(1, Math.ceil(take.length / 4)))
  }
  return null
}

const KINDS = new Set(['user', 'assistant', 'tool', 'notice'])
const str = (v: unknown) => typeof v === 'string'
/** Enough of an item to be drawn without a crash: anything else in a stored copy is left out. */
function isItem(v: unknown): v is ChatItem {
  if (v === null || typeof v !== 'object') return false
  const i = v as Record<string, unknown>
  if (!str(i.id) || !KINDS.has(i.kind as string)) return false
  if (i.at !== null && i.at !== undefined && !str(i.at)) return false
  if (i.kind === 'tool') return str(i.name) && str(i.label) && str(i.summary) && str(i.detail) && str(i.output) && ['running', 'done', 'error'].includes(i.status as string)
  return str(i.text)
}

/** A stored copy's items; null when there is none, it is not ours, it is broken or it is too old. */
export function decodeCopy(raw: string | null, now: number): ChatItem[] | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { v?: unknown; at?: unknown; items?: unknown }
    if (v?.v !== COPY_VERSION || typeof v.at !== 'number' || now - v.at > COPY_KEEP_MS || now - v.at < -60_000 || !Array.isArray(v.items)) return null
    const items = v.items.filter(isItem)
    return items.length ? items : null
  } catch {
    return null
  }
}

/** The list of kept copies (newest first) after `key` was written now: what stays, and the keys to remove. */
export function nextIndex(stored: unknown, key: string, now: number): { index: { key: string; at: number }[]; drop: string[] } {
  const old = Array.isArray(stored) ? stored.filter((e): e is { key: string; at: number } => !!e && typeof e === 'object' && str((e as { key?: unknown }).key) && typeof (e as { at?: unknown }).at === 'number') : []
  const all = [{ key, at: now }, ...old.filter(e => e.key !== key)]
  const keep = all.filter(e => now - e.at <= COPY_KEEP_MS).slice(0, COPY_MAX_CHATS)
  const kept = new Set(keep.map(e => e.key))
  return { index: keep, drop: [...new Set(all.filter(e => !kept.has(e.key)).map(e => e.key))] }
}

// --- the overlay's own chat (its floor and agent), so the overlay can open it before the floors have come ------------------------------------------------------

export interface ContactCopy {
  floor: Floor
  agent: FloorAgent
  state: ChatState | null
}

/** What is stored for the overlay's chat: its floor with only that agent in it (the rest of the floor is not needed to show it). */
export function encodeContactCopy(c: ContactCopy, now: number): string | null {
  const text = JSON.stringify({ v: COPY_VERSION, at: now, floor: { ...c.floor, agents: [c.agent] }, state: c.state })
  return text.length <= COPY_MAX_CHARS ? text : null
}

export function decodeContactCopy(raw: string | null, now: number): ContactCopy | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { v?: unknown; at?: unknown; floor?: Floor; state?: unknown }
    if (v?.v !== COPY_VERSION || typeof v.at !== 'number' || now - v.at > COPY_KEEP_MS || !v.floor || typeof v.floor !== 'object') return null
    const f = v.floor
    const a = Array.isArray(f.agents) ? f.agents[0] : null
    if (!str(f.id) || !str(f.name) || !a || !str(a.id) || !str(a.name) || !(a.sessionId === null || str(a.sessionId)) || !Array.isArray(a.mcpServers)) return null
    const state = v.state === 'running' || v.state === 'idle' || v.state === 'question' ? v.state : null
    return { floor: f, agent: a, state }
  } catch {
    return null
  }
}
