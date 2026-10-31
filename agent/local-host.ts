import type { IncomingHttpHeaders } from 'node:http'
import net from 'node:net'

// Which requests come from the app's own pages (agent/SPEC.md › Local API). Vite's proxy hands
// the agent's token only to those, and the agent itself refuses a browser Origin that is not
// this PC. Both have to stop a DNS-rebinding page: a site that points its own name at 127.0.0.1
// is same-origin with itself, so only the name in Host and Origin gives it away.

/** "localhost:5173" → "localhost", "[::1]:5173" → "::1"; "" when malformed. */
function hostname(host: string): string {
  const h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end > 0 ? h.slice(1, end) : ''
  }
  const colon = h.indexOf(':')
  return colon === -1 ? h : h.slice(0, colon)
}

/**
 * A Host header Vite itself accepts with no `allowedHosts` set (its isHostAllowed): an IP
 * literal, localhost, or a name under .localhost. A rebound page names its own domain.
 */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false
  const name = hostname(host)
  return net.isIP(name) !== 0 || name === 'localhost' || name.endsWith('.localhost')
}

/** An Origin naming this PC: localhost, *.localhost, 127.0.0.0/8 or ::1. */
export function loopbackOrigin(origin: string): boolean {
  let name: string
  try {
    name = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

/**
 * Whether a request reaching Vite's proxy comes from the app's own pages. First the Host must
 * be one Vite accepts: Vite checks it on plain requests, but hands WebSocket upgrades to the
 * proxy unchecked. Then fetch metadata, or with none the Origin, must say same-origin.
 */
export function fromApp(headers: IncomingHttpHeaders): boolean {
  if (!hostAllowed(headers.host)) return false
  const site = headers['sec-fetch-site']
  if (site) return site === 'same-origin' || site === 'none'
  const origin = headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === headers.host
  } catch {
    return false
  }
}
