import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isTailnet, parseHostPort } from './net.ts'

// devices.json (agent/SPEC.md › Pairing): on the hub, the allowlist of paired members; on a
// member, the hub it pinned. Written whole to a temp name and renamed, so a reader never sees
// half a file. Trust lives here: a member is let in only when its id AND key hash match.

export interface MemberRecord {
  id: string
  name: string
  /** sha256 of the member's SPKI, hex: what its certificate must carry. */
  spkiSha256: string
  rustdeskId: string | null
  pairedAt: string
  lastSeen: string | null
}

export interface HubBundle {
  id: string
  name: string
  /** The pin: sha256 of the hub's SPKI, hex. */
  spkiSha256: string
  /** 'ip:port' each, at the hub's LAN address. */
  lan: { peer: string; hbbs: string; hbbr: string }
  /** 'host:port' each, at the hub's public address (phase 2). */
  public: { hbbs: string; hbbr: string }
  /** 'ip:port' of the hub's listener on its Tailscale address, or null when Tailscale isn't up there. */
  tailnet: string | null
  /**
   * F-110 (5 Nov 2026): the hub's own name on the tailnet ("server.tail36192f.ts.net"), when it knows it. A member that cannot reach the
   * `tailnet` address (the hub moved to another tailnet and got a new one) tries this name, and its first label, before giving up.
   * Missing in hubs and files from before F-110.
   */
  tailnetName?: string
  /** hbbs/hbbr's key (id_ed25519.pub), null while the hub's hbbs has not started yet. */
  licenceKey: string | null
}

export interface HubRecord extends HubBundle {
  pairedAt: string
  lastSeen: string | null
}

export interface DevicesFile {
  version: 1
  members: MemberRecord[]
  hub: HubRecord | null
}

const ID = /^[a-z2-7]{16}$/
const HEX32 = /^[0-9a-f]{64}$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isEndpoint = (v: unknown): v is string => typeof v === 'string' && parseHostPort(v) !== null
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))

/** A peer's name, as it may show on screen: trimmed, no control characters, at most 64. */
export function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.replace(/\p{Cc}/gu, ' ').trim().slice(0, 64) : ''
  return s || fallback
}

/** The hub's bundle as a member gets it in pair-result or hello; throws on anything malformed. */
export function checkBundle(v: unknown): HubBundle {
  const bad = (what: string) => new Error(`The hub's details are malformed: ${what}`)
  if (!isObject(v)) throw bad('not an object')
  if (typeof v.id !== 'string' || !ID.test(v.id)) throw bad('id')
  if (typeof v.spkiSha256 !== 'string' || !HEX32.test(v.spkiSha256)) throw bad('spkiSha256')
  const lan = v.lan
  const pub = v.public
  if (!isObject(lan) || !isEndpoint(lan.peer) || !isEndpoint(lan.hbbs) || !isEndpoint(lan.hbbr)) throw bad('lan')
  if (!isObject(pub) || !isEndpoint(pub.hbbs) || !isEndpoint(pub.hbbr)) throw bad('public')
  // Missing in hubs and files from before Tailscale: no Tailscale address.
  let tailnet: string | null = null
  if (v.tailnet !== undefined && v.tailnet !== null) {
    if (!isEndpoint(v.tailnet) || !isTailnet(parseHostPort(v.tailnet)?.host ?? '')) throw bad('tailnet')
    tailnet = v.tailnet
  }
  // A bad name is dropped, not an error: the address above is what counts, and a hub from the future may say it differently.
  const tailnetName = typeof v.tailnetName === 'string' && isDnsName(v.tailnetName.replace(/\.$/, '').toLowerCase()) ? v.tailnetName.replace(/\.$/, '').toLowerCase() : null
  if (v.licenceKey !== null && (typeof v.licenceKey !== 'string' || !/^[A-Za-z0-9+/=]{1,200}$/.test(v.licenceKey))) {
    throw bad('licenceKey')
  }
  return {
    id: v.id,
    name: cleanName(v.name, `hub ${v.id.slice(0, 4)}`),
    spkiSha256: v.spkiSha256,
    lan: { peer: lan.peer, hbbs: lan.hbbs, hbbr: lan.hbbr },
    public: { hbbs: pub.hbbs, hbbr: pub.hbbr },
    tailnet,
    ...(tailnetName ? { tailnetName } : {}),
    licenceKey: v.licenceKey,
  }
}

/** A host name as DNS has it: dot-separated labels of letters, digits and hyphens (a tailnet name such as server.tail36192f.ts.net). */
export const isDnsName = (s: string): boolean => s.length > 0 && s.length <= 253 && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(s)

function checkMember(v: unknown, at: string): MemberRecord {
  const bad = (what: string) => new Error(`${at}: ${what}`)
  if (!isObject(v)) throw bad('not an object')
  if (typeof v.id !== 'string' || !ID.test(v.id)) throw bad('"id" must be a 16-character device ID')
  if (typeof v.spkiSha256 !== 'string' || !HEX32.test(v.spkiSha256)) throw bad('"spkiSha256" must be 64 hex digits')
  if (v.rustdeskId !== null && typeof v.rustdeskId !== 'string') throw bad('"rustdeskId" must be a string or null')
  if (!isTime(v.pairedAt)) throw bad('"pairedAt" must be a date')
  if (v.lastSeen !== null && !isTime(v.lastSeen)) throw bad('"lastSeen" must be a date or null')
  return {
    id: v.id,
    name: cleanName(v.name, v.id),
    spkiSha256: v.spkiSha256,
    rustdeskId: v.rustdeskId,
    pairedAt: v.pairedAt,
    lastSeen: v.lastSeen,
  }
}

