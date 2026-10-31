// F-058: what the page says while the app restarts. The guard (agent/guard.ts) serves the page on 5173
// itself and answers GET /guard/status there even while the agent is down; this reads that answer.
// Pure, so it is tested without a page (guard-note.test.ts); src/lib/live/guard.ts does the asking.
//   up          the app answers: nothing special to say (the link sign shows only its own trouble)
//   starting / down / backoff   "The app is restarting. Back in about N s."
//   updating    "The app is updating. Back in about a minute."
//   stopped     "The app is stopped."  (the guard was asked to stop it)
// Next to it the sign offers Control (RustDesk, which the guard keeps running apart from the app) and
// the backup page on Christopher's port, so a crash never leaves the PC out of reach.

export type GuardAgentState = 'starting' | 'up' | 'down' | 'backoff' | 'updating' | 'stopped'

const STATES: readonly string[] = ['starting', 'up', 'down', 'backoff', 'updating', 'stopped']

export interface GuardNote {
  state: GuardAgentState
  /** About how many seconds until the app answers again, as of `at` (0: it does). */
  etaSeconds: number
  /** When the answer came, on the page's clock (ms). */
  at: number
  /** rustdesk://connection/new/<id>, or null when the guard doesn't know the ID (yet). */
  rustdeskUri: string | null
  /** The port of the independent backup page (Christopher), or null. */
  backupPort: number | null
}

const RUSTDESK_URI = /^rustdesk:\/\/connection\/new\/[0-9A-Za-z_-]{3,40}$/

/** Reads the guard's /guard/status answer. null: it is not that answer (a dev server's page, an error body). */
export function parseGuardNote(body: unknown, at: number): GuardNote | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as { agent?: unknown; etaSeconds?: unknown; control?: unknown }
  if (typeof b.agent !== 'object' || b.agent === null) return null
  const state = (b.agent as { state?: unknown }).state
  if (typeof state !== 'string' || !STATES.includes(state)) return null
  const eta = typeof b.etaSeconds === 'number' && Number.isFinite(b.etaSeconds) ? Math.max(0, Math.min(600, Math.round(b.etaSeconds))) : 0
  const control = typeof b.control === 'object' && b.control !== null ? (b.control as { rustdeskUri?: unknown; christopherPort?: unknown }) : {}
  const uri = typeof control.rustdeskUri === 'string' && RUSTDESK_URI.test(control.rustdeskUri) ? control.rustdeskUri : null
  const port = typeof control.christopherPort === 'number' && Number.isInteger(control.christopherPort) && control.christopherPort > 0 && control.christopherPort < 65536 ? control.christopherPort : null
  return { state: state as GuardAgentState, etaSeconds: eta, at, rustdeskUri: uri, backupPort: port }
}

/** The line for the sign, or null when the app answers (so there is nothing to add to the plain link sign). */
export function restartLine(note: GuardNote, now: number): string | null {
  if (note.state === 'up') return null
  if (note.state === 'stopped') return 'The app is stopped.'
  const what = note.state === 'updating' ? 'updating' : 'restarting'
  // `now` can be a second behind an answer that has just arrived: time never runs backwards here.
  const left = Math.max(0, note.etaSeconds - Math.round(Math.max(0, now - note.at) / 1000))
  if (left <= 1) return `The app is ${what}. Back any moment.`
  if (left >= 60) return `The app is ${what}. Back in about a minute.`
  return `The app is ${what}. Back in about ${left} s.`
}

/** The sign offers Control and the backup page whenever the app is not answering. */
export const offersControl = (note: GuardNote): boolean => note.state !== 'up'
