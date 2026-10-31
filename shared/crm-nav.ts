// F-054: where the CRM sits in the app's addresses, and the key that goes in and out of it. Pure,
// so it is tested without a page (crm-nav.test.ts); src/crm/ does the rest.
//
// The CRM is one frame with two sizes. /crm is the CRM page: the frame fills the page area, so the
// page picker (or the tabs, or the side menu) and the top bar stay where they are. /crm?full=1 is
// the CRM full window (Alt+B): the frame covers all of it, and Alt+B again goes back to where it
// was pressed.

/** The CRM page. */
export const CRM_PATH = '/crm'
/** The CRM, full window. */
export const CRM_FULL = '/crm?full=1'

export const isCrmPath = (pathname: string) => pathname === CRM_PATH || pathname.startsWith(`${CRM_PATH}/`)

/** Whether an address is the CRM filling the window. */
export const isCrmFull = (pathname: string, search: string) => isCrmPath(pathname) && new URLSearchParams(search).get('full') === '1'

/**
 * Alt+B, and only that: the physical B key (a layout can print another character with Alt held),
 * with Alt alone. Ctrl+Alt is AltGr on many keyboards, and Meta or Shift mean another shortcut.
 */
export function isCrmShortcut(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code: string }): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyB'
}

/**
 * Where leaving the full window goes: back to the address it was entered from (the CRM page
 * included), else the start. Never another address's host, and never the full window again.
 */
export function leaveTarget(from: string | null | undefined): string {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) return '/'
  let u: URL
  try {
    u = new URL(from, 'http://app.invalid')
  } catch {
    return '/'
  }
  return u.origin === 'http://app.invalid' && !isCrmFull(u.pathname, u.search) ? from : '/'
}
