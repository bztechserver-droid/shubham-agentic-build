import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { LinkPath, Location, Route } from '../shared/agent-api.ts'
import { isDnsName, type HubRecord } from './devices.ts'
import { createMux, type Control, type Mux, type OpenHandler } from './link/mux.ts'
import { tlsClient, tlsServer, type PeerTls, type TlsIdentity, type VerifyPeer } from './link/tls.ts'
import type { Logger } from './log.ts'
import { inCidr, isTailnet, parseHostPort, parseIPv4, type Subnet } from './net.ts'
import { mangle, unmangle } from './rendezvous/codec.ts'
import { hubLabels, rankPeers, suffixOf, type TailnetView } from './tailnet-peers.ts'
import {
  connectTcp,
  punchFailure,
  punchHoleRequest,
  relayAllowed,
  sendOneShot,
  type PunchAnswer,
  type Push,
} from './rendezvous/hbbs.ts'
import type { Outgoing } from './rendezvous/messages.ts'
import { joinRelay, RELAY_TIMEOUT_MS } from './rendezvous/relay.ts'

// How a member reaches its hub, and how the hub answers hbbs (agent/SPEC.md › The flows).
// The member is the controller, the hub the controlled side:
//   1. Direct: TLS straight to the hub's LAN address, when it is in one of our subnets.
//   1b. Tailscale: TLS straight to the hub's Tailscale address, when both PCs run Tailscale.
//   2. Through hbbs: PunchHoleRequest. On one LAN hbbs asks the hub for its LAN address
//      (FetchLocalAddr) and passes it on (is_local): TLS straight there ("hub-lan"). A
//      relay_response (the hub answered a PunchHole) names hbbr and a uuid.
//   3. A relay: RequestRelay with our own uuid through hbbs to the hub, then both join hbbr.
// The route setting picks which of these run (shared/agent-api.ts › Route). Every attempt
// ends in pinned TLS and the hub's hello: until the hello comes, the hub may still turn us
// away (it checks our certificate after the handshake).

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const ms = (n: number) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`)
const hostOf = (addr: string) => parseHostPort(addr)?.host ?? addr

export interface Timing {
  /** TCP connect of the direct probe. */
  directConnectMs: number
  /** The whole direct probe: TCP, TLS and the hub's hello. */
  directTotalMs: number
  /** TCP connect to the hub's Tailscale address (a first packet may wait for Tailscale to find a path). */
  tailnetConnectMs: number
  /** The whole Tailscale attempt, hello included. */
  tailnetTotalMs: number
  /** Waiting for hbbs's answer to PunchHoleRequest (the hub answers through hbbs). */
  punchMs: number
  /** TLS to the LAN address hbbs gave (hub-lan), hello included. */
  hubLanMs: number
  /** Waiting in hbbr for the hub (hbbr itself gives up after 30 s). */
  relayMs: number
  /** TLS over the relay, hello included. */
  tlsMs: number
}

export const TIMING: Timing = {
  directConnectMs: 3000,
  directTotalMs: 5000,
  tailnetConnectMs: 5000,
  tailnetTotalMs: 10_000,
  punchMs: 10_000,
  hubLanMs: 5000,
  relayMs: RELAY_TIMEOUT_MS,
  tlsMs: 10_000,
}

export interface HubLink {
  mux: Mux
  /** The hub's hello. */
  hello: Control
  path: LinkPath
  location: Location
  /** The far end: the hub's address, or hbbr's. */
  address: string
  /** How this link was decided, step by step. */
  evidence: string[]
}

/** Why no link came up. `refused`: the hub itself turned this PC away. */
export type ConnectFailure = Error & { location: 'offline' | 'unreachable'; refused: boolean; evidence: string[]; hint?: string; /** F-112: on a refusal, 'ip:port' of the hub that answered (not a relay's), ready for Join a hub. */ answeredAt?: string }

function failure(text: string, location: 'offline' | 'unreachable', refused = false): ConnectFailure {
  return Object.assign(new Error(text), { location, refused, evidence: [] as string[] })
}

/** F-113: how a try of the typed address went. */
export interface ManualResult {
  result: 'accepted' | 'refused' | 'wrong-pc' | 'no-answer'
  detail: string
}

export const isRefusal = (e: unknown): boolean => (e as Partial<ConnectFailure> | null)?.refused === true

export interface ConnectOptions {
  identity: TlsIdentity
  hub: HubRecord
  /** Our hello. `path` and `evidence` are added per attempt, so the hub knows how we came. */
  hello: Control
  /** Which steps run (shared/agent-api.ts › Route). */
  route: Route
  /** SAD_TEST_SKIP_DIRECT: leave out step 1, to prove the hub-lan path on one PC. */
  skipDirect?: boolean
  /** This PC's Tailscale address now, or null: step 1b needs Tailscale at both ends. */
  tailnet?: () => string | null
  /**
   * F-110: when the stored Tailscale address does not answer, try the hub's name, then look for the hub among the PCs on this PC's own tailnet.
   * Default true; false is the way before 5 Nov 2026 (the stored address only).
   */
  tailnetSearch?: boolean
  /** F-110: this PC's tailnet as it is now (its PCs and its name suffix), read when the stored address fails; null when unknown. */
  tailnetPeers?: () => Promise<TailnetView | null>
  /** F-113: told how the try of the typed address (`hub.manualAddress`) went. */
  onManual?: (r: ManualResult) => void
  /**
   * More addresses for step 1: where LAN discovery heard the pinned hub's ID answer. Discovery
   * is not authenticated, but the pin is: an impostor there fails TLS like any wrong key.
   */
  lanPeers?: string[]
  subnets: () => Subnet[]
  version: string
  /** Control messages after the hub's hello, with the link's mux to tell links apart. */
  onControl?: (msg: Control, mux: Mux) => void
  /** Stream kinds this end accepts from the hub. */
  onOpen?: Record<string, OpenHandler>
  /** Each evidence line as it is decided. */
  onEvidence?: (line: string) => void
  log?: Logger
  timing?: Partial<Timing>
}

interface Way {
  path: LinkPath
  location: Location
  address: string
  /** The evidence line once TLS is through, given the time since the attempt started. */
  tlsLine: (elapsedMs: number) => string
  started: number
}

/**
 * TLS with the hub pinned, then hellos. Resolves on the hub's hello; a close before it is the
 * hub turning us away (a removed or unknown device). Takes ownership of `raw`.
 */
function establish(raw: Duplex, way: Way, o: ConnectOptions, timeoutMs: number, note: (line: string) => void, evidence: string[]) {
  const deadline = Date.now() + timeoutMs
  let wrongKey: string | null = null
  const pinned: VerifyPeer = (id, spki) => {
    const ok = id === o.hub.id && spki.toString('hex') === o.hub.spkiSha256
    if (!ok) wrongKey = id
    return ok
  }
  return tlsClient(raw, o.identity, pinned, timeoutMs, m => o.log?.debug(m)).then(
    peer =>
      new Promise<HubLink>((resolve, reject) => {
        note(way.tlsLine(Date.now() - way.started))
        let hello: Control | null = null
        let settled = false
        const settle = (e: ConnectFailure | null, why?: string) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (!e) return
          if (why) mux.close(why)
          reject(e)
        }
        const timer = setTimeout(
          () => settle(failure(`no hello from the hub within ${ms(timeoutMs)}`, 'unreachable'), 'no hello from the hub in time'),
          Math.max(0, deadline - Date.now()),
        )
        const mux = createMux(peer.tls, {
          onControl: msg => {
            if (hello) return o.onControl?.(msg, mux)
            if (settled) return
            if (msg.t !== 'hello' || msg.role !== 'hub' || msg.id !== o.hub.id) {
              return settle(failure(`the hub sent '${msg.t}' before its hello`, 'unreachable'), `expected the hub's hello, got '${msg.t}'`)
            }
            hello = msg
            settle(null)
            resolve({ mux, hello: msg, path: way.path, location: way.location, address: way.address, evidence })
          },
          onOpen: o.onOpen,
          log: m => o.log?.debug(`link: ${m}`),
        })
        mux.on('close', reason => {
          if (settled) return
          // TLS went through with the right hub, so this is its answer: it does not take this PC.
          const why = reason.replace(/^peer: /, '')
          note(`The hub refused this PC: ${why}`)
          const sock = raw as { remoteAddress?: string; remotePort?: number }
          const direct = way.path !== 'relay-lan' && way.path !== 'relay-internet'
          const answeredAt = direct ? (sock.remoteAddress && sock.remotePort ? `${sock.remoteAddress.replace(/^::ffff:/i, '')}:${sock.remotePort}` : way.address) : undefined
          settle(Object.assign(failure(`the hub refused this PC (${why})`, 'unreachable', true), answeredAt ? { answeredAt, reason: why } : { reason: why }))
        })
        mux.send({ ...o.hello, path: way.path, evidence: evidence.slice(-8) })
      }),
    (e: unknown) => {
      if (wrongKey) throw failure(`answered as device ${wrongKey}, not the paired hub ${o.hub.id}`, 'unreachable')
      throw e
    },
  )
}

