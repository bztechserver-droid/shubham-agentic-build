// Order ofd53 (slice 1 of o45c0): the email edit modal's fields. The rules the agent and the page both use: the address, the recovery email, the phone, the
// note, the switched-off flag, and the password (write only: it is checked for length here, sealed by the agent, and never given back). Pure: no network.

export const EMAIL_EDIT_LIMITS = { address: 200, recovery: 200, phone: 60, note: 5000, password: 500 } as const

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string }

const SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export interface EmailEditInput {
  address: string
  recoveryEmail: string | null
  phone: string | null
  note: string | null
  disabled: boolean
  /** The new password: null or '' keeps the stored one; a value replaces it (sealed by the agent). */
  password: string | null
  /** True when the note is shown as hidden (it looked like a secret): the stored note is kept as it is. */
  keepNote: boolean
}

export function checkAddress(v: unknown): Checked<string> {
  const t = typeof v === 'string' ? v.trim() : ''
  if (!t) return { ok: false, message: 'An email account needs an address.' }
  if (t.length > EMAIL_EDIT_LIMITS.address || !SHAPE.test(t)) return { ok: false, message: 'The address looks like name@example.com.' }
  return { ok: true, value: t }
}

/** An optional address (recovery email): empty is null. */
export function checkOptionalAddress(v: unknown, what: string): Checked<string | null> {
  const t = typeof v === 'string' ? v.trim() : ''
  if (!t) return { ok: true, value: null }
  if (t.length > EMAIL_EDIT_LIMITS.recovery || !SHAPE.test(t)) return { ok: false, message: `The ${what} looks like name@example.com.` }
  return { ok: true, value: t }
}

export function checkPhone(v: unknown): Checked<string | null> {
  const t = typeof v === 'string' ? v.trim() : ''
  if (!t) return { ok: true, value: null }
  if (t.length > EMAIL_EDIT_LIMITS.phone) return { ok: false, message: `The phone is longer than ${EMAIL_EDIT_LIMITS.phone} characters.` }
  return { ok: true, value: t }
}

export function checkNote(v: unknown): Checked<string | null> {
  const t = typeof v === 'string' ? v.trim() : ''
  if (!t) return { ok: true, value: null }
  if (t.length > EMAIL_EDIT_LIMITS.note) return { ok: false, message: `The note is longer than ${EMAIL_EDIT_LIMITS.note} characters.` }
  return { ok: true, value: t }
}

/** The password: null or empty keeps the stored one. Only its length is checked; it is never trimmed or shown. */
export function checkPassword(v: unknown): Checked<string | null> {
  if (v === undefined || v === null || v === '') return { ok: true, value: null }
  if (typeof v !== 'string') return { ok: false, message: 'The password is text.' }
  if (v.length > EMAIL_EDIT_LIMITS.password) return { ok: false, message: `The password is longer than ${EMAIL_EDIT_LIMITS.password} characters.` }
  return { ok: true, value: v }
}

/** Every field at once: the first problem is the answer (plain words). */
export function checkEmailEdit(raw: unknown): Checked<EmailEditInput> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, message: 'The email account is missing.' }
  const r = raw as Record<string, unknown>
  const address = checkAddress(r.address)
  if (!address.ok) return address
  const recovery = checkOptionalAddress(r.recoveryEmail, 'recovery email')
  if (!recovery.ok) return recovery
  const phone = checkPhone(r.phone)
  if (!phone.ok) return phone
  const note = checkNote(r.note)
  if (!note.ok) return note
  const password = checkPassword(r.password)
  if (!password.ok) return password
  if (r.disabled !== undefined && typeof r.disabled !== 'boolean') return { ok: false, message: 'Switched off is yes or no.' }
  if (r.keepNote !== undefined && typeof r.keepNote !== 'boolean') return { ok: false, message: 'keepNote is yes or no.' }
  return {
    ok: true,
    value: { address: address.value, recoveryEmail: recovery.value, phone: phone.value, note: note.value, disabled: r.disabled === true, password: password.value, keepNote: r.keepNote === true },
  }
}
