import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ScreenVia } from '../shared/agent-api.ts'
import { writeAtomic } from './config.ts'
import type { Logger } from './log.ts'

// Remember me on Control (F-008): another PC's password, kept as RustDesk's own client keeps it
// for "Remember password" (RustDesk 1.5.0 src/client.rs: handle_login_from_ui, 4818-4848, makes
// H1 = SHA256(password ‖ salt); handle_peer_info, 3681-3715, saves it once the login worked;
// handle_hash, 4632-4760, logs in with it the next time, as SHA256(H1 ‖ challenge); a wrong one
// is dropped and the password asked again, handle_login_error, 4500-4512). Here H1 stays in the
// agent: the page sends it after a login that worked, and later asks for one connection's
// answer, never for H1 itself. The salt is kept beside it, so a password changed on that PC (the
// app's own screen draws a new salt then) is noticed before a wrong try is spent there.
//
// <state>/agent/saved-passwords.json, mode 0600, never logged:
//   { "<device id>": { "app": {salt, h1 (base64), savedAt}, "rustdesk": {...} } }

const VIAS: readonly ScreenVia[] = ['app', 'rustdesk']

interface Saved {
  salt: string
  h1: string
  savedAt: string
}
type Store = Record<string, Partial<Record<ScreenVia, Saved>>>

export interface SavedPasswords {
  /** The ways in whose password is saved for that PC. */
  ways(deviceId: string): ScreenVia[]
  save(deviceId: string, via: ScreenVia, salt: string, h1: Buffer): void
  /** This connection's answer, SHA256(H1 ‖ challenge); null when none is saved, or it was saved for another salt (then it is forgotten). */
  answer(deviceId: string, via: ScreenVia, salt: string, challenge: string): Buffer | null
  /** Both ways when `via` is left out. False when there was nothing to forget. */
  forget(deviceId: string, via?: ScreenVia): boolean
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const h1Of = (s: Saved) => Buffer.from(s.h1, 'base64')

function load(file: string): Store {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  const out: Store = {}
  if (!isObject(raw)) return out
  for (const [id, ways] of Object.entries(raw)) {
    if (!isObject(ways)) continue
    for (const via of VIAS) {
      const s = ways[via]
      if (!isObject(s) || typeof s.salt !== 'string' || typeof s.h1 !== 'string' || typeof s.savedAt !== 'string') continue
      if (Buffer.from(s.h1, 'base64').length !== 32) continue
      ;(out[id] ??= {})[via] = { salt: s.salt, h1: s.h1, savedAt: s.savedAt }
    }
  }
  return out
}

export function createSavedPasswords(file: string, log: Logger): SavedPasswords {
  const all = load(file)
  const write = () => writeAtomic(file, JSON.stringify(all, null, 2) + '\n', 0o600)

  function forget(deviceId: string, via?: ScreenVia) {
    const ways = all[deviceId]
    if (!ways) return false
    let gone = false
    for (const v of via ? [via] : VIAS) {
      if (!ways[v]) continue
      delete ways[v]
      gone = true
    }
    if (!gone) return false
    if (!VIAS.some(v => ways[v])) delete all[deviceId]
    write()
    return true
  }

  return {
    ways: deviceId => VIAS.filter(v => all[deviceId]?.[v]),

    save(deviceId, via, salt, h1) {
      if (h1.length !== 32) throw new Error('H1 is 32 bytes')
      ;(all[deviceId] ??= {})[via] = { salt, h1: h1.toString('base64'), savedAt: new Date().toISOString() }
      write()
      log.info(`saved the ${via === 'app' ? "app's own screen" : 'RustDesk'} password for ${deviceId}`)
    },

    answer(deviceId, via, salt, challenge) {
      const s = all[deviceId]?.[via]
      if (!s) return null
      if (s.salt !== salt) {
        // That PC's password changed since (a new salt): this one can only be wrong.
        forget(deviceId, via)
        log.info(`the saved ${via} password for ${deviceId} is from before its password changed: forgotten`)
        return null
      }
      return createHash('sha256').update(h1Of(s)).update(challenge, 'utf8').digest()
    },

    forget(deviceId, via) {
      const gone = forget(deviceId, via)
      if (gone) log.info(`forgot the saved ${via ?? ''}${via ? ' ' : ''}password${via ? '' : 's'} for ${deviceId}`)
      return gone
    },
  }
}
