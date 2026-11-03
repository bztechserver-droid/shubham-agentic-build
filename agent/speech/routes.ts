import type { IncomingMessage, ServerResponse } from 'node:http'
import { apiError, type ApiMount, type WsSocket } from '../api.ts'
import type { Logger } from '../log.ts'
import type { Engine, TranscribeOptions } from './engine.ts'
import { Segmenter } from './segmenter.ts'
import { pcmMs, wavToPcm } from './wav.ts'

// F-080: the hub's speech service, under /agent-api/speech (the app's token, like the rest of the page's API).
//   GET  /speech/status                   {available, why?, model, loaded, busy}
//   POST /speech/warm                     load the model now (the mic was pressed)
//   POST /speech/transcribe?lang=&before=&words=a,b   one utterance, whole, as a raw body: audio/wav
//                                         (16 kHz mono 16-bit) or application/octet-stream (that PCM) -> {text, raw, audioMs, ms}
//   WS   /speech/stream                   one recording, live (the overlay's mic), text frames as JSON:
//     page -> {t:'start', lang?, words?, partials?}  {t:'audio', b64}  {t:'stop'}  {t:'cancel'}
//     hub  -> {t:'ready', model}  {t:'partial', i, text}  {t:'final', i, text, audioMs, ms}  {t:'error', message, status}
//             {t:'done', text}   (after stop: every sentence, in order, joined)
// The phone app (F-074, device key) gets the same stream through Overlay's /voice mount: voice.ts hands its
// device-key WebSocket /voice/speech to stream() below. (The API's JSON bodies stop at 64 KB, so audio
// travels in WebSocket frames or a raw body, never as JSON.)
// Limits: a recording longer than maxMs gets {t:'error', status:413} and ends as if stopped; a socket that
// gets no audio for idleMs (before stop) is closed. Privacy: audio is never written to disk, and the words are
// never logged (only lengths and timings).
// The recording runs until he presses stop; pauses only cut it into sentences, which are transcribed in
// order while he goes on speaking, each with the one before as context.
// F-087 (the Assistant, hands-free): {t:'start', once:true, endSilenceMs?, noSpeechMs?} is ONE question that
// ends by itself: at the first pause of endSilenceMs (default 1.2 s) after speech, or empty when nothing is
// said within noSpeechMs of audio (default 8 s), or at 60 s. The hub also sends {t:'heard'} the moment speech
// starts (any mode), so the page can show "heard you", and {t:'stopped'} when it stops listening (stop, a limit,
// or one question over: the microphone can go; the last words and 'done' follow).

export const MAX_UTTERANCE_MS = 120_000
export const MAX_RECORDING_MS = 15 * 60_000
/** One audio message at most this big (base64 of ~12 s): a paired phone can't hand the hub one huge piece. */
export const MAX_AUDIO_B64 = 512 * 1024
/** No audio for this long while recording: the socket is closed. */
export const AUDIO_IDLE_MS = 10_000
/** A live partial of the sentence in progress, at most this often. */
export const PARTIAL_EVERY_MS = 1500
/** One question (once): the pause that ends it, the wait for any speech, and its longest. */
export const ONCE_END_SILENCE_MS = 1200
export const ONCE_NO_SPEECH_MS = 8000
export const ONCE_MAX_MS = 60_000

