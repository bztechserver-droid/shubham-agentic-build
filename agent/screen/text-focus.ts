import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { Logger } from '../log.ts'

// Whether a text box on this PC has the keyboard focus (F-017), for a phone controlling it: its
// own keyboard then opens by itself, as it would for a text box on the phone. RustDesk has no
// message for this; Windows' own touch keyboard asks UI Automation, and so does this. Asking runs
// apart from the agent (text-focus-uia.ts is the asking): asking an app that hangs can block for
// seconds, which the agent's main thread must never do, and koffi, which makes the calls, can end the
// whole process it runs in with a native failure that no try/catch sees (F-058: "FATAL ERROR:
// Error::ThrowAsJavaScriptException napi_throw", 3 runs in 8 of the test; a thread that has been
// stopped while it is in such a call can also keep the agent from ever exiting). So by default it
// is a child process of its own (text-focus-process.ts): when that ends in any way, the agent goes on
// and starts it again; when nobody watches, it is ended by its handle. `SAD_TEXT_FOCUS=worker` is
// the old way, a thread of the agent (text-focus-worker.ts).
// And only while a viewer asks (host.ts, the "sad.text-focus" plugin message): asking makes Chrome
// turn on its accessibility support, which costs it a little for as long as it lasts.

// UI Automation's control types and properties (UIAutomationClient.h).
export const UIA = {
  ComboBox: 50003,
  Edit: 50004,
  Document: 50030,
  IsValuePatternAvailable: 30043,
  ValueIsReadOnly: 30046,
} as const

/** The focused element, as far as the rule needs it. */
export interface FocusedInfo {
  controlType: number
  /** It has UI Automation's Value pattern. */
  valuePattern: boolean
  /** Its Value pattern says read-only (false when it has none). */
  readOnly: boolean
}

/**
 * A text box someone can type into: an edit control that isn't read-only, or a document or
 * combo box whose value can be changed (a browser's page itself is a document too, but a
 * read-only one, or one without a value). Word's document says neither, so it doesn't count.
 */
export function editableOf(f: FocusedInfo | null): boolean {
  if (!f) return false
  if (f.controlType === UIA.Edit) return !f.readOnly
  if (f.controlType === UIA.Document || f.controlType === UIA.ComboBox) return f.valuePattern && !f.readOnly
  return false
}

export interface TextFocusWatch {
  stop(): void
  /** Look now rather than at the next poll (after a click). */
  nudge(): void
}

export interface TextFocus {
  /** `onChange` at once with what is known, then at each change, until stop(). */
  watch(onChange: (editable: boolean) => void): TextFocusWatch
  close(): void
}

// ---------------------------------------------------------------------------------------------
// Where the asking runs

export type AskerMessage = { t: 'focus'; editable: boolean } | { t: 'error'; message: string }

/** A running asker: the agent tells it about a click, and ends it. */
export interface Asker {
  send(message: { t: 'check' }): void
  /** Ends it at once; nothing it says afterwards is heard. */
  stop(): void
}

export interface AskerEvents {
  intervalMs: number
  onMessage(m: AskerMessage): void
  /** It ended without having been stopped: why. */
  onEnd(why: string): void
}

export type StartAsker = (e: AskerEvents) => Asker

