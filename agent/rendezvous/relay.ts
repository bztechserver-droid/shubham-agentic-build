import net from 'node:net'
import { frame, parseHostPort } from './codec.ts'
import { connectTcp } from './hbbs.ts'
import { encode } from './messages.ts'

// Joining hbbr 1.1.16 (rustdesk-server src/relay_server.rs, cited by line). hbbr reads one
// framed RequestRelay within 30 s (make_pair_ 425-462), drops the connection without a word
// when its licence_key is wrong (430-433), parks the first stream of a uuid for 30 s (453-456)
// and, when the second comes, switches both to raw and pipes bytes between them (440-445).
// So after RequestRelay the socket is a raw pipe, and nothing on it says the other side came.
// That is what the marker is for: the controlled side writes SAD1 straight after RequestRelay
// (hbbr holds it until the pair is made) and the controller waits for exactly those 4 bytes
// before it starts TLS.
// Loopback callers get hbbr's admin console instead of a relay (366-380): use the LAN address.

/** Written by the controlled side; the controller starts TLS only after seeing it. */
export const RELAY_MARKER = Buffer.from('SAD1')
/** How long hbbr parks a lone stream, and our cap on joining. */
export const RELAY_TIMEOUT_MS = 30_000

export interface JoinOptions {
  uuid: string
  licenceKey: string
  /** Our own ID; hbbr doesn't use it. */
  id?: string
  /**
   * 'controlled' writes the marker, 'controller' waits for it. Leave it out to do the marker
   * step yourself with writeMarker / awaitMarker.
   */
  role?: 'controller' | 'controlled'
  /** Capped at 30 s. */
  timeoutMs?: number
  localAddress?: string
  log?: (msg: string) => void
}

/**
 * Connects to hbbr ('ip:port') and writes the framed RequestRelay{id, uuid, licence_key,
 * conn_type: DEFAULT_CONN}. Resolves with the raw socket: for the controller once the marker
 * has come (hbbr paired us; the socket comes back paused, see awaitMarker), for the controlled
 * side once the marker is out. The socket then belongs to the caller, error handling included.
 */
export async function joinRelay(hbbr: string, opts: JoinOptions): Promise<net.Socket> {
  const timeoutMs = Math.min(opts.timeoutMs ?? RELAY_TIMEOUT_MS, RELAY_TIMEOUT_MS)
  const deadline = Date.now() + timeoutMs
  if (isLoopback(parseHostPort(hbbr).host)) {
    opts.log?.(`hbbr ${hbbr}: a loopback caller gets hbbr's console, not a relay; use the LAN address`)
  }
  const request = frame(
    encode({
      request_relay: { id: opts.id ?? '', uuid: opts.uuid, licence_key: opts.licenceKey, conn_type: 'DEFAULT_CONN' },
    }),
  )
  const socket = await connectTcp(hbbr, timeoutMs, opts.localAddress)
  const ignore = () => {} // a write error also reaches its callback, which rejects below
  socket.on('error', ignore)
  try {
    await write(socket, request)
    if (opts.role === 'controlled') await writeMarker(socket)
  } catch (e) {
    socket.destroy()
    throw e
  } finally {
    socket.off('error', ignore)
  }
  if (opts.role === 'controller') return awaitMarker(socket, Math.max(0, deadline - Date.now()))
  return socket
}

/** The controlled side's half: SAD1, flushed to the OS before TLS takes the socket. */
export function writeMarker(socket: net.Socket): Promise<void> {
  return write(socket, RELAY_MARKER)
}

/**
 * The controller's half: waits for exactly SAD1, then hands the socket back paused, with any
 * bytes after the marker put back for the next reader. TLS takes it as it is; a plain reader
 * must call resume(), since a paused stream stays paused when a 'data' listener is added.
 * Anything else, a close or the timeout destroys the socket and rejects.
 */
export function awaitMarker(socket: net.Socket, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let got = Buffer.alloc(0)
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', fail)
      socket.off('close', onClose)
    }
    const fail = (e: Error) => {
      cleanup()
      socket.destroy()
      reject(e)
    }
    const onClose = () =>
      fail(new Error('hbbr closed the relay before the other side joined (wrong key, or nobody came within 30 s)'))
    const onData = (chunk: Buffer) => {
      got = Buffer.concat([got, chunk])
      const n = Math.min(got.length, RELAY_MARKER.length)
      if (!got.subarray(0, n).equals(RELAY_MARKER.subarray(0, n))) {
        return fail(new Error('The relay sent something other than the SAD1 marker'))
      }
      if (got.length < RELAY_MARKER.length) return
      cleanup()
      socket.pause()
      if (got.length > RELAY_MARKER.length) socket.unshift(got.subarray(RELAY_MARKER.length))
      resolve(socket)
    }
    const timer = setTimeout(() => fail(new Error(`hbbr did not pair the relay within ${timeoutMs} ms`)), timeoutMs)
    socket.on('data', onData)
    socket.on('error', fail)
    socket.on('close', onClose)
  })
}

function write(socket: net.Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, err => (err ? reject(err) : resolve()))
  })
}

function isLoopback(host: string) {
  return host === 'localhost' || host === '::1' || /^(::ffff:)?127\./.test(host)
}
