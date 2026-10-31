// F-057: what a chat keeps so that a reconnect or a reload loses nothing. Pure, so it is tested without
// a page (chat-resume.test.ts); src/chat/feed.ts and src/lib/live/drafts.ts use it.
//
// 1. A chat's feed (the chat WebSocket) sends `hello` first on EVERY connect: the end of the conversation
//    and the file's size. After a reconnect (the phone woke, the app restarted) what is on screen is kept
//    where it agrees with that, so the older pages the person scrolled to are not thrown away and the
//    place they were reading does not jump; and nothing is shown twice, because items are matched by id.
// 2. A message typed and not sent is kept in the browser, per chat, so a reload (Update now, a tab the
//    phone discarded in the background) does not take it.

export interface FeedPart<T> {
  items: T[]
  /** Where older items end (a byte offset in the agent's file); null: this is the start of the conversation. */
  before: number | null
  /** The file's size when the feed last said so. */
  size: number
}

/**
 * The feed after a `hello`. `loaded`: a hello came before. The old part of the conversation stays when the new
 * window is the same conversation grown (the file did not shrink and the window starts at an item already
 * here); anything else - the first hello, a file that was replaced or cut, a window with nothing in common
 * (so much happened while away that it is all new) - is replaced by it, as the server says to.
 */
export function applyHello<T extends { id: string }>(current: FeedPart<T> & { loaded: boolean }, hello: FeedPart<T>): FeedPart<T> {
  const first = hello.items[0]
  if (current.loaded && first && hello.size >= current.size) {
    const at = current.items.findIndex(i => i.id === first.id)
    if (at > 0) return { items: [...current.items.slice(0, at), ...hello.items], before: current.before, size: hello.size }
  }
  return { items: hello.items, before: hello.before, size: hello.size }
}

// ---- drafts

export const DRAFT_KEEP_MS = 7 * 24 * 3600 * 1000
export const DRAFT_MAX_CHARS = 20_000

/** What goes into storage for a draft (an empty one: null, so the entry is removed). */
export function encodeDraft(text: string, now: number): string | null {
  return text ? JSON.stringify({ text: text.slice(0, DRAFT_MAX_CHARS), at: now }) : null
}

/** The text of a stored draft; '' when there is none, it is not ours or it is older than a week. */
export function decodeDraft(raw: string | null, now: number): string {
  if (!raw) return ''
  try {
    const v = JSON.parse(raw) as { text?: unknown; at?: unknown }
    if (typeof v.text !== 'string' || typeof v.at !== 'number' || now - v.at > DRAFT_KEEP_MS) return ''
    return v.text
  } catch {
    return ''
  }
}
