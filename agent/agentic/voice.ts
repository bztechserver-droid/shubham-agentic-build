import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { apiError, type ApiMount, type MountRequest, type WsSocket } from '../api.ts'
import { writeAtomic } from '../config.ts'
import type { Scan } from './orders.ts'
import { MAX_RESULT_BYTES, createPhoneControl, type PhoneControl, type PhoneTiming } from './phone.ts'

// F-074: the hub's side of "Hey Chris", Shubham's phone app. The phone never gets the app's API token.
// A page button asks for a pair code (token, page); the phone trades it for a device key: 32 random bytes,
// shown once, of which the hub keeps only the sha256. Every call after that carries
// "Authorization: Bearer <key>" and lives under /agent-api/voice/* (own credential, never from a page).
//   page:   POST /voice/pair-code   GET /voice/devices   POST /voice/devices/revoke
//   phone:  POST /voice/pair        GET /voice/hello
//           POST /voice/ask         GET /voice/ask/:id?wait=25     POST /voice/ask/:id/cancel
//           GET /voice/events?since=<cursor>&wait=25
// An ask is Shubham's own words, typed into the Assistant's chat marked as spoken; the Assistant's final
// answer of that turn comes back as `speak` (found by the ask's id in its conversation, as orders are).

export const CODE_TTL_MS = 10 * 60_000
export const CODE_TRIES = 5
export const PAIR_ATTEMPTS_PER_MIN = 10
export const MAX_DEVICES = 8
export const MAX_ASK_CHARS = 4000
export const MAX_WAIT_S = 25
/** An ask the Assistant never took up, with its chat resting, is said to have failed after this long. */
export const NOT_TAKEN_MS = 120_000
/** The Assistant resting this long after answering is the end of its turn. */
export const SETTLE_MS = 1500
export const SPEAK_MAX = 1200
/** A confirmation the Assistant asked for is good this long, once. */
export const CONFIRM_TTL_MS = 30 * 60_000
const KEEP_ASKS = 50
const KEEP_EVENTS = 200

export type Live = 'working' | 'waiting' | 'idle' | 'stopped'
export type ChatNow = 'running' | 'question' | 'idle' | undefined

export interface Device {
  id: string
  name: string
  model: string
  /** sha256 of the key, hex. */
  hash: string
  at: string
  lastSeen: string | null
}

export interface AskView {
  askId: string
  state: 'queued' | 'working' | 'done' | 'error'
  /** The safety rule: the Assistant would act, and wants Shubham's Approve (from an unlocked phone) first. */
  confirm?: { id: string; summary: string }
  status?: { text: string; secs: number | null; tokens: string | null }
  /** What to say aloud: the Assistant's answer, as plain sentences. */
  speak?: string
  error?: string
}

export type VoiceEvent = { t: 'answer'; askId: string; speak: string } | { t: 'beat'; at: number; text: string; items: { floor: string; agent: string; what: string }[] } | { t: 'ask'; askId: string; state: AskView['state'] }

export interface VoiceDeps {
  now(): number
  /** voice-devices.json */
  file?: string
  /** The Assistant's chat: its conversation id and what it is doing; null when there is no Assistant yet. */
  assistant(): { sessionId: string | null; state: ChatNow } | null
  /** Types `text` into the Assistant's chat, starting it when it is not running; false when that was not possible. */
  say(text: string): Promise<boolean>
  /** Where the ask began in the Assistant's conversation, and what it answered (orders.ts's rule, for an ask). */
  scan(sessionId: string, askId: string): Scan
  /** Esc into the Assistant's chat: stops what it is doing. */
  interrupt(): Promise<boolean>
  /**
   * The signed tap that allows a pair code: throws unless the request carries a registered approval
   * device's signature (strict: no unsigned old way). Says who signed, for the log. Without it, no pair code is made.
   */
  proof?(body: unknown): string
  /** The Assistant's chat feed, as /agentic/chat sends it (hello, add, patch, menu, status); returns the way to stop. */
  feed?(send: (m: unknown) => void): () => void
  /** Older items of the Assistant's conversation. */
  history?(before: number, limit: number | undefined): unknown
  /** What the Assistant's spinner says, if it says anything. */
  status?(): AskView['status'] | null
  /** F-080: the WebSocket handler for /voice/speech (the speech service's stream), opened with a paired phone's device key. Without it the route does not exist. */
  speech?: (ws: WsSocket) => void
  /** F-082: the timings of phone control (tests shorten them). */
  phoneTiming?: Partial<PhoneTiming>
  log?: { info(m: string): void; warn(m: string): void }
}

