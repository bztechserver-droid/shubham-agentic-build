// orders o0e2a, o8938, oc2db: the Accounts page's Codebases tab (the CRM's Codebases page and the platform accounts of its Code > Accounts page, copied into the NEW Supabase project, schema sad:
// db/accounts/0004_codebases.sql). The pure part: the shapes the page gets, the guards that keep a SECRET out of a copy and out of an answer (a password or token in an address, a connection string, a note
// that holds a key), the .env's variable COUNT (the file itself is never copied), the filters of the CRM's Codebases page, and the sorted order. The agent's route is
// agent/agentic/accounts-codebases.ts, the copy agent/agentic/accounts-codebase-import.ts, the page src/accounts/CodebasesTab.tsx.

export type DetailKind = 'github' | 'deployment' | 'database' | 'other'
export const DETAIL_KINDS: readonly DetailKind[] = ['github', 'deployment', 'database', 'other']
export const KIND_WORDS: Record<DetailKind | 'none', string> = { github: 'GitHub', deployment: 'Deployment', database: 'Database', other: 'Other', none: 'Other' }

/** A row under a codebase (the CRM's "details": the repos, the deployments, the database console). */
export interface CodebaseDetail {
  id: string
  name: string
  kind: DetailKind | null
  /** The link, unless it looked like it held a secret (then null and urlHidden is true). */
  url: string | null
  urlHidden: boolean
  note: string | null
  noteHidden: boolean
  disabled: boolean
  /** The email account it names, when that account is in the copied Email list: its row id (the Email tab can open it) and its address. */
  emailId: string | null
  emailAddress: string | null
}

/** A platform account (Vercel, Supabase, GitHub...) connected to a codebase. There is no password here, only that one exists. */
export interface PlatformLink {
  id: string
  platform: string
  accountType: string | null
  name: string | null
  signInEmail: string | null
  emailId: string | null
  phone: string | null
  hasPassword: boolean
  disabled: boolean
  /** Which part of the codebase is deployed from this account: 'be', 'fe' or both. */
  parts: ('be' | 'fe')[]
}

/** One codebase as the page sees it. There is no .env and no password anywhere in this shape, and no way to ask for one. */
export interface CodebaseRow {
  id: string
  name: string
  repoUrl: string | null
  repoHidden: boolean
  localPath: string | null
  note: string | null
  noteHidden: boolean
  stack: string | null
  owner: string | null
  services: string[]
  /** A .env exists on the CRM's record, and how many NAME=value lines it has: the content is never copied. */
  hasEnv: boolean
  envCount: number
  /** The CRM calls it Retired (switched off): kept in the list. */
  retired: boolean
  /** The CRM's own "last changed", as a date string. */
  updatedAt: string | null
  details: CodebaseDetail[]
  platforms: PlatformLink[]
}

export type NotConnected = import('./email-accounts.ts').NotConnected
export type CodebasesAnswer = { connected: true; codebases: CodebaseRow[] } | { connected: false; reason: NotConnected; message: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---- secrets ---------------------------------------------------------------------------------------------------------------------------------------------

/** Text that holds, or looks like it holds, a secret: a password or token written out, a key, a connection string with a login, a known token shape, a private key block. */
const SECRET_TEXT: RegExp[] = [
  /\b(pass(word|wd|code|phrase)?|pwd|secret|token|bearer|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|client[-_ ]?secret|credential)s?\b\s*(is|are)?\s*[:=]/i,
  /\b(pass(word|wd)?|pwd|secret|token|api[-_ ]?key)\b/i,
  /\b(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|redis|rediss|amqps?|mssql|sqlserver):\/\//i,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/,
  /\bsk[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
]
/** A long run of letters and digits on its own (40+): an API key or token pasted bare. Not applied to the path of an address (a long repository or branch name is not a secret). */
const BARE_BLOB = /(?<![\w/.-])[A-Za-z0-9+_-]{40,}={0,2}(?![\w/.-])/

export const looksSecret = (text: string): boolean => SECRET_TEXT.some(re => re.test(text)) || BARE_BLOB.test(text)
const looksSecretInPath = (text: string): boolean => SECRET_TEXT.some(re => re.test(text))

const MAX_TEXT = 5000
const MAX_URL = 500
const SECRET_PARAM = /^(token|access_token|auth|authorization|key|api_?key|apikey|secret|password|passwd|pwd|sig|signature|private_token|x-amz-signature)$/i

/** A note: trimmed, cut; null when empty; `hidden` when it looks like it holds a secret (then it is NOT kept). */
export function safeText(raw: unknown, max = MAX_TEXT): { text: string | null; hidden: boolean } {
  if (typeof raw !== 'string') return { text: null, hidden: false }
  const text = raw.replace(/\r\n?/g, '\n').trim()
  if (!text) return { text: null, hidden: false }
  if (looksSecret(text)) return { text: null, hidden: true }
  return { text: text.length > max ? text.slice(0, max) : text, hidden: false }
}

/**
 * A link or address: an http(s)/ssh/git address, or "git@host:path". Hidden (not kept) when it carries a login or a password (user:pass@), has a secret-looking query parameter, is a connection string, or
 * otherwise looks like it holds a secret. Anything else that is not an address (a plain label) is kept as text under the same secret test.
 */
export function safeUrl(raw: unknown): { url: string | null; hidden: boolean } {
  if (typeof raw !== 'string') return { url: null, hidden: false }
  const text = raw.trim()
  if (!text) return { url: null, hidden: false }
  if (text.length > MAX_URL) return { url: null, hidden: true }
  if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(text)) return { url: text, hidden: false }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let u: URL
    try {
      u = new URL(text)
    } catch {
      return { url: null, hidden: true }
    }
    if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(u.protocol)) return { url: null, hidden: true }
    // A password in the address is a secret; so is a user name on an http(s) address (it is how a token is usually carried: https://<token>@github.com/...). ssh://git@host/... is only a user name.
    if (u.password || (u.username && u.protocol.startsWith('http'))) return { url: null, hidden: true }
    for (const k of u.searchParams.keys()) if (SECRET_PARAM.test(k)) return { url: null, hidden: true }
    if (looksSecretInPath(text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''))) return { url: null, hidden: true }
    return { url: text, hidden: false }
  }
  if (looksSecret(text)) return { url: null, hidden: true }
  return { url: text, hidden: false }
}