const clampMs = (v: unknown, min: number, max: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : dflt

export function decodeAudio(raw: Buffer): Buffer {
  if (!raw.length) throw apiError(400, 'Expected audio: 16 kHz mono 16-bit PCM or WAV')
  const pcm = raw.toString('ascii', 0, 4) === 'RIFF' ? wavToPcm(raw) : raw
  if (!pcm) throw apiError(415, 'The WAV must be 16 kHz, mono, 16-bit PCM')
  if (pcm.length % 2) throw apiError(400, 'PCM16 audio has an even number of bytes')
  return pcm
}

function opts(b: Record<string, unknown>): TranscribeOptions {
  return {
    lang: typeof b.lang === 'string' ? b.lang.slice(0, 20) : undefined,
    before: typeof b.before === 'string' ? b.before.slice(-500) : undefined,
    words: Array.isArray(b.words) ? b.words.filter((w): w is string => typeof w === 'string').slice(0, 40) : undefined,
  }
}

const MAX_UTTERANCE_BYTES = (MAX_UTTERANCE_MS / 1000) * 32_000 + 1024
const AUDIO_TYPE = /^(?:audio\/(?:wav|x-wav|wave)|application\/octet-stream)\b/i

/** POST /speech/transcribe: one utterance as a raw body (the API has already checked the token and the Origin). */
export function transcribeRaw(engine: Engine) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const answer = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    try {
      if (req.method !== 'POST') throw apiError(405, 'POST the audio')
      if (!AUDIO_TYPE.test(String(req.headers['content-type'] ?? ''))) throw apiError(415, 'Send audio/wav or application/octet-stream (16 kHz mono 16-bit PCM)')
      const chunks: Buffer[] = []
      let size = 0
      for await (const c of req) {
        size += (c as Buffer).length
        if (size > MAX_UTTERANCE_BYTES) throw apiError(413, `Up to ${MAX_UTTERANCE_MS / 1000} s at a time`)
        chunks.push(c as Buffer)
      }
      const pcm = decodeAudio(Buffer.concat(chunks))
      const q = new URL(req.url ?? '/', 'http://agent').searchParams
      const words = (q.get('words') ?? '').split(',').filter(Boolean)
      const r = await engine.transcribe(pcm, opts({ lang: q.get('lang') ?? undefined, before: q.get('before') ?? undefined, words }))
      answer(200, r ?? { text: '', raw: '', audioMs: pcmMs(pcm), ms: 0 })
    } catch (e) {
      answer((e as { status?: number }).status ?? 500, { error: e instanceof Error ? e.message : String(e) })
    }
  }
}

export interface StreamLimits {
  /** The longest recording (ms): the page's mic allows MAX_RECORDING_MS, the phone's Chris one utterance of 60 s. */
  maxMs?: number
  idleMs?: number
}

