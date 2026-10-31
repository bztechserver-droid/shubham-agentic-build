import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { statePaths } from '../config.ts'
import { log as rootLog, type Logger } from '../log.ts'
import { flvReader, ivfReader, type EncodedFrame } from './frames.ts'

// FFmpeg does the app's own screen's capture and compression (F-006), the way RustDesk does
// both: Windows' Desktop Duplication through FFmpeg's ddagrab filter (RustDesk's scrap,
// libs/scrap/src/common/dxgi.rs), and the graphics chip's H.264 encoder through FFmpeg (RustDesk's
// hwcodec library, which its vcpkg.json builds FFmpeg with qsv, nvcodec and amf for), else x264
// or libvpx's VP9 in software (RustDesk's vpxcodec.rs). One ffmpeg process per screen shown; its
// output is cut into frames by frames.ts. Nothing is installed: setup:screen puts one pinned,
// checksummed ffmpeg.exe in %LOCALAPPDATA%\shubham-agentic\ffmpeg.

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const run = promisify(execFile)
const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')

// --- the program -----------------------------------------------------------------------------

export interface FfmpegRelease {
  version: string
  url: string
  /** The zip's size and sha256. */
  size: number
  sha256: string
  /** Inside the zip: ffmpeg.exe's path and size. */
  exePath: string
  exeSize: number
}

/** Gyan's "essentials" build (GPL), mirrored on GitHub with versioned, permanent URLs. */
export const FFMPEG: FfmpegRelease = {
  version: '9.0.2',
  url: 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip',
  size: 114_768_076,
  sha256: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba',
  exePath: 'ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe',
  exeSize: 105_423_872,
}

const sizeOf = (file: string) => {
  try {
    return statSync(file).size
  } catch {
    return -1
  }
}

/**
 * ffmpeg.exe for the app's own screen: SAD_FFMPEG when set (tests), else the pinned copy
 * setup:screen put in place, recognised by its size. Null when there is none.
 */
export function findFfmpeg(env: Record<string, string | undefined> = process.env, release: FfmpegRelease = FFMPEG): string | null {
  if (env.SAD_FFMPEG) return existsSync(env.SAD_FFMPEG) ? env.SAD_FFMPEG : null
  const exe = path.join(statePaths(undefined, env).ffmpegBin, 'ffmpeg.exe')
  return sizeOf(exe) === release.exeSize ? exe : null
}

export interface EnsureFfmpegOptions {
  /** Where ffmpeg.exe goes. Default: %LOCALAPPDATA%\shubham-agentic\ffmpeg. */
  dir?: string
  /** A copy of the release zip you already have; it is checked the same way. */
  zip?: string
  log?: Logger
  /** Download progress, 0..1. */
  progress?: (done: number) => void
  release?: FfmpegRelease
}