/** Step 1 alone: the hub at its LAN address, or null. Links.ts also uses it to leave a relay. */
export async function probeDirect(o: ConnectOptions, note: (line: string) => void, evidence: string[]): Promise<HubLink | null> {
  const t = { ...TIMING, ...o.timing }
  const subnets = o.subnets()
  const heard = (o.lanPeers ?? []).filter(addr => addr !== o.hub.lan.peer)
  const candidates = [...new Set([o.hub.lan.peer, ...heard])].filter(addr => subnets.some(s => inCidr(hostOf(addr), s.cidr)))
  if (!candidates.length) {
    const ours = subnets.map(s => s.cidr).join(', ') || 'no LAN'
    note(`Direct: skipped, ${hostOf(o.hub.lan.peer)} is not in this PC's subnets (${ours})`)
    return null
  }
  for (const addr of heard) if (candidates.includes(addr)) note(`Direct: the hub answered on this network from ${addr}; trying it too`)
  // All at once, capped; the first link wins and any later one is closed.
  const deadline = Date.now() + t.directTotalMs
  const attempts = candidates.map(async addr => {
    const started = Date.now()
    let socket
    try {
      socket = await connectTcp(addr, Math.min(t.directConnectMs, t.directTotalMs))
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      note(
        code === 'ECONNREFUSED'
          ? `Direct: ${addr} refused the connection (no agent listening there)`
          : `Direct: ${addr} didn't answer in ${ms(t.directConnectMs)}`,
      )
      throw e
    }
    const way: Way = {
      path: 'lan-direct',
      location: 'same-network',
      address: addr,
      started,
      tlsLine: elapsed => `Direct: TLS to ${addr} in ${ms(elapsed)}, pinned key matched`,
    }
    try {
      return await establish(socket, way, o, Math.max(0, deadline - Date.now()), note, evidence)
    } catch (e) {
      if (!isRefusal(e)) note(`Direct: ${addr}: ${message(e)}`)
      throw e
    }
  })
  let winner: HubLink | null = null
  try {
    winner = await Promise.any(attempts)
    return winner
  } catch (e) {
    const errors = e instanceof AggregateError ? e.errors : [e]
    const refused = errors.find(isRefusal)
    if (refused) throw refused
    return null
  } finally {
    // Others that still came up later: close them.
    void Promise.allSettled(attempts).then(results => {
      for (const r of results) if (r.status === 'fulfilled' && r.value !== winner) r.value.mux.close('another direct link won')
    })
  }
}

