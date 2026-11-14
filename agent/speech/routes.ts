import type { IncomingMessage, ServerResponse } from 'node:http'
import { apiError, type ApiMount, type WsSocket } from '../api.ts'
import type { Logger } from '../log.ts'
import { DICTATION_WINDOW, type Engine, type TranscribeOptions } from './engine.ts'
import { DictationChunker } from './dictation.ts'
import { Segmenter } from './segmenter.ts'
import { marksHeader, type Tts } from './tts.ts'
import { pcmMs, wavToPcm } from './wav.ts'

// F-080: the hub's speech service, under /agent-api/speech (the app's token, like the rest of the page's API).
//   GET  /speech/status                   {available, why?, model, loaded, busy, voice}   (voice: the PC voice's status, F-221)
//   POST /speech/warm                     load the model now (the mic was pressed)
//   POST /speech/transcribe?lang=&before=&words=a,b&guess=1   one utterance, whole, as a raw body: audio/wav
//                                         (16 kHz mono 16-bit) or application/octet-stream (that PCM) -> {text, raw, audioMs, ms}
//                                         F-221: guess=1 is live talk's guess at his first short pause: when Whisper has anything running
//                                         or queued, or is loading the model, it is 409 {busy: true} at once, and nothing is queued. A request
//                                         the page drops (an aborted fetch, a closed tab) before Whisper has started on it (still queued, or
//                                         waiting for the model to load) is dropped: never run.
//                                         Every job leaves one log line, numbers only (engine.ts).
// F-221 (order ob98a): the PC voice (agent/speech/tts.ts: Windows' own voices, rendered on this PC for live talk's page to play):
//   POST /speech/say                      {text, voice?, lang?, rate?} -> audio/wav (16-bit PCM, silence at the ends trimmed), with
//                                         X-Speech-Marks (encodeURIComponent of the JSON [{ms, start, end}]: each word's start in the audio, and
//                                         text.slice(start, end)), X-Speech-Voice (the voice's name), X-Speech-Ms (the render time)
//   GET  /speech/voices                   {voices: [{id, name, lang, gender}], default}
//   POST /speech/say/warm                 start the PC voice now (Talk was pressed) -> {ok, state, ms}
//   Errors are {error} with the status, as the other routes here. Not Windows: 503 "The PC voice needs Windows".
//   WS   /speech/stream                   one recording, live (the overlay's mic), text frames as JSON:
//     page -> {t:'start', lang?, words?, partials?}  {t:'audio', b64}  {t:'stop'}  {t:'cancel'}
//     hub  -> {t:'ready', model}  {t:'partial', i, text}  {t:'final', i, text, audioMs, ms}  {t:'error', message, status}
//             {t:'done', text}   (after stop: every sentence, in order, joined)
// F-176: a dictation (mode 'dictate') also takes {t:'note', code} frames (a short code for a step of the page's start: press, mic-open, first-frame, no-audio ...) and the agent's log gets one line per
// start, per code, per first audio and per end (reason, seconds of audio, chunks): codes and numbers only, never words or audio, so a failed start can be explained afterwards.
// The phone app (F-074, device key) gets the same stream through Overlay's /voice mount: voice.ts hands its
// device-key WebSocket /voice/speech to stream() below. (The API's JSON bodies stop at 64 KB, so audio
// travels in WebSocket frames or a raw body, never as JSON.)
// Limits: a recording longer than maxMs gets {t:'error', status:413} and ends as if stopped; a socket that
// gets no audio for idleMs (before stop) is closed. Privacy: audio is never written to disk, and the words are
// never logged (only lengths and timings).
// The recording runs until he presses stop; pauses only cut it into sentences, which are transcribed in
// order while he goes on speaking, each with the one before as context.
// F-176 (the dictation button): {t:'start', mode:'dictate'} is one recording that is written ONLY when he finishes: the hub cuts it at his pauses into chunks of 5-11 s and transcribes each in
// the background with one fixed window (nothing is sent while he speaks except {t:'progress', i, audioMs, ms}: no text, no partials), and after {t:'stop'} it sends {t:'stopped'} and
// {t:'done', text}. If any chunk fails, no 'done' is sent: it answers {t:'error'} and closes, so the page keeps his audio and offers a retry (a text with a missing piece is never delivered).
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

