import dgram from 'node:dgram'
import type { DiscoveredHub } from '../shared/agent-api.ts'
import type { Logger } from './log.ts'
import { inCidr, parseHostPort, type Subnet } from './net.ts'

// LAN discovery (agent/SPEC.md › LAN discovery): a member asks {"t":"sad-who"} on the directed
// broadcast of each local subnet (while not paired, for the Join dialog; once paired, when it
// has lost its hub); the hub answers by unicast {"t":"sad-hub", id, name, peer}. Answers are
// not authenticated, so they are only hints: trust comes from pairing and the pin. Every
// address answering for an ID is kept, so a second PC claiming a hub's ID shows as a conflict
// instead of quietly replacing the real one.

const ID = /^[a-z2-7]{16}$/
const MAX_DATAGRAM = 512

export interface HubAnswer {
  id: string
  name: string
  /** The hub's TLS listener, 'ip:port'. */
  peer: string
}

function parse(buf: Buffer): Record<string, unknown> | null {
  if (buf.length > MAX_DATAGRAM) return null
  try {
    const v: unknown = JSON.parse(buf.toString('utf8'))
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export interface DiscoveryAnswerOptions {
  port: number
  /** What to answer with; null to stay quiet (no LAN address yet). */
  answer: () => HubAnswer | null
  subnets: () => Subnet[]
  log?: Logger
}

/** The hub's side: UDP on 0.0.0.0:<port>, answering queries from its own subnets. */
export function startDiscoveryAnswer(o: DiscoveryAnswerOptions): Promise<{ close(): Promise<void> }> {
  const socket = dgram.createSocket('udp4')
  socket.on('message', (buf, from) => {
    if (parse(buf)?.t !== 'sad-who') return
    // A query from outside our LANs learns nothing.
    if (!o.subnets().some(s => inCidr(from.address, s.cidr))) return
    const answer = o.answer()
    if (!answer) return
    socket.send(JSON.stringify({ t: 'sad-hub', ...answer }), from.port, from.address, err => {
      if (err) o.log?.debug(`answering ${from.address}:${from.port} failed: ${err.message}`)
    })
  })
  return new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(o.port, '0.0.0.0', () => {
      socket.off('error', reject)
      socket.on('error', e => o.log?.warn(`${e.message}`))
      o.log?.info(`answering on UDP ${o.port}`)
      resolve({ close: () => new Promise<void>(r => socket.close(() => r())) })
    })
  })
}

export interface DiscoveryClientOptions {
  port: number
  subnets: () => Subnet[]
  /** The list changed: a hub appeared, moved or went quiet. */
  onChange: () => void
  /** Query period; default 5 s. */
  everyMs?: number
  /** A hub not heard for this long drops off the list; default 3 periods. */
  staleMs?: number
  log?: Logger
}

export interface DiscoveryClient {
  /** Starts asking (idempotent). */
  start(): void
  /** Stops asking and forgets what it heard. */
  stop(): void
  /** One row per hub ID; `conflict` when more than one address answers for it. */
  list(): DiscoveredHub[]
  /** Every address answering for this ID right now, first heard first. */
  addresses(id: string): string[]
}

interface Heard {
  name: string
  seenAt: string
  at: number
}

/** A member's side: asks while started, from its own ephemeral UDP socket. */
export function createDiscoveryClient(o: DiscoveryClientOptions): DiscoveryClient {
  const everyMs = o.everyMs ?? 5000
  const staleMs = o.staleMs ?? everyMs * 3
  // By hub ID, then by the address that answered.
  const heard = new Map<string, Map<string, Heard>>()
  let socket: dgram.Socket | null = null
  let timer: NodeJS.Timeout | null = null

  function ask() {
    const s = socket
    if (!s) return
    // Forget answers that went quiet.
    const now = Date.now()
    let dropped = false
    for (const [id, byAddress] of heard) {
      for (const [address, h] of byAddress) {
        if (now - h.at > staleMs) {
          byAddress.delete(address)
          dropped = true
        }
      }
      if (!byAddress.size) heard.delete(id)
    }
    if (dropped) o.onChange()
    const query = Buffer.from(JSON.stringify({ t: 'sad-who' }))
    for (const subnet of o.subnets()) {
      s.send(query, o.port, subnet.broadcast, err => {
        if (err) o.log?.debug(`asking ${subnet.broadcast}: ${err.message}`)
      })
    }
  }

  function onMessage(buf: Buffer, from: dgram.RemoteInfo) {
    const msg = parse(buf)
    if (msg?.t !== 'sad-hub' || typeof msg.id !== 'string' || !ID.test(msg.id) || typeof msg.peer !== 'string') return
    const peer = parseHostPort(msg.peer)
    if (!peer) return
    // The address it answered from is the one this PC can reach.
    const address = `${from.address}:${peer.port}`
    const name = typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim().slice(0, 64) : msg.id
    let byAddress = heard.get(msg.id)
    if (!byAddress) heard.set(msg.id, (byAddress = new Map()))
    const before = byAddress.get(address)
    byAddress.set(address, { name, seenAt: new Date().toISOString(), at: Date.now() })
    if (!before || before.name !== name) {
      if (byAddress.size > 1) {
        o.log?.warn(`hub ${msg.id} answers from ${[...byAddress.keys()].join(' and ')}: someone may be pretending to be it`)
      } else {
        o.log?.info(`hub ${name} (${msg.id}) at ${address}`)
      }
    }
    o.onChange()
  }

  // A socket error closes the socket; the next round opens a new one.
  function open() {
    const s = dgram.createSocket('udp4')
    socket = s
    s.on('message', onMessage)
    s.on('error', e => {
      o.log?.warn(`${e.message}`)
      if (socket === s) socket = null
      try {
        s.close()
      } catch {
        // already closed
      }
    })
    s.bind(0, '0.0.0.0', () => {
      s.setBroadcast(true)
      ask()
    })
  }

  return {
    start() {
      if (timer) return
      open()
      timer = setInterval(() => (socket ? ask() : open()), everyMs)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      const s = socket
      socket = null
      s?.close()
      if (heard.size) {
        heard.clear()
        o.onChange()
      }
    },
    list: () =>
      [...heard].map(([id, byAddress]) => {
        // The first address heard keeps the row; a later one makes it a conflict, never a swap.
        const [[address, first]] = byAddress
        const seenAt = [...byAddress.values()].map(h => h.seenAt).sort().at(-1) ?? first.seenAt
        return { id, name: first.name, address, seenAt, conflict: byAddress.size > 1 }
      }),
    addresses: id => [...(heard.get(id)?.keys() ?? [])],
  }
}
