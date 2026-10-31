import dgram from 'node:dgram'
import net from 'node:net'
import { Deframer, frame, parseHostPort, unmangle } from './codec.ts'
import { decode, encode, type Bodies, type Outgoing } from './messages.ts'

// Talking to an unmodified hbbs 1.1.16 (rustdesk-server src/rendezvous_server.rs, cited below
// by line). Its transport rules:
//   - UDP carries a bare RendezvousMessage, no length prefix: registration, and the pushes hbbs
//     forwards to a registered device (handle_udp 317-472, sends through tx at 254).
//   - TCP carries BytesCodec frames. hbbs keeps reading a connection after PunchHoleRequest and
//     RequestRelay (handle_tcp 485-506 return true) and closes it after RelayResponse,
//     PunchHoleSent and LocalAddr (507-532 return false, ending the loop at 1182-1186), so the
//     controlled side's replies each take a new connection. It also drops a connection 30 s
//     after the last frame it got (timeout(30_000, ...) at 1182).
// Never point these at 127.0.0.1: the hub must reach hbbs from its LAN address to be inside
// --mask (is_lan 1249-1264).

type Log = (msg: string) => void
const quiet: Log = () => {}

/** hbbs counts a device offline 30 s after its last RegisterPeer (REG_TIMEOUT, line 50). */
export const REGISTER_EVERY_MS = 12_000
/** hbbs's own read timeout on a TCP connection (line 1182). */
export const PUNCH_TIMEOUT_MS = 30_000
const ONE_SHOT_TIMEOUT_MS = 5_000
// The push budget. hbbs forwards RequestRelay without checking any key (493-506), so anyone
// who knows our ID could fill it, and a forged relay push holds its slot ~30 s (hbbr parks the
// lone stream). So it is kept per requester too: the address hbbs writes into socket_addr is
// the sender's own TCP peer (500), which can't be forged. The last slot is kept for a trusted
// requester (a paired member's address), which the per-minute cap doesn't hold back either.
const MAX_PENDING = 5
const MAX_PENDING_PER_SOURCE = 2
const MAX_PER_MINUTE = 20
// hbbs messages are a few hundred bytes; anything near this is not hbbs.
const MAX_FRAME = 64 * 1024

/** TCP to 'host:port' with a connect timeout. The caller owns the socket (and its errors) after. */
export function connectTcp(addr: string, timeoutMs: number, localAddress?: string): Promise<net.Socket> {
  const { host, port } = parseHostPort(addr)
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, localAddress, noDelay: true })
    const fail = (e: Error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(e)
    }
    const timer = setTimeout(() => fail(new Error(`No TCP connection to ${addr} within ${timeoutMs} ms`)), timeoutMs)
    socket.once('error', fail)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.off('error', fail)
      resolve(socket)
    })
  })
}

/**
 * Whether a relay_server from hbbs is one of ours (the hub's lan:hbbr or publicHost:hbbr).
 * hbbs forwards RequestRelay to a device without any check (493-506), so anyone who knows our
 * ID could otherwise send us to their own relay.
 */
export function relayAllowed(relayServer: string, allow: readonly string[]): boolean {
  const key = endpointKey(relayServer)
  return key !== null && allow.some(a => endpointKey(a) === key)
}

function endpointKey(s: string) {
  try {
    const { host, port } = parseHostPort(s)
    return `${host.toLowerCase()}:${port}`
  } catch {
    return null
  }
}

export type PushKind = 'punch_hole' | 'fetch_local_addr' | 'request_relay'
/** What onPush gets: the kind, then its body. */
export type Push = { [K in PushKind]: [kind: K, body: Bodies[K]] }[PushKind]

