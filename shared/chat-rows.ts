import type { ChatAttachment } from './attachments.ts'
import type { ChatAssistantItem, ChatItem, ChatNoticeItem, ChatToolItem, ChatUserItem } from './chat.ts'
import { isMediaToolName, parseMediaResult, type MediaShown } from './media.ts'
import { isScreenToolName, parseScreenResult, type ScreenShown } from './screen-bubble.ts'

// F-050: what the conversation list draws: chat items turned into rows. Consecutive tool calls
// are one row (a single line that opens), bubbles from one side close together are a cluster
// (only its last has a tail), a new day gets a separator, and what the person just sent is shown
// at once, before claude has written it into its file, until the file has it.

/** A message sent from this page that claude's file hasn't shown yet. */
export interface PendingMessage {
  id: string
  text: string
  /** The page's clock when it was sent. */
  sentAt: string
  /** The ids of every item the page had when it was sent: an echo is a new one. */
  known: ReadonlySet<string>
  state: 'sending' | 'sent' | 'failed'
  error?: string
  /** F-069: the files sent with it (the text is only the person's words; the lines naming the files are added when it is said). */
  attachments?: ChatAttachment[]
  /** F-069: where each is kept (the PC the chat runs on), to say it again when sending is retried. */
  paths?: string[]
  /** The agent's clock when it answered this send (its receipt): closer to claude's own timestamps than the page's `sentAt`. */
  anchorAt?: string
}

/**
 * WhatsApp's ticks: sending (a clock), sent (one tick: the agent's PC has it), delivered (two:
 * claude took it into the conversation), answered (two, filled: claude has since written back).
 */
export type Ticks = 'sending' | 'sent' | 'delivered' | 'answered' | 'failed'

export type ChatRow =
  | { k: 'day'; id: string; at: string }
  | {
      k: 'msg'
      id: string
      /** The element key: a sent message keeps its own when claude's echo of it replaces it, so it doesn't enter twice. */
      key: string
      item: ChatUserItem | ChatAssistantItem
      /** The person's own (right), or the agent's and a sibling chat's (left). */
      mine: boolean
      /** A sibling chat that wrote it, to name above the bubble. */
      sender: string | null
      first: boolean
      last: boolean
      ticks: Ticks | null
      pending: PendingMessage | null
    }
  | { k: 'tools'; id: string; tools: ChatToolItem[]; running: boolean }
  /** The agent's question (AskUserQuestion), a card of its own with its options as buttons. */
  | { k: 'ask'; id: string; tool: ChatToolItem }
  /** Order o16d2: a picture or a video the agent showed (its show_media tool, answered): a bubble on the agent's side, not a tool line. */
  | { k: 'media'; id: string; tool: ChatToolItem; media: MediaShown }
  /** Order o3963: a button for a PC's Control screen an agent offered (its show_screen tool, answered): a bubble on the agent's side; nothing connects before a tap. */
  | { k: 'screen'; id: string; tool: ChatToolItem; screen: ScreenShown }
  | { k: 'notice'; id: string; item: ChatNoticeItem }

/** Two bubbles from the same side this close are one cluster. */
export const CLUSTER_MS = 5 * 60 * 1000

const isMine = (i: ChatItem): i is ChatUserItem => i.kind === 'user' && i.from === null

export const senderName = (i: ChatUserItem) => (i.from ? (i.from.name ?? (i.from.chat ? `chat ${i.from.chat}` : 'Another chat')) : null)

/**
 * Which pending messages the items now show. An echo is a message of the person's with the same
 * words that wasn't there when it was sent; each echo answers one pending message, oldest first.
 */