/**
 * Step 0 (F-113): the address typed by hand for the hub. Any route but Relay only. TCP, then pinned TLS and the hello, like every other path, so an address that
 * belongs to another PC fails on the pin and is told so. Null when there is none, or when nothing good came of it (the evidence says why); a refusal by the hub is thrown.
 */
export async function probeManual(o: ConnectOptions, note: (line: string) => void, evidence: string[]): Promise<HubLink | null> {
  const at = o.hub.manualAddress
  if (!at) return null
  const t = { ...TIMING, ...o.timing }
  const host = hostOf(at)
  // How it counts: a Tailscale address or name (100.64/10, *.ts.net, a bare machine name) is over Tailscale; an address on this PC's LAN is the same network; any other is direct over the internet.
  const viaTailnet = isTailnet(host) || host.endsWith('.ts.net') || (parseIPv4(host) === null && !host.includes('.'))
  const sameNet = parseIPv4(host) !== null && o.subnets().some(s => inCidr(host, s.cidr))
  const started = Date.now()
  let socket
  try {
    socket = await connectTcp(at, Math.min(t.tailnetConnectMs, t.tailnetTotalMs))
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    const why =
      code === 'ECONNREFUSED'
        ? `${at} refused the connection (no agent listening there)`
        : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
          ? `the name ${host} is not known on this PC`
          : `${at} didn't answer in ${ms(t.tailnetConnectMs)}${viaTailnet && !o.tailnet?.() ? ' (Tailscale is not running on this PC)' : ''}`
    note(`Typed address: ${why}`)
    o.onManual?.({ result: 'no-answer', detail: `Nothing answered at ${at}: ${why}.` })
    return null
  }
  const way: Way = {
    path: viaTailnet ? 'tailscale' : 'lan-direct',
    location: sameNet ? 'same-network' : 'internet',
    address: at,
    started,
    tlsLine: elapsed => `Typed address: TLS to ${at} in ${ms(elapsed)}, pinned key matched`,
  }
  try {
    const link = await establish(socket, way, o, Math.max(0, started + t.tailnetTotalMs - Date.now()), note, evidence)
    o.onManual?.({ result: 'accepted', detail: `${o.hub.name} answered at ${at} and let this PC in.` })
    return link
  } catch (e) {
    if (isRefusal(e)) {
      o.onManual?.({ result: 'refused', detail: `${o.hub.name} answered at ${at} but does not know this PC (it was removed, or never paired). Pair it again.` })
      throw e
    }
    const wrong = /not the paired hub/.test(message(e))
    note(`Typed address: ${at}: ${message(e)}`)
    o.onManual?.(
      wrong
        ? { result: 'wrong-pc', detail: `Something answered at ${at}, but it is not ${o.hub.name} (its ID or key is different), so it was not used.` }
        : { result: 'no-answer', detail: `${at} answered, but not as a hub: ${message(e)}.` },
    )
    return null
  }
}

