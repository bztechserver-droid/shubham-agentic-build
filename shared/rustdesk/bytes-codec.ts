// RustDesk's BytesCodec framing over Uint8Array, for the in-app viewer (F-005): the same rules
// as agent/rendezvous/codec.ts (hbb_common bytes_codec.rs:46-144), with no Node Buffer, so it
// runs in the browser and under node:test alike.

/** The largest payload a 4-byte header can announce. */
export const MAX_FRAME = 0x3fffffff

/**
 * BytesCodec::encode: a 1 to 4 byte little-endian header holding
 * (length << 2) | (header bytes - 1), then the payload.
 */
export function frame(payload: Uint8Array): Uint8Array {
  const n = payload.length
  if (n > MAX_FRAME) throw new RangeError(`A frame holds at most ${MAX_FRAME} bytes, not ${n}`)
  const hl = n <= 0x3f ? 1 : n <= 0x3fff ? 2 : n <= 0x3fffff ? 3 : 4
  const out = new Uint8Array(hl + n)
  let head = n * 4 + (hl - 1)
  for (let i = 0; i < hl; i++, head = Math.floor(head / 256)) out[i] = head & 0xff
  out.set(payload, hl)
  return out
}

/**
 * BytesCodec::decode: push() takes bytes as they arrive (a WebSocket message holds any slice
 * of the TCP stream) and returns the payload of every whole frame, in order.
 */
export class Deframer {
  /** A header announcing more than this throws, as BytesCodec's max_packet_length does. */
  readonly maxLength: number
  private parts: Uint8Array[] = []
  private size = 0

  constructor(maxLength = MAX_FRAME) {
    this.maxLength = maxLength
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length) {
      this.parts.push(chunk)
      this.size += chunk.length
    }
    const out: Uint8Array[] = []
    while (this.size > 0) {
      const head = this.peek(Math.min(4, this.size))
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

  /** Bytes held for a frame that hasn't fully arrived. */
  get pending() {
    return this.size
  }

  // The first n buffered bytes as one array. Parts are merged only once a whole frame is
  // here, so a big keyframe arriving in small chunks is copied once, not once per chunk.
  private peek(n: number): Uint8Array {
    if (this.parts[0].length < n) {
      let k = 0
      for (let len = 0; len < n; k++) len += this.parts[k].length
      const merged = new Uint8Array(this.parts.slice(0, k).reduce((s, p) => s + p.length, 0))
      let at = 0
      for (const p of this.parts.slice(0, k)) {
        merged.set(p, at)
        at += p.length
      }
      this.parts.splice(0, k, merged)
    }
    return this.parts[0].subarray(0, n)
  }

  private take(n: number): Uint8Array {
    if (n === 0) return new Uint8Array(0)
    const b = this.peek(n)
    this.parts[0] = this.parts[0].subarray(n)
    if (!this.parts[0].length) this.parts.shift()
    this.size -= n
    return b
  }
}