export interface RegistrationOptions {
  /** hbbs as 'ip:port', at its LAN address. */
  hbbs: string
  /** This PC's LAN address: the socket binds bindAddress:0, so hbbs sees us inside --mask. */
  bindAddress: string
  id: string
  /** 16 bytes, kept for good: hbbs binds an ID to the first uuid it registered with (handle_udp 359-381). */
  uuid: Uint8Array
  /** 32 bytes: this device's spkiSha256. */
  pk: Uint8Array
  /**
   * Gets punch_hole, fetch_local_addr and request_relay. A returned promise keeps the push
   * pending until it settles: at most 5 pending (4 unless the requester is trusted), 2 from
   * one requester, and 20 a minute from untrusted ones; the rest are dropped.
   */
  onPush: (...push: Push) => unknown
  /** When given, a push whose relay_server is not on it is dropped (see relayAllowed). */
  relayAllow?: readonly string[]
  /** Requesters (by IP, from the push's socket_addr) to keep room for: a paired member's last address. */
  trusted?: (ip: string) => boolean
  /** RegisterPeer interval, 12 s by default; tests shorten it. */
  everyMs?: number
  log?: Log
}

export interface Registration {
  stop(): void
  /** When hbbs last confirmed us: RegisterPeerResponse without request_pk, or RegisterPkResponse OK. */
  lastOk(): Date | null
}

/**
 * Keeps this device registered with hbbs over one UDP socket: RegisterPeer{id, serial: 0}
 * now and every 12 s, RegisterPk{id, uuid, pk} when hbbs asks for it (request_pk), and the
 * pushes hbbs forwards from controllers handed to onPush.
 */
