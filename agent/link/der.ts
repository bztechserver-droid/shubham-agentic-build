import { createPublicKey, sign, type KeyObject } from 'node:crypto'

// A minimal DER writer: only what a self-signed Ed25519 X.509 v3 certificate needs. Node can
// parse and verify certificates (crypto.X509Certificate) but cannot make one, and the spec
// allows no certificate library.

const ED25519 = '1.3.101.112'
const COMMON_NAME = '2.5.4.3'
const BASIC_CONSTRAINTS = '2.5.29.19'
const KEY_USAGE = '2.5.29.15'
const EXT_KEY_USAGE = '2.5.29.37'
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1'
const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2'

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

/** One tag-length-value. */
export function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(body.length), body])
}

export const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items))

/** SET OF: DER wants the members sorted by their encoding. */
export const setOf = (...items: Buffer[]) => tlv(0x31, Buffer.concat([...items].sort(Buffer.compare)))

/** [n] EXPLICIT: a constructed, context-specific wrapper. */
export const explicit = (n: number, body: Buffer) => tlv(0xa0 | n, body)

export const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]))
export const octetString = (bytes: Buffer) => tlv(0x04, bytes)
export const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'))

export function bitString(bytes: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]))
}

/** A non-negative INTEGER, from a number or big-endian bytes, in the shortest form DER allows. */
export function int(value: number | Buffer): Buffer {
  let b: Buffer
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`der: ${value} is not a non-negative integer`)
    const bytes: number[] = []
    for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256)
    b = Buffer.from(bytes)
  } else {
    b = value
  }
  let i = 0
  while (i < b.length && b[i] === 0) i++
  b = b.subarray(i)
  // A set top bit would read as negative: a leading zero keeps it positive.
  if (b.length === 0 || b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b])
  return tlv(0x02, b)
}

export function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number)
  if (
    arcs.length < 2 ||
    arcs.some(a => !Number.isSafeInteger(a) || a < 0) ||
    arcs[0] > 2 ||
    (arcs[0] < 2 && arcs[1] >= 40)
  ) {
    throw new Error(`der: bad OID ${dotted}`)
  }
  const out: number[] = []
  for (const arc of [arcs[0] * 40 + arcs[1], ...arcs.slice(2)]) {
    // Base 128, high bit set on every byte but the last.
    const chunk = [arc % 128]
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v % 128) | 0x80)
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}

/** RFC 5280: UTCTime through 2049, GeneralizedTime from 2050. Whole seconds, UTC. */
export function time(d: Date): Buffer {
  const year = d.getUTCFullYear()
  if (Number.isNaN(year) || year < 1950 || year > 9999) throw new Error(`der: ${String(d)} is out of range`)
  const digits = d.toISOString().slice(0, 19).replace(/[-:T]/g, '') // YYYYMMDDHHMMSS
  return year < 2050 ? tlv(0x17, Buffer.from(digits.slice(2) + 'Z')) : tlv(0x18, Buffer.from(digits + 'Z'))
}

export function pem(der: Buffer, label: string): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

const extension = (id: string, critical: boolean, value: Buffer) =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octetString(value))

export interface CertOptions {
  /** The Ed25519 private key; the certificate carries its public half and is signed by it. */
  key: KeyObject
  /** Issuer and subject both: CN=<cn>. */
  cn: string
  /** Positive and non-zero, at most 20 bytes. */
  serial: Buffer
  notBefore: Date
  notAfter: Date
}

/** A self-signed Ed25519 X.509 v3 certificate, as DER. */
export function selfSignedEd25519(o: CertOptions): Buffer {
  if (o.key.type !== 'private' || o.key.asymmetricKeyType !== 'ed25519') {
    throw new Error('der: the certificate key must be an Ed25519 private key')
  }
  if (o.serial.length > 20 || !o.serial.some(b => b !== 0)) throw new Error('der: the serial must be 1-20 bytes, not zero')
  const spki = createPublicKey(o.key).export({ type: 'spki', format: 'der' })
  // Ed25519's AlgorithmIdentifier has no parameters (RFC 8410).
  const algorithm = seq(oid(ED25519))
  const name = seq(setOf(seq(oid(COMMON_NAME), utf8(o.cn))))
  const tbs = seq(
    explicit(0, int(2)), // v3
    int(o.serial),
    algorithm,
    name,
    seq(time(o.notBefore), time(o.notAfter)),
    name,
    spki,
    explicit(
      3,
      seq(
        extension(BASIC_CONSTRAINTS, true, seq()), // cA defaults to FALSE: an end entity
        extension(KEY_USAGE, true, bitString(Buffer.from([0x80]), 7)), // digitalSignature only
        extension(EXT_KEY_USAGE, false, seq(oid(SERVER_AUTH), oid(CLIENT_AUTH))), // either end of a link
      ),
    ),
  )
  return seq(tbs, algorithm, bitString(sign(null, tbs, o.key)))
}