function checkHub(v: unknown, at: string): HubRecord {
  if (!isObject(v)) throw new Error(`${at}: not an object`)
  let bundle: HubBundle
  try {
    bundle = checkBundle(v)
  } catch (e) {
    throw new Error(`${at}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!isTime(v.pairedAt)) throw new Error(`${at}: "pairedAt" must be a date`)
  if (v.lastSeen !== null && !isTime(v.lastSeen)) throw new Error(`${at}: "lastSeen" must be a date or null`)
  return { ...bundle, pairedAt: v.pairedAt, lastSeen: v.lastSeen }
}

/** devices.json, or an empty one when missing. A malformed file is an error, never silently reset: it is the allowlist. */
export function readDevices(file: string): DevicesFile {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, members: [], hub: null }
    throw e
  }
  const fix = `Fix it, or delete it to forget every paired device.`
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`${file} is not valid JSON. ${fix}`)
  }
  try {
    if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.members)) throw new Error('expected {version: 1, members: [...], hub}')
    const members = raw.members.map((m, i) => checkMember(m, `members[${i}]`))
    const hub = raw.hub === null || raw.hub === undefined ? null : checkHub(raw.hub, 'hub')
    return { version: 1, members, hub }
  } catch (e) {
    throw new Error(`${file} is malformed: ${e instanceof Error ? e.message : String(e)}. ${fix}`)
  }
}

// Windows refuses a rename over a file another program has open for a moment (an antivirus,
// the search indexer): EPERM, EBUSY or EACCES. graceful-fs retries those; so do we, briefly.
const RENAME_WAITS_MS = [10, 25, 50, 100, 200]
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** renameSync, tried again for up to ~0.4 s while Windows says the target is busy. `rename` is for tests. */
export function renameRetrying(from: string, to: string, rename: (from: string, to: string) => void = renameSync): void {
  for (let i = 0; ; i++) {
    try {
      return rename(from, to)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= RENAME_WAITS_MS.length || !code || !BUSY.has(code)) throw e
      // A synchronous wait: the store is synchronous, and this is the rare path.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_WAITS_MS[i])
    }
  }
}

function writeDevices(file: string, data: DevicesFile) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  try {
    renameRetrying(tmp, file)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // the rename's error is the one worth reporting
    }
    throw e
  }
}

export interface DeviceStore {
  members(): MemberRecord[]
  member(id: string): MemberRecord | null
  /** The member with this ID, only if its key hash is the one it paired with. */
  allowed(id: string, spkiSha256: Buffer): MemberRecord | null
  /** Adds a member, or replaces the one with the same ID (pairing again). */
  addMember(m: Pick<MemberRecord, 'id' | 'name' | 'spkiSha256' | 'rustdeskId'>): MemberRecord
  removeMember(id: string): boolean
  updateMember(id: string, patch: Partial<Pick<MemberRecord, 'name' | 'rustdeskId' | 'lastSeen'>>): void
  hub(): HubRecord | null
  /** Pins a hub (a member that pairs again replaces its hub). */
  setHub(bundle: HubBundle): HubRecord
  /** Fresh details from the pinned hub's hello; the pin itself never changes this way. */
  updateHub(patch: Partial<Pick<HubRecord, 'name' | 'lan' | 'public' | 'tailnet' | 'tailnetName' | 'licenceKey' | 'lastSeen'>>): void
}

/** Loads devices.json once and keeps it in memory; every change is written through. */
export function createDeviceStore(file: string): DeviceStore {
  let data = readDevices(file)
  const save = (next: DevicesFile) => {
    writeDevices(file, next)
    data = next
  }
  const copy = <T>(v: T): T => structuredClone(v)

  return {
    members: () => copy(data.members),
    member: id => copy(data.members.find(m => m.id === id) ?? null),
    allowed(id, spki) {
      const m = data.members.find(x => x.id === id)
      return m && m.spkiSha256 === spki.toString('hex') ? copy(m) : null
    },
    addMember(m) {
      const record: MemberRecord = { ...m, pairedAt: new Date().toISOString(), lastSeen: null }
      save({ ...data, members: [...data.members.filter(x => x.id !== m.id), record] })
      return copy(record)
    },
    removeMember(id) {
      if (!data.members.some(m => m.id === id)) return false
      save({ ...data, members: data.members.filter(m => m.id !== id) })
      return true
    },
    updateMember(id, patch) {
      const m = data.members.find(x => x.id === id)
      if (!m) return
      const next = { ...m, ...patch }
      if (JSON.stringify(next) === JSON.stringify(m)) return
      save({ ...data, members: data.members.map(x => (x.id === id ? next : x)) })
    },
    hub: () => copy(data.hub),
    setHub(bundle) {
      const record: HubRecord = { ...bundle, pairedAt: new Date().toISOString(), lastSeen: null }
      save({ ...data, hub: record })
      return copy(record)
    },
    updateHub(patch) {
      if (!data.hub) return
      const next = { ...data.hub, ...patch }
      if (JSON.stringify(next) === JSON.stringify(data.hub)) return
      save({ ...data, hub: next })
    },
  }
}
