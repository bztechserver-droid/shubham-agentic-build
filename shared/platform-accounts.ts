import { looksSecret } from './codebase-accounts.ts'

// order o4029: the Accounts page's "Accounts" tab: the SAME page as the CRM's Code > Accounts (the platform accounts: Vercel, Supabase, GitHub...), kept in the NEW Supabase project (db/accounts/0004 and
// 0005) and reached through the agent. The pure part: the shape the page gets (a whitelist; there is no password or token in it, only that a password is stored), the platform names the CRM shows, and the
// CRM page's filters to the letter: Search, Type, Platform, Codebase, the All / Active / Disabled tab (opens on Active) and the four quick filters (No codebase, No phone, Not in Emails, Not in Contacts).
// The agent's route is agent/agentic/accounts-platforms.ts, the page src/accounts/PlatformsTab.tsx.

/** The CRM's list of platforms and the words it shows for them (a platform typed by hand is its own label). */
export const PLATFORM_LABELS: Record<string, string> = {
  github: 'GitHub', vercel: 'Vercel', netlify: 'Netlify', render: 'Render', railway: 'Railway', cloudflare: 'Cloudflare', aws: 'AWS', digitalocean: 'DigitalOcean', hostinger: 'Hostinger', spotify: 'Spotify',
  supabase: 'Supabase', neon: 'Neon', mongodb: 'MongoDB Atlas', planetscale: 'PlanetScale', firebase: 'Firebase',
}
export const platformLabel = (p: string): string => PLATFORM_LABELS[p] ?? p
export const PART_LABEL: Record<'be' | 'fe', string> = { be: 'BE', fe: 'FE' }

/** A codebase an account is connected to, and which part of it (BE, FE or both) is deployed from the account. */
export interface PlatformCodebaseLink {
  /** The copied codebase's row id (the Codebases tab can open it); null when that codebase is not in the copy. */
  codebaseId: string | null
  name: string
  parts: ('be' | 'fe')[]
}

/** One platform account as the page sees it. No password, no token, no key: only THAT a password is stored. */
export interface PlatformAccountRow {
  id: string
  /** The platform's key as the CRM keeps it ("vercel") and the words for it ("Vercel"). */
  platform: string
  platformName: string
  /** What the account is for (Deployment, Database...), as the CRM's type name; null: no type. */
  accountType: string | null
  accountTypeDisabled: boolean
  /** The account's own name on the platform (the team or user name). */
  name: string | null
  /** The email address it signs in with, and its row on the Email tab (null when that address is not in the copied email list). */
  signInEmail: string | null
  emailId: string | null
  /** The address is in the CRM's Emails directory (else the CRM says "Not in Emails"), and that email is switched off there ("Disabled in Emails"). */
  inEmails: boolean
  emailDisabled: boolean
  phone: string | null
  contactName: string | null
  /** The number is linked to a contact (else "Not in Contacts"), and that contact is switched off ("Contact disabled"). */
  contactLinked: boolean
  contactDisabled: boolean
  hasPassword: boolean
  disabled: boolean
  updatedAt: string | null
  codebases: PlatformCodebaseLink[]
}

import type { NotConnected } from './email-accounts.ts'
export type PlatformsAnswer = { connected: true; accounts: PlatformAccountRow[] } | { connected: false; reason: NotConnected; message: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const MAX_ROWS = 2000

function isoOf(v: unknown): string | null {
  const d = v instanceof Date ? v : typeof v === 'string' ? new Date(v) : null
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null
}

/** The agent's rows as the page's rows. Only these fields are read; a value that looks like a secret is dropped (the name, the phone, the type: none should ever look like one). A row without an id or a platform is left out. Null when it is not a list. */
export function safePlatformRows(raw: unknown): PlatformAccountRow[] | null {
  if (!Array.isArray(raw)) return null
  const rows: PlatformAccountRow[] = []
  for (const r of raw.slice(0, MAX_ROWS)) {
    if (!isObject(r)) continue
    const id = typeof r.id === 'string' && r.id ? r.id.slice(0, 80) : ''
    const platform = str(r.platform, 80)
    if (!id || !platform) continue
    const clean = (v: unknown, max: number): string | null => {
      const t = str(v, max)
      return t !== null && looksSecret(t) ? null : t
    }
    const codebases: PlatformCodebaseLink[] = []
    for (const c of (Array.isArray(r.codebases) ? r.codebases : []).slice(0, 60)) {
      if (!isObject(c)) continue
      const name = str(c.name, 200)
      if (!name) continue
      codebases.push({ codebaseId: str(c.codebaseId, 80), name, parts: (Array.isArray(c.parts) ? c.parts : []).filter((p): p is 'be' | 'fe' => p === 'be' || p === 'fe') })
    }
    codebases.sort((a, b) => a.name.localeCompare(b.name))
    rows.push({
      id,
      platform,
      platformName: platformLabel(platform),
      accountType: clean(r.accountType, 80),
      accountTypeDisabled: r.accountTypeDisabled === true,
      name: clean(r.name, 200),
      signInEmail: str(r.signInEmail, 200),
      emailId: str(r.emailId, 80),
      inEmails: r.inEmails === true,
      emailDisabled: r.emailDisabled === true,
      phone: clean(r.phone, 60),
      contactName: clean(r.contactName, 200),
      contactLinked: r.contactLinked === true,
      contactDisabled: r.contactDisabled === true,
      hasPassword: r.hasPassword === true,
      disabled: r.disabled === true,
      updatedAt: isoOf(r.updatedAt),
      codebases,
    })
  }
  return rows.sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.platformName.localeCompare(b.platformName) || (a.name ?? a.signInEmail ?? '').localeCompare(b.name ?? b.signInEmail ?? ''))
}

