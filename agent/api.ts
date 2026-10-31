import { createHash, timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type net from 'node:net'
import type { Duplex } from 'node:stream'
import {
  AGENT_API_PREFIX,
  type AgentEvent,
  type AgentSettings,
  type AgentState,
  type ClaudeCheckRequest,
  type ClaudeInfo,
  type ClaudeSignInRequest,
  type ForgetPasswordRequest,
  type GrabbedKey,
  type JoinConfirm,
  type JoinRequest,
  type JoinState,
  type KeysMessage,
  type PairingCode,
  type SavedLoginAnswer,
  type SavedLoginRequest,
  type SavePasswordRequest,
  type ScreenPasswordRequest,
  type ScreenVia,
  type SettingsPatch,
} from '../shared/agent-api.ts'
import type { SwitchAutoRequest, SwitchPreview, SwitchRefreshRequest, SwitchRequest, SwitchResponse } from '../shared/claude-switch.ts'
import { ROUTES } from './config.ts'
import { loopbackOrigin } from './local-host.ts'
import type { Logger } from './log.ts'
import { keepalive, pongFor, WS_DEAD_MS, WS_PING_MS } from './ws-live.ts'

// The local API the app talks to (agent/SPEC.md › Local API): HTTP and a WebSocket on
// 127.0.0.1 only, with shared/agent-api.ts as the contract. Every request but /health must
// carry x-sad-token: Vite's proxy adds it, and Christopher's remote gate shares loopback
// ports with the tailnet, so the token is what really guards this port. A browser Origin that
// is not this PC is refused as well, whatever it carries: the proxy should never have given
// such a page the token, and this holds even if it did.
// The WebSockets are a minimal RFC 6455 server: unmasked frames out; masked client frames in,
// answering ping and close. No extensions. Two kinds:
//   /ws                    the state, pushed as text; nothing a client sends is acted on, but the
//                          page's {"t":"ping"} (F-057, agent/ws-live.ts: every text socket answers it).
//   /devices/<id>/remote   a byte pipe to that device's screen: binary frames both ways carry
//                          the raw stream the link opens, and the page speaks RustDesk's
//                          protocol over it. ?via=app reaches the app's own screen on that PC
//                          (F-006, the link's 'screen' kind); ?via=rustdesk, or no via, the
//                          RustDesk installed there (F-005, the 'rustdesk' kind). This PC's own
//                          ID reaches its own screen the same two ways, with no link (F-014: its
//                          page opened on another device, the phone through the remote gate).
//   /keys                  F-013: while open, this PC's keys (Alt+Tab, the Windows key and the
//                          rest a browser never gets) for the Control page that opened it, as
//                          text: 'grabbing', then each key (KeysMessage). Closing it gives them back.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_BODY = 64 * 1024
const MAX_WS_FRAME = 64 * 1024
/** A pipe's frames carry whatever the page writes at once (a big clipboard, say). */
const MAX_PIPE_FRAME = 8 * 1024 * 1024
const PUSH_DEBOUNCE_MS = 100
// A client that stops reading is dropped rather than buffered for.
const MAX_WS_BACKLOG = 4 * 1024 * 1024

/** An error the API answers with this status and message. */
export function apiError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

export interface ApiActions {
  state(): AgentState
  startPairing(): PairingCode | Promise<PairingCode>
  cancelPairing(): unknown
  approve(requestId: string): unknown
  reject(requestId: string): unknown
  join(req: JoinRequest): JoinState | Promise<JoinState>
  confirmJoin(req: JoinConfirm): JoinState | Promise<JoinState>
  cancelJoin(): unknown
  check(id: string): unknown
  screen(id: string): unknown
  /** A raw stream to that device's screen (its own through the app, or its RustDesk), or to this PC's own (F-014), for the in-app viewer; throws apiError when there is none. */
  remote(id: string, via: ScreenVia): Promise<Duplex>
  remove(id: string): unknown
  settings(patch: SettingsPatch): AgentSettings | Promise<AgentSettings>
  /** F-006: this PC's control password for its own screen. */
  screenPassword(req: ScreenPasswordRequest): unknown
  /** F-006: fetch FFmpeg in the background. */
  screenSetup(): unknown
  /** F-007: sign in to the CRM here, and run Claude on this PC on the subscription it gives. */
  claudeSignIn(req: ClaudeSignInRequest): Promise<ClaudeInfo>
  /** F-007: ask the CRM again; `replace` takes over a CLAUDE_CODE_OAUTH_TOKEN something else set. */
  claudeCheck(req: ClaudeCheckRequest): Promise<ClaudeInfo>
  /** F-007: take the CRM's subscription off this PC and sign out of the CRM. */
  claudeSignOut(): Promise<ClaudeInfo>
  /** Claude subscription failover: read the office's subscriptions again from the CRM (with `readings`, each one's week too). */
  claudeSwitchRefresh(req: SwitchRefreshRequest): Promise<ClaudeInfo>
  /** What a switch to subscription `to` would do and which running chats it would restart. Changes nothing. */
  claudeSwitchPreview(to: string): Promise<SwitchPreview>
  /** The person's own switch to another Claude subscription, restarting the chats they chose. */
  claudeSwitch(req: SwitchRequest): Promise<SwitchResponse>
  /** Switch by itself when the weekly limit is used up: on or off. */
  claudeSwitchAuto(req: SwitchAutoRequest): Promise<ClaudeInfo>
  /** F-008: the saved password's answer to this connection's challenge (never the saved H1 itself). */
  savedLogin(id: string, req: SavedLoginRequest): SavedLoginAnswer
  /** F-008: remember that PC's password for this way in, as H1, after a login that worked. */
  savePassword(id: string, req: SavePasswordRequest): unknown
  /** F-008: forget it (both ways when no `via`). */
  forgetPassword(id: string, req: ForgetPasswordRequest): unknown
  /** F-013: this PC's keys for a Control page here until stop(), or until `onEnd`; rejects where it can't. */
  grabKeys?(onKey: (k: GrabbedKey) => void, onEnd: (why: string) => void): Promise<{ stop(): void }>
}

export interface ApiOptions {
  port: number
  /** Default 127.0.0.1; never a LAN address. */
  host?: string
  token: string
  actions: ApiActions
  /** WebSocket clients connected now: the Devices page is open while there are any. */
  onClients?: (count: number) => void
  log?: Logger
  /** F-018: parts of the API that live in modules of their own (agent/agentic/). */
  mounts?: ApiMount[]
  /** F-057, tests: how often a text WebSocket client is pinged, and how long one may stay silent before it is dropped. */
  wsPingMs?: number
  wsDeadMs?: number
}

/** One HTTP request to a mount: `rest` is the path after its prefix, `body` the JSON of a POST, PATCH or PUT. */
export interface MountRequest {
  method: string
  rest: string
  query: URLSearchParams
  body: unknown
  headers: IncomingMessage['headers']
}

/** A WebSocket a mount took: text frames both ways. */
export interface WsSocket {
  sendText(text: string): void
  onText(cb: (text: string) => void): void
  onClose(cb: () => void): void
  close(code?: number, reason?: string): void
}

/**
 * F-018: a part of the API in its own module, under `${AGENT_API_PREFIX}${prefix}/`. Its routes
 * are guarded like the rest (a page on this PC, with x-sad-token), except the paths `ownAuth`
 * names: those carry their own credential (the agentic tools' per-chat key), are refused to
 * any browser page, and get no token at all.
 */
export interface ApiMount {
  prefix: string
  ownAuth?(rest: string): boolean
  /** Resolves to the JSON answer; an apiError for an error status. */
  http(req: MountRequest): Promise<unknown>
  /** Its WebSocket at `rest`, run once accepted; null when it has none there (404). */
  ws?(rest: string, query: URLSearchParams): ((socket: WsSocket) => void) | null
  /**
   * F-054: a path that answers by itself, with the raw request and response (a proxy: any method, a
   * body that isn't JSON, an answer that is streamed). Guarded like the JSON routes (a page on this
   * PC, with x-sad-token) before it runs; null when `rest` isn't one. An apiError it throws is
   * answered as JSON, as for the others.
   */
  raw?(rest: string, url: URL): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null
}

export interface Api {
  port: number
  /** Something changed: push the state to every WebSocket client (debounced 100 ms). */
  changed(): void
  clients(): number
  close(): Promise<void>
}

function tokenOk(given: unknown, token: string) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data ?? { ok: true })
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '')
  // The UI always sends JSON; a form post from another site can't, without a CORS preflight.
  if (!/^application\/json\b/i.test(type)) throw apiError(415, 'Send the request body as application/json')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw apiError(413, 'Request too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw apiError(400, 'The request body is not JSON')
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function joinRequest(body: unknown): JoinRequest {
  if (!isObject(body) || typeof body.hubAddress !== 'string' || typeof body.code !== 'string') {
    throw apiError(400, 'Expected {hubAddress, code, hubId?}')
  }
  if (body.hubId !== undefined && (typeof body.hubId !== 'string' || !/^[a-z2-7]{16}$/.test(body.hubId))) {
    throw apiError(400, 'hubId must be a 16-character device ID')
  }
  const req: JoinRequest = { hubAddress: body.hubAddress.trim(), code: body.code }
  return body.hubId === undefined ? req : { ...req, hubId: body.hubId }
}

function screenPassword(body: unknown): ScreenPasswordRequest {
  if (!isObject(body) || (typeof body.password !== 'string' && body.password !== null)) throw apiError(400, 'Expected {password: text, or null to remove it}')
  return { password: body.password }
}

// A login and password, used once for the CRM's sign-in and never kept or logged here.
function claudeSignIn(body: unknown): ClaudeSignInRequest {
  if (!isObject(body) || typeof body.login !== 'string' || typeof body.password !== 'string') throw apiError(400, 'Expected {login, password}')
  if (body.login.length > 320 || body.password.length > 1024) throw apiError(400, 'That login or password is too long')
  return { login: body.login, password: body.password }
}

const isVia = (v: unknown): v is ScreenVia => v === 'app' || v === 'rustdesk'
/** A salt or challenge: RustDesk's are 32 and 6 characters. */
const isShortText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256

function savedLogin(body: unknown): SavedLoginRequest {
  if (!isObject(body) || !isVia(body.via) || !isShortText(body.salt) || !isShortText(body.challenge)) {
    throw apiError(400, 'Expected {via: "app" or "rustdesk", salt, challenge}')
  }
  return { via: body.via, salt: body.salt, challenge: body.challenge }
}

function savePassword(body: unknown): SavePasswordRequest {
  if (!isObject(body) || !isVia(body.via) || !isShortText(body.salt) || typeof body.h1 !== 'string') {
    throw apiError(400, 'Expected {via: "app" or "rustdesk", salt, h1}')
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(body.h1)) throw apiError(400, 'h1 is 32 bytes in base64')
  return { via: body.via, salt: body.salt, h1: body.h1 }
}

function forgetPassword(body: unknown): ForgetPasswordRequest {
  if (!isObject(body) || (body.via !== undefined && !isVia(body.via))) throw apiError(400, 'Expected {via?: "app" or "rustdesk"}')
  return body.via === undefined ? {} : { via: body.via }
}

function claudeCheck(body: unknown): ClaudeCheckRequest {
  if (!isObject(body) || (body.replace !== undefined && typeof body.replace !== 'boolean')) throw apiError(400, 'Expected {replace?: true or false}')
  return body.replace === undefined ? {} : { replace: body.replace }
}

function switchRefresh(body: unknown): SwitchRefreshRequest {
  if (!isObject(body) || (body.readings !== undefined && typeof body.readings !== 'boolean')) throw apiError(400, 'Expected {readings?: true or false}')
  return body.readings === undefined ? {} : { readings: body.readings }
}

/** The CRM's ids are UUIDs; nothing else is passed on to it. */
const SUBSCRIPTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function switchTarget(body: unknown): string {
  if (!isObject(body) || typeof body.to !== 'string' || !SUBSCRIPTION_ID.test(body.to)) throw apiError(400, 'Expected {to: the id of a Claude subscription}')
  return body.to.toLowerCase()
}

function switchRequest(body: unknown): SwitchRequest {
  const to = switchTarget(body)
  const restart = isObject(body) ? body.restart : undefined
  if (!Array.isArray(restart) || restart.length > 64 || restart.some(x => typeof x !== 'string' || x.length === 0 || x.length > 80)) {
    throw apiError(400, 'Expected {to, restart: [the ids of the chats to restart]}')
  }
  return { to, restart: [...new Set(restart as string[])] }
}

function switchAuto(body: unknown): SwitchAutoRequest {
  if (!isObject(body) || typeof body.on !== 'boolean') throw apiError(400, 'Expected {on: true or false}')
  return { on: body.on }
}

function joinConfirm(body: unknown): JoinConfirm {
  if (!isObject(body) || typeof body.match !== 'boolean') throw apiError(400, 'Expected {match: true or false}')
  return { match: body.match }
}

/** A browser Origin from anywhere but this PC (no Origin is fine: not a browser, or a same-origin GET). */
const foreignOrigin = (req: IncomingMessage) => typeof req.headers.origin === 'string' && !loopbackOrigin(req.headers.origin)

function settingsPatch(body: unknown): SettingsPatch {
  if (!isObject(body)) throw apiError(400, 'Expected {route?, stayReachable?}')
  for (const key of Object.keys(body)) if (key !== 'route' && key !== 'stayReachable') throw apiError(400, `Unknown setting "${key}"`)
  const patch: SettingsPatch = {}
  if (body.route !== undefined) {
    const route = ROUTES.find(r => r === body.route)
    if (!route) throw apiError(400, `route must be one of ${ROUTES.join(', ')}`)
    patch.route = route
  }
  if (body.stayReachable !== undefined) {
    if (typeof body.stayReachable !== 'boolean') throw apiError(400, 'stayReachable must be true or false')
    patch.stayReachable = body.stayReachable
  }
  return patch
}

type Route = [method: 'GET' | 'POST', path: RegExp, run: (m: string[], body: unknown) => unknown]

// ---------------------------------------------------------------------------------------
// WebSocket frames

/** One unmasked server frame. */
export function wsFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const n = payload.length
  const head = n < 126 ? Buffer.alloc(2) : n < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10)
  head[0] = 0x80 | opcode
  if (n < 126) head[1] = n
  else if (n < 65_536) {
    head[1] = 126
    head.writeUInt16BE(n, 2)
  } else {
    head[1] = 127
    head.writeBigUInt64BE(BigInt(n), 2)
  }
  return Buffer.concat([head, payload])
}

