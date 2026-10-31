import { readFileSync } from 'node:fs'
import { CRM_ADDRESS_MAX, type CrmCheck, type CrmMode, type CrmReason } from '../../shared/crm.ts'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'

// F-054: the CRM page shows the CRM built into the page (crm-host/), or, as the other way, the
// CRM's own website in a frame. The hub keeps which, and where that website is (one setting for
// every device); for the frame it asks the site, from here, whether it can be shown: a browser can't
// read another site's response headers, and a frame that can't load says nothing about why. What
// this finds is plain sentences for the page: the site is switched off, doesn't exist, has an
// expired certificate, or refuses to be framed.

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The address as it is kept: https (http only for this PC, to try things), no login in it, at most
 * 300 characters, no `#...`. "crm.example.com" alone is taken as https. Empty, or null, clears it.
 */
export function crmAddress(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw apiError(400, 'The address is text')
  let text = v.trim()
  if (!text) return null
  if (text.length > CRM_ADDRESS_MAX) throw apiError(400, `An address is at most ${CRM_ADDRESS_MAX} characters`)
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`
  let u: URL
  try {
    u = new URL(text)
  } catch {
    throw apiError(400, "That isn't a web address. Write it like https://crm.example.com")
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.has(u.hostname))) {
    throw apiError(400, "Use an https:// address: this app is served over https, and a browser won't show an http site inside it")
  }
  if (u.username || u.password) throw apiError(400, 'Leave the user name and password out of the address')
  u.hash = ''
  return u.toString()
}

/** How the CRM is shown: 'bundled' (the default) or 'frame'. */
export function crmMode(v: unknown): CrmMode {
  if (v === 'bundled' || v === 'frame') return v
  throw apiError(400, 'mode is "bundled" (the CRM built into the page) or "frame" (its website in a frame)')
}

export interface CrmSettings {
  /** The website's address, for the frame. */
  url: string | null
  mode: CrmMode
}

export interface CrmStore {
  get(): CrmSettings
  /** Only what is given changes. */
  set(patch: { url?: string | null; mode?: CrmMode }): void
}

/** The settings in a small JSON file on the hub, written whole each time. */
export function createCrmStore(file: string): CrmStore {
  let settings: CrmSettings = { url: null, mode: 'bundled' }
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (isObject(data)) {
      if (typeof data.url === 'string') settings = { ...settings, url: crmAddress(data.url) }
      if (data.mode === 'frame' || data.mode === 'bundled') settings = { ...settings, mode: data.mode }
    }
  } catch {
    // None yet, or one that can't be read or isn't an address: the defaults.
  }
  return {
    get: () => ({ ...settings }),
    set(patch) {
      settings = { url: patch.url === undefined ? settings.url : patch.url, mode: patch.mode ?? settings.mode }
      writeAtomic(file, `${JSON.stringify(settings, null, 2)}
`)
    },
  }
}

// --- may it be shown in a frame? -------------------------------------------------------------------

export interface Framing {
  allowed: boolean
  /** The header that refuses, as the site sent it. */
  header: string | null
}

interface HeaderReader {
  get(name: string): string | null
}

/** Does one source of a `frame-ancestors` list admit the page at `app`, for a site at `site`? */
function admits(source: string, site: string, app: string): boolean {
  const s = source.toLowerCase()
  if (s === "'self'") return app === site
  if (s === '*') return /^https?:\/\//.test(app)
  if (s.endsWith(':') && !s.includes('/')) return app.startsWith(s)
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|\*\.[^/:]+|[^/:*]+)(?::(\*|\d+))?(?:\/.*)?$/.exec(s)
  if (!m) return false
  const [, scheme, host, port] = m
  const a = new URL(app)
  if (scheme ? `${scheme}:` !== a.protocol : !/^https?:$/.test(a.protocol)) return false
  const h = a.hostname
  if (host !== '*' && !(host.startsWith('*.') ? h.endsWith(host.slice(1)) : h === host)) return false
  if (port === '*') return true
  const want = port ?? (a.protocol === 'https:' ? '443' : '80')
  return (a.port || (a.protocol === 'https:' ? '443' : '80')) === want
}

/**
 * Whether a site's headers let the app at `app` (its origin, as the page sees it; null when not
 * known) show it in a frame: X-Frame-Options, and every policy's `frame-ancestors`.
 */
export function framingOf(headers: HeaderReader, site: string, app: string | null): Framing {
  const xfo = headers.get('x-frame-options')
  if (xfo) {
    const values = xfo.split(',').map(x => x.trim().toLowerCase())
    if (values.includes('deny')) return { allowed: false, header: `X-Frame-Options: ${xfo}` }
    if (values.includes('sameorigin') && app !== site) return { allowed: false, header: `X-Frame-Options: ${xfo}` }
  }
  const csp = headers.get('content-security-policy')
  if (csp) {
    // Several policies arrive joined by commas; each one has its say.
    for (const policy of csp.split(',')) {
      const directive = policy
        .split(';')
        .map(d => d.trim())
        .find(d => /^frame-ancestors(\s|$)/i.test(d))
      if (!directive) continue
      const sources = directive.split(/\s+/).slice(1)
      const none = sources.length === 0 || sources.some(x => x.toLowerCase() === "'none'")
      // Without the page's origin only a list that can't include it is certain to refuse.
      const admitted = !none && (app === null ? sources.some(x => x.toLowerCase() !== "'self'") : sources.some(x => admits(x, site, app)))
      if (!admitted) return { allowed: false, header: `Content-Security-Policy: ${directive}` }
    }
  }
  return { allowed: true, header: null }
}

// --- asking the site ---------------------------------------------------------------------------------

const CERT_EXPIRED = new Set(['CERT_HAS_EXPIRED'])
const CERT_UNTRUSTED = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_NOT_YET_VALID', 'CERT_REVOKED'])

/** The error code under a failed fetch (Node nests it in `cause`). */
function codeOf(e: unknown): string {
  for (let x: unknown = e, i = 0; isObject(x) && i < 4; x = x.cause, i++) {
    if (typeof x.code === 'string') return x.code
    if (x.name === 'TimeoutError' || x.name === 'AbortError') return 'TIMEOUT'
  }
  return ''
}

export interface CheckOptions {
  /** The page's origin (https://server.tailc768e5.ts.net:5173), to tell whether a frame-ancestors list admits it. */
  app?: string | null
  fetch?: typeof fetch
  timeoutMs?: number
  now?: () => number
}

/** Asks the CRM's site for its front page and says whether it can be shown, and if not, why. */
export async function checkCrm(url: string, o: CheckOptions = {}): Promise<CrmCheck> {
  const now = o.now ?? Date.now
  const started = now()
  const host = new URL(url).host
  const done = (reason: CrmReason | null, status: number | null, message: string, header: string | null = null): CrmCheck => ({
    url,
    ok: reason === null,
    reason,
    status,
    message,
    header,
    ms: now() - started,
    checkedAt: new Date(started).toISOString(),
  })

  let res: Response
  try {
    res = await (o.fetch ?? fetch)(url, { method: 'GET', redirect: 'follow', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(o.timeoutMs ?? 8000) })
  } catch (e) {
    const code = codeOf(e)
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA') return done('dns', null, `${host} doesn't exist: no DNS record answers for that name.`)
    if (CERT_EXPIRED.has(code)) return done('cert', null, `${host}'s security certificate has expired, so browsers refuse it.`)
    if (CERT_UNTRUSTED.has(code)) return done('cert', null, `${host}'s security certificate isn't trusted (${code.toLowerCase().replace(/_/g, ' ')}), so browsers refuse it.`)
    if (code === 'ECONNREFUSED') return done('refused', null, `Nothing is listening at ${host}: the connection was refused.`)
    if (code === 'TIMEOUT' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return done('timeout', null, `${host} didn't answer within ${Math.round((o.timeoutMs ?? 8000) / 1000)} seconds.`)
    return done('network', null, `${host} can't be reached from this PC${code ? ` (${code})` : ''}.`)
  }
  // Only the answer's head is wanted.
  await res.body?.cancel().catch(() => {})

  const status = res.status
  const vercel = res.headers.get('x-vercel-error')
  if (status === 402 || vercel === 'DEPLOYMENT_DISABLED') {
    return done('disabled', status, `${host} is switched off by its host${vercel ? ` (${vercel}, HTTP ${status})` : ` (HTTP ${status}, payment required)`}: there is no site to show until it is turned back on or put somewhere else.`)
  }
  if (status === 404) return done('notfound', status, `${host} answers 404: its host has no site at that address${vercel ? ` (${vercel})` : ''}.`)
  if (status === 401 || status === 403) return done('status', status, `${host} answers ${status}: it wants a login or an allowance before it shows anything.`)
  if (status >= 400) return done('status', status, `${host} answers ${status}, an error.`)

  const finalUrl = res.url || url
  const site = new URL(finalUrl).origin
  const framing = framingOf(res.headers, site, o.app ?? null)
  if (!framing.allowed) return done('framing', status, `${host} answers, but it refuses to be shown inside another site (${framing.header}). That has to be changed on the CRM site's own side.`, framing.header)
  return done(null, status, `${host} answers (HTTP ${status}) and allows being shown in this app.`)
}