interface Ask {
  id: string
  deviceId: string
  at: number
  text: string
  cancelled: boolean
  idleSince: number | null
  /** Set once, when it ended: what the phone is told from then on. */
  final: AskView | null
  /** The ended state was put in the events. */
  announced: boolean
  /** The safety rule was on for it: the Assistant may answer with a CONFIRM line. */
  safety: boolean
}

/** What the Assistant wrote, split into what to say and the one sentence it wants confirmed (its last "CONFIRM: ..." line). */
export function splitConfirm(text: string): { speak: string; summary: string | null } {
  const lines = text.split(String.fromCharCode(10))
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*CONFIRM:\s*(.+?)\s*$/i.exec(lines[i])
    if (m) return { speak: [...lines.slice(0, i), ...lines.slice(i + 1)].join(String.fromCharCode(10)), summary: m[1].slice(0, 300) }
  }
  return { speak: text, summary: null }
}

const sha = (key: string) => createHash('sha256').update(key).digest('hex')
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

/** The live word the phone shows for the Assistant's chat. */
export const liveOf = (s: ChatNow): Live => (s === 'running' ? 'working' : s === 'question' ? 'waiting' : s === 'idle' ? 'idle' : 'stopped')

/** An answer as sentences to be said: no code, links or markdown marks, short. */
export function forSpeech(text: string): string {
  let t = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > SPEAK_MAX) {
    const cut = t.slice(0, SPEAK_MAX)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
    t = `${end > SPEAK_MAX / 2 ? cut.slice(0, end + 1) : cut} The rest is in the overlay.`
  }
  return t
}

export interface Voice {
  /** The mount for the agent's API. */
  mount: ApiMount
  /** The timer's call: asks that ended get their answer event even when nobody is polling. */
  tick(): void
  /** The heartbeat found something: the phone is told (its background service reads /voice/events). */
  beat(text: string, items: { floor: string; agent: string; what: string }[]): void
  /** For tests and the page: the devices paired. */
  devices(): { id: string; name: string; model: string; at: string; lastSeen: string | null }[]
  /** F-082: the Assistant's hands on the phone (phone_screen, phone_control). */
  phone: PhoneControl
  close(): void
}