/** The default: a child process of its own (text-focus-process.ts, or `entry`, which tests change). */
export function processAsker(entry: string = fileURLToPath(new URL('./text-focus-process.ts', import.meta.url))): StartAsker {
  return e => {
    const child = fork(entry, [String(e.intervalMs)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
    let over = false
    const end = (why: string) => {
      if (over) return
      over = true
      e.onEnd(why)
    }
    child.on('message', m => {
      if (!over) e.onMessage(m as AskerMessage)
    })
    child.on('error', err => end(`could not run: ${err.message}`))
    child.on('exit', (code, signal) => end(signal ? `ended by ${signal}` : `exit code ${code}`))
    return {
      send(m) {
        try {
          if (child.connected) child.send(m)
        } catch {
          // Gone while we spoke: its exit says so.
        }
      },
      stop() {
        over = true
        // By the handle of the process this started, so never another one that has the number now.
        child.kill()
      },
    }
  }
}

/** The old way (`SAD_TEXT_FOCUS=worker`): a thread of the agent. */
export const workerAsker: StartAsker = e => {
  const w = new Worker(new URL('./text-focus-worker.ts', import.meta.url), { workerData: { intervalMs: e.intervalMs } })
  let over = false
  const end = (why: string) => {
    if (over) return
    over = true
    e.onEnd(why)
  }
  w.on('message', m => {
    if (!over) e.onMessage(m as AskerMessage)
  })
  w.on('error', err => end(err.message))
  w.on('exit', () => end('the thread ended'))
  return {
    send: m => w.postMessage(m),
    stop() {
      over = true
      void w.terminate()
    },
  }
}

/** After an ending that nobody asked for, the asker is started again after these waits (ms); the last one repeats. */
export const RESTART_MS: readonly number[] = [500, 1500, 5000, 15_000, 30_000]
/** More endings than this within RESTART_WINDOW_MS and it is given up on until the agent starts again. */
export const MAX_ENDINGS = 5
export const RESTART_WINDOW_MS = 120_000

export interface TextFocusOptions {
  log: Logger
  intervalMs?: number
  /** Where the asking runs; default: a child process, or a thread with SAD_TEXT_FOCUS=worker. */
  start?: StartAsker
  restartMs?: readonly number[]
  now?: () => number
}

/** Polls while anyone watches; the asker ends with the last watcher. */
export function createTextFocus(o: TextFocusOptions): TextFocus {
  const start = o.start ?? (process.env.SAD_TEXT_FOCUS === 'worker' ? workerAsker : processAsker())
  const waits = o.restartMs?.length ? o.restartMs : RESTART_MS
  const now = o.now ?? Date.now
  const watchers = new Set<(editable: boolean) => void>()
  let asker: Asker | null = null
  let last: boolean | null = null
  let failed = false
  let endings: number[] = []
  let restart: NodeJS.Timeout | null = null

  const stopAsker = () => {
    if (restart) clearTimeout(restart)
    restart = null
    const a = asker
    asker = null
    last = null
    a?.stop()
  }

  function begin() {
    if (asker || failed || restart) return
    const a: Asker = (asker = start({
      intervalMs: o.intervalMs ?? 300,
      onMessage: m => {
        if (asker !== a) return
        if (m.t === 'focus') {
          last = m.editable === true
          for (const fn of watchers) fn(last)
        } else if (m.t === 'error') {
          failed = true
          o.log.warn(`text boxes can't be told apart here: ${m.message}`)
          stopAsker()
        }
      },
      onEnd: why => {
        if (asker !== a) return
        asker = null
        last = null
        ended(why)
      },
    }))
  }

  /** It ended and nobody asked it to: start it again, unless that keeps happening. */
  function ended(why: string) {
    if (!watchers.size) return
    const t = now()
    endings = [...endings.filter(x => t - x < RESTART_WINDOW_MS), t]
    if (endings.length > MAX_ENDINGS) {
      failed = true
      o.log.warn(`UI Automation keeps stopping (${why}); text boxes won't be told apart until the app starts again`)
      return
    }
    const wait = waits[Math.min(endings.length - 1, waits.length - 1)]
    o.log.warn(`UI Automation stopped (${why}); the agent goes on; asking again in ${(wait / 1000).toFixed(1)} s`)
    restart = setTimeout(() => {
      restart = null
      if (watchers.size) begin()
    }, wait)
    restart.unref()
  }

  return {
    watch(onChange) {
      watchers.add(onChange)
      begin()
      if (last !== null) onChange(last)
      return {
        stop() {
          if (!watchers.delete(onChange)) return
          if (watchers.size === 0) stopAsker()
        },
        nudge: () => asker?.send({ t: 'check' }),
      }
    },
    close() {
      watchers.clear()
      stopAsker()
    },
  }
}
