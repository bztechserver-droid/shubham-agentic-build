import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Logger } from '../log.ts'
import { SpeechError } from './engine.ts'

// F-221 (order ob98a, T1): the PC voice. Live talk's page asks the PC to say one sentence in Windows' own voices and gets back a WAV and the
// time of each word in it. Why the PC and not the browser's voice: the Agentic phone app's WebView has no voice at all, and on the PC Chrome's
// echo canceller removes only what the page itself plays (the browser's voice goes from Windows straight to the speakers, so live talk would
// hear itself and cut itself off).
//
// How: one long-lived Windows PowerShell 5.1 (the helper) loads WinRT's SpeechSynthesizer once and then renders one sentence per line it
// reads: about 5-30 ms a sentence once warm, against about 0.5 s for a fresh PowerShell each time (measured 13-14 Nov on this PC). Its script
// ships here as text, as agent/agentic/pdf-pages.ts does, so the published build needs nothing else. Nothing is played on the PC and nothing
// is written to disk; the words are never logged (only lengths and timings).
// The helper starts with the first request or warm() (Talk pressed), never at the hub's start; it is let go after 10 minutes without a
// request. One request at a time: a sentence not said in 8 s ends the helper by its own process (the ChildProcess spawned here: never by
// name, never a tree), and the next request starts a fresh one. Never more than one helper (about 80-120 MB).
//
// The helper's protocol, one JSON line each way, ASCII only (every other character travels as \uXXXX, so Hindi survives whatever code page
// the console has; the real smoke test checks it both ways):
//   at start, once:                         {t:'ready', pid, voices:[{id, name, lang, gender}], default}
//   {id, text, voice?, rate?}           ->  {id, ok:true, ms, voice, voiceId, wav:<base64 RIFF WAV>, marks:[{ms, start, end}]}
//   {id, op:'voices'}                   ->  {id, ok:true, voices:[...], default}
//   {id, op:'echo', text}               ->  {id, ok:true, text}
//   anything that fails                 ->  {id, ok:false, error}
// A mark is one word: when it starts (ms from the start of the audio) and where it is in the text: text.slice(start, end).

/** The longest text one request may carry (characters): the page sends a sentence at a time. */
export const MAX_CHARS = 400
/** Requests waiting behind the one being said; one more is refused (503). */
export const MAX_WAITING = 8
/** A request the helper has not answered in this long ends it. */
export const SAY_TIMEOUT_MS = 8000
/** Starting the helper: Windows PowerShell can take seconds when the PC is busy (1.3 s measured cold, outliers of 3.7 s). */
export const START_TIMEOUT_MS = 15_000
/** The helper is let go after this long without a request. */
export const VOICE_IDLE_MS = 10 * 60_000
/** Silence at the ends of a sentence: quieter than this is silence (dBFS of 16-bit PCM), and this much of it is kept on each side. */
export const SILENCE_DBFS = -50
export const SILENCE_PAD_MS = 30
/** The word timings travel in a response header; a proxy reads at most 16 KB of headers, so a pathological sentence gets fewer of them. */
export const MAX_MARKS_HEADER = 8000

const NEEDS_WINDOWS = 'The PC voice needs Windows'

export interface Voice {
  id: string
  name: string
  /** BCP-47, as Windows says it: en-US, en-IN, hi-IN. */
  lang: string
  gender: string
}

/** One word of the text: when it starts in the returned audio (ms) and where it is: text.slice(start, end). */
export interface Mark {
  ms: number
  start: number
  end: number
}

export interface SayRequest {
  text: string
  /** A voice id from voices(); used when it is installed. */
  voice?: string
  /** A hint for text that has no letters to tell by (hi, mr: a Hindi voice). */
  lang?: string
  /** 0.5-2.0; 1 is Windows' normal speed. */
  rate?: number
}

