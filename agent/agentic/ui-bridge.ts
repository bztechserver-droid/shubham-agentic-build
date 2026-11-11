import { randomUUID } from 'node:crypto'
import { apiError, type WsSocket } from '../api.ts'

// F-070: the way the overlay assistant reaches the screen. Every page of the app keeps one small
// WebSocket here (src/overlay/UiLink.tsx), and says whether it is on screen, whether the overlay is
// open on it and where it was last used. A tool call (ui_screen, ui_control, ...) goes to the ONE
// page the person is looking at: visible first, then the one with the overlay open, then the one
// used last. The page does it (src/overlay/driver.ts) and answers with the call's id.
//   page -> agent   {t:'state', visible, active, overlayOpen, route, phone}   (also the hello)
//                   {t:'result', id, ok, result | error}
//   agent -> page   {t:'cmd', id, cmd, args}

export interface UiClientInfo {
  id: string
  visible: boolean
  overlayOpen: boolean
  route: string
  /** The page says it is on a phone-sized screen (the overlay's own rule: narrower than 640px). */
  phone: boolean
  idleMs: number
}

interface Client {
  id: string
  ws: WsSocket
  visible: boolean
  overlayOpen: boolean
  route: string
  phone: boolean
  activeAt: number
}

interface Waiting {
  client: Client
  resolve(v: unknown): void
  reject(e: unknown): void
  timer: ReturnType<typeof setTimeout>
}

export const UI_CALL_TIMEOUT_MS = 25_000

export interface UiBridge {
  /** The handler for the page's socket. */
  socket(): (ws: WsSocket) => void
  /** Runs `cmd` on the screen being looked at and answers what the page answered. */
  call(cmd: string, args: unknown, timeoutMs?: number): Promise<unknown>
  /** Is the screen a call would drive now a phone? null: there is none to drive (nobody is looking, or it is hidden). */
  onPhone(): boolean | null
  clients(): UiClientInfo[]
  close(): void
}

export function createUiBridge(now: () => number = Date.now): UiBridge {
  const clients = new Set<Client>()
  const waiting = new Map<string, Waiting>()

  function best(): Client | null {
    let top: Client | null = null
    const rank = (c: Client) => (c.visible ? 2 : 0) + (c.overlayOpen ? 1 : 0)
    for (const c of clients) {
      if (!top || rank(c) > rank(top) || (rank(c) === rank(top) && c.activeAt > top.activeAt)) top = c
    }
    return top
  }

  function failFor(client: Client, why: string) {
    for (const [id, w] of waiting) {
      if (w.client !== client) continue
      clearTimeout(w.timer)
      waiting.delete(id)
      w.reject(apiError(409, why))
    }
  }

  return {
    socket: () => ws => {
      const me: Client = { id: randomUUID(), ws, visible: false, overlayOpen: false, route: '', phone: false, activeAt: now() }
      clients.add(me)
      ws.onText(text => {
        let m: { t?: unknown; id?: unknown; visible?: unknown; active?: unknown; overlayOpen?: unknown; route?: unknown; phone?: unknown; ok?: unknown; result?: unknown; error?: unknown }
        try {
          m = JSON.parse(text)
        } catch {
          return
        }
        if (m.t === 'state') {
          me.visible = m.visible === true
          me.overlayOpen = m.overlayOpen === true
          if (typeof m.route === 'string') me.route = m.route.slice(0, 300)
          me.phone = m.phone === true
          if (m.active === true) me.activeAt = now()
        } else if (m.t === 'result' && typeof m.id === 'string') {
          const w = waiting.get(m.id)
          if (!w || w.client !== me) return
          clearTimeout(w.timer)
          waiting.delete(m.id)
          if (m.ok === true) w.resolve(m.result ?? null)
          else w.reject(apiError(422, typeof m.error === 'string' ? m.error : 'That did not work'))
        }
      })
      ws.onClose(() => {
        clients.delete(me)
        failFor(me, 'The screen went away before it answered')
      })
    },

    call(cmd, args, timeoutMs = UI_CALL_TIMEOUT_MS) {
      const c = best()
      if (!c) return Promise.reject(apiError(409, 'No screen of the app is open: nobody is looking at the app right now. Ask Shubham to open it.'))
      if (!c.visible) return Promise.reject(apiError(409, "The app's screen is open but hidden (the phone is locked or the tab is in the background), so there is nothing to drive. Ask Shubham to look at the app."))
      return new Promise((resolve, reject) => {
        const id = randomUUID()
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(apiError(504, "The screen didn't answer in time"))
        }, timeoutMs)
        waiting.set(id, { client: c, resolve, reject, timer })
        try {
          c.ws.sendText(JSON.stringify({ t: 'cmd', id, cmd, args }))
        } catch {
          clearTimeout(timer)
          waiting.delete(id)
          reject(apiError(409, 'The screen went away'))
        }
      })
    },

    onPhone() {
      const c = best()
      return c?.visible ? c.phone : null
    },

    clients: () => [...clients].map(c => ({ id: c.id.slice(0, 8), visible: c.visible, overlayOpen: c.overlayOpen, route: c.route, phone: c.phone, idleMs: now() - c.activeAt })),

    close() {
      for (const c of clients) c.ws.close(1001, 'the agent is stopping')
      clients.clear()
      for (const [, w] of waiting) {
        clearTimeout(w.timer)
        w.reject(apiError(409, 'The agent is stopping'))
      }
      waiting.clear()
    },
  }
}