/**
 * Step 1b alone: the hub over Tailscale, or null. Tailscale tells us nothing about where the hub is, so the link counts as over the internet.
 *
 * F-110 (5 Nov 2026): the stored address goes stale when the hub moves to another tailnet. So, all at once: the stored address and the hub's name
 * (`tailnetTargets`); if none answers, every other PC on THIS PC's tailnet (`tailnet-peers.ts`). The pin (the hub's ID and key) decides who is really
 * there, so a wrong PC costs a line of evidence and nothing else; the hub's hello then refreshes the stored address. With `tailnetSearch` off only the
 * stored address is dialled, as before. Why it failed is said in plain words (`hint`): another tailnet, or no PC answering.
 */
export async function probeTailnet(
  o: ConnectOptions,
  note: (line: string) => void,
  evidence: string[],
  hint?: (text: string) => void,
): Promise<HubLink | null> {
  const t = { ...TIMING, ...o.timing }
  const search = o.tailnetSearch !== false
  const targets = tailnetTargets(o.hub, search)
  if (!targets.length) {
    note("Tailscale: skipped, the hub hasn't said it is on Tailscale")
    return null
  }
  if (!o.tailnet?.()) {
    note('Tailscale: skipped, Tailscale is not running on this PC')
    return null
  }
  const first = await raceTailnet(o, targets, targets.length > 1 ? Math.min(t.tailnetConnectMs, 5000) : t.tailnetConnectMs, note, evidence, t)
  if (first) {
    if (first.address !== targets[0]) note(`Tailscale: the hub answered at ${first.address} (not its stored address); its details are refreshed from its hello`)
    return first
  }
  if (!search || !o.tailnetPeers) return null

  const view = await o.tailnetPeers().catch(() => null)
  if (!view) {
    note("Tailscale: could not read this PC's tailnet to look for the hub there")
    return null
  }
  const port = parseHostPort(o.hub.lan.peer)?.port ?? parseHostPort(o.hub.tailnet ?? '')?.port ?? 21220
  const { named, others } = rankPeers(view, o.hub, port, targets)
  const total = named.length + others.length
  note(`Tailscale: the stored address did not work; looking for the hub among the ${total} other PC${total === 1 ? '' : 's'} on this PC's tailnet${view.suffix ? ` (${view.suffix})` : ''}`)
  const connectMs = Math.min(t.tailnetConnectMs, 3000)
  // PCs named like the hub first; the rest only when none of those is it.
  let found = named.length ? await raceTailnet(o, named, connectMs, note, evidence, t) : null
  if (!found && others.length) found = await raceTailnet(o, others, connectMs, note, evidence, t)
  if (found) {
    note(`Tailscale: found the hub on this tailnet at ${found.address}; its stored address is refreshed from its hello`)
    return found
  }
  hint?.(tailnetHint(view, o.hub, total))
  note(`Tailscale: no PC on this tailnet answered as ${o.hub.name}`)
  return null
}

