import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { writeAtomic } from '../config.ts'
import type { Logger } from '../log.ts'
import { IDENTITY_MS, listProcesses, type Proc } from '../proc-tree.ts'
import { pcmMs, pcmToWav } from './wav.ts'
import { clean, promptFor, whisperLang } from './words.ts'

// F-080: Whisper on this PC, through whisper.cpp's own server program (ggml-org's official Windows
// build), kept OUTSIDE the app and outside git: %LOCALAPPDATA%\shubham-agentic\speech-bin\whisper\Release
// and the models in %LOCALAPPDATA%\shubham-agentic\models. Neither is part of a publish: a PC without
// them says "not available" and the mic keeps using the phone's own recogniser.
//
// Memory on this PC is tight (Android builds), so the model is loaded only when someone speaks, is
// refused when there isn't room, and is let go after a few idle minutes. One sentence at a time.
// The server is our own child. Each agent on this PC (Dev's and the build's) notes its server in a file of its
// own; a server whose agent has gone (died without stopping it) is ended by the next agent to load Whisper,
// by its exact PID and start time, never by name, and never one whose agent is still running.

// Measured on this PC (i5-12500H, CPU only, 8 threads, no GPU): 3 Nov, a 5 s sentence once loaded: small 1.2 s with a short window (3.4 s full window), large-v3-turbo q5 4.8 s (18 s without).
// Turbo is too slow here, so small is the default; SAD_WHISPER_MODEL can still pick another file from the models folder. 10 Nov (F-176): small at the fixed window below: 2.1-2.3 s for 5 s or
// 10 s of speech, 3.6-3.7 s full window; load 6.5-17 s (22-25 s cold on 3 Nov).
export const DEFAULT_MODEL = 'small'
/**
 * How long the model stays loaded after the last use. 15 minutes (was 5): a dictation after a short break no longer pays the load (6.5 s warm, 8-25 s cold on this PC) while it is being said. The model holds about 0.8 GB, so
 * SAD_WHISPER_IDLE_MIN (1-240) can shorten or lengthen it for a PC that is short of memory.
 */
export const IDLE_MS = 15 * 60_000
export function idleMsFromEnv(v: string | undefined): number {
  const n = Number(v)
  return v !== undefined && Number.isFinite(n) && n >= 1 && n <= 240 ? Math.round(n * 60_000) : IDLE_MS
}

/**
 * The encoder window: ONE fixed window (768 frames = 15.4 s) for anything up to 11 s, the full 30 s window (0) above that; never a window that follows the length of the audio.
 * Why (F-176, measured 10 Nov on this PC): whisper.cpp gave wrong text when the window changed between requests: after a 512 frame request and a full-window one, a 704 frame request
 * for a 10 s sentence came back as just "The" (4 times in 3 sequences; one more gave a clipped sentence). A fixed 768 window, mixed with the full one, never broke in 3 sequences.
 * Cost (small model, 8 threads): about 2.2 s per request whatever the length up to 11 s (a 5 s sentence was 1.3 s in a 512 window, but that window is the one that corrupted).
 */
export const SPEECH_WINDOW = 768
/** The longest audio the fixed window holds with room for the prompt: 11 s of speech + 4 s. */
export const SPEECH_WINDOW_MAX_MS = 11_000
/** Dictation chunks (agent/speech/dictation.ts) are at most this long, so they always use the fixed window. */
export const DICTATION_WINDOW = SPEECH_WINDOW
export function audioCtx(ms: number): number {
  return ms <= SPEECH_WINDOW_MAX_MS ? SPEECH_WINDOW : 0
}
const READY_TIMEOUT_MS = 60_000
const INFER_TIMEOUT_MS = 60_000
/** Room the model needs on top of its file size, in MB (whisper.cpp's buffers and the server). */
const OVERHEAD_MB = 400
/** Always leave this much for everything else. */
const KEEP_FREE_MB = 800

export interface EngineStatus {
  available: boolean
  /** Why it isn't (no program, no model, not enough memory just now). */
  why?: string
  model: string
  loaded: boolean
  busy: boolean
}

export interface Transcript {
  text: string
  /** What Whisper said before cleaning. */
  raw: string
  /** Audio length and time taken, ms. */
  audioMs: number
  ms: number
}

export interface TranscribeOptions {
  /** BCP-47 from Settings (en-IN), or a Whisper code; 'auto' lets it choose. */
  lang?: string
  /** What was said just before (the prompt keeps the thread). */
  before?: string
  /** Extra names for the prompt. */
  words?: readonly string[]
  /** A live partial: skipped (null) rather than queued when Whisper is busy. */
  partial?: boolean
  /** Use exactly this encoder window (frames) instead of fitting it to the audio (dictation: DICTATION_WINDOW). Audio too long for it gets the full window. */
  window?: number
}

