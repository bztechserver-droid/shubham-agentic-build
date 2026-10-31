import { performance } from 'node:perf_hooks'
import { Duplex } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import { tlsSide } from './tls.ts'

// One TLS link carries a JSON control channel and any number of byte streams (a RustDesk
// tunnel, later the shared drive). Frames: u8 type | u32 streamId | u32 length | payload,
// big-endian, payload at most 64 KiB.
//
// Streams: the TLS client opens odd IDs, the server even ones. `close` with an empty payload
// means "no more data from me" (the stream ends once both sides have sent it); with a reason
// in the payload it aborts the stream at once.
//
// Backpressure is per stream: each side may have at most WINDOW bytes of a stream unread at
// the other end, and `window` frames hand back credit as the reader consumes. The TLS socket
// itself is always read, so one slow stream never stalls the others, pings or bye (pausing
// the whole socket deadlocks two streams whose readers depend on each other).

const HEADER = 9
export const MAX_PAYLOAD = 64 * 1024
/** Unread bytes allowed per stream and direction: 1 MiB is ~3 MB/s at a 300 ms Wi-Fi RTT. */
export const WINDOW = 1024 * 1024

const CONTROL = 0
const OPEN = 1
const DATA = 2
const CLOSE = 3
const OPEN_RESULT = 4
const WINDOW_UPDATE = 5

const EMPTY = Buffer.alloc(0)

export type Control = { t: string; [key: string]: unknown }
export type OpenMeta = Record<string, unknown>

/**
 * Decides on a stream the far end wants to open. Return (or resolve to) what to do with the
 * stream once it is open; throw (or reject) to refuse it, with the error's message as the reason.
 */
export type OpenHandler = (meta: OpenMeta) => StreamUser | Promise<StreamUser>
export type StreamUser = (stream: Duplex) => void

export interface MuxOptions {
  /** Which end of the TLS handshake this is; read from tls.ts when left out. */
  side?: 'client' | 'server'
  /** Every control message except ping, pong and bye, which the mux answers itself. */
  onControl?: (msg: Control) => void
  /** The handler for each stream kind this end accepts. Other kinds are refused. */
  onOpen?: Record<string, OpenHandler>
  /** Ping period. Default 5 s. */
  pingMs?: number
  /** The link is dead after this long without a frame. Default 15 s. */
  deadMs?: number
  /** How long open() waits for the far end to accept. Default 30 s. */
  openTimeoutMs?: number
  log?: (msg: string) => void
}

export interface Mux {
  send(msg: Control): void
  open(kind: string, meta?: OpenMeta): Promise<Duplex>
  /** The last round trip measured on a pong, in ms; null before the first one. */
  rtt(): number | null
  /** When the last frame arrived (epoch ms). */
  lastSeen(): number
  /** Streams open or half-closed right now. */
  streams(): number
  /** Why the link closed, or null while it is up. */
  closed(): string | null
  /** Says bye with the reason, then closes. Every stream on the link closes with it. */
  close(reason: string): void
  /** Called once when the link closes, with the reason; at once if it already has. */
  on(event: 'close', listener: (reason: string) => void): void
}