async function download(release: FfmpegRelease, log: Logger, progress?: (done: number) => void): Promise<Buffer> {
  log.info(`downloading FFmpeg ${release.version} (${(release.size / 1e6).toFixed(0)} MB) from ${release.url}`)
  const res = await fetch(release.url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000) })
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${release.url}`)
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared && declared !== release.size) throw new Error(`Refusing the download: ${declared} bytes, expected ${release.size}`)
  // Collected with a cap, so a wrong or hostile answer can't fill memory.
  const chunks: Buffer[] = []
  let size = 0
  let shown = 0
  for await (const chunk of res.body) {
    size += chunk.byteLength
    if (size > release.size) throw new Error(`Refusing the download: more than ${release.size} bytes`)
    chunks.push(Buffer.from(chunk))
    progress?.(size / release.size)
    if (size / release.size >= shown + 0.2) {
      shown += 0.2
      log.info(`downloaded ${Math.round((100 * size) / release.size)}%`)
    }
  }
  return Buffer.concat(chunks)
}

/**
 * Makes sure the pinned ffmpeg.exe is in `dir` (npm run setup:screen, or the Devices page's
 * Set up). Skips when it is there with the right size; otherwise downloads the zip, refuses it
 * on any size or sha256 mismatch, extracts ffmpeg.exe and its LICENSE with Windows' tar.exe in
 * a temp folder, and moves them in.
 */
export async function ensureFfmpeg(opts: EnsureFfmpegOptions = {}): Promise<{ exe: string; fetched: boolean }> {
  const release = opts.release ?? FFMPEG
  const log = opts.log ?? rootLog.child('setup')
  const dir = opts.dir ?? statePaths().ffmpegBin
  const exe = path.join(dir, 'ffmpeg.exe')
  if (sizeOf(exe) === release.exeSize) return { exe, fetched: false }

  const data = opts.zip ? readFileSync(opts.zip) : await download(release, log, opts.progress)
  const from = opts.zip ?? 'the download'
  if (data.length !== release.size) throw new Error(`Refusing ${from}: ${data.length} bytes, expected ${release.size}`)
  const sha256 = createHash('sha256').update(data).digest('hex')
  if (sha256 !== release.sha256) throw new Error(`Refusing ${from}: sha256 ${sha256}, expected ${release.sha256}`)

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sad-ffmpeg-'))
  try {
    const zip = path.join(tmp, 'ffmpeg.zip')
    const extracted = path.join(tmp, 'x')
    writeFileSync(zip, data)
    mkdirSync(extracted)
    const root = release.exePath.split('/')[0]
    await run(TAR, ['-xf', zip, '-C', extracted, release.exePath, `${root}/LICENSE`], { windowsHide: true })
    const found = path.join(extracted, ...release.exePath.split('/'))
    const actual = sizeOf(found)
    if (actual !== release.exeSize) throw new Error(`ffmpeg.exe in the zip is ${actual} bytes, expected ${release.exeSize}`)
    mkdirSync(dir, { recursive: true })
    // Copied beside, then renamed: a half-copied exe never has the real name.
    copyFileSync(found, `${exe}.part`)
    renameSync(`${exe}.part`, exe)
    const license = path.join(extracted, root, 'LICENSE')
    if (existsSync(license)) copyFileSync(license, path.join(dir, 'LICENSE.txt'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  log.info(`ffmpeg.exe ${release.version} verified and copied to ${dir}`)
  return { exe, fetched: true }
}

// --- encoders --------------------------------------------------------------------------------

export type Encoder = 'h264_qsv' | 'h264_nvenc' | 'h264_amf' | 'h264_mf' | 'libx264' | 'libvpx-vp9'
export type Codec = 'h264' | 'vp9'

export const codecOf = (e: Encoder): Codec => (e === 'libvpx-vp9' ? 'vp9' : 'h264')

/** PCI vendor IDs, from the DXGI adapter that drives the display. */
export const VENDOR = { intel: 0x8086, nvidia: 0x10de, amd: 0x1002 } as const

/**
 * The encoders worth trying, best first. H.264: the display's own graphics chip (Intel Quick
 * Sync, NVIDIA NVENC, AMD AMF), then Windows' Media Foundation (whichever hardware encoder it
 * finds), then x264 on the processor. VP9 only for a viewer that can't decode H.264.
 */
export function encodersFor(codec: Codec, vendorId: number | null): Encoder[] {
  if (codec === 'vp9') return ['libvpx-vp9']
  const chip: Encoder | null =
    vendorId === VENDOR.intel ? 'h264_qsv' : vendorId === VENDOR.nvidia ? 'h264_nvenc' : vendorId === VENDOR.amd ? 'h264_amf' : null
  return [...(chip ? [chip] : []), 'h264_mf', 'libx264']
}

/** About 0.09 bit per pixel per frame: 6 Mbit/s for 1920×1200 at 30 fps; 2 to 16 Mbit/s. */
export function bitrateFor(width: number, height: number, fps: number): number {
  return Math.round(Math.min(16e6, Math.max(2e6, width * height * fps * 0.09)))
}

/** A keyframe every 2 s: a viewer that lost one waits at most that long without asking. */
export const GOP_SECONDS = 2

export interface CaptureSpec {
  exe: string
  encoder: Encoder
  /** The DXGI adapter that drives the display, and the display's index on it (ddagrab's output_idx). */
  adapter: number
  output: number
  fps: number
  /** Bits per second. */
  bitrate: number
  /** Draw the pointer into the picture (used when its shape can't be sent on its own). */
  drawMouse: boolean
  /** Tests: FFmpeg's moving test pattern at this size, instead of the screen. */
  pattern?: { width: number; height: number }
}

/** The ffmpeg command line for one capture (pure, for the tests). */
export function captureArgs(s: CaptureSpec): string[] {
  const n = (v: number) => String(Math.round(v))
  const gop = n(s.fps * GOP_SECONDS)
  const b = s.bitrate
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']

  if (s.pattern) {
    // System-memory frames: every encoder here takes nv12 or yuv420p uploads.
    const fmt = s.encoder === 'libx264' || s.encoder === 'libvpx-vp9' ? 'yuv420p' : 'nv12'
    args.push('-f', 'lavfi', '-i', `testsrc2=size=${s.pattern.width}x${s.pattern.height}:rate=${s.fps}`, '-vf', `format=${fmt}`)
  } else {
    // ddagrab gives D3D11 frames on the adapter named here; the encoder takes them on the GPU
    // (Quick Sync through a QSV mapping; NVENC and AMF directly), or they come down to memory.
    const grab = `ddagrab=output_idx=${s.output}:framerate=${s.fps}:draw_mouse=${s.drawMouse ? 1 : 0}`
    const after: Record<Encoder, string> = {
      h264_qsv: 'hwmap=derive_device=qsv,format=qsv',
      h264_nvenc: '',
      h264_amf: '',
      h264_mf: 'hwdownload,format=bgra,format=nv12',
      libx264: 'hwdownload,format=bgra,format=yuv420p',
      'libvpx-vp9': 'hwdownload,format=bgra,format=yuv420p',
    }
    const chain = after[s.encoder]
    args.push('-init_hw_device', `d3d11va=screen:${s.adapter}`, '-filter_hw_device', 'screen', '-filter_complex', chain ? `${grab},${chain}` : grab)
  }
  args.push('-an', '-sn', '-dn', '-fps_mode', 'passthrough')

  // No B-frames anywhere: a frame is sent the moment it is encoded (RustDesk: the same).
  switch (s.encoder) {
    case 'h264_qsv':
      args.push('-c:v', 'h264_qsv', '-preset', 'veryfast', '-scenario', 'displayremoting', '-look_ahead', '0', '-async_depth', '1')
      args.push('-bf', '0', '-g', gop, '-b:v', n(b), '-maxrate', n(b * 2), '-bufsize', n(b))
      break
    case 'h264_nvenc':
      args.push('-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-delay', '0', '-rc', 'cbr')
      args.push('-bf', '0', '-g', gop, '-b:v', n(b), '-bufsize', n(b / 2))
      break
    case 'h264_amf':
      args.push('-c:v', 'h264_amf', '-usage', 'ultralowlatency', '-quality', 'speed', '-latency', '1', '-rc', 'cbr')
      args.push('-bf', '0', '-g', gop, '-b:v', n(b))
      break
    case 'h264_mf':
      args.push('-c:v', 'h264_mf', '-hw_encoding', '1', '-scenario', 'display_remoting', '-rate_control', 'cbr')
      args.push('-bf', '0', '-g', gop, '-b:v', n(b))
      break
    case 'libx264':
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-sc_threshold', '0')
      args.push('-bf', '0', '-g', gop, '-b:v', n(b), '-maxrate', n(b), '-bufsize', n(b / 2))
      break
    case 'libvpx-vp9':
      args.push('-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-tile-columns', '2')
      args.push('-lag-in-frames', '0', '-error-resilient', '1', '-g', gop, '-b:v', n(b))
      break
  }

  // Every packet straight out; FLV and IVF give each frame its length (frames.ts).
  args.push('-flush_packets', '1')
  if (codecOf(s.encoder) === 'h264') args.push('-flvflags', '+no_duration_filesize+no_metadata', '-f', 'flv')
  else args.push('-f', 'ivf')
  args.push('pipe:1')
  return args
}

// --- one capture -----------------------------------------------------------------------------

export interface CaptureEvents {
  frame(f: EncodedFrame): void
  /** ffmpeg ended without being stopped, or gave no picture in time: why, and how many frames it had sent. */
  failed(reason: string, frames: number): void
}

export interface Capture {
  readonly encoder: Encoder
  stop(): void
}

/** No first frame within this long and the capture has failed (QSV and ddagrab start in about 1 s). */
const FIRST_FRAME_MS = 8000

/** Starts ffmpeg for `spec`; frames come out as they are encoded. */
export function startCapture(spec: CaptureSpec, ev: CaptureEvents, log?: Logger): Capture {
  const child = spawn(spec.exe, captureArgs(spec), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const reader = codecOf(spec.encoder) === 'vp9' ? ivfReader() : flvReader()
  let done = false
  let frames = 0
  let errors = ''

  const end = (why: string | null) => {
    if (done) return
    done = true
    clearTimeout(timer)
    child.kill()
    if (why !== null) ev.failed(why, frames)
  }
  const timer = setTimeout(() => end(`no picture within ${FIRST_FRAME_MS / 1000} s`), FIRST_FRAME_MS)

  child.stdout.on('data', (chunk: Buffer) => {
    if (done) return
    let out: EncodedFrame[]
    try {
      out = reader.push(chunk)
    } catch (e) {
      return end(`unreadable output from ffmpeg: ${message(e)}`)
    }
    if (out.length && frames === 0) {
      clearTimeout(timer)
      log?.debug(`${spec.encoder}: first frame`)
    }
    for (const f of out) {
      frames++
      ev.frame(f)
      if (done) return
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    errors = (errors + chunk.toString('utf8')).slice(-4000)
  })
  child.on('error', e => end(`ffmpeg could not start: ${e.message}`))
  child.on('exit', (code, signal) => {
    const last = errors.trim().split(/\r?\n/).filter(Boolean).at(-1)
    end(last ? `ffmpeg stopped: ${last}` : `ffmpeg stopped (${code ?? signal})`)
  })
  return { encoder: spec.encoder, stop: () => end(null) }
}

export interface ScreenTarget {
  adapter: number
  output: number
  /** The adapter's PCI vendor, for the encoder choice; null when unknown. */
  vendorId: number | null
  width: number
  height: number
}

export interface ScreenCaptureOptions {
  exe: string
  fps?: number
  drawMouse: boolean
  log?: Logger
  /** Tests: the test pattern instead of the screen. */
  pattern?: boolean
}

/** Encoders that produced a picture on this vendor's chip, so later screens start with them. */
const proven = new Map<string, Encoder>()

/**
 * Starts capturing `target` in `codec`, trying the encoders in order until one gives a picture
 * (one that fails before its first frame moves on to the next; one that fails later is
 * reported). The encoder that worked is tried first next time.
 */
export function startScreenCapture(target: ScreenTarget, codec: Codec, o: ScreenCaptureOptions, ev: CaptureEvents & { started?(encoder: Encoder): void }): Capture {
  const fps = o.fps ?? 30
  const key = `${codec}:${target.vendorId ?? 'none'}`
  const order = encodersFor(codec, target.vendorId)
  const first = proven.get(key)
  const chain = first ? [first, ...order.filter(e => e !== first)] : order
  let current: Capture | null = null
  let stopped = false
  let tried: string[] = []

  const attempt = (i: number) => {
    if (stopped) return
    const encoder = chain[i]
    let started = false
    current = startCapture(
      {
        exe: o.exe,
        encoder,
        adapter: target.adapter,
        output: target.output,
        fps,
        bitrate: bitrateFor(target.width, target.height, fps),
        drawMouse: o.drawMouse,
        pattern: o.pattern ? { width: target.width, height: target.height } : undefined,
      },
      {
        frame: f => {
          if (!started) {
            started = true
            proven.set(key, encoder)
            o.log?.info(`capturing display ${target.output} on adapter ${target.adapter} with ${encoder}`)
            ev.started?.(encoder)
          }
          ev.frame(f)
        },
        failed: (why, frames) => {
          if (stopped) return
          if (frames === 0 && i + 1 < chain.length) {
            tried = [...tried, `${encoder}: ${why}`]
            o.log?.info(`${encoder} gave no picture (${why}); trying ${chain[i + 1]}`)
            if (proven.get(key) === encoder) proven.delete(key)
            return attempt(i + 1)
          }
          ev.failed(frames === 0 ? [...tried, `${encoder}: ${why}`].join('; ') : why, frames)
        },
      },
      o.log,
    )
  }
  attempt(0)
  return {
    get encoder() {
      return current?.encoder ?? chain[0]
    },
    stop() {
      stopped = true
      current?.stop()
    },
  }
}
