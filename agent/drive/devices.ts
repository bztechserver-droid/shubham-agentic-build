import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { driveError } from './store.ts'

// F-097: the devices that may use the drive from outside the app (WebDAV, the sync folder): each gets its own password, made
// here, shown ONCE, and kept only as a salted scrypt hash. Revoking one stops that device and no other.
// Nothing here is specific to one operating system.

export interface DriveDevice {
  name: string
  createdAt: number
  lastUsedAt?: number
}

interface Saved extends DriveDevice {
  salt: string
  hash: string
}

/** A readable password: 20 characters from an alphabet with no look-alikes, in groups of five. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
export function makePassword(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(20)
  const chars = [...bytes].map(b => ALPHABET[b % ALPHABET.length])
  return [0, 5, 10, 15].map(i => chars.slice(i, i + 5).join('')).join('-')
}

const hashOf = (password: string, salt: string) => scryptSync(password, Buffer.from(salt, 'hex'), 32).toString('hex')
const nameKey = (s: string) => s.trim().toLowerCase()

export interface DriveDevices {
  list(): DriveDevice[]
  /** Makes (or, for a name that exists, replaces) the device's password and returns it: the only time it is ever visible. */
  create(name: string): { name: string; password: string }
  revoke(name: string): boolean
  /** True for a device name and password that match; notes the time. Slow on purpose (scrypt). */
  verify(name: string, password: string): boolean
  /** A device with that name exists. */
  has(name: string): boolean
  /** Goes up whenever a device is made or revoked: a sign-in remembered under an older number must be proved again. */
  revision(): number
}

export function createDriveDevices(file: string, now: () => number = Date.now): DriveDevices {
  let all: Saved[] = []
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Saved[]
    if (Array.isArray(v)) all = v.filter(d => typeof d?.name === 'string' && typeof d.salt === 'string' && typeof d.hash === 'string')
  } catch {
    // None yet.
  }
  const save = () => {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  }
  let revision = 0
  return {
    revision: () => revision,
    list: () => all.map(({ name, createdAt, lastUsedAt }) => ({ name, createdAt, ...(lastUsedAt ? { lastUsedAt } : {}) })),
    has: name => all.some(d => nameKey(d.name) === nameKey(name)),
    create(name) {
      const clean = [...name].filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127 && !':/\\'.includes(c)).join('').trim().slice(0, 40)
      if (!clean) throw driveError(400, 'badname', 'A device needs a name.')
      const password = makePassword()
      const salt = randomBytes(16).toString('hex')
      all = [...all.filter(d => nameKey(d.name) !== nameKey(clean)), { name: clean, createdAt: now(), salt, hash: hashOf(password, salt) }]
      save()
      revision++
      return { name: clean, password }
    },
    revoke(name) {
      const before = all.length
      all = all.filter(d => nameKey(d.name) !== nameKey(name))
      if (all.length !== before) {
        save()
        revision++
      }
      return all.length !== before
    },
    verify(name, password) {
      const d = all.find(x => nameKey(x.name) === nameKey(name))
      // The same work whether or not the name exists, so the time doesn't say which names are real.
      const salt = d?.salt ?? '00'.repeat(16)
      const given = Buffer.from(hashOf(password, salt), 'hex')
      const want = Buffer.from(d?.hash ?? '00'.repeat(32), 'hex')
      const ok = d !== undefined && given.length === want.length && timingSafeEqual(given, want)
      if (ok && d) {
        d.lastUsedAt = now()
        save()
      }
      return ok
    },
  }
}

/** Failed sign-ins per remote address: after `max` in `windowMs`, that address is refused until the window passes. */
export function createThrottle(max = 8, windowMs = 60_000, now: () => number = Date.now) {
  const fails = new Map<string, number[]>()
  const recent = (who: string) => (fails.get(who) ?? []).filter(t => now() - t < windowMs)
  return {
    blocked: (who: string) => recent(who).length >= max,
    failed(who: string) {
      fails.set(who, [...recent(who), now()])
    },
    ok(who: string) {
      fails.delete(who)
    },
  }
}
