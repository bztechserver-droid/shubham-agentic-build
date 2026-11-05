import type { PortShare } from '../../shared/agent-api.ts'
import type { ServeEntry, ServeVia } from './serve.ts'

// F-114: the links to open a shared page. The rule (Lead, 5 Nov): NEVER a link that cannot open.
//  - By name (httpsUrl): https with the real certificate. Only where https is served on that port.
//  - By bare IP (ipUrl): plain http opens with no warning, but only where nobody does TLS in front of it (a raw share by Ports whose gate answers http). Where Tailscale does the TLS,
//    plain http can never open, so the link is https by IP and `ipUrlWarns` says the browser will complain about the certificate. Where nothing web opens by IP: null and a note.

export interface Where {
  /** This PC's name on the tailnet, e.g. "server.tail36192f.ts.net", or null while unknown. */
  name: string | null
  /** This PC's Tailscale IPv4, or null. */
  ip: string | null
}

const url = (scheme: 'http' | 'https', host: string, port: number) => `${scheme}://${host}${(scheme === 'https' && port === 443) || (scheme === 'http' && port === 80) ? '' : ':' + port}`

/** A share by Ports. `via` raw = the gate answers (http by IP opens; https by name needs the certificate); tls = Tailscale did the TLS. */
export function oursLinks(where: Where, port: number, via: ServeVia, certReady: boolean): Pick<PortShare, 'httpsUrl' | 'ipUrl' | 'ipUrlWarns' | 'note'> {
  if (via === 'raw') {
    return {
      httpsUrl: where.name && certReady ? url('https', where.name, port) : null,
      ipUrl: where.ip ? url('http', where.ip, port) : null,
      ipUrlWarns: false,
      note: certReady ? null : 'https by name waits for this PC\'s certificate; the http link by IP works now',
    }
  }
  return {
    httpsUrl: where.name ? url('https', where.name, port) : null,
    ipUrl: where.ip ? url('https', where.ip, port) : null,
    ipUrlWarns: where.ip !== null,
    note: where.ip ? 'Tailscale does the TLS on this port, so by IP the browser warns about the certificate (click through); by name it is clean' : null,
  }
}

/** A share Ports did not make (the phone gate, the Drive, a hand-made entry): read-only, described by how Tailscale serves it. */
export function foreignLinks(where: Where, e: ServeEntry, byGate: boolean): Pick<PortShare, 'httpsUrl' | 'ipUrl' | 'ipUrlWarns' | 'note'> {
  const who = byGate ? 'The phone gate' : 'Tailscale'
  switch (e.kind) {
    case 'tls-tcp':
    case 'https':
      return {
        httpsUrl: where.name ? url('https', where.name, e.port) : null,
        ipUrl: where.ip ? url('https', where.ip, e.port) : null,
        ipUrlWarns: where.ip !== null,
        note: where.ip ? `${who} does the TLS on this port, so by IP the browser warns about the certificate (click through); by name it is clean` : null,
      }
    case 'http':
      return { httpsUrl: null, ipUrl: where.ip ? url('http', where.ip, e.port) : null, ipUrlWarns: false, note: 'Shared as plain http only: no https link' }
    case 'tcp':
      // A raw forward: for the phone gate's port 80 (and a raw share of a web page) plain http opens; for anything else we cannot tell it is a web page.
      return byGate
        ? { httpsUrl: null, ipUrl: where.ip ? url('http', where.ip, e.port) : null, ipUrlWarns: false, note: 'The phone gate answers plain http on this port: no https link' }
        : { httpsUrl: null, ipUrl: null, ipUrlWarns: false, note: 'Shared as raw TCP by something else: no web link can be given for it' }
  }
}
