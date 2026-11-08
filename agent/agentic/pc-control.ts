import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { Floor, FloorAgent } from '../../shared/agentic.ts'
import type { PcControlExpected } from '../../shared/pc-control.ts'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'
import { SBSKRRT_OWNER } from './access.ts'
import { createFloorStore, type FloorStoreOptions } from './floors.ts'

export interface PcControlKnownDevice { id: string; name: string; online: boolean }
export const isPcControl = (f: Floor | null | undefined): f is Floor & { workspace: 'pc-control'; targetPcId: string } => f?.workspace === 'pc-control' && !!f.targetPcId
export const pcControlError = (code: string, text: string, status = 409) => Object.assign(apiError(status, text), { code })
export const immutablePcControl = () => pcControlError('pc-control-immutable', 'PC Control workspaces and slots are managed by the server. Use PC Control to open, stop or change engine.')
export const pcControlRevision = (floor: Floor) => createHash('sha256').update(JSON.stringify(floor)).digest('hex')

/** A managed identity must never resolve by whichever of the two stores happens to list first. */
export function checkedPcControlNamespace(rows: Floor[]): Floor[] {
  const managed = rows.filter(isPcControl), ids = new Map<string,string>()
  const bindings = (a: FloorAgent) => [a.sessionId,a.codexThread,a.opencodeSession,...(a.conversationHistory ?? []).flatMap(h=>[h.sessionId,h.codexThread,h.opencodeSession])].filter((x): x is string => typeof x === 'string')
  const add = (id: string, owner: string) => { if (ids.has(id) && ids.get(id) !== owner) throw immutablePcControl(); ids.set(id,owner) }
  for (const f of managed) {
    add(f.id,'floor:'+f.id)
    for (const a of f.agents) { add(a.id,'entity:'+a.id); for (const id of bindings(a)) add(id,'binding:'+a.id) }
  }
  for (const f of rows.filter(f=>!isPcControl(f))) for (const id of [f.id,...f.agents.flatMap(a=>[a.id,...bindings(a)])]) if (ids.has(id)) throw immutablePcControl()
  return rows
}

export function assertPcControlExpected(floor: Floor, agent: FloorAgent, raw: unknown): asserts raw is PcControlExpected {
  const x = raw as Partial<PcControlExpected> | null
  if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some(k => !['revision','engine','sessionId','codexThread','opencodeSession'].includes(k)) ||
      x.revision !== pcControlRevision(floor) || x.engine !== agent.engine || x.sessionId !== agent.sessionId ||
      x.codexThread !== (agent.codexThread ?? null) || x.opencodeSession !== null || agent.opencodeSession != null) {
    throw pcControlError('pc-control-stale', 'This PC conversation changed. Refresh PC Control before trying again.')
  }
}

/** Metadata only. Neither ensuring devices nor reading this store starts a native process. */
export function createPcControlStore(file: string, changed: () => void, options: FloorStoreOptions) {
  options = { ...options, pcControl: true }
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(raw.floors) || raw.floors.some((f: Floor) => !isPcControl(f) || !Array.isArray(f.agents) || f.agents.length !== 2 || f.agents[0].pcControlSlot !== 1 || f.agents[1].pcControlSlot !== 2 || f.agents.some(a => !['claude','codex'].includes(a.engine ?? '') || a.homePc !== f.targetPcId))) throw new Error('Invalid workspace')
      const owners = new Map<string,string>(), pcs = new Set<string>(), entities = new Set<string>()
      for (const f of raw.floors as Floor[]) for (const id of [f.id,...f.agents.map(a=>a.id)]) {
        if (typeof id !== 'string' || !id || entities.has(id)) throw new Error('Aliased entity')
        entities.add(id)
      }
      const check = (id: string | null | undefined, owner: string) => { if (id && owners.has(id) && owners.get(id) !== owner) throw new Error('Aliased workspace'); if (id) owners.set(id, owner) }
      for (const f of raw.floors as Floor[]) {
        if (pcs.has(f.targetPcId!)) throw new Error('Duplicate PC')
        pcs.add(f.targetPcId!)
        for (const a of f.agents) for (const id of [a.sessionId,a.codexThread,a.opencodeSession,...(a.conversationHistory ?? []).flatMap(h=>[h.sessionId,h.codexThread,h.opencodeSession])]) {
          if (id && entities.has(id)) throw new Error('Native/entity alias')
          check(id,a.id)
        }
      }
    } catch { throw pcControlError('pc-control-immutable', 'The PC Control store is unreadable. It was left untouched; restore its metadata before continuing.') }
  }
  const onChange = () => changed()
  let store = createFloorStore(file, onChange, options)
  return {
    get store() { return store },
    ensure(devices: PcControlKnownDevice[]) {
      const rows = store.list(), ids = new Set<string>()
      let dirty = false
      for (const d of devices) {
        if (!d.id || d.id.length > 64 || ids.has(d.id)) continue
        ids.add(d.id)
        let f = rows.find(f => isPcControl(f) && f.targetPcId === d.id)
        if (!f) {
          f = createFloorStore('', undefined, { readOnly: true }).create(d.name, SBSKRRT_OWNER)
          f.workspace = 'pc-control'; f.targetPcId = d.id
          const base = f.agents[0]
          f.agents = ([1, 2] as const).map(n => ({ ...structuredClone(base), id: randomUUID(), name: `Chat ${n}`, role: '', md: '',
            isBoss: false, reportsTo: null, duty: null, pcControlSlot: n, engine: n === 1 ? 'claude' : 'codex',
            homePc: d.id, homePcName: d.name, x: (n - 1) * 300, y: 0 }))
          rows.push(f); dirty = true
        }
        if (f.name !== d.name || f.agents.some(a => a.homePcName !== d.name)) {
          f.name = d.name
          for (const a of f.agents) { a.homePc = d.id; a.homePcName = d.name }
          f.updatedAt = new Date().toISOString(); dirty = true
        }
        if (f.agents.length !== 2 || f.agents[0].pcControlSlot !== 1 || f.agents[1].pcControlSlot !== 2 ||
            f.agents.some(a => !['claude','codex'].includes(a.engine ?? '') || a.homePc !== d.id)) {
          throw pcControlError('pc-control-immutable', 'The persisted PC workspace is inconsistent; no conversations were changed.')
        }
      }
      if (!dirty) return
      writeAtomic(file, JSON.stringify({ floors: rows }, null, 2) + '\n')
      store = createFloorStore(file, onChange, options)
      changed()
    },
  }
}