/** How many NAME=value lines a .env text has. Only this number is ever kept from it. */
export function countEnvVars(env: unknown): number {
  if (typeof env !== 'string') return 0
  let n = 0
  for (const line of env.split(/\r?\n/)) if (/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) n++
  return n
}

// ---- the whitelist mapper (database rows -> the page's rows) ---------------------------------------------------------------------------------------------

const MAX_ROWS = 500
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const strs = (v: unknown, n: number, max: number): string[] => (Array.isArray(v) ? v.map(x => str(x, max)).filter((x): x is string => x !== null).slice(0, n) : [])

function isoOf(v: unknown): string | null {
  const d = v instanceof Date ? v : typeof v === 'string' ? new Date(v) : null
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null
}

/**
 * The agent's rows ({ id, name, ..., details: [...], platforms: [...] }) as the page's rows. Only these fields are read; the secret guards run AGAIN here (a row written by some other tool, or a guard
 * added later, is still held to them). A row with no id or name is left out. Null when it is not a list.
 */
export function safeCodebaseRows(raw: unknown): CodebaseRow[] | null {
  if (!Array.isArray(raw)) return null
  const rows: CodebaseRow[] = []
  for (const r of raw.slice(0, MAX_ROWS)) {
    if (!isObject(r)) continue
    const id = typeof r.id === 'string' && r.id ? r.id.slice(0, 80) : ''
    const name = str(r.name, 200)
    if (!id || !name) continue
    const repo = r.repoHidden === true ? { url: null, hidden: true } : safeUrl(r.repoUrl)
    const note = r.noteHidden === true ? { text: null, hidden: true } : safeText(r.note)
    const details: CodebaseDetail[] = []
    for (const d of (Array.isArray(r.details) ? r.details : []).slice(0, 60)) {
      if (!isObject(d)) continue
      const dn = str(d.name, 200)
      const did = typeof d.id === 'string' && d.id ? d.id.slice(0, 80) : ''
      if (!dn || !did) continue
      const url = d.urlHidden === true ? { url: null, hidden: true } : safeUrl(d.url)
      const dnote = d.noteHidden === true ? { text: null, hidden: true } : safeText(d.note)
      details.push({
        id: did,
        name: dn,
        kind: DETAIL_KINDS.includes(d.kind as DetailKind) ? (d.kind as DetailKind) : null,
        url: url.url,
        urlHidden: url.hidden,
        note: dnote.text,
        noteHidden: dnote.hidden,
        disabled: d.disabled === true,
        emailId: str(d.emailId, 80),
        emailAddress: str(d.emailAddress, 200),
      })
    }
    const platforms: PlatformLink[] = []
    for (const p of (Array.isArray(r.platforms) ? r.platforms : []).slice(0, 60)) {
      if (!isObject(p)) continue
      const pid = typeof p.id === 'string' && p.id ? p.id.slice(0, 80) : ''
      const platform = str(p.platform, 80)
      if (!pid || !platform) continue
      platforms.push({
        id: pid,
        platform,
        accountType: str(p.accountType, 80),
        name: str(p.name, 200),
        signInEmail: str(p.signInEmail, 200),
        emailId: str(p.emailId, 80),
        phone: str(p.phone, 60),
        hasPassword: p.hasPassword === true,
        disabled: p.disabled === true,
        parts: (Array.isArray(p.parts) ? p.parts : []).filter((x): x is 'be' | 'fe' => x === 'be' || x === 'fe'),
      })
    }
    rows.push({
      id,
      name,
      repoUrl: repo.url,
      repoHidden: repo.hidden,
      localPath: str(r.localPath, 500),
      note: note.text,
      noteHidden: note.hidden,
      stack: str(r.stack, 500),
      owner: str(r.owner, 200),
      services: strs(r.services, 20, 200),
      hasEnv: r.hasEnv === true,
      envCount: typeof r.envCount === 'number' && Number.isFinite(r.envCount) && r.envCount > 0 ? Math.min(Math.floor(r.envCount), 10000) : 0,
      retired: r.retired === true,
      updatedAt: isoOf(r.updatedAt),
      details,
      platforms,
    })
  }
  return rows.sort((a, b) => Number(a.retired) - Number(b.retired) || a.name.localeCompare(b.name))
}

