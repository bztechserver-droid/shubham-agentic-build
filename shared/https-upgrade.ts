// F-117: the app's own page opened over plain http by a bare Tailscale address (http://100.x.y.z:5173). No certificate can name an address, so the browser says Not
// secure there. This PC's agent answers https by name on the same port, so the page checks, quietly, whether the name answers from this device and, if it does,
// moves there (location.replace, same path). If it does not (a browser's Secure DNS hides names like it), the page stays and says why. Pure: the checks and the words.

/** Tailscale's own address range, 100.64.0.0/10. Only a page opened at one of these is moved: a page by a LAN address or localhost is left alone. */
export function isTailnetIp(hostname: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!m) return false
  const [a, b, c, d] = m.slice(1).map(Number)
  return a === 100 && b >= 64 && b <= 127 && c <= 255 && d <= 255
}

export interface PageLoc {
  protocol: string
  hostname: string
  port: string
  pathname: string
  search: string
  hash: string
}

/** This PC's tailnet name, cleaned ("Ravi.tail1.ts.net." gives "ravi.tail1.ts.net"), or null when it is not a name a browser could open. */
export function cleanName(name: string | null | undefined): string | null {
  const n = name?.trim().replace(/\.$/, '').toLowerCase()
  return n && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(n) ? n : null
}

/** Whether this page is the case: plain http, at a Tailscale address. */
export const needsUpgrade = (loc: Pick<PageLoc, 'protocol' | 'hostname'>) => loc.protocol === 'http:' && isTailnetIp(loc.hostname)

/** The https address by name for the same page (port, path, query and hash kept), or null when this page is not the case or the name is not known. */
export function secureTarget(loc: PageLoc, tailnetName: string | null | undefined): string | null {
  const name = cleanName(tailnetName)
  if (!name || !needsUpgrade(loc)) return null
  return `https://${name}${loc.port ? `:${loc.port}` : ''}${loc.pathname}${loc.search}${loc.hash}`
}

/** The address to ask whether the name answers: the same port, the root. */
export function probeUrl(target: string): string {
  const u = new URL(target)
  return `${u.origin}/`
}

/** What the page says when it stays on the address. */
export function stayWords(name: string): { title: string; text: string } {
  return {
    title: 'This page is open without https',
    text: `You are on an address, and no certificate can name an address, so the browser shows Not secure. The secure name ${name} did not answer on this device. A browser’s Secure DNS often hides names like it: turn it off (Chrome and Edge: Settings, Privacy and security, Security, Use secure DNS), then reload.`,
  }
}
