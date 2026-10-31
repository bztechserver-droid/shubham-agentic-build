import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
  type KeyObject,
} from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pem, selfSignedEd25519 } from './der.ts'

// The device's identity: an Ed25519 key, a self-signed certificate for TLS, the device ID
// derived from the key, and the uuid hbbs binds that ID to. Files, under <state>/agent/identity:
//   device.key  PKCS#8 PEM      device.crt  PEM      uuid  16 random bytes, hex

export interface Identity {
  /** base32(sha256(SPKI)), lowercase, 16 characters. Also the device's hbbs ID. */
  id: string
  key: KeyObject
  keyPem: string
  certPem: string
  spkiSha256: Buffer
  /** hbbs binds an ID to its first uuid forever, so it never changes once written. */
  uuid: Buffer
}

const KEY_FILE = 'device.key'
const CERT_FILE = 'device.crt'
const UUID_FILE = 'uuid'
const DAY_MS = 86_400_000
const CERT_YEARS = 20

export function spkiSha256(publicKey: KeyObject): Buffer {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest()
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lowercase, without padding. */
export function base32(buf: Buffer): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** The device ID: the first 16 base32 characters (80 bits) of sha256(SPKI). */
export const deviceId = (spki: Buffer) => base32(spki).slice(0, 16)

/** A fresh self-signed certificate for `key`: CN=sad-<id>, valid from a day ago for 20 years. */
export function makeCertificate(key: KeyObject, id: string, now = new Date()): string {
  const serial = randomBytes(16)
  serial[0] &= 0x7f // positive without a leading zero byte
  const notAfter = new Date(now)
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + CERT_YEARS)
  const der = selfSignedEd25519({
    key,
    cn: `sad-${id}`,
    serial,
    notBefore: new Date(now.getTime() - DAY_MS),
    notAfter,
  })
  return pem(der, 'CERTIFICATE')
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

function parseUuid(text: string | null): Buffer | null {
  const hex = text?.trim() ?? ''
  return /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, 'hex') : null
}

// A new key means a new device ID and pairing again, so a broken identity is never replaced
// on its own: the person decides.
function broken(dir: string, problem: string) {
  return new Error(
    `The device identity in ${dir} is unusable: ${problem}. It is never replaced automatically, ` +
      `because a new key is a new device that must pair again. To reset it, stop the agent, delete ` +
      `${KEY_FILE}, ${CERT_FILE} and ${UUID_FILE} in that folder, start the agent and pair this PC again.`,
  )
}

/** Loads this device's identity from `dir`, or creates it there on first start. */
export async function loadOrCreateIdentity(dir: string, log?: (msg: string) => void): Promise<Identity> {
  const keyFile = path.join(dir, KEY_FILE)
  const certFile = path.join(dir, CERT_FILE)
  const uuidFile = path.join(dir, UUID_FILE)
  const [keyPem, certPem, uuidText] = await Promise.all([keyFile, certFile, uuidFile].map(readIfExists))

  if (keyPem === null && certPem === null) {
    await mkdir(dir, { recursive: true })
    const { privateKey } = generateKeyPairSync('ed25519')
    const spki = spkiSha256(createPublicKey(privateKey))
    const id = deviceId(spki)
    const newKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const newCertPem = makeCertificate(privateKey, id)
    // A uuid left from an earlier identity is kept: it binds nothing until hbbs sees it with an ID.
    let uuid = parseUuid(uuidText)
    if (!uuid) {
      uuid = randomBytes(16)
      await writeFile(uuidFile, uuid.toString('hex') + '\n')
    }
    // 'wx' fails rather than overwrite, should another agent be creating the same identity.
    await writeFile(certFile, newCertPem, { flag: 'wx' })
    await writeFile(keyFile, newKeyPem, { flag: 'wx', mode: 0o600 })
    log?.(`identity: created device ${id} in ${dir}`)
    return { id, key: privateKey, keyPem: newKeyPem, certPem: newCertPem, spkiSha256: spki, uuid }
  }

  if (keyPem === null) throw broken(dir, `${CERT_FILE} is there but ${KEY_FILE} is missing`)
  if (certPem === null) throw broken(dir, `${KEY_FILE} is there but ${CERT_FILE} is missing`)

  let key: KeyObject
  let cert: X509Certificate
  try {
    key = createPrivateKey(keyPem)
  } catch {
    throw broken(dir, `${KEY_FILE} is not a readable private key`)
  }
  if (key.asymmetricKeyType !== 'ed25519') throw broken(dir, `${KEY_FILE} is not an Ed25519 key`)
  try {
    cert = new X509Certificate(certPem)
  } catch {
    throw broken(dir, `${CERT_FILE} is not a readable certificate`)
  }
  const publicKey = createPublicKey(key)
  const spki = spkiSha256(publicKey)
  if (!spkiSha256(cert.publicKey).equals(spki)) throw broken(dir, `${CERT_FILE} does not belong to ${KEY_FILE}`)
  if (!cert.verify(publicKey)) throw broken(dir, `${CERT_FILE} is not signed by ${KEY_FILE}`)
  const id = deviceId(spki)
  const uuid = parseUuid(uuidText)
  // hbbs already knows this ID with its uuid; a new one would be refused there.
  if (!uuid) throw broken(dir, `${UUID_FILE} is ${uuidText === null ? 'missing' : 'not 32 hex digits'}`)
  return { id, key, keyPem, certPem, spkiSha256: spki, uuid }
}