// ---- the CRM Codebases page's filters ---------------------------------------------------------------------------------------------------------------------

/** Status: live only (the CRM's start), all, or retired only. */
export type CodebaseStatusFilter = 'live' | 'all' | 'retired'
export const CODEBASE_STATUS_FILTERS: readonly { value: CodebaseStatusFilter; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: 'all', label: 'All' },
  { value: 'retired', label: 'Retired' },
]
export interface CodebaseFilters {
  search: string
  status: CodebaseStatusFilter
  /** 'all', 'none' (nobody yet) or an owner's name. */
  owner: string
  /** 'all', 'none' (shared tooling) or a product/service name. */
  service: string
  /** Stack contains. */
  stack: string
}
export const NO_CODEBASE_FILTERS: CodebaseFilters = { search: '', status: 'live', owner: 'all', service: 'all', stack: '' }
export const codebaseFiltersOn = (f: CodebaseFilters): boolean => f.search.trim() !== '' || f.stack.trim() !== '' || f.owner !== 'all' || f.service !== 'all' || f.status !== 'live'

/** The rows the CRM page's filters keep: status, the search word against name, repository, path, note, stack, owner and the products; owner; product/service; stack contains. */
export function filterCodebases(rows: CodebaseRow[], f: CodebaseFilters): CodebaseRow[] {
  const q = f.search.trim().toLowerCase()
  const stack = f.stack.trim().toLowerCase()
  return rows.filter(r => {
    if (f.status === 'live' && r.retired) return false
    if (f.status === 'retired' && !r.retired) return false
    if (q && ![r.name, r.repoUrl, r.localPath, r.note, r.stack, r.owner, ...r.services].some(v => (v ?? '').toLowerCase().includes(q))) return false
    if (stack && !(r.stack ?? '').toLowerCase().includes(stack)) return false
    if (f.owner !== 'all' && (f.owner === 'none' ? r.owner !== null : r.owner !== f.owner)) return false
    if (f.service !== 'all' && (f.service === 'none' ? r.services.length > 0 : !r.services.includes(f.service))) return false
    return true
  })
}

/** The distinct owners and products in the list, for the two selects. */
export function filterChoices(rows: CodebaseRow[]): { owners: string[]; services: string[] } {
  const owners = new Set<string>()
  const services = new Set<string>()
  for (const r of rows) {
    if (r.owner) owners.add(r.owner)
    for (const s of r.services) services.add(s)
  }
  return { owners: [...owners].sort((a, b) => a.localeCompare(b)), services: [...services].sort((a, b) => a.localeCompare(b)) }
}

// ---- what a copy reports ----------------------------------------------------------------------------------------------------------------------------

export interface CopyPlan {
  insert: number
  update: number
  unchanged: number
  goneFromCrm: number
}
export interface CopyDone {
  inserted: number
  updated: number
  unchanged: number
  flaggedGone: number
}
/** What the copy of the codebases reports (counts and sizes only, never contents). */
export interface CodebaseImportReport {
  mode: 'check' | 'copy'
  crm: { codebases: number; live: number; retired: number; withEnv: number; envVars: number; details: number; platforms: number; links: number; hiddenValues: number; bytes: number }
  plan: { codebases: CopyPlan; platforms: CopyPlan } | null
  planNote: string | null
  done: { codebases: CopyDone; platforms: CopyDone; batches: number } | null
}
