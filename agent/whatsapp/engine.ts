import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { waPreview, type WaChat, type WaMe, type WaMessage, type WaMessageType, type WaState } from '../../shared/whatsapp.ts'

// F-079: one linked WhatsApp device, driven through whatsapp-web.js (WhatsApp Web in the PC's own Chrome).
// Ported from techserverbz/whatsapp-backend src/engines/webjs/engine.ts (Oct 2026), keeping what it learned
// on today's WhatsApp:
// - `ready` often never fires, so after `authenticated` WhatsApp Web's own state is polled until CONNECTED,
//   and a client that never gets there is reopened (twice at most);
// - the WhatsApp Web build is never pinned: WhatsApp unlinks an old build a few minutes after it connects;
// - before a launch only the profile's Service Worker is cleared (it can serve another app shell); the rest of
//   the cache stays, so opening again is quick;
// - Chrome is always closed with destroy(): its login is a LevelDB store, and a killed Chrome can corrupt it.
// Not taken: killing Chrome by its command line (this app ends a process by exact PID only), the CRM login,
// and its own copy of every message (this keeps none; WhatsApp Web has the history).
// New here: a generation number, so events from a client that was already closed change nothing.

/** The part of whatsapp-web.js's Client this uses: the real one (worker.ts), or a test's. */
export interface WaClient {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  initialize(): Promise<unknown>
  /** Closes Chrome; the login stays. */
  destroy(): Promise<unknown>
  /** Unlinks the device on WhatsApp's side, closes Chrome and deletes the saved login. */
  logout(): Promise<unknown>
  getState(): Promise<unknown>
  getChats(): Promise<unknown[]>
  getChatById(id: string): Promise<unknown>
  sendMessage(chatId: string, content: string): Promise<unknown>
  requestPairingCode(phone: string, showNotification?: boolean): Promise<unknown>
  info?: unknown
  pupBrowser?: unknown
}

export interface EngineOptions {
  /** A new client (whatsapp-web.js's, or a test's). */
  createClient(): WaClient
  /** The QR's text as an image (a data URL). */
  qrImage(text: string): Promise<string>
  /** This login's Chrome profile (LocalAuth's session-<id> folder): its Service Worker is cleared before a launch. */
  profileDir: string
  /** One line about what happened; never a message, a number or the QR. */
  log?(line: string): void
  /** Tests: shorter waits. */
  pollMs?: number
  pollTries?: number
  retryMs?: number
}

export interface EngineStatus {
  state: WaState
  qr: string | null
  pairingCode: string | null
  me: WaMe | null
  reason: string | null
  loading: number | null
  /** What this run learned: true once connected, false when WhatsApp asks for a scan or let the device go; null before. */
  linked: boolean | null
}

export interface EngineEvents {
  status: [EngineStatus]
  message: [WaMessage]
  ack: [{ id: string; chatId: string; ack: number }]
}

