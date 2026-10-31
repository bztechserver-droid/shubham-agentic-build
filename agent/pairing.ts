import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { JoinState, PairingCode, PairingRequest } from '../shared/agent-api.ts'
import { checkBundle, cleanName, type DeviceStore, type HubBundle, type MemberRecord } from './devices.ts'
import type { Identity } from './link/identity.ts'
import { createMux, type Control, type Mux } from './link/mux.ts'
import { NONCE_BYTES, sas, tlsClient, type PeerTls } from './link/tls.ts'
import type { Logger } from './log.ts'
import { parseHostPort } from './net.ts'
import { connectTcp } from './rendezvous/hbbs.ts'

// Pairing (agent/SPEC.md › Pairing). The hub shows a one-time code; the new PC opens TLS to
// the hub without a pin yet and sends the code with a commitment to a random nonce. The hub
// answers with its own nonce, the PC reveals its nonce, and both screens show a 6-digit check
// number made from that TLS session and the two nonces (link/tls.ts › sas). If anyone sits in
// between, the two sessions differ and so do the numbers; the commitment keeps anyone from
// steering them back together. Both people compare: the hub's approves, the PC's confirms, and
// only with both does the hub store the PC and hand over the details the PC pins.
//
//   PC → hub   pair-request {code, name, rustdeskId, version, commit: sha256(nm)}
//   hub → PC   pair-nonce {nonce: nh}                     (the hub shows nothing yet)
//   PC → hub   pair-reveal {nonce: nm}                    (the hub checks it against commit)
//   hub → PC   pair-wait {sas}                            (both screens show the number)
//   PC → hub   pair-confirm                               (its user said the numbers match)
//   hub → PC   pair-result {ok, hub | reason}             (approved and confirmed, or not)

/** Crockford base32: no I, L, O or U. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CODE_TTL_MS = 10 * 60_000
/** Requests a code takes, right or wrong: each right one is also a 1 in 10^6 chance at matching numbers. */
export const CODE_ATTEMPTS = 5
export const REQUEST_TTL_MS = 5 * 60_000
/** The PC reveals its nonce as soon as it has the hub's. */
export const REVEAL_MS = 10_000

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const withStatus = (status: number, text: string) => Object.assign(new Error(text), { status })
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest()
/** A nonce or commitment on the wire: 32 bytes as 64 lowercase hex digits; null for anything else. */
const bytes32 = (v: unknown): Buffer | null => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? Buffer.from(v, 'hex') : null)

/** 8 random Crockford characters: 40 bits, no bias (32 divides 256). */
export function newCode(): string {
  return Array.from(randomBytes(8), b => CODE_ALPHABET[b & 31]).join('')
}

/** A code as typed: upper case, without dashes or spaces, read the Crockford way (I and L are 1, O is 0). */
export function normalizeCode(typed: string): string {
  return typed.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
}

