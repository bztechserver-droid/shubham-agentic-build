import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { WA_IDLE_MS, WA_PREFIX, WA_READ_MAX, WA_TEXT_MAX, type WaChat, type WaDraft, type WaLive, type WaMessage, type WaSendRequest, type WaSetup, type WaStatus } from '../../shared/whatsapp.ts'
import { apiError, type ApiMount, type MountRequest, type WsSocket } from '../api.ts'
import { writeAtomic } from '../config.ts'
import type { Logger } from '../log.ts'
import { findChrome } from './chrome.ts'
import { createDrafts } from './drafts.ts'
import { message, type EngineStatus } from './engine.ts'
import { createHost, type HostOptions } from './host.ts'
import { LOGIN_ID, type WorkerEvent } from './protocol.ts'
import { installLib, libReady, MANIFEST_DIR } from './setup.ts'

// F-079: WhatsApp in the app, on the hub. Shubham's own WhatsApp, linked once as a device by his QR scan, then read
// and written from the WhatsApp page and, within limits, by the overlay Assistant.
// - On demand: WhatsApp (worker.ts, its Chrome) runs only while it is used, and closes WA_IDLE_MS after the last
//   use with no WhatsApp page open, unless he sets it to stay on. The login is kept between runs.
// - Sending is his alone: every send carries his approval device's signature over exactly that chat and those
//   words (as Send as me does, F-076), so neither the Assistant nor anything driving this PC can send.
// - The Assistant reads only when asked and only drafts (drafts.ts); its drafts wait on his page for his tap.
// - Nothing about a message, a chat or a number is logged; the login stays in <state>\whatsapp\auth, locked to his
//   Windows account, and is deleted when he unlinks.

export interface WhatsAppOptions {
  /** The state folder's WhatsApp part: %LOCALAPPDATA%\shubham-agentic\whatsapp. */
  dir: string
  log: Logger
  /** His approval device's signature over a WhatsApp send (agentic's humanProof): who it was, or it throws 401/403. */
  human(kind: 'wa-send', fields: (string | number | boolean)[], sig: unknown): string
  // Tests:
  script?: string
  env?: Record<string, string>
  chrome?: string | null
  ready?: () => boolean
  install?: () => Promise<void>
  now?: () => number
  idleMs?: number
  /** Lock the login folder to this Windows user (icacls); default on Windows. */
  lock?: boolean
  host?: Partial<HostOptions>
}

/** What the Assistant's tools use (agentic/index.ts, through whatsapp/tools.ts). */
export interface WaTools {
  status(): WaStatus
  chats(): Promise<WaChat[]>
  read(chatId: string, count: number): Promise<WaMessage[]>
  draft(chatId: string, text: string, why: string): Promise<WaDraft>
}

export interface WhatsApp {
  mount: ApiMount
  tools: WaTools
  status(): WaStatus
  /** The app is stopping: Chrome closes properly (the login is kept). */
  close(): Promise<void>
}

const CHAT_ID = /^[\w.:-]{1,80}@(c\.us|g\.us|lid|s\.whatsapp\.net)$/
/** His own sends: at most this many a minute (a stuck button, not a limit on him). */
const MINE_PER_MINUTE = 10
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Settings {
  alwaysOn: boolean
  /** A login was made and WhatsApp hasn't let it go since (the folder alone can't say: Chrome makes it at once). */
  linked: boolean
  /** His WhatsApp name, to show while it is closed. */
  name: string | null
}

