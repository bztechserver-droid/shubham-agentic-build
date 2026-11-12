// Accounts edit slice: the platform account's editable fields (what the agent checks and the page sends). Pure: no network.

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string }

export const PLATFORM_EDIT_LIMITS = { platform: 80, accountType: 80, name: 200, signInEmail: 200, phone: 60 } as const

export interface PlatformEditInput {
  platform: string
  accountType: string | null
  name: string | null
  signInEmail: string | null
  phone: string | null
  disabled: boolean
}

const SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const opt = (v: unknown, max: number, what: string): Checked<string | null> => {
  const t = typeof v === 'string' ? v.trim() : ''
  if (!t) return { ok: true, value: null }
  if (t.length > max) return { ok: false, message: `The ${what} is longer than ${max} characters.` }
  return { ok: true, value: t }
}

export function checkPlatformEdit(raw: unknown): Checked<PlatformEditInput> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, message: 'The account is missing.' }
  const r = raw as Record<string, unknown>
  const platform = typeof r.platform === 'string' ? r.platform.trim() : ''
  if (!platform) return { ok: false, message: 'An account needs a platform (for example Vercel or GitHub).' }
  if (platform.length > PLATFORM_EDIT_LIMITS.platform) return { ok: false, message: `The platform is longer than ${PLATFORM_EDIT_LIMITS.platform} characters.` }
  const accountType = opt(r.accountType, PLATFORM_EDIT_LIMITS.accountType, 'account type')
  if (!accountType.ok) return accountType
  const name = opt(r.name, PLATFORM_EDIT_LIMITS.name, 'name')
  if (!name.ok) return name
  const email = opt(r.signInEmail, PLATFORM_EDIT_LIMITS.signInEmail, 'sign-in email')
  if (!email.ok) return email
  if (email.value !== null && !SHAPE.test(email.value)) return { ok: false, message: 'The sign-in email looks like name@example.com.' }
  const phone = opt(r.phone, PLATFORM_EDIT_LIMITS.phone, 'phone')
  if (!phone.ok) return phone
  if (r.disabled !== undefined && typeof r.disabled !== 'boolean') return { ok: false, message: 'Switched off is yes or no.' }
  return {
    ok: true,
    value: { platform, accountType: accountType.value, name: name.value, signInEmail: email.value, phone: phone.value, disabled: r.disabled === true },
  }
}
