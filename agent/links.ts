import type { DeviceInfo, LinkPath, Location, Route } from '../shared/agent-api.ts'
import { connectHub, probeDirect, type ConnectFailure, type ConnectOptions, type HubLink, type RelayVia, type Timing } from './connect.ts'
import { checkBundle, cleanName, type DeviceStore, type MemberRecord } from './devices.ts'
import type { Identity } from './link/identity.ts'
import { createMux, type Control, type Mux, type OpenHandler } from './link/mux.ts'
import type { PeerTls } from './link/tls.ts'
import type { Logger } from './log.ts'
import type { TailnetView } from './tailnet-peers.ts'
import { inCidr, parseHostPort, type Subnet } from './net.ts'
import type { PairingHub } from './pairing.ts'

// The live links (agent/SPEC.md › links.ts). A member keeps exactly one link to its hub:
// reconnecting with backoff, re-probing the direct path while it rides a relay or Tailscale,
// and running the whole decision again on "Check again". The hub keeps every member's
// incoming links and hellos, and decides on each new one: a paired device's hello, or a
// pairing request.

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const iso = (ms: number) => new Date(ms).toISOString()
const isRelay = (path: LinkPath) => path === 'relay-lan' || path === 'relay-internet'
/** Paths a direct link on the same network should replace when it comes back. */
const roundabout = (path: LinkPath) => isRelay(path) || path === 'tailscale'
const seconds = (ms: number) => `${ms / 1000} s`

export const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]
export const REPROBE_MS = 30_000
/** Unknown PCs that may wait to say their first word (pair-request) while a code is open: in all, and per IP. */
export const MAX_STRANGERS = 4
export const MAX_STRANGERS_PER_IP = 1

/** Closes a link once nothing runs on it, so a screen session is never cut for a better path. */
function closeWhenIdle(mux: Mux, reason: string) {
  if (mux.closed() !== null) return
  if (mux.streams() === 0) return mux.close(reason)
  setTimeout(() => closeWhenIdle(mux, reason), 2000).unref()
}

/** A peer's evidence lines from its hello: strings only, a few, not too long. */
function theirLines(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(-8).map(s => s.slice(0, 200)) : []
}

// ---------------------------------------------------------------------------------------
// A member: one link to the hub

export interface MemberLinksOptions {
  identity: Identity
  devices: DeviceStore
  /** Our hello: id, name, role, version, rustdeskId, screen, appScreen. */
  hello: () => Control
  /** The How to connect setting, read at each attempt. */
  route: () => Route
  /** SAD_TEST_SKIP_DIRECT (tests): never probe the direct path. */
  skipDirect?: boolean
  subnets: () => Subnet[]
  /** This PC's Tailscale address now, or null. */
  tailnet?: () => string | null
  /** F-110: may the Tailscale step try the hub's name when its address does not answer (config.json "tailnetSearch", default true)? Read at each attempt. */
  tailnetSearch?: () => boolean
  /** F-110: this PC's tailnet now (tailnet-peers.ts), for looking for the hub among its PCs when the stored address fails. */
  tailnetPeers?: () => Promise<TailnetView | null>
  version: string
  /** Stream kinds this end serves to the hub. */
  onOpen?: Record<string, OpenHandler>
  /**
   * Where LAN discovery heard the pinned hub answer just now: more addresses for the direct
   * probe, so a hub whose LAN address changed is found again. Pinned TLS makes a false answer
   * harmless.
   */
  lanPeers?: () => string[]
  /** Called with true when every path failed (look for the hub on the LAN), false once linked. */
  seekHub?: (on: boolean) => void
  onChange: () => void
  log?: Logger
  timing?: { backoffMs?: number[]; reprobeMs?: number; connect?: Partial<Timing> }
}

export interface MemberLinks {
  /** The hub's row; null when this PC has no hub. */
  device(): DeviceInfo | null
  /** The live link, or null. */
  mux(): Mux | null
  /** Runs the whole decision again now ("Check again", How to connect changed). */
  check(): void
  /** A new hub was pinned: drop any old link and connect. */
  hubChanged(): void
  /** Tells the hub something, on the live link. */
  send(msg: Control): void
  stop(reason?: string): void
}