/** Launches tried before giving up (whatsapp-web.js sometimes fails while WhatsApp Web is still loading). */
const LAUNCHES = 4
/** Reopenings when WhatsApp was linked but never reached CONNECTED. */
const RECYCLES = 2

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
/** whatsapp-web.js's ids are objects: `_serialized`, or `$1` since WhatsApp renamed it (whatsapp-web.js #201832). */
export const idOf = (v: unknown): string => (typeof v === 'string' ? v : str(obj(v)._serialized) || str(obj(v).$1))
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A library's error, fit for a log line: no numbers, no WhatsApp ids, short. */
export function clean(text: string): string {
  return text
    .replace(/\S*@(c\.us|g\.us|lid|s\.whatsapp\.net|broadcast|newsletter)\b/g, '<id>')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '<number>')
    .replace(/data:[^\s"']+/g, '<data>')
    .replace(/\s+/g, ' ')
    .slice(0, 200)
}

const TYPES = new Set<WaMessageType>(['chat', 'image', 'video', 'audio', 'ptt', 'document', 'sticker', 'location', 'vcard', 'multi_vcard', 'revoked'])
const MEDIA = new Set(['image', 'video', 'audio', 'ptt', 'document', 'sticker'])
/** Chats that aren't conversations: status updates, channels. */
const NOT_A_CHAT = /@(broadcast|newsletter)$/

/** Whether a message is one a person wrote (not a notification of WhatsApp's own: a key change, a group event, ...). */
export function shown(raw: unknown): boolean {
  return TYPES.has((str(obj(raw).type) || 'chat') as WaMessageType)
}

/** whatsapp-web.js message -> WaMessage. */
export function toMessage(raw: unknown): WaMessage {
  const m = obj(raw)
  const data = obj(m._data)
  const t = str(m.type) || 'chat'
  const type: WaMessageType = TYPES.has(t as WaMessageType) ? (t as WaMessageType) : 'other'
  const fromMe = m.fromMe === true
  const chatId = fromMe ? idOf(m.to) : idOf(m.from)
  return {
    id: idOf(m.id),
    chatId,
    fromMe,
    author: !fromMe && chatId.endsWith('@g.us') ? str(data.notifyName) || null : null,
    type,
    text: str(m.body),
    at: num(m.timestamp) * 1000,
    ack: typeof m.ack === 'number' ? m.ack : 0,
    hasMedia: m.hasMedia === true || MEDIA.has(t),
    filename: str(data.filename) || null,
  }
}

/** whatsapp-web.js chat -> WaChat. */
export function toChat(raw: unknown): WaChat {
  const c = obj(raw)
  const id = idOf(c.id)
  const last = c.lastMessage
  return {
    id,
    name: str(c.name) || id.split('@')[0] || 'Unknown',
    isGroup: c.isGroup === true || id.endsWith('@g.us'),
    unread: num(c.unreadCount),
    at: num(c.timestamp) * 1000,
    last: last ? waPreview(toMessage(last)) : '',
    lastFromMe: obj(last).fromMe === true,
    muted: c.isMuted === true,
    archived: c.archived === true,
    pinned: c.pinned === true,
  }
}

/**
 * A launch error in plain words, and whether trying again could help. A certificate error is a network that won't
 * let WhatsApp Web through (seen 2 Nov 2026 on the office network: a FortiGate firewall re-signs web.whatsapp.com,
 * and only that host, with its own certificate): trying again can't help, and the network's owner has to allow it.
 */
export function explain(raw: string): { reason: string; retry: boolean } {
  if (/ERR_CERT_|ERR_SSL_|CERT_AUTHORITY|certificate/i.test(raw))
    return { reason: "This network won't let WhatsApp Web through: the certificate it shows for web.whatsapp.com isn't WhatsApp's (a firewall is checking or blocking it). Whoever runs the network has to allow web.whatsapp.com for this PC.", retry: false }
  if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_|ERR_CONNECTION_|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE/.test(raw))
    return { reason: `WhatsApp Web could not be reached (${clean(raw)}). Is the internet up?`, retry: true }
  return { reason: `WhatsApp Web did not open: ${clean(raw)}`, retry: true }
}

/** Why WhatsApp let go of the device, in plain words. */
function reasonOf(raw: unknown): string {
  const r = str(raw) || message(raw)
  if (r === 'LOGOUT') return 'This device was unlinked (on the phone, or by WhatsApp). Link it again to use WhatsApp here.'
  if (r === 'CONFLICT') return 'WhatsApp was opened on another computer, so this one let go.'
  return `WhatsApp disconnected (${clean(r) || 'no reason given'}).`
}

const notReady = () => Object.assign(new Error('WhatsApp is not open yet: it opens when it is used. Try again in a moment.'), { status: 409 })

export class WaEngine extends EventEmitter<EngineEvents> {
  private readonly o: EngineOptions & { pollMs: number; pollTries: number; retryMs: number }
  private client: WaClient | null = null
  /** Goes up at every launch and stop: a client's events count only while their generation is the current one. */
  private gen = 0
  private st: EngineStatus = { state: 'off', qr: null, pairingCode: null, me: null, reason: null, loading: null, linked: null }
  private poll: ReturnType<typeof setInterval> | null = null
  private polls = 0
  private recycles = 0
  private retry: ReturnType<typeof setTimeout> | undefined

  constructor(o: EngineOptions) {
    super()
    this.o = { pollMs: 3000, pollTries: 30, retryMs: 1500, ...o }
  }

  status(): EngineStatus {
    return { ...this.st }
  }

  /** Opens WhatsApp; does nothing when it is open or opening. Progress comes as 'status' events. */
  start(): void {
    if (this.client) return
    this.recycles = 0
    this.set({ state: 'starting', qr: null, pairingCode: null, reason: null, loading: null })
    this.launch(1)
  }

  /** Closes Chrome and keeps the login, so the next start needs no QR. Never rejects. */
  async stop(reason: string | null = null): Promise<void> {
    const c = this.halt()
    // destroy() lets Chrome write its login to disk and close: never skip it.
    if (c) await c.destroy().catch(e => this.o.log?.(`closing: ${clean(message(e))}`))
    this.set({ state: 'off', qr: null, pairingCode: null, loading: null, reason })
  }

