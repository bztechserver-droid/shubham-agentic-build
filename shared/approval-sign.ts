// F-076 hardening: proof from a registered approval device. A browser (his phone) makes a signing key that cannot be
// exported (WebCrypto, ECDSA P-256), registers its public half with the hub once, and signs every approval and every
// send-as-me. The hub checks the signature against the registered keys only: the page proxy's token alone, which any
// program on the PC can use, is not proof. What is signed is exactly what he saw (the prompt id and option, or the
// target and the words), plus a nonce and the time, so a signature can't be reused, changed or kept for later.
// Types and the text that is signed; nothing here touches a key.

/** What a request carries: which device signed, the nonce and time that were in it, and the signature (base64, raw r||s). */
export interface Signed {
  device: string
  nonce: string
  /** When it was signed (ms since 1970, the device's clock). */
  at: number
  sig: string
}

/** A signature is good for this long either side of the hub's clock. */
export const SIGN_WINDOW_MS = 60_000

/** F-079 'wa-send': a WhatsApp message he sends, over [chatId, sha256(text), the Assistant's draft or ''] (agent/whatsapp/). */
export type SignedKind = 'answer' | 'send' | 'code' | 'remove' | 'unsigned' | 'autoupdate' | 'pair' | 'cancel' | 'wa-send'

/**
 * The text that is signed. Fields are joined with line breaks (none of them can contain one: ids, a number, a hash),
 * so one field can't run into the next, and the kind and the version are in it, so a signature for one thing is
 * never good for another.
 */
export function payloadOf(kind: SignedKind, fields: (string | number | boolean)[], nonce: string, at: number): string {
  return ['sad-approval-v1', kind, ...fields.map(String), nonce, String(at)].join('\n')
}

/** The device's id: the start of the hash of its public key's parts (the same on both sides). */
export interface PublicJwk {
  kty: string
  crv: string
  x: string
  y: string
}

export interface ApprovalDevice {
  id: string
  name: string
  addedAt: string
  lastUsed: string | null
  /**
   * The page address (location.origin, e.g. "https://server.tail36192f.ts.net:5173") the device registered from. A device's key lives in that page's
   * browser storage, so a device registered from an old address can't sign from the new one. Shown for information only, never used to decide anything;
   * absent for devices registered before it was kept.
   */
  origin?: string
}

/** Where a recovery stands (agent/agentic/approval-recovery.ts). */
export type RecoveryState =
  | 'none' // nothing started (or the last one is over and forgotten)
  | 'waiting' // the Windows administrator prompt is open on the PC the hub runs on
  | 'ready' // the prompt was answered Yes: Finish can be pressed
  | 'declined' // No (or closed)
  | 'failed' // the prompt could not be shown or the step did not work
  | 'expired' // more than 5 minutes
  | 'used' // Finish was pressed; the code was given

/** GET /agentic/approvals/devices/recover, and the answer of .../recover/start */
export interface RecoveryAnswer {
  /** False where recovery is not built yet (Linux, macOS): `why` says so in words. */
  supported: boolean
  why?: string
  state: RecoveryState
  startedAt?: string
  /** When the started recovery runs out (5 minutes after the start). */
  expiresAt?: string
  /** What went wrong, in words, for 'declined' and 'failed'. */
  detail?: string
}

/**
 * The answer of POST /agentic/approvals/devices/recover/start: the state, and a one-time `ticket` that only this answer carries (GET never shows it).
 * Finish needs it, so a program that merely shares the page's token can't finish a recovery the person started. Keep it in memory only.
 */
export interface RecoveryStarted extends RecoveryAnswer {
  ticket: string
}

/** The answer of POST /agentic/approvals/devices/recover/finish: a code to register ONE device with, like the first device's. */
export interface RecoveryFinished extends DevicesAnswer {
  code: string
  expiresAt: string
}

/** GET /agentic/approvals/devices */
export interface DevicesAnswer {
  devices: ApprovalDevice[]
  /** The old way is on: a request with no signature is accepted (Settings switch; off to start with). */
  unsignedAllowed: boolean
  /** No device is registered yet: the first one needs only a code from this screen. */
  bootstrap: boolean
}
