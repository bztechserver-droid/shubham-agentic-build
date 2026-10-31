import { Worker } from 'node:worker_threads'
import type { GrabbedKey } from '../../shared/agent-api.ts'
import { WIN_SCANCODE } from '../../shared/rustdesk/keys.ts'
import type { Logger } from '../log.ts'
import { codesByScan, GRAB, LET_GO } from './grab-keys.ts'

// Alt+Tab, the Windows key and the other keys a browser never gets (F-013), taken on this PC, the
// controlling one, while its Control page has the focus, as RustDesk's viewer takes them with a
// low-level keyboard hook while its session window has the focus (src/keyboard.rs:148-300,
// 612-701). The hook runs on its own thread (grab-worker.ts); the page opens /agent-api/keys
// while its screen has the focus and gets the keys there. One grab at a time: a new one ends the
// one before.

const WM_QUIT = 0x12

export interface KeyGrab {
  /** Keys taken for `onKey` until stop(), or until `onEnd` says why not (the window in front changed). */
  start(onKey: (k: GrabbedKey) => void, onEnd: (why: string) => void): Promise<{ stop(): void }>
  close(): void
}

export function createKeyGrab(o: { log: Logger; postThreadMessage(thread: number, message: number): boolean; injected?: 'skip' | 'only' }): KeyGrab {
  const log = o.log
  let worker: Worker | null = null
  let thread: Promise<number> | null = null
  let current: { onKey(k: GrabbedKey): void; onEnd(why: string): void } | null = null
  const acks: ((ok: boolean) => void)[] = []

  const end = (why: string) => {
    const c = current
    current = null
    c?.onEnd(why)
  }
  const post = (message: number) => void thread?.then(t => o.postThreadMessage(t, message), () => {})

  function start(): Promise<number> {
    if (thread) return thread
    const w = (worker = new Worker(new URL('./grab-worker.ts', import.meta.url), {
      workerData: { codes: [...codesByScan(WIN_SCANCODE)], injected: o.injected ?? 'skip' },
    }))
    const t = new Promise<number>((resolve, reject) => {
      const gone = (why: string) => {
        if (worker !== w) return
        worker = null
        thread = null
        for (const ack of acks.splice(0)) ack(false)
        reject(new Error(why))
        end(why)
      }
      w.on('message', (m: { t: string; tid?: number; ok?: boolean } & Partial<GrabbedKey>) => {
        if (m.t === 'ready') resolve(m.tid!)
        else if (m.t === 'grabbing') acks.shift()?.(m.ok === true)
        else if (m.t === 'key') {
          current?.onKey({ code: m.code!, down: m.down!, repeat: m.repeat!, alt: m.alt!, ctrl: m.ctrl!, shift: m.shift!, meta: m.meta! })
        } else if (m.t === 'lost') {
          post(LET_GO)
          end('another window came in front')
        }
      })
      w.on('error', e => {
        log.warn(`the keyboard hook stopped: ${e.message}`)
        gone('the keyboard hook stopped')
      })
      w.on('exit', () => gone('the keyboard hook stopped'))
    })
    // Whoever is waiting hears of a failure; with nobody waiting it is no crash.
    t.catch(() => {})
    return (thread = t)
  }

  return {
    async start(onKey, onEnd) {
      const t = await start()
      end('another Control page took the keys')
      // Before the hook is in, so no key it takes is lost on the way.
      const me = { onKey, onEnd }
      current = me
      const ok = new Promise<boolean>(resolve => acks.push(resolve))
      if (!o.postThreadMessage(t, GRAB) || !(await ok)) {
        if (current === me) current = null
        throw new Error("Windows didn't let the app take this PC's keys")
      }
      log.info("taking this PC's keys for Control: Alt+Tab, the Windows key and the rest go to the other PC")
      return {
        stop() {
          if (current !== me) return
          current = null
          post(LET_GO)
          log.info("this PC's keys are its own again")
        },
      }
    },

    close() {
      end('the agent is stopping')
      post(WM_QUIT)
      const w = worker
      if (w) setTimeout(() => void w.terminate(), 1000).unref()
    },
  }
}