/** A raw route's JSON answer (an error too: {error}, as the API gives it). Nothing when the page has gone. */
function answerJson(res: ServerResponse, status: number, body: object) {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** F-221: aborted when the page goes away before its answer was written (a fetch it aborted, a tab it closed). */
function goneSignal(res: ServerResponse): AbortSignal {
  const gone = new AbortController()
  res.once('close', () => {
    if (!res.writableEnded) gone.abort()
  })
  return gone.signal
}

/** POST /speech/transcribe: one utterance as a raw body (the API has already checked the token and the Origin). */
export function transcribeRaw(engine: Engine) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const gone = goneSignal(res)
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
      const guess = q.get('guess') === '1'
      const r = await engine.transcribe(pcm, { ...opts({ lang: q.get('lang') ?? undefined, before: q.get('before') ?? undefined, words }), ...(guess ? { guess: true } : {}) }, { signal: gone })
      answerJson(res, 200, r ?? { text: '', raw: '', audioMs: pcmMs(pcm), ms: 0 })
    } catch (e) {
      answerJson(res, (e as { status?: number }).status ?? 500, { error: e instanceof Error ? e.message : String(e), ...((e as { busy?: unknown }).busy === true ? { busy: true } : {}) })
    }
  }
}

const SAY_BODY_MAX = 16 * 1024
const NO_VOICE = 'The PC voice is not set up on this hub'

/** A raw route's JSON body (the API reads the JSON routes' bodies itself, by the same rules: JSON only, so another site's form can't post one). */
async function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) throw apiError(415, 'Send the request body as application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw apiError(413, 'Request too large')
    chunks.push(c as Buffer)
  }
  let v: unknown
  try {
    v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw apiError(400, 'The body is not valid JSON')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw apiError(400, 'Send a JSON object')
  return v as Record<string, unknown>
}

const optionalString = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : undefined)

