import { readFileSync } from 'node:fs'
import protobuf from 'protobufjs'

// RendezvousMessage, the one message hbbs and hbbr speak (hbb_common 83419b6
// protos/rendezvous.proto:173-196). rendezvous.proto here keeps only the parts we use, under
// the same field numbers. A union field it leaves out (ConfigUpdate 14, SoftwareUpdate 17,
// PeerDiscovery 22, HealthCheck 26, or anything newer) decodes to kind 'unknown'.
//
// Field names stay snake_case, as in the schema. Decoded bodies follow proto3: every field is
// there, absent ones at their default ('' / 0 / false / empty Buffer / the enum's 0 name). A
// oneof member is there only when it was sent, and `union` names it. Enums are names, or the
// number when the schema doesn't know it.

const root = protobuf.parse(readFileSync(new URL('./rendezvous.proto', import.meta.url), 'utf8'), {
  keepCase: true,
}).root
const Rendezvous = root.lookupType('hbb.RendezvousMessage')
const TO_OBJECT: protobuf.IConversionOptions = { enums: String, defaults: true, arrays: true, oneofs: true }

type Enum<T extends string> = T | number
export type NatType = Enum<'UNKNOWN_NAT' | 'ASYMMETRIC' | 'SYMMETRIC'>
export type ConnType = Enum<'DEFAULT_CONN' | 'FILE_TRANSFER' | 'PORT_FORWARD' | 'RDP'>
export type RegisterPkResult = Enum<
  'OK' | 'UUID_MISMATCH' | 'ID_EXISTS' | 'TOO_FREQUENT' | 'INVALID_ID_FORMAT' | 'NOT_SUPPORT' | 'SERVER_ERROR'
>
export type PunchFailure = Enum<'ID_NOT_EXIST' | 'OFFLINE' | 'LICENSE_MISMATCH' | 'LICENSE_OVERUSE'>

/** Each union member of RendezvousMessage, as decode() returns it. */
export interface Bodies {
  register_peer: { id: string; serial: number }
  register_peer_response: { request_pk: boolean }
  punch_hole_request: {
    id: string
    nat_type: NatType
    licence_key: string
    conn_type: ConnType
    token: string
    version: string
  }
  punch_hole: { socket_addr: Buffer; relay_server: string; nat_type: NatType }
  punch_hole_sent: { socket_addr: Buffer; id: string; relay_server: string; nat_type: NatType; version: string }
  punch_hole_response: {
    socket_addr: Buffer
    /** hbbs-signed IdPk, only when the answering side sent a version. */
    pk: Buffer
    /** Meaningful only when socket_addr is empty: ID_NOT_EXIST is 0, the default. */
    failure: PunchFailure
    relay_server: string
    union?: 'nat_type' | 'is_local'
    nat_type?: NatType
    is_local?: boolean
    other_failure: string
  }
  fetch_local_addr: { socket_addr: Buffer; relay_server: string }
  local_addr: { socket_addr: Buffer; local_addr: Buffer; relay_server: string; id: string; version: string }
  register_pk: { id: string; uuid: Buffer; pk: Buffer; old_id: string }
  register_pk_response: { result: RegisterPkResult; keep_alive: number }
  request_relay: {
    id: string
    uuid: string
    socket_addr: Buffer
    relay_server: string
    secure: boolean
    licence_key: string
    conn_type: ConnType
    token: string
  }
  relay_response: {
    socket_addr: Buffer
    uuid: string
    relay_server: string
    /** The answering side sends `id`; hbbs swaps it for the signed `pk` on the way (rendezvous_server.rs:510-514). */
    union?: 'id' | 'pk'
    id?: string
    pk?: Buffer
    refuse_reason: string
    version: string
  }
  test_nat_request: { serial: number }
  test_nat_response: { port: number }
  online_request: { id: string; peers: string[] }
  online_response: { states: Buffer }
  key_exchange: { keys: Buffer[] }
}

export type Kind = keyof Bodies

export type Decoded =
  | { [K in Kind]: { kind: K; body: Bodies[K] } }[Kind]
  /** A union field this schema doesn't have; `field` is its number, for the log. */
  | { kind: 'unknown'; body: { field: number | null } }
  /** Not protobuf at all. */
  | { kind: 'invalid'; body: { error: string } }

type In<V> = V extends Buffer ? Uint8Array : V extends Buffer[] ? Uint8Array[] : V
type Encodable<T> = { [P in Exclude<keyof T, 'union'>]?: In<T[P]> }

/** A RendezvousMessage to send: exactly one union member, any of its fields (the rest are defaults). */
export type Outgoing = { [K in Kind]: { [P in K]: Encodable<Bodies[K]> } }[Kind]

export const KINDS: readonly string[] = Rendezvous.oneofs.union.oneof

/**
 * Encodes one RendezvousMessage. proto3 leaves default values off the wire (a set oneof member
 * is always written), so the bytes match what RustDesk's own encoder sends. Throws on a field
 * the schema doesn't have (say, licenceKey for licence_key) or an enum name it doesn't know,
 * which protobufjs would otherwise drop without a word.
 */
export function encode(msg: Outgoing): Buffer {
  const keys = Object.keys(msg)
  if (keys.length !== 1 || !KINDS.includes(keys[0])) {
    throw new Error(`A RendezvousMessage carries exactly one of its union fields, not: ${keys.join(', ') || 'none'}`)
  }
  check(Rendezvous, msg, 'RendezvousMessage')
  const out = Rendezvous.encode(Rendezvous.fromObject(msg)).finish()
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
}

/** Decodes one RendezvousMessage. Never throws: see the 'unknown' and 'invalid' kinds. */
export function decode(buf: Uint8Array): Decoded {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  let obj: Record<string, unknown>
  try {
    obj = Rendezvous.toObject(Rendezvous.decode(bytes), TO_OBJECT)
  } catch (e) {
    return { kind: 'invalid', body: { error: e instanceof Error ? e.message : String(e) } }
  }
  const kind = obj.union
  if (typeof kind !== 'string') return { kind: 'unknown', body: { field: firstField(bytes) } }
  return { kind, body: obj[kind] } as Decoded
}

function check(type: protobuf.Type, obj: object, path: string) {
  const fields = obj as Record<string, unknown>
  for (const [name, value] of Object.entries(fields)) {
    const field = type.fields[name]
    if (!field) throw new Error(`${path}.${name}: ${type.name} has no such field`)
    if (value === undefined || value === null) continue
    const t = field.resolve().resolvedType
    if (t instanceof protobuf.Enum && typeof value === 'string' && !(value in t.values)) {
      throw new Error(`${path}.${name}: ${value} is not a ${t.name}`)
    }
    if (t instanceof protobuf.Type) {
      if (typeof value !== 'object') throw new Error(`${path}.${name}: expected a ${t.name} object`)
      check(t, value, `${path}.${name}`)
    }
  }
  for (const oneof of type.oneofsArray) {
    const set = oneof.oneof.filter(n => fields[n] !== undefined && fields[n] !== null)
    if (set.length > 1) throw new Error(`${path}: ${set.join(' and ')} share a oneof; set one`)
  }
}

// The field number of the first tag, to say which unknown union field arrived.
function firstField(bytes: Buffer): number | null {
  try {
    return bytes.length ? protobuf.Reader.create(bytes).uint32() >>> 3 : null
  } catch {
    return null
  }
}
