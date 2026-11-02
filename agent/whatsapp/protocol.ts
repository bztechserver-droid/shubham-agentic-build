import type { EngineStatus } from './engine.ts'

// F-079: what the hub (host.ts) and the WhatsApp process (worker.ts) say to each other over Node's IPC channel.
// Kept apart from worker.ts, which starts itself when it is loaded.

export type WorkerOp = 'start' | 'status' | 'chats' | 'messages' | 'send' | 'pairCode' | 'logout' | 'quit'

export interface WorkerRequest {
  id: number
  op: WorkerOp
  args?: Record<string, unknown>
}

export type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string; status?: number }

/** What the worker says by itself. */
export type WorkerEvent =
  | { t: 'status'; status: EngineStatus }
  | { t: 'message'; message: unknown }
  | { t: 'ack'; id: string; chatId: string; ack: number }
  /** The Chrome it launched (null: none now), so the hub can note its exact PID. */
  | { t: 'chrome'; pid: number | null }

/** The switches Chrome gets beyond puppeteer's own: no graphics process, no sound. Its sandbox stays on. */
export const CHROME_ARGS = ['--disable-gpu', '--mute-audio']

/** How the linked device is named on his phone, under Linked devices. */
export const DEVICE_NAME = 'Shubham Agentic'

/** The login's name: its Chrome profile is <auth>\session-main. */
export const LOGIN_ID = 'main'