export function createVoice(deps: VoiceDeps): Voice {
  let devices: Device[] = load(deps.file)
  const phone = createPhoneControl({ now: deps.now, dir: deps.file ? path.dirname(deps.file) : undefined, timing: deps.phoneTiming, log: deps.log })
  const codes = new Map<string, number>()
  let fails = 0
  const attempts: number[] = []
  const asks = new Map<string, Ask>()
  const confirms = new Map<string, { summary: string; at: number; deviceId: string; used: boolean }>()
  const subs = new Set<(e: VoiceEvent) => void>()
  const events: { cursor: number; at: number; e: VoiceEvent }[] = []
  let cursor = 0
  const waiters = new Set<() => void>()

  const save = () => {
    if (!deps.file) return
    try {
      writeAtomic(deps.file, JSON.stringify({ devices }, null, 2))
    } catch (e) {
      deps.log?.warn(`voice: devices could not be saved: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const push = (e: VoiceEvent) => {
    events.push({ cursor: ++cursor, at: deps.now(), e })
    if (events.length > KEEP_EVENTS) events.splice(0, events.length - KEEP_EVENTS)
    for (const w of [...waiters]) w()
    for (const s of [...subs]) s(e)
  }

  // --- pairing ---------------------------------------------------------------------------------
  function pairCode() {
    const t = deps.now()
    for (const [c, at] of codes) if (t - at > CODE_TTL_MS) codes.delete(c)
    // One code at a time is plenty: a new one burns the last.
    codes.clear()
    fails = 0
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    codes.set(code, t)
    return { code, expiresAt: t + CODE_TTL_MS }
  }

  function pair(raw: unknown) {
    const t = deps.now()
    while (attempts.length && t - attempts[0] > 60_000) attempts.shift()
    if (attempts.length >= PAIR_ATTEMPTS_PER_MIN) throw apiError(429, 'Too many tries: wait a minute')
    attempts.push(t)
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const code = typeof b.code === 'string' ? b.code.trim() : ''
    const at = codes.get(code)
    if (at === undefined || t - at > CODE_TTL_MS) {
      // Five wrong tries and every code is burned: the page makes a new one.
      if (++fails >= CODE_TRIES) codes.clear()
      throw apiError(403, 'That code is wrong or has expired')
    }
    if (devices.length >= MAX_DEVICES) throw apiError(409, `There are already ${MAX_DEVICES} phones paired: remove one first`)
    codes.delete(code)
    const key = randomBytes(32).toString('base64url')
    const id = randomBytes(6).toString('hex')
    const name = (typeof b.name === 'string' ? b.name : '').trim().slice(0, 40) || 'Phone'
    const model = (typeof b.model === 'string' ? b.model : '').trim().slice(0, 40)
    devices.push({ id, name, model, hash: sha(key), at: new Date(t).toISOString(), lastSeen: null })
    save()
    deps.log?.info(`voice: ${name} paired`)
    return { deviceId: id, key }
  }

  function auth(req: { headers: MountRequest['headers'] }): Device {
    const h = req.headers.authorization
    const m = typeof h === 'string' ? /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(h) : null
    if (!m) throw apiError(401, 'Missing or malformed Authorization: Bearer <device key>')
    const want = Buffer.from(sha(m[1]), 'hex')
    const d = devices.find(x => {
      const have = Buffer.from(x.hash, 'hex')
      return have.length === want.length && timingSafeEqual(have, want)
    })
    if (!d) throw apiError(401, 'This phone is not paired (or was removed)')
    d.lastSeen = new Date(deps.now()).toISOString()
    return d
  }

  // --- asks ------------------------------------------------------------------------------------
  /** A line typed into a chat ends with Enter: at a permission prompt or a menu that would pick the highlighted option. So nothing is typed then. */
  function waitingGuard() {
    if (deps.assistant()?.state === 'question') throw apiError(409, 'The Assistant is waiting for an answer on the PC')
  }

  async function ask(d: Device, raw: unknown) {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const text = (typeof b.text === 'string' ? b.text : '').replace(/\s+/g, ' ').trim()
    if (!text) throw apiError(400, 'text is empty')
    if (text.length > MAX_ASK_CHARS) throw apiError(413, `text is longer than ${MAX_ASK_CHARS} characters`)
    waitingGuard()
    const via = b.via === 'text' ? 'text' : 'voice'
    const locked = b.locked === true
    const safety = b.safety === true && locked
    const id = `v${randomBytes(3).toString('hex')}`
    const tags = [
      via === 'voice' ? 'spoken' : 'typed on the phone',
      ...(locked ? ['phone locked'] : []),
      'answer for speech: a few short sentences, no markdown, code or links',
      ...(safety ? ["safety rule ON: do nothing outward or destructive now (no messages, emails, CRM writes or deletes, money, publishing, commands on PCs); do not do it; say in a sentence what you would do, and end your answer with one last line: CONFIRM: <one sentence saying exactly what you would do>. He will tap Approve on his unlocked phone, and then you will be told"] : []),
    ]
    const line = `[voice ${hhmm(deps.now())}, ask ${id}] (${tags.join('; ')}) ${text}`
    if (!(await deps.say(line))) throw apiError(409, "The Assistant's chat could not be reached")
    const a: Ask = { id, deviceId: d.id, at: deps.now(), text, cancelled: false, idleSince: null, final: null, announced: false, safety }
    asks.set(id, a)
    while (asks.size > KEEP_ASKS) asks.delete(asks.keys().next().value as string)
    push({ t: 'ask', askId: id, state: 'queued' })
    return { askId: id }
  }

  /** Where an ask stands now; once it ended, that is kept and said again. */
  function view(a: Ask): AskView {
    if (a.final) return a.final
    const end = (v: Omit<AskView, 'askId'>): AskView => {
      a.final = { askId: a.id, ...v }
      return a.final
    }
    if (a.cancelled) return end({ state: 'error', error: 'Cancelled.' })
    const as = deps.assistant()
    if (!as || !as.sessionId) return end({ state: 'error', error: 'There is no Assistant chat.' })
    const s = deps.scan(as.sessionId, a.id)
    const now = deps.now()
    if (!s.started) {
      if (as.state === undefined) return end({ state: 'error', error: "The Assistant's chat stopped before it took this." })
      if (as.state === 'idle' && now - a.at > NOT_TAKEN_MS) return end({ state: 'error', error: 'The Assistant did not take this up.' })
      return { askId: a.id, state: 'queued' }
    }
    if (as.state === 'running' || as.state === 'question') {
      a.idleSince = null
      const status = deps.status?.()
      return { askId: a.id, state: 'working', ...(status ? { status } : {}) }
    }
    // At rest: twice in a row is the end of its turn (one blink between two steps is not).
    a.idleSince ??= now
    if (as.state !== undefined && now - a.idleSince < SETTLE_MS) return { askId: a.id, state: 'working' }
    const split = a.safety ? splitConfirm(s.answer) : { speak: s.answer, summary: null }
    if (split.summary) {
      const id = `c${randomBytes(3).toString('hex')}`
      confirms.set(id, { summary: split.summary, at: now, deviceId: a.deviceId, used: false })
      while (confirms.size > KEEP_ASKS) confirms.delete(confirms.keys().next().value as string)
      return end({ state: 'done', speak: forSpeech(split.speak) || 'I need your confirmation first.', confirm: { id, summary: split.summary } })
    }
    return end({ state: 'done', speak: forSpeech(s.answer) || 'Done.' })
  }

  function mine(d: Device, id: string): Ask {
    const a = asks.get(id)
    if (!a || a.deviceId !== d.id) throw apiError(404, 'No such ask')
    return a
  }

  /** The state, waiting up to `wait` seconds for it to change from what the phone last saw. */
  async function askState(d: Device, id: string, waitS: number, seen: string | null): Promise<AskView> {
    const a = mine(d, id)
    const until = deps.now() + Math.min(MAX_WAIT_S, Math.max(0, waitS)) * 1000
    for (;;) {
      const v = view(a)
      if (v.state === 'done' || v.state === 'error' || JSON.stringify(v) !== seen || deps.now() >= until) return v
      await new Promise(r => setTimeout(r, 400))
    }
  }

  async function cancel(d: Device, id: string) {
    const a = mine(d, id)
    if (!a.final) {
      a.cancelled = true
      await deps.interrupt().catch(() => false)
    }
    return view(a)
  }

  /** His Approve (or No) on an unlocked phone: typed to the Assistant as his own words, as a new ask whose answer the phone then follows. */
  async function confirm(d: Device, id: string, raw: unknown) {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const c = confirms.get(id)
    if (!c || c.deviceId !== d.id) throw apiError(404, 'No such confirmation')
    if (c.used) throw apiError(409, 'That was already answered')
    if (deps.now() - c.at > CONFIRM_TTL_MS) throw apiError(410, 'That confirmation has expired: ask again')
    if (b.locked !== false) throw apiError(409, 'Unlock the phone first: Approve works only from an unlocked phone')
    if (typeof b.approve !== 'boolean') throw apiError(400, 'Expected {approve: true | false, locked: false}')
    if (b.approve) waitingGuard()
    c.used = true
    if (!b.approve) return { ok: true, denied: true }
    const aid = `v${randomBytes(3).toString('hex')}`
    const line = `[voice ${hhmm(deps.now())}, ask ${aid}] (confirmation, answer for speech: a few short sentences, no markdown, code or links) Approved by Shubham: ${c.summary}`
    let sent = false
    try {
      sent = await deps.say(line)
    } catch (e) {
      c.used = false
      throw e
    }
    if (!sent) {
      c.used = false
      throw apiError(409, "The Assistant's chat could not be reached")
    }
    asks.set(aid, { id: aid, deviceId: d.id, at: deps.now(), text: c.summary, cancelled: false, idleSince: null, final: null, announced: false, safety: false })
    push({ t: 'ask', askId: aid, state: 'queued' })
    return { askId: aid }
  }

  /** The phone's live screen: the Assistant's chat feed as it is written, and the beats and asks as they happen. */
  function live(ws: WsSocket) {
    const stops: (() => void)[] = []
    const send = (m: unknown) => ws.sendText(JSON.stringify(m))
    const as = deps.assistant()
    if (deps.feed && as?.sessionId) stops.push(deps.feed(send))
    else send({ t: 'hello', sessionId: as?.sessionId ?? '', items: [], before: null, size: 0 })
    const sub = (e: VoiceEvent) => send(e.t === 'answer' ? { t: 'ask', askId: e.askId, state: 'done', speak: e.speak } : e)
    subs.add(sub)
    stops.push(() => void subs.delete(sub))
    ws.onText(() => {})
    ws.onClose(() => stops.forEach(f => f()))
  }

  function tick() {
    for (const a of asks.values()) {
      if (a.announced) continue
      const v = view(a)
      if (v.state !== 'done' && v.state !== 'error') continue
      a.announced = true
      if (v.state === 'done') push({ t: 'answer', askId: a.id, speak: v.speak ?? '' })
      else push({ t: 'ask', askId: a.id, state: 'error' })
    }
  }

  async function eventsSince(since: number, waitS: number) {
    const until = deps.now() + Math.min(MAX_WAIT_S, Math.max(0, waitS)) * 1000
    for (;;) {
      tick()
      const list = events.filter(x => x.cursor > since)
      if (list.length || deps.now() >= until) return { cursor: list.length ? list[list.length - 1].cursor : Math.max(since, cursor), events: list.map(x => ({ at: x.at, ...x.e })) }
      await new Promise<void>(r => {
        const done = () => {
          clearTimeout(timer)
          waiters.delete(done)
          r()
        }
        const timer = setTimeout(done, 500)
        waiters.add(done)
      })
    }
  }

  const num = (v: string | null, d: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : d
  }

  // --- the mount -------------------------------------------------------------------------------
  const pageRoute = (rest: string) => rest === '/pair-code' || rest === '/devices' || rest === '/devices/revoke' || rest === '/control-status' || rest === '/control-stop'
  const mount: ApiMount = {
    prefix: '/voice',
    // Everything but the page's own routes carries the phone's key, never the app's token.
    ownAuth: rest => !pageRoute(rest),
    // A screen read by the phone (its nodes, a shot) is bigger than the 64 KiB every other body is held to.
    maxBody: rest => (rest === '/control/result' ? MAX_RESULT_BYTES : undefined),
    // The phone's live screen is a WebSocket on its device key alone (agent/api.ts: wsKey); nothing else here is.
    // F-080: the phone's speech-to-text socket (Whisper on the hub, agent/speech): the same device-key check as /live.
    ws: rest => (rest === '/live' ? live : rest === '/speech' ? (deps.speech ?? null) : null),
    wsKey: (rest, headers) => {
      if (rest !== '/live' && !(rest === '/speech' && deps.speech)) return null
      try {
        auth({ headers })
        return true
      } catch {
        return false
      }
    },
    async http(r) {
      const { method, rest } = r
      if (method === 'POST' && rest === '/pair-code') {
        // Making a code takes his signed tap from a registered approval device: a paired phone can talk to the Assistant, and through it to everything.
        if (!deps.proof) throw apiError(503, 'Pairing needs a registered approval device (Settings › Approval device)')
        const who = deps.proof(r.body)
        deps.log?.info(`voice: a pair code was made (${who})`)
        return pairCode()
      }
      if (method === 'GET' && rest === '/devices') return { devices: voice.devices() }
      if (method === 'POST' && rest === '/devices/revoke') {
        const id = (r.body as { id?: unknown } | null)?.id
        if (typeof id !== 'string') throw apiError(400, 'Expected {id}')
        const before = devices.length
        devices = devices.filter(x => x.id !== id)
        if (devices.length === before) throw apiError(404, 'No such phone')
        save()
        phone.forget(id)
        return { devices: voice.devices() }
      }
      const control = phone.page(method, rest)
      if (control !== undefined) return control
      if (method === 'POST' && rest === '/pair') return pair(r.body)
      const d = auth(r)
      if (method === 'GET' && rest === '/hello') {
        const as = deps.assistant()
        return { assistant: { sessionId: as?.sessionId ?? null, live: liveOf(as?.state) }, settings: {} }
      }
      // F-082: the phone's hands (phone.ts): state, the long poll for the next command, its result, progress, STOP.
      if (rest.startsWith('/control/')) {
        const out = phone.http(d, method, rest.slice('/control'.length), r.query, r.body)
        if (out !== undefined) return out
      }
      if (method === 'POST' && rest === '/ask') return ask(d, r.body)
      const sure = /^\/confirm\/([^/]+)$/.exec(rest)
      if (method === 'POST' && sure) return confirm(d, sure[1], r.body)
      if (method === 'GET' && rest === '/history') {
        const at = r.query.get('before')
        const before = at === null || at.trim() === '' ? Number.NaN : Number(at)
        const limit = Number(r.query.get('limit')) || undefined
        return Number.isFinite(before) && deps.history ? deps.history(before, limit) : { items: [], before: null }
      }
      const one = /^\/ask\/([^/]+)$/.exec(rest)
      if (method === 'GET' && one) return askState(d, one[1], num(r.query.get('wait'), 0), r.query.get('seen'))
      const stop = /^\/ask\/([^/]+)\/cancel$/.exec(rest)
      if (method === 'POST' && stop) return cancel(d, stop[1])
      if (method === 'GET' && rest === '/events') return eventsSince(Math.max(0, Math.floor(num(r.query.get('since'), 0))), num(r.query.get('wait'), 0))
      throw apiError(404, `No such route: ${method} ${rest}`)
    },
  }

  const voice: Voice = {
    mount,
    tick,
    beat(text, items) {
      push({ t: 'beat', at: deps.now(), text, items })
    },
    devices: () => devices.map(d => ({ id: d.id, name: d.name, model: d.model, at: d.at, lastSeen: d.lastSeen })),
    phone,
    close: () => phone.close(),
  }
  return voice
}

function load(file: string | undefined): Device[] {
  if (!file || !existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { devices?: unknown }
    return Array.isArray(raw.devices)
      ? raw.devices.filter((d): d is Device => !!d && typeof d === 'object' && typeof (d as Device).id === 'string' && typeof (d as Device).hash === 'string')
      : []
  } catch {
    return []
  }
}