export function reconcile(items: ChatItem[], pending: PendingMessage[]): { matched: Map<string, string>; open: PendingMessage[] } {
  // The words alone cannot say which send an echo answers when the same words were sent several times (Shubham sent "update" over and over),
  // and claude's file carries none of our ids. So every possible pair is listed and the pairs that are closest in TIME are taken first: claude
  // stamps an echo with the moment the message was typed, so the echo of a send is the nearest one to it. An old send whose own echo is out of
  // the window therefore finds only echoes that belong to newer sends, which are already taken, and stays unmatched instead of stealing one.
  // Without usable times the order is the old one: oldest send first, earliest echo first.
  const pairs: { pi: number; ii: number; gap: number }[] = []
  pending.forEach((p, pi) => {
    if (p.state === 'failed') return
    const sent = when(p.anchorAt ?? p.sentAt)
    items.forEach((i, ii) => {
      if (!isMine(i) || i.command || p.known.has(i.id) || i.text.trim() !== p.text.trim()) return
      const echoed = when(i.at)
      pairs.push({ pi, ii, gap: Number.isNaN(sent) || Number.isNaN(echoed) ? Number.POSITIVE_INFINITY : Math.abs(echoed - sent) })
    })
  })
  pairs.sort((a, b) => (a.gap === b.gap ? 0 : a.gap < b.gap ? -1 : 1) || a.pi - b.pi || a.ii - b.ii)
  const taken = new Set<string>()
  const matched = new Map<string, string>()
  for (const { pi, ii } of pairs) {
    const p = pending[pi]
    const echo = items[ii]
    if (matched.has(p.id) || taken.has(echo.id)) continue
    taken.add(echo.id)
    matched.set(p.id, echo.id)
  }
  return { matched, open: pending.filter(p => !matched.has(p.id)) }
}

const when = (at: string | null | undefined) => (at ? Date.parse(at) : Number.NaN)

/**
 * The items as things really entered the conversation. Claude writes what the person typed while it was working (a `queued_command`, also a
 * sub-agent's report) into its file when it TAKES it, but stamps it with the moment it was TYPED, so in the file it sits after answers that
 * came later than it. The chat shows such a message at the moment it was typed, above those answers, as the terminal's own time order does.
 * Only a person's message or a notice is ever moved, and only above rows stamped later than it; a row without a time stays put; the feed's
 * own list (file order, ids, merges) is never touched. Nothing out of order: the same array comes back.
 */
export function inTimeOrder(items: ChatItem[]): ChatItem[] {
  let out: ChatItem[] | null = null
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const t = it.kind === 'user' || it.kind === 'notice' ? when(it.at) : Number.NaN
    if (Number.isNaN(t)) { out?.push(it); continue }
    // Walk back over what is stamped later than this row; the first row at or before its time (or the start) is where it belongs.
    const src = out ?? items
    const end = out ? out.length : i
    let j = end
    for (let steps = 0; j > 0 && steps < 2000; steps++) {
      const above = when(src[j - 1].at)
      if (Number.isNaN(above) || above <= t) break   // a row without a time is never passed: its place against this one is unknown
      j--
    }
    if (j === end) { out?.push(it); continue }
    out ??= items.slice(0, i)
    out.splice(j, 0, it)
  }
  return out ?? items
}

/** Whether two instants are on the same calendar day, here. */
const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString()

/**
 * ocbbf (Stage 1, the simple layer): `keepFeedOrder` shows the feed in Claude's own order (its file order) and never moves a message by its typed time:
 * Claude's own report says when a message was taken, and that is the place it has in the conversation.
 */
