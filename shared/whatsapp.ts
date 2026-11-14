// F-079: WhatsApp in the app. Shubham's own WhatsApp, linked once as a device (his QR scan, the WhatsApp
// Web way), read and written from the app. This is what the hub's /agent-api/whatsapp/ part and the
// WhatsApp page say to each other. The login itself never leaves the hub's state folder.

/** The WhatsApp part of the agent's API, under AGENT_API_PREFIX. */
export const WA_PREFIX = '/whatsapp'

/**
 * Order o8416 (F-223): the WhatsApp page's own part of the agent's API, under AGENT_API_PREFIX. It proxies to the
 * WhatsApp backend on this Server (agent/whatsapp-backend/), adding the backend's token on the server side: the page never sees it.
 */
export const WA_BACKEND_PREFIX = '/whatsapp-backend'
/** The WhatsApp backend's port on 127.0.0.1: 50000 or higher, never the agent's own 21221. */
export const WA_BACKEND_PORT = 50070

/** How long WhatsApp stays open after its last use, unless it is set to stay on. */
export const WA_IDLE_MS = 10 * 60_000

/** The Assistant's drafts: how many may wait at once, how long one lasts, and how many may be sent in an hour. */
export const WA_DRAFTS_MAX = 5
export const WA_DRAFT_MS = 15 * 60_000
export const WA_ASSISTANT_SENDS_PER_HOUR = 20

/** The longest message the app sends (WhatsApp allows far more; this keeps a slip short). */
export const WA_TEXT_MAX = 4000

/** The most messages one read gives (the page pages back for more). */
export const WA_READ_MAX = 100

/** The one-time setup of the WhatsApp program on the hub (its packages, in the state folder). */
export type WaSetup = 'missing' | 'installing' | 'ready' | 'failed'

/**
 * off: nothing runs (a saved login is kept); starting: Chrome is opening WhatsApp Web; qr: waiting for his scan
 * (or for the pairing code); linking: scanned, WhatsApp is loading; ready: connected; failed: it could not start.
 */
export type WaState = 'off' | 'starting' | 'qr' | 'linking' | 'ready' | 'failed'

/** The linked account, once known (only his own name and number). */
export interface WaMe {
  name: string | null
  phone: string | null
}

export interface WaStatus {
  setup: WaSetup
  /** The setup's progress or error, in plain words. */
  setupNote: string | null
  state: WaState
  /** A login is saved here (the next start needs no QR). */
  linked: boolean
  me: WaMe | null
  /** The QR to scan, as an image (a data URL), only while state is 'qr'. */
  qr: string | null
  /** The code to type on his phone in place of the QR (Link with phone number), when he asked for one. */
  pairingCode: string | null
  /** WhatsApp Web's own loading progress (0 to 100) while it opens. */
  loading: number | null
  /** Why it is off or failed, in plain words. */
  reason: string | null
  /** Stays open (never closed for being idle). Off: it opens when used and closes after WA_IDLE_MS. */
  alwaysOn: boolean
  /** When it will close for being idle (ISO), while it is open and not always on. */
  closesAt: string | null
  /** The Assistant's drafts waiting for his tap. */
  drafts: WaDraft[]
  /** How many of the Assistant's drafts were sent in the last hour (at most WA_ASSISTANT_SENDS_PER_HOUR). */
  assistantSentLastHour: number
}

export interface WaChat {
  /** WhatsApp's id for the chat (…@c.us, …@g.us, …@lid). */
  id: string
  name: string
  isGroup: boolean
  unread: number
  /** The last activity (ms since the epoch). */
  at: number
  /** What the last message was, short. */
  last: string
  lastFromMe: boolean
  muted: boolean
  archived: boolean
  pinned: boolean
}

export type WaMessageType = 'chat' | 'image' | 'video' | 'audio' | 'ptt' | 'document' | 'sticker' | 'location' | 'vcard' | 'multi_vcard' | 'revoked' | 'other'

export interface WaMessage {
  id: string
  chatId: string
  fromMe: boolean
  /** Who wrote it, in a group (their WhatsApp name); null for his own and in one-to-one chats. */
  author: string | null
  type: WaMessageType
  /** The text, or a photo's caption. */
  text: string
  /** When (ms since the epoch). */
  at: number
  /** WhatsApp's ticks: -1 failed, 0 waiting, 1 sent, 2 delivered, 3 read, 4 played. */
  ack: number
  hasMedia: boolean
  filename: string | null
}

/** A message the Assistant proposes. Nothing sends it but his own tap (a signed send). */
export interface WaDraft {
  id: string
  chatId: string
  chatName: string
  text: string
  /** One line from the Assistant: why. */
  why: string
  /** When it was made, and when it lapses (ISO). */
  at: string
  expiresAt: string
}

/** POST send: his message, signed by his approval device over ['wa-send'; chatId, sha256(text), draft ?? '']. */
export interface WaSendRequest {
  chatId: string
  text: string
  /** The Assistant's draft this sends, if any (it is then used up). */
  draft?: string
  sig?: unknown
}

/** What the live socket (WA_PREFIX/live) pushes to the page. */
export type WaLive =
  | { t: 'status'; status: WaStatus }
  | { t: 'message'; message: WaMessage }
  | { t: 'ack'; id: string; chatId: string; ack: number }

/** A message's text as a short line: what a chat list shows for it. */
export function waPreview(m: Pick<WaMessage, 'type' | 'text' | 'filename'>): string {
  switch (m.type) {
    case 'image':
      return m.text ? `Photo: ${m.text}` : 'Photo'
    case 'video':
      return m.text ? `Video: ${m.text}` : 'Video'
    case 'ptt':
      return 'Voice message'
    case 'audio':
      return 'Audio'
    case 'document':
      return `Document: ${m.filename ?? 'file'}`
    case 'sticker':
      return 'Sticker'
    case 'location':
      return 'Location'
    case 'vcard':
    case 'multi_vcard':
      return 'Contact'
    case 'revoked':
      return 'This message was deleted'
    default:
      return m.text
  }
}