export function createMemberLinks(o: MemberLinksOptions): MemberLinks {
  const backoff = o.timing?.backoffMs ?? BACKOFF_MS
  const reprobeMs = o.timing?.reprobeMs ?? REPROBE_MS
  const log = o.log
  let current: HubLink | null = null
  let since: string | null = null
  let location: Location = 'connecting'
  let evidence: string[] = []
  let lastSeen: number | null = null
  let attempt = 0
  let timer: NodeJS.Timeout | null = null
  let running = false
  // A check asked for while an attempt runs: done once that attempt ends.
  let again: string | null = null
  let stopped = false
  let opening = 'Connecting'
  let reprobe: NodeJS.Timeout | null = null
  let reprobing = false

  const changed = () => o.onChange()

  function schedule(delay: number) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void attemptNow(), delay)
    timer.unref()
  }

  // Bookkeeping that must never throw into a link callback: a devices.json that can't be
  // written for a moment (an antivirus or indexer handle, a full disk) would otherwise leave
  // the link state stuck, with no reconnect until a restart.
  function saveLastSeen() {
    try {
      o.devices.updateHub({ lastSeen: iso(lastSeen ?? Date.now()) })
    } catch (e) {
      log?.warn(`could not save when the hub was last seen: ${message(e)}`)
    }
  }
  function seek(on: boolean) {
    try {
      o.seekHub?.(on)
    } catch (e) {
      log?.warn(`LAN discovery: ${message(e)}`)
    }
  }

  // Streams on a member's link come from its hub: the handler is told so (`from`).
  function fromHub(handlers: Record<string, OpenHandler> | undefined, hub: { id: string; name: string }) {
    if (!handlers) return undefined
    const from = { id: hub.id, name: hub.name }
    return Object.fromEntries(Object.entries(handlers).map(([kind, handler]) => [kind, (meta: Record<string, unknown>) => handler({ ...meta, from })]))
  }

  function options(): ConnectOptions | null {
    const hub = o.devices.hub()
    if (!hub) return null
    return {
      identity: o.identity,
      hub,
      hello: o.hello(),
      route: o.route(),
      skipDirect: o.skipDirect,
      lanPeers: o.lanPeers?.() ?? [],
      subnets: o.subnets,
      tailnet: o.tailnet,
      tailnetSearch: o.tailnetSearch?.() ?? true,
      tailnetPeers: o.tailnetPeers,
      version: o.version,
      onControl,
      onOpen: fromHub(o.onOpen, hub),
      log,
      timing: o.timing?.connect,
    }
  }

  async function attemptNow() {
    timer = null
    const opts = options()
    if (stopped || running || current || !opts) return
    running = true
    const hubId = opts.hub.id
    evidence = [opening]
    opening = 'Connecting'
    location = 'connecting'
    changed()
    try {
      const link = await connectHub({
        ...opts,
        onEvidence: line => {
          evidence.push(line)
          changed()
        },
      })
      if (stopped || o.devices.hub()?.id !== hubId) {
        link.mux.close(stopped ? 'the agent is stopping' : 'this PC joined another hub')
        return
      }
      // The attempt's own lines: why it ran, then each step.
      adopt(link, evidence)
    } catch (e) {
      if (stopped) return
      const f = e as Partial<ConnectFailure>
      location = f.location ?? 'unreachable'
      if (!f.evidence?.length) evidence.push(`Failed: ${message(e)}`)
      // Turned away by the hub itself (removed there): no point asking again soon.
      const delay = f.refused ? backoff[backoff.length - 1] : backoff[Math.min(attempt, backoff.length - 1)]
      attempt++
      evidence.push(`${f.refused ? 'The hub turned this PC away' : 'Every path failed'}; trying again in ${seconds(delay)}`)
      // F-110: the last line is what the row shows under the name, so it says in plain words what to do.
      const hubName = opts.hub.name
      const hint = f.refused ? `${hubName} does not know this PC (it was removed, or never paired). Pair it again: on ${hubName}'s Hub page start a pairing code, then Join with it here.` : f.hint
      if (hint) evidence.push(hint)
      log?.warn(`no link to the hub: ${message(e)}; trying again in ${seconds(delay)}`)
      schedule(delay)
      // Its LAN address may have changed (no fixed lease in phase 1): ask the LAN where it is now.
      if (!f.refused) seek(true)
      changed()
    } finally {
      running = false
      const why = again
      again = null
      if (why && !stopped) rerun(why)
    }
  }

  function adopt(link: HubLink, lines: string[]) {
    current = link
    since = new Date().toISOString()
    location = link.location
    evidence = [...lines]
    attempt = 0
    lastSeen = Date.now()
    // The close handler before anything else: a link it misses would never be replaced.
    link.mux.on('close', reason => {
      if (current !== link) return
      current = null
      stopReprobe()
      lastSeen = Date.now()
      evidence.push(`Link closed: ${reason}`)
      location = 'connecting'
      opening = `Reconnecting: the last link closed (${reason})`
      log?.info(`the link to the hub closed: ${reason}`)
      if (!stopped) schedule(backoff[0])
      saveLastSeen()
      changed()
    })
    if (roundabout(link.path)) startReprobe()
    else stopReprobe()
    seek(false)
    log?.info(`linked to the hub: ${link.path} via ${link.address}`)
    // Bookkeeping last; neither of these throws.
    refreshHub(link.hello.hub)
    saveLastSeen()
    changed()
  }

  // The hub's hello and 'hub' messages carry its current details (a new LAN address, a new
  // hbbs key): keep the pin, take the rest.
  function refreshHub(v: unknown) {
    if (v === undefined || v === null) return
    const hub = o.devices.hub()
    try {
      const fresh = checkBundle(v)
      if (!hub || fresh.id !== hub.id || fresh.spkiSha256 !== hub.spkiSha256) throw new Error('not the pinned hub')
      // The Tailscale address too (F-057 follow-up, 4 Nov 2026: the hub moved to another tailnet, and a member kept dialling the old address for ever).
      // A hello without one ("Tailscale isn't up on the hub right now") keeps the last known address rather than wiping it.
      o.devices.updateHub({ name: fresh.name, lan: fresh.lan, public: fresh.public, licenceKey: fresh.licenceKey, ...(fresh.tailnet ? { tailnet: fresh.tailnet } : {}), ...(fresh.tailnetName ? { tailnetName: fresh.tailnetName } : {}) })
    } catch (e) {
      log?.warn(`ignored the hub's details: ${message(e)}`)
    }
  }

  function onControl(msg: Control, mux: Mux) {
    if (!current || mux !== current.mux) return
    if (msg.t === 'check') {
      log?.info('the hub asked this PC to check its link again')
      check()
    } else if (msg.t === 'status') {
      current.hello = { ...current.hello, screen: msg.screen === true, appScreen: msg.appScreen === true }
      changed()
    } else if (msg.t === 'hub') {
      refreshHub(msg.hub)
      changed()
    }
  }

  // While on a relay or Tailscale, look for the direct path every 30 s (when the route allows
  // it); a new direct link takes over, and the old one closes once nothing runs on it.
  function startReprobe() {
    stopReprobe()
    reprobe = setInterval(() => void probeOnce(), reprobeMs)
    reprobe.unref()
  }
  function stopReprobe() {
    if (reprobe) clearInterval(reprobe)
    reprobe = null
  }
  async function probeOnce() {
    const old = current
    const opts = options()
    if (reprobing || !old || !roundabout(old.path) || !opts || opts.skipDirect) return
    if (opts.route !== 'auto' && opts.route !== 'rustdesk') return
    reprobing = true
    const lines: string[] = []
    const was = old.path === 'tailscale' ? 'Tailscale' : 'the relay'
    try {
      const direct = await probeDirect(opts, line => lines.push(line), lines)
      if (!direct) return
      if (current !== old || stopped) return direct.mux.close('not needed any more')
      log?.info(`the direct path is back: moving off ${was}`)
      adopt(direct, [`Moved off ${was} (${old.address}): the direct path answers again`, ...lines])
      closeWhenIdle(old.mux, 'moved to a direct link')
    } catch (e) {
      log?.debug(`re-probe: ${message(e)}`)
    } finally {
      reprobing = false
    }
  }

  function rerun(why: string) {
    attempt = 0
    opening = why
    const link = current
    if (link) {
      current = null
      stopReprobe()
      link.mux.close(why.toLowerCase())
    }
    schedule(0)
  }

  // An attempt in flight may be using what just changed (the setting, the hub): run once more after it.
  function restart(why: string) {
    if (stopped) return
    if (running) again = why
    else rerun(why)
  }

  function check() {
    if (o.devices.hub()) restart('Checking again')
  }

  schedule(0)

  return {
    device() {
      const hub = o.devices.hub()
      if (!hub) return null
      const link = current
      return {
        id: hub.id,
        name: hub.name,
        role: 'hub',
        location: link ? link.location : location,
        path: link?.path ?? null,
        rttMs: link?.mux.rtt() ?? null,
        address: link?.address ?? null,
        connectedSince: link ? since : null,
        lastSeen: link ? iso(link.mux.lastSeen()) : lastSeen ? iso(lastSeen) : hub.lastSeen,
        evidence: [...evidence],
        canOpenScreen: Boolean(link && link.hello.screen === true),
        canOpenAppScreen: Boolean(link && link.hello.appScreen === true),
      }
    },
    mux: () => current?.mux ?? null,
    check,
    hubChanged: () => restart('Connecting to the new hub'),
    send(msg) {
      current?.mux.send(msg)
    },
    stop(reason = 'the agent is stopping') {
      stopped = true
      if (timer) clearTimeout(timer)
      stopReprobe()
      current?.mux.close(reason)
      current = null
    },
  }
}

