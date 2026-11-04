import { createHash, createPublicKey, randomInt, verify } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { SIGN_WINDOW_MS, payloadOf, type ApprovalDevice, type PublicJwk, type Signed, type SignedKind } from '../../shared/approval-sign.ts'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'

// F-076 hardening: the registered approval devices (the hub keeps them) and the check that a request was signed by one.

interface Stored extends ApprovalDevice {
  jwk: PublicJwk
}
interface DevicesFile {
  devices: Stored[]
  unsignedAllowed: boolean
}

const CODE_MS = 5 * 60_000
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/

/** The id a public key has: the same hash on the page. */
export const deviceIdOf = (jwk: PublicJwk) => createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('hex').slice(0, 16)

const isJwk = (v: unknown): v is PublicJwk => typeof v === 'object' && v !== null && (v as PublicJwk).kty === 'EC' && (v as PublicJwk).crv === 'P-256' && typeof (v as PublicJwk).x === 'string' && typeof (v as PublicJwk).y === 'string' && (v as PublicJwk).x.length <= 64 && (v as PublicJwk).y.length <= 64

/**
 * A page address worth keeping: "https://host:port" exactly as a browser's location.origin writes it (no path, no login), at most 200 characters; else
 * undefined. For showing only: nothing is ever decided by it (the page says it itself, so it proves nothing).
 */
export function cleanOrigin(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200) return undefined
  try {
    const u = new URL(v)
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.origin !== v) return undefined
    return u.origin
  } catch {
    return undefined
  }
}

export interface DeviceStore {
  list(): ApprovalDevice[]
  count(): number
  unsignedAllowed(): boolean
  setUnsignedAllowed(on: boolean): void
  /** A one-time code that lets one device register (5 minutes). */
  newCode(): { code: string; expiresAt: string }
  /** Registers a device with a code (used once). Throws when the code isn't good. */
  register(name: unknown, jwk: unknown, code: unknown, origin?: unknown): ApprovalDevice
  remove(id: string): boolean
  /**
   * That `signed` is a signature by a registered device of `payload` made now and never seen: throws 401 otherwise.
   * The device's `lastUsed` is noted.
   */
  verify(kind: SignedKind, fields: (string | number | boolean)[], signed: unknown): ApprovalDevice
}

export function createDeviceStore(file: string, now: () => number = Date.now): DeviceStore {
  let data: DevicesFile = { devices: [], unsignedAllowed: false }
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<DevicesFile>
      data = {
        devices: Array.isArray(raw.devices) ? raw.devices.filter(d => d && typeof d.id === 'string' && isJwk(d.jwk) && deviceIdOf(d.jwk) === d.id) : [],
        unsignedAllowed: raw.unsignedAllowed === true,
      }
    } catch {
      // Not readable: no devices, the old way off (the safe state).
    }
  }
  const save = () => writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
  const pub = ({ id, name, addedAt, lastUsed, origin }: Stored): ApprovalDevice => ({ id, name, addedAt, lastUsed, ...(origin ? { origin } : {}) })
  let code: { value: string; until: number } | null = null
  /** Nonces seen lately: a signature is good once. */
  const seen = new Map<string, number>()
  const sweep = () => {
    const t = now()
    for (const [n, until] of seen) if (until < t) seen.delete(n)
  }

  return {
    list: () => data.devices.map(pub),
    count: () => data.devices.length,
    unsignedAllowed: () => data.unsignedAllowed,
    setUnsignedAllowed(on) {
      data.unsignedAllowed = on
      save()
    },
    newCode() {
      // Six digits, one at a time; a new code replaces the one before.
      const value = String(randomInt(0, 1_000_000)).padStart(6, '0')
      code = { value, until: now() + CODE_MS }
      return { code: value, expiresAt: new Date(code.until).toISOString() }
    },
    register(name, jwk, given, originGiven) {
      if (!code || code.until < now() || typeof given !== 'string' || given !== code.value) throw apiError(403, 'That code is not right, or it has run out. Ask for a new one.')
      if (!isJwk(jwk)) throw apiError(400, 'Expected the device\'s public key (ECDSA P-256)')
      const nm = typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : 'A device'
      const id = deviceIdOf(jwk)
      // The code is used up whether or not the key was new.
      code = null
      const had = data.devices.find(d => d.id === id)
      if (had) {
        had.name = nm
        const again = cleanOrigin(originGiven)
        if (again) had.origin = again
        save()
        return pub(had)
      }
      const origin = cleanOrigin(originGiven)
      const d: Stored = { id, name: nm, addedAt: new Date(now()).toISOString(), lastUsed: null, ...(origin ? { origin } : {}), jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } }
      data.devices.push(d)
      save()
      return pub(d)
    },
    remove(id) {
      const n = data.devices.length
      data.devices = data.devices.filter(d => d.id !== id)
      if (data.devices.length === n) return false
      save()
      return true
    },
    verify(kind, fields, signed) {
      const s = signed as Partial<Signed> | null | undefined
      if (!s || typeof s.device !== 'string' || typeof s.nonce !== 'string' || typeof s.at !== 'number' || typeof s.sig !== 'string') throw apiError(401, 'This needs a signature from a registered approval device.')
      const d = data.devices.find(x => x.id === s.device)
      if (!d) throw apiError(401, 'That device is not registered as an approval device.')
      if (!NONCE_RE.test(s.nonce)) throw apiError(401, 'The signature is malformed.')
      const t = now()
      if (Math.abs(t - s.at) > SIGN_WINDOW_MS) throw apiError(401, 'The signature is too old (or the device clock is wrong). Try again.')
      sweep()
      if (seen.has(s.nonce)) throw apiError(401, 'That signature was already used.')
      let ok = false
      try {
        ok = verify('sha256', Buffer.from(payloadOf(kind, fields, s.nonce, s.at)), { key: createPublicKey({ key: d.jwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s.sig, 'base64'))
      } catch {
        ok = false
      }
      if (!ok) throw apiError(401, "The signature doesn't match what was asked.")
      // Spent only once it is good (a forged one can't use up a real nonce), and kept for as long as it could be replayed.
      seen.set(s.nonce, t + 2 * SIGN_WINDOW_MS)
      d.lastUsed = new Date(t).toISOString()
      save()
      return pub(d)
    },
  }
}
