import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import type { RecoveryAnswer, RecoveryStarted, RecoveryState } from '../../shared/approval-sign.ts'
import { apiError } from '../api.ts'

// F-076 recovery (4 Nov 2026, order o4a52): the way back in when no registered approval device can sign any more (a phone's key lives in the browser
// storage of ONE page address; at another address, or after the browser's data is cleared, it is gone). Without a device nobody can show a code, and
// the bootstrap ("the first device needs no code") is only for a hub with NO device.
//
// The proof is a Windows administrator (UAC) prompt on the PC the hub runs on. Every program on this PC, the agents included, can use the page's token,
// which is why a request alone is never enough; but none of them can answer a UAC prompt (it is on the secure desktop; the agents run un-elevated).
//   start:  the agent makes a random one-time token and keeps it in memory for 5 minutes; an elevated `reg.exe` (the Windows one, nothing of ours that
//           a program could change) writes "<token>:<time>" under HKLM\SOFTWARE\ShubhamAgentic, a place only an administrator can write.
//   finish: only if that value is there and equals the token in memory, less than 5 minutes old. The token is then spent: one code (the same kind the
//           first device gets) is given, and a second finish is refused. A stale value in the registry is useless: the next token is another random one.
//   ticket: `start` hands its caller a random one-time ticket (the answer of that one call; GET never shows it) and `finish` needs it, in constant time.
//           Without it, any program that shares the page's token could finish first after the person said Yes, take the code and register itself. To
//           finish a recovery a program would have to have started it, and then the person sees a prompt he did not ask for. A wrong or missing ticket
//           ends that recovery (403). The ticket is spent with the token.
// Never started from anywhere but its route. No unsigned removal, no "this PC is trusted". On Linux and macOS: not built yet (pkexec later).

export const RECOVERY_MS = 5 * 60_000
/** At least this long between two starts, and at most MAX_PER_HOUR in an hour: an agent can't flood the person with prompts. */
export const MIN_GAP_MS = 30_000
export const MAX_PER_HOUR = 5
export const RECOVERY_KEY = 'HKLM\\SOFTWARE\\ShubhamAgentic'
export const RECOVERY_VALUE = 'ApprovalRecovery'

export type Written = { ok: true } | { ok: false; kind: 'declined' | 'failed'; detail: string }

/** The one part that touches Windows; a fake in tests. */
export interface Elevation {
  supported: boolean
  /** Why not, in words for a person (when not supported). */
  why?: string
  /** Writes the value under the administrator prompt. Resolves when the prompt has been answered. */
  write(value: string): Promise<Written>
  /** What is there now (no elevation needed), or null. */
  read(): Promise<string | null>
}

export type Run = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

const defaultRun: Run = (file, args) =>
  new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: RECOVERY_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err ? err.message : '')) })
    })
  })

const VALUE_RE = /^[0-9a-f]{32}:\d{10,15}$/