interface WsClient {
  socket: Duplex
  closing: boolean
  /** F-057: when anything last arrived from the client (wsReader sets it), for the sweep of silent ones. */
  seen?: number
}

/** A close frame's payload: the status code, and a reason cut to fit the 125-byte limit. */
function closePayload(code: number, reason = ''): Buffer {
  const status = Buffer.alloc(2)
  status.writeUInt16BE(code)
  let text = reason
  while (Buffer.byteLength(text) > 123) text = text.slice(0, -1)
  return Buffer.concat([status, Buffer.from(text)])
}

interface ReaderOptions {
  /** Binary and continuation payloads, in order (a pipe). Without it, data frames are ignored. */
  onData?: (payload: Buffer) => void
  /** F-018: whole (unfragmented) text messages, for a mount's socket. */
  onText?: (text: string) => void
  maxFrame?: number
}

/** Reads masked client frames as they come; answers ping and close; a protocol error closes. */
function wsReader(client: WsClient, onClose: () => void, opts: ReaderOptions = {}) {
  const maxFrame = opts.maxFrame ?? MAX_WS_FRAME
  let buf: Buffer = Buffer.alloc(0)
  const shut = (code: number) => {
    if (!client.closing) {
      client.closing = true
      const status = Buffer.alloc(2)
      status.writeUInt16BE(code)
      client.socket.write(wsFrame(0x8, status))
    }
    client.socket.end()
    onClose()
  }
  return (chunk: Buffer) => {
    client.seen = Date.now()
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0
      const rsv = buf[0] & 0x70
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let at = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        at = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        const big = buf.readBigUInt64BE(2)
        if (big > BigInt(maxFrame)) return shut(1009)
        len = Number(big)
        at = 10
      }
      // No extensions, so no RSV bits; a client must mask; control frames are short and whole.
      if (rsv || !masked) return shut(1002)
      if (opcode >= 0x8 && (!fin || len > 125)) return shut(1002)
      if (len > maxFrame) return shut(1009)
      if (buf.length < at + 4 + len) return
      const mask = buf.subarray(at, at + 4)
      const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len))
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      buf = buf.subarray(at + 4 + len)
      if (opcode === 0x8) {
        // Close: answer with the same status, then hang up.
        if (!client.closing) {
          client.closing = true
          client.socket.write(wsFrame(0x8, payload.subarray(0, 2)))
        }
        client.socket.end()
        return onClose()
      }
      if (opcode === 0x9) client.socket.write(wsFrame(0xa, payload))
      else if (opts.onText && opcode === 0x1) {
        // Browsers send a message as one frame; a fragmented one isn't taken.
        if (!fin) return shut(1003)
        if (!client.closing) opts.onText(payload.toString('utf8'))
      } else if (opts.onData && (opcode === 0x2 || opcode === 0x0)) {
        // A text message is refused at its first frame, so continuations here are binary.
        if (!client.closing) opts.onData(payload)
      } else if (opts.onData && opcode === 0x1) return shut(1003)
      else if (![0x0, 0x1, 0x2, 0xa].includes(opcode)) return shut(1002)
      // Otherwise (the state socket): nothing a client says is acted on.
    }
  }
}

