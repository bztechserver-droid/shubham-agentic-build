// order o57e2, o4d14: the Accounts page's Email tab lists the email accounts kept in the NEW Supabase project (schema sad: db/accounts/README.md). This is the pure part: the shape the page gets, what may leave
// the agent (a WHITELIST of fields, so a column added one day is not passed on by accident), the provider named from the address, and the one rule for a note that looks like it holds a secret. The agent's
// route is agent/agentic/accounts-email.ts; the page is src/accounts/EmailTab.tsx. There is no password, recovery address or phone in this shape, and no way to ask for one.

/** One email account as the page sees it. */
export interface EmailAccountRow {
  id: string
  address: string
  /** Named from the address's domain ("Gmail", "Outlook", the domain itself for an own domain). The database stores no provider for these. */
  provider: string
  /** The row's note, unless it looks like it holds a password or key (then null and noteHidden is true). */
  note: string | null
  noteHidden: boolean
  /** Switched off (kept in the list, last). These are a list of logins: nothing is connected from here, so there is no "connected" or "needs sign-in" state to show. */
  disabled: boolean
  /** What each is used for ("Spotify", "LinkedIn"): the names only. */
  usedFor: string[]
  /** The CRM's Emails page shows these two beside the address: kept (this page is the owner's), and searched like the CRM's. */
  recoveryEmail: string | null
  phone: string | null
  /** A password is stored (encrypted) for this account. Only THAT it exists: the password itself is never in this shape, never sent to a page, and not readable by the reading login at all. */
  hasPassword: boolean
  /** The CRM's own "last changed" for this account (an ISO time), for the table's date column; null when unknown. */
  updatedAt: string | null
  /** Order o2881: the email account whose authenticator app holds this account's 2FA codes (its address), the app's name, and the device note. Never a code or a secret. */
  authenticatorEmail: string | null
  authenticatorApp: string | null
  authenticatorNote: string | null
}

/** Why the list is not there yet. Each has plain words and a next step (agent/agentic/accounts-email.ts). */
export type NotConnected = 'not-set-up' | 'package-missing' | 'login' | 'unreachable' | 'no-tables' | 'needs-update'

/** What the agent answers: the list, or a plain reason there is none yet (not an error: the page explains what comes next). */
export type EmailAccountsAnswer = { connected: true; accounts: EmailAccountRow[] } | { connected: false; reason: NotConnected; message: string }

const MAX_ACCOUNTS = 500
const MAX_ADDRESS = 200
const MAX_NOTE = 140
const MAX_USES = 12
const MAX_USE_NAME = 200
const MAX_CONTACT = 200

const PROVIDERS: [RegExp, string][] = [
  [/^(gmail|googlemail)\.com$/, 'Gmail'],
  [/^(outlook|hotmail|live|msn)\.[a-z.]+$/, 'Outlook'],
  [/^yahoo\.[a-z.]+$|^ymail\.com$/, 'Yahoo'],
  [/^(icloud|me|mac)\.com$/, 'iCloud'],
  [/^(proton\.me|protonmail\.com|pm\.me)$/, 'Proton'],
  [/^zoho\.[a-z.]+$/, 'Zoho'],
  [/^(aol\.com)$/, 'AOL'],
  [/^(gmx\.[a-z.]+)$/, 'GMX'],
]

/** The provider named from the address: "Gmail", "Outlook" and so on for the well-known mail sites, else the domain itself (a company's own mail), else "Unknown". */
export function providerOf(address: string): string {
  const at = address.lastIndexOf('@')
  const domain = at >= 0 ? address.slice(at + 1).trim().toLowerCase() : ''
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) return 'Unknown'
  for (const [re, name] of PROVIDERS) if (re.test(domain)) return name
  return domain
}

/** A note that talks about a password, a PIN, a code, a token or a key: it may BE one, so it is never shown (the page says so). */
const SECRETISH = /\bpass(word|wd|code|phrase)?\b|\bpwd\b|\bpin\b|\botp\b|\btoken\b|\bsecret\b|api[-_ ]?key|\bkey\b|\bcode\b|2fa|credential/i

