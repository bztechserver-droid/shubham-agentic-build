import { parseViews } from './views.ts'
import { rebaseViews, validSnapshot, type SyncedView, type ViewDeviceKind, type ViewOperation, type ViewSnapshot } from './view-sync.ts'

export type SyncState = 'local' | 'pending' | 'synced' | 'offline' | 'reauth' | 'conflict' | 'blocked' | 'unsupported'
interface Cache { remote: SyncedView[]; revision: number; operations: ViewOperation[]; conflicts: ViewOperation[]; examined: boolean; legacy: SyncedView[] }
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface ViewsState { views: SyncedView[]; status: SyncState; conflicts: ViewOperation[]; persistent: boolean }
export interface ViewTransport {
  get(kind: ViewDeviceKind): Promise<ViewSnapshot & { crmOrigin: string }>
  put(kind: ViewDeviceKind, revision: number, views: SyncedView[]): Promise<ViewSnapshot & { crmOrigin: string }>
}
const fresh = (): Cache => ({ remote: [], revision: 0, operations: [], conflicts: [], examined: false, legacy: [] })
const LEGACY = 'sad-agentic-views'
const CLAIM = 'sad-agentic-views-claim-v1'

/** F-144: one worker, scoped cache and durable intentions. No live windows dependencies. */
export class SavedViewsStore {
  private cache = fresh()
  private generation = 0
  private person: string | null = null
  private kind: ViewDeviceKind = 'pc'
  private host = ''
  private key = ''
  private running = false
  private paused: 'blocked' | 'unsupported' | 'reauth' | null = null
  private persistent = true
  private memory = new Map<string, string>()
  private state: ViewsState = { views: [], status: 'local', conflicts: [], persistent: true }
  private listeners = new Set<() => void>()
  private storage: StorageLike
  private transport: ViewTransport
  private uuid: () => string
  constructor(storage: StorageLike, transport: ViewTransport, uuid: () => string = () => crypto.randomUUID()) { this.storage = storage; this.transport = transport; this.uuid = uuid }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  deviceKind = () => this.kind
  matches = (host: string, person: string | null, kind: ViewDeviceKind) => this.host === host && this.person === person && this.kind === kind && !!this.key
  private read(key: string) { try { return this.storage.getItem(key) ?? this.memory.get(key) ?? null } catch { this.persistent = false; return this.memory.get(key) ?? null } }
  private write(key: string, value: string) { this.memory.set(key, value); try { this.storage.setItem(key, value) } catch { this.persistent = false } }
  private legacy(kind: ViewDeviceKind): SyncedView[] {
    try { return parseViews(JSON.parse(this.read(LEGACY) ?? '[]')).slice(0, 64).map(v => ({ ...v, deviceKind: kind, slots: Array.from({ length: v.count }, (_, i) => v.slots[i] ?? null) })) } catch { return [] }
  }
  private emit(status: SyncState = this.state.status) {
    const rebased = rebaseViews(this.cache.remote, this.cache.operations)
    this.state = { views: rebased.views, status, conflicts: this.cache.conflicts, persistent: this.persistent }
    for (const l of this.listeners) l()
  }
  private save(status: SyncState) { this.write(this.key, JSON.stringify(this.cache)); this.emit(status) }
  configure(host: string, person: string | null, kind: ViewDeviceKind) {
    if (host === this.host && person === this.person && kind === this.kind && this.key) return
    this.generation++
    this.running = false
    this.paused = null
    this.host = host; this.person = person; this.kind = kind
    const namespace = JSON.stringify([host, person, kind])
    const origin = this.read(`sad-views-origin:${namespace}`)
    this.key = `sad-views-v1:${JSON.stringify([host, origin, person, kind])}`
    this.cache = fresh()
    try {
      const raw = JSON.parse(this.read(this.key) ?? 'null') as Cache | null
      if (raw && Array.isArray(raw.remote) && Array.isArray(raw.operations) && Array.isArray(raw.conflicts) && Array.isArray(raw.legacy)) this.cache = raw
    } catch { /* A corrupt cache never means an absent CRM row. */ }
    if (person && !this.cache.examined && this.cache.revision === 0 && !this.cache.remote.length) {
      const claim = JSON.stringify([origin ?? `agent:${host}`, person, kind])
      const claimed = this.read(CLAIM)
      if (!claimed || claimed === claim) {
        const legacy = this.legacy(kind)
        if (legacy.length) { this.write(CLAIM, claim); this.cache.remote = legacy; this.cache.legacy = legacy }
      }
    }
    if (!person && !this.cache.remote.length && !this.cache.operations.length) {
      try { this.cache.remote = parseViews(JSON.parse(this.read(LEGACY) ?? '[]')).map(v => ({ ...v, deviceKind: kind })) } catch { /* Keep anonymous fallback usable. */ }
    }
    // Anonymous views are separate; the old unowned list is recovery-only until claimed.
    this.emit(person ? 'pending' : 'local')
  }
  private operation(before: SyncedView | null, after: SyncedView | null) {
    if (this.cache.operations.length + this.cache.conflicts.length >= 256) throw new Error('Saved views queue is full. Export your views and retry sync.')
    if (after && !before && this.state.views.length >= 64) throw new Error('At most 64 saved views. Export or remove a view first.')
    this.cache.operations.push({ opId: this.uuid(), before, after })
    this.save(this.person ? this.paused ?? 'pending' : 'local')
  }
  create(view: SyncedView) {
    if (view.deviceKind !== this.kind) throw new Error('Wrong device kind')
    this.operation(null, view)
  }
  rename(id: string, name: string) {
    const before = this.state.views.find(v => v.id === id)
    const clean = name.replace(/\s+/gu, ' ').trim().slice(0, 40)
    if (before && clean && clean !== before.name) this.operation(before, { ...before, name: clean })
  }
  remove(id: string) { const before = this.state.views.find(v => v.id === id); if (before) this.operation(before, null) }
  importLocal() {
    if (!this.person) return
    const key = `sad-views-v1:${JSON.stringify([this.host, null, null, this.kind])}`
    let local = fresh()
    try { local = JSON.parse(this.read(key) ?? 'null') as Cache ?? fresh() } catch { /* No anonymous cache. */ }
    const views = rebaseViews(local.remote, local.operations).views
    if (views.length + this.state.views.length > 64) throw new Error('Import would exceed 64 views. Export and remove some views first.')
    for (const view of views) this.create({ ...view, id: this.uuid(), deviceKind: this.kind })
    return views.length
  }
  resolve(opId: string, mine: boolean) {
    const conflict = this.cache.conflicts.find(o => o.opId === opId)
    if (!conflict) return
    if (mine && conflict.after) {
      // Copy instead of overwriting someone else's edit; a remote removal stays removed.
      this.operation(null, { ...conflict.after, id: this.uuid(), name: `${conflict.after.name.slice(0, 28)} (my copy)` })
    } else if (mine && conflict.before) {
      const current = this.state.views.find(v => v.id === conflict.before!.id)
      if (current) this.operation(current, null)
    }
    this.cache.conflicts = this.cache.conflicts.filter(o => o.opId !== opId)
    this.save(this.cache.conflicts.length ? 'conflict' : 'pending')
  }
  export() { return JSON.stringify({ views: this.state.views, pending: this.cache.operations, conflicts: this.cache.conflicts, legacyRecovery: this.cache.legacy }, null, 2) }
  resume() { this.paused = null }
  reload() {
    try {
      const other = JSON.parse(this.read(this.key) ?? 'null') as Cache | null
      if (!other || !Array.isArray(other.operations) || !Array.isArray(other.remote)) return
      const byId = new Map([...other.operations, ...this.cache.operations].map(o => [o.opId, o]))
      this.cache.operations = [...byId.values()]
      if (other.revision > this.cache.revision) { this.cache.remote = other.remote; this.cache.revision = other.revision }
      this.emit(this.person ? 'pending' : 'local')
    } catch { /* Ignore malformed tab notifications. */ }
  }
  async sync() {
    if (!this.person || this.running || this.paused) return
    const generation = this.generation
    const owner = this.person
    const kind = this.kind
    const current = () => generation === this.generation
    this.running = true
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await this.transport.get(kind)
        if (!current()) return
        if (!validSnapshot(remote, owner, kind) || typeof remote.crmOrigin !== 'string') throw new Error('Malformed snapshot')
        const namespace = JSON.stringify([this.host, owner, kind])
        const oldOrigin = this.read(`sad-views-origin:${namespace}`)
        if (oldOrigin && oldOrigin !== remote.crmOrigin) {
          // An agent reconfigured for another CRM never uploads the previous environment's queue.
          this.cache = fresh()
        }
        this.write(`sad-views-origin:${namespace}`, remote.crmOrigin)
        this.key = `sad-views-v1:${JSON.stringify([this.host, remote.crmOrigin, owner, kind])}`
        const claim = JSON.stringify([remote.crmOrigin, owner, kind])
        let bootstrap: SyncedView[] = []
        if (!this.cache.examined) {
          const claimed = this.read(CLAIM)
          if (!claimed || claimed === claim || claimed === JSON.stringify([`agent:${this.host}`, owner, kind])) {
            this.write(CLAIM, claim)
            bootstrap = this.legacy(kind)
          }
          if (remote.exists) { this.cache.legacy = bootstrap; bootstrap = []; this.cache.examined = true }
        }
        const baseline = !remote.exists && bootstrap.length ? bootstrap : remote.views
        this.cache.remote = baseline
        this.cache.revision = remote.revision
        const rebased = rebaseViews(baseline, this.cache.operations)
        this.cache.operations = rebased.pending
        this.cache.conflicts.push(...rebased.conflicts)
        // Legacy is never an ordinary create operation: a losing base-0 race cannot merge it.
        const desired = rebaseViews(baseline, this.cache.operations).views
        if (!this.cache.operations.length && !bootstrap.length) {
          this.cache.examined = true
          this.save(this.cache.conflicts.length ? 'conflict' : 'synced')
          return
        }
        const included = new Set(this.cache.operations.map(o => o.opId))
        this.save(this.cache.conflicts.length ? 'conflict' : 'pending')
        try {
          const ack = await this.transport.put(kind, remote.revision, desired)
          if (!current()) return
          if (!validSnapshot(ack, owner, kind)) throw new Error('Malformed acknowledgement')
          this.cache.remote = ack.views; this.cache.revision = ack.revision; this.cache.examined = true
          this.cache.operations = this.cache.operations.filter(o => !included.has(o.opId))
          this.save(this.cache.conflicts.length ? 'conflict' : this.cache.operations.length ? 'pending' : 'synced')
          if (!this.cache.operations.length) return
        } catch (e) {
          if (!current()) return
          if ((e as { status?: number }).status !== 409) throw e
          this.cache.legacy = bootstrap
        }
      }
      if (current()) this.save('pending')
    } catch (e) {
      if (current()) {
        const status = (e as { status?: number }).status
        this.paused = status === 401 ? 'reauth' : status === 403 ? 'blocked' : status === 404 ? 'unsupported' : null
        this.save(this.paused ?? 'offline')
      }
    } finally { if (current()) this.running = false }
  }
}