export interface Said {
  /** A RIFF WAV (16-bit PCM), silence at its ends trimmed. */
  wav: Buffer
  marks: Mark[]
  /** The voice's name, and its id. */
  voice: string
  voiceId: string
  /** How long the helper took to render it. */
  ms: number
  audioMs: number
  sampleRate: number
}

export type VoiceState = 'off' | 'starting' | 'ready' | 'failed'

export interface VoiceStatus {
  available: boolean
  /** Why it is not available, or why it last failed. */
  why?: string
  state: VoiceState
  /** The helper's process while it runs. */
  pid: number | null
  /** How many voices Windows has (as the helper last said). */
  voices: number
  /** The last sentence's render time. */
  lastMs: number | null
}

export interface Tts {
  status(): VoiceStatus
  /** Starts the helper now (Talk was pressed), so the first sentence does not wait for it. */
  warm(): Promise<{ ok: true; state: VoiceState; ms: number }>
  voices(): Promise<{ voices: Voice[]; default: string | null }>
  /** One sentence. `signal`: the page went away; a request still waiting is dropped, never said. */
  say(r: SayRequest, signal?: AbortSignal): Promise<Said>
  /** The agent is stopping: the helper is let go, and every request after this is refused. */
  stop(): Promise<void>
}

export interface TtsDeps {
  /** Tests: a stand-in for the helper's process. */
  spawn?: (exe: string, args: string[]) => ChildProcess
  now?: () => number
  platform?: string
  log?: Logger
  sayTimeoutMs?: number
  startTimeoutMs?: number
  idleMs?: number
}

// --- the helper (Windows PowerShell 5.1) ---------------------------------------------------------------------------------------------
// String.raw: PowerShell's backslashes stay as written. The script has no backtick (it would end the template; [char]96 stands for it) and no
// dollar-brace. Uncaptured output would corrupt the protocol, so every call that returns something is assigned or [void]ed.