/** Why no PC on this tailnet answered, in plain words: another tailnet when the names say so, else "none of them". */
export function tailnetHint(view: Pick<TailnetView, 'suffix'>, hub: Pick<HubRecord, 'name' | 'tailnetName'>, total: number): string {
  const mine = view.suffix
  const last = suffixOf(hub.tailnetName)
  const who = hub.name
  if (mine && last && mine !== last) return `This PC is on the tailnet ${mine}, but ${who} was last on ${last}. Sign this PC in to the tailnet ${who} is on now.`
  return `None of the ${total} other PC${total === 1 ? '' : 's'} on this PC's tailnet${mine ? ` (${mine})` : ''} answered as ${who}. Is ${who} on, and signed in to this tailnet? If it moved to another tailnet, sign this PC in to that one.`
}

/**
 * The places to dial the hub over Tailscale: the stored address, then (when `search` is on) the name it told us and that name's first label, then - for a
 * hub paired before it told its name - its own name as a label ("Server" → "server"). The same port throughout. Empty when the hub never said it is on Tailscale.
 */
export function tailnetTargets(hub: HubRecord, search = true): string[] {
  const out: string[] = []
  if (hub.tailnet) out.push(hub.tailnet)
  if (!search || !(hub.tailnet || hub.tailnetName)) return out
  const port = parseHostPort(hub.lan.peer)?.port ?? parseHostPort(hub.tailnet ?? '')?.port
  if (!port) return out
  const hosts = hub.tailnetName ? [hub.tailnetName, hub.tailnetName.split('.')[0]] : hubLabels(hub)
  for (const h of hosts) if (isDnsName(h)) out.push(`${h}:${port}`)
  return [...new Set(out)]
}

/**
 * Dials all of `targets` at once. The first link wins (a later one is closed); a refusal by the hub itself is conclusive and is thrown at once, without
 * waiting for a slow name lookup; otherwise null once every dial has failed.
 */
function raceTailnet(o: ConnectOptions, targets: string[], connectMs: number, note: (line: string) => void, evidence: string[], t: Timing): Promise<HubLink | null> {
  const attempts = targets.map(at => tailnetOnce(o, at, connectMs, note, evidence, t))
  return new Promise<HubLink | null>((resolve, reject) => {
    let left = attempts.length
    let done = false
    for (const attempt of attempts) {
      attempt.then(
        link => {
          if (done) return link.mux.close('another Tailscale link won')
          done = true
          resolve(link)
        },
        (e: unknown) => {
          if (done) return
          if (isRefusal(e)) {
            done = true
            return reject(e)
          }
          if (--left === 0) {
            done = true
            resolve(null)
          }
        },
      )
    }
  })
}

/** One dial: TCP, then pinned TLS and the hello. Rejects when it does not work (the evidence line says why). */
async function tailnetOnce(o: ConnectOptions, at: string, connectMs: number, note: (line: string) => void, evidence: string[], t: Timing): Promise<HubLink> {
  const started = Date.now()
  let socket
  try {
    socket = await connectTcp(at, Math.min(connectMs, t.tailnetTotalMs))
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    note(
      code === 'ECONNREFUSED'
        ? `Tailscale: ${at} refused the connection (no agent listening there)`
        : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
          ? `Tailscale: the name ${hostOf(at)} is not known on this PC's tailnet`
          : `Tailscale: ${at} didn't answer in ${ms(connectMs)} (is Tailscale running on the hub?)`,
    )
    throw e
  }
  const way: Way = {
    path: 'tailscale',
    location: 'internet',
    address: at,
    started,
    tlsLine: elapsed => `Tailscale: TLS to ${at} in ${ms(elapsed)}, pinned key matched`,
  }
  try {
    return await establish(socket, way, o, Math.max(0, started + t.tailnetTotalMs - Date.now()), note, evidence)
  } catch (e) {
    if (!isRefusal(e)) note(`Tailscale: ${at}: ${message(e)}`)
    throw e
  }
}

