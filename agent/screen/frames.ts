// FFmpeg's encoded output, cut into frames (F-006). A container with a length on every frame,
// so each one is handed on the moment its last byte arrives: raw H.264 only shows where a frame
// ends when the next one starts, a whole frame later.
//
//   H.264: FLV. Each frame leaves as Annex B with the stream's SPS and PPS in front of every
//          keyframe, the form RustDesk's own hardware encoder sends and the viewer's WebCodecs
//          decoder takes without a `description` (design/features/F-005-protocol.md › 5).
//   VP9:   IVF, as libvpx writes it; each frame as is.

export interface EncodedFrame {
  data: Buffer
  key: boolean
  /** Milliseconds, the encoder's own clock. */
  pts: number
}

const START = Buffer.from([0, 0, 0, 1])
/** FLV's tag size field is 24 bits; IVF's frame size is capped here, far above any real frame. */
const MAX_FRAME = 16 * 1024 * 1024

/** Bytes in, frames out; the bytes may arrive in any slices. Throws on a stream it can't read. */
export interface FrameReader {
  push(chunk: Buffer): EncodedFrame[]
}

/** A growing buffer read from the front, compacted as it goes. */
function queue() {
  let buf: Buffer = Buffer.alloc(0)
  return {
    add(chunk: Buffer) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    },
    get length() {
      return buf.length
    },
    peek: () => buf,
    take(n: number) {
      const out = buf.subarray(0, n)
      buf = buf.subarray(n)
      return out
    },
  }
}

const nalType = (nal: Buffer) => nal[0] & 0x1f

/** AVCDecoderConfigurationRecord (ISO/IEC 14496-15 § 5.2.4.1): its NAL length size and SPS/PPS as Annex B. */
export function parseAvcConfig(rec: Buffer): { lengthSize: number; annexB: Buffer } {
  if (rec.length < 7 || rec[0] !== 1) throw new Error('not an AVC configuration record')
  const lengthSize = (rec[4] & 0x03) + 1
  const parts: Buffer[] = []
  let p = 6 // after numOfSequenceParameterSets, byte 5
  const sets = (count: number) => {
    for (let i = 0; i < count; i++) {
      if (p + 2 > rec.length) throw new Error('AVC configuration record cut short')
      const len = rec.readUInt16BE(p)
      p += 2
      if (p + len > rec.length) throw new Error('AVC configuration record cut short')
      parts.push(START, rec.subarray(p, p + len))
      p += len
    }
  }
  sets(rec[5] & 0x1f)
  if (p >= rec.length) throw new Error('AVC configuration record cut short')
  sets(rec[p++])
  return { lengthSize, annexB: Buffer.concat(parts) }
}

/** Length-prefixed NAL units (AVCC) as Annex B, and whether there was an IDR or an SPS among them. */
export function avccToAnnexB(data: Buffer, lengthSize: number): { annexB: Buffer; idr: boolean; sps: boolean } {
  const parts: Buffer[] = []
  let idr = false
  let sps = false
  let p = 0
  while (p < data.length) {
    if (p + lengthSize > data.length) throw new Error('H.264 NAL length cut short')
    const len = data.readUIntBE(p, lengthSize)
    p += lengthSize
    if (len === 0 || p + len > data.length) throw new Error('H.264 NAL unit cut short')
    const nal = data.subarray(p, p + len)
    p += len
    const type = nalType(nal)
    if (type === 5) idr = true
    if (type === 7) sps = true
    parts.push(START, nal)
  }
  return { annexB: Buffer.concat(parts), idr, sps }
}

/**
 * FLV (Adobe's spec, v10.1, annex E; and the "enhanced" form FFmpeg may write: video tag byte 0
 * bit 7 set, then a FourCC). Only H.264 video tags are read; script and audio tags are skipped.
 */
