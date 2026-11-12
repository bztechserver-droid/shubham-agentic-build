import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'
import { decryptPassword, encryptPassword, parseKey } from './accounts-crypto.ts'

// Order o7f34: the Anthropic API key the efficient route may use (Settings › Old app reader). It is kept HERE, on the Server only, encrypted
// (AES-256-GCM, the same code as the mailbox passwords: accounts-crypto.ts). The sealed key is in model-key.json; the 32-byte key that opens
// it is in model-key.key, beside it. Neither is ever sent back: the API says only whether a key is saved and when it was saved. The key is
// never written to a log, a chat, a browser or an error message; its text is handed on only to the API client, in memory, for one request.
// Honest limit: the key file sits next to the sealed one on the same disk, so this protects against the sealed file alone (a copy, a backup,
// a screenshot of the folder listing), not against someone who can read the whole state folder.

const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,250}$/

/** Is this text an Anthropic API key by its shape (not checked with Anthropic; that is the Test button's job)? */
export function looksLikeApiKey(text: unknown): text is string {
  return typeof text === 'string' && KEY_SHAPE.test(text.trim())
}

export interface ModelKeyStatus {
  saved: boolean
  /** When it was saved (ms since the epoch), or null. */
  savedAt: number | null
}

export interface ModelKeyStore {
  status(): ModelKeyStatus
  /** Saves a key (replacing one). Refused with plain words when it does not look like a key; the text is never echoed. */
  set(text: unknown): ModelKeyStatus
  clear(): ModelKeyStatus
  /** The plain key, for one request. null when none is saved or it cannot be opened. Never store or show the result. */
  use(): string | null
}

interface Sealed {
  v: 1
  savedAt: number
  sealed: string
}

export function createModelKeyStore(dir: string, now: () => number = Date.now): ModelKeyStore {
  const file = path.join(dir, 'model-key.json')
  const keyFile = path.join(dir, 'model-key.key')

  const readSealed = (): Sealed | null => {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Sealed>
      if (raw.v === 1 && typeof raw.sealed === 'string' && raw.sealed !== '' && typeof raw.savedAt === 'number') return raw as Sealed
    } catch {
      // No file, or damaged: no key saved.
    }
    return null
  }

  /** The key that opens the sealed key: made once, on the first save. */
  const masterKey = (create: boolean): Buffer | null => {
    if (existsSync(keyFile)) {
      try {
        return parseKey(readFileSync(keyFile, 'utf8'))
      } catch {
        return null
      }
    }
    if (!create) return null
    const fresh = randomBytes(32)
    writeFileSync(keyFile, `${fresh.toString('base64')}\n`, { mode: 0o600, flag: 'wx' })
    return fresh
  }

  const statusOf = (s: Sealed | null): ModelKeyStatus => (s ? { saved: true, savedAt: s.savedAt } : { saved: false, savedAt: null })

  return {
    status: () => statusOf(readSealed()),
    set(text) {
      if (!looksLikeApiKey(text)) throw apiError(400, 'That does not look like an Anthropic API key (it starts with sk-ant-).')
      const master = masterKey(true)
      if (!master) throw apiError(500, 'The key file on the Server cannot be read, so the key was not saved.')
      const saved: Sealed = { v: 1, savedAt: now(), sealed: encryptPassword(master, text.trim()) }
      writeAtomic(file, `${JSON.stringify(saved, null, 2)}\n`)
      return statusOf(saved)
    },
    clear() {
      // An empty sealed value is "no key" (readSealed refuses it). If the file cannot be written the key stays, and status() says so.
      writeAtomic(file, `${JSON.stringify({ v: 1, savedAt: 0, sealed: '' })}\n`)
      return statusOf(readSealed())
    },
    use() {
      const s = readSealed()
      if (!s || !s.sealed) return null
      const master = masterKey(false)
      if (!master) return null
      try {
        return decryptPassword(master, s.sealed)
      } catch {
        return null
      }
    },
  }
}