const ROUTE_NOTE: Partial<Record<Route, string>> = {
  tailscale: 'How to connect is Tailscale only: skipped the same-network check and the RustDesk servers',
  relay: "How to connect is Relay only: skipped the direct probe, Tailscale and hbbs's LAN answer",
}

/**
 * The member's decision, every step the route allows (agent/SPEC.md › The flows). Resolves
 * with the first link up; rejects with a ConnectFailure carrying the location to show.
 */
export async function connectHub(o: ConnectOptions): Promise<HubLink> {
  const t = { ...TIMING, ...o.timing }
  const evidence: string[] = []
  const note = (line: string) => {
    evidence.push(line)
    o.onEvidence?.(line)
    o.log?.info(`connect ${o.hub.name}: ${line}`)
  }
  // F-110: why the Tailscale step failed, in plain words, for the row's second line (links.ts puts it last).
  let tailHint: string | undefined
  const fail = (e: ConnectFailure) => Object.assign(e, { evidence }, tailHint && !e.refused ? { hint: tailHint } : {})
  const local = (addr: string) => o.subnets().some(s => inCidr(hostOf(addr), s.cidr))
  const licenceKey = o.hub.licenceKey ?? ''

  // TLS to the LAN address hbbs passed on. Null when it fails for a reason other than the hub refusing us.
  const hubLan = async (at: string): Promise<HubLink | null> => {
    const started = Date.now()
    try {
      const socket = await connectTcp(at, t.hubLanMs)
      const way: Way = {
        path: 'hub-lan',
        location: local(at) ? 'same-network' : 'internet',
        address: at,
        started,
        tlsLine: elapsed => `TLS to ${at} in ${ms(elapsed)}, pinned key matched`,
      }
      return await establish(socket, way, o, Math.max(0, started + t.hubLanMs - Date.now()), note, evidence)
    } catch (e) {
      if (isRefusal(e)) throw fail(e as ConnectFailure)
      note(`TLS to ${at} failed: ${message(e)}`)
      return null
    }
  }

  // hbbr pairs us with the hub by uuid; the hub writes SAD1 once it is in.
  const viaRelay = async (relay: string, uuid: string): Promise<HubLink | null> => {
    const started = Date.now()
    let socket
    try {
      socket = await joinRelay(relay, { uuid, licenceKey, role: 'controller', timeoutMs: t.relayMs, log: m => o.log?.debug(m) })
    } catch (e) {
      note(`Relay: hbbr ${relay}: ${message(e)}`)
      return null
    }
    note(`Relay: hbbr ${relay} paired in ${ms(Date.now() - started)}, SAD1 seen`)
    const path: LinkPath = local(relay) ? 'relay-lan' : 'relay-internet'
    const way: Way = {
      path,
      location: path === 'relay-lan' ? 'same-network' : 'internet',
      address: relay,
      started: Date.now(),
      tlsLine: () => 'TLS through the relay, pinned key matched',
    }
    try {
      return await establish(socket, way, o, t.tlsMs, note, evidence)
    } catch (e) {
      if (isRefusal(e)) throw fail(e as ConnectFailure)
      note(`TLS through the relay failed: ${message(e)}`)
      return null
    }
  }

  const route = o.route
  const routeNote = ROUTE_NOTE[route]
  if (routeNote) note(routeNote)

  // 0. An address typed by hand (F-113): first, on any route but Relay only; the steps below still run if it gets nowhere.
  if (route !== 'relay' && o.hub.manualAddress) {
    try {
      const link = await probeManual(o, note, evidence)
      if (link) return link
    } catch (e) {
      throw fail(e as ConnectFailure)
    }
  }

  // 1. Same network first.
  if (route === 'auto' || route === 'rustdesk') {
    if (o.skipDirect) note('Direct: skipped (SAD_TEST_SKIP_DIRECT)')
    else {
      try {
        const link = await probeDirect(o, note, evidence)
        if (link) return link
      } catch (e) {
        throw fail(e as ConnectFailure)
      }
    }
  }

  // 1b. Tailscale, before hbbs: away from the hub's network, hbbs at the public address may
  // not answer at all until the firewall in front of it lets it.
  if (route === 'auto' || route === 'tailscale') {
    try {
      const link = await probeTailnet(o, note, evidence, text => (tailHint = text))
      if (link) return link
    } catch (e) {
      throw fail(e as ConnectFailure)
    }
    if (route === 'tailscale') throw fail(failure('No link over Tailscale', 'unreachable'))
  }

  // 2. Through hbbs: its LAN address first, when it is on our network.
  if (!o.hub.licenceKey) note("The hub's hbbs key is not known yet, so hbbs and hbbr will refuse this PC")
  const hbbsList = [...new Set([...(local(o.hub.lan.hbbs) ? [o.hub.lan.hbbs] : []), o.hub.public.hbbs])]
  let answer: PunchAnswer | null = null
  let hbbs: string | null = null
  for (const addr of hbbsList) {
    const started = Date.now()
    try {
      answer = await punchHoleRequest(addr, { id: o.hub.id, licenceKey, version: o.version, timeoutMs: t.punchMs, log: m => o.log?.debug(m) })
      hbbs = addr
      o.log?.debug(`hbbs ${addr} answered in ${ms(Date.now() - started)}`)
      break
    } catch (e) {
      const unreachable = /No TCP connection/.test(message(e)) || typeof (e as NodeJS.ErrnoException).code === 'string'
      note(`hbbs ${addr}: ${message(e)}`)
      // Reached but silent: the hub's answer may have been lost; a relay may still work.
      if (!unreachable) hbbs ??= addr
    }
  }
  if (!hbbs) throw fail(failure('Every path failed: neither the hub nor its hbbs answered', 'unreachable'))

  try {
    if (answer?.kind === 'punch_hole_response') {
      const refusedBy = punchFailure(answer.body)
      if (refusedBy) {
        const offline = refusedBy === 'OFFLINE' || refusedBy === 'ID_NOT_EXIST'
        note(`hbbs said: ${refusedBy}${HINT[refusedBy] ?? ''}`)
        throw fail(failure(`hbbs said ${refusedBy}`, offline ? 'offline' : 'unreachable'))
      }
      let at: string | null = null
      try {
        const { ip, port } = unmangle(answer.body.socket_addr)
        at = `${ip}:${port}`
      } catch (e) {
        note(`hbbs sent an address this PC can't read: ${message(e)}`)
      }
      if (at && answer.body.is_local) {
        note(`hbbs said: same LAN (FetchLocalAddr), the hub is at ${at}`)
        if (route === 'relay') note("Relay only: not using hbbs's LAN answer")
        else {
          const link = await hubLan(at)
          if (link) return link
        }
      } else if (at) {
        note(`hbbs said: the hub is at ${at} for a hole punch, which this agent can't do; asking for a relay`)
      }
    } else if (answer?.kind === 'relay_response') {
      const relay = answer.body.relay_server
      if (!relayAllowed(relay, [o.hub.lan.hbbr, o.hub.public.hbbr])) {
        note(`hbbs offered relay "${relay}", which is not the hub's: ignored`)
      } else if (answer.body.uuid) {
        note(`hbbs ${hbbs} offered a relay`)
        const link = await viaRelay(relay, answer.body.uuid)
        if (link) return link
      }
    }

    // 3. Ask for a relay with our own uuid: hbbs passes it to the hub, and both join hbbr.
    const relay = local(o.hub.lan.hbbr) ? o.hub.lan.hbbr : o.hub.public.hbbr
    const uuid = randomUUID()
    const request: Outgoing = {
      request_relay: { id: o.hub.id, uuid, relay_server: relay, licence_key: licenceKey, conn_type: 'DEFAULT_CONN' },
    }
    if (answer?.send(request)) {
      note(`Asked hbbs for a relay through ${relay}`)
    } else {
      try {
        await sendOneShot(hbbs, request)
        note(`Asked hbbs ${hbbs} for a relay through ${relay}`)
      } catch (e) {
        note(`hbbs ${hbbs}: could not ask for a relay: ${message(e)}`)
        throw fail(failure('Every path failed: hbbs took no relay request', 'unreachable'))
      }
    }
    const link = await viaRelay(relay, uuid)
    if (link) return link
    throw fail(failure('Every path failed', 'unreachable'))
  } finally {
    answer?.close()
  }
}