export function stream(engine: Engine, log?: Logger, limits: StreamLimits = {}) {
  const maxMs = limits.maxMs ?? MAX_RECORDING_MS
  const idleMs = limits.idleMs ?? AUDIO_IDLE_MS
  return (ws: WsSocket) => {
    const send = (m: object) => {
      try {
        ws.sendText(JSON.stringify(m))
      } catch {
        /* closed */
      }
    }
    let o: TranscribeOptions & { partials?: boolean } = {}
    let seg: Segmenter | null = null
    let finals: string[] = []
    let chain: Promise<void> = Promise.resolve()
    let total = 0
    let lastPartial = 0
    let partialBusy = false
    let ended = false
    let stopped = false
    let n = 0
    let once = false
    let heard = false
    let noSpeechMs = ONCE_NO_SPEECH_MS
    let limit = maxMs
    let quiet: ReturnType<typeof setTimeout> | null = null
    const unheard = () => {
      if (quiet) clearTimeout(quiet)
      quiet = stopped || ended ? null : setTimeout(() => {
        if (stopped || ended) return
        send({ t: 'error', message: 'No audio came for a while: the recording was closed', status: 408 })
        ended = true
        ws.close(1000, 'no audio')
      }, idleMs)
      quiet?.unref?.()
    }

    const fail = (e: unknown) => {
      const status = (e as { status?: number })?.status ?? 500
      send({ t: 'error', message: e instanceof Error ? e.message : String(e), status })
    }

    const queueFinal = (pcm: Buffer) => {
      const i = n++
      chain = chain.then(async () => {
        if (ended) return
        try {
          const r = await engine.transcribe(pcm, { ...o, before: finals.join(' ') })
          if (!r || ended) return
          finals[i] = r.text
          send({ t: 'final', i, text: r.text, audioMs: r.audioMs, ms: r.ms })
        } catch (e) {
          finals[i] = ''
          fail(e)
        }
      })
    }

    const partial = () => {
      if (!o.partials || partialBusy || !seg) return
      const cur = seg.current()
      const now = Date.now()
      if (!cur || pcmMs(cur) < 700 || now - lastPartial < PARTIAL_EVERY_MS) return
      lastPartial = now
      partialBusy = true
      engine
        .transcribe(cur, { ...o, partial: true, before: finals.join(' ') })
        .then(r => {
          if (r && r.text && !ended && seg?.current()) send({ t: 'partial', i: n, text: r.text })
        })
        .catch(() => {})
        .finally(() => {
          partialBusy = false
        })
    }

    /** The end (stop pressed, the limit, or one question over): the sentences still in Whisper, then 'done'. */
    const finish = (dropRest = false) => {
      if (stopped || ended || !seg) return
      stopped = true
      if (quiet) clearTimeout(quiet)
      // The page can let the microphone go now; the words follow.
      send({ t: 'stopped' })
      // After one question's pause, whatever came next is not part of it.
      const last = dropRest ? null : seg.flush()
      if (last) queueFinal(last.pcm)
      void chain.then(() => {
        if (ended) return
        ended = true
        send({ t: 'done', text: finals.filter(Boolean).join(' ') })
        ws.close(1000, 'done')
      })
    }

    ws.onText(text => {
      let m: Record<string, unknown>
      try {
        m = JSON.parse(text)
      } catch {
        return
      }
      if (m.t === 'start' && !seg) {
        o = { ...opts(m), partials: m.partials === true }
        once = m.once === true
        if (once) {
          noSpeechMs = clampMs(m.noSpeechMs, 2000, 30_000, ONCE_NO_SPEECH_MS)
          limit = Math.min(maxMs, ONCE_MAX_MS)
        }
        // One question is never cut in the middle: its first pause ends it, or its 60 s.
        seg = once ? new Segmenter({ endSilenceMs: clampMs(m.endSilenceMs, 500, 3000, ONCE_END_SILENCE_MS), maxMs: ONCE_MAX_MS + 1000 }) : new Segmenter()
        unheard()
        const s = engine.status()
        if (!s.available) {
          send({ t: 'error', message: s.why ?? 'Whisper is not available', status: 503 })
          ws.close(1000, 'unavailable')
          return
        }
        engine.warm().then(
          () => send({ t: 'ready', model: s.model }),
          e => {
            fail(e)
            ws.close(1000, 'unavailable')
          },
        )
        return
      }
      if (!seg || ended || stopped) return
      if (m.t === 'audio' && typeof m.b64 === 'string') {
        if (m.b64.length > MAX_AUDIO_B64) {
          send({ t: 'error', message: 'Send audio in pieces of a few hundred ms', status: 413 })
          ended = true
          ws.close(1009, 'too big')
          return
        }
        const pcm = Buffer.from(m.b64, 'base64')
        total += pcmMs(pcm)
        unheard()
        if (total > limit) {
          send({ t: 'error', message: `Recordings stop after ${Math.round(limit / 1000)} s`, status: 413 })
          return finish()
        }
        const done = seg.push(pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm)
        if (!heard && (seg.speaking || done.length)) {
          heard = true
          send({ t: 'heard' })
        }
        for (const s of done) queueFinal(s.pcm)
        // One question: its first sentence is the whole of it; nothing said at all ends it empty.
        if (once && (done.length || (!heard && total >= noSpeechMs))) return finish(true)
        partial()
        return
      }
      if (m.t === 'stop') return finish()
      if (m.t === 'cancel') {
        ended = true
        if (quiet) clearTimeout(quiet)
        ws.close(1000, 'cancelled')
      }
    })
    ws.onClose(() => {
      if (quiet) clearTimeout(quiet)
      if (!ended) log?.info('speech: a recording was closed before its end')
      ended = true
    })
  }
}

export function speechMount(engine: Engine, log?: Logger): ApiMount {
  const live = stream(engine, log)
  const once = transcribeRaw(engine)
  return {
    prefix: '/speech',
    ws: rest => (rest === '/stream' ? live : null),
    raw: rest => (rest === '/transcribe' ? once : null),
    async http(r) {
      const { method, rest } = r
      if (method === 'GET' && rest === '/status') return engine.status()
      if (method === 'POST' && rest === '/warm') {
        await engine.warm()
        return engine.status()
      }
      throw apiError(404, `No such route: ${method} ${rest}`)
    },
  }
}
