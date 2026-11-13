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
  /** Order od371: which device this screen is (the page's own stable id; the socket's id until it says). */
  device: string
  /** The device's name, for "Acting on: <name>". */
  name: string
}

/** Order od371: a device that has the overlay open, as the other devices are told about it. */
export interface OverlayDevice {
  device: string
  name: string
  phone: boolean
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
  /** Order od371: which device the Assistant drives now (null: none, or two are open and none is chosen). */
  driven(): OverlayDevice | null
  /** Order od371: the devices with the overlay open right now. */
  overlayDevices(): OverlayDevice[]
  clients(): UiClientInfo[]
  close(): void
}

export function createUiBridge(now: () => number = Date.now): UiBridge {
  const clients = new Set<Client>()
  const waiting = new Map<string, Waiting>()
  /** Order od371: the device he chose ("Act on this device"); null: the rule below decides. */
  let chosen: string | null = null

  function best(): Client | null {
    let top: Client | null = null
    const rank = (c: Client) => (c.visible ? 2 : 0) + (c.overlayOpen ? 1 : 0)
    for (const c of clients) {
      if (!top || rank(c) > rank(top) || (rank(c) === rank(top) && c.activeAt > top.activeAt)) top = c
    }
    return top
  }

  const openClients = (): Client[] => [...clients].filter(c => c.overlayOpen)
  /** One entry per device (several tabs of one browser are one device: they share its id). */
  const openDevices = (): Client[] => {
    const seen = new Map<string, Client>()
    for (const c of openClients()) if (!seen.has(c.device)) seen.set(c.device, c)
    return [...seen.values()]
  }

  /** Order od371: two devices have the overlay open and he has not chosen one of them: the Assistant must ask him, not guess. */
  function ambiguous(): boolean {
    const devices = openDevices()
    return devices.length > 1 && !devices.some(c => c.device === chosen)
  }

  /** Order od371: the chosen device when it has the overlay open; with two open and none chosen, nothing; else the one the rule picks (as before). */
  function driving(): Client | null {
    if (chosen !== null) {
      const c = openClients().find(x => x.device === chosen)
      if (c) return c
    }
    if (ambiguous()) return null
    return best()
  }

  /** Order od371: every open device is told which one is driven, so each can say "Acting on this device" or "Overlay open elsewhere, not driven". */
  function tellAll() {
    const driven = driving()
    const msg = JSON.stringify({ t: 'acting', driven: driven?.device ?? null, devices: openDevices().map(c => ({ device: c.device, name: c.name, phone: c.phone })) })
    for (const c of clients) {
      try {
        c.ws.sendText(msg)
      } catch {
        // A socket that cannot take the word is dropped by its own close.
      }
    }
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
      const id = randomUUID()
      const me: Client = { id, ws, visible: false, overlayOpen: false, route: '', phone: false, activeAt: now(), device: id, name: 'a device' }
      clients.add(me)
      ws.onText(text => {
        let m: { t?: unknown; id?: unknown; visible?: unknown; active?: unknown; overlayOpen?: unknown; route?: unknown; phone?: unknown; ok?: unknown; result?: unknown; error?: unknown; device?: unknown; name?: unknown }
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
          if (typeof m.device === 'string' && m.device) me.device = m.device.slice(0, 80)
          if (typeof m.name === 'string' && m.name) me.name = m.name.replace(/\s+/g, ' ').trim().slice(0, 60) || 'a device'
          if (m.active === true) me.activeAt = now()
          tellAll()
        } else if (m.t === 'choose') {
          // Order od371: "Act on this device" on that device. Only a device with the overlay open can be chosen.
          if (me.overlayOpen) {
            chosen = me.device
            tellAll()
          }
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
        if (chosen === me.device && ![...clients].some(c => c.device === me.device)) chosen = null
        failFor(me, 'The screen went away before it answered')
        tellAll()
      })
    },

    call(cmd, args, timeoutMs = UI_CALL_TIMEOUT_MS) {
      if (ambiguous()) {
        return Promise.reject(apiError(409, 'The overlay is open on two of his devices (his phone and his PC) and he has not chosen which one the Assistant should drive. Ask Shubham which one to use, and do not guess.'))
      }
      const c = driving()
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
      const c = driving()
      return c?.visible ? c.phone : null
    },

    driven() {
      const c = driving()
      return c ? { device: c.device, name: c.name, phone: c.phone } : null
    },

    overlayDevices: () => openDevices().map(c => ({ device: c.device, name: c.name, phone: c.phone })),

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
