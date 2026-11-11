import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

// order o5c4d: the mailbox passwords are encrypted HERE, in the agent, before they are written to the new database (db/accounts/README.md). AES-256-GCM, a fresh random nonce each time, the key only in
// a file on the Server (accounts-db.key: 32 random bytes, base64). The database holds 'v1:' + base64(nonce | ciphertext | tag) and never the key or the password. A second, separate key (derived from
// the first) makes a keyed fingerprint of the password, so a copy can tell "unchanged" without storing or comparing the password itself.

const NONCE = 12
const TAG = 16

/** The key from its file's text (one line of base64 that decodes to exactly 32 bytes), else null. Never echoes the text. */
export function parseKey(text: string): Buffer | null {
  const line = text.split(/\r?\n/)[0].trim()
  if (!/^[A-Za-z0-9+/]{42,44}={0,2}$/.test(line)) return null
  const key = Buffer.from(line, 'base64')
  return key.length === 32 ? key : null
}

export function encryptPassword(key: Buffer, plain: string): string {
  const nonce = randomBytes(NONCE)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `v1:${Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64')}`
}

/** Only for tests and the later "show one password" slice: throws on a wrong key or any change to the stored text. */
export function decryptPassword(key: Buffer, stored: string): string {
  if (!stored.startsWith('v1:')) throw new Error('not a v1 password')
  const raw = Buffer.from(stored.slice(3), 'base64')
  if (raw.length < NONCE + TAG) throw new Error('too short')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE))
  decipher.setAuthTag(raw.subarray(raw.length - TAG))
  return Buffer.concat([decipher.update(raw.subarray(NONCE, raw.length - TAG)), decipher.final()]).toString('utf8')
}

/** A keyed fingerprint of a password (hex): equal passwords give equal fingerprints, and it reveals nothing without the key. */
export function passwordMac(key: Buffer, plain: string): string {
  const macKey = createHmac('sha256', key).update('sad-accounts-password-mac-v1').digest()
  return createHmac('sha256', macKey).update(plain, 'utf8').digest('hex')
}
