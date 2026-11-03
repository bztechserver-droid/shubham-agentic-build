import { createHash, randomBytes } from 'node:crypto'
import type { DriveSyncPairing } from '../../shared/drive.ts'

// F-097 part C: one-time codes that pair a sync device without anyone typing a password. The Drive page asks for a code for a named
// device; the sync program on that device hands the code in and gets that device's own password back. A code is good once, for ten
// minutes, and is kept here only as a hash (in memory: a restart of the agent drops them, which is fine for ten minutes).

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const PAIR_TTL_MS = 10 * 60 * 1000

const hash = (code: string) => createHash('sha256').update(code.replace(/[^A-Z0-9]/gi, '').toUpperCase()).digest('hex')

export function makeCode(random: (n: number) => Buffer = randomBytes): string {
  const chars = [...random(8)].map(b => ALPHABET[b % ALPHABET.length])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

export interface Pairing {
  /** A fresh code for a device called `name` (an earlier one for the same name stops working). */
  start(name: string): DriveSyncPairing
  /** The device name a good code was made for, once; null for a wrong, used or expired code. */
  redeem(code: string): string | null
}

export function createPairing(now: () => number = Date.now, random?: (n: number) => Buffer): Pairing {
  const open = new Map<string, { name: string; expiresAt: number }>()
  const sweep = () => {
    for (const [k, v] of open) if (v.expiresAt <= now()) open.delete(k)
  }
  return {
    start(name) {
      sweep()
      for (const [k, v] of open) if (v.name.toLowerCase() === name.toLowerCase()) open.delete(k)
      const code = makeCode(random)
      const expiresAt = now() + PAIR_TTL_MS
      open.set(hash(code), { name, expiresAt })
      return { name, code, expiresAt }
    },
    redeem(code) {
      sweep()
      const k = hash(code)
      const v = open.get(k)
      if (!v) return null
      open.delete(k)
      return v.name
    },
  }
}
