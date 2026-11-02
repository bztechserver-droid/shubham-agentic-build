// F-080: audio in the shape whisper.cpp wants: 16 kHz, mono, signed 16-bit little-endian PCM.
// The phone sends that raw (the overlay page and Chris both resample before sending), so the hub
// never needs ffmpeg for speech; a WAV file of the same shape is accepted too.

export const RATE = 16_000

/** A WAV file around raw PCM16 mono. */
export function pcmToWav(pcm: Buffer, rate = RATE): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16) // fmt chunk size
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28) // bytes per second
  h.writeUInt16LE(2, 32) // block align
  h.writeUInt16LE(16, 34) // bits
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/** The PCM inside a WAV file, if it is 16 kHz mono 16-bit; null for anything else. */
export function wavToPcm(buf: Buffer): Buffer | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let fmtOk = false
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) return null
      fmtOk = buf.readUInt16LE(body) === 1 && buf.readUInt16LE(body + 2) === 1 && buf.readUInt32LE(body + 4) === RATE && buf.readUInt16LE(body + 14) === 16
      if (!fmtOk) return null
    } else if (id === 'data') {
      if (!fmtOk) return null
      const end = Math.min(buf.length, body + size)
      return buf.subarray(body, end - ((end - body) % 2))
    }
    at = body + size + (size % 2)
  }
  return null
}

/** Milliseconds of audio in PCM16 mono at RATE. */
export function pcmMs(pcm: Buffer): number {
  return Math.round((pcm.length / 2 / RATE) * 1000)
}