export function windowsElevation(run: Run = defaultRun, platform: string = process.platform, systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows'): Elevation {
  if (platform !== 'win32') {
    return {
      supported: false,
      why: platform === 'linux' ? 'Recovery from this PC is not built for Linux yet (it will ask for the administrator password with pkexec).' : 'Recovery from this PC is only built for Windows so far.',
      write: async () => ({ ok: false, kind: 'failed', detail: 'not supported here' }),
      read: async () => null,
    }
  }
  const sys32 = path.win32.join(systemRoot, 'System32')
  const reg = path.win32.join(sys32, 'reg.exe')
  const powershell = path.win32.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return {
    supported: true,
    async write(value) {
      if (!VALUE_RE.test(value)) return { ok: false, kind: 'failed', detail: 'the value is not the shape it must be' }
      // Exit 4: the prompt was answered No (Windows error 1223, whatever the language of the PC); 3: anything else.
      const script =
        `try { Start-Process -FilePath '${reg}' -ArgumentList 'add','${RECOVERY_KEY}','/v','${RECOVERY_VALUE}','/t','REG_SZ','/d','${value}','/f' -Verb RunAs -Wait -WindowStyle Hidden -ErrorAction Stop } ` +
        `catch { $n = 0; if ($_.Exception.InnerException -is [System.ComponentModel.Win32Exception]) { $n = $_.Exception.InnerException.NativeErrorCode }; if ($n -eq 1223) { exit 4 }; [Console]::Error.WriteLine($_.Exception.Message); exit 3 }`
      const r = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script])
      if (r.code === 0) return { ok: true }
      if (r.code === 4) return { ok: false, kind: 'declined', detail: 'The Windows administrator prompt was answered No (or closed).' }
      return { ok: false, kind: 'failed', detail: `The administrator prompt could not be shown or did not finish${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 200)}` : '.'}` }
    },
    async read() {
      const r = await run(reg, ['query', RECOVERY_KEY, '/v', RECOVERY_VALUE])
      if (r.code !== 0) return null
      return new RegExp(`${RECOVERY_VALUE}\\s+REG_SZ\\s+(\\S+)`).exec(r.stdout)?.[1] ?? null
    },
  }
}

export interface RecoveryOptions {
  elevation: Elevation
  now?: () => number
  /** Tests. */
  token?: () => string
  ticket?: () => string
  /** One line for the approvals log per step. `by` is who asked. Never carries the token. */
  note?: (detail: string, by: string) => void
}

export interface Recovery {
  status(): RecoveryAnswer
  /** Opens the administrator prompt (it does not wait for the answer) and returns the ticket finish needs. Throws 501 where unsupported, 409 while one is open, 429 when asked too often. */
  start(by: string): RecoveryStarted
  /** Accepts the proof: resolves once, and only with the ticket start gave, when the prompt was answered Yes and the value is there and right. Throws 409/403 with words otherwise. */
  finish(by: string, ticket: unknown): Promise<void>
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export function createRecovery(o: RecoveryOptions): Recovery {
  const now = o.now ?? Date.now
  const note = (detail: string, by: string) => o.note?.(detail, by)
  const AFTER = 'after a Windows administrator prompt'
  let cur: { value: string; ticket: string; startedAt: number; expiresAt: number; state: RecoveryState; detail?: string; by: string } | null = null
  const starts: number[] = []

  /** The state now: a recovery that waited too long is over. */
  const live = () => {
    if (cur && (cur.state === 'waiting' || cur.state === 'ready') && now() > cur.expiresAt) cur.state = 'expired'
    return cur
  }

  function status(): RecoveryAnswer {
    if (!o.elevation.supported) return { supported: false, why: o.elevation.why, state: 'none' }
    const c = live()
    if (!c) return { supported: true, state: 'none' }
    return {
      supported: true,
      state: c.state,
      startedAt: new Date(c.startedAt).toISOString(),
      expiresAt: new Date(c.expiresAt).toISOString(),
      ...(c.detail ? { detail: c.detail } : {}),
    }
  }

  return {
    status,
    start(by) {
      if (!o.elevation.supported) throw apiError(501, o.elevation.why ?? 'Recovery from this PC is not built for this system yet.')
      if (live()?.state === 'waiting') throw apiError(409, 'The Windows administrator prompt is already open on this PC. Answer it there.')
      const t = now()
      while (starts.length && t - starts[0] > 3_600_000) starts.shift()
      if (starts.length && t - starts[starts.length - 1] < MIN_GAP_MS) throw apiError(429, 'The administrator prompt was just shown. Wait a little before asking again.')
      if (starts.length >= MAX_PER_HOUR) throw apiError(429, 'The administrator prompt has been shown too many times this hour. Try again later.')
      starts.push(t)
      const token = o.token ? o.token() : randomBytes(16).toString('hex')
      const ticket = o.ticket ? o.ticket() : randomBytes(16).toString('hex')
      const mine = { value: `${token}:${t}`, ticket, startedAt: t, expiresAt: t + RECOVERY_MS, state: 'waiting' as RecoveryState, by, detail: undefined as string | undefined }
      cur = mine
      note('Device recovery started: a Windows administrator prompt was opened on this PC', by)
      void o.elevation
        .write(mine.value)
        .catch((e: unknown): Written => ({ ok: false, kind: 'failed', detail: e instanceof Error ? e.message : String(e) }))
        .then(r => {
          // Only the recovery still current, and only if it is still waiting.
          if (cur !== mine || mine.state !== 'waiting') return
          if (now() > mine.expiresAt) {
            mine.state = 'expired'
            return
          }
          if (r.ok) {
            mine.state = 'ready'
            note(`The Windows administrator prompt was answered Yes (${AFTER})`, by)
          } else {
            mine.state = r.kind
            mine.detail = r.detail
            note(`Device recovery stopped: ${r.detail}`, by)
          }
        })
      return { ...status(), ticket }
    },
    async finish(by, given) {
      if (!o.elevation.supported) throw apiError(501, o.elevation.why ?? 'Recovery from this PC is not built for this system yet.')
      const c = live()
      if (!c) throw apiError(409, 'Start the recovery first (Use this PC to add a device).')
      // The ticket first, before anything is said about the state: only the caller of start has it. A wrong one ends a recovery that is still open.
      if (typeof given !== 'string' || !same(given, c.ticket)) {
        if (c.state === 'waiting' || c.state === 'ready') {
          c.state = 'failed'
          c.detail = 'Finish came without the ticket start gave.'
          note('Device recovery refused: finish came without the right ticket, so this recovery is over', by)
        }
        throw apiError(403, 'This is not the page that started the recovery (the ticket is missing or wrong), so nothing was allowed. Start again.')
      }
      const words: Partial<Record<RecoveryState, string>> = {
        waiting: 'The Windows administrator prompt is still open on this PC. Answer it there first.',
        declined: 'The administrator prompt was answered No. Start again.',
        failed: 'The administrator prompt did not work. Start again.',
        expired: 'The 5 minutes are over. Start again.',
        used: 'This recovery was already used. Start again if you need another code.',
      }
      if (c.state !== 'ready') throw apiError(409, words[c.state] ?? 'Start the recovery first.')
      const seen = await o.elevation.read()
      // After the wait: still the current one, still ready, still in time. Spent in the same breath (nothing awaited between the check and the change).
      if (cur !== c || c.state !== 'ready') throw apiError(409, words[c.state] ?? 'Start again.')
      if (now() > c.expiresAt) {
        c.state = 'expired'
        throw apiError(409, words.expired!)
      }
      const [token, at] = (seen ?? '').split(':')
      if (seen === null || !same(seen, c.value) || !(Number(at) > 0) || now() - Number(at) > RECOVERY_MS || !token) {
        c.state = 'failed'
        c.detail = 'The administrator step left no proof on this PC.'
        note('Device recovery refused: the administrator step left no proof', by)
        throw apiError(403, 'The administrator step left no proof on this PC, so nothing was allowed. Start again.')
      }
      c.state = 'used'
      note(`Device recovery accepted ${AFTER}: one code for one new device was given`, by)
    },
  }
}