/** The helper's script; runs with -EncodedCommand (no quoting of anything on a command line). */
export const TTS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$opType = 'IAsyncOperation' + [char]96 + '1'
$asOp = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq $opType } | Select-Object -First 1
function Await($op, [type]$t) { $k = $asOp.MakeGenericMethod($t).Invoke($null, @($op)); $k.Wait(-1) | Out-Null; $k.Result }
function Q([string]$s) {
  $b = New-Object System.Text.StringBuilder ($s.Length + 8)
  [void]$b.Append([char]34)
  foreach ($ch in $s.ToCharArray()) {
    $n = [int]$ch
    if ($n -eq 34 -or $n -eq 92) { [void]$b.Append([char]92); [void]$b.Append($ch) }
    elseif ($n -lt 32 -or $n -gt 126) { [void]$b.Append('\u' + $n.ToString('x4')) }
    else { [void]$b.Append($ch) }
  }
  [void]$b.Append([char]34)
  $b.ToString()
}
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$synth.Options.IncludeWordBoundaryMetadata = $true
try { $synth.Options.AppendedSilence = [Windows.Media.SpeechSynthesis.SpeechAppendedSilence]::Min } catch { }
$byId = @{}
function Refresh {
  $script:byId = @{}
  foreach ($v in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) { $script:byId[$v.Id] = $v }
}
function VoiceList {
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($v in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) {
    $g = ([string]$v.Gender).ToLowerInvariant()
    $parts.Add('{"id":' + (Q $v.Id) + ',"name":' + (Q $v.DisplayName) + ',"lang":' + (Q $v.Language) + ',"gender":' + (Q $g) + '}')
  }
  $d = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::DefaultVoice
  $did = ''
  if ($null -ne $d) { $did = $d.Id }
  '"voices":[' + ($parts -join ',') + '],"default":' + (Q $did)
}
function Render([string]$text, [string]$voiceId, [double]$rate) {
  if ($voiceId -and $synth.Voice.Id -ne $voiceId) {
    $v = $byId[$voiceId]
    if ($null -eq $v) { Refresh; $v = $byId[$voiceId] }
    if ($null -ne $v) { $synth.Voice = $v }
  }
  if ($synth.Options.SpeakingRate -ne $rate) { $synth.Options.SpeakingRate = $rate }
  $stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  try {
    $size = [uint32]$stream.Size
    $r = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
    $null = Await ($r.LoadAsync($size)) ([uint32])
    $bytes = New-Object byte[] $size
    $r.ReadBytes($bytes)
    $r.Dispose()
    $marks = New-Object System.Text.StringBuilder
    foreach ($tr in $stream.TimedMetadataTracks) {
      if ([string]$tr.Id -ne 'SpeechWord') { continue }
      foreach ($c in $tr.Cues) {
        $s = $c.StartPositionInInput
        $e = $c.EndPositionInInput
        if ($null -eq $s -or $null -eq $e) { continue }
        if ($marks.Length -gt 0) { [void]$marks.Append(',') }
        [void]$marks.Append('{"ms":' + [int][Math]::Round($c.StartTime.TotalMilliseconds) + ',"start":' + [int]$s + ',"end":' + ([int]$e + 1) + '}')
      }
    }
    @{ bytes = $bytes; marks = $marks.ToString() }
  } finally {
    $stream.Dispose()
  }
}
Refresh
$null = ConvertFrom-Json '{"warm":1}'
$null = Render 'Ready.' '' 1.0
[Console]::Out.Write('{"t":"ready","pid":' + $PID + ',' + (VoiceList) + '}' + [char]10)
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = ''
  try {
    $m = ConvertFrom-Json $line
    $id = [string]$m.id
    $op = [string]$m.op
    if ($op -eq 'voices') {
      Refresh
      $out = '{"id":' + (Q $id) + ',"ok":true,' + (VoiceList) + '}'
    } elseif ($op -eq 'echo') {
      $out = '{"id":' + (Q $id) + ',"ok":true,"text":' + (Q ([string]$m.text)) + '}'
    } else {
      $rate = 1.0
      if ($null -ne $m.rate) { $rate = [double]$m.rate }
      if (-not ($rate -ge 0.5 -and $rate -le 2.0)) { $rate = 1.0 }
      $t = [System.Diagnostics.Stopwatch]::StartNew()
      $said = Render ([string]$m.text) ([string]$m.voice) $rate
      $ms = [int]$t.Elapsed.TotalMilliseconds
      $out = '{"id":' + (Q $id) + ',"ok":true,"ms":' + $ms + ',"voice":' + (Q $synth.Voice.DisplayName) + ',"voiceId":' + (Q $synth.Voice.Id) + ',"wav":"' + [Convert]::ToBase64String($said.bytes) + '","marks":[' + $said.marks + ']}'
    }
  } catch {
    $out = '{"id":' + (Q $id) + ',"ok":false,"error":' + (Q ($_.Exception.Message -replace '\s+', ' ')) + '}'
  }
  [Console]::Out.Write($out + [char]10)
  [Console]::Out.Flush()
}
`

export const HELPER_EXE = 'powershell.exe'
const ENCODED = Buffer.from(TTS_SCRIPT, 'utf16le').toString('base64')
export const HELPER_ARGS: readonly string[] = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED]

/** JSON with every character outside printable ASCII as \uXXXX: what the helper reads cannot be garbled by a console code page. */
export const asciiJson = (v: unknown): string => JSON.stringify(v).replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** What PowerShell wrote to stderr, as one short line: its CLIXML wrapping (progress records) out, the error text kept. */
export function stderrLine(raw: string): string {
  let s = raw
  if (s.includes('#< CLIXML')) {
    const errors = [...s.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map(m => m[1])
    s = errors.length ? errors.join(' ') : ''
  }
  return s
    .replace(/_x000[dDaA]_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-300)
}

// --- the voice for a sentence (pure) -------------------------------------------------------------------------------------------------

const DEVANAGARI_LETTER = /(?=\p{Script=Devanagari})\p{L}/u
const ANY_LETTER = /\p{L}/u

/**
 * The voice for a sentence (his decision 3, 14 Nov: the Windows voice packs): the voice asked for, when it is installed; otherwise by the
 * text: Devanagari letters (Hindi, Marathi) -> a hi-IN voice if there is one; English -> en-IN if there is one, else the Windows default voice,
 * else any en-* voice (else whatever there is). Of several voices of one language, the Windows default when it is one of them, else the first
 * Windows lists. `lang` only decides text with no letters at all ("500"): hi or mr -> the Hindi voice.
 */
export function chooseVoice(voices: readonly Voice[], dflt: string | null, want: { text: string; voice?: string; lang?: string }): Voice | null {
  if (want.voice) {
    const asked = voices.find(v => v.id === want.voice)
    if (asked) return asked
  }
  const of = (tag: string) => voices.filter(v => v.lang.toLowerCase() === tag)
  const best = (list: readonly Voice[]) => list.find(v => v.id === dflt) ?? list[0] ?? null
  const hindi = DEVANAGARI_LETTER.test(want.text) || (!ANY_LETTER.test(want.text) && /^(?:hi|mr)\b/i.test(want.lang ?? ''))
  if (hindi) {
    const hi = best(of('hi-in'))
    if (hi) return hi
  }
  return best(of('en-in')) ?? voices.find(v => v.id === dflt) ?? best(voices.filter(v => /^en(?:-|$)/i.test(v.lang))) ?? voices[0] ?? null
}

/** The voices the helper listed, checked (a voice without an id is left out). */
export function voiceList(raw: unknown): Voice[] {
  if (!Array.isArray(raw)) return []
  const out: Voice[] = []
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id) continue
    out.push({ id: o.id, name: typeof o.name === 'string' && o.name ? o.name : o.id, lang: typeof o.lang === 'string' ? o.lang : '', gender: typeof o.gender === 'string' ? o.gender : '' })
  }
  return out
}

/** The word timings the helper gave, checked against the text: whole numbers, inside it, in time order. */
export function cleanMarks(raw: unknown, textLength: number): Mark[] {
  if (!Array.isArray(raw)) return []
  const out: Mark[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const { ms, start, end } = m as Record<string, unknown>
    if (typeof ms !== 'number' || !Number.isFinite(ms) || !Number.isInteger(start) || !Number.isInteger(end)) continue
    const s = start as number
    const e = Math.min(end as number, textLength)
    if (s < 0 || e <= s) continue
    out.push({ ms: Math.max(0, Math.round(ms)), start: s, end: e })
  }
  return out.sort((a, b) => a.ms - b.ms || a.start - b.start)
}

// --- the audio (pure) ----------------------------------------------------------------------------------------------------------------

export interface WavShape {
  format: number
  channels: number
  rate: number
  bits: number
  data: Buffer
}

/** A RIFF WAV's format and its samples; null when it is not one. WinRT writes an 18-byte fmt chunk (a 46-byte header): any chunk layout is read. */
export function readWav(buf: Buffer): WavShape | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let fmt: Omit<WavShape, 'data'> | null = null
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) return null
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
    } else if (id === 'data') {
      if (!fmt) return null
      return { ...fmt, data: buf.subarray(body, Math.min(buf.length, body + size)) }
    }
    at = body + size + (size % 2)
  }
  return null
}

/** A plain 44-byte-header PCM WAV around these samples. */
export function wavFrom(data: Buffer, s: { channels: number; rate: number; bits: number }): Buffer {
  const block = s.channels * (s.bits / 8)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(s.channels, 22)
  h.writeUInt32LE(s.rate, 24)
  h.writeUInt32LE(s.rate * block, 28)
  h.writeUInt16LE(block, 32)
  h.writeUInt16LE(s.bits, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

/**
 * The silence at both ends of a sentence cut off (Windows leaves about 0.1 s before the first word, and more after the last), keeping
 * SILENCE_PAD_MS of it on each side, so sentences played one after another do not leave gaps; the marks move with the start. 16-bit PCM only:
 * any other WAV comes back as it was. Nothing to hear (all quiet, or no samples at all: an English voice given only Devanagari says nothing,
 * measured 14 Nov): a moment of silence, still a WAV the page can play. Null when it is not a WAV.
 */
export function trimSilence(wav: Buffer, marks: readonly Mark[], o: { dbfs?: number; padMs?: number } = {}): { wav: Buffer; marks: Mark[]; leadMs: number; audioMs: number; rate: number } | null {
  const w = readWav(wav)
  if (!w) return null
  const { channels, rate, bits } = w
  const block = channels * (bits / 8)
  const frames = block > 0 ? Math.floor(w.data.length / block) : 0
  if (!((w.format === 1 || w.format === 0xfffe) && bits === 16 && channels >= 1 && rate > 0)) {
    return { wav, marks: [...marks], leadMs: 0, audioMs: rate > 0 ? Math.round((frames * 1000) / rate) : 0, rate }
  }
  const limit = 32768 * 10 ** ((o.dbfs ?? SILENCE_DBFS) / 20)
  const loud = (f: number) => {
    for (let ch = 0; ch < channels; ch++) if (Math.abs(w.data.readInt16LE(f * block + ch * 2)) > limit) return true
    return false
  }
  const pad = Math.round(((o.padMs ?? SILENCE_PAD_MS) * rate) / 1000)
  let first = 0
  while (first < frames && !loud(first)) first++
  if (first === frames) {
    const audioMs = Math.round((pad * 1000) / rate)
    return { wav: wavFrom(Buffer.alloc(pad * block), { channels, rate, bits }), marks: marks.map(m => ({ ...m, ms: Math.min(audioMs, m.ms) })), leadMs: 0, audioMs, rate }
  }
  let last = frames - 1
  while (last > first && !loud(last)) last--
  const from = Math.max(0, first - pad)
  const to = Math.min(frames, last + 1 + pad)
  const lead = (from * 1000) / rate
  const audioMs = Math.round(((to - from) * 1000) / rate)
  return {
    wav: wavFrom(w.data.subarray(from * block, to * block), { channels, rate, bits }),
    marks: marks.map(m => ({ ...m, ms: Math.min(audioMs, Math.max(0, Math.round(m.ms - lead))) })),
    leadMs: Math.round(lead),
    audioMs,
    rate,
  }
}

/** The word timings as the X-Speech-Marks header carries them: encodeURIComponent of their JSON, as many as fit in MAX_MARKS_HEADER. */
export function marksHeader(marks: readonly Mark[]): string {
  let n = marks.length
  let v = encodeURIComponent(JSON.stringify(marks))
  while (v.length > MAX_MARKS_HEADER && n > 0) {
    n = Math.floor(n * 0.75)
    v = encodeURIComponent(JSON.stringify(marks.slice(0, n)))
  }
  return v
}

// --- the PC voice ------------------------------------------------------------------------------------------------------------------

interface Answer {
  ok?: unknown
  error?: unknown
  [k: string]: unknown
}

interface Job {
  run(): Promise<unknown>
  resolve(v: unknown): void
  reject(e: unknown): void
  signal?: AbortSignal
  leave?: () => void
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const dropped = () => SpeechError('The page went away before the PC voice started on it', 499)
const rateOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(2, Math.max(0.5, v)) : 1)

export function createTts(d: TtsDeps = {}): Tts {
  const windows = (d.platform ?? process.platform) === 'win32'
  const now = d.now ?? Date.now
  const log = d.log
  const sayTimeoutMs = d.sayTimeoutMs ?? SAY_TIMEOUT_MS
  const startTimeoutMs = d.startTimeoutMs ?? START_TIMEOUT_MS
  const idleMs = d.idleMs ?? VOICE_IDLE_MS
  const spawnHelper = d.spawn ?? ((exe: string, args: string[]) => nodeSpawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }))

  let state: VoiceState = 'off'
  let why: string | undefined
  /** The helper (starting or ready); null when there is none. */
  let child: ChildProcess | null = null
  let ready = false
  let starting: Promise<ChildProcess> | null = null
  /** A helper on its way out: the next one starts only after it has gone (never two at once). */
  let ending: Promise<void> | null = null
  const exited = new WeakMap<ChildProcess, Promise<void>>()
  let voices: Voice[] = []
  let dflt: string | null = null
  let lastMs: number | null = null
  let idle: NodeJS.Timeout | null = null
  let stopped = false
  let seq = 0
  let asking: { id: string; c: ChildProcess; done(a: Answer | Error): void } | null = null
  let readyWait: { c: ChildProcess; done(e?: Error): void } | null = null
  const queue: Job[] = []
  let busy = false

  function check() {
    if (!windows) throw SpeechError(NEEDS_WINDOWS, 503)
    if (stopped) throw SpeechError('The PC voice is stopping', 503)
  }

  function setVoices(raw: unknown, def: unknown) {
    voices = voiceList(raw)
    dflt = typeof def === 'string' && def ? def : null
  }

  // One request at a time; the rest wait (MAX_WAITING of them). A waiting request whose page went away leaves the queue at once.
  function enqueue<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(dropped())
      if (busy && queue.length >= MAX_WAITING) return reject(SpeechError('The PC voice is busy: try again in a moment', 503))
      const job: Job = { run, resolve: v => resolve(v as T), reject, signal }
      if (signal) {
        job.leave = () => {
          const i = queue.indexOf(job)
          if (i < 0) return
          queue.splice(i, 1)
          reject(dropped())
        }
        signal.addEventListener('abort', job.leave, { once: true })
      }
      queue.push(job)
      pump()
    })
  }

  function pump() {
    if (busy) return
    const job = queue.shift()
    if (!job) return
    busy = true
    if (job.leave) job.signal?.removeEventListener('abort', job.leave)
    job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        busy = false
        touch()
        pump()
      })
  }

  /** The idle timer, from now: let go after idleMs without a request. */
  function touch() {
    if (idle) clearTimeout(idle)
    idle = null
    if (!child || stopped) return
    idle = setTimeout(() => {
      idle = null
      if (busy || queue.length) return touch()
      letGo('idle')
    }, idleMs)
    idle.unref?.()
  }

  /** Ends the helper the gentle way: its input closes and it exits by itself; if it has not in 3 s, its own process is ended. */
  function letGo(reason: string) {
    const c = child
    if (!c) return
    child = null
    ready = false
    state = 'off'
    log?.info(`speech: the PC voice was let go (${reason})`)
    ending = exited.get(c) ?? null
    try {
      c.stdin?.end()
    } catch {
      /* it has gone already */
    }
    const hard = setTimeout(() => {
      if (c.exitCode === null && c.signalCode === null) c.kill()
    }, 3000)
    hard.unref?.()
    void ending?.then(() => clearTimeout(hard))
  }

  /** Ends the helper at once: by the ChildProcess spawned here (its exact PID), never by name, never a tree. */
  function endNow(c: ChildProcess, reason: string) {
    if (child === c) {
      child = null
      ready = false
    }
    ending = exited.get(c) ?? null
    log?.warn(`speech: ${reason}: ending the PC voice's process (PID ${c.pid})`)
    c.kill()
  }

  function helper(): Promise<ChildProcess> {
    if (child && ready) return Promise.resolve(child)
    starting ??= start().finally(() => {
      starting = null
    })
    return starting
  }

  async function start(): Promise<ChildProcess> {
    // The one before has to be gone first (a process Windows will not end in 5 s is left to it, with a line in the log).
    if (ending) {
      const late = await Promise.race([ending.then(() => false), new Promise<boolean>(r => setTimeout(() => r(true), 5000).unref?.())])
      if (late) log?.warn('speech: the PC voice before this one has not ended after 5 s; starting a new one all the same')
      ending = null
    }
    if (stopped) throw SpeechError('The PC voice is stopping', 503)
    state = 'starting'
    why = undefined
    const t0 = now()
    let c: ChildProcess
    try {
      c = spawnHelper(HELPER_EXE, [...HELPER_ARGS])
    } catch (e) {
      state = 'failed'
      why = `The PC voice could not start: ${message(e)}`
      log?.warn(`speech: ${why}`)
      throw SpeechError(why, 503)
    }
    child = c
    let tail = ''
    exited.set(
      c,
      new Promise<void>(resolve => {
        let over = false
        const end = (how: string) => {
          if (over) return
          over = true
          gone(c, how, stderrLine(tail))
          resolve()
        }
        // 'close', not 'exit': by then every line it wrote has been read (an answer written just before it ended is not lost).
        c.once('close', (code: number | null, signal: string | null) => end(signal ? `signal ${signal}` : `exit ${code ?? '?'}`))
        // An 'error' is a process that never started, or one that could not be ended (that one is still there: it stays the helper).
        c.on('error', e => {
          if (c.pid === undefined || c.exitCode !== null) end(message(e))
          else log?.warn(`speech: the PC voice's process (PID ${c.pid}): ${message(e)}`)
        })
      }),
    )
    c.stdin?.on('error', () => {})
    c.stderr?.on('data', (b: Buffer | string) => {
      tail = (tail + String(b)).slice(-4000)
    })
    if (c.stdout) createInterface({ input: c.stdout, crlfDelay: Infinity }).on('line', l => heard(c, l))
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          readyWait = null
          endNow(c, `the PC voice did not start in ${startTimeoutMs / 1000} s`)
          reject(SpeechError(`The PC voice did not start in ${startTimeoutMs / 1000} s`, 503))
        }, startTimeoutMs)
        readyWait = {
          c,
          done: e => {
            clearTimeout(timer)
            readyWait = null
            if (e) reject(e)
            else resolve()
          },
        }
      })
    } catch (e) {
      state = 'failed'
      why = message(e)
      throw e
    }
    // Let go (the agent stopping) while it started.
    if (child !== c) throw SpeechError('The PC voice is stopping', 503)
    ready = true
    state = 'ready'
    log?.info(`speech: the PC voice is ready in ${now() - t0} ms (PID ${c.pid}, ${voices.length} voices)`)
    touch()
    return c
  }

  /** A line from a helper. */
  function heard(c: ChildProcess, line: string) {
    let m: Answer
    try {
      m = JSON.parse(line) as Answer
    } catch {
      log?.debug('speech: the PC voice wrote a line that is not JSON (left out)')
      return
    }
    if (!m || typeof m !== 'object') return
    if (m.t === 'ready') {
      if (!readyWait || readyWait.c !== c) return
      setVoices(m.voices, m.default)
      readyWait.done()
      return
    }
    if (asking && asking.c === c && String(m.id) === asking.id) asking.done(m)
  }

  /** A helper ended: if it was not let go or ended on purpose, it stopped by itself. */
  function gone(c: ChildProcess, how: string, stderr: string) {
    const detail = stderr ? `${how}: ${stderr}` : how
    if (child === c) {
      child = null
      ready = false
      state = 'failed'
      why = `The PC voice stopped (${detail})`
      log?.warn(`speech: ${why}`)
    }
    if (readyWait?.c === c) readyWait.done(SpeechError(`The PC voice could not start (${detail})`, 503))
    if (asking?.c === c) asking.done(SpeechError('The PC voice stopped before it had said it', 502))
  }

  /** One request to the helper and its answer; not answered in sayTimeoutMs: the helper is ended (the next request starts a fresh one). */
  function ask(c: ChildProcess, msg: Record<string, unknown>): Promise<Answer> {
    return new Promise<Answer>((resolve, reject) => {
      // It ended between being ready and this request: no line can reach it.
      if (child !== c) return reject(SpeechError('The PC voice stopped before it had said it', 502))
      const id = String(++seq)
      const timer = setTimeout(() => {
        if (asking?.id !== id) return
        asking = null
        state = 'failed'
        why = `The PC voice did not answer in ${sayTimeoutMs / 1000} s`
        endNow(c, why)
        reject(SpeechError(`The PC voice took too long (over ${sayTimeoutMs / 1000} s); it starts again with the next sentence`, 504))
      }, sayTimeoutMs)
      asking = {
        id,
        c,
        done: a => {
          clearTimeout(timer)
          asking = null
          if (a instanceof Error) reject(a)
          else resolve(a)
        },
      }
      try {
        if (!c.stdin) throw new Error('no input')
        c.stdin.write(`${asciiJson({ id, ...msg })}\n`)
      } catch (e) {
        asking.done(SpeechError(`The PC voice could not be asked: ${message(e)}`, 502))
      }
    })
  }

  return {
    status() {
      if (!windows) return { available: false, why: NEEDS_WINDOWS, state: 'off', pid: null, voices: 0, lastMs: null }
      return { available: true, ...(state === 'failed' && why ? { why } : {}), state, pid: child?.pid ?? null, voices: voices.length, lastMs }
    },

    async warm() {
      check()
      const t0 = now()
      await helper()
      touch()
      return { ok: true, state, ms: now() - t0 }
    },

    async voices() {
      check()
      return enqueue(async () => {
        const a = await ask(await helper(), { op: 'voices' })
        if (a.ok !== true) throw SpeechError(`The PC voice could not list its voices: ${String(a.error ?? 'no reason given').slice(0, 300)}`, 502)
        setVoices(a.voices, a.default)
        return { voices: [...voices], default: dflt }
      })
    },

    async say(r, signal) {
      check()
      const text = typeof r.text === 'string' ? r.text : ''
      if (!text.trim()) throw SpeechError('Nothing to say', 400)
      if (text.length > MAX_CHARS) throw SpeechError(`Up to ${MAX_CHARS} characters at a time: send it a sentence at a time`, 413)
      const rate = rateOf(r.rate)
      return enqueue(async () => {
        const c = await helper()
        const v = chooseVoice(voices, dflt, { text, voice: r.voice, lang: r.lang })
        const t0 = now()
        const a = await ask(c, { text, ...(v ? { voice: v.id } : {}), rate })
        if (a.ok !== true) throw SpeechError(`The PC voice could not say it: ${String(a.error ?? 'no reason given').slice(0, 300)}`, 502)
        const t = trimSilence(typeof a.wav === 'string' ? Buffer.from(a.wav, 'base64') : Buffer.alloc(0), cleanMarks(a.marks, text.length))
        if (!t) throw SpeechError('The PC voice gave no audio', 502)
        const ms = typeof a.ms === 'number' && Number.isFinite(a.ms) ? Math.max(0, Math.round(a.ms)) : now() - t0
        lastMs = ms
        log?.debug(`speech: the PC voice said ${text.length} characters: render ${ms} ms, round trip ${now() - t0} ms, audio ${t.audioMs} ms, ${t.marks.length} words`)
        return {
          wav: t.wav,
          marks: t.marks,
          voice: typeof a.voice === 'string' && a.voice ? a.voice : (v?.name ?? ''),
          voiceId: typeof a.voiceId === 'string' && a.voiceId ? a.voiceId : (v?.id ?? ''),
          ms,
          audioMs: t.audioMs,
          sampleRate: t.rate,
        }
      }, signal)
    },

    async stop() {
      stopped = true
      if (idle) clearTimeout(idle)
      idle = null
      for (const j of queue.splice(0)) j.reject(SpeechError('The PC voice is stopping', 503))
      letGo('the agent is stopping')
      if (ending) await ending
    },
  }
}