// ---------------------------------------------------------------------------------------
// The hub: every member's incoming links

/** How a link reached the hub: a listener (`tailnet`: the one on its Tailscale address) or hbbr. */
export type Via = { kind: 'direct'; address: string; tailnet?: boolean } | ({ kind: 'relay' } & RelayVia)

export interface HubLinksOptions {
  devices: DeviceStore
  pairing: PairingHub
  /** The hub's hello: id, name, role, version, rustdeskId, screen, appScreen, and its details (hub). */
  hello: () => Control
  subnets: () => Subnet[]
  /** Stream kinds the hub serves to linked members. */
  onOpen?: Record<string, OpenHandler>
  onChange: () => void
  /** How long a new link may take to say hello (or pair-request). Default 10 s. */
  helloMs?: number
  log?: Logger
}

export interface HubLinks {
  /** A TLS peer from the listener (any certificate) or a relay (allowlisted): decide on it. */
  accept(peer: PeerTls, via: Via): void
  devices(): DeviceInfo[]
  /** A member's live link, or null. */
  mux(id: string): Mux | null
  /** Asks a linked member to run its decision again; false when it has no link. */
  check(id: string): boolean
  /** Takes the member off the allowlist and closes its links. */
  remove(id: string): boolean
  /** Sends to every linked member. */
  broadcast(msg: Control): void
  /** Whether a paired member's last link came from this IP (hbbs pushes from it get a reserved slot). */
  knownIp(ip: string): boolean
  stop(reason?: string): void
}