function sameCode(typed: string, code: string) {
  const a = Buffer.from(typed)
  const b = Buffer.from(code)
  return a.length === b.length && timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------------------
// The hub: "Add a PC"

export interface PairingHubOptions {
  devices: DeviceStore
  /** The hub's details for a new member; throws when it has none to give (no LAN yet). */
  bundle: () => HubBundle
  /** Where a new PC should connect, e.g. ["192.168.1.118:21220"]. */
  addresses: () => string[]
  onChange: () => void
  /** A member was approved, confirmed and stored. */
  onPaired?: (member: MemberRecord) => void
  log?: Logger
  /** Tests: shorter lifetimes. */
  timing?: Partial<{ codeTtlMs: number; requestTtlMs: number; revealMs: number }>
}

export interface PairingHub {
  /** A new code; it replaces the old one, whose waiting requests are turned away. */
  start(): PairingCode
  cancel(): void
  /** A code is open, so an unknown device may say pair-request. */
  active(): boolean
  state(): { code: PairingCode | null; requests: PairingRequest[] }
  /**
   * A TLS peer's first control message was pair-request: answer it, and keep the link while it
   * waits. Returns what to do with the PC's later messages on that link (its reveal, its confirm).
   */
  request(peer: PeerTls, mux: Mux, msg: Control, from: string): (msg: Control) => void
  /**
   * Approves on the hub. `member` is the stored PC when its user has confirmed the number too;
   * null while that is still to come (the PC is stored the moment it confirms).
   */
  approve(requestId: string): { deviceId: string; member: MemberRecord | null }
  reject(requestId: string): void
  stop(): void
}

interface Pending {
  request: PairingRequest
  peer: PeerTls
  mux: Mux
  rustdeskId: string | null
  /** sha256 of the PC's nonce, from its pair-request. */
  commit: Buffer
  /** The hub's own nonce, sent once the code was right. */
  nonce: Buffer
  /** The PC revealed a nonce that matches its commitment: the request is on screen. */
  shown: boolean
  /** Its deadline: the reveal, then an answer on the hub. */
  timer?: NodeJS.Timeout
}

export function createPairingHub(o: PairingHubOptions): PairingHub {
  const codeTtlMs = o.timing?.codeTtlMs ?? CODE_TTL_MS
  const requestTtlMs = o.timing?.requestTtlMs ?? REQUEST_TTL_MS
  const revealMs = o.timing?.revealMs ?? REVEAL_MS
  let code: { value: string; expiresAt: number; attemptsLeft: number } | null = null
  let expiry: NodeJS.Timeout | null = null
  const pending = new Map<string, Pending>()
  const log = o.log

  function clearCode() {
    code = null
    if (expiry) clearTimeout(expiry)
    expiry = null
  }

  /** Answers a waiting request, closes its link and forgets it. */
  function end(p: Pending, result: Control, why: string) {
    if (pending.get(p.request.requestId) !== p) return
    pending.delete(p.request.requestId)
    clearTimeout(p.timer)
    p.mux.send(result)
    p.mux.close(why)
    o.onChange()
  }

  const turnAway = (reason: string, why: string) => {
    for (const p of [...pending.values()]) end(p, { t: 'pair-result', ok: false, reason }, why)
  }

  function refuse(mux: Mux, result: Control, why: string) {
    mux.send(result)
    mux.close(why)
  }

  function state() {
    return {
      code: code && {
        code: code.value,
        expiresAt: new Date(code.expiresAt).toISOString(),
        attemptsLeft: code.attemptsLeft,
        hubAddresses: o.addresses(),
      },
      // A request shows only once its nonce is revealed: before that it has no number to check.
      requests: [...pending.values()].filter(p => p.shown).map(p => ({ ...p.request })),
    }
  }

  function wait(p: Pending, ms: number, result: Control, why: string) {
    clearTimeout(p.timer)
    p.timer = setTimeout(() => end(p, result, why), ms)
    p.timer.unref()
  }

  /** Approved here and confirmed there: store the PC, hand it the hub's details, spend the code. */
  function complete(p: Pending): MemberRecord {
    const bundle = o.bundle()
    const member = o.devices.addMember({
      id: p.request.deviceId,
      name: p.request.name,
      spkiSha256: p.peer.peerSpki.toString('hex'),
      rustdeskId: p.rustdeskId,
    })
    end(p, { t: 'pair-result', ok: true, hub: bundle }, 'paired')
    // One use: the code is spent, and anyone else who used it is turned away.
    clearCode()
    turnAway('code-used', 'the code was used by another PC')
    log?.info(`paired ${member.name} (${member.id})`)
    o.onPaired?.(member)
    o.onChange()
    return member
  }

  /** The PC's messages after its pair-request. */
  function later(p: Pending, msg: Control) {
    if (pending.get(p.request.requestId) !== p) return
    const { name, deviceId } = p.request
    if (msg.t === 'pair-reveal') {
      const nm = p.shown ? null : bytes32(msg.nonce)
      if (!nm || !timingSafeEqual(sha256(nm), p.commit)) {
        log?.warn(`pairing request from ${name} (${deviceId}): its nonce does not match what it committed to; turned away`)
        return end(p, { t: 'pair-result', ok: false, reason: 'bad-reveal' }, 'the nonce did not match its commitment')
      }
      p.request.sas = sas(p.peer.tls, nm, p.nonce)
      p.shown = true
      wait(p, requestTtlMs, { t: 'pair-result', ok: false, reason: 'timeout' }, 'nobody approved within 5 minutes')
      p.mux.send({ t: 'pair-wait', sas: p.request.sas })
      log?.info(`pairing request from ${name} (${deviceId}) at ${p.request.from}; check number shown`)
      return o.onChange()
    }
    if (msg.t === 'pair-confirm') {
      if (!p.shown) return end(p, { t: 'pair-result', ok: false, reason: 'bad-reveal' }, 'confirmed before any number was shown')
      if (p.request.confirmed) return
      p.request.confirmed = true
      log?.info(`${name} (${deviceId}) says its check number matches`)
      if (p.request.approved) {
        try {
          complete(p)
        } catch (e) {
          // Not lost: the request is back to waiting for Approve, which will say what went wrong.
          p.request.approved = false
          log?.error(`could not finish pairing ${name} (${deviceId}): ${message(e)}`)
        }
      }
      return o.onChange()
    }
  }

  const ignore = () => {}

  return {
    start() {
      clearCode()
      turnAway('cancelled', 'a new pairing code replaced this one')
      const fresh = { value: newCode(), expiresAt: Date.now() + codeTtlMs, attemptsLeft: CODE_ATTEMPTS }
      code = fresh
      expiry = setTimeout(() => {
        if (code !== fresh) return
        clearCode()
        log?.info('the pairing code expired')
        o.onChange()
      }, codeTtlMs)
      expiry.unref()
      log?.info(`pairing code open for ${codeTtlMs / 60_000} minutes`)
      o.onChange()
      return state().code as PairingCode
    },

    cancel() {
      clearCode()
      turnAway('cancelled', 'pairing cancelled on the hub')
      o.onChange()
    },

    active: () => code !== null && Date.now() < code.expiresAt,

    state,

    request(peer, mux, msg, from) {
      if (!code || Date.now() >= code.expiresAt) {
        log?.info(`pair-request from ${from} (${peer.peerId}) with no code open`)
        refuse(mux, { t: 'pair-result', ok: false, reason: 'no-code' }, 'no pairing code is open')
        return ignore
      }
      // Every request costs a try, right code or wrong: a right one is also a chance at a
      // matching check number, so nobody gets more than 5 of those per code.
      code.attemptsLeft--
      const attemptsLeft = code.attemptsLeft
      const right = sameCode(typeof msg.code === 'string' ? normalizeCode(msg.code) : '', code.value)
      // Used up: nobody may try again. A right request still goes on.
      if (attemptsLeft <= 0) clearCode()
      if (!right) {
        log?.warn(`wrong pairing code from ${from} (${peer.peerId}); ${attemptsLeft} tries left`)
        refuse(mux, { t: 'pair-result', ok: false, reason: 'bad-code', attemptsLeft }, 'wrong pairing code')
        o.onChange()
        return ignore
      }
      const commit = bytes32(msg.commit)
      if (!commit) {
        log?.warn(`a pair-request from ${from} (${peer.peerId}) without a usable commitment`)
        refuse(mux, { t: 'pair-result', ok: false, reason: 'bad-request' }, 'a pair-request without a commitment')
        o.onChange()
        return ignore
      }
      // The same PC asking again (a retry after a dropped link) replaces its earlier request.
      for (const p of [...pending.values()]) {
        if (p.request.deviceId === peer.peerId) end(p, { t: 'pair-result', ok: false, reason: 'replaced' }, 'replaced by a newer request')
      }
      // One PC per code at a time. Another PC with the same code means someone else knows it
      // (perhaps sitting between this PC and the hub): cancel it, and say so.
      if (pending.size > 0) {
        const earlier = [...pending.values()].map(p => `${p.request.name} (${p.request.deviceId}) from ${p.request.from}`).join(', ')
        log?.warn(`two PCs used the pairing code at once: ${earlier}, then ${peer.peerId} from ${from}. Cancelled the code: someone else may have seen it`)
        clearCode()
        turnAway('conflict', 'two PCs used the same code at once')
        refuse(mux, { t: 'pair-result', ok: false, reason: 'conflict' }, 'two PCs used the same code at once')
        o.onChange()
        return ignore
      }
      const request: PairingRequest = {
        requestId: randomUUID(),
        name: cleanName(msg.name, `PC ${peer.peerId.slice(0, 4)}`),
        deviceId: peer.peerId,
        sas: '',
        from,
        receivedAt: new Date().toISOString(),
        approved: false,
        confirmed: false,
      }
      const p: Pending = {
        request,
        peer,
        mux,
        rustdeskId: typeof msg.rustdeskId === 'string' && msg.rustdeskId.length <= 32 ? msg.rustdeskId : null,
        commit,
        nonce: randomBytes(NONCE_BYTES),
        shown: false,
      }
      pending.set(request.requestId, p)
      wait(p, revealMs, { t: 'pair-result', ok: false, reason: 'bad-reveal' }, `no nonce within ${revealMs / 1000} s`)
      // The new PC went away (cancelled, closed, said the numbers differ): its request goes too.
      mux.on('close', reason => {
        if (pending.get(request.requestId) !== p) return
        pending.delete(request.requestId)
        clearTimeout(p.timer)
        log?.info(`pairing request from ${request.name} (${request.deviceId}) ended: ${reason}`)
        o.onChange()
      })
      mux.send({ t: 'pair-nonce', nonce: p.nonce.toString('hex') })
      log?.info(`pairing request from ${request.name} (${peer.peerId}) at ${from}; waiting for its nonce`)
      o.onChange()
      return next => later(p, next)
    },

    approve(requestId) {
      const p = pending.get(requestId)
      if (!p || !p.shown) throw withStatus(404, 'That request is no longer waiting')
      const deviceId = p.request.deviceId
      if (p.request.confirmed) return { deviceId, member: complete(p) }
      // Fails now, while someone is looking, if the hub has nothing to hand over (no LAN yet).
      o.bundle()
      p.request.approved = true
      log?.info(`approved ${p.request.name} (${deviceId}) on the hub; waiting for it to confirm the number`)
      o.onChange()
      return { deviceId, member: null }
    },

    reject(requestId) {
      const p = pending.get(requestId)
      if (!p || !p.shown) throw withStatus(404, 'That request is no longer waiting')
      log?.info(`rejected the pairing request from ${p.request.name} (${p.request.deviceId})`)
      end(p, { t: 'pair-result', ok: false, reason: 'rejected' }, 'rejected on the hub')
    },

    stop() {
      clearCode()
      turnAway('cancelled', 'the hub is stopping')
    },
  }
}

// ---------------------------------------------------------------------------------------
// A member: "Join a hub"

export interface JoinOptions {
  /** 'host:port' of the hub's TLS listener, from discovery or typed. */
  hubAddress: string
  /** The hub's ID when it was picked from discovery: another PC at that address is refused before it hears the code. */
  hubId?: string | null
  code: string
  identity: Pick<Identity, 'keyPem' | 'certPem'>
  name: string
  rustdeskId: string | null
  version: string
  onState: (state: JoinState) => void
  /** The approved hub's details, already checked against its certificate: pin and store them. */
  onPaired: (bundle: HubBundle) => void
  log?: Logger
  /** Tests: shorter waits. */
  timing?: Partial<{ connectMs: number; tlsMs: number; waitMs: number }>
}

export interface Join {
  /**
   * This PC's user compared the check numbers (status 'confirm'). True tells the hub, which
   * stores this PC once it is approved there too; false ends the join. Throws (409) otherwise.
   */
  confirm(match: boolean): JoinState
  /** Stops waiting; the hub drops the request. */
  cancel(): void
  /** Settles with the final state: paired, failed, or idle after cancel(). */
  done: Promise<JoinState>
}

/** Why the hub said no, in words for the Join dialog. */
function refusal(msg: Control): string {
  const left = typeof msg.attemptsLeft === 'number' ? msg.attemptsLeft : null
  switch (msg.reason) {
    case 'bad-code':
      return left
        ? `The hub turned the code down. Check it and try again (${left} ${left === 1 ? 'try' : 'tries'} left).`
        : 'The hub turned the code down, and that code has no tries left. Choose Add a PC on the hub for a new one.'
    case 'no-code':
      return 'The hub has no code open. Choose Add a PC on the hub first.'
    case 'rejected':
      return 'The hub said no.'
    case 'timeout':
      return 'Nobody approved this PC on the hub within 5 minutes.'
    case 'code-used':
      return 'Another PC used that code first.'
    case 'cancelled':
      return 'The hub stopped adding PCs.'
    case 'replaced':
      return 'This PC asked again; the hub kept the newer request.'
    case 'conflict':
      return 'Another PC used the same code at the same time, so the hub cancelled it: someone else may have seen it. Choose Add a PC on the hub for a new code.'
    case 'bad-request':
    case 'bad-reveal':
      return 'The pairing exchange with the hub went wrong, so nothing was paired. Try again.'
    default:
      return `The hub refused: ${typeof msg.reason === 'string' ? msg.reason.slice(0, 100) : 'no reason given'}`
  }
}

export function startJoin(o: JoinOptions): Join {
  const connectMs = o.timing?.connectMs ?? 5000
  const tlsMs = o.timing?.tlsMs ?? 10_000
  // The hub waits 5 minutes for an answer; give it a little more.
  const waitMs = o.timing?.waitMs ?? REQUEST_TTL_MS + 60_000
  const log = o.log
  let state: JoinState = { status: 'connecting', hubAddress: o.hubAddress, sas: null, error: null }
  let finished = false
  let mux: Mux | null = null
  let raw: { destroy(): void } | null = null
  let settle: (s: JoinState) => void = () => {}
  const done = new Promise<JoinState>(resolve => (settle = resolve))
  // Ours, hidden behind its hash until the hub has sent its own: then neither can pick theirs to suit.
  const nonce = randomBytes(NONCE_BYTES)
  let hubNonce: Buffer | null = null
  let mine: string | null = null
  let confirmed = false

  const set = (patch: Partial<JoinState>) => {
    state = { ...state, ...patch }
    o.onState({ ...state })
  }

  function finish(patch: Partial<JoinState>, why: string) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    if (mux) mux.close(why)
    else raw?.destroy()
    set(patch)
    settle({ ...state })
  }
  const fail = (error: string, why = 'join failed') => {
    log?.warn(`join ${o.hubAddress}: ${error}`)
    finish({ status: 'failed', error }, why)
  }

  const timer = setTimeout(() => fail('No answer from the hub in time.'), waitMs)
  timer.unref()

  function onMessage(msg: Control, peer: PeerTls, link: Mux) {
    if (finished) return
    if (msg.t === 'pair-nonce') {
      const theirs = bytes32(msg.nonce)
      if (!theirs || hubNonce) return fail('The hub broke the pairing exchange, so nothing was paired.')
      hubNonce = theirs
      mine = sas(peer.tls, nonce, theirs)
      link.send({ t: 'pair-reveal', nonce: nonce.toString('hex') })
      return
    }
    if (msg.t === 'pair-wait') {
      // This PC shows the number from its own session and nonces, never the hub's word for it.
      if (!mine || state.status !== 'connecting') return fail('The hub broke the pairing exchange, so nothing was paired.')
      if (msg.sas !== mine) {
        return fail('The check numbers differ between this PC and the hub, so someone may be in between. Nothing was paired.')
      }
      log?.info(`join ${o.hubAddress}: check number shown; waiting for this PC's user to compare it with the hub's`)
      return set({ status: 'confirm', sas: mine })
    }
    if (msg.t !== 'pair-result') return
    if (msg.ok !== true) return fail(refusal(msg))
    // Only once this PC's own user has said the numbers match: a "hub" that approves by itself
    // could be anyone answering at that address.
    if (!confirmed) return fail('The hub answered before you had checked the number, so nothing was paired.')
    let bundle: HubBundle
    try {
      bundle = checkBundle(msg.hub)
    } catch (e) {
      return fail(message(e))
    }
    if (bundle.id !== peer.peerId || bundle.spkiSha256 !== peer.peerSpki.toString('hex') || (o.hubId && bundle.id !== o.hubId)) {
      return fail("The hub's details do not match its certificate. Nothing was paired.")
    }
    try {
      o.onPaired(bundle)
    } catch (e) {
      return fail(`Could not save the hub: ${message(e)}`)
    }
    log?.info(`joined hub ${bundle.name} (${bundle.id})`)
    finish({ status: 'paired', error: null }, 'paired')
  }

  async function run() {
    if (!parseHostPort(o.hubAddress)) throw new Error(`"${o.hubAddress}" is not a host:port address`)
    let socket
    try {
      socket = await connectTcp(o.hubAddress, connectMs)
    } catch (e) {
      throw new Error(`Could not reach the hub at ${o.hubAddress}: ${message(e)}`, { cause: e })
    }
    if (finished) return void socket.destroy()
    raw = socket
    // Nothing is pinned yet, so any hub will do, unless one was picked from discovery: then a
    // PC answering with another key never hears the code. The check number is the real proof.
    let wrongHub: string | null = null
    const expected = (id: string) => {
      if (!o.hubId || id === o.hubId) return true
      wrongHub = id
      return false
    }
    let peer: PeerTls
    try {
      peer = await tlsClient(socket, o.identity, expected, tlsMs)
    } catch (e) {
      if (wrongHub) {
        throw new Error(`The PC at ${o.hubAddress} answered as ${wrongHub}, not the hub you picked (${o.hubId}). Nothing was sent to it.`, { cause: e })
      }
      throw e
    }
    if (finished) return void peer.tls.destroy()
    const link = createMux(peer.tls, {
      onControl: msg => onMessage(msg, peer, link),
      log: m => log?.debug(`join: ${m}`),
    })
    mux = link
    // With no code open the hub turns unknown PCs away before reading anything.
    link.on('close', reason =>
      fail(/not paired with the hub/.test(reason) ? refusal({ t: 'pair-result', reason: 'no-code' }) : `The hub closed the connection (${reason}).`),
    )
    link.send({
      t: 'pair-request',
      code: normalizeCode(o.code),
      name: o.name,
      rustdeskId: o.rustdeskId,
      version: o.version,
      commit: sha256(nonce).toString('hex'),
    })
  }

  o.onState({ ...state })
  run().catch(e => fail(message(e)))

  return {
    confirm(match) {
      if (finished || state.status !== 'confirm') throw withStatus(409, 'This PC is not waiting for you to check a number')
      if (!match) {
        fail(
          'You said the hub shows a different number, so someone may be in between. Nothing was paired. Start again, and check the hub address on its Add a PC screen.',
          'the check numbers differ on this PC',
        )
        return { ...state }
      }
      confirmed = true
      mux?.send({ t: 'pair-confirm' })
      log?.info(`join ${o.hubAddress}: the numbers match on this PC; waiting for the hub to approve`)
      set({ status: 'waiting-approval' })
      return { ...state }
    },
    cancel: () => finish({ status: 'idle', hubAddress: null, sas: null, error: null }, 'cancelled on this PC'),
    done,
  }
}