export function startRegistration(opts: RegistrationOptions): Registration {
  const { host, port } = parseHostPort(opts.hbbs)
  const log = opts.log ?? quiet
  const name = `hbbs ${opts.hbbs}`
  if (opts.id.length < 6) throw new Error('hbbs refuses IDs shorter than 6 characters (handle_udp 348)')
  if (!opts.uuid.length || !opts.pk.length) throw new Error('hbbs ignores RegisterPk without uuid and pk (handle_udp 343)')

  let socket: dgram.Socket | null = null
  let stopped = false
  let ok: Date | null = null
  let pending = 0
  const bySource = new Map<string, number>() // pending pushes per requester IP
  const recent: number[] = [] // when each accepted untrusted push came, for the per-minute cap
  let quietUntil = 0
  let suppressed = 0

  // Drop notes are throttled: whoever floods us with pushes shouldn't also flood the log.
  const dropped = (why: string) => {
    const now = Date.now()
    if (now < quietUntil) return void suppressed++
    log(`${name}: dropped ${why}${suppressed ? ` (and ${suppressed} more since the last note)` : ''}`)
    suppressed = 0
    quietUntil = now + 10_000
  }

  const send = (msg: Outgoing) =>
    socket?.send(encode(msg), port, host, err => {
      if (err) log(`${name}: UDP send failed: ${err.message}`)
    })
  const register = () => send({ register_peer: { id: opts.id, serial: 0 } })

  const confirmed = () => {
    if (!ok) log(`${name}: registered ${opts.id}`)
    ok = new Date()
  }

  function open() {
    const s = dgram.createSocket(net.isIPv6(opts.bindAddress) ? 'udp6' : 'udp4')
    socket = s
    // A bind or send error (the LAN address went away) closes the socket; the next tick opens a new one.
    s.on('error', err => {
      log(`${name}: UDP socket on ${opts.bindAddress}: ${err.message}`)
      if (socket === s) socket = null
      try {
        s.close()
      } catch {
        // a socket that never bound is already closed
      }
    })
    s.on('message', onMessage)
    s.bind(0, opts.bindAddress, register)
  }

  function onMessage(buf: Buffer, from: dgram.RemoteInfo) {
    if (from.port !== port || (net.isIP(host) && !sameIp(from.address, host))) {
      return dropped(`a datagram from ${from.address}:${from.port}, which is not hbbs`)
    }
    const msg = decode(buf)
    switch (msg.kind) {
      case 'register_peer_response':
        // request_pk: hbbs has no key for us yet, or our IP changed (update_addr 570-604).
        if (msg.body.request_pk) send({ register_pk: { id: opts.id, uuid: opts.uuid, pk: opts.pk } })
        else confirmed()
        return
      case 'register_pk_response':
        if (msg.body.result === 'OK') return confirmed()
        return log(`${name}: refused the key for ${opts.id}: ${msg.body.result}${HINTS[String(msg.body.result)] ?? ''}`)
      case 'punch_hole':
      case 'fetch_local_addr':
      case 'request_relay':
        return push([msg.kind, msg.body] as Push)
      case 'unknown':
        return log(`${name}: ignored union field ${msg.body.field}`)
      default:
        return log(`${name}: ignored ${msg.kind}`)
    }
  }

  function push(p: Push) {
    const [kind, body] = p
    if (opts.relayAllow && !relayAllowed(body.relay_server, opts.relayAllow)) {
      return dropped(`${kind}: relay "${body.relay_server}" is not ours`)
    }
    const source = sourceOf(body.socket_addr)
    const trusted = source !== null && opts.trusted?.(source) === true
    const fromSource = bySource.get(source ?? '') ?? 0
    const now = Date.now()
    while (recent.length && now - recent[0] >= 60_000) recent.shift()
    if (pending >= (trusted ? MAX_PENDING : MAX_PENDING - 1)) return dropped(`${kind}: ${pending} pushes still pending`)
    if (fromSource >= MAX_PENDING_PER_SOURCE) return dropped(`${kind}: ${fromSource} pushes from ${source ?? 'an unknown address'} still pending`)
    if (!trusted && recent.length >= MAX_PER_MINUTE) return dropped(`${kind}: over ${MAX_PER_MINUTE} pushes a minute`)
    if (!trusted) recent.push(now)
    pending++
    bySource.set(source ?? '', fromSource + 1)
    let result: unknown
    try {
      result = opts.onPush(...p)
    } catch (e) {
      result = Promise.reject(e)
    }
    Promise.resolve(result)
      .catch(e => log(`${name}: ${kind} failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        pending--
        const left = (bySource.get(source ?? '') ?? 1) - 1
        if (left > 0) bySource.set(source ?? '', left)
        else bySource.delete(source ?? '')
      })
  }

  open()
  const timer = setInterval(() => {
    if (stopped) return
    if (socket) register()
    else open()
  }, opts.everyMs ?? REGISTER_EVERY_MS)

  return {
    stop() {
      stopped = true
      clearInterval(timer)
      socket?.close()
      socket = null
    },
    lastOk: () => ok,
  }
}

const HINTS: Record<string, string> = {
  UUID_MISMATCH: ' (hbbs keeps the uuid an ID first registered with, or saw this ID with another key from another IP)',
  TOO_FREQUENT: ' (hbbs allows 3 RegisterPk per ID in 6 s, and about 30 a minute per IP: 390-394, 883-911)',
}

const plainIp = (ip: string) => ip.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '')

function sameIp(a: string, b: string) {
  return plainIp(a) === plainIp(b)
}

/** Who asked, from a push's socket_addr (the requester's address as hbbs saw it), or null. */
function sourceOf(socketAddr: Uint8Array): string | null {
  if (!socketAddr.length) return null
  try {
    return plainIp(unmangle(socketAddr).ip)
  } catch {
    return null
  }
}

/**
 * One message to hbbs on a new TCP connection, as the controlled side sends LocalAddr,
 * RelayResponse and PunchHoleSent. hbbs handles the frame and closes the connection; this
 * resolves once it has, or once the frame is out and `timeoutMs` has passed.
 */
export async function sendOneShot(
  hbbs: string,
  msg: Outgoing,
  opts: { timeoutMs?: number; localAddress?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? ONE_SHOT_TIMEOUT_MS
  const data = frame(encode(msg))
  const socket = await connectTcp(hbbs, timeoutMs, opts.localAddress)
  return new Promise((resolve, reject) => {
    let sent = false
    const done = (e?: Error) => {
      clearTimeout(timer)
      socket.destroy()
      if (sent) resolve()
      else reject(e ?? new Error(`hbbs ${hbbs} closed the connection before the message went out`))
    }
    const timer = setTimeout(() => done(new Error(`Could not send to hbbs ${hbbs} within ${timeoutMs} ms`)), timeoutMs)
    socket.on('error', done)
    socket.on('close', () => done())
    socket.resume() // hbbs answers nothing; reading lets its close come through
    socket.end(data, () => {
      sent = true
    })
  })
}

export type PunchAnswer = (
  | { kind: 'punch_hole_response'; body: Bodies['punch_hole_response'] }
  | { kind: 'relay_response'; body: Bodies['relay_response'] }
) & {
  /** The punch socket, still open: hbbs reads more frames on it until 30 s after the last one. */
  socket: net.Socket
  /** Sends one more message (a RequestRelay) on the punch socket; false when it has closed. */
  send(msg: Outgoing): boolean
  close(): void
}

export interface PunchOptions {
  /** The ID to reach (the hub's). */
  id: string
  licenceKey: string
  /** With a version, hbbs signs the peer's key into the answer's `pk` (get_pk 1196-1218). */
  version: string
  /** Capped at 30 s, hbbs's own timeout. */
  timeoutMs?: number
  localAddress?: string
  log?: Log
}

/**
 * Asks hbbs for a way to `id`: PunchHoleRequest{id, nat_type: SYMMETRIC, licence_key,
 * conn_type: DEFAULT_CONN, version} over TCP, the only transport hbbs accepts it on (UDP is
 * ignored, 427-430). hbbs files this connection under our address (488) and answers on it:
 *   - punch_hole_response at once when the key is wrong, the ID unknown or offline (681-781;
 *     see punchFailure), or later, relayed from the peer's LocalAddr (is_local, 642-671) or
 *     PunchHoleSent (608-639);
 *   - relay_response, relayed from the peer's RelayResponse (507-526).
 * The socket stays open for a RequestRelay to follow. hbbs sends its answer only once per
 * connection (send_to_tcp 814-819 takes the stored sink), so a RelayResponse to that later
 * RequestRelay doesn't come back here: join the relay with your own uuid instead.
 */
export async function punchHoleRequest(hbbs: string, opts: PunchOptions): Promise<PunchAnswer> {
  const timeoutMs = Math.min(opts.timeoutMs ?? PUNCH_TIMEOUT_MS, PUNCH_TIMEOUT_MS)
  const deadline = Date.now() + timeoutMs
  const log = opts.log ?? quiet
  const request = frame(
    encode({
      punch_hole_request: {
        id: opts.id,
        nat_type: 'SYMMETRIC',
        licence_key: opts.licenceKey,
        conn_type: 'DEFAULT_CONN',
        version: opts.version,
      },
    }),
  )
  const socket = await connectTcp(hbbs, timeoutMs, opts.localAddress)
  return new Promise((resolve, reject) => {
    const deframer = new Deframer(MAX_FRAME)
    let answered = false
    const fail = (e: Error) => {
      if (answered) return
      answered = true
      clearTimeout(timer)
      socket.destroy()
      reject(e)
    }
    const timer = setTimeout(
      () => fail(new Error(`hbbs ${hbbs} did not answer within ${timeoutMs} ms`)),
      Math.max(0, deadline - Date.now()),
    )
    // Listeners stay for the socket's whole life, so an error after the answer can't go unhandled.
    socket.on('error', e => (answered ? log(`hbbs ${hbbs}: punch socket: ${e.message}`) : fail(e)))
    socket.on('close', () => fail(new Error(`hbbs ${hbbs} closed the connection without an answer`)))
    socket.on('data', (chunk: Buffer) => {
      let frames: Buffer[]
      try {
        frames = deframer.push(chunk)
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        if (!answered) return fail(err)
        log(`hbbs ${hbbs}: ${err.message}`)
        return void socket.destroy()
      }
      for (const f of frames) {
        const msg = decode(f)
        if (answered || (msg.kind !== 'punch_hole_response' && msg.kind !== 'relay_response')) {
          log(`hbbs ${hbbs}: ignored ${msg.kind} on the punch socket`)
          continue
        }
        answered = true
        clearTimeout(timer)
        resolve({
          ...msg,
          socket,
          send(next) {
            if (socket.destroyed || !socket.writable) return false
            socket.write(frame(encode(next)))
            return true
          },
          close() {
            socket.end()
            setTimeout(() => socket.destroy(), 2_000).unref()
          },
        })
      }
    })
    socket.write(request)
  })
}

/**
 * Why a punch_hole_response is a refusal, or null when it carries an address. As RustDesk's
 * client reads it (rustdesk 1.5.0 client.rs:995-1012): an empty socket_addr means it failed.
 * ID_NOT_EXIST is 0, the proto3 default, so a bare response means "no such ID".
 */
export function punchFailure(body: Bodies['punch_hole_response']): string | null {
  if (body.socket_addr.length) return null
  return body.other_failure || String(body.failure)
}
