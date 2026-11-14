// F-235 (order o7c1c): a conversation's preview on the Import agent dialog (its title, first and last messages) never shows what
// looks like a secret. Each such part of the text is replaced by HIDDEN; the words around it stay, so the conversation can still be
// recognised. Hidden: a private key block; known key and token shapes (Anthropic, OpenAI, GitHub, GitLab, Slack, AWS, Google, Stripe,
// Hugging Face, npm, SendGrid, Tailscale, a JWT, this app's own chat keys); the value written after a secret's name (password=,
// "token": , API_KEY: …); a Bearer or Basic credential; the password in an address (scheme://user:password@host); and any other long
// run of random-looking letters and digits (hex, or mixed case with digits in long pieces), but never a chat id (a UUID).
// The whole-text sibling is codebase-accounts.ts looksSecret (a note there is kept or not). Pure; tested in secret-text.test.ts.

export const HIDDEN = '[hidden]'

/** Key and token shapes, each hidden whole. */
const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bya29\.[0-9A-Za-z._-]{20,}/g,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}/g,
  /\b[rsp]k_(?:live|test)_[0-9A-Za-z]{16,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\btskey-[A-Za-z0-9-]{10,}/g,
  /\bsad_[0-9a-f]{48}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]

/** The password in an address: scheme://user:password@host. */
const ADDRESS_LOGIN = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s/@]+@/gi

/** A credential after its scheme: Bearer …, Basic …. */
const SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g

/** A secret's name (with what goes before it in a longer name: CLAUDE_CODE_OAUTH_TOKEN, x-sad-token, db.password) and its = or :. */
const NAME =
  String.raw`\b((?:[A-Za-z0-9]+[-_.])*(?:pass(?:word|wd|code|phrase)?|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|client[-_]?secret|credentials?|authorization|auth|cookie|session[-_]?key|signature))(\s*["']?\s*(?:=>|[:=])\s*)`
/** The value written after it, in quotes ("token": "a b c") or bare (password=…, API_KEY: …). */
const NAMED_QUOTED = new RegExp(`${NAME}(["'\`])([^"'\`\\n]{1,300})\\3`, 'gi')
const NAMED_BARE = new RegExp(`${NAME}([^\\s"'\`,;&)}\\][]{3,})`, 'gi')

/** A long run of key-like characters on its own. */
const RUN = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9+/_=-])/g
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether a long run looks random (a key pasted bare) rather than words: hex of 32 or more (a key, or a hash); mixed case with digits
 * whose longest piece (between / _ . -) is 12 or more (base64, base64url); one case with digits in a piece of 24 or more, a sixth of it
 * digits. A path (a/b/c), a folder or project name (C--Users-me-code) and a chat id are words, not keys.
 */
function randomLooking(run: string): boolean {
  if (UUID.test(run)) return false
  const core = run.replace(/^[/_=+-]+|[/_=+-]+$/g, '')
  if (!/[0-9]/.test(core) || !/[A-Za-z]/.test(core)) return false
  if (core.length >= 32 && /^[0-9a-f]+$/i.test(core)) return true
  const pieces = core.split(/[/_.-]+/).filter(Boolean)
  const longest = Math.max(0, ...pieces.map(p => p.length))
  if (/[a-z]/.test(core) && /[A-Z]/.test(core)) return longest >= 12
  const digits = core.replace(/[^0-9]/g, '').length
  return longest >= 24 && digits / core.length >= 1 / 6
}

/** The text with every part that looks like a secret replaced by HIDDEN (the rest as it was). */
export function hideSecrets(text: string): string {
  let out = text
  for (const re of SHAPES) out = out.replace(re, HIDDEN)
  out = out.replace(ADDRESS_LOGIN, `$1${HIDDEN}@`)
  out = out.replace(SCHEME, `$1 ${HIDDEN}`)
  out = out.replace(NAMED_QUOTED, (_m, name: string, sep: string, quote: string) => `${name}${sep}${quote}${HIDDEN}${quote}`)
  out = out.replace(NAMED_BARE, (_m, name: string, sep: string) => `${name}${sep}${HIDDEN}`)
  out = out.replace(RUN, run => (randomLooking(run) ? HIDDEN : run))
  return out
}
