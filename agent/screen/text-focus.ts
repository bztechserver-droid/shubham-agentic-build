import { Worker } from 'node:worker_threads'
import type { Logger } from '../log.ts'

// Whether a text box on this PC has the keyboard focus (F-017), for a phone controlling it: its
// own keyboard then opens by itself, as it would for a text box on the phone. RustDesk has no
// message for this; Windows' own touch keyboard asks UI Automation, and so does this. UI
// Automation runs on its own thread (text-focus-worker.ts): asking an app that hangs can block
// for seconds, which the agent's main thread must never do. And only while a viewer asks
// (host.ts, the "sad.text-focus" plugin message): asking makes Chrome turn on its
// accessibility support, which costs it a little for as long as it lasts.

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

/** Polls while anyone watches; the thread ends with the last watcher. */
export function createTextFocus(o: { log: Logger; intervalMs?: number }): TextFocus {
  const watchers = new Set<(editable: boolean) => void>()
  let worker: Worker | null = null
  let last: boolean | null = null
  let failed = false

  const stopWorker = () => {
    const w = worker
    worker = null
    last = null
    void w?.terminate()
  }

  function startWorker() {
    if (worker || failed) return
    const w = (worker = new Worker(new URL('./text-focus-worker.ts', import.meta.url), { workerData: { intervalMs: o.intervalMs ?? 300 } }))
    w.on('message', (m: { t: string; editable?: boolean; message?: string }) => {
      if (worker !== w) return
      if (m.t === 'focus') {
        last = m.editable === true
        for (const fn of watchers) fn(last)
      } else if (m.t === 'error') {
        failed = true
        o.log.warn(`text boxes can't be told apart here: ${m.message}`)
        stopWorker()
      }
    })
    w.on('error', e => {
      if (worker !== w) return
      o.log.warn(`UI Automation stopped: ${e.message}`)
      stopWorker()
    })
    w.on('exit', () => {
      if (worker === w) worker = null
    })
  }

  return {
    watch(onChange) {
      watchers.add(onChange)
      startWorker()
      if (last !== null) onChange(last)
      return {
        stop() {
          if (!watchers.delete(onChange)) return
          if (watchers.size === 0) stopWorker()
        },
        nudge: () => worker?.postMessage({ t: 'check' }),
      }
    },
    close() {
      watchers.clear()
      stopWorker()
    },
  }
}