interface Stream {
  id: number
  duplex: Duplex
  sentClose: boolean
  gotClose: boolean
  /** Bytes we may still send before the far end hands back credit. */
  credit: number
  /** Bytes of this stream received so far, and how many the far end was allowed to send. */
  received: number
  allowed: number
  /** A write waiting for credit or for the TLS socket to drain. */
  writing: { rest: Buffer; done: () => void } | null
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const json = (v: unknown) => Buffer.from(JSON.stringify(v))

function parseObject(payload: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(payload.toString('utf8'))
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function createMux(tls: TLSSocket, opts: MuxOptions = {}): Mux {
  const { onControl, onOpen = {}, pingMs = 5000, deadMs = 15_000, openTimeoutMs = 30_000, log } = opts
  const side = opts.side ?? tlsSide(tls)
  if (!side) throw new Error('createMux: say which end of the TLS handshake this is (side)')

  const streams = new Map<number, Stream>()
  const opening = new Map<number, { resolve: (d: Duplex) => void; reject: (e: Error) => void }>()
  const closeListeners: ((reason: string) => void)[] = []
  const waitingDrain = new Set<Stream>()
  let socketFull = false
  let nextId = side === 'client' ? 1 : 2
  let closedReason: string | null = null
  let socketError: string | null = null
  let rttMs: number | null = null
  let lastSeen = Date.now()
  let pingN = 0
  const pings = new Map<number, number>()
  let pending: Buffer = EMPTY

  // ---- writing

  function frame(type: number, id: number, payload: Buffer = EMPTY): boolean {
    if (tls.destroyed || !tls.writable) return true
    const head = Buffer.allocUnsafe(HEADER)
    head[0] = type
    head.writeUInt32BE(id, 1)
    head.writeUInt32BE(payload.length, 5)
    const ok = tls.write(payload.length ? Buffer.concat([head, payload]) : head)
    if (!ok) socketFull = true
    return ok
  }

  tls.on('drain', () => {
    socketFull = false
    for (const st of [...waitingDrain]) {
      waitingDrain.delete(st)
      pump(st)
    }
  })

  /** Sends as much of a stream's pending write as its credit and the TLS socket allow. */
  function pump(st: Stream) {
    const w = st.writing
    if (!w || closedReason !== null || st.duplex.destroyed) return
    while (w.rest.length > 0 && st.credit > 0 && !socketFull) {
      const n = Math.min(w.rest.length, st.credit, MAX_PAYLOAD)
      frame(DATA, st.id, w.rest.subarray(0, n))
      w.rest = w.rest.subarray(n)
      st.credit -= n
    }
    // A full socket holds the writer back too; otherwise it waits for a window frame.
    if (socketFull) waitingDrain.add(st)
    else if (w.rest.length === 0) {
      st.writing = null
      w.done()
    }
  }

  function send(msg: Control) {
    if (closedReason !== null) {
      log?.(`mux: dropped '${msg.t}', the link is closed`)
      return
    }
    const payload = json(msg)
    if (payload.length > MAX_PAYLOAD) throw new Error(`mux: control message '${msg.t}' is over 64 KiB`)
    frame(CONTROL, 0, payload)
  }

  // ---- streams

  /** Hands back credit for what the reader has consumed, a quarter window at a time. */
  function grant(st: Stream) {
    if (st.gotClose || closedReason !== null || streams.get(st.id) !== st) return
    // In flight plus unread stays within WINDOW.
    const consumed = st.received - st.duplex.readableLength
    const more = consumed + WINDOW - st.allowed
    if (more < WINDOW / 4) return
    st.allowed += more
    const payload = Buffer.allocUnsafe(4)
    payload.writeUInt32BE(more)
    frame(WINDOW_UPDATE, st.id, payload)
  }

  /** Drops a stream at both ends, with no 'error' event (nobody may be listening for one). */
  function abort(st: Stream, reason: string) {
    if (streams.get(st.id) === st) {
      streams.delete(st.id)
      if (closedReason === null) frame(CLOSE, st.id, Buffer.from(reason.slice(0, 200) || 'closed'))
    }
    st.duplex.destroy()
  }

  // Both sides said they are done: forget the ID. The Duplex lives on until it is read out.
  function settle(st: Stream) {
    if (st.sentClose && st.gotClose && streams.get(st.id) === st) streams.delete(st.id)
  }

  function makeStream(id: number): Stream {
    const st: Stream = {
      id,
      duplex: undefined as unknown as Duplex,
      sentClose: false,
      gotClose: false,
      credit: WINDOW,
      received: 0,
      allowed: WINDOW,
      writing: null,
    }
    st.duplex = new Duplex({
      allowHalfOpen: true,
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        // Unreachable in practice (closing the link destroys its streams); drop rather than throw.
        if (closedReason !== null) return callback()
        st.writing = { rest: chunk, done: () => callback() }
        pump(st)
      },
      final(callback) {
        if (!st.sentClose) {
          st.sentClose = true
          frame(CLOSE, id)
        }
        settle(st)
        callback()
      },
      destroy(err, callback) {
        st.writing = null
        waitingDrain.delete(st)
        // Still open on the wire: tell the far end to drop it too.
        if (streams.get(id) === st) {
          streams.delete(id)
          if (closedReason === null) frame(CLOSE, id, Buffer.from((err?.message || 'closed').slice(0, 200)))
        }
        callback(err)
      },
    })
    // Credit follows what the reader takes. _read is no hook for that: Node calls it before
    // taking from the buffer, and not again until the next push, which may never come.
    const read = st.duplex.read
    st.duplex.read = function (size?: number) {
      const chunk: unknown = read.call(this, size)
      if (chunk !== null) grant(st)
      return chunk
    }
    streams.set(id, st)
    return st
  }

  function open(kind: string, meta: OpenMeta = {}): Promise<Duplex> {
    if (closedReason !== null) return Promise.reject(new Error(`link closed: ${closedReason}`))
    if (nextId > 0xffffffff) return Promise.reject(new Error('mux: out of stream IDs'))
    const payload = json({ ...meta, kind })
    if (payload.length > MAX_PAYLOAD) return Promise.reject(new Error('mux: open request is over 64 KiB'))
    const id = nextId
    nextId += 2
    const st = makeStream(id)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        opening.delete(id)
        abort(st, 'open timed out')
        reject(new Error(`the far end did not accept the '${kind}' stream within ${openTimeoutMs / 1000} s`))
      }, openTimeoutMs)
      opening.set(id, {
        resolve: d => {
          clearTimeout(timer)
          resolve(d)
        },
        reject: e => {
          clearTimeout(timer)
          reject(e)
        },
      })
      frame(OPEN, id, payload)
    })
  }

  function onOpenFrame(id: number, payload: Buffer) {
    const theirs = side === 'client' ? 0 : 1
    if (id === 0 || id % 2 !== theirs || streams.has(id)) return fail(`bad stream ID ${id} in open`)
    const req = parseObject(payload)
    if (!req || typeof req.kind !== 'string') return fail('open without a kind')
    const { kind, ...meta } = req
    const st = makeStream(id)
    const live = () => closedReason === null && streams.get(id) === st
    const refuse = (reason: string) => {
      log?.(`mux: refused a '${kind}' stream: ${reason}`)
      if (live()) {
        frame(OPEN_RESULT, id, json({ ok: false, error: reason }))
        streams.delete(id)
      }
      st.duplex.destroy()
    }
    if (!Object.hasOwn(onOpen, kind)) return refuse(`no handler for '${kind}'`)
    Promise.resolve()
      .then(() => onOpen[kind](meta))
      .then(
        use => {
          if (typeof use !== 'function') return refuse(`the '${kind}' handler took no stream`)
          if (live()) frame(OPEN_RESULT, id, json({ ok: true }))
          // Even when the link died meanwhile: the user's cleanup runs on the destroyed stream.
          try {
            use(st.duplex)
          } catch (e) {
            log?.(`mux: the '${kind}' handler failed: ${message(e)}`)
            abort(st, message(e))
          }
        },
        e => refuse(message(e)),
      )
  }

  function onOpenResult(id: number, payload: Buffer) {
    const waiter = opening.get(id)
    const st = streams.get(id)
    if (!waiter || !st) return
    opening.delete(id)
    const result = parseObject(payload)
    if (result?.ok === true) return waiter.resolve(st.duplex)
    streams.delete(id)
    st.duplex.destroy()
    waiter.reject(new Error(typeof result?.error === 'string' ? result.error : 'refused'))
  }

  function onData(id: number, payload: Buffer) {
    const st = streams.get(id)
    if (!st || st.gotClose || st.duplex.destroyed) return
    st.received += payload.length
    if (st.received > st.allowed) return fail(`stream ${id} overran its window`)
    st.duplex.push(payload)
    // A flowing reader may have taken it already.
    grant(st)
  }

  function onWindow(id: number, payload: Buffer) {
    if (payload.length !== 4) return fail('bad window frame')
    const st = streams.get(id)
    if (!st) return
    st.credit += payload.readUInt32BE(0)
    pump(st)
  }

  function onClose(id: number, payload: Buffer) {
    const st = streams.get(id)
    if (!st) return
    if (payload.length === 0) {
      st.gotClose = true
      st.duplex.push(null)
      settle(st)
      return
    }
    // Aborted by the far end: no reply, and no 'error' event.
    log?.(`mux: stream ${id} aborted by the peer: ${payload.toString('utf8')}`)
    streams.delete(id)
    opening.get(id)?.reject(new Error(payload.toString('utf8')))
    opening.delete(id)
    st.duplex.destroy()
  }

  // ---- control

  function sendPing() {
    pingN++
    pings.set(pingN, performance.now())
    // Pongs that never came: keep the table small.
    for (const n of pings.keys()) if (n < pingN - 4) pings.delete(n)
    frame(CONTROL, 0, json({ t: 'ping', n: pingN, at: Date.now() }))
  }

  function onControlFrame(id: number, payload: Buffer) {
    const msg = parseObject(payload)
    if (id !== 0 || !msg || typeof msg.t !== 'string') return fail('bad control message')
    if (msg.t === 'ping') {
      frame(CONTROL, 0, json({ t: 'pong', n: msg.n, at: msg.at }))
    } else if (msg.t === 'pong') {
      const sentAt = typeof msg.n === 'number' ? pings.get(msg.n) : undefined
      if (sentAt !== undefined) {
        pings.delete(msg.n as number)
        rttMs = Math.round((performance.now() - sentAt) * 10) / 10
      }
    } else if (msg.t === 'bye') {
      shut(`peer: ${typeof msg.reason === 'string' ? msg.reason : 'bye'}`, 'end')
    } else {
      try {
        onControl?.(msg as Control)
      } catch (e) {
        log?.(`mux: onControl('${msg.t}') failed: ${message(e)}`)
      }
    }
  }

  // ---- reading

  function fail(why: string) {
    log?.(`mux: protocol error: ${why}`)
    shut(`protocol error: ${why}`, 'destroy')
  }

  function onFrame(type: number, id: number, payload: Buffer) {
    if (type === CONTROL) onControlFrame(id, payload)
    else if (type === OPEN) onOpenFrame(id, payload)
    else if (type === DATA) onData(id, payload)
    else if (type === CLOSE) onClose(id, payload)
    else if (type === OPEN_RESULT) onOpenResult(id, payload)
    else if (type === WINDOW_UPDATE) onWindow(id, payload)
    else fail(`unknown frame type ${type}`)
  }

  tls.on('data', (chunk: Buffer) => {
    if (closedReason !== null) return
    lastSeen = Date.now()
    deadTimer.refresh()
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (closedReason === null && pending.length >= HEADER) {
      const length = pending.readUInt32BE(5)
      if (length > MAX_PAYLOAD) return fail(`a frame of ${length} bytes`)
      if (pending.length < HEADER + length) break
      const type = pending[0]
      const id = pending.readUInt32BE(1)
      const payload = pending.subarray(HEADER, HEADER + length)
      pending = pending.subarray(HEADER + length)
      onFrame(type, id, payload)
    }
  })

  // ---- liveness and closing

  const pingTimer = setInterval(sendPing, pingMs)
  pingTimer.unref()
  const deadTimer = setTimeout(() => shut(`timeout: nothing heard for ${deadMs / 1000} s`, 'destroy'), deadMs)
  deadTimer.unref()

  tls.on('error', e => {
    socketError = e.message
  })
  tls.on('end', () => shut('the connection closed', 'end'))
  tls.on('close', () => shut(socketError ?? 'the connection closed', 'destroy'))

  function shut(reason: string, how: 'bye' | 'end' | 'destroy') {
    if (closedReason !== null) return
    if (how === 'bye') frame(CONTROL, 0, json({ t: 'bye', reason }))
    closedReason = reason
    clearInterval(pingTimer)
    clearTimeout(deadTimer)
    if (how === 'destroy') {
      tls.destroy()
    } else {
      // A clean TLS close that never waits forever for the far end's.
      tls.end()
      setTimeout(() => tls.destroy(), 2000).unref()
    }
    const err = new Error(`link closed: ${reason}`)
    for (const waiter of opening.values()) waiter.reject(err)
    opening.clear()
    const open = [...streams.values()]
    streams.clear()
    waitingDrain.clear()
    for (const st of open) st.duplex.destroy()
    for (const listener of closeListeners.splice(0)) {
      try {
        listener(reason)
      } catch (e) {
        log?.(`mux: a close listener failed: ${message(e)}`)
      }
    }
  }

  if (tls.destroyed) shut('the connection closed', 'destroy')
  // An early first ping gives an RTT right after connecting.
  else sendPing()

  return {
    send,
    open,
    rtt: () => rttMs,
    lastSeen: () => lastSeen,
    streams: () => streams.size,
    closed: () => closedReason,
    close: reason => shut(reason, 'bye'),
    on(_event, listener) {
      if (closedReason === null) closeListeners.push(listener)
      else queueMicrotask(() => listener(closedReason as string))
    },
  }
}
