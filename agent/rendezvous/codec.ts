import net from 'node:net'

// RustDesk's wire helpers, ported from hbb_common 83419b6 (the version rustdesk-server 1.1.16
// pins) by way of design/features/F-004-probes/round2/wire.mjs:
//   - BytesCodec framing, on every TCP connection to hbbs and hbbr (bytes_codec.rs);
//   - AddrMangle, the scrambled socket address inside punch and relay messages (lib.rs:126-199).
// UDP datagrams to hbbs carry a bare RendezvousMessage and need neither.

/**
 * BytesCodec::encode (bytes_codec.rs:123-144): a 1 to 4 byte little-endian header holding
 * (length << 2) | (header bytes - 1), then the payload.
 */
export function frame(payload: Uint8Array): Buffer {
  const n = payload.length
  let head: Buffer
  if (n <= 0x3f) head = Buffer.from([n << 2])
  else if (n <= 0x3fff) {
    head = Buffer.alloc(2)
    head.writeUInt16LE((n << 2) | 1)
  } else if (n <= 0x3fffff) {
    head = Buffer.alloc(3)
    head.writeUIntLE((n << 2) | 2, 0, 3)
  } else if (n <= 0x3fffffff) {
    head = Buffer.alloc(4)
    head.writeUInt32LE(n * 4 + 3)
  } else throw new RangeError(`A frame holds at most 0x3fffffff bytes, not ${n}`)
  return Buffer.concat([head, payload])
}

/**
 * BytesCodec::decode (bytes_codec.rs:46-117): push() takes bytes as they arrive and returns the
 * payload of every whole frame. Once `raw` is set (hbbr's set_raw after pairing), everything
 * buffered and everything after goes through as it comes.
 */
export class Deframer {
  raw = false
  /** A header announcing more than this throws, as BytesCodec's max_packet_length does. */
  maxLength: number
  private parts: Buffer[] = []
  private size = 0

  constructor(maxLength = Infinity) {
    this.maxLength = maxLength
  }

  push(chunk: Uint8Array): Buffer[] {
    if (chunk.length) {
      this.parts.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      this.size += chunk.length
    }
    const out: Buffer[] = []
    while (this.size > 0) {
      if (this.raw) {
        out.push(this.take(this.size))
        break
      }
      const head = this.peek(4)
      const hl = (head[0] & 3) + 1
      if (this.size < hl) break
      let n = 0
      for (let i = 0; i < hl; i++) n += head[i] * 2 ** (8 * i)
      n = Math.floor(n / 4)
      if (n > this.maxLength) throw new RangeError(`A ${n}-byte frame is over the ${this.maxLength}-byte limit`)
      if (this.size < hl + n) break
      this.take(hl)
      out.push(this.take(n))
    }
    return out
  }

  // The first n buffered bytes as one Buffer. Parts are merged only once a whole frame is
  // here, so a big frame arriving in small chunks is copied once, not once per chunk.
  private peek(n: number): Buffer {
    n = Math.min(n, this.size)
    if (this.parts[0].length < n) {
      let k = 0
      for (let len = 0; len < n; k++) len += this.parts[k].length
      this.parts.splice(0, k, Buffer.concat(this.parts.slice(0, k)))
    }
    return this.parts[0].subarray(0, n)
  }

  private take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0)
    const b = this.peek(n)
    this.parts[0] = this.parts[0].subarray(n)
    if (!this.parts[0].length) this.parts.shift()
    this.size -= n
    return b
  }
}

/**
 * AddrMangle::encode (lib.rs:143-165). IPv4 becomes at most 16 bytes, scrambled with the clock
 * so routers don't rewrite addresses they recognise; IPv6 is 16 bytes plus the port, little
 * endian. A v4-mapped or v4-compatible IPv6 address counts as IPv4, as try_into_v4 makes it
 * (lib.rs:113-124).
 */
