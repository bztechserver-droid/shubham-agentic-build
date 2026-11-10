import { Segmenter, type Segment } from './segmenter.ts'
import { pcmMs } from './wav.ts'

// F-176: the hub's side of the dictation button. He presses the button, speaks as long as he likes, presses it again; only then does the text appear. While he speaks the hub cuts the
// recording at his pauses (the same loudness-only Segmenter as the live mic) and merges the pieces into chunks of about 5 to 11 s, each of which is transcribed quietly in the
// background (nothing is sent to the page), so only the last chunk is left when he presses finish. Why 5-11 s and not one chunk per sentence: Whisper's cost here is its encoder
// window, not the length of the sentence (about 2.2 s per request for 5 s or 10 s of speech, small model), so short sentences would cost as much as long ones and could not keep up with
// his speech; one chunk of 5-11 s takes 0.2-0.4 x its length and never builds a queue. The ceiling (11 s) is what one fixed window of 15.4 s holds with room to spare.

/** A chunk is not closed before it holds this much speech (unless the recording ends). */
export const CHUNK_MIN_MS = 5000
/** A chunk never holds more than this: it always fits Whisper's fixed dictation window. */
export const CHUNK_MAX_MS = 11_000
/** Silence put between two merged pieces, so words at the join do not run together. */
const JOIN_GAP_MS = 250

export interface Chunk extends Segment {
  /** How many pauses-separated pieces went into it. */
  pieces: number
}

const gap = Buffer.alloc((16_000 / 1000) * JOIN_GAP_MS * 2)

export class DictationChunker {
  private readonly seg: Segmenter
  private acc: Segment[] = []
  private accMs = 0

  constructor() {
    // A pause of 0.6 s ends a piece; a piece is cut anyway at 10 s (at its quietest point), so with the pre-roll it stays under the ceiling.
    this.seg = new Segmenter({ endSilenceMs: 600, maxMs: 10_000 })
  }

  /** Feed audio (any length); returns the chunks it closed. */
  push(pcm: Buffer): Chunk[] {
    const out: Chunk[] = []
    for (const s of this.seg.push(pcm)) this.add(s, out)
    return out
  }

  /** The recording ended: whatever is left (the piece in progress and the unfinished chunk), as one chunk, or two when they would not fit together. */
  flushAll(): Chunk[] {
    const out: Chunk[] = []
    const last = this.seg.flush()
    if (last) this.add(last, out)
    const rest = this.close()
    if (rest) out.push(rest)
    return out
  }

  /** Is anyone speaking right now (a piece has begun and not ended)? */
  get speaking(): boolean {
    return this.seg.speaking
  }

  private add(s: Segment, out: Chunk[]) {
    const ms = pcmMs(s.pcm)
    if (this.acc.length && this.accMs + JOIN_GAP_MS + ms > CHUNK_MAX_MS) {
      const c = this.close()
      if (c) out.push(c)
    }
    this.acc.push(s)
    this.accMs += (this.acc.length > 1 ? JOIN_GAP_MS : 0) + ms
    if (this.accMs >= CHUNK_MIN_MS) {
      const c = this.close()
      if (c) out.push(c)
    }
  }

  private close(): Chunk | null {
    if (!this.acc.length) return null
    const parts: Buffer[] = []
    this.acc.forEach((s, i) => {
      if (i) parts.push(gap)
      parts.push(s.pcm)
    })
    const chunk: Chunk = { pcm: Buffer.concat(parts), startMs: this.acc[0].startMs, endMs: this.acc[this.acc.length - 1].endMs, pieces: this.acc.length }
    this.acc = []
    this.accMs = 0
    return chunk
  }
}
