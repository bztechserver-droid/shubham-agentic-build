import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'

import type { DeliveryReceipt, DeliveryState } from '../../shared/chat.ts'
import { cleanDeliveryDiagnostic, isDeliveryBlockReason, type DeliveryBlockReason, type DeliveryDiagnostic } from '../../shared/delivery-reason.ts'
interface Record extends DeliveryReceipt {
  owner: string
  floorId: string
  agentId: string
  digest: string
}
/** What a send reports about how it ended; cut down to the safe shape (codes and milliseconds only) before it is kept. */
export type DeliveryNote = { cause: unknown; marks: unknown }
interface Intent {
  id?: string
  owner: string
  floorId: string
  agentId: string
  text: string
  expectedSessionId?: string | null
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const STATES = new Set<DeliveryState>(['pending', 'sent', 'blocked', 'unconfirmed', 'gone'])
const receipt = ({ id, state, sessionId, generation, started, updatedAt, reason, targetPcName, diag }: Record): DeliveryReceipt => ({ id, state, sessionId, generation, started, updatedAt, ...(reason ? { reason } : {}), ...(targetPcName ? { targetPcName } : {}), ...(diag ? { diag } : {}) })

/** IDs are durable tombstones, not a replay queue. Text and credentials are never persisted. */
export function createDeliveryReceipts(file: string, options: { now?: () => number; capacity?: number; onFinal?: (receipt: DeliveryReceipt, diag: DeliveryDiagnostic | undefined) => void } = {}) {
  const now = options.now ?? Date.now
  const records = new Map<string, Record>()
  const running = new Map<string, Promise<void>>()
  let unavailable = false
  let closed = false
  const stamp = () => new Date(now()).toISOString()
  const save = () => { if (closed) throw Error('Receipt store closed'); writeAtomic(file, JSON.stringify({ version: 1, records: [...records.values()] }) + '\n') }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { version: unknown; records: Record[] }
    if (raw.version !== 1 || !Array.isArray(raw.records)) throw Error('Invalid receipt store')
    for (const r of raw.records) {
      if (!r || !UUID.test(r.id) || records.has(r.id) || !STATES.has(r.state) || typeof r.owner !== 'string' || typeof r.floorId !== 'string' || typeof r.agentId !== 'string' || !/^[0-9a-f]{64}$/.test(r.digest) || !(r.sessionId === null || typeof r.sessionId === 'string') || !(r.generation === null || typeof r.generation === 'string') || typeof r.started !== 'boolean' || typeof r.updatedAt !== 'string') throw Error('Invalid receipt record')
      if (r.reason !== undefined && !isDeliveryBlockReason(r.reason) || r.targetPcName !== undefined && (typeof r.targetPcName !== 'string' || r.targetPcName.length > 120)) throw Error('Invalid delivery diagnostic')
      // A diagnostic that is not exactly the safe shape is dropped, never a reason to refuse the store.
      const diag = cleanDeliveryDiagnostic(r.diag)
      const { diag: _kept, ...rest } = r
      // A crash or restart cannot say how a pending send ended: the cause is the restart itself.
      records.set(r.id, { ...rest, ...(r.state === 'pending' ? { state: 'unconfirmed' as const, updatedAt: stamp(), diag: { cause: 'agent-restarted' as const, marks: [] } } : diag ? { diag } : {}) })
    }
    // A crash cannot prove whether Enter/HTTP commit happened. Never start it again.
    save()
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') unavailable = true
  }
  const available = () => { if (unavailable || closed) throw apiError(503, 'Delivery receipts are unavailable. Nothing new was sent; do not retry an earlier uncertain message.') }
  const lookup = (id: string, owner: string, floorId: string, agentId: string) => {
    available()
    const r = records.get(id.toLowerCase())
    return r && r.owner === owner && r.floorId === floorId && r.agentId === agentId ? receipt(r) : null
  }
  return {
    lookup,
    /**
     * How many sends are pending right now, read-only and synchronous. null when that cannot be known (the store is unavailable or
     * closed): a caller that gates on "nothing pending" must treat null as "not safe to assume zero".
     */
    pendingCount(): number | null {
      if (unavailable || closed) return null
      let n = 0
      for (const r of records.values()) if (r.state === 'pending') n++
      return n
    },
    close() {
      if (closed) return
      for (const r of records.values()) if (r.state === 'pending') { r.state = 'unconfirmed'; r.updatedAt = stamp(); r.diag = { cause: 'agent-closing', marks: [] } }
      try { if (!unavailable) save() } catch { unavailable = true } finally { closed = true }
    },
    begin(intent: Intent, send: (bind: (sid: string, generation: string, started: boolean) => void, blocked: (reason: DeliveryBlockReason, targetPcName?: string) => 'blocked', note: (how: DeliveryNote) => void) => Promise<Exclude<DeliveryState, 'pending'>>) {
      available()
      const id = intent.id ?? randomUUID()
      if (!UUID.test(id)) throw apiError(400, 'messageId must be a UUID')
      const key = id.toLowerCase()
      const digest = createHash('sha256').update(JSON.stringify([intent.text, intent.expectedSessionId === undefined ? ['unspecified'] : intent.expectedSessionId])).digest('hex')
      const existing = records.get(key)
      if (existing) {
        if (existing.owner !== intent.owner || existing.floorId !== intent.floorId || existing.agentId !== intent.agentId || existing.digest !== digest) throw Object.assign(apiError(409, 'That message ID already belongs to a different send. Nothing was pasted.'), { code: 'delivery-id-conflict' })
        return receipt(existing)
      }
      if (records.size >= (options.capacity ?? 10_000)) throw apiError(503, 'Delivery receipt storage is full. Nothing new was sent.')
      const r: Record = { id: key, owner: intent.owner, floorId: intent.floorId, agentId: intent.agentId, digest, state: 'pending', sessionId: null, generation: null, started: false, updatedAt: stamp() }
      records.set(key, r)
      try { save() } catch (error) { unavailable = true; throw error }
      const began = now()
      let how: DeliveryDiagnostic | undefined
      const done = Promise.resolve().then(() => send((sid, generation, started) => {
        if (r.sessionId !== null && (r.sessionId !== sid || r.generation !== generation)) throw Error('Delivery generation changed')
        r.sessionId = sid; r.generation = generation; r.started = started; r.updatedAt = stamp()
        try { save() } catch (error) { unavailable = true; throw error }
      }, (reason, targetPcName) => {
        r.reason = reason
        r.targetPcName = targetPcName?.slice(0, 120)
        return 'blocked'
      }, note => { how = cleanDeliveryDiagnostic(note) ?? how })).then(state => {
        if (!STATES.has(state) || state === ('pending' as DeliveryState)) throw Error('Invalid final delivery state')
        r.state = state
        if (state !== 'blocked') { delete r.reason; delete r.targetPcName }
      }, () => { r.state = 'unconfirmed'; how ??= { cause: 'exception', marks: [['end', Math.max(0, now() - began)]] } }).catch(() => { r.state = 'unconfirmed' }).then(() => {
        r.updatedAt = stamp()
        // Kept for the sends that need explaining; a sent one only goes to the log (receipts stay small).
        if (r.state === 'sent') delete r.diag
        else if (how) r.diag = how
        try { save() } catch { unavailable = true; r.state = 'unconfirmed' }
        try { options.onFinal?.(receipt(r), how) } catch { /* logging never changes a delivery */ }
      }).finally(() => { running.delete(key) })
      running.set(key, done)
      return receipt(r)
    },
    async wait(id: string, owner: string, floorId: string, agentId: string, ms = 18_000) {
      const current = lookup(id, owner, floorId, agentId)
      if (!current || current.state !== 'pending') return current
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([running.get(current.id), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, Math.min(ms, 18_000))) })]) }
      finally { clearTimeout(timer) }
      return lookup(id, owner, floorId, agentId)
    },
  }
}