const HINT: Record<string, string> = {
  OFFLINE: ', the hub has not registered in the last 30 s (is its agent running?)',
  ID_NOT_EXIST: ', hbbs does not know the hub (its agent has not registered yet)',
  LICENSE_MISMATCH: ", this PC has an old copy of the hub's key: it updates on the next direct link",
}

// ---------------------------------------------------------------------------------------
// The hub's side: answering what hbbs forwards from a member

export interface RelayVia {
  /** The relay_server hbbs named. */
  relay: string
  /** The member's address as hbbs saw it, or null. */
  from: string | null
}

export interface HubSideOptions {
  identity: TlsIdentity & { id: string }
  version: string
  /** This PC's LAN address now, or null. */
  lan: () => string | null
  ports: { peer: number; hbbs: number; hbbr: number }
  /** hbbs/hbbr's key, null until hbbs runs with one. */
  licenceKey: () => string | null
  /** Who may come through a relay: the allowlist, checked in the TLS step. */
  verifyPeer: VerifyPeer
  /** A member came through a relay and TLS is through: hand it on. */
  accept: (peer: PeerTls, via: RelayVia) => void
  log?: Logger
  timing?: Partial<Pick<Timing, 'relayMs' | 'tlsMs'>>
}

function readAddr(b: Uint8Array): string | null {
  try {
    const { ip, port } = unmangle(b)
    return `${ip}:${port}`
  } catch {
    return null
  }
}

