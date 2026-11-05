import type { AuthErrorCode, AuthPerson } from '../../shared/auth.ts'

// F-118: the two things api.ts and the modules share without importing each other as values.

/** Who a request is: its person (null: nobody signed in), where it came from, and which session. */
export interface Caller {
  person: AuthPerson | null
  via: 'local' | 'tailnet'
  /** The session's public id (the first 12 characters of its hash), or null. Safe to log. */
  sid: string | null
}

/** A caller with no cookie from this PC's own browser: what everything is when no auth is wired (tests, the open app). */
export const OPEN: Caller = { person: null, via: 'local', sid: null }

/**
 * F-119: whether this request may press Publish. A PAGE (a browser: it sends an Origin or fetch metadata, or the page server
 * tagged it as from the tailnet) may only when it is signed in as an admin (sbskrrt): "unsigned, so the open app" does not count,
 * since every tailnet device can open the Server's page. A program on the Server calling with the machine token and no page
 * headers (build-api.mjs) is not a page and keeps working.
 */
export function mayPublish(headers: Record<string, string | string[] | undefined>, caller: Caller | undefined): boolean {
  const page = headers.origin !== undefined || headers['sec-fetch-site'] !== undefined || headers['x-sad-via'] === 'tailnet'
  return !page || caller?.person?.canSeeAll === true
}

/** An error the API answers with this status, message and the contract's code. */
export function authError(status: number, message: string, code: AuthErrorCode): Error & { status: number; code: AuthErrorCode } {
  return Object.assign(new Error(message), { status, code })
}
