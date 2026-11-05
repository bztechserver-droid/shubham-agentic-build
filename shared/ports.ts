import type { ListeningPort, PortShare, PortsGate, PortsMode, PortsState, PortsTlsBy } from './agent-api.ts'

// F-114 Ports: what the page says about the agent's PortsState (the contract is in agent-api.ts). Pure, so the words and the groups are tested.

/** This PC's full name on the tailnet ("ravi-scyramp.tail36192f.ts.net"), from the agent's parts; null while either is unknown. */
export function selfHost(self: PortsState['self']): string | null {
  const name = self.name?.trim().replace(/\.$/, '')
  const tail = self.tailnet?.trim().replace(/^\./, '').replace(/\.$/, '')
  if (!name) return null
  if (name.includes('.')) return name
  return tail ? `${name}.${tail}` : null
}

/** How a row behaves: 'locked' (never shared by Ports), 'readonly' (held by the phone gate or another Tailscale entry), 'all' (mode all shares it), 'switch'. */
export type RowKind = 'locked' | 'readonly' | 'all' | 'switch'

/** Whether "Share all" covers this port's program (the agent's `allPrograms`); a port of any other program can still be chosen one by one. */
export const coveredByAll = (p: ListeningPort, allPrograms: string[]) => p.program !== null && allPrograms.some(a => a.toLowerCase() === p.program!.toLowerCase())

export function rowKind(p: ListeningPort, mode: PortsMode, allPrograms: string[] = []): RowKind {
  if (p.sharedBy === 'gate' || p.sharedBy === 'other') return 'readonly'
  if (p.blocked) return 'locked'
  return mode === 'all' && coveredByAll(p, allPrograms) ? 'all' : 'switch'
}

/** Rows to switch (or read) first, by number; the ones that are never shared apart. */
export function splitPorts(ports: ListeningPort[], mode: PortsMode, allPrograms: string[] = []): { open: ListeningPort[]; locked: ListeningPort[] } {
  const byPort = (a: ListeningPort, b: ListeningPort) => a.port - b.port
  return {
    open: ports.filter(p => rowKind(p, mode, allPrograms) !== 'locked').sort(byPort),
    locked: ports.filter(p => rowKind(p, mode, allPrograms) === 'locked').sort(byPort),
  }
}

/** Whether Ports shares this port right now (its own share, not the gate's). */
export const sharedNow = (p: ListeningPort) => p.sharedBy === 'ports'

export const READ_ONLY_WORDS = {
  gate: 'Shared by the phone gate (old way)',
  other: 'Shared by another Tailscale entry',
} as const

/** "2 of 5 shared", or why nothing is. */
export function sharedSummary(s: PortsState): string {
  const { open } = splitPorts(s.ports, s.mode, s.allPrograms)
  const can = open.filter(p => rowKind(p, s.mode, s.allPrograms) !== 'readonly')
  if (can.length === 0) return 'No port is listening that can be shared'
  const n = can.filter(sharedNow).length
  if (s.mode === 'off') {
    const chosen = can.filter(p => p.chosen).length
    return chosen > 0 ? `${chosen} chosen, sharing is off` : 'Nothing shared'
  }
  return n === 0 ? 'Nothing shared yet' : `${n} of ${can.length} shared`
}

export const MODE_WORDS: Record<PortsMode, { label: string; hint: string }> = {
  off: { label: 'Off', hint: 'Nothing of this PC is shared.' },
  chosen: { label: 'Chosen ports', hint: 'Only the ports you switch on below.' },
  all: { label: 'Share all', hint: 'Every port of the programs listed below. The ones that are never shared stay out.' },
}

/** What "Share all" covers, in one line (the agent's list of programs), and that other ports can still be chosen by hand. */
export function shareAllWords(allPrograms: string[]): string {
  return allPrograms.length === 0
    ? 'Share all covers no program on this PC. Switch ports on one by one.'
    : `Share all covers the ports of: ${allPrograms.join(', ')}. Any other port you can still switch on one by one.`
}

/** The https-by-name line: what state the certificate is in, in plain words, or null when there is nothing to say (Ports off). */
export function gateWords(g: PortsGate): { text: string; tone: 'good' | 'wait' | 'bad' } | null {
  if (g.https === 'off') return null
  if (g.https === 'ready') return { text: 'The name opens over https, with a real certificate.', tone: 'good' }
  if (g.https === 'getting') return { text: 'Getting the certificate for the name. The address link works meanwhile.', tone: 'wait' }
  return { text: `This PC has no certificate of its own yet, so Tailscale does the https (by name) and the link by address warns.${g.detail ? ` ${g.detail}` : ''}`, tone: 'bad' }
}

/** What to tell about one share's links: the agent's own sentence when it has one, else a plain word for a warning or a missing link. Empty when the links just work. */
export function linkNotes(s: Pick<PortShare, 'httpsUrl' | 'ipUrl' | 'ipUrlWarns'> & { note?: string | null }): string[] {
  if (s.note?.trim()) return [s.note.trim()]
  if (!s.ipUrl) return ['There is no link by address.']
  if (s.ipUrlWarns) return ['The browser warns about the certificate on the link by address; click through.']
  // Plain http by the address: it opens, but without the padlock.
  if (s.ipUrl.startsWith('http://')) return [NO_PADLOCK]
  return []
}

/** Said under the link by address when it is plain http (F-117): the link by name is the main one. */
export const NO_PADLOCK = 'Opens without the padlock, because no certificate can name an address. Use the link by name when you can.'

/** Next to the switch of the app's own page: what sharing it means. */
export const APP_PAGE_WARNING =
  'This is this PC’s own app page. Shared, it lets every device on your tailnet, whatever account it is signed in with, use this PC’s app.'

export const TLS_WORDS: Record<PortsTlsBy, { label: string; hint: string }> = {
  agent: { label: 'This app', hint: 'The link by address is plain http: it opens with no warning, and without the padlock.' },
  tailscale: { label: 'Tailscale', hint: 'The link by address is https, and the browser warns about its certificate. Tailscale does the https, so there is no plain http and no redirect.' },
}

/** The http-to-https redirect line under its switch: what it does now, and why not when it can't. Null when the agent has no such setting (an agent before F-117). */
export function redirectWords(s: Pick<PortsState, 'tlsBy' | 'httpRedirect'>): { text: string; tone: 'good' | 'wait' } | null {
  const r = s.httpRedirect
  if (!r) return null
  if (s.tlsBy === 'tailscale') return { text: 'With Tailscale doing the https there is no redirect, and no plain http either.', tone: 'wait' }
  if (!r.on) return { text: 'Off: http by name opens as it is, without the padlock.', tone: 'wait' }
  if (!r.active) return { text: 'On, but not working yet: it needs this app’s own certificate (see the line above).', tone: 'wait' }
  return { text: 'On: http by name goes to https by name, whatever was typed. http by address stays http.', tone: 'good' }
}