export function mangle(ip: string, port: number, nowMicros = BigInt(Date.now()) * 1000n): Buffer {
  if (!Number.isInteger(port) || port < 0 || port > 0xffff) throw new RangeError(`Not a port: ${port}`)
  let v4: number[]
  if (net.isIPv4(ip)) v4 = ip.split('.').map(Number)
  else {
    const v6 = ipv6Bytes(ip)
    const mapped = asV4(v6)
    if (!mapped) return Buffer.concat([v6, Buffer.from([port & 0xff, port >> 8])])
    v4 = mapped
  }
  const tm = BigInt.asUintN(32, nowMicros) // `as_micros() as u32`
  const ipn = BigInt((v4[0] | (v4[1] << 8) | (v4[2] << 16) | (v4[3] << 24)) >>> 0) // u32::from_le_bytes(octets)
  let v = BigInt.asUintN(128, ((ipn + tm) << 49n) | (tm << 17n) | (BigInt(port) + (tm & 0xffffn)))
  const bytes: number[] = []
  for (let i = 0; i < 16; i++, v >>= 8n) bytes.push(Number(v & 0xffn))
  while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop()
  return Buffer.from(bytes)
}

/**
 * AddrMangle::decode (lib.rs:167-199): at most 16 bytes is IPv4, 18 is IPv6 plus the port.
 * Rust answers any other length with 0.0.0.0:0; this throws instead, so a bad address is seen.
 */
export function unmangle(b: Uint8Array): { ip: string; port: number } {
  if (b.length > 16) {
    if (b.length !== 18) throw new RangeError(`A mangled address is up to 16 or exactly 18 bytes, not ${b.length}`)
    const words = Array.from({ length: 8 }, (_, i) => ((b[2 * i] << 8) | b[2 * i + 1]).toString(16))
    // URL's serializer writes the RFC 5952 short form (lowercase, longest zero run as ::).
    return { ip: new URL(`http://[${words.join(':')}]`).hostname.slice(1, -1), port: b[16] | (b[17] << 8) }
  }
  let num = 0n
  for (let i = b.length - 1; i >= 0; i--) num = (num << 8n) | BigInt(b[i])
  const tm = (num >> 17n) & 0xffffffffn
  const ipn = Number(BigInt.asUintN(32, (num >> 49n) - tm))
  const port = Number(BigInt.asUintN(16, (num & 0xffffffn) - (tm & 0xffffn)))
  return { ip: [ipn & 255, (ipn >>> 8) & 255, (ipn >>> 16) & 255, ipn >>> 24].join('.'), port }
}

function ipv6Bytes(ip: string): Buffer {
  const s = ip.split('%')[0] // a zone (fe80::1%12) is not part of the address
  if (!net.isIPv6(s)) throw new Error(`Not an IP address: ${ip}`)
  const words = (part: string) =>
    part
      ? part.split(':').flatMap(p => {
          if (!p.includes('.')) return [parseInt(p, 16)]
          const o = p.split('.').map(Number)
          return [(o[0] << 8) | o[1], (o[2] << 8) | o[3]]
        })
      : []
  const gap = s.indexOf('::')
  let all = words(s)
  if (gap >= 0) {
    const head = words(s.slice(0, gap))
    const tail = words(s.slice(gap + 2))
    all = [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail]
  }
  const b = Buffer.alloc(16)
  all.forEach((w, i) => b.writeUInt16BE(w, 2 * i))
  return b
}

// Rust's Ipv6Addr::to_ipv4 inside try_into_v4: ::ffff:a.b.c.d and ::a.b.c.d are IPv4, but the
// loopback ::1 stays IPv6.
function asV4(b: Buffer): number[] | null {
  const zeros = (from: number, to: number) => b.subarray(from, to).every(x => x === 0)
  const mapped = zeros(0, 10) && b[10] === 0xff && b[11] === 0xff
  const compatible = zeros(0, 12) && !(zeros(12, 15) && b[15] === 1)
  return mapped || compatible ? [...b.subarray(12)] : null
}

/** 'host:port' or '[v6]:port', as RustDesk writes servers (relay_server, -r). */
export function parseHostPort(s: string): { host: string; port: number } {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) ?? /^([^:]+):(\d+)$/.exec(s)
  const port = m ? Number(m[2]) : NaN
  if (!m || port < 1 || port > 0xffff) throw new Error(`Expected host:port, got "${s}"`)
  return { host: m[1], port }
}