export function toRows(feedItems: ChatItem[], pending: PendingMessage[] = [], opts: { keepFeedOrder?: boolean } = {}): ChatRow[] {
  const items = opts.keepFeedOrder ? feedItems : inTimeOrder(feedItems)
  const { matched } = reconcile(items, pending)
  // A message sent from here and not echoed yet waits where it was sent: right after the last item the page had when it was sent, so
  // what arrives afterwards lands BELOW it, and its echo (stamped with the same moment) takes that very place. When the page cannot tell
  // (nothing was on screen, or none of what was is any more) it is the newest, at the bottom, as before.
  const index = new Map(items.map((it, n) => [it.id, n]))
  const placed = new Map<number, PendingMessage[]>()
  const bottom: PendingMessage[] = []
  // Two sends before the first echo knew the same items, but the second was sent after the first: never above its echo or its row.
  let floor = -1
  let toBottom = false
  for (const p of pending) {
    if (p.state === 'failed') continue
    const echo = matched.get(p.id)
    if (echo !== undefined) { floor = Math.max(floor, index.get(echo) ?? -1); continue }
    let after = -1
    for (const id of p.known) after = Math.max(after, index.get(id) ?? -1)
    if (toBottom || after < 0) { toBottom = true; bottom.push(p); continue }
    after = Math.max(after, floor)
    floor = after
    placed.set(after, [...(placed.get(after) ?? []), p])
  }
  for (const p of pending) if (p.state === 'failed') bottom.push(p)
  const echoOf = new Map([...matched].map(([pendingId, itemId]) => [itemId, pendingId]))
  const rows: ChatRow[] = []
  let lastAt: string | null = null
  // A person's message is answered once the agent has written (or run a tool) after it.
  const answeredFrom = new Set<number>()
  let sawReply = false
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'assistant' || it.kind === 'tool') sawReply = true
    else if (isMine(it) && sawReply) answeredFrom.add(i)
  }

  const day = (at: string | null) => {
    if (!at || Number.isNaN(Date.parse(at))) return
    if (!lastAt || !sameDay(lastAt, at)) rows.push({ k: 'day', id: `day:${at.slice(0, 10)}:${rows.length}`, at })
    lastAt = at
  }

  const pushPending = (p: PendingMessage) => {
    const item: ChatUserItem = { kind: 'user', id: `pending:${p.id}`, at: p.sentAt, text: p.text, from: null, command: false, ...(p.attachments?.length ? { attachments: p.attachments } : {}) }
    day(p.sentAt)
    rows.push({ k: 'msg', id: item.id, key: item.id, item, mine: true, sender: null, first: true, last: true, ticks: p.state === 'failed' ? 'failed' : p.state === 'sent' ? 'sent' : 'sending', pending: p })
  }

  items.forEach((it, idx) => {
    emit(it, idx)
    for (const p of placed.get(idx) ?? []) pushPending(p)
  })
  for (const p of bottom) pushPending(p)

  function emit(it: ChatItem, idx: number) {
    if (it.kind === 'tool') {
      day(it.at)
      if (it.ask) {
        rows.push({ k: 'ask', id: it.id, tool: it })
        return
      }
      // Order o16d2: once show_media has answered, the picture or video is its own bubble. Still running, or refused: a tool line, as any other.
      const media = it.status === 'done' && isMediaToolName(it.name) ? parseMediaResult(it.output) : null
      if (media) {
        rows.push({ k: 'media', id: it.id, tool: it, media })
        return
      }
      // Order o3963: once show_screen has answered, its button is a bubble of its own.
      const screen = it.status === 'done' && isScreenToolName(it.name) ? parseScreenResult(it.output) : null
      if (screen) {
        rows.push({ k: 'screen', id: it.id, tool: it, screen })
        return
      }
      const prev = rows.at(-1)
      if (prev?.k === 'tools') {
        prev.tools.push(it)
        prev.running ||= it.status === 'running'
      } else rows.push({ k: 'tools', id: `tools:${it.id}`, tools: [it], running: it.status === 'running' })
      return
    }
    day(it.at)
    if (it.kind === 'notice') {
      rows.push({ k: 'notice', id: it.id, item: it })
      return
    }
    const mine = isMine(it)
    rows.push({
      k: 'msg',
      id: it.id,
      key: echoOf.has(it.id) ? `pending:${echoOf.get(it.id)}` : it.id,
      item: it,
      mine,
      sender: it.kind === 'user' ? senderName(it) : null,
      first: true,
      last: true,
      ticks: mine && !it.command ? (answeredFrom.has(idx) ? 'answered' : 'delivered') : null,
      pending: null,
    })
  }

  // Clusters: neighbours on the same side, by the same sender, close in time.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.k !== 'msg') continue
    const prev = rows[i - 1]
    const next = rows[i + 1]
    const joins = (a: ChatRow | undefined, b: typeof row) =>
      a?.k === 'msg' && a.mine === b.mine && a.sender === b.sender && Math.abs(when(b.item.at) - when(a.item.at)) < CLUSTER_MS
    row.first = !joins(prev, row)
    row.last = !(next?.k === 'msg' && joins(row, next))
  }
  return rows
}
