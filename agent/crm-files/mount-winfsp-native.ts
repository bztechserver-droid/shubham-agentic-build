import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { access } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { CRM_FILES_REASONS, type CrmMountStatus } from '../../shared/crm-files.ts'
import type { CrmFilesService } from './service.ts'
import { answerBridgeRequest, newBridgeBuffers, type BridgeBuffers, type BridgeRequest } from './winfsp-bridge.ts'
import { createCrmFsHandler } from './winfsp-crm.ts'
import { WINFSP_DLL } from './winfsp-native.ts'

// o6e65 S9a: the in-process WinFsp drive as a mount backend (the DEFAULT way of the Windows drive): the agent loads the installed, signed WinFsp through koffi in a WORKER THREAD, which serves a
// letter whose files come from the CRM files service. No program of ours is run (so Smart App Control has nothing to block), no WebDAV (no 50 MB limit). READ-ONLY until the write-back queue (S9b).
//
// Rules kept here: the letter is never asked with a synchronous file call (WinFsp's callbacks need THIS process's event loop, so such a call would wait for itself): the same async, time-boxed,
// remembered check as the built-in WebDAV way; the worker is ended with a message (WinFsp stops cleanly), and when the agent itself stops or crashes WinFsp takes the drive away with the process.

export interface WorkerLike {
  postMessage(value: unknown): void
  on(event: 'message' | 'error' | 'exit', listener: (...a: never[]) => void): unknown
  terminate(): Promise<number> | void
}

export interface NativeOptions {
  letter: string
  service: () => CrmFilesService | null
  log?: { info(m: string): void; warn(m: string): void }
  dll?: string
  /**
   * S9a2, the crash breaker: a file written when the in-app drive starts (with the start time and this process's id) and removed when it ends cleanly. The drive lives INSIDE the agent's process, so a
   * native fault would end the agent; the file is then still there at the next start, which tells mount-win.ts to keep the in-app way OFF instead of looping.
   */
  markerFile?: string
  /** Tests: another worker (a fake), and the file system's answers about the letter. */
  createWorker?: (data: { bufs: BridgeBuffers; letter: string; dll: string; label: string }) => WorkerLike
  exists?: (letter: string) => Promise<boolean>
  startMs?: number
  stopMs?: number
  answerMs?: number
  cacheMs?: number
}

export type NativeStart = { ok: true } | { ok: false; reason: string; code: NonNullable<CrmMountStatus['reasonCode']> }