/** The note as it may be shown: cut short, or hidden when it looks like it holds a secret. */
export function safeNote(raw: unknown): { note: string | null; hidden: boolean } {
  if (typeof raw !== 'string') return { note: null, hidden: false }
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return { note: null, hidden: false }
  if (SECRETISH.test(text)) return { note: null, hidden: true }
  return { note: text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE)}…` : text, hidden: false }
}

function isoOrNull(v: unknown): string | null {
  const d = v instanceof Date ? v : typeof v === 'string' ? new Date(v) : null
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Rows as the database gave them ({ id, address, description, isDisabled, uses: [{ usedFor }] }, in a list or as { emailAccounts: [...] }) as safe rows. Only these fields are ever read from a row: id,
 * address, description, isDisabled and the NAMES in uses (usedFor). Anything else a row carries (a column added one day, a password, who made it, dates) is dropped here, on the agent, and never reaches
 * a page or a log. A row with no usable address is left out. Null when it is not a list at all.
 */
export function safeEmailRows(raw: unknown): EmailAccountRow[] | null {
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.emailAccounts) ? raw.emailAccounts : null
  if (!list) return null
  const rows: EmailAccountRow[] = []
  for (const r of list.slice(0, MAX_ACCOUNTS)) {
    if (!isObject(r)) continue
    const address = typeof r.address === 'string' ? r.address.trim() : ''
    if (!address || address.length > MAX_ADDRESS || !address.includes('@')) continue
    const id = typeof r.id === 'string' && r.id ? r.id.slice(0, 80) : address
    const { note, hidden } = safeNote(r.description)
    const usedFor = (Array.isArray(r.uses) ? r.uses : [])
      .map(u => (isObject(u) && typeof u.usedFor === 'string' ? u.usedFor.replace(/\s+/g, ' ').trim().slice(0, MAX_USE_NAME) : ''))
      .filter(Boolean)
      .slice(0, MAX_USES)
    const contact = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_CONTACT) : null)
    rows.push({ id, address, provider: providerOf(address), note, noteHidden: hidden, disabled: r.isDisabled === true, usedFor, recoveryEmail: contact(r.recoveryEmail), phone: contact(r.phone), hasPassword: r.hasPassword === true, updatedAt: isoOrNull(r.updatedAt), authenticatorEmail: contact(r.authenticatorEmail), authenticatorApp: contact(r.authenticatorApp), authenticatorNote: contact(r.authenticatorNote) })
  }
  // Switched on first, then by address (the query sorts them so; kept here so the page never depends on it).
  return rows.sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.address.localeCompare(b.address))
}

/** The words for a row's state. */
export const statusWords = (r: Pick<EmailAccountRow, 'disabled'>): string => (r.disabled ? 'Switched off' : 'Active')

/** The CRM's Emails page has two filters: a search word and the state (All, Active, Disabled). The same two here. */
export type EmailStatusFilter = 'all' | 'active' | 'disabled'
export const EMAIL_STATUS_FILTERS: readonly { value: EmailStatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Disabled' },
]

/**
 * The rows the filters keep, as the CRM's Emails page does it: the state first (active hides the switched-off ones, disabled shows only them), then the search word (trimmed, any case) against the address,
 * the recovery address, the phone and the note. An empty word keeps all. (A note that was hidden because it mentions a secret cannot be matched.)
 */
export function filterEmailRows(rows: EmailAccountRow[], f: { search: string; status: EmailStatusFilter }): EmailAccountRow[] {
  const q = f.search.trim().toLowerCase()
  return rows.filter(r => {
    if (f.status === 'active' && r.disabled) return false
    if (f.status === 'disabled' && !r.disabled) return false
    if (!q) return true
    return r.address.toLowerCase().includes(q) || (r.recoveryEmail ?? '').toLowerCase().includes(q) || (r.phone ?? '').toLowerCase().includes(q) || (r.note ?? '').toLowerCase().includes(q)
  })
}

/** What a copy from the CRM reports (counts and sizes only, never contents). */
export interface ImportReport {
  mode: 'check' | 'copy'
  /** What the CRM has, from one read of its list. */
  crm: { total: number; active: number; disabled: number; withPassword: number; uses: number; bytes: number }
  /** What copying would do (or did), against what the new database already holds. Null when the new database or the key is not set up yet: then only the CRM's counts are known. */
  plan: { insert: number; update: number; unchanged: number; keptByApp?: number; goneFromCrm: number } | null
  /** Why there is no plan, in plain words. */
  planNote: string | null
  /** Only for a copy that ran. */
  done: { inserted: number; updated: number; unchanged: number; flaggedGone: number; batches: number } | null
}
