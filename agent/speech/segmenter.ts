import { RATE } from './wav.ts'

// F-080: cuts a live recording into sentences at his pauses, so each one is transcribed as soon as
// he stops for a moment, while the recording itself goes on until he presses stop. Loudness only
// (RMS of 20 ms frames against a noise floor that follows the room), which is cheap enough to run
// on every frame on the hub; Whisper itself ignores the bits of silence left at the edges.

export interface SegmenterOptions {
  /** A pause this long ends a sentence. */
  endSilenceMs?: number
  /** Shorter bursts (a click, a cough) are dropped. */
  minSpeechMs?: number
  /** A sentence this long is cut anyway, at its quietest point in the last second. */
  maxMs?: number
  /** Audio kept from before the speech started, so the first sound isn't clipped. */
  preRollMs?: number
  /** Never treat anything quieter than this RMS (of 16-bit samples) as speech. */
  minLevel?: number
}

export interface Segment {
  pcm: Buffer
  /** Where it starts and ends in the whole recording, in ms. */
  startMs: number
  endMs: number
}

const FRAME_MS = 20
const FRAME_BYTES = (RATE / 1000) * FRAME_MS * 2

export function rms(frame: Buffer): number {
  let sum = 0
  const n = Math.floor(frame.length / 2)
  for (let i = 0; i < n; i++) {
    const s = frame.readInt16LE(i * 2)
    sum += s * s
  }
  return n ? Math.sqrt(sum / n) : 0
}

export class Segmenter {
  private readonly o: Required<SegmenterOptions>
  private rest = Buffer.alloc(0)
  private frames = 0
  private floor = 0
  /** Frames before speech (pre-roll ring). */
  private before: Buffer[] = []
  /** The sentence being spoken: its frames and their levels. */
  private cur: Buffer[] = []
  private levels: number[] = []
  private startFrame = 0
  private speechFrames = 0
  private silentRun = 0

  constructor(o: SegmenterOptions = {}) {
    this.o = { endSilenceMs: 700, minSpeechMs: 250, maxMs: 25_000, preRollMs: 300, minLevel: 250, ...o }
  }

  /** Feed audio (any length); returns the sentences it finished. */
  push(pcm: Buffer): Segment[] {
    const out: Segment[] = []
    let buf = this.rest.length ? Buffer.concat([this.rest, pcm]) : pcm
    let at = 0
    for (; at + FRAME_BYTES <= buf.length; at += FRAME_BYTES) {
      const seg = this.frame(Buffer.from(buf.subarray(at, at + FRAME_BYTES)))
      if (seg) out.push(seg)
    }
    this.rest = Buffer.from(buf.subarray(at))
    buf = Buffer.alloc(0)
    return out
  }

  /** The sentence in progress (for live partial words), or null when he isn't speaking. */
  current(): Buffer | null {
    return this.speechFrames > 0 ? Buffer.concat(this.cur) : null
  }

  /** Whether he is speaking right now (a sentence has started and not ended). */
  get speaking(): boolean {
    return this.speechFrames > 0
  }

  /** He pressed stop: whatever he was saying is a sentence too. */
  flush(): Segment | null {
    if (this.rest.length) {
      const pad = Buffer.alloc(FRAME_BYTES)
      this.rest.copy(pad)
      this.rest = Buffer.alloc(0)
      const seg = this.frame(pad)
      if (seg) return seg
    }
    return this.end(this.cur.length)
  }

  private threshold() {
    return Math.max(this.o.minLevel, this.floor * 2.5)
  }

  private frame(f: Buffer): Segment | null {
    const level = rms(f)
    const n = this.frames++
    const loud = level > this.threshold()
    if (!this.cur.length) {
      // The noise floor follows the room while nobody speaks (quickly down, slowly up).
      this.floor = this.floor === 0 ? level : level < this.floor ? this.floor * 0.7 + level * 0.3 : this.floor * 0.98 + level * 0.02
      if (!loud) {
        this.before.push(f)
        if (this.before.length > this.o.preRollMs / FRAME_MS) this.before.shift()
        return null
      }
      this.startFrame = n - this.before.length
      this.cur = [...this.before, f]
      this.levels = [...this.before.map(rms), level]
      this.before = []
      this.speechFrames = 1
      this.silentRun = 0
      return null
    }
    this.cur.push(f)
    this.levels.push(level)
    if (loud) {
      this.speechFrames++
      this.silentRun = 0
    } else this.silentRun++
    if (this.silentRun * FRAME_MS >= this.o.endSilenceMs) return this.end(this.cur.length - this.silentRun + Math.min(this.silentRun, 10))
    if (this.cur.length * FRAME_MS >= this.o.maxMs) {
      // Too long without a pause: cut at the quietest frame of the last second, keep the rest going.
      const from = Math.max(1, this.cur.length - 1000 / FRAME_MS)
      let cut = this.cur.length
      for (let i = from; i < this.cur.length; i++) if (this.levels[i] < (this.levels[cut] ?? Infinity)) cut = i
      const keep = this.cur.slice(cut)
      const keepLevels = this.levels.slice(cut)
      const seg = this.end(cut, true)
      this.cur = keep
      this.levels = keepLevels
      this.startFrame = n - keep.length + 1
      this.speechFrames = keepLevels.filter(l => l > this.threshold()).length || 1
      this.silentRun = 0
      return seg
    }
    return null
  }

  /** Ends the sentence after `upto` frames; null when it was too short to be speech. */
  private end(upto: number, forced = false): Segment | null {
    const frames = this.cur.slice(0, upto)
    const speech = this.speechFrames
    const start = this.startFrame
    this.cur = []
    this.levels = []
    this.speechFrames = 0
    this.silentRun = 0
    if (!frames.length || (!forced && speech * FRAME_MS < this.o.minSpeechMs)) return null
    return { pcm: Buffer.concat(frames), startMs: start * FRAME_MS, endMs: (start + frames.length) * FRAME_MS }
  }
}
