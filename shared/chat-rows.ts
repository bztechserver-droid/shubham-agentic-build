import type { ChatAssistantItem, ChatItem, ChatNoticeItem, ChatToolItem, ChatUserItem } from './chat.ts'

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
  const taken = new Set<string>()
  const matched = new Map<string, string>()
  for (const p of pending) {
    if (p.state === 'failed') continue
    const echo = items.find(i => isMine(i) && !i.command && !p.known.has(i.id) && !taken.has(i.id) && i.text.trim() === p.text.trim())
    if (echo) {
      taken.add(echo.id)
      matched.set(p.id, echo.id)
    }
  }
  return { matched, open: pending.filter(p => !matched.has(p.id)) }
}

const when = (at: string | null) => (at ? Date.parse(at) : Number.NaN)

/** Whether two instants are on the same calendar day, here. */
const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString()

export function toRows(items: ChatItem[], pending: PendingMessage[] = []): ChatRow[] {
  const { matched, open } = reconcile(items, pending)
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

  items.forEach((it, idx) => {
    if (it.kind === 'tool') {
      day(it.at)
      if (it.ask) {
        rows.push({ k: 'ask', id: it.id, tool: it })
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
  })

  for (const p of open) {
    const item: ChatUserItem = { kind: 'user', id: `pending:${p.id}`, at: p.sentAt, text: p.text, from: null, command: false }
    day(p.sentAt)
    rows.push({ k: 'msg', id: item.id, key: item.id, item, mine: true, sender: null, first: true, last: true, ticks: p.state === 'failed' ? 'failed' : p.state === 'sent' ? 'sent' : 'sending', pending: p })
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