/** Starts the API on 127.0.0.1:<port>; resolves once listening. */
export function startApi(o: ApiOptions): Promise<Api> {
  const host = o.host ?? '127.0.0.1'
  const log = o.log
  const a = o.actions
  const clients = new Set<WsClient>()
  let pushTimer: NodeJS.Timeout | null = null

  const routes: Route[] = [
    ['GET', /^\/state$/, () => a.state()],
    ['POST', /^\/pairing\/start$/, () => a.startPairing()],
    ['POST', /^\/pairing\/cancel$/, () => a.cancelPairing()],
    ['POST', /^\/pairing\/requests\/([^/]+)\/approve$/, ([id]) => a.approve(id)],
    ['POST', /^\/pairing\/requests\/([^/]+)\/reject$/, ([id]) => a.reject(id)],
    ['POST', /^\/join$/, (_, body) => a.join(joinRequest(body))],
    ['POST', /^\/join\/confirm$/, (_, body) => a.confirmJoin(joinConfirm(body))],
    ['POST', /^\/join\/cancel$/, () => a.cancelJoin()],
    ['POST', /^\/devices\/([^/]+)\/check$/, ([id]) => a.check(id)],
    ['POST', /^\/devices\/([^/]+)\/screen$/, ([id]) => a.screen(id)],
    ['POST', /^\/devices\/([^/]+)\/remove$/, ([id]) => a.remove(id)],
    ['POST', /^\/settings$/, (_, body) => a.settings(settingsPatch(body))],
    ['POST', /^\/screen\/password$/, (_, body) => a.screenPassword(screenPassword(body))],
    ['POST', /^\/screen\/setup$/, () => a.screenSetup()],
    ['POST', /^\/claude\/sign-in$/, (_, body) => a.claudeSignIn(claudeSignIn(body))],
    ['POST', /^\/claude\/check$/, (_, body) => a.claudeCheck(claudeCheck(body))],
    ['POST', /^\/claude\/sign-out$/, () => a.claudeSignOut()],
    ['POST', /^\/claude\/switch\/refresh$/, (_, body) => a.claudeSwitchRefresh(switchRefresh(body))],
    ['POST', /^\/claude\/switch\/preview$/, (_, body) => a.claudeSwitchPreview(switchTarget(body))],
    ['POST', /^\/claude\/switch\/auto$/, (_, body) => a.claudeSwitchAuto(switchAuto(body))],
    ['POST', /^\/claude\/switch$/, (_, body) => a.claudeSwitch(switchRequest(body))],
    ['POST', /^\/devices\/([^/]+)\/password\/login$/, ([id], body) => a.savedLogin(id, savedLogin(body))],
    ['POST', /^\/devices\/([^/]+)\/password\/save$/, ([id], body) => a.savePassword(id, savePassword(body))],
    ['POST', /^\/devices\/([^/]+)\/password\/forget$/, ([id], body) => a.forgetPassword(id, forgetPassword(body))],
  ]

  /** F-018: the mount whose prefix this path is under. */
  const mountOf = (path: string) => o.mounts?.find(m => path.startsWith(`${AGENT_API_PREFIX}${m.prefix}/`))

  async function answerMount(m: ApiMount, req: IncomingMessage, url: URL): Promise<unknown> {
    const rest = url.pathname.slice(`${AGENT_API_PREFIX}${m.prefix}`.length)
    if (m.ownAuth?.(rest)) {
      // Its own credential, for programs: a browser page always sends an Origin on a POST.
      if (req.headers.origin !== undefined) throw apiError(403, 'Not for pages')
    } else {
      if (foreignOrigin(req)) throw apiError(403, 'Requests from pages on other sites are refused')
      if (!tokenOk(req.headers['x-sad-token'], o.token)) throw apiError(401, 'Missing or wrong x-sad-token: open the app through its dev server (npm run dev)')
    }
    const method = req.method ?? 'GET'
    const body = method === 'POST' || method === 'PATCH' || method === 'PUT' ? await readJson(req) : undefined
    return m.http({ method, rest, query: url.searchParams, body, headers: req.headers })
  }

  /** F-018: a mount's WebSocket, text frames both ways; closed with the others when the API stops. */
  function wsSocket(socket: Duplex, head: Buffer): WsSocket {
    ;(socket as net.Socket).setNoDelay?.(true)
    const client: WsClient = { socket, closing: false }
    const texts: ((text: string) => void)[] = []
    const closes: (() => void)[] = []
    let done = false
    const stopSweep = sweep(client)
    const finish = () => {
      if (done) return
      done = true
      stopSweep()
      pipes.delete(stop)
      for (const cb of closes) cb()
    }
    const close = (code = 1000, reason = '') => {
      if (!client.closing) {
        client.closing = true
        socket.write(wsFrame(0x8, closePayload(code, reason)))
      }
      socket.end()
      setTimeout(() => socket.destroy(), 1000).unref()
      finish()
    }
    const stop = (why: string) => close(1001, why)
    const read = wsReader(client, finish, {
      maxFrame: MAX_PIPE_FRAME,
      onText: t => {
        // F-057: the page's ping is answered here and never reaches the mount.
        const pong = pongFor(t)
        if (pong !== null) return push(client, pong)
        for (const cb of texts) cb(t)
      },
    })
    socket.on('data', read)
    socket.on('close', finish)
    pipes.add(stop)
    // After the mount's handler has said what it wants to hear.
    if (head.length) queueMicrotask(() => read(head))
    return {
      sendText(text) {
        if (client.closing || socket.destroyed) return
        if (socket.writableLength > MAX_WS_BACKLOG) {
          log?.warn('a WebSocket client stopped reading; dropped it')
          socket.destroy()
          return
        }
        socket.write(wsFrame(0x1, Buffer.from(text)))
      },
      onText: cb => void texts.push(cb),
      onClose: cb => {
        if (done) cb()
        else closes.push(cb)
      },
      close,
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://agent')
    const path = url.pathname
    if (path === `${AGENT_API_PREFIX}/health` && req.method === 'GET') return send(res, 200, { ok: true })
    if (!path.startsWith(`${AGENT_API_PREFIX}/`)) return send(res, 404, { error: `No such path: ${path}` })
    const mount = mountOf(path)
    if (mount) {
      // F-054: a path that takes over the response (the CRM's proxy), guarded the same way.
      const raw = mount.raw?.(path.slice(`${AGENT_API_PREFIX}${mount.prefix}`.length), url)
      if (raw) {
        if (foreignOrigin(req)) throw apiError(403, 'Requests from pages on other sites are refused')
        if (!tokenOk(req.headers['x-sad-token'], o.token)) throw apiError(401, 'Missing or wrong x-sad-token: open the app through its dev server (npm run dev)')
        return raw(req, res)
      }
      const result = await answerMount(mount, req, url)
      return send(res, 200, typeof result === 'object' && result !== null ? result : { ok: true })
    }
    if (foreignOrigin(req)) return send(res, 403, { error: 'Requests from pages on other sites are refused' })
    if (!tokenOk(req.headers['x-sad-token'], o.token)) {
      return send(res, 401, { error: 'Missing or wrong x-sad-token: open the app through its dev server (npm run dev)' })
    }
    const rest = path.slice(AGENT_API_PREFIX.length)
    let methodMismatch = false
    for (const [method, pattern, run] of routes) {
      const m = pattern.exec(rest)
      if (!m) continue
      if (req.method !== method) {
        methodMismatch = true
        continue
      }
      let params: string[]
      try {
        params = m.slice(1).map(decodeURIComponent)
      } catch {
        throw apiError(400, 'Malformed path')
      }
      const body = method === 'POST' ? await readJson(req) : undefined
      const result = await run(params, body)
      // Every answer is a JSON object; actions with nothing to say get {ok: true}.
      return send(res, 200, typeof result === 'object' && result !== null ? result : { ok: true })
    }
    if (methodMismatch) return send(res, 405, { error: `${req.method} is not allowed on ${path}` })
    return send(res, 404, { error: `No such path: ${path}` })
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = (e as { status?: unknown }).status
      const code = typeof status === 'number' && status >= 400 && status < 600 ? status : 500
      if (code === 500) log?.error(`${req.method} ${req.url}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
      if (!res.headersSent) send(res, code, { error: e instanceof Error ? e.message : String(e) })
      else res.destroy()
    })
  })

  function stateText() {
    return JSON.stringify({ type: 'state', state: a.state() } satisfies AgentEvent)
  }

  function push(client: WsClient, text: string) {
    if (client.closing || client.socket.destroyed) return
    if (client.socket.writableLength > MAX_WS_BACKLOG) {
      log?.warn('a WebSocket client stopped reading; dropped it')
      client.socket.destroy()
      return
    }
    client.socket.write(wsFrame(0x1, Buffer.from(text)))
  }

  /**
   * F-057: pings a text WebSocket client now and then and drops one that has gone silent (a phone
   * that locked or lost its VPN leaves no FIN, and its socket would otherwise stay for ever).
   * The remote screen's pipe and the keys socket are left as they were.
   */
  function sweep(client: WsClient) {
    client.seen = Date.now()
    return keepalive(
      {
        seen: () => client.seen ?? 0,
        alive: () => !client.closing && !client.socket.destroyed,
        ping: () => void client.socket.write(wsFrame(0x9)),
        drop: () => {
          log?.warn('a WebSocket client went silent; dropped it')
          client.socket.destroy()
        },
      },
      { pingMs: o.wsPingMs ?? WS_PING_MS, deadMs: o.wsDeadMs ?? WS_DEAD_MS },
    )
  }

  function refuse(socket: Duplex, status: number, text: string) {
    const body = JSON.stringify({ error: text })
    socket.end(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    )
  }

  // Open pipes, each closed by its function (on stop).
  const pipes = new Set<(why: string) => void>()
  const remotePath = new RegExp(`^${AGENT_API_PREFIX}/devices/([^/]+)/remote$`)
  const keysPath = `${AGENT_API_PREFIX}/keys`

  /** F-013: /keys, open while the Control page here has the focus; this PC's keys go to it. */
  function keys(socket: Duplex, head: Buffer) {
    ;(socket as net.Socket).setNoDelay?.(true)
    const client: WsClient = { socket, closing: false }
    let grab: { stop(): void } | null = null
    let done = false
    const finish = (why: string) => {
      if (done) return
      done = true
      pipes.delete(finish)
      grab?.stop()
      if (!client.closing) {
        client.closing = true
        socket.write(wsFrame(0x8, closePayload(1000, why)))
      }
      socket.end()
      setTimeout(() => socket.destroy(), 1000).unref()
    }
    const send = (m: KeysMessage) => {
      if (!done) socket.write(wsFrame(0x1, Buffer.from(JSON.stringify(m))))
    }
    const read = wsReader(client, () => finish('the page closed it'))
    socket.on('data', read)
    socket.on('close', () => finish('the page went away'))
    pipes.add(finish)
    a.grabKeys!(k => send({ t: 'key', ...k }), finish).then(
      g => {
        if (done) return g.stop()
        grab = g
        send({ t: 'grabbing' })
      },
      (e: unknown) => finish(e instanceof Error ? e.message : String(e)),
    )
    if (head.length) read(head)
  }

  /** A device's RustDesk stream as binary frames both ways; whichever side is ahead waits for the other. */
  function pipe(socket: Duplex, stream: Duplex, head: Buffer, id: string) {
    ;(socket as net.Socket).setNoDelay?.(true)
    const client: WsClient = { socket, closing: false }
    let done = false
    const finish = (why: string) => {
      if (done) return
      done = true
      pipes.delete(finish)
      if (!client.closing) {
        client.closing = true
        socket.write(wsFrame(0x8, closePayload(1000, why)))
      }
      socket.end()
      stream.destroy()
      setTimeout(() => socket.destroy(), 1000).unref()
      log?.info(`remote screen of ${id}: closed (${why})`)
    }
    const read = wsReader(client, () => finish('the page closed it'), {
      maxFrame: MAX_PIPE_FRAME,
      onData: payload => {
        if (!stream.write(payload)) socket.pause()
      },
    })
    stream.on('drain', () => socket.resume())
    stream.on('data', (chunk: Buffer) => {
      if (client.closing) return
      if (!socket.write(wsFrame(0x2, chunk))) stream.pause()
    })
    socket.on('drain', () => stream.resume())
    stream.on('end', () => finish('the other PC closed the screen'))
    stream.on('error', e => finish(e.message))
    stream.on('close', () => finish('the link closed'))
    socket.on('data', read)
    socket.on('close', () => finish('the page went away'))
    pipes.add(finish)
    log?.info(`remote screen of ${id}: open`)
    socket.resume()
    if (head.length) read(head)
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {})
    const url = new URL(req.url ?? '/', 'http://agent')
    const path = url.pathname
    const remote = remotePath.exec(path)
    const mount = mountOf(path)
    const mountWs = mount?.ws?.(path.slice(`${AGENT_API_PREFIX}${mount.prefix}`.length), url.searchParams) ?? null
    if (path !== `${AGENT_API_PREFIX}/ws` && path !== keysPath && !remote && !mountWs) return refuse(socket, 404, `No WebSocket at ${path}`)
    // The proxy keeps the browser's own Origin on a WebSocket (changeOrigin rewrites Host only).
    if (foreignOrigin(req)) return refuse(socket, 403, 'WebSockets from pages on other sites are refused')
    if (!tokenOk(req.headers['x-sad-token'], o.token)) return refuse(socket, 401, 'Missing or wrong x-sad-token')
    const key = req.headers['sec-websocket-key']
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase()
    if (upgrade !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) {
      return refuse(socket, 400, 'Not a WebSocket version 13 handshake')
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    const switching = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`

    if (mountWs) {
      socket.write(switching)
      return mountWs(wsSocket(socket, head))
    }

    if (path === keysPath) {
      if (!a.grabKeys) return refuse(socket, 404, "This PC can't take its keys for Control")
      socket.write(switching)
      return keys(socket, head)
    }

    if (remote) {
      let id: string
      try {
        id = decodeURIComponent(remote[1])
      } catch {
        return refuse(socket, 400, 'Malformed path')
      }
      // No via: the RustDesk way, as before F-006.
      const via = url.searchParams.get('via') ?? 'rustdesk'
      if (via !== 'app' && via !== 'rustdesk') return refuse(socket, 400, 'via must be app or rustdesk')
      // The stream first, so a missing device or link is an HTTP answer with the reason.
      socket.pause()
      Promise.resolve()
        .then(() => a.remote(id, via))
        .then(
          stream => {
            if (socket.destroyed) return void stream.destroy()
            socket.write(switching)
            pipe(socket, stream, head, id)
          },
          (e: unknown) => {
            const status = (e as { status?: unknown }).status
            refuse(socket, typeof status === 'number' && status >= 400 && status < 600 ? status : 502, e instanceof Error ? e.message : String(e))
          },
        )
      return
    }

    socket.write(switching)
    ;(socket as net.Socket).setNoDelay?.(true)
    const client: WsClient = { socket, closing: false }
    let gone = false
    const stopSweep = sweep(client)
    const drop = () => {
      if (gone) return
      gone = true
      stopSweep()
      clients.delete(client)
      o.onClients?.(clients.size)
    }
    // Nothing a client says is acted on, but the page's ping gets its pong (F-057).
    const read = wsReader(client, drop, {
      onText: t => {
        const pong = pongFor(t)
        if (pong !== null) push(client, pong)
      },
    })
    socket.on('data', read)
    socket.on('close', drop)
    clients.add(client)
    o.onClients?.(clients.size)
    push(client, stateText())
    if (head.length) read(head)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, host, () => {
      server.off('error', reject)
      server.on('error', e => log?.error(`${e.message}`))
      const port = (server.address() as net.AddressInfo).port
      log?.info(`listening on http://${host}:${port}${AGENT_API_PREFIX}`)
      resolve({
        port,
        changed() {
          if (pushTimer || !clients.size) return
          pushTimer = setTimeout(() => {
            pushTimer = null
            const text = stateText()
            for (const client of clients) push(client, text)
          }, PUSH_DEBOUNCE_MS)
        },
        clients: () => clients.size,
        close() {
          if (pushTimer) clearTimeout(pushTimer)
          pushTimer = null
          for (const finish of [...pipes]) finish('the agent is stopping')
          for (const client of clients) {
            // 1001: going away.
            if (!client.closing) client.socket.write(wsFrame(0x8, Buffer.from([0x03, 0xe9])))
            client.closing = true
            client.socket.end()
            setTimeout(() => client.socket.destroy(), 1000).unref()
          }
          clients.clear()
          return new Promise<void>(r => {
            server.close(() => r())
            server.closeAllConnections()
          })
        },
      })
    })
  })
}