/**
 * Answers one push from hbbs (startRegistration's onPush; the relay allowlist and rate limit
 * are already applied there). Replies to hbbs each take a new TCP connection, as hbbs closes
 * it after one (rendezvous_server.rs 507-532).
 */
export async function answerPush(o: HubSideOptions, ...push: Push): Promise<void> {
  const [kind, body] = push
  const lan = o.lan()
  if (!lan) throw new Error(`${kind}: this PC has no LAN address`)
  const hbbs = `${lan}:${o.ports.hbbs}`
  const from = readAddr(body.socket_addr)
  const t = { ...TIMING, ...o.timing }

  if (kind === 'fetch_local_addr') {
    // hbbs passes local_addr on to the member as is_local: our TLS listener.
    await sendOneShot(
      hbbs,
      {
        local_addr: {
          socket_addr: body.socket_addr,
          local_addr: mangle(lan, o.ports.peer),
          relay_server: body.relay_server,
          id: o.identity.id,
          version: o.version,
        },
      },
      { localAddress: lan },
    )
    o.log?.info(`hbbs asked for this hub's LAN address (FetchLocalAddr) for ${from ?? 'a member'}: sent ${lan}:${o.ports.peer}`)
    return
  }

  const licenceKey = o.licenceKey()
  if (!licenceKey) throw new Error(`${kind}: hbbs has no key yet, so hbbr would refuse the relay`)
  let uuid: string
  if (kind === 'punch_hole') {
    // We can't punch holes: offer a relay instead, with our own uuid.
    uuid = randomUUID()
    await sendOneShot(
      hbbs,
      { relay_response: { socket_addr: body.socket_addr, uuid, relay_server: body.relay_server, id: o.identity.id, version: o.version } },
      { localAddress: lan },
    )
  } else {
    uuid = body.uuid
    if (!uuid || uuid.length > 64) throw new Error('request_relay without a usable uuid')
  }
  // hbbr is this PC's own: join it at the LAN address whichever of its two addresses the push
  // names, so nothing goes out to the router and back.
  const hbbr = `${lan}:${o.ports.hbbr}`
  const started = Date.now()
  const raw = await joinRelay(hbbr, { uuid, licenceKey, id: o.identity.id, role: 'controlled', localAddress: lan, log: m => o.log?.debug(m) })
  o.log?.info(`relay: joined hbbr ${hbbr} for ${from ?? 'a member'} (${kind}), SAD1 sent`)
  // The member may take up to hbbr's 30 s to arrive before its TLS starts.
  const peer = await tlsServer(raw, o.identity, o.verifyPeer, t.relayMs + t.tlsMs, m => o.log?.debug(m))
  o.log?.info(`relay: TLS with ${peer.peerId} through hbbr in ${ms(Date.now() - started)}`)
  o.accept(peer, { relay: body.relay_server, from })
}