interface MemberLink {
  mux: Mux
  hello: Control
  path: LinkPath
  location: Location
  address: string
  since: string
  evidence: string[]
}

export function createHubLinks(o: HubLinksOptions): HubLinks {
  const log = o.log
  const helloMs = o.helloMs ?? 10_000
  // Every open link per member, newest last: a member moving off a relay has two for a while.
  const links = new Map<string, MemberLink[]>()
  // What the row shows once the last link is gone.
  const history = new Map<string, string[]>()
  // The IP each member's last link came from.
  const lastIp = new Map<string, string>()
  // Unknown PCs waiting to say their first word, per IP.
  const strangers = new Map<string, number>()
  let strangerCount = 0
  const local = (ip: string) => o.subnets().some(s => inCidr(ip, s.cidr))

  const current = (id: string) => links.get(id)?.at(-1) ?? null

  // Bookkeeping that must never throw into a link callback (see saveLastSeen on the member).
  function saveMember(id: string, patch: Parameters<DeviceStore['updateMember']>[1]) {
    try {
      o.devices.updateMember(id, patch)
    } catch (e) {
      log?.warn(`could not save ${id}'s details: ${message(e)}`)
    }
  }

  function linked(record: MemberRecord, mux: Mux, hello: Control, via: Via): MemberLink {
    const name = cleanName(hello.name, record.name)
    const direct = via.kind === 'direct'
    // How it came is the member's to say (it is authenticated), except for the listener it
    // came in on; where it is, ours to judge.
    const tailnet = via.kind === 'direct' && via.tailnet === true
    const path: LinkPath = tailnet
      ? 'tailscale'
      : direct
        ? hello.path === 'hub-lan' ? 'hub-lan' : 'lan-direct'
        : hello.path === 'relay-internet' ? 'relay-internet' : 'relay-lan'
    const fromIp = parseHostPort(direct ? via.address : (via.from ?? ''))?.host ?? null
    const location: Location = fromIp ? (local(fromIp) ? 'same-network' : 'internet') : path === 'relay-internet' ? 'internet' : 'same-network'
    const link: MemberLink = {
      mux,
      hello,
      path,
      location,
      address: direct ? via.address : via.relay,
      since: new Date().toISOString(),
      evidence: [
        direct
          ? `Incoming TLS from ${via.address}${tailnet ? ' over Tailscale' : ''}, pinned key matched`
          : `Relay: joined hbbr for ${via.from ?? 'it'} (${via.relay}), SAD1 sent; TLS through the relay, pinned key matched`,
        ...theirLines(hello.evidence).map(line => `${name} says: ${line}`),
      ],
    }
    links.set(record.id, [...(links.get(record.id) ?? []), link])
    if (fromIp) lastIp.set(record.id, fromIp.replace(/^::ffff:/i, ''))
    // The close handler before anything that could throw: a link it misses would stay the
    // member's current row for good.
    mux.on('close', reason => {
      const list = (links.get(record.id) ?? []).filter(l => l !== link)
      const wasCurrent = current(record.id) === link
      if (list.length) links.set(record.id, list)
      else links.delete(record.id)
      if (wasCurrent && !list.length) {
        history.set(record.id, [...link.evidence, `Link closed: ${reason}`])
        saveMember(record.id, { lastSeen: new Date().toISOString() })
      }
      log?.info(`${name}: a link closed: ${reason}`)
      o.onChange()
    })
    mux.send(o.hello())
    log?.info(`${name} (${record.id}) linked: ${path} from ${direct ? via.address : (via.from ?? 'a relay')}`)
    saveMember(record.id, {
      name,
      rustdeskId: typeof hello.rustdeskId === 'string' ? hello.rustdeskId.slice(0, 32) : null,
      lastSeen: link.since,
    })
    o.onChange()
    return link
  }

  // Only linked members may open streams, and the handler learns which one from its paired
  // record (`from`), whatever the far end put in its request.
  function guarded(who: () => { id: string; name: string } | null): Record<string, OpenHandler> {
    return Object.fromEntries(
      Object.entries(o.onOpen ?? {}).map(([kind, handler]) => [
        kind,
        (meta: Record<string, unknown>) => {
          const from = who()
          if (!from) throw new Error('say hello first')
          return handler({ ...meta, from })
        },
      ]),
    )
  }

  return {
    accept(peer, via) {
      const from = via.kind === 'direct' ? via.address : (via.from ?? 'a relay')
      const known = o.devices.allowed(peer.peerId, peer.peerSpki) !== null
      // Unknown, and no code open: turned away at once, with the reason.
      if (!known && !o.pairing.active()) {
        log?.info(`refused ${peer.peerId} from ${from}: not paired`)
        createMux(peer.tls).close('this PC is not paired with the hub')
        return
      }
      // Unknown PCs may wait for their first word only a few at a time, one per IP: nobody
      // gets to hold a crowd of sessions open while a code is.
      let release = () => {}
      if (!known) {
        const ip = via.kind === 'direct' ? (parseHostPort(via.address)?.host ?? via.address) : 'relay'
        const fromIp = strangers.get(ip) ?? 0
        if (strangerCount >= MAX_STRANGERS || fromIp >= MAX_STRANGERS_PER_IP) {
          log?.warn(`refused ${peer.peerId} from ${from}: ${fromIp >= MAX_STRANGERS_PER_IP ? `another unknown PC from ${ip}` : `${strangerCount} unknown PCs`} already waiting`)
          createMux(peer.tls).close('too many PCs are pairing at once; try again in a few seconds')
          return
        }
        strangerCount++
        strangers.set(ip, fromIp + 1)
        let held = true
        release = () => {
          if (!held) return
          held = false
          strangerCount--
          const left = (strangers.get(ip) ?? 1) - 1
          if (left > 0) strangers.set(ip, left)
          else strangers.delete(ip)
        }
      }
      let first = true
      let member: MemberLink | null = null
      // A pairing request's later messages (its reveal, its confirm) go to pairing.ts.
      let pairing: ((msg: Control) => void) | null = null
      const mux = createMux(peer.tls, {
        onControl: msg => {
          if (!first) {
            if (pairing) return pairing(msg)
            if (member && msg.t === 'status') {
              member.hello = { ...member.hello, screen: msg.screen === true, appScreen: msg.appScreen === true }
              o.onChange()
            }
            return
          }
          first = false
          clearTimeout(timer)
          release()
          if (msg.t === 'pair-request') {
            if (via.kind !== 'direct') return mux.close('pairing needs a direct connection')
            pairing = o.pairing.request(peer, mux, msg, from)
            return
          }
          // Checked again: it may have been removed while its link came up.
          const record = o.devices.allowed(peer.peerId, peer.peerSpki)
          if (!record) {
            log?.info(`refused ${peer.peerId} from ${from}: not paired`)
            return mux.close('this PC is not paired with the hub')
          }
          if (msg.t !== 'hello') return mux.close(`expected hello, got '${msg.t}'`)
          member = linked(record, mux, msg, via)
        },
        onOpen: guarded(() => (member ? { id: peer.peerId, name: o.devices.member(peer.peerId)?.name ?? peer.peerId } : null)),
        log: m => log?.debug(m),
      })
      const timer = setTimeout(() => mux.close(`no hello within ${seconds(helloMs)}`), helloMs)
      timer.unref()
      mux.on('close', () => {
        clearTimeout(timer)
        release()
      })
    },

    devices() {
      return o.devices.members().map((m): DeviceInfo => {
        const link = current(m.id)
        if (!link) {
          return {
            id: m.id,
            name: m.name,
            role: 'member',
            location: 'offline',
            path: null,
            rttMs: null,
            address: null,
            connectedSince: null,
            lastSeen: m.lastSeen,
            evidence: history.get(m.id) ?? ['No link yet: a member connects to the hub on its own'],
            canOpenScreen: false,
            canOpenAppScreen: false,
          }
        }
        return {
          id: m.id,
          name: m.name,
          role: 'member',
          location: link.location,
          path: link.path,
          rttMs: link.mux.rtt(),
          address: link.address,
          connectedSince: link.since,
          lastSeen: iso(link.mux.lastSeen()),
          evidence: [...link.evidence],
          canOpenScreen: link.hello.screen === true,
          canOpenAppScreen: link.hello.appScreen === true,
        }
      })
    },

    mux: id => current(id)?.mux ?? null,

    check(id) {
      const link = current(id)
      if (!link) {
        const record = o.devices.member(id)
        if (record) history.set(id, [...(history.get(id) ?? []), 'No link to check: a member connects to the hub on its own'].slice(-12))
        o.onChange()
        return false
      }
      link.mux.send({ t: 'check' })
      link.evidence = [...link.evidence, 'Asked it to check its link again']
      o.onChange()
      return true
    },

    remove(id) {
      const removed = o.devices.removeMember(id)
      for (const link of links.get(id) ?? []) link.mux.close('removed from the hub')
      links.delete(id)
      history.delete(id)
      lastIp.delete(id)
      if (removed) log?.info(`removed ${id}`)
      o.onChange()
      return removed
    },

    broadcast(msg) {
      for (const list of links.values()) for (const link of list) link.mux.send(msg)
    },

    knownIp: ip => [...lastIp.values()].includes(ip),

    stop(reason = 'the hub is stopping') {
      for (const list of [...links.values()]) for (const link of list) link.mux.close(reason)
      links.clear()
    },
  }
}
