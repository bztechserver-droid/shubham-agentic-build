// Order ocf00: the Codebases modal's tabs (BE, FE, Deployment, Database: a description and links; Environment variables: named subsets of NAME and VALUE).
// The rules both the agent and the page use: the sections, the limits, which variable names look like secrets (their values are masked by default and
// never sent to the page unless he asks for them), and the checks on a link, a name and a value. Pure: no network, no database.

export const TAB_SECTIONS = ['be', 'fe', 'deployment', 'database'] as const
export type TabSection = (typeof TAB_SECTIONS)[number]
export const SECTION_WORDS: Record<TabSection, string> = { be: 'BE', fe: 'FE', deployment: 'Deployment', database: 'Database' }

export const TAB_LIMITS = {
  description: 5000,
  linkLabel: 200,
  linkUrl: 1000,
  linkNote: 2000,
  subsetName: 100,
  varName: 200,
  varValue: 10000,
} as const

/** A variable name: letters, digits, _ . - (not starting with a digit), as an .env file has them. */
export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/** Names that look like they hold a secret. Their values are masked on the page by default, and only given when he asks (reveal). */
const SECRET_NAME = /KEY|SECRET|TOKEN|PASS|PWD|PRIVATE|CREDENTIAL|AUTH|DSN|CONNECTION|COOKIE|SESSION|SIGNATURE|CERT/i
export const isSecretName = (name: string): boolean => SECRET_NAME.test(name)

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string }

/** A description of a section: free text, may be empty (empty clears it). */
export function checkDescription(text: unknown): Checked<string> {
  if (typeof text !== 'string') return { ok: false, message: 'The description is text.' }
  const t = text.trim()
  if (t.length > TAB_LIMITS.description) return { ok: false, message: `The description is longer than ${TAB_LIMITS.description} characters.` }
  return { ok: true, value: t }
}

/** A link: a label, an address (http or https, with no user name or password inside it) and a note for the link (optional). */
export function checkLink(input: unknown): Checked<{ label: string; url: string; description: string }> {
  if (typeof input !== 'object' || input === null) return { ok: false, message: 'The link is missing.' }
  const r = input as Record<string, unknown>
  const label = typeof r.label === 'string' ? r.label.trim() : ''
  const url = typeof r.url === 'string' ? r.url.trim() : ''
  const description = typeof r.description === 'string' ? r.description.trim() : ''
  if (!label) return { ok: false, message: 'A link needs a label.' }
  if (label.length > TAB_LIMITS.linkLabel) return { ok: false, message: `The label is longer than ${TAB_LIMITS.linkLabel} characters.` }
  if (!url) return { ok: false, message: 'A link needs an address (URL).' }
  if (url.length > TAB_LIMITS.linkUrl) return { ok: false, message: `The address is longer than ${TAB_LIMITS.linkUrl} characters.` }
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: 'The address starts with http:// or https://.' }
  // A user name or password in the address is never kept: it would be a secret in the clear.
  if (/^https?:\/\/[^/?#]*@/i.test(url)) return { ok: false, message: 'The address has a user name or password in it: take that out.' }
  if (description.length > TAB_LIMITS.linkNote) return { ok: false, message: `The note is longer than ${TAB_LIMITS.linkNote} characters.` }
  return { ok: true, value: { label, url, description } }
}

export function checkSubsetName(name: unknown): Checked<string> {
  const t = typeof name === 'string' ? name.trim() : ''
  if (!t) return { ok: false, message: 'A subset needs a name.' }
  if (t.length > TAB_LIMITS.subsetName) return { ok: false, message: `The name is longer than ${TAB_LIMITS.subsetName} characters.` }
  return { ok: true, value: t }
}

export function checkVarName(name: unknown): Checked<string> {
  const t = typeof name === 'string' ? name.trim() : ''
  if (!t) return { ok: false, message: 'A variable needs a name.' }
  if (t.length > TAB_LIMITS.varName || !VAR_NAME.test(t)) return { ok: false, message: 'A variable name is letters, digits, _ . or -, not starting with a digit.' }
  return { ok: true, value: t }
}

export function checkVarValue(value: unknown): Checked<string> {
  if (typeof value !== 'string') return { ok: false, message: 'The value is text.' }
  if (value.length > TAB_LIMITS.varValue) return { ok: false, message: `The value is longer than ${TAB_LIMITS.varValue} characters.` }
  return { ok: true, value }
}

export const isSection = (v: unknown): v is TabSection => typeof v === 'string' && (TAB_SECTIONS as readonly string[]).includes(v)

// --- what the agent answers (the page and the agent read the same shapes) ----------------------------------------------------

export interface TabsLink {
  id: string
  section: TabSection
  label: string
  url: string
  description: string
}
export interface TabsVar {
  id: string
  name: string
  /** A name that looks like a secret: its value is not given (see reveal). */
  secret: boolean
  /** The value, for a name that does not look like a secret; null for a secret, or when the key file is not on this PC. */
  value: string | null
}
export interface TabsSubset {
  id: string
  name: string
  vars: TabsVar[]
}
export interface TabsAnswer {
  codebaseId: string
  sections: Record<TabSection, string>
  links: TabsLink[]
  subsets: TabsSubset[]
  /** Whether the key file is on this PC (values can be read and saved). */
  keyOk: boolean
}