export function createWhatsApp(o: WhatsAppOptions): WhatsApp {
  const now = o.now ?? Date.now
  const log = o.log
  const authDir = path.join(o.dir, 'auth')
  const libDir = path.join(o.dir, 'lib')
  const profile = path.join(authDir, `session-${LOGIN_ID}`)
  const settingsFile = path.join(o.dir, 'settings.json')
  const chrome = o.chrome !== undefined ? o.chrome : findChrome()
  const isReady = o.ready ?? (() => libReady(libDir, MANIFEST_DIR))
  const drafts = createDrafts({ now })
  const sockets = new Set<WsSocket>()
  const waiters = new Set<() => void>()

  let settings = readSettings()
  let engine: EngineStatus = { state: 'off', qr: null, pairingCode: null, me: null, reason: null, loading: null, linked: null }
  let setup: { state: WaSetup; note: string | null } = { state: isReady() ? 'ready' : 'missing', note: null }
  let idle: ReturnType<typeof setTimeout> | null = null
  let closesAt: string | null = null
  let mine: number[] = []
  let locked = false
  let queued = false

  function readSettings(): Settings {
    try {
      const raw = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>
      return { alwaysOn: raw.alwaysOn === true, linked: raw.linked === true, name: typeof raw.name === 'string' ? raw.name : null }
    } catch {
      return { alwaysOn: false, linked: false, name: null }
    }
  }
  function saveSettings(patch: Partial<Settings>) {
    settings = { ...settings, ...patch }
    try {
      mkdirSync(o.dir, { recursive: true })
      writeAtomic(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
    } catch (e) {
      log.warn(`could not save the WhatsApp settings: ${message(e)}`)
    }
  }

  const linked = () => {
    if (!settings.linked) return false
    try {
      return readdirSync(profile).length > 0
    } catch {
      return false
    }
  }

  const host = createHost({
    script: o.script ?? path.join(import.meta.dirname, 'worker.ts'),
    env: { SAD_WA_LIB: libDir, SAD_WA_AUTH: authDir, ...(chrome ? { SAD_WA_CHROME: chrome } : {}), ...o.env },
    pidFile: path.join(o.dir, 'running.json'),
    log,
    on: onWorker,
    onExit: code => {
      clearIdle()
      if (code !== 0) log.warn(`WhatsApp's process ended unexpectedly (code ${code ?? 'none'})`)
      engine = { ...engine, state: engine.state === 'failed' ? 'failed' : 'off', qr: null, pairingCode: null, loading: null, reason: code === 0 ? engine.reason : 'WhatsApp stopped unexpectedly. It opens again when it is used.' }
      changed()
    },
    ...o.host,
  })

  function onWorker(e: WorkerEvent) {
    if (e.t === 'status') {
      const was = engine.state
      engine = e.status
      if (was !== engine.state) log.info(`WhatsApp: ${engine.state}`)
      if (engine.linked === true && (!settings.linked || (engine.me?.name && engine.me.name !== settings.name))) saveSettings({ linked: true, name: engine.me?.name ?? settings.name })
      if (engine.linked === false && settings.linked) saveSettings({ linked: false })
      changed()
    } else if (e.t === 'message') push({ t: 'message', message: e.message as WaMessage })
    else if (e.t === 'ack') push({ t: 'ack', id: e.id, chatId: e.chatId, ack: e.ack })
  }

  function status(): WaStatus {
    const open = host.running()
    const state = open ? engine.state : engine.state === 'failed' ? 'failed' : 'off'
    return {
      setup: setup.state,
      setupNote: setup.note,
      state,
      linked: linked(),
      me: engine.me ?? (settings.name ? { name: settings.name, phone: null } : null),
      qr: state === 'qr' ? engine.qr : null,
      pairingCode: state === 'qr' ? engine.pairingCode : null,
      loading: open ? engine.loading : null,
      reason: engine.reason,
      alwaysOn: settings.alwaysOn,
      closesAt,
      drafts: drafts.list(),
      assistantSentLastHour: drafts.sentLastHour(),
    }
  }

  function push(m: WaLive) {
    const text = JSON.stringify(m)
    for (const s of sockets) s.sendText(text)
  }
  /** Something changed: the open pages hear the new status (once per turn), and whoever waits looks again. */
  function changed() {
    for (const w of [...waiters]) w()
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      if (sockets.size) push({ t: 'status', status: status() })
    })
  }
  const nextChange = (ms: number) =>
    new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(t)
        waiters.delete(done)
        resolve()
      }
      const t = setTimeout(done, ms)
      waiters.add(done)
    })

  // --- on demand ------------------------------------------------------------------------------

  function clearIdle() {
    if (idle) clearTimeout(idle)
    idle = null
    closesAt = null
  }
  /** It was used: it closes WA_IDLE_MS from now, unless it stays on or a WhatsApp page is open. */
  function touch() {
    clearIdle()
    if (host.running() && !settings.alwaysOn && sockets.size === 0) {
      const ms = o.idleMs ?? WA_IDLE_MS
      closesAt = new Date(now() + ms).toISOString()
      idle = setTimeout(() => {
        idle = null
        closesAt = null
        log.info('WhatsApp closes: not used for a while')
        void shut('Closed after 10 minutes without use. It opens again when it is used.')
      }, ms)
      idle.unref?.()
    }
    changed()
  }

  /** The login folder: this Windows user only (icacls, inherited rights removed), before Chrome writes anything in it. */
  function lockAuth() {
    mkdirSync(authDir, { recursive: true })
    if (locked || o.lock === false || process.platform !== 'win32') return
    const user = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`
    const r = spawnSync('icacls', [authDir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) throw apiError(500, `The login folder could not be locked to your Windows account: ${(r.stdout || r.stderr || '').trim().slice(0, 200)}`)
    locked = true
  }

  async function open(): Promise<void> {
    if (!isReady()) throw apiError(409, 'WhatsApp is not set up on this PC yet. Set it up on the WhatsApp page first.')
    if (!chrome) throw apiError(409, 'There is no Chrome on this PC: WhatsApp runs in Google Chrome. Install it, then try again.')
    lockAuth()
    await host.spawn()
    if (engine.state === 'off' || engine.state === 'failed') await host.call('start')
    touch()
  }

  /** Open and connected (the Assistant's reads and his sends wait up to `ms` for it). */
  async function connected(ms = 60_000): Promise<void> {
    if (!linked() && engine.state !== 'ready') throw apiError(409, 'WhatsApp is not linked yet: Shubham links it once on the WhatsApp page (a QR to scan with his phone).')
    await open()
    const until = now() + ms
    while (engine.state !== 'ready') {
      if (engine.state === 'qr') throw apiError(409, 'WhatsApp needs linking again: Shubham scans the QR on the WhatsApp page.')
      if (engine.state === 'failed') throw apiError(502, `WhatsApp could not open: ${engine.reason ?? 'no reason given'}`)
      if (!host.running()) throw apiError(503, 'WhatsApp stopped while it was opening.')
      const left = until - now()
      if (left <= 0) throw apiError(504, 'WhatsApp is still opening (it can take a minute). Try again shortly.')
      await nextChange(Math.min(left, 1000))
    }
    touch()
  }

  async function shut(reason: string | null) {
    clearIdle()
    await host.quit()
    engine = { ...engine, state: 'off', qr: null, pairingCode: null, loading: null, reason }
    changed()
  }

  // --- what he does ---------------------------------------------------------------------------

  function startSetup() {
    if (setup.state === 'installing') return
    if (setup.state === 'ready' && isReady()) return
    setup = { state: 'installing', note: "Getting WhatsApp's program…" }
    changed()
    const progress = (note: string) => {
      setup = { ...setup, note }
      changed()
    }
    const job = o.install ? o.install() : installLib({ libDir, log, progress })
    job.then(
      () => {
        setup = { state: 'ready', note: null }
        changed()
      },
      e => {
        log.warn(`the WhatsApp setup failed: ${message(e)}`)
        setup = { state: 'failed', note: `The setup failed: ${message(e)}` }
        changed()
      },
    )
  }

  async function pairCode(body: unknown): Promise<{ code: string }> {
    const phone = isObject(body) && typeof body.phone === 'string' ? body.phone : ''
    if (engine.state !== 'qr' || !host.running()) throw apiError(409, 'WhatsApp is not showing a QR right now: open it first.')
    touch()
    return host.call<{ code: string }>('pairCode', { phone })
  }

  async function unlink(): Promise<{ told: boolean }> {
    let told = false
    if (linked() || engine.state === 'ready') {
      try {
        await connected(60_000)
        told = (await host.call<{ told: boolean }>('logout')).told
      } catch (e) {
        log.warn(`unlinking: WhatsApp could not be told (${message(e)})`)
      }
    }
    clearIdle()
    await host.quit()
    for (let i = 0; i < 8 && existsSync(profile); i++) {
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch {
        // Chrome lets go of its files a moment after it ends.
      }
      if (existsSync(profile)) await sleep(500)
    }
    if (existsSync(profile)) log.warn('the saved WhatsApp login could not be deleted yet (its files are still in use)')
    saveSettings({ linked: false, name: null })
    engine = {
      state: 'off',
      qr: null,
      pairingCode: null,
      me: null,
      loading: null,
      linked: false,
      reason: told ? 'Unlinked: WhatsApp no longer lists this device.' : 'The login saved here is deleted. If "Shubham Agentic" is still under Linked devices on your phone, log it out there.',
    }
    log.info(told ? 'WhatsApp unlinked' : 'WhatsApp: the saved login was deleted (WhatsApp itself could not be told)')
    changed()
    return { told }
  }

  async function send(body: unknown): Promise<WaMessage> {
    const req = (isObject(body) ? body : {}) as Partial<WaSendRequest>
    const chatId = typeof req.chatId === 'string' ? req.chatId : ''
    const text = typeof req.text === 'string' ? req.text : ''
    const draft = typeof req.draft === 'string' ? req.draft : ''
    if (!CHAT_ID.test(chatId)) throw apiError(400, 'Expected {chatId, text, sig}')
    if (!text.trim()) throw apiError(400, 'The message is empty.')
    if (text.length > WA_TEXT_MAX) throw apiError(400, `A message is at most ${WA_TEXT_MAX} characters.`)
    // His tap, signed on his approval device over exactly this chat, these words and this draft: before anything else.
    const who = o.human('wa-send', [chatId, sha256(text), draft], req.sig)
    if (draft) {
      drafts.get(draft, chatId)
      drafts.allowSend()
    } else {
      const t = now()
      mine = mine.filter(x => x > t - 60_000)
      if (mine.length >= MINE_PER_MINUTE) throw apiError(429, `${MINE_PER_MINUTE} messages in a minute: wait a moment.`)
      mine.push(t)
    }
    await connected()
    const m = await host.call<WaMessage>('send', { chatId, text })
    if (draft) {
      drafts.drop(draft)
      drafts.sent()
    }
    log.info(`a WhatsApp message was sent${draft ? " (the Assistant's draft)" : ''}, signed by ${who}`)
    changed()
    return m
  }

  // --- the Assistant ----------------------------------------------------------------------------

  const tools: WaTools = {
    status,
    async chats() {
      await connected()
      return host.call<WaChat[]>('chats')
    },
    async read(chatId, count) {
      if (!CHAT_ID.test(chatId)) throw apiError(400, 'That is not a WhatsApp chat id (they come from wa_chats).')
      await connected()
      return host.call<WaMessage[]>('messages', { chatId, count: Math.max(1, Math.min(20, Math.floor(count) || 10)) })
    },
    async draft(chatId, text, why) {
      if (!CHAT_ID.test(chatId)) throw apiError(400, 'That is not a WhatsApp chat id (they come from wa_chats).')
      await connected()
      const chat = (await host.call<WaChat[]>('chats')).find(c => c.id === chatId)
      if (!chat) throw apiError(404, 'Shubham has no chat with that id. The Assistant drafts only to people he already has a chat with (see wa_chats).')
      const d = drafts.add(chat, text, why)
      log.info('the Assistant drafted a WhatsApp message')
      changed()
      return d
    },
  }

  // --- the page's API ---------------------------------------------------------------------------

  async function http(req: MountRequest): Promise<unknown> {
    const { method, rest, query, body } = req
    const route = `${method} ${rest}`
    switch (route) {
      case 'GET /status':
        return status()
      case 'POST /setup':
        startSetup()
        return status()
      case 'POST /open':
        await open()
        return status()
      case 'POST /close':
        await shut('Closed.')
        return status()
      case 'POST /pair-code':
        return pairCode(body)
      case 'POST /unlink':
        return { ...(await unlink()), status: status() }
      case 'GET /chats':
        await connected()
        return host.call<WaChat[]>('chats')
      case 'GET /messages': {
        const chatId = query.get('chat') ?? ''
        if (!CHAT_ID.test(chatId)) throw apiError(400, 'Expected ?chat=<chat id>')
        const count = Math.max(1, Math.min(WA_READ_MAX, Number(query.get('count')) || 40))
        await connected()
        return host.call<WaMessage[]>('messages', { chatId, count, ...(query.get('before') ? { before: query.get('before') } : {}) })
      }
      case 'POST /send':
        return send(body)
      case 'PATCH /settings': {
        if (!isObject(body) || typeof body.alwaysOn !== 'boolean') throw apiError(400, 'Expected {alwaysOn}')
        saveSettings({ alwaysOn: body.alwaysOn })
        if (body.alwaysOn && linked()) await open()
        else touch()
        return status()
      }
    }
    const drop = /^DELETE \/drafts\/([\w-]{1,64})$/.exec(route)
    if (drop) {
      drafts.drop(drop[1])
      changed()
      return status()
    }
    throw apiError(404, `No such path: ${WA_PREFIX}${rest}`)
  }

  const mount: ApiMount = {
    prefix: WA_PREFIX,
    http,
    ws(rest) {
      if (rest !== '/live') return null
      return socket => {
        sockets.add(socket)
        socket.sendText(JSON.stringify({ t: 'status', status: status() } satisfies WaLive))
        touch()
        socket.onClose(() => {
          sockets.delete(socket)
          touch()
        })
      }
    },
  }

  // A crash may have left the last run's Chrome holding the login: end exactly that. Then, if it stays on, open it.
  void host.sweep().then(() => {
    if (settings.alwaysOn && linked() && isReady()) open().catch(e => log.warn(`WhatsApp did not open at start: ${message(e)}`))
  })

  return {
    mount,
    tools,
    status,
    async close() {
      clearIdle()
      await host.quit()
    },
  }
}
