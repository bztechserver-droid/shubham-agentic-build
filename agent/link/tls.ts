import { createHash } from 'node:crypto'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import tls, { type TLSSocket } from 'node:tls'
import { deviceId, spkiSha256, type Identity } from './identity.ts'

// Pinned mutual TLS 1.3 over any socket: a direct TCP connection or a pipe through hbbr. The
// certificates are self-signed, so chain checks are off and trust is the peer's key alone:
// after the handshake the caller's verifyPeer sees the peer's ID and SPKI hash and decides.
// TLS's CertificateVerify has already proved the peer holds that key.

type Log = (msg: string) => void

/** True to accept the peer. Pinning compares spkiSha256; pairing accepts anyone. */
export type VerifyPeer = (id: string, spkiSha256: Buffer) => boolean | Promise<boolean>

export interface PeerTls {
  tls: TLSSocket
  peerId: string
  peerSpki: Buffer
}

export type TlsIdentity = Pick<Identity, 'keyPem' | 'certPem'>

const SAS_LABEL = 'EXPORTER-sad-pairing-sas'

// Which end of the handshake each socket was, so the mux can pick odd or even stream IDs.
const sides = new WeakMap<TLSSocket, 'client' | 'server'>()

export const tlsSide = (sock: TLSSocket) => sides.get(sock)

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The member's end (the one that dialled): TLS client, presenting its own certificate. */
export function tlsClient(
  socket: Duplex,
  identity: TlsIdentity,
  verifyPeer: VerifyPeer,
  timeoutMs: number,
  log?: Log,
): Promise<PeerTls> {
  const sock = tls.connect({
    socket,
    key: identity.keyPem,
    cert: identity.certPem,
    minVersion: 'TLSv1.3',
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  })
  sides.set(sock, 'client')
  return handshake(socket, sock, 'secureConnect', verifyPeer, timeoutMs, log)
}

/** The hub's end (the one that was dialled): TLS server, requiring a client certificate. */
export function tlsServer(
  socket: Duplex,
  identity: TlsIdentity,
  verifyPeer: VerifyPeer,
  timeoutMs: number,
  log?: Log,
): Promise<PeerTls> {
  const sock = new tls.TLSSocket(socket, {
    isServer: true,
    key: identity.keyPem,
    cert: identity.certPem,
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
  })
  sides.set(sock, 'server')
  return handshake(socket, sock, 'secure', verifyPeer, timeoutMs, log)
}

function handshake(
  raw: Duplex,
  sock: TLSSocket,
  event: 'secure' | 'secureConnect',
  verifyPeer: VerifyPeer,
  timeoutMs: number,
  log?: Log,
): Promise<PeerTls> {
  // Small frames (pings, keystrokes) should not wait for Nagle.
  if (raw instanceof net.Socket) raw.setNoDelay(true)
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      raw.destroy()
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error(`TLS handshake timed out after ${timeoutMs} ms`)), timeoutMs)
    // These stay after the handshake: an 'error' with no listener would crash the agent.
    const onError = (e: Error) => (settled ? log?.(`tls: ${e.message}`) : fail(e))
    sock.on('error', onError)
    raw.on('error', onError)
    sock.once('close', () => fail(new Error('the connection closed during the TLS handshake')))
    sock.once(event, async () => {
      try {
        const cert = sock.getPeerX509Certificate()
        if (!cert) throw new Error('the peer sent no certificate')
        if (cert.publicKey.asymmetricKeyType !== 'ed25519') throw new Error('the peer certificate is not Ed25519')
        const peerSpki = spkiSha256(cert.publicKey)
        const peerId = deviceId(peerSpki)
        if (!(await verifyPeer(peerId, peerSpki))) throw new Error(`device ${peerId} is not the one expected`)
        if (settled) return // timed out or closed while verifyPeer ran
        settled = true
        clearTimeout(timer)
        resolve({ tls: sock, peerId, peerSpki })
      } catch (e) {
        fail(e instanceof Error ? e : new Error(message(e)))
      }
    })
  })
}

/** The pairing nonces: 32 random bytes from each end. */
export const NONCE_BYTES = 32

/**
 * The 6-digit check number both screens show while pairing: uint32(sha256(exporter ‖ nm ‖ nh))
 * mod 10^6, where the exporter value is this TLS session's own, nm the member's nonce and nh
 * the hub's. A machine in the middle runs two sessions, so the numbers differ. The exporter
 * alone is not enough: whoever plays the TLS server picks its last inputs after seeing the
 * client's, so it could grind its ServerHello until the numbers matched. The nonces close
 * that: the member commits to nm (sha256) before it sees nh, and reveals it after, so neither
 * end, nor anyone between them, can steer the number (pairing.ts).
 */
export function sas(sock: TLSSocket, memberNonce: Buffer, hubNonce: Buffer): string {
  if (memberNonce.length !== NONCE_BYTES || hubNonce.length !== NONCE_BYTES) throw new Error(`sas: nonces are ${NONCE_BYTES} bytes`)
  // TLS 1.3 treats an absent exporter context as an empty one.
  const exporter = sock.exportKeyingMaterial(32, SAS_LABEL, Buffer.alloc(0))
  const digest = createHash('sha256').update(exporter).update(memberNonce).update(hubNonce).digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

export interface ListenOptions {
  /** Cap per connection, from TCP accept to a verified peer. Default 10 s. */
  timeoutMs?: number
  /** Handshakes in flight before new connections are dropped. Default 32. */
  maxPending?: number
  /** Handshakes in flight from one IP address, so one PC can't take every slot. Default 8. */
  maxPendingPerIp?: number
  log?: Log
}

/**
 * The hub's listener. Any well-formed Ed25519 client certificate completes the handshake;
 * `onSocket` gets the TLS socket with the peer's identity and decides there: a paired device,
 * or a pairing request. Resolves once listening.
 */
export function listenTls(
  host: string,
  port: number,
  identity: TlsIdentity,
  onSocket: (peer: PeerTls) => void,
  opts: ListenOptions = {},
): Promise<net.Server> {
  const { timeoutMs = 10_000, maxPending = 32, maxPendingPerIp = 8, log } = opts
  let pending = 0
  const perIp = new Map<string, number>()
  const server = net.createServer(socket => {
    const ip = socket.remoteAddress ?? ''
    const from = `${ip}:${socket.remotePort}`
    const fromIp = perIp.get(ip) ?? 0
    if (pending >= maxPending || fromIp >= maxPendingPerIp) {
      log?.(`tls: dropped ${from}: ${fromIp >= maxPendingPerIp ? `${fromIp} handshakes from ${ip}` : `${pending} handshakes`} already in progress`)
      socket.destroy()
      return
    }
    pending++
    perIp.set(ip, fromIp + 1)
    tlsServer(socket, identity, () => true, timeoutMs, log)
      .then(
        peer => {
          try {
            onSocket(peer)
          } catch (e) {
            log?.(`tls: handling ${peer.peerId} from ${from} failed: ${message(e)}`)
            peer.tls.destroy()
          }
        },
        e => log?.(`tls: refused ${from}: ${message(e)}`),
      )
      .finally(() => {
        pending--
        const left = (perIp.get(ip) ?? 1) - 1
        if (left > 0) perIp.set(ip, left)
        else perIp.delete(ip)
      })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      server.on('error', e => log?.(`tls: listener ${host}:${port}: ${e.message}`))
      resolve(server)
    })
  })
}