export function createWinNative(o: NativeOptions) {
  const letter = o.letter.toUpperCase()
  if (!/^[A-Z]:$/.test(letter)) throw new Error('a drive letter looks like "Y:"')
  const dll = o.dll ?? WINFSP_DLL
  const startMs = o.startMs ?? 20_000
  const stopMs = o.stopMs ?? 8_000
  const answerMs = o.answerMs ?? 1500
  const cacheMs = o.cacheMs ?? 10_000
  const existsAsync = o.exists ?? ((l: string) => access(`${l}\\`).then(() => true, () => false))
  let worker: WorkerLike | null = null
  let ready = false
  let exited = false
  let ending = false
  let starting: Promise<NativeStart> | null = null
  let remembered: { at: number; value: boolean } | null = null

  const make = (data: { bufs: BridgeBuffers; letter: string; dll: string; label: string }): WorkerLike => new Worker(new URL('./winfsp-worker.ts', import.meta.url), { workerData: data }) as unknown as WorkerLike

  const writeMarker = () => {
    if (!o.markerFile) return
    try {
      mkdirSync(path.dirname(o.markerFile), { recursive: true })
      writeFileSync(o.markerFile, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid, letter }))
    } catch (e) {
      o.log?.warn(`crm drive: could not write the in-app drive's marker (${(e as Error).message})`)
    }
  }
  const removeMarker = () => {
    if (!o.markerFile) return
    try {
      rmSync(o.markerFile, { force: true })
    } catch {
      // a marker that cannot be removed only keeps the in-app way off: the safe side
    }
  }

  /** Is WinFsp (its signed driver library) on this PC? */
  const available = () => existsSync(dll)

  /** Does the letter answer? Async, time-boxed, remembered (see the header). */
  async function answers(): Promise<boolean> {
    if (remembered && Date.now() - remembered.at < cacheMs) return remembered.value
    let timer: ReturnType<typeof setTimeout> | undefined
    const value = await Promise.race([
      existsAsync(letter).catch(() => false),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), answerMs)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
    remembered = { at: Date.now(), value }
    return value
  }

  function start(): Promise<NativeStart> {
    if (ready && !exited) return Promise.resolve({ ok: true })
    starting ??= (async (): Promise<NativeStart> => {
      if (!available()) return { ok: false, reason: CRM_FILES_REASONS.winfspMissing, code: 'driver-missing' }
      remembered = null
      if (await answers()) return { ok: false, reason: CRM_FILES_REASONS.letterTaken.replace('Y:', letter), code: 'letter-taken' }
      const bufs = newBridgeBuffers()
      const handler = createCrmFsHandler(o.service)
      ready = false
      exited = false
      // From here until a clean end the marker says "the in-app drive is (being) served by this process".
      writeMarker()
      const w = (worker = (o.createWorker ?? make)({ bufs, letter, dll, label: 'CRM files' }))
      return await new Promise<NativeStart>(resolve => {
        let settled = false
        const settle = (r: NativeStart) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          // A start that failed cleanly (the thread told us, or ended) left nothing running: no marker.
          if (!r.ok) removeMarker()
          resolve(r)
        }
        const timer = setTimeout(() => {
          o.log?.warn('crm drive: the in-app WinFsp drive did not start in time')
          void w.terminate()
          settle({ ok: false, reason: 'The drive did not start in time. Try again.', code: 'failed' })
        }, startMs)
        timer.unref?.()
        w.on('message', ((m: { type?: string; message?: string; line?: string } & Partial<BridgeRequest>) => {
          if (m?.type === 'fs') void answerBridgeRequest(handler, bufs, m as BridgeRequest)
          else if (m?.type === 'ready') {
            ready = true
            remembered = { at: Date.now(), value: true }
            o.log?.info(`crm drive: ${letter} is served by the agent (in-app WinFsp)`)
            settle({ ok: true })
          } else if (m?.type === 'error') {
            const text = String(m.message ?? 'the drive failed')
            o.log?.warn(`crm drive: ${text}`)
            // WinFsp's own words for a letter it could not use, and for a missing driver, become the person's reasons
            if (/could not use/i.test(text)) settle({ ok: false, reason: CRM_FILES_REASONS.letterTaken.replace('Y:', letter), code: 'letter-taken' })
            else if (/Cannot find module|specified module|winfsp-x64/i.test(text)) settle({ ok: false, reason: CRM_FILES_REASONS.winfspMissing, code: 'driver-missing' })
            else settle({ ok: false, reason: `The in-app drive could not start (${text.slice(0, 100)}).`, code: 'failed' })
          } else if (m?.type === 'log' && m.line) o.log?.info(`crm drive: ${m.line}`)
        }) as never)
        w.on('error', ((e: Error) => {
          o.log?.warn(`crm drive: the drive's thread failed (${e.message.slice(0, 80)})`)
          settle({ ok: false, reason: `The in-app drive could not start (${e.message.slice(0, 80)}).`, code: 'failed' })
        }) as never)
        w.on('exit', (() => {
          const was = ready
          exited = true
          ready = false
          remembered = { at: Date.now(), value: false }
          // The thread is over and this process is still here: not a crash of the agent.
          removeMarker()
          if (was && !ending) o.log?.warn('crm drive: the in-app drive stopped')
          settle({ ok: false, reason: 'The in-app drive stopped right after it started.', code: 'failed' })
        }) as never)
      })
    })().finally(() => (starting = null))
    return starting
  }

  /** Ends the drive: a "stop" message (WinFsp stops its dispatcher and removes the letter), then the thread ends; a thread that does not answer in time is terminated. */
  async function end(): Promise<void> {
    const w = worker
    if (!w) return
    ending = true
    if (ready && !exited) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          o.log?.warn('crm drive: the in-app drive did not stop in time; its thread is ended')
          void w.terminate()
          resolve()
        }, stopMs)
        timer.unref?.()
        w.on('exit', (() => (clearTimeout(timer), resolve())) as never)
        w.postMessage({ type: 'stop' })
      })
    }
    ready = false
    worker = null
    ending = false
    remembered = null
    removeMarker()
  }

  return { start, end, answers, available, alive: () => ready && !exited }
}
