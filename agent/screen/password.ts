import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { writeAtomic } from '../config.ts'

// The app's own screen's control password (F-006), kept the way RustDesk keeps its permanent
// one (hbb_common/src/config/permanent_password.rs:177-188): a random salt and
// H1 = SHA256(password ‖ salt), never the password itself. A viewer logs in with
// SHA256(H1 ‖ challenge) (connection.rs:2454-2500), exactly what the in-app viewer already sends
// to RustDesk (shared/rustdesk/client.ts › passwordHash), so the same login screen serves both.

export interface StoredPassword {
  /** 32 characters [a-z0-9]: RustDesk's salt alphabet and length (connection.rs:542-547). */
  salt: string
  /** SHA256(password ‖ salt), hex. */
  h1: string
  setAt: string
}

export const MIN_PASSWORD = 6
export const MAX_PASSWORD = 128

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** n random characters from [a-z0-9]: salts and challenges. */
export function randomText(n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return s
}

const sha256 = (...parts: (string | Buffer)[]) => {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest()
}

/** The stored password, or null when none is set (or the file is unreadable). */
export function loadPassword(file: string): StoredPassword | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredPassword>
    if (typeof v.salt === 'string' && /^[a-z0-9]{8,64}$/.test(v.salt) && typeof v.h1 === 'string' && /^[0-9a-f]{64}$/.test(v.h1)) {
      return { salt: v.salt, h1: v.h1, setAt: typeof v.setAt === 'string' ? v.setAt : '' }
    }
  } catch {
    // Missing or broken: no password.
  }
  return null
}

/** Why `password` can't be a control password, or null when it can. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'The password must be text'
  if ([...password].length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters`
  if ([...password].length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters`
  return null
}

/** Sets the password (a new salt each time); null removes it. */
export function savePassword(file: string, password: string | null): StoredPassword | null {
  if (password === null) {
    rmSync(file, { force: true })
    return null
  }
  const problem = passwordProblem(password)
  if (problem) throw new Error(problem)
  const salt = randomText(32)
  const stored = { salt, h1: sha256(password, salt).toString('hex'), setAt: new Date().toISOString() }
  writeAtomic(file, JSON.stringify(stored, null, 2) + '\n', 0o600)
  return stored
}

/** Whether `digest` (LoginRequest.password) is SHA256(H1 ‖ challenge) for the stored password. */
export function passwordMatches(stored: StoredPassword, challenge: string, digest: Uint8Array): boolean {
  if (digest.length !== 32) return false
  const want = sha256(Buffer.from(stored.h1, 'hex'), challenge)
  return timingSafeEqual(want, Buffer.from(digest))
}

// Wrong passwords, counted per PC as RustDesk counts them per address (connection.rs:4346-4520):
// more than 6 in the same minute → "Please try 1 minute later"; more than 30 in all →
// "Too many wrong attempts" until a right one or the agent restarts.
export interface Failures {
  /** The refusal to send before even checking, or null. */
  check(who: string, now?: number): string | null
  fail(who: string, now?: number): void
  clear(who: string): void
}

export function createFailures(): Failures {
  const seen = new Map<string, { minute: number; inMinute: number; total: number }>()
  const minuteOf = (now: number) => Math.floor(now / 60_000)
  return {
    check(who, now = Date.now()) {
      const f = seen.get(who)
      if (!f) return null
      if (f.total > 30) return 'Too many wrong attempts'
      if (f.minute === minuteOf(now) && f.inMinute > 6) return 'Please try 1 minute later'
      return null
    },
    fail(who, now = Date.now()) {
      const minute = minuteOf(now)
      const f = seen.get(who) ?? { minute, inMinute: 0, total: 0 }
      seen.set(who, { minute, inMinute: f.minute === minute ? f.inMinute + 1 : 1, total: f.total + 1 })
    },
    clear: who => void seen.delete(who),
  }
}
