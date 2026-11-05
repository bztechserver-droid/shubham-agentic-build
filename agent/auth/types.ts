import type { AuthErrorCode, AuthPerson } from '../../shared/auth.ts'

// F-118: the two things api.ts and the modules share without importing each other as values.

/** Who a request is: its person (null: nobody signed in), where it came from, and which session. */
export interface Caller {
  person: AuthPerson | null
  via: 'local' | 'tailnet'
  /** The session's public id (the first 12 characters of its hash), or null. Safe to log. */
  sid: string | null
  /**
   * The PC itself, not a browser: a request with the machine token and none of the page markers (isPageRequest), such as the Server's own
   * build-api.mjs. It is not bound by the sign-in level and acts as the owner of the app ('system'); it never holds a person's session.
   */
  machine?: boolean
}

/** A caller with no cookie from this PC's own browser: what everything is when no auth is wired (tests, the open app). */
export const OPEN: Caller = { person: null, via: 'local', sid: null }

/**
 * Whether a request came from a PAGE (a browser, through the page server or a Ports share) as opposed to a program on the PC.
 * Any one marker is enough, so it is enough to be wrong in only one direction (a program that wears a marker is treated as a page and
 * is bound by the level; nothing a page can do removes them): the page server's own x-sad-page, an Origin, the fetch metadata a browser
 * always sends (sec-fetch-site, sec-fetch-dest; NOT sec-fetch-mode, which Node's own fetch sends too: it is what build-api.mjs is), or any x-sad-via at all (the Ports gate and the page server set it; the value is not trusted for this).
 */
export function isPageRequest(headers: Record<string, string | string[] | undefined>): boolean {
  return (
    headers['x-sad-page'] !== undefined ||
    headers.origin !== undefined ||
    headers['sec-fetch-site'] !== undefined ||
    headers['sec-fetch-dest'] !== undefined ||
    headers['x-sad-via'] !== undefined
  )
}

/**
 * F-119: whether this request may press Publish. A PAGE (a browser: it sends an Origin or fetch metadata, or the page server
 * tagged it as from the tailnet) may only when it is signed in as an admin (sbskrrt): "unsigned, so the open app" does not count,
 * since every tailnet device can open the Server's page. A program on the Server calling with the machine token and no page
 * headers (build-api.mjs) is not a page and keeps working.
 */
export function mayPublish(headers: Record<string, string | string[] | undefined>, caller: Caller | undefined): boolean {
  return !isPageRequest(headers) || caller?.person?.canSeeAll === true
}

/** An error the API answers with this status, message and the contract's code. */
export function authError(status: number, message: string, code: AuthErrorCode): Error & { status: number; code: AuthErrorCode } {
  return Object.assign(new Error(message), { status, code })
}
