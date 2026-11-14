import type { FastClientFrame } from './fast.ts'

// order oe3cf (Live talking, classic): the pure part of the adapter between the OLD app's voice frames and the new fast Assistant's (src/live/classic/prelude.ts has the socket and the rest). Tested on its own
// (live-classic-frames.test.ts). A turn is a number in the old client and the string "t<number>" here (the fast protocol's ids are strings of A-Za-z0-9_.:-).
export type Frame = Record<string, unknown>

export const turnId = (turn: unknown): string => `t${Number(turn)}`
export const turnOf = (id: unknown): number | undefined => {
  const m = typeof id === 'string' ? /^t(\d{1,9})$/.exec(id) : null
  return m ? Number(m[1]) : undefined
}

/** One frame from the hub -> the old client's frame (null: it has no such thing, or the turn is not one the page started: the hub's "o:<order>" turns, the hand-off question's answer). */
export function fromHub(f: Record<string, unknown>): Frame | null {
  const turn = turnOf(f.id)
  switch (f.t) {
    case 'state':
      // The new "off" (no Assistant on this hub) is the old "unavailable".
      return { type: 'voice-state', state: f.state === 'off' ? 'unavailable' : f.state, reason: typeof f.reason === 'string' ? f.reason : undefined }
    case 'delta':
      return turn === undefined ? null : { type: 'voice-delta', turn, text: f.text }
    case 'flush':
      return turn === undefined ? null : { type: 'voice-flush', turn }
    case 'tool':
      return turn === undefined ? null : { type: 'voice-tool', turn, label: f.label }
    case 'done':
      return turn === undefined ? null : { type: 'voice-done', turn }
    case 'error':
      // An error of one of our turns is the old voice-error; an error with no turn is the old "the link is bad" frame; any other turn's error is not ours.
      return turn !== undefined ? { type: 'voice-error', turn, error: typeof f.message === 'string' ? f.message : 'The voice agent hit an error.' } : f.id === undefined ? { type: 'error' } : null
    default:
      return null
  }
}

/** One frame from the old client -> the hub's (null: nothing to send). */
export function toHub(f: Frame): FastClientFrame | null {
  switch (f.type) {
    case 'voice-start':
      return { t: 'start', client: 'web', id: String(f.tabId), model: f.model === 'sonnet' ? 'sonnet' : 'haiku', ...(f.resume ? { resume: true } : {}) } as FastClientFrame
    case 'voice-utterance':
      return { t: 'ask', id: turnId(f.turn), text: String(f.text ?? '').slice(0, 2000), via: 'voice', ...(f.thorough ? { thorough: true } : {}) } as FastClientFrame
    case 'voice-interrupt':
      return { t: 'cancel', id: turnId(f.turn) } as FastClientFrame
    case 'voice-stop':
      return { t: 'stop' } as FastClientFrame
    default:
      // voice-confirm-answer: the Assistant of this app has no change that needs a spoken yes (its one write, a task, is on the Assistant page); nothing is sent.
      return null
  }
}

/**
 * F-221 (ob98a, T4): what follows a frame the old client sent, on the hub's side: after its start, the hold latch as Settings › Assistant › Spoken
 * hand-offs says ("Tap to send": on, the default; "Send at once": off, the old way), after EVERY start (a plain start begins with hold off, a
 * reconnect only ever raises it). Null after any other frame. The old client itself is not changed (old-voice.generated.js is pinned).
 */
export function holdAfter(f: Frame, tapToSend: boolean): FastClientFrame | null {
  return f.type === 'voice-start' ? { t: 'hold', on: tapToSend } : null
}

/** The old client's STT address -> this app's speech route (undefined: not an STT address). */
export function speechUrl(oldUrl: string, speechBase: string): { url: string; kind: 'status' | 'warm' | 'transcribe' } | undefined {
  const STT = '/api/stt/'
  if (!oldUrl.startsWith(STT)) return undefined
  const [pathname, query = ''] = oldUrl.slice(STT.length).split('?')
  if (pathname === 'status' || pathname === 'warm') return { url: `${speechBase}${pathname}`, kind: pathname }
  if (pathname === 'transcribe') {
    const p = new URLSearchParams(query)
    const lang = p.get('lang')
    const out = new URLSearchParams()
    if (lang && lang !== 'auto') out.set('lang', lang.slice(0, 2))
    const hint = p.get('hint')
    if (hint) out.set('before', hint.slice(-500))
    return { url: `${speechBase}transcribe${out.size ? `?${out}` : ''}`, kind: 'transcribe' }
  }
  return undefined
}

/** The new /speech/status answer -> the shape the old client reads (state off = "loads on first use"). */
export function oldSttStatus(s: { available?: boolean; why?: string; model?: string; loaded?: boolean } | null) {
  const available = s?.available === true
  return { available, state: available ? (s?.loaded ? 'ready' : 'off') : 'unavailable', engine: 'whisper-local', model: s?.model ?? null, reason: available ? null : (s?.why ?? 'Whisper is not available on this server.') }
}
