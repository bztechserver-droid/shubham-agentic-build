// Accounts, "Authenticator" (order o2881): which email account's authenticator app holds the 2FA codes of an account (an email or a platform account). Three optional fields:
// the email account it is on (picked from the Email tab's list: its address), the app's name, and a short note (the device). NEVER the 2FA secret, a code or a recovery code:
// the checks below accept only these three, and a long or secret-looking note is refused. Pure: no network.

import type { Checked } from './platform-edit.ts'

export const AUTHENTICATOR_APPS = ['Google Authenticator', 'Microsoft Authenticator', 'Authy', 'Other'] as const
export const AUTHENTICATOR_LIMITS = { email: 200, note: 200 } as const

export interface AuthenticatorInput {
  authenticatorEmail: string | null
  authenticatorApp: string | null
  authenticatorNote: string | null
}

const SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
/** A note that looks like it holds a secret (a code, a key, a seed, a recovery code) is refused: those never go in this field. */
const SECRET_WORDS = /\b(secret|seed|recovery code|backup code|otp|totp|key)\b\s*[:=]/i
/** A run of 16+ capitals and digits 2-7 (an authenticator secret is base32): case-sensitive, so ordinary words do not trip it. */
const SECRET_BASE32 = /[A-Z2-7]{16,}/
const SECRET_LOOKING = { test: (s: string) => SECRET_WORDS.test(s) || /\b\d{6}\b/.test(s) || SECRET_BASE32.test(s) }

export function checkAuthenticator(raw: unknown): Checked<AuthenticatorInput> {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const email = typeof r.authenticatorEmail === 'string' ? r.authenticatorEmail.trim() : ''
  if (email.length > AUTHENTICATOR_LIMITS.email) return { ok: false, message: `The authenticator email is longer than ${AUTHENTICATOR_LIMITS.email} characters.` }
  if (email && !SHAPE.test(email)) return { ok: false, message: 'The authenticator email looks like name@example.com.' }
  const app = typeof r.authenticatorApp === 'string' ? r.authenticatorApp.trim() : ''
  if (app && !(AUTHENTICATOR_APPS as readonly string[]).includes(app)) return { ok: false, message: 'Choose the app: Google Authenticator, Microsoft Authenticator, Authy or Other.' }
  const note = typeof r.authenticatorNote === 'string' ? r.authenticatorNote.trim() : ''
  if (note.length > AUTHENTICATOR_LIMITS.note) return { ok: false, message: `The authenticator note is longer than ${AUTHENTICATOR_LIMITS.note} characters.` }
  if (note && SECRET_LOOKING.test(note)) return { ok: false, message: 'The note looks like it holds a code or a key. Write only the device (for example "Shubham\'s phone"); never a code or a secret.' }
  return { ok: true, value: { authenticatorEmail: email || null, authenticatorApp: app || null, authenticatorNote: note || null } }
}

/** The words on a row: "Google Authenticator on ops@example.com · Shubham's phone", or "No authenticator recorded". Never a code. */
export function authenticatorWords(a: { authenticatorEmail: string | null; authenticatorApp: string | null; authenticatorNote: string | null }): string {
  if (!hasAuthenticator(a)) return 'No authenticator recorded'
  const app = a.authenticatorApp ?? 'Authenticator'
  const on = a.authenticatorEmail ? ` on ${a.authenticatorEmail}` : ''
  const note = a.authenticatorNote ? ` · ${a.authenticatorNote}` : ''
  return `${app}${on}${note}`
}

/** Whether an account has an authenticator recorded (any of the three fields). */
export const hasAuthenticator = (a: { authenticatorEmail: string | null; authenticatorApp: string | null; authenticatorNote: string | null }): boolean =>
  Boolean(a.authenticatorEmail || a.authenticatorApp || a.authenticatorNote)
