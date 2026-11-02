import { WA_ASSISTANT_SENDS_PER_HOUR, WA_DRAFT_MS, WA_DRAFTS_MAX, waPreview, type WaStatus } from '../../shared/whatsapp.ts'
import type { ToolDef } from '../agentic/tools.ts'
import type { WaTools } from './index.ts'

// F-079: the overlay Assistant's WhatsApp tools (agentic/index.ts calls waTool for these names, for the Assistant
// only). It reads only when Shubham asks, and only drafts: a draft goes on his WhatsApp page, and nothing is sent
// until he taps Send there (signed on his phone). What it reads is his: never into memory, tasks, notes or another chat.

export const WA_TOOL_NAMES = ['wa_status', 'wa_chats', 'wa_read', 'wa_prepare_send'] as const
export type WaToolName = (typeof WA_TOOL_NAMES)[number]
export const isWaTool = (name: string): name is WaToolName => (WA_TOOL_NAMES as readonly string[]).includes(name)

const PRIVATE =
  "What you read is Shubham's private WhatsApp: use it for what he asked, then let it go. Never save it to memory, tasks or notes, and never pass it to another chat."

export const WA_TOOLS: ToolDef[] = [
  {
    name: 'wa_status',
    description: "ONLY the overlay Assistant. Shubham's WhatsApp in the app: whether it is set up, linked and open, and the drafts waiting for his tap.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'wa_chats',
    description: `ONLY the overlay Assistant, and only when Shubham asks about his WhatsApp. His chats, newest first: chat id, name, group or not, unread, when, and the last message. \`query\` keeps the names that contain it. WhatsApp opens if it is closed (up to a minute). ${PRIVATE}`,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Part of a name (any case).' }, limit: { type: 'number', description: 'How many (default 15, at most 30).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'wa_read',
    description: `ONLY the overlay Assistant, and only when Shubham asks. The latest messages of one chat (its id from wa_chats), oldest first, at most 20. Reading marks nothing as read. ${PRIVATE}`,
    inputSchema: {
      type: 'object',
      properties: { chatId: { type: 'string', description: 'From wa_chats.' }, count: { type: 'number', description: 'How many (default 10, at most 20).' } },
      required: ['chatId'],
      additionalProperties: false,
    },
  },
  {
    name: 'wa_prepare_send',
    description: `ONLY the overlay Assistant. Draft a WhatsApp message for Shubham to send AS HIMSELF to ONE person he already has a chat with (its id from wa_chats; never a group, never a new number). It goes on his WhatsApp page as a card; nothing is sent unless he taps Send there (signed on his phone), and he can change the words first. At most ${WA_DRAFTS_MAX} drafts wait at once (a new one for the same person replaces the old), each for ${WA_DRAFT_MS / 60_000} minutes, and at most ${WA_ASSISTANT_SENDS_PER_HOUR} drafts are sent in an hour. Write as he would, first person, short; say why in one line.`,
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'From wa_chats: one person, not a group.' },
        text: { type: 'string', description: 'The words he would send.' },
        why: { type: 'string', description: 'One line: why.' },
      },
      required: ['chatId', 'text'],
      additionalProperties: false,
    },
  },
]

const json = (v: unknown) => JSON.stringify(v, null, 2)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const when = (ms: number) => (ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null)

/** One line per fact, for wa_status. */
export function statusText(s: WaStatus): string {
  const lines: string[] = []
  if (s.setup !== 'ready') lines.push(s.setup === 'installing' ? 'WhatsApp is being set up on the hub right now.' : 'WhatsApp is not set up on the hub yet: Shubham sets it up on the WhatsApp page.')
  else if (!s.linked) lines.push('WhatsApp is not linked: Shubham links it once on the WhatsApp page (a QR he scans with his phone).')
  else lines.push(`WhatsApp is linked${s.me?.name ? ` (as ${s.me.name})` : ''} and ${s.state === 'ready' ? 'open' : s.state === 'off' ? 'closed (it opens when used, in up to a minute)' : s.state}.`)
  if (s.state === 'failed' && s.reason) lines.push(`Last problem: ${s.reason}`)
  lines.push(`Drafts waiting for his tap: ${s.drafts.length}${s.drafts.length ? ` (${s.drafts.map(d => d.chatName).join(', ')})` : ''}.`)
  lines.push(`Your drafts sent in the last hour: ${s.assistantSentLastHour} of ${WA_ASSISTANT_SENDS_PER_HOUR}.`)
  return lines.join('\n')
}

/** Carries out one of the WhatsApp tools for the Assistant. Errors are thrown (apiError) with plain words. */
export async function waTool(wa: WaTools, name: WaToolName, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'wa_status':
      return statusText(wa.status())
    case 'wa_chats': {
      const q = str(args.query).trim().toLowerCase()
      const limit = Math.max(1, Math.min(30, Math.floor(num(args.limit, 15))))
      const all = await wa.chats()
      const hits = (q ? all.filter(c => c.name.toLowerCase().includes(q)) : all).slice(0, limit)
      if (!hits.length) return q ? `No chat whose name contains "${str(args.query).trim()}".` : 'No chats.'
      return json(hits.map(c => ({ chatId: c.id, name: c.name, group: c.isGroup, unread: c.unread, when: when(c.at), last: `${c.lastFromMe ? 'You: ' : ''}${c.last}`.slice(0, 160) })))
    }
    case 'wa_read': {
      const msgs = await wa.read(str(args.chatId), num(args.count, 10))
      if (!msgs.length) return 'No messages in that chat.'
      return json(msgs.map(m => ({ from: m.fromMe ? 'Shubham' : (m.author ?? 'them'), when: when(m.at), text: waPreview(m) })))
    }
    case 'wa_prepare_send': {
      const d = await wa.draft(str(args.chatId), str(args.text), str(args.why))
      const until = new Date(d.expiresAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
      return `Drafted for Shubham to ${d.chatName}: "${d.text.slice(0, 160)}${d.text.length > 160 ? '…' : ''}". It is on his WhatsApp page; only his own tap sends it. It lapses at ${until}.`
    }
  }
}
