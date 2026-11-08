import { createHash, randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { SBSKRRT_ID } from '../shared/auth.ts'
import type { BuildInfo } from '../shared/build.ts'
import { PC_BUILD_STREAM, type PcBuildStatus, type PcBuildActor, type PcBuildPeerRequest, type PcBuildPrepare, type PcBuildReply, type PcBuildErrorCode, type PcBuildUpdateResult } from '../shared/pc-build.ts'
import type { ApiMount, MountRequest } from './api.ts'

export interface BuildControl {
  info(): BuildInfo
  check(): Promise<BuildInfo>
  requestUpdate(): BuildInfo & { restarting: boolean }
  busy(): number
}
export interface PcBuildPeer { generation: object; open(): Promise<Duplex> }
export interface PcBuildOptions {
  selfId: string
  role(): 'hub' | 'member'
  hubId(): string | null
  hubOrigin(): string | null
  generation(): object | null
  peer(id: string): PcBuildPeer | null
  build: BuildControl | null
  now?: () => number
  token?: () => string
  timeoutMs?: number
}
const MAX_BYTES = 16_384
const TTL_MS = 60_000
const ID = /^[a-z0-9]{16}$/
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k))
function releaseFingerprint(value: unknown): string {
  const stable = (v: unknown): string => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : obj(v) ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v) ?? 'null'
  return createHash('sha256').update(stable(value)).digest('hex')
}
const fail = (status: number, code: PcBuildErrorCode, message: string) => Object.assign(new Error(message), { status, code })
function admin(actor: unknown): asserts actor is PcBuildActor {
  if (!obj(actor) || !keys(actor, ['id', 'sid']) || actor.id !== SBSKRRT_ID || typeof actor.sid !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(actor.sid)) throw fail(403, 'admin-required', 'Sign in as sbskrrt on Server.')
}
function parse(raw: unknown, target: string): PcBuildPeerRequest {
  if (!obj(raw) || !keys(raw, ['protocol', 'targetId', 'actor', 'action', 'update']) || raw.protocol !== 1 || raw.targetId !== target || !['status', 'check', 'prepare-update', 'update'].includes(String(raw.action))) throw fail(400, 'invalid-request', 'Invalid PC build request.')
  admin(raw.actor)
  if (raw.action === 'update') {
    const u = raw.update
    if (!obj(u) || !keys(u, ['confirmed', 'confirmationToken', 'expectedCurrent', 'expectedAvailable']) || u.confirmed !== true || typeof u.confirmationToken !== 'string' || !/^[a-f0-9]{64}$/.test(u.confirmationToken) || typeof u.expectedCurrent !== 'string' || u.expectedCurrent.length > 80 || typeof u.expectedAvailable !== 'string' || u.expectedAvailable.length > 80) throw fail(409, 'confirmation-required', 'Explicit target/version confirmation is required; force is not accepted.')
  } else if (raw.update !== undefined) throw fail(400, 'invalid-request', 'Unexpected update payload.')
  return raw as unknown as PcBuildPeerRequest
}
function cleanReply(raw: unknown, req: PcBuildPeerRequest): PcBuildReply {
  const invalid = () => fail(426, 'peer-unsupported', 'The target returned an invalid build capability response.')
  const version = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_.+-]{1,80}$/.test(v)
  const cleanStatus = (v: unknown): PcBuildStatus => {
    const fields = ['protocol','pcId','connection','capability','runningVersion','availableVersion','updateState','canCheck','canUpdate','reason','hostBusy','waitingForIdle','transition']
    if (!obj(v) || !keys(v, fields) || Object.keys(v).length !== fields.length || v.protocol !== 1 || v.pcId !== req.targetId || v.connection !== 'online' || ![null,'pc-build-v1'].includes(v.capability as string | null) || !(v.runningVersion === null || version(v.runningVersion)) || !(v.availableVersion === null || version(v.availableVersion)) || !['unknown','checking','up-to-date','available','failed'].includes(String(v.updateState)) || typeof v.canCheck !== 'boolean' || typeof v.canUpdate !== 'boolean' || !(v.reason === null || typeof v.reason === 'string') || !Number.isSafeInteger(v.hostBusy) || Number(v.hostBusy) < 0 || typeof v.waitingForIdle !== 'boolean' || !['idle','waiting-for-idle','restarting'].includes(String(v.transition))) throw invalid()
    // Never relay arbitrary target diagnostics, paths or provider text.
    return { ...v, reason: v.reason === null ? null : 'Build controls unavailable or an update is already pending.' } as unknown as PcBuildStatus
  }
  if (req.action === 'status' || req.action === 'check') return cleanStatus(raw)
  if (!obj(raw) || raw.protocol !== 1 || raw.pcId !== req.targetId) throw invalid()
  const status = cleanStatus(raw.status)
  if (req.action === 'prepare-update') {
    if (!keys(raw,['protocol','pcId','confirmationToken','expiresAt','expectedCurrent','expectedAvailable','status']) || typeof raw.confirmationToken !== 'string' || !/^[a-f0-9]{64}$/.test(raw.confirmationToken) || typeof raw.expiresAt !== 'string' || !Number.isFinite(Date.parse(raw.expiresAt)) || raw.expectedCurrent !== status.runningVersion || raw.expectedAvailable !== status.availableVersion) throw invalid()
    return { protocol:1, pcId:req.targetId, confirmationToken:raw.confirmationToken, expiresAt:raw.expiresAt, expectedCurrent:raw.expectedCurrent, expectedAvailable:raw.expectedAvailable, status } as PcBuildPrepare
  }
  if (!keys(raw,['protocol','pcId','outcome','status']) || !['restarting','waiting-for-idle'].includes(String(raw.outcome))) throw invalid()
  return { protocol:1, pcId:req.targetId, outcome:raw.outcome, status } as PcBuildUpdateResult
}
export function safeHubOrigin(name: string | null | undefined): string | null {
  const host = name?.replace(/\.$/, '').toLowerCase()
  return host && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(host) ? `https://${host}:5173` : null
}
export function createPcBuild(o: PcBuildOptions) {
  const now = o.now ?? Date.now
  const token = o.token ?? (() => randomBytes(32).toString('hex'))
  const selfGeneration = {}
  let requested = false
  const confirmations = new Map<string, { actor: string; sid: string; current: string; available: string; currentFingerprint: string; availableFingerprint: string; generation: object; expires: number }>()
  function status(): PcBuildStatus {
    const b = o.build?.info()
    const waiting = !!b?.update.hostWait
    return { protocol: 1, pcId: o.selfId, connection: 'online', capability: o.build ? 'pc-build-v1' : null, runningVersion: b?.current?.version ?? null, availableVersion: b?.update.available?.version ?? null, updateState: b?.update.state ?? 'unknown', canCheck: b?.kind === 'build', canUpdate: !!(o.build && b?.update.can && b.current && b.update.available && !requested && !waiting), reason: !o.build ? 'Build controls are unavailable.' : !b?.update.can ? 'This installed build cannot update itself.' : requested ? 'An update was already requested; refresh status, do not resend.' : null, hostBusy: Math.max(0, o.build?.busy() ?? 0), waitingForIdle: waiting, transition: waiting ? 'waiting-for-idle' : requested ? 'restarting' : 'idle' }
  }
  async function perform(raw: unknown, generation: object, alive: () => boolean): Promise<PcBuildReply> {
    const req = parse(raw, o.selfId)
    if (!alive()) throw fail(409, 'confirmation-stale', 'The PC connection changed; refresh status.')
    if (!o.build) throw fail(426, 'peer-unsupported', 'This PC does not support remote build controls.')
    if (req.action === 'status') return status()
    if (req.action === 'check') { await o.build.check(); if (!alive()) throw fail(409, 'confirmation-stale', 'Connection changed during check.'); return status() }
    const s = status()
    if (!s.canUpdate || !s.runningVersion || !s.availableVersion) throw fail(409, 'update-unavailable', 'No confirmed update is currently available.')
    const release = o.build.info()
    const currentFingerprint = releaseFingerprint(release.current)
    const availableFingerprint = releaseFingerprint(release.update.available)
    if (req.action === 'prepare-update') {
      for (const [key, value] of confirmations) if (value.expires <= now()) confirmations.delete(key)
      if (confirmations.size >= 256) throw fail(409, 'confirmation-required', 'Too many pending confirmations; wait for expiry.')
      const nonce = token()
      const expires = now() + TTL_MS
      confirmations.set(nonce, { actor: req.actor.id, sid: req.actor.sid, current: s.runningVersion, available: s.availableVersion, currentFingerprint, availableFingerprint, generation, expires })
      return { protocol: 1, pcId: o.selfId, confirmationToken: nonce, expiresAt: new Date(expires).toISOString(), expectedCurrent: s.runningVersion, expectedAvailable: s.availableVersion, status: s } satisfies PcBuildPrepare
    }
    const u = req.update!
    const c = confirmations.get(u.confirmationToken)
    if (!c) throw fail(409, 'confirmation-required', 'Confirmation is absent or already used.')
    // A failed attempt consumes the challenge too; never permit guessing/replaying it.
    confirmations.delete(u.confirmationToken)
    if (c.expires <= now()) throw fail(409, 'confirmation-expired', 'Confirmation expired; prepare again.')
    if (c.actor !== req.actor.id || c.sid !== req.actor.sid || c.generation !== generation || c.current !== u.expectedCurrent || c.available !== u.expectedAvailable || c.current !== s.runningVersion || c.available !== s.availableVersion || c.currentFingerprint !== currentFingerprint || c.availableFingerprint !== availableFingerprint || !alive()) throw fail(409, 'confirmation-stale', 'Session, connection or offered build changed; prepare again.')
    requested = true
    try {
      const result = o.build.requestUpdate() // No body/force forwarded. Existing host-busy gate decides.
      return { protocol: 1, pcId: o.selfId, outcome: result.restarting ? 'restarting' : 'waiting-for-idle', status: status() } satisfies PcBuildUpdateResult
    } catch {
      // Once committed, never infer that retrying is safe from a transport/target failure.
      throw fail(504, 'update-result-unknown', 'Update outcome is unknown. Refresh PC status; do not resend.')
    }
  }
  const local = (raw: unknown) => perform(raw, selfGeneration, () => true)
  function serve(meta: Record<string, unknown>): (stream: Duplex) => void {
    const from = meta.from
    const generation = o.generation()
    if (o.role() !== 'member' || !obj(from) || from.id !== o.hubId() || !generation) throw fail(403, 'admin-required', 'Only the currently pinned hub may forward a build operation.')
    const hub = o.hubId()
    return stream => receive(stream, raw => perform(raw, generation, () => o.hubId() === hub && o.generation() === generation))
  }
  async function remote(id: string, req: PcBuildPeerRequest): Promise<PcBuildReply> {
    if (id === o.selfId) return local(req)
    const peer = o.peer(id)
    if (!peer) throw fail(503, 'target-offline', 'This PC is offline. Refresh when it reconnects.')
    let stream: Duplex
    try { stream = await peer.open() } catch { throw fail(426, 'peer-unsupported', 'The PC has no compatible remote build capability; update it locally.') }
    try {
      const reply = await exchange(stream, req, o.timeoutMs ?? 15_000)
      if (o.peer(id)?.generation !== peer.generation) throw fail(409, 'confirmation-stale', 'The PC reconnected; refresh status.')
      if (!obj(reply) || reply.protocol !== 1 || reply.pcId !== id) throw fail(426, 'peer-unsupported', 'Invalid PC build capability response.')
      return cleanReply(reply, req)
    } catch (e) {
      if (obj(e) && e.refused === true) throw e
      if (req.action === 'update') throw fail(504, 'update-result-unknown', 'Update outcome is unknown. Refresh status; do not resend.')
      if (obj(e) && typeof e.status === 'number') throw e
      throw fail(503, 'target-offline', 'PC response unavailable; refresh when it reconnects.')
    } finally { stream.destroy() }
  }
  const mount: ApiMount = {
    prefix: '/pc-control', scoped: true,
    async http(r: MountRequest) {
      const actor = { id: r.caller?.person?.id, sid: r.caller?.sid }
      admin(actor) // No machine/open-app/username shortcut.
      if (o.role() !== 'hub') throw Object.assign(fail(409, 'hub-sign-in-required', 'Sign in on Server to manage updates for this PC.'), { hubOrigin: o.hubOrigin() })
      const match = /^\/pcs\/([a-z0-9]{16})\/build(?:\/(check|update\/prepare|update))?$/.exec(r.rest)
      if (!match || !ID.test(match[1])) throw fail(404, 'invalid-request', 'No PC build operation at this path.')
      const action = !match[2] ? 'status' : match[2] === 'check' ? 'check' : match[2] === 'update/prepare' ? 'prepare-update' : 'update'
      if (r.method !== (action === 'status' ? 'GET' : 'POST') || r.query.toString()) throw fail(400, 'invalid-request', 'Invalid method or query for PC build operation.')
      if (action !== 'status' && action !== 'update' && (!obj(r.body) || Object.keys(r.body).length)) throw fail(400, 'invalid-request', 'This operation takes an empty JSON object.')
      const req = parse({ protocol: 1, targetId: match[1], actor, action, ...(action === 'update' ? { update: r.body } : {}) }, match[1])
      try { return await remote(match[1], req) }
      catch (e) {
        if (action === 'status' && obj(e) && ['target-offline', 'peer-unsupported'].includes(String(e.code))) return { protocol: 1, pcId: match[1], connection: e.code === 'target-offline' ? 'offline' : 'unsupported', capability: null, runningVersion: null, availableVersion: null, updateState: 'unknown', canCheck: false, canUpdate: false, reason: e.code === 'target-offline' ? 'PC is offline.' : 'Remote build controls are unsupported.', hostBusy: 0, waitingForIdle: false, transition: 'idle' } satisfies PcBuildStatus
        throw e
      }
    },
  }
  return { mount, serve, local, status }
}
function receive(stream: Duplex, work: (raw: unknown) => Promise<PcBuildReply>) {
  let data = '', used = false
  const timer = setTimeout(() => stream.destroy(), 15_000); timer.unref()
  stream.setEncoding('utf8')
  stream.on('error', () => {})
  stream.on('close', () => clearTimeout(timer))
  stream.on('data', (chunk: string) => {
    if (used) return
    data += chunk
    if (Buffer.byteLength(data) > MAX_BYTES) { used = true; stream.destroy(); return }
    const i = data.indexOf('\n')
    if (i < 0) return
    used = true
    let raw: unknown
    try { raw = JSON.parse(data.slice(0, i)) } catch { stream.end(JSON.stringify({ ok: false, status: 400, code: 'invalid-request', error: 'Invalid JSON.' }) + '\n'); return }
    void work(raw).then(value => stream.end(JSON.stringify({ ok: true, value }) + '\n'), e => stream.end(JSON.stringify({ ok: false, status: obj(e) && typeof e.status === 'number' ? e.status : 500, code: obj(e) && typeof e.code === 'string' ? e.code : 'target-error', error: 'PC build operation refused.' }) + '\n'))
  })
}
function exchange(stream: Duplex, req: PcBuildPeerRequest, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '', done = false
    const finish = (error?: Error, value?: unknown) => { if (done) return; done = true; clearTimeout(timer); if (error) reject(error); else resolve(value) }
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs); timer.unref()
    stream.setEncoding('utf8')
    stream.on('error', () => finish(new Error('transport failed')))
    stream.on('end', () => { if (!done) finish(new Error('incomplete response')) })
    stream.on('close', () => { if (!done) finish(new Error('connection closed')) })
    stream.on('data', (chunk: string) => {
      data += chunk
      if (Buffer.byteLength(data) > MAX_BYTES) { finish(new Error('oversized response')); stream.destroy(); return }
      const i = data.indexOf('\n'); if (i < 0) return
      try {
        const raw: unknown = JSON.parse(data.slice(0, i))
        const codes = ['admin-required','invalid-request','confirmation-required','confirmation-expired','confirmation-stale','update-unavailable','update-result-unknown','peer-unsupported','target-error']
        if (obj(raw) && raw.ok === true && keys(raw,['ok','value'])) finish(undefined, raw.value)
        else if (obj(raw) && raw.ok === false && keys(raw,['ok','status','code','error']) && [400,401,403,409,426,503,504].includes(Number(raw.status)) && codes.includes(String(raw.code))) finish(Object.assign(fail(Number(raw.status), raw.code as PcBuildErrorCode, 'PC build operation refused.'), { refused:true }))
        else finish(new Error('invalid response envelope'))
      } catch { finish(new Error('invalid response')) }
    })
    stream.end(JSON.stringify(req) + '\n')
  })
}
export { PC_BUILD_STREAM }