export function flvReader(): FrameReader {
  const q = queue()
  let header = false
  let lengthSize = 4
  let config: Buffer | null = null

  function video(d: Buffer, pts: number): EncodedFrame | null {
    if (d.length < 2) return null
    let packet: Buffer
    let key: boolean
    if (d[0] & 0x80) {
      // Enhanced: [1 IsExHeader | 3 FrameType | 4 PacketType] FourCC, then the body.
      const frameType = (d[0] >> 4) & 0x07
      const packetType = d[0] & 0x0f
      if (d.length < 5 || d.toString('latin1', 1, 5) !== 'avc1') return null
      if (packetType === 0) {
        ;({ lengthSize, annexB: config } = parseAvcConfig(d.subarray(5)))
        return null
      }
      if (packetType === 1) packet = d.subarray(8) // CodedFrames: 24-bit composition time first
      else if (packetType === 3) packet = d.subarray(5) // CodedFramesX: none
      else return null
      key = frameType === 1
    } else {
      // Legacy: [4 FrameType | 4 CodecID] AVCPacketType, 24-bit composition time, then the body.
      if ((d[0] & 0x0f) !== 7 || d.length < 5) return null
      if (d[1] === 0) {
        ;({ lengthSize, annexB: config } = parseAvcConfig(d.subarray(5)))
        return null
      }
      if (d[1] !== 1) return null
      packet = d.subarray(5)
      key = d[0] >> 4 === 1
    }
    if (!packet.length) return null
    const { annexB, idr, sps } = avccToAnnexB(packet, lengthSize)
    key ||= idr
    // A keyframe must carry its parameter sets: a decoder may start there.
    const data = key && !sps && config ? Buffer.concat([config, annexB]) : annexB
    return { data, key, pts }
  }

  return {
    push(chunk) {
      q.add(chunk)
      const out: EncodedFrame[] = []
      if (!header) {
        if (q.length < 13) return out
        const h = q.peek()
        if (h.toString('latin1', 0, 3) !== 'FLV') throw new Error('not an FLV stream')
        const size = h.readUInt32BE(5)
        if (size < 9 || size > 1024) throw new Error('bad FLV header size')
        if (q.length < size + 4) return out
        q.take(size + 4) // the header and PreviousTagSize0
        header = true
      }
      while (q.length >= 11) {
        const h = q.peek()
        const type = h[0] & 0x1f
        const size = h.readUIntBE(1, 3)
        if (size > MAX_FRAME) throw new Error('FLV tag too large')
        if (q.length < 11 + size + 4) break
        const pts = h.readUIntBE(4, 3) | (h[7] << 24)
        const tag = q.take(11 + size + 4)
        if (h[0] & 0x20) continue // encrypted (filter) tags: never written by FFmpeg here
        if (type === 9) {
          const f = video(Buffer.from(tag.subarray(11, 11 + size)), pts >>> 0)
          if (f) out.push(f)
        }
      }
      return out
    },
  }
}

/**
 * Whether a VP9 frame is a keyframe: its uncompressed header (VP9 bitstream spec § 6.2):
 * frame_marker (2), profile (2, a reserved bit after it for profile 3), show_existing_frame (1),
 * frame_type (1, 0 = KEY_FRAME).
 */
export function vp9IsKey(frame: Uint8Array): boolean {
  if (!frame.length) return false
  let bit = 0
  const read = () => (frame[bit >> 3] >> (7 - (bit++ & 7))) & 1
  if (read() !== 1 || read() !== 0) return false
  const low = read()
  const high = read()
  if (((high << 1) | low) === 3) read()
  if (read() === 1) return false
  return read() === 0
}

/** IVF: a 32-byte "DKIF" header, then 12-byte frame headers (size, 64-bit pts in the header's time base). */
export function ivfReader(): FrameReader {
  const q = queue()
  let msPerTick = 0
  return {
    push(chunk) {
      q.add(chunk)
      const out: EncodedFrame[] = []
      if (!msPerTick) {
        if (q.length < 32) return out
        const h = q.take(32)
        if (h.toString('latin1', 0, 4) !== 'DKIF') throw new Error('not an IVF stream')
        const rate = h.readUInt32LE(16)
        const scale = h.readUInt32LE(20)
        msPerTick = rate && scale ? (1000 * scale) / rate : 1
      }
      while (q.length >= 12) {
        const h = q.peek()
        const size = h.readUInt32LE(0)
        if (size > MAX_FRAME) throw new Error('IVF frame too large')
        if (q.length < 12 + size) break
        const pts = Number(h.readBigUInt64LE(4))
        const data = Buffer.from(q.take(12 + size).subarray(12))
        out.push({ data, key: vp9IsKey(data), pts: Math.round(pts * msPerTick) })
      }
      return out
    },
  }
}
