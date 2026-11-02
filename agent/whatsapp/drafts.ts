import { randomUUID } from 'node:crypto'
import { WA_ASSISTANT_SENDS_PER_HOUR, WA_DRAFT_MS, WA_DRAFTS_MAX, WA_TEXT_MAX, type WaChat, type WaDraft } from '../../shared/whatsapp.ts'
import { apiError } from '../api.ts'

// F-079: the Assistant's drafts. It may only propose, and only within limits Shubham agreed to (2 Nov 2026):
// one person per draft (a new draft for the same person replaces the old one), never a group, never someone he has
// no chat with (index.ts looks that up), at most five waiting, each for 15 minutes, and at most 20 of them sent in
// an hour. Sending is his tap alone, signed on his phone (index.ts). Only the times of those sends are kept here,
// never what was said or to whom.

export interface Drafts {
  /** The drafts still waiting, oldest first. */
  list(): WaDraft[]
  add(chat: WaChat, text: string, why: string): WaDraft
  /** A draft he is sending: it must still be there, and for that chat. */
  get(id: string, chatId: string): WaDraft
  drop(id: string): boolean
  /** Throws 429 if one more of the Assistant's drafts may not be sent this hour. */
  allowSend(): void
  /** One of the Assistant's drafts was sent. */
  sent(): void
  sentLastHour(): number
}

export interface DraftsOptions {
  now?: () => number
  max?: number
  lifeMs?: number
  perHour?: number
}

const HOUR = 3_600_000

export function createDrafts(o: DraftsOptions = {}): Drafts {
  const now = o.now ?? Date.now
  const max = o.max ?? WA_DRAFTS_MAX
  const life = o.lifeMs ?? WA_DRAFT_MS
  const perHour = o.perHour ?? WA_ASSISTANT_SENDS_PER_HOUR
  const drafts = new Map<string, WaDraft>()
  let sends: number[] = []

  const prune = () => {
    const t = now()
    for (const [id, d] of drafts) if (Date.parse(d.expiresAt) <= t) drafts.delete(id)
    sends = sends.filter(s => s > t - HOUR)
  }
  const full = () => apiError(429, `${perHour} of the Assistant's drafts were sent in the last hour, the most allowed. More can be sent when that hour has passed.`)

  return {
    list() {
      prune()
      return [...drafts.values()].sort((a, b) => a.at.localeCompare(b.at))
    },
    add(chat, raw, why) {
      prune()
      const text = raw.trim()
      if (!text) throw apiError(400, 'The draft is empty.')
      if (text.length > WA_TEXT_MAX) throw apiError(400, `A draft is at most ${WA_TEXT_MAX} characters.`)
      if (chat.isGroup || chat.id.endsWith('@g.us')) throw apiError(403, 'The Assistant does not draft to groups. Shubham writes to groups himself.')
      if (sends.length >= perHour) throw full()
      for (const [id, d] of drafts) if (d.chatId === chat.id) drafts.delete(id)
      if (drafts.size >= max) throw apiError(429, `${max} drafts are already waiting for Shubham. Wait until he sends or drops one.`)
      const t = now()
      const d: WaDraft = {
        id: randomUUID(),
        chatId: chat.id,
        chatName: chat.name,
        text,
        why: why.trim().replace(/\s+/g, ' ').slice(0, 300),
        at: new Date(t).toISOString(),
        expiresAt: new Date(t + life).toISOString(),
      }
      drafts.set(d.id, d)
      return d
    },
    get(id, chatId) {
      prune()
      const d = drafts.get(id)
      if (!d) throw apiError(410, 'That draft has lapsed or was dropped.')
      if (d.chatId !== chatId) throw apiError(409, 'That draft is for another chat.')
      return d
    },
    drop: id => drafts.delete(id),
    allowSend() {
      prune()
      if (sends.length >= perHour) throw full()
    },
    sent() {
      sends.push(now())
    },
    sentLastHour() {
      prune()
      return sends.length
    },
  }
}