  /** Unlinks this device on WhatsApp's side and deletes the saved login. Never rejects; says whether WhatsApp was told. */
  async logout(): Promise<boolean> {
    const c = this.halt()
    let told = false
    if (c) {
      try {
        await c.logout()
        told = true
      } catch (e) {
        this.o.log?.(`unlinking: ${clean(message(e))}`)
      }
      await c.destroy().catch(() => undefined)
    }
    this.set({ state: 'off', qr: null, pairingCode: null, loading: null, me: null, reason: 'Unlinked.', linked: false })
    return told
  }

  /** In place of the QR, a code he types on his phone (Linked devices › Link with phone number instead). */
  async pairCode(phone: string): Promise<string> {
    const digits = phone.replace(/\D/g, '')
    if (digits.length < 8 || digits.length > 15) throw Object.assign(new Error('Give the phone number with its country code, digits only (for India: 91 and the 10 digits).'), { status: 400 })
    if (!this.client || this.st.state !== 'qr') throw Object.assign(new Error('WhatsApp is not waiting to be linked right now.'), { status: 409 })
    const code = str(await this.client.requestPairingCode(digits, true))
    if (!code) throw new Error('WhatsApp gave no code. Try the QR instead.')
    this.set({ pairingCode: code })
    return code
  }

  /** The chats, newest first (no status updates or channels). */
  async chats(): Promise<WaChat[]> {
    const raw = await this.need().getChats()
    return raw
      .map(toChat)
      .filter(c => c.id && !NOT_A_CHAT.test(c.id))
      .sort((a, b) => b.at - a.at)
  }

  /**
   * The latest `count` messages of a chat, or the `count` before message `before`. WhatsApp Web loads older
   * history from the phone as it is asked for, so the window grows until it holds them (or the chat's start).
   */
  async messages(chatId: string, count: number, before?: string): Promise<WaMessage[]> {
    const chat = await this.need().getChatById(chatId)
    const fetchMessages = obj(chat).fetchMessages
    if (typeof fetchMessages !== 'function') throw Object.assign(new Error('No such chat.'), { status: 404 })
    const fetch = async (limit: number): Promise<unknown[]> => {
      const r: unknown = await fetchMessages.call(chat, { limit })
      return Array.isArray(r) ? r : []
    }
    const out = (list: unknown[]) => list.filter(shown).map(toMessage)
    if (!before) return out(await fetch(count))
    let limit = Math.max(count * 4, 200)
    let all: unknown[] = []
    for (let round = 0; round < 6; round++) {
      all = await fetch(limit)
      const i = all.findIndex(m => idOf(obj(m).id) === before)
      if (i === -1) {
        if (all.length < limit) break // the whole chat is here, and `before` is not in it
        limit *= 2
        continue
      }
      if (i >= count || all.length < limit) return out(all.slice(Math.max(0, i - count), i))
      limit *= 2
    }
    const i = all.findIndex(m => idOf(obj(m).id) === before)
    const end = i === -1 ? all.length : i
    return out(all.slice(Math.max(0, end - count), end))
  }

  async send(chatId: string, text: string): Promise<WaMessage> {
    return toMessage(await this.need().sendMessage(chatId, text))
  }

  /** The PID of the Chrome this client launched, once there is one. */
  chromePid(): number | null {
    const browser = obj(this.client?.pupBrowser)
    const proc = typeof browser.process === 'function' ? obj((browser.process as () => unknown).call(browser)) : {}
    return typeof proc.pid === 'number' ? proc.pid : null
  }

  // ---------------------------------------------------------------------------------------------

  private set(patch: Partial<EngineStatus>) {
    this.st = { ...this.st, ...patch }
    this.emit('status', this.status())
  }

  private need(): WaClient {
    if (!this.client || this.st.state !== 'ready') throw notReady()
    return this.client
  }

  /** Ends the current generation: its client's events and timers no longer count. Returns that client. */
  private halt(): WaClient | null {
    this.gen++
    this.stopPoll()
    clearTimeout(this.retry)
    const c = this.client
    this.client = null
    return c
  }

  private launch(attempt: number): void {
    const gen = ++this.gen
    this.clearServiceWorker()
    let client: WaClient
    try {
      client = this.o.createClient()
    } catch (e) {
      this.set({ state: 'failed', reason: `WhatsApp could not start: ${clean(message(e))}` })
      return
    }
    this.client = client
    this.attach(client, gen)
    client.initialize().catch(async (e: unknown) => {
      if (gen !== this.gen) return
      this.o.log?.(`opening, try ${attempt} of ${LAUNCHES}: ${clean(message(e))}`)
      this.client = null
      await client.destroy().catch(() => undefined)
      if (gen !== this.gen) return
      const why = explain(message(e))
      if (attempt < LAUNCHES && why.retry) {
        this.retry = setTimeout(() => {
          if (gen === this.gen) this.launch(attempt + 1)
        }, this.o.retryMs)
      } else {
        this.set({ state: 'failed', loading: null, reason: why.reason })
      }
    })
  }