export interface EngineDeps {
  root?: string
  model?: string
  threads?: number
  idleMs?: number
  log?: Logger
  /** Tests: fakes for the program, its HTTP, memory and the process table. */
  spawn?: (exe: string, args: string[]) => ChildProcess
  fetch?: typeof fetch
  freeMb?: () => number
  procs?: () => Promise<Proc[]>
  kill?: (pid: number) => void
  exists?: (file: string) => boolean
  size?: (file: string) => number
  port?: () => Promise<number>
  now?: () => number
  /** This agent: its PID and when it started (ms). */
  self?: { pid: number; created: number }
}

export interface Engine {
  status(): EngineStatus
  transcribe(pcm: Buffer, o?: TranscribeOptions): Promise<Transcript | null>
  /** Loads the model now (the mic was pressed), so the first sentence doesn't wait for it. */
  warm(): Promise<void>
  stop(): Promise<void>
}

/** An error with the HTTP status the routes answer with (503: not available here or now; 502: Whisper failed). */
export function SpeechError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

/** SAD_WHISPER_MODEL (e.g. large-v3-turbo-q5_0) names a file ggml-<name>.bin in the models folder; anything else is the default. */
export const modelFromEnv = (v: string | undefined) => (v && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(v) && !v.includes('..') ? v : DEFAULT_MODEL)

