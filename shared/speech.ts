// F-080: the page's side of the hub's speech service (agent/speech), the parts that need no browser:
// turning the microphone's samples (usually 48 kHz float) into what Whisper wants (16 kHz mono 16-bit),
// and the engine setting. The mic itself is src/chat/voice-hub.ts.

export const SPEECH_RATE = 16_000

/**
 * Which engine turns speech into words: Whisper on the PC (the hub), the phone browser's own (Google), or the phone's
 * keyboard (F-101: the mic opens the keyboard, and its own voice typing writes in the box).
 */
export type VoiceEngine = 'hub' | 'phone' | 'keyboard'
export const VOICE_ENGINES: readonly { code: VoiceEngine; label: string; note: string }[] = [
  { code: 'hub', label: 'PC (Whisper)', note: 'Your voice goes to this PC only. Better with Indian English, names and punctuation. It makes no start sound.' },
  { code: 'phone', label: 'Phone (Google)', note: "The phone browser's own recogniser. Sends your voice to Google. Chrome plays its own start sound with it, which the app cannot switch off." },
  {
    code: 'keyboard',
    label: 'Keyboard',
    note: "The mic opens your keyboard: tap the keyboard's own mic (Samsung keyboard, Gboard). The same voice typing as in any other app, with punctuation and the words it has learnt. In a terminal the mic uses Phone (Google).",
  },
]
// Whisper on the PC is the default (his word, 10 Nov: "optimize PC Whisper", it is the silent dictation engine he wants on the phone). The old ways stay one tap away in Settings › Voice (per device, kept in
// this browser), and the mic itself falls back to the phone's own recogniser, with a note, whenever the PC cannot take speech (no program or model, not enough memory just now, no connection).
export const DEFAULT_ENGINE: VoiceEngine = 'hub'
export const parseEngine = (raw: unknown): VoiceEngine => (raw === 'hub' || raw === 'phone' || raw === 'keyboard' ? raw : DEFAULT_ENGINE)

/**
 * Microphone samples at any rate -> 16 kHz PCM16. Each output sample is the average of the input samples it
 * covers (a box filter: enough of a low-pass for speech), and the fraction left over carries into the next
 * call, so pieces of any size join without clicks or drift.
 */
export class Resampler {
  private readonly step: number
  private pos = 0
  private sum = 0
  private count = 0

  constructor(fromRate: number) {
    if (!(fromRate >= SPEECH_RATE)) throw new Error(`Can't resample from ${fromRate} Hz`)
    this.step = fromRate / SPEECH_RATE
  }

  push(input: Float32Array): Int16Array {
    const out = new Int16Array(Math.ceil((input.length + this.pos + 1) / this.step) + 1)
    let n = 0
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i]
      this.count++
      this.pos++
      if (this.pos >= this.step) {
        const v = Math.max(-1, Math.min(1, this.sum / this.count))
        out[n++] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff)
        this.pos -= this.step
        this.sum = 0
        this.count = 0
      }
    }
    return out.subarray(0, n)
  }
}

/** Bytes as base64, in pieces (String.fromCharCode on a whole second of audio would overflow the stack). */
export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** The sentences heard so far, in order (a missing one is still on its way), as one text. */
export const joinFinals = (finals: readonly (string | undefined)[]) =>
  finals
    .filter((x): x is string => !!x)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Messages the hub's stream sends (agent/speech/routes.ts). */
export type HubMessage =
  | { t: 'ready'; model: string }
  /** Speech has started (F-087: the page shows "heard you"). */
  | { t: 'heard' }
  /** The hub has stopped listening (stop, a limit, or one question over): the microphone can go; 'done' follows. */
  | { t: 'stopped' }
  | { t: 'partial'; text: string }
  | { t: 'final'; i: number; text: string; audioMs: number; ms: number }
  /** Dictation (F-176): one chunk was written in the background; no text, only the timing. The text comes once, in 'done'. */
  | { t: 'progress'; i: number; audioMs: number; ms: number }
  | { t: 'error'; message: string; status: number }
  | { t: 'done'; text: string }
