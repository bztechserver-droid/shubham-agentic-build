import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import { AUTH_VIA_HEADER } from '../../shared/auth.ts'

// F-118: "came over the tailnet" must never be a thing a client can say or hide. Two places make
// it true: the Ports gate (agent/ports/gate.ts: it removes any client copy, then tags what it
// passes on, over loopback to this page server) and a connection that is not from this PC at all
// (the tailnet listener on its own port). Everything else is the PC's own browser. So the page
// server, for each request it forwards to the API:
//   - a client on another address: any copy it sent is dropped and 'tailnet' is set;
//   - a client on loopback: the gate's tag is kept only if it is exactly 'tailnet' (what a
//     program on this PC does to itself is its own affair: it can only make itself stricter);
//   - the login the gate read from Tailscale rides along as x-sad-via-login (audit only).

export const VIA_LOGIN_HEADER = 'x-sad-via-login'

export const isLoopbackAddress = (address: string) => address === '::1' || address === '127.0.0.1' || /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)

/** Removes every client copy of the via headers from `headers` (a copy being forwarded) and sets what is true. */
export function applyVia(headers: OutgoingHttpHeaders, from: IncomingHttpHeaders, remoteAddress: string | undefined): void {
  delete headers[AUTH_VIA_HEADER]
  delete headers[VIA_LOGIN_HEADER]
  if (!remoteAddress || !isLoopbackAddress(remoteAddress)) {
    headers[AUTH_VIA_HEADER] = 'tailnet'
    return
  }
  if (from[AUTH_VIA_HEADER] === 'tailnet') {
    headers[AUTH_VIA_HEADER] = 'tailnet'
    const login = from[VIA_LOGIN_HEADER]
    if (typeof login === 'string' && login.length <= 200 && /^[\x20-\x7e]*$/.test(login)) headers[VIA_LOGIN_HEADER] = login
  }
}