  private attach(client: WaClient, gen: number): void {
    const live = () => gen === this.gen
    client.on('qr', (text: unknown) => {
      if (!live()) return
      void this.o.qrImage(str(text)).then(
        qr => live() && this.set({ state: 'qr', qr, loading: null, linked: false }),
        e => live() && this.set({ state: 'failed', reason: `The QR could not be drawn: ${clean(message(e))}` }),
      )
    })
    client.on('code', (code: unknown) => {
      if (live() && str(code)) this.set({ pairingCode: str(code) })
    })
    client.on('loading_screen', (percent: unknown) => {
      if (live() && this.st.state !== 'ready') this.set({ loading: Math.max(0, Math.min(100, Math.round(num(percent)))) })
    })
    client.on('authenticated', () => {
      if (!live()) return
      this.o.log?.('linked: loading WhatsApp')
      this.set({ state: 'linking', qr: null, pairingCode: null })
      this.startPoll(gen)
    })
    client.on('auth_failure', () => {
      if (!live()) return
      this.stopPoll()
      this.set({ state: 'failed', qr: null, reason: 'WhatsApp did not accept the saved login. Link it again.' })
    })
    client.on('ready', () => {
      if (live()) this.finish(gen)
    })
    client.on('change_state', (s: unknown) => {
      if (live()) this.o.log?.(`WhatsApp Web state: ${clean(str(s))}`)
    })
    client.on('disconnected', (why: unknown) => {
      if (!live()) return
      const reason = reasonOf(why)
      this.o.log?.(`disconnected: ${clean(str(why) || message(why))}`)
      const c = this.halt()
      void c?.destroy().catch(() => undefined)
      this.set({ state: 'off', qr: null, pairingCode: null, loading: null, reason, ...(str(why) === 'LOGOUT' ? { me: null, linked: false } : {}) })
    })
    client.on('message', (m: unknown) => {
      if (live() && shown(m)) this.emit('message', toMessage(m))
    })
    // His own messages, from here or from his phone: 'message' carries only the ones he receives.
    client.on('message_create', (m: unknown) => {
      if (live() && obj(m).fromMe === true && shown(m)) this.emit('message', toMessage(m))
    })
    client.on('message_ack', (m: unknown, ack: unknown) => {
      if (!live()) return
      const msg = toMessage(m)
      this.emit('ack', { id: msg.id, chatId: msg.chatId, ack: num(ack) })
    })
  }

  /** CONNECTED: say who is linked (client.info may still be missing when `ready` never fired; the session works anyway). */
  private finish(gen: number) {
    if (gen !== this.gen || this.st.state === 'ready') return
    this.stopPoll()
    this.recycles = 0
    const info = obj(this.client?.info)
    const user = str(obj(info.wid).user)
    this.set({ state: 'ready', qr: null, pairingCode: null, loading: null, reason: null, linked: true, me: info.wid ? { name: str(info.pushname) || null, phone: user || null } : this.st.me })
    this.o.log?.('ready')
  }

  private startPoll(gen: number) {
    this.stopPoll()
    this.polls = 0
    this.poll = setInterval(() => void this.pollOnce(gen), this.o.pollMs)
  }

  private stopPoll() {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  private async pollOnce(gen: number) {
    const c = this.client
    if (gen !== this.gen || !c) return this.stopPoll()
    this.polls += 1
    let state: unknown = null
    try {
      state = await c.getState()
    } catch {
      // The page is busy loading: ask again next time.
    }
    if (gen !== this.gen) return
    if (state === 'CONNECTED') return this.finish(gen)
    if (this.polls < this.o.pollTries || this.st.state === 'ready') return
    this.stopPoll()
    if (this.recycles >= RECYCLES) {
      this.set({ state: 'failed', reason: 'WhatsApp was linked but never finished opening. Try again.' })
      return
    }
    this.recycles += 1
    this.o.log?.(`linked but not connected after ${Math.round((this.o.pollMs * this.o.pollTries) / 1000)} s: opening again (${this.recycles} of ${RECYCLES})`)
    const old = this.halt()
    await old?.destroy().catch(() => undefined)
    this.set({ state: 'starting', loading: null })
    this.launch(1)
  }

  /**
   * Only the Service Worker: it can serve a whole other WhatsApp Web app shell. IndexedDB and Local Storage (the
   * login) and the HTTP and code caches (a quick start) stay.
   */
  private clearServiceWorker() {
    try {
      rmSync(path.join(this.o.profileDir, 'Default', 'Service Worker'), { recursive: true, force: true })
    } catch {
      // Not there, or locked: leave it.
    }
  }
}