// ---- the CRM Accounts page's filters ----------------------------------------------------------------------------------------------------------------

export type AccountsStateTab = 'all' | 'active' | 'disabled'
export const STATE_TABS: readonly { value: AccountsStateTab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Disabled' },
]
/** The four quick filters, one at a time (the empty string is none). */
export type QuickGap = '' | 'no-codebase' | 'no-phone' | 'not-in-emails' | 'not-in-contacts'
export const QUICK_FILTERS: readonly { value: Exclude<QuickGap, ''>; label: string; title: string }[] = [
  { value: 'no-codebase', label: 'No codebase', title: 'Accounts with no codebase recorded against them' },
  { value: 'no-phone', label: 'No phone', title: 'Accounts with no phone number' },
  { value: 'not-in-emails', label: 'Not in Emails', title: 'Accounts whose email is not in the Emails directory' },
  { value: 'not-in-contacts', label: 'Not in Contacts', title: 'Accounts whose phone is not linked to a contact' },
]
export interface PlatformFilters {
  search: string
  /** 'all', 'none' (No type) or a type's name. */
  type: string
  /** 'all' or a platform key. */
  platform: string
  /** 'all', 'none' (No codebase) or a codebase's name. */
  codebase: string
  tab: AccountsStateTab
  gap: QuickGap
}
/** The CRM page opens on its Active tab with nothing else set. */
export const NO_PLATFORM_FILTERS: PlatformFilters = { search: '', type: 'all', platform: 'all', codebase: 'all', tab: 'active', gap: '' }
/** "Any filter is on" as the CRM page counts it: the search, type, platform, codebase and the quick filter (the Active / Disabled tab is not one). */
export const platformFiltersOn = (f: PlatformFilters): boolean => f.search !== '' || f.type !== 'all' || f.platform !== 'all' || f.codebase !== 'all' || f.gap !== ''

/** The rows the CRM page's filters keep, in its own order of tests. */
export function filterPlatformRows(rows: readonly PlatformAccountRow[], f: PlatformFilters): PlatformAccountRow[] {
  const q = f.search.trim().toLowerCase()
  return rows.filter(r => {
    if (f.tab === 'active' && r.disabled) return false
    if (f.tab === 'disabled' && !r.disabled) return false
    if (f.gap === 'no-codebase' && r.codebases.length > 0) return false
    if (f.gap === 'no-phone' && r.phone) return false
    if (f.gap === 'not-in-emails' && r.inEmails) return false
    if (f.gap === 'not-in-contacts' && (r.contactLinked || !r.phone)) return false
    if (f.type === 'none' && r.accountType) return false
    if (f.type !== 'all' && f.type !== 'none' && r.accountType !== f.type) return false
    if (f.platform !== 'all' && r.platform !== f.platform) return false
    if (f.codebase === 'none' && r.codebases.length > 0) return false
    if (f.codebase !== 'all' && f.codebase !== 'none' && !r.codebases.some(c => c.name === f.codebase)) return false
    if (!q) return true
    return (
      (r.name ?? '').toLowerCase().includes(q) ||
      (r.accountType ?? '').toLowerCase().includes(q) ||
      r.platformName.toLowerCase().includes(q) ||
      (r.signInEmail ?? '').toLowerCase().includes(q) ||
      (r.phone ?? '').toLowerCase().includes(q) ||
      (r.contactName ?? '').toLowerCase().includes(q) ||
      r.codebases.some(c => c.name.toLowerCase().includes(q))
    )
  })
}

/** The number on each state tab (All, Active, Disabled), over every row. */
export const stateCount = (rows: readonly PlatformAccountRow[], tab: AccountsStateTab): number => rows.filter(r => (tab === 'all' ? true : tab === 'active' ? !r.disabled : r.disabled)).length

/** What the filter selects offer: the types, the platforms and the codebases that exist in the list. */
export function platformChoices(rows: readonly PlatformAccountRow[]): { types: string[]; platforms: { value: string; label: string }[]; codebases: string[] } {
  const types = new Set<string>()
  const platforms = new Map<string, string>()
  const codebases = new Set<string>()
  for (const r of rows) {
    if (r.accountType) types.add(r.accountType)
    platforms.set(r.platform, r.platformName)
    for (const c of r.codebases) codebases.add(c.name)
  }
  return {
    types: [...types].sort((a, b) => a.localeCompare(b)),
    platforms: [...platforms].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
    codebases: [...codebases].sort((a, b) => a.localeCompare(b)),
  }
}

// ---- paging (the CRM page: 10 / 20 / 50 / 100 per page, 20 to start) -----------------------------------------------------------------------------------

export const PER_PAGE_CHOICES: readonly number[] = [10, 20, 50, 100]
export const DEFAULT_PER_PAGE = 20
export interface PagePlan {
  pages: number
  page: number
  /** 1-based first and last row on the page (0 and 0 when there are no rows). */
  from: number
  to: number
}
/** The page asked for, kept inside the real pages, and the "1–20 of N" range of it. */
export function pagePlan(total: number, page: number, perPage: number): PagePlan {
  const per = Math.max(1, Math.floor(perPage))
  const pages = Math.max(1, Math.ceil(Math.max(0, total) / per))
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages)
  return total <= 0 ? { pages, page: p, from: 0, to: 0 } : { pages, page: p, from: (p - 1) * per + 1, to: Math.min(p * per, total) }
}