export function createEngine(d: EngineDeps = {}): Engine {
  const root = d.root ?? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'shubham-agentic')
  const exe = path.join(root, 'speech-bin', 'whisper', 'Release', 'whisper-server.exe')
  const model = d.model ?? modelFromEnv(process.env.SAD_WHISPER_MODEL)
  const modelFile = path.join(root, 'models', `ggml-${model}.bin`)
  const threads = d.threads ?? Math.max(2, Math.min(8, os.cpus().length - 4))
  const idleMs = d.idleMs ?? idleMsFromEnv(process.env.SAD_WHISPER_IDLE_MIN)
  const exists = d.exists ?? existsSync
  const fetchFn = d.fetch ?? fetch
  const freeMb = d.freeMb ?? (() => Math.round(os.freemem() / 1_048_576))
  const now = d.now ?? Date.now
  const log = d.log
  const self = d.self ?? { pid: process.pid, created: Math.round(Date.now() - process.uptime() * 1000) }
  const servers = path.join(root, 'speech-bin', 'servers')
  const stateFile = path.join(servers, `${self.pid}.json`)

  let child: ChildProcess | null = null
  let base = ''
  let starting: Promise<void> | null = null
  let idle: NodeJS.Timeout | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let pending = 0
  let orphansChecked = false

  // The ggml weights take about their file size in memory; read the size, never the file.
  let sizeMb: number | null = null
  const modelMb = () => {
    try {
      return (sizeMb ??= Math.round((d.size ?? (f => statSync(f).size))(modelFile) / 1_048_576))
    } catch {
      return 1000
    }
  }
  const needMb = () => modelMb() + OVERHEAD_MB + KEEP_FREE_MB

  function missing(): string | null {
    if (!exists(exe)) return 'The Whisper program is not on this PC'
    if (!exists(modelFile)) return `The Whisper model ${model} is not on this PC`
    return null
  }

  function status(): EngineStatus {
    const m = missing()
    if (m) return { available: false, why: m, model, loaded: false, busy: false }
    if (!child && freeMb() < needMb()) return { available: false, why: 'Not enough free memory on the PC just now', model, loaded: false, busy: false }
    return { available: true, model, loaded: !!child && !starting, busy: pending > 0 }
  }

  async function endOrphan() {
    if (orphansChecked) return
    orphansChecked = true
    let files: string[]
    try {
      files = readdirSync(servers).filter(f => f.endsWith('.json'))
    } catch {
      return
    }
    if (!files.length) return
    let table: Proc[]
    try {
      table = await (d.procs ?? listProcesses)()
    } catch (e) {
      log?.warn(`speech: could not check for a left-behind Whisper server: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    const alive = (pid: unknown, created: unknown, name?: RegExp) => {
      const p = table.find(x => x.pid === pid)
      return !!p && typeof created === 'number' && Math.abs(p.created - created) <= IDENTITY_MS && (!name || name.test(p.name))
    }
    for (const f of files) {
      const file = path.join(servers, f)
      let s: { pid?: number; created?: number; agentPid?: number; agentCreated?: number }
      try {
        s = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      // Its agent is still running (the other agent on this PC, or this one): its server is its own business.
      if (alive(s.agentPid, s.agentCreated) || (s.agentPid === self.pid && s.agentCreated === self.created)) continue
      if (alive(s.pid, s.created, /^whisper-server.exe$/i)) {
        log?.warn(`speech: ending the Whisper server a stopped agent left behind (PID ${s.pid})`)
        try {
          ;(d.kill ?? (pid => process.kill(pid)))(s.pid!)
        } catch (e) {
          log?.warn(`speech: could not end PID ${s.pid}: ${e instanceof Error ? e.message : String(e)}`)
          continue
        }
      }
      rmSync(file, { force: true })
    }
  }

  function touch() {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => {
      if (pending === 0) void unload('idle')
      else touch()
    }, idleMs)
    idle.unref?.()
  }

  async function unload(why: string) {
    if (idle) clearTimeout(idle)
    idle = null
    const c = child
    child = null
    base = ''
    if (c && c.exitCode === null) {
      log?.info(`speech: Whisper unloaded (${why})`)
      c.kill()
    }
    rmSync(stateFile, { force: true })
  }

  async function load() {
    // A load in progress first: `child` is set as soon as the server is spawned, long before it listens (F-095:
    // a sentence sent while the model was still loading went to a closed port and failed with "fetch failed").
    if (starting) return starting
    if (child) return
    starting = (async () => {
      const m = missing()
      if (m) throw SpeechError(m, 503)
      await endOrphan()
      const free = freeMb()
      if (free < needMb()) throw SpeechError(`Not enough free memory on the PC for Whisper (${free} MB free, ${needMb()} MB needed)`, 503)
      const port = await (d.port ?? freePort)()
      const args = ['-m', modelFile, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-nt']
      const t0 = now()
      const c = (d.spawn ?? ((f, a) => nodeSpawn(f, a, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })))(exe, args)
      child = c
      // Its own output is kept (and logged) only while it loads, before it has heard a word: the words are never logged.
      let tail = ''
      let served = false
      c.stderr?.on('data', (b: Buffer) => {
        if (!served) tail = (tail + b.toString('utf8')).slice(-2000)
      })
      c.on('exit', code => {
        if (child === c) {
          child = null
          base = ''
          const why = !served && tail ? `: ${tail.trim().split(/\r?\n/).slice(-2).join(' / ')}` : ''
          log?.warn(`speech: Whisper server stopped (exit ${code})${why}`)
        }
      })
      if (c.pid) {
        try {
          mkdirSync(servers, { recursive: true })
          writeAtomic(stateFile, JSON.stringify({ pid: c.pid, created: t0, model, agentPid: self.pid, agentCreated: self.created }))
        } catch {
          /* only a help for the next run */
        }
      }
      base = `http://127.0.0.1:${port}`
      const until = now() + READY_TIMEOUT_MS
      for (;;) {
        if (child !== c) throw SpeechError('The Whisper server stopped while loading', 503)
        try {
          const r = await fetchFn(`${base}/`, { signal: AbortSignal.timeout(2000) })
          if (r.ok) break
        } catch {
          /* not listening yet */
        }
        if (now() > until) {
          await unload('did not start')
          throw SpeechError('The Whisper server did not start in time', 503)
        }
        await new Promise(r => setTimeout(r, 250))
      }
      served = true
      tail = ''
      log?.info(`speech: Whisper ${model} loaded in ${now() - t0} ms (${threads} threads)`)
      touch()
    })()
    try {
      await starting
    } catch (e) {
      if (child) await unload('failed to load')
      throw e
    } finally {
      starting = null
    }
  }

  async function infer(pcm: Buffer, o: TranscribeOptions): Promise<Transcript> {
    await load()
    const t0 = now()
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(pcmToWav(pcm))], { type: 'audio/wav' }), 'speech.wav')
    form.append('response_format', 'json')
    form.append('temperature', '0.0')
    form.append('language', whisperLang(o.lang))
    form.append('prompt', promptFor(o.before, o.words))
    const ctx = o.window === undefined ? audioCtx(pcmMs(pcm)) : pcmMs(pcm) <= SPEECH_WINDOW_MAX_MS ? o.window : 0
    if (ctx) form.append('audio_ctx', String(ctx))
    let r: Response
    try {
      r = await fetchFn(`${base}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(INFER_TIMEOUT_MS) })
    } catch (e) {
      throw SpeechError(`Whisper did not answer: ${e instanceof Error ? e.message : String(e)}`, 502)
    }
    if (!r.ok) throw SpeechError(`Whisper answered ${r.status}`, 502)
    const j = (await r.json().catch(() => ({}))) as { text?: unknown; error?: unknown }
    if (typeof j.text !== 'string') throw SpeechError(`Whisper gave no text${typeof j.error === 'string' ? `: ${j.error}` : ''}`, 502)
    touch()
    return { text: clean(j.text), raw: j.text, audioMs: pcmMs(pcm), ms: now() - t0 }
  }

  return {
    status,
    async warm() {
      await load()
    },
    transcribe(pcm, o = {}) {
      if (o.partial && pending > 0) return Promise.resolve(null)
      if (pcm.length < 3200) return Promise.resolve({ text: '', raw: '', audioMs: pcmMs(pcm), ms: 0 }) // < 0.1 s
      pending++
      const run = queue.then(() => infer(pcm, o))
      queue = run.catch(() => {})
      return run.finally(() => {
        pending--
      })
    },
    async stop() {
      await unload('the agent is stopping')
    },
  }
}

