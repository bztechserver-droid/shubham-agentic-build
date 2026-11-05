// F-113: the Server's address typed by hand, checked on the page before it is sent (the agent checks it again). "host:port" with the host an IPv4
// address or a name, the port optional (1 to 65535); an empty field clears it.

export type HubAddressCheck = { ok: true; address: string } | { ok: false; error: string }

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i

export function checkHubAddress(text: string): HubAddressCheck {
  const t = text.trim()
  if (t === '') return { ok: true, address: '' }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.includes('/')) return { ok: false, error: 'Type only the address and the port, like 100.78.83.92:21220, without http:// or a path.' }
  if (/\s/.test(t)) return { ok: false, error: 'An address has no spaces in it.' }
  if (t.startsWith('[') || (t.match(/:/g)?.length ?? 0) > 1) return { ok: false, error: 'Use an IPv4 address or a name, like 100.78.83.92:21220.' }
  const colon = t.lastIndexOf(':')
  const host = (colon === -1 ? t : t.slice(0, colon)).replace(/\.$/, '')
  const port = colon === -1 ? null : t.slice(colon + 1)
  if (port !== null) {
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return { ok: false, error: 'The port is a number from 1 to 65535, after a colon.' }
  }
  if (host === '') return { ok: false, error: 'Type the address before the port.' }
  const digits = /^[\d.]+$/.test(host)
  if (digits) {
    const parts = host.split('.')
    if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return { ok: false, error: 'That is not an IPv4 address: four numbers up to 255, like 100.78.83.92.' }
  } else if (host.length > 253 || !host.split('.').every(l => l.length <= 63 && LABEL.test(l))) {
    return { ok: false, error: 'That is not a name or an address: letters, numbers, dots and dashes only.' }
  }
  return { ok: true, address: `${host.toLowerCase()}${port === null ? '' : `:${Number(port)}`}` }
}
