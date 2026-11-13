import type { Duplex } from 'node:stream'
import { PC_PORTS_PREFIX, PC_PORTS_PROTOCOL, PC_PORTS_STREAM, cleanReport, unknownReport, type PcPortRow, type PcPortsReport, type PcPortsRequest } from '../shared/pc-ports.ts'
import { apiError, type ApiMount, type MountRequest } from './api.ts'

// Order oc0ae: the Ports tab of PC control (shared/pc-ports.ts). READ ONLY: this module never opens, closes, shares or changes a port.
//  - GET /agent-api/pc-ports/pcs/<id>: this PC's own report, or (the Server) a member's, asked over their link on a 'pc-ports-v1' stream.
//  - Not a "scoped" mount, so the API lets only the owner (sbskrrt, or the PC's own open app) in, like every core route.
//  - A member answers only its pinned Server (the link stamps `from`), one request per stream, and only with its own report.

const MAX_BYTES = 262_144
const ID = /^[a-z0-9]{16}$/
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export interface PcPortsPeer {
  open(): Promise<Duplex>
}

export interface PcPortsOptions {
  selfId: string
  role(): 'hub' | 'member'
  hubId(): string | null
  /** This PC's own report, built from its Ports state (main.ts). */
  report(): PcPortsReport
  /** The Server: the link to a member, or null while it is not connected. */
  peer(id: string): PcPortsPeer | null
  /** The Server: a paired PC's name, or null for an ID that is not one of its PCs (404). */
  member(id: string): { name: string } | null
  /** The Server: what it knows of a PC that did not answer (that PC's stable ports, with the Server's own links to them). */
  fallback(id: string, tailnetName: string | null): PcPortRow[]
  /** The Server: adds its own links to a member's stable ports (it answers every PC's when they are on). */
  serverLinks(rows: PcPortRow[]): PcPortRow[]
  timeoutMs?: number
}

export interface PcPorts {
  mount: ApiMount
  /** The member's side of the 'pc-ports-v1' stream (main.ts's onOpen). Throws for anyone but its pinned Server. */
  serve(meta: Record<string, unknown>): (stream: Duplex) => void
  /** One PC's report, as the page gets it. */
  get(id: string): Promise<PcPortsReport>
}

export function createPcPorts(o: PcPortsOptions): PcPorts {
  // The last name and address each member said, so a PC that went away still shows where it was (said as unknown, with its last known name).
  const last = new Map<string, { tailnetName: string | null; tailnetAddress: string | null }>()

  async function remote(id: string, name: string): Promise<PcPortsReport> {
    const before = last.get(id) ?? null
    const unknown = (connection: 'offline' | 'unsupported', reason: string) => unknownReport(id, connection, reason, o.fallback(id, before?.tailnetName ?? null), before)
    const peer = o.peer(id)
    if (!peer) return unknown('offline', `${name} is off or not connected right now, so its ports are unknown.`)
    let stream: Duplex
    try {
      stream = await peer.open()
    } catch {
      return unknown('unsupported', `${name} runs an older build that cannot list its ports. Update it from its Updates tab, then look again.`)
    }
    try {
      const request: PcPortsRequest = { protocol: PC_PORTS_PROTOCOL, targetId: id }
      const report = cleanReport(await exchange(stream, request, o.timeoutMs ?? 10_000), id)
      if (report.connection !== 'online') throw new Error('not an answer from that PC')
      last.set(id, { tailnetName: report.tailnetName, tailnetAddress: report.tailnetAddress })
      return { ...report, rows: o.serverLinks(report.rows) }
    } catch {
      return unknown('offline', `${name} did not answer about its ports, so they are unknown. Refresh to ask again.`)
    } finally {
      stream.destroy()
    }
  }

  async function get(id: string): Promise<PcPortsReport> {
    if (!ID.test(id)) throw apiError(404, 'There is no such PC.')
    if (id === o.selfId) return o.report()
    if (o.role() !== 'hub') throw apiError(409, 'Open PC control on the Server to see another PC’s ports.')
    const pc = o.member(id)
    if (!pc) throw apiError(404, 'That PC is not one of the Server’s PCs.')
    return remote(id, pc.name)
  }

  const mount: ApiMount = {
    prefix: PC_PORTS_PREFIX,
    async http(r: MountRequest) {
      const match = /^\/pcs\/([^/]+)$/.exec(r.rest)
      if (!match) throw apiError(404, 'Nothing here.')
      if (r.method !== 'GET' || r.query.toString()) throw apiError(400, 'Only GET, with nothing after the PC’s ID.')
      return get(match[1])
    },
  }

  function serve(meta: Record<string, unknown>): (stream: Duplex) => void {
    const from = meta.from
    if (o.role() !== 'member' || !obj(from) || typeof from.id !== 'string' || from.id !== o.hubId()) throw new Error('Only this PC’s Server may ask for its ports.')
    return stream => answerOnce(stream, raw => {
      if (!obj(raw) || raw.protocol !== PC_PORTS_PROTOCOL || raw.targetId !== o.selfId || Object.keys(raw).length !== 2) throw new Error('not a ports request for this PC')
      return o.report()
    })
  }

  return { mount, serve, get }
}

/** The member's side: one JSON line in, one JSON line out ({ok:true,value} or {ok:false}), then the stream ends. */
function answerOnce(stream: Duplex, work: (raw: unknown) => PcPortsReport) {
  let data = ''
  let used = false
  const timer = setTimeout(() => stream.destroy(), 15_000)
  timer.unref()
  stream.setEncoding('utf8')
  stream.on('error', () => {})
  stream.on('close', () => clearTimeout(timer))
  stream.on('data', (chunk: string) => {
    if (used) return
    data += chunk
    if (data.length > 4096) {
      used = true
      stream.destroy()
      return
    }
    const i = data.indexOf('\n')
    if (i < 0) return
    used = true
    let reply: string
    try {
      reply = JSON.stringify({ ok: true, value: work(JSON.parse(data.slice(0, i))) })
    } catch {
      reply = JSON.stringify({ ok: false })
    }
    stream.end(reply + '\n')
  })
}

/** The Server's side: sends the request line, reads one answer line (bounded in size and time). */
function exchange(stream: Duplex, request: PcPortsRequest, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    let done = false
    const finish = (error: Error | null, value?: unknown) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs)
    timer.unref()
    stream.setEncoding('utf8')
    stream.on('error', () => finish(new Error('transport failed')))
    stream.on('end', () => finish(new Error('incomplete answer')))
    stream.on('close', () => finish(new Error('connection closed')))
    stream.on('data', (chunk: string) => {
      data += chunk
      if (data.length > MAX_BYTES) {
        finish(new Error('oversized answer'))
        stream.destroy()
        return
      }
      const i = data.indexOf('\n')
      if (i < 0) return
      try {
        const raw: unknown = JSON.parse(data.slice(0, i))
        if (obj(raw) && raw.ok === true && Object.keys(raw).length === 2) finish(null, raw.value)
        else finish(new Error('refused'))
      } catch {
        finish(new Error('invalid answer'))
      }
    })
    stream.end(JSON.stringify(request) + '\n')
  })
}

export { PC_PORTS_STREAM }