/** POST /speech/say (F-221): one sentence in the PC's own voice, as a WAV; its word timings in a header. A sentence still waiting when the page goes away is not said. */
export function sayRaw(tts: Tts | undefined) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const gone = goneSignal(res)
    try {
      if (req.method !== 'POST') throw apiError(405, 'POST the words')
      if (!tts) throw apiError(503, NO_VOICE)
      const b = await readJsonBody(req, SAY_BODY_MAX)
      if (typeof b.text !== 'string') throw apiError(400, 'Send {text}: the words to say')
      const said = await tts.say({ text: b.text, voice: optionalString(b.voice, 300), lang: optionalString(b.lang, 20), rate: typeof b.rate === 'number' ? b.rate : undefined }, gone)
      if (res.destroyed) return
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': said.wav.length,
        'cache-control': 'no-store',
        'x-speech-marks': marksHeader(said.marks),
        // A header carries printable ASCII only; Windows' voice names are ("Microsoft Heera").
        'x-speech-voice': said.voice.replace(/[^\x20-\x7e]/g, '').slice(0, 200),
        'x-speech-ms': String(said.ms),
      })
      res.end(said.wav)
    } catch (e) {
      answerJson(res, (e as { status?: number }).status ?? 500, { error: e instanceof Error ? e.message : String(e) })
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
    let dictation: DictationChunker | null = null
    let startedAt = 0
    let firstAudioLogged = false
    let endLogged = false
    /** One line when a dictation ends (codes and numbers only). */
    const logEnd = (reason: string) => {
      if (!dictation || endLogged) return
      endLogged = true
      log?.info(`speech: dictate end ${reason} audio=${Math.round(total / 100) / 10}s chunks=${n} failed=${chunkFailed !== null} after=${Date.now() - startedAt}ms`)
    }
    let chunkFailed: string | null = null
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
        logEnd('no-audio')
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
          // Dictation: no text goes to the page until the end (only the timing, for the log and the tests).
          if (dictation) send({ t: 'progress', i, audioMs: r.audioMs, ms: r.ms })
          else send({ t: 'final', i, text: r.text, audioMs: r.audioMs, ms: r.ms })
        } catch (e) {
          finals[i] = ''
          if (dictation) chunkFailed = e instanceof Error ? e.message : String(e)
          else fail(e)
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
          if (r && r.text && !stopped && !ended && seg?.current()) send({ t: 'partial', i: n, text: r.text })
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
      if (dictation) for (const c of dictation.flushAll()) queueFinal(c.pcm)
      else {
        const last = dropRest ? null : seg.flush()
        if (last) queueFinal(last.pcm)
      }
      void chain.then(() => {
        if (ended) return
        ended = true
        if (chunkFailed !== null) {
          // A piece of what he said is missing: no text is delivered, so the page keeps the audio and offers a retry.
          send({ t: 'error', message: `Whisper could not write all of it: ${chunkFailed}`, status: 502 })
          ws.close(1011, 'incomplete')
          return
        }
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
        const dictate = m.mode === 'dictate'
        // Dictation: no partials, one fixed Whisper window for every chunk (see engine.ts DICTATION_WINDOW).
        o = { ...opts(m), partials: !dictate && m.partials === true, ...(dictate ? { window: DICTATION_WINDOW } : {}) }
        once = !dictate && m.once === true
        if (once) {
          noSpeechMs = clampMs(m.noSpeechMs, 2000, 30_000, ONCE_NO_SPEECH_MS)
          limit = Math.min(maxMs, ONCE_MAX_MS)
        }
        // One question is never cut in the middle: its first pause ends it, or its 60 s.
        if (dictate) {
          startedAt = Date.now()
          log?.info('speech: dictate start')
          dictation = new DictationChunker()
          seg = new Segmenter() // never fed: the chunker owns the audio; it only marks that the recording has started
        } else seg = once ? new Segmenter({ endSilenceMs: clampMs(m.endSilenceMs, 500, 3000, ONCE_END_SILENCE_MS), maxMs: ONCE_MAX_MS + 1000 }) : new Segmenter()
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
        if (dictation && !firstAudioLogged) {
          firstAudioLogged = true
          log?.info(`speech: dictate first audio +${Date.now() - startedAt}ms`)
        }
        unheard()
        if (total > limit) {
          send({ t: 'error', message: `Recordings stop after ${Math.round(limit / 1000)} s`, status: 413 })
          logEnd('limit')
          return finish()
        }
        const piece = pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm
        const done = dictation ? dictation.push(piece) : seg.push(piece)
        if (!heard && ((dictation ? dictation.speaking : seg.speaking) || done.length)) {
          heard = true
          send({ t: 'heard' })
        }
        for (const s of done) queueFinal(s.pcm)
        // One question: its first sentence is the whole of it; nothing said at all ends it empty.
        if (once && (done.length || (!heard && total >= noSpeechMs))) return finish(true)
        partial()
        return
      }
      if (m.t === 'note' && dictation) {
        if (typeof m.code === 'string' && /^[a-z][a-z0-9-]{1,23}$/.test(m.code)) log?.info(`speech: dictate note ${m.code} +${Date.now() - startedAt}ms`)
        return
      }
      if (m.t === 'stop') {
        logEnd('stop')
        return finish()
      }
      if (m.t === 'cancel') {
        logEnd('cancel')
        ended = true
        if (quiet) clearTimeout(quiet)
        ws.close(1000, 'cancelled')
      }
    })
    ws.onClose(() => {
      if (quiet) clearTimeout(quiet)
      logEnd(stopped ? 'closed-after-stop' : 'closed')
      if (!ended) log?.info('speech: a recording was closed before its end')
      ended = true
    })
  }
}

/** The speech routes (one mount, so the PC voice's are guarded exactly as Whisper's: the app's token, the owner). `tts`: the PC voice (F-221). */
export function speechMount(engine: Engine, log?: Logger, tts?: Tts): ApiMount {
  const live = stream(engine, log)
  const once = transcribeRaw(engine)
  const say = sayRaw(tts)
  const status = () => (tts ? { ...engine.status(), voice: tts.status() } : engine.status())
  const voice = () => {
    if (!tts) throw apiError(503, NO_VOICE)
    return tts
  }
  return {
    prefix: '/speech',
    ws: rest => (rest === '/stream' ? live : null),
    raw: rest => (rest === '/transcribe' ? once : rest === '/say' ? say : null),
    async http(r) {
      const { method, rest } = r
      if (method === 'GET' && rest === '/status') return status()
      if (method === 'POST' && rest === '/warm') {
        await engine.warm()
        return status()
      }
      if (method === 'GET' && rest === '/voices') return voice().voices()
      if (method === 'POST' && rest === '/say/warm') return voice().warm()
      throw apiError(404, `No such route: ${method} ${rest}`)
    },
  }
}
